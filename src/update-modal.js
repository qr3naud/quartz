/**
 * Update history modal.
 *
 * Opened from the overlay More menu's "Update" row (__cb.openUpdateModal).
 * Shows the version timeline ("the pushes") from the native git host via the
 * service worker (cb:update:log) and lets the user pull the latest with one
 * click. The actual git work + extension reload + tab reload all happen in the
 * service worker (src/internal-bg.js); this file is pure UI.
 */
(function () {
  "use strict";

  const __cb = window.__cb;

  let backdropEl = null;
  let modalEl = null;

  function closeModal() {
    if (modalEl) {
      modalEl.remove();
      modalEl = null;
    }
    if (backdropEl) {
      backdropEl.remove();
      backdropEl = null;
    }
    document.removeEventListener("keydown", onKeydown);
  }

  function onKeydown(evt) {
    if (evt.key === "Escape") {
      evt.preventDefault();
      closeModal();
    }
  }

  /** Pulls a trailing "(vX.Y.Z)" off a commit subject so we can show it as a
   *  badge and keep the message clean. Returns { version, message }. */
  function splitVersion(subject) {
    const m = /\s*\(v([0-9][0-9.]*)\)\s*$/.exec(subject || "");
    if (m) {
      return { version: m[1], message: subject.slice(0, m.index).trim() };
    }
    return { version: null, message: subject || "" };
  }

  function commitRow(commit, isNew) {
    const { version, message } = splitVersion(commit.subject);
    const row = document.createElement("div");
    row.className = "cb-update-item" + (isNew ? " cb-update-item-new" : "");

    const left = document.createElement("div");
    left.className = "cb-update-item-main";

    if (version) {
      const badge = document.createElement("span");
      badge.className = "cb-update-badge";
      badge.textContent = "v" + version;
      left.appendChild(badge);
    }
    const msg = document.createElement("span");
    msg.className = "cb-update-msg";
    msg.textContent = message || commit.subject || "(no message)";
    left.appendChild(msg);

    const date = document.createElement("span");
    date.className = "cb-update-date";
    date.textContent = commit.date || "";

    row.appendChild(left);
    row.appendChild(date);
    return row;
  }

  function renderTimeline(bodyEl, data) {
    bodyEl.innerHTML = "";

    const incoming = Array.isArray(data.incoming) ? data.incoming : [];
    const recent = Array.isArray(data.recent) ? data.recent : [];

    if (incoming.length) {
      const label = document.createElement("div");
      label.className = "cb-update-section-label";
      label.textContent = "New in this update";
      bodyEl.appendChild(label);
      for (const c of incoming) bodyEl.appendChild(commitRow(c, true));
    }

    const label2 = document.createElement("div");
    label2.className = "cb-update-section-label";
    label2.textContent = incoming.length ? "Earlier" : "Recent history";
    bodyEl.appendChild(label2);

    const incomingHashes = new Set(incoming.map((c) => c.hash));
    const earlier = recent.filter((c) => !incomingHashes.has(c.hash));
    if (earlier.length) {
      for (const c of earlier) bodyEl.appendChild(commitRow(c, false));
    } else if (!incoming.length) {
      const empty = document.createElement("div");
      empty.className = "cb-update-empty";
      empty.textContent = "No commit history available.";
      bodyEl.appendChild(empty);
    }
  }

  function setStatus(statusEl, kind, text) {
    statusEl.className = "cb-update-status cb-update-status-" + kind;
    statusEl.textContent = text;
  }

  function sendUpdateMessage(type) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type }, (res) => {
          resolve({ lastError: chrome.runtime.lastError ? chrome.runtime.lastError.message : null, res: res || null });
        });
      } catch (err) {
        resolve({ lastError: String(err), res: null });
      }
    });
  }

  __cb.openUpdateModal = function openUpdateModal() {
    closeModal();

    backdropEl = document.createElement("div");
    backdropEl.className = "cb-update-backdrop";
    backdropEl.addEventListener("click", closeModal);
    backdropEl.addEventListener("mousedown", (evt) => evt.stopPropagation());

    modalEl = document.createElement("div");
    modalEl.className = "cb-update-modal";
    modalEl.addEventListener("click", (evt) => evt.stopPropagation());
    modalEl.addEventListener("mousedown", (evt) => evt.stopPropagation());

    // Header
    const header = document.createElement("div");
    header.className = "cb-update-header";
    const title = document.createElement("div");
    title.className = "cb-update-title";
    title.textContent = "Quartz";
    const versionEl = document.createElement("div");
    versionEl.className = "cb-update-version";
    const currentVersion = (chrome.runtime.getManifest && chrome.runtime.getManifest().version) || "";
    versionEl.textContent = currentVersion ? "v" + currentVersion : "";
    header.appendChild(title);
    header.appendChild(versionEl);
    modalEl.appendChild(header);

    // Status line
    const statusEl = document.createElement("div");
    statusEl.className = "cb-update-status cb-update-status-loading";
    statusEl.textContent = "Checking for updates\u2026";
    modalEl.appendChild(statusEl);

    // Body (timeline)
    const body = document.createElement("div");
    body.className = "cb-update-body";
    const spinner = document.createElement("div");
    spinner.className = "cb-update-spinner";
    body.appendChild(spinner);
    modalEl.appendChild(body);

    // Footer
    const footer = document.createElement("div");
    footer.className = "cb-update-footer";
    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "cb-update-btn cb-update-btn-secondary";
    closeBtn.textContent = "Close";
    closeBtn.addEventListener("click", closeModal);
    const updateBtn = document.createElement("button");
    updateBtn.type = "button";
    updateBtn.className = "cb-update-btn cb-update-btn-primary";
    updateBtn.textContent = "Update now";
    updateBtn.disabled = true;
    footer.appendChild(closeBtn);
    footer.appendChild(updateBtn);
    modalEl.appendChild(footer);

    document.body.appendChild(backdropEl);
    document.body.appendChild(modalEl);
    document.addEventListener("keydown", onKeydown);

    let busy = false;
    function runPull(type) {
      if (busy) return;
      busy = true;
      updateBtn.disabled = true;
      setStatus(statusEl, "loading", "Updating\u2026");
      sendUpdateMessage(type).then(({ lastError, res }) => {
        // On a successful update the extension reloads and this whole page is
        // torn down — we only reach here for no-op / error outcomes.
        busy = false;
        if (lastError || !res || res.ok === false) {
          if (res && res.error === "host-missing") {
            setStatus(statusEl, "error", "One-time setup needed \u2014 run: bash ~/Quartz/scripts/install-updater.sh");
          } else if (res && res.error === "ff-only") {
            setStatus(statusEl, "error", "Local changes block the update.");
            updateBtn.disabled = false;
            updateBtn.textContent = "Force update";
            updateBtn.onclick = () => {
              if (window.confirm("Discard local changes and update to the latest version?")) {
                runPull("cb:update:forcePull");
              }
            };
          } else {
            setStatus(statusEl, "error", "Update failed. Try again.");
            updateBtn.disabled = false;
          }
        } else if (res.ok && !res.updated) {
          setStatus(statusEl, "ok", "You're on the latest version.");
        }
      });
    }
    updateBtn.onclick = () => runPull("cb:update:pull");

    // Load the timeline.
    sendUpdateMessage("cb:update:log").then(({ lastError, res }) => {
      if (lastError || !res || res.ok === false) {
        spinner.remove();
        if (res && res.error === "host-missing") {
          setStatus(statusEl, "error", "Updater not set up yet.");
          body.innerHTML = "";
          const hint = document.createElement("div");
          hint.className = "cb-update-empty";
          hint.textContent = "Run this once in Terminal to enable one-click updates:";
          const code = document.createElement("code");
          code.className = "cb-update-code";
          code.textContent = "bash ~/Quartz/scripts/install-updater.sh";
          body.appendChild(hint);
          body.appendChild(code);
        } else {
          setStatus(statusEl, "error", "Couldn't check for updates.");
        }
        return;
      }
      const behind = (res.behind || 0) > 0;
      if (behind) {
        const latest = res.latestVersion ? "v" + res.latestVersion : "latest";
        setStatus(statusEl, "available", `Update available \u2014 ${latest} (${res.behind} new)`);
        updateBtn.disabled = false;
      } else {
        setStatus(statusEl, "ok", "You're on the latest version.");
        updateBtn.disabled = true;
      }
      renderTimeline(body, res);
    });
  };
})();
