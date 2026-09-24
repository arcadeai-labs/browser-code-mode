import { useChat } from "@ai-sdk/react";
import { createFileRoute } from "@tanstack/react-router";
import { DefaultChatTransport, type UIMessage } from "ai";
import { useEffect, useRef, useState } from "react";
import { Streamdown } from "streamdown";

import "streamdown/styles.css";

export const Route = createFileRoute("/")({ component: Home });

interface BrowserHandle {
  provider: string;
  cdpUrl: string;
  sessionId?: string;
  liveViewUrl?: string;
}

async function responseError(response: Response): Promise<string> {
  const body = (await response.json().catch(() => null)) as { error?: string } | null;
  return body?.error ?? `Browser request failed (HTTP ${response.status}).`;
}

function Home() {
  const [browser, setBrowser] = useState<BrowserHandle | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => {
    try {
      const saved = sessionStorage.getItem("browse.browser");
      if (saved) setBrowser(JSON.parse(saved));
    } catch {
      sessionStorage.removeItem("browse.browser");
    }
  }, []);
  const lifecycle = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const response = await fetch("/api/browser", {
        method: browser ? "DELETE" : "POST",
        headers: { "content-type": "application/json" },
        ...(browser ? { body: JSON.stringify(browser) } : {}),
      });
      if (!response.ok) throw new Error(await responseError(response));
      const next: BrowserHandle | null = browser ? null : await response.json();
      setBrowser(next);
      try {
        if (next) sessionStorage.setItem("browse.browser", JSON.stringify(next));
        else sessionStorage.removeItem("browse.browser");
      } catch {
        /* A blocked storage API must not prevent using the browser. */
      }
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="split">
      <div className="viewport" style={{ display: "flex", flexDirection: "column" }}>
        <div style={{ padding: 12 }}>
          <button onClick={() => void lifecycle()} disabled={busy}>
            {busy ? "Working…" : browser ? "Stop browser" : "Start browser"}
          </button>
          {browser ? (
            <span role="status" style={{ marginLeft: 12 }}>
              Browser connected
            </span>
          ) : null}
          {error ? (
            <div className="error" role="alert">
              {error}
            </div>
          ) : null}
        </div>
        {browser ? (
          <LiveView browser={browser} />
        ) : (
          <div className="viewport-empty" style={{ position: "static", flex: 1 }}>
            Start a browser to begin.
          </div>
        )}
      </div>
      {browser ? <Chat key={browser.cdpUrl} cdpUrl={browser.cdpUrl} /> : <div className="chat" />}
    </div>
  );
}

/**
 * Left pane: the page itself, streamed from CDP as JPEG frames.
 *
 * Deliberately not Chrome's DevTools frontend in an iframe — that renders the
 * whole inspector, which is not what "watch the browser" means.
 *
 * Frames are fetched as blobs and swapped only once decoded. Pointing an <img>
 * at a changing URL instead blanks it on every request, which reads as a
 * flickering black pane.
 */
function LiveView({ browser }: { browser: BrowserHandle }) {
  const [src, setSrc] = useState<string | null>(null);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (browser.liveViewUrl) return;
    let stopped = false;
    const controller = new AbortController();
    let currentUrl: string | null = null;

    const poll = async (): Promise<void> => {
      while (!stopped) {
        try {
          const response = await fetch("/api/screen", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ cdpUrl: browser.cdpUrl }),
            cache: "no-store",
            signal: controller.signal,
          });
          if (response.status === 200) {
            const blob = await response.blob();
            if (stopped) return;
            const next = URL.createObjectURL(blob);
            setSrc(next);
            if (currentUrl) URL.revokeObjectURL(currentUrl);
            currentUrl = next;
            setError(undefined);
          } else if (response.status !== 204) {
            throw new Error(await responseError(response));
          }
        } catch (error) {
          if (stopped) return;
          setError(error instanceof Error ? error.message : "Could not load the browser preview.");
        }
        await new Promise((resolve) => setTimeout(resolve, 750));
      }
    };

    void poll();
    return () => {
      stopped = true;
      controller.abort();
      if (currentUrl) URL.revokeObjectURL(currentUrl);
    };
  }, [browser.cdpUrl, browser.liveViewUrl]);

  if (browser.liveViewUrl)
    return (
      <iframe
        className="frame"
        src={browser.liveViewUrl}
        title="Browser live view"
        style={{ width: "100%", height: "100%", border: 0 }}
      />
    );

  return (
    <div className="viewport" style={{ flex: 1, minHeight: 0, width: "100%" }}>
      {src ? (
        <img className="frame" src={src} alt="" />
      ) : (
        <div className="viewport-empty">
          {error ? "Browser preview unavailable" : "Waiting for the browser…"}
        </div>
      )}
      {error ? (
        <div
          className="error"
          role="alert"
          style={{ position: "absolute", bottom: 16, left: 16, right: 16 }}
        >
          {error} Retrying…
        </div>
      ) : null}
    </div>
  );
}

/** Right pane: the conversation, with each program and its output inline. */
function Chat({ cdpUrl }: { cdpUrl: string }) {
  const { messages, sendMessage, status, error } = useChat({
    transport: new DefaultChatTransport({ api: "/api/chat", body: { cdpUrl } }),
  });
  const [input, setInput] = useState("");
  const listRef = useRef<HTMLDivElement>(null);
  const busy = status === "submitted" || status === "streaming";

  // Scroll the list itself. `scrollIntoView` walks up the ancestor chain and
  // will scroll the document too, which drags the whole two-pane layout.
  useEffect(() => {
    const list = listRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [messages, status]);

  const submit = (): void => {
    const text = input.trim();
    if (!text || busy) return;
    setInput("");
    void sendMessage({ text });
  };

  return (
    <div className="chat">
      <div className="messages" ref={listRef}>
        {messages.map((message) => (
          <Message key={message.id} message={message} />
        ))}
      </div>

      {error ? <div className="error">{error.message}</div> : null}

      <div className="composer">
        <textarea
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              submit();
            }
          }}
          placeholder="Ask the browser to do something"
          rows={1}
        />
        <button type="button" onClick={submit} disabled={busy || input.trim().length === 0}>
          Send
        </button>
      </div>
    </div>
  );
}

function Message({ message }: { message: UIMessage }) {
  return (
    <div className={`msg msg-${message.role}`}>
      {message.parts.map((part, index) => {
        if (part.type === "text") {
          if (!part.text.trim()) return null;
          // Assistant replies use tables and lists, so they render as markdown;
          // a user's own words are shown verbatim rather than reinterpreted as
          // markup. Streamdown rather than react-markdown because it renders
          // markdown that is still arriving, so a half-written table or fence
          // does not flash as raw text mid-stream.
          return message.role === "assistant" ? (
            <div key={index} className="bubble markdown">
              <Streamdown>{part.text}</Streamdown>
            </div>
          ) : (
            <div key={index} className="bubble">
              {part.text}
            </div>
          );
        }

        const call = asToolCall(part);
        return call ? <ToolCall key={index} call={call} /> : null;
      })}
    </div>
  );
}

interface ToolCallView {
  name: string;
  state: string;
  input: unknown;
  output: unknown;
  errorText?: string;
}

/**
 * MCP tools arrive as dynamic tool parts. Narrow them here rather than trusting
 * a tool-specific part type that only exists for statically declared tools.
 */
function asToolCall(part: UIMessage["parts"][number]): ToolCallView | null {
  if (part.type !== "dynamic-tool" && !part.type.startsWith("tool-")) return null;
  const record = part as unknown as {
    type: string;
    toolName?: string;
    state?: string;
    input?: unknown;
    output?: unknown;
    errorText?: string;
  };
  return {
    name: record.toolName ?? record.type.replace(/^tool-/, ""),
    state: record.state ?? "",
    input: record.input,
    output: record.output,
    ...(record.errorText ? { errorText: record.errorText } : {}),
  };
}

function ToolCall({ call }: { call: ToolCallView }) {
  const code = codeOf(call.input);
  const output = call.errorText ?? textOf(call.output);
  const failed = Boolean(call.errorText) || call.state === "output-error";
  const running = call.state === "input-streaming" || call.state === "input-available";

  return (
    <details
      className="tool"
      data-state={failed ? "error" : "ok"}
      open={!failed && call.name === "browser_run"}
    >
      <summary>
        {call.name}
        {running ? " · running" : ""}
      </summary>
      {code ? <pre>{code}</pre> : null}
      {output ? <pre className="output">{output}</pre> : null}
    </details>
  );
}

function codeOf(input: unknown): string {
  if (input && typeof input === "object" && "code" in input) {
    const code = (input as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return input === undefined ? "" : stringify(input);
}

function textOf(output: unknown): string {
  if (output === undefined || output === null) return "";
  if (typeof output === "string") return output;

  // MCP tool results arrive as content blocks; show the text the server rendered.
  if (typeof output === "object" && "content" in output) {
    const content = (output as { content?: unknown }).content;
    if (Array.isArray(content)) {
      const text = content
        .map((block) =>
          block && typeof block === "object" && "text" in block
            ? String((block as { text: unknown }).text)
            : "",
        )
        .filter(Boolean)
        .join("\n");
      if (text) return text;
    }
  }
  return stringify(output);
}

function stringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}
