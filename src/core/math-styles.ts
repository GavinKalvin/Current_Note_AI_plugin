import mathCss from "katex/dist/katex.min.css?raw";

/** Styles/fonts are bundled offline and scoped at build time to our bubbles. */
export function appendMathStyles(container: HTMLElement): void {
  const style = container.createEl("style", { attr: { "data-current-note-ai-math": "" } });
  style.textContent = mathCss;
}
