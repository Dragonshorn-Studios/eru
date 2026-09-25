import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function parseInteger(raw: string | undefined, fallback: number): number {
  if (raw == null || raw.trim() === "") return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) {
    throw new Error(`invalid integer: ${raw}`);
  }
  return n;
}

export function parseBooleanEnv(value: string | undefined): boolean {
  return value !== undefined && ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

// A directory handed to OpenCode can sit inside a git checkout (a dev repo
// layout, a TMPDIR under a repo). OpenCode discovers its project by walking
// up to the nearest .git, so without a marker the session binds to *that*
// repo — its AGENTS.md and file context leak in and the model reads the
// wrong codebase. A minimal valid .git skeleton makes the directory its own
// project root; no git binary is needed.
export async function markWorkspaceRoot(dir: string): Promise<void> {
  const gitDir = join(dir, ".git");
  await mkdir(join(gitDir, "objects"), { recursive: true });
  await mkdir(join(gitDir, "refs"), { recursive: true });
  // wx re-marking expects EEXIST; anything else (EACCES, ENOSPC, EROFS)
  // would leave a partial .git that silently loses to the parent repo.
  const writeOnce = (path: string, body: string) =>
    writeFile(path, body, { flag: "wx" }).catch((err) => {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    });
  await writeOnce(join(gitDir, "HEAD"), "ref: refs/heads/main\n");
  await writeOnce(join(gitDir, "config"), "[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tbare = false\n");
}
