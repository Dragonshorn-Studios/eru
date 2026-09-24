import { generateKeyPairSync } from "node:crypto";
import { lstatSync, mkdtempSync, readFileSync, readlinkSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CSRF_FIELD, SESSION_COOKIE, verifySession } from "./auth.js";
import type { Config } from "./config.js";
import {
  getForgeCredential,
  getSetting,
  setSetting,
  getPrimaryRepo,
  listPages,
  openDb,
  setForgeCredential,
  setLastMapped,
  upsertConnectedRepo,
  upsertPage,
  type SqliteDb,
} from "./db.js";
import { decryptForgeToken, encryptForgeToken, forgeKeySecrets } from "./forge.js";
import { ProviderCredentialStore } from "./providers.js";
import { createApp } from "./server.js";
import { TOKENS } from "./theme.js";
import type { AskRunner, ModelDiscovery } from "./opencode.js";
import type { RefreshRunner } from "./refresh.js";

function gatedConfig(overrides: Partial<Config> = {}): Config {
  return {
    host: "127.0.0.1",
    port: 3000,
    sqlitePath: ":memory:",
    uiPassword: "test-ui-password",
    sessionSecret: "test-session-secret",
    loginLimit: 5,
    loginWindowMs: 60_000,
    openCodeBin: "opencode",
    openCodeTimeoutMs: 120_000,
    publicUrl: "http://eru.test",
    oauthAdminIds: [],
    uiLocalLogin: false,
    ...overrides,
  };
}

function app(
  overrides: Partial<Config> = {},
  fetchImpl?: (url: string, init: RequestInit) => Promise<Response>,
  askRunner?: AskRunner,
  refreshRunner?: RefreshRunner,
  providerStore?: ProviderCredentialStore,
  modelDiscovery?: ModelDiscovery,
  oauthFetch?: typeof fetch,
) {
  const config = gatedConfig(overrides);
  const db = openDb(":memory:");
  return {
    app: createApp({ config, db, fetchImpl, oauthFetch, askRunner, refreshRunner, providerStore, modelDiscovery }),
    config,
    db,
  };
}

async function login(instance: ReturnType<typeof app>["app"], password = "test-ui-password") {
  const res = await instance.request("/login", {
    method: "POST",
    body: new URLSearchParams({ password }),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    redirect: "manual",
  });
  return res;
}

function cookieLine(res: Response): string {
  const cookies =
    typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [res.headers.get("set-cookie") ?? ""];
  const line = cookies.find((entry) => entry.startsWith(`${SESSION_COOKIE}=`));
  if (!line) throw new Error("missing session cookie");
  return line;
}

function cookieValue(line: string): string {
  return line.split(";")[0].slice(SESSION_COOKIE.length + 1);
}

// POST /refresh returns immediately — the job settles in the background and
// /refresh/status reports the outcome. Poll it until the notice lands.
async function waitRefreshNotice(
  instance: ReturnType<typeof app>,
  cookie: string,
): Promise<{ status: string; notice: string | null }> {
  for (let i = 0; i < 200; i++) {
    const res = await instance.app.request("/refresh/status", { headers: { Cookie: cookie } });
    const state = (await res.json()) as { status: string; notice: string | null };
    if (state.status !== "running") return state;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("refresh job did not settle");
}

async function fakeTarball() {
  const { execFile } = await import("node:child_process");
  const { mkdtemp, mkdir, writeFile, readFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { promisify } = await import("node:util");
  const dir = await mkdtemp(join(tmpdir(), "eru-tar-"));
  await mkdir(join(dir, "repo-sha"));
  await writeFile(join(dir, "repo-sha", "index.ts"), "export {};\n");
  await promisify(execFile)("tar", ["-czf", join(dir, "a.tgz"), "-C", dir, "repo-sha"]);
  return readFile(join(dir, "a.tgz"));
}

describe("operator gate", () => {
  it("serves health without a cookie and without Basic Auth", async () => {
    const { app: instance } = app();
    const res = await instance.request("/health");
    expect(res.status).toBe(200);
    expect(res.headers.get("www-authenticate")).toBeNull();
    await expect(res.json()).resolves.toEqual({ ok: true });
  });

  it("redirects the home page to login", async () => {
    const { app: instance } = app();
    const res = await instance.request("/", { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/login");
  });

  it("refuses unauthenticated mutating routes", async () => {
    const { app: instance } = app();
    const res = await instance.request("/ask", {
      method: "POST",
      body: new URLSearchParams({ q: "hi" }),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBeNull();
  });

  it("sets an HttpOnly SameSite=Lax cookie on login and keeps Secure off on HTTP", async () => {
    const { app: instance, config } = app();
    const res = await login(instance);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/");
    const line = cookieLine(res);
    expect(line.toLowerCase()).toContain("httponly");
    expect(line.toLowerCase()).toContain("samesite=lax");
    expect(line.toLowerCase()).not.toContain("secure");
    const session = verifySession(config.sessionSecret, cookieValue(line));
    expect(session?.csrf).toBeTruthy();
  });

  it("renders Brief and Ask chrome after login", async () => {
    const { app: instance, config } = app();
    const loggedIn = await login(instance);
    const cookie = `${SESSION_COOKIE}=${cookieValue(cookieLine(loggedIn))}`;
    const res = await instance.request("/", { headers: { Cookie: cookie } });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("Brief");
    expect(body).toContain("Ask");
    expect(body).toContain("connect a repo");
    expect(body).toContain("not a checkout job, not DeepWiki.com");
    expect(body).not.toContain("Eruka");
    expect(body).not.toContain("WWW-Authenticate");
    const session = verifySession(config.sessionSecret, cookieValue(cookieLine(loggedIn)));
    expect(body).toContain(`name="${CSRF_FIELD}"`);
    expect(body).toContain(session!.csrf);
  });

  it("rejects cookie POSTs without CSRF", async () => {
    const { app: instance } = app();
    const loggedIn = await login(instance);
    const cookie = `${SESSION_COOKIE}=${cookieValue(cookieLine(loggedIn))}`;
    const res = await instance.request("/ask", {
      method: "POST",
      body: new URLSearchParams({ q: "hi" }),
      headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookie },
    });
    expect(res.status).toBe(403);
  });

  it("accepts Ask with CSRF and HTMX", async () => {
    const { app: instance, config } = app();
    const loggedIn = await login(instance);
    const token = cookieValue(cookieLine(loggedIn));
    const session = verifySession(config.sessionSecret, token)!;
    const res = await instance.request("/ask", {
      method: "POST",
      body: new URLSearchParams({ q: "What is this?", [CSRF_FIELD]: session.csrf }),
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: `${SESSION_COOKIE}=${token}`,
        "HX-Request": "true",
      },
    });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("Connect a repo before asking.");
    expect(body).toContain('id="ask-result"');
  });

  it("throttles login bursts", async () => {
    const { app: instance } = app({ loginLimit: 3 });
    let last = 0;
    for (let i = 0; i < 4; i += 1) {
      const res = await instance.request("/login", {
        method: "POST",
        body: new URLSearchParams({ password: "wrong" }),
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      });
      last = res.status;
    }
    expect(last).toBe(429);
  });

  it("throttles login per client when forwarding headers are present", async () => {
    const { app: instance } = app({ loginLimit: 2 });

    async function attempt(headers: Record<string, string>) {
      return instance.request("/login", {
        method: "POST",
        body: new URLSearchParams({ password: "wrong" }),
        headers: { "Content-Type": "application/x-www-form-urlencoded", ...headers },
      });
    }

    expect((await attempt({ "X-Forwarded-For": "203.0.113.10" })).status).toBe(401);
    expect((await attempt({ "X-Forwarded-For": "203.0.113.10" })).status).toBe(401);
    expect((await attempt({ "X-Forwarded-For": "203.0.113.10" })).status).toBe(429);
    expect((await attempt({ "X-Forwarded-For": "203.0.113.10, 10.0.0.1" })).status).toBe(429);
    expect((await attempt({ "X-Forwarded-For": "203.0.113.11" })).status).toBe(401);
    expect((await attempt({ "X-Real-IP": "198.51.100.5" })).status).toBe(401);
    expect((await attempt({ "X-Real-IP": "198.51.100.5" })).status).toBe(401);
    expect((await attempt({ "X-Real-IP": "198.51.100.5" })).status).toBe(429);
  });
});

describe("forge connect", () => {
  function githubFetch(status: number, body: unknown = {}) {
    return async (_url: string, _init: RequestInit) =>
      new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  }

  async function authed(instance: ReturnType<typeof app>["app"], config: Config) {
    const loggedIn = await login(instance);
    const token = cookieValue(cookieLine(loggedIn));
    const session = verifySession(config.sessionSecret, token)!;
    return { cookie: `${SESSION_COOKIE}=${token}`, csrf: session.csrf };
  }

  it("requires a session for GET /connect and CSRF for POST /connect", async () => {
    const { app: instance, config } = app();
    const unauth = await instance.request("/connect", { redirect: "manual" });
    expect(unauth.status).toBe(302);
    expect(unauth.headers.get("location")).toBe("/login?next=%2Fconnect");

    const { cookie, csrf } = await authed(instance, config);
    const noCsrf = await instance.request("/connect", {
      method: "POST",
      body: new URLSearchParams({ owner: "a", name: "b" }),
      headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookie },
    });
    expect(noCsrf.status).toBe(403);

    const page = await instance.request("/connect", { headers: { Cookie: cookie } });
    expect(page.status).toBe(200);
    const body = await page.text();
    expect(body).toContain('name="owner"');
    expect(body).toContain('name="name"');
    expect(body).toContain('name="token"');
    expect(body).toContain(`value="${csrf}"`);
  });

  it("connects a repo, stores the token encrypted, and shows owner/repo in the topbar", async () => {
    const { app: instance, config, db } = app(
      {},
      githubFetch(200, { owner: { login: "Dragonshorn-Studios" }, name: "eru", full_name: "Dragonshorn-Studios/eru" }),
    );
    const { cookie, csrf } = await authed(instance, config);
    const res = await instance.request("/connect", {
      method: "POST",
      body: new URLSearchParams({ owner: "dragonshorn-studios", name: "eru", token: "ghp_secret-token", [CSRF_FIELD]: csrf }),
      headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookie },
      redirect: "manual",
    });
    expect(res.status).toBe(302);

    const repo = getPrimaryRepo(db)!;
    expect(repo.owner).toBe("Dragonshorn-Studios");
    expect(repo.name).toBe("eru");
    const stored = getForgeCredential(db, repo.id)!;
    expect(stored).toBeTruthy();
    expect(stored).not.toContain("ghp_secret-token");
    expect(decryptForgeToken(config.sessionSecret, stored)).toBe("ghp_secret-token");

    const home = await instance.request("/", { headers: { Cookie: cookie } });
    const body = await home.text();
    expect(body).toContain("Dragonshorn-Studios / eru");
    expect(body).toContain("not mapped yet");
  });

  it("encrypts the stored token under the dedicated forge key when configured", async () => {
    const { app: instance, config, db } = app(
      { forgeKeySecret: "forge-key-material-16+" },
      githubFetch(200, { owner: { login: "o" }, name: "r" }),
    );
    const { cookie, csrf } = await authed(instance, config);
    const res = await instance.request("/connect", {
      method: "POST",
      body: new URLSearchParams({ owner: "o", name: "r", token: "ghp_dedicated", [CSRF_FIELD]: csrf }),
      headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookie },
      redirect: "manual",
    });
    expect(res.status).toBe(302);

    const stored = getForgeCredential(db, getPrimaryRepo(db)!.id)!;
    expect(decryptForgeToken(forgeKeySecrets(config), stored)).toBe("ghp_dedicated");
    // Encryption used the dedicated key, not the session secret.
    expect(() => decryptForgeToken(config.sessionSecret, stored)).toThrow();
    expect(decryptForgeToken(config.forgeKeySecret!, stored)).toBe("ghp_dedicated");
  });

  it("rejects invalid owner/repo and unreachable or unresolvable targets without storing anything", async () => {
    const notFound = app({}, githubFetch(404));
    const { cookie, csrf } = await authed(notFound.app, notFound.config);
    for (const [owner, name] of [
      ["bad owner!", "repo"],
      ["owner", "x".repeat(101)],
      ["owner", "missing-repo"],
    ]) {
      const res = await notFound.app.request("/connect", {
        method: "POST",
        body: new URLSearchParams({ owner, name, [CSRF_FIELD]: csrf }),
        headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookie },
      });
      expect(res.status).toBe(400);
      expect(getPrimaryRepo(notFound.db)).toBeUndefined();
    }

    const down = app({}, async () => {
      throw new Error("network down");
    });
    const { cookie: cookie2, csrf: csrf2 } = await authed(down.app, down.config);
    const res = await down.app.request("/connect", {
      method: "POST",
      body: new URLSearchParams({ owner: "o", name: "r", [CSRF_FIELD]: csrf2 }),
      headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookie2 },
    });
    expect(res.status).toBe(502);
    expect(getPrimaryRepo(down.db)).toBeUndefined();
  });

  it("reconnecting without a token clears the stored credential", async () => {
    const { app: instance, config, db } = app(
      {},
      githubFetch(200, { owner: { login: "o" }, name: "r" }),
    );
    const { cookie, csrf } = await authed(instance, config);
    const post = (token: string) =>
      instance.request("/connect", {
        method: "POST",
        body: new URLSearchParams({ owner: "o", name: "r", token, [CSRF_FIELD]: csrf }),
        headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookie },
        redirect: "manual",
      });
    expect((await post("ghp_one")).status).toBe(302);
    const repo = getPrimaryRepo(db)!;
    expect(getForgeCredential(db, repo.id)).toBeTruthy();
    expect((await post("")).status).toBe(302);
    expect(getForgeCredential(db, repo.id)).toBeUndefined();
  });
});

async function seed(
  instance: ReturnType<typeof app>,
  pages: { slug: string; title: string; body: string; sortOrder: number }[],
  forgeToken?: string,
) {
  const repoId = upsertConnectedRepo(
    instance.db,
    { forge: "github", owner: "acme", name: "box" },
    "2026-01-01T00:00:00Z",
  );
  if (forgeToken) {
    setForgeCredential(
      instance.db,
      repoId,
      encryptForgeToken(instance.config.sessionSecret, forgeToken),
      "2026-01-01T00:00:00Z",
    );
  }
  for (const page of pages) {
    upsertPage(instance.db, repoId, { ...page, mappedRef: "main" }, "2026-01-01T00:00:00Z");
  }
  const loggedIn = await login(instance.app);
  const token = cookieValue(cookieLine(loggedIn));
  return `${SESSION_COOKIE}=${token}`;
}

describe("durable Brief pages", () => {
  const PAGES = [
    { slug: "arch", title: "Architecture", body: "arch body line\nmore arch", sortOrder: 0 },
    { slug: "auth", title: "Auth", body: "auth body", sortOrder: 1 },
  ];

  it("lists stored pages in the Brief TOC and shows the first page body", async () => {
    const instance = app();
    const cookie = await seed(instance, PAGES);
    const res = await instance.app.request("/brief", { headers: { Cookie: cookie } });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("/brief/arch");
    expect(body).toContain("/brief/auth");
    expect(body).toContain("arch body line");
    expect(body).toContain("aria-current=\"page\"");
  });

  it("renders the requested page and escapes its body", async () => {
    const instance = app();
    const cookie = await seed(instance, [
      { slug: "x", title: "XSS", body: "<script>alert(1)</script>", sortOrder: 0 },
    ]);
    const res = await instance.app.request("/brief/x", { headers: { Cookie: cookie } });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(body).not.toContain("<script>alert(1)");
  });

  it("escapes hostile titles and mapped refs, not just bodies", async () => {
    const instance = app();
    const repoId = upsertConnectedRepo(
      instance.db,
      { forge: "github", owner: "acme", name: "box" },
      "2026-01-01T00:00:00Z",
    );
    upsertPage(
      instance.db,
      repoId,
      {
        slug: "evil",
        title: '<img src=x onerror=alert("t")>',
        body: "b",
        sortOrder: 0,
        mappedRef: '<svg onload=alert("r")>',
      },
      "t",
    );
    const loggedIn = await login(instance.app);
    const cookie = `${SESSION_COOKIE}=${cookieValue(cookieLine(loggedIn))}`;
    const res = await instance.app.request("/brief/evil", { headers: { Cookie: cookie } });
    const body = await res.text();
    expect(body).toContain("&lt;img src=x");
    expect(body).toContain("&lt;svg onload");
    expect(body).not.toContain('<img src=x onerror=alert("t")>');
    expect(body).not.toContain('<svg onload=alert("r")>');
  });

  it("404s an unknown slug when pages exist, and falls to the empty state when none do", async () => {
    const instance = app();
    const cookie = await seed(instance, PAGES);
    const res = await instance.app.request("/brief/nope", { headers: { Cookie: cookie } });
    expect(res.status).toBe(404);

    const empty = app();
    const emptyCookie = await seed(empty, []);
    const res2 = await empty.app.request("/brief/missing", { headers: { Cookie: emptyCookie } });
    expect(res2.status).toBe(200);
    expect(await res2.text()).toContain("No map pages yet");
  });

  it("shows a clear empty state before the first refresh and a connect prompt without a repo", async () => {
    const instance = app();
    const withRepo = await seed(instance, []);
    const res = await instance.app.request("/brief", { headers: { Cookie: withRepo } });
    const body = await res.text();
    expect(body).toContain("No map pages yet");

    const fresh = app();
    const loggedIn = await login(fresh.app);
    const cookie = `${SESSION_COOKIE}=${cookieValue(cookieLine(loggedIn))}`;
    const res2 = await fresh.app.request("/brief", { headers: { Cookie: cookie } });
    const body2 = await res2.text();
    expect(body2).toContain("No repo connected");
    expect(body2).toContain("/connect");
  });
});

describe("ask OpenCode", () => {
  async function ask(instance: ReturnType<typeof app>, q: string, htmx = true) {
    const loggedIn = await login(instance.app);
    const token = cookieValue(cookieLine(loggedIn));
    const session = verifySession(instance.config.sessionSecret, token)!;
    return instance.app.request("/ask", {
      method: "POST",
      body: new URLSearchParams({ q, [CSRF_FIELD]: session.csrf }),
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: `${SESSION_COOKIE}=${token}`,
        ...(htmx ? { "HX-Request": "true" } : {}),
      },
    });
  }

  it("answers via the runner with pages and repo label, escaped", async () => {
    let seen: { q: string; slugs: string[]; label: string } | undefined;
    const runner: AskRunner = async (q, pages, label) => {
      seen = { q, slugs: pages.map((p) => p.slug), label };
      return { ok: true, answer: "See map/arch.md\n<script>alert(1)</script>" };
    };
    const instance = app({}, undefined, runner);
    await seed(instance, [{ slug: "arch", title: "Arch", body: "bodies", sortOrder: 0 }]);
    const res = await ask(instance, "how is auth?");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("See map/arch.md");
    expect(body).toContain("&lt;script&gt;");
    expect(body).not.toContain("<script>");
    expect(seen).toEqual({ q: "how is auth?", slugs: ["arch"], label: "acme/box" });
  });

  it("renders the answer into the full page without HTMX", async () => {
    const instance = app({}, undefined, async () => ({ ok: true, answer: "plain answer" }));
    await seed(instance, [{ slug: "a", title: "A", body: "b", sortOrder: 0 }]);
    const res = await ask(instance, "q", false);
    const body = await res.text();
    expect(body).toContain("plain answer");
    expect(body).toContain('class="ask-answer"');
  });

  it("refuses empty and oversized questions before touching OpenCode", async () => {
    let called = false;
    const runner: AskRunner = async () => {
      called = true;
      return { ok: true, answer: "x" };
    };
    const instance = app({}, undefined, runner);
    await seed(instance, [{ slug: "a", title: "A", body: "b", sortOrder: 0 }]);
    expect(await (await ask(instance, "   ")).text()).toContain("Ask something first.");
    expect(await (await ask(instance, "x".repeat(2001))).text()).toContain("under 2000 characters");
    expect(called).toBe(false);
  });

  it("fails closed without a repo or without map pages", async () => {
    const instance = app();
    expect(await (await ask(instance, "q")).text()).toContain("Connect a repo before asking.");
    await seed(instance, []);
    expect(await (await ask(instance, "q")).text()).toContain("no pages yet");
  });

  it("surfaces unconfigured and failed OpenCode honestly", async () => {
    const unconfigured = app({}, undefined, async () => ({ ok: false, error: "unconfigured" as const }));
    await seed(unconfigured, [{ slug: "a", title: "A", body: "b", sortOrder: 0 }]);
    expect(await (await ask(unconfigured, "q")).text()).toContain("not configured");

    const failed = app({}, undefined, async () => ({ ok: false, error: "failed" as const }));
    await seed(failed, [{ slug: "a", title: "A", body: "b", sortOrder: 0 }]);
    expect(await (await ask(failed, "q")).text()).toContain("could not answer");
  });
});

describe("refresh map", () => {
  async function refreshPost(instance: ReturnType<typeof app>, htmx = true) {
    const loggedIn = await login(instance.app);
    const token = cookieValue(cookieLine(loggedIn));
    const session = verifySession(instance.config.sessionSecret, token)!;
    const res = await instance.app.request("/refresh", {
      method: "POST",
      body: new URLSearchParams({ [CSRF_FIELD]: session.csrf }),
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: `${SESSION_COOKIE}=${token}`,
        ...(htmx ? { "HX-Request": "true" } : {}),
      },
    });
    // The job runs in the background — wait on /refresh/status for the notice.
    // No repo means no job at all: the POST itself carries the notice.
    const postText = await res.text();
    const state = await waitRefreshNotice(instance, `${SESSION_COOKIE}=${token}`);
    return new Response(state.notice ?? postText, { status: res.status });
  }

  it("upserts pages and last_mapped_ref from OpenCode output", async () => {
    const tar = await fakeTarball();
    let sentAuth: string | undefined;
    let sawCheckout = false;
    const fetchImpl = async (url: string, init: RequestInit) => {
      sentAuth = (init.headers as Record<string, string>)?.Authorization;
      expect(url).toContain("/repos/acme/box/tarball/main");
      return new Response(new Uint8Array(tar));
    };
    const runner = async (workdir: string) => {
      const { existsSync } = await import("node:fs");
      const { join } = await import("node:path");
      sawCheckout = existsSync(join(workdir, "index.ts"));
      return { ok: true as const, pages: [{ slug: "arch", title: "Arch", body: "mapped", sortOrder: 0 }] };
    };
    const instance = app({}, fetchImpl, undefined, runner);
    await seed(instance, [], "tok");
    const res = await refreshPost(instance);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Mapped @main — 1 page.");
    expect(sentAuth).toBe("Bearer tok");
    expect(sawCheckout).toBe(true);
    const repo = getPrimaryRepo(instance.db)!;
    expect(repo.lastMappedRef).toBe("main");
    expect(listPages(instance.db, repo.id).map((p) => p.slug)).toEqual(["arch"]);

    const cookie = await seed(instance, []);
    const home = await instance.app.request("/", { headers: { Cookie: cookie } });
    expect(await home.text()).toContain("last mapped @main");
  });

  it("refuses missing setup without touching the forge", async () => {
    let fetched = false;
    const fetchImpl = async () => {
      fetched = true;
      throw new Error("should not fetch");
    };
    const bare = app({}, fetchImpl);
    expect(await (await refreshPost(bare)).text()).toContain("Connect a repo");
    expect(fetched).toBe(false);

    // Anonymous connects refresh without a token: the forge is still called
    // (no Authorization header) and maps the public-repo outcome honestly.
    let sawAuth = "unset";
    const noCred = app({}, async (url, init) => {
      sawAuth = (init.headers as Record<string, string> | undefined)?.Authorization ?? "none";
      return new Response("nope", { status: 404 });
    });
    await seed(noCred, []);
    expect(await (await refreshPost(noCred)).text()).toContain("could not find that ref");
    expect(sawAuth).toBe("none");
  });

  it("maps the stored default branch and falls back to master when main 404s", async () => {
    const tar = await fakeTarball();
    const seen: string[] = [];
    const fetchImpl = async (url: string) => {
      seen.push(url);
      if (url.endsWith("/tarball/master")) return new Response(new Uint8Array(tar));
      return new Response("nope", { status: 404 });
    };
    const runner = async () => ({ ok: true as const, pages: [{ slug: "a", title: "A", body: "b", sortOrder: 0 }] });
    const instance = app({}, fetchImpl, undefined, runner);
    await seed(instance, [], "tok");
    const res = await refreshPost(instance);
    expect(await res.text()).toContain("Mapped @master — 1 page.");
    expect(seen.some((u) => u.endsWith("/tarball/main"))).toBe(true);
    expect(seen.some((u) => u.endsWith("/tarball/master"))).toBe(true);

    const seenTrunk: string[] = [];
    const trunkFetch = async (url: string) => {
      seenTrunk.push(url);
      return new Response(new Uint8Array(tar));
    };
    const trunk = app({}, trunkFetch, undefined, runner);
    const repoId = upsertConnectedRepo(
      trunk.db,
      { forge: "github", owner: "acme", name: "box", defaultBranch: "trunk" },
      "2026-01-01T00:00:00Z",
    );
    setForgeCredential(trunk.db, repoId, encryptForgeToken(trunk.config.sessionSecret, "tok"), "2026-01-01T00:00:00Z");
    const res2 = await refreshPost(trunk);
    expect(await res2.text()).toContain("Mapped @trunk — 1 page.");
    expect(seenTrunk.every((u) => u.endsWith("/tarball/trunk"))).toBe(true);
  });

  it("maps forge and OpenCode failures to honest notices", async () => {
    const notFound = app({}, async () => new Response("nope", { status: 404 }));
    await seed(notFound, [], "tok");
    expect(await (await refreshPost(notFound)).text()).toContain("could not find that ref");

    const tar = await fakeTarball();
    const okFetch = async () => new Response(new Uint8Array(tar));
    const unconfigured = app(
      {},
      okFetch,
      undefined,
      async () => ({ ok: false as const, error: "unconfigured" as const }),
    );
    await seed(unconfigured, [], "tok");
    expect(await (await refreshPost(unconfigured)).text()).toContain("not configured");

    const nomap = app({}, okFetch, undefined, async () => ({ ok: false as const, error: "nomap" as const }));
    await seed(nomap, [], "tok");
    expect(await (await refreshPost(nomap)).text()).toContain("did not return map pages");
  });
});

describe("locked tokens", () => {
  it("serves CSS variables for the token lock", async () => {
    const { app: instance } = app();
    const res = await instance.request("/assets/eru.css");
    expect(res.status).toBe(200);
    const css = await res.text();
    for (const hex of Object.values(TOKENS)) {
      expect(css).toContain(hex);
    }
  });

  it("serves the exact public HTMX asset and gates unknown assets", async () => {
    const { app: instance } = app();
    const htmx = await instance.request("/assets/htmx.min.js");
    expect(htmx.status).toBe(200);
    const unknown = await instance.request("/assets/secret.css", { redirect: "manual" });
    expect(unknown.status).toBe(302);
    expect(unknown.headers.get("location")).toBe("/login?next=%2Fassets%2Fsecret.css");
  });

  it("serves browser icons publicly with long-lived cache headers", async () => {
    const { app: instance } = app();
    for (const [path, contentType] of [
      ["/favicon.ico", "image/x-icon"],
      ["/assets/favicon-32.png", "image/png"],
      ["/assets/apple-touch-icon.png", "image/png"],
    ] as const) {
      const res = await instance.request(path);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain(contentType);
      expect(res.headers.get("cache-control")).toContain("immutable");
      expect((await res.arrayBuffer()).byteLength).toBeGreaterThan(100);
    }
  });
});

describe("docs lock", () => {
  it("keeps the Liter capsule and names the skills", () => {
    const readme = readFileSync("README.md", "utf8");
    expect(readme).toContain("I'm curious about this repo.");
    expect(readme).toContain("not a checkout job, not DeepWiki.com");
    const agents = readFileSync("AGENTS.md", "utf8");
    expect(agents).toContain("eru-shape");
    expect(agents).toContain("eru-security");
  });

  it("describes chrome as CSS variables and hand CSS, not a Tailwind pipeline", () => {
    const readme = readFileSync("README.md", "utf8");
    const agents = readFileSync("AGENTS.md", "utf8");
    const contributing = readFileSync("CONTRIBUTING.md", "utf8");
    const shape = readFileSync(".cursor/skills/eru-shape/SKILL.md", "utf8");
    for (const text of [readme, agents, contributing, shape]) {
      expect(text).toMatch(/hand CSS/);
      expect(text).not.toMatch(/HTMX \+ Tailwind/);
    }
    expect(agents).toContain("CSS variables");
    expect(agents).toContain("no Tailwind pipeline");
    expect(contributing).toContain("not a Tailwind pipeline");
    expect(shape).toContain("no Tailwind pipeline");
  });

  it("keeps .agents skills as pointers, not copied bodies", () => {
    for (const name of ["eru-shape", "eru-security"] as const) {
      const cursor = readFileSync(`.cursor/skills/${name}/SKILL.md`, "utf8");
      const agentsRoot = `.agents/skills/${name}`;
      const stat = lstatSync(agentsRoot);
      if (stat.isSymbolicLink()) {
        expect(readlinkSync(agentsRoot).replaceAll("\\", "/")).toMatch(new RegExp(`\\.cursor/skills/${name}$`));
        continue;
      }
      const pointer = readFileSync(`${agentsRoot}/SKILL.md`, "utf8");
      expect(pointer).toContain(`.cursor/skills/${name}`);
      expect(pointer.length).toBeLessThan(cursor.length);
      expect(pointer).not.toEqual(cursor);
    }
  });
});

describe("config page", () => {
  async function authed(instance: ReturnType<typeof app>) {
    const loggedIn = await login(instance.app);
    const token = cookieValue(cookieLine(loggedIn));
    const session = verifySession(instance.config.sessionSecret, token)!;
    return { cookie: `${SESSION_COOKIE}=${token}`, csrf: session.csrf };
  }

  async function post(instance: ReturnType<typeof app>, path: string, fields: Record<string, string>) {
    const { cookie, csrf } = await authed(instance);
    return instance.app.request(path, {
      method: "POST",
      body: new URLSearchParams({ ...fields, [CSRF_FIELD]: csrf }),
      headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookie },
      redirect: "manual",
    });
  }

  it("renders model pickers fed by the discovered model list", async () => {
    const instance = app(
      { openCodeModel: "anthropic/claude-sonnet-4" },
      undefined,
      undefined,
      undefined,
      undefined,
      {
        snapshot: () => ({ models: ["anthropic/claude-sonnet-4", "openai/gpt-5"], updatedAt: "t" }),
        refresh: async () => {},
      },
    );
    const { cookie } = await authed(instance);
    const res = await instance.app.request("/config", { headers: { Cookie: cookie } });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("Ask model");
    expect(body).toContain("Map model");
    expect(body).toContain("ERU_OPENCODE_ASK_MODEL");
    expect(body).toContain("ERU_OPENCODE_MAP_MODEL");
    expect(body).toContain('<select name="ask_model">');
    expect(body).toContain('<option value="anthropic/claude-sonnet-4">anthropic/claude-sonnet-4</option>');
    expect(body).not.toContain('list="opencode-models"');
    // A saved value outside the discovered list still shows as the saved choice.
    await post(instance, "/config/models", { ask_model: "custom/thing", map_model: "" });
    const saved = await (await instance.app.request("/config", { headers: { Cookie: cookie } })).text();
    expect(saved).toContain('value="custom/thing" selected>custom/thing · saved');
  });

  it("saves models to settings and passes them to the runners", async () => {
    let askModel: string | undefined;
    let mapModel: string | undefined;
    const askRunner: AskRunner = async (_q, _p, _l, model) => {
      askModel = model;
      return { ok: true, answer: "ok" };
    };
    const refreshRunner: RefreshRunner = async (_w, _l, _r, model) => {
      mapModel = model;
      return { ok: false, error: "nomap" };
    };
    const instance = app({}, async () => new Response(new Uint8Array(await fakeTarball())), askRunner, refreshRunner);
    await seed(instance, [{ slug: "arch", title: "Arch", body: "b", sortOrder: 0 }], "tok");

    const res = await post(instance, "/config/models", {
      ask_model: "anthropic/claude-haiku",
      map_model: "openai/gpt-5",
    });
    expect(res.status).toBe(302);

    const loggedIn = await login(instance.app);
    const token = cookieValue(cookieLine(loggedIn));
    const session = verifySession(instance.config.sessionSecret, token)!;
    await instance.app.request("/ask", {
      method: "POST",
      body: new URLSearchParams({ q: "hi", [CSRF_FIELD]: session.csrf }),
      headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: `${SESSION_COOKIE}=${token}` },
    });
    expect(askModel).toBe("anthropic/claude-haiku");

    await instance.app.request("/refresh", {
      method: "POST",
      body: new URLSearchParams({ ref: "main", [CSRF_FIELD]: session.csrf }),
      headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: `${SESSION_COOKIE}=${token}` },
    });
    await waitRefreshNotice(instance, `${SESSION_COOKIE}=${token}`);
    expect(mapModel).toBe("openai/gpt-5");

    // Clearing the field removes the stored override.
    await post(instance, "/config/models", { ask_model: "", map_model: "openai/gpt-5" });
    const { cookie } = await authed(instance);
    const page = await (await instance.app.request("/config", { headers: { Cookie: cookie } })).text();
    expect(page).toContain("OpenCode default");
  });

  it("saved model beats the env override and is marked as overriding", async () => {
    let askModel: string | undefined;
    const askRunner: AskRunner = async (_q, _p, _l, model) => {
      askModel = model;
      return { ok: true, answer: "ok" };
    };
    const instance = app({ openCodeAskModel: "env/fallback" }, undefined, askRunner);
    await seed(instance, [{ slug: "arch", title: "Arch", body: "b", sortOrder: 0 }]);
    await post(instance, "/config/models", { ask_model: "stored/wins", map_model: "" });
    const loggedIn = await login(instance.app);
    const token = cookieValue(cookieLine(loggedIn));
    const session = verifySession(instance.config.sessionSecret, token)!;
    await instance.app.request("/ask", {
      method: "POST",
      body: new URLSearchParams({ q: "hi", [CSRF_FIELD]: session.csrf }),
      headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: `${SESSION_COOKIE}=${token}` },
    });
    expect(askModel).toBe("stored/wins");

    const { cookie } = await authed(instance);
    const page = await (await instance.app.request("/config", { headers: { Cookie: cookie } })).text();
    expect(page).toContain("saved on this page · overrides <code>ERU_OPENCODE_ASK_MODEL</code>");
  });

  it("rejects malformed model names without storing", async () => {
    const instance = app();
    const res = await post(instance, "/config/models", { ask_model: "not a model!", map_model: "" });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("not a model name");
    const { cookie } = await authed(instance);
    const page = await (await instance.app.request("/config", { headers: { Cookie: cookie } })).text();
    expect(page).toContain("OpenCode default");
  });

  it("refreshes the discovered model list", async () => {
    let refreshed = 0;
    const discovery = {
      snapshot: () => ({ models: ["prov/a", "prov/b"] }),
      refresh: async () => {
        refreshed++;
      },
    };
    const config = gatedConfig();
    const db = openDb(":memory:");
    const instance = { app: createApp({ config, db, modelDiscovery: discovery }), config, db };
    expect(refreshed).toBe(1); // boot refresh
    const res = await post(instance, "/config/models/refresh", {});
    expect(res.status).toBe(302);
    expect(refreshed).toBe(2);
    const { cookie } = await authed(instance);
    const page = await (await instance.app.request("/config", { headers: { Cookie: cookie } })).text();
    expect(page).toContain("2 models discovered");
    expect(page).toContain('value="prov/a"');
  });
});

describe("github app", () => {
  const APP_PEM = generateKeyPairSync("rsa", { modulusLength: 2048 })
    .privateKey.export({ type: "pkcs8", format: "pem" })
    .toString();

  function appFetch(seen: { auth: string; path: string }[], tarballBody?: Buffer) {
    return async (url: string, init: RequestInit) => {
      const u = new URL(url);
      seen.push({ auth: (init.headers as Record<string, string>)?.Authorization ?? "none", path: u.pathname });
      const json = (status: number, body: unknown) =>
        new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
      if (u.pathname === "/app/installations") return json(200, [{ id: 7 }]);
      if (u.pathname === "/app/installations/7/access_tokens") {
        return json(201, { token: "ghs_inst_tok", expires_at: "2030-01-01T00:00:00Z" });
      }
      if (u.pathname === "/installation/repositories") {
        return json(200, {
          total_count: 2,
          repositories: [
            { owner: { login: "acme" }, name: "box", private: true },
            { owner: { login: "acme" }, name: "cart", private: false },
          ],
        });
      }
      if (u.pathname === "/repos/acme/box") return json(200, { owner: { login: "acme" }, name: "box" });
      if (u.pathname.startsWith("/repos/") && u.pathname.includes("/tarball/") && tarballBody) {
        return new Response(new Uint8Array(tarballBody));
      }
      return json(404, {});
    };
  }

  async function authed(instance: ReturnType<typeof app>) {
    const loggedIn = await login(instance.app);
    const token = cookieValue(cookieLine(loggedIn));
    const session = verifySession(instance.config.sessionSecret, token)!;
    return { cookie: `${SESSION_COOKIE}=${token}`, csrf: session.csrf };
  }

  async function post(instance: ReturnType<typeof app>, path: string, fields: Record<string, string>) {
    const { cookie, csrf } = await authed(instance);
    return instance.app.request(path, {
      method: "POST",
      body: new URLSearchParams({ ...fields, [CSRF_FIELD]: csrf }),
      headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookie },
      redirect: "manual",
    });
  }

  it("saves app config with the private key encrypted, and removes it", async () => {
    const instance = app();
    const res = await post(instance, "/config/github-app", {
      app_id: "4242",
      app_installation_id: "777",
      app_private_key: APP_PEM,
    });
    expect(res.status).toBe(302);
    expect(getSetting(instance.db, "github_app.id")).toBe("4242");
    expect(getSetting(instance.db, "github_app.installation_id")).toBe("777");
    const storedKey = getSetting(instance.db, "github_app.private_key")!;
    expect(storedKey).toMatch(/^v1\./);
    expect(storedKey).not.toContain("PRIVATE KEY");
    expect(decryptForgeToken(instance.config.sessionSecret, storedKey)).toBe(APP_PEM.trim());

    const { cookie } = await authed(instance);
    const page = await (await instance.app.request("/config", { headers: { Cookie: cookie } })).text();
    expect(page).toContain("key saved on this page");

    const removed = await post(instance, "/config/github-app/remove", {});
    expect(removed.status).toBe(302);
    expect(getSetting(instance.db, "github_app.id")).toBeUndefined();
    expect(getSetting(instance.db, "github_app.private_key")).toBeUndefined();
  });

  it("rejects malformed app fields without storing", async () => {
    const instance = app();
    for (const fields of [
      { app_id: "abc", app_installation_id: "", app_private_key: "" },
      { app_id: "1", app_installation_id: "x", app_private_key: "" },
      { app_id: "1", app_installation_id: "", app_private_key: "not-a-pem" },
    ]) {
      const res = await post(instance, "/config/github-app", fields);
      expect(res.status).toBe(400);
    }
    expect(getSetting(instance.db, "github_app.id")).toBeUndefined();
  });

  it("lists installation repos on /connect and connects one via the app", async () => {
    const seen: { auth: string; path: string }[] = [];
    const instance = app({ githubAppId: "4242", githubAppPrivateKey: APP_PEM }, appFetch(seen));
    const { cookie, csrf } = await authed(instance);
    const page = await (await instance.app.request("/connect", { headers: { Cookie: cookie } })).text();
    expect(page).toContain("acme/box");
    expect(page).toContain("acme/cart");
    expect(page).toContain("private");
    expect(page).toContain('action="/connect/app"');
    expect(page).toContain("or add manually");

    const res = await instance.app.request("/connect/app", {
      method: "POST",
      body: new URLSearchParams({ owner: "acme", name: "box", [CSRF_FIELD]: csrf }),
      headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookie },
      redirect: "manual",
    });
    expect(res.status).toBe(302);
    const repo = getPrimaryRepo(instance.db)!;
    expect(repo.authSource).toBe("app");
    expect(getForgeCredential(instance.db, repo.id)).toBeUndefined();
    // The repo verify ran on an installation token minted from the app JWT.
    expect(seen.some((s) => s.path === "/app/installations/7/access_tokens" && s.auth.startsWith("Bearer eyJ"))).toBe(
      true,
    );
    expect(seen.some((s) => s.path === "/repos/acme/box" && s.auth === "Bearer ghs_inst_tok")).toBe(true);
  });

  it("refreshes an app-connected repo with the installation token", async () => {
    const tar = await fakeTarball();
    const seen: { auth: string; path: string }[] = [];
    const instance = app(
      { githubAppId: "4242", githubAppPrivateKey: APP_PEM },
      appFetch(seen, tar),
      undefined,
      async () => ({ ok: true as const, pages: [{ slug: "a", title: "A", body: "b", sortOrder: 0 }] }),
    );
    const repoId = upsertConnectedRepo(instance.db, { forge: "github", owner: "acme", name: "box" }, "t", "app");
    expect(repoId).toBeGreaterThan(0);

    const { cookie, csrf } = await authed(instance);
    await instance.app.request("/refresh", {
      method: "POST",
      body: new URLSearchParams({ ref: "main", [CSRF_FIELD]: csrf }),
      headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookie, "HX-Request": "true" },
    });
    const state = await waitRefreshNotice(instance, cookie);
    expect(state.notice).toContain("Mapped @main");
    const tarballCall = seen.find((s) => s.path.includes("/tarball/main"));
    expect(tarballCall?.auth).toBe("Bearer ghs_inst_tok");
  });

  it("refuses refresh on an app repo when the app is no longer configured", async () => {
    const instance = app();
    upsertConnectedRepo(instance.db, { forge: "github", owner: "acme", name: "box" }, "t", "app");
    const { cookie, csrf } = await authed(instance);
    await instance.app.request("/refresh", {
      method: "POST",
      body: new URLSearchParams({ ref: "main", [CSRF_FIELD]: csrf }),
      headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookie, "HX-Request": "true" },
    });
    const state = await waitRefreshNotice(instance, cookie);
    expect(state.status).toBe("failed");
    expect(state.notice).toContain("GitHub App is not configured");
  });

  it("shows a stored app id as in-effect and marks the env var as overridden", async () => {
    const instance = app({ githubAppId: "99999", githubAppPrivateKey: APP_PEM });
    await post(instance, "/config/github-app", { app_id: "111", app_installation_id: "", app_private_key: "" });
    const { cookie } = await authed(instance);
    const page = await (await instance.app.request("/config", { headers: { Cookie: cookie } })).text();
    expect(page).toContain("saved on this page · overrides <code>ERU_GITHUB_APP_ID</code>");
    expect(page).toContain('value="111"');
  });
});

describe("repo selection", () => {
  async function authed(instance: ReturnType<typeof app>) {
    const loggedIn = await login(instance.app);
    const token = cookieValue(cookieLine(loggedIn));
    const session = verifySession(instance.config.sessionSecret, token)!;
    return { cookie: `${SESSION_COOKIE}=${token}`, csrf: session.csrf };
  }

  function twoRepos(instance: ReturnType<typeof app>) {
    const box = upsertConnectedRepo(instance.db, { forge: "github", owner: "acme", name: "box" }, "2026-01-01T00:00:00Z");
    const cart = upsertConnectedRepo(instance.db, { forge: "github", owner: "acme", name: "cart" }, "2026-01-02T00:00:00Z");
    upsertPage(instance.db, box, { slug: "boxpage", title: "BoxPage", body: "box body", sortOrder: 0, mappedRef: "main" }, "t");
    upsertPage(instance.db, cart, { slug: "cartpage", title: "CartPage", body: "cart body", sortOrder: 0, mappedRef: "dev" }, "t");
    setLastMapped(instance.db, box, "main", "t");
    setLastMapped(instance.db, cart, "dev", "t");
    return { box, cart };
  }

  it("shows a switcher with multiple repos, selects the newest connect, and honors a switch", async () => {
    const instance = app();
    const { box } = twoRepos(instance);
    const { cookie, csrf } = await authed(instance);
    const home = await (await instance.app.request("/", { headers: { Cookie: cookie } })).text();
    expect(home).toContain('action="/repo/select"');
    expect(home).toContain("acme / box");
    expect(home).toContain("acme / cart");
    // Latest connect is primary by default.
    expect(home).toContain("CartPage");
    expect(home).toContain("last mapped @dev");

    const res = await instance.app.request("/repo/select", {
      method: "POST",
      body: new URLSearchParams({ repo_id: String(box), [CSRF_FIELD]: csrf }),
      headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookie },
      redirect: "manual",
    });
    expect(res.status).toBe(302);
    const switched = await (await instance.app.request("/", { headers: { Cookie: cookie } })).text();
    expect(switched).toContain("BoxPage");
    expect(switched).toContain("last mapped @main");
    expect(getSetting(instance.db, "ui.selected_repo")).toBe(String(box));
  });

  it("rejects an unknown repo id and falls back to primary on a stale selection", async () => {
    const instance = app();
    const { box, cart } = twoRepos(instance);
    const { cookie, csrf } = await authed(instance);
    const bad = await instance.app.request("/repo/select", {
      method: "POST",
      body: new URLSearchParams({ repo_id: "9999", [CSRF_FIELD]: csrf }),
      headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookie },
    });
    expect(bad.status).toBe(400);

    instance.db.prepare(`DELETE FROM repos WHERE id = ?`).run(box);
    setSetting(instance.db, "ui.selected_repo", String(box), "t");
    const home = await (await instance.app.request("/", { headers: { Cookie: cookie } })).text();
    expect(home).toContain("CartPage");
    expect(getPrimaryRepo(instance.db)!.id).toBe(cart);
  });

  it("connecting a repo selects it, and refresh acts on the selected repo", async () => {
    const tar = await fakeTarball();
    let tarballUrl = "";
    const fetchImpl = async (url: string) => {
      tarballUrl = url;
      return new Response(new Uint8Array(tar));
    };
    const instance = app(
      {},
      fetchImpl,
      undefined,
      async () => ({ ok: true as const, pages: [{ slug: "a", title: "A", body: "b", sortOrder: 0 }] }),
    );
    const { box } = twoRepos(instance);
    const { cookie, csrf } = await authed(instance);
    await instance.app.request("/repo/select", {
      method: "POST",
      body: new URLSearchParams({ repo_id: String(box), [CSRF_FIELD]: csrf }),
      headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookie },
      redirect: "manual",
    });
    await instance.app.request("/refresh", {
      method: "POST",
      body: new URLSearchParams({ ref: "main", [CSRF_FIELD]: csrf }),
      headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookie, "HX-Request": "true" },
    });
    const state = await waitRefreshNotice(instance, cookie);
    expect(state.notice).toContain("Mapped @main");
    expect(tarballUrl).toContain("/repos/acme/box/tarball/main");
  });
});

describe("operator pill", () => {
  async function authed(instance: ReturnType<typeof app>) {
    const loggedIn = await login(instance.app);
    const token = cookieValue(cookieLine(loggedIn));
    const session = verifySession(instance.config.sessionSecret, token)!;
    return { cookie: `${SESSION_COOKIE}=${token}`, csrf: session.csrf };
  }

  it("falls back to an operator monogram and picks up env or saved logins", async () => {
    const instance = app({ uiUser: "env-user" });
    const { cookie } = await authed(instance);
    const res = await instance.app.request("/", { headers: { Cookie: cookie } });
    const html = await res.text();
    expect(html).toContain('src="https://github.com/env-user.png?size=64"');
    expect(html).toContain("env-user");

    const plain = app();
    const plainAuth = await authed(plain);
    const resPlain = await plain.app.request("/", { headers: { Cookie: plainAuth.cookie } });
    const htmlPlain = await resPlain.text();
    expect(htmlPlain).toContain(">op<");
    expect(htmlPlain).not.toContain("github.com/operator.png");
  });

  it("saves and clears the login via /config/user", async () => {
    const instance = app();
    const { cookie, csrf } = await authed(instance);
    const save = await instance.app.request("/config/user", {
      method: "POST",
      body: new URLSearchParams({ ui_user: "stored-user", [CSRF_FIELD]: csrf }),
      headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookie },
    });
    expect(save.status).toBe(302);

    const home = await instance.app.request("/", { headers: { Cookie: cookie } });
    expect(await home.text()).toContain('src="https://github.com/stored-user.png?size=64"');
    const configPageRes = await instance.app.request("/config", { headers: { Cookie: cookie } });
    expect(await configPageRes.text()).toContain('value="stored-user"');

    const bad = await instance.app.request("/config/user", {
      method: "POST",
      body: new URLSearchParams({ ui_user: "not a login!", [CSRF_FIELD]: csrf }),
      headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookie },
    });
    expect(bad.status).toBe(400);
    expect(getSetting(instance.db, "ui.user")).toBe("stored-user");

    const clear = await instance.app.request("/config/user", {
      method: "POST",
      body: new URLSearchParams({ ui_user: "", [CSRF_FIELD]: csrf }),
      headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookie },
    });
    expect(clear.status).toBe(302);
    const home2 = await instance.app.request("/", { headers: { Cookie: cookie } });
    expect(await home2.text()).toContain(">op<");
  });

  it("env login is used until a stored one exists", async () => {
    const instance = app({ uiUser: "env-fallback" });
    const { cookie, csrf } = await authed(instance);
    await instance.app.request("/config/user", {
      method: "POST",
      body: new URLSearchParams({ ui_user: "stored-user", [CSRF_FIELD]: csrf }),
      headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookie },
    });
    const home = await instance.app.request("/", { headers: { Cookie: cookie } });
    const html = await home.text();
    expect(html).toContain("github.com/stored-user.png");
    expect(html).not.toContain("env-fallback.png");

    const page = await (await instance.app.request("/config", { headers: { Cookie: cookie } })).text();
    expect(page).toContain("saved on this page · overrides <code>ERU_UI_USER</code>");
  });
});

describe("provider keys on /config", () => {
  async function authed(instance: ReturnType<typeof app>) {
    const loggedIn = await login(instance.app);
    const token = cookieValue(cookieLine(loggedIn));
    const session = verifySession(instance.config.sessionSecret, token)!;
    return { cookie: `${SESSION_COOKIE}=${token}`, csrf: session.csrf };
  }

  it("renders the section nav and provider statuses without key material", async () => {
    const dir = mkdtempSync(join(tmpdir(), "eru-auth-"));
    const authPath = join(dir, "auth.json");
    writeFileSync(authPath, JSON.stringify({ anthropic: { type: "api", key: "sk-ant-secret9" } }));
    const instance = app({}, undefined, undefined, undefined, new ProviderCredentialStore(authPath, { OPENAI_API_KEY: "env" }));
    const { cookie } = await authed(instance);
    const res = await instance.app.request("/config", { headers: { Cookie: cookie } });
    const html = await res.text();
    expect(html).toContain('href="#providers"');
    expect(html).toContain('href="#github-app"');
    expect(html).toContain("config-stage");
    expect(html).toContain("key from env <code>OPENAI_API_KEY</code>");
    expect(html).toContain("stored in auth.json ···ret9");
    expect(html).not.toContain("sk-ant-secret9");
    expect(html).toContain(authPath);
  });

  it("saves and removes keys through POST /config/providers/:id", async () => {
    const dir = mkdtempSync(join(tmpdir(), "eru-auth-"));
    const authPath = join(dir, "auth.json");
    const instance = app({}, undefined, undefined, undefined, new ProviderCredentialStore(authPath, {}));
    const { cookie, csrf } = await authed(instance);

    const save = await instance.app.request("/config/providers/groq", {
      method: "POST",
      body: new URLSearchParams({ key: "gsk_test_key_1", [CSRF_FIELD]: csrf }),
      headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookie },
    });
    expect(save.status).toBe(302);
    expect(JSON.parse(readFileSync(authPath, "utf8")).groq.key).toBe("gsk_test_key_1");
    expect(statSync(authPath).mode & 0o777).toBe(0o600);

    const bad = await instance.app.request("/config/providers/groq", {
      method: "POST",
      body: new URLSearchParams({ key: "has space", [CSRF_FIELD]: csrf }),
      headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookie },
    });
    expect(bad.status).toBe(400);

    const badId = await instance.app.request("/config/providers/bad%20id", {
      method: "POST",
      body: new URLSearchParams({ key: "gsk_test", [CSRF_FIELD]: csrf }),
      headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookie },
    });
    expect(badId.status).toBe(400);

    const remove = await instance.app.request("/config/providers/groq/delete", {
      method: "POST",
      body: new URLSearchParams({ [CSRF_FIELD]: csrf }),
      headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookie },
    });
    expect(remove.status).toBe(302);
    expect(JSON.parse(readFileSync(authPath, "utf8")).groq).toBeUndefined();
  });
});

describe("github oauth login", () => {
  const oauthCfg = {
    oauthClientId: "gh-client-id",
    oauthClientSecret: "gh-client-secret",
    oauthAdminIds: [42],
    publicUrl: "http://eru.test",
  };
  const oauthFetchStub = (userId = 42, login = "octo-cat"): typeof fetch =>
    (async (input: unknown) => {
      const url = String(input);
      if (url.startsWith("https://github.com/login/oauth/access_token")) {
        return new Response(JSON.stringify({ access_token: "tok-1" }), { status: 200 });
      }
      if (url === "https://api.github.com/user") {
        return new Response(
          JSON.stringify({ id: userId, login, avatar_url: "https://avatars.test/u.png" }),
          { status: 200 },
        );
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

  it("redirects to GitHub, exchanges the code, and issues a session with the identity", async () => {
    const { app: instance } = app(oauthCfg, undefined, undefined, undefined, undefined, undefined, oauthFetchStub());
    const start = await instance.request("/login/github?next=/config", { redirect: "manual" });
    expect(start.status).toBe(302);
    const loc = start.headers.get("location") ?? "";
    expect(loc).toContain("https://github.com/login/oauth/authorize");
    expect(loc).toContain("client_id=gh-client-id");
    expect(loc).toContain(encodeURIComponent("http://eru.test/login/github/callback"));
    const state = new URL(loc).searchParams.get("state") ?? "";
    expect(state).not.toBe("");

    const cb = await instance.request(`/login/github/callback?state=${state}&code=abc`, { redirect: "manual" });
    expect(cb.status).toBe(302);
    expect(cb.headers.get("location")).toBe("/config");
    const cookie = (cb.headers.get("set-cookie") ?? "").split(";")[0];
    expect(cookie).toContain("eru_session=");

    const home = await instance.request("/", { headers: { cookie } });
    expect(home.status).toBe(200);
    expect(await home.text()).toContain("octo-cat");
  });

  it("denies non-allowlisted accounts and rejects replayed states", async () => {
    const { app: deniedApp } = app(oauthCfg, undefined, undefined, undefined, undefined, undefined, oauthFetchStub(7, "mallory"));
    const s0 = await deniedApp.request("/login/github", { redirect: "manual" });
    const state0 = new URL(s0.headers.get("location") ?? "").searchParams.get("state") ?? "";
    const denied = await deniedApp.request(`/login/github/callback?state=${state0}&code=abc`, { redirect: "manual" });
    expect(denied.status).toBe(403);
    expect(await denied.text()).toContain("not an operator");

    const { app: okApp } = app(oauthCfg, undefined, undefined, undefined, undefined, undefined, oauthFetchStub());
    const s1 = await okApp.request("/login/github", { redirect: "manual" });
    const state1 = new URL(s1.headers.get("location") ?? "").searchParams.get("state") ?? "";
    const ok = await okApp.request(`/login/github/callback?state=${state1}&code=abc`, { redirect: "manual" });
    expect(ok.status).toBe(302);
    const replay = await okApp.request(`/login/github/callback?state=${state1}&code=abc`, { redirect: "manual" });
    expect(replay.status).toBe(403);
  });

  it("drops the session when the id leaves the allowlist", async () => {
    const { app: instance } = app(oauthCfg, undefined, undefined, undefined, undefined, undefined, oauthFetchStub());
    const s = await instance.request("/login/github", { redirect: "manual" });
    const state = new URL(s.headers.get("location") ?? "").searchParams.get("state") ?? "";
    const cb = await instance.request(`/login/github/callback?state=${state}&code=abc`, { redirect: "manual" });
    const cookie = (cb.headers.get("set-cookie") ?? "").split(";")[0];
    expect((await instance.request("/", { headers: { cookie } })).status).toBe(200);

    const { app: shrunk } = app({ ...oauthCfg, oauthAdminIds: [99] }, undefined, undefined, undefined, undefined, undefined, oauthFetchStub());
    const res = await shrunk.request("/", { headers: { cookie }, redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/login");
  });

  it("hides the password form under OAuth unless ERU_UI_LOCAL_LOGIN is on", async () => {
    const { app: strict } = app(oauthCfg);
    const page = await strict.request("/login");
    const text = await page.text();
    expect(text).toContain("Sign in with GitHub");
    expect(text).not.toContain('name="password"');
    const refused = await login(strict);
    expect(refused.status).toBe(401);

    const { app: local } = app({ ...oauthCfg, uiLocalLogin: true });
    const page2 = await local.request("/login");
    const text2 = await page2.text();
    expect(text2).toContain("Sign in with GitHub");
    expect(text2).toContain('name="password"');
    const res = await login(local);
    expect(res.status).toBe(302);
  });

  it("keeps the gate closed when OAuth is not configured", async () => {
    const { app: instance } = app();
    const res = await instance.request("/login/github", { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/login");
  });
});
