#!/usr/bin/env bash
#
# One-time setup for Quartz one-click updates.
#
# Registers the native-messaging host (scripts/updater/quartz-updater.py) with
# every Chromium-family browser found on this Mac, so the extension's in-browser
# "Update" button can run `git pull` for you. Run this once after cloning:
#
#   bash ~/Quartz/scripts/install-updater.sh
#
# Safe to re-run (it just rewrites the host manifest). The repo path is detected
# from this script's own location, so it works wherever you cloned Quartz.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
HOST_PATH="$REPO_ROOT/scripts/updater/quartz-updater.py"
HOST_NAME="com.quartz.updater"
EXT_ID="fdhggeebmboppaapccjagpeobpoccloi"

if [ ! -f "$HOST_PATH" ]; then
  echo "ERROR: updater not found at $HOST_PATH" >&2
  echo "Make sure you're running this from inside the cloned Quartz repo." >&2
  exit 1
fi
chmod +x "$HOST_PATH"

if ! command -v python3 >/dev/null 2>&1 && [ ! -x /usr/bin/python3 ]; then
  echo "WARNING: python3 not found. Install Apple's tools first: xcode-select --install" >&2
fi

# If the repo was downloaded as a ZIP (rather than git-cloned), macOS flags the
# files with a quarantine attribute and Chrome's hardened runtime refuses to
# launch them. Strip it so the host can run. Harmless on git clones.
xattr -dr com.apple.quarantine "$REPO_ROOT/scripts" >/dev/null 2>&1 || true

# The native-host manifest. allowed_origins pins the extension to the ID
# derived from the public "key" in manifest.json, so this is stable across
# machines.
MANIFEST_JSON=$(cat <<EOF
{
  "name": "$HOST_NAME",
  "description": "Quartz extension auto-updater",
  "path": "$HOST_PATH",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://$EXT_ID/"]
}
EOF
)

SUPPORT="$HOME/Library/Application Support"
# Base profile dirs for Chromium-family browsers on macOS. We write a
# NativeMessagingHosts/<host>.json under each that exists.
BROWSER_DIRS=(
  "$SUPPORT/Google/Chrome"
  "$SUPPORT/Google/Chrome Beta"
  "$SUPPORT/Google/Chrome Canary"
  "$SUPPORT/Google/Chrome Dev"
  "$SUPPORT/Chromium"
  "$SUPPORT/BraveSoftware/Brave-Browser"
  "$SUPPORT/Microsoft Edge"
  "$SUPPORT/Arc/User Data"
)

installed=0
for base in "${BROWSER_DIRS[@]}"; do
  if [ -d "$base" ]; then
    target="$base/NativeMessagingHosts"
    mkdir -p "$target"
    printf '%s\n' "$MANIFEST_JSON" > "$target/$HOST_NAME.json"
    echo "  registered for: ${base#"$SUPPORT"/}"
    installed=$((installed + 1))
  fi
done

if [ "$installed" -eq 0 ]; then
  echo "ERROR: no Chromium-family browsers found under $SUPPORT" >&2
  exit 1
fi

# Warm up the host once so macOS performs its first-run security check now
# (the very first launch from a sandboxed app can be killed). The host reads
# stdin and exits on EOF, so feeding it /dev/null returns immediately.
"$HOST_PATH" </dev/null >/dev/null 2>&1 || true

echo ""
echo "Done - one-click updates enabled for $installed browser profile(s)."
echo "Final step: open chrome://extensions and reload the Quartz card once"
echo "(or remove it and Load unpacked again) so the new permissions take effect."
