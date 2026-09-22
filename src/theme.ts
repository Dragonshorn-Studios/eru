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
.ask-stub, .flash {
  color: color-mix(in srgb, var(--ink) 70%, white);
  font-size: 0.92rem;
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
        `<path d="M32 8c3.6 6.2 4.6 12.2 0 18.4C27.4 20.2 28.4 14.2 32 8z" transform="rotate(${deg} 32 32)"/>`,
    )
    .join("");
  return `<svg class="seal" viewBox="0 0 64 64" width="${size}" height="${size}" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">
  <g fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round">
    <circle cx="32" cy="32" r="4.2"/>
    ${petals}
  </g>
</svg>`;
}
