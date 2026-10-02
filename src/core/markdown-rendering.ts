import MarkdownIt, { type Env } from "markdown-it";
import { renderToString } from "katex";

const MAX_MATH_CHARACTERS = 16_384;
const MAX_FORMULAS_PER_MESSAGE = 256;
const MAX_MATH_CHARACTERS_PER_MESSAGE = 65_536;

interface MathRenderBudget extends Env {
  formulas: number;
  characters: number;
}

/** Locate a closing delimiter without treating an escaped dollar/backslash as one. */
function closingDelimiter(source: string, delimiter: string, from: number): number {
  let position = source.indexOf(delimiter, from);
  while (position !== -1) {
    let backslashes = 0;
    for (let index = position - 1; index >= 0 && source[index] === "\\"; index--) backslashes++;
    if (backslashes % 2 === 0) return position;
    position = source.indexOf(delimiter, position + delimiter.length);
  }
  return -1;
}

const markdown = new MarkdownIt({
  breaks: true,
  html: false,
  linkify: true,
  typographer: false,
});

// Parse math before Markdown consumes backslashes or treats TeX punctuation as
// emphasis. Code spans and fenced code retain their normal, inert rendering.
markdown.inline.ruler.before("escape", "current_note_ai_math", (state, silent) => {
  const start = state.pos;
  const source = state.src;
  const open = source.startsWith("\\(", start) ? "\\("
    : source.startsWith("\\[", start) ? "\\["
      : source.startsWith("$$", start) ? "$$"
        : source[start] === "$" ? "$" : null;
  if (!open) return false;
  if (open === "$" && /\s/u.test(source[start + 1] ?? " ")) return false;
  const close = open === "\\(" ? "\\)" : open === "\\[" ? "\\]" : open;
  const remaining = source.slice(start + open.length, Math.min(state.posMax, start + open.length + MAX_MATH_CHARACTERS + close.length));
  const offset = closingDelimiter(remaining, close, 0);
  if (offset === -1) return false;
  const content = remaining.slice(0, offset);
  if (!content.trim() || ((open === "$" || open === "\\(") && content.includes("\n"))) return false;
  // Ordinary prices ($5 and $10) are not formulas. Explicit $5$ still is.
  if (open === "$" && (/\s/u.test(content.at(-1)!) || /\d/u.test(source[start + open.length + offset + close.length] ?? ""))) return false;
  if (!silent) {
    const token = state.push("current_note_ai_math", "", 0);
    token.content = content;
    token.markup = open;
    token.meta = { display: open === "$$" || open === "\\[", original: `${open}${content}${close}` };
  }
  state.pos = start + open.length + offset + close.length;
  return true;
});

markdown.block.ruler.before("fence", "current_note_ai_math_block", (state, startLine, endLine, silent) => {
  if (state.sCount[startLine]! - state.blkIndent >= 4) return false;
  const first = state.src.slice(state.bMarks[startLine]! + state.tShift[startLine]!, state.eMarks[startLine]);
  const open = first.startsWith("$$") ? "$$" : first.startsWith("\\[") ? "\\[" : null;
  if (!open) return false;
  const close = open === "$$" ? "$$" : "\\]";
  const parts: string[] = [];
  let lastLine = startLine;
  for (; lastLine < endLine; lastLine++) {
    if (lastLine > startLine && state.sCount[lastLine]! < state.blkIndent && !state.isEmpty(lastLine)) return false;
    const line = lastLine === startLine ? first.slice(open.length)
      : state.src.slice(state.bMarks[lastLine]! + state.tShift[lastLine]!, state.eMarks[lastLine]);
    const end = closingDelimiter(line, close, 0);
    if (end !== -1) {
      // A same-line sentence containing $$...$$ is handled by the inline rule.
      if (line.slice(end + close.length).trim()) return false;
      parts.push(line.slice(0, end));
      break;
    }
    parts.push(line);
  }
  if (lastLine >= endLine || !parts.join("\n").trim()) return false;
  if (silent) return true;
  const token = state.push("current_note_ai_math", "", 0);
  token.block = true;
  token.map = [startLine, lastLine + 1];
  token.content = parts.join("\n").trim();
  token.markup = open;
  token.meta = { display: true, original: `${open}\n${token.content}\n${close}` };
  state.line = lastLine + 1;
  return true;
}, { alt: ["paragraph", "reference", "blockquote", "list"] });

markdown.renderer.rules.current_note_ai_math = (tokens, index, _options, env) => {
  const token = tokens[index]!;
  const meta = token.meta as { display: boolean; original: string };
  const budget = env as MathRenderBudget;
  budget.formulas++;
  budget.characters += token.content.length;
  try {
    if (token.content.length > MAX_MATH_CHARACTERS || budget.formulas > MAX_FORMULAS_PER_MESSAGE
      || budget.characters > MAX_MATH_CHARACTERS_PER_MESSAGE) throw new Error("Formula budget exceeded");
    return renderToString(token.content, {
      displayMode: meta.display,
      output: "htmlAndMathml",
      throwOnError: true,
      trust: false,
      // Chinese text is useful in formulas; HTML extensions must still fail closed.
      strict: (code) => code === "htmlExtension" ? "error" : "ignore",
      maxExpand: 200,
      maxSize: 20,
      macros: {},
    });
  } catch {
    // Invalid, unsupported or oversized TeX is still selectable and copyable.
    const tag = meta.display ? "div" : "span";
    return `<${tag} class="current-note-ai-math-fallback" title="Formula could not be rendered">${markdown.utils.escapeHtml(meta.original)}</${tag}>`;
  }
};

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
 * Renders conversation Markdown and bounded, untrusted TeX locally without
 * Obsidian/third-party post-processors. HTML is escaped; images never auto-load.
 */
export function renderAssistantMarkdown(source: string): string {
  return markdown.render(source, { formulas: 0, characters: 0 } satisfies MathRenderBudget);
}
