/**
 * `browser_run` and `browser_api` as plain in-process tools.
 *
 * These are the same tools the MCP server registers — same descriptions, same
 * sandbox, same result text — without an MCP hop. `./ai-sdk` and `./mastra`
 * wrap this toolkit in each framework's tool type.
 */

import { z } from "zod";
import {
  API_TOOL_DESCRIPTION,
  INSTRUCTIONS,
  executeBrowserRun,
  loadConfig,
  providerFromEnv,
  renderBrowserApi,
  runInputShape,
  runToolDescription,
  staticProvider,
  type BrowserProvider,
  type ToolDeps,
} from "@browse-code-mode/mcp-server/core";

export {
  browserProvider,
  providerFromEnv,
  staticProvider,
  type BrowserHandle,
  type BrowserProvider,
} from "@browse-code-mode/mcp-server/core";

export interface BrowserToolsOptions {
  /**
   * CDP endpoint every program drives: a port, an http(s) origin, or a ws(s)
   * URL. Overrides `provider` and `BROWSE_CDP_URL`.
   */
  cdpUrl?: string;
  /**
   * Where browsers come from when there is no `cdpUrl`. Defaults to
   * `BROWSE_PROVIDER` and its credentials, read from `env`.
   */
  provider?: BrowserProvider;
  /** Configuration source (`SANDBOX_*`, `BROWSE_*`). Defaults to `process.env`. */
  env?: Record<string, string | undefined>;
  /** Commands, logs, and browser events as a program runs. */
  onEvent?: (event: BrowserEvent) => void;
  /** Test seams: how to attach to a browser and how to run a program. */
  connect?: ToolDeps["connect"];
  run?: ToolDeps["run"];
}

export interface BrowserEvent {
  level: "info" | "error";
  data: unknown;
}

/** `browser_run`'s result. `text` is what the model reads; the rest is JSON. */
export interface BrowserRunOutput {
  text: string;
  isError: boolean;
  status: "completed" | "failed" | "interrupted";
  value?: unknown;
  [key: string]: unknown;
}

export type BrowserRunInput = z.infer<ReturnType<typeof createBrowserToolkit>["run"]["inputSchema"]>;

/** Model guidance for either tool set; append it to your system prompt. */
export const instructions = INSTRUCTIONS;

export function createBrowserToolkit(options: BrowserToolsOptions = {}) {
  const env = options.env ?? process.env;
  const base = loadConfig(env);
  const config = options.cdpUrl ? { ...base, defaultCdpUrl: options.cdpUrl } : base;
  const deps: ToolDeps = {
    config,
    provider: options.cdpUrl
      ? staticProvider(options.cdpUrl)
      : (options.provider ?? providerFromEnv(env)),
    ...(options.connect ? { connect: options.connect } : {}),
    ...(options.run ? { run: options.run } : {}),
  };
  const notify = options.onEvent
    ? (level: BrowserEvent["level"], data: unknown) => options.onEvent!({ level, data })
    : undefined;

  return {
    instructions,
    api: {
      name: "browser_api" as const,
      description: API_TOOL_DESCRIPTION,
      inputSchema: z.object({}),
      execute: (): string => renderBrowserApi(config),
    },
    run: {
      name: "browser_run" as const,
      description: runToolDescription(config),
      inputSchema: z.object(runInputShape(config)),
      async execute(
        input: { code: string; cdpUrl?: string | undefined; timeoutMs?: number | undefined },
        signal?: AbortSignal,
      ): Promise<BrowserRunOutput> {
        const { text, isError, structuredContent } = await executeBrowserRun(deps, input, {
          signal,
          ...(notify ? { notify } : {}),
        });
        return { ...(structuredContent as { status: BrowserRunOutput["status"] }), text, isError };
      },
    },
  };
}

/** Hand the model the compact text, flagged as an error when the program failed. */
export function toModelOutput(output: BrowserRunOutput) {
  return { type: output.isError ? ("error-text" as const) : ("text" as const), value: output.text };
}
