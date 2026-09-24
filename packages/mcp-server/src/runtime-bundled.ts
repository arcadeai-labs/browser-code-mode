import wasmBinary from "virtual:browse-wasm";
import variant from "@jitl/quickjs-wasmfile-release-sync";
import { newQuickJSWASMModuleFromVariant, newVariant } from "quickjs-emscripten-core";
import { createApp } from "./app.ts";
import { providerFromEnv } from "./browse/providers.ts";
import { loadConfig } from "./config.ts";
import { createProgramRunner } from "./sandbox/runner.ts";

const run = createProgramRunner(() =>
  newQuickJSWASMModuleFromVariant(
    newVariant(
      variant as unknown as Exclude<
        Awaited<Parameters<typeof newQuickJSWASMModuleFromVariant>[0]>,
        { default: unknown }
      >,
      { wasmBinary },
    ),
  ),
);

export function createConfiguredApp(env: Record<string, string | undefined>) {
  return createApp({ config: loadConfig(env), provider: providerFromEnv(env), run });
}
