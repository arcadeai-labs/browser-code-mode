import assert from "node:assert/strict";
import { test } from "node:test";

import { RequestContext } from "@mastra/core/request-context";
import { noopObserve } from "@mastra/core/tools";
import { generateText, stepCountIs } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { z } from "zod";

import { browserTools as aiSdkTools } from "../src/ai-sdk.ts";
import { browserTools as mastraTools } from "../src/mastra.ts";
import { providerBrowser, type BrowserToolsOptions } from "../src/index.ts";

const runOutputSchema = z
  .object({
    text: z.string(),
    isError: z.boolean(),
    status: z.enum(["completed", "failed", "interrupted"]),
    value: z.unknown(),
  })
  .passthrough();
const liveViewSchema = z.object({
  url: z.string().optional(),
  screenshot: z.object({ mediaType: z.literal("image/jpeg"), base64: z.string() }),
});
const sessionListSchema = z.object({ sessions: z.array(z.object({ id: z.string() }).passthrough()) });

const mastraContext = () => ({ requestContext: new RequestContext(), observe: noopObserve });

/** Answers commands like a page titled "Fake"; no Chrome needed. */
function fakeBrowser() {
  const state: { endpoints: string[]; closed: number } = { endpoints: [], closed: 0 };
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
  const prompts: unknown[][] = [];
  const model = new MockLanguageModelV4({
    doGenerate: async ({ prompt }) => {
      prompts.push(prompt);
      if (prompts.length === 1) {
        return {
          content: [{
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "browser_run",
            input: JSON.stringify({
              code: `await browse.open("https://example.com"); return (await browse.get("title")).title;`,
            }),
          }],
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

  const output = runOutputSchema.parse(result.steps[0]!.toolResults[0]!.output);
  assert.equal(output.status, "completed");
  assert.equal(output.value, "Fake");

  // The model sees the rendered text, not the JSON.
  const toolMessage = JSON.stringify(prompts[1]?.at(-1));
  assert.match(toolMessage, /completed · 2 commands/);
  assert.match(toolMessage, /"type":"text"/);
});

test("AI SDK: a failed program is reported to the model as an error", async () => {
  const { connect } = fakeBrowser();
  const tools = aiSdkTools({ cdpUrl: "ws://fake", connect, env: {} });
  const output = runOutputSchema.parse(
    await tools.browser_run.execute!(
      { code: `await browse.back();` },
      { toolCallId: "1", messages: [], context: {} },
    ),
  );
  assert.equal(output.isError, true);
  assert.match(output.text, /unexpected command back/);
  const modelOutput = await tools.browser_run.toModelOutput!({ toolCallId: "1", input: { code: "" }, output });
  assert.equal(modelOutput.type, "error-text");
});

test("Mastra: tools share ids, descriptions, and execution", async () => {
  const { state, connect } = fakeBrowser();
  const tools = mastraTools({ cdpUrl: "ws://fake", connect, env: {} });
  assert.equal(tools.browser_run.id, "browser_run");
  assert.match(tools.browser_run.description, /Evaluate a TypeScript program/);
  assert.match(z.string().parse(await tools.browser_api.execute!({}, mastraContext())), /declare const browse/);

  const output = runOutputSchema.parse(
    await tools.browser_run.execute!(
      { code: `return (await browse.get("title")).title;` },
      mastraContext(),
    ),
  );
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
  await tools.browser_run.execute!({ code: `return 1;` }, { toolCallId: "1", messages: [], context: {} });
  assert.deepEqual(lifecycle, ["create", "shutdown"]);
  assert.deepEqual(state.endpoints, ["ws://leased"]);
});

test("with a Browser, the model starts a session, drives it by id, watches it, and stops it", async () => {
  const { state, connect } = fakeBrowser();
  let created = 0;
  const shutdowns: string[] = [];
  const browser = providerBrowser(
    {
      name: "test",
      async create() {
        created += 1;
        return { provider: "test", cdpUrl: `ws://session-${created}`, sessionId: `s${created}` };
      },
      async shutdown(handle) {
        shutdowns.push(handle.sessionId!);
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

  // The CDP URL is a credential: it never reaches the model.
  assert.doesNotMatch(JSON.stringify(tools.browser_run.inputSchema), /cdpUrl/);
  const started = await tools.browser_start!.execute!({}, options);
  assert.deepEqual(Object.keys(started).sort(), ["id", "provider", "startedAt"]);
  await tools.browser_start!.execute!({}, options);

  const first = runOutputSchema.parse(await tools.browser_run.execute!({ code: `return 1;`, sessionId: "s1" }, options));
  await tools.browser_run.execute!({ code: `return 1;` }, options);
  assert.match(first.text, /· session s1\n/);
  assert.doesNotMatch(JSON.stringify(first), /ws:\/\//);
  assert.deepEqual(state.endpoints, ["ws://session-1", "ws://session-2"]);

  const unknown = runOutputSchema.parse(
    await tools.browser_run.execute!({ code: `return 1;`, sessionId: "nope" }, options),
  );
  assert.equal(unknown.isError, true);
  assert.match(unknown.text, /Unknown browser session: nope/);

  const view = liveViewSchema.parse(await tools.browser_live_view!.execute!({ sessionId: "s1" }, options));
  const viewOutput = await tools.browser_live_view!.toModelOutput!({ toolCallId: "1", input: { sessionId: "s1" }, output: view });
  assert.equal(viewOutput.type, "content");
  assert.match(JSON.stringify(viewOutput), /"mediaType":"image\/jpeg".*"SlBFRw=="/);

  await tools.browser_stop!.execute!({ sessionId: "s1" }, options);
  const { sessions } = sessionListSchema.parse(await tools.browser_list_sessions!.execute!({}, options));
  assert.deepEqual(sessions.map((s) => s.id), ["s2"]);
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
  await tools.browser_run.execute!({ code: `return 1;` }, mastraContext());
  assert.deepEqual(lifecycle, ["create", "shutdown"]);
  assert.deepEqual(state.endpoints, ["ws://temporary"]);
  assert.deepEqual(await browser.listSessions(), []);
});

test("without a Browser there are no session tools", () => {
  const tools = aiSdkTools({ cdpUrl: "ws://fake", env: {} });
  assert.deepEqual(Object.keys(tools).sort(), ["browser_api", "browser_run"]);
  assert.throws(() => aiSdkTools({ cdpUrl: "ws://fake", browser: providerBrowser({
    name: "unused",
    create: async () => ({ provider: "unused", cdpUrl: "ws://unused" }),
    shutdown: async () => {},
  }) }), /not both/);
});
