import { readFileSync } from "node:fs";
import { normalizeForgeOrigin } from "./forges.js";
import { parseBooleanEnv, parseInteger } from "./util.js";

export const MIN_SESSION_SECRET = 16;
export const DEFAULT_HOST = "0.0.0.0";
export const DEFAULT_PORT = 3000;
export const DEFAULT_SQLITE_PATH = "./data/eru.sqlite";
export const DEFAULT_LOGIN_LIMIT = 5;
export const DEFAULT_LOGIN_WINDOW_MS = 60_000;
export const DEFAULT_OPENCODE_BIN = "opencode";
export const DEFAULT_OPENCODE_TIMEOUT_MS = 120_000;
export const OPENCODE_TIMEOUT_MIN_MS = 1_000;
export const OPENCODE_TIMEOUT_MAX_MS = 600_000;
export const DEFAULT_ISSUE_BOT_HOURLY_CAP = 20;
export const ISSUE_BOT_HOURLY_CAP_MAX = 1_000;
export const MIN_WEBHOOK_SECRET = 16;

export function parseOpenCodeTimeout(raw: string): number | undefined {
  if (!/^\d+$/.test(raw)) return undefined;
  const ms = Number(raw);
  return ms >= OPENCODE_TIMEOUT_MIN_MS && ms <= OPENCODE_TIMEOUT_MAX_MS ? ms : undefined;
}

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
  /** Ask thread workspaces root; empty = <sqlite dir>/ask. */
  askWorkdir?: string;
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
  /** Present when webhook secret + bot user id + App ID/PEM all resolve (one App is enough). */
  issueBot?: IssueBotConfig;
  gitlab?: ForgeInstanceConfig;
  forgejo?: ForgeInstanceConfig;
}

export interface IssueBotConfig {
  appId: string;
  privateKey: string;
  webhookSecret: string;
  /** GitHub user id of the App's `*[bot]` account — loop guard compares `sender.id`. */
  botUserId: number;
  trustedBotIds: number[];
  hourlyCap: number;
  /**
   * True when `ERU_ISSUE_BOT_APP_ID` or a dedicated PEM is set. Dedicated
   * credentials never mix with the mapping App's PEM, webhook secret, or bot id.
   */
  dedicated: boolean;
}

/** Self-hosted GitLab or Forgejo instance. Token is a PAT / access token, not OAuth. */
export interface ForgeInstanceConfig {
  origin: string;
  token: string;
  webhookSecret?: string;
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
  if (!Number.isInteger(openCodeTimeoutMs) || parseOpenCodeTimeout(String(openCodeTimeoutMs)) === undefined) {
    throw new Error("eru: ERU_OPENCODE_TIMEOUT_MS is invalid");
  }
  const openCodeModel = env.ERU_OPENCODE_MODEL?.trim() || undefined;
  const openCodeAskModel = env.ERU_OPENCODE_ASK_MODEL?.trim() || undefined;
  const openCodeMapModel = env.ERU_OPENCODE_MAP_MODEL?.trim() || undefined;
  const askWorkdir = env.ERU_ASK_WORKDIR?.trim() || undefined;

  const githubAppId = optionalDigits(env, "ERU_GITHUB_APP_ID");
  const githubAppPrivateKey = loadPem(
    env,
    "ERU_GITHUB_APP_PRIVATE_KEY",
    "ERU_GITHUB_APP_PRIVATE_KEY_FILE",
  );
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

  const oauthClientId =
    env.ERU_GITHUB_APP_CLIENT_ID?.trim() || env.ERU_OAUTH_CLIENT_ID?.trim() || undefined;
  const oauthClientSecret =
    env.ERU_GITHUB_APP_CLIENT_SECRET?.trim() || env.ERU_OAUTH_CLIENT_SECRET?.trim() || undefined;
  if (Boolean(oauthClientId) !== Boolean(oauthClientSecret)) {
    throw new Error(
      "eru: set both GitHub App client id and secret (ERU_GITHUB_APP_CLIENT_ID/SECRET, or ERU_OAUTH_* aliases)",
    );
  }
  const oauthAdminIds = parseIdList(
    env.ERU_GITHUB_APP_ADMIN_IDS?.trim() || env.ERU_OAUTH_ADMIN_IDS,
    env.ERU_GITHUB_APP_ADMIN_IDS?.trim() ? "ERU_GITHUB_APP_ADMIN_IDS" : "ERU_OAUTH_ADMIN_IDS",
  );
  const issueBot = loadIssueBotConfig(env, githubAppId, githubAppPrivateKey);
  const gitlab = loadForgeInstance(env, "GITLAB");
  const forgejo = loadForgeInstance(env, "FORGEJO");
  const publicUrl = env.ERU_PUBLIC_URL?.trim().replace(/\/+$/, "") ?? "";
  const uiLocalLogin = parseBooleanEnv(env.ERU_UI_LOCAL_LOGIN);
  if (oauthClientId) {
    if (oauthAdminIds.length === 0) {
      throw new Error("eru: GitHub login requires ERU_GITHUB_APP_ADMIN_IDS (or ERU_OAUTH_ADMIN_IDS)");
    }
    if (!publicUrl) {
      throw new Error("eru: GitHub login requires ERU_PUBLIC_URL to build the exact callback URL");
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
    askWorkdir,
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
    issueBot,
    gitlab,
    forgejo,
  };
}

function parseIdList(raw: string | undefined, key: string): number[] {
  const value = raw?.trim();
  if (!value) return [];
  const ids = value.split(",").map((piece) => Number(piece.trim()));
  if (ids.some((id) => !Number.isInteger(id) || id <= 0)) {
    throw new Error(`eru: ${key} must be comma-separated numeric GitHub user ids`);
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
function loadPem(env: NodeJS.ProcessEnv, inlineKey: string, fileKey: string): string | undefined {
  const file = env[fileKey]?.trim();
  if (file) {
    let pem: string;
    try {
      pem = readFileSync(file, "utf8").trim();
    } catch {
      throw new Error(`eru: ${fileKey} is unreadable`);
    }
    if (!pem.includes("PRIVATE KEY")) {
      throw new Error(`eru: ${fileKey} is not a PEM private key`);
    }
    return pem;
  }
  const inline = env[inlineKey]?.replace(/\\n/g, "\n").trim();
  if (!inline) return undefined;
  if (!inline.includes("PRIVATE KEY")) {
    throw new Error(`eru: ${inlineKey} is not a PEM private key`);
  }
  return inline;
}

function requireWebhookSecret(value: string | undefined, key: string): string {
  if (!value) {
    throw new Error(`eru: issue bot needs ${key}`);
  }
  if (value.length < MIN_WEBHOOK_SECRET) {
    throw new Error("eru: webhook secret is too short");
  }
  return value;
}

function requireBotUserId(raw: string | undefined, key: string): number {
  if (!raw) {
    throw new Error(`eru: issue bot needs ${key}`);
  }
  if (!/^\d+$/.test(raw)) {
    throw new Error(`eru: ${key} is not a number`);
  }
  return Number(raw);
}

function issueBotHourlyCap(env: NodeJS.ProcessEnv): number {
  const hourlyCap = parseInteger(env.ERU_ISSUE_BOT_HOURLY_CAP, DEFAULT_ISSUE_BOT_HOURLY_CAP);
  if (!Number.isInteger(hourlyCap) || hourlyCap < 1 || hourlyCap > ISSUE_BOT_HOURLY_CAP_MAX) {
    throw new Error("eru: ERU_ISSUE_BOT_HOURLY_CAP is invalid");
  }
  return hourlyCap;
}

function loadIssueBotConfig(
  env: NodeJS.ProcessEnv,
  githubAppId?: string,
  githubAppPrivateKey?: string,
): IssueBotConfig | undefined {
  const dedicatedAppId = optionalDigits(env, "ERU_ISSUE_BOT_APP_ID");
  const dedicatedKey = loadPem(env, "ERU_ISSUE_BOT_PRIVATE_KEY", "ERU_ISSUE_BOT_PRIVATE_KEY_FILE");
  const dedicatedWebhook = env.ERU_ISSUE_BOT_WEBHOOK_SECRET?.trim() || undefined;
  const dedicatedBotUser = env.ERU_ISSUE_BOT_USER_ID?.trim() || undefined;
  const mappingWebhook = env.ERU_GITHUB_APP_WEBHOOK_SECRET?.trim() || undefined;
  const mappingBotUser = env.ERU_GITHUB_APP_BOT_USER_ID?.trim() || undefined;
  const extras = Boolean(env.ERU_TRUSTED_BOT_IDS?.trim()) || Boolean(env.ERU_ISSUE_BOT_HOURLY_CAP?.trim());

  // Any dedicated App ID or PEM means the dedicated App is in play: require
  // its own PEM, webhook secret, and bot user id. Mapping-App fields must not
  // silently pair with a different App ID.
  if (dedicatedAppId || dedicatedKey) {
    if (!dedicatedAppId) {
      throw new Error("eru: issue bot needs ERU_ISSUE_BOT_APP_ID");
    }
    if (!dedicatedKey) {
      throw new Error("eru: issue bot needs ERU_ISSUE_BOT_PRIVATE_KEY or ERU_ISSUE_BOT_PRIVATE_KEY_FILE");
    }
    return {
      appId: dedicatedAppId,
      privateKey: dedicatedKey,
      webhookSecret: requireWebhookSecret(dedicatedWebhook, "ERU_ISSUE_BOT_WEBHOOK_SECRET"),
      botUserId: requireBotUserId(dedicatedBotUser, "ERU_ISSUE_BOT_USER_ID"),
      trustedBotIds: parseIdList(env.ERU_TRUSTED_BOT_IDS, "ERU_TRUSTED_BOT_IDS"),
      hourlyCap: issueBotHourlyCap(env),
      dedicated: true,
    };
  }

  const webhookSecret = mappingWebhook || dedicatedWebhook;
  const botUserRaw = mappingBotUser || dedicatedBotUser;
  const any = Boolean(webhookSecret) || Boolean(botUserRaw) || extras;
  if (!any) return undefined;
  if (!githubAppId) {
    throw new Error("eru: issue bot needs ERU_GITHUB_APP_ID (or ERU_ISSUE_BOT_APP_ID)");
  }
  if (!githubAppPrivateKey) {
    throw new Error("eru: issue bot needs the GitHub App private key (or ERU_ISSUE_BOT_PRIVATE_KEY/_FILE)");
  }
  return {
    appId: githubAppId,
    privateKey: githubAppPrivateKey,
    webhookSecret: requireWebhookSecret(
      webhookSecret,
      "ERU_GITHUB_APP_WEBHOOK_SECRET (or ERU_ISSUE_BOT_WEBHOOK_SECRET)",
    ),
    botUserId: requireBotUserId(
      botUserRaw,
      mappingBotUser ? "ERU_GITHUB_APP_BOT_USER_ID" : "ERU_GITHUB_APP_BOT_USER_ID (or ERU_ISSUE_BOT_USER_ID)",
    ),
    trustedBotIds: parseIdList(env.ERU_TRUSTED_BOT_IDS, "ERU_TRUSTED_BOT_IDS"),
    hourlyCap: issueBotHourlyCap(env),
    dedicated: false,
  };
}

function loadForgeInstance(env: NodeJS.ProcessEnv, kind: "GITLAB" | "FORGEJO"): ForgeInstanceConfig | undefined {
  const label = kind.toLowerCase() as "gitlab" | "forgejo";
  const urlRaw = env[`ERU_${kind}_URL`]?.trim();
  const token = env[`ERU_${kind}_TOKEN`]?.trim();
  const webhookSecret = env[`ERU_${kind}_WEBHOOK_SECRET`]?.trim();
  if (!urlRaw && !token && !webhookSecret) return undefined;
  if (!urlRaw || !token) {
    throw new Error(`eru: ${label} needs ERU_${kind}_URL and ERU_${kind}_TOKEN (or neither)`);
  }
  const origin = normalizeForgeOrigin(urlRaw, label);
  if (!origin) {
    throw new Error(`eru: ERU_${kind}_URL is not an http(s) origin`);
  }
  if (webhookSecret && webhookSecret.length < MIN_WEBHOOK_SECRET) {
    throw new Error(`eru: ERU_${kind}_WEBHOOK_SECRET is too short`);
  }
  return { origin, token, webhookSecret: webhookSecret || undefined };
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
