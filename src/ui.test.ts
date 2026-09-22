import { describe, expect, it } from "vitest";
import { appPage, loginPage } from "./ui.js";

describe("chrome copy", () => {
  it("keeps Brief and Ask labels and omits forbidden words", () => {
    const html = appPage({
      owner: "owner",
      name: "repo",
      lastMappedRef: "main",
      lastMappedLabel: "never",
      csrf: "csrf-token",
      selectedSlug: "architecture",
    });
    expect(html).toContain("Brief");
    expect(html).toContain("Ask");
    expect(html).toContain("last mapped @main");
    expect(html).toContain("hx-post=\"/ask\"");
    expect(html).not.toContain("Eruka");
    expect(html).not.toContain("DeepWiki");
    expect(html).not.toContain("Approve");
    expect(html).not.toContain("Golden");
  });

  it("renders the operator gate without Basic Auth", () => {
    const html = loginPage("Refused.");
    expect(html).toContain("I'm curious about this repo.");
    expect(html).toContain('name="password"');
    expect(html).not.toContain("WWW-Authenticate");
    expect(html).toContain("Refused.");
  });
});
