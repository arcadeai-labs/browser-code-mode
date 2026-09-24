import { fetchBrowserApp } from "./browser-app.ts";
import { mcpHeaders } from "./env.ts";

/** Browser API calls are bounded; navigation/HMR cancellation is not a 500. */
export async function proxyBrowserRequest(
  request: Request,
  path: "/browser" | "/screen",
  dispatch = fetchBrowserApp,
): Promise<Response> {
  try {
    const body =
      path === "/screen" || request.method === "DELETE" ? await request.text() : undefined;
    const response = await dispatch(new URL(path, "http://browse.internal"), {
      method: request.method,
      headers: { ...mcpHeaders(), "content-type": "application/json" },
      ...(body === undefined ? {} : { body }),
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(35_000)]),
    });
    // These endpoints return bounded JSON or one image. Consume inside the
    // try block so cancellation while reading the body is handled too.
    const data = response.status === 204 ? null : await response.arrayBuffer();
    return new Response(data, {
      status: response.status,
      headers: {
        "content-type": response.headers.get("content-type") ?? "application/json",
        "cache-control": "no-store",
      },
    });
  } catch (error) {
    if (request.signal.aborted) return new Response(null, { status: 499 });
    const timedOut = error instanceof Error && error.name === "TimeoutError";
    return Response.json(
      {
        error: timedOut
          ? "The browser service took too long to respond. Try again."
          : "Cannot reach the browser service. Make sure pnpm dev is running, then try again.",
      },
      { status: timedOut ? 504 : 502 },
    );
  }
}
