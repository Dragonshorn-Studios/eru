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
  origin TEXT NOT NULL DEFAULT '',
  auth_source TEXT NOT NULL DEFAULT 'manual',
  default_branch TEXT,
  last_mapped_ref TEXT,
  last_mapped_at TEXT,
  connected_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (forge, owner, name, origin)
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
  /** Table rebuilds that need PRAGMA foreign_keys=OFF cannot run inside a transaction. */
  unlocked?: boolean;
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
  {
    name: "0007_issue_bot.sql",
    apply(db) {
      db.exec(ISSUE_BOT_SQL);
    },
  },
  {
    name: "0008_issue_bot_forge.sql",
    apply(db) {
      const columns = db.prepare(`PRAGMA table_info(issue_refine_jobs)`).all() as { name: string }[];
      if (columns.length === 0) {
        db.exec(ISSUE_BOT_SQL);
        return;
      }
      if (columns.some((col) => col.name === "forge")) return;
      db.exec(`
        CREATE TABLE issue_refine_jobs_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          forge TEXT NOT NULL DEFAULT 'github',
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
          UNIQUE (forge, owner, name, issue_number)
        );
        INSERT INTO issue_refine_jobs_new (
          id, forge, installation_id, owner, name, issue_number, title, body,
          status, attempts, run_after, last_error, created_at, updated_at
        )
        SELECT
          id, 'github', installation_id, owner, name, issue_number, title, body,
          status, attempts, run_after, last_error, created_at, updated_at
        FROM issue_refine_jobs;
        DROP TABLE issue_refine_jobs;
        ALTER TABLE issue_refine_jobs_new RENAME TO issue_refine_jobs;
        CREATE INDEX IF NOT EXISTS issue_refine_jobs_poll_idx ON issue_refine_jobs (status, run_after, id);
        CREATE INDEX IF NOT EXISTS issue_refine_jobs_repo_idx ON issue_refine_jobs (forge, owner, name, created_at);
      `);
    },
  },
  {
    name: "0009_repo_origin.sql",
    unlocked: true,
    apply(db) {
      const columns = db.prepare(`PRAGMA table_info(repos)`).all() as { name: string }[];
      if (columns.some((col) => col.name === "origin")) return;
      db.exec(`
        CREATE TABLE repos_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          forge TEXT NOT NULL DEFAULT 'github',
          owner TEXT NOT NULL,
          name TEXT NOT NULL,
          origin TEXT NOT NULL DEFAULT '',
          auth_source TEXT NOT NULL DEFAULT 'manual',
          default_branch TEXT,
          last_mapped_ref TEXT,
          last_mapped_at TEXT,
          connected_at TEXT,
          created_at TEXT NOT NULL,
          UNIQUE (forge, owner, name, origin)
        );
        INSERT INTO repos_new (
          id, forge, owner, name, origin, auth_source, default_branch,
          last_mapped_ref, last_mapped_at, connected_at, created_at
        )
        SELECT
          id, forge, owner, name, '', COALESCE(auth_source, 'manual'), default_branch,
          last_mapped_ref, last_mapped_at, connected_at, created_at
        FROM repos;
        DROP TABLE repos;
        ALTER TABLE repos_new RENAME TO repos;
      `);
    },
  },
  {
    name: "0010_issue_refine_story.sql",
    apply(db) {
      const columns = db.prepare(`PRAGMA table_info(issue_refine_jobs)`).all() as { name: string }[];
      if (columns.length === 0) return;
      const names = new Set(columns.map((col) => col.name));
      if (!names.has("origin")) db.exec(`ALTER TABLE issue_refine_jobs ADD COLUMN origin TEXT NOT NULL DEFAULT ''`);
      if (!names.has("outcome")) db.exec(`ALTER TABLE issue_refine_jobs ADD COLUMN outcome TEXT`);
      if (!names.has("refined")) db.exec(`ALTER TABLE issue_refine_jobs ADD COLUMN refined TEXT`);
      if (!names.has("why")) db.exec(`ALTER TABLE issue_refine_jobs ADD COLUMN why TEXT`);
    },
  },
  {
    name: "0011_webhook_log.sql",
    apply(db) {
      db.exec(WEBHOOK_LOG_SQL);
    },
  },
  {
    name: "0012_issue_refine_note.sql",
    apply(db) {
      const columns = db.prepare(`PRAGMA table_info(issue_refine_jobs)`).all() as { name: string }[];
      if (columns.length === 0 || columns.some((col) => col.name === "note")) return;
      db.exec(`ALTER TABLE issue_refine_jobs ADD COLUMN note TEXT`);
    },
  },
  {
    name: "0013_webhook_sender.sql",
    apply(db) {
      const columns = db.prepare(`PRAGMA table_info(webhook_log)`).all() as { name: string }[];
      if (columns.length === 0) return;
      const names = new Set(columns.map((col) => col.name));
      if (!names.has("sender_id")) db.exec(`ALTER TABLE webhook_log ADD COLUMN sender_id INTEGER`);
      if (!names.has("sender_login")) db.exec(`ALTER TABLE webhook_log ADD COLUMN sender_login TEXT NOT NULL DEFAULT ''`);
      if (!names.has("installation_id")) {
        db.exec(`ALTER TABLE webhook_log ADD COLUMN installation_id TEXT NOT NULL DEFAULT ''`);
      }
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

// Issue bot (#37): one job per issue (UNIQUE owner/name/issue_number). GitHub
// retries INSERT OR IGNORE. The in-process worker claims pending rows.
const ISSUE_BOT_SQL = `
CREATE TABLE IF NOT EXISTS issue_refine_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  forge TEXT NOT NULL DEFAULT 'github',
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
  UNIQUE (forge, owner, name, issue_number)
);
CREATE INDEX IF NOT EXISTS issue_refine_jobs_poll_idx ON issue_refine_jobs (status, run_after, id);
CREATE INDEX IF NOT EXISTS issue_refine_jobs_repo_idx ON issue_refine_jobs (forge, owner, name, created_at);
`;

const WEBHOOK_LOG_SQL = `
CREATE TABLE IF NOT EXISTS webhook_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  forge TEXT NOT NULL,
  origin TEXT NOT NULL DEFAULT '',
  owner TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL DEFAULT '',
  issue_number INTEGER,
  delivery TEXT NOT NULL DEFAULT '',
  event TEXT NOT NULL DEFAULT '',
  action TEXT NOT NULL DEFAULT '',
  outcome TEXT NOT NULL,
  reason TEXT NOT NULL,
  detail TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  job_id INTEGER,
  sender_id INTEGER,
  sender_login TEXT NOT NULL DEFAULT '',
  installation_id TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS webhook_log_at_idx ON webhook_log (id DESC);
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
      const run = () => {
        migration.apply(db);
        recordMigration(db, migration.name);
      };
      if (migration.unlocked) {
        db.pragma("foreign_keys = OFF");
        try {
          run();
        } finally {
          db.pragma("foreign_keys = ON");
        }
      } else {
        db.transaction(run)();
      }
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
  origin: string;
  authSource: string;
  defaultBranch: string | null;
  lastMappedRef: string | null;
  lastMappedAt: string | null;
}

export type RepoAuthSource = "manual" | "app" | "instance";

const MAPPED_REPO_COLUMNS = `id, forge, owner, name, origin, auth_source AS authSource, default_branch AS defaultBranch, last_mapped_ref AS lastMappedRef, last_mapped_at AS lastMappedAt`;

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

/** Match a forge identity to a connected repo. Owner/name compare case-insensitively. */
export function findConnectedRepo(
  db: SqliteDb,
  identity: { forge: string; owner: string; name: string; origin?: string },
): MappedRepo | undefined {
  return db
    .prepare(
      `SELECT ${MAPPED_REPO_COLUMNS} FROM repos
       WHERE forge = ? AND origin = ? AND lower(owner) = lower(?) AND lower(name) = lower(?)
       LIMIT 1`,
    )
    .get(identity.forge, identity.origin ?? "", identity.owner, identity.name) as MappedRepo | undefined;
}

export function upsertConnectedRepo(
  db: SqliteDb,
  repo: { forge: string; owner: string; name: string; defaultBranch?: string; origin?: string },
  at: string,
  authSource: RepoAuthSource = "manual",
): number {
  const origin = repo.origin ?? "";
  const row = db
    .prepare(
      `INSERT INTO repos (forge, owner, name, origin, auth_source, default_branch, connected_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (forge, owner, name, origin) DO UPDATE SET
         connected_at = excluded.connected_at,
         auth_source = excluded.auth_source,
         default_branch = COALESCE(excluded.default_branch, repos.default_branch)
       RETURNING id`,
    )
    .get(repo.forge, repo.owner, repo.name, origin, authSource, repo.defaultBranch ?? null, at, at) as { id: number };
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

// A refresh replaces the map: pages the new scan did not produce are stale.
// Refuse to wipe the whole map if a caller ever passes an empty list.
export function deleteStalePages(db: SqliteDb, repoId: number, keepSlugs: string[]): void {
  if (keepSlugs.length === 0) return;
  const placeholders = keepSlugs.map(() => "?").join(",");
  db.prepare(`DELETE FROM pages WHERE repo_id = ? AND slug NOT IN (${placeholders})`).run(repoId, ...keepSlugs);
}

export type IssueRefineStatus = "pending" | "running" | "done" | "failed";
export type IssueRefineOutcome = "agent-ready" | "needs-info" | "failed" | "skipped";

export interface IssueRefineStory {
  outcome: Exclude<IssueRefineOutcome, "failed">;
  refined?: string | null;
  why: string;
  /** What Eru thinks of the names in the issue. Not posted as part of the brief. */
  note?: string | null;
}

export interface IssueRefineJob {
  id: number;
  forge: string;
  origin: string;
  installationId: string;
  owner: string;
  name: string;
  issueNumber: number;
  title: string;
  body: string;
  status: IssueRefineStatus;
  outcome: IssueRefineOutcome | null;
  refined: string | null;
  why: string | null;
  note: string | null;
  attempts: number;
  runAfter: string;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

const ISSUE_JOB_COLUMNS = `id, forge, origin, installation_id AS installationId, owner, name, issue_number AS issueNumber, title, body, status, outcome, refined, why, note, attempts, run_after AS runAfter, last_error AS lastError, created_at AS createdAt, updated_at AS updatedAt`;

/** Insert a job. Returns undefined when that issue is already queued. */
export function enqueueIssueRefineJob(
  db: SqliteDb,
  job: {
    forge?: string;
    origin?: string;
    installationId: string;
    owner: string;
    name: string;
    issueNumber: number;
    title: string;
    body: string;
  },
  at: string,
): number | undefined {
  const row = db
    .prepare(
      `INSERT OR IGNORE INTO issue_refine_jobs (
         forge, origin, installation_id, owner, name, issue_number, title, body,
         status, attempts, run_after, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)
       RETURNING id`,
    )
    .get(
      job.forge ?? "github",
      job.origin ?? "",
      job.installationId,
      job.owner,
      job.name,
      job.issueNumber,
      job.title,
      job.body,
      at,
      at,
      at,
    ) as { id: number } | undefined;
  return row?.id;
}

/**
 * Insert a job, or reset a finished one so the operator can rewrite it again.
 * A running job is left alone and this returns undefined.
 */
export function enqueueOrRestartIssueRefineJob(
  db: SqliteDb,
  job: {
    forge?: string;
    origin?: string;
    installationId: string;
    owner: string;
    name: string;
    issueNumber: number;
    title: string;
    body: string;
  },
  at: string,
): number | undefined {
  const inserted = enqueueIssueRefineJob(db, job, at);
  if (inserted !== undefined) return inserted;
  const forge = job.forge ?? "github";
  const existing = db
    .prepare(
      `SELECT id, status FROM issue_refine_jobs
        WHERE forge = ? AND owner = ? AND name = ? AND issue_number = ?`,
    )
    .get(forge, job.owner, job.name, job.issueNumber) as { id: number; status: string } | undefined;
  if (!existing || existing.status === "running") return undefined;
  const updated = db
    .prepare(
      `UPDATE issue_refine_jobs
          SET status = 'pending', attempts = 0, title = ?, body = ?, installation_id = ?, origin = ?,
              outcome = NULL, refined = NULL, why = NULL, note = NULL, last_error = NULL,
              run_after = ?, updated_at = ?
        WHERE id = ? AND status != 'running'`,
    )
    .run(job.title, job.body, job.installationId, job.origin ?? "", at, at, existing.id);
  return updated.changes === 0 ? undefined : existing.id;
}

/** Put a finished job back on the queue. A running job is left alone. */
export function restartIssueRefineJob(
  db: SqliteDb,
  id: number,
  at: string,
  job: { title: string; body: string; installationId: string },
): boolean {
  const updated = db
    .prepare(
      `UPDATE issue_refine_jobs
          SET status = 'pending', attempts = 0, title = ?, body = ?, installation_id = ?,
              outcome = NULL, refined = NULL, why = NULL, note = NULL, last_error = NULL,
              run_after = ?, updated_at = ?
        WHERE id = ? AND status != 'running'`,
    )
    .run(job.title, job.body, job.installationId, at, at, id);
  return updated.changes > 0;
}

export function countRecentIssueRefineJobs(
  db: SqliteDb,
  owner: string,
  name: string,
  since: string,
  forge = "github",
): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM issue_refine_jobs WHERE forge = ? AND owner = ? AND name = ? AND created_at >= ?`,
    )
    .get(forge, owner, name, since) as { n: number };
  return row.n;
}

export function getIssueRefineJob(db: SqliteDb, id: number): IssueRefineJob | undefined {
  return db.prepare(`SELECT ${ISSUE_JOB_COLUMNS} FROM issue_refine_jobs WHERE id = ?`).get(id) as
    | IssueRefineJob
    | undefined;
}

export function listIssueRefineJobs(db: SqliteDb): IssueRefineJob[] {
  return db.prepare(`SELECT ${ISSUE_JOB_COLUMNS} FROM issue_refine_jobs ORDER BY id ASC`).all() as IssueRefineJob[];
}

/** Newest catches for one connected repo. Blank origin matches jobs recorded before hosts were stored. */
export function listIssueRefineJobsForRepo(
  db: SqliteDb,
  repo: { forge: string; owner: string; name: string; origin?: string },
): IssueRefineJob[] {
  return db
    .prepare(
      `SELECT ${ISSUE_JOB_COLUMNS} FROM issue_refine_jobs
       WHERE forge = ? AND lower(owner) = lower(?) AND lower(name) = lower(?)
         AND (origin = '' OR origin = ?)
       ORDER BY id DESC
       LIMIT 80`,
    )
    .all(repo.forge, repo.owner, repo.name, repo.origin ?? "") as IssueRefineJob[];
}

/** Claim the next due pending job. Single-process: no other worker races us. */
export function claimDueIssueRefineJob(db: SqliteDb, at: string): IssueRefineJob | undefined {
  return db
    .transaction(() => {
      const row = db
        .prepare(
          `SELECT ${ISSUE_JOB_COLUMNS} FROM issue_refine_jobs
           WHERE status = 'pending' AND run_after <= ?
           ORDER BY id ASC LIMIT 1`,
        )
        .get(at) as IssueRefineJob | undefined;
      if (!row) return undefined;
      db.prepare(
        `UPDATE issue_refine_jobs SET status = 'running', attempts = attempts + 1, updated_at = ? WHERE id = ?`,
      ).run(at, row.id);
      return { ...row, status: "running" as const, attempts: row.attempts + 1, updatedAt: at };
    })();
}

export function completeIssueRefineJob(db: SqliteDb, id: number, at: string, story?: IssueRefineStory): void {
  if (!story) {
    db.prepare(`UPDATE issue_refine_jobs SET status = 'done', last_error = NULL, updated_at = ? WHERE id = ?`).run(at, id);
    return;
  }
  db.prepare(
    `UPDATE issue_refine_jobs
     SET status = 'done', outcome = ?, refined = ?, why = ?, note = ?, last_error = NULL, updated_at = ?
     WHERE id = ?`,
  ).run(story.outcome, story.refined ?? null, story.why, story.note ?? null, at, id);
}

export function failIssueRefineJob(db: SqliteDb, id: number, at: string, error: string, why?: string): void {
  db.prepare(
    `UPDATE issue_refine_jobs SET status = 'failed', outcome = 'failed', why = ?, last_error = ?, updated_at = ? WHERE id = ?`,
  ).run(why ?? null, error, at, id);
}

export function retryIssueRefineJob(db: SqliteDb, id: number, at: string, runAfter: string, error: string): void {
  db.prepare(
    `UPDATE issue_refine_jobs
     SET status = 'pending', run_after = ?, last_error = ?, updated_at = ?
     WHERE id = ?`,
  ).run(runAfter, error, at, id);
}

/** Jobs left `running` after a crash go back on the queue. */
export type WebhookLogOutcome = "queued" | "ignored" | "rejected" | "agent-ready" | "needs-info" | "failed" | "skipped";

export interface WebhookLogEntry {
  id: number;
  at: string;
  forge: string;
  origin: string;
  owner: string;
  name: string;
  issueNumber: number | null;
  delivery: string;
  event: string;
  action: string;
  outcome: WebhookLogOutcome;
  reason: string;
  detail: string;
  title: string;
  jobId: number | null;
  senderId: number | null;
  senderLogin: string;
  installationId: string;
}

const WEBHOOK_LOG_COLUMNS = `id, at, forge, origin, owner, name, issue_number AS issueNumber, delivery, event, action, outcome, reason, detail, title, job_id AS jobId, sender_id AS senderId, sender_login AS senderLogin, installation_id AS installationId`;
/** Signed deliveries (queued and ignored). Rejected rows use a separate cap. */
export const WEBHOOK_LOG_KEEP = 200;
/** Bad signatures are unauthenticated. They must not evict signed deliveries. */
export const WEBHOOK_REJECTED_KEEP = 40;

/** Operator-visible decision. Title is truncated; the issue body and the signature are never stored. */
export function insertWebhookLog(
  db: SqliteDb,
  row: {
    at: string;
    forge: string;
    origin?: string;
    owner?: string;
    name?: string;
    issueNumber?: number | null;
    delivery?: string;
    event?: string;
    action?: string;
    outcome: WebhookLogOutcome;
    reason: string;
    detail: string;
    title?: string;
    jobId?: number | null;
    senderId?: number | null;
    senderLogin?: string;
    installationId?: string;
  },
): number {
  const senderId =
    typeof row.senderId === "number" && Number.isInteger(row.senderId) && row.senderId > 0 ? row.senderId : null;
  const inserted = db
    .prepare(
      `INSERT INTO webhook_log (
         at, forge, origin, owner, name, issue_number, delivery, event, action,
         outcome, reason, detail, title, job_id, sender_id, sender_login, installation_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      row.at,
      row.forge,
      row.origin ?? "",
      (row.owner ?? "").slice(0, 200),
      (row.name ?? "").slice(0, 200),
      row.issueNumber ?? null,
      (row.delivery ?? "").slice(0, 80),
      (row.event ?? "").slice(0, 80),
      (row.action ?? "").slice(0, 80),
      row.outcome,
      row.reason.slice(0, 40),
      row.detail.slice(0, 500),
      (row.title ?? "").replace(/\s+/g, " ").trim().slice(0, 200),
      row.jobId ?? null,
      senderId,
      (row.senderLogin ?? "").replace(/\s+/g, " ").trim().slice(0, 80),
      (row.installationId ?? "").slice(0, 40),
    );
  pruneWebhookLog(db, row.outcome);
  return Number(inserted.lastInsertRowid);
}

function pruneWebhookLog(db: SqliteDb, outcome: WebhookLogOutcome): void {
  if (outcome === "rejected") {
    db.prepare(
      `DELETE FROM webhook_log
        WHERE outcome = 'rejected'
          AND id NOT IN (
            SELECT id FROM webhook_log WHERE outcome = 'rejected' ORDER BY id DESC LIMIT ?
          )`,
    ).run(WEBHOOK_REJECTED_KEEP);
    return;
  }
  db.prepare(
    `DELETE FROM webhook_log
      WHERE outcome != 'rejected'
        AND id NOT IN (
          SELECT id FROM webhook_log WHERE outcome != 'rejected' ORDER BY id DESC LIMIT ?
        )`,
  ).run(WEBHOOK_LOG_KEEP);
}

/** The operator asked to rewrite this delivery. Settle-on-read copies the job outcome later. */
export function queueWebhookLog(db: SqliteDb, id: number, jobId: number, detail: string): void {
  const text = detail.slice(0, 500);
  db.prepare(
    `UPDATE webhook_log SET outcome = 'queued', reason = 'forced', detail = ?, job_id = ? WHERE id = ?`,
  ).run(text, jobId, id);
  // Rows that already settled from this job would otherwise keep the old pill
  // after the same job is rewritten.
  db.prepare(
    `UPDATE webhook_log
        SET outcome = 'queued', reason = 'forced', detail = ?
      WHERE job_id = ? AND id != ?
        AND outcome IN ('agent-ready', 'needs-info', 'failed', 'skipped')`,
  ).run(text, jobId, id);
}

/** A queued row keeps that label forever unless we copy the finished job onto it. */
export function settleWebhookLogs(db: SqliteDb): void {
  db.prepare(
    `UPDATE webhook_log
        SET outcome = (SELECT j.outcome FROM issue_refine_jobs j WHERE j.id = webhook_log.job_id),
            reason = (SELECT j.outcome FROM issue_refine_jobs j WHERE j.id = webhook_log.job_id),
            detail = (
              SELECT COALESCE(NULLIF(j.why, ''), webhook_log.detail)
              FROM issue_refine_jobs j WHERE j.id = webhook_log.job_id
            )
      WHERE outcome = 'queued'
        AND job_id IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM issue_refine_jobs j
          WHERE j.id = webhook_log.job_id
            AND j.status IN ('done', 'failed')
            AND j.outcome IS NOT NULL
        )`,
  ).run();
}

export function listWebhookLogs(
  db: SqliteDb,
  limit = 80,
  repo?: { forge: string; owner: string; name: string; origin?: string },
  opts?: { hideIgnored?: boolean },
): WebhookLogEntry[] {
  settleWebhookLogs(db);
  const cap = Math.max(1, Math.min(limit, WEBHOOK_LOG_KEEP));
  const hidden = opts?.hideIgnored ? ` AND outcome != 'ignored'` : "";
  if (!repo) {
    return db
      .prepare(`SELECT ${WEBHOOK_LOG_COLUMNS} FROM webhook_log WHERE 1 = 1${hidden} ORDER BY id DESC LIMIT ?`)
      .all(cap) as WebhookLogEntry[];
  }
  return db
    .prepare(
      `SELECT ${WEBHOOK_LOG_COLUMNS} FROM webhook_log
        WHERE lower(forge) = lower(?)
          AND lower(owner) = lower(?)
          AND lower(name) = lower(?)
          AND lower(origin) = lower(?)
          ${hidden}
        ORDER BY id DESC LIMIT ?`,
    )
    .all(repo.forge, repo.owner, repo.name, repo.origin ?? "", cap) as WebhookLogEntry[];
}

/** The operator asked to analyze this issue again. Settle-on-read copies the new outcome later. */
export function requeueWebhookLogsForJob(db: SqliteDb, jobId: number, detail: string): void {
  db.prepare(
    `UPDATE webhook_log SET outcome = 'queued', reason = 'rerun', detail = ? WHERE job_id = ? AND outcome != 'rejected'`,
  ).run(detail.slice(0, 500), jobId);
}

export function getWebhookLog(db: SqliteDb, id: number): WebhookLogEntry | undefined {
  settleWebhookLogs(db);
  return db.prepare(`SELECT ${WEBHOOK_LOG_COLUMNS} FROM webhook_log WHERE id = ?`).get(id) as WebhookLogEntry | undefined;
}

export function recoverIssueRefineJobs(db: SqliteDb, at: string): number {
  const result = db
    .prepare(`UPDATE issue_refine_jobs SET status = 'pending', updated_at = ? WHERE status = 'running'`)
    .run(at);
  return result.changes;
}
