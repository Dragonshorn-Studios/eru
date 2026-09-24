import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig, MIN_SESSION_SECRET, parseOpenCodeTimeout } from "./config.js";

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

  it("ignores a blank forge token key and rejects a short one", () => {
    expect(loadConfig({ ...secrets, ERU_FORGE_TOKEN_KEY: "   " }).forgeKeySecret).toBeUndefined();
    expect(() => loadConfig({ ...secrets, ERU_FORGE_TOKEN_KEY: "short" })).toThrow(/too short/);
  });
});

describe("github app config", () => {
  const PEM = "-----BEGIN PRIVATE KEY-----\nabc123\n-----END PRIVATE KEY-----";

  it("loads app id + inline PEM, normalizing \\n escapes", () => {
    const cfg = loadConfig({
      ...secrets,
      ERU_GITHUB_APP_ID: "12345",
      ERU_GITHUB_APP_PRIVATE_KEY: PEM.replace(/\n/g, "\\n"),
      ERU_GITHUB_APP_INSTALLATION_ID: "6789",
    });
    expect(cfg.githubAppId).toBe("12345");
    expect(cfg.githubAppPrivateKey).toBe(PEM);
    expect(cfg.githubAppInstallationId).toBe("6789");
    expect(loadConfig({ ...secrets }).githubAppId).toBeUndefined();
  });

  it("reads the PEM from a file, and the file wins over an inline key", () => {
    const dir = mkdtempSync(join(tmpdir(), "eru-pem-"));
    const file = join(dir, "app.pem");
    writeFileSync(file, PEM);
    const cfg = loadConfig({
      ...secrets,
      ERU_GITHUB_APP_ID: "1",
      ERU_GITHUB_APP_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\\nother\\n-----END PRIVATE KEY-----",
      ERU_GITHUB_APP_PRIVATE_KEY_FILE: file,
    });
    expect(cfg.githubAppPrivateKey).toBe(PEM);
  });

  it("fails closed on a partial app config or a non-PEM key", () => {
    expect(() => loadConfig({ ...secrets, ERU_GITHUB_APP_ID: "1" })).toThrow(/PRIVATE_KEY/);
    expect(() => loadConfig({ ...secrets, ERU_GITHUB_APP_PRIVATE_KEY: PEM })).toThrow(/APP_ID/);
    expect(() => loadConfig({ ...secrets, ERU_GITHUB_APP_ID: "1", ERU_GITHUB_APP_PRIVATE_KEY: "blob" })).toThrow(
      /PEM/,
    );
    expect(() => loadConfig({ ...secrets, ERU_GITHUB_APP_ID: "abc" })).toThrow(/APP_ID/);
    expect(() =>
      loadConfig({ ...secrets, ERU_GITHUB_APP_ID: "1", ERU_GITHUB_APP_PRIVATE_KEY: PEM, ERU_GITHUB_APP_PRIVATE_KEY_FILE: "/nope.pem" }),
    ).toThrow(/PRIVATE_KEY_FILE/);
  });
});

describe("ui user config", () => {
  it("parses a GitHub login and rejects malformed values", () => {
    expect(loadConfig({ ...secrets, ERU_UI_USER: "octo-cat" }).uiUser).toBe("octo-cat");
    expect(loadConfig({ ...secrets }).uiUser).toBeUndefined();
    expect(() => loadConfig({ ...secrets, ERU_UI_USER: "not a login!" })).toThrow("ERU_UI_USER");
  });
});

describe("github oauth config", () => {
  const oauth = {
    ERU_OAUTH_CLIENT_ID: "Iv1.example",
    ERU_OAUTH_CLIENT_SECRET: "oauth-secret",
    ERU_OAUTH_ADMIN_IDS: "42, 7",
    ERU_PUBLIC_URL: "https://eru.example.test/",
  };

  it("loads the oauth block and strips the public URL trailing slash", () => {
    const cfg = loadConfig({ ...secrets, ...oauth });
    expect(cfg.oauthClientId).toBe("Iv1.example");
    expect(cfg.oauthAdminIds).toEqual([42, 7]);
    expect(cfg.publicUrl).toBe("https://eru.example.test");
    expect(cfg.uiLocalLogin).toBe(false);
    expect(loadConfig({ ...secrets }).oauthClientId).toBeUndefined();
    expect(loadConfig({ ...secrets }).oauthAdminIds).toEqual([]);
  });

  it("fails closed on half an oauth pair or a missing allowlist/public URL", () => {
    expect(() => loadConfig({ ...secrets, ERU_OAUTH_CLIENT_ID: "x" })).toThrow(/both/);
    expect(() => loadConfig({ ...secrets, ERU_OAUTH_CLIENT_SECRET: "x" })).toThrow(/both/);
    const noIds = { ...oauth };
    delete (noIds as Record<string, string>).ERU_OAUTH_ADMIN_IDS;
    expect(() => loadConfig({ ...secrets, ...noIds })).toThrow(/ERU_OAUTH_ADMIN_IDS/);
    const noUrl = { ...oauth };
    delete (noUrl as Record<string, string>).ERU_PUBLIC_URL;
    expect(() => loadConfig({ ...secrets, ...noUrl })).toThrow(/ERU_PUBLIC_URL/);
    expect(() => loadConfig({ ...secrets, ...oauth, ERU_OAUTH_ADMIN_IDS: "abc" })).toThrow(/numeric/);
  });

  it("parses ERU_UI_LOCAL_LOGIN", () => {
    expect(loadConfig({ ...secrets, ...oauth, ERU_UI_LOCAL_LOGIN: "true" }).uiLocalLogin).toBe(true);
    expect(loadConfig({ ...secrets, ...oauth, ERU_UI_LOCAL_LOGIN: "1" }).uiLocalLogin).toBe(true);
    expect(loadConfig({ ...secrets, ...oauth, ERU_UI_LOCAL_LOGIN: "no" }).uiLocalLogin).toBe(false);
    expect(loadConfig({ ...secrets, ...oauth, ERU_UI_LOCAL_LOGIN: "garbage" }).uiLocalLogin).toBe(false);
  });
});

describe("parseOpenCodeTimeout", () => {
  it("accepts only integers in the 1000-600000 range", () => {
    expect(parseOpenCodeTimeout("1000")).toBe(1000);
    expect(parseOpenCodeTimeout("600000")).toBe(600000);
    expect(parseOpenCodeTimeout("999")).toBeUndefined();
    expect(parseOpenCodeTimeout("600001")).toBeUndefined();
    expect(parseOpenCodeTimeout("abc")).toBeUndefined();
    expect(parseOpenCodeTimeout("12.5")).toBeUndefined();
    expect(parseOpenCodeTimeout("")).toBeUndefined();
  });
});
