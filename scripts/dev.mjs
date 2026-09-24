#!/usr/bin/env node
/**
 * `pnpm dev` — bring up everything needed to use the app.
 *
 *   1. a Chrome with CDP exposed (skipped if one is already on the port)
 *   2. the web app, with the Hono MCP app mounted inside it
 *   4. your browser, opened on the UI
 *
 * Ctrl-C stops whatever this started, and deliberately leaves a browser it
 * found already running.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import net from "node:net";
import { fileURLToPath } from "node:url";

import { createLocalBrowser } from "../packages/mcp-server/src/node/local-browser.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
// The API key and anything else the app needs live in the workspace .env.
// Real environment variables still win.
const envFile = new URL("../.env", import.meta.url);
if (existsSync(envFile)) {
  try {
    process.loadEnvFile(fileURLToPath(envFile));
  } catch {
    // An unreadable .env should not stop the dev stack.
  }
}

const CHROME_PORT = Number(process.env.CHROME_PORT ?? 9222);
const WEB_PORT = Number(process.env.WEB_PORT ?? 3000);
const HEADLESS = process.env.CHROME_HEADLESS !== "0";

const children = [];
let localBrowser;
let startingBrowser;
const startup = new AbortController();
let stopping = false;

function log(tag, message) {
  process.stdout.write(`[${tag}] ${message}\n`);
}

/** Spawn a child and prefix its output, so three processes stay readable. */
function run(tag, command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: root,
    env: { ...process.env, ...options.env },
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  children.push({ tag, child });

  const forward = (stream) => {
    let buffer = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) if (line.trim()) log(tag, line);
    });
  };
  forward(child.stdout);
  forward(child.stderr);

  child.on("error", (error) => {
    log(tag, error.message);
    void shutdown(1);
  });
  child.on("exit", (code) => {
    if (stopping) return;
    log(tag, `exited with code ${code}`);
    shutdown(code ?? 1);
  });

  return child;
}

/**
 * True when something already accepts connections on the port.
 *
 * Both families are probed: a dev server bound only to ::1 is invisible to a
 * 127.0.0.1 connect, and missing it lets this script "succeed" against a stale
 * process.
 */
async function portInUse(port) {
  const probe = (host) =>
    new Promise((resolve) => {
      const socket = net.createConnection({ port, host });
      const settle = (inUse) => {
        socket.destroy();
        resolve(inUse);
      };
      socket.once("connect", () => settle(true));
      socket.once("error", () => settle(false));
      setTimeout(() => settle(false), 700);
    });

  const results = await Promise.all([probe("127.0.0.1"), probe("::1")]);
  return results.some(Boolean);
}

async function waitForHttp(url, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(1000),
        headers: process.env.MCP_AUTH_TOKEN
          ? { authorization: `Bearer ${process.env.MCP_AUTH_TOKEN}` }
          : {},
      });
      if (response.ok) return true;
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  log("dev", `${label} did not come up at ${url}`);
  return false;
}

async function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  startup.abort();
  await Promise.all(
    children.map(async ({ child }) => {
      if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
      const kill = (signal) => {
        try {
          if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal);
          else child.kill(signal);
        } catch {}
      };
      const exited = new Promise((resolve) => child.once("exit", resolve));
      kill("SIGTERM");
      const timer = setTimeout(() => kill("SIGKILL"), 3000);
      await exited;
      clearTimeout(timer);
    }),
  );
  const browser = localBrowser ?? (await startingBrowser?.catch(() => undefined));
  await browser?.shutdown();
  process.exit(code);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

// ------------------------------------------------------------- 0. preflight
// A stale server on either port would let this script report success while the
// UI talked to yesterday's code, so refuse to start rather than guess.
for (const [label, port] of [["web app", WEB_PORT]]) {
  if (await portInUse(port)) {
    log("dev", `Port ${port} is already in use, so the ${label} cannot start.`);
    log(
      "dev",
      `Stop whatever is on :${port}, or set ${label === "web app" ? "WEB_PORT" : "PORT"}.`,
    );
    process.exit(1);
  }
}

// ---------------------------------------------------------------- 1. browser
try {
  startingBrowser = createLocalBrowser({
    port: CHROME_PORT,
    headless: HEADLESS,
    signal: startup.signal,
  });
  localBrowser = await startingBrowser;
  if (stopping) {
    await localBrowser.shutdown();
    process.exit(0);
  }
  log("chrome", `${localBrowser.owned ? "started" : "borrowed"} browser on :${CHROME_PORT}`);
  localBrowser.process?.once("exit", () => {
    void shutdown(1);
  });
} catch (error) {
  log("chrome", error.message);
  await shutdown(1);
}

{
  // ----------------------------------------------------------------- 3. web app
  if (!process.env.ANTHROPIC_API_KEY) {
    log("web", "ANTHROPIC_API_KEY is not set — the UI will load but chat will fail.");
  }
  run("web", "pnpm", ["--filter", "@browse-code-mode/web", "dev", "--port", String(WEB_PORT)], {
    env: {
      BROWSE_PROVIDER: "cdp",
      PORT: String(WEB_PORT),
      BROWSE_CDP_URL: String(CHROME_PORT),
    },
  });
  if (!(await waitForHttp(`http://localhost:${WEB_PORT}/`, 60_000, "web app"))) {
    shutdown(1);
  }

  // -------------------------------------------------------------- 4. open the UI
  const url = `http://localhost:${WEB_PORT}/`;
  log("dev", `ready — ${url}`);
  if (process.env.NO_OPEN !== "1") {
    const opener =
      process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
    spawn(opener, [url], { stdio: "ignore", detached: true }).unref();
  }
}
