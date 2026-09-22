import { parseInteger } from "./util.js";

export const MIN_SESSION_SECRET = 16;
export const DEFAULT_HOST = "0.0.0.0";
export const DEFAULT_PORT = 3000;
export const DEFAULT_SQLITE_PATH = "./data/eru.sqlite";
export const DEFAULT_LOGIN_LIMIT = 5;
export const DEFAULT_LOGIN_WINDOW_MS = 60_000;

export interface Config {
  host: string;
  port: number;
  sqlitePath: string;
  uiPassword: string;
  sessionSecret: string;
  forgeKeySecret?: string;
  loginLimit: number;
  loginWindowMs: number;
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
  if (env.ERU_FORGE_TOKEN_KEY !== undefined) {
    const trimmed = env.ERU_FORGE_TOKEN_KEY.trim();
    if (!trimmed) {
      throw new Error("eru: ERU_FORGE_TOKEN_KEY is empty");
    }
    if (trimmed.length < MIN_SESSION_SECRET) {
      throw new Error("eru: ERU_FORGE_TOKEN_KEY is too short");
    }
    forgeKeySecret = trimmed;
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
  };
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
