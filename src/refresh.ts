import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { OpenCodeOptions } from "./opencode.js";

const execFileP = promisify(execFile);

export const MAX_MAP_PAGES = 40;
const MAX_PAGE_BODY = 60_000;
const MAX_OUTPUT = 8 * 1024 * 1024;
const TAR_TIMEOUT_MS = 60_000;

// Branch/tag/SHA characters; anything outside this set or containing ".." is refused.
export const MAP_REF_RE = /^[A-Za-z0-9][A-Za-z0-9._\/-]{0,199}$/;

export interface MappedPageDraft {
  slug: string;
  title: string;
  body: string;
  sortOrder: number;
}

export type RefreshError = "unconfigured" | "failed" | "nomap";
export type RefreshResult = { ok: true; pages: MappedPageDraft[] } | { ok: false; error: RefreshError };

export type RefreshRunner = (workdir: string, repoLabel: string, ref: string) => Promise<RefreshResult>;

export function isValidMapRef(ref: string): boolean {
  return MAP_REF_RE.test(ref) && !ref.includes("..");
}

// Refresh runs OpenCode read-only inside the extracted checkout: the same
// deny-everything permission file as Ask, and the map comes back as JSON on
// stdout which we validate before it ever touches SQLite.
export function createMapRefresher(opts: OpenCodeOptions): RefreshRunner {
  return async (workdir, repoLabel, ref) => {
    try {
      await writeFile(
        join(workdir, "opencode.json"),
        JSON.stringify({
          permission: { "*": "deny", read: "allow", glob: "allow", grep: "allow" },
        }),
      );
      const args = ["run", "--format", "default"];
      if (opts.model) args.push("-m", opts.model);
      args.push(refreshPrompt(repoLabel, ref));
      const { stdout } = await execFileP(opts.bin, args, {
        cwd: workdir,
        timeout: opts.timeoutMs,
        maxBuffer: MAX_OUTPUT,
      });
      const pages = parseMapPages(stdout);
      if (!pages || pages.length === 0) return { ok: false, error: "nomap" };
      return { ok: true, pages };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return { ok: false, error: "unconfigured" };
      return { ok: false, error: "failed" };
    }
  };
}

export async function extractTarball(data: Buffer, destDir: string): Promise<void> {
  const archive = join(destDir, "checkout.tar.gz");
  const target = join(destDir, "checkout");
  await mkdir(target);
  await writeFile(archive, data);
  await execFileP("tar", ["-xzf", archive, "-C", target, "--strip-components=1"], { timeout: TAR_TIMEOUT_MS });
}

// Model output is untrusted: strict shape, bounded sizes, sanitized slugs.
export function parseMapPages(stdout: string): MappedPageDraft[] | null {
  let text = stdout.trim();
  const fenced = text.match(/```(?:json)?\s*(\[[\s\S]*\])\s*```/);
  if (fenced) text = fenced[1];
  else {
    const start = text.indexOf("[");
    const end = text.lastIndexOf("]");
    if (start === -1 || end <= start) return null;
    text = text.slice(start, end + 1);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!Array.isArray(raw)) return null;

  const pages: MappedPageDraft[] = [];
  const seen = new Set<string>();
  for (const entry of raw.slice(0, MAX_MAP_PAGES)) {
    if (typeof entry !== "object" || entry === null) continue;
    const { slug, title, body, sortOrder } = entry as Record<string, unknown>;
    if (typeof slug !== "string" || typeof title !== "string" || typeof body !== "string") continue;
    const cleanSlug = slug
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64);
    const cleanTitle = title.trim().slice(0, 200);
    const cleanBody = body.slice(0, MAX_PAGE_BODY);
    if (!cleanSlug || !cleanTitle || !cleanBody.trim() || seen.has(cleanSlug)) continue;
    seen.add(cleanSlug);
    pages.push({
      slug: cleanSlug,
      title: cleanTitle,
      body: cleanBody,
      sortOrder:
        typeof sortOrder === "number" && Number.isFinite(sortOrder)
          ? Math.max(0, Math.trunc(sortOrder))
          : pages.length,
    });
  }
  return pages;
}

function refreshPrompt(repoLabel: string, ref: string): string {
  return [
    `You are Eru mapping the repository ${repoLabel} at ref ${ref}.`,
    "This directory is the repo checkout. Read source files only.",
    "Produce the durable map: a JSON array of pages, each {\"slug\", \"title\", \"body\", \"sortOrder\"}.",
    '- slug: lowercase letters/digits/hyphens, <=64 chars (e.g. "auth-flow")',
    "- title: short page title",
    "- body: markdown notes about that part of the codebase, citing real file paths",
    "- sortOrder: integer reading order starting at 0",
    "Write 4-12 pages covering architecture, entry points, data/storage, auth/security, external deps, build/test ops.",
    "Output ONLY the JSON array — no prose, no fences.",
  ].join("\n");
}
