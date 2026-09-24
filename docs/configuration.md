# Configuration

Configuration comes from two places: environment variables (`.env`, or the Compose container env) and values saved on `/config` in the UI. **Saved values win over env vars; env vars win over defaults.** A field that shadows an env var is marked on the page (`overrides ERU_*`). Clearing a saved field falls back to `.env`, then to the default.

The authoritative list with comments is [.env.example](../.env.example). This page is the guided tour.

## Required

These are `:?`-required in `compose.yaml` and validated at boot; Eru fails closed without them.

| Variable | Purpose |
| --- | --- |
| `ERU_UI_PASSWORD` | Shared operator password for `/login`. The installer generates one. |
| `ERU_UI_SESSION_SECRET` | HMAC key for the signed session cookie, 16+ bytes. Rotate to invalidate all sessions. |

## Secrets model

Three kinds of secrets, three different homes — deliberately:

- **Stored forge tokens** (per-repo PATs entered on `/connect`, the GitHub App private key saved on `/config`) are encrypted AES-256-GCM in SQLite under `ERU_FORGE_TOKEN_KEY` — or under `ERU_UI_SESSION_SECRET` when the key is unset.
- **Provider API keys** (OpenAI, Anthropic, OpenCode Zen/Go, …) entered on `/config` are written to OpenCode's own `auth.json` under `XDG_DATA_HOME` — write-only, never the eru database, and never rendered back. An env var (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `OPENCODE_API_KEY`, …) also works and is marked `env` on the page; OAuth providers enroll with `opencode auth login` instead.
- **`.env` values** are deployment config owned by the operator — the Compose stack only.

## `ERU_FORGE_TOKEN_KEY`

Optional but recommended (16+ bytes). It separates the encryption key for stored credentials from the session secret, so rotating `ERU_UI_SESSION_SECRET` does not orphan saved tokens. Set it at install time and keep it stable. A blank value is ignored like any other unset optional env.

Rotation story: there is no re-encryption migration. If `ERU_FORGE_TOKEN_KEY` (or the session secret it falls back to) changes, previously stored credentials become unreadable — connect pages re-prompt for a token. To rotate cleanly, remove stored repos' tokens first, rotate, then re-enter them.

## Optional envs

| Variable | Default | Purpose |
| --- | --- | --- |
| `ERU_HOST` | `0.0.0.0` | Bind address |
| `ERU_PORT` | `3000` | Container port (and host port in Compose) |
| `ERU_SQLITE_PATH` | `./data/eru.sqlite` | SQLite file location |
| `ERU_UI_USER` | — | GitHub login for the top-bar pill + avatar (also settable on `/config`) |
| `ERU_OPENCODE_BIN` | `opencode` | Path to the OpenCode CLI; Compose defaults to `/opt/opencode/.opencode/bin/opencode`. Ask also spawns a supervised `opencode serve` on loopback (random port + per-boot basic-auth password, proxied at `/ask/oc/*`) — it never opens a second listening port |
| `ERU_OPENCODE_TIMEOUT_MS` | `120000` | Timeout for OpenCode invocations (also settable on `/config`) |
| `ERU_OPENCODE_ASK_MODEL` | — | `provider/model` for Ask |
| `ERU_OPENCODE_MAP_MODEL` | — | `provider/model` for map generation |
| `ERU_OPENCODE_MODEL` | — | Both purposes (lowest precedence) |
| `ERU_ASK_WORKDIR` | `<sqlite dir>/ask` | Root for per-thread Ask workspaces (`map/` snapshot + deny config). Persists on the `eru-data` volume by default; point it elsewhere to relocate or to wipe on boot |
| `ERU_GITHUB_APP_ID` | — | GitHub App ID |
| `ERU_GITHUB_APP_PRIVATE_KEY` / `ERU_GITHUB_APP_PRIVATE_KEY_FILE` | — | App private key, inline or file path |
| `ERU_GITHUB_APP_INSTALLATION_ID` | — | Installation ID (auto-detected when omitted) |
| `ERU_OAUTH_CLIENT_ID` / `ERU_OAUTH_CLIENT_SECRET` | — | GitHub OAuth App credentials — both or neither |
| `ERU_OAUTH_ADMIN_IDS` | — | Comma-separated numeric GitHub user ids allowed to sign in (required with OAuth) |
| `ERU_PUBLIC_URL` | — | Public URL Eru is reached at, e.g. `https://eru.example` (required with OAuth) |
| `ERU_UI_LOCAL_LOGIN` | `false` | Keep the shared-password form when OAuth is on |
| `XDG_DATA_HOME` | — | Where `auth.json` lives; Compose sets `/data/xdg` on the `eru-data` volume |

## GitHub OAuth login

Setting `ERU_OAUTH_CLIENT_ID` + `ERU_OAUTH_CLIENT_SECRET` enables a "Sign in with GitHub" button on `/login`. Setup:

1. Create an OAuth App under GitHub → Settings → Developer settings. The authorization callback URL must be exactly `$ERU_PUBLIC_URL/login/github/callback`.
2. Set `ERU_PUBLIC_URL` to the URL operators use to reach Eru (no trailing slash needed).
3. Set `ERU_OAUTH_ADMIN_IDS` to the comma-separated numeric GitHub user ids allowed in — the id is checked on every request, so removing an id locks that account out at the next page load.
4. `ERU_UI_LOCAL_LOGIN=true` keeps the shared-password form alongside the GitHub button — useful as a break-glass path.

Sessions carry the GitHub identity (login + avatar) in the signed cookie; the OAuth token is used once to fetch the profile and then discarded.

Every field that exists on `/config` (models, operator login, GitHub App) can also be set here — a saved value overrides the env var, and the page marks it.
