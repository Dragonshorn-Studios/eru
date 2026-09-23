import { generateKeyPairSync, verify } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createGithubAppClient,
  decryptForgeToken,
  encryptForgeToken,
  githubAppJwt,
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

  it("decrypts with any configured key secret, so adopting a dedicated key keeps old rows readable", () => {
    const legacy = encryptForgeToken("session-secret", "ghp_old");
    const rotated = encryptForgeToken("forge-key", "ghp_new");
    expect(decryptForgeToken(["forge-key", "session-secret"], legacy)).toBe("ghp_old");
    expect(decryptForgeToken(["forge-key", "session-secret"], rotated)).toBe("ghp_new");
    expect(() => decryptForgeToken(["forge-key"], legacy)).toThrow();
    expect(() => decryptForgeToken([], legacy)).toThrow();
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
      ["owner", "."],
      ["owner", ".."],
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

describe("github app client", () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const APP_PEM = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const APP_PUB = publicKey.export({ type: "pkcs1", format: "pem" }).toString();
  const CREDS = { appId: "424242", privateKey: APP_PEM, installationId: "777" };

  function json(status: number, body: unknown): FetchLike {
    return async () => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  }

  it("signs an RS256 JWT the GitHub App can be verified with", () => {
    const now = 1_800_000_000_000;
    const jwt = githubAppJwt("424242", APP_PEM, () => now);
    const [header, payload, signature] = jwt.split(".");
    expect(JSON.parse(Buffer.from(header, "base64url").toString())).toEqual({ alg: "RS256", typ: "JWT" });
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString());
    expect(claims.iss).toBe("424242");
    expect(claims.exp - claims.iat).toBe(600);
    expect(claims.iat).toBeLessThan(now / 1000);
    expect(verify("RSA-SHA256", Buffer.from(`${header}.${payload}`), APP_PUB, Buffer.from(signature, "base64url"))).toBe(
      true,
    );
  });

  it("uses the configured installation id without a lookup, else auto-detects exactly one", async () => {
    let calls = 0;
    const spy: FetchLike = async () => {
      calls++;
      return json(200, [])(`x`, {});
    };
    const pinned = createGithubAppClient(CREDS, spy);
    const id = await pinned.installationId();
    expect(id).toEqual({ ok: true, value: "777" });
    expect(calls).toBe(0);

    const one = createGithubAppClient({ appId: "1", privateKey: APP_PEM }, json(200, [{ id: 55 }]));
    expect(await one.installationId()).toEqual({ ok: true, value: "55" });
    const none = createGithubAppClient({ appId: "1", privateKey: APP_PEM }, json(200, []));
    const noRes = await none.installationId();
    expect(!noRes.ok && noRes.error === "noinstall").toBe(true);
    const many = createGithubAppClient({ appId: "1", privateKey: APP_PEM }, json(200, [{ id: 1 }, { id: 2 }]));
    const manyRes = await many.installationId();
    expect(!manyRes.ok && manyRes.error === "ambiguous").toBe(true);
  });

  it("mints an installation token once and reuses it until it nears expiry", async () => {
    const seen: string[] = [];
    const fetchImpl: FetchLike = async (url, init) => {
      seen.push(`${init.method ?? "GET"} ${url} ${(init.headers as Record<string, string>).Authorization?.slice(0, 15)}`);
      if (url.includes("access_tokens")) {
        return json(201, { token: "ghs_installation_token", expires_at: "2030-01-01T00:00:00Z" })(url, init);
      }
      return json(200, {})(url, init);
    };
    const client = createGithubAppClient(CREDS, fetchImpl, "https://api.example.test");
    const first = await client.installationToken();
    const second = await client.installationToken();
    expect(first).toEqual({ ok: true, value: "ghs_installation_token" });
    expect(second).toEqual({ ok: true, value: "ghs_installation_token" });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain("POST https://api.example.test/app/installations/777/access_tokens");
    expect(seen[0]).toContain("Bearer eyJ"); // app JWT, not a PAT
  });

  it("maps auth failures on token mint to auth", async () => {
    const client = createGithubAppClient(CREDS, json(403, {}));
    const res = await client.installationToken();
    expect(!res.ok && res.error === "auth").toBe(true);
  });

  it("returns 'invalid' when the private key cannot sign", async () => {
    const client = createGithubAppClient({ appId: "1", privateKey: "not-a-pem" }, json(200, {}));
    const res = await client.installationToken();
    expect(!res.ok && res.error === "invalid").toBe(true);
  });

  it("lists installation repos with the minted token", async () => {
    const authSeen: string[] = [];
    const fetchImpl: FetchLike = async (url, init) => {
      authSeen.push((init.headers as Record<string, string>).Authorization ?? "none");
      if (url.includes("access_tokens")) {
        return json(201, { token: "inst-tok", expires_at: "2030-01-01T00:00:00Z" })(url, init);
      }
      return json(200, {
        total_count: 2,
        repositories: [
          { owner: { login: "acme" }, name: "box", private: true },
          { owner: { login: "acme" }, name: "cart", private: false },
        ],
      })(url, init);
    };
    const client = createGithubAppClient(CREDS, fetchImpl, "https://api.example.test");
    const repos = await client.listRepos();
    expect(repos).toEqual({
      ok: true,
      value: [
        { owner: "acme", name: "box", privateRepo: true },
        { owner: "acme", name: "cart", privateRepo: false },
      ],
    });
    expect(authSeen[1]).toBe("Bearer inst-tok");
  });

  it("treats unreachable networks as unreachable", async () => {
    const client = createGithubAppClient(CREDS, async () => {
      throw new Error("down");
    });
    const res = await client.installationToken();
    expect(!res.ok && res.error === "unreachable").toBe(true);
  });
});
