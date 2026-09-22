import { CSRF_FIELD } from "./auth.js";
import type { MapPage, PageTocEntry } from "./db.js";
import type { TarballError, VerifyError } from "./forge.js";
import { ASK_MAX_QUESTION } from "./opencode.js";
import { flowerSeal, THEME_CSS } from "./theme.js";
import { escapeHtml } from "./util.js";

export interface ChromeModel {
  repo: {
    owner: string;
    name: string;
    lastMappedRef: string | null;
    lastMappedLabel: string;
  } | null;
  path: string;
  csrf: string;
  pages: PageTocEntry[];
  page: MapPage | null;
  askNotice?: string;
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
  <title>${escapeHtml(title)}</title>
  <link rel="stylesheet" href="/assets/eru.css"/>
  <script src="/assets/htmx.min.js" defer></script>
</head>
${body}
</html>`;
}

function topbar(model: ChromeModel): string {
  const repoPill = model.repo
    ? `<span class="pill">${escapeHtml(model.repo.owner)} / ${escapeHtml(model.repo.name)}</span>`
    : `<a class="pill pill-link" href="/connect">connect a repo</a>`;
  const mapped = model.repo
    ? model.repo.lastMappedRef
      ? `<span class="mapped">last mapped @${escapeHtml(model.repo.lastMappedRef)}</span>`
      : `<span class="mapped">not mapped yet</span>`
    : "";
  return `<header class="topbar">
      <a class="brand" href="/">
        ${flowerSeal(42)}
        <h1>Eru</h1>
      </a>
      ${repoPill}
      ${mapped}
      <span class="grow"></span>
      <form method="post" action="/logout">${csrfInput(model.csrf)}<button class="logout" type="submit">Log out</button></form>
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

export function loginPage(error = ""): string {
  const flash = error ? `<p class="flash" role="alert">${escapeHtml(error)}</p>` : "";
  return layout(
    "Eru — operator gate",
    `<body>
  <a class="skip" href="#main">Skip to content</a>
  <main id="main" class="gate">
    <section class="card gate-card">
      ${flowerSeal(56)}
      <h1>Eru</h1>
      <p class="lede">I'm curious about this repo.</p>
      ${flash}
      <form class="gate-form" method="post" action="/login" autocomplete="off">
        <label class="sr-only" for="password">Password</label>
        <input id="password" type="password" name="password" required autofocus autocomplete="current-password"/>
        <button class="enter" type="submit">Enter</button>
      </form>
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

export const REFRESH_TARBALL_ERRORS: Record<TarballError, string> = {
  invalid: "That ref does not look right.",
  notfound: "The forge could not find that ref or SHA. Check it and try again.",
  auth: "The forge token cannot read that repository. Reconnect with a least-privilege token.",
  unreachable: "Could not reach the forge. Try again in a moment.",
  toobig: "That checkout is too large to map.",
};

export function connectPage(model: ChromeModel, error = "", values: { owner?: string; name?: string } = {}): string {
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
  const askNotice = model.askNotice
    ? `<p class="ask-answer" id="ask-result">${escapeHtml(model.askNotice)}</p>`
    : `<p class="ask-answer" id="ask-result" hidden></p>`;

  return layout(
    "Eru",
    `<body>
  <a class="skip" href="#main">Skip to content</a>
  <div class="shell">
    ${topbar(model)}
    ${masthead(model)}
    <main id="main" class="stage">
      <aside class="card" aria-label="Brief">
        <p class="kicker">Brief pages</p>
        <hr class="rule"/>
        ${briefToc(model)}
        <hr class="rule"/>
        <form class="refresh-form" method="post" action="/refresh" hx-post="/refresh" hx-target="#refresh-result" hx-swap="outerHTML">
          ${csrfInput(model.csrf)}
          <label class="sr-only" for="ref">Ref or SHA to map</label>
          <input id="ref" type="text" name="ref" placeholder="ref or SHA" autocomplete="off" maxlength="200"${model.repo ? "" : " disabled"}/>
          <button class="refresh-run" type="submit"${model.repo ? "" : " disabled"}>Refresh map</button>
        </form>
        ${refreshNotice}
      </aside>
      <article class="card" aria-label="Page">
        ${pageArticle(model)}
      </article>
      <section class="card" aria-label="Ask">
        <h2>Ask</h2>
        <form class="ask-form" method="post" action="/ask" hx-post="/ask" hx-target="#ask-result" hx-swap="outerHTML">
          ${csrfInput(model.csrf)}
          <label class="sr-only" for="q">What do you want to know?</label>
          <input id="q" type="text" name="q" placeholder="What do you want to know?" autocomplete="off" maxlength="${ASK_MAX_QUESTION}"/>
          <button class="ask-eru" type="submit">Ask Eru</button>
        </form>
        ${askNotice}
      </section>
    </main>
    ${foot(model)}
  </div>
</body>`,
  );
}

export function themeCss(): string {
  return THEME_CSS;
}

export function askResultFragment(notice: string): string {
  return `<p class="ask-answer" id="ask-result">${escapeHtml(notice)}</p>`;
}

export function refreshResultFragment(notice: string): string {
  return `<p class="refresh-result" id="refresh-result">${escapeHtml(notice)}</p>`;
}
