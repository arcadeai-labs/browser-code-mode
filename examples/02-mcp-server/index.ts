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
import { localProvider } from "@browse-code-mode/mcp-server/local-browser";
import {
  createBrowserToolkit,
  providerBrowser,
  type SessionToolkit,
} from "@browse-code-mode/tools";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

const port = Number(process.env.PORT ?? 3000);
const host = "127.0.0.1";

// Local Chrome: borrows one already on CHROME_PORT, or launches it.
// Sessions outlive each stateless request because they live in this process.
const browser = providerBrowser(localProvider());
const toolkit = createBrowserToolkit({ browser });
if (!toolkit.sessions) throw new Error("A toolkit created with a browser has session tools.");
const sessions: SessionToolkit = toolkit.sessions;
const runShape = sessionRunShape(toolkit.run.inputSchema.shape);

function sessionRunShape(shape: typeof toolkit.run.inputSchema.shape) {
  if (!("sessionId" in shape)) throw new Error("With a browser, browser_run takes a sessionId.");
  return shape;
}

const json = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
});

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
      inputSchema: runShape,
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async (input, { signal }) => {
      const { text, isError, ...structuredContent } = await toolkit.run.execute(input, signal);
      return { content: [{ type: "text", text }], structuredContent, isError };
    },
  );

  server.registerTool(
    sessions.start.name,
    {
      description: sessions.start.description,
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async ({ signal }) => json(await sessions.start.execute(signal)),
  );

  server.registerTool(
    sessions.stop.name,
    {
      description: sessions.stop.description,
      inputSchema: sessions.stop.inputSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async (input) => json(await sessions.stop.execute(input)),
  );

  server.registerTool(
    sessions.list.name,
    { description: sessions.list.description, annotations: { readOnlyHint: true } },
    async () => json(await sessions.list.execute()),
  );

  server.registerTool(
    sessions.liveView.name,
    {
      description: sessions.liveView.description,
      inputSchema: sessions.liveView.inputSchema.shape,
      annotations: { readOnlyHint: true },
    },
    async (input, { signal }) => {
      const { url, screenshot } = await sessions.liveView.execute(input, signal);
      return {
        content: [
          ...(url ? [{ type: "text" as const, text: `Live view: ${url}` }] : []),
          { type: "image" as const, data: screenshot.base64, mimeType: screenshot.mediaType },
        ],
      };
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
  console.log("the model starts browsers with browser_start; they stop on exit");
});

const stop = async () => {
  http.close();
  await browser.close();
  process.exit(0);
};
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());
