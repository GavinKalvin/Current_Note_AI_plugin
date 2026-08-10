import { describe, expect, it } from "vitest";
import { renderAssistantMarkdown } from "../src/core/markdown-rendering";

describe("assistant Markdown rendering", () => {
  it("renders common Markdown structures", () => {
    const html = renderAssistantMarkdown([
      "## Summary",
      "",
      "- **First** item",
      "- `second` item",
      "",
      "| A | B |",
      "| - | - |",
      "| 1 | 2 |",
    ].join("\n"));

    expect(html).toContain("<h2>Summary</h2>");
    expect(html).toContain("<strong>First</strong>");
    expect(html).toContain("<code>second</code>");
    expect(html).toContain("<table>");
  });

  it("escapes raw HTML and rejects non-web link protocols", () => {
    const html = renderAssistantMarkdown(
      [
        '<script>alert("x")</script>',
        "",
        "[run](javascript:alert(1))",
        "",
        "[command](obsidian://advanced-uri)",
      ].join("\n"),
    );

    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("href=\"javascript:");
    expect(html).not.toContain("href=\"obsidian:");
  });

  it("does not auto-load Markdown or Obsidian embeds", () => {
    const html = renderAssistantMarkdown([
      "![remote](https://example.com/private.png)",
      "",
      "![[Private note]]",
    ].join("\n"));

    expect(html).toContain('[Image: remote]');
    expect(html).not.toContain("<img");
    expect(html).not.toContain("private.png");
    expect(html).toContain("![[Private note]]");
  });

  it("marks links to open without opener access", () => {
    const html = renderAssistantMarkdown("[Source](https://example.com)");

    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
  });
});
