# Eru

I'm curious about this repo.

Self-hosted OpenCode notes that stay with the repo. Page the map, then ask. Refresh when you want — not a checkout job, not DeepWiki.com.

Agents and contributors: [AGENTS.md](AGENTS.md) · [SECURITY.md](SECURITY.md) · [CONTRIBUTING.md](CONTRIBUTING.md).

## Eru is not Maomao

| | Maomao | Eru |
| --- | --- | --- |
| Job | Ephemeral Repo brief on a checkout SHA | Durable repo map |
| Store | Review jobs; the brief does not outlive the checkout | Pages live in SQLite and refresh in place |
| Ask | Against a checkout workspace | Against the stored map |
| Product | Self-hosted PR review | Self-hosted OpenCode notes that stay with the repo |

Never Eruka. Never merge into Maomao. Never DeepWiki.com SaaS.

Chrome labels: **Brief** · **Ask** · `last mapped @ref`.

## Stack

Node.js >= 22, TypeScript, Hono, better-sqlite3, HTMX + CSS variables + hand CSS (no Tailwind pipeline), OpenCode (deny bash/edit/write/webfetch), MIT, Docker Compose. CI on a self-hosted runner.

No React SPA for chrome. No Redis. No Postgres. No Kubernetes. No GraphQL.

## Run locally

Copy `.env.example` to `.env` and set `ERU_UI_PASSWORD` and `ERU_UI_SESSION_SECRET`.

```sh
npm ci
npm run dev
```

Open `http://127.0.0.1:3000/login`. `GET /health` is liveness only and does not need a cookie.

```sh
npm run typecheck
npm test
npm run build
npm start
```

## Compose

```sh
cp .env.example .env
# set ERU_UI_PASSWORD and ERU_UI_SESSION_SECRET — Compose fails closed if they are missing
docker compose up --build
```

Compose publishes `:3000` for a **private host or tunnel**. Do not put this stack on the public internet with only `/health`. The operator UI is a shared-password gate at `/login` (not Basic Auth). The process is non-root.

SQLite lives on the `eru-data` volume at `/data/eru.sqlite`.

## Schema

On start Eru migrates:

- `repos` — connected forge identity (`owner` / `name` / `forge`) and `last_mapped_ref` (filled by issues #2 and #5)
- `pages` — durable map pages (`slug`, `title`, `body`, `sort_order`) scoped to a repo (filled by issues #3 and #5)

Re-running migrate is a no-op once those files are recorded. Connect a GitHub repo at `/connect`; the token is stored encrypted and used only for forge reads.

Ask shells out to OpenCode (`ERU_OPENCODE_BIN`, default `opencode`). Each question runs in a throwaway directory holding only the materialized `map/*.md` files, with an `opencode.json` that denies every tool except read/glob/grep (never bash, edit, write, or webfetch). A missing or failing binary fails closed with an operator notice.

## License

MIT
