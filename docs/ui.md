# The operator UI

Server-rendered HTML + HTMX, locked pastel tokens (cream, lavender, pink, mint, moss, rose), serif titles, sans body, mono paths. Every page except `/health` and `/login` sits behind the operator session cookie. `/ask` mounts the one exception: a React island (assistant-ui, bundled by esbuild into `dist/assets/ask.js`) inside the same shell — see The Ask tab.

## `/login`

The gate. Single password field (`ERU_UI_PASSWORD`), throttled, timing-safe compare, signed `HttpOnly` `SameSite=Lax` cookie. When the GitHub App client id/secret are set (on `/config` or `ERU_GITHUB_APP_CLIENT_*` / `ERU_OAUTH_*`), a **Sign in with GitHub** button appears (OAuth against a numeric-id allowlist); the password form then only shows with `ERU_UI_LOCAL_LOGIN=true`.

![login](ui/login.png)

## `/` — Brief

The home view. Top bar: Eru seal, the active repo (`owner / name`), `last mapped @ref`, a refresh icon button (re-maps the default branch, with a progress view while it runs), the segmented **Brief / Ask / Refine** tabs, **Config**, and the operator pill (GitHub avatar when `ERU_UI_USER` or the Operator setting names a login). Left column is the page table of contents; the right column renders the selected page.

With no repo connected, the empty state points at `/connect`. With a repo that has no pages yet, it points at the refresh button.

![brief home](ui/brief-home.png)

## `/brief/<slug>`

One map page from SQLite — title, body, and its spot in the TOC. Bodies are model-written markdown rendered to escaped HTML; they cite source paths from the map.

![brief page](ui/brief-page.png)

## The Ask tab

Same shell, tab switched — but the stage is a full-page assistant-ui thread. A left rail lists that repo's threads (**+ New thread**, delete, `stale map` badge when the map moved past the snapshot the thread was built from); the main column is the streaming conversation with a composer (Enter sends, **Stop** cancels, failed turns keep a **retry** action).

Under the hood each thread owns an isolated workspace under `ERU_ASK_WORKDIR` (default `<sqlite dir>/ask`): a `map/<slug>.md` snapshot of the durable map plus a deny-by-default `opencode.json` (read/glob/grep only — no bash, no edits, no checkout). The browser never talks to OpenCode directly: the island calls same-origin `/ask/oc/<threadId>/*`, and Eru's proxy injects the loopback basic-auth and workspace `directory=` server-side, allowlisting only the endpoints the adapter uses (session, event stream, permission/question replies).

Threads persist across reloads — the OpenCode session id is recorded on the thread row and the conversation resumes where it left off. Answers render as markdown with map citations (`map/<slug>.md`) rewritten to `/brief/<slug>` links; citations to pages that do not exist stay plain text. Model output is never trusted as HTML.

## The Refine tab

Same shell, tab switched. The left column is the webhook log for the **selected repo** only: each row is the issue number and the status (queued, ignored, rejected). The right column is why that delivery landed that way. A queued rewrite also shows the brief: why the verdict landed, the eight sections, and the original issue under **What arrived**.

**Log** sits in the top bar beside Config. `/log` lists every delivery, every repository, including pings and repos that are not selected. A catch from another repo is not listed on Refine and its Refine URL is a 404. Issue text and the model brief are untrusted and rendered as escaped markdown. Jobs finished before this tab existed say the story was not kept.

## `/connect`

Point Eru at a GitHub, GitLab, or Forgejo repository: pick from the connected GitHub App installation, from a GitLab/Forgejo token configured on `/config`, **or** add one manually with forge/owner/repo and an optional token (stored encrypted; optional for public GitHub, or when the instance token is already set).

![connect](ui/connect.png)

## `/config`

Brief-style layout — sticky section nav on the left (OpenCode models / Provider keys / GitHub App / GitLab / Forgejo / Operator), wide settings card on the right. Saved values win over env vars; every overridden field is marked `overrides ERU_*`.

- **OpenCode models** — separate Ask and Map model fields (`provider/model`), a datalist fed by `opencode models`, a refresh-list button.
- **Provider API keys** — write-only inputs per provider (OpenCode Zen, OpenCode Go, Anthropic, OpenAI, …), stored in OpenCode's `auth.json`, shown as a source badge plus a last-4 fingerprint.
- **GitHub App** — one App for mapping, Sign in with GitHub, and `@eru-issue-bot`: numbered setup for callback URL, webhook URL, permissions, and bot user id, then App ID, installation ID, private key, client id/secret, operator user ids, public URL, webhook secret, bot user id. **Test app config** calls GitHub with the App JWT (installation, repo list, bot user lookup) and never echoes secrets. Issue rewrite only runs on connected repos.
- **GitLab / Forgejo** — self-hosted origin + API token (write-only, encrypted) and optional webhook secret for issue rewrite on connected repos.
- **Operator** — the GitHub login shown in the top-bar pill and used for the avatar.

![config](ui/config.png)

## Chrome conventions

- `last mapped @ref` is shown in the top bar on every page after the first successful refresh.
- During refresh the whole stage swaps to the mapping view — rotating voice lines and a progress bar — and swaps back when the map lands.
- The footer holds the last-mapped timestamp and the Explore / Connect / Archive / Inspire / About links.
