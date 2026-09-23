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

export type AskRunner = (question: string, pages: AskPage[], repoLabel: string, model?: string) => Promise<AskResult>;

export interface OpenCodeOptions {
  bin: string;
  timeoutMs: number;
  model?: string;
}

// Ask runs in a throwaway directory: the map is materialized as plain files and
// opencode.json denies every tool except read/glob/grep (never bash, edit,
// write, or webfetch), so the model can only read the map and answer.
export function createOpenCodeRunner(opts: OpenCodeOptions): AskRunner {
  return async (question, pages, repoLabel, model) => {
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
      const runModel = model ?? opts.model;
      if (runModel) args.push("-m", runModel);
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

export interface ModelSnapshot {
  models: string[];
  error?: string;
  updatedAt?: string;
}

export interface ModelDiscovery {
  snapshot(): ModelSnapshot;
  refresh(): Promise<void>;
}

const MODEL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;

export function isValidModelName(model: string): boolean {
  return MODEL_NAME_RE.test(model);
}

// `opencode models` lists one provider/model per line for providers it
// considers configured. Discovery caches the list, shares one child process
// between concurrent refreshes, and never rejects — a failed refresh keeps the
// previous list and records the error on the snapshot.
export function createModelDiscovery(opts: Pick<OpenCodeOptions, "bin" | "timeoutMs">): ModelDiscovery {
  let snap: ModelSnapshot = { models: [] };
  let inflight: Promise<void> | null = null;
  return {
    snapshot: () => snap,
    refresh() {
      if (!inflight) {
        inflight = (async () => {
          try {
            const { stdout } = await execFileP(opts.bin, ["models"], {
              timeout: Math.min(opts.timeoutMs, 30_000),
              maxBuffer: MAX_OUTPUT,
            });
            const models = [
              ...new Set(
                stdout
                  .split("\n")
                  .map((line) => line.trim().split(/\s+/)[0])
                  .filter((token) => MODEL_NAME_RE.test(token)),
              ),
            ].sort();
            snap = { models, updatedAt: new Date().toISOString() };
          } catch (err) {
            snap = { ...snap, error: err instanceof Error ? err.message : String(err) };
          } finally {
            inflight = null;
          }
        })();
      }
      return inflight;
    },
  };
}
