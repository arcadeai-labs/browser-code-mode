/**
 * The browser tools behind your own Streamable HTTP MCP server.
 *
 *   pnpm example 02-mcp-server
 *   claude mcp add --transport http browser http://127.0.0.1:3000/mcp
 *
 * Stateless: each POST gets a fresh McpServer and transport, and no session ids
 * are issued. The browser's tabs and cookies persist between programs because
 * they live in the browser, not here.
 */

import { createServer } from "node:http";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createBrowserToolkit } from "@browse-code-mode/tools";
import { openBrowser } from "@browse-code-mode/tools/browser";

const port = Number(process.env.PORT ?? 3000);
const host = "127.0.0.1";

// Local Chrome by default; BROWSE_PROVIDER / BROWSE_CDP_URL pick another browser.
const browser = await openBrowser();
const toolkit = createBrowserToolkit({ cdpUrl: browser.cdpUrl });

function createMcpServer(): McpServer {
  const server = new McpServer(
    { name: "browser", version: "0.1.0" },
    { instructions: toolkit.instructions },
  );

  server.registerTool(
    toolkit.api.name,
    { description: toolkit.api.description, annotations: { readOnlyHint: true } },
    async () => ({ content: [{ type: "text", text: toolkit.api.execute() }] }),
  );

  server.registerTool(
    toolkit.run.name,
    {
      description: toolkit.run.description,
      inputSchema: toolkit.run.inputSchema.shape,
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async (input, { signal }) => {
      const { text, isError, ...structuredContent } = await toolkit.run.execute(input, signal);
      return { content: [{ type: "text", text }], structuredContent, isError };
    },
  );

  return server;
}

// Anyone who can reach this server can drive the browser, so it listens on
// loopback only and rejects other Host headers (DNS rebinding).
const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);

const http = createServer(async (req, res) => {
  const { pathname } = new URL(req.url ?? "/", `http://${host}`);
  if (pathname !== "/mcp") return void res.writeHead(404).end();
  if (!allowedHosts.has(req.headers.host ?? "")) return void res.writeHead(403).end();
  if (req.method !== "POST") return void res.writeHead(405, { allow: "POST" }).end();

  const server = createMcpServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res);
  } catch (error) {
    console.error(error);
    if (!res.headersSent) res.writeHead(500).end();
  }
});

http.listen(port, host, () => {
  console.log(`browser MCP server on http://${host}:${port}/mcp`);
  console.log(`driving ${browser.handle.provider} browser${browser.handle.liveViewUrl ? ` (live view: ${browser.handle.liveViewUrl})` : ""}`);
});

const stop = async () => {
  http.close();
  await browser.close();
  process.exit(0);
};
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());
