import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono, type Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import {
  CSRF_FIELD,
  CSRF_HEADER,
  LoginLimiter,
  SESSION_COOKIE,
  SESSION_TTL_MS,
  clientKey,
  cookieSecure,
  csrfOK,
  isMutating,
  isPublicPath,
  issueSession,
  passwordsMatch,
  safeNextPath,
  verifySession,
  type UiSession,
} from "./auth.js";
import type { Config } from "./config.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";
import {
  deleteForgeCredential,
  getForgeCredential,
  getPage,
  getPrimaryRepo,
  listAllPages,
  listPages,
  setForgeCredential,
  setLastMapped,
  upsertConnectedRepo,
  upsertPage,
  type SqliteDb,
} from "./db.js";
import {
  decryptForgeToken,
  encryptForgeToken,
  fetchRepoTarball,
  verifyGithubRepo,
  type FetchLike,
  type TarballError,
  type VerifyError,
} from "./forge.js";
import { ASK_MAX_QUESTION, createOpenCodeRunner, type AskRunner } from "./opencode.js";
import { createMapRefresher, extractTarball, isValidMapRef, type RefreshRunner } from "./refresh.js";
import {
  appPage,
  askResultFragment,
  connectPage,
  refreshResultFragment,
  loginPage,
  themeCss,
  type ChromeModel,
} from "./ui.js";

export interface AppOptions {
  config: Config;
  db: SqliteDb;
  limiter?: LoginLimiter;
  now?: () => number;
  fetchImpl?: FetchLike;
  askRunner?: AskRunner;
  refreshRunner?: RefreshRunner;
}

type Env = {
  Variables: {
    session?: UiSession;
  };
};

export function createApp(opts: AppOptions): Hono<Env> {
  const { config, db } = opts;
  const limiter = opts.limiter ?? new LoginLimiter(config.loginLimit, config.loginWindowMs);
  const now = opts.now ?? Date.now;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const ask =
    opts.askRunner ??
    createOpenCodeRunner({ bin: config.openCodeBin, timeoutMs: config.openCodeTimeoutMs, model: config.openCodeModel });
  const refresh =
    opts.refreshRunner ??
    createMapRefresher({ bin: config.openCodeBin, timeoutMs: config.openCodeTimeoutMs, model: config.openCodeModel });
  const app = new Hono<Env>();
  const htmxJs = loadHtmx();

  app.use("*", async (c, next) => {
    c.header("X-Content-Type-Options", "nosniff");
    c.header("X-Frame-Options", "DENY");
    c.header("Referrer-Policy", "no-referrer");
    const path = new URL(c.req.url).pathname;
    const session = verifySession(config.sessionSecret, getCookie(c, SESSION_COOKIE), now());
    if (session) c.set("session", session);

    if (isPublicPath(path)) {
      if (path === "/login" && isMutating(c.req.method) && !limiter.allow(requestClientKey(c))) {
        return c.text("too many requests", 429);
      }
      await next();
      return;
    }

    if (!session) {
      if (isMutating(c.req.method)) {
        if (!limiter.allow(requestClientKey(c))) return c.text("too many requests", 429);
        return c.text("unauthorized", 401);
      }
      if (c.req.header("HX-Request") === "true") return c.text("unauthorized", 401);
      const nextPath = path === "/" ? "" : `?next=${encodeURIComponent(path)}`;
      return c.redirect(`/login${nextPath}`);
    }

    if (isMutating(c.req.method)) {
      const body = await c.req.parseBody();
      const field = typeof body[CSRF_FIELD] === "string" ? body[CSRF_FIELD] : undefined;
      if (!csrfOK(session, field, c.req.header(CSRF_HEADER))) {
        return c.text("csrf", 403);
      }
    }

    await next();
  });

  app.get("/health", (c) => {
    db.prepare("SELECT 1 AS ok").get();
    return c.json({ ok: true });
  });

  app.get("/assets/eru.css", (c) => {
    c.header("Content-Type", "text/css; charset=utf-8");
    c.header("Cache-Control", "no-store");
    return c.body(themeCss());
  });

  app.get("/assets/htmx.min.js", (c) => {
    c.header("Content-Type", "text/javascript; charset=utf-8");
    c.header("Cache-Control", "public, max-age=86400");
    return c.body(htmxJs);
  });

  app.get("/login", (c) => {
    if (c.get("session")) return c.redirect("/");
    return html(c, loginPage());
  });

  app.post("/login", async (c) => {
    const body = await c.req.parseBody();
    const password = typeof body.password === "string" ? body.password : "";
    if (!passwordsMatch(password, config.uiPassword)) {
      console.log("login refused");
      return html(c, loginPage("Refused."), 401);
    }
    const issued = issueSession(config.sessionSecret, now());
    setCookie(c, SESSION_COOKIE, issued.token, {
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
      secure: cookieSecure(c.req.url, c.req.header("x-forwarded-proto")),
      maxAge: Math.floor(SESSION_TTL_MS / 1000),
    });
    return c.redirect(safeNextPath(c.req.query("next")));
  });

  app.post("/logout", (c) => {
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    return c.redirect("/login");
  });

  app.get("/", (c) => html(c, appPage(chromeModel(c, db))));
  app.get("/brief", (c) => html(c, appPage(chromeModel(c, db))));
  app.get("/brief/:slug", (c) => {
    const model = chromeModel(c, db, c.req.param("slug"));
    if (!model.page && model.pages.length > 0) return c.text("page not found", 404);
    return html(c, appPage(model));
  });
  app.get("/ask", (c) => html(c, appPage(chromeModel(c, db))));

  app.get("/connect", (c) => html(c, connectPage(chromeModel(c, db))));

  app.post("/connect", async (c) => {
    const body = await c.req.parseBody();
    const owner = typeof body.owner === "string" ? body.owner.trim() : "";
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const token = typeof body.token === "string" ? body.token.trim() : "";
    const result = await verifyGithubRepo(owner, name, token, fetchImpl);
    if (!result.ok) {
      console.log(`connect refused: ${result.error}`);
      return html(c, connectPage(chromeModel(c, db), CONNECT_ERRORS[result.error], { owner, name }), connectStatus(result.error));
    }
    const at = new Date(now()).toISOString();
    db.transaction(() => {
      const repoId = upsertConnectedRepo(db, result.repo, at);
      if (token) {
        setForgeCredential(db, repoId, encryptForgeToken(config.forgeKeySecret ?? config.sessionSecret, token), at);
      } else {
        deleteForgeCredential(db, repoId);
      }
    })();
    console.log(`connected ${result.repo.forge}:${result.repo.owner}/${result.repo.name}`);
    return c.redirect("/");
  });

  app.post("/ask", async (c) => {
    const body = await c.req.parseBody();
    const q = typeof body.q === "string" ? body.q.trim() : "";
    const notice = await askNotice(db, ask, q);
    if (c.req.header("HX-Request") === "true") {
      c.header("Content-Type", "text/html; charset=utf-8");
      return c.body(askResultFragment(notice));
    }
    return html(c, appPage(chromeModel(c, db, undefined, notice)));
  });

  app.post("/refresh", async (c) => {
    const body = await c.req.parseBody();
    const ref = typeof body.ref === "string" ? body.ref.trim() : "";
    const notice = await refreshNotice(db, config, fetchImpl, refresh, ref, now);
    if (c.req.header("HX-Request") === "true") {
      c.header("Content-Type", "text/html; charset=utf-8");
      return c.body(refreshResultFragment(notice));
    }
    return html(c, appPage(chromeModel(c, db, undefined, undefined, notice)));
  });

  return app;
}

function html(c: Context<Env>, body: string, status: ContentfulStatusCode = 200) {
  c.header("Content-Type", "text/html; charset=utf-8");
  c.header("Cache-Control", "no-store");
  return c.body(body, status);
}

function requestClientKey(c: Context<Env>): string {
  const incoming = (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming;
  return clientKey(c.req.header("x-forwarded-for"), c.req.header("x-real-ip"), incoming?.socket?.remoteAddress);
}

const CONNECT_ERRORS: Record<VerifyError, string> = {
  invalid: "Owner or repo name is not valid.",
  notfound: "Could not uniquely resolve that repository. Check owner and name.",
  auth: "The forge token cannot read that repository. Use a least-privilege token for this repo.",
  unreachable: "Could not reach the forge. Try again in a moment.",
};

function connectStatus(error: VerifyError): ContentfulStatusCode {
  return error === "unreachable" ? 502 : 400;
}

const REFRESH_TARBALL_ERRORS: Record<TarballError, string> = {
  invalid: "That ref does not look right.",
  notfound: "The forge could not find that ref or SHA. Check it and try again.",
  auth: "The forge token cannot read that repository. Reconnect with a least-privilege token.",
  unreachable: "Could not reach the forge. Try again in a moment.",
  toobig: "That checkout is too large to map.",
};

async function refreshNotice(
  db: SqliteDb,
  config: Config,
  fetchImpl: FetchLike,
  refresh: RefreshRunner,
  ref: string,
  now: () => number,
): Promise<string> {
  if (!ref) return "Pick a ref or SHA first.";
  if (!isValidMapRef(ref)) return "That ref does not look right.";
  const repo = getPrimaryRepo(db);
  if (!repo) return "Connect a repo before refreshing.";
  const stored = getForgeCredential(db, repo.id);
  if (!stored) return "Reconnect the repo with a forge token before refreshing.";
  let token: string;
  try {
    token = decryptForgeToken(config.sessionSecret, stored);
  } catch {
    console.log("refresh refused: credential unreadable");
    return "The stored forge credential could not be read — reconnect the repo.";
  }

  const tarball = await fetchRepoTarball(repo.owner, repo.name, ref, token, fetchImpl);
  if (!tarball.ok) {
    console.log(`refresh refused: ${tarball.error}`);
    return REFRESH_TARBALL_ERRORS[tarball.error];
  }

  const workdir = await mkdtemp(joinPath(tmpdir(), "eru-map-"));
  try {
    await extractTarball(tarball.data, workdir);
  } catch {
    console.log("refresh failed: could not unpack the checkout");
    return "Could not unpack the checkout — refresh failed.";
  }

  try {
    const result = await refresh(joinPath(workdir, "checkout"), `${repo.owner}/${repo.name}`, ref);
    if (!result.ok) {
      console.log(`refresh failed: ${result.error}`);
      if (result.error === "unconfigured") return "OpenCode is not configured on this host (check ERU_OPENCODE_BIN).";
      if (result.error === "nomap") return "OpenCode did not return map pages — nothing was stored.";
      return "OpenCode could not map the checkout — check the service log.";
    }
    const at = new Date(now()).toISOString();
    db.transaction(() => {
      for (const page of result.pages) {
        upsertPage(db, repo.id, { ...page, mappedRef: ref }, at);
      }
      setLastMapped(db, repo.id, ref, at);
    })();
    console.log(`mapped ${repo.owner}/${repo.name} @${ref}: ${result.pages.length} pages`);
    return `Mapped @${ref} — ${result.pages.length} page${result.pages.length === 1 ? "" : "s"}.`;
  } finally {
    await rm(workdir, { recursive: true, force: true }).catch(() => {});
  }
}

async function askNotice(db: SqliteDb, ask: AskRunner, q: string): Promise<string> {
  if (!q) return "Ask something first.";
  if (q.length > ASK_MAX_QUESTION) return `Keep questions under ${ASK_MAX_QUESTION} characters.`;
  const repo = getPrimaryRepo(db);
  if (!repo) return "Connect a repo before asking.";
  const pages = listAllPages(db, repo.id);
  if (pages.length === 0) return "The map has no pages yet — refresh the map first.";
  const result = await ask(q, pages, `${repo.owner}/${repo.name}`);
  if (result.ok) return result.answer || "OpenCode returned an empty answer.";
  console.log(`ask refused: ${result.error}`);
  return result.error === "unconfigured"
    ? "OpenCode is not configured on this host (check ERU_OPENCODE_BIN)."
    : "OpenCode could not answer — check the service log.";
}

function chromeModel(
  c: Context<Env>,
  db: SqliteDb,
  slug?: string,
  askNotice?: string,
  refreshNotice?: string,
): ChromeModel {
  const session = c.get("session");
  if (!session) throw new Error("eru: missing session");
  const repo = getPrimaryRepo(db);
  const pages = repo ? listPages(db, repo.id) : [];
  const page = repo && (slug || pages.length > 0) ? getPage(db, repo.id, slug ?? pages[0].slug) ?? null : null;
  return {
    hasRepo: Boolean(repo),
    owner: repo?.owner ?? "",
    name: repo?.name ?? "",
    lastMappedRef: repo?.lastMappedRef ?? null,
    lastMappedLabel: repo?.lastMappedAt ?? "never",
    csrf: session.csrf,
    pages,
    page,
    askNotice,
    refreshNotice,
  };
}

function loadHtmx(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, "assets", "htmx.min.js"),
    join(process.cwd(), "dist", "assets", "htmx.min.js"),
    join(process.cwd(), "node_modules", "htmx.org", "dist", "htmx.min.js"),
    join(here, "..", "node_modules", "htmx.org", "dist", "htmx.min.js"),
  ];
  for (const path of candidates) {
    if (existsSync(path)) return readFileSync(path, "utf8");
  }
  throw new Error("eru: htmx.min.js is missing");
}
