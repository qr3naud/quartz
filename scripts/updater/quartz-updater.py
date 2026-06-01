#!/usr/bin/env python3
"""Quartz extension auto-updater - Chrome native-messaging host.

Chrome launches this on demand (chrome.runtime.sendNativeMessage from the
extension's service worker) to run `git` inside the cloned extension repo, so
the in-browser "Update" button can refresh the extension with no terminal.

It reads exactly one JSON request from stdin using Chrome's native-messaging
framing (a 4-byte little-endian length prefix followed by UTF-8 JSON), runs the
requested git command, writes one framed JSON response to stdout, and exits.

Commands:
  {"cmd": "status"}     -> {ok, behind, currentVersion, latestVersion}
  {"cmd": "pull"}       -> {ok, updated, fromVersion, toVersion, output}
  {"cmd": "forcePull"}  -> {ok, updated, ...}   # discards local changes

The repo path is auto-detected from this script's own location (it lives at
<repo>/scripts/updater/quartz-updater.py), so it works wherever the user cloned
the repo. Registered with Chrome by scripts/install-updater.sh.
"""

import json
import os
import struct
import subprocess
import sys
from shutil import which

# scripts/updater/quartz-updater.py -> repo root is two levels up.
REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))


def find_git():
    """Chrome launches native hosts with a minimal PATH, so probe known
    locations rather than relying on `git` being resolvable."""
    found = which("git")
    candidates = [found] if found else []
    candidates += ["/opt/homebrew/bin/git", "/usr/local/bin/git", "/usr/bin/git"]
    for candidate in candidates:
        if candidate and os.path.exists(candidate):
            return candidate
    try:
        out = subprocess.run(
            ["/usr/bin/xcrun", "--find", "git"],
            capture_output=True, text=True, timeout=10,
        )
        if out.returncode == 0 and out.stdout.strip():
            return out.stdout.strip()
    except Exception:
        pass
    return "git"


GIT = find_git()


def read_message():
    raw_len = sys.stdin.buffer.read(4)
    if len(raw_len) < 4:
        return None
    msg_len = struct.unpack("<I", raw_len)[0]
    data = sys.stdin.buffer.read(msg_len)
    return json.loads(data.decode("utf-8"))


def send_message(obj):
    data = json.dumps(obj).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("<I", len(data)))
    sys.stdout.buffer.write(data)
    sys.stdout.buffer.flush()


def git(*args, timeout=120):
    return subprocess.run(
        [GIT, "-C", REPO_ROOT, *args],
        capture_output=True, text=True, timeout=timeout,
    )


def local_version():
    try:
        with open(os.path.join(REPO_ROOT, "manifest.json"), "r", encoding="utf-8") as f:
            return json.load(f).get("version")
    except Exception:
        return None


def version_at(ref):
    out = git("show", "{}:manifest.json".format(ref))
    if out.returncode != 0:
        return None
    try:
        return json.loads(out.stdout).get("version")
    except Exception:
        return None


def do_status():
    fetched = git("fetch", "--quiet")
    if fetched.returncode != 0:
        return {"ok": False, "error": "git fetch failed", "detail": fetched.stderr.strip()}
    counted = git("rev-list", "--count", "HEAD..@{u}")
    behind = int(counted.stdout.strip()) if counted.returncode == 0 and counted.stdout.strip().isdigit() else 0
    return {
        "ok": True,
        "behind": behind,
        "currentVersion": local_version(),
        "latestVersion": version_at("@{u}") or local_version(),
    }


def do_pull(force=False):
    before = local_version()
    before_head = git("rev-parse", "HEAD").stdout.strip()
    if force:
        fetched = git("fetch", "origin", "--quiet")
        if fetched.returncode != 0:
            return {"ok": False, "error": "git fetch failed", "detail": fetched.stderr.strip()}
        result = git("reset", "--hard", "@{u}")
    else:
        result = git("pull", "--ff-only")
    output = (result.stdout + result.stderr).strip()
    after = local_version()
    after_head = git("rev-parse", "HEAD").stdout.strip()
    if result.returncode != 0:
        return {
            "ok": False,
            "error": "ff-only" if not force else "reset",
            "output": output,
            "fromVersion": before,
            "toVersion": after,
        }
    return {
        "ok": True,
        "updated": before_head != after_head,
        "fromVersion": before,
        "toVersion": after,
        "output": output,
    }


def main():
    try:
        msg = read_message()
    except Exception as exc:
        send_message({"ok": False, "error": "bad-message", "detail": str(exc)})
        return
    if not msg:
        return
    cmd = msg.get("cmd")
    try:
        if cmd == "status":
            send_message(do_status())
        elif cmd == "pull":
            send_message(do_pull(force=False))
        elif cmd == "forcePull":
            send_message(do_pull(force=True))
        else:
            send_message({"ok": False, "error": "unknown-cmd", "detail": str(cmd)})
    except subprocess.TimeoutExpired:
        send_message({"ok": False, "error": "git-timeout"})
    except Exception as exc:
        send_message({"ok": False, "error": str(exc)})


if __name__ == "__main__":
    main()
