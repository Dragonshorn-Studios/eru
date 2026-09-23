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
  askRunner?: AskRunner;
  refreshRunner?: RefreshRunner;
  modelDiscovery?: ModelDiscovery;
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
  const modelDiscovery =
    opts.modelDiscovery ?? createModelDiscovery({ bin: config.openCodeBin, timeoutMs: config.openCodeTimeoutMs });
  void modelDiscovery.refresh();

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

  app.get("/connect", async (c) => html(c, connectPage(chromeModel(c, db), "", {}, await appRepoList())));

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
      html(c, connectPage(chromeModel(c, db), error, { owner, name }, await appRepoList()), status);
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
    return html(c, appPage(chromeModel(c, db, undefined, notice)));
  });

  app.post("/refresh", async (c) => {
    const body = await c.req.parseBody();
    const ref = typeof body.ref === "string" ? body.ref.trim() : "";
    const notice = await refreshNotice(db, config, fetchImpl, refresh, ref, now, githubApp);
    if (c.req.header("HX-Request") === "true") {
      c.header("Content-Type", "text/html; charset=utf-8");
      return c.body(refreshResultFragment(notice));
    }
    return html(c, appPage(chromeModel(c, db, undefined, undefined, notice)));
  });

  app.get("/config", (c) => html(c, configPage(chromeModel(c, db), configView(db, config, modelDiscovery))));

  app.post("/config/models", async (c) => {
    const body = await c.req.parseBody();
    const askModel = typeof body.ask_model === "string" ? body.ask_model.trim() : "";
    const mapModel = typeof body.map_model === "string" ? body.map_model.trim() : "";
    if ((askModel && !isValidModelName(askModel)) || (mapModel && !isValidModelName(mapModel))) {
      return html(
        c,
        configPage(chromeModel(c, db), configView(db, config, modelDiscovery), "That is not a model name."),
        400,
      );
    }
    const at = new Date(now()).toISOString();
    db.transaction(() => {
      if (askModel) setSetting(db, SETTING_ASK_MODEL, askModel, at);
      else deleteSetting(db, SETTING_ASK_MODEL);
      if (mapModel) setSetting(db, SETTING_MAP_MODEL, mapModel, at);
      else deleteSetting(db, SETTING_MAP_MODEL);
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
    const reject = (notice: string) => html(c, configPage(chromeModel(c, db), configView(db, config, modelDiscovery), notice), 400);
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
}

// Env wins per field over what /config saved; the stored private key uses the
// same encrypted envelope as forge tokens.
function resolveGithubApp(config: Config, db: SqliteDb): ResolvedGithubApp | null {
  const storedId = getSetting(db, SETTING_APP_ID);
  const storedInstall = getSetting(db, SETTING_APP_INSTALL);
  const storedKey = getSetting(db, SETTING_APP_KEY);
  const appId = config.githubAppId ?? storedId;
  const installationId = config.githubAppInstallationId ?? storedInstall;
  let privateKey = config.githubAppPrivateKey;
  let keySource: ResolvedGithubApp["keySource"] | "none" = privateKey ? "env" : "none";
  if (!privateKey && storedKey) {
    try {
      privateKey = decryptForgeToken(forgeKeySecrets(config), storedKey);
      keySource = "stored";
    } catch {
      console.log("github app: stored private key unreadable");
    }
  }
  if (!appId || !privateKey || keySource === "none") return null;
  return {
    creds: { appId, privateKey, installationId: installationId || undefined },
    appIdSource: config.githubAppId ? "env" : "stored",
    installSource: config.githubAppInstallationId ? "env" : storedInstall ? "stored" : "none",
    keySource,
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

// Purpose env > saved setting > general env > OpenCode's own default.
function resolveModel(config: Config, db: SqliteDb, purpose: ModelPurpose): { value?: string; source: ModelSource } {
  const envSpecific = purpose === "ask" ? config.openCodeAskModel : config.openCodeMapModel;
  if (envSpecific) return { value: envSpecific, source: "env" };
  const stored = getSetting(db, purpose === "ask" ? SETTING_ASK_MODEL : SETTING_MAP_MODEL);
  if (stored) return { value: stored, source: "stored" };
  if (config.openCodeModel) return { value: config.openCodeModel, source: "env" };
  return { source: "default" };
}

function modelRow(
  label: string,
  field: string,
  envKey: string,
  resolved: { value?: string; source: ModelSource },
  stored: string,
): ConfigView["ask"] {
  return { label, field, envKey, effective: resolved.value ?? "", source: resolved.source, stored };
}

function configView(db: SqliteDb, config: Config, discovery: ModelDiscovery): ConfigView {
  const app = resolveGithubApp(config, db);
  const storedAppId = getSetting(db, SETTING_APP_ID) ?? "";
  const storedInstall = getSetting(db, SETTING_APP_INSTALL) ?? "";
  return {
    bin: config.openCodeBin,
    timeoutMs: config.openCodeTimeoutMs,
    app: {
      appId: app?.creds.appId ?? "",
      installationId: app?.creds.installationId ?? "",
      appIdSource: app?.appIdSource ?? "default",
      installSource: app?.installSource === "none" || app === null ? "default" : app.installSource,
      keySource: app?.keySource ?? "default",
      storedAppId,
      storedInstall,
      hasStoredKey: Boolean(getSetting(db, SETTING_APP_KEY)),
    },
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
  };
}

async function refreshNotice(
  db: SqliteDb,
  config: Config,
  fetchImpl: FetchLike,
  refresh: RefreshRunner,
  ref: string,
  now: () => number,
  githubAppFactory: () => GithubAppClient | null,
): Promise<string> {
  if (!ref) return "Pick a ref or SHA first.";
  if (!isValidMapRef(ref)) return "That ref does not look right.";
  const repo = selectedRepo(db);
  if (!repo) return "Connect a repo before refreshing.";
  const resolved = await repoToken(db, config, fetchImpl, githubAppFactory, repo);
  if (!resolved.ok) return resolved.notice;
  const token = resolved.token;

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
    const result = await refresh(
      joinPath(workdir, "checkout"),
      `${repo.owner}/${repo.name}`,
      ref,
      resolveModel(config, db, "map").value,
    );
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
  const repo = selectedRepo(db);
  const pages = repo ? listPages(db, repo.id) : [];
  const page = repo && (slug || pages.length > 0) ? getPage(db, repo.id, slug ?? pages[0].slug) ?? null : null;
  return {
    repo: repo
      ? {
          id: repo.id,
          owner: repo.owner,
          name: repo.name,
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
