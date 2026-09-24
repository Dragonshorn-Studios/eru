import { describe, expect, it } from "vitest";
import { runChild } from "./proc.js";

// The shell recomputes $PWD itself, so a leaked inherited PWD only shows up in
// processes that read it straight from the environment — like OpenCode.
const ENV_DUMP = "process.stdout.write(process.env.PWD + '/' + process.env.INIT_CWD)";

describe("runChild", () => {
  it("rewrites PWD and INIT_CWD to the child cwd", async () => {
    const result = await runChild(process.execPath, ["-e", ENV_DUMP], {
      cwd: "/tmp",
      env: { PATH: process.env.PATH, PWD: "/leaked", INIT_CWD: "/leaked" },
      timeoutMs: 10_000,
    });
    expect(result.stdout).toBe("/tmp//tmp");
  });

  it("leaves PWD and INIT_CWD untouched without a cwd", async () => {
    const result = await runChild(process.execPath, ["-e", ENV_DUMP], {
      env: { PATH: process.env.PATH, PWD: "/keep", INIT_CWD: "/keep" },
      timeoutMs: 10_000,
    });
    expect(result.stdout).toBe("/keep//keep");
  });
});
