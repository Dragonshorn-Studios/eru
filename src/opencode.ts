import { opencodeChildEnv, outputTail, runChild, type ChildResult } from "./proc.js";

export const ASK_MAX_QUESTION = 2000;
const MAX_OUTPUT = 4 * 1024 * 1024;

export interface OpenCodeOptions {
  bin: string;
  // A number for fixed timeouts, or a getter when the timeout can be
  // reconfigured at runtime (the /config page resolves it per call).
  timeoutMs: number | (() => number);
  model?: string | (() => string | undefined);
}

export function opencodeTimeout(opts: Pick<OpenCodeOptions, "timeoutMs">): number {
  return typeof opts.timeoutMs === "function" ? opts.timeoutMs() : opts.timeoutMs;
}

export function opencodeModel(opts: Pick<OpenCodeOptions, "model">): string | undefined {
  return typeof opts.model === "function" ? opts.model() : opts.model;
}

/** 1.x has no `--standalone`. 2.x rejects a shared service unless that flag is on `run`. */
export type OpenCodeGeneration = 1 | 2;

export interface OpenCodeVersion {
  generation: OpenCodeGeneration;
  version: string;
}

const generationCache = new Map<string, OpenCodeGeneration>();

/** Test hook. Detection is cached for the process so map runs do not re-probe. */
export function clearOpenCodeGenerationCache(): void {
  generationCache.clear();
}

/**
 * Accept only a version line (`1.2.3`, `opencode 2.0.0`). Help pages mention
 * other numbers and must not decide the generation.
 */
export function parseOpenCodeVersion(text: string): OpenCodeVersion | undefined {
  for (const line of text.split(/\r?\n/)) {
    const match = line.trim().match(/^(?:opencode\s+)?v?(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?$/i);
    if (!match) continue;
    const major = Number(match[1]);
    const version = `${match[1]}.${match[2]}.${match[3]}`;
    if (major >= 2) return { generation: 2, version };
    if (major === 0 || major === 1) return { generation: 1, version };
  }
  return undefined;
}

/**
 * 1.x: `opencode run [-m model] -- prompt`.
 * 2.x: `opencode run --standalone [-m model] -- prompt`.
 * `--standalone` before `run` is the default TUI and exits with command help.
 * `--` keeps the prompt from being swallowed as flags.
 */
export function opencodeRunArgs(prompt: string, model: string | undefined, generation: OpenCodeGeneration): string[] {
  const args = ["run"];
  if (generation === 2) args.push("--standalone");
  if (model) args.push("-m", model);
  args.push("--", prompt);
  return args;
}

export function opencodeModelsArgs(generation: OpenCodeGeneration): string[] {
  return generation === 2 ? ["models", "--standalone"] : ["models"];
}

type Probe = typeof runChild;

async function probeGeneration(bin: string, run: Probe, timeoutMs: number): Promise<OpenCodeGeneration> {
  const cached = generationCache.get(bin);
  if (cached) return cached;
  const limits = { env: opencodeChildEnv(), timeoutMs, maxBuffer: 256_000 };
  try {
    const version = await run(bin, ["--version"], limits);
    if (!version.timedOut) {
      const parsed = parseOpenCodeVersion(`${version.stdout}\n${version.stderr}`);
      if (parsed) {
        generationCache.set(bin, parsed.generation);
        console.log(`opencode: ${bin} is ${parsed.version} (${parsed.generation}.x)`);
        return parsed.generation;
      }
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") throw err;
  }
  try {
    const help = await run(bin, ["run", "--help"], limits);
    if (!help.timedOut) {
      const generation: OpenCodeGeneration = /(?:^|\s)--standalone(?:\s|$)/.test(`${help.stdout}\n${help.stderr}`) ? 2 : 1;
      generationCache.set(bin, generation);
      console.log(`opencode: ${bin} detected as ${generation}.x from run --help`);
      return generation;
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") throw err;
  }
  return 1;
}

export async function detectOpenCodeGeneration(bin: string, timeoutMs = 8_000, run: Probe = runChild): Promise<OpenCodeGeneration> {
  return probeGeneration(bin, run, timeoutMs);
}

/** Run a prompt. If the chosen generation prints CLI help, try the other once. */
export async function runOpenCode(
  input: {
    bin: string;
    prompt: string;
    model?: string;
    cwd?: string;
    timeoutMs: number;
    maxBuffer?: number;
  },
  run: Probe = runChild,
): Promise<ChildResult> {
  const probeTimeout = Math.min(input.timeoutMs, 8_000);
  let generation = await probeGeneration(input.bin, run, probeTimeout);
  const once = (gen: OpenCodeGeneration) =>
    run(input.bin, opencodeRunArgs(input.prompt, input.model, gen), {
      cwd: input.cwd,
      env: opencodeChildEnv(),
      timeoutMs: input.timeoutMs,
      maxBuffer: input.maxBuffer,
    });
  const first = await once(generation);
  const dumped = `${first.stderr}\n${first.stdout}`;
  if (first.code === 0 || first.timedOut || !isCliHelpDump(dumped)) return first;
  const flipped: OpenCodeGeneration = generation === 2 ? 1 : 2;
  console.log(`opencode: ${generation}.x run printed command help, retrying as ${flipped}.x`);
  generationCache.set(input.bin, flipped);
  return once(flipped);
}

/** Yargs help is not an operator-facing reason. */
export function isCliHelpDump(text: string): boolean {
  const flat = text.replace(/\s+/g, " ");
  return /--[a-z0-9-]+/.test(flat) && /\[(boolean|number|string|count)\]/.test(flat);
}

/** OC2 JSON envelopes wrap the payload in `{ data }`. OC1 returned the value directly. */
export function unwrapOcData<T>(body: unknown): T {
  if (body && typeof body === "object" && "data" in body) {
    const data = (body as { data: unknown }).data;
    if (data !== undefined && data !== null) return data as T;
  }
  return body as T;
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
            const generation = await detectOpenCodeGeneration(opts.bin, Math.min(opencodeTimeout(opts), 8_000));
            const child = await runChild(opts.bin, opencodeModelsArgs(generation), {
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
