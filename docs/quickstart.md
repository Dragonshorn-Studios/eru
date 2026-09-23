# Quickstart

Two paths: the one-line installer (Docker Compose, recommended for running Eru for real) or local dev (`npm run dev`).

## Installer (Docker Compose)

```sh
curl -fsSL https://raw.githubusercontent.com/Dragonshorn-Studios/eru/main/scripts/install.sh | bash
```

What it does, in order:

1. Uses the current checkout if you run it inside one, otherwise clones `https://github.com/Dragonshorn-Studios/eru.git` (branch `main`) to `~/.eru`. Override with `ERU_HOME`, `ERU_REPO_URL`, `ERU_REPO_REF`.
2. Writes `.env` (mode 600) seeded from `.env.example` with generated `ERU_UI_PASSWORD`, `ERU_UI_SESSION_SECRET`, and `ERU_FORGE_TOKEN_KEY`.
3. Optionally configures a GitHub App: copies the PEM to `github-app.pem` (mode 400, uid 1000) and generates `docker-compose.override.yml` bind-mounting it to `/run/secrets/github-app.pem`. The PEM never lands in `.env`.
4. Downloads the OpenCode CLI from GitHub releases onto the `eru-opencode` volume.
5. Runs `docker compose up -d` and waits for `http://127.0.0.1:<port>/health`.
6. Prints the UI URL and the generated password (also stored in `.env`).

Flags:

| Flag | Effect |
| --- | --- |
| `--non-interactive`, `-y` | No prompts; every value comes from the environment (see `./scripts/install.sh --help`) |
| `--skip-start` | Write `.env` and mounts only; no Docker |
| `--upgrade-opencode` | Re-seed the OpenCode CLI, recreate the container, wait on `/health` |
| `--force` | Overwrite an existing `.env` (default is to reuse it) |

First login: open `http://127.0.0.1:3000/login` and enter `ERU_UI_PASSWORD`. Then `/connect` a repository — pick from the GitHub App installation's list, or enter owner/repo manually (a token is optional for public repos). Press the refresh icon to build the first map.

## Local dev

Requires Node.js >= 22.

```sh
cp .env.example .env   # set ERU_UI_PASSWORD and ERU_UI_SESSION_SECRET
npm ci
npm run dev
```

Open `http://127.0.0.1:3000/login`. Ask and Refresh need an `opencode` binary — set `ERU_OPENCODE_BIN` to its path, or install OpenCode so it is on `PATH`. Without it those actions fail closed with an operator notice; the Brief UI still works.

## Troubleshooting

**Ask/Refresh say OpenCode is missing under Compose.** A bare `docker compose up` never seeds the `eru-opencode` volume — the default `ERU_OPENCODE_BIN` (`/opt/opencode/.opencode/bin/opencode`) points at nothing. Fix with `./scripts/install.sh --upgrade-opencode`, or point `ERU_OPENCODE_BIN` at a binary you provide.

**`ERU_GITHUB_APP_PRIVATE_KEY_FILE is unreadable` at boot.** The bind mount preserves host ownership and mode; the container reads the PEM as uid 1000. A `400`/`600` file owned by a different host uid is denied. Fix on the host: `sudo chown 1000:1000 github-app.pem && chmod 400 github-app.pem` (or `setfacl -m u:1000:r github-app.pem`), then `docker compose up -d --force-recreate`. The installer applies this automatically — re-running it repairs permissions — and its pre-flight check verifies the PEM is readable inside the container before `up`. If the file exists but was created *after* the first `up`, recreate so Docker stops mounting a stale directory.

**Container won't start / exits immediately.** Eru fails closed on missing or invalid config — check `docker compose logs eru` for the exact `eru: ERU_*` error. Common causes: `ERU_UI_PASSWORD` or `ERU_UI_SESSION_SECRET` unset, a session secret under 16 bytes, or a GitHub App ID without a private key.

**Port already in use.** Set `ERU_PORT` in `.env` — it controls the host port; the container always listens on 3000.

**`/health` times out after install.** Run `docker compose logs --tail 120 eru`. The installer polls for 3 minutes; a fresh image build plus first migration normally takes under one.
