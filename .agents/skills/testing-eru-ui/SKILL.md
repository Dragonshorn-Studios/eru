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
