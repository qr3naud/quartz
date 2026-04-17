# Clay Scoping Tool

A Chrome extension that adds a visual brainstorming canvas to Clay workbooks for scoping enrichment workflows.

---

**Pick your path:**

- First time setting this up? → [Install](#install)
- Already installed, just want the latest version? → [Update](#update)
- Something not working? → [Troubleshooting](#troubleshooting)

---

## Install

*One-time, ~2 minutes per machine. From then on you only run the [Update](#update) step.*

### 1. Clone the repo

Open the **Terminal** app (on macOS: press `Cmd + Space`, type "Terminal", press Enter), then paste this command and press Enter:

```bash
git clone https://github.com/qr3naud/scoping.git ~/clay-scoping-extension
```

This creates a folder called `clay-scoping-extension` in your home directory and downloads the latest version of the extension into it.

> **First time using `git`?** macOS will prompt you to install the **Xcode Command Line Tools** the first time you run a `git` command. Click **Install** in the popup and wait for it to finish (a few minutes), then re-run the command above.

### 2. Load it into Chrome

1. Open a new Chrome tab and go to [`chrome://extensions`](chrome://extensions)
2. Toggle **Developer mode** on — it's the switch in the top-right corner of the page
3. Click **Load unpacked** (button on the left)
4. In the file picker, navigate to your home folder and select `clay-scoping-extension`, then click **Select** / **Open**

You should now see a card titled **Clay Scoping Tool** in the extensions list.

### 3. Confirm it works

Open any Clay workbook (e.g. `https://app.clay.com/workspaces/...`). You should see a **GTME View** button in the workbook toolbar. Click it to open the canvas.

If you don't see the button, reload the Clay tab. Still missing? See [Troubleshooting](#troubleshooting) below.

---

## Update

*Run this whenever you want the latest version — usually when something new has shipped and you want to pick it up.*

```bash
cd ~/clay-scoping-extension && git pull
```

Then in Chrome:

1. Go to [`chrome://extensions`](chrome://extensions)
2. Find the **Clay Scoping Tool** card and click the **circular refresh icon** on it
3. Reload any open Clay tabs so they pick up the new code

That's it.

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

**`git pull` says "merge conflict" or "your local changes would be overwritten"**
This means files in your `clay-scoping-extension` folder have been modified locally (you probably don't want to keep those changes — you just want the latest version from GitHub). Reset to the remote version:

```bash
cd ~/clay-scoping-extension && git fetch origin && git reset --hard origin/main
```

> **Warning:** this throws away any local edits in that folder. That's almost always what you want for an extension you're just using (not developing).

**The extension card shows an "Errors" button**
Click it, copy the error, and ping the maintainer (see below). Most often this means a file got corrupted during update — re-running `git pull` usually fixes it.

---

## Bugs and feature requests

<!-- TODO: replace with the right Slack channel / handle / email -->
Ping the maintainer directly for now.
