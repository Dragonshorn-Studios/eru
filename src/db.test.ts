import Database from "better-sqlite3";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  deleteForgeCredential,
  deleteSetting,
  deleteStalePages,
  getForgeCredential,
  getPage,
  getPrimaryRepo,
  getSetting,
  listPages,
  migrate,
  openDb,
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
    expect(migrations.n).toBe(6);
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
    expect(getPrimaryRepo(legacy)).toMatchObject({ owner: "legacy", name: "repo", lastMappedRef: "main" });
    const migrations = legacy.prepare(`SELECT COUNT(*) AS n FROM schema_migrations`).get() as { n: number };
    expect(migrations.n).toBe(6);

    // The legacy row is primary while it is the only row; a new connect
    // displaces it (NULL connected_at sorts last under DESC).
    upsertConnectedRepo(legacy, { forge: "github", owner: "acme", name: "box" }, "2026-01-01T00:00:00Z");
    expect(getPrimaryRepo(legacy)!.name).toBe("box");

    migrate(legacy);
    const after = legacy.prepare(`SELECT COUNT(*) AS n FROM schema_migrations`).get() as { n: number };
    expect(after.n).toBe(6);
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

    // Reconnecting the same repo manually flips it back.
    upsertConnectedRepo(db, { forge: "github", owner: "acme", name: "cart" }, "2026-01-03T00:00:00Z");
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
