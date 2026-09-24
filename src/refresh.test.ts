import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { createMapRefresher, extractTarball, isValidMapRef, parseMapPages } from "./refresh.js";

const execFileP = promisify(execFile);

describe("isValidMapRef", () => {
  it("accepts branches, tags, and SHAs", () => {
    for (const ref of ["main", "feature/x", "v1.2.3", "a1b2c3d"]) expect(isValidMapRef(ref)).toBe(true);
  });
  it("rejects traversal, spaces, and leading dash", () => {
    for (const ref of ["", "../x", "a..b", "has space", "-dash", "x;rm -rf", "x>y"]) {
      expect(isValidMapRef(ref)).toBe(false);
    }
  });
});

describe("parseMapPages", () => {
  it("parses a bare JSON array and normalizes entries", () => {
    const pages = parseMapPages(
      JSON.stringify([
        { slug: "Arch Page!", title: " Arch ", body: "b", sortOrder: 2.7 },
        { slug: "auth", title: "Auth", body: "a" },
      ]),
    );
    expect(pages).toEqual([
      { slug: "arch-page", title: "Arch", body: "b", sortOrder: 2 },
      { slug: "auth", title: "Auth", body: "a", sortOrder: 1 },
    ]);
  });

  it("extracts JSON from fenced or noisy model output", () => {
    const fenced = parseMapPages('here you go\n```json\n[{"slug":"a","title":"T","body":"b"}]\n```\nthanks');
    expect(fenced?.[0]?.slug).toBe("a");
    const noisy = parseMapPages('prefix [{"slug":"a","title":"T","body":"b"}] suffix');
    expect(noisy?.[0]?.slug).toBe("a");
  });

  it("rejects garbage, non-arrays, and unusable entries", () => {
    expect(parseMapPages("not json")).toBeNull();
    expect(parseMapPages("{}")).toBeNull();
    expect(parseMapPages("[]")).toEqual([]);
    const pages = parseMapPages(
      JSON.stringify([
        { slug: "", title: "t", body: "b" },
        { slug: "ok", title: "", body: "b" },
        { slug: "ok2", title: "t", body: "   " },
        { slug: "ok", title: "dup", body: "b" },
        42,
      ]),
    );
    expect(pages).toEqual([{ slug: "ok", title: "dup", body: "b", sortOrder: 0 }]);
  });
});

describe("extractTarball", () => {
  it("unpacks a GitHub-style tarball into checkout/", async () => {
    const dir = await mkdtemp(join(tmpdir(), "eru-tar-"));
    await mkdir(join(dir, "repo-sha"));
    await writeFile(join(dir, "repo-sha", "index.ts"), "export {};\n");
    await execFileP("tar", ["-czf", join(dir, "a.tgz"), "-C", dir, "repo-sha"]);

    const dest = await mkdtemp(join(tmpdir(), "eru-dest-"));
    await extractTarball(await readFile(join(dir, "a.tgz")), dest);
    expect(await readFile(join(dest, "checkout", "index.ts"), "utf8")).toBe("export {};\n");
  });
});

describe("createMapRefresher", () => {
  it("collects validated pages from OpenCode stdout", async () => {
    const dir = await mkdtemp(join(tmpdir(), "eru-fake-oc-"));
    const script = join(dir, "fake-oc.mjs");
    await writeFile(
      script,
      `#!${process.execPath}
import { readFileSync } from "node:fs";
const perm = JSON.parse(readFileSync("opencode.json", "utf8")).permission;
console.log(JSON.stringify([{ slug: "arch", title: "P:" + perm["*"], body: "b", sortOrder: 0 }]));
`,
    );
    await chmod(script, 0o755);
    const workdir = await mkdtemp(join(tmpdir(), "eru-map-"));
    const result = await createMapRefresher({ bin: script, timeoutMs: 10_000 })(workdir, "o/r", "main");
    expect(result).toEqual({ ok: true, pages: [{ slug: "arch", title: "P:deny", body: "b", sortOrder: 0 }] });
    // The checkout gets a .git marker so OpenCode roots its project here
    // instead of walking up to a surrounding repository.
    expect(existsSync(join(workdir, ".git", "HEAD"))).toBe(true);
  });

  it("fails closed on missing binary, non-zero exit, and garbage output", async () => {
    const workdir = await mkdtemp(join(tmpdir(), "eru-map-"));
    const missing = await createMapRefresher({ bin: "eru-no-such-bin", timeoutMs: 10_000 })(workdir, "o/r", "main");
    expect(missing).toEqual({ ok: false, error: "unconfigured" });
    const failed = await createMapRefresher({ bin: "/bin/false", timeoutMs: 10_000 })(workdir, "o/r", "main");
    expect(failed).toEqual({ ok: false, error: "failed", detail: "" });
    const garbage = await createMapRefresher({ bin: "/bin/echo", timeoutMs: 10_000 })(workdir, "o/r", "main");
    expect(garbage).toMatchObject({ ok: false, error: "nomap" });
    expect(garbage.ok === false && "detail" in garbage && garbage.detail!.length > 0).toBe(true);
  });

  it("ends stdin so opencode-style children do not block on EOF", async () => {
    // `opencode run` reads stdin when it is not a TTY; this stub does the same.
    // With stdin left open it would hang until the timeout — here it answers.
    const workdir = await mkdtemp(join(tmpdir(), "eru-map-"));
    const stub = join(workdir, "stub.sh");
    await writeFile(stub, "#!/bin/sh\ncat >/dev/null\nprintf '%s' '[{\"slug\":\"a\",\"title\":\"t\",\"body\":\"b\",\"sortOrder\":0}]'\n");
    await chmod(stub, 0o755);
    const result = await createMapRefresher({ bin: stub, timeoutMs: 10_000 })(workdir, "o/r", "main");
    expect(result).toEqual({ ok: true, pages: [{ slug: "a", title: "t", body: "b", sortOrder: 0 }] });
  });

  it("fails loudly — not unconfigured — when the marker cannot be written", async () => {
    const workdir = await mkdtemp(join(tmpdir(), "eru-map-"));
    // .git as a file: the skeleton mkdir fails ENOTDIR, and that must surface
    // as "failed" with the error detail — never as a silent wrong-repo run.
    await writeFile(join(workdir, ".git"), "not a dir");
    const result = await createMapRefresher({ bin: "/bin/true", timeoutMs: 10_000 })(workdir, "o/r", "main");
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toBe("failed");
    expect(result.ok === false && result.detail).toMatch(/ENOTDIR|not a dir/i);
  });

  it("scopes ENOENT to the spawn — a missing workdir is not 'unconfigured'", async () => {
    const gone = join(await mkdtemp(join(tmpdir(), "eru-map-")), "gone");
    const result = await createMapRefresher({ bin: "/bin/true", timeoutMs: 10_000 })(gone, "o/r", "main");
    expect(result).toMatchObject({ ok: false, error: "failed" });
    expect(result.ok === false && result.detail!.length).toBeGreaterThan(0);
  });

  it("fails with a timed-out detail when the child outlives its budget", async () => {
    const workdir = await mkdtemp(join(tmpdir(), "eru-map-"));
    const stub = join(workdir, "stub.sh");
    await writeFile(stub, "#!/bin/sh\nsleep 30\n");
    await chmod(stub, 0o755);
    const result = await createMapRefresher({ bin: stub, timeoutMs: 100 })(workdir, "o/r", "main");
    expect(result).toMatchObject({ ok: false, error: "failed" });
    expect(result.ok === false && result.detail?.includes("timed out")).toBe(true);
  });
});
