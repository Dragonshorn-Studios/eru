---
name: eru-security
description: Use this when touching auth, sessions, secrets, CSRF, OpenCode permissions, or forge tokens.
---

# Eru security

Read [AGENTS.md](../../../AGENTS.md) and [SECURITY.md](../../../SECURITY.md). Do not invent a second auth scheme.

- Fail closed: missing or empty config, migrate failure, or missing UI password / session secret → do not serve the operator UI.
- Operator UI: shared password from env + signed HttpOnly session cookie (`SameSite=Lax`, `Secure` when HTTPS). Timing-safe password compare. **Never HTTP Basic Auth.**
- CSRF token required on cookie-authenticated POSTs. `SameSite=Lax` alone is not enough. Rate-limit login and other unauthenticated POSTs.
- Never log passwords, session secrets, raw cookies, or forge tokens. No secrets in git.
- OpenCode deny `bash`, `edit`, `write`, `webfetch`. Model output is untrusted. No secret exfil through Ask, pages, logs, or errors.
- Forge tokens (issue #2) are least privilege. Production forge crypto is not in this shell.
