# 02 · MCP server

`browser_run` and `browser_api` from `@browse-code-mode/tools`, registered on an
`McpServer` from the official MCP SDK and served over stateless Streamable HTTP
with `node:http`.

```sh
pnpm example 02-mcp-server
# browser MCP server on http://127.0.0.1:3000/mcp
```

Connect a client:

```sh
claude mcp add --transport http browser http://127.0.0.1:3000/mcp
npx @modelcontextprotocol/inspector   # Streamable HTTP, same URL
```

As in 01, `openBrowser()` supplies the browser (local Chrome by default, or
whatever `BROWSE_PROVIDER` / `BROWSE_CDP_URL` select), and Ctrl-C closes it.
`PORT` changes the port.

The server listens on loopback and checks the `Host` header, because any caller
can drive the browser, and `browser_run` accepts a `cdpUrl` naming any endpoint.
Before exposing it elsewhere, add authentication (compare `MCP_AUTH_TOKEN` in
`packages/mcp-server`).

`createBrowserToolkit` is the framework-free form of the tools: a name,
description, zod input schema, and `execute` for each. The AI SDK and Mastra
adapters wrap the same object, so this server, those agents, and
`packages/mcp-server` all hand the model identical tools.
