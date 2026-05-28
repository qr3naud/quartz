#!/usr/bin/env node
"use strict";

// Build the public spin-off extension from the source tree.
//
// Usage:
//   node build.js [--out <path>]
//
// The path can also be set via the BUILD_OUT environment variable or in
// build.config.js. Resolution order: --out arg > $BUILD_OUT > config.out.
//
// What this does:
//   1. Walks the source tree skipping anything in config.exclude.
//   2. Copies every file (text or binary) verbatim — no source transforms.
//   3. Wipes the output directory (preserving .git) before copying.
//   4. Writes a public .gitignore from config.publicGitignore.
//
// Why no transforms anymore: Phase 3 moved feature gating from build-time
// (sentinel-wrapped blocks + branding string substitution) to runtime
// (`__cb.hasFeature(...)` driven by the `features` claim on the JWT). The
// public extension now ships identical code to the internal one; the
// internal-only features (SFDC, Dust POC, pricing comparison, GTME export,
// "GTME View" branding) simply don't render for users whose JWT carries
// an empty features list. See AGENTS.md for the full model.
//
// The script has zero npm dependencies on purpose — it should run with any
// modern Node without `yarn install`.

const fs = require("fs");
const path = require("path");
const config = require("./build.config.js");

const SOURCE_DIR = __dirname;

// --- argument parsing ------------------------------------------------------

function resolveOutDir() {
  const argv = process.argv.slice(2);
  const idx = argv.indexOf("--out");
  if (idx !== -1 && argv[idx + 1]) {
    return path.resolve(argv[idx + 1]);
  }
  const envOut = process.env.BUILD_OUT;
  if (envOut) return path.resolve(envOut);
  return path.resolve(SOURCE_DIR, config.out);
}

const OUT_DIR = resolveOutDir();

if (OUT_DIR === SOURCE_DIR) {
  console.error("Refusing to build: output directory equals source directory.");
  process.exit(1);
}
// Refuse to build into a parent of the source — would copy the source onto
// itself recursively. Comparing with a trailing separator avoids "/foo" being
// flagged as a parent of "/foobar".
if ((SOURCE_DIR + path.sep).startsWith(OUT_DIR + path.sep)) {
  console.error(
    `Refusing to build: output directory ${OUT_DIR} contains the source directory.`,
  );
  process.exit(1);
}

// --- file classification ---------------------------------------------------

function relPosix(absPath) {
  return path.relative(SOURCE_DIR, absPath).split(path.sep).join("/");
}

function shouldExclude(relPath) {
  for (const ex of config.exclude) {
    if (relPath === ex) return true;
    if (relPath.startsWith(ex + "/")) return true;
  }
  return false;
}

// --- I/O -------------------------------------------------------------------

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

// Wipe everything in OUT_DIR except .git (so the public-repo clone keeps its
// history). Safe to call before the first build too: the early `return` if
// OUT_DIR doesn't exist keeps it from blowing up.
function cleanOutDir() {
  if (!fs.existsSync(OUT_DIR)) return;
  for (const name of fs.readdirSync(OUT_DIR)) {
    if (name === ".git") continue;
    fs.rmSync(path.join(OUT_DIR, name), { recursive: true, force: true });
  }
}

function copyTree(srcDir, dstDir) {
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const srcPath = path.join(srcDir, entry.name);
    const rel = relPosix(srcPath);
    if (shouldExclude(rel)) continue;

    const dstPath = path.join(dstDir, entry.name);

    if (entry.isDirectory()) {
      ensureDir(dstPath);
      copyTree(srcPath, dstPath);
      continue;
    }
    if (!entry.isFile()) continue; // skip symlinks etc.

    fs.copyFileSync(srcPath, dstPath);
  }
}

function writePublicGitignore() {
  fs.writeFileSync(path.join(OUT_DIR, ".gitignore"), config.publicGitignore);
}

// --- main ------------------------------------------------------------------

function main() {
  console.log(`Source: ${SOURCE_DIR}`);
  console.log(`Output: ${OUT_DIR}`);
  ensureDir(OUT_DIR);
  cleanOutDir();
  copyTree(SOURCE_DIR, OUT_DIR);
  writePublicGitignore();
  console.log("Build complete.");
}

main();
