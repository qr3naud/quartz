#!/usr/bin/env node
// Build a Chrome Web Store package of Quartz.
//
// Quartz ships two ways from one source tree:
//   - Manual / installer flow: the repo loaded unpacked, kept current by the
//     native git updater. Uses the real manifest.json verbatim (pinned ID via
//     "key", nativeMessaging permission for the updater host).
//   - Chrome Web Store: this script's output. Chrome assigns the ID and
//     auto-updates, so the store build drops the "key" (new, separate ID), the
//     "nativeMessaging" permission, and the localhost host permissions — none
//     of which a store install uses. The git-updater UI is gated off at runtime
//     for store installs (see quartzGetChannel in src/internal-bg.js).
//
// The repo's own manifest.json is never modified; the transform happens only on
// the copy under dist/cws/. Output: dist/quartz-cws-<version>.zip
//
// Usage: node scripts/build-cws.mjs   (or: bash scripts/build-cws.sh)

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = path.join(ROOT, "dist");
const PKG_DIR = path.join(OUT_DIR, "cws");

// Runtime assets the extension actually loads at install/run time. Everything
// else (scripts/, supabase/, docs/, releases.json, .git, README, dotfiles) is
// dev/deploy-only and stays out of the store package.
const COPY_FILES = ["manifest.json", "popup.html", "popup.css", "popup.js"];
const COPY_DIRS = ["icons", "src", "styles", "vendor"];

// Host permissions a store install never needs (only used for local calculator
// dev, and that line is commented out in src/config.js).
const DROP_HOST_PERMS = new Set([
  "http://localhost/*",
  "http://localhost:*/*",
  "http://127.0.0.1/*",
  "http://127.0.0.1:*/*",
]);

function rmrf(p) {
  fs.rmSync(p, { recursive: true, force: true });
}

function log(msg) {
  process.stdout.write(`[build-cws] ${msg}\n`);
}

// --- read + validate source manifest --------------------------------------
const srcManifest = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"));
const version = srcManifest.version;
if (!version) {
  console.error("[build-cws] manifest.json has no version");
  process.exit(1);
}

// --- clean + recreate package dir -----------------------------------------
rmrf(PKG_DIR);
fs.mkdirSync(PKG_DIR, { recursive: true });

// --- copy runtime assets ---------------------------------------------------
for (const f of COPY_FILES) {
  const from = path.join(ROOT, f);
  if (!fs.existsSync(from)) {
    console.error(`[build-cws] missing required file: ${f}`);
    process.exit(1);
  }
  fs.copyFileSync(from, path.join(PKG_DIR, f));
}
for (const d of COPY_DIRS) {
  const from = path.join(ROOT, d);
  if (!fs.existsSync(from)) {
    console.error(`[build-cws] missing required dir: ${d}`);
    process.exit(1);
  }
  fs.cpSync(from, path.join(PKG_DIR, d), { recursive: true });
}

// --- transform the copied manifest for the store --------------------------
const manifest = JSON.parse(JSON.stringify(srcManifest));

// Drop the pinned key so Chrome assigns a fresh, separate ID for the store
// build (lets the unpacked dev build and the store build coexist in one Chrome).
delete manifest.key;

// Drop nativeMessaging — the store build never talks to the git updater host.
if (Array.isArray(manifest.permissions)) {
  manifest.permissions = manifest.permissions.filter((p) => p !== "nativeMessaging");
}

// Drop localhost host permissions — unused by a store install.
if (Array.isArray(manifest.host_permissions)) {
  manifest.host_permissions = manifest.host_permissions.filter((h) => !DROP_HOST_PERMS.has(h));
}

fs.writeFileSync(
  path.join(PKG_DIR, "manifest.json"),
  JSON.stringify(manifest, null, 2) + "\n",
);

// --- zip (manifest must be at the archive root) ---------------------------
const zipName = `quartz-cws-${version}.zip`;
const zipPath = path.join(OUT_DIR, zipName);
rmrf(zipPath);
// -r recurse, -X strip extra macOS attrs, -q quiet. Run inside PKG_DIR so the
// archive has manifest.json at its root (Chrome rejects nested manifests).
execFileSync("zip", ["-r", "-X", "-q", zipPath, "."], { cwd: PKG_DIR, stdio: "inherit" });

log(`version       ${version}`);
log(`key removed   ${"key" in srcManifest ? "yes (separate store ID)" : "n/a"}`);
log(`permissions   ${JSON.stringify(manifest.permissions)}`);
log(`host perms    ${JSON.stringify(manifest.host_permissions)}`);
log(`package dir   ${path.relative(ROOT, PKG_DIR)}`);
log(`zip           ${path.relative(ROOT, zipPath)}`);
log("done. Upload the zip in the Chrome Web Store developer dashboard.");
