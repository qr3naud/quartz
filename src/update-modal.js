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

  /** Parses major/minor/patch from a trailing "(vX[.Y[.Z]])" in the subject. */
  function parseVersion(subject) {
    const m = /\(v(\d+)(?:\.(\d+))?(?:\.(\d+))?\)\s*$/.exec(subject || "");
    if (!m) return null;
    const major = parseInt(m[1], 10);
    const minor = m[2] != null ? parseInt(m[2], 10) : 0;
    const patch = m[3] != null ? parseInt(m[3], 10) : 0;
    const raw = m[1] + (m[2] != null ? "." + m[2] : "") + (m[3] != null ? "." + m[3] : "");
    return { major, minor, patch, raw };
  }

  const CHEVRON_SVG =
    '<svg class="cb-update-chevron" width="12" height="12" viewBox="0 0 24 24" ' +
    'fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" ' +
    'stroke-linejoin="round" aria-hidden="true"><polyline points="9 6 15 12 9 18"/></svg>';

  /** A collapsible group node. Returns { wrap, childrenEl } and toggles a
   *  collapsed class on click of the header. */
  function makeGroup(level, label, count, isNew, collapsed) {
    const wrap = document.createElement("div");
    wrap.className = "cb-update-group cb-update-group-" + level + (collapsed ? " cb-update-collapsed" : "");

    const header = document.createElement("button");
    header.type = "button";
    header.className = "cb-update-group-header";
    header.innerHTML = CHEVRON_SVG;

    const labelEl = document.createElement("span");
    labelEl.className = "cb-update-group-label";
    labelEl.textContent = label;
    header.appendChild(labelEl);

    if (isNew) {
      const dot = document.createElement("span");
      dot.className = "cb-update-group-new";
      dot.textContent = "new";
      header.appendChild(dot);
    }

    const countEl = document.createElement("span");
    countEl.className = "cb-update-group-count";
    countEl.textContent = String(count);
    header.appendChild(countEl);

    const childrenEl = document.createElement("div");
    childrenEl.className = "cb-update-children";

    header.addEventListener("click", (evt) => {
      evt.stopPropagation();
      wrap.classList.toggle("cb-update-collapsed");
    });

    wrap.appendChild(header);
    wrap.appendChild(childrenEl);
    return { wrap, childrenEl };
  }

  function makeCommitRow(commit) {
    const { message } = splitVersion(commit.subject);
    const row = document.createElement("div");
    row.className = "cb-update-item" + (commit.isNew ? " cb-update-item-new" : "");

    const msg = document.createElement("span");
    msg.className = "cb-update-msg";
    msg.textContent = message || commit.subject || "(no message)";

    const date = document.createElement("span");
    date.className = "cb-update-date";
    date.textContent = commit.date || "";

    const badge = document.createElement("span");
    badge.className = "cb-update-badge";
    badge.textContent = commit.version ? "v" + commit.version.raw : "\u2014";

    row.appendChild(msg);
    row.appendChild(date);
    row.appendChild(badge);
    return row;
  }

  function renderTimeline(bodyEl, data) {
    bodyEl.innerHTML = "";

    const incoming = Array.isArray(data.incoming) ? data.incoming : [];
    const recent = Array.isArray(data.recent) ? data.recent : [];
    const newHashes = new Set(incoming.map((c) => c.hash));

    // Merge incoming + recent (incoming first), dedupe by hash, parse versions.
    const seen = new Set();
    const commits = [];
    for (const c of incoming.concat(recent)) {
      if (seen.has(c.hash)) continue;
      seen.add(c.hash);
      commits.push({ ...c, isNew: newHashes.has(c.hash), version: parseVersion(c.subject) });
    }

    // Group: major -> minor -> commits[]. Unversioned commits go to "other".
    const majors = new Map(); // major(number) -> Map<minor, commit[]>
    const other = [];
    for (const c of commits) {
      if (!c.version) { other.push(c); continue; }
      if (!majors.has(c.version.major)) majors.set(c.version.major, new Map());
      const minors = majors.get(c.version.major);
      if (!minors.has(c.version.minor)) minors.set(c.version.minor, []);
      minors.get(c.version.minor).push(c);
    }

    if (!commits.length) {
      const empty = document.createElement("div");
      empty.className = "cb-update-empty";
      empty.textContent = "No commit history available.";
      bodyEl.appendChild(empty);
      return;
    }

    const sortedMajors = [...majors.keys()].sort((a, b) => b - a);
    let firstMajor = true;
    for (const major of sortedMajors) {
      const minors = majors.get(major);
      const majorCommits = [...minors.values()].flat();
      const majorHasNew = majorCommits.some((c) => c.isNew);
      // Expand the newest major (or any major with incoming commits).
      const { wrap: majorWrap, childrenEl: majorChildren } = makeGroup(
        "major",
        "Version " + major,
        majorCommits.length,
        majorHasNew,
        !(firstMajor || majorHasNew),
      );
      bodyEl.appendChild(majorWrap);

      const sortedMinors = [...minors.keys()].sort((a, b) => b - a);
      let firstMinor = true;
      for (const minor of sortedMinors) {
        const rows = minors.get(minor).sort((a, b) => (b.version.patch - a.version.patch));
        const minorHasNew = rows.some((c) => c.isNew);
        const { wrap: minorWrap, childrenEl: minorChildren } = makeGroup(
          "minor",
          "v" + major + "." + minor,
          rows.length,
          minorHasNew,
          // Expand the newest minor of the newest major, or any with new commits.
          !((firstMajor && firstMinor) || minorHasNew),
        );
        for (const c of rows) minorChildren.appendChild(makeCommitRow(c));
        majorChildren.appendChild(minorWrap);
        firstMinor = false;
      }
      firstMajor = false;
    }

    if (other.length) {
      const { wrap, childrenEl } = makeGroup("major", "Other changes", other.length, false, true);
      for (const c of other) childrenEl.appendChild(makeCommitRow(c));
      bodyEl.appendChild(wrap);
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
