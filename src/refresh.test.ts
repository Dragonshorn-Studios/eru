import { execFile } from "node:child_process";
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
  });

  it("fails closed on missing binary, non-zero exit, and garbage output", async () => {
    const workdir = await mkdtemp(join(tmpdir(), "eru-map-"));
    const missing = await createMapRefresher({ bin: "eru-no-such-bin", timeoutMs: 10_000 })(workdir, "o/r", "main");
    expect(missing).toEqual({ ok: false, error: "unconfigured" });
    const failed = await createMapRefresher({ bin: "/bin/false", timeoutMs: 10_000 })(workdir, "o/r", "main");
    expect(failed).toEqual({ ok: false, error: "failed", detail: "" });
    const garbage = await createMapRefresher({ bin: "/bin/echo", timeoutMs: 10_000 })(workdir, "o/r", "main");
    expect(garbage).toEqual({ ok: false, error: "nomap" });
  });
});
