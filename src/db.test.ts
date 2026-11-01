import Database from "better-sqlite3";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  claimDueIssueRefineJob,
  deleteForgeCredential,
  deleteSetting,
  deleteStalePages,
  completeIssueRefineJob,
  enqueueIssueRefineJob,
  enqueueOrRestartIssueRefineJob,
  requeueWebhookLogsForJob,
  restartIssueRefineJob,
  listIssueRefineJobsForRepo,
  getForgeCredential,
  getIssueRefineJob,
  getPage,
  findConnectedRepo,
  getPrimaryRepo,
  getRepo,
  getSetting,
  getWebhookLog,
  insertWebhookLog,
  listWebhookLogs,
  queueWebhookLog,
  WEBHOOK_LOG_KEEP,
  WEBHOOK_REJECTED_KEEP,
  listPages,
  migrate,
  openDb,
  recoverIssueRefineJobs,
  setForgeCredential,
  setSetting,
  upsertConnectedRepo,
  upsertPage,
} from "./db.js";

describe("sqlite stub schema", () => {
  it("migrates repos and pages on a fresh file", () => {
    const dir = mkdtempSync(join(tmpdir(), "eru-"));
    const db = openDb(join(dir, "eru.sqlite"));
    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`)
      .all() as { name: string }[];
    const names = tables.map((row) => row.name);
    expect(names).toContain("repos");
    expect(names).toContain("pages");
    expect(names).toContain("forge_credentials");
    expect(names).toContain("schema_migrations");
    expect(names).toContain("issue_refine_jobs");
    expect(names).not.toContain("github_webhook_deliveries");
    expect(getPrimaryRepo(db)).toBeUndefined();
    db.exec(
      `INSERT INTO repos (forge, owner, name, last_mapped_ref, created_at) VALUES ('github', 'acme', 'box', 'main', datetime('now'))`,
    );
    expect(getPrimaryRepo(db)).toMatchObject({ owner: "acme", name: "box", lastMappedRef: "main" });
    db.exec(`INSERT INTO pages (repo_id, slug, title, body, sort_order, updated_at) VALUES (1, 'architecture', 'Architecture', '', 0, datetime('now'))`);
    const count = db.prepare(`SELECT COUNT(*) AS n FROM pages`).get() as { n: number };
    expect(count.n).toBe(1);
    db.close();
    const again = openDb(join(dir, "eru.sqlite"));
    const migrations = again.prepare(`SELECT COUNT(*) AS n FROM schema_migrations`).get() as { n: number };
    expect(migrations.n).toBe(14);
    again.close();
  });

  it("upgrades a legacy 0001-only database with migration 0002", () => {
    const legacy = new Database(":memory:");
    legacy.exec(`
      CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL);
      CREATE TABLE repos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        forge TEXT NOT NULL DEFAULT 'github',
        owner TEXT NOT NULL,
        name TEXT NOT NULL,
        last_mapped_ref TEXT,
        last_mapped_at TEXT,
        created_at TEXT NOT NULL,
        UNIQUE (forge, owner, name)
      );
      CREATE TABLE pages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        repo_id INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
        slug TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL DEFAULT '',
        sort_order INTEGER NOT NULL DEFAULT 0,
        mapped_ref TEXT,
        updated_at TEXT NOT NULL,
        UNIQUE (repo_id, slug)
      );
      INSERT INTO schema_migrations (name, applied_at) VALUES ('0001_init.sql', '2020-01-01T00:00:00Z');
      INSERT INTO repos (forge, owner, name, last_mapped_ref, created_at)
        VALUES ('github', 'legacy', 'repo', 'main', '2020-01-01T00:00:00Z');
    `);

    migrate(legacy);

    const columns = legacy.prepare(`PRAGMA table_info(repos)`).all() as { name: string }[];
    expect(columns.some((col) => col.name === "connected_at")).toBe(true);
    const tables = legacy.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as { name: string }[];
    expect(tables.map((t) => t.name)).toContain("forge_credentials");
    expect(tables.map((t) => t.name)).toContain("settings");
    expect(tables.map((t) => t.name)).toContain("issue_refine_jobs");
    expect(tables.map((t) => t.name)).not.toContain("github_webhook_deliveries");
    expect(getPrimaryRepo(legacy)).toMatchObject({ owner: "legacy", name: "repo", lastMappedRef: "main" });
    const migrations = legacy.prepare(`SELECT COUNT(*) AS n FROM schema_migrations`).get() as { n: number };
    expect(migrations.n).toBe(14);

    // The legacy row is primary while it is the only row; a new connect
    // displaces it (NULL connected_at sorts last under DESC).
    upsertConnectedRepo(legacy, { forge: "github", owner: "acme", name: "box" }, "2026-01-01T00:00:00Z");
    expect(getPrimaryRepo(legacy)!.name).toBe("box");

    migrate(legacy);
    const after = legacy.prepare(`SELECT COUNT(*) AS n FROM schema_migrations`).get() as { n: number };
    expect(after.n).toBe(14);
    legacy.close();
  });
});

describe("forge connect storage", () => {
  it("orders the primary repo by most recent connect and stores credentials per repo", () => {
    const db = openDb(":memory:");
    const a = upsertConnectedRepo(db, { forge: "github", owner: "acme", name: "box" }, "2026-01-01T00:00:00Z");
    const b = upsertConnectedRepo(db, { forge: "github", owner: "acme", name: "cart" }, "2026-01-02T00:00:00Z");
    expect(getPrimaryRepo(db)!.name).toBe("cart");

    setForgeCredential(db, a, "enc-a", "2026-01-01T00:00:00Z");
    setForgeCredential(db, b, "enc-b", "2026-01-02T00:00:00Z");
    expect(getForgeCredential(db, a)).toBe("enc-a");
    expect(getForgeCredential(db, b)).toBe("enc-b");

    setForgeCredential(db, b, "enc-b2", "2026-01-03T00:00:00Z");
    expect(getForgeCredential(db, b)).toBe("enc-b2");
    deleteForgeCredential(db, b);
    expect(getForgeCredential(db, b)).toBeUndefined();

    // Re-connecting an existing repo bumps it to primary without duplicating the row.
    upsertConnectedRepo(db, { forge: "github", owner: "acme", name: "box" }, "2026-02-01T00:00:00Z");
    expect(getPrimaryRepo(db)!.name).toBe("box");
    const count = db.prepare(`SELECT COUNT(*) AS n FROM repos`).get() as { n: number };
    expect(count.n).toBe(2);
    db.close();
  });

  it("finds a connected repo by forge identity, case-insensitive owner/name", () => {
    const db = openDb(":memory:");
    upsertConnectedRepo(db, { forge: "github", owner: "Acme", name: "Box" }, "2026-01-01T00:00:00Z");
    upsertConnectedRepo(
      db,
      { forge: "gitlab", owner: "acme", name: "box", origin: "https://git.example" },
      "2026-01-01T00:00:00Z",
      "instance",
    );
    expect(findConnectedRepo(db, { forge: "github", owner: "acme", name: "box" })?.name).toBe("Box");
    expect(findConnectedRepo(db, { forge: "github", owner: "ACME", name: "BOX" })?.owner).toBe("Acme");
    expect(findConnectedRepo(db, { forge: "github", owner: "acme", name: "cart" })).toBeUndefined();
    expect(findConnectedRepo(db, { forge: "gitlab", owner: "acme", name: "box" })).toBeUndefined();
    expect(
      findConnectedRepo(db, { forge: "gitlab", owner: "acme", name: "box", origin: "https://git.example" })?.forge,
    ).toBe("gitlab");
    db.close();
  });

  it("stores operator settings as plain key/value rows", () => {
    const db = openDb(":memory:");
    expect(getSetting(db, "opencode.ask_model")).toBeUndefined();
    setSetting(db, "opencode.ask_model", "a/b", "2026-01-01T00:00:00Z");
    expect(getSetting(db, "opencode.ask_model")).toBe("a/b");
    setSetting(db, "opencode.ask_model", "c/d", "2026-01-02T00:00:00Z");
    expect(getSetting(db, "opencode.ask_model")).toBe("c/d");
    deleteSetting(db, "opencode.ask_model");
    expect(getSetting(db, "opencode.ask_model")).toBeUndefined();
    db.close();
  });

  it("lists and upserts durable map pages scoped to a repo", () => {
    const db = openDb(":memory:");
    const repoA = upsertConnectedRepo(db, { forge: "github", owner: "acme", name: "box" }, "2026-01-01T00:00:00Z");
    const repoB = upsertConnectedRepo(db, { forge: "github", owner: "acme", name: "cart" }, "2026-01-02T00:00:00Z");

    upsertPage(db, repoA, { slug: "auth", title: "Auth", body: "auth body", sortOrder: 2, mappedRef: "main" }, "t");
    upsertPage(db, repoA, { slug: "arch", title: "Architecture", body: "arch body", sortOrder: 1 }, "t");
    upsertPage(db, repoB, { slug: "other", title: "Other", body: "", sortOrder: 0 }, "t");

    expect(listPages(db, repoA)).toEqual([
      { slug: "arch", title: "Architecture" },
      { slug: "auth", title: "Auth" },
    ]);
    expect(listPages(db, repoB)).toHaveLength(1);

    const page = getPage(db, repoA, "auth")!;
    expect(page.body).toBe("auth body");
    expect(page.mappedRef).toBe("main");
    expect(getPage(db, repoB, "auth")).toBeUndefined();

    upsertPage(db, repoA, { slug: "auth", title: "Auth v2", body: "new", sortOrder: 2 }, "t2");
    expect(getPage(db, repoA, "auth")!.title).toBe("Auth v2");
    expect(listPages(db, repoA)).toHaveLength(2);
    db.close();
  });

  it("deleteStalePages removes slugs the scan dropped, scoped to the repo", () => {
    const db = openDb(":memory:");
    const repoA = upsertConnectedRepo(db, { forge: "github", owner: "acme", name: "box" }, "2026-01-01T00:00:00Z");
    const repoB = upsertConnectedRepo(db, { forge: "github", owner: "acme", name: "cart" }, "2026-01-02T00:00:00Z");
    upsertPage(db, repoA, { slug: "keep", title: "Keep", body: "b", sortOrder: 0 }, "t");
    upsertPage(db, repoA, { slug: "stale", title: "Stale", body: "b", sortOrder: 1 }, "t");
    upsertPage(db, repoB, { slug: "stale", title: "Stale", body: "b", sortOrder: 0 }, "t");

    deleteStalePages(db, repoA, ["keep"]);
    expect(listPages(db, repoA).map((p) => p.slug)).toEqual(["keep"]);
    // Same slug under another repo is untouched.
    expect(listPages(db, repoB).map((p) => p.slug)).toEqual(["stale"]);

    // An empty keep-set never wipes the map.
    deleteStalePages(db, repoA, []);
    expect(listPages(db, repoA)).toHaveLength(1);
    db.close();
  });

  it("drops credentials when a repo row is deleted", () => {
    const db = openDb(":memory:");
    const id = upsertConnectedRepo(db, { forge: "github", owner: "acme", name: "box" }, "2026-01-01T00:00:00Z");
    setForgeCredential(db, id, "enc", "2026-01-01T00:00:00Z");
    db.prepare(`DELETE FROM repos WHERE id = ?`).run(id);
    expect(getForgeCredential(db, id)).toBeUndefined();
    db.close();
  });
});

describe("repo auth source and page mapped_ref", () => {
  it("defaults auth_source to manual and flips to app on app connect", () => {
    const db = openDb(":memory:");
    const manual = upsertConnectedRepo(db, { forge: "github", owner: "acme", name: "box" }, "2026-01-01T00:00:00Z");
    expect(getPrimaryRepo(db)!.authSource).toBe("manual");

    const appId = upsertConnectedRepo(db, { forge: "github", owner: "acme", name: "cart" }, "2026-01-02T00:00:00Z", "app");
    expect(getPrimaryRepo(db)!.authSource).toBe("app");

    const instanceId = upsertConnectedRepo(
      db,
      { forge: "gitlab", owner: "acme", name: "box" },
      "2026-01-04T00:00:00Z",
      "instance",
    );
    expect(getRepo(db, instanceId)!.authSource).toBe("instance");
    expect(getRepo(db, instanceId)!.forge).toBe("gitlab");
    expect(getRepo(db, instanceId)!.origin).toBe("");

    // Reconnecting the same GitHub repo manually flips it back.
    upsertConnectedRepo(db, { forge: "github", owner: "acme", name: "cart" }, "2026-01-05T00:00:00Z");
    expect(getRepo(db, appId)!.authSource).toBe("manual");
    expect(getPrimaryRepo(db)!.authSource).toBe("manual");
    expect(manual).not.toBe(appId);
    db.close();
  });

  it("keeps the stored mapped_ref when an update omits it, on the same row", () => {
    const db = openDb(":memory:");
    const repo = upsertConnectedRepo(db, { forge: "github", owner: "acme", name: "box" }, "t0");
    const first = upsertPage(db, repo, { slug: "arch", title: "Arch", body: "v1", sortOrder: 0, mappedRef: "main" }, "t1");
    const second = upsertPage(db, repo, { slug: "arch", title: "Arch v2", body: "v2", sortOrder: 0 }, "t2");
    expect(second).toBe(first);
    const page = getPage(db, repo, "arch")!;
    expect(page.mappedRef).toBe("main");
    expect(page.body).toBe("v2");
    db.close();
  });
});

describe("issue refine jobs", () => {
  const job = {
    installationId: "555",
    owner: "acme",
    name: "box",
    issueNumber: 12,
    title: "The lights flicker",
    body: "hello",
  };

  it("dedupes on owner/name/issue_number and increments attempts on claim", () => {
    const db = openDb(":memory:");
    const at = "2026-01-01T00:00:00Z";
    const first = enqueueIssueRefineJob(db, job, at);
    const second = enqueueIssueRefineJob(db, { ...job, title: "other" }, at);
    expect(first).toBeDefined();
    expect(second).toBeUndefined();
    expect(getIssueRefineJob(db, first!)!.attempts).toBe(0);

    const claimed = claimDueIssueRefineJob(db, at);
    expect(claimed?.id).toBe(first);
    expect(claimed?.attempts).toBe(1);
    expect(getIssueRefineJob(db, first!)!.attempts).toBe(1);

    recoverIssueRefineJobs(db, at);
    expect(getIssueRefineJob(db, first!)!.status).toBe("pending");
    expect(getIssueRefineJob(db, first!)!.attempts).toBe(1);
    expect(claimDueIssueRefineJob(db, at)?.attempts).toBe(2);
    db.close();
  });

  it("allows the same issue number on different forges", () => {
    const db = openDb(":memory:");
    const at = "2026-01-01T00:00:00Z";
    const github = enqueueIssueRefineJob(db, { ...job, forge: "github" }, at);
    const gitlab = enqueueIssueRefineJob(db, { ...job, forge: "gitlab" }, at);
    expect(github).toBeDefined();
    expect(gitlab).toBeDefined();
    expect(github).not.toBe(gitlab);
    expect(getIssueRefineJob(db, gitlab!)!.forge).toBe("gitlab");
    db.close();
  });

  it("keeps a refinement story and lists catches for the matching repo only", () => {
    const db = openDb(":memory:");
    const at = "2026-01-01T00:00:00Z";
    const github = enqueueIssueRefineJob(db, { ...job, origin: "" }, at)!;
    const cased = enqueueIssueRefineJob(db, { ...job, owner: "ACME", name: "BOX", issueNumber: 13 }, at)!;
    const gitlab = enqueueIssueRefineJob(
      db,
      { ...job, forge: "gitlab", origin: "https://git.example", issueNumber: 12 },
      at,
    )!;
    completeIssueRefineJob(db, github, at, {
      outcome: "agent-ready",
      refined: "## Problem\nThe lamp.",
      why: "Open questions was empty, so Eru marked this agent-ready.",
    });
    const stored = getIssueRefineJob(db, github)!;
    expect(stored.outcome).toBe("agent-ready");
    expect(stored.refined).toContain("The lamp.");
    expect(stored.why).toContain("agent-ready");
    expect(stored.note).toBeNull();

    const githubHits = listIssueRefineJobsForRepo(db, { forge: "github", owner: "acme", name: "box", origin: "" });
    expect(githubHits.map((row) => row.id)).toEqual([cased, github]);
    const gitlabHits = listIssueRefineJobsForRepo(db, {
      forge: "gitlab",
      owner: "acme",
      name: "box",
      origin: "https://git.example",
    });
    expect(gitlabHits.map((row) => row.id)).toEqual([gitlab]);
    expect(
      listIssueRefineJobsForRepo(db, {
        forge: "gitlab",
        owner: "acme",
        name: "box",
        origin: "https://other.example",
      }),
    ).toEqual([]);
    db.close();
  });

  it("adds forge to a pre-0008 issue_refine_jobs table", () => {
    const legacy = new Database(":memory:");
    legacy.pragma("foreign_keys = ON");
    legacy.exec(`
      CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL);
      CREATE TABLE repos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        forge TEXT NOT NULL DEFAULT 'github',
        owner TEXT NOT NULL,
        name TEXT NOT NULL,
        auth_source TEXT NOT NULL DEFAULT 'manual',
        default_branch TEXT,
        last_mapped_ref TEXT,
        last_mapped_at TEXT,
        connected_at TEXT,
        created_at TEXT NOT NULL,
        UNIQUE (forge, owner, name)
      );
      CREATE TABLE pages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        repo_id INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
        slug TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL DEFAULT '',
        sort_order INTEGER NOT NULL DEFAULT 0,
        mapped_ref TEXT,
        updated_at TEXT NOT NULL,
        UNIQUE (repo_id, slug)
      );
      CREATE TABLE forge_credentials (
        repo_id INTEGER PRIMARY KEY REFERENCES repos(id) ON DELETE CASCADE,
        token_enc TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE ask_threads (
        id TEXT PRIMARY KEY,
        repo_id INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
        session_id TEXT,
        title TEXT NOT NULL DEFAULT '',
        mapped_ref TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE issue_refine_jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        installation_id TEXT NOT NULL,
        owner TEXT NOT NULL,
        name TEXT NOT NULL,
        issue_number INTEGER NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        status TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        run_after TEXT NOT NULL,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (owner, name, issue_number)
      );
      INSERT INTO issue_refine_jobs (
        installation_id, owner, name, issue_number, title, body, status, attempts,
        run_after, created_at, updated_at
      ) VALUES ('555', 'acme', 'box', 12, 't', 'b', 'pending', 0, 't', 't', 't');
    `);
    for (const name of [
      "0001_init.sql",
      "0002_forge_connect.sql",
      "0003_settings.sql",
      "0004_auth_source.sql",
      "0005_default_branch.sql",
      "0006_ask_threads.sql",
      "0007_issue_bot.sql",
    ]) {
      legacy.prepare(`INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)`).run(name, "t");
    }
    migrate(legacy);
    const columns = legacy.prepare(`PRAGMA table_info(issue_refine_jobs)`).all() as { name: string }[];
    expect(columns.some((col) => col.name === "forge")).toBe(true);
    const row = legacy.prepare(`SELECT forge, owner FROM issue_refine_jobs`).get() as { forge: string; owner: string };
    expect(row).toEqual({ forge: "github", owner: "acme" });
    legacy.close();
  });

  it("keeps GitLab/Forgejo hosts distinct by origin after 0009", () => {
    const db = openDb(":memory:");
    const hostA = upsertConnectedRepo(
      db,
      { forge: "gitlab", owner: "acme", name: "box", origin: "https://git.a.example" },
      "2026-01-01T00:00:00Z",
      "instance",
    );
    upsertPage(db, hostA, { slug: "arch", title: "A", body: "from A", sortOrder: 0 }, "t");
    const hostB = upsertConnectedRepo(
      db,
      { forge: "gitlab", owner: "acme", name: "box", origin: "https://git.b.example" },
      "2026-01-02T00:00:00Z",
      "instance",
    );
    expect(hostB).not.toBe(hostA);
    expect(listPages(db, hostA)).toEqual([{ slug: "arch", title: "A" }]);
    expect(listPages(db, hostB)).toEqual([]);
    const sameA = upsertConnectedRepo(
      db,
      { forge: "gitlab", owner: "acme", name: "box", origin: "https://git.a.example" },
      "2026-01-03T00:00:00Z",
      "instance",
    );
    expect(sameA).toBe(hostA);
    db.close();
  });

  it("adds origin to a pre-0009 repos table and preserves pages", () => {
    const legacy = new Database(":memory:");
    legacy.pragma("foreign_keys = ON");
    legacy.exec(`
      CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL);
      CREATE TABLE repos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        forge TEXT NOT NULL DEFAULT 'github',
        owner TEXT NOT NULL,
        name TEXT NOT NULL,
        auth_source TEXT NOT NULL DEFAULT 'manual',
        default_branch TEXT,
        last_mapped_ref TEXT,
        last_mapped_at TEXT,
        connected_at TEXT,
        created_at TEXT NOT NULL,
        UNIQUE (forge, owner, name)
      );
      CREATE TABLE pages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        repo_id INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
        slug TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL DEFAULT '',
        sort_order INTEGER NOT NULL DEFAULT 0,
        mapped_ref TEXT,
        updated_at TEXT NOT NULL,
        UNIQUE (repo_id, slug)
      );
      INSERT INTO repos (forge, owner, name, auth_source, created_at)
        VALUES ('gitlab', 'acme', 'box', 'instance', 't');
      INSERT INTO pages (repo_id, slug, title, body, sort_order, updated_at)
        VALUES (1, 'arch', 'Arch', 'body', 0, 't');
    `);
    for (const name of [
      "0001_init.sql",
      "0002_forge_connect.sql",
      "0003_settings.sql",
      "0004_auth_source.sql",
      "0005_default_branch.sql",
      "0006_ask_threads.sql",
      "0007_issue_bot.sql",
      "0008_issue_bot_forge.sql",
    ]) {
      legacy.prepare(`INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)`).run(name, "t");
    }
    migrate(legacy);
    const columns = legacy.prepare(`PRAGMA table_info(repos)`).all() as { name: string }[];
    expect(columns.some((col) => col.name === "origin")).toBe(true);
    expect(getPage(legacy, 1, "arch")?.body).toBe("body");
    expect(getRepo(legacy, 1)).toMatchObject({ forge: "gitlab", owner: "acme", name: "box", origin: "" });
    const hostB = upsertConnectedRepo(
      legacy,
      { forge: "gitlab", owner: "acme", name: "box", origin: "https://git.b.example" },
      "t2",
      "instance",
    );
    expect(hostB).not.toBe(1);
    legacy.close();
  });
});

describe("webhook log", () => {
  function row(detail: string, outcome: "queued" | "ignored" | "rejected" = "ignored") {
    return {
      at: "2026-01-01T00:00:00Z",
      forge: "github",
      outcome,
      reason: outcome === "rejected" ? "signature" : "mention",
      detail,
      title: "  lights\n flicker  ",
      owner: "o".repeat(250),
    };
  }

  it("truncates title, owner, and detail, and collapses title whitespace", () => {
    const db = openDb(":memory:");
    const id = insertWebhookLog(db, { ...row("d".repeat(600)), title: "  lights\n flicker  " });
    const entry = getWebhookLog(db, id);
    expect(entry?.title).toBe("lights flicker");
    expect(entry?.owner).toHaveLength(200);
    expect(entry?.detail).toHaveLength(500);
    expect(getWebhookLog(db, id + 50)).toBeUndefined();
  });

  it("keeps signed deliveries when rejected signatures fill their own cap", () => {
    const db = openDb(":memory:");
    const kept = insertWebhookLog(db, row("signed-delivery"));
    for (let i = 0; i < WEBHOOK_REJECTED_KEEP + 15; i++) insertWebhookLog(db, row(`bad-${i}`, "rejected"));
    for (let i = 0; i < WEBHOOK_LOG_KEEP + 5; i++) insertWebhookLog(db, row(`later-${i}`));
    expect(getWebhookLog(db, kept)).toBeUndefined();
    const all = listWebhookLogs(db, WEBHOOK_LOG_KEEP);
    expect(all.filter((entry) => entry.outcome === "rejected")).toHaveLength(0);
    expect(listWebhookLogs(db, 1)).toHaveLength(1);
    expect(listWebhookLogs(db, 10_000)).toHaveLength(WEBHOOK_LOG_KEEP);
    const rejected = db.prepare(`SELECT COUNT(*) AS n FROM webhook_log WHERE outcome = 'rejected'`).get() as { n: number };
    const signed = db.prepare(`SELECT COUNT(*) AS n FROM webhook_log WHERE outcome != 'rejected'`).get() as { n: number };
    expect(rejected.n).toBe(WEBHOOK_REJECTED_KEEP);
    expect(signed.n).toBe(WEBHOOK_LOG_KEEP);
    expect(db.prepare(`SELECT detail FROM webhook_log WHERE outcome != 'rejected' ORDER BY id ASC LIMIT 1`).get()).toEqual({
      detail: "later-5",
    });
  });

  it("lists only the requested repository", () => {
    const db = openDb(":memory:");
    insertWebhookLog(db, { ...row("box"), owner: "acme", name: "box", forge: "github" });
    insertWebhookLog(db, { ...row("lamp"), owner: "acme", name: "lamp", forge: "github" });
    insertWebhookLog(db, { ...row("other-host"), owner: "acme", name: "box", forge: "gitlab", origin: "https://git.other" });
    insertWebhookLog(db, { ...row("this-host"), owner: "ACME", name: "Box", forge: "gitlab", origin: "https://git.example" });
    expect(listWebhookLogs(db, 80, { forge: "github", owner: "Acme", name: "box" }).map((entry) => entry.detail)).toEqual(["box"]);
    expect(
      listWebhookLogs(db, 80, { forge: "gitlab", owner: "acme", name: "box", origin: "https://git.example" }).map(
        (entry) => entry.detail,
      ),
    ).toEqual(["this-host"]);
  });

  it("replaces a queued row with the finished job the next time the log is read", () => {
    const db = openDb(":memory:");
    const job = enqueueIssueRefineJob(
      db,
      { installationId: "1", owner: "acme", name: "box", issueNumber: 105, title: "Tokens", body: "expire" },
      "2026-01-01T00:00:00Z",
    )!;
    const id = insertWebhookLog(db, {
      ...row("Queued. still waiting"),
      owner: "acme",
      name: "box",
      outcome: "queued",
      reason: "queued",
      jobId: job,
      issueNumber: 105,
    });
    completeIssueRefineJob(db, job, "2026-01-01T00:01:00Z", {
      outcome: "needs-info",
      why: "Open questions still need an answer, so Eru left this as needs-info.",
    });
    expect(getWebhookLog(db, id)).toMatchObject({
      outcome: "needs-info",
      reason: "needs-info",
      detail: "Open questions still need an answer, so Eru left this as needs-info.",
    });
  });

  it("keeps the sender id and can mark that row queued again", () => {
    const db = openDb(":memory:");
    const id = insertWebhookLog(db, {
      ...row("Ignored. GitHub author association was NONE for nagato."),
      owner: "acme",
      name: "box",
      issueNumber: 4,
      reason: "author",
      senderId: 13,
      senderLogin: "nagato",
      installationId: "555",
    });
    expect(getWebhookLog(db, id)).toMatchObject({
      senderId: 13,
      senderLogin: "nagato",
      installationId: "555",
      outcome: "ignored",
    });
    const job = enqueueIssueRefineJob(
      db,
      { installationId: "555", owner: "acme", name: "box", issueNumber: 4, title: "lamp", body: "" },
      "2026-01-02T00:00:00Z",
    )!;
    const earlier = insertWebhookLog(db, {
      ...row("Open questions still need an answer."),
      owner: "acme",
      name: "box",
      issueNumber: 4,
      outcome: "needs-info",
      reason: "needs-info",
      jobId: job,
    });
    queueWebhookLog(db, id, job, "Queued by the operator. nagato is on the allowlist.");
    expect(getWebhookLog(db, id)).toMatchObject({
      outcome: "queued",
      reason: "forced",
      jobId: job,
      detail: "Queued by the operator. nagato is on the allowlist.",
    });
    expect(getWebhookLog(db, earlier)).toMatchObject({
      outcome: "queued",
      reason: "forced",
      detail: "Queued by the operator. nagato is on the allowlist.",
    });
    db.close();
  });
});

describe("issue refine restart", () => {
  it("resets a finished job and leaves a running job alone", () => {
    const db = openDb(":memory:");
    const at = "2026-01-01T00:00:00Z";
    const id = enqueueIssueRefineJob(
      db,
      { installationId: "1", owner: "acme", name: "box", issueNumber: 3, title: "old", body: "old body" },
      at,
    )!;
    completeIssueRefineJob(db, id, at, { outcome: "needs-info", why: "wait", refined: "x" });
    const again = enqueueOrRestartIssueRefineJob(
      db,
      { installationId: "2", owner: "acme", name: "box", issueNumber: 3, title: "new", body: "" },
      "2026-01-02T00:00:00Z",
    );
    expect(again).toBe(id);
    expect(getIssueRefineJob(db, id)).toMatchObject({
      status: "pending",
      title: "new",
      body: "",
      installationId: "2",
      outcome: null,
      attempts: 0,
      why: null,
      note: null,
    });
    db.prepare(`UPDATE issue_refine_jobs SET status = 'running' WHERE id = ?`).run(id);
    expect(
      enqueueOrRestartIssueRefineJob(
        db,
        { installationId: "2", owner: "acme", name: "box", issueNumber: 3, title: "newer", body: "no" },
        "2026-01-03T00:00:00Z",
      ),
    ).toBeUndefined();
    expect(getIssueRefineJob(db, id)?.title).toBe("new");
    db.close();
  });
});

describe("issue refine restart", () => {
  it("hides ignored rows from a repo list and can queue a finished job again", () => {
    const db = openDb(":memory:");
    const log = (detail: string, extra: Record<string, unknown> = {}) => ({
      at: "2026-01-01T00:00:00Z",
      forge: "github",
      outcome: "ignored" as const,
      reason: "mention",
      detail,
      title: "lights",
      ...extra,
    });
    insertWebhookLog(db, log("skip me", { owner: "acme", name: "box" }));
    const job = enqueueIssueRefineJob(
      db,
      { installationId: "1", owner: "acme", name: "box", issueNumber: 4, title: "Lamp", body: "dead" },
      "2026-01-01T00:00:00Z",
    )!;
    completeIssueRefineJob(db, job, "2026-01-01T00:01:00Z", { outcome: "agent-ready", why: "done", refined: "brief" });
    const kept = insertWebhookLog(db, log("kept", {
      owner: "acme",
      name: "box",
      outcome: "agent-ready",
      reason: "agent-ready",
      jobId: job,
      issueNumber: 4,
    }));
    expect(listWebhookLogs(db, 80, { forge: "github", owner: "acme", name: "box" }, { hideIgnored: true }).map((entry) => entry.id)).toEqual([
      kept,
    ]);
    db.prepare(`UPDATE issue_refine_jobs SET status = 'running' WHERE id = ?`).run(job);
    expect(restartIssueRefineJob(db, job, "2026-01-02T00:00:00Z", { title: "Lamp", body: "dead", installationId: "1" })).toBe(false);
    db.prepare(`UPDATE issue_refine_jobs SET status = 'done' WHERE id = ?`).run(job);
    expect(restartIssueRefineJob(db, job, "2026-01-02T00:00:00Z", { title: "Lamp", body: "original", installationId: "9" })).toBe(true);
    expect(getIssueRefineJob(db, job)).toMatchObject({ status: "pending", body: "original", outcome: null, note: null, attempts: 0 });
    requeueWebhookLogsForJob(db, job, "Queued again by the operator.");
    expect(getWebhookLog(db, kept)).toMatchObject({ outcome: "queued", reason: "rerun", detail: "Queued again by the operator." });
    db.close();
  });
});
