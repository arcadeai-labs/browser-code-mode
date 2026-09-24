import { Hono } from "hono";
import { handle } from "hono/vercel";
import { createApp } from "../src/app.ts";
import { providerFromEnv } from "../src/browse/providers.ts";
import { loadConfig } from "../src/config.ts";

const app = createApp({ config: loadConfig(process.env), provider: providerFromEnv(process.env) });
const router = new Hono();
router.all("*", (c) => app.fetch(c.req.raw));
export default handle(router);
