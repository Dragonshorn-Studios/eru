import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { FetchLike } from "./forge.js";
import {
  fetchForgejoArchive,
  fetchGitlabArchive,
  forgeApiRoot,
  forgejoAddLabels,
  forgejoEnsureComment,
  forgejoGetIssue,
  forgejoRemoveLabels,
  gitlabEnsureNote,
  gitlabGetIssue,
  listForgejoRepos,
  listGitlabRepos,
  normalizeForgeOrigin,
  splitNamespace,
  validOwner,
  validRepoName,
  verifyForgejoRepo,
  verifyForgejoWebhookSignature,
  verifyGitlabRepo,
  verifyGitlabWebhookToken,
} from "./forges.js";

function jsonFetch(status: number, body: unknown = {}): FetchLike {
  return async (_url, _init) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("owner and name validation", () => {
  it("accepts GitHub-style owners and GitLab nested groups", () => {
    expect(validOwner("github", "acme")).toBe(true);
    expect(validOwner("forgejo", "acme")).toBe(true);
    expect(validOwner("forgejo", "my.org")).toBe(true);
    expect(validOwner("github", "my.org")).toBe(false);
    expect(validOwner("gitlab", "group/sub")).toBe(true);
    expect(validOwner("gitlab", "acme")).toBe(true);
    expect(validRepoName("eru")).toBe(true);
    expect(validOwner("gitlab", "group//sub")).toBe(false);
    expect(validOwner("gitlab", "/leading")).toBe(false);
    expect(validOwner("github", "group/sub")).toBe(false);
    expect(validRepoName(".")).toBe(false);
    expect(validRepoName("..")).toBe(false);
  });

  it("splits a namespace on the last slash", () => {
    expect(splitNamespace("group/sub/repo")).toEqual({ owner: "group/sub", name: "repo" });
    expect(splitNamespace("acme/box")).toEqual({ owner: "acme", name: "box" });
    expect(splitNamespace("noslash")).toBeUndefined();
    expect(splitNamespace("/trailing/")).toBeUndefined();
    expect(splitNamespace("a/")).toBeUndefined();
  });
});

describe("normalizeForgeOrigin", () => {
  it("strips API prefixes and trailing slashes", () => {
    expect(normalizeForgeOrigin("https://git.example/api/v4", "gitlab")).toBe("https://git.example");
    expect(normalizeForgeOrigin("https://git.example/gitlab/api/v4", "gitlab")).toBe("https://git.example/gitlab");
    expect(normalizeForgeOrigin("https://git.example/api/v1/", "forgejo")).toBe("https://git.example");
    expect(normalizeForgeOrigin("http://git.example", "gitlab")).toBe("http://git.example");
    expect(normalizeForgeOrigin("https://user:pass@git.example", "gitlab")).toBeUndefined();
    expect(normalizeForgeOrigin("ftp://git.example", "gitlab")).toBeUndefined();
    expect(normalizeForgeOrigin("not a url", "gitlab")).toBeUndefined();
  });

  it("builds API roots", () => {
    expect(forgeApiRoot("https://git.example", "gitlab")).toBe("https://git.example/api/v4");
    expect(forgeApiRoot("https://git.example/", "forgejo")).toBe("https://git.example/api/v1");
  });
});

describe("verify gitlab / forgejo repos", () => {
  it("rejects invalid owner/name without hitting the network", async () => {
    const called: string[] = [];
    const spy: FetchLike = async (url) => {
      called.push(url);
      return jsonFetch(200)(url, {});
    };
    expect((await verifyGitlabRepo("https://git.example", "bad owner", "repo", "tok", spy)).ok).toBe(false);
    expect((await verifyForgejoRepo("https://git.example", "owner", ".", "tok", spy)).ok).toBe(false);
    expect(called).toHaveLength(0);
  });

  it("verifies GitLab via path_with_namespace and PRIVATE-TOKEN", async () => {
    let seenAuth: string | null = null;
    let seenUrl = "";
    const spy: FetchLike = async (url, init) => {
      seenUrl = url;
      seenAuth = (init.headers as Record<string, string>)["PRIVATE-TOKEN"] ?? null;
      return jsonFetch(200, {
        path_with_namespace: "group/sub/box",
        default_branch: "trunk",
      })(url, init);
    };
    const res = await verifyGitlabRepo("https://git.example", "group/sub", "box", "glpat-x", spy);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.repo).toEqual({
        forge: "gitlab",
        owner: "group/sub",
        name: "box",
        defaultBranch: "trunk",
        origin: "https://git.example",
      });
    }
    expect(seenUrl).toBe("https://git.example/api/v4/projects/group%2Fsub%2Fbox");
    expect(seenAuth).toBe("glpat-x");
  });

  it("verifies Forgejo via owner login and token header", async () => {
    let seenAuth: string | null = null;
    const spy: FetchLike = async (url, init) => {
      seenAuth = (init.headers as Record<string, string>).Authorization ?? null;
      return jsonFetch(200, {
        owner: { login: "Acme" },
        name: "box",
        default_branch: "main",
      })(url, init);
    };
    const res = await verifyForgejoRepo("https://git.example", "acme", "box", "tok", spy);
    expect(res.ok).toBe(true);
    if (res.ok)
      expect(res.repo).toEqual({
        forge: "forgejo",
        owner: "Acme",
        name: "box",
        defaultBranch: "main",
        origin: "https://git.example",
      });
    expect(seenAuth).toBe("token tok");
  });

  it("maps 404 to notfound and 401 to auth", async () => {
    const nf = await verifyGitlabRepo("https://git.example", "o", "r", "t", jsonFetch(404));
    expect(!nf.ok && nf.error === "notfound").toBe(true);
    const auth = await verifyForgejoRepo("https://git.example", "o", "r", "t", jsonFetch(403));
    expect(!auth.ok && auth.error === "auth").toBe(true);
  });
});

describe("list instance repos", () => {
  it("pages GitLab membership projects", async () => {
    const spy: FetchLike = async (url) => {
      const page = new URL(url).searchParams.get("page");
      if (page === "1") {
        return jsonFetch(200, [{ path_with_namespace: "acme/box", visibility: "private", default_branch: "main" }])(
          url,
          {},
        );
      }
      return jsonFetch(200, [])(url, {});
    };
    const res = await listGitlabRepos("https://git.example", "tok", spy);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.repos).toEqual([{ owner: "acme", name: "box", privateRepo: true, defaultBranch: "main" }]);
    }
  });

  it("pages Forgejo user repos", async () => {
    const spy: FetchLike = async () =>
      jsonFetch(200, [{ owner: { username: "acme" }, name: "box", private: false, default_branch: "dev" }])("", {});
    const res = await listForgejoRepos("https://git.example", "tok", spy);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.repos).toEqual([{ owner: "acme", name: "box", privateRepo: false, defaultBranch: "dev" }]);
    }
  });

  it("maps 401 to auth", async () => {
    const gitlab = await listGitlabRepos("https://git.example", "tok", jsonFetch(401));
    expect(!gitlab.ok && gitlab.error === "auth").toBe(true);
    const forgejo = await listForgejoRepos("https://git.example", "tok", jsonFetch(401));
    expect(!forgejo.ok && forgejo.error === "auth").toBe(true);
  });
});

describe("archives", () => {
  it("fetches GitLab archive.tar.gz by sha", async () => {
    let seen = "";
    const spy: FetchLike = async (url) => {
      seen = url;
      return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    };
    const res = await fetchGitlabArchive("https://git.example", "acme", "box", "main", "tok", spy);
    expect(res.ok).toBe(true);
    expect(seen).toBe("https://git.example/api/v4/projects/acme%2Fbox/repository/archive.tar.gz?sha=main");
  });

  it("keeps slashes in Forgejo archive refs", async () => {
    let seen = "";
    const spy: FetchLike = async (url) => {
      seen = url;
      return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    };
    const res = await fetchForgejoArchive("https://git.example", "acme", "box", "feature/x", "tok", spy);
    expect(res.ok).toBe(true);
    expect(seen).toBe("https://git.example/api/v1/repos/acme/box/archive/feature/x.tar.gz");
  });
});

describe("webhook auth", () => {
  it("compares GitLab tokens in constant time", () => {
    expect(verifyGitlabWebhookToken("secret-secret-16+", "secret-secret-16+")).toBe(true);
    expect(verifyGitlabWebhookToken("secret-secret-16+", "other-secret-16++")).toBe(false);
    expect(verifyGitlabWebhookToken("secret-secret-16+", undefined)).toBe(false);
    expect(verifyGitlabWebhookToken("secret-secret-16+", "short")).toBe(false);
  });

  it("accepts Forgejo HMAC with or without a sha256= prefix", () => {
    const body = '{"action":"opened"}';
    const hex = createHmac("sha256", "webhook-secret-16+").update(body).digest("hex");
    expect(verifyForgejoWebhookSignature("webhook-secret-16+", body, hex)).toBe(true);
    expect(verifyForgejoWebhookSignature("webhook-secret-16+", body, `sha256=${hex}`)).toBe(true);
    expect(verifyForgejoWebhookSignature("webhook-secret-16+", body, "deadbeef")).toBe(false);
    expect(verifyForgejoWebhookSignature("webhook-secret-16+", body, undefined)).toBe(false);
  });
});

describe("issue writes", () => {
  it("reads a GitLab description as the issue body", async () => {
    const res = await gitlabGetIssue(
      "https://git.example",
      "tok",
      "acme",
      "box",
      12,
      jsonFetch(200, { title: "Lamp", description: "out" }),
    );
    expect(res).toEqual({ title: "Lamp", body: "out" });
  });

  it("reads a Forgejo body field", async () => {
    const res = await forgejoGetIssue(
      "https://git.example",
      "tok",
      "acme",
      "box",
      12,
      jsonFetch(200, { title: "Lamp", body: "out" }),
    );
    expect(res).toEqual({ title: "Lamp", body: "out" });
  });

  it("adds Forgejo labels by numeric id", async () => {
    const calls: { method: string; url: string; body: unknown }[] = [];
    const spy: FetchLike = async (url, init) => {
      const method = (init?.method ?? "GET").toUpperCase();
      let parsed: unknown;
      if (typeof init?.body === "string" && init.body) parsed = JSON.parse(init.body);
      calls.push({ method, url, body: parsed });
      if (url.includes("/labels") && !url.includes("/issues/") && method === "GET") {
        return jsonFetch(200, [])(url, init ?? {});
      }
      if (url.includes("/labels") && !url.includes("/issues/") && method === "POST") {
        const name = (parsed as { name?: string }).name ?? "x";
        return jsonFetch(201, { id: name === "eru:refined" ? 11 : 12, name })(url, init ?? {});
      }
      if (url.includes("/issues/12/labels") && method === "POST") {
        return jsonFetch(200, [])(url, init ?? {});
      }
      return jsonFetch(404)(url, init ?? {});
    };
    await forgejoAddLabels("https://git.example", "tok", "acme", "box", 12, ["eru:refined", "agent-ready"], spy);
    const create = calls.filter((c) => c.method === "POST" && c.url.endsWith("/labels") && !c.url.includes("/issues/"));
    expect(create).toHaveLength(2);
    expect((create[0].body as { color: string }).color).toBe("a8b99a");
    const attach = calls.find((c) => c.method === "POST" && c.url.includes("/issues/12/labels"));
    expect(attach?.body).toEqual({ labels: [11, 12] });
  });

  it("pages GitLab notes before posting so a later-page bot comment is not duplicated", async () => {
    const calls: { method: string; url: string }[] = [];
    const spy: FetchLike = async (url, init) => {
      const method = (init?.method ?? "GET").toUpperCase();
      calls.push({ method, url });
      if (url.includes("/notes") && method === "GET") {
        const page = new URL(url).searchParams.get("page");
        if (page === "1") {
          return jsonFetch(
            200,
            Array.from({ length: 100 }, (_, i) => ({ body: `old-${i}` })),
          )(url, init ?? {});
        }
        return jsonFetch(200, [{ body: "bot already said this" }])(url, init ?? {});
      }
      return jsonFetch(201, { id: 1 })(url, init ?? {});
    };
    await gitlabEnsureNote("https://git.example", "tok", "acme", "box", 12, "bot already said this", spy);
    expect(calls.some((c) => c.method === "POST")).toBe(false);
    expect(calls.filter((c) => c.method === "GET")).toHaveLength(2);
  });

  it("pages Forgejo comments before posting", async () => {
    const calls: { method: string; url: string }[] = [];
    const spy: FetchLike = async (url, init) => {
      const method = (init?.method ?? "GET").toUpperCase();
      calls.push({ method, url });
      if (url.includes("/comments") && method === "GET") {
        const page = new URL(url).searchParams.get("page");
        if (page === "1") {
          return jsonFetch(
            200,
            Array.from({ length: 50 }, (_, i) => ({ body: `old-${i}` })),
          )(url, init ?? {});
        }
        return jsonFetch(200, [{ body: "done" }])(url, init ?? {});
      }
      return jsonFetch(201, { id: 1 })(url, init ?? {});
    };
    await forgejoEnsureComment("https://git.example", "tok", "acme", "box", 12, "done", spy);
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });
});

describe("forgejo label cleanup", () => {
  it("deletes an Eru label that sits past the first page", async () => {
    const deleted: string[] = [];
    const fetchImpl: FetchLike = async (url, init) => {
      const method = (init?.method ?? "GET").toUpperCase();
      const parsed = new URL(url);
      if (parsed.pathname.endsWith("/labels") && method === "GET") {
        const page = parsed.searchParams.get("page");
        if (page === "2") {
          return new Response(JSON.stringify([{ id: 99, name: "eru:refined" }]), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response(JSON.stringify(Array.from({ length: 50 }, (_, i) => ({ id: i + 1, name: `other-${i}` }))), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (method === "DELETE" && parsed.pathname.includes("/labels/")) {
        deleted.push(parsed.pathname);
        return new Response(null, { status: 204 });
      }
      return new Response("no", { status: 404 });
    };
    await forgejoRemoveLabels("https://git.example", "tok", "acme", "box", 12, ["eru:refined"], fetchImpl);
    expect(deleted).toHaveLength(1);
    expect(deleted[0]).toContain("/issues/12/labels/99");
  });
});
