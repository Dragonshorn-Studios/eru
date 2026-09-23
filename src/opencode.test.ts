import { mkdtemp, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createOpenCodeRunner } from "./opencode.js";

const PAGE = { slug: "arch", title: "Arch", body: "the body" };

describe("createOpenCodeRunner", () => {
  it("runs the binary in a locked workdir with the materialized map", async () => {
    const dir = await mkdtemp(join(tmpdir(), "eru-fake-oc-"));
    const script = join(dir, "fake-oc.mjs");
    await writeFile(
      script,
      [
        `#!${process.execPath}`,
        'import { readFileSync, readdirSync } from "node:fs";',
        'const perm = JSON.parse(readFileSync("opencode.json", "utf8")).permission;',
        'const files = readdirSync("map");',
        'const body = readFileSync("map/arch.md", "utf8");',
        'console.log(JSON.stringify({ perm, files, body, argv: process.argv.slice(2) }));',
      ].join("\n"),
    );
    await chmod(script, 0o755);
    const runner = createOpenCodeRunner({ bin: script, timeoutMs: 10_000 });
    const result = await runner("q?", [PAGE], "o/r");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const out = JSON.parse(result.answer);
    expect(out.perm).toEqual({ "*": "deny", read: "allow", glob: "allow", grep: "allow" });
    expect(out.files).toEqual(["arch.md"]);
    expect(out.body).toContain("# Arch");
    expect(out.body).toContain("the body");
    expect(out.argv).toContain("run");
    expect(out.argv[out.argv.length - 1]).toContain("Question: q?");
    expect(out.argv[out.argv.length - 1]).toContain("o/r");
  });

  it("fails closed as unconfigured when the binary is missing", async () => {
    const runner = createOpenCodeRunner({ bin: "eru-definitely-no-such-bin", timeoutMs: 10_000 });
    const result = await runner("q", [PAGE], "o/r");
    expect(result).toEqual({ ok: false, error: "unconfigured" });
  });

  it("maps a non-zero exit to failed", async () => {
    const runner = createOpenCodeRunner({ bin: "/bin/false", timeoutMs: 10_000 });
    const result = await runner("q", [PAGE], "o/r");
    expect(result).toEqual({ ok: false, error: "failed" });
  });

  it("sanitizes hostile slugs into safe map filenames", async () => {
    const dir = await mkdtemp(join(tmpdir(), "eru-fake-oc-"));
    const script = join(dir, "fake-oc.mjs");
    await writeFile(
      script,
      `#!${process.execPath}\nimport { readdirSync } from "node:fs";\nconsole.log(JSON.stringify(readdirSync("map")));\n`,
    );
    await chmod(script, 0o755);
    const runner = createOpenCodeRunner({ bin: script, timeoutMs: 10_000 });
    const result = await runner("q", [{ slug: "../evil/../../x", title: "T", body: "B" }], "o/r");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const files = JSON.parse(result.answer) as string[];
    expect(files).toEqual(["evil-x.md"]);
  });
});
