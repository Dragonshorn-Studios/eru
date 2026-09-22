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
