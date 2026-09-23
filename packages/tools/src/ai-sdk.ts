/**
 * Browser tools for the Vercel AI SDK.
 *
 * ```ts
 * const { text } = await generateText({
 *   model,
 *   system: instructions,
 *   tools: browserTools({ cdpUrl: "9222" }),
 *   stopWhen: stepCountIs(12),
 *   prompt: "What's the weather in San Francisco?",
 * });
 * ```
 */

import { tool } from "ai";

import { createBrowserToolkit, toModelOutput, type BrowserToolsOptions } from "./index.ts";

export { instructions, type BrowserToolsOptions, type BrowserRunOutput } from "./index.ts";

export function browserTools(options: BrowserToolsOptions = {}) {
  const { api, run } = createBrowserToolkit(options);
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
