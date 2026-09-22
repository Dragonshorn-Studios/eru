import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

export const ASK_MAX_QUESTION = 2000;
const MAX_OUTPUT = 4 * 1024 * 1024;

export type AskError = "unconfigured" | "failed";
export type AskResult = { ok: true; answer: string } | { ok: false; error: AskError };

export interface AskPage {
  slug: string;
  title: string;
  body: string;
}

export type AskRunner = (question: string, pages: AskPage[], repoLabel: string) => Promise<AskResult>;

export interface OpenCodeOptions {
  bin: string;
  timeoutMs: number;
  model?: string;
}

// Ask runs in a throwaway directory: the map is materialized as plain files and
// opencode.json denies every tool except read/glob/grep (never bash, edit,
// write, or webfetch), so the model can only read the map and answer.
export function createOpenCodeRunner(opts: OpenCodeOptions): AskRunner {
  return async (question, pages, repoLabel) => {
    const workdir = await mkdtemp(join(tmpdir(), "eru-ask-"));
    try {
      await writeFile(
        join(workdir, "opencode.json"),
        JSON.stringify({
          permission: { "*": "deny", read: "allow", glob: "allow", grep: "allow" },
        }),
      );
      const mapDir = join(workdir, "map");
      await mkdir(mapDir);
      const used = new Set<string>();
      for (const page of pages) {
        const base = pageFile(page.slug);
        let file = base;
        for (let n = 2; used.has(file); n++) file = `${base}-${n}`;
        used.add(file);
        await writeFile(join(mapDir, `${file}.md`), `# ${page.title}\n\n${page.body}\n`);
      }
      const args = ["run", "--format", "default"];
      if (opts.model) args.push("-m", opts.model);
      args.push(prompt(repoLabel, question));
      const { stdout } = await execFileP(opts.bin, args, {
        cwd: workdir,
        timeout: opts.timeoutMs,
        maxBuffer: MAX_OUTPUT,
      });
      return { ok: true, answer: stdout.trim() };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return { ok: false, error: "unconfigured" };
      console.log("ask runner failed:", err instanceof Error ? err.message : err);
      return { ok: false, error: "failed" };
    } finally {
      await rm(workdir, { recursive: true, force: true }).catch(() => {});
    }
  };
}

function pageFile(slug: string): string {
  return slug.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "page";
}

function prompt(repoLabel: string, question: string): string {
  return [
    `You are Eru answering a question about the repository ${repoLabel}.`,
    "The repo's map (durable notes about the codebase) is in ./map/*.md — read those files first.",
    'Answer concisely in plain text. Cite the map paths you used, e.g. "map/auth.md".',
    "If the map does not cover the question, say what is missing instead of guessing.",
    "",
    `Question: ${question}`,
  ].join("\n");
}
