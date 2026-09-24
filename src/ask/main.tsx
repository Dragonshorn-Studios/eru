// Eru's one client island: the Ask thread. Everything else is SSR + HTMX.
// The island never holds an OpenCode credential — it talks to Eru's own
// /ask/api/* (session cookie + X-CSRF-Token) and streams through /ask/oc/*,
// where the server injects the loopback basic-auth and the workspace dir.
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { createRoot } from "react-dom/client";
import {
  ActionBarPrimitive,
  AssistantRuntimeProvider,
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
} from "@assistant-ui/react";
import { createOpencodeClient, useOpenCodeRuntime } from "@assistant-ui/react-opencode";
import { MarkdownTextPrimitive } from "@assistant-ui/react-markdown";

declare global {
  interface Window {
    __ERU_ASK__?: {
      csrf: string;
      agent: string;
      maxQuestion: number;
      apiBase: string;
      slugs: string[];
    };
  }
}

interface ThreadView {
  id: string;
  sessionId: string | null;
  title: string;
  mappedRef: string | null;
  stale: boolean;
  createdAt: string;
  updatedAt: string;
}

interface AskStatus {
  opencode: "up" | "down";
  agent: string;
  model: string | null;
  repo: { id: number; owner: string; name: string; lastMappedRef: string | null } | null;
  hasMap: boolean;
}

const boot = window.__ERU_ASK__ ?? { csrf: "", agent: "eru-ask", maxQuestion: 2000, apiBase: "/ask", slugs: [] };
const KNOWN_SLUGS = new Set(boot.slugs);

const API_TIMEOUT_MS = 25_000;

async function api(path: string, init?: RequestInit): Promise<Response> {
  // Bounded so a stalled request surfaces a banner instead of leaving the
  // island on "Waking up…" forever.
  const signals: AbortSignal[] = [AbortSignal.timeout(API_TIMEOUT_MS)];
  if (init?.signal) signals.push(init.signal);
  const res = await fetch(`${boot.apiBase}${path}`, {
    ...init,
    signal: AbortSignal.any(signals),
    headers: { accept: "application/json", "x-csrf-token": boot.csrf, ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) detail = body.error;
    } catch {
      /* non-json error page */
    }
    throw new Error(detail);
  }
  return res;
}

// Mutating requests need the CSRF header; harmless on the rest.
const csrfFetch: typeof fetch = (input, init) =>
  fetch(input, {
    ...init,
    headers: { ...(init?.headers ?? {}), "x-csrf-token": boot.csrf },
  });

// Map citations land on Brief pages; anything else the model links stays a
// normal (rel-safe) link, and an unknown map slug degrades to plain text.
function CiteLink(props: { href?: string; children?: React.ReactNode }) {
  const m = /^(?:\.\/)?map\/([A-Za-z0-9][A-Za-z0-9._-]*)\.md$/.exec(props.href ?? "");
  if (m) {
    if (KNOWN_SLUGS.has(m[1])) {
      return <a href={`/brief/${encodeURIComponent(m[1])}`}>{props.children}</a>;
    }
    return <span>{props.children}</span>;
  }
  return (
    <a href={props.href} rel="noreferrer noopener" target="_blank">
      {props.children}
    </a>
  );
}

const MAP_CITE_RE = /^(?:\.\/)?map\/([A-Za-z0-9][A-Za-z0-9._-]*)\.md$/;

// The agent cites map pages as `map/<slug>.md` code spans; when the slug is a
// known Brief page they should behave like the links they look like.
function CiteCode(props: { children?: React.ReactNode; className?: string }) {
  const text = typeof props.children === "string" ? props.children : "";
  const m = MAP_CITE_RE.exec(text.trim());
  if (m && KNOWN_SLUGS.has(m[1])) {
    return <a className="ask-cite" href={`/brief/${encodeURIComponent(m[1])}`}>{text}</a>;
  }
  return <code className={props.className}>{props.children}</code>;
}

const AskText = () => (
  <MarkdownTextPrimitive className="ask-md" smooth components={{ a: CiteLink, code: CiteCode }} />
);

const TOOL_LABELS: Record<string, string> = { read: "read", glob: "glob", grep: "grep" };

function toolTarget(args: unknown): string {
  if (typeof args !== "object" || args === null) return "";
  const a = args as Record<string, unknown>;
  const target = a.filePath ?? a.filepath ?? a.path ?? a.pattern ?? a.query ?? a.include ?? "";
  return typeof target === "string" ? target : "";
}

interface ToolPartProps {
  toolName?: string;
  args?: unknown;
  argsText?: string;
  result?: unknown;
  status?: { type?: string };
}

// Token-styled tool card: name + what it touched, expandable for the raw
// args/result. The workspace only allows read/glob/grep on the map.
const ToolCard = ({ toolName, args, argsText, result, status }: ToolPartProps) => {
  const running = status?.type === "running";
  const failed = status?.type === "incomplete";
  const name = TOOL_LABELS[toolName ?? ""] ?? toolName ?? "tool";
  const target = toolTarget(args);
  const detail = [argsText, typeof result === "string" ? result : result ? JSON.stringify(result, null, 2) : ""]
    .filter(Boolean)
    .join("\n\n")
    .trim();
  return (
    <details className={`ask-tool${running ? " running" : ""}${failed ? " failed" : ""}`}>
      <summary className="ask-tool-head">
        <span className="ask-tool-dot" aria-hidden="true" />
        <span className="ask-tool-name">{name}</span>
        {target ? <span className="ask-tool-target">{target}</span> : null}
        <span className="ask-tool-state">{running ? "reading…" : failed ? "stopped" : "done"}</span>
      </summary>
      {detail ? <pre className="ask-tool-detail">{detail}</pre> : null}
    </details>
  );
};

const AskMessage = () => (
  <MessagePrimitive.Root className="ask-msg">
    <MessagePrimitive.If user>
      <div className="ask-bubble ask-bubble-user">
        <MessagePrimitive.Parts components={{ Text: AskText }} />
      </div>
    </MessagePrimitive.If>
    <MessagePrimitive.If assistant>
      <div className="ask-bubble">
        <MessagePrimitive.Parts components={{ Text: AskText, tools: { Fallback: ToolCard } }} />
        <MessagePrimitive.Error>
          <p className="ask-msg-error">Eru hit a snag on that turn — you can retry below.</p>
        </MessagePrimitive.Error>
        <ActionBarPrimitive.Root className="ask-actions" hideWhenRunning autohide="not-last">
          <ActionBarPrimitive.Reload className="ask-action" title="Retry">
            retry
          </ActionBarPrimitive.Reload>
          <ActionBarPrimitive.Copy className="ask-action" title="Copy">
            copy
          </ActionBarPrimitive.Copy>
        </ActionBarPrimitive.Root>
      </div>
    </MessagePrimitive.If>
  </MessagePrimitive.Root>
);

function Conversation({ thread, model, onSession, onError }: { thread: ThreadView; model: string | null; onSession: (id: string) => void; onError: (msg: string) => void }) {
  const client = useMemo(
    () =>
      createOpencodeClient({
        baseUrl: `${location.origin}${boot.apiBase}/oc/${thread.id}`,
        fetch: csrfFetch,
      }),
    [thread.id],
  );
  const defaultModel = useMemo(() => {
    if (!model) return undefined;
    const i = model.indexOf("/");
    return i > 0 ? { providerID: model.slice(0, i), modelID: model.slice(i + 1) } : undefined;
  }, [model]);
  const runtime = useOpenCodeRuntime({
    client,
    initialSessionId: thread.sessionId ?? undefined,
    defaultAgent: boot.agent,
    defaultModel,
    onThreadIdChange: (id) => {
      if (id && id !== thread.sessionId) onSession(id);
    },
    onError: (err) => onError(err instanceof Error ? err.message : "OpenCode connection failed."),
  });
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ThreadPrimitive.Root className="ask-thread">
        <ThreadPrimitive.Viewport className="ask-viewport" autoScroll>
          <div className="ask-msgs">
            <ThreadPrimitive.Empty>
              <p className="ask-empty">Ask anything about this map — pages cite themselves.</p>
            </ThreadPrimitive.Empty>
            <ThreadPrimitive.Messages components={{ Message: AskMessage }} />
          </div>
          <ThreadPrimitive.ScrollToBottom className="ask-scroll" aria-label="Scroll to latest">
            ↓
          </ThreadPrimitive.ScrollToBottom>
        </ThreadPrimitive.Viewport>
        <ComposerPrimitive.Root className="ask-composer">
          <div className="ask-composer-row">
            <ComposerPrimitive.Input
              className="ask-input"
              placeholder="What do you want to know?"
              aria-label="Ask Eru"
              maxLength={boot.maxQuestion}
              autoFocus
            />
            <ThreadPrimitive.If running>
              <ComposerPrimitive.Cancel className="ask-btn">Stop</ComposerPrimitive.Cancel>
            </ThreadPrimitive.If>
            <ThreadPrimitive.If running={false}>
              <ComposerPrimitive.Send className="ask-btn ask-send">Ask</ComposerPrimitive.Send>
            </ThreadPrimitive.If>
          </div>
        </ComposerPrimitive.Root>
      </ThreadPrimitive.Root>
    </AssistantRuntimeProvider>
  );
}

function AskApp() {
  const [threads, setThreads] = useState<ThreadView[] | null>(null);
  const [status, setStatus] = useState<AskStatus | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [banner, setBanner] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    const [threadsRes, statusRes] = await Promise.all([
      api("/api/threads").then((r) => r.json() as Promise<{ threads: ThreadView[] }>),
      api("/api/status").then((r) => r.json() as Promise<AskStatus>),
    ]);
    setThreads(threadsRes.threads);
    setStatus(statusRes);
    setActiveId((current) => current ?? threadsRes.threads[0]?.id ?? null);
  }, []);

  useEffect(() => {
    refresh().catch((err) => setBanner(err instanceof Error ? err.message : "Ask failed to load."));
  }, [refresh]);

  const createThread = useCallback(async () => {
    setBusy(true);
    setBanner(null);
    try {
      const res = await api("/api/threads", { method: "POST" });
      const { thread } = (await res.json()) as { thread: ThreadView };
      setThreads((ts) => [thread, ...(ts ?? [])]);
      setActiveId(thread.id);
    } catch (err) {
      setBanner(err instanceof Error ? err.message : "Could not start a thread.");
    } finally {
      setBusy(false);
    }
  }, []);

  const deleteThread = useCallback(
    async (id: string, ev: FormEvent | React.MouseEvent) => {
      ev.stopPropagation();
      try {
        await api(`/api/threads/${id}`, { method: "DELETE" });
        const rest = (threads ?? []).filter((t) => t.id !== id);
        setThreads(rest);
        setActiveId((cur) => (cur === id ? (rest[0]?.id ?? null) : cur));
      } catch (err) {
        setBanner(err instanceof Error ? err.message : "Could not delete the thread.");
      }
    },
    [threads],
  );

  const syncSession = useCallback((threadId: string) => {
    return (sessionId: string) => {
      setThreads((ts) => (ts ?? []).map((t) => (t.id === threadId ? { ...t, sessionId } : t)));
      void api(`/api/threads/${threadId}/session`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId }),
      }).catch(() => {});
    };
  }, []);

  if (threads === null) {
    return banner ? <p className="ask-empty ask-error-text">{banner}</p> : <p className="ask-empty">Waking up the Ask thread…</p>;
  }

  if (status && !status.hasMap) {
    return <p className="ask-empty">The map has no pages yet — refresh the map on Brief first.</p>;
  }
  if (status && !status.repo) {
    return <p className="ask-empty">Connect a repo before asking.</p>;
  }

  const active = threads.find((t) => t.id === activeId) ?? null;

  return (
    <div className="ask-app">
      <aside className="ask-rail" aria-label="Threads">
        <button type="button" className="ask-btn ask-new" onClick={createThread} disabled={busy}>
          + New thread
        </button>
        <ul className="ask-threads">
          {threads.map((t) => (
            <li key={t.id}>
              <button
                type="button"
                className={`ask-thread-row${t.id === activeId ? " active" : ""}`}
                onClick={() => setActiveId(t.id)}
              >
                <span className="ask-thread-title">{t.title || "Ask"}</span>
                {t.stale ? <span className="ask-stale" title={`mapped @${t.mappedRef ?? "?"}, map moved on`}>stale map</span> : null}
              </button>
              <button type="button" className="ask-thread-del" title="Delete thread" aria-label="Delete thread" onClick={(e) => void deleteThread(t.id, e)}>
                ×
              </button>
            </li>
          ))}
          {threads.length === 0 ? <li className="ask-empty ask-empty-rail">No threads yet.</li> : null}
        </ul>
        {status?.opencode === "down" ? <p className="ask-error-text">OpenCode serve is down — check ERU_OPENCODE_BIN.</p> : null}
      </aside>
      <section className="ask-main">
        {banner ? <p className="ask-error-text" role="alert">{banner}</p> : null}
        {active ? (
          <Conversation key={active.id} thread={active} model={status?.model ?? null} onSession={syncSession(active.id)} onError={setBanner} />
        ) : (
          <p className="ask-empty">Start a thread to ask about the map.</p>
        )}
      </section>
    </div>
  );
}

const rootEl = document.getElementById("ask-root");
if (rootEl) createRoot(rootEl).render(<AskApp />);
