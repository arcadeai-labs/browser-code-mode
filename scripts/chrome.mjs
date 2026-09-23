#!/usr/bin/env node
import { createLocalBrowser } from "../packages/mcp-server/src/node/local-browser.ts";

const startup = new AbortController();
let stopping = false;
const starting = createLocalBrowser({ signal: startup.signal });
const stop = async () => {
  if (stopping) return;
  stopping = true;
  startup.abort();
  const browser = await starting.catch(() => undefined);
  await browser?.shutdown();
  process.exit(0);
};
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());
try {
  const browser = await starting;
  console.log(
    `CDP browser on ${browser.browser.cdpUrl} (${browser.owned ? "owned" : "borrowed"})`,
  );
  if (!browser.owned) process.exit(0);
  browser.process?.once("exit", async () => {
    await browser.shutdown();
    process.exit(0);
  });
} catch (error) {
  if (!stopping) {
    console.error(error);
    process.exitCode = 1;
  }
}
