/**
 * The agent's tools come from the MCP server, not from this app.
 *
 * `browser_run` and `browser_api` are defined once, in the server, and reach the
 * model through MCP. Nothing about the browser surface is duplicated here.
 */

import { createMCPClient } from "@ai-sdk/mcp";

import { mcpHeaders } from "./env.ts";
import { fetchBrowserApp } from "./browser-app.ts";

export interface McpSession {
  tools: Awaited<
    ReturnType<Awaited<ReturnType<typeof createMCPClient>>["tools"]>
  >;
  instructions: string | undefined;
  close: () => Promise<void>;
}

/**
 * Connect for the duration of one chat turn. The MCP server is stateless, so
 * there is nothing to keep warm between requests.
 */
export async function openMcpSession(cdpUrl?: string): Promise<McpSession> {
  const client = await createMCPClient({
    transport: {
      type: "http",
      url: "http://browse.internal/mcp",
      fetch: fetchBrowserApp,
      headers: {
        ...mcpHeaders(),
        ...(cdpUrl ? { "x-browse-cdp-url": cdpUrl } : {}),
      },
    },
  });

  try {
    return {
      tools: await client.tools(),
      instructions: client.instructions,
      close: () => client.close(),
    };
  } catch (error) {
    await client.close();
    throw error;
  }
}
