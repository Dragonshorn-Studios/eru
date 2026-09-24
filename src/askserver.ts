import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { opencodeChildEnv } from "./proc.js";

/**
 * OpenCode `serve` supervisor (#33). Eru runs a single headless OpenCode server
 * on loopback, protected by a per-boot random basic-auth password. The browser
 * never talks to it directly — the /ask/oc proxy injects the credentials, so
 * no OpenCode port or credential is ever exposed beyond the Hono process.
 */

export interface OpenCodeServeOptions {
  bin: string;
  /** Picked at random per boot when omitted. */
  password?: string;
  hostname?: string;
  /** Fixed port for tests; a free loopback port is chosen when omitted. */
  port?: number;
  healthTimeoutMs?: number;
  maxRestarts?: number;
  spawnImpl?: typeof spawn;
  fetchImpl?: typeof fetch;
  log?: (msg: string) => void;
}

export interface OpenCodeServe {
  /** Base URL (e.g. http://127.0.0.1:4123), or null while the server is down. */
  url(): string | null;
  /** Basic-auth password for the upstream, never reachable from the browser. */
  password(): string;
  /** Start the server once; repeat calls share the same attempt. */
  ensure(): Promise<void>;
  stop(): Promise<void>;
}

const HEALTH_PATH = "/global/health";
const HEALTH_POLL_MS = 250;
const DEFAULT_HEALTH_TIMEOUT_MS = 15_000;
const RESTART_DELAY_MS = 1_000;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const address = srv.address();
      const port = typeof address === "object" && address ? address.port : 0;
      srv.close(() => (port > 0 ? resolve(port) : reject(new Error("no free port"))));
    });
  });
}

export function createOpenCodeServer(opts: OpenCodeServeOptions): OpenCodeServe {
  const spawnImpl = opts.spawnImpl ?? spawn;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const password = opts.password ?? randomBytes(24).toString("hex");
  const hostname = opts.hostname ?? "127.0.0.1";
  const healthTimeout = opts.healthTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS;
  const maxRestarts = opts.maxRestarts ?? 3;
  const log = opts.log ?? ((msg: string) => console.log(`ask server: ${msg}`));

  let child: ChildProcess | null = null;
  let port = 0;
  let starting: Promise<void> | null = null;
  let stopping = false;
  let restarts = 0;

  const basic = () => `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;

  async function waitHealthy(): Promise<void> {
    const deadline = Date.now() + healthTimeout;
    let lastErr = "";
    while (Date.now() < deadline) {
      try {
        // Per-request cap: a socket that accepts but never answers must not
        // stall the health loop past its deadline.
        const res = await fetchImpl(`http://${hostname}:${port}${HEALTH_PATH}`, {
          headers: { authorization: basic() },
          signal: AbortSignal.timeout(2_000),
        });
        if (res.ok) return;
        lastErr = `health ${res.status}`;
      } catch (err) {
        lastErr = err instanceof Error ? err.message : String(err);
      }
      await new Promise((r) => setTimeout(r, HEALTH_POLL_MS));
    }
    throw new Error(`opencode serve did not come up (${lastErr || "timeout"})`);
  }

  function onExit(code: number | null) {
    child = null;
    if (stopping) return;
    log(`opencode serve exited code=${code}`);
    if (restarts >= maxRestarts) {
      log(`not restarting — already restarted ${restarts} times`);
      return;
    }
    restarts++;
    log(`restarting opencode serve (attempt ${restarts}/${maxRestarts})`);
    setTimeout(() => {
      void launch().catch((err) => log(`restart failed: ${err instanceof Error ? err.message : err}`));
    }, RESTART_DELAY_MS);
  }

  async function launch(): Promise<void> {
    if (!port) {
      port = opts.port ?? (await freePort());
    }
    const spawned = spawnImpl(opts.bin, ["serve", "--hostname", hostname, "--port", String(port)], {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...opencodeChildEnv(),
        OPENCODE_SERVER_PASSWORD: password,
      },
    });
    child = spawned;
    spawned.stderr?.on("data", (chunk: Buffer) => {
      const line = chunk.toString("utf8").trim();
      if (line) log(`opencode: ${line.slice(-300)}`);
    });
    spawned.once("error", (err) => {
      log(`spawn failed: ${err.message}`);
      if (child === spawned) child = null;
    });
    spawned.once("exit", (code) => {
      if (child === spawned) onExit(code);
    });
    try {
      await waitHealthy();
    } catch (err) {
      // Detach before killing so the exit handler does not "restart" a
      // server that ensure() is about to report as failed.
      if (child === spawned) child = null;
      spawned.kill("SIGTERM");
      throw err;
    }
    log(`opencode serve up on http://${hostname}:${port}`);
  }

  return {
    url: () => (child ? `http://${hostname}:${port}` : null),
    password: () => password,
    ensure() {
      if (child) return Promise.resolve();
      if (!starting) {
        starting = launch()
          .catch((err) => {
            child = null;
            throw err instanceof Error ? err : new Error(String(err));
          })
          .finally(() => {
            starting = null;
          });
      }
      return starting;
    },
    async stop() {
      stopping = true;
      const current = child;
      child = null;
      if (!current) return;
      await new Promise<void>((resolve) => {
        const killer = setTimeout(() => {
          current.kill("SIGKILL");
          resolve();
        }, 2_000);
        current.once("exit", () => {
          clearTimeout(killer);
          resolve();
        });
        current.kill("SIGTERM");
      });
    },
  };
}
