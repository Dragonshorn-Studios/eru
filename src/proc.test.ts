import { describe, expect, it } from "vitest";
import { opencodeChildEnv, runChild } from "./proc.js";

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

describe("opencodeChildEnv", () => {
  it("strips every ERU_* variable from the OpenCode child", () => {
    const previous = {
      ERU_UI_SESSION_SECRET: process.env.ERU_UI_SESSION_SECRET,
      ERU_ISSUE_BOT_WEBHOOK_SECRET: process.env.ERU_ISSUE_BOT_WEBHOOK_SECRET,
      ERU_FORGE_TOKEN_KEY: process.env.ERU_FORGE_TOKEN_KEY,
    };
    process.env.ERU_UI_SESSION_SECRET = "must-not-leak";
    process.env.ERU_ISSUE_BOT_WEBHOOK_SECRET = "must-not-leak-webhook";
    process.env.ERU_FORGE_TOKEN_KEY = "must-not-leak-forge";
    try {
      const env = opencodeChildEnv();
      expect(env.ERU_UI_SESSION_SECRET).toBeUndefined();
      expect(env.ERU_ISSUE_BOT_WEBHOOK_SECRET).toBeUndefined();
      expect(env.ERU_FORGE_TOKEN_KEY).toBeUndefined();
      expect(Object.keys(env).some((key) => key.startsWith("ERU_"))).toBe(false);
      expect(env.TERM).toBe("dumb");
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});
