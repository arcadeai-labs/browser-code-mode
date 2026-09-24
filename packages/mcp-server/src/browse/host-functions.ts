/**
 * QuickJS host functions for the `browse` command surface.
 *
 * The sandbox gets one global per command group (`browse`, `mouse`, `tab`,
 * `network`) with one function per CLI command. Nothing else crosses the
 * boundary: no filesystem, no network, no env, no Node. A program's only
 * capability is the browser, through these functions.
 */

type HostFunctions = Record<string, Record<string, (...args: unknown[]) => Promise<unknown>>>;

import {
  buildParams,
  COMMANDS,
  type CommandSpec,
  commandGroups,
  type GroupName,
} from "./commands.ts";
import type { CommandRunner } from "./driver.ts";

/** One executed command, recorded for tracing and streamed to the client. */
export interface CommandCall {
  /** One-based call order within the program. */
  index: number;
  /** Equivalent shell command, for logs. */
  cli: string;
  group: GroupName;
  fn: string;
  wire: string;
  params: Record<string, unknown>;
  durationMs: number;
  ok: boolean;
  error?: string;
}

export interface HostFunctionOptions {
  /** The browser connection this program runs against. */
  session: CommandRunner;
  signal?: AbortSignal;
  /** Commands the sandbox may call, as `group.fn`. Defaults to all. */
  allow?: readonly string[];
  /** Commands the sandbox may not call, as `group.fn`. Applied after `allow`. */
  deny?: readonly string[];
  /** Called before a command runs. */
  onCallStart?: (call: Pick<CommandCall, "index" | "cli">) => void;
  /** Called after a command settles. */
  onCallEnd?: (call: CommandCall) => void;
}

export interface HostFunctionBundle {
  hostFunctions: HostFunctions;
  /** Commands executed so far, in order. Mutated as the program runs. */
  calls: CommandCall[];
  /** `group.fn` names actually exposed to the sandbox. */
  exposed: string[];
}

export function createHostFunctions(options: HostFunctionOptions): HostFunctionBundle {
  const calls: CommandCall[] = [];
  const exposed: string[] = [];
  const hostFunctions: HostFunctions = {};
  // Counter rather than `calls.length`: `Promise.all` starts several commands
  // before any of them finishes and pushes.
  const counter = { next: 0 };

  for (const group of commandGroups()) {
    hostFunctions[group] = {};
  }

  for (const spec of COMMANDS) {
    const key = `${spec.group}.${spec.fn}`;
    if (!isPermitted(key, options)) continue;
    exposed.push(key);
    const group = hostFunctions[spec.group] ?? {};
    hostFunctions[spec.group] = group;
    group[spec.fn] = (...args: unknown[]) => invoke(spec, args, calls, counter, options);
  }

  return { hostFunctions, calls, exposed };
}

async function invoke(
  spec: CommandSpec,
  args: unknown[],
  calls: CommandCall[],
  counter: { next: number },
  options: HostFunctionOptions,
): Promise<unknown> {
  counter.next += 1;
  const index = counter.next;

  const record = (
    cli: string,
    params: Record<string, unknown>,
    startedAt: number,
    error?: unknown,
  ): void => {
    const call: CommandCall = {
      index,
      cli,
      group: spec.group,
      fn: spec.fn,
      wire: spec.wire,
      params,
      durationMs: Date.now() - startedAt,
      ok: error === undefined,
      ...(error === undefined
        ? {}
        : { error: error instanceof Error ? error.message : String(error) }),
    };
    calls.push(call);
    options.onCallEnd?.(call);
  };

  // Argument errors are recorded as failed commands too. The sandbox masks
  // every host error as "Host function failed.", so the trace is the only place
  // an agent can learn that it called `browse.click()` with no target.
  const startedAt = Date.now();
  let params: Record<string, unknown>;
  try {
    params = buildParams(spec, args);
  } catch (error) {
    record(`${spec.group}.${spec.fn}(…)`, {}, startedAt, error);
    throw error;
  }

  const cli = formatCall(spec, params);
  options.onCallStart?.({ index, cli });

  try {
    options.signal?.throwIfAborted();
    const result = await options.session.run(spec.wire, params);
    record(cli, params, startedAt);
    return result;
  } catch (error) {
    record(cli, params, startedAt, error);
    throw error;
  }
}

function isPermitted(key: string, options: HostFunctionOptions): boolean {
  if (options.allow && !options.allow.includes(key)) return false;
  if (options.deny?.includes(key)) return false;
  return true;
}

/**
 * Render a call as the shell command it stands for, so a program's trace reads
 * like the `browse` invocations an agent would otherwise have typed.
 */
export function formatCall(spec: CommandSpec, params: Record<string, unknown>): string {
  const words = cliWords(spec.cli);
  const positional = (spec.args ?? [])
    .map((arg) => params[arg.param ?? arg.name])
    .filter((value) => value !== undefined)
    .map(quote);
  const optionNames = new Set((spec.options ?? []).map((option) => option.name));
  const flags = Object.entries(params)
    .filter(([key]) => optionNames.has(key))
    .map(([key, value]) =>
      value === true ? `--${kebab(key)}` : `--${kebab(key)} ${quote(value)}`,
    );
  return [...words, ...positional, ...flags].join(" ");
}

function cliWords(cli: string): string[] {
  const words: string[] = [];
  for (const token of cli.split(/\s+/)) {
    if (token.startsWith("<") || token.startsWith("[")) break;
    words.push(token);
  }
  return words;
}

function quote(value: unknown): string {
  if (Array.isArray(value)) return value.map(quote).join(" ");
  if (typeof value !== "string") return JSON.stringify(value) ?? String(value);
  const truncated = value.length > 120 ? `${value.slice(0, 117)}...` : value;
  return /[\s"'`$]/.test(truncated) ? JSON.stringify(truncated) : truncated;
}

function kebab(value: string): string {
  return value.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}
