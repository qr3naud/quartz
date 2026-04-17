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

  /** Clay's API includes session cookies because we use credentials:"include"
   *  and the manifest grants host permissions for api.clay.com. */
  async function fetchCurrentUser() {
    try {
      const res = await fetch("https://api.clay.com/v3/me", {
        credentials: "include",
      });
      if (!res.ok) return null;
      const data = await res.json();
      if (!data || data.id == null) return null;
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

  /** Returns contributor rows with embedded canvas metadata AND user info
   *  for the last editor. Sorted by most-recently accessed first. */
  async function fetchCanvases(userId) {
    // PostgREST resource embedding:
    // - canvases(...) pulls workspace_id and workbook_name from the fk
    // - updatedByUser:users!... resolves canvases.updated_by to a users row.
    //   The ! syntax names the foreign-key hint to PostgREST; we need it here
    //   because canvases.updated_by isn't a declared foreign key (users.id is
    //   text and updated_by may contain "unknown"). So we request the name
    //   separately below via a second query.
    return supa.supabaseFetch("canvas_contributors", "GET", {
      query: {
        user_id: `eq.${userId}`,
        select: "workbook_id,last_accessed_at,canvases(workspace_id,workbook_name,updated_at,updated_by)",
        order: "last_accessed_at.desc",
        limit: "50",
      },
    });
  }

  /**
   * Given a list of user ids, fetches name + profile_picture for each.
   * Returns a Map<id, { name, profile_picture }>.
   *
   * We do this as a separate query (rather than a PostgREST embed) because
   * `canvases.updated_by` is not a formal foreign key (it can contain
   * "unknown" when a save happens before the user fetch resolves).
   */
  async function fetchUsersByIds(ids) {
    const byId = new Map();
    const filtered = [...new Set(ids)].filter(id => id && id !== "unknown");
    if (filtered.length === 0) return byId;
    try {
      const rows = await supa.supabaseFetch("users", "GET", {
        query: {
          id: `in.(${filtered.join(",")})`,
          select: "id,name,profile_picture",
        },
      });
      for (const row of rows || []) byId.set(row.id, row);
    } catch (err) {
      console.warn("[Clay Scoping Popup] users lookup failed:", err);
    }
    return byId;
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

  function renderList(rows, currentIds, usersById, currentUserId) {
    listEl.innerHTML = "";

    if (!rows || rows.length === 0) {
      showStatus("No saved canvases yet. Open the GTME View on a workbook to start.");
      return;
    }

    hideStatus();
    listEl.hidden = false;

    for (const row of rows) {
      const li = document.createElement("li");
      li.className = "cb-popup-item";

      const editorId = row.canvases?.updated_by;
      const editor = editorId ? usersById.get(editorId) : null;

      const avatar = document.createElement("div");
      avatar.className = "cb-popup-avatar";
      renderAvatar(avatar, editor?.profile_picture, editor?.name || editorId);

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
      const editorLabel = editor?.name
        ? (editorId === currentUserId ? "you" : editor.name)
        : editorId || "unknown";
      meta.textContent = `Last edited ${formatRelative(row.canvases?.updated_at || row.last_accessed_at)} by ${editorLabel}`;

      body.appendChild(title);
      body.appendChild(meta);

      li.appendChild(avatar);
      li.appendChild(body);

      const workspaceId = row.canvases?.workspace_id;
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

  async function init() {
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
        const rows = await fetchCanvases(user.id);
        // Collect the set of user ids we'll need avatars/names for, then
        // fetch them in one round-trip.
        const editorIds = (rows || [])
          .map(r => r.canvases?.updated_by)
          .filter(Boolean);
        const usersById = await fetchUsersByIds(editorIds);
        renderList(rows, currentIds, usersById, user.id);
      } catch (err) {
        console.error("[Clay Scoping Popup] fetchCanvases failed:", err);
        showStatus("Couldn't load canvases from the server.", true);
      }
    });
  }

  init();
})();
