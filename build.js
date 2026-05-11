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
//   2. For text files (.js/.css/.html/.md/.json/.txt/.sh):
//        a. Excises sentinel-wrapped blocks
//           (// __CB_INTERNAL_ONLY_BEGIN ... // __CB_INTERNAL_ONLY_END or
//            /* __CB_INTERNAL_ONLY_BEGIN ... */ ... /* __CB_INTERNAL_ONLY_END */).
//        b. Runs the ordered branding substitutions from config.branding.
//   3. For manifest.json: parses it, drops content_scripts[].js entries that
//      are in config.excludeFromManifestScripts and content_scripts[].css
//      entries in config.excludeFromManifestStyles, deletes any top-level
//      keys listed in config.excludeManifestKeys, re-stringifies
//      pretty-printed.
//   4. Wipes the output directory (preserving .git) and writes everything fresh.
//   5. Writes a public .gitignore from config.publicGitignore.
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

const TEXT_EXTENSIONS = new Set([
  ".js",
  ".css",
  ".html",
  ".md",
  ".json",
  ".txt",
  ".sh",
]);

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

// --- transforms ------------------------------------------------------------

// Sentinel block: a line containing __CB_INTERNAL_ONLY_BEGIN (with `//` or
// `/*` lead) through the matching __CB_INTERNAL_ONLY_END line. Multiline mode
// so `^` matches start of each line; non-greedy `[\s\S]*?` so adjacent blocks
// don't collapse into one big match.
const SENTINEL_RE =
  /^[ \t]*(?:\/\/|\/\*)[^\n]*__CB_INTERNAL_ONLY_BEGIN[^\n]*\n[\s\S]*?^[ \t]*(?:\/\/|\/\*)[^\n]*__CB_INTERNAL_ONLY_END[^\n]*\n?/gm;

function stripSentinels(content) {
  return content.replace(SENTINEL_RE, "");
}

function applyBranding(content) {
  let out = content;
  for (const [from, to] of config.branding) {
    out = out.split(from).join(to);
  }
  return out;
}

function transformManifest(jsonStr) {
  const m = JSON.parse(jsonStr);
  const excludedJs = new Set(config.excludeFromManifestScripts || []);
  const excludedCss = new Set(config.excludeFromManifestStyles || []);
  if (Array.isArray(m.content_scripts)) {
    for (const cs of m.content_scripts) {
      if (Array.isArray(cs.js)) {
        cs.js = cs.js.filter((p) => !excludedJs.has(p));
      }
      if (Array.isArray(cs.css)) {
        cs.css = cs.css.filter((p) => !excludedCss.has(p));
      }
    }
  }
  for (const key of config.excludeManifestKeys || []) {
    delete m[key];
  }
  return JSON.stringify(m, null, 2) + "\n";
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

function copyAndTransform(srcDir, dstDir) {
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const srcPath = path.join(srcDir, entry.name);
    const rel = relPosix(srcPath);
    if (shouldExclude(rel)) continue;

    const dstPath = path.join(dstDir, entry.name);

    if (entry.isDirectory()) {
      ensureDir(dstPath);
      copyAndTransform(srcPath, dstPath);
      continue;
    }
    if (!entry.isFile()) continue; // skip symlinks etc.

    const ext = path.extname(entry.name).toLowerCase();
    if (TEXT_EXTENSIONS.has(ext)) {
      let content = fs.readFileSync(srcPath, "utf8");
      content = stripSentinels(content);
      if (entry.name === "manifest.json") {
        // Sentinels in JSON would be malformed anyway; the stripSentinels pass
        // above is a no-op on a clean manifest. Re-serialize to drop excluded
        // scripts from content_scripts[].js.
        content = transformManifest(content);
      }
      content = applyBranding(content);
      fs.writeFileSync(dstPath, content);
    } else {
      fs.copyFileSync(srcPath, dstPath);
    }
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
  copyAndTransform(SOURCE_DIR, OUT_DIR);
  writePublicGitignore();
  console.log("Build complete.");
}

main();
