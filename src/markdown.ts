import { marked } from "marked";
import { escapeHtml } from "./util.js";

// Page bodies are model output — untrusted. Raw HTML in the source is rendered
// as text instead of markup, and link hrefs are filtered to a safe protocol
// allowlist (no javascript:/data: URLs, no event handlers).
marked.setOptions({ gfm: true, breaks: false });

marked.use({
  renderer: {
    html({ text }) {
      return escapeHtml(text);
    },
    link({ href, title, tokens }) {
      const text = this.parser.parseInline(tokens);
      const safe = safeHref(href);
      if (!safe) return text;
      const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
      return `<a href="${escapeHtml(safe)}"${titleAttr}>${text}</a>`;
    },
  },
});

function safeHref(href: string): string | null {
  const trimmed = href.trim();
  if (trimmed === "") return null;
  if (trimmed.startsWith("#") || trimmed.startsWith("/") || trimmed.startsWith("./") || trimmed.startsWith("../")) {
    return trimmed;
  }
  try {
    const url = new URL(trimmed);
    return url.protocol === "https:" || url.protocol === "http:" || url.protocol === "mailto:" ? trimmed : null;
  } catch {
    return null;
  }
}

export function renderMarkdown(source: string): string {
  return marked.parse(source, { async: false });
}
