# Clay Scoping Tool

A Chrome extension that adds a visual scoping canvas to Clay workbooks for planning enrichment workflows.

---

**Pick your path:**

- First time setting this up? → [Install](#install)
- Already installed, just want the latest version? → [Update](#update)
- Something not working? → [Troubleshooting](#troubleshooting)

---

## Install

*One-time, ~3 minutes per machine. After this, updating is a single click — no Terminal.*

### 1. Clone the repo

Open the **Terminal** app (on macOS: press `Cmd + Space`, type "Terminal", press Enter), then paste this command and press Enter:

```bash
git clone https://github.com/qr3naud/scoping.git ~/Downloads/Quartz
```

This creates a folder called `Quartz` inside your **Downloads** folder and downloads the latest version of the extension into it.

> **Heads-up:** don't delete this folder when you clean out Downloads — the extension reads from it every time Chrome starts. If you ever do delete it by accident, just re-run the clone command above.

> **First time using `git`?** macOS will prompt you to install the **Xcode Command Line Tools** the first time you run a `git` command. Click **Install** in the popup and wait for it to finish (a few minutes), then re-run the command above.

### 2. Load it into Chrome

1. Open a new Chrome tab and go to [`chrome://extensions`](chrome://extensions)
2. Toggle **Developer mode** on — it's the switch in the top-right corner of the page
3. Click **Load unpacked** (button on the left)
4. In the file picker, go to your **Downloads** folder and select `Quartz`, then click **Select** / **Open**

You should now see a card titled **Clay Scoping Tool** in the extensions list.

### 3. Enable one-click updates

This registers a tiny helper so the **Update** button inside the extension can pull new versions for you. Run it once in Terminal:

```bash
bash ~/Downloads/Quartz/scripts/install-updater.sh
```

Then go back to [`chrome://extensions`](chrome://extensions) and click the **circular refresh icon** on the **Clay Scoping Tool** card once, so the new permissions take effect.

### 4. Confirm it works

Open any Clay workbook (e.g. `https://app.clay.com/workspaces/...`). You should see a **GTME View** button in the workbook toolbar. Click it to open the canvas.

If you don't see the button, reload the Clay tab. Still missing? See [Troubleshooting](#troubleshooting) below.

---

## Update

Once one-click updates are enabled (Install step 3), you don't need Terminal anymore.

**When an update is available**, the extension's toolbar icon shows a red badge and flips upside-down. To update:

- Click the **extension icon** (top-right of Chrome) and hit **Update now**, **or**
- Open the canvas on any Clay workbook → **More** menu (`⋯`) → **Update**.

The extension pulls the latest version, reloads itself, and refreshes your open Clay tabs automatically.

> **Manual fallback** (if you skipped step 3 or the helper isn't working):
>
> ```bash
> cd ~/Downloads/Quartz && git pull
> ```
>
> Then go to [`chrome://extensions`](chrome://extensions), click the refresh icon on the **Clay Scoping Tool** card, and reload your Clay tabs.

---

## Already installed before one-click updates?

The extension's ID is now pinned (so the updater helper can talk to it). If you installed an older version, do this once:

1. Pull the latest: `cd ~/Downloads/Quartz && git pull` (or re-clone per Install step 1 if your folder is still named `clay-scoping-extension`).
2. At [`chrome://extensions`](chrome://extensions), **Remove** the old **Clay Scoping Tool** card, then **Load unpacked** the `Quartz` folder again.
3. Run Install step 3 to enable one-click updates.

Your canvases are safe — they live in the cloud, not in the extension.

---

## Troubleshooting

**I don't see the "GTME View" button on Clay workbooks**
Reload the Clay tab first. If it's still missing, go to [`chrome://extensions`](chrome://extensions), click the refresh icon on the **Clay Scoping Tool** card, then reload Clay again.

**Terminal says `git: command not found`**
You need Apple's developer tools. Run this in Terminal and click **Install** in the popup:

```bash
xcode-select --install
```

Wait for it to finish, then re-run the clone command.

**The Update button says "Local changes block update" / "Conflict"**
This means files in your `Quartz` folder have been modified locally (you probably don't want to keep those changes — you just want the latest version from GitHub). Use **Force update** in the popup, or reset manually:

```bash
cd ~/Downloads/Quartz && git fetch origin && git reset --hard origin/main
```

> **Warning:** this throws away any local edits in that folder. That's almost always what you want for an extension you're just using (not developing).

**The extension card shows an "Errors" button**
Click it, copy the error, and share it with the maintainer. Most often this means a file got corrupted during update — re-running `git pull` usually fixes it.
