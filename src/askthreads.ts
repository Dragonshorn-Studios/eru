import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { listAllPages, type MapPage, type SqliteDb } from "./db.js";

/**
 * Ask threads (#33). Each Eru thread owns an isolated workspace containing
 * only a snapshot of the repo's durable map (`map/<slug>.md`) and a
 * deny-by-default `opencode.json`; the repository checkout is never mounted.
 * Only reconnect metadata lives in SQLite — the workspace is the snapshot.
 */

export interface AskThread {
  id: string;
  repoId: number;
  sessionId: string | null;
  title: string;
  /** The map ref this thread's workspace was materialized from. */
  mappedRef: string | null;
  createdAt: string;
  updatedAt: string;
}

const ASK_AGENT_NAME = "eru-ask";

const ASK_SYSTEM_PROMPT = `You are Eru, answering questions about one software repository.

The repository's durable map lives in ./map/*.md — notes from an earlier mapping pass. Read the relevant pages with glob/grep/read before answering.

- Answer in Markdown. Cite the map pages you used as \`map/<slug>.md\` paths. Cite repository file paths only as they appear inside map pages.
- There is no checkout here: ./map is the only source. Do not invent file paths, symbols, or behavior.
- If the map does not cover the question, say exactly what is missing and suggest refreshing the map — never guess from outside knowledge.
- Never repeat environment variables, credentials, cookies, or secrets in an answer.`;

// Deny-by-default workspace config: only read/glob/grep survive, every other
// tool — bash, edit, write, webfetch, task, … — is refused outright (never
// "ask", so nothing stalls waiting on interactive approval).
export const ASK_WORKSPACE_CONFIG = {
  $schema: "https://opencode.ai/config.json",
  share: "disabled",
  snapshot: false,
  permission: {
    "*": "deny",
    read: "allow",
    glob: "allow",
    grep: "allow",
    external_directory: "deny",
  },
  agent: {
    [ASK_AGENT_NAME]: {
      mode: "primary",
      description: "Answers questions from the repository's Eru map only",
      prompt: ASK_SYSTEM_PROMPT,
      tools: { "*": false, read: true, glob: true, grep: true },
      permission: {
        "*": "deny",
        read: "allow",
        glob: "allow",
        grep: "allow",
        bash: "deny",
        edit: "deny",
        write: "deny",
        webfetch: "deny",
        external_directory: "deny",
      },
    },
  },
} as const;

export const ASK_AGENT = ASK_AGENT_NAME;

export function askWorkspaceRoot(sqlitePath: string, workdir?: string): string {
  if (workdir) return workdir;
  return sqlitePath === ":memory:" ? join(process.cwd(), "data", "ask") : join(dirname(sqlitePath), "ask");
}

export function threadWorkspace(workdir: string, threadId: string): string {
  return join(workdir, threadId);
}

function pageFile(slug: string): string {
  return slug.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "page";
}

// The workspace is a snapshot: slug-named map pages, the deny config, and the
// agent prompt. Slug collisions get a numeric suffix, matching the old runner.
export async function materializeWorkspace(workdir: string, threadId: string, pages: MapPage[]): Promise<string> {
  const dir = threadWorkspace(workdir, threadId);
  const mapDir = join(dir, "map");
  await mkdir(mapDir, { recursive: true });
  const used = new Set<string>();
  for (const page of pages) {
    const base = pageFile(page.slug);
    let file = base;
    for (let n = 2; used.has(file); n++) file = `${base}-${n}`;
    used.add(file);
    const front = `---\nslug: ${page.slug}\ntitle: ${page.title.replace(/\n/g, " ")}\n---\n\n`;
    await writeFile(join(mapDir, `${file}.md`), `${front}# ${page.title}\n\n${page.body}\n`);
  }
  await writeFile(join(dir, "opencode.json"), JSON.stringify(ASK_WORKSPACE_CONFIG, null, 2) + "\n");
  await writeFile(join(dir, "AGENTS.md"), `${ASK_SYSTEM_PROMPT}\n`);
  await markWorkspaceRoot(dir);
  return dir;
}

// The workspace lives under <data>/ask, which can sit inside a git checkout
// (the dev repo layout). OpenCode discovers its project by walking up to the
// nearest .git, so without a marker the session binds to *that* repo — its
// AGENTS.md and file context leak in, and Ask ends up analysing Eru itself.
// A minimal valid .git skeleton makes the workspace its own project root;
// no git binary is needed.
export async function markWorkspaceRoot(dir: string): Promise<void> {
  const gitDir = join(dir, ".git");
  await mkdir(join(gitDir, "objects"), { recursive: true });
  await mkdir(join(gitDir, "refs"), { recursive: true });
  await writeFile(join(gitDir, "HEAD"), "ref: refs/heads/main\n", { flag: "wx" }).catch(() => {});
  await writeFile(join(gitDir, "config"), "[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tbare = false\n", { flag: "wx" }).catch(() => {});
}

interface ThreadRow {
  id: string;
  repo_id: number;
  session_id: string | null;
  title: string;
  mapped_ref: string | null;
  created_at: string;
  updated_at: string;
}

function toThread(row: ThreadRow): AskThread {
  return {
    id: row.id,
    repoId: row.repo_id,
    sessionId: row.session_id,
    title: row.title,
    mappedRef: row.mapped_ref,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function getThread(db: SqliteDb, id: string): AskThread | undefined {
  const row = db
    .prepare(`SELECT id, repo_id, session_id, title, mapped_ref, created_at, updated_at FROM ask_threads WHERE id = ?`)
    .get(id) as ThreadRow | undefined;
  return row ? toThread(row) : undefined;
}

export function listThreads(db: SqliteDb, repoId: number): AskThread[] {
  const rows = db
    .prepare(
      `SELECT id, repo_id, session_id, title, mapped_ref, created_at, updated_at
       FROM ask_threads WHERE repo_id = ? ORDER BY updated_at DESC, created_at DESC`,
    )
    .all(repoId) as ThreadRow[];
  return rows.map(toThread);
}

export function insertThread(db: SqliteDb, repoId: number, mappedRef: string | null, at: string): AskThread {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO ask_threads (id, repo_id, session_id, title, mapped_ref, created_at, updated_at)
     VALUES (?, ?, NULL, '', ?, ?, ?)`,
  ).run(id, repoId, mappedRef, at, at);
  return { id, repoId, sessionId: null, title: "", mappedRef, createdAt: at, updatedAt: at };
}

export function setThreadSession(db: SqliteDb, id: string, sessionId: string, at: string): void {
  db.prepare(`UPDATE ask_threads SET session_id = ?, updated_at = ? WHERE id = ?`).run(sessionId, at, id);
}

export function renameThread(db: SqliteDb, id: string, title: string, at: string): void {
  db.prepare(`UPDATE ask_threads SET title = ?, updated_at = ? WHERE id = ?`).run(title, at, id);
}

export function touchThread(db: SqliteDb, id: string, at: string): void {
  db.prepare(`UPDATE ask_threads SET updated_at = ? WHERE id = ?`).run(at, id);
}

export function setThreadMappedRef(db: SqliteDb, id: string, mappedRef: string | null, at: string): void {
  db.prepare(`UPDATE ask_threads SET mapped_ref = ?, updated_at = ? WHERE id = ?`).run(mappedRef, at, id);
}

export function deleteThreadRow(db: SqliteDb, id: string): boolean {
  return db.prepare(`DELETE FROM ask_threads WHERE id = ?`).run(id).changes > 0;
}

// A thread is stale once the repo's map moved past the snapshot its workspace
// was materialized from — the conversation stays valid, it is just behind.
export function threadStale(thread: AskThread, lastMappedRef: string | null): boolean {
  return thread.mappedRef !== lastMappedRef;
}

// Workspaces are re-materializable caches of a map snapshot. When a thread's
// directory is gone (workdir was wiped), rebuild it from the repo's *current*
// pages and re-point mapped_ref so the marker still describes what's on disk.
export async function ensureWorkspace(db: SqliteDb, workdir: string, thread: AskThread, at: string): Promise<string> {
  const dir = threadWorkspace(workdir, thread.id);
  if (existsSync(dir)) {
    // Self-heal workspaces written before the project-root marker existed.
    if (!existsSync(join(dir, ".git", "HEAD"))) await markWorkspaceRoot(dir).catch(() => {});
    return dir;
  }
  const repo = db.prepare(`SELECT last_mapped_ref FROM repos WHERE id = ?`).get(thread.repoId) as
    | { last_mapped_ref: string | null }
    | undefined;
  const mappedRef = repo?.last_mapped_ref ?? null;
  await materializeWorkspace(workdir, thread.id, listAllPages(db, thread.repoId));
  if (mappedRef !== thread.mappedRef) setThreadMappedRef(db, thread.id, mappedRef, at);
  return dir;
}

// Boot sweep: drop workspace directories whose thread row is gone (deleted
// thread, crashed cleanup). Rows without directories self-heal lazily via
// ensureWorkspace, so nothing else is needed here.
export async function sweepWorkspaces(db: SqliteDb, workdir: string): Promise<number> {
  let entries: string[];
  try {
    entries = await readdir(workdir);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const entry of entries) {
    if (!/^[0-9a-f-]{36}$/i.test(entry)) continue;
    if (!getThread(db, entry)) {
      await rm(join(workdir, entry), { recursive: true, force: true }).catch(() => {});
      removed++;
    }
  }
  return removed;
}
