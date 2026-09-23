#!/usr/bin/env node
/**
 * `pnpm example [name] [...args]` — run one of examples/.
 *
 *   pnpm example                                  # 01-hello-world
 *   pnpm example 02-mcp-server
 *   pnpm example 01-hello-world "Who won the last Super Bowl?"
 *
 * The name can be shortened to any unique prefix, e.g. `pnpm example 02`.
 */

import { spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const examples = fileURLToPath(new URL("../examples/", import.meta.url));
const available = readdirSync(examples, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

const [name = "01-hello-world", ...args] = process.argv.slice(2);
const matches = available.includes(name)
  ? [name]
  : available.filter((example) => example.startsWith(name));
if (matches.length !== 1) {
  console.error(
    `${matches.length ? "Ambiguous" : "Unknown"} example "${name}". Available:\n` +
      available.map((example) => `  ${example}`).join("\n"),
  );
  process.exit(1);
}

const child = spawn("pnpm", ["--dir", `${examples}${matches[0]}`, "start", ...args], {
  stdio: "inherit",
});
// Ctrl-C reaches the example directly; let it clean up, then exit with its code.
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => {});
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
