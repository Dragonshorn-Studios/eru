# Storage

Eru keeps all state in one SQLite file (via better-sqlite3, WAL mode) plus OpenCode's credential file. No Redis, no Postgres.

## SQLite (`ERU_SQLITE_PATH`, default `./data/eru.sqlite`)

| Table | Contents |
| --- | --- |
| `repos` | Connected repositories: owner, name, forge, `default_branch`, `last_mapped_ref`, active selection |
| `forge_credentials` | Forge tokens and the GitHub App private key — AES-256-GCM encrypted under `ERU_FORGE_TOKEN_KEY` (or the session secret) |
| `pages` | Map pages per repo: `slug`, `title`, `body`, `sort_order` — upserted in place on refresh |
| `settings` | `/config` values: models, operator login, GitHub App fields |
| `migrations` | Applied schema migrations (`migrations/0001`–`0005`) |

Migrations run at boot; Eru fails closed if they fail.

## Volumes (Compose)

| Volume | Mount | Contents |
| --- | --- | --- |
| `eru-data` | `/data` | `eru.sqlite`, plus `xdg/opencode/auth.json` (provider API keys, written by `/config`) |
| `eru-opencode` | `/opt/opencode` | The seeded OpenCode CLI the container runs |

## What survives restarts

Repositories, map pages, saved `/config` settings, encrypted credentials, and provider keys in `auth.json` — everything on the two volumes. The container filesystem is read-only and ephemeral; `HOME=/data` exists so the Bun-compiled OpenCode CLI has a writable cache directory.

## What rotates

- Session cookies rotate with `ERU_UI_SESSION_SECRET` — all logins invalidate.
- Refresh scratch workspaces live in a throwaway temp dir per run and are deleted afterward.
- Ask thread workspaces persist under `ERU_ASK_WORKDIR` (default `<sqlite dir>/ask`, on the volume): each holds a `map/` snapshot plus a deny-by-default `opencode.json` so a reload can resume the session. They're re-materializable caches — orphaned directories are swept at boot and missing ones rebuild from the current map on next access.
- The app's `/tmp` is a tmpfs in Compose — nothing persists there.

## Cleanup

There is no page pruning today: `pages` rows upsert in place on refresh, and rows for slugs a map no longer produces are left behind. SQLite stays small in practice (pages are text), but orphaned rows accumulate across renames — tracked as a known deferred item.
