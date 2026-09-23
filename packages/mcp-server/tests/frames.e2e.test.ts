/**
 * Iframes and shadow DOM, end to end against a real browser.
 *
 * Opt in like the other e2e suite: `BROWSE_E2E=1 pnpm test:e2e` with Chrome on
 * BROWSE_CDP_URL (default 9222). The fixture serves its own pages, including a
 * cross-site frame that Chrome runs out of process.
 */

import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { BrowserSession } from "../src/browse/driver.ts";
import { runProgram, type ProgramResult } from "../src/sandbox/runner.ts";
import { serveHardPages, type HardPages } from "./helpers/hard-pages.ts";

const enabled = process.env.BROWSE_E2E === "1";
const CDP_URL = process.env.BROWSE_CDP_URL ?? "9222";

let pages: HardPages;
before(async () => {
  if (enabled) pages = await serveHardPages();
});
after(async () => {
  await pages?.close();
});

async function run(code: string): Promise<ProgramResult> {
  const session = await BrowserSession.connect({ cdpUrl: CDP_URL });
  try {
    return await runProgram({ code, session, limits: { timeoutMs: 60_000 } });
  } finally {
    await session.close();
  }
}

/** Open the fixture, snapshot, and define `ref(name)` and `events()` for the body. */
async function onHardPage(body: string): Promise<unknown> {
  const result = await run(`
    await browse.open(${JSON.stringify(pages.url)});
    await browse.wait("selector", "#cross >> iframe >> [data-id=nested-button]", { timeoutMs: 10000 });
    await browse.wait("selector", "iframe[title='Frame in shadow root'] >> [data-id=shadow-frame-button]", { timeoutMs: 10000 }).catch(() => {});
    const { tree } = await browse.snapshot();
    const ref = (name) => {
      const line = tree.split("\\n").find((l) => l.includes(": " + name));
      if (!line) throw new Error("not in snapshot: " + name);
      return "@" + /\\[(\\d+-\\d+)\\]/.exec(line)[1];
    };
    const events = async () => {
      await browse.wait("timeout", "300");
      return (await browse.eval("[...document.querySelectorAll('#log div')].map((d) => d.textContent)")).result;
    };
    ${body}
  `);
  assert.equal(result.status, "completed", JSON.stringify(result.failedCall ?? result.error));
  return result.value;
}

test("the snapshot includes every frame, cross-site and nested ones too", { skip: !enabled }, async () => {
  const tree = (await onHardPage(`return tree;`)) as string;
  const refOf = (name: string) => /\[(\d+)-\d+\]/.exec(tree.split("\n").find((l) => l.includes(name)) ?? "")?.[1];

  for (const name of [
    "Top button",
    "Same-origin button",
    "Cross-site button",
    "Nested frame button",
    "Button in shadow frame",
    "Open shadow button",
    "Closed shadow button",
  ]) assert.ok(refOf(name) !== undefined, `${name} missing from:\n${tree}`);

  // The frame index in a ref says which document the element belongs to.
  assert.equal(refOf("Top button"), "0");
  assert.equal(refOf("Open shadow button"), "0");
  const frames = new Set(["Same-origin button", "Cross-site button", "Nested frame button", "Button in shadow frame"].map(refOf));
  assert.equal(frames.size, 4);
  assert.ok(![...frames].includes("0"));

  // Frame content sits under its iframe, and text runs no longer repeat names.
  const lines = tree.split("\n");
  const iframe = lines.findIndex((l) => l.includes("Iframe: Cross-site frame"));
  const button = lines.findIndex((l) => l.includes("button: Cross-site button"));
  assert.ok(button > iframe && lines[button]!.search(/\S/) > lines[iframe]!.search(/\S/));
  assert.ok(!tree.includes("InlineTextBox"));
  assert.ok(!tree.includes("StaticText: Top button"));
});

test("refs click inside every frame and shadow root", { skip: !enabled }, async () => {
  const events = await onHardPage(`
    for (const name of ["Top button", "Same-origin button", "Cross-site button", "Nested frame button",
                        "Button in shadow frame", "Open shadow button", "Closed shadow button"])
      await browse.click(ref(name));
    return events();
  `);
  assert.deepEqual(events, [
    "click:top-button",
    "click:same-button",
    "click:cross-button",
    "click:nested-button",
    "click:shadow-frame-button",
    "click:open-button",
    "click:closed-button",
  ]);
});

test("fill, select, read, and type work in cross-site and same-origin frames", { skip: !enabled }, async () => {
  const value = await onHardPage(`
    await browse.fill(ref("Cross-site input"), "filled");
    await browse.select(ref("Same-origin select"), ["b"]);
    const { text: crossText } = await browse.get("text", "#cross >> #cross-text");
    const { value: crossValue } = await browse.get("value", ref("Cross-site input"));

    // Real keyboard input follows focus into the cross-site frame.
    await browse.fill(ref("Cross-site input"), "");
    await browse.click(ref("Cross-site input"));
    await browse.type("typed");
    const { value: typed } = await browse.get("value", "#cross >> [data-id=cross-input]");

    return { crossText, crossValue, typed, events: await events() };
  `);
  assert.deepEqual(value, {
    crossText: "Text inside the cross-site frame",
    crossValue: "filled",
    typed: "typed",
    events: ["change:cross-input=filled", "change:same-select=b", "change:cross-input=", "click:cross-input"],
  });
});

test("CSS pierces open shadow roots and hops into frames with >>", { skip: !enabled }, async () => {
  const value = await onHardPage(`
    await browse.fill("#shadow-field", "via css");
    const { value } = await browse.get("value", "#shadow-field");
    await browse.click("#cross >> iframe >> [data-id=nested-button]");
    await browse.click("iframe[title='Frame in shadow root'] >> [data-id=shadow-frame-button]");
    const { text } = await browse.get("text", "iframe#same >> #same-text");
    const { visible } = await browse.is("visible", "#cross >> [data-id=cross-button]");
    return { value, text, visible, events: await events() };
  `);
  assert.deepEqual(value, {
    value: "via css",
    text: "Text inside the same-origin frame",
    visible: true,
    events: ["change:open-input=via css", "click:nested-button", "click:shadow-frame-button"],
  });
});

test("get box returns page coordinates that mouse.click can use, even in a nested cross-site frame", { skip: !enabled }, async () => {
  const events = await onHardPage(`
    const { x, y } = await browse.get("box", ref("Nested frame button"));
    await mouse.click(x, y);
    return events();
  `);
  assert.deepEqual(events, ["click:nested-button"]);
});

test(">> into something that is not a frame explains itself", { skip: !enabled }, async () => {
  const result = await run(`
    await browse.open(${JSON.stringify(pages.url)});
    await browse.click("h1 >> button");
  `);
  assert.equal(result.status, "failed");
  assert.match(result.failedCall?.error ?? "", /"h1" is not an iframe/);
});

test("eval runs in a chosen frame's own window", { skip: !enabled }, async () => {
  const value = await onHardPage(`
    const nestedIndex = ref("Nested frame button").slice(1).split("-")[0];
    const read = async (frame) => (await browse.eval("window.appName", frame ? { frame } : undefined)).result;
    return {
      top: await read(),
      bySelector: await read("#same"),
      crossSite: await read("#cross"),
      nestedHop: await read("#cross >> iframe"),
      byIframeRef: await read(ref("Cross-site frame")),
      byIndex: await read(nestedIndex),
      inShadow: await read("iframe[title='Frame in shadow root']"),
      promise: (await browse.eval("Promise.resolve(document.title)", { frame: "#cross" })).result,
    };
  `);
  assert.deepEqual(value, {
    top: "top",
    bySelector: "same",
    crossSite: "cross",
    nestedHop: "nested",
    byIframeRef: "cross",
    byIndex: "nested",
    inShadow: "in-shadow",
    promise: "Cross",
  });
});

test("eval explains a frame target that is not a frame", { skip: !enabled }, async () => {
  for (const [frame, message] of [
    ["h1", /not an iframe/],
    ["9", /No frame 9 in this program's snapshot/],
  ] as const) {
    const result = await run(`
      await browse.open(${JSON.stringify(pages.url)});
      await browse.snapshot();
      await browse.eval("1", { frame: ${JSON.stringify(frame)} });
    `);
    assert.equal(result.status, "failed");
    assert.match(result.failedCall?.error ?? "", message);
  }
});
