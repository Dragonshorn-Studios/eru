/** Locked Eru tokens. Do not invent a second palette. */
export const TOKENS = {
  cream: "#F7F5F0",
  lavender: "#E9E4F7",
  pink: "#FBE9EC",
  ink: "#1B1A18",
  mint: "#CDE8DF",
  moss: "#A8B99A",
  rose: "#FADADD",
} as const;

export const THEME_CSS = `:root {
  --cream: ${TOKENS.cream};
  --lavender: ${TOKENS.lavender};
  --pink: ${TOKENS.pink};
  --ink: ${TOKENS.ink};
  --mint: ${TOKENS.mint};
  --moss: ${TOKENS.moss};
  --rose: ${TOKENS.rose};
  --font-serif: "Iowan Old Style", Palatino, "Palatino Linotype", "Times New Roman", serif;
  --font-sans: "Avenir Next", "Segoe UI", "Helvetica Neue", system-ui, sans-serif;
  --font-mono: "IBM Plex Mono", "SF Mono", ui-monospace, Menlo, Consolas, monospace;
  --radius: 1.5rem;
  --shadow: 0 18px 50px rgba(27, 26, 24, 0.08);
}

* { box-sizing: border-box; }
html, body { margin: 0; min-height: 100%; }
body {
  font-family: var(--font-sans);
  color: var(--ink);
  background-color: var(--cream);
  background-image:
    radial-gradient(circle at 12% 18%, color-mix(in srgb, var(--lavender) 75%, white) 0 18%, transparent 52%),
    radial-gradient(circle at 88% 12%, color-mix(in srgb, var(--pink) 80%, white) 0 16%, transparent 48%),
    radial-gradient(circle at 78% 82%, color-mix(in srgb, var(--mint) 55%, white) 0 20%, transparent 56%),
    radial-gradient(circle at 18% 88%, color-mix(in srgb, var(--rose) 45%, white) 0 14%, transparent 50%),
    linear-gradient(165deg, #f3eef8 0%, var(--cream) 42%, #eef4ef 100%);
  min-height: 100vh;
}
body::before {
  content: "";
  pointer-events: none;
  position: fixed;
  inset: 0;
  background-image:
    radial-gradient(circle, rgba(255,255,255,0.85) 0 2px, transparent 3px),
    radial-gradient(circle, rgba(255,255,255,0.55) 0 3px, transparent 5px),
    radial-gradient(circle, color-mix(in srgb, var(--mint) 50%, white) 0 2px, transparent 4px);
  background-size: 180px 180px, 260px 260px, 220px 220px;
  background-position: 8% 12%, 70% 30%, 40% 78%;
  opacity: 0.7;
}

.skip {
  position: absolute;
  left: -999px;
  top: 0;
}
.skip:focus { left: 1rem; background: var(--cream); padding: 0.4rem 0.8rem; }

.shell { position: relative; z-index: 1; min-height: 100vh; display: flex; flex-direction: column; }
.topbar {
  display: flex;
  align-items: center;
  gap: 1rem;
  padding: 1.6rem 2.4rem 0.8rem;
  flex-wrap: wrap;
}
.brand {
  display: flex;
  align-items: center;
  gap: 0.7rem;
  color: inherit;
  text-decoration: none;
}
.brand .seal { color: var(--moss); width: 42px; height: 42px; }
.brand h1 {
  font-family: var(--font-serif);
  font-weight: 500;
  font-size: 2.4rem;
  margin: 0;
  letter-spacing: 0.01em;
}
.pill {
  border: 1px solid color-mix(in srgb, var(--ink) 12%, transparent);
  background: color-mix(in srgb, var(--cream) 70%, white);
  border-radius: 999px;
  padding: 0.28rem 0.85rem;
  font-size: 0.85rem;
  color: color-mix(in srgb, var(--ink) 70%, white);
}
.mapped {
  font-size: 0.92rem;
  color: color-mix(in srgb, var(--ink) 55%, white);
}
.grow { flex: 1; }
.logout {
  background: none;
  border: 0;
  color: color-mix(in srgb, var(--ink) 55%, white);
  cursor: pointer;
  font: inherit;
  font-size: 0.72rem;
  letter-spacing: 0.08em;
}
.user-pill {
  display: inline-flex;
  align-items: center;
  gap: 0.55rem;
  border: 1px solid color-mix(in srgb, var(--ink) 12%, transparent);
  background: color-mix(in srgb, var(--cream) 70%, white);
  border-radius: 999px;
  padding: 0.22rem 0.75rem 0.22rem 0.22rem;
  font-size: 0.85rem;
}
.user-pill .user-name {
  color: color-mix(in srgb, var(--ink) 75%, white);
  max-width: 9rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.user-pill form { display: inline-flex; margin: 0; }
.user-pill .logout:hover { color: var(--ink); text-decoration: underline; }
.avatar {
  width: 24px;
  height: 24px;
  border-radius: 50%;
  display: inline-block;
  object-fit: cover;
}
.avatar-mono {
  background: color-mix(in srgb, var(--mint) 65%, white);
  border: 1px solid color-mix(in srgb, var(--moss) 45%, transparent);
  color: color-mix(in srgb, var(--ink) 70%, white);
  font-size: 0.62rem;
  font-weight: 600;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border-radius: 50%;
}

.masthead {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 1.5rem;
  padding: 0 2.4rem;
  flex-wrap: wrap;
}
.tagline {
  font-family: var(--font-serif);
  font-style: italic;
  font-size: 0.98rem;
  margin: 0;
  color: color-mix(in srgb, var(--ink) 50%, white);
}
.tabs {
  display: inline-flex;
  gap: 2px;
  padding: 3px;
  border: 1px solid color-mix(in srgb, var(--ink) 14%, transparent);
  border-radius: 999px;
  background: color-mix(in srgb, var(--lavender) 45%, var(--cream));
}
.tab {
  font-size: 0.82rem;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  text-decoration: none;
  color: color-mix(in srgb, var(--ink) 60%, white);
  padding: 0.45rem 1.3rem;
  border-radius: 999px;
  border: 1px solid transparent;
}
.tab[aria-current="page"] {
  color: var(--ink);
  border-color: color-mix(in srgb, var(--ink) 10%, transparent);
  background: var(--cream);
  box-shadow: 0 1px 2px color-mix(in srgb, var(--ink) 14%, transparent);
}
.tab:hover { color: var(--ink); }

:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--moss) 80%, white);
  outline-offset: 2px;
  border-radius: 0.4rem;
}

.stage {
  display: grid;
  grid-template-columns: minmax(220px, 0.9fr) minmax(0, 1.6fr) minmax(240px, 0.95fr);
  gap: 1.2rem;
  padding: 1rem 2.4rem 2rem;
  flex: 1;
}
@media (max-width: 960px) {
  .stage { grid-template-columns: 1fr; }
}

.card {
  background: color-mix(in srgb, var(--cream) 86%, white);
  border: 1px solid color-mix(in srgb, white 70%, var(--lavender));
  border-radius: var(--radius);
  box-shadow: var(--shadow);
  backdrop-filter: blur(16px);
  padding: 1.4rem 1.5rem 1.6rem;
}
.card h2, .page-title {
  font-family: var(--font-serif);
  font-weight: 500;
  margin: 0 0 0.6rem;
  font-size: 2rem;
}
.card h3 {
  font-family: var(--font-serif);
  font-weight: 500;
  font-size: 1.25rem;
  margin: 1rem 0 0.4rem;
}
.config-refresh {
  display: flex;
  align-items: center;
  gap: 0.8rem;
  margin-top: 0.8rem;
  flex-wrap: wrap;
}
.kicker {
  font-size: 0.72rem;
  letter-spacing: 0.22em;
  text-transform: uppercase;
  color: color-mix(in srgb, var(--ink) 45%, white);
  text-align: center;
  margin: 0 0 0.8rem;
}
.rule {
  height: 1px;
  background: linear-gradient(90deg, transparent, color-mix(in srgb, var(--moss) 55%, white), transparent);
  border: 0;
  margin: 0 1.5rem 0.9rem;
}

.toc { list-style: none; margin: 0; padding: 0; }
.toc a {
  display: flex;
  align-items: center;
  gap: 0.55rem;
  padding: 0.7rem 0.85rem;
  border-radius: 0.9rem;
  color: inherit;
  text-decoration: none;
  border-left: 3px solid transparent;
}
.toc a[aria-current="page"] {
  background: color-mix(in srgb, var(--lavender) 55%, var(--pink));
  border-left-color: var(--moss);
}
.spark { color: var(--moss); font-size: 0.85rem; }
.page-lead { line-height: 1.55; margin: 0 0 1.1rem; color: color-mix(in srgb, var(--ink) 82%, white); }
.path {
  font-family: var(--font-mono);
  font-size: 0.82rem;
  color: var(--moss);
  margin: 0 0 1rem;
}
.cmd {
  font-family: var(--font-sans);
  font-size: 0.95rem;
}
.page-body {
  white-space: pre-wrap;
  line-height: 1.65;
  font-size: 0.95rem;
  color: color-mix(in srgb, var(--ink) 85%, white);
}
.empty-hint {
  text-align: center;
  font-size: 0.85rem;
  color: color-mix(in srgb, var(--ink) 45%, white);
}
.cmd code {
  font-family: var(--font-mono);
  background: color-mix(in srgb, var(--mint) 35%, var(--cream));
  padding: 0.1rem 0.35rem;
  border-radius: 0.35rem;
  font-size: 0.88em;
}

.ask-form { display: flex; flex-direction: column; gap: 1rem; margin-top: 1rem; }
.ask-form input[type="text"] {
  border: 1px solid color-mix(in srgb, var(--ink) 10%, transparent);
  background: color-mix(in srgb, white 70%, var(--cream));
  border-radius: 999px;
  padding: 0.85rem 1.1rem;
  font: inherit;
  color: var(--ink);
}
.ask-form input::placeholder { color: color-mix(in srgb, var(--ink) 40%, white); }
.ask-eru {
  align-self: center;
  border: 0;
  cursor: pointer;
  background: color-mix(in srgb, var(--lavender) 80%, white);
  color: color-mix(in srgb, var(--ink) 70%, white);
  letter-spacing: 0.16em;
  text-transform: uppercase;
  font: inherit;
  font-size: 0.82rem;
  padding: 0.75rem 1.6rem;
  border-radius: 999px;
}
.ask-answer, .flash {
  color: color-mix(in srgb, var(--ink) 70%, white);
  font-size: 0.92rem;
}
.ask-answer { white-space: pre-wrap; }

.refresh-form {
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
  margin-top: 1rem;
}
.refresh-form input[type="text"] {
  font-family: var(--font-mono);
  font-size: 0.85rem;
  padding: 0.6rem 0.9rem;
  border: 1px solid color-mix(in srgb, var(--ink) 15%, transparent);
  border-radius: 999px;
  background: white;
  color: var(--ink);
}
.refresh-form input:disabled { opacity: 0.5; }
.refresh-run {
  font-family: var(--font-sans);
  font-size: 0.8rem;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  padding: 0.65rem 1.2rem;
  border: none;
  border-radius: 999px;
  background: color-mix(in srgb, var(--moss) 55%, white);
  color: color-mix(in srgb, var(--ink) 80%, white);
  cursor: pointer;
  width: 100%;
}
.refresh-run:hover:not(:disabled) { filter: brightness(0.96); }
.refresh-run:disabled { opacity: 0.5; cursor: default; }
.refresh-result {
  font-size: 0.85rem;
  color: color-mix(in srgb, var(--ink) 70%, white);
  white-space: pre-wrap;
}
.flash { color: #7a3b44; }

.foot {
  display: flex;
  justify-content: center;
  gap: 1.2rem;
  flex-wrap: wrap;
  padding: 0.4rem 1rem 1.6rem;
  font-size: 0.78rem;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: color-mix(in srgb, var(--ink) 45%, white);
}
.foot a { color: inherit; text-decoration: none; }
.sep { opacity: 0.4; }

.gate {
  min-height: 100vh;
  display: grid;
  place-items: center;
  padding: 2rem;
}
.gate-card {
  width: min(420px, 100%);
  text-align: center;
}
.gate-card .seal { color: var(--moss); width: 56px; height: 56px; }
.gate-card h1 {
  font-family: var(--font-serif);
  font-size: 2.4rem;
  margin: 0.4rem 0 0.3rem;
  font-weight: 500;
}
.lede { margin: 0 0 1.2rem; color: color-mix(in srgb, var(--ink) 60%, white); }
.gate-form { display: flex; flex-direction: column; gap: 0.8rem; }
.gate-form input[type="password"] {
  border: 1px solid color-mix(in srgb, var(--ink) 12%, transparent);
  background: color-mix(in srgb, white 75%, var(--cream));
  border-radius: 999px;
  padding: 0.85rem 1.1rem;
  font: inherit;
}
.enter {
  border: 0;
  cursor: pointer;
  background: var(--moss);
  color: var(--cream);
  font: inherit;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  padding: 0.8rem 1.2rem;
  border-radius: 999px;
}
.pill-link { text-decoration: none; }
.config-stage {
  grid-template-columns: minmax(200px, 0.55fr) minmax(0, 2.4fr);
  align-items: start;
}
.config-nav { position: sticky; top: 1rem; }
.config-card { min-width: 0; }
.config-card a {
  color: color-mix(in srgb, var(--ink) 60%, white);
  text-decoration-color: color-mix(in srgb, var(--moss) 70%, transparent);
  text-underline-offset: 2px;
}
.config-card a:hover {
  color: var(--ink);
  text-decoration-color: color-mix(in srgb, var(--moss) 90%, white);
}
.config-card h3 { margin-top: 1.6rem; padding-top: 1.2rem; border-top: 1px solid color-mix(in srgb, var(--ink) 8%, transparent); }
.config-card h3:first-of-type { margin-top: 1rem; padding-top: 0; border-top: 0; }
.badge {
  font-size: 0.72rem;
  padding: 0.15rem 0.6rem;
  border-radius: 999px;
  border: 1px solid color-mix(in srgb, var(--ink) 12%, transparent);
  white-space: nowrap;
}
.badge-env { background: color-mix(in srgb, var(--mint) 55%, var(--cream)); }
.badge-stored { background: color-mix(in srgb, var(--lavender) 60%, var(--cream)); }
.badge-none { color: color-mix(in srgb, var(--ink) 45%, white); }
.provider-filter { margin: 0.6rem 0; display: flex; gap: 0.6rem; align-items: center; }
.provider-filter input {
  flex: 1;
  max-width: 22rem;
  border: 1px solid color-mix(in srgb, var(--ink) 12%, transparent);
  background: color-mix(in srgb, white 75%, var(--cream));
  border-radius: 999px;
  padding: 0.45rem 0.9rem;
  font: inherit;
  color: var(--ink);
}
.provider-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 0.6rem; }
.provider-card {
  border: 1px solid color-mix(in srgb, var(--ink) 10%, transparent);
  border-radius: var(--radius);
  padding: 0.85rem 1rem;
  display: grid;
  gap: 0.4rem;
}
.provider-head { display: flex; justify-content: space-between; align-items: baseline; gap: 0.8rem; }
.provider-head h4 { margin: 0; font-family: var(--font-sans); font-weight: 600; font-size: 0.95rem; }
.provider-id { font-size: 0.72rem; color: color-mix(in srgb, var(--ink) 45%, white); font-family: var(--font-mono); }
.provider-key-form { display: flex; gap: 0.5rem; align-items: center; }
.provider-key-form input {
  flex: 1;
  min-width: 0;
  border: 1px solid color-mix(in srgb, var(--ink) 12%, transparent);
  background: color-mix(in srgb, white 75%, var(--cream));
  border-radius: 999px;
  padding: 0.45rem 0.9rem;
  font: inherit;
  color: var(--ink);
}
.provider-save { padding: 0.45rem 1.1rem; width: auto; }
.config-refresh .refresh-run { width: auto; }
@media (max-width: 960px) {
  .config-stage { grid-template-columns: 1fr; }
  .config-nav { position: static; }
}
.connect {
  display: grid;
  place-items: center;
  padding: 2rem;
  flex: 1;
}
.connect-card { width: min(480px, 100%); }
.connect-form { display: flex; flex-direction: column; gap: 1rem; margin-top: 0.6rem; }
.field { display: flex; flex-direction: column; gap: 0.35rem; font-size: 0.85rem; color: color-mix(in srgb, var(--ink) 65%, white); }
.field-hint { color: color-mix(in srgb, var(--ink) 40%, white); font-size: 0.78rem; }
.field input {
  border: 1px solid color-mix(in srgb, var(--ink) 12%, transparent);
  background: color-mix(in srgb, white 75%, var(--cream));
  border-radius: 0.8rem;
  padding: 0.7rem 1rem;
  font: inherit;
  color: var(--ink);
}
.field input::placeholder { color: color-mix(in srgb, var(--ink) 35%, white); }
.field textarea {
  border: 1px solid color-mix(in srgb, var(--ink) 12%, transparent);
  background: color-mix(in srgb, white 75%, var(--cream));
  border-radius: 0.8rem;
  padding: 0.7rem 1rem;
  font: 0.8rem/1.5 "SFMono-Regular", ui-monospace, Menlo, monospace;
  color: var(--ink);
  resize: vertical;
}
.repo-list { list-style: none; margin: 0.4rem 0 0; padding: 0; display: flex; flex-direction: column; gap: 0.4rem; max-height: 16rem; overflow-y: auto; }
.repo-list form { margin: 0; }
.repo-pick {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.6rem;
  border: 1px solid color-mix(in srgb, var(--ink) 10%, transparent);
  background: color-mix(in srgb, white 75%, var(--cream));
  border-radius: 0.8rem;
  padding: 0.6rem 0.9rem;
  font: inherit;
  color: var(--ink);
  cursor: pointer;
  text-align: left;
}
.repo-pick:hover { background: var(--lavender); }
.repo-pick .mono { font-family: "SFMono-Regular", ui-monospace, Menlo, monospace; font-size: 0.85rem; }
.repo-pick .tag {
  font-size: 0.68rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: color-mix(in srgb, var(--ink) 50%, white);
  border: 1px solid color-mix(in srgb, var(--ink) 14%, transparent);
  border-radius: 999px;
  padding: 0.1rem 0.5rem;
}
.or-line { text-align: center; color: color-mix(in srgb, var(--ink) 40%, white); font-size: 0.8rem; margin: 1rem 0 0.2rem; }
.link-button {
  border: 0;
  background: none;
  padding: 0;
  font: inherit;
  font-size: 0.78rem;
  color: color-mix(in srgb, var(--ink) 50%, white);
  text-decoration: underline;
  cursor: pointer;
}
.repo-switch { display: flex; align-items: center; gap: 0.4rem; }
.repo-switch select {
  border: 1px solid color-mix(in srgb, var(--ink) 10%, transparent);
  background: color-mix(in srgb, white 60%, var(--lavender));
  color: var(--ink);
  font: inherit;
  font-size: 0.82rem;
  border-radius: 999px;
  padding: 0.3rem 0.8rem;
  cursor: pointer;
}
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0,0,0,0);
  border: 0;
}
`;

export function flowerSeal(size = 42): string {
  const petals = [0, 60, 120, 180, 240, 300]
    .map(
      (deg) =>
        `<path d="M32 8c3.6 6.2 4.6 12.2 0 18.4C27.4 20.2 28.4 14.2 32 8z" transform="rotate(${deg} 32 32)" fill="${TOKENS.mint}"/>`,
    )
    .join("");
  return `<svg class="seal" viewBox="0 0 64 64" width="${size}" height="${size}" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">
  <g stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round">
    <circle cx="32" cy="32" r="4.2" fill="${TOKENS.rose}"/>
    ${petals}
  </g>
</svg>`;
}
