# Security

Eru is not “safe by definition”. It is a **self-hosted private** durable repo map with an operator UI gate.

## Intended deployment

Run Eru on a **private network or tunnel**. Compose publishes `:3000` for that host, not for the public internet. `/health` may stay public (liveness only). Do not publish the stack with only `/health` as protection.

## Operator UI

The HTML UI is behind a shared operator password (`ERU_UI_PASSWORD`) and a signed HttpOnly session cookie (`ERU_UI_SESSION_SECRET`, `SameSite=Lax`, `Secure` on HTTPS). Cookie-authenticated POSTs require a CSRF token. Login is rate-limited. Password compare is timing-safe. This is **not** HTTP Basic Auth.

Missing UI password or session secret fails closed: the process must not start, and must not serve the operator UI.

## OpenCode

OpenCode runs with deny `bash`, `edit`, `write`, and `webfetch`. Map refresh and Ask (later tickets) fail closed on missing tool/auth config. Model output is **untrusted** — never treat it as HTML to execute, as shell, or as a secret channel.

## Forge tokens

When forge connect lands (issue #2), tokens are least privilege (read the target repo, nothing else by default). Never log tokens, session secrets, passwords, or raw cookies. Never commit `.env`.

## Forge webhooks (eru-issue-bot)

`POST /webhooks/github`, `/webhooks/gitlab`, and `/webhooks/forgejo` are public paths authenticated by a webhook secret (`X-Hub-Signature-256` HMAC on GitHub/Forgejo; `X-Gitlab-Token` compared with `timingSafeEqual` on GitLab). Missing or invalid signatures/tokens are rejected. A matching signature from a repository that is not connected in Eru returns 202 without enqueueing a job (GitHub does not retry; the path does not leak which repos exist). Repeat deliveries of the same issue are ignored (`UNIQUE(forge, owner, name, issue_number)` + `INSERT OR IGNORE`). Issue title and body are untrusted user data: they are sent to the model as text only (no tools, no repo, no secrets in context) and are never logged. The operator **Refine** tab (`/refine`) is behind the session cookie and renders that text, plus the model brief, as escaped markdown — it is not a public page. App private keys, webhook secrets, instance tokens, and installation tokens live in env / SQLite ciphertext / memory only. OpenCode children that see issue text do not inherit `ERU_*` secrets. Attach GitLab/Forgejo webhooks only on repositories you trust — those forges do not send GitHub `author_association`, and Eru still requires the repo to be connected.

## Secrets and exfil

No secret exfil through Ask, logs, map pages, or error messages. Page bodies and model answers may describe a private repo; they must not echo env, cookies, or forge credentials.

## Fail closed

- Empty or missing `ERU_UI_PASSWORD` / `ERU_UI_SESSION_SECRET`
- Session secret shorter than 16 bytes
- Empty SQLite path
- Migrate failure

The process exits. Compose does not report healthy.

## CI

CI is GitHub Actions on a self-hosted runner. The job uses `contents: read` only. It must not mount Compose volumes or production `.env`, and it does not need UI passwords or session secrets.
