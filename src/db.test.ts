import Database from "better-sqlite3";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  deleteForgeCredential,
  getForgeCredential,
  getPrimaryRepo,
  migrate,
  openDb,
  setForgeCredential,
  upsertConnectedRepo,
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
    expect(migrations.n).toBe(2);
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
    expect(getPrimaryRepo(legacy)).toMatchObject({ owner: "legacy", name: "repo", lastMappedRef: "main" });
    const migrations = legacy.prepare(`SELECT COUNT(*) AS n FROM schema_migrations`).get() as { n: number };
    expect(migrations.n).toBe(2);

    // The legacy row is primary while it is the only row; a new connect
    // displaces it (NULL connected_at sorts last under DESC).
    upsertConnectedRepo(legacy, { forge: "github", owner: "acme", name: "box" }, "2026-01-01T00:00:00Z");
    expect(getPrimaryRepo(legacy)!.name).toBe("box");

    migrate(legacy);
    const after = legacy.prepare(`SELECT COUNT(*) AS n FROM schema_migrations`).get() as { n: number };
    expect(after.n).toBe(2);
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

  it("drops credentials when a repo row is deleted", () => {
    const db = openDb(":memory:");
    const id = upsertConnectedRepo(db, { forge: "github", owner: "acme", name: "box" }, "2026-01-01T00:00:00Z");
    setForgeCredential(db, id, "enc", "2026-01-01T00:00:00Z");
    db.prepare(`DELETE FROM repos WHERE id = ?`).run(id);
    expect(getForgeCredential(db, id)).toBeUndefined();
    db.close();
  });
});
