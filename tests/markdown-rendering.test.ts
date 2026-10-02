import { describe, expect, it } from "vitest";
import { renderAssistantMarkdown } from "../src/core/markdown-rendering";

describe("assistant Markdown rendering", () => {
  it("handles long repeated soft-break email input with linkification enabled", () => {
    const html = renderAssistantMarkdown("a@b.co\n".repeat(20_000));
    expect(html.match(/href="mailto:a@b\.co"/gu)).toHaveLength(20_000);
  });

  it("keeps long unknown-scheme input readable without linkifying it", () => {
    const source = "a://".repeat(40_000);
    const html = renderAssistantMarkdown(source);
    expect(html).toContain(source);
    expect(html).not.toContain("<a ");
  });

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

  it("renders bold text containing Chinese characters", () => {
    const html = renderAssistantMarkdown("中文 **加粗内容** 仍然正常");

    expect(html).toContain("<strong>加粗内容</strong>");
  });

  it("renders supported inline and display math as KaTeX", () => {
    const html = renderAssistantMarkdown([
      "Inline $E = mc^2$ and \\(a^2 + b^2 = c^2\\).",
      "",
      "$$",
      "\\sum_{i=1}^{n} i",
      "$$",
      "",
      "\\[\\frac{1}{2}\\]",
    ].join("\n"));

    expect(html.match(/class="katex(?:-display)?"/g)?.length).toBeGreaterThanOrEqual(4);
    expect(html).not.toContain("$E = mc^2$");
  });

  it("allows Chinese text inside a formula without treating it as an HTML extension", () => {
    const html = renderAssistantMarkdown("$E = \\text{能量}$");
    expect(html).toContain('class="katex"');
    expect(html).not.toContain("current-note-ai-math-fallback");
    expect(html).toContain("能量");
  });

  it("bounds formula count per message and resets the budget for the next message", () => {
    const html = renderAssistantMarkdown(Array.from({ length: 257 }, () => "$x$").join(" "));
    expect(html.match(/class="katex"/gu)).toHaveLength(256);
    expect(html).toContain('class="current-note-ai-math-fallback"');
    expect(renderAssistantMarkdown("$y$")).not.toContain("current-note-ai-math-fallback");
  });

  it("keeps oversized display formulas readable without invoking the TeX renderer", () => {
    const formula = "x+".repeat(9_000);
    const html = renderAssistantMarkdown(`Before\n\n$$\n${formula}\n$$\n\nAfter`);
    expect(html).toContain("current-note-ai-math-fallback");
    expect(html).toContain(formula);
    expect(html).toContain("Before");
    expect(html).toContain("After");
    expect(html).not.toContain('class="katex"');
  });

  it("leaves code and currency-like dollar text alone", () => {
    const html = renderAssistantMarkdown([
      "Cost: $5 and $10.",
      "",
      "Escaped: \\$5.",
      "",
      "`$x^2$`",
      "",
      "```tex",
      "$x^2$",
      "```",
    ].join("\n"));

    expect(html).toContain("$5 and $10");
    expect(html).toContain("Escaped: $5.");
    expect(html).toContain("<code>$x^2$</code>");
    expect(html).toMatch(/<code class="language-tex">\$x\^2\$\s<\/code>/);
    expect(html).not.toContain('class="katex');
  });

  it("does not render escaped or unclosed math delimiters", () => {
    const html = renderAssistantMarkdown([
      "Escaped inline: \\$x^2\\$.",
      "",
      "Unclosed inline: $x^2 continues as text.",
      "",
      "Unclosed display:",
      "$$",
      "x^2",
    ].join("\n"));

    expect(html).toContain("Escaped inline: $x^2$.");
    expect(html).toContain("Unclosed inline: $x^2 continues as text.");
    expect(html).toContain("x^2");
    expect(html).not.toContain('class="katex');
  });

  it("isolates macro definitions between formulas", () => {
    const html = renderAssistantMarkdown("$\\gdef\\privateMacro{secret}\\privateMacro$ then $\\privateMacro$");

    expect(html).toContain('class="katex"');
    expect(html).toContain("current-note-ai-math-fallback");
    expect(html).toContain("\\privateMacro");
  });

  it("bounds recursive macro expansion and keeps the formula readable", () => {
    const html = renderAssistantMarkdown("Before $\\def\\loop{\\loop}\\loop$ after.");

    expect(html).toContain("Before");
    expect(html).toContain("current-note-ai-math-fallback");
    expect(html).toContain("\\def");
    expect(html).toContain("after.");
  });

  it("keeps invalid or incomplete math readable without dropping the message", () => {
    const html = renderAssistantMarkdown("Before $\\frac{1}{ and after $\\unknowncommand{z}$ tail.");

    expect(html).toContain("Before");
    expect(html).toContain("after");
    expect(html).toContain("tail.");
    expect(html).not.toContain("<script");
  });

  it("does not allow dangerous KaTeX commands to create active content", () => {
    const html = renderAssistantMarkdown([
      "$\\href{javascript:alert(1)}{click}$",
      "$\\includegraphics{https://example.com/track.png}$",
      "$\\htmlStyle{background:url(https://example.com)}{styled}$",
      "$\\htmlClass{attacker-controlled}{styled}$",
    ].join("\n"));

    expect(html).not.toMatch(/<a\b[^>]*\bhref\s*=\s*["']?javascript:/i);
    expect(html).not.toMatch(/<img\b[^>]*\bsrc\s*=/i);
    expect(html).not.toMatch(/<[^>]+\bstyle\s*=\s*["'][^"']*url\s*\(/i);
    expect(html).not.toMatch(/<[^>]+\bclass\s*=\s*["'][^"']*attacker-controlled/i);
    expect(html).toContain("https://example.com/track.png");
    expect(html).toContain("current-note-ai-math-fallback");
    // Normal KaTeX layout styles remain allowed; only untrusted command effects are forbidden.
    expect(renderAssistantMarkdown("$\\frac{1}{2}$")).toContain("style=");
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
