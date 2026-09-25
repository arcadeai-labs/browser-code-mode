/** Hosted lifecycles use fetch only and retain no process-local session state. */
import { z } from "zod";
import { type BrowserProvider, browserProvider, staticProvider } from "./provider.ts";

type Env = Record<string, string | undefined>;
type Fetch = typeof fetch;

export function providerFromEnv(env: Env, request: Fetch = fetch): BrowserProvider {
  const name = env.BROWSE_PROVIDER ?? "cdp";
  if (name === "cdp") return staticProvider(env.BROWSE_CDP_URL);
  const timeout = Number(env.BROWSER_TIMEOUT_SECONDS ?? 600);
  if (!Number.isInteger(timeout) || timeout < 60)
    throw new Error("BROWSER_TIMEOUT_SECONDS must be an integer >= 60.");
  const required = (key: string) => {
    const value = env[key];
    if (!value) throw new Error(`${key} is required for ${name}.`);
    return value;
  };
  const api = async (
    url: string,
    method: string,
    headers: Record<string, string>,
    body?: object,
    signal?: AbortSignal,
    deleting = false,
  ) => {
    const response = await request(url, {
      method,
      headers: { ...headers, "content-type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(30_000)])
        : AbortSignal.timeout(30_000),
    });
    if (deleting && [404, 410].includes(response.status)) return null;
    if (!response.ok) throw new Error(`${name} ${method} failed (HTTP ${response.status}).`);
    if (response.status === 204) return null;
    return z.record(z.unknown()).parse(await response.json());
  };
  const field = (data: Record<string, unknown> | null, key: string): string => {
    const value = data?.[key];
    if (typeof value !== "string" || !value) throw new Error(`${name} returned no ${key}.`);
    return value;
  };
  if (name === "browserbase") {
    const headers = { "X-BB-API-Key": required("BROWSERBASE_API_KEY") };
    return browserProvider({
      name,
      async create({ signal }) {
        const session = await api(
          "https://api.browserbase.com/v1/sessions",
          "POST",
          headers,
          {
            ...(env.BROWSERBASE_PROJECT_ID ? { projectId: env.BROWSERBASE_PROJECT_ID } : {}),
            keepAlive: true,
            timeout,
          },
          signal,
        );
        return {
          cdpUrl: field(session, "connectUrl"),
          sessionId: field(session, "id"),
        };
      },
      async shutdown(browser) {
        if (!browser.sessionId) throw new Error("Browserbase sessionId is required.");
        await api(
          `https://api.browserbase.com/v1/sessions/${encodeURIComponent(browser.sessionId)}`,
          "POST",
          headers,
          { status: "REQUEST_RELEASE" },
          undefined,
          true,
        );
      },
    });
  }
  if (name === "kernel") {
    const headers = { authorization: `Bearer ${required("KERNEL_API_KEY")}` };
    return browserProvider({
      name,
      async create({ signal }) {
        const browser = await api(
          "https://api.onkernel.com/browsers",
          "POST",
          headers,
          { timeout_seconds: timeout },
          signal,
        );
        return {
          cdpUrl: field(browser, "cdp_ws_url"),
          sessionId: field(browser, "session_id"),
          ...(typeof browser?.browser_live_view_url === "string"
            ? { liveViewUrl: browser.browser_live_view_url }
            : {}),
        };
      },
      async shutdown(browser) {
        if (!browser.sessionId) throw new Error("Kernel sessionId is required.");
        await api(
          `https://api.onkernel.com/browsers/${encodeURIComponent(browser.sessionId)}`,
          "DELETE",
          headers,
          undefined,
          undefined,
          true,
        );
      },
    });
  }
  throw new Error(`Unknown BROWSE_PROVIDER: ${name}`);
}
