/** QuickJS/WASM sandbox shared by Node, Vercel and Cloudflare Workers.
 * Only JSON values cross the boundary; the guest has no host globals. */
import {
  newQuickJSWASMModuleFromVariant,
  type QuickJSWASMModule,
  type QuickJSHandle,
  type QuickJSDeferredPromise,
} from "quickjs-emscripten-core";
import variant from "@jitl/quickjs-wasmfile-release-sync";
import { transform } from "sucrase";
import type { CommandRunner } from "../browse/driver.ts";
import {
  createHostFunctions,
  type CommandCall,
} from "../browse/host-functions.ts";
export interface RunLimits {
  timeoutMs?: number;
  maxBridgeRequests?: number;
  maxResultBytes?: number;
  memoryLimitBytes?: number;
  maxInterrupts?: number;
}
export interface LogEntry {
  level: "info" | "warn" | "error";
  /** Arguments as the program passed them. */
  args: unknown[];
}

export interface ProgramError {
  name: string;
  message: string;
  code?: string;
}

export interface ProgramResult {
  status: "completed" | "failed" | "interrupted";
  /** The program's return value, present when it completed. */
  value?: unknown;
  error?: ProgramError;
  /**
   * The browser command that failed, when the program died on one. The bridge
   * masks host errors from guest code, so this is where the real
   * message lives.
   */
  failedCall?: CommandCall;
  /** Every browser command the program ran, in order. */
  calls: CommandCall[];
  logs: LogEntry[];
  durationMs: number;
}

export interface RunProgramOptions {
  code: string;
  /** An open browser connection. The caller owns connecting and closing it. */
  session: CommandRunner;
  limits?: RunLimits;
  signal?: AbortSignal;
  allow?: readonly string[];
  deny?: readonly string[];
  onCallStart?: (call: Pick<CommandCall, "index" | "cli">) => void;
  onCallEnd?: (call: CommandCall) => void;
  onLog?: (entry: LogEntry) => void;
}

export type LoadQuickJS = () => Promise<QuickJSWASMModule>;
const loadQuickJS: LoadQuickJS = () =>
  newQuickJSWASMModuleFromVariant(
    variant as unknown as Parameters<typeof newQuickJSWASMModuleFromVariant>[0],
  );

export const runProgram = (options: RunProgramOptions) =>
  createProgramRunner(loadQuickJS)(options);

export function createProgramRunner(load: LoadQuickJS) {
  return async (options: RunProgramOptions): Promise<ProgramResult> => {
    const startedAt = Date.now();
    const timeoutMs = options.limits?.timeoutMs ?? 120_000;
    const deadline = startedAt + timeoutMs;
    const maxBytes = options.limits?.maxResultBytes ?? 4 * 1024 * 1024;
    const maxCommands = options.limits?.maxBridgeRequests ?? 256;
    const logs: LogEntry[] = [];
    const controller = new AbortController();
    const signal = options.signal
      ? AbortSignal.any([options.signal, controller.signal])
      : controller.signal;
    const { hostFunctions, calls } = createHostFunctions({
      ...options,
      signal,
    });
    const module = await load();
    const runtime = module.newRuntime();
    runtime.setMemoryLimit(
      options.limits?.memoryLimitBytes ?? 32 * 1024 * 1024,
    );
    runtime.setMaxStackSize(512 * 1024);
    let interrupts = 0;
    let budgetExceeded = false;
    // Workers freezes Date.now() while JS runs. An instruction budget also
    // bounds synchronous loops there, without needing a worker thread.
    runtime.setInterruptHandler(() => {
      budgetExceeded = ++interrupts > (options.limits?.maxInterrupts ?? 10_000);
      return (
        budgetExceeded || Date.now() >= deadline || !!options.signal?.aborted
      );
    });
    const vm = runtime.newContext();
    let alive = true;
    let commands = 0;
    let logBytes = 0;
    const pending = new Set<Promise<void>>();
    const deferreds = new Set<QuickJSDeferredPromise>();
    const encode = (value: unknown) => {
      const json = JSON.stringify(value === undefined ? null : value);
      if (new TextEncoder().encode(json).byteLength > maxBytes)
        throw new Error("Result exceeds maxResultBytes.");
      return vm.newString(json);
    };
    const host = vm.newFunction(
      "__host",
      (groupHandle, fnHandle, argsHandle) => {
        const group = vm.getString(groupHandle);
        const fn = vm.getString(fnHandle);
        const functions = Object.hasOwn(hostFunctions, group)
          ? hostFunctions[group]
          : undefined;
        const callback =
          functions && Object.hasOwn(functions, fn) ? functions[fn] : undefined;
        if (!callback)
          return {
            error: vm.newError(`Unknown host function: ${group}.${fn}`),
          };
        if (++commands > maxCommands)
          return { error: vm.newError("Command budget exceeded.") };
        const args = JSON.parse(vm.getString(argsHandle)) as unknown[];
        const deferred = vm.newPromise();
        deferreds.add(deferred);
        const task = Promise.resolve()
          .then(() => {
            if (alive) return callback(...args);
          })
          .then(
            (value) => {
              if (!alive) return;
              const handle = encode(value);
              deferred.resolve(handle);
              handle.dispose();
            },
            () => {
              if (!alive) return;
              const error = vm.newError("Host function failed.");
              deferred.reject(error);
              error.dispose();
            },
          )
          .catch((error) => {
            if (!alive) return;
            const handle = vm.newError(
              error instanceof Error ? error.message : String(error),
            );
            deferred.reject(handle);
            handle.dispose();
          })
          .finally(() => {
            pending.delete(task);
            if (alive) {
              deferred.dispose();
              deferreds.delete(deferred);
            }
          });
        pending.add(task);
        return deferred.handle;
      },
    );
    const log = vm.newFunction("__log", (levelHandle, argsHandle) => {
      const json = vm.getString(argsHandle);
      logBytes += new TextEncoder().encode(json).byteLength;
      if (logBytes > maxBytes)
        return { error: vm.newError("Log output exceeds maxResultBytes.") };
      const entry = {
        level: vm.getString(levelHandle) as LogEntry["level"],
        args: JSON.parse(json) as unknown[],
      };
      logs.push(entry);
      options.onLog?.(entry);
    });
    vm.setProp(vm.global, "__host", host);
    vm.setProp(vm.global, "__log", log);
    host.dispose();
    log.dispose();
    let promise: QuickJSHandle | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort: (() => void) | undefined;
    try {
      options.signal?.throwIfAborted();
      const source = transform(
        `async function __program() {\n${options.code}\n}\n__program()`,
        { transforms: ["typescript"], filePath: "program.ts" },
      ).code;
      const setup = vm.evalCode(`
        for (const group of ["browse", "mouse", "tab"]) {
          globalThis[group] = new Proxy({}, { get(_, fn) {
            return async (...args) => JSON.parse(await __host(group, String(fn), JSON.stringify(args)));
          }});
        }
        globalThis.log = Object.fromEntries(["info", "warn", "error"].map(level => [level, (...args) => __log(level, JSON.stringify(args))]));
      `);
      vm.unwrapResult(setup).dispose();
      promise = vm.unwrapResult(vm.evalCode(source, "program.js"));
      const stopped = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              Object.assign(new Error("Program timed out."), {
                name: "RunTimeoutError",
              }),
            ),
          Math.max(1, deadline - Date.now()),
        );
        abort = () =>
          reject(options.signal?.reason ?? new Error("Program aborted."));
        options.signal?.addEventListener("abort", abort, { once: true });
      });
      while (true) {
        options.signal?.throwIfAborted();
        const jobs = runtime.executePendingJobs();
        if (jobs.error) {
          const detail = vm.dump(jobs.error);
          jobs.error.dispose();
          throw new Error(detail.message ?? "QuickJS job failed.");
        }
        const state = vm.getPromiseState(promise);
        if (state.type === "fulfilled") {
          const value = vm.dump(state.value);
          state.value.dispose();
          if (pending.size)
            throw new Error(
              "Program returned with unawaited browser commands.",
            );
          const check = encode(value);
          check.dispose();
          return {
            status: "completed",
            value,
            calls: calls.sort((a, b) => a.index - b.index),
            logs,
            durationMs: Date.now() - startedAt,
          };
        }
        if (state.type === "rejected") {
          const detail = vm.dump(state.error);
          state.error.dispose();
          throw Object.assign(new Error(detail.message ?? String(detail)), {
            name: detail.name ?? "Error",
          });
        }
        if (!pending.size)
          throw new Error("Program left an unresolved promise.");
        await Promise.race([stopped, ...pending]);
      }
    } catch (error) {
      const failedCall = calls.find((call) => !call.ok);
      const timedOut = budgetExceeded || Date.now() >= deadline;
      return {
        status: "failed",
        error: {
          name: timedOut
            ? "RunTimeoutError"
            : error instanceof Error
              ? error.name
              : "Error",
          message: timedOut
            ? "Program exceeded its time or instruction budget."
            : error instanceof Error
              ? error.message
              : String(error),
        },
        ...(failedCall ? { failedCall } : {}),
        calls: calls.sort((a, b) => a.index - b.index),
        logs,
        durationMs: Date.now() - startedAt,
      };
    } finally {
      alive = false;
      controller.abort();
      if (timer) clearTimeout(timer);
      if (abort) options.signal?.removeEventListener("abort", abort);
      promise?.dispose();
      for (const deferred of deferreds) deferred.dispose();
      vm.dispose();
      runtime.dispose();
    }
  };
}
