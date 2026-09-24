import { describe, expect, it } from "vitest";
import { renderMarkdown } from "./markdown.js";

describe("renderMarkdown", () => {
  it("renders common markdown constructs", () => {
    const html = renderMarkdown("## Title\n\nSome **bold** and `code`.\n\n- one\n- two\n");
    expect(html).toContain("<h2");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<code>code</code>");
    expect(html).toContain("<li>one</li>");
  });

  it("renders safe links and drops unsafe protocols", () => {
    expect(renderMarkdown("[ok](https://example.com/x)")).toContain('href="https://example.com/x"');
    expect(renderMarkdown("[rel](/brief/arch)")).toContain('href="/brief/arch"');
    const bad = renderMarkdown("[x](javascript:alert(1))");
    expect(bad).not.toContain("javascript:");
    expect(bad).not.toContain("<a");
    expect(renderMarkdown("[x](data:text/html;base64,AAA)")).not.toContain("data:text/html");
  });

  it("renders raw html as text, never markup", () => {
    const html = renderMarkdown('a <script>alert(1)</script> b <img src=x onerror=alert(1)>');
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;script&gt;");
  });

  it("escapes entities inside attribute contexts", () => {
    const html = renderMarkdown('[x](https://a.com/" onclick="alert(1)")');
    expect(html).not.toContain('onclick="alert(1)"');
  });
});
