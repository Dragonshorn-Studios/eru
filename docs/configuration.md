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
| `ERU_OPENCODE_BIN` | `opencode` | Path to the OpenCode CLI; Compose defaults to `/opt/opencode/.opencode/bin/opencode`. Eru reads `--version` and uses `run` on 1.x or `run --standalone` on 2.x. Ask also spawns a supervised `opencode serve` on loopback (random port + per-boot basic-auth password, proxied at `/ask/oc/*`) — it never opens a second listening port |
| `ERU_OPENCODE_TIMEOUT_MS` | `120000` | Timeout for OpenCode invocations (also settable on `/config`) |
| `ERU_OPENCODE_ASK_MODEL` | — | `provider/model` for Ask |
| `ERU_OPENCODE_MAP_MODEL` | — | `provider/model` for map generation |
| `ERU_OPENCODE_MODEL` | — | Both purposes (lowest precedence) |
| `ERU_ASK_WORKDIR` | `<sqlite dir>/ask` | Root for per-thread Ask workspaces (`map/` snapshot + deny config). Persists on the `eru-data` volume by default; point it elsewhere to relocate or to wipe on boot |
| `ERU_GITHUB_APP_ID` | — | GitHub App ID (mapping + login + issue bot) |
| `ERU_GITHUB_APP_PRIVATE_KEY` / `ERU_GITHUB_APP_PRIVATE_KEY_FILE` | — | App private key, inline or file path |
| `ERU_GITHUB_APP_INSTALLATION_ID` | — | Installation ID (auto-detected when omitted) |
| `ERU_GITHUB_APP_CLIENT_ID` / `ERU_GITHUB_APP_CLIENT_SECRET` | — | App OAuth client credentials for Sign in with GitHub (`ERU_OAUTH_*` are aliases) |
| `ERU_GITHUB_APP_ADMIN_IDS` | — | Comma-separated numeric GitHub user ids allowed to sign in (`ERU_OAUTH_ADMIN_IDS` is an alias) |
| `ERU_GITHUB_APP_WEBHOOK_SECRET` | — | HMAC secret for `POST /webhooks/github` (`ERU_ISSUE_BOT_WEBHOOK_SECRET` is an alias) |
| `ERU_GITHUB_APP_BOT_USER_ID` | — | GitHub user id of `your-app[bot]` (`ERU_ISSUE_BOT_USER_ID` is an alias) |
| `ERU_ISSUE_BOT_APP_ID` | — | Optional dedicated issue-bot App ID. Any dedicated App ID or PEM requires the full dedicated set (ID + PEM + `ERU_ISSUE_BOT_WEBHOOK_SECRET` + `ERU_ISSUE_BOT_USER_ID`) with no mapping-App fallback |
| `ERU_ISSUE_BOT_PRIVATE_KEY` / `ERU_ISSUE_BOT_PRIVATE_KEY_FILE` | — | Optional dedicated issue-bot PEM |
| `ERU_ISSUE_BOT_WEBHOOK_SECRET` | — | Dedicated webhook HMAC secret when a dedicated App is set; otherwise an alias for `ERU_GITHUB_APP_WEBHOOK_SECRET` |
| `ERU_ISSUE_BOT_USER_ID` | — | Dedicated bot user id when a dedicated App is set; otherwise an alias for `ERU_GITHUB_APP_BOT_USER_ID` |
| `ERU_TRUSTED_BOT_IDS` | — | Comma-separated GitHub user ids allowed to trigger a rewrite besides OWNER/MEMBER/COLLABORATOR |
| `ERU_ISSUE_BOT_HOURLY_CAP` | `20` | Max refine jobs enqueued per owner/repo per hour |
| `ERU_GITLAB_URL` / `ERU_GITLAB_TOKEN` | — | Self-hosted GitLab origin + PAT (also settable on `/config`) |
| `ERU_GITLAB_WEBHOOK_SECRET` | — | Token compared to `X-Gitlab-Token` on `POST /webhooks/gitlab` |
| `ERU_FORGEJO_URL` / `ERU_FORGEJO_TOKEN` | — | Self-hosted Forgejo origin + token (also settable on `/config`) |
| `ERU_FORGEJO_WEBHOOK_SECRET` | — | HMAC secret for `POST /webhooks/forgejo` |
| `ERU_OAUTH_CLIENT_ID` / `ERU_OAUTH_CLIENT_SECRET` | — | Aliases for GitHub App client credentials — both or neither |
| `ERU_OAUTH_ADMIN_IDS` | — | Alias for operator GitHub user ids (required with OAuth) |
| `ERU_PUBLIC_URL` | — | Public URL Eru is reached at, e.g. `https://eru.example` (required with OAuth) |
| `ERU_UI_LOCAL_LOGIN` | `false` | Keep the shared-password form when OAuth is on |
| `XDG_DATA_HOME` | — | Where `auth.json` lives; Compose sets `/data/xdg` on the `eru-data` volume |

## GitHub OAuth login

The same GitHub App's client id/secret enables a "Sign in with GitHub" button on `/login`. Setup:

1. On the GitHub App, set the authorization callback URL to exactly `$ERU_PUBLIC_URL/login/github/callback`.
2. Set `ERU_PUBLIC_URL` (or save Public URL on `/config`) to the URL operators use to reach Eru (no trailing slash).
3. Set operator GitHub user ids (`ERU_GITHUB_APP_ADMIN_IDS` / `ERU_OAUTH_ADMIN_IDS`, or the `/config` field) — the id is checked on every request, so removing an id locks that account out at the next page load.
4. `ERU_UI_LOCAL_LOGIN=true` keeps the shared-password form alongside the GitHub button — useful as a break-glass path. First boot uses the password until client credentials are saved.

On `/config`, the GitHub App section lists those callback and webhook URLs for the current public URL. **Test app config** signs a JWT and calls GitHub (`GET /app`, installation token, repo list, `your-app[bot]` lookup). It reports what works and what is still missing; it never prints the PEM, client secret, or webhook secret.

Sessions carry the GitHub identity (login + avatar) in the signed cookie; the OAuth token is used once to fetch the profile and then discarded.

Every field that exists on `/config` (models, operator login, GitHub App, GitLab, Forgejo) can also be set here — a saved value overrides the env var, and the page marks it.

## GitLab and Forgejo

Set a base URL and API token on `/config` (or `ERU_GITLAB_*` / `ERU_FORGEJO_*`). Eru lists repos the token can see, maps them from a tarball, and — with a webhook secret — rewrites issues that mention `@eru-issue-bot` on connected repos. GitLab uses `PRIVATE-TOKEN` and `X-Gitlab-Token`; Forgejo uses `Authorization: token` and HMAC signatures. Partial env config (URL without token, or the reverse) fails closed at boot. Tokens are encrypted like other forge credentials and never logged or rendered back. Attach the webhook only on repositories you trust: the secret is the authentication, GitLab/Forgejo payloads do not carry GitHub-style `author_association`, and Eru still ignores a matching secret from a repo that is not connected.

## eru-issue-bot

Optional. One GitHub App is enough (`ERU_GITHUB_APP_*` plus webhook secret and bot user id); a dedicated `ERU_ISSUE_BOT_*` App is an optional split and must be complete (App ID, PEM, webhook secret, bot user id) — a dedicated App ID is never paired with the mapping App's PEM or webhook secret. When App ID, private key, webhook secret, and bot user id all resolve, Eru accepts GitHub `issues` webhooks at `POST /webhooks/github` and rewrites newly opened issues that mention `@eru-issue-bot` on repositories connected in Eru. GitLab and Forgejo use `/webhooks/gitlab` and `/webhooks/forgejo` once their instance webhook secret is set. A matching signature from an unconnected repo returns 202 without enqueueing. The JSON body names the decision and the repo from that delivery, so the forge’s delivery log shows why. Setup steps live in the [README](../README.md#github-app-mapping--login--issue-bot). Partial env config fails closed at boot. The webhook secret, private key, and minted installation tokens are never logged or rendered back.
