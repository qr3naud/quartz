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

  // Entrance-animation state. IMPORTANT: module-level and deliberately NOT reset
  // on mount(), because the widget is a singleton that gets re-mounted
  // constantly — the table view rebuilds its header (and re-mounts us) on every
  // render/save. Keying the reveal to the workbook means the shimmer -> avatars
  // entrance plays exactly once per canvas, and never again on saves, view
  // toggles, or presence ticks. (Mirrors the viewToggleSeen guard in
  // table-view.js.) Only a full teardown (overlay close) resets it.
  let revealedWorkbookId = null; // workbook whose entrance has already played
  let presenceSynced = false;    // first presence sync seen for this workbook
  let dataReady = false;         // contributors fetched for this workbook
  let revealTimer = null;        // bounded wait for presence before revealing
  let revealOnce = false;        // transient: tags the single reveal render
  // How long to keep the shimmer waiting for the first presence sync so the
  // indigo ring is part of the one entrance animation; reveal anyway after.
  const REVEAL_PRESENCE_WAIT_MS = 1200;

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

  function isRevealed() {
    return !!currentWorkbookId && revealedWorkbookId === currentWorkbookId;
  }

  // Plays the single shimmer -> avatars entrance for the current workbook. The
  // scale-in lives on the container, so the avatars AND each active user's
  // indigo box-shadow ring grow in together (a transform on the parent scales
  // its children's shadows too) — one animation, ring included.
  function doReveal() {
    if (!widgetEl || isRevealed() || !dataReady) return;
    if (revealTimer) { clearTimeout(revealTimer); revealTimer = null; }
    revealedWorkbookId = currentWorkbookId;
    revealOnce = true;
    renderStack();
    revealOnce = false;
  }

  // Reveal once data is loaded, waiting briefly for the first presence sync so
  // the ring is part of the entrance; reveal anyway after REVEAL_PRESENCE_WAIT_MS
  // so the shimmer never hangs if presence is slow or absent.
  function tryReveal() {
    if (!widgetEl || isRevealed() || !dataReady) return;
    if (presenceSynced) { doReveal(); return; }
    if (!revealTimer) {
      revealTimer = setTimeout(() => {
        revealTimer = null;
        doReveal();
      }, REVEAL_PRESENCE_WAIT_MS);
    }
  }

  function buildSkeletons() {
    const wrap = document.createElement("div");
    wrap.className = "cb-collab-stack-inactive cb-collab-skeletons";
    for (let i = 0; i < 2; i++) {
      const ph = document.createElement("div");
      ph.className = "cb-collab-avatar cb-collab-avatar-skeleton";
      wrap.appendChild(ph);
    }
    return wrap;
  }

  function renderStack() {
    if (!stackEl) return;
    stackEl.innerHTML = "";
    // Tag the single entrance render so the container scales in (see doReveal).
    // Set ONLY on that one render and never stripped afterwards, so later
    // re-renders (presence ticks, saves) can't interrupt or replay it.
    if (revealOnce) {
      stackEl.classList.remove("cb-collab-reveal");
      void stackEl.offsetWidth; // reflow so the animation restarts cleanly
      stackEl.classList.add("cb-collab-reveal");
    }

    // Pre-reveal: shimmer until data + presence (or the timeout) are ready.
    if (!isRevealed()) {
      stackEl.appendChild(buildSkeletons());
      if (countEl) countEl.style.display = "none";
      return;
    }

    // Revealed but empty (brand-new canvas before the first save records
    // anyone): show our own avatar so the widget never sits as a blank pill.
    if (contributors.length === 0) {
      const self = selfContributor();
      if (self) {
        const wrap = document.createElement("div");
        wrap.className = "cb-collab-stack-inactive";
        const av = buildAvatar(self.name, self.profilePicture);
        if (self.id && activeUserIds.has(String(self.id))) {
          av.classList.add("cb-collab-avatar-active");
        }
        wrap.appendChild(av);
        stackEl.appendChild(wrap);
      }
      if (countEl) countEl.style.display = "none";
      return;
    }

    // Split so active users get the side-by-side + ring treatment, and inactive
    // users fall back to the classic overlapping stack. The ring is a static
    // box-shadow; on the entrance it scales in with the container, and any later
    // presence change just shows/hides it (no per-tick animation).
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
    // Render whatever we already have: the persisted entrance state means an
    // already-revealed workbook re-mounts straight to its avatars (no shimmer,
    // no replay), while a fresh one shows the shimmer until the entrance plays.
    renderStack();

    // Presence: subscribe to the realtime channel's presence stream so the
    // active/inactive split reflects who's currently viewing, and so the first
    // sync can trigger the ring-inclusive entrance. Drop any prior subscription
    // first — the widget re-mounts when toggling between the canvas float and
    // the table-view inline slot, and leaking handlers would pile up.
    if (unsubPresence) { unsubPresence(); unsubPresence = null; }
    if (__cb.realtime?.onPresenceSync) {
      unsubPresence = __cb.realtime.onPresenceSync((byUser) => {
        const next = new Set(Array.from(byUser.keys()).map(String));
        presenceSynced = true;
        // Presence syncs fire on every heartbeat; only treat it as a change when
        // the active set actually differs, so we don't re-render on idle ticks.
        const changed = !(next.size === activeUserIds.size && [...next].every(id => activeUserIds.has(id)));
        activeUserIds = next;
        if (!isRevealed()) {
          tryReveal(); // presence is here now -> reveal with the ring included
        } else if (changed) {
          renderStack(); // live presence change after the entrance -> silent
          if (isOpen) renderDropdown();
        }
      });
    }

    // Re-fetch the contributor list whenever the Supabase JWT lands or rotates
    // (cold start, a retried first mint, or signing into Clay later). Without
    // this the widget would sit blank until the next save / tab-switch.
    if (unsubJwt) { unsubJwt(); unsubJwt = null; }
    if (__cb.onSupabaseJwtChange) {
      unsubJwt = __cb.onSupabaseJwtChange(() => {
        const wb = currentWorkbookId || __cb.currentWorkbookId || __cb.parseIdsFromUrl?.()?.workbookId;
        if (wb) __cb.refreshCollaborators(wb);
      });
    }

    // Kick off the initial fetch so the entrance always resolves, even if the
    // caller doesn't immediately call refreshCollaborators.
    const initialWb = currentWorkbookId || __cb.currentWorkbookId || __cb.parseIdsFromUrl?.()?.workbookId || null;
    if (initialWb) __cb.refreshCollaborators(initialWb);

    return widgetEl;
  };

  /**
   * Refresh the contributor list from Supabase. Safe to call repeatedly
   * (on canvas open, after save, on tab switch). Bails out if the widget
   * isn't mounted.
   */
  __cb.refreshCollaborators = async function (workbookId) {
    if (!widgetEl) return;
    const wb = workbookId || currentWorkbookId || null;
    // Switching workbooks -> fresh entrance for the new canvas.
    if (wb && wb !== currentWorkbookId) {
      currentWorkbookId = wb;
      revealedWorkbookId = null;
      presenceSynced = false;
      dataReady = false;
      activeUserIds = new Set();
      if (revealTimer) { clearTimeout(revealTimer); revealTimer = null; }
    }
    if (!currentWorkbookId) {
      contributors = [];
      renderStack();
      return;
    }
    // Pre-reveal renders show the shimmer (driven by isRevealed); once revealed,
    // refreshes swap the content silently — no animation on saves.
    renderStack();
    contributors = await fetchContributors(currentWorkbookId);
    dataReady = true;
    if (isRevealed()) {
      renderStack();
    } else {
      tryReveal();
    }
    if (isOpen) renderDropdown();
  };

  /** Tear down the widget (called when the canvas overlay closes). */
  __cb.unmountCollaboratorsWidget = function () {
    detachDocListeners();
    if (unsubPresence) { unsubPresence(); unsubPresence = null; }
    if (unsubJwt) { unsubJwt(); unsubJwt = null; }
    if (revealTimer) { clearTimeout(revealTimer); revealTimer = null; }
    if (widgetEl && widgetEl.parentNode) widgetEl.parentNode.removeChild(widgetEl);
    widgetEl = null;
    stackEl = null;
    countEl = null;
    dropdownEl = null;
    contributors = [];
    isOpen = false;
    currentWorkbookId = null;
    activeUserIds = new Set();
    revealOnce = false;
    // Full teardown (overlay close) resets the entrance so reopening the canvas
    // plays it again. NOTE: the frequent table-view re-mount path goes through
    // mount() only (not here), so saves never reset this.
    revealedWorkbookId = null;
    presenceSynced = false;
    dataReady = false;
  };
})();
