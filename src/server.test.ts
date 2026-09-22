import { lstatSync, readFileSync, readlinkSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CSRF_FIELD, SESSION_COOKIE, verifySession } from "./auth.js";
import type { Config } from "./config.js";
import { getForgeCredential, getPrimaryRepo, openDb, upsertConnectedRepo, upsertPage, type SqliteDb } from "./db.js";
import { decryptForgeToken, forgeKeySecrets } from "./forge.js";
import { createApp } from "./server.js";
import { TOKENS } from "./theme.js";
import { ASK_STUB_MESSAGE } from "./ui.js";

function gatedConfig(overrides: Partial<Config> = {}): Config {
  return {
    host: "127.0.0.1",
    port: 3000,
    sqlitePath: ":memory:",
    uiPassword: "test-ui-password",
    sessionSecret: "test-session-secret",
    loginLimit: 5,
    loginWindowMs: 60_000,
    ...overrides,
  };
}

function app(overrides: Partial<Config> = {}, fetchImpl?: (url: string, init: RequestInit) => Promise<Response>) {
  const config = gatedConfig(overrides);
  const db = openDb(":memory:");
  return { app: createApp({ config, db, fetchImpl }), config, db };
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
    expect(body).not.toContain("Eruka");
    expect(body).not.toContain("DeepWiki");
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

  it("accepts Ask stub with CSRF and HTMX", async () => {
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
    expect(await res.text()).toContain(ASK_STUB_MESSAGE);
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

describe("durable Brief pages", () => {
  async function seed(instance: ReturnType<typeof app>, pages: { slug: string; title: string; body: string; sortOrder: number }[]) {
    const repoId = upsertConnectedRepo(
      instance.db,
      { forge: "github", owner: "acme", name: "box" },
      "2026-01-01T00:00:00Z",
    );
    for (const page of pages) {
      upsertPage(instance.db, repoId, { ...page, mappedRef: "main" }, "2026-01-01T00:00:00Z");
    }
    const loggedIn = await login(instance.app);
    const token = cookieValue(cookieLine(loggedIn));
    return `${SESSION_COOKIE}=${token}`;
  }

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

  it("404s an unknown slug when pages exist", async () => {
    const instance = app();
    const cookie = await seed(instance, PAGES);
    const res = await instance.app.request("/brief/nope", { headers: { Cookie: cookie } });
    expect(res.status).toBe(404);
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
});

describe("docs lock", () => {
  it("keeps the Liter capsule and names the skills", () => {
    const readme = readFileSync("README.md", "utf8");
    expect(readme).toContain("I'm curious about this repo.");
    expect(readme).toContain("not a checkout job, not DeepWiki.com");
    expect(readme).toContain("Never Eruka");
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
    expect(readme).toContain("CSS variables");
    expect(readme).toContain("no Tailwind pipeline");
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
