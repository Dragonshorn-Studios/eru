import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type SqliteDb = Database.Database;

/**
 * `repos` — forge identity, last mapped ref, and connection time (issues #2 / #5).
 * `forge_credentials` — forge tokens encrypted at rest (issue #2).
 * `pages` — durable Brief pages (issues #3 / #5). Ask (#4) reads these rows.
 *
 * This migrate does not seed map content or run OpenCode.
 */
const FORGE_CREDENTIALS_SQL = `
CREATE TABLE IF NOT EXISTS forge_credentials (
  repo_id INTEGER PRIMARY KEY REFERENCES repos(id) ON DELETE CASCADE,
  token_enc TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;

const SETTINGS_SQL = `
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;

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
  auth_source TEXT NOT NULL DEFAULT 'manual',
  default_branch TEXT,
  last_mapped_ref TEXT,
  last_mapped_at TEXT,
  connected_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (forge, owner, name)
);

${FORGE_CREDENTIALS_SQL}
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

${SETTINGS_SQL}
`;

interface Migration {
  name: string;
  apply: (db: SqliteDb) => void;
}

// For databases created before forge connect landed: add repos.connected_at
// and the forge_credentials table. Fresh databases already have both via INIT_SQL.
const MIGRATIONS: Migration[] = [
  {
    name: "0002_forge_connect.sql",
    apply(db) {
      const columns = db.prepare(`PRAGMA table_info(repos)`).all() as { name: string }[];
      if (!columns.some((col) => col.name === "connected_at")) {
        db.exec(`ALTER TABLE repos ADD COLUMN connected_at TEXT`);
      }
      db.exec(FORGE_CREDENTIALS_SQL);
    },
  },
  {
    name: "0003_settings.sql",
    apply(db) {
      db.exec(SETTINGS_SQL);
    },
  },
  {
    name: "0004_auth_source.sql",
    apply(db) {
      const columns = db.prepare(`PRAGMA table_info(repos)`).all() as { name: string }[];
      if (!columns.some((col) => col.name === "auth_source")) {
        db.exec(`ALTER TABLE repos ADD COLUMN auth_source TEXT NOT NULL DEFAULT 'manual'`);
      }
    },
  },
  {
    name: "0005_default_branch.sql",
    apply(db) {
      const columns = db.prepare(`PRAGMA table_info(repos)`).all() as { name: string }[];
      if (!columns.some((col) => col.name === "default_branch")) {
        db.exec(`ALTER TABLE repos ADD COLUMN default_branch TEXT`);
      }
    },
  },
  {
    name: "0006_ask_threads.sql",
    apply(db) {
      db.exec(ASK_THREADS_SQL);
    },
  },
];

// Ask threads (#33): one row per Eru thread. The thread's OpenCode session and
// its map-only workspace live under the ask workdir keyed by thread id; only
// the metadata needed to reconnect is persisted here.
const ASK_THREADS_SQL = `
CREATE TABLE IF NOT EXISTS ask_threads (
  id TEXT PRIMARY KEY,
  repo_id INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  session_id TEXT,
  title TEXT NOT NULL DEFAULT '',
  mapped_ref TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ask_threads_repo_idx ON ask_threads (repo_id, updated_at DESC);
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
  recordMigration(db, "0001_init.sql");
  for (const migration of MIGRATIONS) {
    const applied = db.prepare(`SELECT COUNT(*) AS n FROM schema_migrations WHERE name = ?`).get(migration.name) as {
      n: number;
    };
    if (applied.n === 0) {
      db.transaction(() => {
        migration.apply(db);
        recordMigration(db, migration.name);
      })();
    }
  }
}

function recordMigration(db: SqliteDb, name: string): void {
  const applied = db.prepare(`SELECT COUNT(*) AS n FROM schema_migrations WHERE name = ?`).get(name) as { n: number };
  if (applied.n === 0) {
    db.prepare(`INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)`).run(name, new Date().toISOString());
  }
}

export interface MappedRepo {
  id: number;
  forge: string;
  owner: string;
  name: string;
  authSource: string;
  defaultBranch: string | null;
  lastMappedRef: string | null;
  lastMappedAt: string | null;
}

export type RepoAuthSource = "manual" | "app";

const MAPPED_REPO_COLUMNS = `id, forge, owner, name, auth_source AS authSource, default_branch AS defaultBranch, last_mapped_ref AS lastMappedRef, last_mapped_at AS lastMappedAt`;

/** The currently connected repo: the one most recently connected. */
export function getPrimaryRepo(db: SqliteDb): MappedRepo | undefined {
  return db
    .prepare(`SELECT ${MAPPED_REPO_COLUMNS} FROM repos ORDER BY connected_at DESC, id DESC LIMIT 1`)
    .get() as MappedRepo | undefined;
}

export function getRepo(db: SqliteDb, id: number): MappedRepo | undefined {
  return db.prepare(`SELECT ${MAPPED_REPO_COLUMNS} FROM repos WHERE id = ?`).get(id) as MappedRepo | undefined;
}

export function listConnectedRepos(db: SqliteDb): MappedRepo[] {
  return db
    .prepare(`SELECT ${MAPPED_REPO_COLUMNS} FROM repos ORDER BY connected_at DESC, id DESC`)
    .all() as MappedRepo[];
}

export function upsertConnectedRepo(
  db: SqliteDb,
  repo: { forge: string; owner: string; name: string; defaultBranch?: string },
  at: string,
  authSource: RepoAuthSource = "manual",
): number {
  const row = db
    .prepare(
      `INSERT INTO repos (forge, owner, name, auth_source, default_branch, connected_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (forge, owner, name) DO UPDATE SET
         connected_at = excluded.connected_at,
         auth_source = excluded.auth_source,
         default_branch = COALESCE(excluded.default_branch, repos.default_branch)
       RETURNING id`,
    )
    .get(repo.forge, repo.owner, repo.name, authSource, repo.defaultBranch ?? null, at, at) as { id: number };
  return row.id;
}

export function setForgeCredential(db: SqliteDb, repoId: number, tokenEnc: string, at: string): void {
  db.prepare(
    `INSERT INTO forge_credentials (repo_id, token_enc, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT (repo_id) DO UPDATE SET token_enc = excluded.token_enc, updated_at = excluded.updated_at`,
  ).run(repoId, tokenEnc, at);
}

export function getForgeCredential(db: SqliteDb, repoId: number): string | undefined {
  const row = db.prepare(`SELECT token_enc FROM forge_credentials WHERE repo_id = ?`).get(repoId) as
    | { token_enc: string }
    | undefined;
  return row?.token_enc;
}

export function deleteForgeCredential(db: SqliteDb, repoId: number): void {
  db.prepare(`DELETE FROM forge_credentials WHERE repo_id = ?`).run(repoId);
}

export function setLastMapped(db: SqliteDb, repoId: number, ref: string, at: string): void {
  db.prepare(`UPDATE repos SET last_mapped_ref = ?, last_mapped_at = ? WHERE id = ?`).run(ref, at, repoId);
}

export function getSetting(db: SqliteDb, key: string): string | undefined {
  const row = db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key) as { value: string } | undefined;
  return row?.value;
}

export function setSetting(db: SqliteDb, key: string, value: string, at: string): void {
  db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(key, value, at);
}

export function deleteSetting(db: SqliteDb, key: string): void {
  db.prepare(`DELETE FROM settings WHERE key = ?`).run(key);
}

export interface PageTocEntry {
  slug: string;
  title: string;
}

export interface MapPage {
  id: number;
  slug: string;
  title: string;
  body: string;
  sortOrder: number;
  mappedRef: string | null;
  updatedAt: string;
}

export function listPages(db: SqliteDb, repoId: number): PageTocEntry[] {
  return db
    .prepare(`SELECT slug, title FROM pages WHERE repo_id = ? ORDER BY sort_order ASC, id ASC`)
    .all(repoId) as PageTocEntry[];
}

export function listAllPages(db: SqliteDb, repoId: number): MapPage[] {
  return db
    .prepare(
      `SELECT id, slug, title, body, sort_order AS sortOrder, mapped_ref AS mappedRef, updated_at AS updatedAt
       FROM pages WHERE repo_id = ? ORDER BY sort_order ASC, id ASC`,
    )
    .all(repoId) as MapPage[];
}

export function getPage(db: SqliteDb, repoId: number, slug: string): MapPage | undefined {
  return db
    .prepare(
      `SELECT id, slug, title, body, sort_order AS sortOrder, mapped_ref AS mappedRef, updated_at AS updatedAt
       FROM pages WHERE repo_id = ? AND slug = ?`,
    )
    .get(repoId, slug) as MapPage | undefined;
}

export function upsertPage(
  db: SqliteDb,
  repoId: number,
  page: { slug: string; title: string; body: string; sortOrder: number; mappedRef?: string | null },
  at: string,
): number {
  const row = db
    .prepare(
      `INSERT INTO pages (repo_id, slug, title, body, sort_order, mapped_ref, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (repo_id, slug) DO UPDATE SET
         title = excluded.title,
         body = excluded.body,
         sort_order = excluded.sort_order,
         mapped_ref = COALESCE(excluded.mapped_ref, pages.mapped_ref),
         updated_at = excluded.updated_at
       RETURNING id`,
    )
    .get(repoId, page.slug, page.title, page.body, page.sortOrder, page.mappedRef ?? null, at) as { id: number };
  return row.id;
}
