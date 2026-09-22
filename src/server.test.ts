import { lstatSync, readFileSync, readlinkSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CSRF_FIELD, SESSION_COOKIE, verifySession } from "./auth.js";
import type { Config } from "./config.js";
import { openDb } from "./db.js";
import { createApp } from "./server.js";
import { TOKENS } from "./theme.js";
import { ASK_STUB_MESSAGE, DEFAULT_CHROME } from "./ui.js";

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

function app(overrides: Partial<Config> = {}) {
  const config = gatedConfig(overrides);
  return { app: createApp({ config, db: openDb(":memory:") }), config };
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
    expect(body).toContain(`last mapped @${DEFAULT_CHROME.lastMappedRef}`);
    expect(body).toContain(`${DEFAULT_CHROME.owner} / ${DEFAULT_CHROME.name}`);
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
