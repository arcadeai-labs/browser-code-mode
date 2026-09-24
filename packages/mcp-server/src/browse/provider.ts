/** Serializable identity. Clients or external storage retain this, not the server.
 * Treat cdpUrl as a credential. */
export interface BrowserHandle {
  provider: string;
  cdpUrl: string;
  sessionId?: string | undefined;
  liveViewUrl?: string | undefined;
}

export interface CreateBrowserOptions {
  signal?: AbortSignal;
}

/** Lifecycle is separate from per-program attach/detach.
 * shutdown must work on a fresh provider instance and be idempotent.
 * Hosted implementations should set a provider-side TTL for abandoned clients. */
export interface BrowserProvider {
  readonly name: string;
  create(options?: CreateBrowserOptions): Promise<BrowserHandle>;
  shutdown(browser: BrowserHandle): Promise<void>;
}

export class NoBrowserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NoBrowserError";
  }
}

/** Borrow an externally managed browser. Shutdown never closes it. */
export function staticProvider(defaultCdpUrl?: string): BrowserProvider {
  return {
    name: "cdp",
    async create() {
      if (!defaultCdpUrl) {
        throw new NoBrowserError(
          "No browser to drive. Pass cdpUrl or configure BROWSE_CDP_URL / a BrowserProvider.",
        );
      }
      return { provider: "cdp", cdpUrl: defaultCdpUrl };
    },
    async shutdown() {},
  };
}

/** Adapter for vendor SDKs or REST APIs; no SDK enters the core runtime. */
export function browserProvider(options: {
  name: string;
  create: (options: CreateBrowserOptions) => Promise<Omit<BrowserHandle, "provider">>;
  shutdown: (browser: BrowserHandle) => Promise<void>;
}): BrowserProvider {
  return {
    name: options.name,
    async create(request = {}) {
      return { ...(await options.create(request)), provider: options.name };
    },
    async shutdown(browser) {
      if (browser.provider !== options.name)
        throw new Error("Browser belongs to a different provider.");
      await options.shutdown(browser);
    },
  };
}
