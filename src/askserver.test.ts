import { EventEmitter } from "node:events";
import type { ChildProcess, spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { createOpenCodeServer } from "./askserver.js";

function stubChild(): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  child.stderr = new EventEmitter() as ChildProcess["stderr"];
  child.kill = () => {
    child.emit("exit", 0);
    return true;
  };
  return child;
}

const spawnStub = (() => stubChild()) as unknown as typeof spawn;

describe("opencode serve health probe", () => {
  it("treats /api/health as ready even when /global/health is 404", async () => {
    const paths: string[] = [];
    const server = createOpenCodeServer({
      bin: "opencode",
      port: 4199,
      password: "test-password",
      healthTimeoutMs: 2_000,
      maxRestarts: 0,
      spawnImpl: spawnStub,
      fetchImpl: (async (url: string | URL | Request) => {
        const path = new URL(String(url)).pathname;
        paths.push(path);
        if (path === "/api/health") return new Response("{}", { status: 200 });
        return new Response("{}", { status: 404 });
      }) as typeof fetch,
      log: () => {},
    });
    await server.ensure();
    expect(server.url()).toBe("http://127.0.0.1:4199");
    expect(paths).toContain("/api/health");
    expect(paths).not.toContain("/global/health");
    await server.stop();
  });

  it("times out when no OC2 health path answers", async () => {
    const server = createOpenCodeServer({
      bin: "opencode",
      port: 4198,
      password: "test-password",
      healthTimeoutMs: 400,
      maxRestarts: 0,
      spawnImpl: spawnStub,
      fetchImpl: (async () => new Response("{}", { status: 404 })) as typeof fetch,
      log: () => {},
    });
    await expect(server.ensure()).rejects.toThrow(/did not come up/);
    expect(server.url()).toBeNull();
  });
});
