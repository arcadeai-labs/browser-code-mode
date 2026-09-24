import { createConfiguredApp } from "@browse-code-mode/mcp-server/runtime";

/** Request-local Hono app; no listener, loopback HTTP, or stored browser session. */
export async function fetchBrowserApp(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  return createConfiguredApp({ ...process.env, MCP_ENDPOINT: "/mcp" }).fetch(
    new Request(input, init),
  );
}

/** Mount the complete Hono router beneath /api/browse. */
export function mountedBrowserApp(request: Request): Promise<Response> {
  const url = new URL(request.url);
  url.pathname = url.pathname.replace(/^\/api\/browse(?=\/|$)/, "") || "/";
  return fetchBrowserApp(new Request(url, request));
}
