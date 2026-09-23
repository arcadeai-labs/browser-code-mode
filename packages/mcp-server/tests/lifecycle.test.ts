import assert from "node:assert/strict";
import { test } from "node:test";
import { createApp } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { browserProvider, staticProvider } from "../src/browse/provider.ts";
import { providerFromEnv } from "../src/browse/providers.ts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../src/mcp/server.ts";

test("provider shutdown still runs when CDP disconnect throws", async () => {
  let stopped = false;
  const server = createMcpServer({
    config: loadConfig(),
    provider: browserProvider({
      name: "test", create: async () => ({ cdpUrl: "wss://example.test" }),
      shutdown: async () => { stopped = true; },
    }),
    connect: async () => ({ run: async () => null, close: async () => { throw new Error("disconnect failed"); } }),
  });
  const client = new Client({ name: "cleanup-test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const result = await client.callTool({ name: "browser_run", arguments: { code: "return 1;" } });
    assert.equal(result.isError, true);
    assert.equal(stopped, true);
  } finally { await client.close(); await server.close(); }
});

test("a serialized handle can be shut down on a fresh instance", async () => {
  const stopped: string[] = [];
  const provider = () =>
    browserProvider({
      name: "test",
      create: async () => ({
        sessionId: "session-1",
        cdpUrl: "wss://browser.example/session-1",
      }),
      shutdown: async (browser) => {
        stopped.push(browser.sessionId!);
      },
    });
  const create = createApp({ config: loadConfig(), provider: provider() });
  const result = await create.fetch(
    new Request("http://test/browser", { method: "POST" }),
  );
  assert.equal(result.status, 201);
  const handle = await result.json();
  const fresh = createApp({ config: loadConfig(), provider: provider() });
  const response = await fresh.fetch(
    new Request("http://test/browser", {
      method: "DELETE",
      body: JSON.stringify(handle),
    }),
  );
  assert.equal(response.status, 204);
  assert.deepEqual(stopped, ["session-1"]);
  const wrong = await fresh.fetch(
    new Request("http://test/browser", {
      method: "DELETE",
      body: JSON.stringify({ ...handle, provider: "other" }),
    }),
  );
  assert.equal(wrong.status, 400);
});

test("static lifecycle borrows a browser", async () => {
  const provider = staticProvider("9222");
  const handle = await provider.create();
  assert.deepEqual(handle, { provider: "cdp", cdpUrl: "9222" });
  await provider.shutdown(handle);
  await provider.shutdown(handle);
});

for (const name of ["kernel", "browserbase"]) {
  test(`${name} lifecycle uses provider API and survives reconstruction`, async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const request: typeof fetch = async (input, init) => {
      calls.push({ url: String(input), ...(init ? { init } : {}) });
      if (calls.length > 1) return new Response(null, { status: 404 });
      return Response.json(
        name === "kernel"
          ? {
              session_id: "one",
              cdp_ws_url: "wss://kernel.example/one",
              browser_live_view_url: "https://kernel.example/live/one",
            }
          : { id: "one", connectUrl: "wss://browserbase.example/one" },
      );
    };
    const env = {
      BROWSE_PROVIDER: name,
      KERNEL_API_KEY: "test",
      BROWSERBASE_API_KEY: "test",
    };
    const handle = await providerFromEnv(env, request).create();
    assert.equal(handle.provider, name);
    assert.equal(handle.sessionId, "one");
    const body = JSON.parse(String(calls[0]?.init?.body));
    assert.equal(name === "kernel" ? body.timeout_seconds : body.timeout, 600);
    if (name === "browserbase") assert.equal(body.keepAlive, true);
    await providerFromEnv(env, request).shutdown(
      JSON.parse(JSON.stringify(handle)),
    );
    assert.match(calls[1]!.url, /\/one$/);
    assert.equal(calls[1]?.init?.method, name === "kernel" ? "DELETE" : "POST");
  });
}
