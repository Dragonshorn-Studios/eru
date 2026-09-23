import { describe, expect, it } from "vitest";
import {
  LoginLimiter,
  OAuthStateStore,
  clientKey,
  cookieSecure,
  csrfOK,
  isPublicPath,
  issueOAuthSession,
  issueSession,
  passwordsMatch,
  safeNextPath,
  signSession,
  verifySession,
} from "./auth.js";

describe("session helpers", () => {
  it("round-trips a signed session and rejects tampering or expiry", () => {
    const issued = issueSession("test-session-secret", 1_000, 60_000);
    expect(verifySession("test-session-secret", issued.token, 1_500)?.csrf).toBe(issued.session.csrf);
    expect(verifySession("other-session-secret", issued.token, 1_500)).toBeUndefined();
    expect(verifySession("test-session-secret", issued.token.slice(0, -2) + "ab", 1_500)).toBeUndefined();
    expect(verifySession("test-session-secret", issued.token, 100_000)).toBeUndefined();
  });

  it("compares passwords without throwing on length mismatch", () => {
    expect(passwordsMatch("pw", "pw")).toBe(true);
    expect(passwordsMatch("pw", "no")).toBe(false);
    expect(passwordsMatch("", "x")).toBe(false);
  });

  it("only allows same-origin relative next paths", () => {
    expect(safeNextPath("/brief/auth")).toBe("/brief/auth");
    expect(safeNextPath("https://evil.test")).toBe("/");
    expect(safeNextPath("//evil.test")).toBe("/");
    expect(safeNextPath("/login")).toBe("/");
  });

  it("keeps health, login, and an exact asset allowlist public", () => {
    expect(isPublicPath("/health")).toBe(true);
    expect(isPublicPath("/login")).toBe(true);
    expect(isPublicPath("/favicon.ico")).toBe(true);
    expect(isPublicPath("/assets/favicon-32.png")).toBe(true);
    expect(isPublicPath("/assets/apple-touch-icon.png")).toBe(true);
    expect(isPublicPath("/assets/eru.css")).toBe(true);
    expect(isPublicPath("/assets/htmx.min.js")).toBe(true);
    expect(isPublicPath("/assets/")).toBe(false);
    expect(isPublicPath("/assets/secret.css")).toBe(false);
    expect(isPublicPath("/assets/eru.css.bak")).toBe(false);
    expect(isPublicPath("/")).toBe(false);
    expect(isPublicPath("/ask")).toBe(false);
  });

  it("sets Secure only for HTTPS", () => {
    expect(cookieSecure("http://127.0.0.1:3000/login")).toBe(false);
    expect(cookieSecure("https://eru.example/login")).toBe(true);
    expect(cookieSecure("http://eru.example/login", "https")).toBe(true);
  });

  it("requires a matching csrf token", () => {
    const session = { exp: 9_999, csrf: "token-a" };
    expect(csrfOK(session, "token-a", undefined)).toBe(true);
    expect(csrfOK(session, undefined, "token-a")).toBe(true);
    expect(csrfOK(session, "other", undefined)).toBe(false);
    expect(csrfOK(session, undefined, undefined)).toBe(false);
  });

  it("signs v1 payloads", () => {
    const token = signSession("secret", { exp: 2_000, csrf: "abc" });
    expect(token.startsWith("v1.2000.abc.")).toBe(true);
  });

  it("round-trips v2 OAuth sessions with the GitHub identity", () => {
    const gh = { id: 42, login: "octo-cat", avatarUrl: "https://avatars.githubusercontent.com/u/42" };
    const { token, session } = issueOAuthSession("secret", gh, 1_000);
    expect(token.startsWith("v2.")).toBe(true);
    expect(verifySession("secret", token, 1_500)).toEqual(session);
    expect(verifySession("other", token, 1_500)).toBeUndefined();
    expect(verifySession("secret", `${token}x`, 1_500)).toBeUndefined();
    expect(verifySession("secret", token, session.exp)).toBeUndefined();
    expect(verifySession("secret", undefined)).toBeUndefined();
    const noAvatar = issueOAuthSession("secret", { id: 7, login: "plain", avatarUrl: null }, 1_000);
    expect(verifySession("secret", noAvatar.token, 1_500)?.github?.avatarUrl).toBeNull();
    // A non-https avatar (or a tampered payload) never survives verification.
    const evil = issueOAuthSession("secret", { id: 9, login: "js", avatarUrl: "javascript:alert(1)" }, 1_000);
    expect(verifySession("secret", evil.token, 1_500)?.github?.avatarUrl).toBeNull();
    expect(() => issueOAuthSession("secret", { id: 0, login: "x", avatarUrl: null })).toThrow();
    expect(() => issueOAuthSession("secret", { id: 1, login: "", avatarUrl: null })).toThrow();
  });
});

describe("oauth state store", () => {
  it("issues single-use states with a next path and a TTL", () => {
    const store = new OAuthStateStore();
    const state = store.issue(1_000, 60_000, "/config");
    expect(store.consume(state, 2_000)).toBe("/config");
    expect(store.consume(state, 2_000)).toBeUndefined();
    expect(store.consume(undefined, 2_000)).toBeUndefined();
    const expired = store.issue(1_000, 60_000);
    expect(store.consume(expired, 62_000)).toBeUndefined();
    // Issue sweeps expired entries so abandoned flows do not accumulate.
    const fresh = store.issue(70_000, 60_000);
    expect(store.consume(fresh, 71_000)).toBe("/");
  });
});

describe("login limiter", () => {
  it("allows up to the limit then refuses", () => {
    const limiter = new LoginLimiter(3, 60_000);
    expect(limiter.allow("1.2.3.4", 1_000)).toBe(true);
    expect(limiter.allow("1.2.3.4", 1_100)).toBe(true);
    expect(limiter.allow("1.2.3.4", 1_200)).toBe(true);
    expect(limiter.allow("1.2.3.4", 1_300)).toBe(false);
    expect(limiter.allow("9.9.9.9", 1_300)).toBe(true);
  });
});

describe("clientKey", () => {
  it("uses the first X-Forwarded-For hop when it is IP-like", () => {
    expect(clientKey("203.0.113.10, 10.0.0.1", "198.51.100.5", "127.0.0.1")).toBe("203.0.113.10");
    expect(clientKey("2001:db8::1, 10.0.0.1")).toBe("2001:db8::1");
  });

  it("falls through to X-Real-IP, then the socket, then local", () => {
    expect(clientKey("unknown", "198.51.100.5", "127.0.0.1")).toBe("198.51.100.5");
    expect(clientKey("not-an-ip", "also-not", "10.1.2.3")).toBe("10.1.2.3");
    expect(clientKey("unknown", "nope", undefined)).toBe("local");
    expect(clientKey(undefined, undefined, undefined)).toBe("local");
  });
});
