import assert from "node:assert/strict";
import { test } from "node:test";

import { generateText, stepCountIs } from "ai";
import { MockLanguageModelV4 } from "ai/test";

import { browserTools as aiSdkTools } from "../src/ai-sdk.ts";
import { browserTools as mastraTools } from "../src/mastra.ts";
import type { BrowserRunOutput, BrowserToolsOptions } from "../src/index.ts";

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

  const output = result.steps[0]!.toolResults[0]!.output as BrowserRunOutput;
  assert.equal(output.status, "completed");
  assert.equal(output.value, "Fake");

  // The model sees the rendered text, not the JSON.
  const toolMessage = JSON.stringify((prompts[1] as unknown[]).at(-1));
  assert.match(toolMessage, /completed · 2 commands/);
  assert.match(toolMessage, /"type":"text"/);
});

test("AI SDK: a failed program is reported to the model as an error", async () => {
  const { connect } = fakeBrowser();
  const tools = aiSdkTools({ cdpUrl: "ws://fake", connect, env: {} });
  const output = (await tools.browser_run.execute!(
    { code: `await browse.back();` },
    { toolCallId: "1", messages: [], context: {} },
  )) as BrowserRunOutput;
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
  assert.match(await tools.browser_api.execute!({}, {} as never) as string, /declare const browse/);

  const output = (await tools.browser_run.execute!(
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
  await tools.browser_run.execute!({ code: `return 1;` }, { toolCallId: "1", messages: [], context: {} });
  assert.deepEqual(lifecycle, ["create", "shutdown"]);
  assert.deepEqual(state.endpoints, ["ws://leased"]);
});
