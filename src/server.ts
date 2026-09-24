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
  issueOAuthSession,
  issueSession,
  OAuthStateStore,
  passwordsMatch,
  safeNextPath,
  verifySession,
  type UiSession,
} from "./auth.js";
import {
  exchangeOAuthCode,
  fetchGithubUser,
  oauthAuthorizeUrl,
  oauthEnabled,
} from "./oauth.js";
import {
  DEFAULT_OPENCODE_TIMEOUT_MS,
  parseOpenCodeTimeout,
  type Config,
} from "./config.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";
import {
  deleteForgeCredential,
  deleteSetting,
  getForgeCredential,
  getPage,
  getPrimaryRepo,
  getRepo,
  getSetting,
  listAllPages,
  listConnectedRepos,
  listPages,
  setForgeCredential,
  setLastMapped,
  setSetting,
  upsertConnectedRepo,
  upsertPage,
  type MappedRepo,
  type SqliteDb,
} from "./db.js";
import {
  createGithubAppClient,
  decryptForgeToken,
  encryptForgeToken,
  fetchRepoTarball,
  forgeKeySecrets,
  verifyGithubRepo,
  type AppRepo,
  type FetchLike,
  type GithubAppClient,
  type GithubAppCredentials,
  type TarballError,
  type TarballResult,
  type VerifyError,
} from "./forge.js";
import {
  ASK_MAX_QUESTION,
  createModelDiscovery,
  createOpenCodeRunner,
  isValidModelName,
  type AskRunner,
  type ModelDiscovery,
} from "./opencode.js";
import { opencodeAuthPath, ProviderCredentialStore } from "./providers.js";
import { createMappingTracker, type MappingTracker } from "./mapping.js";
import { createMapRefresher, extractTarball, isValidMapRef, type RefreshRunner } from "./refresh.js";
import {
  APP_ERRORS,
  appPage,
  askResultFragment,
  configPage,
  CONNECT_ERRORS,
  connectPage,
  REFRESH_TARBALL_ERRORS,
  refreshResultFragment,
  loginPage,
  themeCss,
  type ChromeModel,
  type ConfigView,
} from "./ui.js";

export interface AppOptions {
  config: Config;
  db: SqliteDb;
  limiter?: LoginLimiter;
  now?: () => number;
  fetchImpl?: FetchLike;
  oauthFetch?: typeof fetch;
  askRunner?: AskRunner;
  refreshRunner?: RefreshRunner;
  modelDiscovery?: ModelDiscovery;
  providerStore?: ProviderCredentialStore;
  mappingTracker?: MappingTracker;
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
    createOpenCodeRunner({ bin: config.openCodeBin, timeoutMs: () => resolveTimeout(config, db).value, model: config.openCodeModel });
  const refresh =
    opts.refreshRunner ??
    createMapRefresher({ bin: config.openCodeBin, timeoutMs: () => resolveTimeout(config, db).value, model: config.openCodeModel });
  const modelDiscovery =
    opts.modelDiscovery ?? createModelDiscovery({ bin: config.openCodeBin, timeoutMs: () => resolveTimeout(config, db).value });
  void modelDiscovery.refresh();
  const providers = opts.providerStore ?? new ProviderCredentialStore(opencodeAuthPath());
  const mapping = opts.mappingTracker ?? createMappingTracker();

  const oauthOn = oauthEnabled(config);
  const passwordLoginOn = !oauthOn || config.uiLocalLogin;
  const loginOpts = { showGithub: oauthOn, showPassword: passwordLoginOn };
  const oauthStates = new OAuthStateStore();
  const OAUTH_STATE_TTL_MS = 10 * 60_000;

  // Reused across requests so the minted installation token survives between
  // calls; rebuilt whenever the resolved app credentials change.
  let appClientCached: { sig: string; client: GithubAppClient } | undefined;
  function githubApp(): GithubAppClient | null {
    const resolved = resolveGithubApp(config, db);
    if (!resolved) return null;
    const sig = `${resolved.creds.appId}\n${resolved.creds.installationId ?? ""}\n${resolved.creds.privateKey}`;
    if (!appClientCached || appClientCached.sig !== sig) {
      appClientCached = { sig, client: createGithubAppClient(resolved.creds, fetchImpl) };
    }
    return appClientCached.client;
  }
  const app = new Hono<Env>();
  const htmxJs = loadHtmx();
  const faviconIco = loadPublicAsset("favicon.ico");
  const faviconPng = loadPublicAsset("favicon-32.png");
  const appleTouchIcon = loadPublicAsset("apple-touch-icon.png");
  const appIcon = loadPublicAsset("eru-icon.png");

  app.use("*", async (c, next) => {
    c.header("X-Content-Type-Options", "nosniff");
    c.header("X-Frame-Options", "DENY");
    c.header("Referrer-Policy", "no-referrer");
    const path = new URL(c.req.url).pathname;
    let session = verifySession(config.sessionSecret, getCookie(c, SESSION_COOKIE), now());
    // The GitHub allowlist is re-checked on every request: removing an id from
    // ERU_OAUTH_ADMIN_IDS takes effect without waiting for session expiry.
    if (session?.github && !config.oauthAdminIds.includes(session.github.id)) {
      console.warn(`auth: session denied (not allowlisted) id=${session.github.id} login=${session.github.login}`);
      deleteCookie(c, SESSION_COOKIE, { path: "/" });
      session = undefined;
    }
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

  app.get("/favicon.ico", (c) => {
    c.header("Content-Type", "image/x-icon");
    c.header("Cache-Control", "public, max-age=604800, immutable");
    return c.body(faviconIco);
  });

  app.get("/assets/favicon-32.png", (c) => {
    c.header("Content-Type", "image/png");
    c.header("Cache-Control", "public, max-age=604800, immutable");
    return c.body(faviconPng);
  });

  app.get("/assets/apple-touch-icon.png", (c) => {
    c.header("Content-Type", "image/png");
    c.header("Cache-Control", "public, max-age=604800, immutable");
    return c.body(appleTouchIcon);
  });

  app.get("/assets/eru-icon.png", (c) => {
    c.header("Content-Type", "image/png");
    c.header("Cache-Control", "public, max-age=604800, immutable");
    return c.body(appIcon);
  });

  app.get("/login", (c) => {
    if (c.get("session")) return c.redirect("/");
    return html(c, loginPage({ ...loginOpts, next: c.req.query("next") }));
  });

  app.post("/login", async (c) => {
    const body = await c.req.parseBody();
    const password = typeof body.password === "string" ? body.password : "";
    if (!passwordLoginOn || !passwordsMatch(password, config.uiPassword)) {
      console.log("login refused");
      return html(c, loginPage({ ...loginOpts, error: "Refused.", next: c.req.query("next") }), 401);
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

  app.get("/login/github", (c) => {
    if (!oauthOn) return c.redirect("/login");
    if (!limiter.allow(`oauth-start:${requestClientKey(c)}`)) {
      console.warn(`auth: oauth start rate limited ip=${requestClientKey(c)}`);
      return c.text("too many requests", 429);
    }
    const state = oauthStates.issue(now(), OAUTH_STATE_TTL_MS, safeNextPath(c.req.query("next")));
    return c.redirect(oauthAuthorizeUrl(config, state));
  });

  app.get("/login/github/callback", async (c) => {
    if (!oauthOn) return c.redirect("/login");
    const ip = requestClientKey(c);
    const url = new URL(c.req.url);
    const next = oauthStates.consume(url.searchParams.get("state") ?? undefined, now());
    if (next === undefined) {
      limiter.allow(`oauth-fail:${ip}`);
      console.warn(`auth: oauth state rejected (missing, expired, or replayed) ip=${ip}`);
      return html(c, loginPage({ ...loginOpts, error: "Sign-in link expired — try again." }), 403);
    }
    if (url.searchParams.get("error")) {
      // User-initiated cancel or provider refusal: no code exists, so this is
      // not a protocol failure and does not count toward the failure budget.
      console.log(`auth: oauth sign-in not completed at provider (${url.searchParams.get("error")}) ip=${ip}`);
      return html(c, loginPage({ ...loginOpts, error: "Sign-in was cancelled." }), 400);
    }
    const oauthFetch = opts.oauthFetch ?? fetch;
    const accessToken = await exchangeOAuthCode(config, url.searchParams.get("code") ?? "", oauthFetch);
    const user = accessToken ? await fetchGithubUser(accessToken, oauthFetch) : undefined;
    if (!user) {
      limiter.allow(`oauth-fail:${ip}`);
      console.warn("auth: oauth token exchange or user lookup failed");
      return html(c, loginPage({ ...loginOpts, error: "GitHub sign-in failed — try again." }), 502);
    }
    if (!config.oauthAdminIds.includes(user.id)) {
      limiter.allow(`oauth-fail:${ip}`);
      console.warn(`auth: oauth login denied id=${user.id} login=${user.login} ip=${ip}`);
      return html(c, loginPage({ ...loginOpts, error: "This GitHub account is not an operator here." }), 403);
    }
    const issued = issueOAuthSession(config.sessionSecret, user, now());
    setCookie(c, SESSION_COOKIE, issued.token, {
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
      secure: cookieSecure(c.req.url, c.req.header("x-forwarded-proto")),
      maxAge: Math.floor(SESSION_TTL_MS / 1000),
    });
    console.log(`auth: oauth login id=${user.id} login=${user.login}`);
    return c.redirect(safeNextPath(next));
  });

  app.post("/logout", (c) => {
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    return c.redirect("/login");
  });

  // Brief/Ask pages also surface the mapping job for the selected repo: a
  // running job turns the pane into the progress view, and a finished job's
  // notice is consumed exactly once here.
  function appModel(c: Context<Env>, slug?: string, askNotice?: string, refreshNotice?: string): ChromeModel {
    const model = chromeModel(c, db, config, slug, askNotice, refreshNotice);
    if (model.repo) {
      const job = mapping.get(model.repo.id);
      if (job?.status === "running") {
        model.mapping = true;
      } else {
        const done = mapping.consume(model.repo.id);
        if (done && !model.refreshNotice) model.refreshNotice = done.notice;
      }
    }
    return model;
  }

  app.get("/", (c) => html(c, appPage(appModel(c))));
  app.get("/brief", (c) => html(c, appPage(appModel(c))));
  app.get("/brief/:slug", (c) => {
    const model = appModel(c, c.req.param("slug"));
    if (!model.page && model.pages.length > 0) return c.text("page not found", 404);
    return html(c, appPage(model));
  });
  app.get("/ask", (c) => html(c, appPage(appModel(c))));

  app.get("/connect", async (c) => html(c, connectPage(chromeModel(c, db, config), "", {}, await appRepoList())));

  async function appRepoList(): Promise<{ repos: AppRepo[] } | { error: string } | null> {
    const client = githubApp();
    if (!client) return null;
    const repos = await client.listRepos();
    if (!repos.ok) {
      console.log(`github app repo list refused: ${repos.error}`);
      return { error: APP_ERRORS[repos.error] };
    }
    return { repos: repos.value };
  }

  app.post("/connect", async (c) => {
    const body = await c.req.parseBody();
    const owner = typeof body.owner === "string" ? body.owner.trim() : "";
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const token = typeof body.token === "string" ? body.token.trim() : "";
    const result = await verifyGithubRepo(owner, name, token, fetchImpl);
    if (!result.ok) {
      console.log(`connect refused: ${result.error}`);
      return html(c, connectPage(chromeModel(c, db, config), CONNECT_ERRORS[result.error], { owner, name }), connectStatus(result.error));
    }
    const at = new Date(now()).toISOString();
    db.transaction(() => {
      const repoId = upsertConnectedRepo(db, result.repo, at);
      if (token) {
        setForgeCredential(db, repoId, encryptForgeToken(forgeKeySecrets(config)[0], token), at);
      } else {
        deleteForgeCredential(db, repoId);
      }
      setSetting(db, SETTING_SELECTED_REPO, String(repoId), at);
    })();
    console.log(`connected ${result.repo.forge}:${result.repo.owner}/${result.repo.name}`);
    return c.redirect("/");
  });

  app.post("/repo/select", async (c) => {
    const body = await c.req.parseBody();
    const raw = typeof body.repo_id === "string" ? body.repo_id.trim() : "";
    const id = Number(raw);
    if (!/^\d+$/.test(raw) || !getRepo(db, id)) {
      return c.text("unknown repo", 400);
    }
    setSetting(db, SETTING_SELECTED_REPO, String(id), new Date(now()).toISOString());
    return c.redirect("/");
  });

  app.post("/connect/app", async (c) => {
    const body = await c.req.parseBody();
    const owner = typeof body.owner === "string" ? body.owner.trim() : "";
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const errorPage = async (error: string, status: ContentfulStatusCode = 400) =>
      html(c, connectPage(chromeModel(c, db, config), error, { owner, name }, await appRepoList()), status);
    const client = githubApp();
    if (!client) return errorPage("No GitHub App is configured — add one on the Config page or connect manually.");
    const token = await client.installationToken();
    if (!token.ok) {
      console.log(`connect via app refused: ${token.error}`);
      return errorPage(APP_ERRORS[token.error], token.error === "unreachable" ? 502 : 400);
    }
    const result = await verifyGithubRepo(owner, name, token.value, fetchImpl);
    if (!result.ok) {
      console.log(`connect via app refused: ${result.error}`);
      return errorPage(CONNECT_ERRORS[result.error], connectStatus(result.error));
    }
    const at = new Date(now()).toISOString();
    db.transaction(() => {
      const repoId = upsertConnectedRepo(db, result.repo, at, "app");
      setSetting(db, SETTING_SELECTED_REPO, String(repoId), at);
    })();
    console.log(`connected via app ${result.repo.forge}:${result.repo.owner}/${result.repo.name}`);
    return c.redirect("/");
  });

  app.post("/ask", async (c) => {
    const body = await c.req.parseBody();
    const q = typeof body.q === "string" ? body.q.trim() : "";
    const notice = await askNotice(db, config, ask, q);
    if (c.req.header("HX-Request") === "true") {
      c.header("Content-Type", "text/html; charset=utf-8");
      return c.body(askResultFragment(notice));
    }
    return html(c, appPage(appModel(c, undefined, notice)));
  });

  // Refresh runs in the background so the job survives page navigation: POST
  // starts it, the pane polls /refresh/status, and the next full render
  // consumes the finished notice. A second POST while running is a no-op.
  app.post("/refresh", async (c) => {
    const repo = selectedRepo(db);
    if (c.req.header("HX-Request") !== "true" && !repo) {
      return html(c, appPage(appModel(c, undefined, undefined, "Connect a repo before refreshing.")));
    }
    if (!repo) {
      c.header("Content-Type", "text/html; charset=utf-8");
      return c.body(refreshResultFragment("Connect a repo before refreshing."));
    }
    if (mapping.start(repo.id, now())) {
      void refreshNotice(db, config, fetchImpl, refresh, now, githubApp, repo)
        .then((result) => mapping.finish(repo.id, result.ok ? "done" : "failed", result.notice, now()))
        .catch((err) => {
          console.log("refresh crashed:", err instanceof Error ? err.message : err);
          mapping.finish(repo.id, "failed", "Refresh crashed — check the service log.", now());
        });
    }
    if (c.req.header("HX-Request") === "true") {
      c.header("Content-Type", "text/html; charset=utf-8");
      return c.body(refreshResultFragment("Mapping — the pane will reload when it finishes."));
    }
    return c.redirect("/");
  });

  app.get("/refresh/status", (c) => {
    const repo = selectedRepo(db);
    const job = repo ? mapping.get(repo.id) : undefined;
    return c.json({ status: job?.status ?? "none", notice: job?.notice ?? null });
  });

  app.get("/config", (c) => html(c, configPage(chromeModel(c, db, config), configView(db, config, modelDiscovery, providers))));

  app.post("/config/models", async (c) => {
    const body = await c.req.parseBody();
    const askModel = typeof body.ask_model === "string" ? body.ask_model.trim() : "";
    const mapModel = typeof body.map_model === "string" ? body.map_model.trim() : "";
    if ((askModel && !isValidModelName(askModel)) || (mapModel && !isValidModelName(mapModel))) {
      return html(
        c,
        configPage(chromeModel(c, db, config), configView(db, config, modelDiscovery, providers), "That is not a model name."),
        400,
      );
    }
    const timeoutRaw = typeof body.timeout_ms === "string" ? body.timeout_ms.trim() : "";
    if (timeoutRaw && parseOpenCodeTimeout(timeoutRaw) === undefined) {
      return html(
        c,
        configPage(chromeModel(c, db, config), configView(db, config, modelDiscovery, providers), "Timeout is milliseconds — between 1000 and 600000."),
        400,
      );
    }
    const at = new Date(now()).toISOString();
    db.transaction(() => {
      if (askModel) setSetting(db, SETTING_ASK_MODEL, askModel, at);
      else deleteSetting(db, SETTING_ASK_MODEL);
      if (mapModel) setSetting(db, SETTING_MAP_MODEL, mapModel, at);
      else deleteSetting(db, SETTING_MAP_MODEL);
      if (timeoutRaw) setSetting(db, SETTING_OPENCODE_TIMEOUT, timeoutRaw, at);
      else deleteSetting(db, SETTING_OPENCODE_TIMEOUT);
    })();
    return c.redirect("/config");
  });

  app.post("/config/models/refresh", async (c) => {
    await modelDiscovery.refresh();
    return c.redirect("/config");
  });

  app.post("/config/github-app", async (c) => {
    const body = await c.req.parseBody();
    const appId = typeof body.app_id === "string" ? body.app_id.trim() : "";
    const installationId = typeof body.app_installation_id === "string" ? body.app_installation_id.trim() : "";
    const privateKey = typeof body.app_private_key === "string" ? body.app_private_key.trim() : "";
    const reject = (notice: string) => html(c, configPage(chromeModel(c, db, config), configView(db, config, modelDiscovery, providers), notice), 400);
    if (!appId || !/^\d+$/.test(appId)) return reject("App ID is a number — find it on the app's GitHub settings page.");
    if (installationId && !/^\d+$/.test(installationId)) return reject("Installation ID is a number, or leave it empty to auto-detect.");
    if (privateKey && !privateKey.includes("PRIVATE KEY")) return reject("That does not look like a PEM private key.");
    const at = new Date(now()).toISOString();
    db.transaction(() => {
      setSetting(db, SETTING_APP_ID, appId, at);
      if (installationId) setSetting(db, SETTING_APP_INSTALL, installationId, at);
      else deleteSetting(db, SETTING_APP_INSTALL);
      if (privateKey) setSetting(db, SETTING_APP_KEY, encryptForgeToken(forgeKeySecrets(config)[0], privateKey), at);
    })();
    return c.redirect("/config");
  });

  app.post("/config/github-app/remove", (c) => {
    db.transaction(() => {
      deleteSetting(db, SETTING_APP_ID);
      deleteSetting(db, SETTING_APP_INSTALL);
      deleteSetting(db, SETTING_APP_KEY);
    })();
    return c.redirect("/config");
  });

  const renderConfig = (c: Context<Env>, notice = "", status: ContentfulStatusCode = 200) =>
    html(c, configPage(chromeModel(c, db, config), configView(db, config, modelDiscovery, providers), notice), status);

  app.post("/config/providers/:id", async (c) => {
    const body = await c.req.parseBody();
    const key = typeof body.key === "string" ? body.key : "";
    const result = providers.set(c.req.param("id"), key);
    if (!result.ok) return renderConfig(c, result.error, 400);
    return c.redirect("/config#providers");
  });

  app.post("/config/providers/:id/delete", (c) => {
    const result = providers.delete(c.req.param("id"));
    if (!result.ok) return renderConfig(c, result.error, 400);
    return c.redirect("/config#providers");
  });

  app.post("/config/user", async (c) => {
    const body = await c.req.parseBody();
    const user = typeof body.ui_user === "string" ? body.ui_user.trim() : "";
    if (user && !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(user)) {
      return html(c, configPage(chromeModel(c, db, config), configView(db, config, modelDiscovery, providers), "That is not a GitHub login."), 400);
    }
    if (user) setSetting(db, SETTING_UI_USER, user, new Date(now()).toISOString());
    else deleteSetting(db, SETTING_UI_USER);
    return c.redirect("/config");
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



function connectStatus(error: VerifyError): ContentfulStatusCode {
  return error === "unreachable" ? 502 : 400;
}

const SETTING_ASK_MODEL = "opencode.ask_model";
const SETTING_MAP_MODEL = "opencode.map_model";
const SETTING_APP_ID = "github_app.id";
const SETTING_APP_KEY = "github_app.private_key";
const SETTING_APP_INSTALL = "github_app.installation_id";
const SETTING_SELECTED_REPO = "ui.selected_repo";
const SETTING_UI_USER = "ui.user";
const SETTING_OPENCODE_TIMEOUT = "opencode.timeout_ms";

// Saved setting > env > default — the same precedence as the model fields.
function resolveTimeout(config: Config, db: SqliteDb): { value: number; source: ModelSource; overriddenEnv?: string } {
  const envSet = config.openCodeTimeoutMs !== DEFAULT_OPENCODE_TIMEOUT_MS;
  const stored = getSetting(db, SETTING_OPENCODE_TIMEOUT);
  const parsed = stored ? parseOpenCodeTimeout(stored) : undefined;
  if (parsed) return { value: parsed, source: "stored", overriddenEnv: envSet ? "ERU_OPENCODE_TIMEOUT_MS" : undefined };
  return { value: config.openCodeTimeoutMs, source: envSet ? "env" : "default" };
}

// Who the topbar pill shows: saved login > env login > a plain "operator".
function resolveUser(config: Config, db: SqliteDb): { name: string; source: ModelSource; overriddenEnv?: string } {
  const stored = getSetting(db, SETTING_UI_USER);
  if (stored) return { name: stored, source: "stored", overriddenEnv: config.uiUser ? "ERU_UI_USER" : undefined };
  if (config.uiUser) return { name: config.uiUser, source: "env" };
  return { name: "operator", source: "default" };
}

// The repo the UI acts on: the operator's pick, else the latest connect.
// A stale stored id (repo row gone) falls back to primary.
function selectedRepo(db: SqliteDb): MappedRepo | undefined {
  const stored = getSetting(db, SETTING_SELECTED_REPO);
  if (stored) {
    const repo = getRepo(db, Number(stored));
    if (repo) return repo;
  }
  return getPrimaryRepo(db);
}

type ModelPurpose = "ask" | "map";
type ModelSource = "env" | "stored" | "default";

interface ResolvedGithubApp {
  creds: GithubAppCredentials;
  appIdSource: "env" | "stored";
  installSource: "env" | "stored" | "none";
  keySource: "env" | "stored";
  appIdOverriddenEnv: boolean;
  installOverriddenEnv: boolean;
  keyOverriddenEnv: boolean;
}

// Saved values win per field over env; the stored private key uses the
// same encrypted envelope as forge tokens.
function resolveGithubApp(config: Config, db: SqliteDb): ResolvedGithubApp | null {
  const storedId = getSetting(db, SETTING_APP_ID);
  const storedInstall = getSetting(db, SETTING_APP_INSTALL);
  const storedKey = getSetting(db, SETTING_APP_KEY);
  const appId = storedId ?? config.githubAppId;
  const installationId = storedInstall ?? config.githubAppInstallationId;
  let privateKey: string | undefined;
  let keySource: ResolvedGithubApp["keySource"] | "none" = "none";
  if (storedKey) {
    try {
      privateKey = decryptForgeToken(forgeKeySecrets(config), storedKey);
      keySource = "stored";
    } catch {
      console.log("github app: stored private key unreadable");
    }
  }
  if (!privateKey && config.githubAppPrivateKey) {
    privateKey = config.githubAppPrivateKey;
    keySource = "env";
  }
  if (!appId || !privateKey || keySource === "none") return null;
  return {
    creds: { appId, privateKey, installationId: installationId || undefined },
    appIdSource: storedId ? "stored" : "env",
    installSource: storedInstall ? "stored" : config.githubAppInstallationId ? "env" : "none",
    keySource,
    appIdOverriddenEnv: Boolean(storedId && config.githubAppId),
    installOverriddenEnv: Boolean(storedInstall && config.githubAppInstallationId),
    keyOverriddenEnv: keySource === "stored" && Boolean(config.githubAppPrivateKey),
  };
}

// Forge calls need a token only when the repo asked for one: a stored
// credential, or the GitHub App for repos connected from its repo list.
// Public repos connected anonymously get "".
async function repoToken(
  db: SqliteDb,
  config: Config,
  fetchImpl: FetchLike,
  githubApp: () => GithubAppClient | null,
  repo: { id: number; authSource: string },
): Promise<{ ok: true; token: string } | { ok: false; notice: string }> {
  const stored = getForgeCredential(db, repo.id);
  if (stored) {
    try {
      return { ok: true, token: decryptForgeToken(forgeKeySecrets(config), stored) };
    } catch {
      console.log("token resolve refused: credential unreadable");
      return { ok: false, notice: "The stored forge credential could not be read — reconnect the repo." };
    }
  }
  if (repo.authSource === "app") {
    const client = githubApp();
    if (!client) return { ok: false, notice: "The GitHub App is not configured — check the Config page." };
    const token = await client.installationToken();
    if (!token.ok) {
      console.log(`token resolve refused: ${token.error}`);
      return { ok: false, notice: APP_ERRORS[token.error] };
    }
    return { ok: true, token: token.value };
  }
  return { ok: true, token: "" };
}

// Saved setting > purpose env > general env > OpenCode's own default.
function resolveModel(
  config: Config,
  db: SqliteDb,
  purpose: ModelPurpose,
): { value?: string; source: ModelSource; overriddenEnv?: string } {
  const envSpecific = purpose === "ask" ? config.openCodeAskModel : config.openCodeMapModel;
  const envKey = purpose === "ask" ? "ERU_OPENCODE_ASK_MODEL" : "ERU_OPENCODE_MAP_MODEL";
  const stored = getSetting(db, purpose === "ask" ? SETTING_ASK_MODEL : SETTING_MAP_MODEL);
  if (stored) {
    return { value: stored, source: "stored", overriddenEnv: envSpecific ? envKey : config.openCodeModel ? "ERU_OPENCODE_MODEL" : undefined };
  }
  if (envSpecific) return { value: envSpecific, source: "env" };
  if (config.openCodeModel) return { value: config.openCodeModel, source: "env" };
  return { source: "default" };
}

function modelRow(
  label: string,
  field: string,
  envKey: string,
  resolved: { value?: string; source: ModelSource; overriddenEnv?: string },
  stored: string,
): ConfigView["ask"] {
  return { label, field, envKey, effective: resolved.value ?? "", source: resolved.source, stored, overriddenEnv: resolved.overriddenEnv };
}

function configView(db: SqliteDb, config: Config, discovery: ModelDiscovery, providers: ProviderCredentialStore): ConfigView {
  const app = resolveGithubApp(config, db);
  const storedAppId = getSetting(db, SETTING_APP_ID) ?? "";
  const storedInstall = getSetting(db, SETTING_APP_INSTALL) ?? "";
  const timeout = resolveTimeout(config, db);
  return {
    bin: config.openCodeBin,
    timeout: {
      label: "OpenCode timeout",
      field: "timeout_ms",
      envKey: "ERU_OPENCODE_TIMEOUT_MS",
      effective: `${timeout.value} ms`,
      source: timeout.source,
      stored: getSetting(db, SETTING_OPENCODE_TIMEOUT) ?? "",
      overriddenEnv: timeout.overriddenEnv,
    },
    app: {
      appId: app?.creds.appId ?? "",
      installationId: app?.creds.installationId ?? "",
      appIdSource: app?.appIdSource ?? "default",
      installSource: app?.installSource === "none" || app === null ? "default" : app.installSource,
      keySource: app?.keySource ?? "default",
      storedAppId,
      storedInstall,
      hasStoredKey: Boolean(getSetting(db, SETTING_APP_KEY)),
      appIdOverriddenEnv: app?.appIdOverriddenEnv ?? false,
      installOverriddenEnv: app?.installOverriddenEnv ?? false,
      keyOverriddenEnv: app?.keyOverriddenEnv ?? false,
    },
    user: (() => {
      const u = resolveUser(config, db);
      return {
        label: "Operator name",
        field: "ui_user",
        envKey: "ERU_UI_USER",
        effective: u.name,
        source: u.source,
        stored: getSetting(db, SETTING_UI_USER) ?? "",
        overriddenEnv: u.overriddenEnv,
      };
    })(),
    ask: modelRow(
      "Ask model",
      "ask_model",
      "ERU_OPENCODE_ASK_MODEL",
      resolveModel(config, db, "ask"),
      getSetting(db, SETTING_ASK_MODEL) ?? "",
    ),
    map: modelRow(
      "Map model",
      "map_model",
      "ERU_OPENCODE_MAP_MODEL",
      resolveModel(config, db, "map"),
      getSetting(db, SETTING_MAP_MODEL) ?? "",
    ),
    discovered: discovery.snapshot(),
    providers: providers.list(),
    authPath: providers.path,
  };
}

async function refreshNotice(
  db: SqliteDb,
  config: Config,
  fetchImpl: FetchLike,
  refresh: RefreshRunner,
  now: () => number,
  githubAppFactory: () => GithubAppClient | null,
  repo: MappedRepo,
): Promise<{ ok: boolean; notice: string }> {
  const started = now();
  const label = `${repo.owner}/${repo.name}`;
  const resolved = await repoToken(db, config, fetchImpl, githubAppFactory, repo);
  if (!resolved.ok) return { ok: false, notice: resolved.notice };
  const token = resolved.token;
  console.log(`refresh ${label}: forge token resolved (${token ? "credential" : "anonymous"})`);

  // Always re-map the default branch: the one recorded at connect, else
  // main (master) for repos connected before it was stored.
  const candidates = repo.defaultBranch ? [repo.defaultBranch] : ["main", "master"];
  let ref = "";
  let tarball: TarballResult | undefined;
  for (const candidate of candidates) {
    if (!isValidMapRef(candidate)) {
      console.log(`refresh ${label}: stored default branch is not a valid ref — ${candidate}`);
      return { ok: false, notice: "The stored default branch does not look like a ref." };
    }
    console.log(`refresh ${label} @${candidate}: fetching checkout tarball`);
    tarball = await fetchRepoTarball(repo.owner, repo.name, candidate, token, fetchImpl);
    if (tarball.ok) {
      console.log(`refresh ${label} @${candidate}: tarball ok — ${Math.round(tarball.data.length / 1024)} KiB`);
      ref = candidate;
      break;
    }
    console.log(`refresh ${label} @${candidate}: tarball refused — ${tarball.error}`);
    if (tarball.error !== "notfound") {
      return { ok: false, notice: REFRESH_TARBALL_ERRORS[tarball.error] };
    }
  }
  if (!tarball || !tarball.ok) {
    return { ok: false, notice: REFRESH_TARBALL_ERRORS.notfound };
  }

  const workdir = await mkdtemp(joinPath(tmpdir(), "eru-map-"));
  try {
    await extractTarball(tarball.data, workdir);
  } catch (err) {
    console.log(`refresh ${label} @${ref}: could not unpack the checkout —`, err instanceof Error ? err.message : err);
    return { ok: false, notice: "Could not unpack the checkout — refresh failed." };
  }
  console.log(`refresh ${label} @${ref}: checkout extracted — starting OpenCode`);

  try {
    const result = await refresh(
      joinPath(workdir, "checkout"),
      `${repo.owner}/${repo.name}`,
      ref,
      resolveModel(config, db, "map").value,
    );
    if (!result.ok) {
      console.log(`refresh failed: ${result.error}`);
      if (result.error === "unconfigured") {
        return { ok: false, notice: "OpenCode is not configured on this host (check ERU_OPENCODE_BIN)." };
      }
      const detail = result.detail ? ` — ${result.detail.slice(-160)}` : " — check the service log.";
      if (result.error === "nomap") {
        return { ok: false, notice: `OpenCode did not return map pages${detail}` };
      }
      return { ok: false, notice: `OpenCode could not map the checkout${detail}` };
    }
    const at = new Date(now()).toISOString();
    db.transaction(() => {
      for (const page of result.pages) {
        upsertPage(db, repo.id, { ...page, mappedRef: ref }, at);
      }
      setLastMapped(db, repo.id, ref, at);
    })();
    console.log(`mapped ${repo.owner}/${repo.name} @${ref}: ${result.pages.length} pages in ${Math.round((now() - started) / 1000)}s`);
    return { ok: true, notice: `Mapped @${ref} — ${result.pages.length} page${result.pages.length === 1 ? "" : "s"}.` };
  } finally {
    await rm(workdir, { recursive: true, force: true }).catch(() => {});
  }
}

async function askNotice(db: SqliteDb, config: Config, ask: AskRunner, q: string): Promise<string> {
  if (!q) return "Ask something first.";
  if (q.length > ASK_MAX_QUESTION) return `Keep questions under ${ASK_MAX_QUESTION} characters.`;
  const repo = selectedRepo(db);
  if (!repo) return "Connect a repo before asking.";
  const pages = listAllPages(db, repo.id);
  if (pages.length === 0) return "The map has no pages yet — refresh the map first.";
  const result = await ask(q, pages, `${repo.owner}/${repo.name}`, resolveModel(config, db, "ask").value);
  if (result.ok) return result.answer || "OpenCode returned an empty answer.";
  console.log(`ask refused: ${result.error}`);
  if (result.error === "unconfigured") return "OpenCode is not configured on this host (check ERU_OPENCODE_BIN).";
  const detail = result.detail ? ` — ${result.detail.slice(-160)}` : " — check the service log.";
  return `OpenCode could not answer${detail}`;
}

function chromeModel(
  c: Context<Env>,
  db: SqliteDb,
  config: Config,
  slug?: string,
  askNotice?: string,
  refreshNotice?: string,
): ChromeModel {
  const session = c.get("session");
  if (!session) throw new Error("eru: missing session");
  const repo = selectedRepo(db);
  const pages = repo ? listPages(db, repo.id) : [];
  const page = repo && (slug || pages.length > 0) ? getPage(db, repo.id, slug ?? pages[0].slug) ?? null : null;
  const user = resolveUser(config, db);
  // A GitHub-logged-in session knows its real login and avatar; it wins over
  // the stored/env display name.
  const gh = session.github;
  return {
    user: {
      name: gh?.login ?? user.name,
      avatarUrl: gh
        ? (gh.avatarUrl ?? `https://github.com/${encodeURIComponent(gh.login)}.png?size=64`)
        : user.source === "default"
          ? null
          : `https://github.com/${encodeURIComponent(user.name)}.png?size=64`,
    },
    repo: repo
      ? {
          id: repo.id,
          owner: repo.owner,
          name: repo.name,
          defaultBranch: repo.defaultBranch,
          lastMappedRef: repo.lastMappedRef,
          lastMappedLabel: repo.lastMappedAt ?? "never",
        }
      : null,
    repos: listConnectedRepos(db).map((r) => ({ id: r.id, owner: r.owner, name: r.name })),
    path: new URL(c.req.url).pathname,
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

function loadPublicAsset(name: string): ArrayBuffer {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, "assets", name),
    join(process.cwd(), "dist", "assets", name),
    join(process.cwd(), "assets", name),
    join(here, "..", "assets", name),
  ];
  for (const path of candidates) {
    if (existsSync(path)) return Uint8Array.from(readFileSync(path)).buffer;
  }
  throw new Error(`eru: ${name} is missing`);
}
