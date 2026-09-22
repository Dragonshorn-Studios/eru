import { CSRF_FIELD } from "./auth.js";
import { flowerSeal, THEME_CSS } from "./theme.js";
import { escapeHtml } from "./util.js";

export interface ChromeModel {
  owner: string;
  name: string;
  lastMappedRef: string;
  lastMappedLabel: string;
  csrf: string;
  selectedSlug: string;
  askNotice?: string;
}

export const PLACEHOLDER_PAGES = [
  { slug: "architecture", numeral: "I", title: "Architecture" },
  { slug: "auth", numeral: "II", title: "Auth" },
  { slug: "data", numeral: "III", title: "Data" },
  { slug: "jobs", numeral: "IV", title: "Jobs" },
  { slug: "deploy", numeral: "V", title: "Deploy" },
] as const;

export const DEFAULT_CHROME = {
  owner: "owner",
  name: "repo",
  lastMappedRef: "main",
  lastMappedLabel: "never",
} as const;

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

export function appPage(model: ChromeModel): string {
  const selected = PLACEHOLDER_PAGES.find((page) => page.slug === model.selectedSlug) ?? PLACEHOLDER_PAGES[0];
  const toc = PLACEHOLDER_PAGES.map((page) => {
    const current = page.slug === selected.slug ? ` aria-current="page"` : "";
    return `<li><a href="/brief/${escapeHtml(page.slug)}"${current}><span class="spark" aria-hidden="true">✦</span> ${escapeHtml(page.numeral)} ${escapeHtml(page.title)}</a></li>`;
  }).join("");
  const askNotice = model.askNotice
    ? `<p class="ask-stub" id="ask-result">${escapeHtml(model.askNotice)}</p>`
    : `<p class="ask-stub" id="ask-result" hidden></p>`;

  return layout(
    "Eru",
    `<body>
  <a class="skip" href="#main">Skip to content</a>
  <div class="shell">
    <header class="topbar">
      <a class="brand" href="/">
        ${flowerSeal(42)}
        <h1>Eru</h1>
      </a>
      <span class="pill">${escapeHtml(model.owner)} / ${escapeHtml(model.name)}</span>
      <span class="mapped">last mapped @${escapeHtml(model.lastMappedRef)}</span>
      <span class="grow"></span>
      <form method="post" action="/logout">${csrfInput(model.csrf)}<button class="logout" type="submit">Log out</button></form>
    </header>
    <main id="main" class="stage">
      <aside class="card" aria-label="Brief">
        <p class="kicker">Brief pages</p>
        <hr class="rule"/>
        <nav><ul class="toc">${toc}</ul></nav>
      </aside>
      <article class="card" aria-label="Page">
        <h2 class="page-title">Self-Hosted Repo Map</h2>
        <p class="page-lead">A comprehensive overview of the system architecture, detailing the core components and their interactions.</p>
        <p class="path">src / architecture / core / mapping.go</p>
        <p class="cmd">Execute the setup using the command: <code>selfhost --init</code></p>
        <p class="ask-stub">Map pages persist in SQLite. Refresh and real Brief bodies land in later tickets.</p>
      </article>
      <section class="card" aria-label="Ask">
        <h2>Ask</h2>
        <form class="ask-form" method="post" action="/ask" hx-post="/ask" hx-target="#ask-result" hx-swap="innerHTML">
          ${csrfInput(model.csrf)}
          <label class="sr-only" for="q">What do you want to know?</label>
          <input id="q" type="text" name="q" placeholder="What do you want to know?" autocomplete="off"/>
          <button class="ask-eru" type="submit">Ask Eru</button>
        </form>
        ${askNotice}
      </section>
    </main>
    <footer class="foot">
      <span>Last mapped: ${escapeHtml(model.lastMappedLabel)}</span>
      <span class="sep">|</span>
      <a href="/">Explore</a>
      <span class="sep">|</span>
      <span>Archive</span>
      <span class="sep">|</span>
      <span>Inspire</span>
      <span class="sep">|</span>
      <span>About</span>
    </footer>
  </div>
</body>`,
  );
}

export function themeCss(): string {
  return THEME_CSS;
}

export const ASK_STUB_MESSAGE = "Ask is not wired yet. OpenCode against the map lands in issue #4.";

export function askStubFragment(): string {
  return `<p class="ask-stub">${escapeHtml(ASK_STUB_MESSAGE)}</p>`;
}
