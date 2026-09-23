/**
 * The agent's tools come from the MCP server, not from this app.
 *
 * `browser_run` and `browser_api` are defined once, in the server, and reach the
 * model through MCP. Nothing about the browser surface is duplicated here.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { dynamicTool, jsonSchema, type JSONSchema7, type ToolSet } from "ai";

import { mcpHeaders } from "./env.ts";
import { fetchBrowserApp } from "./browser-app.ts";

export interface McpSession {
  tools: ToolSet;
  instructions: string | undefined;
  close: () => Promise<void>;
}

/**
 * Connect for the duration of one chat turn. The MCP server is stateless, so
 * there is nothing to keep warm between requests.
 */
export async function openMcpSession(cdpUrl?: string): Promise<McpSession> {
  const client = new Client({ name: "browse-code-mode-web", version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(new URL("http://browse.internal/mcp"), {
    fetch: fetchBrowserApp,
    requestInit: {
      headers: {
        ...mcpHeaders(),
        ...(cdpUrl ? { "x-browse-cdp-url": cdpUrl } : {}),
      },
    },
  });

  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    return {
      tools: Object.fromEntries(
        tools.map((definition) => [
          definition.name,
          dynamicTool({
            description: definition.description ?? "",
            inputSchema: jsonSchema(definition.inputSchema as JSONSchema7),
            // The UI renders the raw MCP result; the model reads its text.
            execute: (input, { abortSignal }) =>
              client.callTool(
                { name: definition.name, arguments: input as Record<string, unknown> },
                undefined,
                abortSignal ? { signal: abortSignal } : {},
              ),
            toModelOutput: ({ output }) => {
              const result = output as CallToolResult;
              const value = result.content
                .map((part) => (part.type === "text" ? part.text : JSON.stringify(part)))
                .join("\n");
              return { type: result.isError ? "error-text" : "text", value };
            },
          }),
        ]),
      ),
      instructions: client.getInstructions(),
      close: () => client.close(),
    };
  } catch (error) {
    await client.close();
    throw error;
  }
}
