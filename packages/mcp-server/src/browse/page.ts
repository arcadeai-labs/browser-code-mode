/** Direct CDP implementation: no browser extension, filesystem, or Node APIs. */
import { CdpConnection, openWebSocket, type OpenSocket } from "./transport.ts";
import { resolveCdpUrl } from "./cdp.ts";

export type LoadState = "load" | "domcontentloaded" | "networkidle";
export type MouseButton = "left" | "middle" | "right";
type NavigationOptions = { timeout?: number; waitUntil?: LoadState };
const pause = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function connectBrowser(
  cdpUrl: string,
  signal?: AbortSignal,
  openSocket: OpenSocket = openWebSocket,
) {
  const resolved = await resolveCdpUrl(cdpUrl, signal ? { signal } : {});
  const cdp = new CdpConnection(await openSocket(resolved, signal), signal);
  return new BrowserContext(cdp, signal);
}

export class BrowserContext {
  private cdp: CdpConnection;
  private signal: AbortSignal | undefined;
  private selected: string | undefined;
  private attached = new Map<string, Promise<Page>>();
  constructor(cdp: CdpConnection, signal?: AbortSignal) {
    this.cdp = cdp;
    this.signal = signal;
  }
  async pages(): Promise<Page[]> {
    const { targetInfos } = await this.cdp.send("Target.getTargets");
    return Promise.all(
      targetInfos
        .filter((t: { type: string }) => t.type === "page")
        .map((t: { targetId: string }) => this.page(t.targetId)),
    );
  }
  private page(id: string): Promise<Page> {
    let pending = this.attached.get(id);
    if (!pending) {
      pending = this.cdp
        .send("Target.attachToTarget", { targetId: id, flatten: true })
        .then(async ({ sessionId }) => {
          const page = new Page(this.cdp, id, sessionId, this.signal);
          await page.send("Page.enable");
          await page.send("Network.enable");
          return page;
        });
      this.attached.set(id, pending);
    }
    return pending;
  }
  async activePage(): Promise<Page | undefined> {
    const pages = await this.pages();
    const selected = pages.find((p) => p.pageId === this.selected);
    if (selected) return selected;
    for (const page of pages) {
      if (await page.evaluate("document.hasFocus()").catch(() => false))
        return page;
    }
    return pages[0];
  }
  async setActivePage(page: Page) {
    await this.cdp.send("Target.activateTarget", { targetId: page.pageId });
    this.selected = page.pageId;
  }
  async newPage(url = "about:blank") {
    const { targetId } = await this.cdp.send("Target.createTarget", {
      url: "about:blank",
    });
    const page = await this.page(targetId);
    await this.setActivePage(page);
    if (url !== "about:blank") await page.goto(url);
    return page;
  }
  close() {
    this.cdp.close();
  }
}

export class Page {
  readonly pageId: string;
  private cdp: CdpConnection;
  private sessionId: string;
  private signal: AbortSignal | undefined;
  private requests = new Set<string>();
  private networkChangedAt = Date.now();
  constructor(
    cdp: CdpConnection,
    id: string,
    sessionId: string,
    signal?: AbortSignal,
  ) {
    this.cdp = cdp;
    this.pageId = id;
    this.sessionId = sessionId;
    this.signal = signal;
    cdp.onEvent((method, params, session) => {
      if (session !== sessionId) return;
      if (method === "Network.requestWillBeSent") {
        this.requests.add(params.requestId);
        this.networkChangedAt = Date.now();
      } else if (
        method === "Network.loadingFinished" ||
        method === "Network.loadingFailed"
      ) {
        this.requests.delete(params.requestId);
        this.networkChangedAt = Date.now();
      }
    });
  }
  send(method: string, params: object = {}) {
    return this.cdp.send(method, params, this.sessionId);
  }
  async evaluate(expression: string): Promise<any> {
    const response = await this.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (response.exceptionDetails)
      throw new Error(
        response.exceptionDetails.exception?.description ??
          response.exceptionDetails.text,
      );
    return response.result.value;
  }
  url(): Promise<string> {
    return this.evaluate("location.href");
  }
  title(): Promise<string> {
    return this.evaluate("document.title");
  }
  async goto(url: string, options: NavigationOptions = {}) {
    const result = await this.send("Page.navigate", { url });
    if (result.errorText) throw new Error(result.errorText);
    await this.waitForLoadState(options.waitUntil ?? "load", options.timeout);
  }
  async reload(options: NavigationOptions = {}) {
    await this.send("Page.reload");
    await this.waitForLoadState(options.waitUntil ?? "load", options.timeout);
  }
  private async history(delta: number, options: NavigationOptions) {
    const history = await this.send("Page.getNavigationHistory");
    const entry = history.entries[history.currentIndex + delta];
    if (entry)
      await this.send("Page.navigateToHistoryEntry", { entryId: entry.id });
    await this.waitForLoadState(options.waitUntil ?? "load", options.timeout);
  }
  goBack(options: NavigationOptions = {}) {
    return this.history(-1, options);
  }
  goForward(options: NavigationOptions = {}) {
    return this.history(1, options);
  }
  async close() {
    await this.cdp.send("Target.closeTarget", { targetId: this.pageId });
  }
  locator(selector: string) {
    return new Locator(this, selector);
  }
  async waitForLoadState(state: LoadState = "load", timeout = 30_000) {
    if (state === "networkidle") {
      const started = Date.now();
      return this.poll(
        async () =>
          this.requests.size === 0 &&
          Date.now() - Math.max(started, this.networkChangedAt) >= 500,
        timeout,
      );
    }
    await this.poll(async () => {
      const ready = await this.evaluate("document.readyState").catch(
        () => "loading",
      );
      return state === "domcontentloaded"
        ? ready !== "loading"
        : ready === "complete";
    }, timeout);
  }
  async poll(check: () => Promise<boolean>, timeout: number) {
    const deadline = Date.now() + timeout;
    do {
      this.signal?.throwIfAborted();
      if (await check()) return;
      await pause(50);
    } while (Date.now() < deadline);
    throw new Error(`Browser wait timed out after ${timeout}ms.`);
  }
  async waitForTimeout(ms: number) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      this.signal?.throwIfAborted();
      await pause(Math.min(100, deadline - Date.now()));
    }
  }
  async waitForSelector(
    selector: string,
    { state, timeout }: { state: string; timeout: number },
  ) {
    const locator = this.locator(selector);
    await this.poll(async () => {
      const exists = await locator.exists();
      if (state === "attached") return exists;
      if (state === "detached") return !exists;
      const visible = exists && (await locator.isVisible());
      return state === "hidden" ? !visible : visible;
    }, timeout);
  }
  async keyPress(combo: string) {
    const parts = combo.split("+");
    const key = parts.pop()!;
    const modifiers = parts.reduce(
      (n, p) =>
        n | ({ Alt: 1, Control: 2, Ctrl: 2, Meta: 4, Shift: 8 }[p] ?? 0),
      0,
    );
    const codes: Record<string, number> = {
      Enter: 13,
      Tab: 9,
      Escape: 27,
      Backspace: 8,
      Delete: 46,
      ArrowLeft: 37,
      ArrowUp: 38,
      ArrowRight: 39,
      ArrowDown: 40,
      Home: 36,
      End: 35,
      PageUp: 33,
      PageDown: 34,
    };
    const code = codes[key] ?? key.toUpperCase().charCodeAt(0);
    const text =
      key === "Enter"
        ? "\r"
        : key.length === 1 && !(modifiers & 7)
          ? key
          : undefined;
    await this.send("Input.dispatchKeyEvent", {
      type: "keyDown",
      key,
      modifiers,
      windowsVirtualKeyCode: code,
      ...(text ? { text } : {}),
    });
    await this.send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key,
      modifiers,
      windowsVirtualKeyCode: code,
    });
  }
  async type(
    text: string,
    options?: { delay?: number; withMistakes?: boolean },
  ) {
    if (options?.delay || options?.withMistakes)
      for (const char of text) {
        if (options.withMistakes && Math.random() < 0.08) {
          await this.send("Input.insertText", { text: "x" });
          await this.waitForTimeout(options.delay ?? 30);
          await this.keyPress("Backspace");
        }
        await this.send("Input.insertText", { text: char });
        await this.waitForTimeout(options.delay ?? 30);
      }
    else await this.send("Input.insertText", { text });
  }
  async click(
    x: number,
    y: number,
    {
      button = "left",
      clickCount = 1,
    }: { button?: MouseButton; clickCount?: number } = {},
  ) {
    await this.hover(x, y);
    await this.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x,
      y,
      button,
      clickCount,
    });
    await this.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x,
      y,
      button,
      clickCount,
    });
  }
  async hover(x: number, y: number) {
    await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  }
  async scroll(x: number, y: number, deltaX: number, deltaY: number) {
    await this.send("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x,
      y,
      deltaX,
      deltaY,
    });
  }
  async dragAndDrop(
    fromX: number,
    fromY: number,
    toX: number,
    toY: number,
    {
      button = "left",
      steps = 10,
      delay = 10,
    }: { button?: MouseButton; steps?: number; delay?: number } = {},
  ) {
    await this.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: fromX,
      y: fromY,
      button,
      clickCount: 1,
    });
    try {
      for (let i = 1; i <= steps; i++) {
        await this.send("Input.dispatchMouseEvent", {
          type: "mouseMoved",
          x: fromX + ((toX - fromX) * i) / steps,
          y: fromY + ((toY - fromY) * i) / steps,
          button,
          buttons: button === "left" ? 1 : button === "right" ? 2 : 4,
        });
        await this.waitForTimeout(delay);
      }
    } finally {
      await this.send("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x: toX,
        y: toY,
        button,
        clickCount: 1,
      });
    }
  }
  async screenshot(options: {
    fullPage?: boolean | undefined;
    type?: "png" | "jpeg";
    quality?: number;
    clip?: { x: number; y: number; width: number; height: number };
  }) {
    let clip = options.clip;
    if (options.fullPage && !clip) {
      const { cssContentSize } = await this.send("Page.getLayoutMetrics");
      clip = cssContentSize;
    }
    const { data } = await this.send("Page.captureScreenshot", {
      format: options.type ?? "png",
      ...(options.quality === undefined ? {} : { quality: options.quality }),
      ...(clip
        ? { clip: { ...clip, scale: 1 }, captureBeyondViewport: true }
        : {}),
    });
    return data as string;
  }
  async setViewportSize(
    width: number,
    height: number,
    { deviceScaleFactor }: { deviceScaleFactor: number },
  ) {
    await this.send("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor,
      mobile: false,
    });
  }
  async addInitScript(source: string) {
    await this.send("Page.addScriptToEvaluateOnNewDocument", { source });
  }
  async snapshot() {
    const { nodes } = await this.send("Accessibility.getFullAXTree");
    const xpathMap: Record<string, string> = {};
    const urlMap: Record<string, string> = {};
    const lines: string[] = [];
    const byId = new Map<string, any>(
      nodes.map((node: any) => [node.nodeId, node]),
    );
    const visit = (node: any, depth: number) => {
      if (!node) return;
      const ref = node.backendDOMNodeId
        ? `0-${node.backendDOMNodeId}`
        : undefined;
      if (!node.ignored && ref) {
        // Resolve refs using backend node IDs, never a server-side page registry.
        xpathMap[ref] = `backend=${node.backendDOMNodeId}`;
      }
      const url = node.properties?.find(
        (p: { name: string }) => p.name === "url",
      )?.value?.value;
      if (url && ref) urlMap[ref] = url;
      if (!node.ignored)
        lines.push(
          `${"  ".repeat(depth)}${ref ? `[${ref}] ` : ""}${node.role?.value ?? "node"}: ${node.name?.value ?? ""}${node.value?.value ? ` = ${node.value.value}` : ""}`,
        );
      for (const child of node.childIds ?? [])
        visit(byId.get(child), depth + (node.ignored ? 0 : 1));
    };
    for (const node of nodes)
      if (!node.parentId || !byId.has(node.parentId)) visit(node, 0);
    return { formattedTree: lines.join("\n"), xpathMap, urlMap };
  }
}

export class Locator {
  private page: Page;
  private selector: string;
  constructor(page: Page, selector: string) {
    this.page = page;
    this.selector = selector;
  }
  private async apply(body: string): Promise<any> {
    const selector = this.selector.replace(/^xpath=/, "");
    if (selector.startsWith("backend=")) {
      const { object } = await this.page.send("DOM.resolveNode", {
        backendNodeId: Number(selector.slice(8)),
      });
      try {
        const result = await this.page.send("Runtime.callFunctionOn", {
          objectId: object.objectId,
          functionDeclaration: `function() { const el = this; ${body} }`,
          returnByValue: true,
          awaitPromise: true,
        });
        if (result.exceptionDetails)
          throw new Error(
            result.exceptionDetails.exception?.description ??
              "Element operation failed.",
          );
        return result.result.value;
      } finally {
        await this.page.send("Runtime.releaseObject", {
          objectId: object.objectId,
        });
      }
    }
    const lookup =
      selector.startsWith("/") || selector.startsWith("(")
        ? `document.evaluate(${JSON.stringify(selector)}, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue`
        : `document.querySelector(${JSON.stringify(selector)})`;
    return this.page.evaluate(`(() => { const el = ${lookup}; ${body} })()`);
  }
  exists(): Promise<boolean> {
    return this.apply("return !!el;");
  }
  async click() {
    const point = await this.centroid();
    await this.page.click(point.x, point.y);
  }
  async fill(value: string) {
    await this.apply(
      `if (!el) throw new Error('Element not found'); el.focus(); if (el.isContentEditable) el.textContent = ${JSON.stringify(value)}; else { const setter = Object.getOwnPropertyDescriptor(el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value').set; setter.call(el, ${JSON.stringify(value)}); } el.dispatchEvent(new Event('input', {bubbles:true})); el.dispatchEvent(new Event('change', {bubbles:true}));`,
    );
  }
  selectOption(values: string[]): Promise<string[]> {
    return this.apply(
      `if (!el) throw new Error('Element not found'); const values = ${JSON.stringify(values)}; for (const option of el.options) option.selected = values.includes(option.value); el.dispatchEvent(new Event('input', {bubbles:true})); el.dispatchEvent(new Event('change', {bubbles:true})); return [...el.selectedOptions].map(o => o.value);`,
    );
  }
  async setInputFiles(files: string[]): Promise<void> {
    // Paths refer to the browser host, never the Worker/function filesystem.
    const selector = this.selector.replace(/^xpath=/, "");
    const response = selector.startsWith("backend=")
      ? await this.page.send("DOM.resolveNode", {
          backendNodeId: Number(selector.slice(8)),
        })
      : await this.page.send("Runtime.evaluate", {
          expression:
            selector.startsWith("/") || selector.startsWith("(")
              ? `document.evaluate(${JSON.stringify(selector)}, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue`
              : `document.querySelector(${JSON.stringify(selector)})`,
        });
    const objectId: string | undefined = (response.object ?? response.result)
      ?.objectId;
    if (!objectId) throw new Error("File input not found.");
    try {
      await this.page.send("DOM.setFileInputFiles", { objectId, files });
    } finally {
      await this.page.send("Runtime.releaseObject", { objectId });
    }
  }
  async highlight({ durationMs }: { durationMs: number }) {
    await this.apply(
      `if (!el) throw new Error('Element not found'); const original = el.style.outline; el.style.outline = '2px solid red'; setTimeout(() => el.style.outline = original, ${durationMs});`,
    );
  }
  textContent(): Promise<string> {
    return this.apply(
      "if (!el) throw new Error('Element not found'); return el.textContent;",
    );
  }
  innerHtml(): Promise<string> {
    return this.apply(
      "if (!el) throw new Error('Element not found'); return el.innerHTML;",
    );
  }
  inputValue(): Promise<string> {
    return this.apply(
      "if (!el) throw new Error('Element not found'); return el.value;",
    );
  }
  isVisible(): Promise<boolean> {
    return this.apply(
      "return !!el && el.checkVisibility({checkOpacity:true, checkVisibilityCSS:true});",
    );
  }
  isChecked(): Promise<boolean> {
    return this.apply("return !!el && !!el.checked;");
  }
  centroid(): Promise<{ x: number; y: number }> {
    return this.apply(
      "if (!el) throw new Error('Element not found'); el.scrollIntoView({block:'center',inline:'center'}); const r = el.getBoundingClientRect(); if (!r.width || !r.height) throw new Error('Element is not visible'); return {x:r.x+r.width/2,y:r.y+r.height/2};",
    );
  }
}
