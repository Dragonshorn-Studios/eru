import type { Context } from "hono";
import { isMutating } from "./auth.js";
import type { SqliteDb, MappedRepo } from "./db.js";
import type { FetchLike } from "./forge.js";
import { ensureWorkspace, getThread, touchThread } from "./askthreads.js";

/**
 * Hono → OpenCode serve proxy (#33). The browser only ever sees same-origin
 * /ask/oc/<threadId>/* URLs; the proxy resolves the thread's isolated
 * workspace, injects the `directory` parameter and the loopback basic-auth
 * credentials itself, and forwards to the supervised `opencode serve`.
 *
 * Only the OpenCode endpoints the assistant-ui adapter calls are reachable:
 * session CRUD + prompts, the SSE event stream, permission/question replies,
 * and the experimental session list the remote thread list uses. Everything
 * else — PTY, shell, file read outside the workspace, TUI, MCP, auth — is
 * refused before it can leave the process.
 */

export interface AskProxyDeps {
  db: SqliteDb;
  workdir: string;
  /** Selected repo for this request — threads are scoped to it. */
  repo: MappedRepo | undefined;
  server: { url(): string | null; password(): string };
  now: () => number;
  fetchImpl?: FetchLike;
  timeoutMs?: () => number;
}

// First path segment / exact path allowlist for forwarded upstream requests.
const ALLOWED_UPSTREAM = /^\/(session(?:\/.*)?|event|question(?:\/.*)?|permission(?:\/.*)?|experimental\/(session|tool)(?:\/.*)?)$/;

// Headers a client may never smuggle upstream; the proxy sets its own.
const STRIP_REQUEST_HEADERS = new Set([
  "authorization",
  "connection",
  "content-length",
  "cookie",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "transfer-encoding",
  "upgrade",
  "x-csrf-token",
]);

const STRIP_RESPONSE_HEADERS = new Set([
  "connection",
  "content-encoding",
  "content-length",
  "keep-alive",
  "set-cookie",
  "transfer-encoding",
  "upgrade",
]);

export function proxyPathAllowed(rest: string): boolean {
  return ALLOWED_UPSTREAM.test(rest);
}

export async function askProxy(c: Context, deps: AskProxyDeps): Promise<Response> {
  const threadId = c.req.param("threadId") ?? "";
  const prefix = `/ask/oc/${threadId}`;
  const rest = c.req.path.startsWith(prefix) ? c.req.path.slice(prefix.length) : "";
  const upstreamPath = rest === "" ? "/" : rest;
  if (!proxyPathAllowed(upstreamPath)) {
    return c.json({ error: "endpoint not proxied" }, 404);
  }

  const repo = deps.repo;
  const thread = getThread(deps.db, threadId);
  // Same 404 for unknown and out-of-scope threads: existence does not leak
  // across repositories.
  if (!repo || !thread || thread.repoId !== repo.id) {
    return c.json({ error: "no such thread" }, 404);
  }

  const upstream = deps.server.url();
  if (!upstream) {
    return c.json({ error: "opencode serve is not running" }, 503);
  }

  const at = new Date(deps.now()).toISOString();
  const workspace = await ensureWorkspace(deps.db, deps.workdir, thread, at);

  const target = new URL(`${upstream}${upstreamPath}`);
  for (const [key, value] of new URL(c.req.url).searchParams) {
    target.searchParams.append(key, value);
  }
  // The workspace directory is authoritative and server-side: a client may
  // never point a session at another directory on this host.
  target.searchParams.delete("directory");
  target.searchParams.set("directory", workspace);

  const headers = new Headers();
  for (const [key, value] of c.req.raw.headers) {
    if (!STRIP_REQUEST_HEADERS.has(key.toLowerCase())) headers.set(key, value);
  }
  headers.set("authorization", `Basic ${Buffer.from(`opencode:${deps.server.password()}`).toString("base64")}`);

  const method = c.req.method.toUpperCase();
  const init: RequestInit = { method, headers, redirect: "manual" };
  if (isMutating(method)) {
    init.body = await c.req.arrayBuffer();
  }
  const signals = [c.req.raw.signal];
  if (upstreamPath !== "/event" && deps.timeoutMs) {
    signals.push(AbortSignal.timeout(deps.timeoutMs()));
  }
  init.signal = AbortSignal.any(signals);

  let res: Response;
  try {
    res = await (deps.fetchImpl ?? fetch)(target.toString(), init);
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError";
    if (aborted) return c.json({ error: "request cancelled" }, 499 as 400);
    return c.json({ error: "opencode serve unreachable" }, 502);
  }
  if (method !== "GET" && method !== "HEAD") touchThread(deps.db, threadId, at);

  const out = new Headers();
  res.headers.forEach((value, key) => {
    if (!STRIP_RESPONSE_HEADERS.has(key.toLowerCase())) out.set(key, value);
  });
  return new Response(res.body, { status: res.status, headers: out });
}
