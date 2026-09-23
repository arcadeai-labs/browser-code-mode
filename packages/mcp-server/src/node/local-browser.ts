/** Node-only dev lifecycle. Never import this from a deployed fetch handler. */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserHandle } from "../browse/provider.ts";

export async function cdpReady(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(500),
    });
    const info = (await response.json()) as { webSocketDebuggerUrl?: string };
    return response.ok && !!info.webSocketDebuggerUrl;
  } catch {
    return false;
  }
}

function findChrome(): string {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const candidates =
    process.platform === "darwin"
      ? [
          "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
          "/Applications/Chromium.app/Contents/MacOS/Chromium",
        ]
      : process.platform === "win32"
        ? ["C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"]
        : [
            "/usr/bin/google-chrome",
            "/usr/bin/chromium",
            "/usr/bin/chromium-browser",
          ];
  const executable = candidates.find(existsSync);
  if (!executable) throw new Error("Chrome not found. Set CHROME_PATH.");
  return executable;
}

export interface LocalBrowser {
  browser: BrowserHandle;
  owned: boolean;
  process?: ChildProcess;
  shutdown(): Promise<void>;
}

export async function createLocalBrowser({
  port = Number(process.env.CHROME_PORT ?? 9222),
  headless = process.env.CHROME_HEADLESS !== "0",
  signal,
}: {
  port?: number;
  headless?: boolean;
  signal?: AbortSignal;
} = {}): Promise<LocalBrowser> {
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("Invalid CHROME_PORT.");
  signal?.throwIfAborted();
  const browser = { provider: "cdp", cdpUrl: String(port) };
  if (await cdpReady(port))
    return { browser, owned: false, async shutdown() {} };
  const executable = findChrome();
  const temporary = !process.env.CHROME_USER_DATA_DIR;
  const profile =
    process.env.CHROME_USER_DATA_DIR ??
    (await mkdtemp(join(tmpdir(), "browse-cdp-")));
  const child = spawn(
    executable,
    [
      `--remote-debugging-port=${port}`,
      "--remote-allow-origins=*",
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-dev-shm-usage",
      ...(headless ? ["--headless=new"] : []),
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  let launchError: Error | undefined;
  const exited = new Promise<void>((resolve) => {
    child.once("error", (error) => {
      launchError = error;
      resolve();
    });
    child.once("exit", () => resolve());
  });
  let shutdownPromise: Promise<void> | undefined;
  const shutdown = (): Promise<void> =>
    (shutdownPromise ??= (async () => {
      if (
        child.exitCode === null &&
        child.signalCode === null &&
        !launchError
      ) {
        child.kill("SIGTERM");
        const timer = setTimeout(() => child.kill("SIGKILL"), 3000);
        await exited;
        clearTimeout(timer);
      }
      // Only remove the exact temporary profile created by this invocation.
      if (temporary) await rm(profile, { recursive: true, force: true });
    })());
  try {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      signal?.throwIfAborted();
      if (launchError) throw launchError;
      if (child.exitCode !== null || child.signalCode !== null)
        throw new Error("Chrome exited before CDP was ready.");
      if (await cdpReady(port))
        return { browser, owned: true, process: child, shutdown };
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    throw new Error(`Chrome did not expose CDP on ${port}.`);
  } catch (error) {
    await shutdown();
    throw error;
  }
}
