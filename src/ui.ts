import { CSRF_FIELD } from "./auth.js";
import { OPENCODE_TIMEOUT_MAX_MS, OPENCODE_TIMEOUT_MIN_MS } from "./config.js";
import type { MapPage, PageTocEntry } from "./db.js";
import type { AppError, AppRepo, TarballError, VerifyError } from "./forge.js";
import { ASK_MAX_QUESTION } from "./opencode.js";
import { ASK_AGENT } from "./askthreads.js";
import { THEME_CSS } from "./theme.js";
import type { ProviderCredentialStatus } from "./providers.js";
import { escapeHtml } from "./util.js";

export interface ChromeRepo {
  id: number;
  owner: string;
  name: string;
}

export interface ChromeModel {
  repo: {
    id: number;
    owner: string;
    name: string;
    defaultBranch: string | null;
    lastMappedRef: string | null;
    lastMappedLabel: string;
  } | null;
  repos: ChromeRepo[];
  user: { name: string; avatarUrl: string | null };
  path: string;
  csrf: string;
  pages: PageTocEntry[];
  page: MapPage | null;
  /** A map refresh is in flight for the selected repo (survives navigation). */
  mapping?: boolean;
  refreshNotice?: string;
}

function csrfInput(token: string): string {
  return `<input type="hidden" name="${CSRF_FIELD}" value="${escapeHtml(token)}"/>`;
}

function layout(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <meta name="theme-color" content="#F7F5F0"/>
  <title>${escapeHtml(title)}</title>
  <link rel="icon" href="/favicon.ico" sizes="any"/>
  <link rel="icon" type="image/png" href="/assets/favicon-32.png" sizes="32x32"/>
  <link rel="apple-touch-icon" href="/assets/apple-touch-icon.png"/>
  <link rel="stylesheet" href="/assets/eru.css"/>
  <script src="/assets/htmx.min.js" defer></script>
</head>
${body}
</html>`;
}

function topbar(model: ChromeModel): string {
  let repoPill: string;
  if (model.repos.length > 1) {
    const options = model.repos
      .map(
        (r) =>
          `<option value="${r.id}"${model.repo?.id === r.id ? " selected" : ""}>${escapeHtml(r.owner)} / ${escapeHtml(r.name)}</option>`,
      )
      .join("");
    repoPill = `<form class="repo-switch" method="post" action="/repo/select">
        ${csrfInput(model.csrf)}
        <label class="sr-only" for="repo_id">Repository</label>
        <select id="repo_id" name="repo_id" onchange="this.form.requestSubmit()">${options}</select>
        <noscript><button class="link-button" type="submit">switch</button></noscript>
      </form>`;
  } else if (model.repo) {
    repoPill = `<span class="pill">${escapeHtml(model.repo.owner)} / ${escapeHtml(model.repo.name)}</span>`;
  } else {
    repoPill = `<a class="pill pill-link" href="/connect">connect a repo</a>`;
  }
  const addPill = model.repo
    ? `<a class="pill pill-link pill-add" href="/connect" title="Connect another repo" aria-label="Connect another repo"><svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg></a>`
    : "";
  const mapped = model.repo
    ? model.repo.lastMappedRef
      ? `<span class="mapped">last mapped @${escapeHtml(model.repo.lastMappedRef)}</span>`
      : `<span class="mapped">not mapped yet</span>`
    : "";
  return `<header class="topbar">
      <a class="brand" href="/">
        <img class="seal" src="/assets/eru-icon.png" width="42" height="42" alt=""/>
        <h1>Eru</h1>
      </a>
      ${repoPill}
      ${addPill}
      ${mapped}
      <span class="grow"></span>
      <a class="pill pill-link" href="/config">Config</a>
      <span class="user-pill">
        ${model.user.avatarUrl ? `<img class="avatar" src="${escapeHtml(model.user.avatarUrl)}" alt="" width="24" height="24"/>` : `<span class="avatar avatar-mono" aria-hidden="true">${escapeHtml(model.user.name.slice(0, 2))}</span>`}
        <span class="user-name">${escapeHtml(model.user.name)}</span>
        <form method="post" action="/logout">${csrfInput(model.csrf)}<button class="logout" type="submit" title="Log out">log out</button></form>
      </span>
    </header>`;
}

const TABS = [
  { key: "brief", href: "/", label: "Brief" },
  { key: "ask", href: "/ask", label: "Ask" },
] as const;

function isTabActive(key: string, path: string): boolean {
  if (key === "ask") return path === "/ask";
  return path === "/" || path.startsWith("/brief");
}

function masthead(model: ChromeModel): string {
  const tabs = TABS.map(
    (tab) =>
      `<a class="tab" href="${tab.href}"${isTabActive(tab.key, model.path) ? ' aria-current="page"' : ""}>${tab.label}</a>`,
  ).join("");
  return `<div class="masthead">
      <p class="tagline">lasting OpenCode notes — not a checkout job, not DeepWiki.com</p>
      <nav class="tabs" aria-label="Sections">${tabs}</nav>
    </div>`;
}

function foot(model: ChromeModel): string {
  return `<footer class="foot">
      <span>Last mapped: ${escapeHtml(model.repo?.lastMappedLabel ?? "never")}</span>
      <span class="sep">|</span>
      <a href="/">Explore</a>
      <span class="sep">|</span>
      <a href="/connect">Connect</a>
      <span class="sep">|</span>
      <span>Archive</span>
      <span class="sep">|</span>
      <span>Inspire</span>
      <span class="sep">|</span>
      <span>About</span>
    </footer>`;
}

const ROMAN = ["I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X"] as const;

function numeral(index: number): string {
  return ROMAN[index] ?? String(index + 1);
}

export interface LoginPageOptions {
  error?: string;
  /** GitHub OAuth is configured — show the provider button. */
  showGithub?: boolean;
  /** Password form shown (password gate on, or ERU_UI_LOCAL_LOGIN alongside OAuth). */
  showPassword?: boolean;
  next?: string;
}

export function loginPage(opts: LoginPageOptions = {}): string {
  const flash = opts.error ? `<p class="flash" role="alert">${escapeHtml(opts.error)}</p>` : "";
  const nextQuery = opts.next ? `?next=${encodeURIComponent(opts.next)}` : "";
  const githubBtn = opts.showGithub
    ? `<a class="enter github-enter" href="/login/github${nextQuery}"><svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="currentColor"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z"/></svg> Sign in with GitHub</a>`
    : "";
  const passwordForm =
    opts.showPassword === false
      ? ""
      : `${opts.showGithub ? `<p class="gate-or"><span>or</span></p>` : ""}
      <form class="gate-form" method="post" action="/login${nextQuery}" autocomplete="off">
        <label class="sr-only" for="password">Password</label>
        <input id="password" type="password" name="password" required autofocus autocomplete="current-password"/>
        <button class="enter" type="submit">Enter</button>
      </form>`;
  return layout(
    "Eru — operator gate",
    `<body>
  <a class="skip" href="#main">Skip to content</a>
  <main id="main" class="gate">
    <section class="card gate-card">
      <img class="seal" src="/assets/eru-icon.png" width="56" height="56" alt=""/>
      <h1>Eru</h1>
      <p class="lede">I'm curious about this repo.</p>
      ${flash}
      ${githubBtn}
      ${passwordForm}
    </section>
  </main>
</body>`,
  );
}

export const CONNECT_ERRORS: Record<VerifyError, string> = {
  invalid: "Owner or repo name is not valid.",
  notfound: "Could not uniquely resolve that repository. Check owner and name.",
  auth: "The forge token cannot read that repository, or the request was rate limited. Use a least-privilege token for this repo.",
  unreachable: "Could not reach the forge. Try again in a moment.",
};

export interface ConfigModelRow {
  label: string;
  field: string;
  envKey: string;
  effective: string;
  source: "env" | "stored" | "default";
  stored: string;
  /** Env var set but shadowed by the saved value. */
  overriddenEnv?: string;
}

export interface ConfigAppView {
  appId: string;
  installationId: string;
  appIdSource: "env" | "stored" | "default";
  installSource: "env" | "stored" | "default";
  keySource: "env" | "stored" | "default";
  storedAppId: string;
  storedInstall: string;
  hasStoredKey: boolean;
  appIdOverriddenEnv: boolean;
  installOverriddenEnv: boolean;
  keyOverriddenEnv: boolean;
}

export interface ConfigView {
  bin: string;
  timeout: ConfigModelRow;
  app: ConfigAppView;
  user: ConfigModelRow;
  ask: ConfigModelRow;
  map: ConfigModelRow;
  discovered: { models: string[]; error?: string; updatedAt?: string };
  providers: ProviderCredentialStatus[];
  authPath: string;
}

export const APP_ERRORS: Record<AppError, string> = {
  invalid: "The GitHub App private key could not be read — check the PEM.",
  auth: "GitHub refused the app credentials. Check the App ID and private key.",
  unreachable: "Could not reach GitHub. Try again in a moment.",
  noinstall: "The GitHub App has no installations — install it on an account first.",
  ambiguous: "The GitHub App is installed on several accounts — set an installation ID on the Config page.",
};

function modelSourceHint(row: ConfigModelRow): string {
  if (row.source === "env") return `in effect from <code>${escapeHtml(row.envKey)}</code>`;
  if (row.source === "stored") {
    return row.overriddenEnv ? `saved on this page · overrides <code>${escapeHtml(row.overriddenEnv)}</code>` : "saved on this page";
  }
  return "OpenCode default";
}

// A picker, not a textbox: discovered models plus the saved one if it is not
// in the discovered list. Free-form ids still work via the env var.
function configModelField(row: ConfigModelRow, discovered: string[], keyedProviders: ReadonlySet<string>): string {
  const options = [`<option value=""${row.stored === "" ? " selected" : ""}>OpenCode default</option>`];
  for (const m of discovered) {
    const keyed = keyedProviders.has(m.split("/")[0] ?? "") ? " · key set" : "";
    options.push(`<option value="${escapeHtml(m)}"${row.stored === m ? " selected" : ""}>${escapeHtml(m)}${keyed}</option>`);
  }
  if (row.stored && !discovered.includes(row.stored)) {
    options.push(`<option value="${escapeHtml(row.stored)}" selected>${escapeHtml(row.stored)} · saved</option>`);
  }
  return `<label class="field">
    <span>${escapeHtml(row.label)} <span class="field-hint">in effect: ${escapeHtml(row.effective || "opencode default")} · ${modelSourceHint(row)}</span></span>
    <select name="${row.field}">${options.join("")}</select>
    <span class="field-hint"><code>${escapeHtml(row.envKey)}</code> in .env is used when nothing is saved here</span>
  </label>`;
}

// The timeout is a number field, not a picker — same saved > env > default
// hints as the model rows.
function configTimeoutField(row: ConfigModelRow): string {
  return `<label class="field">
    <span>${escapeHtml(row.label)} <span class="field-hint">in effect: ${escapeHtml(row.effective)} · ${modelSourceHint(row)}</span></span>
    <input type="text" name="${escapeHtml(row.field)}" inputmode="numeric" maxlength="6" value="${escapeHtml(row.stored)}" placeholder="${escapeHtml(row.effective)}"/>
    <span class="field-hint">milliseconds, ${OPENCODE_TIMEOUT_MIN_MS}–${OPENCODE_TIMEOUT_MAX_MS} · <code>${escapeHtml(row.envKey)}</code> in .env is used when nothing is saved here</span>
  </label>`;
}

function providerBadge(provider: ProviderCredentialStatus): string {
  if (provider.source === "environment") {
    return `<span class="badge badge-env">key from env <code>${escapeHtml(provider.envVar ?? "")}</code></span>`;
  }
  if (provider.source === "stored") {
    const overridden = provider.overridesEnvVar ? ` · overrides <code>${escapeHtml(provider.overridesEnvVar)}</code>` : "";
    return `<span class="badge badge-stored">stored in auth.json ···${escapeHtml(provider.fingerprint ?? "")}${overridden}</span>`;
  }
  return `<span class="badge badge-none">no key</span>`;
}

function providerCard(provider: ProviderCredentialStatus, csrf: string): string {
  const actionId = escapeHtml(encodeURIComponent(provider.id));
  const stored = provider.source === "stored";
  const help = provider.helpUrl
    ? `<p class="field-hint">${escapeHtml(provider.helpLabel ?? "Get a key")}: <a href="${escapeHtml(provider.helpUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(provider.helpUrl.replace(/^https?:\/\//, ""))}</a></p>`
    : "";
  const envNote =
    provider.source === "environment"
      ? `<p class="field-hint">the env var is used until a key is saved here</p>`
      : "";
  return `<li class="provider-card" data-provider="${escapeHtml(`${provider.id} ${provider.label}`.toLowerCase())}">
      <div class="provider-head">
        <div><span class="provider-id">${escapeHtml(provider.id)}</span><h4>${escapeHtml(provider.label)}</h4></div>
        ${providerBadge(provider)}
      </div>
      ${help}
      ${envNote}
      <form class="provider-key-form" method="post" action="/config/providers/${actionId}">
        ${csrfInput(csrf)}
        <input type="password" name="key" required autocomplete="off" minlength="4"
          placeholder="${stored ? "Replace stored key" : "Paste API key"}"
          aria-label="API key for ${escapeHtml(provider.label)}"/>
        <button class="enter provider-save" type="submit">${stored ? "Replace" : "Save"}</button>
        ${stored ? `<button class="link-button" type="submit" formaction="/config/providers/${actionId}/delete" formnovalidate>Remove</button>` : ""}
      </form>
    </li>`;
}

const CONFIG_SECTIONS = [
  { id: "models", label: "OpenCode models" },
  { id: "providers", label: "Provider keys" },
  { id: "github-app", label: "GitHub App" },
  { id: "operator", label: "Operator" },
] as const;

export function configPage(model: ChromeModel, view: ConfigView, notice = ""): string {
  const flash = notice ? `<p class="flash" role="alert">${escapeHtml(notice)}</p>` : "";
  const keyedProviders = new Set(
    view.providers.filter((p) => p.source === "stored" || p.source === "environment").map((p) => p.id),
  );
  const discoveredLine = view.discovered.error
    ? `model list unavailable — ${escapeHtml(view.discovered.error)}`
    : view.discovered.models.length > 0
      ? `${view.discovered.models.length} models discovered${view.discovered.updatedAt ? ` · ${escapeHtml(view.discovered.updatedAt)}` : ""}`
      : "no models discovered yet — press Refresh model list once OpenCode is configured";
  const nav = CONFIG_SECTIONS.map((s) => `<li><a href="#${s.id}">${s.label}</a></li>`).join("");
  const providerRows = view.providers.map((p) => providerCard(p, model.csrf)).join("");
  return layout(
    "Eru — config",
    `<body>
  <a class="skip" href="#main">Skip to content</a>
  <div class="shell">
    ${topbar(model)}
    <main id="main" class="stage config-stage">
      <aside class="card config-nav" aria-label="Config sections">
        <p class="kicker">Config</p>
        <nav><ul class="toc">${nav}</ul></nav>
      </aside>
      <section class="card config-card">
        <h2>Config</h2>
        <p class="page-lead">Saved values win over environment variables — clear a saved field to fall back to <code>.env</code> or the default.</p>
        ${flash}
        <h3 id="models">OpenCode models</h3>
        <p class="mapped">binary <code>${escapeHtml(view.bin)}</code> — change <code>ERU_OPENCODE_BIN</code> in .env</p>
        <form class="connect-form" method="post" action="/config/models" autocomplete="off">
          ${csrfInput(model.csrf)}
          ${configModelField(view.ask, view.discovered.models, keyedProviders)}
          ${configModelField(view.map, view.discovered.models, keyedProviders)}
          ${configTimeoutField(view.timeout)}
          <button class="enter" type="submit">Save models</button>
        </form>
        <form class="config-refresh" method="post" action="/config/models/refresh">
          ${csrfInput(model.csrf)}
          <button class="refresh-run" type="submit">Refresh model list</button>
          <span class="field-hint">${discoveredLine}</span>
        </form>
        <h3 id="providers">Provider API keys</h3>
        <p class="mapped">written to OpenCode's credential file <code>${escapeHtml(view.authPath)}</code> — never the eru database. Keys are write-only; a saved key overrides the env var. OAuth providers still enroll with <code>opencode auth login</code>.</p>
        <p class="provider-filter"><input type="search" id="provider-filter" placeholder="filter providers…" aria-label="Filter providers"/><span class="field-hint" id="provider-filter-empty" hidden>No providers match.</span></p>
        <ul class="provider-list" id="provider-list">${providerRows}</ul>
        <script>
        (() => {
          const input = document.getElementById("provider-filter");
          const empty = document.getElementById("provider-filter-empty");
          const cards = document.querySelectorAll("#provider-list [data-provider]");
          if (!input || !empty) return;
          input.addEventListener("input", () => {
            const q = input.value.trim().toLowerCase();
            let visible = 0;
            for (const card of cards) {
              const show = !q || card.getAttribute("data-provider").includes(q);
              card.style.display = show ? "" : "none";
              if (show) visible += 1;
            }
            empty.hidden = visible !== 0;
          });
        })();
        </script>
        <h3 id="github-app">GitHub App</h3>
        <p class="mapped">lists installable repos on Connect and mints tokens for refresh — <code>ERU_GITHUB_APP_ID</code> · <code>ERU_GITHUB_APP_PRIVATE_KEY</code>/<code>_FILE</code> · <code>ERU_GITHUB_APP_INSTALLATION_ID</code></p>
        <form class="connect-form" method="post" action="/config/github-app" autocomplete="off">
          ${csrfInput(model.csrf)}
          <label class="field">
            <span>App ID <span class="field-hint">${appFieldHint(view.app.appId, view.app.appIdSource, "ERU_GITHUB_APP_ID", "required", view.app.appIdOverriddenEnv)}</span></span>
            <input type="text" name="app_id" inputmode="numeric" maxlength="20" value="${escapeHtml(view.app.storedAppId)}" placeholder="${escapeHtml(view.app.appId || "123456")}"/>
            <span class="field-hint"><code>ERU_GITHUB_APP_ID</code> in .env is used when nothing is saved here</span>
          </label>
          <label class="field">
            <span>Installation ID <span class="field-hint">${appFieldHint(view.app.installationId, view.app.installSource, "ERU_GITHUB_APP_INSTALLATION_ID", "auto-detect", view.app.installOverriddenEnv)}</span></span>
            <input type="text" name="app_installation_id" inputmode="numeric" maxlength="20" value="${escapeHtml(view.app.storedInstall)}" placeholder="${escapeHtml(view.app.installationId || "auto-detect")}"/>
            <span class="field-hint">leave empty to auto-detect a single installation</span>
          </label>
          <label class="field">
            <span>Private key <span class="field-hint">${appKeyHint(view.app)}</span></span>
            <textarea name="app_private_key" rows="4" spellcheck="false" autocomplete="off" placeholder="-----BEGIN RSA PRIVATE KEY-----"></textarea>
            <span class="field-hint">write-only — stored encrypted; leave empty to keep the saved key · env: <code>ERU_GITHUB_APP_PRIVATE_KEY</code> or <code>ERU_GITHUB_APP_PRIVATE_KEY_FILE</code></span>
          </label>
          <button class="enter" type="submit">Save GitHub App</button>
        </form>
        ${view.app.hasStoredKey || view.app.storedAppId || view.app.storedInstall ? `<form class="config-refresh" method="post" action="/config/github-app/remove">${csrfInput(model.csrf)}<button class="link-button" type="submit">Remove saved app config</button></form>` : ""}
        <h3 id="operator">Operator</h3>
        <p class="mapped">the name (and GitHub avatar) shown in the top bar — <code>ERU_UI_USER</code></p>
        <form class="connect-form" method="post" action="/config/user" autocomplete="off">
          ${csrfInput(model.csrf)}
          <label class="field">
            <span>GitHub login <span class="field-hint">in effect: ${escapeHtml(view.user.effective)} · ${modelSourceHint(view.user)}</span></span>
            <input type="text" name="ui_user" maxlength="39" value="${escapeHtml(view.user.stored)}" placeholder="${escapeHtml(view.user.effective === "operator" ? "github login (blank = operator)" : view.user.effective)}"/>
            <span class="field-hint">shows your github.com avatar; leave empty for a monogram · <code>ERU_UI_USER</code> in .env is used when nothing is saved here</span>
          </label>
          <button class="enter" type="submit">Save operator</button>
        </form>
      </section>
    </main>
    ${foot(model)}
  </div>
</body>`,
  );
}

export const REFRESH_TARBALL_ERRORS: Record<TarballError, string> = {
  invalid: "That ref does not look right.",
  notfound: "The forge could not find that ref or SHA. Check it and try again.",
  auth: "The forge token cannot read that repository. Reconnect with a least-privilege token.",
  unreachable: "Could not reach the forge. Try again in a moment.",
  toobig: "That checkout is too large to map.",
};

function appFieldHint(
  effective: string,
  source: ConfigAppView["appIdSource"],
  envKey: string,
  fallback = "required",
  overriddenEnv = false,
): string {
  if (source === "env") return `in effect from <code>${escapeHtml(envKey)}</code>`;
  if (source === "stored") {
    return overriddenEnv ? `saved on this page · overrides <code>${escapeHtml(envKey)}</code>` : "saved on this page";
  }
  return escapeHtml(fallback);
}

function appKeyHint(app: ConfigAppView): string {
  if (app.keySource === "env") {
    return app.hasStoredKey ? "key comes from env — saved key is unreadable" : "key comes from env";
  }
  if (app.hasStoredKey) {
    return app.keyOverriddenEnv ? "key saved on this page · overrides env key" : "key saved on this page";
  }
  return "no key saved";
}

function appRepoSection(appList: { repos: AppRepo[] } | { error: string } | null | undefined, csrf: string): string {
  if (!appList) return "";
  if ("error" in appList) {
    return `<h3>From your GitHub App</h3>
        <p class="field-hint">repo list unavailable — ${escapeHtml(appList.error)}</p>`;
  }
  if (appList.repos.length === 0) {
    return `<h3>From your GitHub App</h3>
        <p class="field-hint">the installation can see no repositories — grant it access on GitHub first</p>`;
  }
  const items = appList.repos
    .map(
      (repo) => `<li>
          <form method="post" action="/connect/app">
            ${csrfInput(csrf)}
            <input type="hidden" name="owner" value="${escapeHtml(repo.owner)}"/>
            <input type="hidden" name="name" value="${escapeHtml(repo.name)}"/>
            <button class="repo-pick" type="submit"><span class="mono">${escapeHtml(repo.owner)}/${escapeHtml(repo.name)}</span>${repo.privateRepo ? ' <span class="tag">private</span>' : ""}</button>
          </form>
        </li>`,
    )
    .join("");
  return `<h3>From your GitHub App</h3>
      <ul class="repo-list">${items}</ul>
      <p class="or-line">— or add manually —</p>`;
}

export function connectPage(
  model: ChromeModel,
  error = "",
  values: { owner?: string; name?: string } = {},
  appList?: { repos: AppRepo[] } | { error: string } | null,
): string {
  const flash = error ? `<p class="flash" role="alert">${escapeHtml(error)}</p>` : "";
  return layout(
    "Eru — connect a repo",
    `<body>
  <a class="skip" href="#main">Skip to content</a>
  <div class="shell">
    ${topbar(model)}
    <main id="main" class="connect">
      <section class="card connect-card">
        <h2>Connect a repo</h2>
        <p class="page-lead">Point Eru at one GitHub repository. A least-privilege token is stored encrypted; it never reaches logs.</p>
        ${flash}
        ${appRepoSection(appList, model.csrf)}
        <form class="connect-form" method="post" action="/connect" autocomplete="off">
          ${csrfInput(model.csrf)}
          <label class="field">
            <span>Owner</span>
            <input type="text" name="owner" required maxlength="39" value="${escapeHtml(values.owner ?? "")}" placeholder="dragonshorn-studios"/>
          </label>
          <label class="field">
            <span>Repo</span>
            <input type="text" name="name" required maxlength="100" value="${escapeHtml(values.name ?? "")}" placeholder="eru"/>
          </label>
          <label class="field">
            <span>Token <span class="field-hint">optional for public repos</span></span>
            <input type="password" name="token" autocomplete="off" placeholder="github_pat_..."/>
          </label>
          <button class="enter" type="submit">Connect</button>
        </form>
      </section>
    </main>
    ${foot(model)}
  </div>
</body>`,
  );
}

function briefToc(model: ChromeModel): string {
  if (model.pages.length === 0) {
    return `<p class="empty-hint">Nothing to leaf through yet.</p>`;
  }
  const items = model.pages
    .map((page, i) => {
      const current = model.page?.slug === page.slug ? ` aria-current="page"` : "";
      return `<li><a href="/brief/${escapeHtml(page.slug)}"${current}><span class="spark" aria-hidden="true">✦</span> ${numeral(i)} ${escapeHtml(page.title)}</a></li>`;
    })
    .join("");
  return `<nav><ul class="toc">${items}</ul></nav>`;
}

function pageArticle(model: ChromeModel): string {
  if (!model.repo) {
    return `<h2 class="page-title">No repo connected</h2>
        <p class="page-lead">The Brief is a durable map of one repository. <a href="/connect">Connect a repo</a> to start growing it.</p>`;
  }
  if (model.pages.length === 0) {
    return `<h2 class="page-title">No map pages yet</h2>
        <p class="page-lead">This repo has not been mapped. Refresh lands here once the map grows its first pages.</p>`;
  }
  if (!model.page) {
    return `<h2 class="page-title">Page not found</h2>
        <p class="page-lead">That page is not in the map. Pick one from the Brief list.</p>`;
  }
  const page = model.page;
  const mapped = page.mappedRef ? `<p class="path">mapped @${escapeHtml(page.mappedRef)}</p>` : "";
  return `<h2 class="page-title">${escapeHtml(page.title)}</h2>
        ${mapped}
        <div class="page-body">${escapeHtml(page.body)}</div>`;
}

export function appPage(model: ChromeModel): string {
  const refreshNotice = model.refreshNotice
    ? `<p class="refresh-result" id="refresh-result">${escapeHtml(model.refreshNotice)}</p>`
    : `<p class="refresh-result" id="refresh-result" hidden></p>`;

  return layout(
    "Eru",
    `<body>
  <a class="skip" href="#main">Skip to content</a>
  <div class="shell">
    ${topbar(model)}
    ${masthead(model)}
    <main id="main" class="stage${model.mapping ? " mapping" : ""}">
      <aside class="card" aria-label="Brief">
        <div class="brief-head">
          <p class="kicker">Brief pages</p>
          <form class="refresh-form" method="post" action="/refresh" hx-post="/refresh" hx-target="#refresh-result" hx-swap="outerHTML">
            ${csrfInput(model.csrf)}
            <button class="refresh-icon" type="submit" title="Refresh map @${escapeHtml(model.repo?.defaultBranch ?? "main")}" aria-label="Refresh map"${model.repo ? "" : " disabled"}>
              <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><polyline points="21 3 21 9 15 9"/></svg>
            </button>
          </form>
        </div>
        <hr class="rule"/>
        ${briefToc(model)}
        ${refreshNotice}
      </aside>
      <article class="card" aria-label="Page">
        ${pageArticle(model)}
      </article>
      <section class="mapping-pane"${model.mapping ? "" : " hidden"} aria-live="polite" aria-label="Refresh in progress">
        <div class="mapping-fx" aria-hidden="true">
          <svg class="fx-strands fx-left" viewBox="0 0 220 900" preserveAspectRatio="none">
            <path d="M215 -20 C 150 120, 235 250, 165 400 S 205 640, 140 920"/>
            <path d="M190 -20 C 120 160, 200 300, 130 460 S 175 690, 110 920"/>
            <path d="M160 -10 C 100 140, 165 280, 105 440 S 140 660, 85 920"/>
            <path d="M130 -10 C 80 170, 140 320, 80 480 S 110 700, 60 920"/>
            <path d="M205 -20 C 175 100, 225 210, 185 340 S 190 580, 160 760"/>
          </svg>
          <svg class="fx-strands fx-right" viewBox="0 0 220 900" preserveAspectRatio="none">
            <path d="M5 -20 C 70 130, -15 260, 60 410 S 15 650, 85 920"/>
            <path d="M30 -20 C 100 170, 20 310, 95 470 S 50 700, 115 920"/>
            <path d="M60 -10 C 120 150, 55 290, 120 450 S 85 670, 140 920"/>
            <path d="M90 -10 C 145 180, 85 330, 145 490 S 115 710, 165 920"/>
            <path d="M15 -20 C 45 110, 0 220, 40 350 S 30 590, 65 770"/>
          </svg>
          <div class="fx-bokeh-field">${Array.from({ length: 8 }, () => `<span class="fx-bokeh"></span>`).join("")}</div>
          <div class="fx-petal-field">${Array.from({ length: 10 }, () => `<span class="fx-petal"></span>`).join("")}</div>
        </div>
        <img class="mapping-icon" src="/assets/eru-icon.png" width="72" height="72" alt=""/>
        <h2 id="mapping-line">Getting curious about this repo…</h2>
        <p class="mapping-sub">${model.repo ? `mapping ${escapeHtml(model.repo.owner)}/${escapeHtml(model.repo.name)} @${escapeHtml(model.repo.defaultBranch ?? "main")}` : "mapping the repository"}</p>
        <div class="mapping-bar"><div class="mapping-fill"></div></div>
        <p class="field-hint mapping-note">OpenCode is reading the checkout — this can take a few minutes.</p>
      </section>
    </main>
    <script>
    (() => {
      const stage = document.getElementById("main");
      const form = stage?.querySelector(".refresh-form");
      const line = document.getElementById("mapping-line");
      const pane = stage?.querySelector(".mapping-pane");
      if (!stage || !line || !pane) return;
      const LINES = [
        "Getting curious about this repo…",
        "Reading the map…",
        "One more page — the good stuff is in the footnotes…",
        "Curiosity needs a moment to steep…",
        "Almost there — filing the pages…",
      ];
      let lineTimer = 0;
      let pollTimer = 0;
      let i = 0;
      const startPolling = () => {
        if (pollTimer) return;
        pollTimer = window.setInterval(async () => {
          try {
            const res = await fetch("/refresh/status", { headers: { Accept: "application/json" } });
            const state = await res.json();
            if (state.status === "done" || state.status === "failed") {
              window.location.reload();
            } else if (state.status !== "running") {
              stopMappingView();
            }
          } catch {
            /* keep polling through a dropped request */
          }
        }, 2500);
      };
      const startMappingView = () => {
        stage.classList.add("mapping");
        pane.hidden = false;
        i = 0;
        line.textContent = LINES[0];
        if (!lineTimer) {
          lineTimer = window.setInterval(() => {
            i = (i + 1) % LINES.length;
            line.textContent = LINES[i];
          }, 4200);
        }
        startPolling();
      };
      const stopMappingView = () => {
        window.clearInterval(lineTimer);
        window.clearInterval(pollTimer);
        lineTimer = 0;
        pollTimer = 0;
        stage.classList.remove("mapping");
        pane.hidden = true;
      };
      if (${model.mapping ? "true" : "false"}) startMappingView();
      form?.addEventListener("htmx:beforeRequest", startMappingView);
      form?.addEventListener("htmx:afterRequest", (e) => {
        if (e.detail?.failed) stopMappingView();
      });
    })();
    </script>
    ${foot(model)}
  </div>
</body>`,
  );
}

export function themeCss(): string {
  return THEME_CSS;
}

export function refreshResultFragment(notice: string): string {
  return `<p class="refresh-result" id="refresh-result">${escapeHtml(notice)}</p>`;
}

// The Ask page is the one place Eru mounts a client island: the assistant-ui
// thread talks to the loopback OpenCode server through /ask/oc/*, so the
// island never holds a credential. Everything else stays SSR + HTMX.
export function askPage(model: ChromeModel): string {
  const bootstrap = JSON.stringify({
    csrf: model.csrf,
    agent: ASK_AGENT,
    maxQuestion: ASK_MAX_QUESTION,
    apiBase: "/ask",
    slugs: model.pages.map((p) => p.slug),
  }).replace(/</g, "\\u003c");
  return layout(
    "Eru · Ask",
    `<body>
  <a class="skip" href="#ask-root">Skip to Ask</a>
  <div class="shell">
    ${topbar(model)}
    ${masthead(model)}
    <main id="main" class="stage ask-stage">
      <section class="card ask-island" aria-label="Ask">
        <div id="ask-root">${askFallback(model)}</div>
      </section>
    </main>
    ${foot(model)}
  </div>
  <script>window.__ERU_ASK__ = ${bootstrap};</script>
  <script type="module" src="/assets/ask.js"></script>
</body>`,
  );
}

function askFallback(model: ChromeModel): string {
  if (!model.repo) return `<p class="ask-empty">Connect a repo before asking.</p>`;
  if (model.pages.length === 0) return `<p class="ask-empty">The map has no pages yet — refresh the map first.</p>`;
  return `<p class="ask-empty">Waking up the Ask thread…</p>`;
}
