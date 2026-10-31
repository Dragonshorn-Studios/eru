import { createHmac, generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import {
  enqueueIssueRefineJob,
  listIssueRefineJobs,
  openDb,
  recordWebhookDelivery,
} from "./db.js";
import {
  COMMENT_COMPLETE,
  COMMENT_FAILED,
  COMMENT_NEEDS_INFO,
  ISSUE_BOT_MARKER,
  LABEL_AGENT_READY,
  LABEL_FAILED,
  LABEL_NEEDS_INFO,
  LABEL_REFINED,
  composeIssueBody,
  createIssueBot,
  hasIssueBotMarker,
  openQuestionsEmpty,
  parseRefinedMarkdown,
  shouldEnqueueIssue,
  verifyGithubWebhookSignature,
} from "./issuebot.js";
import { createApp } from "./server.js";
import type { Config } from "./config.js";
import type { FetchLike } from "./forge.js";

const secrets = {
  ERU_UI_PASSWORD: "test-ui-password",
  ERU_UI_SESSION_SECRET: "test-session-secret",
};

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const APP_PEM = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const WEBHOOK_SECRET = "webhook-secret-16+";
const BOT_USER_ID = 9_001;
const OWNER_ID = 42;
const TRUSTED_BOT_ID = 7_777;
const STRANGER_ID = 13;

function issueBotConfig() {
  return loadConfig({
    ...secrets,
    ERU_ISSUE_BOT_APP_ID: "424242",
    ERU_ISSUE_BOT_PRIVATE_KEY: APP_PEM,
    ERU_ISSUE_BOT_WEBHOOK_SECRET: WEBHOOK_SECRET,
    ERU_ISSUE_BOT_USER_ID: String(BOT_USER_ID),
    ERU_TRUSTED_BOT_IDS: String(TRUSTED_BOT_ID),
    ERU_ISSUE_BOT_HOURLY_CAP: "20",
  }).issueBot!;
}

function gatedConfig(overrides: Partial<Config> = {}): Config {
  return {
    host: "127.0.0.1",
    port: 3000,
    sqlitePath: ":memory:",
    uiPassword: "test-ui-password",
    sessionSecret: "test-session-secret",
    loginLimit: 5,
    loginWindowMs: 60_000,
    openCodeBin: "opencode",
    openCodeTimeoutMs: 120_000,
    publicUrl: "http://eru.test",
    oauthAdminIds: [],
    uiLocalLogin: false,
    issueBot: issueBotConfig(),
    ...overrides,
  };
}

function sign(body: string, secret = WEBHOOK_SECRET): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

function openedPayload(opts: {
  body?: string;
  association?: string;
  senderId?: number;
  action?: string;
  number?: number;
  title?: string;
  installationId?: number;
  owner?: string;
  repo?: string;
}): Record<string, unknown> {
  return {
    action: opts.action ?? "opened",
    installation: { id: opts.installationId ?? 555 },
    sender: { id: opts.senderId ?? OWNER_ID, login: "owner" },
    repository: {
      name: opts.repo ?? "box",
      owner: { login: opts.owner ?? "acme" },
    },
    issue: {
      number: opts.number ?? 12,
      title: opts.title ?? "The lights flicker",
      body: opts.body ?? "The hallway lamp is dead.\n\n@eru-issue-bot\n",
      author_association: opts.association ?? "OWNER",
    },
  };
}

async function postWebhook(
  app: ReturnType<typeof createApp>,
  payload: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  const body = JSON.stringify(payload);
  return app.request("/webhooks/github", {
    method: "POST",
    body,
    headers: {
      "Content-Type": "application/json",
      "X-GitHub-Event": "issues",
      "X-GitHub-Delivery": headers["X-GitHub-Delivery"] ?? "deliv-1",
      "X-Hub-Signature-256": headers["X-Hub-Signature-256"] ?? sign(body),
      ...headers,
    },
  });
}

function refinedTemplate(openQuestions = ""): string {
  return [
    "## Problem",
    "The hallway light is out.",
    "## Where",
    "Hallway fixture.",
    "## Is",
    "Dead bulb.",
    "## Want",
    "A working light.",
    "## Context",
    "Night-time safety.",
    "## Done when",
    "The lamp turns on.",
    "## Out of scope",
    "Rewiring the house.",
    "## Open questions",
    openQuestions,
  ].join("\n");
}

interface GhCall {
  method: string;
  path: string;
  body?: unknown;
}

function githubMock(opts: { issueBody: string; issueTitle?: string; calls: GhCall[] }): FetchLike {
  return async (url, init) => {
    const method = (init?.method ?? "GET").toUpperCase();
    const path = new URL(url).pathname;
    let parsed: unknown;
    if (typeof init?.body === "string" && init.body) parsed = JSON.parse(init.body);
    opts.calls.push({ method, path, body: parsed });
    if (path.endsWith("/access_tokens") && method === "POST") {
      return json(201, { token: "ghs_install", expires_at: "2030-01-01T00:00:00Z" });
    }
    if (path.includes("/issues/") && path.endsWith("/reactions") && method === "POST") {
      return json(201, { id: 1 });
    }
    if (path.includes("/issues/") && path.endsWith("/labels") && method === "POST") {
      return json(200, []);
    }
    if (path.includes("/issues/") && path.endsWith("/comments") && method === "POST") {
      return json(201, { id: 2 });
    }
    if (/\/labels$/.test(path) && method === "POST") {
      return json(201, { name: (parsed as { name?: string })?.name });
    }
    if (/\/issues\/\d+$/.test(path) && method === "GET") {
      return json(200, { title: opts.issueTitle ?? "The lights flicker", body: opts.issueBody });
    }
    if (/\/issues\/\d+$/.test(path) && method === "PATCH") {
      return json(200, { body: (parsed as { body?: string })?.body });
    }
    return json(404, { message: "not found" });
  };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function testApp(opts: {
  fetchImpl?: FetchLike;
  refine?: (input: { title: string; body: string }) => Promise<string>;
  now?: () => number;
}) {
  const db = openDb(":memory:");
  const config = gatedConfig();
  const bot = createIssueBot({
    db,
    config: config.issueBot!,
    fetchImpl: opts.fetchImpl ?? (async () => json(500, {})),
    refine: opts.refine ?? (async () => refinedTemplate()),
    now: opts.now,
    backoffMs: () => 0,
  });
  const app = createApp({
    config,
    db,
    fetchImpl: opts.fetchImpl,
    issueBot: bot,
    issueBotAutoStart: false,
    openCodeServe: { url: () => null, password: () => "x", ensure: async () => {}, stop: async () => {} },
  });
  return { app, db, bot };
}

describe("github webhook signature", () => {
  it("accepts a matching HMAC and rejects a bad or missing signature", () => {
    const body = '{"ok":true}';
    const good = sign(body);
    expect(verifyGithubWebhookSignature(WEBHOOK_SECRET, body, good)).toBe(true);
    expect(verifyGithubWebhookSignature(WEBHOOK_SECRET, body, sign(body, "other-secret-16++"))).toBe(false);
    expect(verifyGithubWebhookSignature(WEBHOOK_SECRET, body, undefined)).toBe(false);
    expect(verifyGithubWebhookSignature(WEBHOOK_SECRET, body, "sha1=deadbeef")).toBe(false);
    expect(verifyGithubWebhookSignature(WEBHOOK_SECRET, '{"ok":false}', good)).toBe(false);
  });
});

describe("enqueue filter", () => {
  const opts = { botUserId: BOT_USER_ID, trustedBotIds: [TRUSTED_BOT_ID] };

  it("enqueues an owner-opened issue that mentions the bot", () => {
    expect(shouldEnqueueIssue(openedPayload({ association: "OWNER" }), opts)).toEqual({
      enqueue: true,
      reason: "ok",
    });
    expect(shouldEnqueueIssue(openedPayload({ association: "MEMBER" }), opts).enqueue).toBe(true);
    expect(shouldEnqueueIssue(openedPayload({ association: "COLLABORATOR" }), opts).enqueue).toBe(true);
  });

  it("ignores a stranger, the bot's own sender, and issues without the mention", () => {
    expect(shouldEnqueueIssue(openedPayload({ association: "NONE", senderId: STRANGER_ID }), opts)).toEqual({
      enqueue: false,
      reason: "author",
    });
    expect(shouldEnqueueIssue(openedPayload({ senderId: BOT_USER_ID, association: "NONE" }), opts)).toEqual({
      enqueue: false,
      reason: "own-bot",
    });
    expect(shouldEnqueueIssue(openedPayload({ body: "no mention here" }), opts)).toEqual({
      enqueue: false,
      reason: "mention",
    });
    expect(shouldEnqueueIssue(openedPayload({ action: "edited" }), opts)).toEqual({
      enqueue: false,
      reason: "action",
    });
  });

  it("enqueues an allowlisted bot even when author_association is NONE", () => {
    expect(
      shouldEnqueueIssue(openedPayload({ association: "NONE", senderId: TRUSTED_BOT_ID }), opts),
    ).toEqual({ enqueue: true, reason: "ok" });
  });

  it("skips issues that already carry the marker", () => {
    expect(
      shouldEnqueueIssue(openedPayload({ body: `${ISSUE_BOT_MARKER}\n\n@eru-issue-bot\n` }), opts),
    ).toEqual({ enqueue: false, reason: "marker" });
  });
});

describe("refined body", () => {
  it("keeps the original in a collapsed details block and strips the mention", () => {
    const original = "See ![lamp](https://img.example/lamp.png) and https://acme.test/issue\n\n@eru-issue-bot\n";
    const composed = composeIssueBody(refinedTemplate() + "\n@eru-issue-bot\n", original);
    expect(hasIssueBotMarker(composed)).toBe(true);
    expect(composed).toContain("<summary>Original</summary>");
    expect(composed).toContain("![lamp](https://img.example/lamp.png)");
    expect(composed).toContain("https://acme.test/issue");
    expect(composed.indexOf(ISSUE_BOT_MARKER)).toBeLessThan(composed.indexOf("<details>"));
    const refinedPart = composed.slice(0, composed.indexOf("<details>"));
    expect(refinedPart).not.toMatch(/@eru-issue-bot/);
  });

  it("treats blank / None Open questions as agent-ready", () => {
    expect(openQuestionsEmpty(refinedTemplate(""))).toBe(true);
    expect(openQuestionsEmpty(refinedTemplate("None"))).toBe(true);
    expect(openQuestionsEmpty(refinedTemplate("- None"))).toBe(true);
    expect(openQuestionsEmpty(refinedTemplate("What wattage?"))).toBe(false);
    expect(parseRefinedMarkdown("sorry").ok).toBe(false);
  });
});

describe("POST /webhooks/github", () => {
  it("rejects a bad signature and does not record the delivery", async () => {
    const { app, db } = testApp({});
    const payload = openedPayload({});
    const res = await postWebhook(app, payload, { "X-Hub-Signature-256": sign(JSON.stringify(payload), "wrong-secret-16++") });
    expect(res.status).toBe(401);
    expect(listIssueRefineJobs(db)).toEqual([]);
    const n = db.prepare(`SELECT COUNT(*) AS n FROM github_webhook_deliveries`).get() as { n: number };
    expect(n.n).toBe(0);
  });

  it("ignores a duplicate delivery id", async () => {
    const { app, db } = testApp({});
    const payload = openedPayload({});
    const first = await postWebhook(app, payload, { "X-GitHub-Delivery": "same-deliv" });
    const second = await postWebhook(app, payload, { "X-GitHub-Delivery": "same-deliv" });
    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    expect(listIssueRefineJobs(db)).toHaveLength(1);
  });

  it("does not enqueue a stranger, own bot, or marker; does enqueue owner and allowlisted bot", async () => {
    const { app, db } = testApp({});
    const cases: Array<{ payload: Record<string, unknown>; delivery: string; jobs: number }> = [
      { payload: openedPayload({ association: "NONE", senderId: STRANGER_ID }), delivery: "d-stranger", jobs: 0 },
      { payload: openedPayload({ senderId: BOT_USER_ID }), delivery: "d-own", jobs: 0 },
      {
        payload: openedPayload({ body: `${ISSUE_BOT_MARKER}\nhello\n@eru-issue-bot\n` }),
        delivery: "d-marker",
        jobs: 0,
      },
      { payload: openedPayload({ association: "OWNER", senderId: OWNER_ID }), delivery: "d-owner", jobs: 1 },
      {
        payload: openedPayload({ association: "NONE", senderId: TRUSTED_BOT_ID, number: 13 }),
        delivery: "d-trusted",
        jobs: 2,
      },
    ];
    for (const row of cases) {
      const res = await postWebhook(app, row.payload, { "X-GitHub-Delivery": row.delivery });
      expect(res.status).toBe(202);
      expect(listIssueRefineJobs(db)).toHaveLength(row.jobs);
    }
  });

  it("does not enqueue past the per-repo hourly cap", async () => {
    const { app, db } = testApp({});
    db.prepare(`DELETE FROM issue_refine_jobs`).run();
    const cfg = gatedConfig();
    cfg.issueBot = { ...cfg.issueBot!, hourlyCap: 1 };
    const bot = createIssueBot({
      db,
      config: cfg.issueBot,
      fetchImpl: async () => json(500, {}),
      refine: async () => refinedTemplate(),
      backoffMs: () => 0,
    });
    const capped = createApp({
      config: cfg,
      db,
      issueBot: bot,
      issueBotAutoStart: false,
      openCodeServe: { url: () => null, password: () => "x", ensure: async () => {}, stop: async () => {} },
    });
    expect((await postWebhook(capped, openedPayload({ number: 1 }), { "X-GitHub-Delivery": "cap-1" })).status).toBe(202);
    expect((await postWebhook(capped, openedPayload({ number: 2 }), { "X-GitHub-Delivery": "cap-2" })).status).toBe(202);
    expect(listIssueRefineJobs(db)).toHaveLength(1);
  });

  it("returns 404 when the issue bot is not configured", async () => {
    const db = openDb(":memory:");
    const app = createApp({
      config: gatedConfig({ issueBot: undefined }),
      db,
      issueBotAutoStart: false,
      openCodeServe: { url: () => null, password: () => "x", ensure: async () => {}, stop: async () => {} },
    });
    const res = await app.request("/webhooks/github", { method: "POST", body: "{}" });
    expect(res.status).toBe(404);
  });
});

describe("issue refine worker", () => {
  it("rewrites the body, labels agent-ready, and comments when Open questions is empty", async () => {
    const original = "The hallway lamp is dead.\n\n@eru-issue-bot\n";
    const calls: GhCall[] = [];
    const { app, db, bot } = testApp({
      fetchImpl: githubMock({ issueBody: original, calls }),
      refine: async () => refinedTemplate(""),
    });
    const res = await postWebhook(app, openedPayload({ body: original }));
    expect(res.status).toBe(202);
    await bot.processDue();
    const job = listIssueRefineJobs(db)[0];
    expect(job.status).toBe("done");
    const patch = calls.find((c) => c.method === "PATCH" && /\/issues\/12$/.test(c.path));
    expect(patch?.body).toEqual({ body: expect.stringContaining(ISSUE_BOT_MARKER) });
    const patched = (patch?.body as { body: string }).body;
    expect(patched).toContain("<summary>Original</summary>");
    expect(patched).toContain(original.trim());
    expect(calls.some((c) => c.method === "POST" && c.path.endsWith("/reactions"))).toBe(true);
    const labelAdds = calls.filter((c) => c.method === "POST" && c.path.endsWith("/issues/12/labels"));
    expect(labelAdds.some((c) => JSON.stringify(c.body).includes(LABEL_REFINED))).toBe(true);
    expect(labelAdds.some((c) => JSON.stringify(c.body).includes(LABEL_AGENT_READY))).toBe(true);
    const comment = calls.find((c) => c.method === "POST" && c.path.endsWith("/comments"));
    expect(comment?.body).toEqual({ body: COMMENT_COMPLETE });
  });

  it("labels needs-info when Open questions is not empty", async () => {
    const original = "Something is wrong.\n\n@eru-issue-bot\n";
    const calls: GhCall[] = [];
    const { app, bot } = testApp({
      fetchImpl: githubMock({ issueBody: original, calls }),
      refine: async () => refinedTemplate("What wattage should the bulb be?"),
    });
    await postWebhook(app, openedPayload({ body: original }));
    await bot.processDue();
    const labelAdds = calls.filter((c) => c.method === "POST" && c.path.endsWith("/issues/12/labels"));
    expect(JSON.stringify(labelAdds)).toContain(LABEL_NEEDS_INFO);
    const comment = calls.find((c) => c.method === "POST" && c.path.endsWith("/comments"));
    expect(comment?.body).toEqual({ body: COMMENT_NEEDS_INFO });
  });

  it("skips write-back when the live issue already carries the marker", async () => {
    const original = "The hallway lamp is dead.\n\n@eru-issue-bot\n";
    const calls: GhCall[] = [];
    const { db, bot } = testApp({
      fetchImpl: githubMock({
        issueBody: composeIssueBody(refinedTemplate(), original),
        calls,
      }),
    });
    recordWebhookDelivery(db, "deliv-marker-live", "2026-01-01T00:00:00Z");
    enqueueIssueRefineJob(
      db,
      {
        deliveryId: "deliv-marker-live",
        installationId: "555",
        owner: "acme",
        name: "box",
        issueNumber: 12,
        title: "The lights flicker",
        body: original,
      },
      "2026-01-01T00:00:00Z",
    );
    await bot.processDue();
    expect(listIssueRefineJobs(db)[0].status).toBe("skipped");
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
    expect(calls.some((c) => c.method === "POST" && c.path.endsWith("/comments"))).toBe(false);
  });

  it("does not modify the issue body after three failed attempts", async () => {
    const original = "The hallway lamp is dead.\n\n@eru-issue-bot\n";
    const calls: GhCall[] = [];
    const { app, db, bot } = testApp({
      fetchImpl: githubMock({ issueBody: original, calls }),
      refine: async () => {
        throw new Error("model down");
      },
    });
    await postWebhook(app, openedPayload({ body: original }));
    await bot.processDue();
    expect(listIssueRefineJobs(db)[0].status).toBe("failed");
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
    const labelAdds = calls.filter((c) => c.method === "POST" && c.path.endsWith("/issues/12/labels"));
    expect(JSON.stringify(labelAdds)).toContain(LABEL_FAILED);
    const comments = calls.filter((c) => c.method === "POST" && c.path.endsWith("/comments"));
    expect(comments.some((c) => (c.body as { body: string }).body === COMMENT_FAILED)).toBe(true);
  });
});
