/**
 * `browser_run` and `browser_api` as plain in-process tools, plus the session
 * tools when a `Browser` is given.
 *
 * `browser_run` and `browser_api` are the same tools the MCP server registers —
 * same descriptions, same sandbox, same result text — without an MCP hop.
 * `./ai-sdk` and `./mastra` wrap this toolkit in each framework's tool type.
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

import type { Browser, BrowserSession, LiveView } from "./browser.ts";

export {
  browserProvider,
  providerFromEnv,
  staticProvider,
  type BrowserHandle,
  type BrowserProvider,
} from "@browse-code-mode/mcp-server/core";
export {
  providerBrowser,
  type Browser,
  type BrowserSession,
  type LiveView,
  type ProviderBrowser,
} from "./browser.ts";

export interface BrowserToolsOptions {
  /**
   * CDP endpoint every program drives: a port, an http(s) origin, or a ws(s)
   * URL. Overrides `provider` and `BROWSE_CDP_URL`. Not combined with `browser`.
   */
  cdpUrl?: string;
  /**
   * Browser sessions the model manages: adds `browser_start`, `browser_stop`,
   * `browser_list_sessions`, and `browser_live_view`, and `browser_run` takes a
   * `sessionId` instead of a `cdpUrl`.
   */
  browser?: Browser;
  /**
   * Where `browser_run` gets a temporary browser when there is no `cdpUrl` or
   * `browser`. Defaults to `BROWSE_PROVIDER` and its credentials, read from `env`.
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
  status: z.infer<typeof runStatusSchema>["status"];
  value?: unknown;
  [key: string]: unknown;
}

export interface BrowserRunInput {
  code: string;
  /** Only without `browser`. */
  cdpUrl?: string | undefined;
  /** Only with `browser`. */
  sessionId?: string | undefined;
  timeoutMs?: number | undefined;
}

const runStatusSchema = z.object({ status: z.enum(["completed", "failed", "interrupted"]) });

/** A session as the model sees it: everything but the CDP credential. */
export type SessionSummary = Omit<BrowserSession, "cdpUrl">;

/** Model guidance for either tool set; append it to your system prompt. */
export const instructions = INSTRUCTIONS;

export function createBrowserToolkit(options: BrowserToolsOptions = {}) {
  const { browser } = options;
  if (options.cdpUrl && browser) throw new Error("Pass cdpUrl or browser, not both.");
  const env = options.env ?? process.env;
  const base = loadConfig(env);
  const config = options.cdpUrl ? { ...base, defaultCdpUrl: options.cdpUrl } : base;
  const deps: ToolDeps = {
    config,
    provider: options.cdpUrl
      ? staticProvider(options.cdpUrl)
      : browser
        ? temporarySessions(browser)
        : (options.provider ?? providerFromEnv(env)),
    ...(options.connect ? { connect: options.connect } : {}),
    ...(options.run ? { run: options.run } : {}),
  };
  const notify = options.onEvent
    ? (level: BrowserEvent["level"], data: unknown) => options.onEvent!({ level, data })
    : undefined;

  const sessionIdInput = z.object({
    sessionId: z.string().min(1).describe("A session id from `browser_start` or `browser_list_sessions`."),
  });
  const runShape = runInputShape(config);
  const runInputSchema = browser
    ? z.object({
        code: runShape.code,
        sessionId: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Session to drive, from `browser_start`. Defaults to the most recently " +
              "started session, or a temporary browser when none is open.",
          ),
        timeoutMs: runShape.timeoutMs,
      })
    : z.object(runShape);

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
      description: runToolDescription(
        config,
        browser
          ? "Browser: pass the `sessionId` from `browser_start`. Without one, the most " +
              "recently started session is used, or a temporary browser when none is open."
          : undefined,
      ),
      inputSchema: runInputSchema,
      async execute(
        { sessionId, ...input }: BrowserRunInput,
        signal?: AbortSignal,
      ): Promise<BrowserRunOutput> {
        let label: string | undefined;
        if (browser && !input.cdpUrl) {
          const sessions = await browser.listSessions();
          const session = sessionId ? sessions.find((s) => s.id === sessionId) : sessions.at(-1);
          if (sessionId && !session) {
            const text = `Unknown browser session: ${sessionId}. Call browser_list_sessions for the open ones.`;
            return { text, isError: true, status: "failed", error: { name: "Error", message: text } };
          }
          if (session) input.cdpUrl = session.cdpUrl;
          label = session ? `session ${session.id}` : "temporary session";
        }
        const { text, isError, structuredContent } = await executeBrowserRun(deps, input, {
          signal,
          label,
          ...(notify ? { notify } : {}),
        });
        const { status } = runStatusSchema.parse(structuredContent);
        return { ...structuredContent, status, text, isError };
      },
    },
    sessions: browser
      ? {
          start: {
            name: "browser_start" as const,
            description:
              "Start a browser session and return its id. Pass the id to `browser_run` " +
              "as `sessionId`; tabs, cookies, and logins persist across programs until " +
              "`browser_stop`.",
            inputSchema: z.object({}),
            execute: async (signal?: AbortSignal): Promise<SessionSummary> =>
              summarize(await browser.start(signal ? { signal } : {})),
          },
          stop: {
            name: "browser_stop" as const,
            description: "Stop a browser session and release it. Its tabs and cookies are gone.",
            inputSchema: sessionIdInput,
            execute: async ({ sessionId }: { sessionId: string }) => {
              await browser.stop(sessionId);
              return { stopped: sessionId };
            },
          },
          list: {
            name: "browser_list_sessions" as const,
            description: "List the open browser sessions, most recently started last.",
            inputSchema: z.object({}),
            execute: async (): Promise<{ sessions: SessionSummary[] }> => ({
              sessions: (await browser.listSessions()).map(summarize),
            }),
          },
          liveView: {
            name: "browser_live_view" as const,
            description:
              "See a browser session as it is now: a screenshot of the current page, " +
              "plus a URL a person can open to watch it live when the provider has one.",
            inputSchema: sessionIdInput,
            execute: ({ sessionId }: { sessionId: string }, signal?: AbortSignal): Promise<LiveView> =>
              browser.liveView(sessionId, signal ? { signal } : {}),
          },
        }
      : undefined,
  };
}

export type BrowserToolkit = ReturnType<typeof createBrowserToolkit>;
export type SessionToolkit = NonNullable<BrowserToolkit["sessions"]>;

/** `browser_run` without a session: start one for the program, stop it after. */
function temporarySessions(browser: Browser): BrowserProvider {
  return {
    name: "browser",
    async create(options) {
      const session = await browser.start(options);
      return { provider: session.provider, cdpUrl: session.cdpUrl, sessionId: session.id };
    },
    async shutdown(handle) {
      await browser.stop(handle.sessionId!);
    },
  };
}

function summarize({ cdpUrl: _, ...session }: BrowserSession): SessionSummary {
  return session;
}

/** Hand the model the compact text, flagged as an error when the program failed. */
export function toModelOutput(output: Pick<BrowserRunOutput, "text" | "isError">) {
  return { type: output.isError ? ("error-text" as const) : ("text" as const), value: output.text };
}

/** The screenshot as an image, with the live view URL when there is one. */
export function liveViewModelOutput({ url, screenshot }: LiveView) {
  return {
    type: "content" as const,
    value: [
      { type: "text" as const, text: url ? `Live view: ${url}` : "No live view URL for this session; screenshot of the current page:" },
      { type: "file" as const, mediaType: screenshot.mediaType, data: { type: "data" as const, data: screenshot.base64 } },
    ],
  };
}
