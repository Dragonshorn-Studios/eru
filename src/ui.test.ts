import { describe, expect, it } from "vitest";
import { appPage, loginPage } from "./ui.js";

describe("chrome copy", () => {
  it("keeps Brief and Ask labels and omits forbidden words", () => {
    const html = appPage({
      repo: { id: 1, owner: "owner", name: "repo", defaultBranch: "main", lastMappedRef: "main", lastMappedLabel: "never" },
      repos: [{ id: 1, owner: "owner", name: "repo" }],
      user: { name: "operator", avatarUrl: null },
      path: "/",
      csrf: "csrf-token",
      pages: [{ slug: "architecture", title: "Architecture" }],
      page: { id: 1, slug: "architecture", title: "Architecture", body: "body", sortOrder: 0, mappedRef: "main", updatedAt: "" },
    });
    expect(html).toContain("Brief");
    expect(html).toContain("Ask");
    expect(html).toContain("last mapped @main");
    expect(html).toContain('href="/ask"');
    expect(html).toContain("not a checkout job, not DeepWiki.com");
    expect(html).toContain('class="tab" href="/" aria-current="page">Brief');
    expect(html).toContain('class="tab" href="/ask">Ask');
    expect(html).not.toContain("Eruka");
    expect(html).not.toContain("Approve");
    expect(html).not.toContain("Golden");
  });

  it("renders the operator gate without Basic Auth", () => {
    const html = loginPage({ error: "Refused." });
    expect(html).toContain("I'm curious about this repo.");
    expect(html).toContain('rel="icon" href="/favicon.ico"');
    expect(html).toContain('rel="apple-touch-icon" href="/assets/apple-touch-icon.png"');
    expect(html).toContain('name="password"');
    expect(html).not.toContain("WWW-Authenticate");
    expect(html).toContain("Refused.");
  });
});
