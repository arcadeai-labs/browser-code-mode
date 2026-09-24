# browse code mode

An agent drives a real browser by writing TypeScript programs. The MCP server
exposes `browser_api` and `browser_run`; the web app adds chat and a browser preview.

```ts
await browse.open("https://example.com");
const { tree } = await browse.snapshot();
const { title } = await browse.get("title");
return { title, tree };
```

## Runtime and state

The production path runs entirely inside Cloudflare Workers or a Vercel Node
Function: Hono → MCP → QuickJS WebAssembly → direct Chrome DevTools Protocol.
There is no Stagehand, browser extension, Run SDK, Node worker thread, or separate
execution service. TypeScript is stripped with Sucrase before QuickJS evaluates it.

The browser itself runs locally or with a hosted provider. Tabs, cookies, and
page state live there. Every program opens and closes its own CDP connection.
Snapshot refs are local to a program and are cleared on navigation/tab changes.
Take the snapshot in the program that uses its refs. Drive a given browser
sequentially across programs; there is no distributed execution lock.

There are no server-side browser/session registries or preview connection caches.
The UI retains its serializable browser handle in tab-local sessionStorage.
Refreshes and requests routed to different server instances can reuse that handle.

QuickJS exposes only browser commands and logging. Programs have wall-clock,
instruction, memory, command-count, and output budgets. The instruction budget
also stops tight loops in Workers, where the clock does not advance during
synchronous JavaScript. Programs that fail are never automatically replayed.

## Local development

Requires Node 22.13+ and Chrome/Chromium.

```sh
pnpm install
# Put ANTHROPIC_API_KEY in the workspace .env for chat.
pnpm dev
```

`pnpm dev` starts local Chrome and TanStack Start, which mounts the Hono app at
`/api/browse/*` (MCP: `/api/browse/mcp`). There is no separate API listener.
Chat invokes the same Hono app in-process. Click **Start browser**
to attach the UI. Ctrl-C/SIGTERM stops the processes it started and removes its
temporary Chrome profile. An existing CDP browser is borrowed and left running.

```sh
pnpm cli dev       # local Chrome + MCP, no web app
pnpm dev:server    # same server-only dev lifecycle
pnpm dev:web       # web app alone
pnpm chrome        # Chrome alone
pnpm cli serve     # production-style Node listener, no browser launch
```

The built CLI also supports `browse-code-mode dev` and `browse-code-mode serve`.

Overrides: `CHROME_PATH`, `CHROME_PORT`, `CHROME_HEADLESS=0`,
`CHROME_USER_DATA_DIR`, `PORT`, `HOST`, `WEB_PORT`, and `NO_OPEN=1`.
User-supplied profile directories are never deleted. Dev commands always use
local Chrome regardless of the configured production provider.
Only the Node dev lifecycle imports child_process and filesystem APIs.

## In-process tools

`packages/tools` hands the same `browser_run` and `browser_api` to agent
frameworks without an MCP hop. Descriptions, sandbox, and result text come from
`packages/mcp-server/src/core.ts`, which the MCP server registers too.

Pass a `Browser` and the model also manages its own sessions. Each method backs
one tool:

```ts
interface Browser {
  start(options?: { signal?: AbortSignal }): Promise<BrowserSession>; // browser_start
  stop(sessionId: string): Promise<void>;                             // browser_stop
  listSessions(): Promise<BrowserSession[]>;                          // browser_list_sessions
  liveView(sessionId: string): Promise<LiveView>;                     // browser_live_view
}
```

`browser_run` then takes a `sessionId` instead of a `cdpUrl`, so CDP credentials
never reach the model. `browser_live_view` returns a screenshot of the current
page, plus the provider's live view URL when it has one (Kernel does).
Implement `Browser` yourself, or adapt any `BrowserProvider` with
`providerBrowser`:

```ts
import { browserTools, instructions } from "@browse-code-mode/tools/ai-sdk"; // or /mastra
import { createBrowserToolkit, providerBrowser } from "@browse-code-mode/tools"; // framework-free
import { localProvider } from "@browse-code-mode/mcp-server/local-browser";

const browser = providerBrowser(localProvider()); // or providerFromEnv(process.env) for hosted
const tools = browserTools({ browser }); // or browserTools({ cdpUrl }) for one fixed browser
// ...
await browser.close(); // stops every session still open
```

`localProvider` launches Chrome (or borrows one on `CHROME_PORT`). It is
Node-only, so it lives beside the dev lifecycle in
`packages/mcp-server/src/node/local-browser.ts`.

`examples/` shows them in use:

```sh
pnpm example                  # 01-hello-world: AI SDK generateText answers by browsing
pnpm example 02-mcp-server    # the tools on your own Streamable HTTP MCP server
pnpm example 01-hello-world "What's on the front page of Hacker News?"
```

## Browser lifecycle

A provider implements two methods in `packages/mcp-server/src/browse/provider.ts`:

```ts
interface BrowserHandle {
  provider: string;
  cdpUrl: string;
  sessionId?: string;
  liveViewUrl?: string;
}

interface BrowserProvider {
  readonly name: string;
  create(options?: { signal?: AbortSignal }): Promise<BrowserHandle>;
  shutdown(browser: BrowserHandle): Promise<void>;
}
```

The handle contains data, not a cleanup closure. Shutdown can run on a fresh
instance and must be idempotent. Treat handles/CDP URLs as credentials.

| Request | Behavior |
| --- | --- |
| `POST /browser` | Create a browser; return its handle |
| `DELETE /browser` with handle JSON | Shut down the provider session |
| `GET /browser?cdpUrl=...` | Inspect tabs via CDP |
| `POST /screen` with `{ cdpUrl }` | Capture one JPEG, then disconnect |
| `POST /mcp` | Stateless MCP transport |
| `GET /api.d.ts`, `GET /api.md` | Browser program reference |

Pass the handle's `cdpUrl` to every `browser_run` to reuse a browser. Alternatively
set the MCP request header `x-browse-cdp-url`; the web app does this so the model
does not select a browser. Explicitly created browsers remain alive until shutdown
or provider expiry. The UI's **Stop browser** button calls shutdown; closing the tab
does not guarantee cleanup, so provider-side expiry is essential.

If `browser_run` has no endpoint, it creates a temporary browser using the
configured provider and shuts it down in `finally`, including on connection or
program failure. The `cdp` provider borrows `BROWSE_CDP_URL`, so shutdown is a no-op.

### Included providers

Set `BROWSE_PROVIDER` to:

- `cdp` (default): requires `BROWSE_CDP_URL`.
- `browserbase`: requires `BROWSERBASE_API_KEY`; optional `BROWSERBASE_PROJECT_ID`.
- `kernel`: requires `KERNEL_API_KEY`.

`BROWSER_TIMEOUT_SECONDS` defaults to 600. Browserbase uses an absolute session
timeout and keepAlive so connections can detach between programs; the provider
plan must support keepAlive. Kernel uses an inactivity timeout.

Adapters use fetch against the documented
[Browserbase session API](https://docs.browserbase.com/reference/api/create-a-session)
and [Kernel browser API](https://github.com/kernel/kernel-node-sdk/blob/main/src/resources/browsers/browsers.ts).
They are covered by mocked HTTP contract tests; live provider accounts were not
used during validation.

To add another provider, pass it to `createApp({ config, provider })` in the
deployment entry point, or add it to `providerFromEnv`. The `browserProvider`
helper wraps create/shutdown callbacks. No command or sandbox changes are needed.

## Deployment

### Cloudflare Workers

The MCP Worker imports the precompiled QuickJS WASM module and uses Workers'
fetch/WebSocket upgrade API. It does not connect to a Node execution backend.
TanStack Start mounts this app in the same Worker; no second deployment is needed.

```sh
pnpm --filter @browse-code-mode/mcp-server types:worker
pnpm --filter @browse-code-mode/mcp-server check:worker
pnpm --filter @browse-code-mode/web build:cloudflare
```

Configure `BROWSE_PROVIDER`, provider credentials, `MCP_AUTH_TOKEN`, and
`ANTHROPIC_API_KEY` on the web Worker, and deploy from `apps/web` after its
Cloudflare build. The standalone MCP Worker remains available for CLI-only clients.
Use a hosted/publicly reachable CDP browser in production; localhost is only for dev.

### Vercel

Create one project with root directory `apps/web` and workspace files available.
The web package uses TanStack Start + Nitro's Vercel output, with the Node
QuickJS WASM bytes embedded in its server bundle:

```sh
pnpm --filter @browse-code-mode/web build:vercel
```

Set provider/auth variables and `ANTHROPIC_API_KEY` on that project.
MCP clients connect to `/api/browse/mcp`. Function duration must accommodate browser work.
Neither deployment starts Chrome. No production deployment is performed by builds.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` / `HOST` | 8787 / 127.0.0.1 | Node listener only |
| `MCP_ENDPOINT` | /mcp | MCP path |
| `BROWSE_PROVIDER` | cdp | Browser lifecycle adapter |
| `BROWSE_CDP_URL` | none | Externally managed CDP endpoint |
| `SANDBOX_TIMEOUT_MS` | 120000 | Program wall-clock budget |
| `SANDBOX_MAX_COMMANDS` | 256 | Host command budget |
| `SANDBOX_MAX_RESULT_BYTES` | 4194304 | Output cap |
| `BROWSE_ALLOW_COMMANDS` / `BROWSE_DENY_COMMANDS` | all / none | Command access |
| `MCP_AUTH_TOKEN` | none | Bearer authentication for all MCP app routes |
| `MCP_ALLOWED_ORIGINS` | none | Optional Origin allowlist |
| `ANTHROPIC_API_KEY` | none | Web chat credential |
| `ANTHROPIC_MODEL` | claude-opus-5 | Chat model |

## Command compatibility and boundaries

The command table remains the source of truth; call `browser_api` for signatures.
Snapshots use Chrome's accessibility tree, with refs mapped to backend DOM nodes
(the legacy `xpathMap` field contains these selectors). CSS and XPath also work.

Snapshots cover every frame. Same-process iframes and cross-site (out-of-process)
iframes, nested at any depth, are attached over CDP and spliced in under their
`Iframe` line. A ref is `<frame>-<node>`: `0` is the top page, and iframes are
numbered in document order. Shadow DOM content, including closed roots, appears
in the tree, and refs act on it directly. CSS selectors pierce open shadow roots,
and `>>` enters an iframe by selector (`iframe#checkout >> input[name=card]`).
Clicks translate frame coordinates to the top page and wait for the element to
hold still across a drawn frame, because Chrome routes input between frames using
the last drawn layout. `get box` returns top-page coordinates, so `mouse.click`
works on elements inside frames. `eval(expression, { frame })` runs in a frame's
own main world (its page globals included), with the frame named by snapshot
index (`"2"`), the iframe's ref, or an iframe selector.

Screenshots return base64; writing screenshot paths on the application server is
not supported. Upload paths refer to files on the **browser host**, never the
Worker/function filesystem. Hosted files must be staged with the provider first.

The preview uses a provider live-view URL when available, otherwise request-scoped
screenshots at roughly one per second. It no longer requires a persistent
screencast process. A failed command's real error is in `failedCall`; `log.info`
collects intermediate output.

The sandbox isolates the application host, not websites. Browser commands have
the browser's network access and cookies. Protect the web UI with your platform's
access controls before exposing its server-side MCP credentials to other users.
MCP bearer authentication protects the backend; it is not web-user authentication.

## Validation

```sh
pnpm check
pnpm test
pnpm build
pnpm --filter @browse-code-mode/mcp-server test:runtime
pnpm --filter @browse-code-mode/mcp-server test:worker
pnpm test:e2e  # existing browser on BROWSE_CDP_URL or port 9222
```

The runtime suites start an isolated Chrome and exercise real MCP execution,
TypeScript, snapshot-ref clicks, loop interruption, screenshots, and lifecycle
cleanup against Node and local workerd. They shut down their test processes.
