/**
 * Collaborators widget shown in the top-right corner of the scoping canvas.
 * Surfaces who has touched the canvas (historical) AND who is currently
 * viewing it (live).
 *
 * Data sources:
 *   - Historical contributor list: `canvas_contributors` table, fetched via
 *     refreshCollaborators() on canvas open and after saves.
 *   - Live presence (active users): Supabase Realtime Presence, delivered
 *     via __cb.realtime.onPresenceSync. Active users get the side-by-side
 *     green-ring treatment; inactive users stack in the classic overlap.
 *
 * UI:
 *   - Compact header with up to 3 avatars + a count badge.
 *   - Click header -> dropdown listing every contributor.
 *   - Click outside or press Escape -> closes the dropdown.
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

  // Set of user ids that Supabase Realtime Presence reports as currently
  // viewing the channel. Drives the "side-by-side + green ring" rendering.
  // Populated by the onPresenceSync subscription set up in mount().
  let activeUserIds = new Set();
  let unsubPresence = null;
  // Re-fetch when the Supabase JWT lands/rotates so the widget never sits blank
  // through a cold start (see mount()).
  let unsubJwt = null;
  // True while the very first contributor fetch is in flight (drives the
  // shimmer). revealOnce gives a one-shot fade when real avatars first paint.
  let loading = false;
  let revealOnce = false;

  function isActive(c) {
    if (!c?.id) return false;
    return activeUserIds.has(String(c.id));
  }

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

  /** The current (acting) user as a contributor-shaped object, for the empty
   *  state. Uses the name/avatar exposed by user.js (falls back to the email
   *  initial if those haven't resolved yet) — still better than a blank pill. */
  function selfContributor() {
    const id = __cb.userId || null;
    const name = __cb.userName || __cb.userEmail || (id ? String(id) : null);
    if (!id && !name) return null;
    return { id, name: name || "You", profilePicture: __cb.userProfilePicture || null };
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
      console.warn("[Clay Scoping] fetchContributors failed:", err);
      return [];
    }
  }

  function renderStack() {
    if (!stackEl) return;
    stackEl.innerHTML = "";
    // One-shot entrance when real avatars first replace the shimmer. Apply it
    // ONLY on the reveal render and never strip it on later re-renders (presence
    // ticks rebuild the children every few seconds) — stripping it mid-flight is
    // what made the avatar snap. Remove + reflow + re-add so a later cold reload
    // can animate again cleanly. The animation lives on the container, so
    // swapping children underneath it doesn't interrupt it.
    if (revealOnce) {
      stackEl.classList.remove("cb-collab-reveal");
      void stackEl.offsetWidth; // force reflow to restart the animation
      stackEl.classList.add("cb-collab-reveal");
    }

    // First-load shimmer: placeholder avatars while the initial fetch is in
    // flight. Only when we have nothing yet — a refresh over existing avatars
    // (e.g. after a save) must not flash.
    if (loading && contributors.length === 0) {
      const wrap = document.createElement("div");
      wrap.className = "cb-collab-stack-inactive cb-collab-skeletons";
      for (let i = 0; i < 2; i++) {
        const ph = document.createElement("div");
        ph.className = "cb-collab-avatar cb-collab-avatar-skeleton";
        wrap.appendChild(ph);
      }
      stackEl.appendChild(wrap);
      if (countEl) countEl.style.display = "none";
      return;
    }

    // Loaded but empty (brand-new canvas before the first save records anyone):
    // show our own avatar so the widget never sits as a blank pill.
    if (contributors.length === 0) {
      const self = selfContributor();
      if (self) {
        const wrap = document.createElement("div");
        wrap.className = "cb-collab-stack-inactive";
        wrap.appendChild(buildAvatar(self.name, self.profilePicture));
        stackEl.appendChild(wrap);
      }
      if (countEl) countEl.style.display = "none";
      return;
    }

    // Split so active users get the side-by-side + ring treatment, and
    // inactive users fall back to the classic overlapping stack.
    const active = contributors.filter(isActive);
    const inactive = contributors.filter(c => !isActive(c));

    if (active.length > 0) {
      const activeWrap = document.createElement("div");
      activeWrap.className = "cb-collab-stack-active";
      for (const c of active.slice(0, MAX_STACKED_AVATARS)) {
        const av = buildAvatar(c.name, c.profilePicture);
        av.classList.add("cb-collab-avatar-active");
        activeWrap.appendChild(av);
      }
      stackEl.appendChild(activeWrap);
    }

    // Inactive avatars fill any remaining slots (so the compact header never
    // exceeds MAX_STACKED_AVATARS total).
    const remaining = Math.max(0, MAX_STACKED_AVATARS - active.length);
    if (inactive.length > 0 && remaining > 0) {
      const inactiveWrap = document.createElement("div");
      inactiveWrap.className = "cb-collab-stack-inactive";
      for (const c of inactive.slice(0, remaining)) {
        inactiveWrap.appendChild(buildAvatar(c.name, c.profilePicture));
      }
      stackEl.appendChild(inactiveWrap);
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
      if (isActive(c)) row.classList.add("cb-collab-row-active");

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
  __cb.mountCollaboratorsWidget = function (parent, options = {}) {
    if (!parent) return null;
    // Remove any previously-mounted instance (e.g. from a prior canvas open, or
    // when moving between the canvas float and the table view's inline slot).
    if (widgetEl && widgetEl.parentNode) widgetEl.parentNode.removeChild(widgetEl);

    widgetEl = document.createElement("div");
    widgetEl.className = "cb-collab-widget";
    // Inline mode: sits in normal flow inside a toolbar row (table view header)
    // instead of floating absolutely in the canvas top-right. CSS keys off the
    // modifier class to drop the absolute positioning + float shadow and shrink
    // the pill to the row height.
    if (options.inline) widgetEl.classList.add("cb-collab-widget-inline");

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
    // Re-mounts start with no contributors, so show the shimmer until the first
    // fetch (kicked off below) resolves.
    loading = contributors.length === 0;
    renderStack();

    // Presence: subscribe to the realtime channel's presence stream so the
    // active/inactive split reflects who's currently viewing, in real time.
    // The contributors list itself still comes from the historical
    // canvas_contributors table via refreshCollaborators(). Drop any prior
    // subscription first — the widget re-mounts when toggling between the
    // canvas float and the table-view inline slot, and leaking handlers would
    // pile up stale closures pointing at detached stack nodes.
    if (unsubPresence) { unsubPresence(); unsubPresence = null; }
    if (__cb.realtime?.onPresenceSync) {
      unsubPresence = __cb.realtime.onPresenceSync((byUser) => {
        activeUserIds = new Set(Array.from(byUser.keys()).map(String));
        renderStack();
        if (isOpen) renderDropdown();
      });
    }

    // Re-fetch the contributor list whenever the Supabase JWT lands or rotates
    // (cold start, a retried first mint, or signing into Clay later). Without
    // this the widget would sit on whatever it fetched before auth was ready —
    // typically empty — until the next save / tab-switch.
    if (unsubJwt) { unsubJwt(); unsubJwt = null; }
    if (__cb.onSupabaseJwtChange) {
      unsubJwt = __cb.onSupabaseJwtChange(() => {
        const wb = currentWorkbookId || __cb.currentWorkbookId || __cb.parseIdsFromUrl?.()?.workbookId;
        if (wb) __cb.refreshCollaborators(wb);
      });
    }

    // Kick off the initial fetch so the shimmer always resolves, even if the
    // caller doesn't immediately call refreshCollaborators.
    const initialWb = currentWorkbookId || __cb.currentWorkbookId || __cb.parseIdsFromUrl?.()?.workbookId || null;
    if (initialWb) {
      __cb.refreshCollaborators(initialWb);
    } else {
      loading = false;
      renderStack();
    }

    return widgetEl;
  };

  /**
   * Refresh the contributor list from Supabase. Safe to call repeatedly
   * (on canvas open, after save, on tab switch). Bails out if the widget
   * isn't mounted.
   */
  __cb.refreshCollaborators = async function (workbookId) {
    if (!widgetEl) return;
    // Don't wipe a known workbook id if called with nothing (e.g. a JWT-change
    // ping before the URL is parsed).
    currentWorkbookId = workbookId || currentWorkbookId || null;
    if (!currentWorkbookId) {
      loading = false;
      contributors = [];
      renderStack();
      return;
    }
    loading = true;
    renderStack(); // shimmer (only paints when we have nothing yet)
    contributors = await fetchContributors(currentWorkbookId);
    loading = false;
    revealOnce = true; // one-shot fade as real avatars first paint
    renderStack();
    revealOnce = false;
    if (isOpen) renderDropdown();
  };

  /** Tear down the widget (called when the canvas overlay closes). */
  __cb.unmountCollaboratorsWidget = function () {
    detachDocListeners();
    if (unsubPresence) { unsubPresence(); unsubPresence = null; }
    if (unsubJwt) { unsubJwt(); unsubJwt = null; }
    if (widgetEl && widgetEl.parentNode) widgetEl.parentNode.removeChild(widgetEl);
    widgetEl = null;
    stackEl = null;
    countEl = null;
    dropdownEl = null;
    contributors = [];
    isOpen = false;
    currentWorkbookId = null;
    activeUserIds = new Set();
    loading = false;
    revealOnce = false;
  };
})();
