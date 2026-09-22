import { describe, expect, it } from "vitest";
import {
  decryptForgeToken,
  encryptForgeToken,
  verifyGithubRepo,
  type FetchLike,
} from "./forge.js";

const SECRET = "test-session-secret-for-forge";

function fakeFetch(status: number, body: unknown = {}): FetchLike {
  return async (_url, _init) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("forge token crypto", () => {
  it("round-trips a token through AES-256-GCM", () => {
    const enc = encryptForgeToken(SECRET, "ghp_secret-123");
    expect(enc).toMatch(/^v1\./);
    expect(enc).not.toContain("ghp_secret-123");
    expect(decryptForgeToken(SECRET, enc)).toBe("ghp_secret-123");
  });

  it("fails closed with a different secret or tampered ciphertext", () => {
    const enc = encryptForgeToken(SECRET, "ghp_secret-123");
    expect(() => decryptForgeToken("other-secret", enc)).toThrow();
    const parts = enc.split(".");
    parts[3] = parts[3].slice(0, -2) + "xx";
    expect(() => decryptForgeToken(SECRET, parts.join("."))).toThrow();
    expect(() => decryptForgeToken(SECRET, "not-a-token")).toThrow();
  });
});

describe("verifyGithubRepo", () => {
  it("rejects invalid owner/repo without hitting the network", async () => {
    const called: string[] = [];
    const spy: FetchLike = async (url) => {
      called.push(url);
      return fakeFetch(200, {}) (url, {});
    };
    for (const [owner, name] of [
      ["", "repo"],
      ["bad owner", "repo"],
      ["owner", "has space"],
      ["owner", ""],
      ["-leading", "repo"],
    ]) {
      const res = await verifyGithubRepo(owner, name, "", spy);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error).toBe("invalid");
    }
    expect(called).toHaveLength(0);
  });

  it("returns the canonical repo on 200 and checks owner/name match", async () => {
    const res = await verifyGithubRepo(
      "dragonshorn-studios",
      "ERU",
      "",
      fakeFetch(200, { owner: { login: "Dragonshorn-Studios" }, name: "eru" }),
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.repo).toEqual({ forge: "github", owner: "Dragonshorn-Studios", name: "eru" });
    }
  });

  it("fails closed when the resolved repo does not match the request", async () => {
    const res = await verifyGithubRepo(
      "owner",
      "repo",
      "",
      fakeFetch(200, { owner: { login: "someone-else" }, name: "repo" }),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe("notfound");
  });

  it("maps 404 to notfound and 401/403 to auth", async () => {
    const nf = await verifyGithubRepo("o", "r", "", fakeFetch(404));
    expect(!nf.ok && nf.error === "notfound").toBe(true);
    const auth = await verifyGithubRepo("o", "r", "", fakeFetch(403));
    expect(!auth.ok && auth.error === "auth").toBe(true);
  });

  it("treats network errors and non-2xx as unreachable", async () => {
    const net = await verifyGithubRepo("o", "r", "", async () => {
      throw new Error("boom");
    });
    expect(!net.ok && net.error === "unreachable").toBe(true);
    const bad = await verifyGithubRepo("o", "r", "", fakeFetch(500));
    expect(!bad.ok && bad.error === "unreachable").toBe(true);
  });

  it("sends the token as a Bearer header only to the API base", async () => {
    let seenAuth: string | null = null;
    let seenUrl = "";
    const spy: FetchLike = async (url, init) => {
      seenUrl = url;
      seenAuth = (init.headers as Record<string, string>).Authorization ?? null;
      return fakeFetch(200, { owner: { login: "o" }, name: "r" })(url, init);
    };
    await verifyGithubRepo("o", "r", "ghp_x", spy);
    expect(seenUrl).toBe("https://api.github.com/repos/o/r");
    expect(seenAuth).toBe("Bearer ghp_x");
  });
});
