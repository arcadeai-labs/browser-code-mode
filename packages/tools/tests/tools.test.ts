import assert from "node:assert/strict";
import { test } from "node:test";

import { generateText, stepCountIs } from "ai";
import { MockLanguageModelV4 } from "ai/test";

import { browserTools as aiSdkTools } from "../src/ai-sdk.ts";
import {
  type BrowserRunOutput,
  type BrowserToolsOptions,
  type LiveView,
  providerBrowser,
  type SessionSummary,
} from "../src/index.ts";
import { browserTools as mastraTools } from "../src/mastra.ts";

/** Answers commands like a page titled "Fake"; no Chrome needed. */
function fakeBrowser() {
  const state = { endpoints: [] as string[], closed: 0 };
  const connect: NonNullable<BrowserToolsOptions["connect"]> = async ({ cdpUrl }) => {
    state.endpoints.push(cdpUrl);
    return {
      async run(command: string, params: Record<string, unknown>) {
        if (command === "open") return { url: params.url, title: "Fake", pages: [] };
        if (command === "get") return { [String(params.what)]: "Fake" };
        throw new Error(`unexpected command ${command}`);
      },
      async close() {
        state.closed += 1;
      },
    };
  };
  return { state, connect };
}

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};

test("AI SDK: the model runs a program and reads the compact result text", async () => {
  const { state, connect } = fakeBrowser();
  const prompts: unknown[] = [];
  const model = new MockLanguageModelV4({
    doGenerate: async ({ prompt }) => {
      prompts.push(prompt);
      if (prompts.length === 1) {
        return {
          content: [
            {
              type: "tool-call",
              toolCallId: "call-1",
              toolName: "browser_run",
              input: JSON.stringify({
                code: `await browse.open("https://example.com"); return (await browse.get("title")).title;`,
              }),
            },
          ],
          finishReason: { unified: "tool-calls", raw: undefined },
          usage,
          warnings: [],
        };
      }
      return {
        content: [{ type: "text", text: "The title is Fake." }],
        finishReason: { unified: "stop", raw: undefined },
        usage,
        warnings: [],
      };
    },
  });

  const result = await generateText({
    model,
    tools: aiSdkTools({ cdpUrl: "ws://fake", connect, env: {} }),
    stopWhen: stepCountIs(3),
    prompt: "What is the title of example.com?",
  });

  assert.equal(result.text, "The title is Fake.");
  assert.deepEqual(state.endpoints, ["ws://fake"]);
  assert.equal(state.closed, 1);

  const toolResult = result.steps[0]?.toolResults[0];
  assert.ok(toolResult);
  const output = toolResult.output as BrowserRunOutput;
  assert.equal(output.status, "completed");
  assert.equal(output.value, "Fake");

  // The model sees the rendered text, not the JSON.
  const toolMessage = JSON.stringify((prompts[1] as unknown[]).at(-1));
  assert.match(toolMessage, /completed · 2 commands/);
  assert.match(toolMessage, /"type":"text"/);
});

test("AI SDK: a failed program is reported to the model as an error", async () => {
  const { connect } = fakeBrowser();
  const { execute, toModelOutput } = aiSdkTools({
    cdpUrl: "ws://fake",
    connect,
    env: {},
  }).browser_run;
  assert.ok(toModelOutput);
  const output = (await execute(
    { code: `await browse.back();` },
    { toolCallId: "1", messages: [], context: {} },
  )) as BrowserRunOutput;
  assert.equal(output.isError, true);
  assert.match(output.text, /unexpected command back/);
  const modelOutput = await toModelOutput({
    toolCallId: "1",
    input: { code: "" },
    output,
  });
  assert.equal(modelOutput.type, "error-text");
});

test("Mastra: tools share ids, descriptions, and execution", async () => {
  const { state, connect } = fakeBrowser();
  const tools = mastraTools({ cdpUrl: "ws://fake", connect, env: {} });
  assert.equal(tools.browser_run.id, "browser_run");
  assert.match(tools.browser_run.description, /Evaluate a TypeScript program/);
  assert.ok(tools.browser_api.execute && tools.browser_run.execute);
  assert.match(
    (await tools.browser_api.execute({}, {} as never)) as string,
    /declare const browse/,
  );

  const output = (await tools.browser_run.execute(
    { code: `return (await browse.get("title")).title;` },
    {} as never,
  )) as BrowserRunOutput;
  assert.equal(output.value, "Fake");
  assert.equal(state.closed, 1);
});

test("without cdpUrl, each program leases and releases a provider browser", async () => {
  const { state, connect } = fakeBrowser();
  const lifecycle: string[] = [];
  const tools = aiSdkTools({
    env: {},
    connect,
    provider: {
      name: "test",
      async create() {
        lifecycle.push("create");
        return { provider: "test", cdpUrl: "ws://leased" };
      },
      async shutdown() {
        lifecycle.push("shutdown");
      },
    },
  });
  await tools.browser_run.execute(
    { code: `return 1;` },
    { toolCallId: "1", messages: [], context: {} },
  );
  assert.deepEqual(lifecycle, ["create", "shutdown"]);
  assert.deepEqual(state.endpoints, ["ws://leased"]);
});

test("with a Browser, the model starts a session, drives it by id, watches it, and stops it", async () => {
  const { state, connect } = fakeBrowser();
  let created = 0;
  const shutdowns: Array<string | undefined> = [];
  const browser = providerBrowser(
    {
      name: "test",
      async create() {
        created += 1;
        return { provider: "test", cdpUrl: `ws://session-${created}`, sessionId: `s${created}` };
      },
      async shutdown(handle) {
        shutdowns.push(handle.sessionId);
      },
    },
    {
      connect: async () => ({
        async run() {
          return { base64: "SlBFRw==" };
        },
        async close() {},
      }),
    },
  );
  const tools = aiSdkTools({ browser, connect, env: {} });
  const options = { toolCallId: "1", messages: [], context: {} };
  const run = tools.browser_run.execute;
  const start = tools.browser_start?.execute;
  const stop = tools.browser_stop?.execute;
  const list = tools.browser_list_sessions?.execute;
  const liveView = tools.browser_live_view;
  assert.ok(start);
  assert.ok(stop);
  assert.ok(list);
  assert.ok(liveView?.toModelOutput);

  // The CDP URL is a credential: it never reaches the model.
  assert.doesNotMatch(JSON.stringify(tools.browser_run.inputSchema), /cdpUrl/);
  const started = await start({}, options);
  assert.deepEqual(Object.keys(started).sort(), ["id", "provider", "startedAt"]);
  await start({}, options);

  const first = (await run({ code: `return 1;`, sessionId: "s1" }, options)) as BrowserRunOutput;
  await run({ code: `return 1;` }, options);
  assert.match(first.text, /· session s1\n/);
  assert.doesNotMatch(JSON.stringify(first), /ws:\/\//);
  assert.deepEqual(state.endpoints, ["ws://session-1", "ws://session-2"]);

  const unknown = (await run(
    { code: `return 1;`, sessionId: "nope" },
    options,
  )) as BrowserRunOutput;
  assert.equal(unknown.isError, true);
  assert.match(unknown.text, /Unknown browser session: nope/);

  const view = (await liveView.execute({ sessionId: "s1" }, options)) as LiveView;
  const viewOutput = await liveView.toModelOutput({
    toolCallId: "1",
    input: { sessionId: "s1" },
    output: view,
  });
  assert.equal(viewOutput.type, "content");
  assert.match(JSON.stringify(viewOutput), /"mediaType":"image\/jpeg".*"SlBFRw=="/);

  await stop({ sessionId: "s1" }, options);
  const { sessions } = (await list({}, options)) as {
    sessions: SessionSummary[];
  };
  assert.deepEqual(
    sessions.map((s) => s.id),
    ["s2"],
  );
  assert.deepEqual(shutdowns, ["s1"]);
});

test("with a Browser and no open session, browser_run uses a temporary one", async () => {
  const { state, connect } = fakeBrowser();
  const lifecycle: string[] = [];
  const browser = providerBrowser({
    name: "test",
    async create() {
      lifecycle.push("create");
      return { provider: "test", cdpUrl: "ws://temporary" };
    },
    async shutdown() {
      lifecycle.push("shutdown");
    },
  });
  const tools = mastraTools({ browser, connect, env: {} });
  assert.ok(tools.browser_run.execute);
  await tools.browser_run.execute({ code: `return 1;` }, {} as never);
  assert.deepEqual(lifecycle, ["create", "shutdown"]);
  assert.deepEqual(state.endpoints, ["ws://temporary"]);
  assert.deepEqual(await browser.listSessions(), []);
});

test("without a Browser there are no session tools", () => {
  const tools = aiSdkTools({ cdpUrl: "ws://fake", env: {} });
  assert.deepEqual(Object.keys(tools).sort(), ["browser_api", "browser_run"]);
  assert.throws(
    () => aiSdkTools({ cdpUrl: "ws://fake", browser: providerBrowser({} as never) }),
    /not both/,
  );
});
