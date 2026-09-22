# AGENTS.md

Canonical instructions for coding agents. Skills with the same locks: [eru-shape](.cursor/skills/eru-shape/SKILL.md) and [eru-security](.cursor/skills/eru-security/SKILL.md). Threat model: [SECURITY.md](SECURITY.md). How to build: [CONTRIBUTING.md](CONTRIBUTING.md).

## What Eru is

Eru is a **separate** self-hosted app (Hyouka / Eru). It is **not** Maomao.

- Capsule: `I'm curious about this repo.`
- Lead: `Self-hosted OpenCode notes that stay with the repo. Page the map, then ask. Refresh when you want — not a checkout job, not DeepWiki.com.`
- Chrome labels: `Brief` · `Ask` · `last mapped @ref`

Maomao is an ephemeral Repo brief on a checkout SHA. Eru is a **durable** repo map: pages live in SQLite, refresh updates them, Ask runs against the map.

Never call it Eruka. Never merge into Maomao. Never DeepWiki.com SaaS.

## Stack locks

- Language: **Node.js >= 22** + **TypeScript**. Python is Belldandy; Go is Alyssa; this repo is Node.
- HTTP: **Hono** on `@hono/node-server`. UI is server-rendered HTML + **HTMX** + **CSS variables** + **hand CSS** (no Tailwind pipeline). No React SPA for chrome, no DaisyUI, Bootstrap, or Material.
- Data: **SQLite** via `better-sqlite3`. Pages and repos persist here. Compose for the app. **MIT**.
- Mapping: **OpenCode** with deny `bash` / `edit` / `write` / `webfetch`. Model output is untrusted.
- Chrome tokens (locked): cream `#F7F5F0`, lavender `#E9E4F7`, pink `#FBE9EC`, ink `#1B1A18`, mint `#CDE8DF`, moss `#A8B99A`, rose `#FADADD`. Serif titles, sans body, mono paths. Soft radius. Pastel glow. No vine/hair chrome, no character art, no purple SaaS.
- Do not add Kubernetes, Redis, Postgres, GraphQL, or a second UI framework.

## Security non-negotiables

- Fail closed on migrate and on invalid or missing config (including UI password and session secret).
- Operator UI: env password + signed HttpOnly cookie (`SameSite=Lax`, `Secure` on HTTPS); CSRF on cookie POSTs; login throttle; timing-safe compare. **Not** Basic Auth.
- Forge tokens are least privilege. Secrets never in logs or git.
- OpenCode deny list is mandatory. No secret exfil. Model output is untrusted HTML/text.
- `/health` is public liveness only. Do not publish the stack with only `/health` as protection.

## How to work

- Extend `src/`. Chrome HTML lives in `src/ui.ts`. Auth lives in `src/auth.ts`. SQLite lives in `src/db.ts`.
- One PR, one ticketed slice. Do not invent a second auth scheme or a second datastore.
- Run `npm test` and `npm run typecheck`. CI is GitHub Actions on a self-hosted runner; see [CONTRIBUTING.md](CONTRIBUTING.md#ci).
- Read **eru-shape** when changing architecture, stack, chrome, or opening a new slice. Read **eru-security** when touching auth, sessions, secrets, CSRF, OpenCode permissions, or forge tokens.
- If blocked, stop and report.

## Out of scope unless ticketed

- Full GitHub/GitLab OAuth and forge crypto (issue #2).
- Durable map page bodies and Brief TOC from SQLite (issue #3).
- Ask chat backend (issue #4).
- OpenCode map seed/refresh (issue #5).
- Pixel-complete chrome pass (issue #6) — this repo already mounts the locked tokens and Brief/Ask layout as the shell.

## Other coding agents

Codex, OpenCode, zcode, Devin, and Vibe consume this file and/or thin adapters that **point here**. Do not copy this brief into per-tool duplicates. See [CONTRIBUTING.md](CONTRIBUTING.md#agent-instruction-paths).
