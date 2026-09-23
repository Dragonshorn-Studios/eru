import { describe, expect, it } from "vitest";
import { loadConfig, MIN_SESSION_SECRET } from "./config.js";

const secrets = {
  ERU_UI_PASSWORD: "test-ui-password",
  ERU_UI_SESSION_SECRET: "test-session-secret",
};

describe("loadConfig", () => {
  it("loads defaults when optional keys are omitted", () => {
    const cfg = loadConfig({ ...secrets });
    expect(cfg.host).toBe("0.0.0.0");
    expect(cfg.port).toBe(3000);
    expect(cfg.sqlitePath).toBe("./data/eru.sqlite");
    expect(cfg.uiPassword).toBe("test-ui-password");
    expect(cfg.sessionSecret).toBe("test-session-secret");
    expect(cfg.openCodeBin).toBe("opencode");
    expect(cfg.openCodeTimeoutMs).toBe(120_000);
    expect(cfg.openCodeModel).toBeUndefined();
  });

  it("loads OpenCode overrides and fails closed on a bad timeout", () => {
    const cfg = loadConfig({
      ...secrets,
      ERU_OPENCODE_BIN: "/opt/oc",
      ERU_OPENCODE_TIMEOUT_MS: "5000",
      ERU_OPENCODE_MODEL: "anthropic/claude",
    });
    expect(cfg.openCodeBin).toBe("/opt/oc");
    expect(cfg.openCodeTimeoutMs).toBe(5_000);
    expect(cfg.openCodeModel).toBe("anthropic/claude");
    const scoped = loadConfig({
      ...secrets,
      ERU_OPENCODE_ASK_MODEL: "anthropic/haiku",
      ERU_OPENCODE_MAP_MODEL: " openai/gpt-5 ",
    });
    expect(scoped.openCodeAskModel).toBe("anthropic/haiku");
    expect(scoped.openCodeMapModel).toBe("openai/gpt-5");
    expect(() => loadConfig({ ...secrets, ERU_OPENCODE_TIMEOUT_MS: "10" })).toThrow(/ERU_OPENCODE_TIMEOUT_MS/);
    expect(() => loadConfig({ ...secrets, ERU_OPENCODE_BIN: " " })).toThrow(/ERU_OPENCODE_BIN/);
  });

  it("fails closed on empty UI password", () => {
    expect(() => loadConfig({ ...secrets, ERU_UI_PASSWORD: "  " })).toThrow(/ERU_UI_PASSWORD/);
  });

  it("fails closed on empty session secret", () => {
    expect(() => loadConfig({ ERU_UI_PASSWORD: "test-ui-password", ERU_UI_SESSION_SECRET: "" })).toThrow(
      /ERU_UI_SESSION_SECRET/,
    );
  });

  it("fails closed on a short session secret", () => {
    expect(() =>
      loadConfig({ ERU_UI_PASSWORD: "test-ui-password", ERU_UI_SESSION_SECRET: "x".repeat(MIN_SESSION_SECRET - 1) }),
    ).toThrow(/too short/);
  });

  it("fails closed on empty SQLite path", () => {
    expect(() => loadConfig({ ...secrets, ERU_SQLITE_PATH: "   " })).toThrow(/ERU_SQLITE_PATH/);
  });

  it("loads a dedicated forge token key when configured", () => {
    const cfg = loadConfig({ ...secrets, ERU_FORGE_TOKEN_KEY: " forge-key-material-16+ " });
    expect(cfg.forgeKeySecret).toBe("forge-key-material-16+");
    expect(loadConfig({ ...secrets }).forgeKeySecret).toBeUndefined();
  });

  it("fails closed on an empty or short forge token key", () => {
    expect(() => loadConfig({ ...secrets, ERU_FORGE_TOKEN_KEY: "   " })).toThrow(/ERU_FORGE_TOKEN_KEY/);
    expect(() => loadConfig({ ...secrets, ERU_FORGE_TOKEN_KEY: "short" })).toThrow(/too short/);
  });
});
