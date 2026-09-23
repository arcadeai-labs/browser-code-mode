/**
 * The MCP surface for browser code mode.
 *
 * Two tools instead of thirty: `browser_run` evaluates a program written
 * against the `browse` command surface, and `browser_api` hands back that
 * surface's types. A program composes commands, loops, and filters in the
 * sandbox and returns only what matters, so a multi-step browser task costs one
 * tool call and one result instead of a round trip per click.
 *
 * The tools themselves live in `../core.ts`; this file only registers them.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import {
  API_TOOL_DESCRIPTION,
  INSTRUCTIONS,
  executeBrowserRun,
  renderBrowserApi,
  renderGuide,
  runInputShape,
  runToolDescription,
  type ToolDeps,
} from "../core.ts";
import { renderApiDts } from "../browse/dts.ts";

export { EXAMPLE_PROGRAM, type Connection } from "../core.ts";

export const SERVER_NAME = "browse-code-mode";
export const SERVER_VERSION = "0.1.0";

export type CreateServerOptions = ToolDeps;

export function createMcpServer(deps: CreateServerOptions): McpServer {
  const { config } = deps;
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { logging: {} }, instructions: INSTRUCTIONS },
  );

  const allow = config.allowCommands.length > 0 ? config.allowCommands : undefined;

  server.registerTool(
    "browser_run",
    {
      title: "Run a browser program",
      description: runToolDescription(config),
      inputSchema: runInputShape(config),
      annotations: {
        title: "Run a browser program",
        readOnlyHint: false,
        openWorldHint: true,
      },
    },
    async (input, extra) => {
      const { text, structuredContent, isError } = await executeBrowserRun(deps, input, {
        signal: extra.signal,
        notify: (level, data) => {
          // Best-effort: a client that did not open a stream just misses these.
          void extra
            .sendNotification({
              method: "notifications/message",
              params: { level, logger: "browse", data },
            })
            .catch(() => {});
        },
      });
      return {
        content: [{ type: "text" as const, text }],
        structuredContent,
        isError,
      };
    },
  );

  server.registerTool(
    "browser_api",
    {
      title: "Browser program API",
      description: API_TOOL_DESCRIPTION,
      annotations: { title: "Browser program API", readOnlyHint: true, openWorldHint: false },
    },
    async () => ({
      content: [{ type: "text" as const, text: renderBrowserApi(config) }],
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
      contents: [{ uri: uri.href, mimeType: "text/markdown", text: renderGuide(config) }],
    }),
  );

  return server;
}
