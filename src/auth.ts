import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";

export const SESSION_COOKIE = "eru_session";
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
export const CSRF_FIELD = "csrf";
export const CSRF_HEADER = "X-CSRF-Token";

export interface GithubIdentity {
  id: number;
  login: string;
  avatarUrl: string | null;
}

export interface UiSession {
  exp: number;
  csrf: string;
  github?: GithubIdentity;
}

export class LoginLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    readonly limit = 5,
    readonly windowMs = 60_000,
  ) {}

  allow(key: string, now = Date.now()): boolean {
    const cutoff = now - this.windowMs;
    const kept = (this.hits.get(key) ?? []).filter((stamp) => stamp > cutoff);
    if (kept.length >= this.limit) {
      this.hits.set(key, kept);
      return false;
    }
    kept.push(now);
    this.hits.set(key, kept);
    return true;
  }
}

export function safeEqual(a: string, b: string): boolean {
  const digestA = createHmac("sha256", "eru-eq").update(a).digest();
  const digestB = createHmac("sha256", "eru-eq").update(b).digest();
  return timingSafeEqual(digestA, digestB);
}

export function passwordsMatch(provided: string, expected: string): boolean {
  return safeEqual(provided, expected);
}

export function newCsrfToken(): string {
  return randomBytes(32).toString("hex");
}

export function signSession(secret: string, session: UiSession): string {
  const payload = `v1.${session.exp}.${session.csrf}`;
  const sig = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

export function verifySession(secret: string, token: string | undefined, now = Date.now()): UiSession | undefined {
  if (!token) return undefined;
  const lastDot = token.lastIndexOf(".");
  if (lastDot <= 0) return undefined;
  const payload = token.slice(0, lastDot);
  const sig = token.slice(lastDot + 1);
  const expected = createHmac("sha256", secret).update(payload).digest("base64url");
  if (!safeEqual(sig, expected)) return undefined;
  const [version, a, b, c, d, e] = payload.split(".");
  if (version === "v1") {
    const expRaw = a;
    const csrf = b;
    if (!expRaw || !csrf) return undefined;
    const exp = Number(expRaw);
    if (!Number.isFinite(exp) || exp <= now) return undefined;
    return { exp, csrf };
  }
  if (version === "v2") {
    const [nonce, expRaw, csrf, idRaw, loginRaw, avatarRaw = ""] = [a, b, c, d, e, payload.split(".").slice(6).join(".")];
    if (!nonce || !expRaw || !csrf || !idRaw || !loginRaw) return undefined;
    const exp = Number(expRaw);
    if (!Number.isFinite(exp) || exp <= now) return undefined;
    const id = Number(idRaw);
    if (!Number.isInteger(id) || id <= 0) return undefined;
    // Buffer.from never throws here: the HMAC already proved the payload is self-produced.
    const login = Buffer.from(loginRaw, "base64url").toString("utf8");
    if (!login) return undefined;
    const avatar = avatarRaw ? Buffer.from(avatarRaw, "base64url").toString("utf8") : "";
    return {
      exp,
      csrf,
      github: { id, login, avatarUrl: avatar.startsWith("https://") ? avatar : null },
    };
  }
  return undefined;
}

export function issueSession(secret: string, now = Date.now(), ttlMs = SESSION_TTL_MS): { token: string; session: UiSession } {
  const session = { exp: now + ttlMs, csrf: newCsrfToken() };
  return { token: signSession(secret, session), session };
}

// OAuth sessions carry the operator identity (stable numeric GitHub id, mutable
// login and avatar for display only) so the allowlist can be re-checked on
// every request. Format:
// `v2.<nonce>.<exp>.<csrf>.<id>.<base64url(login)>.<base64url(avatar)>.<sig>`
// where the avatar segment is empty when there is no avatar URL.
export function issueOAuthSession(
  secret: string,
  github: GithubIdentity,
  now = Date.now(),
  ttlMs = SESSION_TTL_MS,
): { token: string; session: UiSession } {
  if (!Number.isInteger(github.id) || github.id <= 0 || !github.login) {
    throw new Error("OAuth sessions require a positive numeric id and a login");
  }
  const session: UiSession = { exp: now + ttlMs, csrf: newCsrfToken(), github };
  const avatar = github.avatarUrl ? Buffer.from(github.avatarUrl, "utf8").toString("base64url") : "";
  const login = Buffer.from(github.login, "utf8").toString("base64url");
  const payload = `v2.${randomBytes(16).toString("base64url")}.${session.exp}.${session.csrf}.${github.id}.${login}.${avatar}`;
  const sig = createHmac("sha256", secret).update(payload).digest("base64url");
  return { token: `${payload}.${sig}`, session };
}

// Single-use OAuth `state` values held in process memory (matching the
// in-process limiter). `consume` deletes on first read so replays fail;
// `issue` sweeps expired leftovers so abandoned flows do not accumulate.
export class OAuthStateStore {
  private readonly entries = new Map<string, { expiresAt: number; next: string }>();

  issue(now: number, ttlMs: number, next = "/"): string {
    for (const [nonce, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(nonce);
    }
    const nonce = randomBytes(16).toString("base64url");
    this.entries.set(nonce, { expiresAt: now + ttlMs, next });
    return nonce;
  }

  consume(nonce: string | undefined, now = Date.now()): string | undefined {
    if (!nonce) return undefined;
    const entry = this.entries.get(nonce);
    if (!entry) return undefined;
    this.entries.delete(nonce);
    if (entry.expiresAt <= now) return undefined;
    return entry.next;
  }
}

export function csrfOK(session: UiSession, fieldToken: string | undefined, headerToken: string | undefined): boolean {
  const token = (headerToken?.trim() || fieldToken?.trim()) ?? "";
  if (!token || !session.csrf) return false;
  return safeEqual(token, session.csrf);
}

export function cookieSecure(url: string, forwardedProto?: string | null): boolean {
  if (forwardedProto?.split(",")[0]?.trim() === "https") return true;
  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
  }
}

const PUBLIC_PATHS = new Set([
  "/health",
  "/login",
  "/login/github",
  "/login/github/callback",
  "/favicon.ico",
  "/assets/favicon-32.png",
  "/assets/apple-touch-icon.png",
  "/assets/eru-icon.png",
  "/assets/eru.css",
  "/assets/htmx.min.js",
]);

export function isPublicPath(path: string): boolean {
  return PUBLIC_PATHS.has(path);
}

export function clientKey(
  forwardedFor?: string | null,
  realIp?: string | null,
  remoteAddress?: string | null,
): string {
  const hop = forwardedFor?.split(",")[0]?.trim();
  if (hop && isIP(hop)) return hop;
  const real = realIp?.trim();
  if (real && isIP(real)) return real;
  const remote = remoteAddress?.trim();
  if (remote) return remote;
  return "local";
}

export function isMutating(method: string): boolean {
  return method !== "GET" && method !== "HEAD" && method !== "OPTIONS";
}

export function safeNextPath(raw: string | undefined | null): string {
  if (!raw) return "/";
  let value = raw;
  try {
    value = decodeURIComponent(raw);
  } catch {
    return "/";
  }
  if (!value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) return "/";
  if (value.startsWith("/login") || value.startsWith("/logout") || value.startsWith("/assets/")) return "/";
  return value;
}
