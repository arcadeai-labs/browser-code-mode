import { newVariant, newQuickJSWASMModuleFromVariant } from "quickjs-emscripten-core";
import variant from "@jitl/quickjs-wasmfile-release-sync";
import wasmBinary from "virtual:browse-wasm";
import { createApp } from "./app.ts";
import { loadConfig } from "./config.ts";
import { providerFromEnv } from "./browse/providers.ts";
import { createProgramRunner } from "./sandbox/runner.ts";

const run = createProgramRunner(() => newQuickJSWASMModuleFromVariant(newVariant(
  variant as unknown as Exclude<Awaited<Parameters<typeof newQuickJSWASMModuleFromVariant>[0]>, { default: unknown }>,
  { wasmBinary },
)));

export function createConfiguredApp(env: Record<string, string | undefined>) {
  return createApp({ config: loadConfig(env), provider: providerFromEnv(env), run });
}
