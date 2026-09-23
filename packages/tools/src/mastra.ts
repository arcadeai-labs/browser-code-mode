/**
 * Browser tools for Mastra agents, workflows, and MCP servers.
 *
 * ```ts
 * const agent = new Agent({
 *   name: "browser",
 *   instructions,
 *   model,
 *   tools: browserTools({ cdpUrl: "9222" }),
 * });
 * ```
 */

import { createTool } from "@mastra/core/tools";

import {
  createBrowserToolkit,
  toModelOutput,
  type BrowserRunOutput,
  type BrowserToolsOptions,
} from "./index.ts";

export { instructions, type BrowserToolsOptions, type BrowserRunOutput } from "./index.ts";

export function browserTools(options: BrowserToolsOptions = {}) {
  const { api, run } = createBrowserToolkit(options);
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
