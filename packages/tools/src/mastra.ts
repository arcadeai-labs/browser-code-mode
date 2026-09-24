/**
 * Browser tools for Mastra agents, workflows, and MCP servers.
 *
 * ```ts
 * const agent = new Agent({
 *   name: "browser",
 *   instructions,
 *   model,
 *   tools: browserTools({ browser }), // or { cdpUrl: "9222" }
 * });
 * ```
 */

import { createTool } from "@mastra/core/tools";

import {
  createBrowserToolkit,
  liveViewModelOutput,
  toModelOutput,
  type BrowserRunOutput,
  type LiveView,
  type Browser,
  type BrowserToolkit,
  type BrowserToolsOptions,
  type SessionToolkit,
} from "./index.ts";

export { instructions, type BrowserToolsOptions, type BrowserRunOutput } from "./index.ts";

type RunTools = ReturnType<typeof runTools>;
type SessionTools = ReturnType<typeof sessionTools>;

/** With a `browser`, the session tools join `browser_api` and `browser_run`. */
export function browserTools(options: BrowserToolsOptions & { browser: Browser }): RunTools & SessionTools;
export function browserTools(options?: BrowserToolsOptions): RunTools;
export function browserTools(options: BrowserToolsOptions = {}): RunTools | (RunTools & SessionTools) {
  const toolkit = createBrowserToolkit(options);
  const tools = runTools(toolkit);
  return toolkit.sessions ? { ...tools, ...sessionTools(toolkit.sessions) } : tools;
}

function runTools({ api, run }: BrowserToolkit) {
  return {
    browser_api: createTool({
      id: api.name,
      description: api.description,
      inputSchema: api.inputSchema,
      execute: async () => api.execute(),
    }),
    browser_run: createTool({
      id: run.name,
      description: run.description,
      inputSchema: run.inputSchema,
      execute: (input, { abortSignal }) => run.execute(input, abortSignal),
      toModelOutput: (output) => toModelOutput(output as BrowserRunOutput),
    }),
  };
}

function sessionTools(sessions: SessionToolkit) {
  return {
    browser_start: createTool({
      id: sessions.start.name,
      description: sessions.start.description,
      inputSchema: sessions.start.inputSchema,
      execute: (_, { abortSignal }) => sessions.start.execute(abortSignal),
    }),
    browser_stop: createTool({
      id: sessions.stop.name,
      description: sessions.stop.description,
      inputSchema: sessions.stop.inputSchema,
      execute: (input) => sessions.stop.execute(input),
    }),
    browser_list_sessions: createTool({
      id: sessions.list.name,
      description: sessions.list.description,
      inputSchema: sessions.list.inputSchema,
      execute: () => sessions.list.execute(),
    }),
    browser_live_view: createTool({
      id: sessions.liveView.name,
      description: sessions.liveView.description,
      inputSchema: sessions.liveView.inputSchema,
      execute: (input, { abortSignal }) => sessions.liveView.execute(input, abortSignal),
      toModelOutput: (output) => liveViewModelOutput(output as LiveView),
    }),
  };
}
