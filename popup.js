/**
 * Chrome extension popup. Opens when the user clicks the extension icon in
 * the browser toolbar. Shows the user's recent canvases (from Supabase) and
 * lets them jump to any of them.
 *
 * Runs in the extension's own context (not the page), so it has access to
 * chrome.tabs but NOT to the content script's globals or app.clay.com's
 * localStorage. To trigger the canvas overlay on the destination page, we
 * append a `#cb-open` URL hash that the content script detects.
 */
(function () {
  "use strict";

  const supa = window.cbSupabase;
  const statusEl = document.getElementById("cb-popup-status");
  const listEl = document.getElementById("cb-popup-list");
  const currentBtn = document.getElementById("cb-popup-current");
  const userNameEl = document.getElementById("cb-popup-user-name");
  const userAvatarEl = document.getElementById("cb-popup-user-avatar");

  function showStatus(text, isError) {
    statusEl.textContent = text;
    statusEl.hidden = false;
    statusEl.classList.toggle("cb-popup-status-error", !!isError);
    listEl.hidden = true;
  }

  function hideStatus() {
    statusEl.hidden = true;
  }

  /** Returns the workspaceId/workbookId from a Clay URL, or null. */
  function parseClayUrl(url) {
    if (!url) return null;
    try {
      const u = new URL(url);
      if (!u.hostname.endsWith("clay.com")) return null;
      const parts = u.pathname.split("/");
      const wsIdx = parts.indexOf("workspaces");
      const wbIdx = parts.indexOf("workbooks");
      if (wsIdx === -1 || wbIdx === -1) return null;
      return {
        workspaceId: parts[wsIdx + 1],
        workbookId: parts[wbIdx + 1],
      };
    } catch {
      return null;
    }
  }

  /**
   * Renders either a user's profile photo or a fallback initial into an
   * avatar element. Works for header, row, or any other .cb-popup-avatar.
   */
  function renderAvatar(el, profilePicture, name) {
    el.style.backgroundImage = "";
    el.textContent = "";
    if (profilePicture) {
      el.style.backgroundImage = `url("${profilePicture}")`;
      return;
    }
    // Fallback: show first letter of name in a colored circle.
    el.textContent = (name || "?").trim().charAt(0);
  }

  /** Reads a user's name + avatar from the Supabase `users` table. Used to
   *  recover the acting admin's profile while impersonating (the /v3/me
   *  adminUser payload carries no avatar). RLS permits reading your own row
   *  (id = jwt sub), which is the acting identity. */
  async function fetchUserRow(userId) {
    if (!userId) return null;
    try {
      const rows = await supa.supabaseFetch("users", "GET", {
        query: { id: `eq.${userId}`, select: "name,profile_picture", limit: "1" },
      });
      const row = rows && rows[0];
      return row ? { name: row.name || null, profilePicture: row.profile_picture || null } : null;
    } catch (err) {
      console.warn("[Clay Scoping Popup] users row fetch failed:", err);
      return null;
    }
  }

  /** Clay's API includes session cookies because we use credentials:"include"
   *  and the manifest grants host permissions for api.clay.com.
   *
   *  Returns the *acting* identity: normally the user themselves, but while
   *  impersonating it's the real Clay admin (same logic as presence / the
   *  collaborators widget and the JWT `sub` minted by clay-auth-mint). /v3/me
   *  returns the impersonated user at the top level plus `adminUser` (the real
   *  acting identity, server-set so trustworthy). */
  async function fetchCurrentUser() {
    try {
      const res = await fetch("https://api.clay.com/v3/me", {
        credentials: "include",
      });
      if (!res.ok) return null;
      const data = await res.json();
      if (!data || data.id == null) return null;

      const admin = data.adminUser || null;
      if (data.isImpersonated === true && admin) {
        const acting = {
          id: String(admin.id),
          name: admin.fullName || admin.name || admin.email || null,
          profilePicture: null, // adminUser payload has no avatar
        };
        // Recover the admin's name/avatar from their own Supabase row (the
        // JWT sub matches the acting id, so RLS permits this read).
        const row = await fetchUserRow(acting.id);
        if (row) {
          acting.name = acting.name || row.name;
          acting.profilePicture = row.profilePicture || acting.profilePicture;
        }
        return acting;
      }

      return {
        id: String(data.id),
        name: data.fullName || data.name || data.username || data.email || null,
        profilePicture: data.profilePicture || null,
      };
    } catch (err) {
      console.warn("[Clay Scoping Popup] /v3/me failed:", err);
      return null;
    }
  }

  /** Returns the user's contributor rows with embedded canvas metadata,
   *  across all their workspaces (RLS scopes to workspaces they belong to).
   *  Sorted by most-recently accessed first. */
  async function fetchCanvases(userId) {
    return supa.supabaseFetch("canvas_contributors", "GET", {
      query: {
        user_id: `eq.${userId}`,
        select: "workbook_id,last_accessed_at,canvases!inner(workspace_id,workbook_name,updated_at)",
        order: "last_accessed_at.desc",
        limit: "50",
      },
    });
  }

  // Workspace name + avatar lookups (Clay API), cached for the popup session.
  const workspaceMetaCache = new Map();

  /** Fetches a workspace's display name + avatar from Clay. Best-effort:
   *  on any failure returns a generic name with no avatar. */
  async function fetchWorkspaceMeta(workspaceId) {
    if (!workspaceId) return { name: "Workspace", avatarUrl: null };
    if (workspaceMetaCache.has(workspaceId)) return workspaceMetaCache.get(workspaceId);
    let meta = { name: "Workspace", avatarUrl: null };
    try {
      const res = await fetch(`https://api.clay.com/v3/workspaces/${workspaceId}`, {
        credentials: "include",
      });
      if (res.ok) {
        const data = await res.json();
        meta = { name: data?.name || "Workspace", avatarUrl: data?.icon?.url || null };
      }
    } catch (err) {
      console.warn("[Quartz Popup] workspace meta fetch failed:", err);
    }
    workspaceMetaCache.set(workspaceId, meta);
    return meta;
  }

  function formatRelative(isoDate) {
    if (!isoDate) return "never";
    const then = new Date(isoDate).getTime();
    if (isNaN(then)) return "never";
    const diff = Date.now() - then;
    const sec = Math.round(diff / 1000);
    if (sec < 60) return "just now";
    const min = Math.round(sec / 60);
    if (min < 60) return `${min}m ago`;
    const hr = Math.round(min / 60);
    if (hr < 24) return `${hr}h ago`;
    const day = Math.round(hr / 24);
    if (day < 30) return `${day}d ago`;
    return new Date(isoDate).toLocaleDateString();
  }

  /** Navigates the active tab to the given workbook URL with a #cb-open hash
   *  so the content script knows to auto-open the overlay. */
  function openCanvas(workspaceId, workbookId) {
    const url = `https://app.clay.com/workspaces/${workspaceId}/workbooks/${workbookId}/#cb-open`;
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs[0];
      // Reuse current tab if it's already on app.clay.com; otherwise open new.
      if (tab && tab.url && tab.url.includes("app.clay.com")) {
        chrome.tabs.update(tab.id, { url });
      } else {
        chrome.tabs.create({ url });
      }
      window.close();
    });
  }

  function renderList(rows, currentIds, wsMetaById) {
    listEl.innerHTML = "";

    if (!rows || rows.length === 0) {
      showStatus("No canvases yet. Open Quartz on a workbook to start one.");
      return;
    }

    hideStatus();
    listEl.hidden = false;

    for (const row of rows) {
      const li = document.createElement("li");
      li.className = "cb-popup-item";

      const workspaceId = row.canvases?.workspace_id;
      const ws = (workspaceId && wsMetaById.get(workspaceId)) || { name: "Workspace", avatarUrl: null };

      const avatar = document.createElement("div");
      avatar.className = "cb-popup-avatar";
      renderAvatar(avatar, ws.avatarUrl, ws.name);

      const body = document.createElement("div");
      body.className = "cb-popup-item-body";

      const title = document.createElement("div");
      title.className = "cb-popup-item-title";
      title.textContent = row.canvases?.workbook_name || row.workbook_id;

      // Mark the row that matches the workbook the user is currently viewing.
      if (currentIds && row.workbook_id === currentIds.workbookId) {
        const badge = document.createElement("span");
        badge.className = "cb-popup-item-current-badge";
        badge.textContent = "Current";
        title.appendChild(badge);
      }

      const meta = document.createElement("div");
      meta.className = "cb-popup-item-meta";
      const edited = formatRelative(row.canvases?.updated_at || row.last_accessed_at);
      meta.textContent = `${ws.name} · edited ${edited}`;

      body.appendChild(title);
      body.appendChild(meta);

      li.appendChild(avatar);
      li.appendChild(body);

      if (workspaceId) {
        li.addEventListener("click", () => openCanvas(workspaceId, row.workbook_id));
      } else {
        // No workspace_id stored => can't construct a URL. Disable click.
        li.style.cursor = "not-allowed";
        li.style.opacity = "0.5";
      }

      listEl.appendChild(li);
    }
  }

  /**
   * Wires the "Update available" banner. The background service worker checks
   * (via the native updater helper) whether the cloned repo is behind origin
   * and caches the result in chrome.storage; we read that cache for an instant
   * banner, then trigger a fresh status check. Clicking "Update now" asks the
   * SW to run `git pull` — on success the extension reloads and this popup
   * closes; we only handle the no-op / error outcomes here.
   */
  function initUpdate() {
    const box = document.getElementById("cb-popup-update");
    const textEl = document.getElementById("cb-popup-update-text");
    const btn = document.getElementById("cb-popup-update-btn");
    const versionEl = document.getElementById("cb-popup-version");
    if (!box || !textEl || !btn || !versionEl) return;

    const currentVersion =
      (chrome.runtime.getManifest && chrome.runtime.getManifest().version) || "";

    // The version pill mirrors the update modal: green up to date, amber
    // behind, grey while unconfirmed.
    function setVersionPill(state) {
      versionEl.textContent = currentVersion ? `v${currentVersion}` : "";
      versionEl.className = "cb-popup-version cb-popup-version-" + state;
    }

    function showBanner(info) {
      if (!info || !info.behind) {
        box.hidden = true;
        return;
      }
      textEl.textContent = info.latestVersion
        ? `Update available → v${info.latestVersion}`
        : "Update available";
      box.hidden = false;
    }

    function runUpdate(type) {
      btn.disabled = true;
      textEl.textContent = "Updating…";
      chrome.runtime.sendMessage({ type }, (res) => {
        const lastErr = chrome.runtime.lastError;
        // Success: the service worker reloads the extension (which closes this
        // popup). A closed channel / updated:true means the reload is underway
        // — stay on "Updating…", never flash an error. Same as the modal.
        if (lastErr || (res && res.ok && res.updated)) return;
        btn.disabled = false;
        if (!res || res.ok === false) {
          if (res && res.error === "host-missing") {
            textEl.textContent = "One-time setup needed";
            btn.textContent = "Copy setup command";
            btn.onclick = () => {
              const cmd = "bash ~/Quartz/scripts/install-updater.sh";
              if (navigator.clipboard) navigator.clipboard.writeText(cmd).catch(() => {});
              btn.textContent = "Copied ✓";
            };
          } else if (res && res.error === "ff-only") {
            textEl.textContent = "Local changes block update";
            btn.textContent = "Force update";
            btn.onclick = () => {
              if (window.confirm("Discard local changes and update to the latest version?")) {
                runUpdate("cb:update:forcePull");
              }
            };
          } else {
            textEl.textContent = "Update failed";
            btn.textContent = "Retry";
          }
        } else if (res.ok && !res.updated) {
          textEl.textContent = "You're on the latest version";
          btn.hidden = true;
        }
      });
    }

    btn.onclick = () => runUpdate("cb:update:pull");

    // Instant pill + banner from the SW's cached status, then a live re-check
    // that is the source of truth. The live result is authoritative: guard so
    // a late-resolving (stale) cache read can't override it.
    let liveResolved = false;
    try {
      chrome.storage.local.get("quartzUpdateInfo", (r) => {
        if (liveResolved) return;
        const info = r && r.quartzUpdateInfo;
        if (info) {
          setVersionPill(info.behind ? "behind" : "ok");
          showBanner(info);
        }
      });
    } catch {}
    chrome.runtime.sendMessage({ type: "cb:update:status" }, (res) => {
      liveResolved = true;
      if (chrome.runtime.lastError || !res || !res.ok) {
        setVersionPill("loading"); // unconfirmed (e.g. helper not installed)
        showBanner(null);
        return;
      }
      const behind = (res.behind || 0) > 0;
      setVersionPill(behind ? "behind" : "ok");
      showBanner({ behind, latestVersion: res.latestVersion });
    });
  }

  async function init() {
    initUpdate();

    if (!supa) {
      showStatus("Supabase client failed to load.", true);
      return;
    }

    // Wire up the "Open canvas for current workbook" button. Visible only when
    // the active tab is already on a Clay workbook.
    chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
      const tab = tabs[0];
      const currentIds = parseClayUrl(tab?.url);
      if (currentIds) {
        currentBtn.hidden = false;
        currentBtn.addEventListener("click", () =>
          openCanvas(currentIds.workspaceId, currentIds.workbookId),
        );
      }

      const user = await fetchCurrentUser();
      if (!user) {
        userNameEl.textContent = "Not signed in";
        showStatus(
          "Couldn't identify your Clay user. Make sure you're logged in to app.clay.com.",
          true,
        );
        return;
      }

      // Header: current user's avatar + name
      userNameEl.textContent = user.name || "Clay user";
      renderAvatar(userAvatarEl, user.profilePicture, user.name);

      try {
        // All of the user's canvases across every workspace they belong to
        // (RLS scopes the rows to those workspaces). Each row is labeled with
        // its own workspace's name + avatar, fetched from Clay and cached.
        const rows = await fetchCanvases(user.id);
        const wsIds = [
          ...new Set((rows || []).map(r => r.canvases?.workspace_id).filter(Boolean)),
        ];
        const metas = await Promise.all(wsIds.map(id => fetchWorkspaceMeta(id)));
        const wsMetaById = new Map();
        wsIds.forEach((id, i) => wsMetaById.set(id, metas[i]));
        renderList(rows, currentIds, wsMetaById);
      } catch (err) {
        console.error("[Clay Scoping Popup] fetchCanvases failed:", err);
        showStatus("Couldn't load canvases from the server.", true);
      }
    });
  }

  init();
})();
