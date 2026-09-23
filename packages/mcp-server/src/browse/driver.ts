/**
 * Stateless browser driver.
 *
 * One program run = one CDP connection. `connect` attaches to a browser the
 * caller already has, the program's commands execute against it, and `close`
 * detaches without closing that browser. Nothing survives the request, so any
 * instance of this server can serve any request and a restart loses nothing.
 *
 * The command set and result shapes mirror the `browse` CLI's driver commands
 * (`stagehand/packages/cli/src/lib/driver/commands/*`), so a program reads like
 * the shell pipeline it replaces.
 */

import { NodeHtmlMarkdown } from "node-html-markdown";
import {
  connectBrowser,
  type BrowserContext,
  type LoadState,
  type MouseButton,
  type Page,
} from "./page.ts";
import type { OpenSocket } from "./transport.ts";


import { emptyRefMaps, resolveSelector, type FrameTarget, type RefMaps, type ResolvedSelector } from "./selectors.ts";

/** Raised for command-level failures, mirroring the CLI's error surface. */
export class BrowseCommandError extends Error {
  readonly code: string | undefined;
  constructor(message: string, code?: string) {
    super(message);
    this.name = "BrowseCommandError";
    this.code = code;
  }
}

/**
 * The only thing the sandbox layer needs from a browser connection. Narrowing to
 * this keeps the runner testable without a browser, and keeps the driver free to
 * change how it talks to Chrome.
 */
export interface CommandRunner {
  run(command: string, params: Record<string, unknown>): Promise<unknown>;
}

export interface ConnectOptions {
  /** Port, http(s) origin, or ws(s) URL. Resolved before attaching. */
  cdpUrl: string;
  signal?: AbortSignal;
  onEvent?: (message: string) => void;
  openSocket?: OpenSocket;
}

export interface PageSummary {
  index: number;
  targetId?: string;
  title?: string;
  url: string;
}

type Params = Record<string, unknown>;
type Handler = (session: BrowserSession, params: Params) => Promise<unknown>;

export class BrowserSession implements CommandRunner {
  private readonly refMaps: RefMaps = emptyRefMaps();
  private readonly cursorPages = new Set<string>();

  // Explicit fields rather than TypeScript parameter properties: Node runs this
  // source with type stripping, which does not support them.
  private readonly context: BrowserContext;
  readonly cdpUrl: string;

  private constructor(context: BrowserContext, cdpUrl: string) {
    this.context = context;
    this.cdpUrl = cdpUrl;
  }

  /** Attach to a browser that already exists. */
  static async connect({ cdpUrl, signal, onEvent, openSocket }: ConnectOptions): Promise<BrowserSession> {
    const context = await connectBrowser(cdpUrl, signal, openSocket);
    onEvent?.("attached over CDP");
    return new BrowserSession(context, cdpUrl);
  }

  async close(): Promise<void> {
    this.context.close();
  }

  async run(command: string, params: Params): Promise<unknown> {
    const handler = HANDLERS[command];
    if (!handler) throw new BrowseCommandError(`Unknown command "${command}".`);
    if (["open", "reload", "back", "forward", "tab.new", "tab.switch", "tab.close"].includes(command)) this.setRefMaps({});
    return handler(this, params);
  }

  // --------------------------------------------------------------- internals
  async activePage(): Promise<Page> {
    const active = await this.context.activePage();
    if (active) return active;
    const [first] = await this.context.pages();
    if (first) {
      await this.context.setActivePage(first);
      return first;
    }
    throw new BrowseCommandError(
      "No page is open in this browser. Call browse.open(url) or tab.new(url) first.",
      "no_active_page",
    );
  }

  /** Like `activePage`, but opens a tab when the browser has none. */
  async pageForOpen(): Promise<Page> {
    try {
      return await this.activePage();
    } catch {
      return this.context.newPage();
    }
  }

  selector(value: string): ResolvedSelector {
    return resolveSelector(value, this.refMaps);
  }

  locator(page: Page, value: string) {
    return page.locator(this.selector(value));
  }

  /** A frame by snapshot index (`"2"`), iframe ref (`"@0-10"`), or iframe selector. */
  async frame(page: Page, value: string): Promise<FrameTarget> {
    if (/^\d+$/.test(value)) {
      const frame = this.refMaps.frameMap[value];
      if (!frame)
        throw new BrowseCommandError(
          `No frame ${value} in this program's snapshot. Call browse.snapshot() first; ` +
            `frame indexes are the first number of a ref.`,
          "stale_ref",
        );
      return frame;
    }
    return this.locator(page, value).contentFrame();
  }

  setRefMaps(maps: Partial<RefMaps>): void {
    this.refMaps.xpathMap = maps.xpathMap ?? {};
    this.refMaps.urlMap = maps.urlMap ?? {};
    this.refMaps.frameMap = maps.frameMap ?? {};
  }

  markCursorEnabled(page: Page): void {
    this.cursorPages.add(page.pageId);
  }

  isCursorEnabled(page: Page): boolean {
    return this.cursorPages.has(page.pageId);
  }

  async pageSummaries(): Promise<PageSummary[]> {
    const pages = await this.context.pages();
    return Promise.all(
      pages.map(async (page, index) => ({
        index,
        targetId: page.pageId,
        title: await safeTitle(page),
        url: await page.url(),
      })),
    );
  }

  async openResult(page: Page): Promise<Record<string, unknown>> {
    return {
      cdpUrl: this.cdpUrl,
      pages: await this.pageSummaries(),
      selectedTargetId: page.pageId,
      title: await safeTitle(page),
      url: await page.url(),
    };
  }

  browserContext(): BrowserContext {
    return this.context;
  }
}

// ------------------------------------------------------------------ handlers

const HANDLERS: Record<string, Handler> = {
  // ---------------------------------------------------------------- navigate
  async open(session, params) {
    const page = await session.pageForOpen();
    await page.goto(str(params, "url"), navigationOptions(params));
    return session.openResult(page);
  },

  async reload(session, params) {
    const page = await session.activePage();
    await page.reload(navigationOptions(params));
    return session.openResult(page);
  },

  async back(session, params) {
    const page = await session.activePage();
    await page.goBack(navigationOptions(params));
    return session.openResult(page);
  },

  async forward(session, params) {
    const page = await session.activePage();
    await page.goForward(navigationOptions(params));
    return session.openResult(page);
  },

  // ---------------------------------------------------------------- snapshot
  async snapshot(session, params) {
    const page = await session.activePage();
    const snapshot = await page.snapshot();
    session.setRefMaps(snapshot);

    const tree = formatTree(snapshot.formattedTree, {
      filter: optStr(params, "filter"),
      maxDepth: optNum(params, "maxDepth"),
    });

    return optBool(params, "full")
      ? { tree, xpathMap: snapshot.xpathMap, urlMap: snapshot.urlMap }
      : { tree };
  },

  // ---------------------------------------------------------------- elements
  async click(session, params) {
    const page = await session.activePage();
    await session.locator(page, str(params, "selector")).click();
    return { clicked: true };
  },

  async fill(session, params) {
    const page = await session.activePage();
    const value = optStr(params, "value");
    if (value === undefined) throw new BrowseCommandError("fill requires a value.");
    await session.locator(page, str(params, "selector")).fill(value);
    const pressEnter = optBool(params, "pressEnter") ?? false;
    if (pressEnter) await page.keyPress("Enter");
    return { filled: true, pressedEnter: pressEnter };
  },

  async select(session, params) {
    const page = await session.activePage();
    const selected = await session
      .locator(page, str(params, "selector"))
      .selectOption(strArray(params, "values"));
    return { selected };
  },

  async upload(session, params) {
    const page = await session.activePage();
    const files = strArray(params, "files");
    await session.locator(page, str(params, "selector")).setInputFiles(files);
    return { files, uploaded: true };
  },

  async highlight(session, params) {
    const page = await session.activePage();
    await session
      .locator(page, str(params, "selector"))
      .highlight({ durationMs: optNum(params, "durationMs") ?? 2_000 });
    return { highlighted: true };
  },

  // ---------------------------------------------------------------- keyboard
  async type(session, params) {
    const page = await session.activePage();
    const delay = optNum(params, "delay");
    const mistakes = optBool(params, "mistakes");
    const options = {
      ...(delay === undefined ? {} : { delay }),
      ...(mistakes === undefined ? {} : { withMistakes: mistakes }),
    };
    await page.type(str(params, "text"), Object.keys(options).length ? options : undefined);
    return { typed: true };
  },

  async key(session, params) {
    const page = await session.activePage();
    const key = str(params, "key");
    await page.keyPress(key);
    return { pressed: key };
  },

  // --------------------------------------------------------------- page info
  async get(session, params) {
    const page = await session.activePage();
    const what = str(params, "what");

    if (what === "url") return { url: await page.url() };
    if (what === "title") return { title: await page.title() };

    const locator = session.locator(page, optStr(params, "selector") ?? "body");
    switch (what) {
      case "text":
        return { text: await locator.textContent() };
      case "html":
        return { html: await locator.innerHtml() };
      case "value":
        return { value: await locator.inputValue() };
      case "visible":
        return { visible: await locator.isVisible() };
      case "checked":
        return { checked: await locator.isChecked() };
      case "markdown":
        return { markdown: NodeHtmlMarkdown.translate(await locator.innerHtml()) };
      case "box": {
        const { x, y } = await locator.centroid();
        return { x: Math.round(x), y: Math.round(y) };
      }
      default:
        throw new BrowseCommandError(`Unknown property "${what}".`);
    }
  },

  async is(session, params) {
    const page = await session.activePage();
    const locator = session.locator(page, str(params, "selector"));
    const check = str(params, "check");
    if (check === "visible") return { visible: await locator.isVisible() };
    if (check === "checked") return { checked: await locator.isChecked() };
    throw new BrowseCommandError(`Unknown check "${check}".`);
  },

  async eval(session, params) {
    const page = await session.activePage();
    const expression = str(params, "expression");
    const frame = optStr(params, "frame");
    if (!frame) return { result: await page.evaluate(expression) };
    return { result: await page.evaluateIn(await session.frame(page, frame), expression) };
  },

  // ----------------------------------------------------------------- runtime
  async screenshot(session, params) {
    const page = await session.activePage();
    const type = optStr(params, "type");
    const quality = optNum(params, "quality");
    const clip = params.clip;
    const buffer = await page.screenshot({
      ...(optBool(params, "fullPage") === undefined ? {} : { fullPage: optBool(params, "fullPage") }),
      ...(type === undefined ? {} : { type: type as "png" | "jpeg" }),
      ...(quality === undefined ? {} : { quality }),
      ...(clip === undefined ? {} : { clip: clip as never }),
    });

    if (optStr(params, "path")) throw new BrowseCommandError("Screenshot paths are unavailable; use the returned base64 data.");
    return { base64: buffer };
  },

  async viewport(session, params) {
    const page = await session.activePage();
    const width = num(params, "width");
    const height = num(params, "height");
    await page.setViewportSize(width, height, {
      deviceScaleFactor: optNum(params, "scale") ?? 1,
    });
    return { viewport: { height, width } };
  },

  async wait(session, params) {
    const page = await session.activePage();
    const type = str(params, "type");
    const arg = optStr(params, "arg");
    const timeoutMs = optNum(params, "timeoutMs");

    if (type === "load") {
      await page.waitForLoadState((arg as LoadState | undefined) ?? "load", timeoutMs);
    } else if (type === "selector") {
      if (!arg) throw new BrowseCommandError("wait selector requires a target.");
      await page.waitForSelector(session.selector(arg), {
        state: (optStr(params, "state") ?? "visible") as never,
        timeout: timeoutMs ?? 30_000,
      });
    } else if (type === "timeout") {
      const ms = Number(arg ?? 0);
      if (!Number.isInteger(ms) || ms < 0) {
        throw new BrowseCommandError("wait timeout requires a non-negative integer of milliseconds.");
      }
      await page.waitForTimeout(ms);
    } else {
      throw new BrowseCommandError(`Unknown wait type "${type}".`);
    }
    return { waited: true };
  },

  async cursor(session) {
    const page = await session.activePage();
    await page.addInitScript(CURSOR_OVERLAY_SCRIPT);
    await page.evaluate(CURSOR_OVERLAY_SCRIPT);
    session.markCursorEnabled(page);
    return { cursor: "enabled" };
  },

  // ------------------------------------------------------------------- mouse
  async "mouse.click"(session, params) {
    const page = await session.activePage();
    const x = num(params, "x");
    const y = num(params, "y");
    await moveCursorOverlay(session, page, x, y);
    const button = optStr(params, "button");
    const clickCount = optNum(params, "clickCount");
    await page.click(x, y, {
      ...(button === undefined ? {} : { button: button as MouseButton }),
      ...(clickCount === undefined ? {} : { clickCount }),
    });
    return { clicked: true };
  },

  async "mouse.hover"(session, params) {
    const page = await session.activePage();
    const x = num(params, "x");
    const y = num(params, "y");
    await moveCursorOverlay(session, page, x, y);
    await page.hover(x, y);
    return { hovered: true };
  },

  async "mouse.scroll"(session, params) {
    const page = await session.activePage();
    const x = num(params, "x");
    const y = num(params, "y");
    await moveCursorOverlay(session, page, x, y);
    await page.scroll(x, y, num(params, "deltaX"), num(params, "deltaY"));
    return { scrolled: true };
  },

  async "mouse.drag"(session, params) {
    const page = await session.activePage();
    const fromX = num(params, "fromX");
    const fromY = num(params, "fromY");
    const toX = num(params, "toX");
    const toY = num(params, "toY");
    await moveCursorOverlay(session, page, fromX, fromY);
    const button = optStr(params, "button");
    const steps = optNum(params, "steps");
    const delay = optNum(params, "delay");
    await page.dragAndDrop(fromX, fromY, toX, toY, {
      ...(button === undefined ? {} : { button: button as MouseButton }),
      ...(steps === undefined ? {} : { steps }),
      ...(delay === undefined ? {} : { delay }),
    });
    await moveCursorOverlay(session, page, toX, toY);
    return { dragged: true };
  },

  // -------------------------------------------------------------------- tabs
  async "tab.list"(session) {
    return { tabs: await session.pageSummaries() };
  },

  async "tab.new"(session, params) {
    const context = session.browserContext();
    const url = optStr(params, "url");
    const page = await context.newPage(url);
    await context.setActivePage(page);
    const pages = await context.pages();
    return {
      active: true,
      index: pages.findIndex((candidate) => candidate.pageId === page.pageId),
      targetId: page.pageId,
      title: await safeTitle(page),
      url: await page.url(),
    };
  },

  async "tab.switch"(session, params) {
    const { index, page } = await resolveTab(session, str(params, "tab"));
    await session.browserContext().setActivePage(page);
    return {
      index,
      switched: true,
      targetId: page.pageId,
      title: await safeTitle(page),
      url: await page.url(),
    };
  },

  async "tab.close"(session, params) {
    const context = session.browserContext();
    const pages = await context.pages();
    if (pages.length === 1) throw new BrowseCommandError("Cannot close the last tab.");

    const tab = optStr(params, "tab");
    const active = await context.activePage();
    const resolved = tab
      ? await resolveTab(session, tab)
      : { index: Math.max(0, pages.findIndex((p) => p.pageId === active?.pageId)), page: active ?? pages[0]! };

    const closedTargetId = resolved.page.pageId;
    await resolved.page.close();

    const remaining = (await context.pages()).filter((page) => page.pageId !== closedTargetId);
    let selected = remaining.find((page) => page.pageId === active?.pageId);
    if (!selected) {
      selected = remaining[Math.min(resolved.index, remaining.length - 1)] ?? remaining[0];
      if (selected) await context.setActivePage(selected);
    }

    return {
      closed: true,
      index: resolved.index,
      selectedTargetId: selected?.pageId,
      targetId: closedTargetId,
    };
  },

  // ----------------------------------------------------------------- session
  async status(session) {
    const pages = await session.pageSummaries();
    const active = await session.browserContext().activePage();
    return {
      connected: true,
      cdpUrl: session.cdpUrl,
      pages,
      selectedTargetId: active?.pageId,
      ...(active ? { title: await safeTitle(active), url: await active.url() } : {}),
    };
  },
};

// ------------------------------------------------------------------- helpers

async function resolveTab(
  session: BrowserSession,
  tab: string,
): Promise<{ index: number; page: Page }> {
  const pages = await session.browserContext().pages();
  if (/^\d+$/.test(tab)) {
    const index = Number.parseInt(tab, 10);
    const page = pages[index];
    if (!page) {
      throw new BrowseCommandError(`Tab index ${index} out of range (0-${pages.length - 1}).`);
    }
    return { index, page };
  }

  const index = pages.findIndex((page) => page.pageId === tab);
  if (index === -1) {
    throw new BrowseCommandError(`Tab "${tab}" was not found. Call tab.list() for current tabs.`);
  }
  return { index, page: pages[index]! };
}

async function safeTitle(page: Page): Promise<string> {
  try {
    return await page.title();
  } catch {
    return "";
  }
}

function navigationOptions(params: Params): { timeout?: number; waitUntil?: LoadState } {
  const timeout = optNum(params, "timeoutMs");
  const waitUntil = optStr(params, "waitUntil") as LoadState | undefined;
  return {
    ...(timeout === undefined ? {} : { timeout }),
    ...(waitUntil === undefined ? {} : { waitUntil }),
  };
}

async function moveCursorOverlay(
  session: BrowserSession,
  page: Page,
  x: number,
  y: number,
): Promise<void> {
  if (!session.isCursorEnabled(page)) return;
  // Visual only: a navigation can destroy the execution context, and that must
  // never invalidate the real mouse action.
  try {
    await page.evaluate(`window.__browseCursor && window.__browseCursor(${x}, ${y})`);
  } catch {
    // best effort
  }
}

/** Minimal cursor overlay, so mouse commands are visible in a live view. */
const CURSOR_OVERLAY_SCRIPT = `(() => {
  if (window.__browseCursor) return;
  const dot = document.createElement("div");
  dot.style.cssText = [
    "position:fixed","z-index:2147483647","width:14px","height:14px",
    "margin:-7px 0 0 -7px","border-radius:50%","pointer-events:none",
    "background:rgba(255,64,64,.65)","border:2px solid #fff",
    "box-shadow:0 0 6px rgba(0,0,0,.5)","transition:left .08s,top .08s",
    "left:-100px","top:-100px",
  ].join(";");
  const attach = () => document.body && document.body.appendChild(dot);
  if (document.body) attach(); else document.addEventListener("DOMContentLoaded", attach);
  window.__browseCursor = (x, y) => { dot.style.left = x + "px"; dot.style.top = y + "px"; };
})()`;

/** Filter and depth-trim a formatted accessibility tree, keeping ancestors. */
export function formatTree(
  tree: string,
  { filter, maxDepth }: { filter?: string | undefined; maxDepth?: number | undefined },
): string {
  let lines = tree.split("\n");

  if (maxDepth !== undefined) {
    lines = lines.filter((line) => indentWidth(line) / 2 <= maxDepth);
  }

  if (filter) {
    const match = matcher(filter);
    const keep = new Set<number>();
    const ancestors: number[] = [];
    lines.forEach((line, index) => {
      const depth = indentWidth(line);
      while (ancestors.length > 0 && indentWidth(lines[ancestors.at(-1)!]!) >= depth) {
        ancestors.pop();
      }
      if (match(line)) {
        keep.add(index);
        for (const ancestor of ancestors) keep.add(ancestor);
      }
      ancestors.push(index);
    });
    lines = lines.filter((_, index) => keep.has(index));
  }

  return lines.join("\n");
}

function matcher(filter: string): (line: string) => boolean {
  if (filter.length > 1 && filter.startsWith("/")) {
    const end = filter.lastIndexOf("/");
    if (end > 0) {
      try {
        const regex = new RegExp(filter.slice(1, end), filter.slice(end + 1));
        return (line) => regex.test(line);
      } catch {
        // fall through to substring matching
      }
    }
  }
  const needle = filter.toLowerCase();
  return (line) => line.toLowerCase().includes(needle);
}

function indentWidth(line: string): number {
  return line.length - line.trimStart().length;
}

// -------------------------------------------------------- param accessors

function str(params: Params, key: string): string {
  const value = params[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new BrowseCommandError(`Expected a non-empty string for "${key}".`);
  }
  return value;
}

function optStr(params: Params, key: string): string | undefined {
  const value = params[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new BrowseCommandError(`Expected a string for "${key}".`);
  return value;
}

function num(params: Params, key: string): number {
  const value = params[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new BrowseCommandError(`Expected a number for "${key}".`);
  }
  return value;
}

function optNum(params: Params, key: string): number | undefined {
  const value = params[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new BrowseCommandError(`Expected a number for "${key}".`);
  }
  return value;
}

function optBool(params: Params, key: string): boolean | undefined {
  const value = params[key];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new BrowseCommandError(`Expected a boolean for "${key}".`);
  return value;
}

function strArray(params: Params, key: string): string[] {
  const value = params[key];
  const list = Array.isArray(value) ? value : [value];
  if (list.length === 0 || list.some((entry) => typeof entry !== "string")) {
    throw new BrowseCommandError(`Expected one or more strings for "${key}".`);
  }
  return list as string[];
}
