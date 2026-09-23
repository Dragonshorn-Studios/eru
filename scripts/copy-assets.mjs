import { copyFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const destDir = join(root, "dist", "assets");
await mkdir(destDir, { recursive: true });

const assets = [
  [join(root, "node_modules", "htmx.org", "dist", "htmx.min.js"), "htmx.min.js"],
  [join(root, "assets", "favicon.ico"), "favicon.ico"],
  [join(root, "assets", "favicon-32.png"), "favicon-32.png"],
  [join(root, "assets", "apple-touch-icon.png"), "apple-touch-icon.png"],
  [join(root, "assets", "eru-icon.png"), "eru-icon.png"],
];

await Promise.all(assets.map(([src, name]) => copyFile(src, join(destDir, name))));
