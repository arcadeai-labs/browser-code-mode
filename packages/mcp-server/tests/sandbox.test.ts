import assert from "node:assert/strict";
import { test } from "node:test";

import { runProgram } from "../src/sandbox/runner.ts";
import { createFakeBrowser, echoHandler } from "./helpers/fake-browser.ts";

test("TypeScript is stripped inside the sandbox boundary", async () => {
  const result = await runProgram({
    code: "const value: number = 42; return value;",
    session: createFakeBrowser(),
  });
  assert.equal(result.value, 42);
});

test("a timeout disposes pending host promises without crashing the runtime", async () => {
  const result = await runProgram({
    code: 'return await browse.get("url");',
    session: createFakeBrowser(() => new Promise(() => {})),
    limits: { timeoutMs: 30 },
  });
  assert.equal(result.status, "failed");
  assert.equal(result.error?.name, "RunTimeoutError");
});

test("host prototype members are not sandbox capabilities", async () => {
  const result = await runProgram({
    code: 'return await __host("constructor", "constructor", "[]");',
    session: createFakeBrowser(),
  });
  assert.equal(result.status, "failed");
  assert.match(result.error?.message ?? "", /Unknown host function/);
});

test("a program's commands reach the browser in order", async () => {
  const browser = createFakeBrowser();
  const result = await runProgram({
    code: `
      await browse.open("https://example.com");
      await browse.click("@0-1");
      const { title } = await browse.get("title");
      return { title };
    `,
    session: browser,
  });

  assert.equal(result.status, "completed");
  assert.deepEqual(result.value, { title: "fake-title" });
  assert.deepEqual(
    result.calls.map((call) => call.cli),
    ["browse open https://example.com", "browse click @0-1", "browse get title"],
  );
  assert.deepEqual(
    browser.commands.map((entry) => entry.command),
    ["open", "click", "get"],
  );
  assert.deepEqual(browser.commands[1]?.params, { selector: "@0-1" });
});

test("a failed command records the driver's real message", async () => {
  const browser = createFakeBrowser((command) => {
    if (command === "click") throw new Error('Unknown ref "9-9"');
    return echoHandler(command, {});
  });

  const result = await runProgram({
    code: `await browse.click("@9-9"); return "unreachable";`,
    session: browser,
  });

  assert.equal(result.status, "failed");
  // The sandbox masks host errors, so the trace has to carry the detail.
  assert.match(result.error?.message ?? "", /Host function failed/);
  assert.equal(result.failedCall?.cli, "browse click @9-9");
  assert.match(result.failedCall?.error ?? "", /Unknown ref "9-9"/);
});

test("bad arguments are recorded as a failed command", async () => {
  const result = await runProgram({
    code: `await browse.fill("#only-one-arg"); return 1;`,
    session: createFakeBrowser(),
  });

  assert.equal(result.status, "failed");
  assert.match(result.failedCall?.error ?? "", /requires argument 2 \(value\)/);
});

test("a program can catch a failure and carry on", async () => {
  const browser = createFakeBrowser((command, params) => {
    if (command === "click") throw new Error("no such element");
    return echoHandler(command, params);
  });

  const result = await runProgram({
    code: `
      let clicked = true;
      try { await browse.click("#gone"); } catch { clicked = false; }
      const { title } = await browse.get("title");
      return { clicked, title };
    `,
    session: browser,
  });

  assert.equal(result.status, "completed");
  assert.deepEqual(result.value, { clicked: false, title: "fake-title" });
  assert.equal(result.calls[0]?.ok, false);
  assert.equal(result.calls[1]?.ok, true);
});

test("log output comes back without being awaited", async () => {
  const streamed: string[] = [];
  const result = await runProgram({
    code: `log.info("one", 1); log.warn("two"); log.error("three"); return "done";`,
    session: createFakeBrowser(),
    onLog: (entry) => streamed.push(entry.level),
  });

  assert.equal(result.status, "completed");
  assert.deepEqual(result.logs, [
    { level: "info", args: ["one", 1] },
    { level: "warn", args: ["two"] },
    { level: "error", args: ["three"] },
  ]);
  assert.deepEqual(streamed, ["info", "warn", "error"]);
});

test("the sandbox exposes nothing but the browser", async () => {
  const result = await runProgram({
    code: `return {
      fetch: typeof fetch,
      process: typeof process,
      require: typeof require,
      browse: typeof browse.open,
    };`,
    session: createFakeBrowser(),
  });

  assert.deepEqual(result.value, {
    fetch: "undefined",
    process: "undefined",
    require: "undefined",
    browse: "function",
  });
});

// Host globals are lazy proxies, so a filtered command is not missing from the
// object graph — it fails when called. These assert the behaviour that matters.
test("denied commands cannot be called", async () => {
  const browser = createFakeBrowser();
  const result = await runProgram({
    code: `
      const outcome = {};
      for (const name of ["eval", "click"]) {
        try { await browse[name]("x"); outcome[name] = "ran"; }
        catch (error) { outcome[name] = error.message; }
      }
      return outcome;
    `,
    session: browser,
    deny: ["browse.eval"],
  });

  const outcome = result.value as Record<string, string>;
  assert.match(outcome.eval ?? "", /Unknown host function: browse\.eval/);
  assert.equal(outcome.click, "ran");
  assert.deepEqual(
    browser.commands.map((entry) => entry.command),
    ["click"],
  );
});

test("an allowlist blocks every command outside it", async () => {
  const browser = createFakeBrowser();
  const result = await runProgram({
    code: `
      const outcome = {};
      try { await browse.open("https://example.com"); outcome.open = "ran"; }
      catch (error) { outcome.open = error.message; }
      try { await mouse.click(1, 2); outcome.mouseClick = "ran"; }
      catch (error) { outcome.mouseClick = error.message; }
      return outcome;
    `,
    session: browser,
    allow: ["browse.open"],
  });

  const outcome = result.value as Record<string, string>;
  assert.equal(outcome.open, "ran");
  assert.match(outcome.mouseClick ?? "", /Unknown host function: mouse\.click/);
  assert.deepEqual(
    browser.commands.map((entry) => entry.command),
    ["open"],
  );
});

test("runaway programs are stopped by the timeout", async () => {
  const result = await runProgram({
    code: `while (true) {}`,
    session: createFakeBrowser(),
    limits: { timeoutMs: 1_000 },
  });

  assert.equal(result.status, "failed");
  assert.equal(result.error?.name, "RunTimeoutError");
});

test("the command budget caps how much a program can drive", async () => {
  const result = await runProgram({
    code: `for (let i = 0; i < 20; i += 1) { await browse.get("url"); } return "done";`,
    session: createFakeBrowser(),
    limits: { maxBridgeRequests: 5 },
  });

  assert.equal(result.status, "failed");
  assert.ok(result.calls.length <= 5, `ran ${result.calls.length} commands`);
});

test("concurrent commands get distinct indexes", async () => {
  const result = await runProgram({
    code: `await Promise.all([browse.get("url"), browse.get("title"), browse.get("text", "h1")]); return "ok";`,
    session: createFakeBrowser(),
  });

  assert.equal(result.status, "completed");
  assert.deepEqual(
    result.calls.map((call) => call.index).sort((a, b) => a - b),
    [1, 2, 3],
  );
});

test("a protocol failure is not retried once the program touched the browser", async () => {
  // Re-running a program that already clicked something would repeat the click.
  const browser = createFakeBrowser();
  const result = await runProgram({
    code: `await browse.click("@0-1"); throw new Error("after a command");`,
    session: browser,
  });

  assert.equal(result.status, "failed");
  assert.equal(
    browser.commands.filter((entry) => entry.command === "click").length,
    1,
    "the click must not be repeated",
  );
});

test("an infrastructure failure is explained rather than blamed on the program", async () => {
  const result = await runProgram({
    code: `return "ok";`,
    session: createFakeBrowser(),
    limits: { maxResultBytes: 1 },
  });

  // Not retryable, and the message stays the SDK's own.
  assert.equal(result.status, "failed");
  assert.doesNotMatch(result.error?.message ?? "", /sandbox failure/);
});
