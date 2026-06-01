#!/usr/bin/env bash
#
# Quartz one-line installer.
#
# Paste this into Terminal:
#
#   curl -fsSL https://raw.githubusercontent.com/qr3naud/quartz/main/scripts/bootstrap.sh | bash
#
# What it does, with no assumptions about what you have installed:
#   1. Finds a git that actually works. A broken/foreign git earlier on your
#      PATH (common with conda/Miniconda or a stale Homebrew) fails https
#      clones with "git: 'remote-https' is not a git command". We skip those
#      and prefer Apple's /usr/bin/git, which is almost always already present.
#   2. If no working git exists at all, installs one (Homebrew if you have it,
#      otherwise Apple's Command Line Tools) and asks you to re-run this line.
#   3. Clones (or updates) the extension into ~/Quartz.
#   4. Registers the one-click updater so future updates need no Terminal.
#   5. Prints the final Chrome "Load unpacked" steps.
#
# Safe to re-run at any time.

set -euo pipefail

REPO_URL="https://github.com/qr3naud/quartz.git"
DEST="$HOME/Quartz"

# A broken git install often leaks bad GIT_EXEC_PATH / GIT_TEMPLATE_DIR into the
# environment, which then poisons even a good git. Clear them for this run.
unset GIT_EXEC_PATH GIT_TEMPLATE_DIR 2>/dev/null || true

# Status goes to stderr so command substitution that captures a git path stays
# clean.
say()  { printf '%s\n' "$*" >&2; }
err()  { printf 'ERROR: %s\n' "$*" >&2; }

# A git binary is only usable if it can run AND it ships the https remote
# helper. The broken-git error in the wild ("remote-https is not a git command")
# is exactly a missing git-remote-https, so this check is what rejects it.
git_works() {
  local g="$1"
  [ -n "$g" ] || return 1
  # Accept either an absolute executable or a name resolvable on PATH.
  if [ ! -x "$g" ]; then command -v "$g" >/dev/null 2>&1 || return 1; fi
  "$g" --version >/dev/null 2>&1 || return 1
  local exec_path
  exec_path="$("$g" --exec-path 2>/dev/null)" || return 1
  [ -n "$exec_path" ] && [ -e "$exec_path/git-remote-https" ]
}

# Print the first working git to stdout (the only thing this writes to stdout).
pick_git() {
  local c
  for c in /usr/bin/git /opt/homebrew/bin/git /usr/local/bin/git; do
    if git_works "$c"; then printf '%s' "$c"; return 0; fi
  done
  local x
  if x="$(/usr/bin/xcrun --find git 2>/dev/null)" && git_works "$x"; then
    printf '%s' "$x"; return 0
  fi
  if c="$(command -v git 2>/dev/null)" && git_works "$c"; then
    printf '%s' "$c"; return 0
  fi
  return 1
}

# Resolve a working git, installing one if necessary. Prints the path to stdout.
ensure_git() {
  local g
  if g="$(pick_git)"; then printf '%s' "$g"; return 0; fi

  # No working git anywhere. Prefer Homebrew when it's already installed (fast,
  # no GUI, no sudo); otherwise fall back to Apple's Command Line Tools, which
  # already include git. We do NOT auto-install Homebrew: its own installer
  # pulls in the Command Line Tools anyway and additionally needs an admin
  # password, so it's strictly more friction than CLT alone.
  if command -v brew >/dev/null 2>&1; then
    say "No working git found. Installing it with Homebrew..."
    brew install git >&2
    if g="$(pick_git)"; then printf '%s' "$g"; return 0; fi
  fi

  err "No working git found on this Mac."
  say  "Triggering the Apple Command Line Tools installer..."
  xcode-select --install 2>/dev/null || true
  err "A macOS popup should appear. Click \"Install\", wait for it to finish,"
  err "then paste this same command again to continue."
  exit 1
}

GIT="$(ensure_git)"
say "Using git: $GIT ($("$GIT" --version))"

# Clone fresh, or update an existing clone to the latest published version.
if [ -d "$DEST/.git" ]; then
  say "Updating existing install at $DEST ..."
  "$GIT" -C "$DEST" fetch origin --quiet
  "$GIT" -C "$DEST" reset --hard origin/main
elif [ -e "$DEST" ]; then
  err "$DEST already exists but is not a Quartz git clone."
  err "Move or rename it (e.g. 'mv ~/Quartz ~/Quartz-old'), then re-run this command."
  exit 1
else
  say "Downloading Quartz into $DEST ..."
  "$GIT" clone "$REPO_URL" "$DEST"
fi

chmod +x "$DEST/scripts/updater/quartz-updater.py" 2>/dev/null || true

# Register the native-messaging host so the in-browser Update button works.
say "Enabling one-click updates ..."
bash "$DEST/scripts/install-updater.sh"

cat >&2 <<EOF

============================================================
 Almost done. Final steps in Chrome (one time):
   1. Open a new tab and go to:  chrome://extensions
   2. Turn ON "Developer mode" (top-right toggle)
   3. Click "Load unpacked" (top-left)
   4. Select the "Quartz" folder in your home folder:
        $DEST
   5. Open any Clay workbook and click the Quartz button.

 After this, updates are automatic - no Terminal needed.
============================================================
EOF
