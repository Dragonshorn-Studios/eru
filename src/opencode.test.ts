import { describe, expect, it } from "vitest";
import { isCliHelpDump, opencodeRunArgs, unwrapOcData } from "./opencode.js";

describe("opencodeRunArgs", () => {
  it("runs the non-interactive command with --standalone after run", () => {
    expect(opencodeRunArgs("map this")).toEqual(["run", "--standalone", "--", "map this"]);
    expect(opencodeRunArgs("ask", "anthropic/haiku")).toEqual([
      "run",
      "--standalone",
      "-m",
      "anthropic/haiku",
      "--",
      "ask",
    ]);
  });
});

describe("isCliHelpDump", () => {
  it("recognizes a yargs help tail and ignores a normal error", () => {
    const help =
      "e] --no-replay disable mini session history replay on resume and after resize [boolean] --replay-limit cap visible mini replay to the newest N messages [number]";
    expect(isCliHelpDump(help)).toBe(true);
    expect(isCliHelpDump("provider auth missing")).toBe(false);
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
