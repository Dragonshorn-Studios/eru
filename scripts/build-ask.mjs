// Bundles the Ask island (src/ask/main.tsx) to dist/assets/ask.js with
// esbuild. React and assistant-ui are pinned runtime deps; the bundle is the
// only place JSX/TSX appears — the server tree stays plain .ts.
import { build } from "esbuild";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

await build({
  entryPoints: [join(root, "src", "ask", "main.tsx")],
  outfile: join(root, "dist", "assets", "ask.js"),
  bundle: true,
  format: "esm",
  platform: "browser",
  target: ["es2022"],
  jsx: "automatic",
  minify: true,
  sourcemap: false,
  define: { "process.env.NODE_ENV": '"production"' },
  logLevel: "info",
});

console.log("ask: bundled dist/assets/ask.js");
