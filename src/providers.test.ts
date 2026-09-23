import { chmodSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { opencodeAuthPath, ProviderCredentialStore } from "./providers.js";

function authDir() {
  const dir = mkdtempSync(join(tmpdir(), "eru-auth-"));
  return join(dir, "auth.json");
}

function store(path: string, env: NodeJS.ProcessEnv = {}) {
  return new ProviderCredentialStore(path, env);
}

describe("ProviderCredentialStore", () => {
  it("reports none/environment/stored and keeps unknown stored providers visible", () => {
    const path = authDir();
    writeFileSync(path, JSON.stringify({ anthropic: { type: "api", key: "sk-ant-1234" }, "my-custom": { type: "api", key: "abcd5678" }, openai: { type: "oauth", refresh: "r" } }));
    const statuses = store(path, { OPENAI_API_KEY: "env-key" }).list();
    const byId = new Map(statuses.map((s) => [s.id, s]));
    expect(byId.get("anthropic")?.source).toBe("stored");
    expect(byId.get("anthropic")?.fingerprint).toBe("1234");
    expect(byId.get("openai")?.source).toBe("environment");
    expect(byId.get("openai")?.envVar).toBe("OPENAI_API_KEY");
    expect(byId.get("groq")?.source).toBe("none");
    expect(byId.get("opencode-go")?.label).toBe("OpenCode Go");
    expect(byId.get("opencode-go")?.source).toBe("none");
    expect(byId.get("my-custom")?.source).toBe("stored");
    expect(byId.get("my-custom")?.label).toBe("my-custom");
  });

  it("writes api-key entries atomically at 0600 and preserves OAuth entries", () => {
    const path = authDir();
    writeFileSync(path, JSON.stringify({ openai: { type: "oauth", refresh: "keep-me" } }));
    const s = store(path);
    expect(s.set("anthropic", "sk-ant-secret")).toEqual({ ok: true });
    const auth = JSON.parse(readFileSync(path, "utf8"));
    expect(auth.anthropic).toEqual({ type: "api", key: "sk-ant-secret" });
    expect(auth.openai).toEqual({ type: "oauth", refresh: "keep-me" });
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("a stored key overrides the env var of the same provider", () => {
    const path = authDir();
    const s = store(path, { GROQ_API_KEY: "gsk_env" });
    expect(s.set("groq", "gsk_stored")).toEqual({ ok: true });
    const groq = s.list().find((p) => p.id === "groq")!;
    expect(groq.source).toBe("stored");
    expect(groq.overridesEnvVar).toBe("GROQ_API_KEY");
  });

  it("creates the directory tree when writing a fresh auth.json", () => {
    const base = mkdtempSync(join(tmpdir(), "eru-auth-"));
    const path = join(base, "deep", "opencode", "auth.json");
    expect(store(path).set("groq", "gsk_1234")).toEqual({ ok: true });
    expect(JSON.parse(readFileSync(path, "utf8")).groq.key).toBe("gsk_1234");
  });

  it("rejects malformed auth.json instead of discarding it", () => {
    const path = authDir();
    writeFileSync(path, "{ not json");
    const s = store(path);
    expect(s.set("groq", "gsk_1234")).toMatchObject({ ok: false });
    expect(s.delete("groq")).toMatchObject({ ok: false });
    expect(readFileSync(path, "utf8")).toBe("{ not json");
  });

  it("validates provider id and key before writing", () => {
    const s = store(authDir());
    expect(s.set("bad id!", "key")).toMatchObject({ ok: false });
    expect(s.set("anthropic", "  ")).toMatchObject({ ok: false });
    expect(s.set("anthropic", "has space")).toMatchObject({ ok: false });
  });

  it("deletes only the named entry and reports removal", () => {
    const path = authDir();
    writeFileSync(path, JSON.stringify({ anthropic: { type: "api", key: "k1234" }, groq: { type: "api", key: "g5678" } }));
    const s = store(path);
    expect(s.delete("anthropic")).toEqual({ ok: true, removed: true });
    expect(s.delete("anthropic")).toEqual({ ok: true, removed: false });
    expect(JSON.parse(readFileSync(path, "utf8")).groq.key).toBe("g5678");
  });
});

describe("opencodeAuthPath", () => {
  it("honors XDG_DATA_HOME and falls back to ~/.local/share", () => {
    expect(opencodeAuthPath({ XDG_DATA_HOME: "/data/xdg" })).toBe(join("/data/xdg", "opencode", "auth.json"));
    expect(opencodeAuthPath({ HOME: "/home/op" })).toBe(join("/home/op", ".local", "share", "opencode", "auth.json"));
  });
});
