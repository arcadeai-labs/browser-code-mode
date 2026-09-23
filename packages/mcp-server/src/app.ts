/**
 * Hono application exposing the MCP server over Streamable HTTP.
 *
 * Stateless: no MCP session ids, no session map. Browser handles are caller-owned. Each
 * request gets its own short-lived server and transport, and the browser it
 * drives is named by a CDP URL the caller already owns. Any instance can serve
 * any request, and a restart loses nothing.
 */

import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { Hono } from "hono";
import { z } from "zod";
import { staticProvider } from "./browse/provider.ts";
import { BrowserSession } from "./browse/driver.ts";

import { renderApiDts, renderCheatsheet, PROGRAM_GUIDE } from "./browse/dts.ts";
import type { ServerConfig } from "./config.ts";
import {
  createMcpServer,
  SERVER_NAME,
  SERVER_VERSION,
  type CreateServerOptions,
} from "./mcp/server.ts";

export interface AppDeps {
  config: ServerConfig;
  run?: CreateServerOptions["run"];
  log?: (message: string) => void;
  /** How to attach to a browser. Overridden in tests; defaults to real CDP. */
  connect?: CreateServerOptions["connect"];
  /** Where browsers come from. Defaults to the configured CDP endpoint. */
  provider?: CreateServerOptions["provider"];
}

export interface App {
  fetch: (request: Request, ...rest: unknown[]) => Response | Promise<Response>;
}

export function createApp({
  config,
  log = () => {},
  connect,
  run,
  provider = staticProvider(config.defaultCdpUrl),
}: AppDeps): App {
  const app = new Hono();
  app.onError((error, c) => {
    if (c.req.raw.signal.aborted) return new Response(null, { status: 499 });
    if (error.name === "NoBrowserError")
      return c.json({ error: "No browser configured. Run pnpm dev locally, or configure BROWSE_PROVIDER and its credentials." }, 503);
    log(`Browser operation failed: ${error.message}`);
    return c.json({ error: "Browser operation failed. Check the server logs and browser provider configuration." }, 500);
  });

  // ---------------------------------------------------------------- middleware
  app.use("*", async (c, next) => {
    if (config.allowedOrigins.length > 0) {
      const origin = c.req.header("origin");
      // Non-browser clients send no Origin; only reject a stated, unlisted one.
      if (origin && !config.allowedOrigins.includes(origin)) {
        return c.json({ error: "Origin not allowed." }, 403);
      }
    }

    if (config.authToken) {
      const header = c.req.header("authorization") ?? "";
      const token = header.startsWith("Bearer ") ? header.slice(7) : "";
      if (!timingSafeEqual(token, config.authToken)) {
        return c.json({ error: "Unauthorized." }, 401, {
          "WWW-Authenticate": 'Bearer realm="browse-code-mode"',
        });
      }
    }

    await next();
  });

  // ------------------------------------------------------------------ endpoints
  // Handles travel with callers. Creation/shutdown never require sticky routing.
  app.post("/browser", async (c) => {
    const browser = await provider.create({ signal: c.req.raw.signal });
    return c.json(browser, 201, { "cache-control": "no-store" });
  });

  app.delete("/browser", async (c) => {
    const parsed = browserHandleSchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success)
      return c.json({ error: "A browser handle is required." }, 400);
    if (parsed.data.provider !== provider.name)
      return c.json({ error: "Wrong browser provider." }, 400);
    await provider.shutdown(parsed.data);
    return c.body(null, 204);
  });

  app.post("/screen", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { cdpUrl?: string };
    const endpoint = body.cdpUrl ?? config.defaultCdpUrl;
    if (!endpoint || typeof endpoint !== "string")
      return c.json({ error: "cdpUrl is required." }, 400);
    const session = await (connect ?? BrowserSession.connect)({
      cdpUrl: endpoint,
      signal: c.req.raw.signal,
    });
    try {
      const result = (await session.run("screenshot", {
        type: "jpeg",
        quality: 70,
      })) as { base64: string };
      return c.body(
        Uint8Array.from(atob(result.base64), (char) => char.charCodeAt(0)),
        200,
        {
          "content-type": "image/jpeg",
          "cache-control": "no-store",
        },
      );
    } finally {
      await session.close();
    }
  });

  app.get("/health", (c) =>
    c.json({
      name: SERVER_NAME,
      version: SERVER_VERSION,
      endpoint: config.endpoint,
      stateless: true,
      defaultCdpUrl: config.defaultCdpUrl ?? null,
    }),
  );

  /** Inspect any local or hosted CDP browser without HTTP discovery endpoints. */
  app.get("/browser", async (c) => {
    const endpoint = c.req.query("cdpUrl") ?? config.defaultCdpUrl;
    if (!endpoint)
      return c.json(
        { error: "No cdpUrl given and no default configured." },
        400,
      );

    try {
      const session = await (connect ?? BrowserSession.connect)({
        cdpUrl: endpoint,
        signal: c.req.raw.signal,
      });
      try {
        return c.json(await session.run("tab.list", {}), 200, {
          "cache-control": "no-store",
        });
      } finally {
        await session.close();
      }
    } catch (error) {
      return c.json(
        { error: error instanceof Error ? error.message : String(error) },
        502,
      );
    }
  });

  /** The sandbox API surface, for humans and for agents that prefer a fetch. */
  app.get("/api.d.ts", (c) =>
    c.text(renderApiDts(exposedOption(config)), 200, {
      "content-type": "text/typescript; charset=utf-8",
    }),
  );

  app.get("/api.md", (c) =>
    c.text(
      `# browse code mode\n\n${PROGRAM_GUIDE}\n\n## Commands\n\n${renderCheatsheet(
        exposedOption(config),
      )}\n`,
      200,
      { "content-type": "text/markdown; charset=utf-8" },
    ),
  );

  app.all(config.endpoint, async (c) => {
    if (c.req.method === "GET" || c.req.method === "DELETE") {
      // Stateless: there is no standalone stream to open and no session to end.
      return c.json(
        {
          jsonrpc: "2.0",
          error: {
            code: -32000,
            message:
              "This server is stateless. Send requests as POSTs; no session is kept.",
          },
          id: null,
        },
        405,
      );
    }

    const server = createMcpServer({
      config: c.req.header("x-browse-cdp-url")
        ? { ...config, defaultCdpUrl: c.req.header("x-browse-cdp-url")! }
        : config,
      ...(run ? { run } : {}),
      ...(connect ? { connect } : {}),
      provider: c.req.header("x-browse-cdp-url")
        ? staticProvider(c.req.header("x-browse-cdp-url"))
        : provider,
    });
    // No `sessionIdGenerator`: the transport runs in stateless mode.
    const transport = new WebStandardStreamableHTTPServerTransport();
    await server.connect(transport);

    let response: Response;
    try {
      response = await transport.handleRequest(c.req.raw);
    } catch (error) {
      await closeQuietly(server, transport);
      throw error;
    }

    // The body may still be streaming notifications, so tear down only once the
    // client has actually received everything.
    if (!response.body) {
      await closeQuietly(server, transport);
      return response;
    }

    const reader = response.body.getReader();
    const body = new ReadableStream({
      async pull(controller) {
        try {
          const chunk = await reader.read();
          if (chunk.done) {
            await closeQuietly(server, transport);
            controller.close();
          } else controller.enqueue(chunk.value);
        } catch (error) {
          await closeQuietly(server, transport);
          controller.error(error);
        }
      },
      async cancel(reason) {
        try {
          await reader.cancel(reason);
        } finally {
          await closeQuietly(server, transport);
        }
      },
    });
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  });

  log(`stateless MCP endpoint mounted at ${config.endpoint}`);
  return { fetch: app.fetch as App["fetch"] };
}

const browserHandleSchema = z.object({
  provider: z.string().min(1),
  cdpUrl: z.string().min(1),
  sessionId: z.string().optional(),
  liveViewUrl: z.string().url().optional(),
});

async function closeQuietly(
  server: { close: () => Promise<void> },
  transport: { close: () => Promise<void> },
): Promise<void> {
  await transport.close().catch(() => {});
  await server.close().catch(() => {});
}

function exposedOption(config: ServerConfig): { exposed?: readonly string[] } {
  return config.allowCommands.length > 0
    ? { exposed: config.allowCommands }
    : {};
}

/** Constant-time-ish comparison, to keep token checks from leaking length. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let index = 0; index < a.length; index += 1) {
    mismatch |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return mismatch === 0;
}
