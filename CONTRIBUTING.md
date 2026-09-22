# Contributing

Agents: read [AGENTS.md](AGENTS.md) first, then the two skills [eru-shape](.cursor/skills/eru-shape/SKILL.md) and [eru-security](.cursor/skills/eru-security/SKILL.md). Threat model: [SECURITY.md](SECURITY.md).

Prefer **squash** merges. One PR per ticketed slice.

Chrome is CSS variables plus hand CSS in `src/theme.ts` (served at `/assets/eru.css`). This is not a Tailwind pipeline; do not add Tailwind in this slice.

## Build and test

Node.js >= 22.

```sh
npm ci
npm run typecheck
npm test
npm run build
```

## Local run

Copy `.env.example` to `.env` and set `ERU_UI_PASSWORD` and `ERU_UI_SESSION_SECRET` (placeholders are not for production). Then:

```sh
npm run dev
```

Open `/login` for the operator gate. `GET /health` is liveness only.

## Compose

```sh
docker compose up --build
```

`:3000` is for a **private host or tunnel**. Compose fails closed if `ERU_UI_PASSWORD` or `ERU_UI_SESSION_SECRET` are missing. The process is non-root. SQLite lives on the `eru-data` volume.

## CI

GitHub Actions on a self-hosted runner (`.github/workflows/ci.yml`): `npm ci`, `npm run typecheck`, `npm test`.

The job uses `permissions: contents: read`. It does not mount Compose volumes or production `.env`, and it does not need UI passwords or session secrets.

## Agent instruction paths

Source of truth is `AGENTS.md` plus the two skills. Other tools get **pointers or shared paths**, not a second brief.

| Tool | Instructions | Skills |
| --- | --- | --- |
| Cursor | `AGENTS.md` | `.cursor/skills/eru-shape`, `.cursor/skills/eru-security` |
| Codex | `AGENTS.md` | `.agents/skills/` (thin pointers to the Cursor skills) |
| OpenCode | `AGENTS.md` | `.agents/skills/` (OpenCode also searches this path) |
| zcode | `AGENTS.md` | none extra; follow the skill links in `AGENTS.md` |
| Devin | `AGENTS.md` | `.devin/global_rules.md` points at `AGENTS.md` and the two skills |
| Vibe | `AGENTS.md` | `.agents/skills/` (Vibe also searches this path) |

Do not add a third skill. Do not copy Cursor skill bodies into `.agents/skills/`. Do not duplicate `AGENTS.md` into `CLAUDE.md`, `DEVIN.md`, or per-tool long-form copies.
