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
});
