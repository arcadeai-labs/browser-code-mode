/**
 * Server configuration, read once from the environment.
 *
 * There is no browser lifecycle here: the server attaches to a CDP endpoint the
 * caller already runs. `BROWSE_CDP_URL` is only a default for clients that do
 * not name one per request.
 */

import type { RunLimits } from "./sandbox/runner.ts";

export interface ServerConfig {
  host: string;
  port: number;
  /** MCP endpoint path. */
  endpoint: string;
  /** Default CDP endpoint (port, http origin, or ws URL). May be undefined. */
  defaultCdpUrl: string | undefined;
  limits: RunLimits;
  /** Commands the sandbox may call, as `group.fn`. Empty means all. */
  allowCommands: string[];
  /** Commands the sandbox may not call, as `group.fn`. */
  denyCommands: string[];
  /** Bearer token required on every request, when set. */
  authToken: string | undefined;
  /** Allowed `Origin` values. Empty disables origin checking. */
  allowedOrigins: string[];
}

const DEFAULTS = {
  host: "127.0.0.1",
  port: 8787,
  endpoint: "/mcp",
  /**
   * Browser work is slow relative to computation, and a cold `open` can take a
   * while on its own, so a short default would abort healthy programs.
   */
  timeoutMs: 120_000,
  /** Browser commands per program, via the sandbox's bridge-request budget. */
  maxCommands: 256,
  /** Accessibility trees and markdown extracts are large; 1MB is tight. */
  maxResultBytes: 4 * 1024 * 1024,
} as const;

export function loadConfig(env: Record<string, string | undefined> = {}): ServerConfig {
  return {
    host: env.HOST ?? DEFAULTS.host,
    port: integer(env.PORT, DEFAULTS.port),
    endpoint: env.MCP_ENDPOINT ?? DEFAULTS.endpoint,
    defaultCdpUrl: env.BROWSE_CDP_URL || undefined,
    limits: {
      timeoutMs: integer(env.SANDBOX_TIMEOUT_MS, DEFAULTS.timeoutMs),
      maxBridgeRequests: integer(env.SANDBOX_MAX_COMMANDS, DEFAULTS.maxCommands),
      maxResultBytes: integer(env.SANDBOX_MAX_RESULT_BYTES, DEFAULTS.maxResultBytes),
    },
    allowCommands: list(env.BROWSE_ALLOW_COMMANDS),
    denyCommands: list(env.BROWSE_DENY_COMMANDS),
    authToken: env.MCP_AUTH_TOKEN || undefined,
    allowedOrigins: list(env.MCP_ALLOWED_ORIGINS),
  };
}

function integer(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Expected a positive integer, got "${value}".`);
  }
  return parsed;
}

function list(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}
