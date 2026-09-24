import {
  newVariant,
  newQuickJSWASMModuleFromVariant,
} from "quickjs-emscripten-core";
import { quickjsVariant } from "./sandbox/variant.ts";
import wasmModule from "../node_modules/@jitl/quickjs-wasmfile-release-sync/dist/emscripten-module.wasm";
import { createApp } from "./app.ts";
import { loadConfig } from "./config.ts";
import { BrowserSession } from "./browse/driver.ts";
import { createProgramRunner } from "./sandbox/runner.ts";
import type { OpenSocket } from "./browse/transport.ts";
import { providerFromEnv } from "./browse/providers.ts";

const run = createProgramRunner(() =>
  newQuickJSWASMModuleFromVariant(
    newVariant(
      quickjsVariant,
      { wasmModule },
    ),
  ),
);

const openSocket: OpenSocket = async (url, signal) => {
  const response = await fetch(url.replace(/^ws/, "http"), {
    headers: { Upgrade: "websocket" },
    ...(signal ? { signal } : {}),
  });
  const socket = response.webSocket;
  if (!socket) throw new Error(`CDP upgrade failed: ${response.status}`);
  socket.accept();
  return socket;
};

export function createConfiguredApp(env: Record<string, string | undefined>) {
    return createApp({
      config: loadConfig({ ...env }),
      run,
      provider: providerFromEnv({ ...env }),
      connect: (options) => BrowserSession.connect({ ...options, openSocket }),
    });
}

export default {
  fetch(request, env) {
    return createConfiguredApp({ ...env }).fetch(request);
  },
} satisfies ExportedHandler<Env>;
