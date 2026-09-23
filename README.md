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

## Install (one line)

```sh
curl -fsSL https://raw.githubusercontent.com/Dragonshorn-Studios/eru/main/scripts/install.sh | bash
```

The installer clones (or reuses) a checkout at `~/.eru`, writes a `.env` (mode 600) with generated `ERU_UI_PASSWORD`, `ERU_UI_SESSION_SECRET`, and `ERU_FORGE_TOKEN_KEY`, optionally bind-mounts a GitHub App PEM, downloads the OpenCode CLI onto the `eru-opencode` volume, and starts Compose. Flags: `--non-interactive` (env-driven), `--skip-start`, `--upgrade-opencode`, `--force`. Provider API keys are saved write-only on `/config`, not in `.env`.

## Compose

```sh
cp .env.example .env
# set ERU_UI_PASSWORD and ERU_UI_SESSION_SECRET — Compose fails closed if they are missing
docker compose up --build
```

Bare `docker compose up` does not seed the OpenCode CLI — with an empty `eru-opencode` volume the default `ERU_OPENCODE_BIN=/opt/opencode/.opencode/bin/opencode` is missing and Ask/Refresh fail closed with an operator notice. Run `./scripts/install.sh` (or `./scripts/install.sh --upgrade-opencode` later) to seed it, or point `ERU_OPENCODE_BIN` at a binary you provide.

Compose publishes `:3000` for a **private host or tunnel**. Do not put this stack on the public internet with only `/health`. The operator UI is a shared-password gate at `/login` (not Basic Auth). The process is non-root.

SQLite lives on the `eru-data` volume at `/data/eru.sqlite`, next to OpenCode's `auth.json` under `/data/xdg`.

## Schema

On start Eru migrates:

- `repos` — connected forge identity (`owner` / `name` / `forge`) and `last_mapped_ref` (filled by issues #2 and #5)
- `pages` — durable map pages (`slug`, `title`, `body`, `sort_order`) scoped to a repo (filled by issues #3 and #5)

Re-running migrate is a no-op once those files are recorded. Connect a GitHub repo at `/connect`; the token is stored encrypted (AES-256-GCM; set `ERU_FORGE_TOKEN_KEY` to keep it decryptable across session-secret rotation) and used only for forge reads.

A GitHub App can replace the manual token: set `ERU_GITHUB_APP_ID` + `ERU_GITHUB_APP_PRIVATE_KEY` (or `_FILE`, plus optional `ERU_GITHUB_APP_INSTALLATION_ID`) in `.env`, or save the same fields on `/config` (the PEM is stored with the same encrypted envelope). `/connect` then lists the installation's repositories to pick from — or a repo can still be added manually. App-connected repos refresh with short-lived installation tokens minted on demand; saved `/config` values always win over environment variables.

Ask shells out to OpenCode (`ERU_OPENCODE_BIN`, default `opencode`). Each question runs in a throwaway directory holding only the materialized `map/*.md` files, with an `opencode.json` that denies every tool except read/glob/grep (never bash, edit, write, or webfetch). A missing or failing binary fails closed with an operator notice.

Provider API keys are managed on `/config` → Provider keys: they are written to OpenCode's own `auth.json` (`$XDG_DATA_HOME/opencode/auth.json`), never to the eru database or `.env`. Keys are write-only (the page shows source and a last-4 fingerprint), a stored key overrides the env var of the same provider, and OAuth providers still enroll with `opencode auth login`. In Compose the container is read-only, so `XDG_DATA_HOME` defaults to `/data/xdg` on the `eru-data` volume.

## License

MIT
