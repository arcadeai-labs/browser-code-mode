/**
 * A stand-in for a browser connection.
 *
 * The sandbox layer only needs `run(command, params)`, so tests exercise the
 * real command table, host functions, runner, and MCP plumbing without Chrome.
 */

import type { Connection } from "../../src/mcp/server.ts";

export interface RecordedCommand {
  command: string;
  params: Record<string, unknown>;
}

export type FakeHandler = (
  command: string,
  params: Record<string, unknown>,
) => unknown | Promise<unknown>;

export interface FakeBrowser extends Connection {
  commands: RecordedCommand[];
  closed: boolean;
}

/** Default handler: echo the command back, with a plausible shape for reads. */
export const echoHandler: FakeHandler = (command, params) => {
  if (command === "open") return { url: params.url, title: "Fake", pages: [] };
  if (command === "status") return { connected: true, cdpUrl: "ws://fake", pages: [] };
  if (command === "snapshot") return { tree: "[0-1] RootWebArea: Fake\n  [0-2] link: Example" };
  if (command === "get") return { [String(params.what)]: `fake-${String(params.what)}` };
  return { echo: command, params };
};

export function createFakeBrowser(handler: FakeHandler = echoHandler): FakeBrowser {
  const commands: RecordedCommand[] = [];
  const browser: FakeBrowser = {
    commands,
    closed: false,
    async run(command, params) {
      commands.push({ command, params });
      return handler(command, params);
    },
    async close() {
      browser.closed = true;
    },
  };
  return browser;
}
