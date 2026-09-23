import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";

export const SESSION_COOKIE = "eru_session";
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
export const CSRF_FIELD = "csrf";
export const CSRF_HEADER = "X-CSRF-Token";

export interface UiSession {
  exp: number;
  csrf: string;
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
  const [version, expRaw, csrf] = payload.split(".");
  if (version !== "v1" || !expRaw || !csrf) return undefined;
  const exp = Number(expRaw);
  if (!Number.isFinite(exp) || exp <= now) return undefined;
  return { exp, csrf };
}

export function issueSession(secret: string, now = Date.now(), ttlMs = SESSION_TTL_MS): { token: string; session: UiSession } {
  const session = { exp: now + ttlMs, csrf: newCsrfToken() };
  return { token: signSession(secret, session), session };
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
