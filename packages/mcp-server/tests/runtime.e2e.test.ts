import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";
import { createLocalBrowser, cdpReady } from "../src/node/local-browser.ts";

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No test port");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

test(
  "deployed runtime executes a program and leaves borrowed Chrome alive",
  { timeout: 90_000 },
  async () => {
    const chromePort = await freePort();
    const port = await freePort();
    const local = await createLocalBrowser({ port: chromePort });
    const worker = process.env.BROWSE_RUNTIME === "worker";
    const child = spawn(
      worker ? "pnpm" : process.execPath,
      worker
        ? [
            "exec",
            "wrangler",
            "dev",
            "--port",
            String(port),
            "--var",
            `BROWSE_CDP_URL:${chromePort}`,
          ]
        : ["src/index.ts", "dev"],
      {
        cwd: new URL("..", import.meta.url),
        env: {
          ...process.env,
          PORT: String(port),
          CHROME_PORT: String(chromePort),
          MCP_AUTH_TOKEN: "",
          BROWSE_PROVIDER: "cdp",
        },
        stdio: "pipe",
        detached: process.platform !== "win32",
      },
    );
    let output = "";
    child.stdout.on("data", (data) => {
      output += data;
    });
    child.stderr.on("data", (data) => {
      output += data;
    });
    const exit = new Promise<void>((resolve) =>
      child.once("exit", () => resolve()),
    );
    const client = new Client({ name: "runtime-test", version: "1" });
    const base = `http://127.0.0.1:${port}`;
    try {
      const deadline = Date.now() + 30_000;
      while (true) {
        if (Date.now() >= deadline || child.exitCode !== null)
          throw new Error(`Runtime did not start: ${output}`);
        try {
          if ((await fetch(`${base}/health`)).ok) break;
        } catch {}
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      const create = await fetch(`${base}/browser`, { method: "POST" });
      assert.equal(create.status, 201);
      const browser = z.object({ cdpUrl: z.string() }).passthrough().parse(await create.json());
      await client.connect(
        new StreamableHTTPClientTransport(new URL(`${base}/mcp`)),
      );
      const call = (code: string) =>
        client.callTool({
          name: "browser_run",
          arguments: { code, cdpUrl: browser.cdpUrl },
        });
      const result = await call(`
      await browse.open("data:text/html,<title>Runtime</title><h1>Hello</h1><input id=name><button>Go</button>");
      await browse.fill("#name", "Cloudflare");
      const {tree} = await browse.snapshot();
      const ref = /\\[(\\d+-\\d+)\\] button/.exec(tree)?.[1];
      if (!ref) throw new Error("No button ref");
      await browse.click("@" + ref);
      const answer: number = 42;
      return {answer, title: await browse.get("title"), value: await browse.get("value", "#name")};
    `);
      assert.equal(result.isError, false, JSON.stringify(result));
      assert.deepEqual(z.object({ value: z.unknown() }).parse(result.structuredContent).value, {
        answer: 42,
        title: { title: "Runtime" },
        value: { value: "Cloudflare" },
      });
      const loop = await call("while (true) {}");
      assert.equal(loop.isError, true);
      assert.equal(
        z.object({ error: z.object({ name: z.string() }) }).parse(loop.structuredContent).error.name,
        "RunTimeoutError",
      );
      const screenshot = await fetch(`${base}/screen`, {
        method: "POST",
        body: JSON.stringify(browser),
      });
      assert.equal(screenshot.status, 200);
      assert.equal(screenshot.headers.get("content-type"), "image/jpeg");
      assert.ok((await screenshot.arrayBuffer()).byteLength > 100);
      const shutdown = await fetch(`${base}/browser`, {
        method: "DELETE",
        body: JSON.stringify(browser),
      });
      assert.equal(shutdown.status, 204);
    } finally {
      await client.close().catch(() => {});
      if (child.pid && child.exitCode === null) {
        if (process.platform === "win32") child.kill("SIGTERM");
        else process.kill(-child.pid, "SIGTERM");
        await exit;
      }
      const borrowedSurvived = await cdpReady(chromePort);
      await local.shutdown();
      assert.equal(borrowedSurvived, true);
      assert.equal(await cdpReady(chromePort), false);
    }
  },
);
