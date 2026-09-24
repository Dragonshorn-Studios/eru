import { opencodeChildEnv, outputTail, runChild } from "./proc.js";

export const ASK_MAX_QUESTION = 2000;
const MAX_OUTPUT = 4 * 1024 * 1024;

export interface OpenCodeOptions {
  bin: string;
  // A number for fixed timeouts, or a getter when the timeout can be
  // reconfigured at runtime (the /config page resolves it per call).
  timeoutMs: number | (() => number);
  model?: string;
}

export function opencodeTimeout(opts: Pick<OpenCodeOptions, "timeoutMs">): number {
  return typeof opts.timeoutMs === "function" ? opts.timeoutMs() : opts.timeoutMs;
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
            const child = await runChild(opts.bin, ["models"], {
              env: opencodeChildEnv(),
              timeoutMs: Math.min(opencodeTimeout(opts), 30_000),
              maxBuffer: MAX_OUTPUT,
            });
            if (child.code !== 0) throw new Error(outputTail(child.stderr, child.stdout) || `exit ${child.code}`);
            const models = [
              ...new Set(
                child.stdout
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
