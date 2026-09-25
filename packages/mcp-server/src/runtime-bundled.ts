import wasmBinary from "virtual:browse-wasm";
import { newQuickJSWASMModuleFromVariant, newVariant } from "quickjs-emscripten-core";
import { createApp } from "./app.ts";
import { providerFromEnv } from "./browse/providers.ts";
import { loadConfig } from "./config.ts";
import { createProgramRunner } from "./sandbox/runner.ts";
import { quickjsVariant } from "./sandbox/variant.ts";

const run = createProgramRunner(() =>
  newQuickJSWASMModuleFromVariant(newVariant(quickjsVariant, { wasmBinary })),
);

export function createConfiguredApp(env: Record<string, string | undefined>) {
  return createApp({ config: loadConfig(env), provider: providerFromEnv(env), run });
}
