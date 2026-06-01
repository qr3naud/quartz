# Quartz

A Chrome extension that adds a visual scoping canvas to Clay workbooks for planning enrichment workflows.

---

**Pick your path:**

- First time setting this up? → [Install](#install)
- Already installed, just want the latest version? → [Update](#update)
- Something not working? → [Troubleshooting](#troubleshooting)

---

## Install

*One-time, ~3 minutes per machine. After this, updating is a single click — no Terminal.*

### 1. Run the one-line installer

Open the **Terminal** app (on macOS: press `Cmd + Space`, type "Terminal", press Enter), then paste this command and press Enter:

```bash
curl -fsSL https://raw.githubusercontent.com/qr3naud/quartz/main/scripts/bootstrap.sh | bash
```

That single line does everything for you, no matter what you have installed: it finds (or installs) a working `git`, downloads the extension into `~/Quartz`, and turns on one-click updates. When it finishes it prints the Chrome steps below.

> **If a macOS popup asks you to install developer tools:** that means you have no working `git` yet. Click **Install**, wait for it to finish (a few minutes), then **paste the same command again**. (It's safe to re-run any time.)

> **Important — it installs to your home folder (`~/Quartz`), on purpose.** macOS protects Downloads, Desktop, and Documents, and Chrome can't run the one-click updater from those. Don't move or delete the `Quartz` folder — the extension reads from it every time Chrome starts. If you ever delete it by accident, just re-run the line above.

<details>
<summary>Prefer to run the steps manually?</summary>

```bash
# 1. Download into your home folder
git clone https://github.com/qr3naud/quartz.git ~/Quartz

# 2. Enable one-click updates
bash ~/Quartz/scripts/install-updater.sh
```

If `git` is missing or broken (e.g. `git: 'remote-https' is not a git command`), see [Troubleshooting](#troubleshooting) — or just use the one-line installer above, which handles it automatically.

</details>

### 2. Load it into Chrome

1. Open a new Chrome tab and go to [`chrome://extensions`](chrome://extensions)
2. Toggle **Developer mode** on — it's the switch in the top-right corner of the page
3. Click **Load unpacked** (button on the left)
4. In the file picker, select the `Quartz` folder in your home folder, then click **Select** / **Open**

You should now see a card titled **Quartz** in the extensions list. (One-click updates were already enabled by the installer in step 1 — if you used the manual fallback instead, run `bash ~/Quartz/scripts/install-updater.sh` now and reload the card once.)

### 3. Confirm it works

Open any Clay workbook (e.g. `https://app.clay.com/workspaces/...`). You should see a **Quartz** button in the workbook toolbar. Click it to open the canvas.

> Internal Clay GTM team members see the button labeled **Quartz**; everyone else sees **Scoping** (same button, controlled by the `internal_branding` flag).

If you don't see the button, reload the Clay tab. Still missing? See [Troubleshooting](#troubleshooting) below.

---

## Update

Once one-click updates are enabled (the installer in Install step 1 does this), you don't need Terminal anymore.

**When an update is available**, the extension's toolbar icon shows a red badge and flips upside-down. To update:

- Click the **extension icon** (top-right of Chrome) and hit **Update now**, **or**
- Open the canvas on any Clay workbook → **More** menu (`⋯`) → **Update**.

The extension pulls the latest version, reloads itself, and refreshes your open Clay tabs automatically.

> **Manual fallback** (if the one-click helper isn't working):
>
> ```bash
> cd ~/Quartz && git pull
> ```
>
> Then go to [`chrome://extensions`](chrome://extensions), click the refresh icon on the **Quartz** card, and reload your Clay tabs.

---

## Already installed before one-click updates?

The extension's ID is now pinned (so the updater helper can talk to it), and it must live outside macOS-protected folders. If you installed an older version, do this once:

1. Move it out of Downloads (one-time): `mv ~/Downloads/Quartz ~/Quartz` — or, if your folder is still named `clay-scoping-extension`, re-clone per Install step 1.
2. Pull the latest: `cd ~/Quartz && git pull`.
3. At [`chrome://extensions`](chrome://extensions), **Remove** the old **Quartz** card, then **Load unpacked** the `~/Quartz` folder.
4. Run the one-line installer from Install step 1 to enable one-click updates (it's safe to re-run).

Your canvases are safe — they live in the cloud, not in the extension.

---

## Troubleshooting

**I don't see the "Quartz" button on Clay workbooks**
Reload the Clay tab first. If it's still missing, go to [`chrome://extensions`](chrome://extensions), click the refresh icon on the **Quartz** card, then reload Clay again.

**Terminal says `git: command not found`**
You need Apple's developer tools. The one-line installer (Install step 1) does this for you. To do it by hand, run this and click **Install** in the popup:

```bash
xcode-select --install
```

Wait for it to finish, then re-run the installer.

**Terminal says `git: 'remote-https' is not a git command` (or `templates not found in //share/git-core/templates`)**
Your `git` itself is broken — usually a stray copy from conda/Miniconda or an old Homebrew install that sits ahead of Apple's working `git` on your `PATH`. **Just use the one-line installer in [Install step 1](#1-run-the-one-line-installer)** — it automatically detects the broken `git`, skips it, and uses Apple's working one instead. (If you must clone by hand, run it as `/usr/bin/git clone https://github.com/qr3naud/quartz.git ~/Quartz` to force the good copy.)

**The Update button says "Local changes block update" / "Conflict"**
This means files in your `Quartz` folder have been modified locally (you probably don't want to keep those changes — you just want the latest version from GitHub). Use **Force update** in the popup, or reset manually:

```bash
cd ~/Quartz && git fetch origin && git reset --hard origin/main
```

> **Warning:** this throws away any local edits in that folder. That's almost always what you want for an extension you're just using (not developing).

**The extension card shows an "Errors" button**
Click it, copy the error, and share it with the maintainer. Most often this means a file got corrupted during update — re-running `git pull` usually fixes it.
