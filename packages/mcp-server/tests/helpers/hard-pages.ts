/**
 * Pages built from the parts of the web that break naive automation:
 * same-origin and cross-site iframes (the latter out-of-process), a nested
 * cross-site frame, open and closed shadow roots, and an iframe inside a shadow
 * root.
 *
 * The main page is served on 127.0.0.1 and the cross-site frames on localhost:
 * different sites, so Chrome's site isolation puts them in separate renderer
 * processes and CDP targets. Every control reports what happened to it to the
 * top page's #log, so a test can check where each action actually landed.
 */

import { createServer, type Server } from "node:http";

export interface HardPages {
  /** Top page URL. */
  url: string;
  close(): Promise<void>;
}

const REPORT = `<script>
  // Listen on the document and inside each shadow root: closed roots hide their
  // internals from document listeners, and change events do not cross roots.
  window.wireReports = (root) => {
    const report = (e, kind) => {
      const el = e.composedPath()[0];
      if (e.reported || !el.dataset || !el.dataset.id) return;
      e.reported = true;
      window.top.postMessage(kind + ":" + el.dataset.id + (kind === "change" ? "=" + el.value : ""), "*");
    };
    root.addEventListener("click", (e) => report(e, "click"), true);
    root.addEventListener("change", (e) => report(e, "change"), true);
  };
  wireReports(document);
  // A page global, visible only in the frame's main world.
  window.appName = location.pathname.slice(1) || "top";
</script>`;

function pages(cross: string): Record<string, string> {
  return {
    "/": `<!doctype html><title>Hard pages</title>
      <style>iframe { width: 420px; height: 180px; display: block; margin: 8px 0; }</style>
      <h1>Top</h1>
      <button data-id="top-button">Top button</button>
      <iframe id="same" title="Same-origin frame" src="/same"></iframe>
      <iframe id="cross" title="Cross-site frame" src="${cross}/cross"></iframe>
      <open-host></open-host>
      <closed-host></closed-host>
      <!-- Last, so new lines never shift the controls above. -->
      <div id="log"></div>
      ${REPORT}
      <script>
        window.addEventListener("message", (e) => {
          const line = document.createElement("div");
          line.textContent = e.data;
          document.getElementById("log").appendChild(line);
        });
        customElements.define("open-host", class extends HTMLElement {
          connectedCallback() {
            const root = this.attachShadow({ mode: "open" });
            wireReports(root);
            root.innerHTML = '<button data-id="open-button">Open shadow button</button>' +
              '<input data-id="open-input" id="shadow-field" aria-label="Open shadow input">' +
              '<iframe title="Frame in shadow root" src="/in-shadow" style="width:360px;height:80px"></iframe>';
          }
        });
        customElements.define("closed-host", class extends HTMLElement {
          connectedCallback() {
            const root = this.attachShadow({ mode: "closed" });
            wireReports(root);
            root.innerHTML = '<button data-id="closed-button">Closed shadow button</button>';
          }
        });
      </script>`,
    "/same": `<!doctype html><title>Same</title>
      <button data-id="same-button">Same-origin button</button>
      <select data-id="same-select" aria-label="Same-origin select">
        <option value="a">Alpha</option><option value="b">Beta</option>
      </select>
      <p id="same-text">Text inside the same-origin frame</p>
      ${REPORT}`,
    "/cross": `<!doctype html><title>Cross</title>
      <style>iframe { width: 360px; height: 70px; }</style>
      <button data-id="cross-button">Cross-site button</button>
      <input data-id="cross-input" aria-label="Cross-site input">
      <p id="cross-text">Text inside the cross-site frame</p>
      <iframe title="Nested cross-site frame" src="/nested"></iframe>
      ${REPORT}`,
    "/nested": `<!doctype html><title>Nested</title>
      <button data-id="nested-button">Nested frame button</button>
      ${REPORT}`,
    "/in-shadow": `<!doctype html><title>In shadow</title>
      <button data-id="shadow-frame-button">Button in shadow frame</button>
      ${REPORT}`,
  };
}

export async function serveHardPages(): Promise<HardPages> {
  let port = 0;
  const server: Server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://x").pathname;
    const body = pages(`http://localhost:${port}`)[path];
    response.writeHead(body ? 200 : 404, { "content-type": "text/html" });
    response.end(body ?? "not found");
  });
  // Listen on all loopback names so both 127.0.0.1 and localhost resolve.
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("Fixture server has no TCP port.");
  port = address.port;
  return {
    url: `http://127.0.0.1:${port}/`,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        // Browsers keep connections alive; don't wait for them to time out.
        server.closeAllConnections();
      }),
  };
}
