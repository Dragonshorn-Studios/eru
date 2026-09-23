// Temporary showcase seed — creates a repo + plausible map pages in the SQLite DB.
import Database from "better-sqlite3";

const dbPath = process.argv[2] || "./data/eru.sqlite";
const db = new Database(dbPath);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

const now = new Date().toISOString();
const repo = db
  .prepare(
    `INSERT INTO repos (forge, owner, name, last_mapped_ref, last_mapped_at, connected_at, created_at)
     VALUES ('github', 'dragonshorn-studios', 'eru', 'main', ?, ?, ?)
     ON CONFLICT (forge, owner, name) DO UPDATE SET
       last_mapped_ref = 'main', last_mapped_at = excluded.last_mapped_at, connected_at = excluded.connected_at
     RETURNING id`,
  )
  .get(now, now, now);

const pages = [
  {
    slug: "architecture",
    title: "Architecture",
    sort_order: 0,
    body: `Eru is a small self-hosted service that keeps a durable map of one repository. A Hono server serves the operator UI over plain HTML + htmx; there is no client-side framework to build.

State lives in SQLite via better-sqlite3. Three tables matter: repos (forge identity and last mapped ref), forge_credentials (tokens encrypted at rest), and pages (the Brief map itself, ordered by sort_order).

OpenCode does the actual reading of the checkout. Refresh downloads a tarball of the repo at a ref, extracts it to a temp dir, and asks OpenCode for map pages; results are upserted transactionally.`,
  },
  {
    slug: "auth-and-sessions",
    title: "Auth & sessions",
    sort_order: 1,
    body: `The UI sits behind a single shared operator password. Logging in issues an HMAC-signed session cookie (SESSION_TTL_MS) that every non-public route checks in middleware.

Sessions carry a CSRF token. Mutating requests must echo it either as the hidden form field or the CSRF header; mismatches fail closed with 403. Login attempts are rate limited per client key.

Secrets never reach logs: the forge token is encrypted before it touches forge_credentials, and decrypt tries every configured key so rotation stays safe.`,
  },
  {
    slug: "storage",
    title: "Storage",
    sort_order: 2,
    body: `All durable state is one SQLite file at ERU_SQLITE_PATH, opened with WAL journaling, foreign keys on, and a 5s busy timeout.

Migrations are recorded in schema_migrations. The init schema creates repos, forge_credentials, and pages; a later migration adds repos.connected_at for databases created before forge connect landed.

Pages are upserted per (repo_id, slug). Refresh writes every returned page and then stamps last_mapped_ref / last_mapped_at on the repo inside the same transaction.`,
  },
  {
    slug: "forge-integration",
    title: "Forge integration",
    sort_order: 3,
    body: `Connect verifies owner/repo against the GitHub API with the supplied token, then stores the credential encrypted under the forge key (falling back to the session secret).

Refresh fetches a codeload tarball for the ref — anonymous when no credential is stored, so public repos work token-free. Tarball errors map to operator-facing notices: not found, auth, unreachable, too big.

The extracted checkout lands in a temp dir that is always removed after the run, whether the map succeeded or not.`,
  },
  {
    slug: "build-and-ops",
    title: "Build & ops",
    sort_order: 4,
    body: `The build is tsc plus a small copy-assets step that stages htmx into dist. The server runs from dist/index.js and reads all configuration from ERU_* environment variables.

Required env: ERU_UI_PASSWORD (shared operator password) and ERU_UI_SESSION_SECRET (16+ chars). ERU_OPENCODE_BIN points at the OpenCode binary used by Ask and Refresh; a missing or failing binary fails closed with an operator notice.

A compose.yaml and Dockerfile are provided for self-hosting; /health is the liveness endpoint.`,
  },
];

const upsert = db.prepare(
  `INSERT INTO pages (repo_id, slug, title, body, sort_order, mapped_ref, updated_at)
   VALUES (?, ?, ?, ?, ?, 'main', ?)
   ON CONFLICT (repo_id, slug) DO UPDATE SET
     title = excluded.title, body = excluded.body, sort_order = excluded.sort_order,
     mapped_ref = excluded.mapped_ref, updated_at = excluded.updated_at`,
);

for (const p of pages) {
  upsert.run(repo.id, p.slug, p.title, p.body, p.sort_order, now);
}

console.log(`seeded repo id=${repo.id} with ${pages.length} pages at ${dbPath}`);
db.close();
