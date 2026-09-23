/**
 * One way to get a browser, whatever provides it.
 *
 * ```ts
 * const browser = await openBrowser();
 * try {
 *   const tools = browserTools({ cdpUrl: browser.cdpUrl });
 *   // ...
 * } finally {
 *   await browser.close();
 * }
 * ```
 *
 * `BROWSE_PROVIDER` picks the source, with the same variables as the server:
 *
 * - `local`: launch local Chrome, or borrow one already on `CHROME_PORT`.
 *   The default when neither `BROWSE_PROVIDER` nor `BROWSE_CDP_URL` is set.
 * - `cdp`: borrow `BROWSE_CDP_URL`. The default when it is set; close is a no-op.
 * - `browserbase` / `kernel`: create a hosted session; close releases it.
 *
 * Node only when `local` is selected, which spawns a process.
 */

import { providerFromEnv, type BrowserHandle } from "@browse-code-mode/mcp-server/core";

export interface OpenedBrowser {
  /** Pass to `browserTools({ cdpUrl })`. Treat it as a credential. */
  cdpUrl: string;
  /** The serializable handle, e.g. a hosted session id or live view URL. */
  handle: BrowserHandle;
  /** Stop or release the browser. Idempotent. */
  close(): Promise<void>;
}

export async function openBrowser({
  env = process.env,
  signal,
}: {
  env?: Record<string, string | undefined>;
  signal?: AbortSignal;
} = {}): Promise<OpenedBrowser> {
  const name = env.BROWSE_PROVIDER ?? (env.BROWSE_CDP_URL ? "cdp" : "local");

  if (name === "local") {
    // Imported lazily so hosted providers never load child_process.
    const { createLocalBrowser } = await import("@browse-code-mode/mcp-server/local-browser");
    const local = await createLocalBrowser(signal ? { signal } : {});
    return {
      cdpUrl: local.browser.cdpUrl,
      handle: { ...local.browser, provider: "local" },
      close: once(() => local.shutdown()),
    };
  }

  const provider = providerFromEnv({ ...env, BROWSE_PROVIDER: name });
  const handle = await provider.create(signal ? { signal } : {});
  return { cdpUrl: handle.cdpUrl, handle, close: once(() => provider.shutdown(handle)) };
}

function once(close: () => Promise<void>): () => Promise<void> {
  let closing: Promise<void> | undefined;
  return () => (closing ??= close());
}
