# Eru

I'm curious about this repo.

Self-hosted OpenCode notes that stay with the repo. Page the map, then ask. Refresh when you want — not a checkout job, not DeepWiki.com.

> *A self-hosted service that maps a git repository into durable SQLite notes, then answers questions about them.*

Eru is named after Chitanda Eru from the anime *Hyouka*. The catchphrase above is intentional brand voice, not filler — the prose below should be read on its own terms.

## What it does

- **Map a repo.** Connect a GitHub repository — pick one from a GitHub App installation, or add it manually — and Eru has OpenCode write a page-by-page map of it into SQLite.
- **Ask against the map.** The Ask tab sends a question to OpenCode with only the stored pages materialized, and returns an answer that cites map paths.
- **Refresh on demand.** The refresh button re-maps the repository's default branch; pages update in place and the top bar shows `last mapped @ref`.
- **Self-hosted.** One Node.js process, one SQLite file, two Docker volumes.

## How it works

Eru is a single Node.js + Hono server. The operator UI is server-rendered HTML with HTMX — there is no client-side build. State lives in SQLite via better-sqlite3. Forge reads (repo verification, tarball download) go through a small GitHub adapter using a personal token or a GitHub App installation token. Ask and Refresh shell out to the OpenCode CLI inside a throwaway directory whose `opencode.json` denies every tool except read/glob/grep. Model output is untrusted text and is escaped before rendering.

```
GitHub ──► forge adapter ──► tarball ──► OpenCode ──► map pages ──► SQLite ──► Brief / Ask UI
```

## Stack

- Single Node.js >= 22 process (TypeScript, Hono) — server-rendered HTML + HTMX + CSS variables + hand CSS, no SPA framework.
- SQLite via better-sqlite3 — no Redis, no Postgres.
- Docker Compose for deployment — no Kubernetes.
- OpenCode CLI as the model backend, deny-listed to read/glob/grep tools.

## Quickstart (Docker Compose)

```sh
curl -fsSL https://raw.githubusercontent.com/Dragonshorn-Studios/eru/main/scripts/install.sh | bash
```

The installer clones to `~/.eru`, writes a `.env` (mode 600) with generated secrets, optionally bind-mounts a GitHub App key, seeds the OpenCode CLI onto a Docker volume, and starts Compose. It prints the generated UI password. Open `http://127.0.0.1:3000/login`, enter the password, then connect a repo. Flags: `--non-interactive`, `--skip-start`, `--upgrade-opencode`, `--force`. Details and troubleshooting: [docs/quickstart.md](docs/quickstart.md).

## Quickstart (local dev)

Requires Node.js >= 22, and an `opencode` binary on `PATH` for Ask and Refresh to work.

```sh
cp .env.example .env   # set ERU_UI_PASSWORD and ERU_UI_SESSION_SECRET
npm ci
npm run dev
```

Open `http://127.0.0.1:3000/login` and sign in with `ERU_UI_PASSWORD`. `GET /health` is liveness only and needs no cookie.

## Configuration

Configuration is environment variables plus values saved on `/config` — saved values win over env vars. The full list, with comments, lives in [.env.example](.env.example). Required:

- `ERU_UI_PASSWORD` — shared operator password for `/login`
- `ERU_UI_SESSION_SECRET` — HMAC secret for the signed session cookie (16+ bytes)

Recommended: `ERU_FORGE_TOKEN_KEY` — a stable key for encrypting stored forge credentials. Without it, credentials are encrypted under the session secret and become unreadable when that secret rotates. Secrets model and rotation details: [docs/configuration.md](docs/configuration.md).

## Updating the OpenCode CLI

The CLI lives on the `eru-opencode` Docker volume, not in the image. `./scripts/install.sh --upgrade-opencode` re-downloads it (latest GitHub release, or `ERU_OPENCODE_VERSION` to pin), recreates the container, and waits on `/health`.

## Where to look next

- [docs/quickstart.md](docs/quickstart.md) — install detail and first-login troubleshooting
- [docs/configuration.md](docs/configuration.md) — every environment variable, the secrets model, key rotation
- [docs/storage.md](docs/storage.md) — what lives in SQLite and the two volumes
- [docs/ui.md](docs/ui.md) — the operator UI, page by page
- [AGENTS.md](AGENTS.md) — canonical contributor/agent brief
- [CONTRIBUTING.md](CONTRIBUTING.md) — build, test, CI
- [SECURITY.md](SECURITY.md) — threat model

## What Eru is not

- Not a PR review tool — it never touches pull requests.
- Not a CI/CD pipeline — refresh runs only when the operator asks.
- Not a hosted SaaS — data stays in a local SQLite file on your own host.
- Not a checkout job — nothing is cloned permanently; the map outlives any checkout.
- Not a general chat product — Ask answers only from stored map pages.

## Related projects

For orientation only — a sibling project with a different job:

| | Maomao | Eru |
| --- | --- | --- |
| Job | Ephemeral repo brief on a checkout SHA | Durable repo map |
| Store | Review jobs; the brief does not outlive the checkout | Pages live in SQLite and refresh in place |
| Ask | Against a checkout workspace | Against the stored map |
| Product | Self-hosted PR review | Self-hosted OpenCode notes that stay with the repo |

## License

MIT — © 2026 Dragonshorn Studios. See [LICENSE](LICENSE).
