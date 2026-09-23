import { readFileSync } from "node:fs";
import { parseBooleanEnv, parseInteger } from "./util.js";

export const MIN_SESSION_SECRET = 16;
export const DEFAULT_HOST = "0.0.0.0";
export const DEFAULT_PORT = 3000;
export const DEFAULT_SQLITE_PATH = "./data/eru.sqlite";
export const DEFAULT_LOGIN_LIMIT = 5;
export const DEFAULT_LOGIN_WINDOW_MS = 60_000;
export const DEFAULT_OPENCODE_BIN = "opencode";
export const DEFAULT_OPENCODE_TIMEOUT_MS = 120_000;

export interface Config {
  host: string;
  port: number;
  sqlitePath: string;
  uiPassword: string;
  sessionSecret: string;
  forgeKeySecret?: string;
  loginLimit: number;
  loginWindowMs: number;
  openCodeBin: string;
  openCodeTimeoutMs: number;
  openCodeModel?: string;
  openCodeAskModel?: string;
  openCodeMapModel?: string;
  githubAppId?: string;
  githubAppPrivateKey?: string;
  githubAppInstallationId?: string;
  uiUser?: string;
  publicUrl: string;
  oauthClientId?: string;
  oauthClientSecret?: string;
  oauthAdminIds: number[];
  uiLocalLogin: boolean;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const host = requiredOrDefault(env, "ERU_HOST", DEFAULT_HOST);
  const sqlitePath = requiredOrDefault(env, "ERU_SQLITE_PATH", DEFAULT_SQLITE_PATH);
  const port = parseInteger(env.ERU_PORT, DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("eru: ERU_PORT is invalid");
  }

  const uiPassword = env.ERU_UI_PASSWORD?.trim() ?? "";
  if (!uiPassword) {
    throw new Error("eru: ERU_UI_PASSWORD is empty");
  }

  const sessionSecret = env.ERU_UI_SESSION_SECRET?.trim() ?? "";
  if (!sessionSecret) {
    throw new Error("eru: ERU_UI_SESSION_SECRET is empty");
  }
  if (sessionSecret.length < MIN_SESSION_SECRET) {
    throw new Error("eru: ERU_UI_SESSION_SECRET is too short");
  }

  let forgeKeySecret: string | undefined;
  const forgeKeyEnv = env.ERU_FORGE_TOKEN_KEY?.trim();
  if (forgeKeyEnv) {
    if (forgeKeyEnv.length < MIN_SESSION_SECRET) {
      throw new Error("eru: ERU_FORGE_TOKEN_KEY is too short");
    }
    forgeKeySecret = forgeKeyEnv;
  }

  const openCodeBin = requiredOrDefault(env, "ERU_OPENCODE_BIN", DEFAULT_OPENCODE_BIN);
  const openCodeTimeoutMs = parseInteger(env.ERU_OPENCODE_TIMEOUT_MS, DEFAULT_OPENCODE_TIMEOUT_MS);
  if (!Number.isInteger(openCodeTimeoutMs) || openCodeTimeoutMs < 1_000 || openCodeTimeoutMs > 600_000) {
    throw new Error("eru: ERU_OPENCODE_TIMEOUT_MS is invalid");
  }
  const openCodeModel = env.ERU_OPENCODE_MODEL?.trim() || undefined;
  const openCodeAskModel = env.ERU_OPENCODE_ASK_MODEL?.trim() || undefined;
  const openCodeMapModel = env.ERU_OPENCODE_MAP_MODEL?.trim() || undefined;

  const githubAppId = optionalDigits(env, "ERU_GITHUB_APP_ID");
  const githubAppPrivateKey = loadAppPrivateKey(env);
  const githubAppInstallationId = optionalDigits(env, "ERU_GITHUB_APP_INSTALLATION_ID");
  if (githubAppId && !githubAppPrivateKey) {
    throw new Error("eru: ERU_GITHUB_APP_ID needs ERU_GITHUB_APP_PRIVATE_KEY or ERU_GITHUB_APP_PRIVATE_KEY_FILE");
  }
  if (githubAppPrivateKey && !githubAppId) {
    throw new Error("eru: ERU_GITHUB_APP_PRIVATE_KEY needs ERU_GITHUB_APP_ID");
  }

  const uiUser = env.ERU_UI_USER?.trim() || undefined;
  if (uiUser && !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(uiUser)) {
    throw new Error("eru: ERU_UI_USER is not a GitHub login");
  }

  const oauthClientId = env.ERU_OAUTH_CLIENT_ID?.trim() || undefined;
  const oauthClientSecret = env.ERU_OAUTH_CLIENT_SECRET?.trim() || undefined;
  if (Boolean(oauthClientId) !== Boolean(oauthClientSecret)) {
    throw new Error("eru: set both ERU_OAUTH_CLIENT_ID and ERU_OAUTH_CLIENT_SECRET (or neither)");
  }
  const oauthAdminIds = parseIdList(env.ERU_OAUTH_ADMIN_IDS);
  const publicUrl = env.ERU_PUBLIC_URL?.trim().replace(/\/+$/, "") ?? "";
  const uiLocalLogin = parseBooleanEnv(env.ERU_UI_LOCAL_LOGIN);
  if (oauthClientId) {
    if (oauthAdminIds.length === 0) {
      throw new Error("eru: GitHub OAuth requires ERU_OAUTH_ADMIN_IDS (numeric GitHub user ids)");
    }
    if (!publicUrl) {
      throw new Error("eru: GitHub OAuth requires ERU_PUBLIC_URL to build the exact callback URL");
    }
  }


  return {
    host,
    port,
    sqlitePath,
    uiPassword,
    sessionSecret,
    forgeKeySecret,
    loginLimit: DEFAULT_LOGIN_LIMIT,
    loginWindowMs: DEFAULT_LOGIN_WINDOW_MS,
    openCodeBin,
    openCodeTimeoutMs,
    openCodeModel,
    openCodeAskModel,
    openCodeMapModel,
    githubAppId,
    githubAppPrivateKey,
    githubAppInstallationId,
    uiUser,
    publicUrl,
    oauthClientId,
    oauthClientSecret,
    oauthAdminIds,
    uiLocalLogin,
  };
}

function parseIdList(raw: string | undefined): number[] {
  const value = raw?.trim();
  if (!value) return [];
  const ids = value.split(",").map((piece) => Number(piece.trim()));
  if (ids.some((id) => !Number.isInteger(id) || id <= 0)) {
    throw new Error("eru: ERU_OAUTH_ADMIN_IDS must be comma-separated numeric GitHub user ids");
  }
  return ids;
}

function optionalDigits(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const value = env[key]?.trim();
  if (value === undefined || value === "") return undefined;
  if (!/^\d+$/.test(value)) {
    throw new Error(`eru: ${key} is not a number`);
  }
  return value;
}

// PEM can come inline (with literal \n escapes) or from a file path; the file
// wins when both are set so operators can rotate by moving a file.
function loadAppPrivateKey(env: NodeJS.ProcessEnv): string | undefined {
  const file = env.ERU_GITHUB_APP_PRIVATE_KEY_FILE?.trim();
  if (file) {
    let pem: string;
    try {
      pem = readFileSync(file, "utf8").trim();
    } catch {
      throw new Error("eru: ERU_GITHUB_APP_PRIVATE_KEY_FILE is unreadable");
    }
    if (!pem.includes("PRIVATE KEY")) {
      throw new Error("eru: ERU_GITHUB_APP_PRIVATE_KEY_FILE is not a PEM private key");
    }
    return pem;
  }
  const inline = env.ERU_GITHUB_APP_PRIVATE_KEY?.replace(/\\n/g, "\n").trim();
  if (!inline) return undefined;
  if (!inline.includes("PRIVATE KEY")) {
    throw new Error("eru: ERU_GITHUB_APP_PRIVATE_KEY is not a PEM private key");
  }
  return inline;
}

function requiredOrDefault(env: NodeJS.ProcessEnv, key: string, fallback: string): string {
  if (!Object.prototype.hasOwnProperty.call(env, key) || env[key] === undefined) {
    return fallback;
  }
  const value = env[key].trim();
  if (!value) {
    throw new Error(`eru: ${key} is empty`);
  }
  return value;
}
