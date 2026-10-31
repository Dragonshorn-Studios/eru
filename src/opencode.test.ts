import { beforeEach, describe, expect, it } from "vitest";
import {
  clearOpenCodeGenerationCache,
  detectOpenCodeGeneration,
  isCliHelpDump,
  opencodeModelsArgs,
  opencodeRunArgs,
  parseOpenCodeVersion,
  runOpenCode,
  unwrapOcData,
} from "./opencode.js";
import type { ChildResult } from "./proc.js";

function child(partial: Partial<ChildResult> = {}): ChildResult {
  return { code: 0, stdout: "", stderr: "", timedOut: false, durationMs: 1, ...partial };
}

const HELP =
  "e] --no-replay disable mini session history replay on resume and after resize [boolean] --replay-limit cap visible mini replay [number]";

describe("parseOpenCodeVersion", () => {
  it("reads a bare or labeled version line and ignores help prose", () => {
    expect(parseOpenCodeVersion("1.14.3\n")).toEqual({ generation: 1, version: "1.14.3" });
    expect(parseOpenCodeVersion("opencode 2.0.45")).toEqual({ generation: 2, version: "2.0.45" });
    expect(parseOpenCodeVersion("v0.15.2")).toEqual({ generation: 1, version: "0.15.2" });
    expect(parseOpenCodeVersion(`${HELP}\nsee also node 22.1.0\n`)).toBeUndefined();
  });
});

describe("opencodeRunArgs", () => {
  it("omits --standalone on 1.x and places it on run for 2.x", () => {
    expect(opencodeRunArgs("map this", undefined, 1)).toEqual(["run", "--", "map this"]);
    expect(opencodeRunArgs("map this", undefined, 2)).toEqual(["run", "--standalone", "--", "map this"]);
    expect(opencodeRunArgs("ask", "anthropic/haiku", 1)).toEqual(["run", "-m", "anthropic/haiku", "--", "ask"]);
    expect(opencodeRunArgs("ask", "anthropic/haiku", 2)).toEqual([
      "run",
      "--standalone",
      "-m",
      "anthropic/haiku",
      "--",
      "ask",
    ]);
    expect(opencodeModelsArgs(1)).toEqual(["models"]);
    expect(opencodeModelsArgs(2)).toEqual(["models", "--standalone"]);
  });
});

describe("isCliHelpDump", () => {
  it("recognizes a yargs help tail and ignores a normal error", () => {
    expect(isCliHelpDump(HELP)).toBe(true);
    expect(isCliHelpDump("provider auth missing")).toBe(false);
  });
});

describe("detectOpenCodeGeneration", () => {
  beforeEach(() => clearOpenCodeGenerationCache());

  it("uses --version, then run --help when the version line is missing", async () => {
    const seen: string[][] = [];
    const run = async (_bin: string, args: string[]) => {
      seen.push(args);
      if (args[0] === "--version") return child({ stdout: "usage: opencode\n" });
      return child({ stdout: "run --standalone   private server   [boolean]\n" });
    };
    await expect(detectOpenCodeGeneration("oc", 1000, run as never)).resolves.toBe(2);
    expect(seen).toEqual([["--version"], ["run", "--help"]]);

    clearOpenCodeGenerationCache();
    const v1 = async (_bin: string, args: string[]) => {
      if (args[0] === "--version") return child({ stdout: "1.2.3\n" });
      throw new Error("should not sniff help");
    };
    await expect(detectOpenCodeGeneration("oc1", 1000, v1 as never)).resolves.toBe(1);
  });
});

describe("runOpenCode", () => {
  beforeEach(() => clearOpenCodeGenerationCache());

  it("retries the other generation when the first invocation prints command help", async () => {
    const seen: string[][] = [];
    const run = async (_bin: string, args: string[]) => {
      seen.push(args);
      if (args[0] === "--version") return child({ stdout: "2.1.0\n" });
      if (args.includes("--standalone")) return child({ code: 1, stderr: HELP });
      return child({ stdout: '[{"slug":"a","title":"t","body":"b"}]' });
    };
    const result = await runOpenCode({ bin: "oc", prompt: "map", timeoutMs: 1000 }, run as never);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("slug");
    expect(seen.filter((args) => args[0] === "run").map((args) => args.includes("--standalone"))).toEqual([true, false]);
  });
});

describe("unwrapOcData", () => {
  it("unwraps OC2 { data } envelopes and passes OC1 values through", () => {
    expect(unwrapOcData({ data: { id: "ses-1" } })).toEqual({ id: "ses-1" });
    expect(unwrapOcData({ id: "ses-1" })).toEqual({ id: "ses-1" });
    expect(unwrapOcData({ data: null })).toEqual({ data: null });
    expect(unwrapOcData(undefined)).toBeUndefined();
  });
});
