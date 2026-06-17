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

  const GITHUB_REPO_URL = "https://github.com/qr3naud/quartz";
  const GITHUB_ICON_SVG =
    '<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true">' +
    '<path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 ' +
    "0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53" +
    ".63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 " +
    "0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 " +
    "1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 " +
    '0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z"/></svg>';

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
   *  collapsed class on click of the header. `tone` colors the label pill:
   *  "white" (major), "ok" (green), "behind" (amber), or "grey". */
  function makeGroup(level, label, count, tone, collapsed) {
    const wrap = document.createElement("div");
    wrap.className = "cb-update-group cb-update-group-" + level + (collapsed ? " cb-update-collapsed" : "");

    const header = document.createElement("button");
    header.type = "button";
    header.className = "cb-update-group-header";
    header.innerHTML = CHEVRON_SVG;

    const labelEl = document.createElement("span");
    labelEl.className = "cb-update-grouppill cb-update-grouppill-" + tone;
    labelEl.textContent = label;
    header.appendChild(labelEl);

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

  function makeCommitRow(commit, inRecent, ctx) {
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
    // Status-driven color (assigned in renderTimeline): indigo = published,
    // green = installed (your running version), amber = incoming, grey = default.
    const variantClass =
      commit.badgeVariant === "published"
        ? " cb-update-badge-published"
        : commit.badgeVariant === "installed"
          ? " cb-update-badge-installed"
          : commit.badgeVariant === "new"
            ? " cb-update-badge-new"
            : "";
    badge.className = "cb-update-badge" + variantClass;
    badge.textContent = commit.version ? "v" + commit.version.raw : "\u2014";

    row.appendChild(msg);
    row.appendChild(date);
    row.appendChild(badge);

    // Admin version picker. Status markers: teal "Published" (the version
    // non-admins receive) takes precedence over grey "Installed" (the version
    // currently running). Any version except the running one is installable -
    // the row is clickable and the "Install" button slides in from the right.
    if (ctx && ctx.isAdmin) {
      const ver = commit.version ? commit.version.raw : null;
      const isInstalled = !!(ver && ctx.currentVersion && ver === ctx.currentVersion);
      const isPublished = !!(ver && ctx.publishedVersion && ver === ctx.publishedVersion);

      if (isPublished) {
        const m = document.createElement("span");
        m.className = "cb-update-published";
        m.textContent = "Published";
        row.appendChild(m);
      } else if (isInstalled) {
        const m = document.createElement("span");
        m.className = "cb-update-installed";
        m.textContent = "Installed";
        row.appendChild(m);
      }

      if (!isInstalled) {
        const install = document.createElement("button");
        install.type = "button";
        install.className = "cb-update-install";
        install.textContent = "Install";
        install.title = ver ? "Install v" + ver : "Install this commit";
        install.addEventListener("click", (evt) => {
          evt.stopPropagation();
          ctx.onInstall(commit.hash, ver || commit.hash.slice(0, 7));
        });
        row.appendChild(install);

        // Click the row to arm it (Install slides in from the right). Only one
        // row armed at a time; clicking again disarms.
        row.classList.add("cb-update-item-armable");
        row.addEventListener("click", () => {
          const body = row.closest(".cb-update-body");
          const wasArmed = row.classList.contains("cb-update-item-armed");
          if (body) {
            body
              .querySelectorAll(".cb-update-item-armed")
              .forEach((r) => r.classList.remove("cb-update-item-armed"));
          }
          if (!wasArmed) row.classList.add("cb-update-item-armed");
        });
      }
    }
    return row;
  }

  function renderTimeline(bodyEl, data, ctx) {
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

    // Badge variant is status-driven: "published" (indigo, admin only),
    // "installed" (green, your running version), "new" (amber, incoming), else
    // "default" (grey). Published takes precedence over installed.
    const behind = incoming.length > 0;
    const curVer = ctx && ctx.currentVersion;
    const pubVer = ctx && ctx.isAdmin ? ctx.publishedVersion : null;
    for (const c of commits) {
      const v = c.version ? c.version.raw : null;
      c.badgeVariant =
        v && pubVer && v === pubVer
          ? "published"
          : v && curVer && v === curVer
            ? "installed"
            : c.isNew
              ? "new"
              : "default";
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
      const majorHasPublished = !!pubVer && majorCommits.some((c) => c.version && c.version.raw === pubVer);
      // Major header: a white pill showing just the major number.
      const { wrap: majorWrap, childrenEl: majorChildren } = makeGroup(
        "major",
        String(major),
        majorCommits.length,
        "white",
        !(firstMajor || majorHasNew || majorHasPublished),
      );
      bodyEl.appendChild(majorWrap);

      const sortedMinors = [...minors.keys()].sort((a, b) => b - a);
      let firstMinor = true;
      for (const minor of sortedMinors) {
        const rows = minors.get(minor).sort((a, b) => (b.version.patch - a.version.patch));
        const minorHasNew = rows.some((c) => c.isNew);
        const minorHasPublished = !!pubVer && rows.some((c) => c.version && c.version.raw === pubVer);
        // The group that holds the published version is indigo so it's easy to
        // spot; otherwise the most-recent subgroup is green (up to date) / amber
        // (behind), and every other subgroup is grey.
        const isMostRecent = firstMajor && firstMinor;
        const tone = minorHasPublished
          ? "published"
          : isMostRecent
            ? (behind ? "behind" : "ok")
            : "grey";
        const { wrap: minorWrap, childrenEl: minorChildren } = makeGroup(
          "minor",
          "v" + major + "." + minor,
          rows.length,
          tone,
          // Expand the newest minor, the published group, or any with new commits.
          !(isMostRecent || minorHasNew || minorHasPublished),
        );
        for (const c of rows) minorChildren.appendChild(makeCommitRow(c, isMostRecent, ctx));
        majorChildren.appendChild(minorWrap);
        firstMinor = false;
      }
      firstMajor = false;
    }

    if (other.length) {
      const { wrap, childrenEl } = makeGroup("major", "Other", other.length, "white", true);
      for (const c of other) childrenEl.appendChild(makeCommitRow(c, false, ctx));
      bodyEl.appendChild(wrap);
    }
  }

  function sendUpdateMessage(type, payload) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type, ...(payload || {}) }, (res) => {
          resolve({ lastError: chrome.runtime.lastError ? chrome.runtime.lastError.message : null, res: res || null });
        });
      } catch (err) {
        resolve({ lastError: String(err), res: null });
      }
    });
  }

  __cb.openUpdateModal = function openUpdateModal() {
    // In an orphaned tab (the extension was reloaded out from under this page),
    // the modal can't reach the service worker and chrome.runtime.getManifest()
    // throws "Extension context invalidated". Surface the reconnect banner
    // instead of opening a dead modal / throwing.
    if (window.__cbSupabase && !window.__cbSupabase.isExtensionContextAlive()) {
      window.__cbSupabase.notifyContextInvalidated();
      return;
    }
    closeModal();

    // Chrome Web Store builds update automatically — there's no git host to pull
    // from and no version timeline to show. Surface a passive note instead. (The
    // More-menu Update row is already hidden on store builds; this is a guard for
    // any other caller of openUpdateModal.)
    if (__cb.isStoreChannel && __cb.isStoreChannel()) {
      backdropEl = document.createElement("div");
      backdropEl.className = "cb-update-backdrop";
      backdropEl.addEventListener("click", closeModal);
      backdropEl.addEventListener("mousedown", (evt) => evt.stopPropagation());

      modalEl = document.createElement("div");
      modalEl.className = "cb-update-modal";
      modalEl.addEventListener("click", (evt) => evt.stopPropagation());
      modalEl.addEventListener("mousedown", (evt) => evt.stopPropagation());

      const storeVersion =
        (chrome.runtime.getManifest && chrome.runtime.getManifest().version) || "";
      modalEl.innerHTML =
        '<div class="cb-update-header"><div class="cb-update-headleft">' +
        '<div class="cb-update-title">Quartz</div></div>' +
        '<div class="cb-update-headright">' +
        `<span class="cb-update-version cb-update-version-ok">${storeVersion ? "v" + storeVersion : ""}</span>` +
        "</div></div>" +
        '<div class="cb-update-body"><p class="cb-update-empty">' +
        "Quartz updates automatically through the Chrome Web Store. " +
        "You're always on the latest published version." +
        "</p></div>";

      document.addEventListener("keydown", onKeydown);
      document.body.appendChild(backdropEl);
      document.body.appendChild(modalEl);
      return;
    }

    // Only the maintainer gets the per-version picker (install/rollback to any
    // commit). Gated on the signed `is_admin` claim (src/auth.js), same flag as
    // the Archived menu in src/overlay.js.
    const isAdmin = !!__cb.isAdmin;

    backdropEl = document.createElement("div");
    backdropEl.className = "cb-update-backdrop";
    backdropEl.addEventListener("click", closeModal);
    backdropEl.addEventListener("mousedown", (evt) => evt.stopPropagation());

    modalEl = document.createElement("div");
    modalEl.className = "cb-update-modal";
    modalEl.addEventListener("click", (evt) => evt.stopPropagation());
    modalEl.addEventListener("mousedown", (evt) => evt.stopPropagation());

    // Header: title on the left; a short status label + a colored version
    // pill on the right (green when up to date, amber when behind).
    const header = document.createElement("div");
    header.className = "cb-update-header";

    const headLeft = document.createElement("div");
    headLeft.className = "cb-update-headleft";
    const title = document.createElement("div");
    title.className = "cb-update-title";
    title.textContent = "Quartz";
    const ghLink = document.createElement("a");
    ghLink.className = "cb-update-gh";
    ghLink.href = GITHUB_REPO_URL;
    ghLink.target = "_blank";
    ghLink.rel = "noopener noreferrer";
    ghLink.title = "View the repository on GitHub";
    ghLink.setAttribute("aria-label", "View on GitHub");
    ghLink.innerHTML = GITHUB_ICON_SVG;
    ghLink.addEventListener("click", (evt) => evt.stopPropagation());
    headLeft.appendChild(title);
    headLeft.appendChild(ghLink);

    const headRight = document.createElement("div");
    headRight.className = "cb-update-headright";
    const statusEl = document.createElement("span");
    statusEl.className = "cb-update-status cb-update-status-loading";
    statusEl.textContent = "Checking\u2026";
    const versionPill = document.createElement("span");
    const currentVersion = (chrome.runtime.getManifest && chrome.runtime.getManifest().version) || "";
    versionPill.className = "cb-update-version cb-update-version-loading";
    versionPill.textContent = currentVersion ? "v" + currentVersion : "";
    headRight.appendChild(statusEl);
    headRight.appendChild(versionPill);

    header.appendChild(headLeft);
    header.appendChild(headRight);
    modalEl.appendChild(header);

    // Updates the short status label and the version-pill color together.
    const applyState = (kind, text) => {
      statusEl.className = "cb-update-status cb-update-status-" + kind;
      statusEl.textContent = text;
      const pill =
        kind === "ok" ? "ok" : kind === "loading" ? "loading" : "behind";
      versionPill.className = "cb-update-version cb-update-version-" + pill;
    };

    // When an update is available, the pill reads "vCURRENT -> vLATEST" with the
    // current version struck through; otherwise just the current version.
    const renderVersionPill = (behind, current, latest) => {
      versionPill.textContent = "";
      if (behind && current && latest && current !== latest) {
        const from = document.createElement("span");
        from.className = "cb-update-version-from";
        from.textContent = "v" + current;
        const arrow = document.createElement("span");
        arrow.className = "cb-update-version-arrow";
        arrow.textContent = "\u2192";
        const to = document.createElement("span");
        to.className = "cb-update-version-to";
        to.textContent = "v" + latest;
        versionPill.append(from, arrow, to);
      } else {
        versionPill.textContent = current ? "v" + current : latest ? "v" + latest : "";
      }
    };

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
      applyState("loading", "Updating\u2026");
      sendUpdateMessage(type).then(({ lastError, res }) => {
        // Success: the service worker reloads the extension on a successful
        // update, which closes this message channel (lastError). The only real
        // failures come back as a proper { ok:false } response, so a closed
        // channel — or an explicit updated:true — means the reload is underway.
        // Stay on "Updating…" until the tab refreshes; never flash an error.
        if (lastError || (res && res.ok && res.updated)) {
          return; // keep "Updating…", keep the button disabled (busy stays true)
        }
        busy = false;
        if (!res || res.ok === false) {
          if (res && res.error === "host-missing") {
            applyState("error", "Setup needed");
          } else if (res && res.error === "ff-only") {
            applyState("error", "Conflict");
            updateBtn.disabled = false;
            updateBtn.textContent = "Force update";
            updateBtn.onclick = () => {
              if (window.confirm("Discard local changes and update to the latest version?")) {
                runPull("cb:update:forcePull");
              }
            };
          } else {
            applyState("error", "Update failed");
            updateBtn.disabled = false;
          }
        } else if (res.ok && !res.updated) {
          applyState("ok", "Up to date");
        }
      });
    }
    updateBtn.onclick = () => runPull("cb:update:pull");

    // Admin version picker: install (or roll back to) a specific commit. Same
    // "keep the spinner through the reload" handling as runPull.
    function runCheckout(ref, label) {
      if (busy) return;
      busy = true;
      updateBtn.disabled = true;
      applyState("loading", "Installing v" + label + "\u2026");
      sendUpdateMessage("cb:update:checkout", { ref }).then(({ lastError, res }) => {
        if (lastError || (res && res.ok && res.updated)) return; // reload underway
        busy = false;
        if (!res || res.ok === false) {
          applyState("error", res && res.error === "host-missing" ? "Setup needed" : "Install failed");
          updateBtn.disabled = false;
        } else if (res.ok && !res.updated) {
          applyState("ok", "Already on that version");
        }
      });
    }

    // Load the timeline.
    sendUpdateMessage("cb:update:log").then(({ lastError, res }) => {
      if (lastError || !res || res.ok === false) {
        spinner.remove();
        if (res && res.error === "host-missing") {
          applyState("error", "Setup needed");
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
          applyState("error", "Check failed");
        }
        return;
      }
      const behind = (res.behind || 0) > 0;
      if (behind) {
        applyState("available", "Update available");
        updateBtn.disabled = false;
      } else {
        applyState("ok", "Up to date");
        updateBtn.disabled = true;
      }
      renderVersionPill(behind, res.currentVersion || currentVersion, res.latestVersion);
      const ctx = {
        isAdmin,
        currentVersion,
        publishedVersion: res.publishedVersion || null,
        onInstall: (hash, label) => {
          if (window.confirm("Install v" + label + "? This reloads the extension.")) {
            runCheckout(hash, label);
          }
        },
      };
      renderTimeline(body, res, ctx);
    });
  };
})();
