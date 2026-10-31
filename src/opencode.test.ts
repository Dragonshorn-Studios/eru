import { describe, expect, it } from "vitest";
import { opencodeRunArgs, unwrapOcData } from "./opencode.js";

describe("opencodeRunArgs", () => {
  it("uses --standalone run for OpenCode 2.0 and keeps -- before the prompt", () => {
    expect(opencodeRunArgs("map this")).toEqual(["--standalone", "run", "--", "map this"]);
    expect(opencodeRunArgs("ask", "anthropic/haiku")).toEqual([
      "--standalone",
      "run",
      "-m",
      "anthropic/haiku",
      "--",
      "ask",
    ]);
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
