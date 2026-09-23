import { createFileRoute } from "@tanstack/react-router";
import { proxyBrowserRequest } from "../lib/browser-api.ts";

export const Route = createFileRoute("/api/screen")({
  server: {
    handlers: {
      POST: async ({ request }) => proxyBrowserRequest(request, "/screen"),
    },
  },
});
