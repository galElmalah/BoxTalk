#!/usr/bin/env node
// Copy Readability.js out of node_modules into vendor/ so the unpacked
// extension can ship it as a content-script asset. MV3 disallows references
// outside the extension root, so this file MUST live under packages/extension/.

import { mkdirSync, copyFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const require = createRequire(import.meta.url);

const src = require.resolve("@mozilla/readability/Readability.js");
const destDir = path.join(root, "vendor");
const dest = path.join(destDir, "Readability.js");

mkdirSync(destDir, { recursive: true });
copyFileSync(src, dest);

console.log(`[vendor] copied ${path.relative(root, src)} → ${path.relative(root, dest)}`);
