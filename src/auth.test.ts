import { describe, expect, it } from "vitest";
import {
  LoginLimiter,
  cookieSecure,
  csrfOK,
  isPublicPath,
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

  it("keeps health, login, and assets public", () => {
    expect(isPublicPath("/health")).toBe(true);
    expect(isPublicPath("/login")).toBe(true);
    expect(isPublicPath("/assets/eru.css")).toBe(true);
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
