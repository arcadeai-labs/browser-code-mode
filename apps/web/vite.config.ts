import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react from "@vitejs/plugin-react";
import { nitro } from "nitro/vite";
import { defineConfig, loadEnv } from "vite";

const workspaceRoot = fileURLToPath(new URL("../..", import.meta.url));

export default defineConfig(({ mode, command }) => {
  // Server routes read `process.env`, but Vite only ever populates
  // `import.meta.env`, and only for VITE_-prefixed keys. Load the workspace
  // `.env` into the dev/SSR process so ANTHROPIC_API_KEY is available there.
  // Real environment variables still win, which is what production relies on.
  for (const [key, value] of Object.entries(loadEnv(mode, workspaceRoot, ""))) {
    process.env[key] ??= value;
  }

  return {
    resolve: {
      alias: [
        {
          find: "@browse-code-mode/mcp-server/runtime",
          replacement:
            mode === "cloudflare"
              ? "@browse-code-mode/mcp-server/worker-runtime"
              : "@browse-code-mode/mcp-server/bundled-runtime",
        },
      ],
    },
    server: { port: 3000, strictPort: true },
    plugins: [
      {
        name: "browse-node-wasm",
        resolveId(id) {
          if (id === "virtual:browse-wasm") return "\0browse-wasm";
        },
        load(id) {
          if (id !== "\0browse-wasm") return;
          const binary = readFileSync(
            new URL(
              "../../packages/mcp-server/node_modules/@jitl/quickjs-wasmfile-release-sync/dist/emscripten-module.wasm",
              import.meta.url,
            ),
          );
          return `export default Uint8Array.from(atob(${JSON.stringify(binary.toString("base64"))}), c => c.charCodeAt(0)).buffer;`;
        },
      },
      tailwindcss(),
      ...(mode === "cloudflare" ? [cloudflare({ viteEnvironment: { name: "ssr" } })] : []),
      tanstackStart(),
      ...(mode === "cloudflare" || command !== "build"
        ? []
        : [nitro({ ...(mode === "vercel" ? { preset: "vercel" } : {}) })]),
      react(),
    ],
  };
});
