"use strict";

// Configuration for the public-spinoff build. Run via `node build.js` from this
// directory; the script reads this file, walks the source tree, applies the
// rules below, and writes the rebranded/stripped extension into `out`.
//
// The internal extension == the source tree as-is. There is no internal build.
// Everything below describes what changes for the public build only.

module.exports = {
  // Where the public build is written. Override via $BUILD_OUT or `--out <path>`.
  // Default points one level above the workspace clone (sibling of clay-base).
  // The typical setup is to git-clone the public repo to that path and let the
  // build write directly into it; release.sh then commits + pushes from there.
  out: process.env.BUILD_OUT || "../../../self-scoping",

  // Files / directories never copied into the public build. Paths are relative
  // to this directory. Directory entries also exclude all descendants.
  exclude: [
    "src/pricing-comparison.js", // entire Old vs New Pricing modal
    "src/dust-poc.js",           // Generate POC button (Dust integration)
    "src/dust-bg.js",            // background service worker for Dust CORS proxy
    "styles/dust-poc.css",       // popover styling for Generate POC
    "docs",                       // internal-only architecture + business context
    "AGENTS.md",                  // maintainer-only build instructions
    "build.js",                   // build tooling stays in the source repo
    "build.config.js",
    "release.sh",
    ".git",                       // public repo has its own .git
    ".gitignore",                 // public repo gets its own .gitignore (written below)
    "node_modules",
    "dist",
  ],

  // Scripts removed from manifest.json content_scripts[].js arrays. Must match
  // exactly the values that appear in manifest.json.
  excludeFromManifestScripts: [
    "src/pricing-comparison.js",
    "src/dust-poc.js",
  ],

  // Stylesheets removed from manifest.json content_scripts[].css arrays. Must
  // match exactly the values that appear in manifest.json.
  excludeFromManifestStyles: [
    "styles/dust-poc.css",
  ],

  // Top-level keys removed from manifest.json entirely. Used to drop the
  // `background` field when its service-worker file isn't in the public
  // build — leaving it in place would make Chrome reject the manifest
  // because the referenced file is missing.
  excludeManifestKeys: [
    "background",
  ],

  // Ordered string substitutions applied to every text file (.js, .css, .html,
  // .md, .json). Order matters — longer / more-specific patterns first so they
  // win against the shorter ones below. Each pattern runs once per file.
  //
  // The internal extension uses "GTME View" and points at qr3naud/scoping. The
  // public build rebrands the toolbar label to "Scoping" and the repo URLs to
  // qr3naud/self-scoping. Manifest name ("Clay Scoping Tool") and console log
  // prefix ("[Clay Scoping]") are intentionally NOT rebranded.
  branding: [
    // Longer phrases first so the trailing "GTME View" -> "Scoping" rule below
    // produces grammatical results.
    ["Open the GTME View on a workbook", "Open the Scoping button on a workbook"],

    // The toolbar button label + every reference to it.
    ["GTME View", "Scoping"],

    // GitHub repo path. Substring is unique enough that it won't collide with
    // surrounding text. Self-replacement is safe because "self-scoping" does
    // not contain "scoping" as a separable substring after replacement runs
    // once.
    ["qr3naud/scoping", "qr3naud/self-scoping"],
    ["clay-scoping-extension", "clay-self-scoping-extension"],
  ],

  // Written to <out>/.gitignore. The public repo doesn't need to ignore docs/
  // (we don't copy it), but it should still ignore the usual editor cruft.
  publicGitignore: [
    ".DS_Store",
    "node_modules/",
    "*.log",
  ].join("\n") + "\n",
};
