/**
 * The MCP surface for browser code mode.
 *
 * Two tools instead of thirty: `browser_run` evaluates a program written
 * against the `browse` command surface, and `browser_api` hands back that
 * surface's types. A program composes commands, loops, and filters in the
 * sandbox and returns only what matters, so a multi-step browser task costs one
 * tool call and one result instead of a round trip per click.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { COMMANDS } from "../browse/commands.ts";
import { BrowserSession, type CommandRunner } from "../browse/driver.ts";
import {
  staticProvider,
  type BrowserHandle,
  type BrowserProvider,
} from "../browse/provider.ts";
import { PROGRAM_GUIDE, renderApiDts, renderCheatsheet } from "../browse/dts.ts";
import type { ServerConfig } from "../config.ts";
import { runProgram, type ProgramResult } from "../sandbox/runner.ts";

export const SERVER_NAME = "browse-code-mode";
export const SERVER_VERSION = "0.1.0";

export const EXAMPLE_PROGRAM = `// One program instead of a dozen tool calls.
await browse.open("https://news.ycombinator.com");
const { tree } = await browse.snapshot({ maxDepth: 30 });

// Refs are derived from the snapshot this program just took — never typed
// from memory.
const stories = [...tree.matchAll(/\\[(\\d+-\\d+)\\] link: (.+)/g)]
  .map(([, ref, text]) => ({ ref, text }))
  .filter((story) => story.text.length > 25)
  .slice(0, 10);

log.info("matched", stories.length, "story links");

// Follow the first story, keeping the tree itself out of the reply.
await browse.click("@" + stories[0].ref);
await browse.wait("load", "domcontentloaded");

const [{ url }, { title }] = await Promise.all([browse.get("url"), browse.get("title")]);
return { stories, opened: { url, title } };`;

/** An open browser connection plus the means to release it. */
export interface Connection extends CommandRunner {
  close(): Promise<void>;
}

export interface CreateServerOptions {
  config: ServerConfig;
  run?: typeof runProgram;
  /**
   * Where browsers come from. Defaults to the configured CDP endpoint; swap in
   * a hosted provider without touching anything else.
   */
  provider?: BrowserProvider;
  /** How to attach to a browser. Overridden in tests; defaults to real CDP. */
  connect?: (options: {
    cdpUrl: string;
    signal?: AbortSignal;
    onEvent?: (message: string) => void;
  }) => Promise<Connection>;
}

const connectOverCdp: NonNullable<CreateServerOptions["connect"]> = (options) =>
  BrowserSession.connect(options as Parameters<typeof BrowserSession.connect>[0]);

export function createMcpServer({
  config,
  connect = connectOverCdp,
  provider = staticProvider(config.defaultCdpUrl),
  run = runProgram,
}: CreateServerOptions): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      capabilities: { logging: {} },
      instructions:
        `Drive a real browser by writing TypeScript programs and running them with ` +
        `\`browser_run\`. Each function in the sandbox is one \`browse\` CLI command. ` +
        `Read \`browser_api\` once before your first program.\n\n` +
        `Batch the steps you can already justify into one program, and stop at the ` +
        `first step that depends on page content you have not seen. Never write a ref ` +
        `or selector you have not observed: take a snapshot, look at what came back, ` +
        `then act on it.`,
    },
  );

  const allow = config.allowCommands.length > 0 ? config.allowCommands : undefined;
  const deny = config.denyCommands.length > 0 ? config.denyCommands : undefined;

  server.registerTool(
    "browser_run",
    {
      title: "Run a browser program",
      description: buildRunDescription(config),
      inputSchema: {
        code: z
          .string()
          .min(1)
          .describe(
            "TypeScript function body. Use top-level await, and `return` the values " +
              "you need back. Call `browser_api` for the available functions.",
          ),
        cdpUrl: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Chrome DevTools endpoint to drive: a port, an http(s) origin, or a " +
              "ws(s) URL. Defaults to the server's configured browser. Each program " +
              "attaches, runs, and detaches, so two programs naming different " +
              "endpoints are fully isolated.",
          ),
        timeoutMs: z
          .number()
          .int()
          .positive()
          .max(config.limits.timeoutMs ?? 120_000)
          .optional()
          .describe(`Wall-clock budget for the program. Defaults to ${config.limits.timeoutMs}.`),
      },
      annotations: {
        title: "Run a browser program",
        readOnlyHint: false,
        openWorldHint: true,
      },
    },
    async ({ code, cdpUrl, timeoutMs }, extra) => {
      const notify = (level: "info" | "error", data: unknown): void => {
        // Best-effort: a client that did not open a stream just misses these.
        void extra
          .sendNotification({
            method: "notifications/message",
            params: { level, logger: "browse", data },
          })
          .catch(() => {});
      };

      // Explicit endpoints are borrowed. Otherwise this call owns the provider
      // browser and must shut it down, even if attach/run/detach fails.
      let lease: BrowserHandle;
      try {
        lease = cdpUrl
          ? { provider: "cdp", cdpUrl }
          : await provider.create({ signal: extra.signal });
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: describeError(error) }],
          isError: true,
        };
      }

      const endpoint = lease.cdpUrl;
      let session: Connection;
      try {
        session = await connect({
          cdpUrl: endpoint,
          signal: extra.signal,
          onEvent: (message) => notify("info", { event: "browser", message }),
        });
      } catch (error) {
        if (!cdpUrl) await provider.shutdown(lease);
        return {
          content: [
            {
              type: "text" as const,
              text: `Could not attach to ${endpoint}: ${describeError(error)}`,
            },
          ],
          isError: true,
        };
      }

      try {
        const result = await run({
          code,
          session,
          limits: {
            ...config.limits,
            ...(timeoutMs ? { timeoutMs } : {}),
          },
          signal: extra.signal,
          ...(allow ? { allow } : {}),
          ...(deny ? { deny } : {}),
          onCallStart: (call) => notify("info", { event: "command", ...call }),
          onCallEnd: (call) => {
            if (!call.ok) {
              notify("error", {
                event: "command_failed",
                index: call.index,
                cli: call.cli,
                error: call.error,
              });
            }
          },
          onLog: (entry) =>
            notify(entry.level === "warn" ? "info" : entry.level, {
              event: "log",
              level: entry.level,
              args: entry.args,
            }),
        });

        return {
          content: [{ type: "text" as const, text: renderResult(result, endpoint) }],
          structuredContent: toStructuredContent(result, endpoint),
          isError: result.status !== "completed",
        };
      } finally {
        try {
          await session.close();
        } finally {
          if (!cdpUrl) await provider.shutdown(lease);
        }
      }
    },
  );

  server.registerTool(
    "browser_api",
    {
      title: "Browser program API",
      description:
        "The TypeScript API available inside `browser_run` programs: every `browse` " +
        "CLI command with its parameters, result shape, and shell equivalent. Read " +
        "this before writing your first program.",
      annotations: { title: "Browser program API", readOnlyHint: true, openWorldHint: false },
    },
    async () => ({
      content: [
        {
          type: "text" as const,
          text: `${renderApiDts({ ...(allow ? { exposed: allow } : {}) })}\n/* Example program\n\n${EXAMPLE_PROGRAM}\n*/\n`,
        },
      ],
    }),
  );

  server.registerResource(
    "browse-api",
    "browse://api.d.ts",
    {
      title: "browse code mode API",
      description: "TypeScript declarations for the sandbox's browser commands.",
      mimeType: "text/typescript",
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "text/typescript",
          text: renderApiDts({ ...(allow ? { exposed: allow } : {}) }),
        },
      ],
    }),
  );

  server.registerResource(
    "browse-guide",
    "browse://guide.md",
    {
      title: "browse code mode guide",
      description: "How programs execute, plus a worked example.",
      mimeType: "text/markdown",
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "text/markdown",
          text: `# browse code mode\n\n${PROGRAM_GUIDE}\n\n## Commands\n\n${renderCheatsheet({
            ...(allow ? { exposed: allow } : {}),
          })}\n\n## Example\n\n\`\`\`ts\n${EXAMPLE_PROGRAM}\n\`\`\`\n`,
        },
      ],
    }),
  );

  return server;
}

function buildRunDescription(config: ServerConfig): string {
  const exposed = COMMANDS.length;
  return [
    `Evaluate a TypeScript program against a real browser and return its result.`,
    ``,
    `The program runs in a sandbox whose only capability is the browser: ${exposed} functions,`,
    `each one a \`browse\` CLI command. Compose a whole task — navigate, snapshot, click,`,
    `read, filter — into one program and return just the data you need. Intermediate page`,
    `content stays in the sandbox instead of entering your context.`,
    ``,
    config.defaultCdpUrl
      ? `Browser: the CDP endpoint at \`${config.defaultCdpUrl}\`. Pass \`cdpUrl\` to drive a different one.`
      : "Browser: pass `cdpUrl` to reuse a browser, or omit it to create a temporary browser with the configured provider.",
    ``,
    `Each program attaches to the browser, runs, and detaches. Page state (tabs,`,
    `cookies, scroll) belongs to that browser and persists; snapshot refs do not,`,
    `so take a snapshot in the same program that uses its refs.`,
    ``,
    PROGRAM_GUIDE,
    ``,
    `## Commands`,
    ``,
    renderCheatsheet(),
    ``,
    `## Example`,
    ``,
    "```ts",
    EXAMPLE_PROGRAM,
    "```",
    ``,
    `Full signatures and result shapes: the \`browser_api\` tool.`,
  ].join("\n");
}

/** Human-readable result, kept small enough to sit in a model's context. */
function renderResult(result: ProgramResult, endpoint: string): string {
  const lines: string[] = [];
  const commands = result.calls.length;
  lines.push(
    `${result.status} · ${commands} command${commands === 1 ? "" : "s"} · ${result.durationMs}ms · ${endpoint}`,
  );

  if (result.logs.length > 0) {
    lines.push("", "logs:");
    for (const entry of result.logs) {
      lines.push(`  [${entry.level}] ${entry.args.map(stringify).join(" ")}`);
    }
  }

  if (result.status === "completed") {
    lines.push("", "returned:", indent(stringify(result.value)));
  } else if (result.failedCall) {
    // The sandbox masks host errors, so `result.error` just says "Host function
    // failed." The command's own message is the useful one; lead with it.
    lines.push(
      "",
      `error on command ${result.failedCall.index}: \`${result.failedCall.cli}\``,
      indent(result.failedCall.error ?? "unknown error"),
    );
  } else {
    lines.push("", `error: ${result.error?.name}: ${result.error?.message}`);
  }

  if (result.status !== "completed" && commands > 0) {
    lines.push("", "commands run:");
    for (const call of result.calls) {
      lines.push(`  ${call.index}. ${call.ok ? "ok " : "err"} ${call.cli} (${call.durationMs}ms)`);
    }
  }

  return lines.join("\n");
}

function toStructuredContent(
  result: ProgramResult,
  endpoint: string,
): Record<string, unknown> {
  return {
    status: result.status,
    cdpUrl: endpoint,
    durationMs: result.durationMs,
    ...(result.status === "completed" ? { value: result.value } : {}),
    ...(result.error ? { error: result.error } : {}),
    ...(result.failedCall
      ? {
          failedCall: {
            index: result.failedCall.index,
            cli: result.failedCall.cli,
            error: result.failedCall.error,
          },
        }
      : {}),
    ...(result.logs.length > 0 ? { logs: result.logs } : {}),
    commands: result.calls.map((call) => ({
      index: call.index,
      cli: call.cli,
      ok: call.ok,
      durationMs: call.durationMs,
      ...(call.error ? { error: call.error } : {}),
    })),
  };
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

function indent(value: string): string {
  return value
    .split("\n")
    .map((line) => (line.length > 0 ? `  ${line}` : line))
    .join("\n");
}
