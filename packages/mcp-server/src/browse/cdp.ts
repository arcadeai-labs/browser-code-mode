/**
 * Resolving a CDP endpoint.
 *
 * The browser is addressed by a Chrome DevTools Protocol URL and nothing else.
 * That URL is the whole session identity: this server launches no browser, owns
 * no process, and keeps nothing between requests. Point it at Chrome on your
 * laptop, a headless container, or a hosted CDP provider — it cannot tell the
 * difference.
 */

const DEFAULT_TIMEOUT_MS = 5_000;

export interface ResolveOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** Raised when a CDP endpoint cannot be reached or understood. */
export class CdpEndpointError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options as ErrorOptions);
    this.name = "CdpEndpointError";
  }
}

/**
 * Accept a port (`9222`), an HTTP origin (`http://host:9222`), or a browser
 * WebSocket URL, and return the WebSocket URL to attach to. Ports and HTTP
 * origins are resolved through `/json/version`, the same handshake `browse
 * --cdp` performs.
 */
export async function resolveCdpUrl(
  input: string,
  { timeoutMs = DEFAULT_TIMEOUT_MS, signal }: ResolveOptions = {},
): Promise<string> {
  const value = input.trim();
  if (!value) throw new CdpEndpointError("A CDP endpoint is required.");
  if (value.startsWith("ws://") || value.startsWith("wss://")) return value;

  const origin = /^\d+$/.test(value) ? `http://127.0.0.1:${value}` : value;
  if (!origin.startsWith("http://") && !origin.startsWith("https://")) {
    throw new CdpEndpointError(
      `Unrecognized CDP endpoint "${input}". Use a port, an http(s) origin, or a ws(s) URL.`,
    );
  }

  const payload = await fetchJson(new URL("/json/version", origin), timeoutMs, signal);
  const webSocketDebuggerUrl = (payload as { webSocketDebuggerUrl?: unknown })
    .webSocketDebuggerUrl;
  if (typeof webSocketDebuggerUrl !== "string") {
    throw new CdpEndpointError(
      `${origin} answered /json/version without a webSocketDebuggerUrl. Is it a Chrome DevTools endpoint?`,
    );
  }
  return webSocketDebuggerUrl;
}

async function fetchJson(
  url: URL,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<unknown> {
  signal?.throwIfAborted();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = (): void => controller.abort();
  signal?.addEventListener("abort", onAbort, { once: true });

  try {
    const response = await fetch(url, {
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new CdpEndpointError(`${url} responded with HTTP ${response.status}.`);
    }
    return await response.json();
  } catch (error) {
    if (error instanceof CdpEndpointError) throw error;
    if (error instanceof Error && error.name === "AbortError") {
      throw new CdpEndpointError(`Timed out reaching ${url} after ${timeoutMs}ms.`);
    }
    throw new CdpEndpointError(
      `Could not reach ${url}. Start Chrome with ` +
        `--remote-debugging-port and --remote-allow-origins=*.`,
      { cause: error },
    );
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}
