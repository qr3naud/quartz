"use strict";

// Configuration for the public-spinoff build. Run via `node build.js` from this
// directory; the script reads this file, walks the source tree, and writes the
// trimmed extension into `out`.
//
// The internal extension == the source tree as-is. There is no internal build.
// Everything below describes what changes for the public build only.
//
// Post-Phase-3 the public build is almost identical to the source. Internal-
// only features (SFDC, Dust POC, pricing comparison, GTME export, "GTME View"
// branding) are runtime-gated by the `features` claim on the Phase-1 JWT
// minted by clay-auth-mint. Public users get an empty features list, so the
// matching buttons/menus never render and the matching code paths are never
// reached. The Edge Function proxies independently enforce
// INTERNAL_WORKSPACES, so even a user who tampers with __cb.userFeatures in
// DevTools can't reach SFDC/Dust.
//
// What stays excluded from the public build, then, is:
//   - genuine secrets (docs/, AGENTS.md)
//   - server-side artifacts deployed separately (supabase/, scripts/)
//   - per-machine / build tooling (.git, .gitignore, _metadata, build.*,
//     release.sh, dist, node_modules)
//
// Nothing in `src/` or `styles/` is stripped anymore — every JS/CSS file
// ships to both internal and public installs.

module.exports = {
  // Where the public build is written. Override via $BUILD_OUT or `--out <path>`.
  // Default points one level above the workspace clone (sibling of clay-base).
  // The typical setup is to git-clone the public repo to that path and let the
  // build write directly into it; release.sh then commits + pushes from there.
  out: process.env.BUILD_OUT || "../../../self-scoping",

  // Files / directories never copied into the public build. Paths are relative
  // to this directory. Directory entries also exclude all descendants.
  exclude: [
    "supabase",                  // Edge Function source + SQL migrations (deployed separately, not shipped to Chrome)
    "scripts",                   // SFDC connection tester + per-env dotenv files
    "_metadata",                 // Chrome-generated DNR ruleset cache (auto-created on load)
    "docs",                      // internal-only architecture + business context
    "AGENTS.md",                 // maintainer-only build instructions
    "build.js",                  // build tooling stays in the source repo
    "build.config.js",
    "release.sh",
    ".git",                      // public repo has its own .git
    ".gitignore",                // public repo gets its own .gitignore (written below)
    "node_modules",
    "dist",
  ],

  // Written to <out>/.gitignore. The public repo doesn't need to ignore docs/
  // (we don't copy it), but it should still ignore the usual editor cruft.
  publicGitignore: [
    ".DS_Store",
    "node_modules/",
    "*.log",
  ].join("\n") + "\n",
};
