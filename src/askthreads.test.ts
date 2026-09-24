import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDb, upsertConnectedRepo, upsertPage, setLastMapped } from "./db.js";
import {
  ASK_AGENT,
  ensureWorkspace,
  getThread,
  insertThread,
  listThreads,
  materializeWorkspace,
  setThreadSession,
  sweepWorkspaces,
  threadStale,
  threadWorkspace,
} from "./askthreads.js";

const AT = "2026-01-01T00:00:00Z";

function seedRepo(db: ReturnType<typeof openDb>) {
  const repoId = upsertConnectedRepo(db, { forge: "github", owner: "acme", name: "box" }, AT);
  return repoId;
}

describe("materializeWorkspace", () => {
  it("writes a deny-by-default workspace with only the map snapshot", async () => {
    const workdir = await mkdtemp(join(tmpdir(), "eru-ask-ws-"));
    const dir = await materializeWorkspace(workdir, "thread-1", [
      { id: 1, slug: "arch", title: "Arch", body: "the body", sortOrder: 0, mappedRef: "main", updatedAt: "t" },
      { id: 2, slug: "weird slug!ok", title: "Weird", body: "w", sortOrder: 1, mappedRef: "main", updatedAt: "t" },
      { id: 3, slug: "weird slug ok", title: "Weird2", body: "w2", sortOrder: 2, mappedRef: "main", updatedAt: "t" },
    ]);

    const files = await readdir(join(dir, "map"));
    expect(files).toEqual(["arch.md", "weird-slug-ok-2.md", "weird-slug-ok.md"]);

    const arch = await readFile(join(dir, "map", "arch.md"), "utf8");
    expect(arch).toContain("slug: arch");
    expect(arch).toContain("# Arch");
    expect(arch).toContain("the body");

    const cfg = JSON.parse(await readFile(join(dir, "opencode.json"), "utf8")) as {
      permission: Record<string, string>;
      agent: Record<string, { tools: Record<string, boolean>; mode: string }>;
    };
    // Deny-by-default: only read/glob/grep survive, nothing falls through to "ask".
    expect(cfg.permission).toMatchObject({
      "*": "deny",
      read: "allow",
      glob: "allow",
      grep: "allow",
      external_directory: "deny",
    });
    expect(Object.values(cfg.permission)).not.toContain("ask");
    const agent = cfg.agent[ASK_AGENT];
    expect(agent.mode).toBe("primary");
    expect(agent.tools).toMatchObject({ "*": false, read: true, glob: true, grep: true });

    const agentsMd = await readFile(join(dir, "AGENTS.md"), "utf8");
    expect(agentsMd).toContain("./map");
    expect(agentsMd).toContain("Never repeat environment variables");
  });
});

describe("thread rows", () => {
  it("creates, lists, and marks threads stale when the map moves", () => {
    const db = openDb(":memory:");
    const repoId = seedRepo(db);
    setLastMapped(db, repoId, "aaa1111", AT);
    const a = insertThread(db, repoId, "aaa1111", AT);
    const b = insertThread(db, repoId, "aaa1111", "2026-01-01T01:00:00Z");
    setThreadSession(db, a.id, "ses-1", AT);

    expect(getThread(db, a.id)?.sessionId).toBe("ses-1");
    expect(listThreads(db, repoId).map((t) => t.id)).toEqual([b.id, a.id]);
    expect(threadStale(a, "aaa1111")).toBe(false);
    expect(threadStale(a, "bbb2222")).toBe(true);
    expect(threadStale(a, null)).toBe(true);
  });
});

describe("ensureWorkspace / sweepWorkspaces", () => {
  it("rebuilds a wiped workspace from current pages and re-points mapped_ref", async () => {
    const db = openDb(":memory:");
    const repoId = seedRepo(db);
    upsertPage(db, repoId, { slug: "arch", title: "Arch", body: "b", sortOrder: 0, mappedRef: "v2" }, AT);
    setLastMapped(db, repoId, "v2", AT);
    const thread = insertThread(db, repoId, "v1", AT);
    const workdir = await mkdtemp(join(tmpdir(), "eru-ask-ws-"));

    // Directory never materialized → ensureWorkspace builds it from the
    // current map and updates the stored ref so it isn't marked stale.
    const dir = await ensureWorkspace(db, workdir, thread, AT);
    expect(existsSync(join(dir, "map", "arch.md"))).toBe(true);
    expect(getThread(db, thread.id)?.mappedRef).toBe("v2");
  });

  it("sweeps orphan workspaces but keeps row-backed ones", async () => {
    const db = openDb(":memory:");
    const repoId = seedRepo(db);
    const workdir = await mkdtemp(join(tmpdir(), "eru-ask-ws-"));
    const thread = insertThread(db, repoId, "main", AT);
    await mkdir(threadWorkspace(workdir, thread.id), { recursive: true });
    await mkdir(join(workdir, "00000000-0000-4000-8000-000000000000"), { recursive: true });
    await mkdir(join(workdir, "not-a-uuid"), { recursive: true });

    expect(await sweepWorkspaces(db, workdir)).toBe(1);
    expect(existsSync(threadWorkspace(workdir, thread.id))).toBe(true);
    expect(existsSync(join(workdir, "00000000-0000-4000-8000-000000000000"))).toBe(false);
    expect(existsSync(join(workdir, "not-a-uuid"))).toBe(true);
  });
});
