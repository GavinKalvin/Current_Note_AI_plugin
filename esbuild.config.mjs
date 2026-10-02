import esbuild from "esbuild";
import { mathCssPlugin } from "./scripts/math-css.mjs";

const production = process.argv[2] === "production";

const context = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: ["obsidian", "node:child_process", "node:fs", "node:fs/promises", "node:os", "node:path", "node:crypto", "node:http", "node:https"],
  format: "cjs",
  target: "es2018",
  outfile: "main.js",
  minify: production,
  legalComments: "inline",
  plugins: [mathCssPlugin],
});

if (production) {
  await context.rebuild();
  await context.dispose();
} else {
  await context.watch();
  console.log("Watching for changes...");
}
