import { createFileRoute } from "@tanstack/react-router";
import { mountedBrowserApp } from "../lib/browser-app.ts";

export const Route = createFileRoute("/api/browse/$")({
  server: { handlers: { ANY: ({ request }) => mountedBrowserApp(request) } },
});
