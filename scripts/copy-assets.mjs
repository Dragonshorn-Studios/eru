import { copyFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "node_modules", "htmx.org", "dist", "htmx.min.js");
const destDir = join(root, "dist", "assets");
await mkdir(destDir, { recursive: true });
await copyFile(src, join(destDir, "htmx.min.js"));
