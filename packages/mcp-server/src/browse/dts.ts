/**
 * Renders the code-mode API surface from the command table.
 *
 * Agents write programs against this, so it is generated rather than
 * hand-maintained: a command added to ./commands.ts shows up in the docs, the
 * types, and the sandbox globals at the same time.
 */

import { COMMANDS, commandGroups, SHARED_TYPES, type CommandSpec } from "./commands.ts";

export interface RenderOptions {
  /** Restrict output to these `group.fn` keys. Defaults to all. */
  exposed?: readonly string[];
}

const GROUP_DOCS: Record<string, string> = {
  browse: "Top-level `browse` commands: navigation, snapshots, elements, and page state.",
  mouse: "Raw coordinate input (`browse mouse ...`). Prefer refs when the element is in a snapshot.",
  tab: "Tab management (`browse tab ...`).",
  network: "Network capture (`browse network ...`).",
};

export const PROGRAM_GUIDE = `Programs run in a QuickJS sandbox with no Node, filesystem, network, or env access.
The browser is the only capability, reached through the globals below.

- The source is a function body: use top-level \`await\`, and \`return\` the values you need.
- Return only what you will read. The whole return value crosses back into your context.
- Every call is one real browser command, so order matters and \`Promise.all\` genuinely parallelizes independent reads.
- \`browse.snapshot()\` returns lines of the form \`[ref] role: name\`, so \`[0-73] link: Some title\` is element \`0-73\`. Parse that tree in the sandbox instead of returning it.
- Element targets are refs (\`@0-73\`, \`[0-73]\`, or \`0-73\`), CSS selectors, or XPath. Refs are invalidated by navigation and DOM changes, so re-snapshot after acting.
- Results mirror the CLI's JSON exactly: \`browse.get("text", "@0-12")\` resolves to \`{ text }\`, not a bare string.
- A failed command rejects, but the sandbox masks the reason as "Host function failed." The real message comes back in the result's \`failedCall\`, so let it throw unless you mean to recover.
- \`log.info()\` returns output to you. Plain \`console.log\` goes to the server's stdout, where you will never see it.
- The globals are proxies: \`Object.keys(browse)\` is empty and any property looks callable, so a typo fails at call time with "Unknown host function". Work from the declarations below rather than probing.

Write only the steps you can already justify:

- Never type a ref or selector you have not seen. A ref is legitimate when you derive it in the same program from a snapshot you just took, or when an earlier program returned it to you. Writing \`@0-73\` because it seems plausible is a guess, and it will act on the wrong element as often as it fails outright.
- When you do not know what a page contains, end the first program at the snapshot: navigate, snapshot, return a trimmed tree. Write the acting program once you have seen it.
- Batch what you already know — navigating, waiting, reading, and anything computed from a snapshot taken in the same program. Stop at the first step whose target depends on page content you have not seen.
- One uncertain action per program. If a click's target was a guess, do that click alone and check the result rather than queueing three more actions behind it.
- After a click, a submit, or a navigation, earlier refs are stale. Snapshot again before using one.`;

/** Sandbox globals that are not `browse` commands. */
const RUNTIME_GLOBALS = `/**
 * Diagnostics channel. Output is returned to you in the run result.
 *
 * The sandbox's own \`console\` writes to the server process instead, so use this
 * when you want to see intermediate values without returning them.
 */
declare const log: {
  info(...values: unknown[]): void;
  warn(...values: unknown[]): void;
  error(...values: unknown[]): void;
};`;

/** Full `.d.ts` for the sandbox globals. */
export function renderApiDts(options: RenderOptions = {}): string {
  const sections = commandGroups()
    .map((group) => renderGroup(group, options))
    .filter((section): section is string => section !== undefined);

  return `/**
 * browse code mode — sandbox API.
 *
 * Every function maps to exactly one \`browse\` CLI command, with the same
 * parameters and the same JSON result shape.
 *
${PROGRAM_GUIDE.split("\n")
  .map((line) => ` * ${line}`.trimEnd())
  .join("\n")}
 */

${SHARED_TYPES}

${sections.join("\n\n")}

${RUNTIME_GLOBALS}
`;
}

/** Compact signature list, for tool descriptions and quick reference. */
export function renderCheatsheet(options: RenderOptions = {}): string {
  const lines: string[] = [];
  for (const group of commandGroups()) {
    const specs = specsFor(group, options);
    if (specs.length === 0) continue;
    lines.push(`## ${group}`);
    for (const spec of specs) {
      lines.push(`- \`${spec.group}.${spec.fn}${signature(spec)}\` — ${spec.summary} (\`${spec.cli}\`)`);
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

function renderGroup(group: string, options: RenderOptions): string | undefined {
  const specs = specsFor(group, options);
  if (specs.length === 0) return undefined;

  const members = specs.map((spec) => indent(renderMember(spec), 2)).join("\n\n");
  return `/** ${GROUP_DOCS[group] ?? `\`browse ${group}\` commands.`} */
declare const ${group}: {
${members}
};`;
}

function renderMember(spec: CommandSpec): string {
  return `${docComment(spec)}\n${spec.fn}${signature(spec)}: Promise<${spec.returns}>;`;
}

function docComment(spec: CommandSpec): string {
  const lines: string[] = [spec.summary, "", `CLI: \`${spec.cli}\``];

  const documented = [
    ...(spec.args ?? [])
      .filter((arg) => arg.doc)
      .map((arg) => `@param ${arg.name} ${arg.doc}`),
    ...(spec.options ?? [])
      .filter((option) => option.doc)
      .map((option) => `@param options.${option.name} ${option.doc}`),
  ];
  if (documented.length > 0) lines.push("", ...documented);
  if (spec.notes?.length) lines.push("", ...spec.notes);

  return ["/**", ...lines.map((line) => ` * ${line}`.trimEnd()), " */"].join("\n");
}

function signature(spec: CommandSpec): string {
  const params = (spec.args ?? []).map(
    (arg) => `${arg.name}${arg.optional ? "?" : ""}: ${arg.type}`,
  );

  if (spec.options?.length) {
    const fields = spec.options
      .map((option) => `${option.name}?: ${option.type}`)
      .join("; ");
    params.push(`options?: { ${fields} }`);
  }

  return `(${params.join(", ")})`;
}

function specsFor(group: string, options: RenderOptions): CommandSpec[] {
  return COMMANDS.filter(
    (spec) =>
      spec.group === group &&
      (!options.exposed || options.exposed.includes(`${spec.group}.${spec.fn}`)),
  );
}

function indent(value: string, width: number): string {
  const pad = " ".repeat(width);
  return value
    .split("\n")
    .map((line) => (line.length > 0 ? `${pad}${line}` : line))
    .join("\n");
}
