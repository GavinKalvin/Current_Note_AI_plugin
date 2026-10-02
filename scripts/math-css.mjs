import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import postcss from "postcss";

const require = createRequire(import.meta.url);

/** Keep the three-file plugin install: bundle scoped styles and WOFF2 as text. */
export async function bundledMathCss() {
  const cssPath = require.resolve("katex/dist/katex.min.css");
  const root = postcss.parse(await readFile(cssPath, "utf8"));
  const fonts = [];
  root.walkAtRules("font-face", (rule) => {
    const src = rule.nodes.find((node) => node.type === "decl" && node.prop === "src");
    const match = src?.value.match(/url\((?:["']?)(fonts\/[^)"']+\.woff2)(?:["']?)\)/u);
    if (!src || !match) throw new Error("KaTeX font is missing its offline WOFF2 source.");
    fonts.push(readFile(path.join(path.dirname(cssPath), match[1])).then((font) => {
      src.value = `url("data:font/woff2;base64,${font.toString("base64")}") format("woff2")`;
    }));
  });
  await Promise.all(fonts);
  root.walkRules((rule) => {
    rule.selectors = rule.selectors.map((selector) => selector === "body"
      ? ".current-note-ai-markdown" : `.current-note-ai-markdown ${selector}`);
  });
  root.walkDecls((decl) => {
    if (decl.prop === "font-family" || decl.prop === "font") decl.value = decl.value.replace(/\bKaTeX_/gu, "CNAI_KaTeX_");
    if (decl.prop.startsWith("counter-")) decl.value = decl.value.replace(/\b(?:katexEqnNo|mmlEqnNo)\b/gu, (name) => `cnai_${name}`);
    if (decl.prop === "content") decl.value = decl.value.replace(/counter\((katexEqnNo|mmlEqnNo)\)/gu, "counter(cnai_$1)");
  });
  const license = await readFile(require.resolve("katex/LICENSE"), "utf8");
  return `/* KaTeX 0.19.0 — offline styles and fonts.\n${license.replace(/\*\//gu, "* /")}\nKaTeX fonts: Copyright (c) 2018 Khan Academy, under the same MIT terms above.\n*/\n${root.toString()}`;
}

export const mathCssPlugin = {
  name: "current-note-ai-offline-math-css",
  setup(build) {
    build.onResolve({ filter: /^katex\/dist\/katex\.min\.css\?raw$/ }, () => ({ path: "katex", namespace: "cnai-math-css" }));
    build.onLoad({ filter: /.*/, namespace: "cnai-math-css" }, async () => ({
      contents: `export default ${JSON.stringify(await bundledMathCss())};`,
      loader: "js",
    }));
  },
};
