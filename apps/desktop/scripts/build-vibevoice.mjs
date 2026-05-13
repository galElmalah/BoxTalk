#!/usr/bin/env node
// Clone + build localai-org/vibevoice.cpp into ./vendor/vibevoice.cpp.
// Idempotent: if the repo is already checked out, pulls latest then rebuilds.
//
// Output binary lands at ./vendor/vibevoice.cpp/build/bin/vibevoice-cli — the
// path that vibevoice.js auto-detects.

import { spawn } from "node:child_process";
import { mkdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const vendorDir = path.join(repoRoot, "vendor");
const repoDir = path.join(vendorDir, "vibevoice.cpp");
const buildDir = path.join(repoDir, "build");
const binaryPath = path.join(buildDir, "bin", "vibevoice-cli");

const REPO_URL = "https://github.com/localai-org/vibevoice.cpp";

function run(cmd, args, cwd) {
  return new Promise((resolve, reject) => {
    console.log(`\n$ ${cmd} ${args.join(" ")}  (in ${cwd || "."})`);
    const p = spawn(cmd, args, { cwd, stdio: "inherit" });
    p.on("error", reject);
    p.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`)));
  });
}

async function ensureRepo() {
  await mkdir(vendorDir, { recursive: true });
  if (!existsSync(repoDir)) {
    await run("git", ["clone", "--recursive", REPO_URL, repoDir]);
    return;
  }
  console.log(`vendor/vibevoice.cpp already exists, pulling latest…`);
  await run("git", ["pull", "--ff-only"], repoDir);
  await run("git", ["submodule", "update", "--init", "--recursive"], repoDir);
}

async function build() {
  await run("cmake", ["-B", "build", "-DCMAKE_BUILD_TYPE=Release"], repoDir);
  await run("cmake", ["--build", "build", "-j"], repoDir);
}

async function main() {
  console.log("=== Building vibevoice.cpp ===");
  console.log(`Target binary: ${binaryPath}`);

  await ensureRepo();
  await build();

  try {
    const st = await stat(binaryPath);
    if (!st.isFile()) throw new Error("not a file");
  } catch {
    throw new Error(`build finished but ${binaryPath} is missing — check cmake output above`);
  }

  console.log("\n✓ vibevoice-cli ready at:");
  console.log(`  ${binaryPath}`);
  console.log("\nThe Electron app will pick this up automatically.");
}

main().catch((err) => {
  console.error("\n✗ build failed:", err.message);
  process.exit(1);
});
