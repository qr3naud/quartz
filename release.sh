#!/usr/bin/env bash
#
# Build the public spin-off extension and push the result to the
# qr3naud/self-scoping repo.
#
# Usage:
#   ./release.sh "<commit message>"
#
# Environment:
#   BUILD_OUT   Path to the local clone of qr3naud/self-scoping. Defaults to
#               the same value as build.config.js (../../../self-scoping).
#               Override if your clone lives somewhere else, e.g.:
#                   BUILD_OUT=~/Developer/self-scoping ./release.sh "..."
#
# What it does:
#   1. Runs `node build.js` which rewrites BUILD_OUT in place (preserves .git).
#   2. cd BUILD_OUT, `git add -A`, commit with the supplied message, push.
#
# The internal extension (this repo, qr3naud/scoping) is not touched. Run
# `git commit && git push` from here when you want to ship to internal users.

set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "usage: $0 \"<commit message>\"" >&2
  exit 1
fi

MSG="$1"

# Resolve BUILD_OUT the same way build.js does so the user can pass either
# env-var or config-file default. Reading build.config.js with node keeps the
# two in sync (no separate copy of the default path in this script).
SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT_DIR="$(cd "$SOURCE_DIR" && BUILD_OUT="${BUILD_OUT:-}" node -e '
  const path = require("path");
  const cfg = require("./build.config.js");
  const out = process.env.BUILD_OUT || cfg.out;
  process.stdout.write(path.resolve(out));
')"

if [[ ! -d "$OUT_DIR/.git" ]]; then
  echo "release.sh: $OUT_DIR is not a git checkout." >&2
  echo "Clone the public repo first:" >&2
  echo "  git clone git@github.com:qr3naud/self-scoping.git \"$OUT_DIR\"" >&2
  exit 1
fi

echo "==> Building public extension into $OUT_DIR"
node "$SOURCE_DIR/build.js" --out "$OUT_DIR"

echo "==> Committing + pushing"
cd "$OUT_DIR"
if git diff --quiet && git diff --cached --quiet; then
  echo "release.sh: nothing changed in the public build — skipping commit."
  exit 0
fi
git add -A
git commit -m "$MSG"
git push

echo "==> Done."
