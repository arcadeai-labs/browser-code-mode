/** Web-standard CDP transport. Cloudflare supplies a fetch-upgrade socket factory. */
export type OpenSocket = (url: string, signal?: AbortSignal) => Promise<WebSocket>;

export const openWebSocket: OpenSocket = (url, signal) =>
  new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const socket = new WebSocket(url);
    const timer = setTimeout(() => fail(new Error("CDP connection timed out.")), 10_000);
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    };
    const fail = (error: unknown) => {
      cleanup();
      socket.close();
      reject(error);
    };
    const abort = () => fail(signal?.reason ?? new Error("Aborted"));
    signal?.addEventListener("abort", abort, { once: true });
    socket.addEventListener(
      "open",
      () => {
        cleanup();
        resolve(socket);
      },
      { once: true },
    );
    socket.addEventListener("error", () => fail(new Error("CDP WebSocket connection failed.")), {
      once: true,
    });
  });

type Pending = {
  resolve(value: any): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
};

export class CdpConnection {
  private socket: WebSocket;
  private pending = new Map<number, Pending>();
  private nextId = 0;
  private signal: AbortSignal | undefined;
  private listeners = new Set<(method: string, params: any, sessionId?: string) => void>();
  private abort = () => this.close();
  constructor(socket: WebSocket, signal?: AbortSignal) {
    this.socket = socket;
    this.signal = signal;
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (message.method) {
        for (const listener of this.listeners)
          listener(message.method, message.params, message.sessionId);
        return;
      }
      const call = this.pending.get(message.id);
      if (!call) return;
      clearTimeout(call.timer);
      this.pending.delete(message.id);
      if (message.error) call.reject(new Error(message.error.message));
      else call.resolve(message.result);
    });
    socket.addEventListener("close", this.abort);
    socket.addEventListener("error", this.abort);
    signal?.addEventListener("abort", this.abort, { once: true });
    if (signal?.aborted) this.close();
  }

  onEvent(listener: (method: string, params: any, sessionId?: string) => void) {
    this.listeners.add(listener);
  }

  send<T = any>(method: string, params: object = {}, sessionId?: string): Promise<T> {
    this.signal?.throwIfAborted();
    if (this.socket.readyState !== 1) return Promise.reject(new Error("CDP connection is closed."));
    return new Promise<T>((resolve, reject) => {
      const id = ++this.nextId;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} timed out.`));
      }, 30_000);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.socket.send(
          JSON.stringify({
            id,
            method,
            params,
            ...(sessionId ? { sessionId } : {}),
          }),
        );
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  close(): void {
    this.signal?.removeEventListener("abort", this.abort);
    for (const call of this.pending.values()) {
      clearTimeout(call.timer);
      call.reject(new Error("CDP connection closed."));
    }
    this.pending.clear();
    this.listeners.clear();
    if (this.socket.readyState < 2) this.socket.close();
  }
}
