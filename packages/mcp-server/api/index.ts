import { handle } from "hono/vercel";
import { Hono } from "hono";
import { createApp } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { providerFromEnv } from "../src/browse/providers.ts";

const app = createApp({ config: loadConfig(process.env), provider: providerFromEnv(process.env) });
const router = new Hono();
router.all("*", (c) => app.fetch(c.req.raw));
export default handle(router);
