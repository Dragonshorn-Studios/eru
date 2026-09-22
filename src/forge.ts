import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

export const FORGE_GITHUB = "github";
export const GITHUB_API_BASE = "https://api.github.com";
export const FORGE_FETCH_TIMEOUT_MS = 10_000;

const TOKEN_FORMAT_VERSION = "v1";
const KEY_SALT = "eru-forge-token";
const KEY_INFO = "forge-token-v1";

export function forgeTokenKey(sessionSecret: string): Buffer {
  return Buffer.from(hkdfSync("sha256", sessionSecret, KEY_SALT, KEY_INFO, 32));
}

export function encryptForgeToken(sessionSecret: string, token: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", forgeTokenKey(sessionSecret), iv);
  const ciphertext = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  return [TOKEN_FORMAT_VERSION, iv, cipher.getAuthTag(), ciphertext]
    .map((part) => (typeof part === "string" ? part : part.toString("base64url")))
    .join(".");
}

// Accepts one or more candidate key secrets so a credential written under the
// session secret stays readable after a dedicated ERU_FORGE_TOKEN_KEY is
// introduced (and vice versa). Encrypt always uses the first configured key.
export function decryptForgeToken(secrets: string | string[], stored: string): string {
  const [version, ivRaw, tagRaw, ctRaw, ...rest] = stored.split(".");
  if (version !== TOKEN_FORMAT_VERSION || !ivRaw || !tagRaw || !ctRaw || rest.length > 0) {
    throw new Error("eru: forge credential is malformed");
  }
  const candidates = Array.isArray(secrets) ? secrets : [secrets];
  let lastError: unknown;
  for (const secret of candidates) {
    try {
      const decipher = createDecipheriv("aes-256-gcm", forgeTokenKey(secret), Buffer.from(ivRaw, "base64url"));
      decipher.setAuthTag(Buffer.from(tagRaw, "base64url"));
      return Buffer.concat([decipher.update(Buffer.from(ctRaw, "base64url")), decipher.final()]).toString("utf8");
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("eru: forge credential is unreadable");
}

export interface ConnectedRepo {
  forge: string;
  owner: string;
  name: string;
}

export type VerifyError = "invalid" | "notfound" | "auth" | "unreachable";

export type VerifyResult = { ok: true; repo: ConnectedRepo } | { ok: false; error: VerifyError };

// GitHub login names: 1-39 chars, alnum or single hyphens, no leading/trailing hyphen.
const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
// Repo names: alnum, dash, underscore, dot — but never the path segments "." or "..".
const NAME_RE = /^[A-Za-z0-9._-]{1,100}$/;
const NAME_REJECT = new Set([".", ".."]);

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export async function verifyGithubRepo(
  owner: string,
  name: string,
  token: string,
  fetchImpl: FetchLike = fetch,
  apiBase: string = GITHUB_API_BASE,
): Promise<VerifyResult> {
  if (!OWNER_RE.test(owner) || !NAME_RE.test(name) || NAME_REJECT.has(name)) {
    return { ok: false, error: "invalid" };
  }
  const url = `${apiBase.replace(/\/+$/, "")}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "eru",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  let res: Response;
  try {
    res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(FORGE_FETCH_TIMEOUT_MS) });
  } catch {
    return { ok: false, error: "unreachable" };
  }

  if (res.status === 404) return { ok: false, error: "notfound" };
  if (res.status === 401 || res.status === 403) return { ok: false, error: "auth" };
  if (!res.ok) return { ok: false, error: "unreachable" };

  let data: unknown;
  try {
    data = await res.json();
  } catch {
    return { ok: false, error: "unreachable" };
  }
  const body = data as { owner?: { login?: unknown }; name?: unknown };
  const canonicalOwner = body?.owner?.login;
  const canonicalName = body?.name;
  if (typeof canonicalOwner !== "string" || typeof canonicalName !== "string" || !canonicalOwner || !canonicalName) {
    return { ok: false, error: "notfound" };
  }
  if (canonicalOwner.toLowerCase() !== owner.toLowerCase() || canonicalName.toLowerCase() !== name.toLowerCase()) {
    return { ok: false, error: "notfound" };
  }
  return { ok: true, repo: { forge: FORGE_GITHUB, owner: canonicalOwner, name: canonicalName } };
}
