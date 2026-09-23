/**
 * Canonical `browse` command table.
 *
 * This is the single source of truth for code mode. Every entry maps one
 * `browse` CLI command to one sandbox-callable TypeScript function, and is used
 * to generate three things that therefore can never drift apart:
 *
 *   1. the QuickJS host functions the sandbox calls (./host-functions.ts)
 *   2. the `.d.ts` API surface handed to the agent (./dts.ts)
 *   3. the driver daemon wire params (./backend.ts)
 *
 * Command names, param names, and result shapes mirror
 * `stagehand/packages/cli/src/lib/driver/commands/*` exactly, so a program
 * written here behaves like the equivalent shell pipeline.
 */

/** Driver commands understood by the browse daemon, plus the two session-level ops. */
export const WIRE_COMMANDS = [
  "back",
  "click",
  "cursor",
  "eval",
  "fill",
  "forward",
  "get",
  "highlight",
  "is",
  "key",
  "mouse.click",
  "mouse.drag",
  "mouse.hover",
  "mouse.scroll",
  "open",
  "reload",
  "screenshot",
  "select",
  "snapshot",
  "tab.close",
  "tab.list",
  "tab.new",
  "tab.switch",
  "type",
  "upload",
  "viewport",
  "wait",
  "status",
] as const;

export type WireCommand = (typeof WIRE_COMMANDS)[number];

/** Sandbox globals. Host functions are exposed exactly one level deep. */
export type GroupName = "browse" | "mouse" | "tab";

type Coercion = "array" | "string";

export interface ArgSpec {
  /** TypeScript parameter name. */
  name: string;
  /** Driver param key. Defaults to `name`. */
  param?: string;
  /** TypeScript type as written in the generated `.d.ts`. */
  type: string;
  optional?: boolean;
  /** Normalize before sending: `array` wraps a scalar, `string` stringifies. */
  coerce?: Coercion;
  doc?: string;
}

export interface OptionSpec {
  /** Key in the trailing options object; also the driver param key. */
  name: string;
  type: string;
  doc?: string;
}

export interface CommandSpec {
  group: GroupName;
  /** Function name within the group. */
  fn: string;
  wire: WireCommand;
  /** Equivalent shell invocation, shown in the generated docs. */
  cli: string;
  summary: string;
  args?: ArgSpec[];
  options?: OptionSpec[];
  /** TypeScript type of the resolved value. */
  returns: string;
  /** Extra guidance rendered into the doc comment. */
  notes?: string[];
}

const NAV_OPTIONS: OptionSpec[] = [
  {
    name: "waitUntil",
    type: "LoadState",
    doc: "Load state to wait for. Defaults to `load`.",
  },
  { name: "timeoutMs", type: "number", doc: "Navigation timeout in ms." },
];

const SELECTOR_DOC =
  "A snapshot ref (`@0-12`, `[0-12]`, or `0-12`), a CSS selector, or an XPath expression.";

export const COMMANDS: CommandSpec[] = [
  // ---------------------------------------------------------------- navigation
  {
    group: "browse",
    fn: "open",
    wire: "open",
    cli: "browse open <url>",
    summary: "Navigate the active page to a URL, starting the browser if needed.",
    args: [{ name: "url", type: "string" }],
    options: NAV_OPTIONS,
    returns: "OpenResult",
  },
  {
    group: "browse",
    fn: "reload",
    wire: "reload",
    cli: "browse reload",
    summary: "Reload the active page.",
    options: NAV_OPTIONS,
    returns: "OpenResult",
  },
  {
    group: "browse",
    fn: "back",
    wire: "back",
    cli: "browse back",
    summary: "Navigate backward in history.",
    options: NAV_OPTIONS,
    returns: "OpenResult",
  },
  {
    group: "browse",
    fn: "forward",
    wire: "forward",
    cli: "browse forward",
    summary: "Navigate forward in history.",
    options: NAV_OPTIONS,
    returns: "OpenResult",
  },

  // ------------------------------------------------------------------ snapshot
  {
    group: "browse",
    fn: "snapshot",
    wire: "snapshot",
    cli: "browse snapshot",
    summary:
      "Capture the accessibility tree and refresh the `@ref` map used by element commands.",
    options: [
      {
        name: "full",
        type: "boolean",
        doc: "Also return `xpathMap` and `urlMap`.",
      },
      {
        name: "filter",
        type: "string",
        doc: "Keep only lines matching text or `/regex/`, plus their ancestors.",
      },
      { name: "maxDepth", type: "number", doc: "Trim output below this depth." },
    ],
    returns: "SnapshotResult",
    notes: [
      "Lines are `[ref] role: name`, indented by depth — for example `[0-73] link: Some title`.",
      "Refs are invalidated by navigation and DOM updates. Re-snapshot after any action that changes the page.",
    ],
  },

  // ------------------------------------------------------------------ elements
  {
    group: "browse",
    fn: "click",
    wire: "click",
    cli: "browse click <target>",
    summary: "Click an element.",
    args: [{ name: "target", param: "selector", type: "string", doc: SELECTOR_DOC }],
    returns: "{ clicked: true }",
    notes: [
      "`{ clicked: true }` does not prove an element matched — a selector that matches nothing still resolves. Verify with a follow-up read when it matters.",
    ],
  },
  {
    group: "browse",
    fn: "fill",
    wire: "fill",
    cli: "browse fill <target> <value>",
    summary: "Fill an input, textarea, or contenteditable element.",
    args: [
      { name: "target", param: "selector", type: "string", doc: SELECTOR_DOC },
      { name: "value", type: "string" },
    ],
    options: [
      {
        name: "pressEnter",
        type: "boolean",
        doc: "Press Enter after filling, to submit.",
      },
    ],
    returns: "{ filled: true; pressedEnter: boolean }",
  },
  {
    group: "browse",
    fn: "select",
    wire: "select",
    cli: "browse select <target> <value...>",
    summary: "Select one or more options in a `<select>` element.",
    args: [
      { name: "target", param: "selector", type: "string", doc: SELECTOR_DOC },
      {
        name: "values",
        type: "string | string[]",
        coerce: "array",
        doc: "Option labels, or values when they match the `value` attribute.",
      },
    ],
    returns: "{ selected: string[] }",
  },
  {
    group: "browse",
    fn: "upload",
    wire: "upload",
    cli: "browse upload <target> <file...>",
    summary: "Set files on a file input.",
    args: [
      { name: "target", param: "selector", type: "string", doc: SELECTOR_DOC },
      {
        name: "files",
        type: "string | string[]",
        coerce: "array",
        doc: "Paths on the browser host. For hosted browsers, stage files through the provider first.",
      },
    ],
    returns: "{ files: string[]; uploaded: true }",
  },
  {
    group: "browse",
    fn: "highlight",
    wire: "highlight",
    cli: "browse highlight <target>",
    summary: "Flash a visual highlight around an element.",
    args: [{ name: "target", param: "selector", type: "string", doc: SELECTOR_DOC }],
    options: [
      { name: "durationMs", type: "number", doc: "Defaults to 2000." },
    ],
    returns: "{ highlighted: true }",
  },

  // ------------------------------------------------------------------ keyboard
  {
    group: "browse",
    fn: "type",
    wire: "type",
    cli: "browse type <text>",
    summary: "Type text into the currently focused element.",
    args: [{ name: "text", type: "string" }],
    options: [
      { name: "delay", type: "number", doc: "Per-keystroke delay in ms." },
      {
        name: "mistakes",
        type: "boolean",
        doc: "Type with human-like typos and corrections.",
      },
    ],
    returns: "{ typed: true }",
  },
  {
    group: "browse",
    fn: "press",
    wire: "key",
    cli: "browse press <key>",
    summary: "Press a key or chord, for example `Enter`, `Escape`, or `Meta+K`.",
    args: [{ name: "key", type: "string" }],
    returns: "{ pressed: string }",
  },

  // ----------------------------------------------------------------- page info
  {
    group: "browse",
    fn: "get",
    wire: "get",
    cli: "browse get <what> [target]",
    summary: "Read a page or element property.",
    args: [
      { name: "what", type: "GetWhat" },
      {
        name: "target",
        param: "selector",
        type: "string",
        optional: true,
        doc: "Defaults to `body`. Ignored by `url` and `title`.",
      },
    ],
    returns: "GetResult",
    notes: [
      "Each variant returns an object keyed by the property: `get('text')` resolves to `{ text }`, `get('box')` to `{ x, y }`.",
    ],
  },
  {
    group: "browse",
    fn: "is",
    wire: "is",
    cli: "browse is <check> <target>",
    summary: "Check element state.",
    args: [
      { name: "check", type: '"visible" | "checked"' },
      { name: "target", param: "selector", type: "string", doc: SELECTOR_DOC },
    ],
    returns: "{ visible: boolean } | { checked: boolean }",
  },
  {
    group: "browse",
    fn: "eval",
    wire: "eval",
    cli: "browse eval <expression>",
    summary: "Evaluate a JavaScript expression in the page and return its result.",
    args: [{ name: "expression", type: "string" }],
    returns: "{ result: unknown }",
    notes: [
      "This runs in the *page*, not in this sandbox. Use it to reach DOM APIs that the command surface does not cover.",
    ],
  },

  // ------------------------------------------------------------------- runtime
  {
    group: "browse",
    fn: "screenshot",
    wire: "screenshot",
    cli: "browse screenshot",
    summary: "Capture a screenshot of the active page.",
    options: [
      { name: "fullPage", type: "boolean" },
      { name: "type", type: '"png" | "jpeg"' },
      { name: "quality", type: "number", doc: "JPEG quality, 0-100." },
      { name: "clip", type: "Clip" },
    ],
    returns: "{ base64: string }",
    notes: [
      "Returns base64 data; server filesystem paths are unsupported. Large images consume the result budget.",
    ],
  },
  {
    group: "browse",
    fn: "viewport",
    wire: "viewport",
    cli: "browse viewport <width> <height>",
    summary: "Resize the viewport.",
    args: [
      { name: "width", type: "number" },
      { name: "height", type: "number" },
    ],
    options: [
      { name: "scale", type: "number", doc: "Device pixel ratio. Defaults to 1." },
    ],
    returns: "{ viewport: { height: number; width: number } }",
  },
  {
    group: "browse",
    fn: "wait",
    wire: "wait",
    cli: "browse wait <load|selector|timeout> [arg]",
    summary: "Wait for a load state, a selector, or a fixed duration.",
    args: [
      { name: "type", type: '"load" | "selector" | "timeout"' },
      {
        name: "arg",
        type: "string | number",
        optional: true,
        coerce: "string",
        doc: "Load state for `load`, a target for `selector`, milliseconds for `timeout`.",
      },
    ],
    options: [
      {
        name: "state",
        type: '"attached" | "detached" | "hidden" | "visible"',
        doc: "Selector state to await. Defaults to `visible`.",
      },
      { name: "timeoutMs", type: "number" },
    ],
    returns: "{ waited: true }",
  },
  {
    group: "browse",
    fn: "cursor",
    wire: "cursor",
    cli: "browse cursor",
    summary: "Enable a visible cursor overlay, so mouse commands are observable.",
    returns: '{ cursor: "enabled" }',
  },

  // --------------------------------------------------------------------- mouse
  {
    group: "mouse",
    fn: "click",
    wire: "mouse.click",
    cli: "browse mouse click <x> <y>",
    summary: "Click at viewport coordinates.",
    args: [
      { name: "x", type: "number" },
      { name: "y", type: "number" },
    ],
    options: [
      { name: "button", type: "MouseButton" },
      { name: "clickCount", type: "number" },
    ],
    returns: "{ clicked: true }",
  },
  {
    group: "mouse",
    fn: "hover",
    wire: "mouse.hover",
    cli: "browse mouse hover <x> <y>",
    summary: "Move the mouse to viewport coordinates.",
    args: [
      { name: "x", type: "number" },
      { name: "y", type: "number" },
    ],
    returns: "{ hovered: true }",
  },
  {
    group: "mouse",
    fn: "scroll",
    wire: "mouse.scroll",
    cli: "browse mouse scroll <x> <y> <deltaX> <deltaY>",
    summary: "Scroll by a delta, anchored at a point.",
    args: [
      { name: "x", type: "number" },
      { name: "y", type: "number" },
      { name: "deltaX", type: "number" },
      { name: "deltaY", type: "number" },
    ],
    returns: "{ scrolled: true }",
  },
  {
    group: "mouse",
    fn: "drag",
    wire: "mouse.drag",
    cli: "browse mouse drag <fromX> <fromY> <toX> <toY>",
    summary: "Drag between two points.",
    args: [
      { name: "fromX", type: "number" },
      { name: "fromY", type: "number" },
      { name: "toX", type: "number" },
      { name: "toY", type: "number" },
    ],
    options: [
      { name: "button", type: "MouseButton" },
      { name: "steps", type: "number" },
      { name: "delay", type: "number" },
    ],
    returns: "{ dragged: true }",
  },

  // ---------------------------------------------------------------------- tabs
  {
    group: "tab",
    fn: "list",
    wire: "tab.list",
    cli: "browse tab list",
    summary: "List open tabs with stable target IDs.",
    returns: "{ tabs: PageSummary[] }",
  },
  {
    group: "tab",
    fn: "new",
    wire: "tab.new",
    cli: "browse tab new [url]",
    summary: "Open a new tab and make it active.",
    args: [{ name: "url", type: "string", optional: true }],
    returns:
      "{ active: true; index: number; targetId?: string; title?: string; url: string }",
  },
  {
    group: "tab",
    fn: "switch",
    wire: "tab.switch",
    cli: "browse tab switch <tab>",
    summary: "Switch the active tab by target ID or index.",
    args: [
      {
        name: "tab",
        type: "string | number",
        coerce: "string",
        doc: "Prefer the `targetId` from `tab.list()`; indexes shift as tabs open and close.",
      },
    ],
    returns:
      "{ index: number; switched: true; targetId?: string; title?: string; url: string }",
  },
  {
    group: "tab",
    fn: "close",
    wire: "tab.close",
    cli: "browse tab close [tab]",
    summary: "Close a tab. Defaults to the active tab; refuses to close the last one.",
    args: [
      { name: "tab", type: "string | number", optional: true, coerce: "string" },
    ],
    returns:
      "{ closed: true; index: number; selectedTargetId?: string; targetId?: string }",
  },

  // ------------------------------------------------------------------- session
  {
    group: "browse",
    fn: "status",
    wire: "status",
    cli: "browse status",
    summary: "Report the connected browser's tabs and active page.",
    returns: "StatusResult",
  },
];

/** Shared type declarations referenced by the generated command signatures. */
export const SHARED_TYPES = `type LoadState = "load" | "domcontentloaded" | "networkidle";
type MouseButton = "left" | "middle" | "right";

interface Clip {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface PageSummary {
  index: number;
  targetId?: string;
  title?: string;
  url: string;
}

interface OpenResult {
  /** CDP endpoint this program is attached to. */
  cdpUrl: string;
  pages: PageSummary[];
  selectedTargetId?: string;
  title: string;
  url: string;
}

interface StatusResult {
  connected: true;
  cdpUrl: string;
  pages: PageSummary[];
  selectedTargetId?: string;
  title?: string;
  url?: string;
}

interface SnapshotResult {
  /** Indented accessibility tree. Element refs appear as \`[0-12]\`. */
  tree: string;
  /** Present only with \`{ full: true }\`. */
  xpathMap?: Record<string, string>;
  /** Present only with \`{ full: true }\`. */
  urlMap?: Record<string, string>;
}

type GetWhat =
  | "box"
  | "checked"
  | "html"
  | "markdown"
  | "text"
  | "title"
  | "url"
  | "value"
  | "visible";

type GetResult =
  | { url: string }
  | { title: string }
  | { text: string }
  | { html: string }
  | { value: string }
  | { visible: boolean }
  | { checked: boolean }
  | { markdown: string }
  | { x: number; y: number };`;

const BY_KEY = new Map(COMMANDS.map((spec) => [`${spec.group}.${spec.fn}`, spec]));

export function findCommand(group: string, fn: string): CommandSpec | undefined {
  return BY_KEY.get(`${group}.${fn}`);
}

export function commandGroups(): GroupName[] {
  return [...new Set(COMMANDS.map((spec) => spec.group))];
}

/**
 * Build driver params from the positional arguments and trailing options object
 * a sandbox program passed, following the spec's arg/option declarations.
 */
export function buildParams(
  spec: CommandSpec,
  args: readonly unknown[],
): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  const argSpecs = spec.args ?? [];

  argSpecs.forEach((argSpec, index) => {
    const value = args[index];
    if (value === undefined || value === null) {
      if (!argSpec.optional) {
        throw new Error(
          `${spec.group}.${spec.fn}() requires argument ${index + 1} (${argSpec.name}).`,
        );
      }
      return;
    }
    params[argSpec.param ?? argSpec.name] = coerce(value, argSpec.coerce);
  });

  if (spec.options) {
    const options = args[argSpecs.length];
    if (options !== undefined && options !== null) {
      if (typeof options !== "object" || Array.isArray(options)) {
        throw new Error(
          `${spec.group}.${spec.fn}() expects an options object as argument ${argSpecs.length + 1}.`,
        );
      }
      const allowed = new Set(spec.options.map((option) => option.name));
      for (const [key, value] of Object.entries(options)) {
        if (value === undefined) continue;
        if (!allowed.has(key)) {
          throw new Error(
            `${spec.group}.${spec.fn}() got unknown option "${key}". Supported: ${[...allowed].join(", ")}.`,
          );
        }
        params[key] = value;
      }
    }
  }

  // Always an object, never `undefined`: the daemon parses params with
  // `z.object(...).parse()`, which rejects `undefined` even when every field is
  // optional. `browse snapshot` with no flags sends `{}`, so we do too.
  return params;
}

function coerce(value: unknown, coercion: Coercion | undefined): unknown {
  if (coercion === "array") return Array.isArray(value) ? value : [value];
  if (coercion === "string") return typeof value === "string" ? value : String(value);
  return value;
}
