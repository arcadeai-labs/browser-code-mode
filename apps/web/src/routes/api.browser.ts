import { createFileRoute } from "@tanstack/react-router";
import { proxyBrowserRequest } from "../lib/browser-api.ts";

export const Route = createFileRoute("/api/browser")({
  server: {
    handlers: {
      POST: async ({ request }) => proxyBrowserRequest(request, "/browser"),
      DELETE: async ({ request }) => proxyBrowserRequest(request, "/browser"),
    },
  },
});
