import assert from "node:assert/strict";
import { test } from "node:test";

import { openBrowser } from "../src/browser.ts";

test("BROWSE_CDP_URL is borrowed, and closing leaves it alone", async () => {
  const browser = await openBrowser({ env: { BROWSE_CDP_URL: "ws://borrowed" } });
  assert.equal(browser.cdpUrl, "ws://borrowed");
  assert.equal(browser.handle.provider, "cdp");
  await browser.close();
});

test("a hosted provider is created on open and released once on close", async (t) => {
  const requests: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    requests.push(`${init.method} ${url}`);
    return url.endsWith("/sessions")
      ? Response.json({ id: "session-1", connectUrl: "wss://browserbase/session-1" })
      : Response.json({});
  });

  const browser = await openBrowser({
    env: { BROWSE_PROVIDER: "browserbase", BROWSERBASE_API_KEY: "key" },
  });
  assert.equal(browser.cdpUrl, "wss://browserbase/session-1");
  assert.equal(browser.handle.sessionId, "session-1");

  await Promise.all([browser.close(), browser.close()]);
  assert.deepEqual(requests, [
    "POST https://api.browserbase.com/v1/sessions",
    "POST https://api.browserbase.com/v1/sessions/session-1",
  ]);
});
