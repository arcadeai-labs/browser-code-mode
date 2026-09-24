import assert from "node:assert/strict";
import { test } from "node:test";

import { buildParams, COMMANDS, findCommand, WIRE_COMMANDS } from "../src/browse/commands.ts";
import { renderApiDts, renderCheatsheet } from "../src/browse/dts.ts";
import { formatCall } from "../src/browse/host-functions.ts";

test("every driver command is reachable from the sandbox", () => {
  const wired = new Set(COMMANDS.map((spec) => spec.wire));
  const missing = WIRE_COMMANDS.filter((name) => !wired.has(name));
  assert.deepEqual(missing, [], "commands with no sandbox function");
});

test("command keys are unique", () => {
  const keys = COMMANDS.map((spec) => `${spec.group}.${spec.fn}`);
  assert.equal(new Set(keys).size, keys.length);
});

test("positional arguments map to driver params", () => {
  const spec = findCommand("browse", "fill");
  assert.ok(spec);
  assert.deepEqual(buildParams(spec, ["@0-8", "hello"]), {
    selector: "@0-8",
    value: "hello",
  });
});

test("trailing options merge into params", () => {
  const spec = findCommand("browse", "fill");
  assert.ok(spec);
  assert.deepEqual(buildParams(spec, ["@0-8", "hi", { pressEnter: true }]), {
    selector: "@0-8",
    value: "hi",
    pressEnter: true,
  });
});

test("scalars coerce to arrays where the CLI is variadic", () => {
  const select = findCommand("browse", "select");
  const upload = findCommand("browse", "upload");
  assert.ok(select && upload);
  assert.deepEqual(buildParams(select, ["#s", "CA"]), { selector: "#s", values: ["CA"] });
  assert.deepEqual(buildParams(upload, ["#f", ["a.pdf", "b.pdf"]]), {
    selector: "#f",
    files: ["a.pdf", "b.pdf"],
  });
});

test("numbers coerce to strings where the daemon wants text", () => {
  const wait = findCommand("browse", "wait");
  const tab = findCommand("tab", "switch");
  assert.ok(wait && tab);
  assert.deepEqual(buildParams(wait, ["timeout", 1500]), { type: "timeout", arg: "1500" });
  assert.deepEqual(buildParams(tab, [3]), { tab: "3" });
});

test("params are always an object, since the daemon rejects undefined", () => {
  for (const spec of COMMANDS) {
    if ((spec.args ?? []).some((arg) => !arg.optional)) continue;
    const params = buildParams(spec, []);
    assert.equal(typeof params, "object");
    assert.notEqual(params, null);
  }
});

test("missing required arguments are rejected with the parameter name", () => {
  const spec = findCommand("browse", "click");
  assert.ok(spec);
  assert.throws(() => buildParams(spec, []), /requires argument 1 \(target\)/);
});

test("unknown options are rejected and list the valid ones", () => {
  const spec = findCommand("browse", "snapshot");
  assert.ok(spec);
  assert.throws(
    () => buildParams(spec, [{ nope: true }]),
    /unknown option "nope".*full, filter, maxDepth/,
  );
});

test("optional arguments may be omitted", () => {
  const spec = findCommand("browse", "get");
  assert.ok(spec);
  assert.deepEqual(buildParams(spec, ["url"]), { what: "url" });
  assert.deepEqual(buildParams(spec, ["text", "h1"]), { what: "text", selector: "h1" });
});

test("calls render as the shell command they stand for", () => {
  const cases: Array<[string, string, unknown[], string]> = [
    ["browse", "click", ["@0-12"], "browse click @0-12"],
    [
      "browse",
      "fill",
      ["#q", "hi there", { pressEnter: true }],
      'browse fill #q "hi there" --press-enter',
    ],
    ["browse", "snapshot", [{ maxDepth: 4 }], "browse snapshot --max-depth 4"],
    ["mouse", "scroll", [10, 20, 0, 600], "browse mouse scroll 10 20 0 600"],
    ["tab", "list", [], "browse tab list"],
    ["browse", "wait", ["load", "networkidle"], "browse wait load networkidle"],
  ];
  for (const [group, fn, args, expected] of cases) {
    const spec = findCommand(group, fn);
    assert.ok(spec, `${group}.${fn}`);
    assert.equal(formatCall(spec, buildParams(spec, args)), expected);
  }
});

test("the generated API documents every command", () => {
  const dts = renderApiDts();
  for (const spec of COMMANDS) {
    assert.ok(dts.includes(`${spec.fn}(`), `missing ${spec.group}.${spec.fn}`);
    assert.ok(dts.includes(spec.cli), `missing CLI mapping for ${spec.cli}`);
  }
  assert.ok(dts.includes("declare const browse"));
  assert.ok(dts.includes("declare const log"));
});

test("the cheatsheet can be narrowed to an allowlist", () => {
  const sheet = renderCheatsheet({ exposed: ["browse.open", "browse.get"] });
  assert.ok(sheet.includes("browse.open"));
  assert.ok(sheet.includes("browse.get"));
  assert.ok(!sheet.includes("browse.click"));
  assert.ok(!sheet.includes("## mouse"));
});

test("commands the stateless model cannot honour are absent", () => {
  const keys = COMMANDS.map((spec) => `${spec.group}.${spec.fn}`);
  // `stop` would close a browser we never owned, and `network` capture is
  // session-scoped disk state that Stagehand v4 does not expose anyway.
  assert.ok(!keys.includes("browse.stop"));
  assert.ok(!keys.some((key) => key.startsWith("network.")));
});
