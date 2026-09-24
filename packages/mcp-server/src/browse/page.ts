/** Direct CDP implementation: no browser extension, filesystem, or Node APIs. */

import { resolveCdpUrl } from "./cdp.ts";
import type { FrameTarget, ResolvedSelector } from "./selectors.ts";
import { CdpConnection, type CdpPayload, type OpenSocket, openWebSocket } from "./transport.ts";

export type LoadState = "load" | "domcontentloaded" | "networkidle";
export type MouseButton = "left" | "middle" | "right";
type NavigationOptions = { timeout?: number; waitUntil?: LoadState };
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

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
          await page.trackFrames();
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
      if (await page.evaluate("document.hasFocus()").catch(() => false)) return page;
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
  /** Out-of-process iframes, keyed by frame id (which is also their target id). */
  private oopifs = new Map<string, { sessionId: string; parentSessionId: string }>();
  private attaching = new Set<Promise<unknown>>();
  /** Each session's frames → the id of their main-world execution context. */
  private worlds = new Map<string, Map<string, number>>();
  private runtimeEnabled = new Map<string, Promise<unknown>>();
  constructor(cdp: CdpConnection, id: string, sessionId: string, signal?: AbortSignal) {
    this.cdp = cdp;
    this.pageId = id;
    this.sessionId = sessionId;
    this.signal = signal;
    cdp.onEvent((method, params, session) => {
      if (method === "Target.attachedToTarget" && this.ownsSession(session)) {
        if (params.targetInfo?.type !== "iframe") return;
        this.oopifs.set(params.targetInfo.targetId, {
          sessionId: params.sessionId,
          parentSessionId: session,
        });
        // A cross-site frame can hold cross-site frames of its own.
        this.watch(this.autoAttach(params.sessionId));
        return;
      }
      if (method === "Target.detachedFromTarget" && this.ownsSession(session)) {
        for (const [frameId, frame] of this.oopifs)
          if (frame.sessionId === params.sessionId) this.oopifs.delete(frameId);
        return;
      }
      if (method.startsWith("Runtime.executionContext") && this.ownsSession(session)) {
        this.trackWorld(session, method, params);
        return;
      }
      if (session !== sessionId) return;
      if (method === "Network.requestWillBeSent") {
        this.requests.add(params.requestId);
        this.networkChangedAt = Date.now();
      } else if (method === "Network.loadingFinished" || method === "Network.loadingFailed") {
        this.requests.delete(params.requestId);
        this.networkChangedAt = Date.now();
      }
    });
  }
  send(method: string, params: object = {}) {
    return this.cdp.send(method, params, this.sessionId);
  }
  /** Send to the session that owns a frame: this page's, or an iframe target's. */
  sendTo(sessionId: string, method: string, params: object = {}) {
    return this.cdp.send(method, params, sessionId);
  }
  get mainSession(): string {
    return this.sessionId;
  }

  // ---------------------------------------------------------------- frames
  /**
   * Attach to cross-site iframes. Site isolation runs them in other processes,
   * as separate CDP targets that never appear in this page's frame tree.
   */
  async trackFrames() {
    await this.autoAttach(this.sessionId).catch(() => {});
  }
  private autoAttach(sessionId: string) {
    return this.cdp.send(
      "Target.setAutoAttach",
      { autoAttach: true, waitForDebuggerOnStart: false, flatten: true },
      sessionId,
    );
  }
  private watch(pending: Promise<unknown>) {
    const tracked = pending.catch(() => {}).finally(() => this.attaching.delete(tracked));
    this.attaching.add(tracked);
  }
  private ownsSession(session: string | undefined): session is string {
    if (session === this.sessionId) return true;
    for (const frame of this.oopifs.values()) if (frame.sessionId === session) return true;
    return false;
  }
  private trackWorld(session: string, method: string, params: CdpPayload) {
    let worlds = this.worlds.get(session);
    if (!worlds) {
      worlds = new Map();
      this.worlds.set(session, worlds);
    }
    if (method === "Runtime.executionContextsCleared") return worlds.clear();
    if (method === "Runtime.executionContextDestroyed") {
      for (const [frameId, id] of worlds)
        if (id === params.executionContextId) worlds.delete(frameId);
      return;
    }
    const { id, auxData } = params.context ?? {};
    if (method === "Runtime.executionContextCreated" && auxData?.isDefault && auxData.frameId)
      worlds.set(auxData.frameId, id);
  }
  /**
   * Evaluate in a frame's main world, where the page's own globals live. Chrome
   * only reports context ids after Runtime.enable, so enable it per session on
   * first use; existing contexts arrive before enable returns.
   */
  async evaluateIn<T = unknown>(frame: FrameTarget, expression: string): Promise<T> {
    let enabling = this.runtimeEnabled.get(frame.sessionId);
    if (!enabling) {
      enabling = this.sendTo(frame.sessionId, "Runtime.enable");
      this.runtimeEnabled.set(frame.sessionId, enabling);
    }
    await enabling;
    const contextId = this.worlds.get(frame.sessionId)?.get(frame.frameId);
    if (contextId === undefined)
      throw new Error("That frame has no document yet. Wait for it to load and try again.");
    const response = await this.sendTo(frame.sessionId, "Runtime.evaluate", {
      expression,
      contextId,
      returnByValue: true,
      awaitPromise: true,
    });
    if (response.exceptionDetails)
      throw new Error(
        response.exceptionDetails.exception?.description ?? response.exceptionDetails.text,
      );
    return response.result.value;
  }
  /** Wait until every nested iframe target has been attached. */
  async settleFrames() {
    while (this.attaching.size > 0) await Promise.all(this.attaching);
  }
  /** The session that owns a frame's document, seen from the session holding its owner. */
  frameSession(frameId: string, ownerSession: string): string {
    return this.oopifs.get(frameId)?.sessionId ?? ownerSession;
  }
  /**
   * Offset from a session's viewport to the top page's. Same-process frames
   * already report page coordinates; each cross-site hop adds the position of
   * the iframe element that hosts it.
   */
  async offsetOf(sessionId: string): Promise<{ x: number; y: number }> {
    let x = 0;
    let y = 0;
    while (sessionId !== this.sessionId) {
      const entry = [...this.oopifs].find(([, frame]) => frame.sessionId === sessionId);
      if (!entry) throw new Error("The element's frame is no longer attached.");
      const [frameId, { parentSessionId }] = entry;
      const { backendNodeId } = await this.sendTo(parentSessionId, "DOM.getFrameOwner", {
        frameId,
      });
      const { model } = await this.sendTo(parentSessionId, "DOM.getBoxModel", { backendNodeId });
      x += model.content[0];
      y += model.content[1];
      sessionId = parentSessionId;
    }
    return { x, y };
  }
  /** Every frame in the page, with the iframe element that hosts it. */
  private async frames(): Promise<SnapshotFrame[]> {
    await this.settleFrames();
    const sessions: Array<{ sessionId: string; parentSessionId?: string; frameId?: string }> = [
      { sessionId: this.sessionId },
      ...[...this.oopifs].map(([frameId, frame]) => ({ ...frame, frameId })),
    ];
    const perSession = await Promise.all(
      sessions.map(async ({ sessionId, parentSessionId }) => {
        const { frameTree } = await this.sendTo(sessionId, "Page.getFrameTree").catch(() => ({
          frameTree: undefined,
        }));
        if (!frameTree) return [];
        const found: SnapshotFrame[] = [];
        const walk = (node: FrameTreeNode, root: boolean) => {
          found.push({
            frameId: node.frame.id,
            sessionId,
            ownerSession: root ? parentSessionId : sessionId,
            nodes: [],
          });
          for (const child of node.childFrames ?? []) walk(child, false);
        };
        walk(frameTree, true);
        return found;
      }),
    );
    const frames = perSession.flat();
    await Promise.all(
      frames.map(async (frame) => {
        // A frame can navigate or detach mid-snapshot; leave it out rather than fail.
        const [tree, owner] = await Promise.all([
          this.sendTo(frame.sessionId, "Accessibility.getFullAXTree", {
            frameId: frame.frameId,
          }).catch(() => undefined),
          frame.ownerSession
            ? this.sendTo(frame.ownerSession, "DOM.getFrameOwner", {
                frameId: frame.frameId,
              }).catch(() => undefined)
            : undefined,
        ]);
        frame.nodes = tree?.nodes ?? [];
        if (owner?.backendNodeId) frame.ownerNode = owner.backendNodeId;
      }),
    );
    return frames;
  }
  async evaluate<T = unknown>(expression: string): Promise<T> {
    const response = await this.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (response.exceptionDetails)
      throw new Error(
        response.exceptionDetails.exception?.description ?? response.exceptionDetails.text,
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
    if (entry) await this.send("Page.navigateToHistoryEntry", { entryId: entry.id });
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
  locator(target: ResolvedSelector) {
    return new Locator(this, target);
  }
  async waitForLoadState(state: LoadState = "load", timeout = 30_000) {
    if (state === "networkidle") {
      const started = Date.now();
      return this.poll(
        async () =>
          this.requests.size === 0 && Date.now() - Math.max(started, this.networkChangedAt) >= 500,
        timeout,
      );
    }
    await this.poll(async () => {
      const ready = await this.evaluate("document.readyState").catch(() => "loading");
      return state === "domcontentloaded" ? ready !== "loading" : ready === "complete";
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
  /** Resolve after the page draws a frame; capped, since hidden tabs may never draw. */
  async nextFrame() {
    await this.evaluate(
      "new Promise((done) => { requestAnimationFrame(() => requestAnimationFrame(done)); setTimeout(done, 100); })",
    ).catch(() => {});
  }
  async waitForTimeout(ms: number) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      this.signal?.throwIfAborted();
      await pause(Math.min(100, deadline - Date.now()));
    }
  }
  async waitForSelector(
    target: ResolvedSelector,
    { state, timeout }: { state: string; timeout: number },
  ) {
    const locator = this.locator(target);
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
    const key = parts.pop() ?? "";
    const modifiers = parts.reduce(
      (n, p) => n | ({ Alt: 1, Control: 2, Ctrl: 2, Meta: 4, Shift: 8 }[p] ?? 0),
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
    const text = key === "Enter" ? "\r" : key.length === 1 && !(modifiers & 7) ? key : undefined;
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
  async type(text: string, options?: { delay?: number; withMistakes?: boolean }) {
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
    { button = "left", clickCount = 1 }: { button?: MouseButton; clickCount?: number } = {},
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
      ...(clip ? { clip: { ...clip, scale: 1 }, captureBeyondViewport: true } : {}),
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
  /**
   * The accessibility tree of the page and every frame in it, cross-site ones
   * included, each spliced in under its iframe. Refs are `<frame>-<node>`.
   */
  async snapshot() {
    const frames = await this.frames();
    const hosted = new Map<string, SnapshotFrame>();
    for (const frame of frames)
      if (frame.ownerSession && frame.ownerNode)
        hosted.set(`${frame.ownerSession}:${frame.ownerNode}`, frame);

    const xpathMap: Record<string, string> = {};
    const urlMap: Record<string, string> = {};
    const frameMap: Record<string, FrameTarget> = {};
    const lines: string[] = [];
    let nextFrame = 0;

    const renderFrame = (frame: SnapshotFrame, depth: number) => {
      const index = nextFrame++;
      frameMap[index] = { sessionId: frame.sessionId, frameId: frame.frameId };
      const byId = new Map(frame.nodes.map((node) => [node.nodeId, node]));
      const visit = (node: AXNode | undefined, depth: number, parentName: string | undefined) => {
        if (!node) return;
        const role = node.role?.value ?? "node";
        const name = node.name?.value ?? "";
        const ref = node.backendDOMNodeId ? `${index}-${node.backendDOMNodeId}` : undefined;
        // Text runs repeat their parent's name; they cost tokens and add nothing.
        const redundant =
          role === "InlineTextBox" || (role === "StaticText" && name === parentName);
        const shown = !node.ignored && !redundant;
        if (shown && ref) {
          // Resolve refs using backend node IDs, never a server-side page registry.
          xpathMap[ref] = `backend=${node.backendDOMNodeId}`;
          const url = node.properties?.find((p) => p.name === "url")?.value?.value;
          if (typeof url === "string" && url) urlMap[ref] = url;
        }
        if (shown)
          lines.push(
            `${"  ".repeat(depth)}${ref ? `[${ref}] ` : ""}${role}: ${name}${node.value?.value ? ` = ${node.value.value}` : ""}`,
          );
        const childDepth = depth + (shown ? 1 : 0);
        for (const child of node.childIds ?? [])
          visit(byId.get(child), childDepth, node.ignored ? parentName : name);
        const inner =
          node.backendDOMNodeId && hosted.get(`${frame.sessionId}:${node.backendDOMNodeId}`);
        if (inner) renderFrame(inner, childDepth);
      };
      for (const node of frame.nodes)
        if (!node.parentId || !byId.has(node.parentId)) visit(node, depth, undefined);
    };

    const top = frames.find((frame) => frame.sessionId === this.sessionId && !frame.ownerSession);
    if (top) renderFrame(top, 0);
    return { formattedTree: lines.join("\n"), xpathMap, urlMap, frameMap };
  }
}

interface SnapshotFrame {
  frameId: string;
  sessionId: string;
  /** Session holding the <iframe> element; unset for the top frame. */
  ownerSession: string | undefined;
  ownerNode?: number;
  nodes: AXNode[];
}

/** The fields of CDP's `Accessibility.AXNode` that snapshots read. */
interface AXNode {
  nodeId: string;
  parentId?: string;
  childIds?: string[];
  backendDOMNodeId?: number;
  ignored?: boolean;
  role?: { value?: string };
  name?: { value?: string };
  value?: { value?: unknown };
  properties?: Array<{ name: string; value?: { value?: unknown } }>;
}

/** CDP's `Page.FrameTree`, trimmed to what `frames()` walks. */
interface FrameTreeNode {
  frame: { id: string };
  childFrames?: FrameTreeNode[];
}

/** CDP's `DOM.Quad`: four corners as x/y pairs, clockwise. */
type Quad = [number, number, number, number, number, number, number, number];

/** Where a resolved element lives: its frame's session and a remote object. */
interface ElementHandle {
  sessionId: string;
  objectId: string;
}

/**
 * Find an element by CSS, piercing open shadow roots when the light DOM has no
 * match. Closed shadow roots are reachable only through snapshot refs.
 */
const DEEP_QUERY = `(selector) => {
  const direct = document.querySelector(selector);
  if (direct) return direct;
  const roots = [document];
  for (let i = 0; i < roots.length; i++) {
    const walker = document.createTreeWalker(roots[i], NodeFilter.SHOW_ELEMENT);
    for (let node = walker.currentNode; node; node = walker.nextNode()) {
      if (!node.shadowRoot) continue;
      const hit = node.shadowRoot.querySelector(selector);
      if (hit) return hit;
      roots.push(node.shadowRoot);
    }
  }
  return null;
}`;

function lookupExpression(selector: string): string {
  return selector.startsWith("/") || selector.startsWith("(")
    ? `document.evaluate(${JSON.stringify(selector)}, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue`
    : `(${DEEP_QUERY})(${JSON.stringify(selector)})`;
}

/**
 * An element target: a snapshot ref (already bound to its frame), or a CSS /
 * XPath selector. Selectors may hop into iframes with `>>`, e.g.
 * `iframe#checkout >> input[name=card]`, and CSS pierces open shadow roots.
 */
export class Locator {
  private page: Page;
  private target: ResolvedSelector;
  constructor(page: Page, target: ResolvedSelector) {
    this.page = page;
    this.target = target;
  }
  /** Resolve to a remote object in the frame that owns the element, or null. */
  private async resolve(): Promise<ElementHandle | null> {
    const selector = this.target.selector.replace(/^xpath=/, "");
    if (selector.startsWith("backend=")) {
      const sessionId = this.target.frame?.sessionId ?? this.page.mainSession;
      const { object } = await this.page
        .sendTo(sessionId, "DOM.resolveNode", { backendNodeId: Number(selector.slice(8)) })
        .catch(() => {
          throw new Error("That element is gone. Take a new snapshot.");
        });
      return { sessionId, objectId: object.objectId };
    }

    const hops = selector.split(/\s+>>\s+/);
    let sessionId = this.page.mainSession;
    let contextId: number | undefined;
    for (const [index, hop] of hops.entries()) {
      const { result, exceptionDetails } = await this.page.sendTo(sessionId, "Runtime.evaluate", {
        expression: lookupExpression(hop),
        ...(contextId === undefined ? {} : { contextId }),
      });
      if (exceptionDetails)
        throw new Error(exceptionDetails.exception?.description ?? `Invalid selector "${hop}".`);
      if (!result.objectId) return null;
      if (index === hops.length - 1) return { sessionId, objectId: result.objectId };

      // Step into the iframe this hop matched.
      const { node } = await this.page.sendTo(sessionId, "DOM.describeNode", {
        objectId: result.objectId,
      });
      await this.page.sendTo(sessionId, "Runtime.releaseObject", { objectId: result.objectId });
      if (!node.frameId) throw new Error(`"${hop}" is not an iframe, so ">>" cannot enter it.`);
      await this.page.settleFrames();
      const frameSession = this.page.frameSession(node.frameId, sessionId);
      if (frameSession !== sessionId) {
        // Cross-site: the frame's own target, in its default context.
        sessionId = frameSession;
        contextId = undefined;
      } else {
        // Same process: an isolated world shares the frame's DOM.
        ({ executionContextId: contextId } = await this.page.sendTo(
          sessionId,
          "Page.createIsolatedWorld",
          {
            frameId: node.frameId,
            worldName: "browse",
          },
        ));
      }
    }
    return null;
  }
  private async withElement<T>(action: (element: ElementHandle) => Promise<T>): Promise<T> {
    const element = await this.resolve();
    if (!element) throw new Error("Element not found");
    try {
      return await action(element);
    } finally {
      await this.page
        .sendTo(element.sessionId, "Runtime.releaseObject", { objectId: element.objectId })
        .catch(() => {});
    }
  }
  /** The frame an iframe element hosts. */
  contentFrame(): Promise<FrameTarget> {
    return this.withElement(async ({ sessionId, objectId }) => {
      const { node } = await this.page.sendTo(sessionId, "DOM.describeNode", { objectId });
      if (!node.frameId) throw new Error("The frame target is not an iframe.");
      await this.page.settleFrames();
      return { sessionId: this.page.frameSession(node.frameId, sessionId), frameId: node.frameId };
    });
  }
  /** Run `body` with `el` bound to the element, or to null when nothing matches. */
  private async apply<T = unknown>(body: string): Promise<T> {
    const element = await this.resolve();
    if (!element) return this.page.evaluate<T>(`(() => { const el = null; ${body} })()`);
    try {
      const result = await this.page.sendTo(element.sessionId, "Runtime.callFunctionOn", {
        objectId: element.objectId,
        functionDeclaration: `function() { const el = this; ${body} }`,
        returnByValue: true,
        awaitPromise: true,
      });
      if (result.exceptionDetails)
        throw new Error(
          result.exceptionDetails.exception?.description ?? "Element operation failed.",
        );
      return result.result.value;
    } finally {
      await this.page
        .sendTo(element.sessionId, "Runtime.releaseObject", { objectId: element.objectId })
        .catch(() => {});
    }
  }
  exists(): Promise<boolean> {
    return this.apply("return !!el;");
  }
  /**
   * Click once the element holds still. Chrome routes mouse input between
   * frames using hit-test data from the last drawn frame, so a click sent right
   * after a scroll or layout change can land in the wrong frame. Wait for a
   * frame and require two readings to agree, as a user's eye would.
   */
  async click() {
    let point = await this.centroid();
    for (let attempt = 0; attempt < 10; attempt++) {
      await this.page.nextFrame();
      const next = await this.centroid();
      const settled = Math.abs(next.x - point.x) < 1 && Math.abs(next.y - point.y) < 1;
      point = next;
      if (settled) break;
    }
    await this.page.click(point.x, point.y);
  }
  async fill(value: string) {
    await this.apply(
      `if (!el) throw new Error('Element not found'); el.focus(); if (el.isContentEditable) el.textContent = ${JSON.stringify(value)}; else { const setter = Object.getOwnPropertyDescriptor(el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value').set; setter.call(el, ${JSON.stringify(value)}); } el.dispatchEvent(new Event('input', {bubbles:true, composed:true})); el.dispatchEvent(new Event('change', {bubbles:true}));`,
    );
  }
  selectOption(values: string[]): Promise<string[]> {
    return this.apply(
      `if (!el) throw new Error('Element not found'); const values = ${JSON.stringify(values)}; for (const option of el.options) option.selected = values.includes(option.value); el.dispatchEvent(new Event('input', {bubbles:true})); el.dispatchEvent(new Event('change', {bubbles:true})); return [...el.selectedOptions].map(o => o.value);`,
    );
  }
  async setInputFiles(files: string[]): Promise<void> {
    // Paths refer to the browser host, never the Worker/function filesystem.
    await this.withElement(({ sessionId, objectId }) =>
      this.page.sendTo(sessionId, "DOM.setFileInputFiles", { objectId, files }),
    );
  }
  async highlight({ durationMs }: { durationMs: number }) {
    await this.apply(
      `if (!el) throw new Error('Element not found'); const original = el.style.outline; el.style.outline = '2px solid red'; setTimeout(() => el.style.outline = original, ${durationMs});`,
    );
  }
  textContent(): Promise<string> {
    return this.apply("if (!el) throw new Error('Element not found'); return el.textContent;");
  }
  innerHtml(): Promise<string> {
    return this.apply("if (!el) throw new Error('Element not found'); return el.innerHTML;");
  }
  inputValue(): Promise<string> {
    return this.apply("if (!el) throw new Error('Element not found'); return el.value;");
  }
  isVisible(): Promise<boolean> {
    return this.apply(
      "return !!el && el.checkVisibility({checkOpacity:true, checkVisibilityCSS:true});",
    );
  }
  isChecked(): Promise<boolean> {
    return this.apply("return !!el && !!el.checked;");
  }
  /** The element's center in top-page viewport coordinates, scrolled into view. */
  centroid(): Promise<{ x: number; y: number }> {
    return this.withElement(async ({ sessionId, objectId }) => {
      await this.page.sendTo(sessionId, "DOM.scrollIntoViewIfNeeded", { objectId }).catch(() => {});
      const { quads } = await this.page
        .sendTo(sessionId, "DOM.getContentQuads", { objectId })
        .catch(() => ({ quads: [] }));
      const quad = (quads as Quad[]).find((q) => area(q) > 0);
      if (!quad) throw new Error("Element is not visible");
      const [x1, y1, x2, y2, x3, y3, x4, y4] = quad;
      const offset = await this.page.offsetOf(sessionId);
      return {
        x: offset.x + (x1 + x2 + x3 + x4) / 4,
        y: offset.y + (y1 + y2 + y3 + y4) / 4,
      };
    });
  }
}

function area([x1, y1, x2, y2, x3, y3, x4, y4]: Quad): number {
  return (
    Math.abs(x1 * y2 - x2 * y1 + x2 * y3 - x3 * y2 + x3 * y4 - x4 * y3 + x4 * y1 - x1 * y4) / 2
  );
}
