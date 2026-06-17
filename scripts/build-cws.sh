#!/usr/bin/env bash
# Thin wrapper around scripts/build-cws.mjs — builds the Chrome Web Store zip.
# See that file for what gets copied and how the manifest is trimmed.
#
#   bash scripts/build-cws.sh
#
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec node "$SCRIPT_DIR/build-cws.mjs" "$@"
