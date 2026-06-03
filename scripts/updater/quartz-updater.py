#!/usr/bin/env python3
"""Quartz extension auto-updater - Chrome native-messaging host.

Chrome launches this on demand (chrome.runtime.sendNativeMessage from the
extension's service worker) to run `git` inside the cloned extension repo, so
the in-browser "Update" button can refresh the extension with no terminal.

It reads exactly one JSON request from stdin using Chrome's native-messaging
framing (a 4-byte little-endian length prefix followed by UTF-8 JSON), runs the
requested git command, writes one framed JSON response to stdout, and exits.

Commands:
  {"cmd": "status"}            -> {ok, behind, currentVersion, latestVersion}
  {"cmd": "log"}              -> {ok, behind, incoming[], recent[], ...}
  {"cmd": "pull"}             -> {ok, updated, fromVersion, toVersion, output}
  {"cmd": "forcePull"}        -> {ok, updated, ...}        # discards local changes
  {"cmd": "checkout", "ref"}  -> {ok, updated, ...}        # hard-reset to a commit

The repo path is auto-detected from this script's own location (it lives at
<repo>/scripts/updater/quartz-updater.py), so it works wherever the user cloned
the repo. Registered with Chrome by scripts/install-updater.sh.
"""

import json
import os
import re
import struct
import subprocess
import sys
from shutil import which

# scripts/updater/quartz-updater.py -> repo root is two levels up.
REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))

# A broken git install can leak a bad GIT_EXEC_PATH / GIT_TEMPLATE_DIR into the
# environment, which then poisons even a good git. Run git without them.
GIT_ENV = {k: v for k, v in os.environ.items() if k not in ("GIT_EXEC_PATH", "GIT_TEMPLATE_DIR")}


def _git_usable(path):
    """A git is usable only if it runs AND ships the https remote helper.

    A broken/foreign git (e.g. from conda/Miniconda or a stale Homebrew) is
    missing git-remote-https and fails every https fetch with
    "git: 'remote-https' is not a git command" - exactly the breakage we must
    route around, so we require the helper to be present."""
    if not path:
        return False
    if not (os.path.isabs(path) and os.path.exists(path)) and which(path) is None:
        return False
    try:
        ver = subprocess.run([path, "--version"], capture_output=True, text=True,
                             timeout=10, env=GIT_ENV)
        if ver.returncode != 0:
            return False
        ep = subprocess.run([path, "--exec-path"], capture_output=True, text=True,
                            timeout=10, env=GIT_ENV)
        exec_path = ep.stdout.strip()
        return bool(exec_path) and os.path.exists(os.path.join(exec_path, "git-remote-https"))
    except Exception:
        return False


def find_git():
    """Chrome launches native hosts with a minimal PATH, so probe known
    locations rather than relying on `git` being resolvable. Prefer a git that
    actually ships the https remote helper, so a broken/foreign git on PATH
    can't break the in-browser Update button."""
    candidates = ["/usr/bin/git", "/opt/homebrew/bin/git", "/usr/local/bin/git"]
    found = which("git")
    if found:
        candidates.append(found)
    try:
        out = subprocess.run(
            ["/usr/bin/xcrun", "--find", "git"],
            capture_output=True, text=True, timeout=10,
        )
        if out.returncode == 0 and out.stdout.strip():
            candidates.append(out.stdout.strip())
    except Exception:
        pass
    for candidate in candidates:
        if _git_usable(candidate):
            return candidate
    # Nothing validated; fall back to the first that at least exists, then PATH.
    for candidate in candidates:
        if candidate and os.path.exists(candidate):
            return candidate
    return found or "git"


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
        capture_output=True, text=True, timeout=timeout, env=GIT_ENV,
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


def _parse_log(ref_range, limit=None):
    # %H hash, %cs committer date (YYYY-MM-DD), %s subject; \x1f separates
    # fields, newline separates commits.
    args = ["log", "--pretty=format:%H%x1f%cs%x1f%s"]
    if limit is not None:
        args += ["-n", str(limit)]
    args.append(ref_range)
    result = git(*args)
    commits = []
    if result.returncode != 0:
        return commits
    for line in result.stdout.split("\n"):
        if not line.strip():
            continue
        parts = line.split("\x1f")
        if len(parts) >= 3:
            commits.append({"hash": parts[0], "date": parts[1], "subject": parts[2]})
    return commits


def do_log():
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
        "incoming": _parse_log("HEAD..@{u}"),
        "recent": _parse_log("@{u}", limit=50),
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


def do_checkout(ref):
    """Hard-reset the clone to a specific commit (the in-modal version picker).
    `ref` must be a commit hash from the timeline; validated as hex so it can't
    smuggle extra git args. Discards any local drift (reset --hard), like
    forcePull, so it never stalls on a dirty working tree."""
    if not isinstance(ref, str) or not re.match(r"^[0-9a-f]{7,40}$", ref):
        return {"ok": False, "error": "bad-ref", "detail": str(ref)}
    before = local_version()
    before_head = git("rev-parse", "HEAD").stdout.strip()
    fetched = git("fetch", "origin", "--quiet")
    if fetched.returncode != 0:
        return {"ok": False, "error": "git fetch failed", "detail": fetched.stderr.strip()}
    exists = git("cat-file", "-e", ref + "^{commit}")
    if exists.returncode != 0:
        return {"ok": False, "error": "unknown-ref", "detail": ref}
    result = git("reset", "--hard", ref)
    output = (result.stdout + result.stderr).strip()
    after = local_version()
    after_head = git("rev-parse", "HEAD").stdout.strip()
    if result.returncode != 0:
        return {"ok": False, "error": "reset", "output": output, "fromVersion": before, "toVersion": after}
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
        elif cmd == "log":
            send_message(do_log())
        elif cmd == "pull":
            send_message(do_pull(force=False))
        elif cmd == "forcePull":
            send_message(do_pull(force=True))
        elif cmd == "checkout":
            send_message(do_checkout(msg.get("ref")))
        else:
            send_message({"ok": False, "error": "unknown-cmd", "detail": str(cmd)})
    except subprocess.TimeoutExpired:
        send_message({"ok": False, "error": "git-timeout"})
    except Exception as exc:
        send_message({"ok": False, "error": str(exc)})


if __name__ == "__main__":
    main()
