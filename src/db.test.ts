import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  deleteForgeCredential,
  getForgeCredential,
  getPage,
  getPrimaryRepo,
  listPages,
  openDb,
  setForgeCredential,
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
    expect(migrations.n).toBe(2);
    again.close();
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

  it("drops credentials when a repo row is deleted", () => {
    const db = openDb(":memory:");
    const id = upsertConnectedRepo(db, { forge: "github", owner: "acme", name: "box" }, "2026-01-01T00:00:00Z");
    setForgeCredential(db, id, "enc", "2026-01-01T00:00:00Z");
    db.prepare(`DELETE FROM repos WHERE id = ?`).run(id);
    expect(getForgeCredential(db, id)).toBeUndefined();
    db.close();
  });
});
