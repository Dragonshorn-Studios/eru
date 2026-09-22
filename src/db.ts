import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type SqliteDb = Database.Database;

/**
 * Stub schema for later tickets.
 *
 * `repos` — forge identity and last mapped ref (issues #2 / #5).
 * `pages` — durable Brief pages (issues #3 / #5). Ask (#4) reads these rows.
 *
 * This migrate does not seed map content, store forge tokens, or run OpenCode.
 */
const INIT_SQL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  name TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS repos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  forge TEXT NOT NULL DEFAULT 'github',
  owner TEXT NOT NULL,
  name TEXT NOT NULL,
  last_mapped_ref TEXT,
  last_mapped_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (forge, owner, name)
);

CREATE TABLE IF NOT EXISTS pages (
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
`;

export function openDb(path: string): SqliteDb {
  if (path !== ":memory:") {
    mkdirSync(dirname(path) || ".", { recursive: true });
  }
  const db = new Database(path);
  if (path !== ":memory:") {
    db.pragma("journal_mode = WAL");
  }
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  migrate(db);
  return db;
}

export function migrate(db: SqliteDb): void {
  db.exec(INIT_SQL);
  const applied = db.prepare(`SELECT COUNT(*) AS n FROM schema_migrations WHERE name = ?`).get("0001_init.sql") as {
    n: number;
  };
  if (applied.n === 0) {
    db.prepare(`INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)`).run(
      "0001_init.sql",
      new Date().toISOString(),
    );
  }
}

export interface MappedRepo {
  owner: string;
  name: string;
  lastMappedRef: string | null;
  lastMappedAt: string | null;
}

export function getPrimaryRepo(db: SqliteDb): MappedRepo | undefined {
  return db
    .prepare(
      `SELECT owner, name, last_mapped_ref AS lastMappedRef, last_mapped_at AS lastMappedAt
       FROM repos ORDER BY id ASC LIMIT 1`,
    )
    .get() as MappedRepo | undefined;
}
