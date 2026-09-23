import { createCipheriv, createDecipheriv, hkdfSync, randomBytes, sign } from "node:crypto";

export const FORGE_GITHUB = "github";
export const GITHUB_API_BASE = "https://api.github.com";
export const FORGE_FETCH_TIMEOUT_MS = 10_000;
export const TARBALL_FETCH_TIMEOUT_MS = 60_000;
export const TARBALL_MAX_BYTES = 64 * 1024 * 1024;

const TOKEN_FORMAT_VERSION = "v1";
const KEY_SALT = "eru-forge-token";
const KEY_INFO = "forge-token-v1";

export function forgeTokenKey(keySecret: string): Buffer {
  return Buffer.from(hkdfSync("sha256", keySecret, KEY_SALT, KEY_INFO, 32));
}

export function encryptForgeToken(keySecret: string, token: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", forgeTokenKey(keySecret), iv);
  const ciphertext = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  return [TOKEN_FORMAT_VERSION, iv, cipher.getAuthTag(), ciphertext]
    .map((part) => (typeof part === "string" ? part : part.toString("base64url")))
    .join(".");
}

// One home for the forge key orderings: encrypt uses secrets[0] (the dedicated
// key when configured, else the session secret); decrypt tries every configured
// secret so rows survive key adoption. Callers must use this for both sides.
export function forgeKeySecrets(config: { forgeKeySecret?: string; sessionSecret: string }): string[] {
  const list = [config.forgeKeySecret, config.sessionSecret].filter((s): s is string => Boolean(s));
  return [...new Set(list)];
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

export type TarballError = "invalid" | "notfound" | "auth" | "unreachable" | "toobig";
export type TarballResult = { ok: true; data: Buffer } | { ok: false; error: TarballError };

function forgeHeaders(token: string): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "eru",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

// GitHub 302s tarball downloads to codeload with a signed URL. Handle the
// redirect manually so the bearer token is only ever sent to api.github.com.
export async function fetchRepoTarball(
  owner: string,
  name: string,
  ref: string,
  token: string,
  fetchImpl: FetchLike = fetch,
  apiBase: string = GITHUB_API_BASE,
): Promise<TarballResult> {
  const url = `${apiBase.replace(/\/+$/, "")}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(
    name,
  )}/tarball/${encodeURIComponent(ref)}`;

  let res: Response;
  try {
    res = await fetchImpl(url, {
      headers: forgeHeaders(token),
      signal: AbortSignal.timeout(TARBALL_FETCH_TIMEOUT_MS),
      redirect: "manual",
    });
    const location = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && location) {
      const host = new URL(location).hostname;
      if (host !== "github.com" && !host.endsWith(".github.com")) {
        return { ok: false, error: "unreachable" };
      }
      res = await fetchImpl(location, { signal: AbortSignal.timeout(TARBALL_FETCH_TIMEOUT_MS) });
    }
  } catch {
    return { ok: false, error: "unreachable" };
  }

  if (res.status === 404) return { ok: false, error: "notfound" };
  if (res.status === 401 || res.status === 403) return { ok: false, error: "auth" };
  if (!res.ok) return { ok: false, error: "unreachable" };

  const length = Number(res.headers.get("content-length") ?? "0");
  if (length > TARBALL_MAX_BYTES) return { ok: false, error: "toobig" };
  let data: ArrayBuffer;
  try {
    data = await res.arrayBuffer();
  } catch {
    return { ok: false, error: "unreachable" };
  }
  if (data.byteLength > TARBALL_MAX_BYTES) return { ok: false, error: "toobig" };
  return { ok: true, data: Buffer.from(data) };
}

// ---- GitHub App auth -------------------------------------------------------
// A GitHub App authenticates as itself with a short-lived RS256 JWT signed by
// the app's private key, then mints per-installation access tokens used like
// PATs. The private key is stored with the same AES-GCM envelope as forge
// tokens and is never rendered back.

export interface GithubAppCredentials {
  appId: string;
  privateKey: string;
  installationId?: string;
}

export type AppError = "invalid" | "auth" | "unreachable" | "noinstall" | "ambiguous";

export interface AppRepo {
  owner: string;
  name: string;
  privateRepo: boolean;
}

const APP_JWT_TTL_SECONDS = 600;
const APP_JWT_CLOCK_SKEW_SECONDS = 60;
const TOKEN_REFRESH_MARGIN_MS = 60_000;
const APP_REPO_PAGE_LIMIT = 10;

export function githubAppJwt(appId: string, privateKey: string, now: () => number = Date.now): string {
  const iat = Math.floor(now() / 1000) - APP_JWT_CLOCK_SKEW_SECONDS;
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ iat, exp: iat + APP_JWT_TTL_SECONDS, iss: appId })).toString("base64url");
  const signature = sign("RSA-SHA256", Buffer.from(`${header}.${payload}`), privateKey).toString("base64url");
  return `${header}.${payload}.${signature}`;
}

type AppResult<T> = { ok: true; value: T } | { ok: false; error: AppError };

async function appFetch(
  creds: GithubAppCredentials,
  path: string,
  fetchImpl: FetchLike,
  apiBase: string,
  init: RequestInit = {},
): Promise<AppResult<Response>> {
  let jwt: string;
  try {
    jwt = githubAppJwt(creds.appId, creds.privateKey);
  } catch {
    return { ok: false, error: "invalid" };
  }
  let res: Response;
  try {
    res = await fetchImpl(`${apiBase.replace(/\/+$/, "")}${path}`, {
      ...init,
      headers: { ...forgeHeaders(jwt), ...(init.headers as Record<string, string> | undefined) },
      signal: AbortSignal.timeout(FORGE_FETCH_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, error: "unreachable" };
  }
  if (res.status === 401 || res.status === 403) return { ok: false, error: "auth" };
  if (!res.ok) return { ok: false, error: "unreachable" };
  return { ok: true, value: res };
}

export interface GithubAppClient {
  /** Resolve the installation to act as: the configured id, or the only one listed. */
  installationId(): Promise<AppResult<string>>;
  /** Mint (or reuse a cached) installation access token. */
  installationToken(): Promise<AppResult<string>>;
  /** Repositories the installation can read. */
  listRepos(): Promise<AppResult<AppRepo[]>>;
}

export function createGithubAppClient(
  creds: GithubAppCredentials,
  fetchImpl: FetchLike = fetch,
  apiBase: string = GITHUB_API_BASE,
): GithubAppClient {
  let cachedToken: { token: string; expiresAtMs: number } | undefined;

  async function installationId(): Promise<AppResult<string>> {
    if (creds.installationId) return { ok: true, value: creds.installationId };
    const res = await appFetch(creds, "/app/installations", fetchImpl, apiBase);
    if (!res.ok) return res;
    let data: unknown;
    try {
      data = await res.value.json();
    } catch {
      return { ok: false, error: "unreachable" };
    }
    const list = Array.isArray(data) ? data : [];
    const ids = list
      .map((row) => (row as { id?: unknown })?.id)
      .filter((id): id is number => typeof id === "number" && Number.isInteger(id) && id > 0);
    if (ids.length === 0) return { ok: false, error: "noinstall" };
    if (ids.length > 1) return { ok: false, error: "ambiguous" };
    return { ok: true, value: String(ids[0]) };
  }

  async function installationToken(): Promise<AppResult<string>> {
    if (cachedToken && cachedToken.expiresAtMs - TOKEN_REFRESH_MARGIN_MS > Date.now()) {
      return { ok: true, value: cachedToken.token };
    }
    const install = await installationId();
    if (!install.ok) return install;
    const res = await appFetch(
      creds,
      `/app/installations/${encodeURIComponent(install.value)}/access_tokens`,
      fetchImpl,
      apiBase,
      { method: "POST" },
    );
    if (!res.ok) return res;
    let data: unknown;
    try {
      data = await res.value.json();
    } catch {
      return { ok: false, error: "unreachable" };
    }
    const body = data as { token?: unknown; expires_at?: unknown };
    if (typeof body?.token !== "string" || !body.token) return { ok: false, error: "unreachable" };
    const expiresAtMs = typeof body.expires_at === "string" ? Date.parse(body.expires_at) : NaN;
    cachedToken = {
      token: body.token,
      expiresAtMs: Number.isFinite(expiresAtMs) ? expiresAtMs : Date.now() + APP_JWT_TTL_SECONDS * 1000,
    };
    return { ok: true, value: body.token };
  }

  async function listRepos(): Promise<AppResult<AppRepo[]>> {
    const token = await installationToken();
    if (!token.ok) return token;
    const repos: AppRepo[] = [];
    for (let page = 1; page <= APP_REPO_PAGE_LIMIT; page += 1) {
      let res: Response;
      try {
        res = await fetchImpl(
          `${apiBase.replace(/\/+$/, "")}/installation/repositories?per_page=100&page=${page}`,
          { headers: forgeHeaders(token.value), signal: AbortSignal.timeout(FORGE_FETCH_TIMEOUT_MS) },
        );
      } catch {
        return { ok: false, error: "unreachable" };
      }
      if (res.status === 401 || res.status === 403) return { ok: false, error: "auth" };
      if (!res.ok) return { ok: false, error: "unreachable" };
      let data: unknown;
      try {
        data = await res.json();
      } catch {
        return { ok: false, error: "unreachable" };
      }
      const list = (data as { repositories?: unknown })?.repositories;
      const rows = Array.isArray(list) ? list : [];
      for (const row of rows) {
        const owner = (row as { owner?: { login?: unknown } })?.owner?.login;
        const name = (row as { name?: unknown })?.name;
        if (typeof owner === "string" && typeof name === "string") {
          repos.push({ owner, name, privateRepo: (row as { private?: unknown })?.private === true });
        }
      }
      if (rows.length < 100) return { ok: true, value: repos };
    }
    return { ok: true, value: repos };
  }

  return { installationId, installationToken, listRepos };
}
