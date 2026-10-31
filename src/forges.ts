import { createHmac, timingSafeEqual } from "node:crypto";
import {
  FORGE_FETCH_TIMEOUT_MS,
  TARBALL_FETCH_TIMEOUT_MS,
  TARBALL_MAX_BYTES,
  type AppRepo,
  type FetchLike,
  type TarballResult,
  type VerifyResult,
} from "./forge.js";

export const FORGE_GITHUB = "github";
export const FORGE_GITLAB = "gitlab";
export const FORGE_FORGEJO = "forgejo";

export type ForgeKind = typeof FORGE_GITHUB | typeof FORGE_GITLAB | typeof FORGE_FORGEJO;

export function isForgeKind(value: string): value is ForgeKind {
  return value === FORGE_GITHUB || value === FORGE_GITLAB || value === FORGE_FORGEJO;
}

// GitHub-style owner. Forgejo/Gitea usernames and orgs may contain dots.
const GITHUB_OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const FORGEJO_OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,38}[A-Za-z0-9])?$/;
const NAME_RE = /^[A-Za-z0-9._-]{1,100}$/;
const NAME_REJECT = new Set([".", ".."]);
const GITLAB_OWNER_RE = /^(?!.*\/\/)[A-Za-z0-9._-](?:[A-Za-z0-9._\-\/]{0,198}[A-Za-z0-9._-])?$/;

export function validRepoName(name: string): boolean {
  return NAME_RE.test(name) && !NAME_REJECT.has(name);
}

export function validOwner(forge: string, owner: string): boolean {
  if (!owner) return false;
  if (forge === FORGE_GITLAB) {
    if (!GITLAB_OWNER_RE.test(owner)) return false;
    return owner.split("/").every((part) => part.length > 0 && !NAME_REJECT.has(part));
  }
  if (forge === FORGE_FORGEJO) return FORGEJO_OWNER_RE.test(owner);
  return GITHUB_OWNER_RE.test(owner);
}

/** Strip a trailing API prefix and keep a possible subpath (self-hosted GitLab). */
export function normalizeForgeOrigin(raw: string, kind: "gitlab" | "forgejo"): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
  if (url.username || url.password) return undefined;
  let path = url.pathname.replace(/\/+$/, "") || "";
  if (kind === "gitlab" && (path === "/api/v4" || path.endsWith("/api/v4"))) {
    path = path.slice(0, -"/api/v4".length);
  }
  if (kind === "forgejo" && (path === "/api/v1" || path.endsWith("/api/v1"))) {
    path = path.slice(0, -"/api/v1".length);
  }
  const origin = `${url.protocol}//${url.host}`;
  return path && path !== "/" ? `${origin}${path}` : origin;
}

export function forgeApiRoot(origin: string, kind: "gitlab" | "forgejo"): string {
  return `${origin.replace(/\/+$/, "")}${kind === "gitlab" ? "/api/v4" : "/api/v1"}`;
}

function gitlabHeaders(token: string): Record<string, string> {
  return {
    Accept: "application/json",
    "User-Agent": "eru",
    ...(token ? { "PRIVATE-TOKEN": token } : {}),
  };
}

function forgejoHeaders(token: string): Record<string, string> {
  return {
    Accept: "application/json",
    "User-Agent": "eru",
    ...(token ? { Authorization: `token ${token}` } : {}),
  };
}

async function jsonFetch(
  fetchImpl: FetchLike,
  url: string,
  headers: Record<string, string>,
  timeoutMs: number = FORGE_FETCH_TIMEOUT_MS,
): Promise<{ status: number; body: unknown } | { error: "unreachable" }> {
  let res: Response;
  try {
    res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    return { error: "unreachable" };
  }
  let body: unknown = null;
  try {
    const text = await res.text();
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  return { status: res.status, body };
}

function statusError(status: number): VerifyResult {
  if (status === 404) return { ok: false, error: "notfound" };
  if (status === 401 || status === 403) return { ok: false, error: "auth" };
  return { ok: false, error: "unreachable" };
}

export async function verifyGitlabRepo(
  origin: string,
  owner: string,
  name: string,
  token: string,
  fetchImpl: FetchLike = fetch,
): Promise<VerifyResult> {
  if (!validOwner(FORGE_GITLAB, owner) || !validRepoName(name)) return { ok: false, error: "invalid" };
  const path = `${owner}/${name}`;
  const url = `${forgeApiRoot(origin, "gitlab")}/projects/${encodeURIComponent(path)}`;
  const res = await jsonFetch(fetchImpl, url, gitlabHeaders(token));
  if ("error" in res) return { ok: false, error: "unreachable" };
  if (!res.status || res.status >= 400) return statusError(res.status);
  const body = res.body as { path_with_namespace?: unknown; default_branch?: unknown };
  const full = typeof body.path_with_namespace === "string" ? body.path_with_namespace : "";
  const split = splitNamespace(full);
  if (!split) return { ok: false, error: "notfound" };
  if (split.owner.toLowerCase() !== owner.toLowerCase() || split.name.toLowerCase() !== name.toLowerCase()) {
    return { ok: false, error: "notfound" };
  }
  const defaultBranch = typeof body.default_branch === "string" && body.default_branch ? body.default_branch : undefined;
  return { ok: true, repo: { forge: FORGE_GITLAB, owner: split.owner, name: split.name, defaultBranch, origin } };
}

export async function verifyForgejoRepo(
  origin: string,
  owner: string,
  name: string,
  token: string,
  fetchImpl: FetchLike = fetch,
): Promise<VerifyResult> {
  if (!validOwner(FORGE_FORGEJO, owner) || !validRepoName(name)) return { ok: false, error: "invalid" };
  const url = `${forgeApiRoot(origin, "forgejo")}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
  const res = await jsonFetch(fetchImpl, url, forgejoHeaders(token));
  if ("error" in res) return { ok: false, error: "unreachable" };
  if (!res.status || res.status >= 400) return statusError(res.status);
  const body = res.body as { owner?: { login?: unknown; username?: unknown }; name?: unknown; default_branch?: unknown };
  const canonicalOwner =
    (typeof body.owner?.login === "string" && body.owner.login) ||
    (typeof body.owner?.username === "string" && body.owner.username) ||
    "";
  const canonicalName = typeof body.name === "string" ? body.name : "";
  if (!canonicalOwner || !canonicalName) return { ok: false, error: "notfound" };
  if (canonicalOwner.toLowerCase() !== owner.toLowerCase() || canonicalName.toLowerCase() !== name.toLowerCase()) {
    return { ok: false, error: "notfound" };
  }
  const defaultBranch = typeof body.default_branch === "string" && body.default_branch ? body.default_branch : undefined;
  return {
    ok: true,
    repo: { forge: FORGE_FORGEJO, owner: canonicalOwner, name: canonicalName, defaultBranch, origin },
  };
}

export async function listGitlabRepos(
  origin: string,
  token: string,
  fetchImpl: FetchLike = fetch,
): Promise<{ ok: true; repos: AppRepo[] } | { ok: false; error: "auth" | "unreachable" }> {
  const repos: AppRepo[] = [];
  for (let page = 1; page <= 10; page += 1) {
    const url = `${forgeApiRoot(origin, "gitlab")}/projects?membership=true&simple=true&per_page=100&page=${page}`;
    const res = await jsonFetch(fetchImpl, url, gitlabHeaders(token));
    if ("error" in res) return { ok: false, error: "unreachable" };
    if (res.status === 401 || res.status === 403) return { ok: false, error: "auth" };
    if (!res.status || res.status >= 400) return { ok: false, error: "unreachable" };
    const rows = Array.isArray(res.body) ? res.body : [];
    for (const row of rows) {
      const full = typeof (row as { path_with_namespace?: unknown }).path_with_namespace === "string"
        ? (row as { path_with_namespace: string }).path_with_namespace
        : "";
      const split = splitNamespace(full);
      if (!split) continue;
      const visibility = (row as { visibility?: unknown }).visibility;
      const defaultBranch = (row as { default_branch?: unknown }).default_branch;
      repos.push({
        owner: split.owner,
        name: split.name,
        privateRepo: visibility !== "public",
        defaultBranch: typeof defaultBranch === "string" && defaultBranch ? defaultBranch : undefined,
      });
    }
    if (rows.length < 100) break;
  }
  return { ok: true, repos };
}

export async function listForgejoRepos(
  origin: string,
  token: string,
  fetchImpl: FetchLike = fetch,
): Promise<{ ok: true; repos: AppRepo[] } | { ok: false; error: "auth" | "unreachable" }> {
  const repos: AppRepo[] = [];
  for (let page = 1; page <= 10; page += 1) {
    const url = `${forgeApiRoot(origin, "forgejo")}/user/repos?limit=50&page=${page}`;
    const res = await jsonFetch(fetchImpl, url, forgejoHeaders(token));
    if ("error" in res) return { ok: false, error: "unreachable" };
    if (res.status === 401 || res.status === 403) return { ok: false, error: "auth" };
    if (!res.status || res.status >= 400) return { ok: false, error: "unreachable" };
    const rows = Array.isArray(res.body) ? res.body : [];
    for (const row of rows) {
      const owner =
        (typeof (row as { owner?: { login?: unknown } }).owner?.login === "string" &&
          (row as { owner: { login: string } }).owner.login) ||
        (typeof (row as { owner?: { username?: unknown } }).owner?.username === "string" &&
          (row as { owner: { username: string } }).owner.username) ||
        "";
      const name = typeof (row as { name?: unknown }).name === "string" ? (row as { name: string }).name : "";
      if (!owner || !name) continue;
      const defaultBranch = (row as { default_branch?: unknown }).default_branch;
      repos.push({
        owner,
        name,
        privateRepo: (row as { private?: unknown }).private === true,
        defaultBranch: typeof defaultBranch === "string" && defaultBranch ? defaultBranch : undefined,
      });
    }
    if (rows.length < 50) break;
  }
  return { ok: true, repos };
}

async function readArchive(
  fetchImpl: FetchLike,
  url: string,
  headers: Record<string, string>,
  allowedHosts: Set<string>,
): Promise<TarballResult> {
  let res: Response;
  try {
    res = await fetchImpl(url, {
      headers,
      signal: AbortSignal.timeout(TARBALL_FETCH_TIMEOUT_MS),
      redirect: "manual",
    });
    const location = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && location) {
      const host = new URL(location, url).hostname;
      if (!allowedHosts.has(host)) return { ok: false, error: "unreachable" };
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

export async function fetchGitlabArchive(
  origin: string,
  owner: string,
  name: string,
  ref: string,
  token: string,
  fetchImpl: FetchLike = fetch,
): Promise<TarballResult> {
  if (!validOwner(FORGE_GITLAB, owner) || !validRepoName(name)) return { ok: false, error: "invalid" };
  const path = encodeURIComponent(`${owner}/${name}`);
  const url = `${forgeApiRoot(origin, "gitlab")}/projects/${path}/repository/archive.tar.gz?sha=${encodeURIComponent(ref)}`;
  return readArchive(fetchImpl, url, gitlabHeaders(token), new Set([new URL(origin).hostname]));
}

export async function fetchForgejoArchive(
  origin: string,
  owner: string,
  name: string,
  ref: string,
  token: string,
  fetchImpl: FetchLike = fetch,
): Promise<TarballResult> {
  if (!validOwner(FORGE_FORGEJO, owner) || !validRepoName(name)) return { ok: false, error: "invalid" };
  const encodedRef = ref
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
  const url = `${forgeApiRoot(origin, "forgejo")}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/archive/${encodedRef}.tar.gz`;
  return readArchive(fetchImpl, url, forgejoHeaders(token), new Set([new URL(origin).hostname]));
}

export function verifyGitlabWebhookToken(secret: string, header: string | undefined): boolean {
  if (!header) return false;
  const expected = Buffer.from(secret);
  const provided = Buffer.from(header);
  if (expected.length === 0 || expected.length !== provided.length) return false;
  try {
    return timingSafeEqual(expected, provided);
  } catch {
    return false;
  }
}

export function verifyForgejoWebhookSignature(secret: string, rawBody: string, header: string | undefined): boolean {
  if (!header) return false;
  const expectedHex = createHmac("sha256", secret).update(rawBody).digest("hex");
  const providedHex = header.startsWith("sha256=") ? header.slice("sha256=".length) : header;
  try {
    const expected = Buffer.from(expectedHex, "hex");
    const provided = Buffer.from(providedHex, "hex");
    if (expected.length === 0 || expected.length !== provided.length) return false;
    return timingSafeEqual(expected, provided);
  } catch {
    return false;
  }
}

export function splitNamespace(full: string): { owner: string; name: string } | undefined {
  const trimmed = full.replace(/^\/+|\/+$/g, "");
  const idx = trimmed.lastIndexOf("/");
  if (idx <= 0 || idx === trimmed.length - 1) return undefined;
  return { owner: trimmed.slice(0, idx), name: trimmed.slice(idx + 1) };
}

export interface IssueSnapshot {
  title: string;
  body: string;
}

export async function gitlabGetIssue(
  origin: string,
  token: string,
  owner: string,
  name: string,
  iid: number,
  fetchImpl: FetchLike,
): Promise<IssueSnapshot> {
  const path = encodeURIComponent(`${owner}/${name}`);
  const res = await jsonFetch(
    fetchImpl,
    `${forgeApiRoot(origin, "gitlab")}/projects/${path}/issues/${iid}`,
    gitlabHeaders(token),
  );
  if ("error" in res || !res.status || res.status >= 400) throw new Error(`gitlab:get:${"error" in res ? "unreachable" : res.status}`);
  const body = res.body as { title?: unknown; description?: unknown };
  return {
    title: typeof body.title === "string" ? body.title : "",
    body: typeof body.description === "string" ? body.description : "",
  };
}

export async function gitlabPatchIssue(
  origin: string,
  token: string,
  owner: string,
  name: string,
  iid: number,
  description: string,
  fetchImpl: FetchLike,
): Promise<void> {
  await gitlabWrite(origin, token, owner, name, iid, "PUT", "", { description }, fetchImpl);
}

export async function gitlabAddLabels(
  origin: string,
  token: string,
  owner: string,
  name: string,
  iid: number,
  labels: string[],
  fetchImpl: FetchLike,
): Promise<void> {
  const path = encodeURIComponent(`${owner}/${name}`);
  for (const label of labels) {
    await gitlabRequest(
      origin,
      token,
      "POST",
      `/projects/${path}/labels`,
      { name: label, color: gitlabLabelColor(label) },
      fetchImpl,
    ).catch(() => {});
  }
  await gitlabWrite(origin, token, owner, name, iid, "PUT", "", { add_labels: labels.join(",") }, fetchImpl);
}

const COMMENT_PAGE_CAP = 20;

export async function gitlabEnsureNote(
  origin: string,
  token: string,
  owner: string,
  name: string,
  iid: number,
  body: string,
  fetchImpl: FetchLike,
): Promise<void> {
  const path = encodeURIComponent(`${owner}/${name}`);
  for (let page = 1; page <= COMMENT_PAGE_CAP; page++) {
    const res = await jsonFetch(
      fetchImpl,
      `${forgeApiRoot(origin, "gitlab")}/projects/${path}/issues/${iid}/notes?per_page=100&page=${page}`,
      gitlabHeaders(token),
    );
    if ("error" in res || !res.status || res.status >= 400) throw new Error("gitlab:notes");
    const notes = Array.isArray(res.body) ? res.body : [];
    if (notes.some((note) => (note as { body?: unknown }).body === body)) return;
    if (notes.length < 100) break;
  }
  await gitlabWrite(origin, token, owner, name, iid, "POST", "/notes", { body }, fetchImpl);
}

export async function gitlabAwardEyes(
  origin: string,
  token: string,
  owner: string,
  name: string,
  iid: number,
  fetchImpl: FetchLike,
): Promise<void> {
  const path = encodeURIComponent(`${owner}/${name}`);
  const res = await gitlabRequest(
    origin,
    token,
    "POST",
    `/projects/${path}/issues/${iid}/award_emoji`,
    { name: "eyes" },
    fetchImpl,
  );
  if (res.status === 200 || res.status === 201 || res.status === 404) return;
  // 409 = already awarded
  if (res.status === 409) return;
  throw new Error(`gitlab:award:${res.status}`);
}

export async function forgejoGetIssue(
  origin: string,
  token: string,
  owner: string,
  name: string,
  number: number,
  fetchImpl: FetchLike,
): Promise<IssueSnapshot> {
  const res = await jsonFetch(
    fetchImpl,
    `${forgeApiRoot(origin, "forgejo")}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/issues/${number}`,
    forgejoHeaders(token),
  );
  if ("error" in res || !res.status || res.status >= 400) throw new Error(`forgejo:get:${"error" in res ? "unreachable" : res.status}`);
  const body = res.body as { title?: unknown; body?: unknown };
  return {
    title: typeof body.title === "string" ? body.title : "",
    body: typeof body.body === "string" ? body.body : "",
  };
}

export async function forgejoPatchIssue(
  origin: string,
  token: string,
  owner: string,
  name: string,
  number: number,
  body: string,
  fetchImpl: FetchLike,
): Promise<void> {
  await forgejoWrite(origin, token, owner, name, number, "PATCH", "", { body }, fetchImpl);
}

export async function forgejoAddLabels(
  origin: string,
  token: string,
  owner: string,
  name: string,
  number: number,
  labels: string[],
  fetchImpl: FetchLike,
): Promise<void> {
  const ids: number[] = [];
  for (const label of labels) {
    const id = await forgejoEnsureLabelId(origin, token, owner, name, label, fetchImpl);
    if (id !== undefined) ids.push(id);
  }
  if (ids.length === 0) return;
  await forgejoWrite(origin, token, owner, name, number, "POST", "/labels", { labels: ids }, fetchImpl);
}

async function forgejoEnsureLabelId(
  origin: string,
  token: string,
  owner: string,
  name: string,
  label: string,
  fetchImpl: FetchLike,
): Promise<number | undefined> {
  const list = await jsonFetch(
    fetchImpl,
    `${forgeApiRoot(origin, "forgejo")}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/labels?limit=50`,
    forgejoHeaders(token),
  );
  if (!("error" in list) && Array.isArray(list.body)) {
    const existing = list.body.find((row) => (row as { name?: unknown }).name === label) as
      | { id?: unknown }
      | undefined;
    const existingId = typeof existing?.id === "number" ? existing.id : Number(existing?.id);
    if (Number.isInteger(existingId) && existingId > 0) return existingId;
  }
  const created = await forgejoRequest(
    origin,
    token,
    "POST",
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/labels`,
    { name: label, color: forgejoLabelColor(label) },
    fetchImpl,
  );
  if (created.status === 200 || created.status === 201) {
    try {
      const body = (await created.json()) as { id?: unknown };
      const id = typeof body.id === "number" ? body.id : Number(body.id);
      if (Number.isInteger(id) && id > 0) return id;
    } catch {
      return undefined;
    }
  }
  if (created.status === 409 || created.status === 422) {
    const retry = await jsonFetch(
      fetchImpl,
      `${forgeApiRoot(origin, "forgejo")}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/labels?limit=50`,
      forgejoHeaders(token),
    );
    if (!("error" in retry) && Array.isArray(retry.body)) {
      const existing = retry.body.find((row) => (row as { name?: unknown }).name === label) as
        | { id?: unknown }
        | undefined;
      const existingId = typeof existing?.id === "number" ? existing.id : Number(existing?.id);
      if (Number.isInteger(existingId) && existingId > 0) return existingId;
    }
  }
  return undefined;
}

export async function forgejoEnsureComment(
  origin: string,
  token: string,
  owner: string,
  name: string,
  number: number,
  body: string,
  fetchImpl: FetchLike,
): Promise<void> {
  const root = `${forgeApiRoot(origin, "forgejo")}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/issues/${number}/comments`;
  for (let page = 1; page <= COMMENT_PAGE_CAP; page++) {
    const res = await jsonFetch(fetchImpl, `${root}?limit=50&page=${page}`, forgejoHeaders(token));
    if ("error" in res || !res.status || res.status >= 400) throw new Error("forgejo:comments");
    const comments = Array.isArray(res.body) ? res.body : [];
    if (comments.some((comment) => (comment as { body?: unknown }).body === body)) return;
    if (comments.length < 50) break;
  }
  await forgejoWrite(origin, token, owner, name, number, "POST", "/comments", { body }, fetchImpl);
}

export async function forgejoAddReaction(
  origin: string,
  token: string,
  owner: string,
  name: string,
  number: number,
  fetchImpl: FetchLike,
): Promise<void> {
  const res = await forgejoRequest(
    origin,
    token,
    "POST",
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/issues/${number}/reactions`,
    { content: "eyes" },
    fetchImpl,
  );
  if (res.status === 200 || res.status === 201 || res.status === 403 || res.status === 404) return;
  throw new Error(`forgejo:reaction:${res.status}`);
}

function gitlabLabelColor(name: string): string {
  switch (name) {
    case "eru:refined":
      return "#a8b99a";
    case "agent-ready":
      return "#cde8df";
    case "needs-info":
      return "#e9e4f7";
    case "eru:refine-failed":
      return "#fadadd";
    default:
      return "#ededed";
  }
}

function forgejoLabelColor(name: string): string {
  return gitlabLabelColor(name).replace(/^#/, "");
}

async function gitlabWrite(
  origin: string,
  token: string,
  owner: string,
  name: string,
  iid: number,
  method: string,
  suffix: string,
  body: unknown,
  fetchImpl: FetchLike,
): Promise<void> {
  const path = encodeURIComponent(`${owner}/${name}`);
  const res = await gitlabRequest(origin, token, method, `/projects/${path}/issues/${iid}${suffix}`, body, fetchImpl);
  if (!res.ok) throw new Error(`gitlab:${method}:${res.status}`);
}

async function forgejoWrite(
  origin: string,
  token: string,
  owner: string,
  name: string,
  number: number,
  method: string,
  suffix: string,
  body: unknown,
  fetchImpl: FetchLike,
): Promise<void> {
  const res = await forgejoRequest(
    origin,
    token,
    method,
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/issues/${number}${suffix}`,
    body,
    fetchImpl,
  );
  if (!res.ok) throw new Error(`forgejo:${method}:${res.status}`);
}

async function gitlabRequest(
  origin: string,
  token: string,
  method: string,
  path: string,
  body: unknown,
  fetchImpl: FetchLike,
): Promise<Response> {
  try {
    return await fetchImpl(`${forgeApiRoot(origin, "gitlab")}${path}`, {
      method,
      headers: { ...gitlabHeaders(token), "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(FORGE_FETCH_TIMEOUT_MS),
    });
  } catch {
    throw new Error("gitlab:unreachable");
  }
}

async function forgejoRequest(
  origin: string,
  token: string,
  method: string,
  path: string,
  body: unknown,
  fetchImpl: FetchLike,
): Promise<Response> {
  try {
    return await fetchImpl(`${forgeApiRoot(origin, "forgejo")}${path}`, {
      method,
      headers: { ...forgejoHeaders(token), "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(FORGE_FETCH_TIMEOUT_MS),
    });
  } catch {
    throw new Error("forgejo:unreachable");
  }
}
