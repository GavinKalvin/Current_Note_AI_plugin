import MarkdownIt from "markdown-it";

const markdown = new MarkdownIt({
  breaks: true,
  html: false,
  linkify: true,
  typographer: false,
});

markdown.validateLink = (url) => /^(?:https?:|mailto:)/i.test(url.trim());

const defaultLinkOpen = markdown.renderer.rules.link_open
  ?? ((tokens, index, options, _env, self) => self.renderToken(tokens, index, options));

markdown.renderer.rules.link_open = (tokens, index, options, env, self) => {
  const token = tokens[index];
  token?.attrSet("target", "_blank");
  token?.attrSet("rel", "noopener noreferrer");
  return defaultLinkOpen(tokens, index, options, env, self);
};

markdown.renderer.rules.image = (tokens, index) => {
  const alt = tokens[index]?.content.trim() || "image";
  return `<span class="current-note-ai-image-placeholder">[Image: ${markdown.utils.escapeHtml(alt)}]</span>`;
};

/**
 * Renders provider-authored Markdown without invoking Obsidian or third-party
 * Markdown post-processors. Raw HTML is escaped and images never auto-load.
 */
export function renderAssistantMarkdown(source: string): string {
  return markdown.render(source);
}
