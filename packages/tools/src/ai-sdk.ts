/**
 * Browser tools for the Vercel AI SDK.
 *
 * ```ts
 * const { text } = await generateText({
 *   model,
 *   system: instructions,
 *   tools: browserTools({ browser }), // or { cdpUrl: "9222" }
 *   stopWhen: stepCountIs(12),
 *   prompt: "What's the weather in San Francisco?",
 * });
 * ```
 */

import { tool } from "ai";

import {
  type Browser,
  type BrowserToolkit,
  type BrowserToolsOptions,
  createBrowserToolkit,
  liveViewModelOutput,
  type SessionToolkit,
  toModelOutput,
} from "./index.ts";

export { type BrowserRunOutput, type BrowserToolsOptions, instructions } from "./index.ts";

type RunTools = ReturnType<typeof runTools>;
type SessionTools = ReturnType<typeof sessionTools>;

/** With a `browser`, the session tools join `browser_api` and `browser_run`. */
export function browserTools(
  options: BrowserToolsOptions & { browser: Browser },
): RunTools & SessionTools;
export function browserTools(options?: BrowserToolsOptions): RunTools;
export function browserTools(
  options: BrowserToolsOptions = {},
): RunTools | (RunTools & SessionTools) {
  const toolkit = createBrowserToolkit(options);
  const tools = runTools(toolkit);
  return toolkit.sessions ? { ...tools, ...sessionTools(toolkit.sessions) } : tools;
}

function runTools({ api, run }: BrowserToolkit) {
  return {
    browser_api: tool({
      description: api.description,
      inputSchema: api.inputSchema,
      execute: async () => api.execute(),
    }),
    browser_run: tool({
      description: run.description,
      inputSchema: run.inputSchema,
      execute: (input, { abortSignal }) => run.execute(input, abortSignal),
      toModelOutput: ({ output }) => toModelOutput(output),
    }),
  };
}

function sessionTools(sessions: SessionToolkit) {
  return {
    browser_start: tool({
      description: sessions.start.description,
      inputSchema: sessions.start.inputSchema,
      execute: (_, { abortSignal }) => sessions.start.execute(abortSignal),
    }),
    browser_stop: tool({
      description: sessions.stop.description,
      inputSchema: sessions.stop.inputSchema,
      execute: (input) => sessions.stop.execute(input),
    }),
    browser_list_sessions: tool({
      description: sessions.list.description,
      inputSchema: sessions.list.inputSchema,
      execute: () => sessions.list.execute(),
    }),
    browser_live_view: tool({
      description: sessions.liveView.description,
      inputSchema: sessions.liveView.inputSchema,
      execute: (input, { abortSignal }) => sessions.liveView.execute(input, abortSignal),
      toModelOutput: ({ output }) => liveViewModelOutput(output),
    }),
  };
}
