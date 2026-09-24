import { newVariant, newQuickJSWASMModuleFromVariant } from "quickjs-emscripten-core";
import { quickjsVariant } from "./sandbox/variant.ts";
import wasmBinary from "virtual:browse-wasm";
import { createApp } from "./app.ts";
import { loadConfig } from "./config.ts";
import { providerFromEnv } from "./browse/providers.ts";
import { createProgramRunner } from "./sandbox/runner.ts";

const run = createProgramRunner(() => newQuickJSWASMModuleFromVariant(newVariant(
  quickjsVariant,
  { wasmBinary },
)));

export function createConfiguredApp(env: Record<string, string | undefined>) {
  return createApp({ config: loadConfig(env), provider: providerFromEnv(env), run });
}
