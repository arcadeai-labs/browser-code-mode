import assert from "node:assert/strict";
import { test } from "node:test";

import { providerFromEnv } from "@browse-code-mode/mcp-server/core";

import { providerBrowser } from "../src/browser.ts";

test("a borrowed CDP browser gets a session id, and stopping leaves it alone", async () => {
  const browser = providerBrowser(providerFromEnv({ BROWSE_CDP_URL: "ws://borrowed" }));
  const session = await browser.start();
  assert.equal(session.cdpUrl, "ws://borrowed");
  assert.equal(session.provider, "cdp");
  assert.ok(session.id);
  assert.deepEqual(await browser.listSessions(), [session]);

  await browser.stop(session.id);
  assert.deepEqual(await browser.listSessions(), []);
  await assert.rejects(browser.stop(session.id), /Unknown browser session/);
});

test("hosted sessions are created on start and released once on close", async (t) => {
  const requests: string[] = [];
  let created = 0;
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    requests.push(`${init.method} ${url}`);
    if (!url.endsWith("/sessions")) return Response.json({});
    created += 1;
    return Response.json({
      id: `session-${created}`,
      connectUrl: `wss://browserbase/session-${created}`,
    });
  });

  const browser = providerBrowser(
    providerFromEnv({ BROWSE_PROVIDER: "browserbase", BROWSERBASE_API_KEY: "key" }),
  );
  const first = await browser.start();
  const second = await browser.start();
  assert.equal(first.id, "session-1");
  assert.equal(second.cdpUrl, "wss://browserbase/session-2");

  await Promise.all([browser.close(), browser.close()]);
  assert.deepEqual(await browser.listSessions(), []);
  assert.deepEqual(requests, [
    "POST https://api.browserbase.com/v1/sessions",
    "POST https://api.browserbase.com/v1/sessions",
    "POST https://api.browserbase.com/v1/sessions/session-1",
    "POST https://api.browserbase.com/v1/sessions/session-2",
  ]);
});

test("live view returns a screenshot, plus the provider's URL when it has one", async () => {
  const attached: string[] = [];
  const browser = providerBrowser(
    {
      name: "test",
      async create() {
        return {
          provider: "test",
          cdpUrl: "ws://watched",
          sessionId: "s1",
          liveViewUrl: "https://live/s1",
        };
      },
      async shutdown() {},
    },
    {
      connect: async ({ cdpUrl }) => {
        attached.push(cdpUrl);
        return {
          async run(command: string) {
            assert.equal(command, "screenshot");
            return { base64: "SlBFRw==" };
          },
          async close() {},
        };
      },
    },
  );
  const session = await browser.start();
  assert.deepEqual(await browser.liveView(session.id), {
    url: "https://live/s1",
    screenshot: { mediaType: "image/jpeg", base64: "SlBFRw==" },
  });
  assert.deepEqual(attached, ["ws://watched"]);
  await assert.rejects(browser.liveView("nope"), /Unknown browser session/);
});
