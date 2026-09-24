/**
 * The browser lifecycle behind the session tools: one method per tool.
 *
 * | Method         | Tool                    |
 * | -------------- | ----------------------- |
 * | `start`        | `browser_start`         |
 * | `stop`         | `browser_stop`          |
 * | `listSessions` | `browser_list_sessions` |
 * | `liveView`     | `browser_live_view`     |
 *
 * Implement `Browser` for any source of browsers, or adapt a `BrowserProvider`
 * with `providerBrowser`:
 *
 * ```ts
 * const browser = providerBrowser(provider);
 * try {
 *   const tools = browserTools({ browser });
 *   // ...
 * } finally {
 *   await browser.close();
 * }
 * ```
 */

import {
  type BrowserProvider,
  captureScreenshot,
  type ToolDeps,
} from "@browse-code-mode/mcp-server/core";

export interface BrowserSession {
  /** What the model passes back as `sessionId`. */
  id: string;
  provider: string;
  /** Where programs attach. A credential: never shown to the model. */
  cdpUrl: string;
  /** A page a person can open to watch the session, when the provider has one. */
  liveViewUrl?: string;
  startedAt: string;
}

export interface LiveView {
  /** The session's live view page, when the provider has one. */
  url?: string;
  /** The current page, as the model sees it. */
  screenshot: { mediaType: "image/jpeg"; base64: string };
}

export interface Browser {
  start(options?: { signal?: AbortSignal }): Promise<BrowserSession>;
  /** Throws for an unknown session. */
  stop(sessionId: string): Promise<void>;
  listSessions(): Promise<BrowserSession[]>;
  liveView(sessionId: string, options?: { signal?: AbortSignal }): Promise<LiveView>;
}

export interface ProviderBrowser extends Browser {
  /** Stop every session still open. */
  close(): Promise<void>;
}

/**
 * Sessions from a `BrowserProvider`, tracked in memory. `listSessions` reports
 * the sessions this instance started and has not stopped.
 */
export function providerBrowser(
  provider: BrowserProvider,
  { connect }: { connect?: ToolDeps["connect"] } = {},
): ProviderBrowser {
  const sessions = new Map<string, BrowserSession>();
  const find = (sessionId: string): BrowserSession => {
    const session = sessions.get(sessionId);
    if (!session) throw new Error(`Unknown browser session: ${sessionId}.`);
    return session;
  };

  const browser: ProviderBrowser = {
    async start({ signal } = {}) {
      const handle = await provider.create(signal ? { signal } : {});
      const session: BrowserSession = {
        id: handle.sessionId ?? crypto.randomUUID(),
        provider: handle.provider,
        cdpUrl: handle.cdpUrl,
        ...(handle.liveViewUrl ? { liveViewUrl: handle.liveViewUrl } : {}),
        startedAt: new Date().toISOString(),
      };
      sessions.set(session.id, session);
      return session;
    },
    async stop(sessionId) {
      const { id, provider: name, cdpUrl } = find(sessionId);
      // Forget it first, so a second stop fails fast instead of racing this one.
      sessions.delete(id);
      await provider.shutdown({ provider: name, cdpUrl, sessionId: id });
    },
    async listSessions() {
      return [...sessions.values()];
    },
    async liveView(sessionId, { signal } = {}) {
      const session = find(sessionId);
      const base64 = await captureScreenshot(session.cdpUrl, {
        ...(connect ? { connect } : {}),
        signal,
      });
      return {
        ...(session.liveViewUrl ? { url: session.liveViewUrl } : {}),
        screenshot: { mediaType: "image/jpeg", base64 },
      };
    },
    async close() {
      await Promise.allSettled([...sessions.keys()].map((id) => browser.stop(id)));
    },
  };
  return browser;
}
