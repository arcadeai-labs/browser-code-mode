import assert from "node:assert/strict";
import { after, test } from "node:test";

import { serve } from "@hono/node-server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { LoggingMessageNotificationSchema } from "@modelcontextprotocol/sdk/types.js";

import { createApp } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { createFakeBrowser, echoHandler, type FakeBrowser, type FakeHandler } from "./helpers/fake-browser.ts";

const cleanups: Array<() => Promise<void>> = [];

after(async () => {
  for (const close of cleanups) await close();
});

async function startServer(env: NodeJS.ProcessEnv = {}, handler?: FakeHandler) {
  const config = loadConfig({ BROWSE_CDP_URL: "ws://fake-browser", ...env } as NodeJS.ProcessEnv);

  const connections: FakeBrowser[] = [];
  const app = createApp({
    config,
    connect: async () => {
      const browser = createFakeBrowser(handler ?? echoHandler);
      connections.push(browser);
      return browser;
    },
  });

  const { server, port } = await new Promise<{
    server: ReturnType<typeof serve>;
    port: number;
  }>((resolve) => {
    const instance = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, (info) =>
      resolve({ server: instance, port: info.port }),
    );
  });
  const url = `http://127.0.0.1:${port}${config.endpoint}`;

  const notifications: unknown[] = [];
  const client = new Client({ name: "test", version: "1.0.0" });
  client.setNotificationHandler(LoggingMessageNotificationSchema, (notification) => {
    notifications.push(notification.params.data);
  });

  const transport = new StreamableHTTPClientTransport(new URL(url), {
    ...(env.MCP_AUTH_TOKEN
      ? { requestInit: { headers: { authorization: `Bearer ${env.MCP_AUTH_TOKEN}` } } }
      : {}),
  });

  cleanups.push(async () => {
    await client.close().catch(() => {});
    server.close();
  });

  await client.connect(transport);
  const run = (code: string, args: Record<string, unknown> = {}) =>
    client.callTool({ name: "browser_run", arguments: { code, ...args } });

  return { url, client, run, notifications, connections, transport };
}

function textOf(result: { content?: unknown }): string {
  const content = result.content as Array<{ type: string; text: string }> | undefined;
  return content?.[0]?.text ?? "";
}

test("the server advertises exactly the code mode surface", async () => {
  const { client } = await startServer();

  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((tool) => tool.name).sort(), ["browser_api", "browser_run"]);

  // The point of code mode: one tool description instead of a schema per command.
  const run = tools.find((tool) => tool.name === "browser_run");
  assert.ok(run?.description?.includes("browse.open"));
  assert.ok(run?.description?.includes("mouse.scroll"));
  assert.ok(run?.inputSchema.properties && "cdpUrl" in run.inputSchema.properties);

  const { resources } = await client.listResources();
  assert.deepEqual(
    resources.map((resource) => resource.uri).sort(),
    ["browse://api.d.ts", "browse://guide.md"],
  );
});

test("the transport is stateless: no session id is issued", async () => {
  const { transport } = await startServer();
  assert.equal(transport.sessionId, undefined);
});

test("browser_api returns declarations for every group", async () => {
  const { client } = await startServer();
  const api = textOf(await client.callTool({ name: "browser_api", arguments: {} }));
  for (const group of ["browse", "mouse", "tab", "log"]) {
    assert.ok(api.includes(`declare const ${group}`), `missing ${group}`);
  }
});

test("a program runs and returns structured output", async () => {
  const { run, notifications, connections } = await startServer();
  const result = await run(`
    await browse.open("https://example.com");
    log.info("opened");
    const { title } = await browse.get("title");
    return { title };
  `);

  assert.equal(result.isError, false);
  assert.match(textOf(result), /^completed · 2 commands/);

  const structured = result.structuredContent as Record<string, unknown>;
  assert.equal(structured.status, "completed");
  assert.deepEqual(structured.value, { title: "fake-title" });
  assert.equal(structured.cdpUrl, "ws://fake-browser");

  // Streamed over the same HTTP response, before the result was returned.
  assert.ok(
    notifications.some(
      (notification) =>
        (notification as { cli?: string }).cli === "browse open https://example.com",
    ),
  );

  // Stateless: the connection was opened for this call and released after it.
  assert.equal(connections.length, 1);
  assert.equal(connections[0]?.closed, true);
});

test("every call gets its own browser connection", async () => {
  const { run, connections } = await startServer();
  await run(`return await browse.get("url");`);
  await run(`return await browse.get("url");`);

  assert.equal(connections.length, 2);
  assert.ok(connections.every((connection) => connection.closed));
});

test("the connection is released even when the program fails", async () => {
  const { run, connections } = await startServer({}, (command) => {
    if (command === "click") throw new Error("element is not attached to the DOM");
    return { ok: true };
  });

  const result = await run(`await browse.click("@0-1"); return "unreachable";`);
  assert.equal(result.isError, true);
  assert.match(textOf(result), /error on command 1: `browse click @0-1`/);
  assert.match(textOf(result), /element is not attached to the DOM/);
  assert.equal(connections[0]?.closed, true);
});

test("a call naming its own cdpUrl overrides the default", async () => {
  const { run } = await startServer();
  const result = await run(`return 1;`, { cdpUrl: "ws://other-browser" });
  assert.equal((result.structuredContent as { cdpUrl: string }).cdpUrl, "ws://other-browser");
});

test("a missing browser is reported instead of guessed", async () => {
  const config = loadConfig({} as NodeJS.ProcessEnv);
  assert.equal(config.defaultCdpUrl, undefined);

  const app = createApp({ config, connect: async () => createFakeBrowser() });
  const { server, port } = await new Promise<{
    server: ReturnType<typeof serve>;
    port: number;
  }>((resolve) => {
    const instance = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, (info) =>
      resolve({ server: instance, port: info.port }),
    );
  });
  cleanups.push(async () => server.close());

  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}${config.endpoint}`)),
  );
  const result = await client.callTool({ name: "browser_run", arguments: { code: "return 1;" } });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /No browser to drive/);
  await client.close();
});

test("a bearer token is required when one is configured", async () => {
  const { url } = await startServer({ MCP_AUTH_TOKEN: "s3cret" });
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
  });
  assert.equal(response.status, 401);
});

test("health reports the stateless deployment", async () => {
  const { url } = await startServer();
  const origin = new URL(url).origin;
  const health = (await (await fetch(`${origin}/health`)).json()) as {
    stateless: boolean;
    defaultCdpUrl: string;
  };
  assert.equal(health.stateless, true);
  assert.equal(health.defaultCdpUrl, "ws://fake-browser");

  const dts = await (await fetch(`${origin}/api.d.ts`)).text();
  assert.ok(dts.includes("declare const browse"));
});

test("a provider supplies the browser and is released after the program", async () => {
  // Stands in for a hosted provider: create a session on acquire, end it after.
  const acquired: string[] = [];
  const released: string[] = [];

  const config = loadConfig({} as NodeJS.ProcessEnv);
  const app = createApp({
    config,
    provider: {
      name: "test-cloud",
      async create() {
        const sessionId = `session-${acquired.length + 1}`;
        acquired.push(sessionId);
        return {
          provider: "test-cloud",
          cdpUrl: `wss://cloud.example/${sessionId}`,
          sessionId,
          liveViewUrl: `https://cloud.example/watch/${sessionId}`,
        };
      },
      async shutdown(browser) { released.push(browser.sessionId!); },
    },
    connect: async () => createFakeBrowser(),
  });

  const { server, port } = await new Promise<{
    server: ReturnType<typeof serve>;
    port: number;
  }>((resolve) => {
    const instance = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, (info) =>
      resolve({ server: instance, port: info.port }),
    );
  });
  cleanups.push(async () => server.close());

  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}${config.endpoint}`)),
  );

  const result = await client.callTool({
    name: "browser_run",
    arguments: { code: `return await browse.get("url");` },
  });

  assert.equal(result.isError, false);
  assert.equal((result.structuredContent as { cdpUrl: string }).cdpUrl, "wss://cloud.example/session-1");
  assert.deepEqual(acquired, ["session-1"]);
  assert.deepEqual(released, ["session-1"], "the session must be ended, not orphaned");

  // A failing program still returns its session.
  await client.callTool({ name: "browser_run", arguments: { code: `throw new Error("nope");` } });
  assert.deepEqual(released, ["session-1", "session-2"]);

  await client.close();
});

test("a provider that cannot produce a browser reports why", async () => {
  const config = loadConfig({} as NodeJS.ProcessEnv);
  const app = createApp({
    config,
    provider: {
      name: "test-cloud",
      create: async () => {
        throw new Error("no capacity in region us-west");
      },
      async shutdown() {},
    },
    connect: async () => createFakeBrowser(),
  });

  const { server, port } = await new Promise<{
    server: ReturnType<typeof serve>;
    port: number;
  }>((resolve) => {
    const instance = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, (info) =>
      resolve({ server: instance, port: info.port }),
    );
  });
  cleanups.push(async () => server.close());

  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}${config.endpoint}`)),
  );
  const result = await client.callTool({ name: "browser_run", arguments: { code: "return 1;" } });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /no capacity in region us-west/);
  await client.close();
});
