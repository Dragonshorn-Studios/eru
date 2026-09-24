---
name: testing-eru-ui
description: How to run the eru server locally and seed its SQLite DB for browser testing or showcase screenshots (env vars, seeding repos/pages tables, screenshot tooling).
---

# Testing the eru UI locally

eru renders entirely server-side (Hono + htmx, no client build). Pages read from SQLite, so no GitHub token or OpenCode binary is needed to render the Brief/Ask/Connect UI — Ask and Refresh just fail closed with an operator notice if OpenCode is absent.

## Run the built server

```bash
cd <repo>
npm run build   # tsc + copy-assets (htmx staged into dist/assets)
ERU_HOST=127.0.0.1 ERU_PORT=3131 \
ERU_SQLITE_PATH=./data/eru.sqlite \
ERU_UI_PASSWORD='<any password>' \
ERU_UI_SESSION_SECRET='<16+ chars>' \
node dist/index.js
```

Notes:
- `src/index.ts` does NOT load a `.env` file — pass env vars inline (or `set -a; . .env; set +a`).
- `ERU_UI_PASSWORD` and `ERU_UI_SESSION_SECRET` (>=16 chars) are required; missing/short values crash on boot.
- The DB schema is created on startup by `openDb()` — seed AFTER the server has started (or any openDb call) so the tables exist. Plain `new Database(path)` in a seed script does not create them.

## Config page notes

- `settings` table (migration 0003) stores operator-saved key/value pairs like `opencode.ask_model` / `opencode.map_model`. Migrations apply at `openDb()`, so boot the server once before inspecting the DB.
- Precedence: `ERU_OPENCODE_ASK_MODEL`/`ERU_OPENCODE_MAP_MODEL` env > saved setting > `ERU_OPENCODE_MODEL` > default. To test env-over-saved, save a value via the UI, restart the server with the purpose env var set, and reload /config — the badge flips to "in effect from <env key>" while the field keeps the stored value.
- `opencode` binary is NOT installed on this box — model discovery errors with "model list unavailable — spawn opencode ENOENT" (expected; refresh also runs at boot so the error shows on first /config load).
- Bad model names like `not a model!` get a 400 with "That is not a model name." and write nothing.

## Seeding (better-sqlite3)

Tables: `repos` (forge, owner, name, last_mapped_ref, last_mapped_at, connected_at, created_at) and `pages` (repo_id, slug, title, body, sort_order, mapped_ref, updated_at). Insert one repo row (the primary repo = most recent `connected_at`), then 4-6 page rows with increasing `sort_order`. Page `body` renders via `escapeHtml` inside `.page-body` with `white-space: pre-wrap` — markdown syntax shows literally, so write plain prose paragraphs separated by blank lines; dash-bullets look fine, `##`/`*` look ugly.

## UI flow

- `/` redirects to `/login` without a session; POST the password field on the login form (no CSRF needed on login).
- Routes: `/` and `/brief` = Brief home (first TOC page), `/brief/<slug>` = specific page, `/ask` = same shell with Ask tab active, `/connect` = owner/repo/token form.
- Footer "LAST MAPPED" prints the raw ISO `last_mapped_at` string.

## Screenshots on this box

- Browser: `google-chrome` (Chrome for Testing). Launch with `--disable-infobars` or a "Chrome for Testing is only for automated testing" banner eats ~35px of every screenshot. `--app=<url>` does NOT hide it.
- Maximize: `wmctrl -r :ACTIVE: -b add,maximized_vert,maximized_horz` (do NOT use xdotool Super+Up — it tiles).
- Capture: `scrot <file.png>` grabs the real 1600x1200 screen; the `computer` tool's own screenshots are only 1024x768.
- After login, Chrome pops a "Save password?" dialog — click "Never" before capturing.

## Testing the /ask island (assistant-ui thread)

The Ask page is a React island (`dist/assets/ask.js` — must `npm run build` first) that streams through `/ask/oc/<threadId>/*` to a supervised `opencode serve`. To get real streaming on this box:

- Install the binary: `mkdir -p /tmp/oc && cd /tmp/oc && npm install opencode-ai` then point `ERU_OPENCODE_BIN=/tmp/oc/node_modules/.bin/opencode`.
- No LLM keys exist here, so stand up a mock OpenAI-compatible server (a ~60-line node http server answering `GET /v1/models` and SSE-streaming `POST /v1/chat/completions` word-by-word) and register it in `~/.config/opencode/opencode.json` as a custom provider (`npm: "@ai-sdk/openai-compatible"`, `options.baseURL`), plus `"model": "mock/mock-model"`. Set `ERU_OPENCODE_ASK_MODEL=mock/mock-model` so the island picks it up.
- Mock pitfalls: on modern Node, `req.on("close")`/`req.destroyed` fires right after the request body is read — listen on `res` instead or the SSE stream writes nothing and the opencode turn hangs with `parts: []`.
- Seeded page slugs should match whatever `map/<slug>.md` links the mock answer emits, so the citation rewriter turns them into `/brief/<slug>` anchors you can click.
- While streaming, the composer "Ask" button becomes "Stop" (ComposerPrimitive.Cancel). A stopped turn shows `MessageAbortedError` upstream (check `GET /ask/oc/<id>/session/<sid>/message` through the proxy) and the UI renders the generic snag error.
- The composer/input drifts downward while the page auto-scrolls — click Stop via keyboard focus (Tab to the button) rather than pixel coordinates.
- `POST /ask/api/threads` eagerly creates the upstream session and materializes the workspace (`<workdir>/<threadId>/map/*.md` + deny-by-default `opencode.json` + `AGENTS.md`); `session_id` lands in `ask_threads`. First `/ask/api/status` call can take ~30s while `opencode serve` boots (health timeout is 15s per attempt).
- Stale badge: `UPDATE repos SET last_mapped_ref=...` diverging from the thread's `mapped_ref`, then reload → `stale map` badge on the rail row.
- Security quick checks: `/ask/oc/<id>/pty|file` → 404; `?directory=/etc` is force-overwritten with the workspace; mutating proxy calls need the `X-CSRF-Token` header (the session's csrf is in `window.__ERU_ASK__` / login cookie name `eru_session`); unauthenticated GETs redirect to `/login`, mutating → 401.
- `/assets/ask.js` is NOT a public path (behind the session gate) — intentional.
- Media query `@media (max-width: 820px)` stacks `.ask-app` — resize to ~760px at 100% zoom to see the rail collapse (browser zoom changes CSS viewport width, so reset zoom first).
