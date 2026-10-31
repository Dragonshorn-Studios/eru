import { createHmac, generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "./config.js";
import {
  enqueueIssueRefineJob,
  listIssueRefineJobs,
  listWebhookLogs,
  openDb,
  upsertConnectedRepo,
} from "./db.js";
import {
  COMMENT_COMPLETE,
  COMMENT_FAILED,
  COMMENT_NEEDS_INFO,
  GITHUB_ISSUE_BODY_MAX,
  ISSUE_BOT_MARKER,
  ISSUE_BOT_MAX_BODY_BYTES,
  LABEL_AGENT_READY,
  LABEL_FAILED,
  LABEL_NEEDS_INFO,
  LABEL_REFINED,
  composeIssueBody,
  createIssueBot,
  hasIssueBotMarker,
  openQuestionsEmpty,
  parseRefinedMarkdown,
  shouldEnqueueForgejoIssue,
  shouldEnqueueGitlabIssue,
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
    if (path.includes("/issues/") && path.endsWith("/comments") && method === "GET") {
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
  gitlab?: Config["gitlab"];
  forgejo?: Config["forgejo"];
}) {
  const db = openDb(":memory:");
  upsertConnectedRepo(db, { forge: "github", owner: "acme", name: "box" }, "2026-01-01T00:00:00Z");
  if (opts.gitlab) {
    upsertConnectedRepo(
      db,
      { forge: "gitlab", owner: "acme", name: "box", origin: opts.gitlab.origin },
      "2026-01-01T00:00:00Z",
      "instance",
    );
  }
  if (opts.forgejo) {
    upsertConnectedRepo(
      db,
      { forge: "forgejo", owner: "acme", name: "box", origin: opts.forgejo.origin },
      "2026-01-01T00:00:00Z",
      "instance",
    );
  }
  const config = gatedConfig({ gitlab: opts.gitlab, forgejo: opts.forgejo });
  const bot = createIssueBot({
    db,
    config: config.issueBot!,
    gitlab: config.gitlab,
    forgejo: config.forgejo,
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
    const decision = shouldEnqueueIssue(openedPayload({ association: "OWNER" }), opts);
    expect(decision).toEqual({
      enqueue: true,
      target: {
        forge: "github",
        installationId: "555",
        owner: "acme",
        name: "box",
        issueNumber: 12,
        title: "The lights flicker",
        body: "The hallway lamp is dead.\n\n@eru-issue-bot\n",
      },
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
    expect(shouldEnqueueIssue(openedPayload({ action: "closed" }), opts)).toEqual({
      enqueue: false,
      reason: "action",
    });
    expect(shouldEnqueueIssue(openedPayload({ action: "edited" }), opts).enqueue).toBe(true);
    expect(
      shouldEnqueueIssue(openedPayload({ body: "no mention here", title: "please @eru-issue-bot" }), opts).enqueue,
    ).toBe(true);
  });

  it("enqueues an allowlisted bot even when author_association is NONE", () => {
    expect(
      shouldEnqueueIssue(openedPayload({ association: "NONE", senderId: TRUSTED_BOT_ID }), opts).enqueue,
    ).toBe(true);
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

  it("truncates a long original so the composed body stays under GitHub's limit", () => {
    const original = "a".repeat(70_000);
    const composed = composeIssueBody(refinedTemplate(), original);
    expect(composed.length).toBeLessThanOrEqual(GITHUB_ISSUE_BODY_MAX);
    expect(composed).toContain("truncated");
    expect(composed).toContain("<summary>Original</summary>");
  });

  it("neutralizes @mentions in model output", () => {
    const parsed = parseRefinedMarkdown(`${refinedTemplate("")}\ncc @evil-user and @acme/team\n`);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.text).toContain("`@evil-user`");
    expect(parsed.text).toContain("`@acme/team`");
    expect(parsed.text).not.toMatch(/(^|[^`])@evil-user\b/);
  });
});

describe("POST /webhooks/github", () => {
  it("rejects a bad signature and does not enqueue a job", async () => {
    const { app, db } = testApp({});
    const payload = openedPayload({});
    const res = await postWebhook(app, payload, { "X-Hub-Signature-256": sign(JSON.stringify(payload), "wrong-secret-16++") });
    expect(res.status).toBe(401);
    expect(listIssueRefineJobs(db)).toEqual([]);
    expect(listWebhookLogs(db)[0]).toMatchObject({ outcome: "rejected", reason: "signature" });
    expect(listWebhookLogs(db)[0].detail).toContain("did not match");
  });

  it("ignores a second webhook for the same issue", async () => {
    const { app, db } = testApp({});
    const payload = openedPayload({});
    const first = await postWebhook(app, payload, { "X-GitHub-Delivery": "deliv-a" });
    const second = await postWebhook(app, payload, { "X-GitHub-Delivery": "deliv-b" });
    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    expect(listIssueRefineJobs(db)).toHaveLength(1);
  });

  it("rejects a payload larger than ISSUE_BOT_MAX_BODY_BYTES", async () => {
    const { app } = testApp({});
    const body = "x".repeat(ISSUE_BOT_MAX_BODY_BYTES + 1);
    const res = await app.request("/webhooks/github", {
      method: "POST",
      body,
      headers: {
        "Content-Type": "text/plain",
        "Content-Length": String(body.length),
        "X-GitHub-Event": "issues",
        "X-GitHub-Delivery": "too-big",
        "X-Hub-Signature-256": sign(body),
      },
    });
    expect(res.status).toBe(413);
  });

  it("rejects an oversized payload without Content-Length", async () => {
    const { app } = testApp({});
    const payload = "x".repeat(ISSUE_BOT_MAX_BODY_BYTES + 1);
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(payload));
        controller.close();
      },
    });
    const res = await app.request(
      new Request("http://localhost/webhooks/github", {
        method: "POST",
        body,
        duplex: "half",
        headers: {
          "Content-Type": "text/plain",
          "X-GitHub-Event": "issues",
          "X-GitHub-Delivery": "too-big-chunked",
          "X-Hub-Signature-256": sign(payload),
        },
      } as RequestInit),
    );
    expect(res.status).toBe(413);
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

  it("accepts a signed webhook from an unconnected repo without enqueueing", async () => {
    const { app, db } = testApp({});
    const res = await postWebhook(app, openedPayload({ owner: "other", repo: "lamp" }), {
      "X-GitHub-Delivery": "d-unconnected",
    });
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({
      ok: true,
      outcome: "ignored",
      reason: "unconnected",
      forge: "github",
      repo: "other/lamp",
      issue: 12,
      event: "issues",
      action: "opened",
      delivery: "d-unconnected",
      jobId: null,
    });
    expect(listIssueRefineJobs(db)).toEqual([]);
    expect(listWebhookLogs(db)[0].detail).toContain("not connected");
  });

  it("puts the decision and repo on the 202 body and on the server log", async () => {
    const { app, db } = testApp({});
    const lines: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((line?: unknown) => {
      if (typeof line === "string" && line.startsWith("issuebot webhook")) lines.push(line);
    });
    try {
      const missed = await postWebhook(app, openedPayload({ body: "no mention", title: "Lamp" }), {
        "X-GitHub-Delivery": "d-mention",
      });
      expect(missed.status).toBe(202);
      const missedBody = (await missed.json()) as Record<string, unknown>;
      expect(missedBody).toMatchObject({
        ok: true,
        outcome: "ignored",
        reason: "mention",
        forge: "github",
        repo: "acme/box",
        issue: 12,
        event: "issues",
        action: "opened",
        delivery: "d-mention",
        jobId: null,
      });
      expect(missedBody.detail).toEqual(expect.stringContaining("@eru-issue-bot"));
      expect(JSON.stringify(missedBody)).not.toContain("no mention");

      const queued = await postWebhook(app, openedPayload({}), { "X-GitHub-Delivery": "d-queue" });
      const queuedBody = (await queued.json()) as { jobId: number; detail: string };
      expect(queuedBody).toMatchObject({
        ok: true,
        outcome: "queued",
        reason: "queued",
        forge: "github",
        repo: "acme/box",
        issue: 12,
        delivery: "d-queue",
      });
      expect(queuedBody.jobId).toBe(listIssueRefineJobs(db)[0]?.id);
      expect(queuedBody.detail).toContain("acme/box");
      expect(JSON.stringify(queuedBody)).not.toContain("hallway");

      const pingRaw = JSON.stringify({ zen: "keep it logically awesome" });
      const ping = await app.request("/webhooks/github", {
        method: "POST",
        body: pingRaw,
        headers: {
          "Content-Type": "application/json",
          "X-GitHub-Event": "ping",
          "X-GitHub-Delivery": "d-ping",
          "X-Hub-Signature-256": sign(pingRaw),
        },
      });
      expect(ping.status).toBe(202);
      expect(await ping.json()).toMatchObject({
        ok: true,
        outcome: "ignored",
        reason: "event",
        forge: "github",
        repo: null,
        issue: null,
        event: "ping",
        delivery: "d-ping",
        jobId: null,
      });
    } finally {
      spy.mockRestore();
    }
    expect(lines.some((line) => line.includes("repo=acme/box#12") && line.includes("reason=mention"))).toBe(true);
    expect(lines.some((line) => line.includes("outcome=queued") && line.includes("reason=queued"))).toBe(true);
    expect(lines.some((line) => line.includes("event=ping") && line.includes("reason=event"))).toBe(true);
    expect(lines.join("\n")).not.toContain(WEBHOOK_SECRET);
    expect(lines.join("\n")).not.toContain("hallway");
  });

  it("enqueues a connected repo even when owner and name casing differ", async () => {
    const { app, db } = testApp({});
    const res = await postWebhook(app, openedPayload({ owner: "ACME", repo: "BOX" }), {
      "X-GitHub-Delivery": "d-case",
    });
    expect(res.status).toBe(202);
    expect(listIssueRefineJobs(db)).toHaveLength(1);
    expect(listIssueRefineJobs(db)[0]).toMatchObject({ owner: "ACME", name: "BOX" });
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
    expect(job.outcome).toBe("agent-ready");
    expect(job.refined).toContain("## Problem");
    expect(job.why).toContain("agent-ready");
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

  it("finishes labels and comment when the live body already carries the marker", async () => {
    const original = "The hallway lamp is dead.\n\n@eru-issue-bot\n";
    const calls: GhCall[] = [];
    const { db, bot } = testApp({
      fetchImpl: githubMock({
        issueBody: composeIssueBody(refinedTemplate(), original),
        calls,
      }),
    });
    enqueueIssueRefineJob(
      db,
      {
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
    expect(listIssueRefineJobs(db)[0].status).toBe("done");
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
    const labelAdds = calls.filter((c) => c.method === "POST" && c.path.endsWith("/issues/12/labels"));
    expect(labelAdds.some((c) => JSON.stringify(c.body).includes(LABEL_REFINED))).toBe(true);
    expect(labelAdds.some((c) => JSON.stringify(c.body).includes(LABEL_AGENT_READY))).toBe(true);
    const comment = calls.find((c) => c.method === "POST" && c.path.endsWith("/comments"));
    expect(comment?.body).toEqual({ body: COMMENT_COMPLETE });
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

  it("rewrites a GitLab issue with PUT description, labels, note, and award", async () => {
    const original = "The hallway lamp is dead.\n\n@eru-issue-bot\n";
    const calls: { method: string; path: string; body?: unknown }[] = [];
    const fetchImpl: FetchLike = async (url, init) => {
      const method = (init?.method ?? "GET").toUpperCase();
      const parsedUrl = new URL(url);
      const path = parsedUrl.pathname + parsedUrl.search;
      let parsed: unknown;
      if (typeof init?.body === "string" && init.body) parsed = JSON.parse(init.body);
      calls.push({ method, path, body: parsed });
      if (path.includes("/issues/12") && !path.includes("/notes") && !path.includes("/award") && !path.includes("/labels") && method === "GET") {
        return json(200, { title: "The lights flicker", description: original });
      }
      if (path.includes("/issues/12") && method === "PUT") return json(200, {});
      if (path.includes("/labels") && method === "POST") return json(201, {});
      if (path.includes("/notes") && method === "GET") return json(200, []);
      if (path.includes("/notes") && method === "POST") return json(201, { id: 1 });
      if (path.includes("/award_emoji") && method === "POST") return json(201, {});
      return json(404, {});
    };
    const { db, bot } = testApp({
      fetchImpl,
      gitlab: { origin: "https://git.example", token: "glpat-x", webhookSecret: "gitlab-webhook-16+" },
      refine: async () => refinedTemplate(""),
    });
    enqueueIssueRefineJob(
      db,
      {
        forge: "gitlab",
        installationId: "-",
        owner: "acme",
        name: "box",
        issueNumber: 12,
        title: "The lights flicker",
        body: original,
      },
      "2026-01-01T00:00:00Z",
    );
    await bot.processDue();
    expect(listIssueRefineJobs(db)[0].status).toBe("done");
    const put = calls.find((c) => c.method === "PUT" && /\/issues\/12$/.test(c.path));
    expect((put?.body as { description: string }).description).toContain(ISSUE_BOT_MARKER);
    expect(calls.some((c) => c.method === "POST" && c.path.includes("/notes"))).toBe(true);
    expect(calls.some((c) => c.method === "PUT" && JSON.stringify(c.body).includes("add_labels"))).toBe(true);
    expect(calls.some((c) => c.method === "POST" && c.path.includes("/award_emoji"))).toBe(true);
  });

  it("rewrites a Forgejo issue with PATCH, labels, comment, and reaction", async () => {
    const original = "The hallway lamp is dead.\n\n@eru-issue-bot\n";
    const calls: { method: string; path: string; body?: unknown }[] = [];
    const fetchImpl: FetchLike = async (url, init) => {
      const method = (init?.method ?? "GET").toUpperCase();
      const parsedUrl = new URL(url);
      const path = parsedUrl.pathname;
      let parsed: unknown;
      if (typeof init?.body === "string" && init.body) parsed = JSON.parse(init.body);
      calls.push({ method, path, body: parsed });
      if (/\/issues\/12$/.test(path) && method === "GET") {
        return json(200, { title: "The lights flicker", body: original });
      }
      if (/\/issues\/12$/.test(path) && method === "PATCH") return json(200, {});
      if (path.endsWith("/labels") && !path.includes("/issues/") && method === "GET") return json(200, []);
      if (path.endsWith("/labels") && !path.includes("/issues/") && method === "POST") {
        return json(201, { id: 11, name: (parsed as { name?: string }).name });
      }
      if (path.includes("/issues/12/labels") && method === "POST") return json(200, []);
      if (path.includes("/comments") && method === "GET") return json(200, []);
      if (path.includes("/comments") && method === "POST") return json(201, { id: 2 });
      if (path.includes("/reactions") && method === "POST") return json(201, {});
      return json(404, {});
    };
    const { db, bot } = testApp({
      fetchImpl,
      forgejo: { origin: "https://git.example", token: "tok", webhookSecret: "forgejo-webhook-16+" },
      refine: async () => refinedTemplate(""),
    });
    enqueueIssueRefineJob(
      db,
      {
        forge: "forgejo",
        installationId: "-",
        owner: "acme",
        name: "box",
        issueNumber: 12,
        title: "The lights flicker",
        body: original,
      },
      "2026-01-01T00:00:00Z",
    );
    await bot.processDue();
    expect(listIssueRefineJobs(db)[0].status).toBe("done");
    const patch = calls.find((c) => c.method === "PATCH" && /\/issues\/12$/.test(c.path));
    expect((patch?.body as { body: string }).body).toContain(ISSUE_BOT_MARKER);
    expect(calls.some((c) => c.method === "POST" && c.path.endsWith("/comments"))).toBe(true);
    expect(calls.some((c) => c.method === "POST" && c.path.includes("/issues/12/labels"))).toBe(true);
    expect(calls.some((c) => c.method === "POST" && c.path.endsWith("/reactions"))).toBe(true);
  });

  it("completes a queued job without forge writes when the repo is no longer connected", async () => {
    const original = "The hallway lamp is dead.\n\n@eru-issue-bot\n";
    const calls: GhCall[] = [];
    const { db, bot } = testApp({
      fetchImpl: githubMock({ issueBody: original, calls }),
      refine: async () => refinedTemplate(""),
    });
    enqueueIssueRefineJob(
      db,
      {
        installationId: "555",
        owner: "acme",
        name: "box",
        issueNumber: 12,
        title: "The lights flicker",
        body: original,
      },
      "2026-01-01T00:00:00Z",
    );
    db.prepare(`DELETE FROM repos`).run();
    await bot.processDue();
    expect(listIssueRefineJobs(db)[0].status).toBe("done");
    expect(listIssueRefineJobs(db)[0].outcome).toBe("skipped");
    expect(listIssueRefineJobs(db)[0].why).toContain("no longer connected");
    expect(calls).toEqual([]);
  });
});

function gitlabOpened(
  opts: { description?: string; action?: string; iid?: number; path?: string } = {},
): Record<string, unknown> {
  return {
    object_kind: "issue",
    user: { id: OWNER_ID },
    project: { path_with_namespace: opts.path ?? "acme/box" },
    object_attributes: {
      action: opts.action ?? "open",
      iid: opts.iid ?? 12,
      title: "The lights flicker",
      description: opts.description ?? "The hallway lamp is dead.\n\n@eru-issue-bot\n",
    },
  };
}

function forgejoOpened(
  opts: { body?: string; action?: string; number?: number; owner?: string; repo?: string } = {},
): Record<string, unknown> {
  return {
    action: opts.action ?? "opened",
    sender: { id: OWNER_ID },
    repository: { name: opts.repo ?? "box", owner: { login: opts.owner ?? "acme" } },
    issue: {
      number: opts.number ?? 12,
      title: "The lights flicker",
      body: opts.body ?? "The hallway lamp is dead.\n\n@eru-issue-bot\n",
    },
  };
}

describe("gitlab and forgejo enqueue filters", () => {
  it("enqueues a GitLab issue open that mentions the bot", () => {
    const decision = shouldEnqueueGitlabIssue(gitlabOpened(), { trustedBotIds: [] });
    expect(decision).toEqual({
      enqueue: true,
      target: {
        forge: "gitlab",
        installationId: "-",
        owner: "acme",
        name: "box",
        issueNumber: 12,
        title: "The lights flicker",
        body: "The hallway lamp is dead.\n\n@eru-issue-bot\n",
      },
    });
    expect(shouldEnqueueGitlabIssue(gitlabOpened({ action: "update" }), { trustedBotIds: [] }).enqueue).toBe(false);
    expect(shouldEnqueueGitlabIssue(gitlabOpened({ description: "no mention" }), { trustedBotIds: [] }).enqueue).toBe(
      false,
    );
  });

  it("enqueues a Forgejo issue opened that mentions the bot", () => {
    const decision = shouldEnqueueForgejoIssue(forgejoOpened(), { trustedBotIds: [] });
    expect(decision.enqueue).toBe(true);
    if (decision.enqueue) expect(decision.target.forge).toBe("forgejo");
    expect(shouldEnqueueForgejoIssue(forgejoOpened({ action: "closed" }), { trustedBotIds: [] }).enqueue).toBe(false);
  });
});

describe("POST /webhooks/gitlab and /webhooks/forgejo", () => {
  const GITLAB_SECRET = "gitlab-webhook-16+";
  const FORGEJO_SECRET = "forgejo-webhook-16+";

  function instanceApp() {
    const db = openDb(":memory:");
    upsertConnectedRepo(
      db,
      { forge: "gitlab", owner: "acme", name: "box", origin: "https://git.example" },
      "2026-01-01T00:00:00Z",
      "instance",
    );
    upsertConnectedRepo(
      db,
      { forge: "forgejo", owner: "acme", name: "box", origin: "https://git.example" },
      "2026-01-01T00:00:00Z",
      "instance",
    );
    const config = gatedConfig({
      gitlab: { origin: "https://git.example", token: "glpat-x", webhookSecret: GITLAB_SECRET },
      forgejo: { origin: "https://git.example", token: "tok", webhookSecret: FORGEJO_SECRET },
    });
    const bot = createIssueBot({
      db,
      config: config.issueBot,
      gitlab: config.gitlab,
      forgejo: config.forgejo,
      fetchImpl: async () => json(500, {}),
      refine: async () => refinedTemplate(),
      backoffMs: () => 0,
    });
    const app = createApp({
      config,
      db,
      issueBot: bot,
      issueBotAutoStart: false,
      openCodeServe: { url: () => null, password: () => "x", ensure: async () => {}, stop: async () => {} },
    });
    return { app, db };
  }

  it("accepts a GitLab Issue Hook with a matching token and ignores a bad token", async () => {
    const { app, db } = instanceApp();
    const payload = gitlabOpened();
    const bad = await app.request("/webhooks/gitlab", {
      method: "POST",
      body: JSON.stringify(payload),
      headers: { "Content-Type": "application/json", "X-Gitlab-Event": "Issue Hook", "X-Gitlab-Token": "nope-nope-nope-nope" },
    });
    expect(bad.status).toBe(401);
    const good = await app.request("/webhooks/gitlab", {
      method: "POST",
      body: JSON.stringify(payload),
      headers: { "Content-Type": "application/json", "X-Gitlab-Event": "Issue Hook", "X-Gitlab-Token": GITLAB_SECRET },
    });
    expect(good.status).toBe(202);
    expect(listIssueRefineJobs(db)).toHaveLength(1);
    expect(listIssueRefineJobs(db)[0].forge).toBe("gitlab");
  });

  it("accepts a Forgejo issues webhook with a matching HMAC", async () => {
    const { app, db } = instanceApp();
    const payload = JSON.stringify(forgejoOpened());
    const sig = createHmac("sha256", FORGEJO_SECRET).update(payload).digest("hex");
    const res = await app.request("/webhooks/forgejo", {
      method: "POST",
      body: payload,
      headers: { "Content-Type": "application/json", "X-Gitea-Event": "issues", "X-Gitea-Signature": sig },
    });
    expect(res.status).toBe(202);
    expect(listIssueRefineJobs(db)[0].forge).toBe("forgejo");
  });

  it("ignores a signed GitLab or Forgejo webhook from an unconnected repo", async () => {
    const { app, db } = instanceApp();
    const gitlab = await app.request("/webhooks/gitlab", {
      method: "POST",
      body: JSON.stringify(gitlabOpened({ path: "other/lamp" })),
      headers: { "Content-Type": "application/json", "X-Gitlab-Event": "Issue Hook", "X-Gitlab-Token": GITLAB_SECRET },
    });
    expect(gitlab.status).toBe(202);
    expect(await gitlab.json()).toMatchObject({
      ok: true,
      outcome: "ignored",
      reason: "unconnected",
      forge: "gitlab",
      repo: "other/lamp",
    });
    const payload = JSON.stringify(forgejoOpened({ owner: "other", repo: "lamp" }));
    const sig = createHmac("sha256", FORGEJO_SECRET).update(payload).digest("hex");
    const forgejo = await app.request("/webhooks/forgejo", {
      method: "POST",
      body: payload,
      headers: { "Content-Type": "application/json", "X-Gitea-Event": "issues", "X-Gitea-Signature": sig },
    });
    expect(forgejo.status).toBe(202);
    expect(await forgejo.json()).toMatchObject({
      ok: true,
      outcome: "ignored",
      reason: "unconnected",
      forge: "forgejo",
      repo: "other/lamp",
    });
    expect(listIssueRefineJobs(db)).toEqual([]);
  });

  it("returns 404 when GitLab or Forgejo webhook secrets are missing", async () => {
    const db = openDb(":memory:");
    const config = gatedConfig({
      gitlab: { origin: "https://git.example", token: "glpat-x" },
      forgejo: { origin: "https://git.example", token: "tok" },
    });
    const bot = createIssueBot({
      db,
      config: config.issueBot,
      gitlab: config.gitlab,
      forgejo: config.forgejo,
      fetchImpl: async () => json(500, {}),
      refine: async () => refinedTemplate(),
      backoffMs: () => 0,
    });
    const app = createApp({
      config,
      db,
      issueBot: bot,
      issueBotAutoStart: false,
      openCodeServe: { url: () => null, password: () => "x", ensure: async () => {}, stop: async () => {} },
    });
    expect((await app.request("/webhooks/gitlab", { method: "POST", body: "{}" })).status).toBe(404);
    expect((await app.request("/webhooks/forgejo", { method: "POST", body: "{}" })).status).toBe(404);
  });
});
