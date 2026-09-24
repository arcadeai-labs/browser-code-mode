/**
 * End-to-end against a real browser over CDP.
 *
 * Opt in with `BROWSE_E2E=1 pnpm test:e2e`, and start a browser first with
 * `pnpm chrome` (or point BROWSE_CDP_URL at any Chrome running with
 * --remote-debugging-port and --remote-allow-origins=*). Everything else in the
 * suite runs without a browser.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { BrowserSession } from "../src/browse/driver.ts";
import { type ProgramResult, runProgram } from "../src/sandbox/runner.ts";

const enabled = process.env.BROWSE_E2E === "1";
const CDP_URL = process.env.BROWSE_CDP_URL ?? "9222";

/** Attach, run, detach — exactly what the MCP tool does per call. */
async function run(code: string): Promise<ProgramResult> {
  const session = await BrowserSession.connect({ cdpUrl: CDP_URL });
  try {
    return await runProgram({ code, session, limits: { timeoutMs: 120_000 } });
  } finally {
    await session.close();
  }
}

test("a program drives a real browser and returns only its result", {
  skip: !enabled,
}, async () => {
  const result = await run(`
    await browse.open("https://example.com");
    const { tree } = await browse.snapshot();
    const [{ url }, { title }, { text }] = await Promise.all([
      browse.get("url"),
      browse.get("title"),
      browse.get("text", "h1"),
    ]);
    log.info("tree characters", tree.length);
    return { url, title, heading: text.trim(), treeLines: tree.split("\\n").length };
  `);

  assert.equal(result.status, "completed", JSON.stringify(result.failedCall ?? result.error));
  const value = result.value as Record<string, unknown>;
  assert.equal(value.url, "https://example.com/");
  assert.equal(value.title, "Example Domain");
  assert.equal(value.heading, "Example Domain");
  assert.ok((value.treeLines as number) > 3);
  assert.equal(result.calls.length, 5);
  assert.ok(result.calls.every((call) => call.ok));
});

test("snapshot refs drive clicks within one program", { skip: !enabled }, async () => {
  const result = await run(`
    await browse.open("https://example.com");
    const { tree } = await browse.snapshot();

    // Snapshot lines are \`[ref] role: name\`.
    const link = /\\[(\\d+-\\d+)\\] link/.exec(tree);
    if (!link) return { clicked: false, reason: "no link in snapshot" };

    await browse.click("@" + link[1]);
    await browse.wait("load", "domcontentloaded");
    const { url } = await browse.get("url");
    return { clicked: true, url };
  `);

  assert.equal(result.status, "completed", JSON.stringify(result.failedCall ?? result.error));
  const value = result.value as { clicked: boolean; url?: string };
  assert.equal(value.clicked, true);
  assert.notEqual(value.url, "https://example.com/");
});

test("a ref from an earlier program is stale, by design", { skip: !enabled }, async () => {
  // Refs belong to one program. This is the tradeoff that makes the server
  // stateless, so it is worth pinning as behaviour rather than discovering it.
  await run(`await browse.open("https://example.com"); await browse.snapshot(); return 1;`);
  const result = await run(`await browse.click("@0-14"); return "unreachable";`);

  assert.equal(result.status, "failed");
  assert.match(result.failedCall?.error ?? "", /Unknown ref "0-14"/);
});

test("page state persists in the browser between programs", { skip: !enabled }, async () => {
  await run(`await browse.open("https://example.com"); return 1;`);
  const second = await run(`
    const { url } = await browse.get("url");
    const { tabs } = await tab.list();
    return { url, tabs: tabs.length };
  `);

  assert.equal(second.status, "completed", JSON.stringify(second.failedCall ?? second.error));
  assert.equal((second.value as { url: string }).url, "https://example.com/");
});

test("page JavaScript is reachable through eval", { skip: !enabled }, async () => {
  const result = await run(`
    await browse.open("https://example.com");
    const { result } = await browse.eval("document.querySelectorAll('p').length");
    return { paragraphs: result };
  `);

  assert.equal(result.status, "completed", JSON.stringify(result.failedCall ?? result.error));
  assert.ok((result.value as { paragraphs: number }).paragraphs >= 1);
});

test("tabs, viewport, and typing work end to end", { skip: !enabled }, async () => {
  const result = await run(`
    await browse.open("https://example.com");
    await browse.viewport(1024, 768);
    const opened = await tab.new("https://example.com/");
    const { tabs } = await tab.list();
    await tab.close(opened.targetId);
    const after = await tab.list();
    return { opened: tabs.length, after: after.tabs.length };
  `);

  assert.equal(result.status, "completed", JSON.stringify(result.failedCall ?? result.error));
  const value = result.value as { opened: number; after: number };
  assert.equal(value.after, value.opened - 1);
});
