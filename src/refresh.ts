import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { opencodeTimeout, type OpenCodeOptions } from "./opencode.js";
import { opencodeChildEnv, outputTail, runChild } from "./proc.js";
import { markWorkspaceRoot } from "./util.js";

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
export type RefreshResult = { ok: true; pages: MappedPageDraft[] } | { ok: false; error: RefreshError; detail?: string };

export type RefreshRunner = (workdir: string, repoLabel: string, ref: string, model?: string) => Promise<RefreshResult>;

export function isValidMapRef(ref: string): boolean {
  return MAP_REF_RE.test(ref) && !ref.includes("..");
}

// Refresh runs OpenCode read-only inside the extracted checkout: the same
// deny-everything permission file as Ask, and the map comes back as JSON on
// stdout which we validate before it ever touches SQLite.
export function createMapRefresher(opts: OpenCodeOptions): RefreshRunner {
  return async (workdir, repoLabel, ref, model) => {
    try {
      await writeFile(
        join(workdir, "opencode.json"),
        JSON.stringify({
          permission: { "*": "deny", read: "allow", glob: "allow", grep: "allow" },
        }),
      );
      // The tarball has no .git; OpenCode would otherwise root its project at
      // the nearest .git ancestor of the temp dir and map that repo instead.
      await markWorkspaceRoot(workdir);
      const args = ["run", "--format", "default"];
      const runModel = model ?? opts.model;
      if (runModel) args.push("-m", runModel);
      // `--` guards the prompt: opencode args are yargs-parsed and array
      // options can otherwise swallow a trailing positional (maomao learned
      // this with --file).
      args.push("--", refreshPrompt(repoLabel, ref));
      const timeoutMs = opencodeTimeout(opts);
      console.log(`refresh ${repoLabel} @${ref}: OpenCode run starting (model=${runModel ?? "default"}, timeout=${timeoutMs}ms)`);
      const child = await runChild(opts.bin, args, {
        cwd: workdir,
        env: opencodeChildEnv(),
        timeoutMs,
        maxBuffer: MAX_OUTPUT,
      });
      console.log(`refresh ${repoLabel} @${ref}: exit=${child.code} in ${Math.round(child.durationMs / 1000)}s`);
      if (child.timedOut) {
        const detail = `timed out after ${timeoutMs}ms`;
        console.log(`refresh ${repoLabel}: ${detail}`, outputTail(child.stderr, child.stdout));
        return { ok: false, error: "failed", detail };
      }
      if (child.code !== 0) {
        const detail = outputTail(child.stderr, child.stdout);
        console.log(`refresh ${repoLabel}: OpenCode exited ${child.code} —`, detail || "(no output)");
        return { ok: false, error: "failed", detail };
      }
      const pages = parseMapPages(child.stdout);
      if (!pages || pages.length === 0) {
        const detail = outputTail(child.stdout);
        console.log(`refresh ${repoLabel}: OpenCode returned no map —`, detail || "(empty output)");
        return { ok: false, error: "nomap", detail };
      }
      return { ok: true, pages };
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      // ENOENT from the spawn itself means the binary is missing; ENOENT from
      // the fs writes above is a workdir problem and must not mislabel it.
      if (e.code === "ENOENT" && (e.syscall ?? "").startsWith("spawn")) {
        return { ok: false, error: "unconfigured" };
      }
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`refresh ${repoLabel}: runner error —`, msg);
      return { ok: false, error: "failed", detail: msg };
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
