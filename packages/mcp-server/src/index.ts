#!/usr/bin/env node
/**
 * Entry point: serve the Hono app over Node's HTTP server.
 */

import { serve } from "@hono/node-server";

import { createApp } from "./app.ts";
import { loadConfig } from "./config.ts";
import { providerFromEnv } from "./browse/providers.ts";

const command = process.argv[2];
if (command && command !== "dev" && command !== "serve") {
  console.error("Usage: browse-code-mode [serve|dev]");
  process.exit(1);
}
// Local process ownership is confined to CLI dev, never the fetch application.
const startup = new AbortController();
let local: import("./node/local-browser.ts").LocalBrowser | undefined;
let starting:
  | Promise<import("./node/local-browser.ts").LocalBrowser>
  | undefined;
let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  startup.abort();
  server?.close();
  const browser = local ?? (await starting?.catch(() => undefined));
  await browser?.shutdown();
  process.exit(0);
};
let server: ReturnType<typeof serve> | undefined;
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    void stop();
  });
if (command === "dev") {
  try {
    const { createLocalBrowser } = await import("./node/local-browser.ts");
    starting = createLocalBrowser({ signal: startup.signal });
    local = await starting;
    if (stopping) {
      await local.shutdown();
      process.exit(0);
    }
    process.env.BROWSE_CDP_URL = local.browser.cdpUrl;
  } catch (error) {
    if (stopping) process.exit(0);
    console.error(error);
    process.exit(1);
  }
}
try {
  const config = loadConfig(process.env);
  const log = (message: string): void => {
    process.stderr.write(`[browse-code-mode] ${message}\n`);
  };

  const app = createApp({
    config,
    log,
    provider: providerFromEnv({
      ...process.env,
      ...(command === "dev" ? { BROWSE_PROVIDER: "cdp" } : {}),
    }),
  });

  server = serve(
    { fetch: app.fetch, hostname: config.host, port: config.port },
    (info) => {
      log(`listening on http://${config.host}:${info.port}${config.endpoint}`);
      log(
        config.defaultCdpUrl
          ? `default browser: ${config.defaultCdpUrl}`
          : "no BROWSE_CDP_URL set: callers must pass cdpUrl per request",
      );
      if (!config.authToken) {
        log(
          "no MCP_AUTH_TOKEN set: every caller on this host can drive the browser",
        );
      }
    },
  );

  server.on("error", async (error) => {
    console.error(error);
    await local?.shutdown();
    process.exit(1);
  });
  local?.process?.once("exit", () => {
    void stop();
  });
} catch (error) {
  console.error(error);
  await local?.shutdown();
  process.exit(1);
}
