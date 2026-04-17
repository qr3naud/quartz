/**
 * Collaborators widget shown in the top-right corner of the brainstorm
 * canvas. Surfaces who else has touched the canvas for the current workbook.
 *
 * Data flow:
 *   1. On canvas open, query `canvas_contributors` joined with `users` for
 *      the current workbook_id.
 *   2. Render up to 3 overlapping avatars in a compact header.
 *   3. Click header → toggles a dropdown listing every contributor.
 *   4. Click outside or press Escape → closes the dropdown.
 *
 * Refresh: after each debounced save the list is re-fetched so users see
 * each other's contributions within ~seconds, without real-time wiring.
 */
(function () {
  "use strict";

  const __cb = window.__cb;
  const MAX_STACKED_AVATARS = 3;

  let widgetEl = null;
  let stackEl = null;
  let countEl = null;
  let dropdownEl = null;
  let contributors = [];
  let isOpen = false;
  let currentWorkbookId = null;
  let docListenerAttached = false;

  function firstInitial(name) {
    return (name || "?").trim().charAt(0).toUpperCase();
  }

  /**
   * Builds an avatar element. Uses a photo when available, otherwise shows
   * a colored circle with the user's first initial.
   */
  function buildAvatar(name, profilePicture, options = {}) {
    const avatar = document.createElement("div");
    avatar.className = "cb-collab-avatar";
    if (options.size === "lg") avatar.classList.add("cb-collab-avatar-lg");
    if (profilePicture) {
      avatar.style.backgroundImage = `url("${profilePicture}")`;
    } else {
      avatar.textContent = firstInitial(name);
    }
    avatar.title = name || "";
    return avatar;
  }

  /** Queries Supabase for all contributors to the current workbook. */
  async function fetchContributors(workbookId) {
    const supa = window.__cbSupabase;
    if (!supa || !workbookId) return [];
    try {
      const rows = await supa.supabaseFetch("canvas_contributors", "GET", {
        query: {
          workbook_id: `eq.${workbookId}`,
          // users(...) embeds the related users row via the FK we added.
          select: "user_id,last_accessed_at,users(name,profile_picture)",
          order: "last_accessed_at.desc",
          limit: "50",
        },
      });
      return (rows || []).map(r => ({
        id: r.user_id,
        name: r.users?.name || r.user_id,
        profilePicture: r.users?.profile_picture || null,
        lastAccessedAt: r.last_accessed_at,
      }));
    } catch (err) {
      console.warn("[Clay Brainstorm] fetchContributors failed:", err);
      return [];
    }
  }

  function renderStack() {
    if (!stackEl) return;
    stackEl.innerHTML = "";
    const shown = contributors.slice(0, MAX_STACKED_AVATARS);
    for (const c of shown) {
      stackEl.appendChild(buildAvatar(c.name, c.profilePicture));
    }
    if (countEl) {
      countEl.textContent = String(contributors.length);
      countEl.style.display = contributors.length > 0 ? "" : "none";
    }
  }

  function renderDropdown() {
    if (!dropdownEl) return;
    dropdownEl.innerHTML = "";

    if (contributors.length === 0) {
      const empty = document.createElement("div");
      empty.className = "cb-collab-empty";
      empty.textContent = "No collaborators yet.";
      dropdownEl.appendChild(empty);
      return;
    }

    for (const c of contributors) {
      const row = document.createElement("div");
      row.className = "cb-collab-row";

      row.appendChild(buildAvatar(c.name, c.profilePicture, { size: "lg" }));

      const nameEl = document.createElement("span");
      nameEl.className = "cb-collab-row-name";
      nameEl.textContent = c.name;
      row.appendChild(nameEl);

      if (c.id === __cb.userId) {
        const youBadge = document.createElement("span");
        youBadge.className = "cb-collab-row-you";
        youBadge.textContent = "You";
        row.appendChild(youBadge);
      }

      dropdownEl.appendChild(row);
    }
  }

  function setOpen(open) {
    isOpen = open;
    if (!widgetEl) return;
    widgetEl.classList.toggle("cb-collab-open", open);
    if (open) renderDropdown();
  }

  function onDocumentClick(e) {
    if (!isOpen || !widgetEl) return;
    if (!widgetEl.contains(e.target)) setOpen(false);
  }

  function onKeyDown(e) {
    if (e.key === "Escape" && isOpen) setOpen(false);
  }

  function attachDocListeners() {
    if (docListenerAttached) return;
    document.addEventListener("mousedown", onDocumentClick);
    document.addEventListener("keydown", onKeyDown);
    docListenerAttached = true;
  }

  function detachDocListeners() {
    if (!docListenerAttached) return;
    document.removeEventListener("mousedown", onDocumentClick);
    document.removeEventListener("keydown", onKeyDown);
    docListenerAttached = false;
  }

  /**
   * Mount the widget into `parent`. Returns the element so callers can
   * remove it on teardown.
   */
  __cb.mountCollaboratorsWidget = function (parent) {
    if (!parent) return null;
    // Remove any previously-mounted instance (e.g. from a prior canvas open).
    if (widgetEl && widgetEl.parentNode) widgetEl.parentNode.removeChild(widgetEl);

    widgetEl = document.createElement("div");
    widgetEl.className = "cb-collab-widget";

    const header = document.createElement("button");
    header.className = "cb-collab-header";
    header.type = "button";
    header.title = "Collaborators";

    stackEl = document.createElement("div");
    stackEl.className = "cb-collab-stack";

    countEl = document.createElement("span");
    countEl.className = "cb-collab-count";

    header.appendChild(stackEl);
    header.appendChild(countEl);

    dropdownEl = document.createElement("div");
    dropdownEl.className = "cb-collab-dropdown";

    widgetEl.appendChild(header);
    widgetEl.appendChild(dropdownEl);

    header.addEventListener("click", (e) => {
      e.stopPropagation();
      setOpen(!isOpen);
    });

    parent.appendChild(widgetEl);
    attachDocListeners();
    renderStack();
    return widgetEl;
  };

  /**
   * Refresh the contributor list from Supabase. Safe to call repeatedly
   * (on canvas open, after save, on tab switch). Bails out if the widget
   * isn't mounted.
   */
  __cb.refreshCollaborators = async function (workbookId) {
    if (!widgetEl) return;
    currentWorkbookId = workbookId || null;
    contributors = await fetchContributors(currentWorkbookId);
    renderStack();
    if (isOpen) renderDropdown();
  };

  /** Tear down the widget (called when the canvas overlay closes). */
  __cb.unmountCollaboratorsWidget = function () {
    detachDocListeners();
    if (widgetEl && widgetEl.parentNode) widgetEl.parentNode.removeChild(widgetEl);
    widgetEl = null;
    stackEl = null;
    countEl = null;
    dropdownEl = null;
    contributors = [];
    isOpen = false;
    currentWorkbookId = null;
  };
})();
