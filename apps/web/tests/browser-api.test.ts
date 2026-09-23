import assert from "node:assert/strict";
import { test } from "node:test";
import { proxyBrowserRequest } from "../src/lib/browser-api.ts";
import { mountedBrowserApp } from "../src/lib/browser-app.ts";
import { openMcpSession } from "../src/lib/mcp.ts";

test("TanStack mount exposes the Hono router and preserves authentication", async () => {
  const response = await mountedBrowserApp(new Request("http://localhost/api/browse/health"));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).stateless, true);
  const previous = process.env.MCP_AUTH_TOKEN;
  try {
    process.env.MCP_AUTH_TOKEN = "test-token";
    assert.equal((await mountedBrowserApp(new Request("http://localhost/api/browse/health"))).status, 401);
    assert.equal((await mountedBrowserApp(new Request("http://localhost/api/browse/health", {
      headers: { authorization: "Bearer test-token" },
    }))).status, 200);
  } finally {
    if (previous === undefined) delete process.env.MCP_AUTH_TOKEN;
    else process.env.MCP_AUTH_TOKEN = previous;
  }
});

test("chat discovers tools through in-process MCP without an HTTP server", async () => {
  const session = await openMcpSession();
  try {
    assert.deepEqual(Object.keys(session.tools).sort(), ["browser_api", "browser_run"]);
  } finally { await session.close(); }
});

test("cancelled preview body reads return 499 instead of an unhandled 500", async (t) => {
  const controller = new AbortController();
  const dispatch = t.mock.fn(async () => {
    const stream = new ReadableStream({
      start(sink) {
        controller.abort();
        sink.error(new DOMException("This operation was aborted", "AbortError"));
      },
    });
    return new Response(stream);
  });
  const response = await proxyBrowserRequest(new Request("http://localhost/api/screen", {
    method: "POST", body: '{"cdpUrl":"9222"}', signal: controller.signal,
  }), "/screen", dispatch);
  assert.equal(response.status, 499);
});

test("an unreachable backend returns a useful start error", async (t) => {
  const dispatch = t.mock.fn(async () => { throw new TypeError("fetch failed"); });
  const response = await proxyBrowserRequest(new Request("http://localhost/api/browser", { method: "POST" }), "/browser", dispatch);
  assert.equal(response.status, 502);
  assert.match((await response.json()).error, /pnpm dev/);
});

test("successful create and preview responses preserve their bodies", async (t) => {
  const handle = { provider: "cdp", cdpUrl: "9222" };
  const fetch = t.mock.fn(async () => Response.json(handle, { status: 201 }));
  const response = await proxyBrowserRequest(new Request("http://localhost/api/browser", { method: "POST" }), "/browser", fetch);
  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), handle);
  fetch.mock.mockImplementation(async () => new Response(new Uint8Array([255, 216, 255]), { headers: { "content-type": "image/jpeg" } }));
  const preview = await proxyBrowserRequest(new Request("http://localhost/api/screen", { method: "POST", body: JSON.stringify(handle) }), "/screen", fetch);
  assert.equal(preview.headers.get("content-type"), "image/jpeg");
  assert.deepEqual(new Uint8Array(await preview.arrayBuffer()), new Uint8Array([255, 216, 255]));
});
