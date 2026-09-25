import { spawn } from "node:child_process";

export type ChildResult = {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
};

// `opencode run` reads stdin whenever it is not a TTY (Bun.stdin.text()).
// execFile leaves its piped stdin open, so the child blocks on an EOF that
// never arrives and is later killed by the timeout — with empty stdout and
// stderr, which is why failures only ever logged "Command failed". Piping
// stdin and ending it immediately is a clean EOF: the run proceeds on the
// argv prompt. Mirrors maomao's opencode spawn.
export function runChild(
  bin: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs: number; maxBuffer?: number },
): Promise<ChildResult> {
  const started = Date.now();
  const limit = opts.maxBuffer ?? 4 * 1024 * 1024;
  return new Promise((resolve, reject) => {
    // cwd changes the child's real working directory but not the inherited
    // env: PWD/INIT_CWD would keep naming Eru's own launch directory (the eru
    // checkout under npm run dev) for anything that resolves paths via env.
    const env = opts.cwd ? { ...(opts.env ?? process.env), PWD: opts.cwd, INIT_CWD: opts.cwd } : opts.env;
    const child = spawn(bin, args, { cwd: opts.cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    child.stdin?.end();
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let overflow = false;
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      if (!overflow && stdout.length > limit) overflow = true;
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    const finish = (code: number | null) => {
      resolve({
        code: overflow ? 1 : (code ?? 1),
        stdout: overflow ? stdout.slice(0, limit) : stdout,
        stderr: overflow ? `${stderr} [stdout exceeded ${limit} bytes]` : stderr,
        timedOut,
        durationMs: Date.now() - started,
      });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
      // Resolve now — a grandchild holding the pipes would otherwise delay
      // `close` (a wrapper's `sleep` outlives a killed `sh`, for example).
      finish(null);
    }, opts.timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (!timedOut) finish(code);
    });
  });
}

// The tail of child output is the real reason a run died (bad model, missing
// provider key); compact it for logs and operator notices.
export function outputTail(...texts: string[]): string {
  const text = texts.find((s) => s.trim().length > 0) ?? "";
  return text.trim().replace(/\s+/g, " ").slice(-400);
}

export function opencodeChildEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    TERM: "dumb",
    OPENCODE_DISABLE_AUTOUPDATE: "true",
    OPENCODE_DISABLE_DEFAULT_PLUGINS: "true",
    OPENCODE_DISABLE_CLAUDE_CODE: "true",
  };
}
