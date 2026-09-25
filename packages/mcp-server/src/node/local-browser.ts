/** Node-only dev lifecycle. Never import this from a deployed fetch handler. */
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { BrowserHandle, BrowserProvider } from "../browse/provider.ts";

export async function cdpReady(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(500),
    });
    const info = z
      .object({ webSocketDebuggerUrl: z.string().min(1) })
      .safeParse(await response.json());
    return response.ok && info.success;
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
        : ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"];
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
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid CHROME_PORT.");
  signal?.throwIfAborted();
  const browser = { provider: "cdp", cdpUrl: String(port) };
  if (await cdpReady(port)) return { browser, owned: false, async shutdown() {} };
  const executable = findChrome();
  const temporary = !process.env.CHROME_USER_DATA_DIR;
  const profile =
    process.env.CHROME_USER_DATA_DIR ?? (await mkdtemp(join(tmpdir(), "browse-cdp-")));
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
      if (child.exitCode === null && child.signalCode === null && !launchError) {
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
      if (await cdpReady(port)) return { browser, owned: true, process: child, shutdown };
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    throw new Error(`Chrome did not expose CDP on ${port}.`);
  } catch (error) {
    await shutdown();
    throw error;
  }
}

/**
 * Local Chrome as a provider. The first session borrows or launches Chrome on
 * `port`; later ones launch on free ports so sessions stay isolated.
 *
 * Unlike hosted providers, shutdown needs the instance that launched the
 * browser: the process lives here, not behind an API.
 */
export function localProvider({
  port = Number(process.env.CHROME_PORT ?? 9222),
  headless = process.env.CHROME_HEADLESS !== "0",
}: {
  port?: number;
  headless?: boolean;
} = {}): BrowserProvider {
  const running = new Map<string, LocalBrowser>();
  return {
    name: "local",
    async create({ signal } = {}) {
      const target = running.has(String(port)) ? await freePort() : port;
      const local = await createLocalBrowser({
        port: target,
        headless,
        ...(signal ? { signal } : {}),
      });
      running.set(local.browser.cdpUrl, local);
      return { provider: "local", cdpUrl: local.browser.cdpUrl, sessionId: local.browser.cdpUrl };
    },
    async shutdown(browser) {
      const local = running.get(browser.cdpUrl);
      running.delete(browser.cdpUrl);
      await local?.shutdown();
    },
  };
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close(() => reject(new Error("Could not determine a free TCP port.")));
        return;
      }
      server.close(() => resolve(address.port));
    });
  });
}
