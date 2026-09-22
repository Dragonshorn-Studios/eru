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
import {
  deleteForgeCredential,
  getPage,
  getPrimaryRepo,
  listPages,
  setForgeCredential,
  upsertConnectedRepo,
  type SqliteDb,
} from "./db.js";
import { encryptForgeToken, forgeKeySecrets, verifyGithubRepo, type FetchLike, type VerifyError } from "./forge.js";
import {
  ASK_STUB_MESSAGE,
  appPage,
  askStubFragment,
  connectPage,
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
        setForgeCredential(db, repoId, encryptForgeToken(forgeKeySecrets(config)[0], token), at);
      } else {
        deleteForgeCredential(db, repoId);
      }
    })();
    console.log(`connected ${result.repo.forge}:${result.repo.owner}/${result.repo.name}`);
    return c.redirect("/");
  });

  app.post("/ask", async (c) => {
    if (c.req.header("HX-Request") === "true") {
      c.header("Content-Type", "text/html; charset=utf-8");
      return c.body(askStubFragment());
    }
    return html(c, appPage(chromeModel(c, db, undefined, ASK_STUB_MESSAGE)));
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
  auth: "The forge token cannot read that repository, or the request was rate limited. Use a least-privilege token for this repo.",
  unreachable: "Could not reach the forge. Try again in a moment.",
};

function connectStatus(error: VerifyError): ContentfulStatusCode {
  return error === "unreachable" ? 502 : 400;
}

function chromeModel(c: Context<Env>, db: SqliteDb, slug?: string, askNotice?: string): ChromeModel {
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
