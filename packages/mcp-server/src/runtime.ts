import { createApp } from "./app.ts";
import { providerFromEnv } from "./browse/providers.ts";
import { loadConfig } from "./config.ts";

export function createConfiguredApp(env: Record<string, string | undefined>) {
  return createApp({ config: loadConfig(env), provider: providerFromEnv(env) });
}
