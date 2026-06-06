(function () {
  "use strict";

  const __cb = window.__cb;

  __cb.updateGroupButtonVisibility = function () {};

  // Cache whether the current user is the Quartz maintainer so the service
  // worker can scope update checks (admin -> origin/main HEAD; everyone else ->
  // the published version). Pure-UI gate; refreshed whenever the JWT lands or
  // rotates. Sources the signed `is_admin` claim (set on __cb.isAdmin in
  // src/auth.js from the ADMIN_EMAILS secret) — same flag the Admin menu uses.
  function syncQuartzAdminFlag() {
    try {
      chrome.storage.local.set({ quartzIsAdmin: !!__cb.isAdmin });
    } catch {}
  }
  syncQuartzAdminFlag();
  if (__cb.onSupabaseJwtChange) __cb.onSupabaseJwtChange(syncQuartzAdminFlag);

  // Pie-slice icon — visually communicates "fraction of the whole filled".
  // Hoisted to module scope so the overflow menu (__cb.openMoreMenu) can
  // reuse the same glyph that used to ride on the standalone Pro Mode
  // toolbar button.
  const PRO_ICON_SVG =
    '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 256 256" fill="currentColor">' +
    '<path d="M128 24a104 104 0 1 0 104 104A104 104 0 0 0 128 24Zm0 16a88 88 0 0 1 86.5 72H128Z"/>' +
    '</svg>';

  // Balance-scale icon — "weighing two sides", matches the Old vs New
  // Pricing comparison modal's intent. Same shape that used to live on
  // the standalone pricing toolbar button.
  const PRICING_ICON_SVG =
    '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" fill="none" stroke="currentColor" ' +
    'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24">' +
    '<path d="M12 3v18"/><path d="M5 8h14"/>' +
    '<path d="M5 8l-3 7a4 4 0 0 0 6 0L5 8z"/>' +
    '<path d="M19 8l-3 7a4 4 0 0 0 6 0L19 8z"/></svg>';

  // Magnifying-glass-over-list glyph for the Import Inspector row — reads as
  // "inspect what the import pulls in".
  const INSPECT_ICON_SVG =
    '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" ' +
    'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" ' +
    'stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M3 5h10"/><path d="M3 10h7"/><path d="M3 15h5"/>' +
    '<circle cx="16" cy="15" r="4"/><path d="m22 21-2.8-2.8"/></svg>';

  // Kebab/overflow icon for the topbar "more" button. Three vertical dots
  // is the conventional affordance for "secondary options live here".
  const MORE_ICON_SVG =
    '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" ' +
    'fill="currentColor" aria-hidden="true">' +
    '<circle cx="12" cy="5"  r="1.6"/>' +
    '<circle cx="12" cy="12" r="1.6"/>' +
    '<circle cx="12" cy="19" r="1.6"/></svg>';

  // Cloud-upload glyph for the "Upload POC" row — mirrors the icon the
  // button carried when it lived in the table-view header (uploadSvg in
  // src/table-view.js) so the relocated action reads the same.
  const UPLOAD_ICON_SVG =
    '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" ' +
    'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" ' +
    'stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>' +
    '<polyline points="17 8 12 3 7 8"/>' +
    '<line x1="12" y1="3" x2="12" y2="15"/>' +
    '</svg>';

  // Arrow-right-left swap glyph for the Canvas / Tables view row. Reads
  // as "swap between views" in both directions so the same icon works
  // regardless of which view is currently active.
  const SWAP_VIEW_ICON_SVG =
    '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" ' +
    'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" ' +
    'stroke-linejoin="round" aria-hidden="true">' +
    '<path d="m16 3 4 4-4 4"/>' +
    '<path d="M20 7H4"/>' +
    '<path d="m8 21-4-4 4-4"/>' +
    '<path d="M4 17h16"/>' +
    '</svg>';

  // Circular-arrows "refresh" glyph for the Update row — reads as "pull the
  // latest version". Same visual family as the other menu icons.
  const UPDATE_ICON_SVG =
    '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" ' +
    'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" ' +
    'stroke-linejoin="round" aria-hidden="true">' +
    '<polyline points="23 4 23 10 17 10"/>' +
    '<polyline points="1 20 1 14 7 14"/>' +
    '<path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>' +
    '</svg>';

  // Chevron-left glyph for the "Archived" row — its submenu opens to the left.
  const CHEVRON_LEFT_ICON_SVG =
    '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" ' +
    'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" ' +
    'stroke-linejoin="round" aria-hidden="true"><polyline points="15 18 9 12 15 6"/></svg>';

  // Paper-plane "send" glyph for the Request POC row — reads as "send a request".
  const REQUEST_POC_ICON_SVG =
    '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" ' +
    'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" ' +
    'stroke-linejoin="round" aria-hidden="true">' +
    '<line x1="22" y1="2" x2="11" y2="13"/>' +
    '<polygon points="22 2 15 22 11 13 2 9 22 2"/>' +
    '</svg>';

  // Gear glyph for the maintainer-only Admin (settings) row.
  const ADMIN_ICON_SVG =
    '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" ' +
    'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" ' +
    'stroke-linejoin="round" aria-hidden="true">' +
    '<circle cx="12" cy="12" r="3"/>' +
    '<path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>' +
    '</svg>';

  let moreMenuEl = null;
  let moreMenuBackdrop = null;
  let moreSubmenuEl = null;

  function closeMoreMenu() {
    if (moreMenuEl) { moreMenuEl.remove(); moreMenuEl = null; }
    if (moreMenuBackdrop) { moreMenuBackdrop.remove(); moreMenuBackdrop = null; }
    if (moreSubmenuEl) { moreSubmenuEl.remove(); moreSubmenuEl = null; }
  }

  __cb.closeMoreMenu = closeMoreMenu;

  // Overflow menu that collapses Pro Mode + Old vs New Pricing under a
  // single kebab button. Mirrors the backdrop + right-aligned anchor
  // pattern openExportMenu in src/export.js uses, so the two topbar
  // dropdowns feel identical to operate.
  __cb.openMoreMenu = function openMoreMenu(anchorEl) {
    closeMoreMenu();

    moreMenuBackdrop = document.createElement("div");
    moreMenuBackdrop.style.cssText = "position:fixed;inset:0;z-index:9999998;";
    moreMenuBackdrop.addEventListener("mousedown", (evt) => {
      evt.stopPropagation();
      closeMoreMenu();
    });

    moreMenuEl = document.createElement("div");
    moreMenuEl.className = "cb-export-menu cb-more-menu";
    moreMenuEl.addEventListener("mousedown", (evt) => evt.stopPropagation());

    // Update — leads the menu. Opens the center modal (src/update-modal.js)
    // with the version timeline + an "Update now" action. The state pill is
    // seeded from the cached status, then refreshed live so it never disagrees
    // with the popup / toolbar cue.
    const updateItem = document.createElement("button");
    updateItem.type = "button";
    updateItem.className = "cb-export-menu-option cb-more-menu-option";
    updateItem.title = "See what's new and update the extension";
    updateItem.innerHTML =
      `<span class="cb-more-menu-icon">${UPDATE_ICON_SVG}</span>` +
      `<span class="cb-more-menu-label">Update</span>` +
      `<span class="cb-more-menu-state cb-update-state"></span>`;
    const updateStateEl = updateItem.querySelector(".cb-update-state");
    const renderUpdateState = (behind, latestVersion) => {
      if (behind) {
        // Amber pill via .cb-more-menu-option-active .cb-more-menu-state.
        updateItem.classList.add("cb-more-menu-option-active");
        updateStateEl.classList.remove("cb-update-state-ok");
        updateStateEl.textContent = latestVersion ? `v${latestVersion}` : "Available";
      } else {
        updateItem.classList.remove("cb-more-menu-option-active");
        updateStateEl.classList.add("cb-update-state-ok");
        updateStateEl.textContent = "Up to date";
      }
    };
    try {
      chrome.storage.local.get("quartzUpdateInfo", (r) => {
        const info = r && r.quartzUpdateInfo;
        if (info) renderUpdateState(!!info.behind, info.latestVersion);
        // Same behind-gate as the view-open check: once we're behind, keep the
        // cached pill and skip the fetch — only the Update modal re-checks then.
        if (info && info.behind) return;
        chrome.runtime.sendMessage({ type: "cb:update:status" }, (res) => {
          if (chrome.runtime.lastError || !res || !res.ok) return; // leave seeded state
          renderUpdateState((res.behind || 0) > 0, res.latestVersion);
          if (__cb.refreshMoreDot) __cb.refreshMoreDot();
        });
      });
    } catch {}
    updateItem.addEventListener("click", (evt) => {
      evt.stopPropagation();
      closeMoreMenu();
      if (__cb.openUpdateModal) __cb.openUpdateModal();
    });
    moreMenuEl.appendChild(updateItem);

    // Upload POC — bulk-imports data points from a POC overview doc. Used to
    // live as a button in the table-view header; relocated here to keep that
    // header compact. A plain action row (icon + label, no state pill),
    // available to everyone. Opens the modal in src/poc-import.js.
    if (__cb.startPocImport) {
      const uploadItem = document.createElement("button");
      uploadItem.type = "button";
      uploadItem.className = "cb-export-menu-option cb-more-menu-option";
      uploadItem.title = "Import data points from a POC overview document";
      uploadItem.innerHTML =
        `<span class="cb-more-menu-icon">${UPLOAD_ICON_SVG}</span>` +
        `<span class="cb-more-menu-label">Upload POC</span>`;
      uploadItem.addEventListener("click", (evt) => {
        evt.stopPropagation();
        closeMoreMenu();
        __cb.startPocImport();
      });
      moreMenuEl.appendChild(uploadItem);
    }

    // Request POC moved out of this menu into the guided rail as a first-class
    // step (see the cb-toolbar-request-poc button + updateGuidedFlow in
    // __cb.openCanvas). REQUEST_POC_ICON_SVG is reused there.

    // Old vs New Pricing — maintainer only (the signed `is_admin` claim). The
    // comparison surface is still being iterated on, so it's gated to the admin
    // rather than the whole team. Non-admins simply don't see this row.
    if (__cb.isAdmin && __cb.startPricingComparison) {
      const pricingItem = document.createElement("button");
      pricingItem.type = "button";
      pricingItem.className = "cb-export-menu-option cb-more-menu-option";
      pricingItem.title = "Compare per-row credit cost on the legacy vs modern Clay pricing plans";
      pricingItem.innerHTML =
        `<span class="cb-more-menu-icon">${PRICING_ICON_SVG}</span>` +
        `<span class="cb-more-menu-label">Old vs New Pricing</span>`;
      pricingItem.addEventListener("click", (evt) => {
        evt.stopPropagation();
        closeMoreMenu();
        __cb.startPricingComparison(anchorEl);
      });
      moreMenuEl.appendChild(pricingItem);
    }

    // Import Inspector (formerly "Export as JSON" in the Export menu) — a
    // read-only debugger for the import flow: the ordered API calls plus the
    // per-field projected/actual breakdown. Clay team only (any internal member).
    if (__cb.isInternal && __cb.openExportJsonModal) {
      const inspectItem = document.createElement("button");
      inspectItem.type = "button";
      inspectItem.className = "cb-export-menu-option cb-more-menu-option";
      inspectItem.title = "Inspect the import flow: API calls + per-field credits, coverage, fill, and actual spend";
      inspectItem.innerHTML =
        `<span class="cb-more-menu-icon">${INSPECT_ICON_SVG}</span>` +
        `<span class="cb-more-menu-label">Import Inspector</span>`;
      inspectItem.addEventListener("click", (evt) => {
        evt.stopPropagation();
        closeMoreMenu();
        __cb.openExportJsonModal();
      });
      moreMenuEl.appendChild(inspectItem);
    }

    // Archived — deprecated toggles (View + Pro Mode), kept available only to
    // the maintainer. Hovering (or clicking) the row opens a flyout submenu to
    // the left. The chevron-left icon hints at the open direction. Gated on the
    // signed `is_admin` claim (src/auth.js), not a client-side email compare.
    const isArchiveAdmin = !!__cb.isAdmin;
    if (isArchiveAdmin) {
      // Admin — maintainer-only settings. Edits public.app_settings in Supabase
      // (e.g. the POC request Slack channel) so operational config lives in the
      // DB, not code or secrets. Opens the modal in src/admin-settings.js.
      if (__cb.openAdminSettings) {
        const adminItem = document.createElement("button");
        adminItem.type = "button";
        adminItem.className = "cb-export-menu-option cb-more-menu-option";
        adminItem.title = "Edit Quartz operational settings";
        adminItem.innerHTML =
          `<span class="cb-more-menu-icon">${ADMIN_ICON_SVG}</span>` +
          `<span class="cb-more-menu-label">Admin</span>`;
        adminItem.addEventListener("click", (evt) => {
          evt.stopPropagation();
          closeMoreMenu();
          __cb.openAdminSettings();
        });
        moreMenuEl.appendChild(adminItem);
      }

      // View (Canvas / Tables) toggle. Canvas is allow-listed; otherwise the
      // row is locked to Tables.
      const canUseCanvas = __cb.canUseCanvasView?.() ?? false;
      const inTable = __cb.brainstormView === "table";
      const currentViewLabel = inTable ? "Tables" : "Canvas";
      const otherViewLabel = inTable ? "Canvas" : "Tables";
      const viewItem = document.createElement("button");
      viewItem.type = "button";
      if (canUseCanvas) {
        viewItem.className = "cb-export-menu-option cb-more-menu-option";
        viewItem.title = `Switch to the ${otherViewLabel.toLowerCase()} view`;
        viewItem.innerHTML =
          `<span class="cb-more-menu-icon">${SWAP_VIEW_ICON_SVG}</span>` +
          `<span class="cb-more-menu-label">View</span>` +
          `<span class="cb-more-menu-state">${currentViewLabel}</span>`;
        viewItem.addEventListener("click", (evt) => {
          evt.stopPropagation();
          closeMoreMenu();
          if (__cb.setBrainstormView) __cb.setBrainstormView(inTable ? "canvas" : "table");
        });
      } else {
        viewItem.className =
          "cb-export-menu-option cb-more-menu-option cb-more-menu-option-disabled";
        viewItem.disabled = true;
        viewItem.title = "Canvas view is being rebuilt — table view only";
        viewItem.innerHTML =
          `<span class="cb-more-menu-icon">${SWAP_VIEW_ICON_SVG}</span>` +
          `<span class="cb-more-menu-label">View</span>` +
          `<span class="cb-more-menu-state">Tables</span>`;
      }

      // Pro Mode toggle.
      const proActive = !!__cb.proMode;
      const proItem = document.createElement("button");
      proItem.type = "button";
      proItem.className =
        "cb-export-menu-option cb-more-menu-option" +
        (proActive ? " cb-more-menu-option-active" : "");
      proItem.title = "Show fill rates on data point cards";
      proItem.innerHTML =
        `<span class="cb-more-menu-icon">${PRO_ICON_SVG}</span>` +
        `<span class="cb-more-menu-label">Pro Mode</span>` +
        `<span class="cb-more-menu-state">${proActive ? "On" : "Off"}</span>`;
      proItem.addEventListener("click", (evt) => {
        evt.stopPropagation();
        closeMoreMenu();
        if (__cb.setProMode) __cb.setProMode(!__cb.proMode);
      });

      // The Archived row + its left-opening flyout submenu.
      const archivedItem = document.createElement("button");
      archivedItem.type = "button";
      archivedItem.className = "cb-export-menu-option cb-more-menu-option cb-more-menu-has-submenu";
      archivedItem.title = "Archived tools";
      archivedItem.innerHTML =
        `<span class="cb-more-menu-icon">${CHEVRON_LEFT_ICON_SVG}</span>` +
        `<span class="cb-more-menu-label">Archived</span>`;

      const submenu = document.createElement("div");
      submenu.className = "cb-export-menu cb-more-menu cb-more-submenu";
      submenu.style.display = "none";
      submenu.addEventListener("mousedown", (evt) => evt.stopPropagation());
      submenu.appendChild(viewItem);
      submenu.appendChild(proItem);

      let submenuHideTimer = null;
      const positionSubmenu = () => {
        const r = archivedItem.getBoundingClientRect();
        submenu.style.position = "fixed";
        submenu.style.top = r.top + "px";
        // Open to the LEFT: pin the submenu's right edge just left of the row.
        submenu.style.right = Math.max(8, window.innerWidth - r.left + 6) + "px";
        submenu.style.zIndex = "9999999";
      };
      const showSubmenu = () => {
        clearTimeout(submenuHideTimer);
        positionSubmenu();
        submenu.style.display = "block";
        archivedItem.classList.add("cb-more-menu-option-active");
      };
      const hideSubmenu = () => {
        submenuHideTimer = setTimeout(() => {
          submenu.style.display = "none";
          archivedItem.classList.remove("cb-more-menu-option-active");
        }, 160);
      };
      archivedItem.addEventListener("mouseenter", showSubmenu);
      archivedItem.addEventListener("mouseleave", hideSubmenu);
      archivedItem.addEventListener("click", (evt) => {
        evt.stopPropagation();
        if (submenu.style.display === "none") showSubmenu();
        else hideSubmenu();
      });
      submenu.addEventListener("mouseenter", () => clearTimeout(submenuHideTimer));
      submenu.addEventListener("mouseleave", hideSubmenu);

      moreMenuEl.appendChild(archivedItem);
      moreSubmenuEl = submenu;
      document.body.appendChild(submenu);
    }

    document.body.appendChild(moreMenuBackdrop);
    document.body.appendChild(moreMenuEl);

    // Same anchor math openExportMenu uses — fix the menu's right edge
    // to the trigger's right edge so dropdowns near the toolbar's right
    // side don't push off-screen.
    const rect = anchorEl.getBoundingClientRect();
    moreMenuEl.style.position = "fixed";
    moreMenuEl.style.top = (rect.bottom + 6) + "px";
    moreMenuEl.style.right = Math.max(8, window.innerWidth - rect.right) + "px";
    moreMenuEl.style.zIndex = "9999999";
  };

  // --- Overlay positioning (pin below Clay's top nav) ------------------------

  // Clay's header/nav. Same selector chain used by the float launcher.
  function findClayHeader() {
    return (
      document.querySelector("#clay-app header") ??
      document.querySelector("#clay-app nav") ??
      document.querySelector("#clay-app > div > div:first-child")
    );
  }

  // Pins the overlay's top edge to the bottom of Clay's top nav so the native
  // breadcrumb/header stays visible above us. Returns true once it has a real
  // measurement to apply. Crucially it returns false when the header isn't
  // mounted OR is mounted but not yet laid out (bottom === 0): on a hard
  // refresh the sticky-open flag fires openCanvas before Clay's SPA renders,
  // and applying a 0 top would leave the overlay full-page (its CSS default).
  function positionOverlayBelowHeader() {
    if (!__cb.overlayEl) return false;
    const clayHeader = findClayHeader();
    if (!clayHeader) return false;
    const bottom = clayHeader.getBoundingClientRect().bottom;
    if (bottom <= 0) return false;
    __cb.overlayEl.style.top = bottom + "px";
    return true;
  }

  let overlayPosObserver = null;
  let overlayPosTimer = null;
  function stopOverlayPositionWatch() {
    if (overlayPosObserver) { overlayPosObserver.disconnect(); overlayPosObserver = null; }
    if (overlayPosTimer) { clearInterval(overlayPosTimer); overlayPosTimer = null; }
  }

  // Retries positioning until Clay's header has mounted and laid out. Covers
  // the refresh race where openCanvas runs before the SPA paints. Watches DOM
  // mutations (header mounting) and polls (header present but pre-layout).
  // Once positioned, the DOM observer disconnects but the poll keeps re-pinning
  // for the rest of the window so a late layout shift (impersonation banner,
  // web-font reflow) doesn't leave us mispinned. Self-terminates on overlay
  // close or after ~6s.
  function watchOverlayPosition() {
    stopOverlayPositionWatch();
    let attempts = 0;
    const MAX_ATTEMPTS = 60; // ~6s at 100ms
    const attempt = () => {
      if (!__cb.overlayEl) { stopOverlayPositionWatch(); return; }
      if (positionOverlayBelowHeader() && overlayPosObserver) {
        overlayPosObserver.disconnect();
        overlayPosObserver = null;
      }
      if (++attempts >= MAX_ATTEMPTS) stopOverlayPositionWatch();
    };
    overlayPosObserver = new MutationObserver(attempt);
    overlayPosObserver.observe(document.body, { childList: true, subtree: true });
    overlayPosTimer = setInterval(attempt, 100);
  }

  // Keep the overlay pinned when the header's height changes (window resize,
  // or Clay's impersonation banner toggling — common for GTME/SE users).
  function onOverlayReposition() {
    if (!__cb.overlayEl) return;
    positionOverlayBelowHeader();
  }

  __cb.openCanvas = async function (initialCards) {
    if (__cb.overlayEl) return;

    // Wait for the Supabase JWT to land so __cb.userFeatures is populated
    // before we build the toolbar — otherwise the first canvas open on a
    // fresh install (no cached JWT) would skip every internal-only button.
    // On warm loads this is synchronous (cached JWT adopted at script
    // load). Callers fire-and-forget, so making this async is safe.
    if (__cb.supabaseJwtReady) {
      try { await __cb.supabaseJwtReady; } catch {}
    }

    if (!__cb.tabStore) {
      const tabId = __cb.generateTabId();
      __cb.tabStore = {
        activeId: tabId,
        tabs: [{ id: tabId, name: "Scoping", hidden: false, state: null }],
      };
    }

    const ids = __cb.parseIdsFromUrl();
    if (ids) {
      localStorage.setItem(`cb-open-${ids.workbookId}`, "1");
      __cb.currentWorkbookId = ids.workbookId;
      __cb.currentWorkspaceId = ids.workspaceId;
    }

    __cb.overlayEl = document.createElement("div");
    __cb.overlayEl.className = "cb-overlay";

    // Pin below Clay's top nav. If the header isn't mounted/laid out yet (hard
    // refresh + sticky-open fires before the SPA paints), keep retrying until
    // it is — otherwise the overlay keeps its CSS default (top:0) and covers
    // the whole page instead of sitting under the native Clay header.
    if (!positionOverlayBelowHeader()) {
      watchOverlayPosition();
    }
    window.addEventListener("resize", onOverlayReposition);

    const topBar = document.createElement("div");
    topBar.className = "cb-topbar";

    const leftGroup = document.createElement("div");
    leftGroup.className = "cb-topbar-left";

    __cb.buildTabBar(leftGroup);

    const rightGroup = document.createElement("div");
    // cb-topbar-guided turns the action cluster into the collapse-to-icon
    // guided rail (see styles/overlay.css + updateGuidedFlow below).
    rightGroup.className = "cb-topbar-right cb-topbar-guided";

    // Export button replaces the old "+ Add More" entry point. Click opens a
    // dropdown of export options the rep can run on the current scope. The
    // chevron is part of the button so it visually communicates "menu opens
    // here" the same way the model chip and frequency trigger do elsewhere.
    const exportBtn = document.createElement("button");
    exportBtn.className = "cb-toolbar-btn cb-toolbar-btn-primary cb-toolbar-export";
    exportBtn.type = "button";
    exportBtn.innerHTML =
      '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>' +
      '<span class="cb-toolbar-label">Export</span>';
    exportBtn.addEventListener("click", (evt) => {
      evt.stopPropagation();
      if (__cb.openExportMenu) __cb.openExportMenu(exportBtn);
    });

    const closeBtn = document.createElement("button");
    closeBtn.className = "cb-toolbar-btn cb-toolbar-close";
    closeBtn.type = "button";
    closeBtn.title = "Close";
    closeBtn.setAttribute("aria-label", "Close");
    // X glyph + collapsible label so Close reads as an icon in the guided rail
    // and reveals "Close" on hover like the other buttons.
    closeBtn.innerHTML =
      '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>' +
      '<span class="cb-toolbar-label">Close</span>';
    closeBtn.addEventListener("click", __cb.closeCanvas);

    // Generate POC is constructed below inside its feature-flag block so
    // non-internal users don't allocate an unused DOM node. Declared
    // here as null and reassigned only when the feature is enabled.
    // Pro Mode + Old vs New Pricing used to live in this stretch as
    // standalone buttons; both now live inside the overflow menu the
    // kebab "more" button surfaces — see __cb.openMoreMenu above.
    // Guided-flow state shared across the action buttons built below. Declared
    // up here (before any path that can call updateGuidedFlow, e.g. the dust
    // hydrate) so the controller closes over them without a TDZ hazard.
    let dustBtn = null;
    let requestBtn = null;
    let sfdcWrap = null;
    let requestPocDone = false;
    if (__cb.hasFeature?.("dust")) {
      // Generate POC — opens a small popover with a customer-name input and
      // POSTs to Dust to create a new conversation mentioning the POC agent.
      dustBtn = document.createElement("button");
      dustBtn.className = "cb-toolbar-btn cb-toolbar-dust-poc";
      dustBtn.type = "button";
      dustBtn.title = "Generate a POC scope in Dust for a customer";
      // Two icons live in the button: the document glyph (default) and a
      // check (shown in the "done" state). CSS shows exactly one based on
      // the state class; the loading state hides both and draws a spinner
      // via ::before. Label is wrapped in <span class="cb-toolbar-label"> so
      // the guided rail can collapse/expand it (matches Export / Import).
      dustBtn.innerHTML =
        '<svg class="cb-toolbar-dust-poc-doc" xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><line x1="10" y1="9" x2="8" y2="9"/></svg>' +
        '<svg class="cb-toolbar-dust-poc-check" xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>' +
        '<span class="cb-toolbar-label">Generate POC</span>';
      dustBtn.addEventListener("click", (evt) => {
        evt.stopPropagation();
        if (__cb.startDustPoc) __cb.startDustPoc(dustBtn);
      });

      // Lets src/dust-poc.js drive the button's visual state as a POC moves
      // through its lifecycle (incl. when auto-fired from an SFDC opportunity
      // link). CSS keys off the state classes:
      //   "loading" → spinner replaces the icon (cb-toolbar-dust-poc-loading)
      //   "done"    → check icon + linked-opportunity color treatment
      //               (cb-toolbar-dust-poc-done)
      //   "idle"    → default document icon, neutral toolbar styling
      // The button stays clickable in every state (we never set `disabled`)
      // so the rep can always open the popover to watch progress or grab the
      // finished doc link.
      __cb.setDustPocButtonState = function (state) {
        dustBtn.classList.toggle("cb-toolbar-dust-poc-loading", state === "loading");
        dustBtn.classList.toggle("cb-toolbar-dust-poc-done", state === "done");
        // The "done" class is the Generate POC step's done signal, so re-run
        // the guided controller after toggling it (hoisted; defined below).
        updateGuidedFlow();
      };
    }

    // Request POC — Clay team only (any internal member). A first-class step in
    // the guided rail (between Generate POC and Import), relocated from the
    // overflow menu. Opens the Request POC modal (src/request-poc.js), which
    // posts a one-way request to the POC Slack channel. Reuses the paper-plane
    // REQUEST_POC_ICON_SVG. Left null for non-internal users so the controller
    // simply skips it.
    if (__cb.isInternal && __cb.startRequestPoc) {
      requestBtn = document.createElement("button");
      requestBtn.className = "cb-toolbar-btn cb-toolbar-request-poc";
      requestBtn.type = "button";
      requestBtn.title = "Request a POC from the team (posts to Slack)";
      requestBtn.setAttribute("aria-label", "Request POC");
      requestBtn.innerHTML =
        REQUEST_POC_ICON_SVG + '<span class="cb-toolbar-label">Request POC</span>';
      requestBtn.addEventListener("click", (evt) => {
        evt.stopPropagation();
        __cb.startRequestPoc();
      });
    }

    const importBtn = document.createElement("button");
    importBtn.className = "cb-toolbar-btn cb-toolbar-import";
    importBtn.type = "button";
    importBtn.title = "Import a Clay table";
    importBtn.innerHTML =
      '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>' +
      '<span class="cb-toolbar-label">Import Clay Table</span>';
    importBtn.addEventListener("click", () => __cb.startImport(importBtn));

    // Amber "Pricing" button — enters the customer-facing multi-year pricing
    // view: the scope summary collapses into cost/savings cards, the
    // Projected/Actual toggle becomes a 1/2/3-year term toggle, and the table
    // collapses to per-use-case per-year volume editors. Internal-only (same
    // gate as Export-to-GTME); the bands + approval stay behind the in-view
    // "View Bands" control so the main view is safe to screen-share.
    let pricingBtn = null;
    if (__cb.hasFeature?.("gtme_export")) {
      pricingBtn = document.createElement("button");
      pricingBtn.className = "cb-toolbar-btn cb-toolbar-pricing";
      pricingBtn.type = "button";
      pricingBtn.title = "Multi-year pricing view";
      pricingBtn.innerHTML =
        '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>' +
        '<span class="cb-toolbar-label">Pricing</span>';
      pricingBtn.addEventListener("click", (evt) => {
        evt.stopPropagation();
        if (__cb.setPricingMode) __cb.setPricingMode(!__cb.pricingMode);
      });
    }

    // Overflow ("more") trigger — sits to the right of Export. Surfaces
    // the secondary toggles (Pro Mode + Old vs New Pricing) that used to
    // each occupy a topbar slot of their own. See __cb.openMoreMenu at
    // the top of this file for the menu contents and the feature gates.
    const moreBtn = document.createElement("button");
    moreBtn.className = "cb-toolbar-btn cb-toolbar-more";
    moreBtn.type = "button";
    moreBtn.title = "More options";
    moreBtn.setAttribute("aria-label", "More options");
    moreBtn.innerHTML = MORE_ICON_SVG;
    moreBtn.addEventListener("click", (evt) => {
      evt.stopPropagation();
      if (__cb.openMoreMenu) __cb.openMoreMenu(moreBtn);
    });

    // "Update available" dot — a secondary cue mirroring the toolbar-icon
    // badge so users notice the Update row without opening the menu. Toggled
    // from the status the service worker caches in chrome.storage; kept fresh
    // via a single storage.onChanged listener (re-pointed each canvas open).
    moreBtn.style.position = "relative";
    const moreDot = document.createElement("span");
    moreDot.className = "cb-toolbar-more-dot";
    moreDot.style.cssText =
      "position:absolute;top:3px;right:3px;width:7px;height:7px;border-radius:50%;" +
      "background:#F59E0B;box-shadow:0 0 0 1.5px rgba(255,255,255,0.9);display:none;";
    moreBtn.appendChild(moreDot);
    __cb.refreshMoreDot = function refreshMoreDot() {
      try {
        chrome.storage.local.get("quartzUpdateInfo", (r) => {
          moreDot.style.display = r && r.quartzUpdateInfo && r.quartzUpdateInfo.behind ? "block" : "none";
        });
      } catch {}
    };
    __cb.refreshMoreDot();
    // Recheck update status whenever the extension view opens (this runs inside
    // openCanvas) so the toolbar icon + menu dot reflect reality. Once we know
    // we're behind we stop auto-checking — the cue already shows, and only the
    // popup / Update modal refresh from there. The storage.onChanged listener
    // below repaints the dot once the SW writes a fresh result.
    try {
      chrome.storage.local.get("quartzUpdateInfo", (r) => {
        if (r && r.quartzUpdateInfo && r.quartzUpdateInfo.behind) return;
        chrome.runtime.sendMessage({ type: "cb:update:status" }, () => {
          void chrome.runtime.lastError;
        });
      });
    } catch {}
    if (chrome.storage && chrome.storage.onChanged && !__cb.__quartzCueWired) {
      __cb.__quartzCueWired = true;
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area === "local" && changes.quartzUpdateInfo && __cb.refreshMoreDot) {
          __cb.refreshMoreDot();
        }
      });
    }

    // Canvas / Tables view switching lives inside the overflow ("more")
    // menu — see the View row in __cb.openMoreMenu above. The toolbar
    // doesn't carry a dedicated toggle button anymore; users open the
    // menu, pick the view they want, and the menu re-reads
    // __cb.brainstormView on each open so the state pill stays current.
    __cb.setBrainstormView = function (value) {
      let next = value === "table" ? "table" : "canvas";
      // Defense in depth: canvas is allow-listed (see __cb.canUseCanvasView).
      // Coerce any "canvas" request to "table" for everyone else so no entry
      // point — including the tabs.js tab-switch path, which still defaults
      // legacy tabs to "canvas" — can surface the canvas to a locked user.
      if (next === "canvas" && !__cb.canUseCanvasView?.()) {
        next = "table";
      }
      const prev = __cb.brainstormView;
      __cb.brainstormView = next;
      if (__cb.overlayEl) {
        __cb.overlayEl.setAttribute("data-cb-brainstorm-view", next);
      }
      // Mount/unmount the spreadsheet on transition. The canvas DOM stays
      // mounted in both states (CSS hides it via [data-cb-brainstorm-view]),
      // so we don't have to teardown/reinit __cb.canvas.
      if (next === "table") {
        const host = __cb.overlayEl?.querySelector(".cb-table-view-area");
        if (host && __cb.tableView?.mount) __cb.tableView.mount(host);
      } else {
        // Lazy canvas DOM (C2.2): a table-view tab restored without mounting
        // any .cb-card elements. Build them now, before revealing the canvas.
        // Idempotent — no-ops if the canvas was already hydrated (e.g. opened
        // directly in canvas view). Runs refreshClusters + credit/group
        // bookkeeping internally, so the tightenBrokenClusters pass below sees
        // real geometry.
        if (__cb.canvas?.hydrateCanvasDom) __cb.canvas.hydrateCanvasDom();
        if (__cb.tableView?.unmount) __cb.tableView.unmount();
        // The table view moves the collaborators widget inline into its header;
        // unmount tore it down with the table DOM. Put it back in the canvas
        // area's floating top-right corner. Only needed when actually coming
        // from the table view — the initial canvas open already mounted it.
        if (prev === "table" && __cb.mountCollaboratorsWidget) {
          __cb.mountCollaboratorsWidget(mainArea);
        }
        // Lineage grouping (C2.4): fold each enrichment together with its
        // extracted data points into one cluster so the canvas matches the
        // lineage-driven table. Idempotent — a no-op when hydrateCanvasDom
        // already ran it (table→canvas toggle); does the work when a canvas-view
        // tab was opened directly (hydrateCanvasDom early-returns as already
        // hydrated by restore).
        let lineageGrouped = false;
        if (__cb.canvas?.clusterByLineage) {
          lineageGrouped = __cb.canvas.clusterByLineage();
        }
        // Coming back from the table view: clusters that the table-side
        // mutated (deleted a bridge ER, merged orphan clusters, etc.)
        // may be relationally intact but geometrically scattered. Pull
        // any "broken" cluster's members back together into a snap-
        // adjacent layout so the canvas matches the model. Skipped on
        // initial open (prev === undefined) so first-time canvas entry
        // doesn't reorganize a user's hand-arranged layout.
        if (
          prev === "table" &&
          __cb.canvas?.tightenBrokenClusters
        ) {
          const moved = __cb.canvas.tightenBrokenClusters();
          if (moved) {
            // Refresh visuals so snap classes line up with the new
            // adjacencies.
            if (__cb.canvas.refreshClusters) {
              __cb.canvas.refreshClusters({ dragCardIds: new Set() });
            }
            if (__cb.canvas.updateGroupBounds) __cb.canvas.updateGroupBounds();
            lineageGrouped = true;
          }
        }
        // Persist the (re)grouping through the canonical write path. Covers the
        // initial canvas-view open, where setBrainstormView's prev===next means
        // the trailing debouncedSave below won't fire.
        if (lineageGrouped) {
          __cb.model.update();
        }
      }
      // Soft-fade the freshly mounted body in on a tab/view switch. One-shot
      // (remove + reflow + re-add restarts the keyframe each switch), so plain
      // table refreshes — which don't go through setBrainstormView — never
      // flicker. Covers both the table host and the canvas area.
      const fadeTarget =
        next === "table"
          ? __cb.overlayEl?.querySelector(".cb-table-view-area")
          : mainArea;
      if (fadeTarget) {
        fadeTarget.classList.remove("cb-view-fade-in");
        void fadeTarget.offsetWidth;
        fadeTarget.classList.add("cb-view-fade-in");
      }
      if (prev !== next && __cb.debouncedSave) __cb.debouncedSave();
    };

    // Toggle the workbook-scoped pro mode flag. Visibility of the per-card
    // fill-rate badges is CSS-driven via `[data-cb-pro-mode]` on the overlay,
    // so individual cards don't need to be re-rendered. We use the debounced
    // save instead of an immediate `saveTabs()` because saveTabs serializes
    // the live canvas — calling it during the initial seed (before
    // `canvas.restore` runs) would overwrite the user's persisted state with
    // an empty canvas snapshot.
    __cb.setProMode = function (value) {
      const next = !!value;
      // Early-out when state didn't change (e.g. canvas restore reapplying
      // the persisted Pro Mode value). Without this we'd capture and reflow
      // clusters on every restore, which is wasted work and could broadcast
      // spurious card moves to collaborators.
      if (next === __cb.proMode) return;

      // Capture cluster topology BEFORE the CSS attribute flip so snap
      // adjacency still sees cards at their current (old) height. After the
      // height change, applyClusterReflow re-positions each cluster
      // member's y to match the new pitch, keeping magnets intact.
      const oldH = __cb.proMode ? 96 : 70;
      const newH = next ? 96 : 70;
      let clustersBefore = null;
      if (oldH !== newH && __cb.canvas?.getSnapClusters) {
        clustersBefore = __cb.canvas.getSnapClusters();
      }

      __cb.proMode = next;
      if (__cb.overlayEl) {
        if (next) __cb.overlayEl.setAttribute("data-cb-pro-mode", "");
        else __cb.overlayEl.removeAttribute("data-cb-pro-mode");
      }
      // Visual feedback for "Pro is on" now comes from (a) the
      // Projected / Actual segmented control becoming visible (CSS
      // gated on [data-cb-pro-mode]) and (b) the menu item itself
      // rendering with cb-more-menu-option-active the next time the
      // overflow menu is opened. The standalone Pro Mode toolbar
      // button that used to carry this state was retired in v3.30.
      // Source of truth for "did the user pick Pro recently?" lives in
      // localStorage (per-workbook, 1h TTL). Every toggle resets the
      // window when enabling and clears the key when disabling.
      __cb.writeProModePreference(__cb.currentWorkbookId, next);

      if (clustersBefore && __cb.canvas?.applyClusterReflow) {
        __cb.canvas.applyClusterReflow(clustersBefore, oldH, newH);
      }

      // Re-derive group rects from the cards' new offsetHeight. The CSS
      // attribute flip above changes every .cb-card between 70px and 96px,
      // and groups size themselves from getCardRect (which reads live
      // offsetHeight). Without this call, groups stay at the old height and
      // either let cards bleed past the bottom (entering Pro) or leave a
      // dead band below them (leaving Pro). Runs after applyClusterReflow
      // so any reflowed cluster member's new y is reflected in maxY.
      if (__cb.canvas?.updateGroupBounds) __cb.canvas.updateGroupBounds();

      if (__cb.debouncedSave) __cb.debouncedSave();
    };

    // Projected / Actual cost toggle. "Projected" uses catalog credit costs
    // multiplied by record count (the existing behavior). "Actual" pulls
    // realtime credit usage from Redshift via /column/recent and sums the
    // observed spend. Source of truth lives on `__cb.viewMode` and
    // `tabStore.viewMode` so it survives reloads and tab switches. The toggle
    // no longer lives in the topbar — it's mounted far-left in the table view's
    // action row (src/table-view.js calls __cb.buildViewModeToggle). Because
    // that row is rebuilt on every render we can't hold node references, so
    // setViewMode reflects the active half by querying the overlay each time.
    __cb.buildViewModeToggle = function () {
      const wrap = document.createElement("div");
      wrap.className = "cb-view-mode-toggle";

      const proj = document.createElement("button");
      proj.className = "cb-view-mode-btn cb-view-mode-projected";
      proj.type = "button";
      proj.title = "Projected: catalog credits \u00d7 records";
      proj.textContent = "Projected";

      const act = document.createElement("button");
      act.className = "cb-view-mode-btn cb-view-mode-actual";
      act.type = "button";
      act.title = "Actual: real spend from Clay's billing pipeline";
      act.textContent = "Actual";
      // Run-bucket (session) count badge. Filled by the table view's session
      // wiring once the session list loads; empty (hidden via :empty) on first
      // paint.
      const actBadge = document.createElement("span");
      actBadge.className = "cb-view-mode-actual-badge";
      act.appendChild(actBadge);

      const mode = __cb.viewMode === "actual" ? "actual" : "projected";

      // The white pill is a REAL element (.cb-view-mode-thumb), not a ::before:
      // Chrome doesn't reliably apply JS-set custom properties to a pseudo-
      // element's var()-driven left/width, so the pill silently fell back to a
      // fixed 50% half and read asymmetric for the unequal-width words. A real
      // span with inline left/width is exact. We also derive the offset from the
      // toggle's padding + button widths (not getBoundingClientRect minus an
      // integer-rounded border) so both ends get an identical gap, sub-pixel.
      //
      // Geometry is set after the caller mounts us (widths need layout):
      //  - plain refresh: snap the pill under the active word with the no-anim
      //    class so the reposition doesn't animate, and
      //  - when the user just flipped the mode (setViewMode set
      //    _viewModeSlideFrom): park it under the OLD word, then glide to the
      //    new word next frame so the transition has a delta to animate.
      const thumb = document.createElement("span");
      thumb.className = "cb-view-mode-thumb";

      // NOTE: don't clear _viewModeSlideFrom here. setViewMode can trigger more
      // than one table refresh in the same tick (credit recompute + explicit
      // refresh), each rebuilding this toggle; clearing on read would let the
      // first (discarded) rebuild consume the flag and the surviving toggle
      // would snap instead of slide. We clear it in the rAF below instead, so
      // every synchronous rebuild this tick sees the same value.
      const from = __cb._viewModeSlideFrom;
      const animate = (from === "projected" || from === "actual") && from !== mode;
      const startMode = animate ? from : mode;

      const applyActive = (m) => {
        proj.classList.toggle("cb-view-mode-btn-active", m === "projected");
        act.classList.toggle("cb-view-mode-btn-active", m === "actual");
      };
      const moveThumbTo = (m) => {
        // Buttons fill the toggle's content box edge-to-edge (gap:0), so each
        // button's left edge equals the toggle's padding-left plus the widths
        // before it. Projected sits flush at padding-left; Actual ends flush at
        // padding-right — identical outer gap on both ends, sub-pixel exact.
        const padL = parseFloat(getComputedStyle(wrap).paddingLeft) || 0;
        const projW = proj.getBoundingClientRect().width;
        const actW = act.getBoundingClientRect().width;
        thumb.style.left = `${m === "actual" ? padL + projW : padL}px`;
        thumb.style.width = `${m === "actual" ? actW : projW}px`;
      };

      applyActive(startMode);

      // Switching to Projected dismisses the session menu (we're leaving Actual).
      proj.addEventListener("click", () => {
        if (__cb.closeSessionPopover) __cb.closeSessionPopover();
        __cb.setViewMode("projected");
      });
      // Actual doubles as the session-cutoff menu trigger now (the standalone
      // session button was removed). First click just switches to Actual;
      // clicking Actual again (when it's already selected) opens the session
      // popover anchored to the freshly-rebuilt Actual button.
      act.addEventListener("click", () => {
        const wasActual = __cb.viewMode === "actual";
        __cb.setViewMode("actual");
        if (wasActual && __cb.toggleSessionPopover) {
          const anchor =
            __cb.overlayEl?.querySelector(
              ".cb-table-view-mode-toggle .cb-view-mode-actual",
            ) || act;
          __cb.toggleSessionPopover(anchor);
        }
      });

      wrap.appendChild(thumb);
      wrap.appendChild(proj);
      wrap.appendChild(act);

      requestAnimationFrame(() => {
        // Consume the slide flag now (after the synchronous rebuild burst).
        __cb._viewModeSlideFrom = null;
        // Snap to the start word without animating the initial placement.
        wrap.classList.add("cb-view-mode-no-anim");
        moveThumbTo(startMode);
        if (animate) {
          requestAnimationFrame(() => {
            // Commit the start position, then re-enable the transition and move
            // to the target word + active color so both glide together.
            void wrap.offsetWidth;
            wrap.classList.remove("cb-view-mode-no-anim");
            applyActive(mode);
            moveThumbTo(mode);
          });
        } else {
          requestAnimationFrame(() =>
            wrap.classList.remove("cb-view-mode-no-anim"),
          );
        }
      });

      return wrap;
    };

    __cb.setViewMode = function (value) {
      const next = value === "actual" ? "actual" : "projected";
      // Remember the half we're leaving so the rebuilt toggle can replay the
      // slide. This toggle is mounted only in the table-view action row, which
      // render() tears down and rebuilds on the very refresh setViewMode kicks
      // off below — so the pill can't animate via a plain class flip on a
      // persistent node. buildViewModeToggle consumes this flag to run the
      // slide as an enter-transition instead. Only set on a real change so
      // ordinary refreshes (cell edits, syncs) don't animate.
      const prev = __cb.viewMode === "actual" ? "actual" : "projected";
      if (prev !== next) __cb._viewModeSlideFrom = prev;
      __cb.viewMode = next;
      if (__cb.overlayEl) {
        __cb.overlayEl.setAttribute("data-cb-view-mode", next);
        // Reflect the active half on whatever toggle is currently mounted.
        __cb.overlayEl
          .querySelectorAll(".cb-view-mode-projected")
          .forEach((b) =>
            b.classList.toggle("cb-view-mode-btn-active", next === "projected"),
          );
        __cb.overlayEl
          .querySelectorAll(".cb-view-mode-actual")
          .forEach((b) =>
            b.classList.toggle("cb-view-mode-btn-active", next === "actual"),
          );
      }
      if (__cb.tabStore) {
        __cb.tabStore.viewMode = next;
        // Persist the mode on the active tab so it's remembered per tab (lets a
        // multi-tab export mix Projected/Actual per tab). saveTabs/debouncedSave
        // also serializes state.viewMode from __cb.viewMode.
        const at = __cb.tabStore.tabs?.find((t) => t.id === __cb.tabStore.activeId);
        if (at?.state) at.state.viewMode = next;
      }
      // Recompute Actual loading/expired state BEFORE the recalc so
      // setSummaryNumber renders the shimmer placeholder / "Expired" correctly
      // for the mode we're entering.
      __cb.applyActualSummaryState?.();
      // Re-run credit math so the summary boxes flip immediately. Flag the
      // refresh so the headline numbers count up/down to their new values
      // (setSummaryNumber reads this synchronously); cleared right after so
      // ordinary recalcs stay instant.
      __cb._animateSummary = true;
      try {
        if (__cb.canvas?.refreshCreditTotal) {
          __cb.canvas.refreshCreditTotal();
        } else {
          recalcTotal();
        }
      } finally {
        __cb._animateSummary = false;
      }
      if (__cb.canvas?.updateGroupCredits) __cb.canvas.updateGroupCredits();
      // The table view's per-row Credits / Actions columns are view-mode-aware
      // (projected catalog vs actual spend), so re-render it on toggle.
      if (__cb.tableView?.refresh) __cb.tableView.refresh();
      if (__cb.debouncedSave) __cb.debouncedSave();
    };

    // ---- Contract-term toggle (1y / 2y / 3y) -------------------------------
    // Visual clone of buildViewModeToggle, but a 3-segment pill. Shown in the
    // table intro INSTEAD of Projected/Actual while pricing mode is on. The
    // selected term N is both the contract length (drives floor derivation and
    // the savings sum) and the number of per-year record columns shown per use
    // case. State on __cb.contractYears (1..3), persisted per tab.
    if (typeof __cb.contractYears !== "number") __cb.contractYears = 1;

    __cb.buildContractTermToggle = function () {
      const wrap = document.createElement("div");
      wrap.className = "cb-view-mode-toggle cb-term-toggle";
      const defs = [
        { n: 1, t: "1 year" },
        { n: 2, t: "2 year" },
        { n: 3, t: "3 year" },
      ];
      const btns = defs.map(({ n, t }) => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "cb-view-mode-btn cb-term-btn";
        b.dataset.years = String(n);
        b.textContent = t;
        return b;
      });
      const active = Math.min(3, Math.max(1, __cb.contractYears || 1));
      const thumb = document.createElement("span");
      thumb.className = "cb-view-mode-thumb";
      const from = __cb._termSlideFrom;
      const animate = from >= 1 && from <= 3 && from !== active;
      const startIdx = (animate ? from : active) - 1;
      const applyActive = (idx) =>
        btns.forEach((b, i) => b.classList.toggle("cb-view-mode-btn-active", i === idx));
      const moveThumbTo = (idx) => {
        const padL = parseFloat(getComputedStyle(wrap).paddingLeft) || 0;
        let left = padL;
        for (let i = 0; i < idx; i++) left += btns[i].getBoundingClientRect().width;
        thumb.style.left = `${left}px`;
        thumb.style.width = `${btns[idx].getBoundingClientRect().width}px`;
      };
      applyActive(startIdx);
      btns.forEach((b, i) => b.addEventListener("click", () => __cb.setContractYears(i + 1)));
      wrap.appendChild(thumb);
      btns.forEach((b) => wrap.appendChild(b));
      requestAnimationFrame(() => {
        __cb._termSlideFrom = null;
        wrap.classList.add("cb-view-mode-no-anim");
        moveThumbTo(startIdx);
        if (animate) {
          requestAnimationFrame(() => {
            void wrap.offsetWidth;
            wrap.classList.remove("cb-view-mode-no-anim");
            applyActive(active - 1);
            moveThumbTo(active - 1);
          });
        } else {
          requestAnimationFrame(() => wrap.classList.remove("cb-view-mode-no-anim"));
        }
      });
      return wrap;
    };

    __cb.setContractYears = function (n) {
      const next = Math.min(3, Math.max(1, Number(n) || 1));
      const prev = Math.min(3, Math.max(1, __cb.contractYears || 1));
      if (prev !== next) __cb._termSlideFrom = prev;
      __cb.contractYears = next;
      if (__cb.tabStore) {
        __cb.tabStore.contractYears = next;
        const at = __cb.tabStore.tabs?.find((t) => t.id === __cb.tabStore.activeId);
        if (at?.state) at.state.contractYears = next;
      }
      recalcTotal();
      if (__cb.tableView?.refresh) __cb.tableView.refresh();
      if (__cb.debouncedSave) __cb.debouncedSave();
    };

    // Salesforce opportunity link — leads the guided rail
    // (Link opp → Generate POC → Request POC → Import → Pricing + Export).
    // The element internally swaps between a "Link opportunity" button and a
    // linked-opp pill ("Acme Inc — Q3 Expansion") based on the
    // canvases row's sfdc_opportunity_* columns. See src/sfdc.js for
    // the picker. The src/sfdc.js IIFE only assigns to __cb.sfdc when
    // the `sfdc` feature flag is on, so this `?.` check is the runtime
    // gate. Stored in sfdcWrap so updateGuidedFlow can drive its step.
    if (__cb.sfdc?.buildToolbarElement) {
      sfdcWrap = __cb.sfdc.buildToolbarElement();
      rightGroup.appendChild(sfdcWrap);
      // Hydrate from Supabase on canvas open. Fire-and-forget — the
      // toolbar element re-renders on its own when the linked-opp state
      // changes via __cb.sfdc.onLinkedOppChange.
      if (__cb.currentWorkbookId && __cb.sfdc.hydrateLinkedOpportunity) {
        __cb.sfdc.hydrateLinkedOpportunity(__cb.currentWorkbookId).catch((err) => {
          console.warn("[Clay Scoping] SFDC hydrate failed:", err);
        });
      }
    }
    if (dustBtn) rightGroup.appendChild(dustBtn);
    if (requestBtn) rightGroup.appendChild(requestBtn);
    rightGroup.appendChild(importBtn);
    if (pricingBtn) rightGroup.appendChild(pricingBtn);
    rightGroup.appendChild(exportBtn);
    rightGroup.appendChild(moreBtn);
    rightGroup.appendChild(closeBtn);
    topBar.appendChild(leftGroup);
    topBar.appendChild(rightGroup);

    // Resume any in-flight (or finished) POC generation for this canvas.
    // Fire-and-forget — hydratePocState flips the dust button into its
    // spinner and restarts the poller if a previous session left a POC
    // mid-flight; if one finished, the saved doc link is cached so opening
    // the popover shows it immediately. Only published when the `dust`
    // feature is on, hence the optional call.
    if (__cb.currentWorkbookId && __cb.hydratePocState) {
      __cb.hydratePocState(__cb.currentWorkbookId);
    }

    // Resume the Request POC "done" state. A prior request is recorded in
    // poc_requests keyed by workbook_id; hydrateRequestPocState flips the step
    // to its done color via __cb.setRequestPocDone when a row exists.
    // Fire-and-forget; only published for internal users (src/request-poc.js).
    if (__cb.currentWorkbookId && __cb.hydrateRequestPocState) {
      __cb.hydrateRequestPocState(__cb.currentWorkbookId);
    }

    // ---- Guided flow controller ----
    // Collapses the action rail to icons and expands the current step along the
    // chain Link -> Generate POC -> Request POC -> Import, then the tail
    // (Pricing + Export) once every chain step is done. The expanded button is
    // just the first step that isn't done yet (kept white, no highlight); done
    // chain steps color indigo and collapse to their icon. Buttons absent for
    // this user (feature-gated) are skipped, so a non-internal user simply gets
    // Import -> Export.
    function updateGuidedFlow() {
      // Re-resolve the SFDC inner element on each run — its wrapper rebuilds the
      // button/pill on link changes, so a cached reference would go stale.
      const sfdcInner = sfdcWrap
        ? sfdcWrap.querySelector(".cb-toolbar-sfdc-link, .cb-sfdc-pill")
        : null;

      const importDone = (__cb.canvas?.getCards?.() || []).length > 0;
      const linkDone = !!__cb.sfdc?.getLinkedOpportunity?.();
      const generateDone = !!dustBtn?.classList.contains("cb-toolbar-dust-poc-done");

      // Color the new done-states. The linked-opp pill and the Generate POC
      // done state already carry their own indigo treatment.
      if (importBtn) importBtn.classList.toggle("cb-toolbar-done", importDone);
      if (requestBtn) requestBtn.classList.toggle("cb-toolbar-done", requestPocDone);

      // Ordered chain of the steps that exist for this user.
      const chain = [];
      if (sfdcInner) chain.push({ el: sfdcInner, done: linkDone });
      if (dustBtn) chain.push({ el: dustBtn, done: generateDone });
      if (requestBtn) chain.push({ el: requestBtn, done: requestPocDone });
      if (importBtn) chain.push({ el: importBtn, done: importDone });

      // Tail actions have no done-state; they expand together once the whole
      // chain is complete.
      const tail = [];
      if (pricingBtn) tail.push(pricingBtn);
      if (exportBtn) tail.push(exportBtn);

      for (const step of chain) step.el.classList.remove("cb-toolbar-expanded");
      for (const btn of tail) btn.classList.remove("cb-toolbar-expanded");

      const next = chain.find((s) => !s.done);
      if (next) {
        next.el.classList.add("cb-toolbar-expanded");
      } else {
        for (const btn of tail) btn.classList.add("cb-toolbar-expanded");
      }
    }
    __cb.updateGuidedFlow = updateGuidedFlow;

    // Lets src/request-poc.js flip the Request POC step to done (on submit
    // success or on hydrate) and re-run the controller.
    __cb.setRequestPocDone = function (value) {
      requestPocDone = !!value;
      updateGuidedFlow();
    };

    // Re-run the controller whenever the linked opportunity changes (fires
    // immediately with the current value too). The SFDC element's own render()
    // is subscribed first, so the fresh button/pill is already in the DOM by
    // the time this runs.
    if (__cb.sfdc?.onLinkedOppChange) {
      __cb.sfdc.onLinkedOppChange(updateGuidedFlow);
    }

    // Initial paint (also covers users without the sfdc feature, where the
    // subscription above doesn't exist).
    updateGuidedFlow();

    // ---- Summary bar ----

    const summaryBar = document.createElement("div");
    summaryBar.className = "cb-summary-bar";

    const creditsBox = document.createElement("div");
    creditsBox.className = "cb-summary-box";
    const creditsLabel = document.createElement("span");
    creditsLabel.className = "cb-summary-label";
    creditsLabel.textContent = "Credits / Row";
    const creditsValue = document.createElement("span");
    creditsValue.className = "cb-summary-value";
    creditsValue.id = "cb-credits-value";
    creditsValue.textContent = "0";
    creditsBox.appendChild(creditsLabel);
    creditsBox.appendChild(creditsValue);

    const recordsBox = document.createElement("div");
    recordsBox.className = "cb-summary-box";
    const recordsLabel = document.createElement("label");
    recordsLabel.className = "cb-summary-label";
    recordsLabel.textContent = "Records";
    recordsLabel.htmlFor = "cb-records-input";
    const recordsInput = document.createElement("input");
    recordsInput.type = "text";
    recordsInput.inputMode = "numeric";
    recordsInput.className = "cb-summary-input";
    recordsInput.id = "cb-records-input";
    recordsInput.placeholder = "0";
    // "Reset to POC" affordance: hidden until the rep overrides the imported
    // (actual) count. Shown via the .cb-records-override class on recordsBox.
    const recordsResetBtn = document.createElement("button");
    recordsResetBtn.type = "button";
    recordsResetBtn.className = "cb-records-reset";
    recordsResetBtn.id = "cb-records-reset";
    recordsResetBtn.innerHTML =
      '<svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" ' +
      'stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">' +
      '<polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>' +
      '<span>Reset to POC</span>';
    recordsBox.appendChild(recordsLabel);
    recordsBox.appendChild(recordsInput);
    recordsBox.appendChild(recordsResetBtn);

    // Frequency box: displays the global default. Clicking the value opens
    // the same dropdown used on each ER card's ×N badge, so the UX is
    // symmetrical between global and per-card control.
    const freqBox = document.createElement("div");
    freqBox.className = "cb-summary-box cb-summary-freq";
    const freqLabel = document.createElement("span");
    freqLabel.className = "cb-summary-label";
    freqLabel.textContent = "Frequency";
    const freqTrigger = document.createElement("button");
    freqTrigger.type = "button";
    freqTrigger.className = "cb-summary-freq-trigger";
    freqTrigger.id = "cb-frequency-trigger";
    const freqTriggerText = document.createElement("span");
    freqTriggerText.className = "cb-summary-freq-text";
    freqTriggerText.textContent = __cb.getFrequencyLabel(__cb.getCurrentFrequencyId());
    const freqTriggerChevron = document.createElement("span");
    freqTriggerChevron.className = "cb-chevron";
    freqTriggerChevron.innerHTML =
      '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" ' +
      'stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">' +
      '<polyline points="6 9 12 15 18 9"/></svg>';
    freqTrigger.appendChild(freqTriggerText);
    freqTrigger.appendChild(freqTriggerChevron);
    freqBox.appendChild(freqLabel);
    freqBox.appendChild(freqTrigger);

    function setGlobalFrequency(nextId, opts) {
      const id = __cb.FREQUENCY_OPTIONS.some((o) => o.id === nextId)
        ? nextId
        : __cb.DEFAULT_FREQUENCY_ID;
      __cb.currentFrequencyId = id;
      freqTriggerText.textContent = __cb.getFrequencyLabel(id);
      // Update every ER card that hasn't been individually overridden so the
      // badges on those cards stay in sync with the new default.
      if (__cb.canvas?.updateDefaultFrequencies) {
        __cb.canvas.updateDefaultFrequencies(id);
      }
      // Re-run credit math so the "Total Credits" box reflects the new weight.
      if (__cb.canvas?.refreshCreditTotal) {
        __cb.canvas.refreshCreditTotal();
      } else {
        recalcTotal();
      }
      // If a target Total Cost is pinned, hold the dollar figure and let Records
      // absorb the new frequency (records = budget / per-record cost) instead of
      // the total ballooning. Runs after the recompute above so perRowDollarCost
      // reflects the new frequency weight.
      if (__cb.applyTotalCostTarget) __cb.applyTotalCostTarget();
      // Table view shows the effective frequency on each ER chip and (in
      // Projected) frequency-weighted group totals — refresh so it tracks the
      // new default the same way the canvas badges do.
      if (__cb.tableView?.refresh) __cb.tableView.refresh();
      if (opts?.skipSave) return;
      if (__cb.debouncedSave) __cb.debouncedSave();
    }

    // Exposed so tabs.js can reset the summary-bar frequency when the user
    // switches tabs. closeCanvas clears this again.
    __cb.setGlobalFrequency = setGlobalFrequency;

    // Write a per-use-case (per imported table) records/frequency override. Used
    // by the per-table header controls (table-view) when 2+ use cases exist.
    // Re-runs the cost roll-up + table refresh + persist.
    __cb.setUseCaseScope = function (key, patch) {
      if (!key || key === __cb.cost.OTHER_USE_CASE || !patch) return;
      __cb.useCaseScope = __cb.useCaseScope || {};
      __cb.useCaseScope[key] = { ...(__cb.useCaseScope[key] || {}), ...patch };
      // refreshCreditTotal -> notifyCreditTotal runs cost.syncUseCaseCoverage(),
      // which re-defaults each use case's non-custom ERs' coverageRows to the new
      // records (so the edit scales the total + the Coverage column); debounced
      // save then persists those coverageRows. Per-ER manual coverage is kept.
      if (__cb.canvas?.refreshCreditTotal) __cb.canvas.refreshCreditTotal();
      if (__cb.canvas?.updateGroupCredits) __cb.canvas.updateGroupCredits();
      if (__cb.tableView?.refresh) __cb.tableView.refresh();
      if (__cb.debouncedSave) __cb.debouncedSave();
    };

    freqTrigger.addEventListener("click", (evt) => {
      evt.stopPropagation();
      __cb.showFrequencyPicker(freqTrigger, __cb.getCurrentFrequencyId(), (picked) => {
        setGlobalFrequency(picked);
      });
    });

    const actionsBox = document.createElement("div");
    actionsBox.className = "cb-summary-box";
    const actionsLabel = document.createElement("span");
    actionsLabel.className = "cb-summary-label";
    actionsLabel.textContent = "Actions / Row";
    const actionsValue = document.createElement("span");
    actionsValue.className = "cb-summary-value";
    actionsValue.id = "cb-actions-value";
    actionsValue.textContent = "0";
    actionsBox.appendChild(actionsLabel);
    actionsBox.appendChild(actionsValue);

    const totalBox = document.createElement("div");
    totalBox.className = "cb-summary-box cb-summary-total";
    const totalLabel = document.createElement("span");
    totalLabel.className = "cb-summary-label";
    totalLabel.textContent = "Total Credits";
    const totalValue = document.createElement("span");
    totalValue.className = "cb-summary-value";
    totalValue.id = "cb-total-value";
    totalValue.textContent = "0";
    totalBox.appendChild(totalLabel);
    totalBox.appendChild(totalValue);

    const totalActionsBox = document.createElement("div");
    totalActionsBox.className = "cb-summary-box cb-summary-total";
    const totalActionsLabel = document.createElement("span");
    totalActionsLabel.className = "cb-summary-label";
    totalActionsLabel.textContent = "Total Actions";
    const totalActionsValue = document.createElement("span");
    totalActionsValue.className = "cb-summary-value";
    totalActionsValue.id = "cb-total-actions-value";
    totalActionsValue.textContent = "0";
    totalActionsBox.appendChild(totalActionsLabel);
    totalActionsBox.appendChild(totalActionsValue);

    // ---- Pricing cards (collapsible) ----

    const pricingGroup = document.createElement("div");
    pricingGroup.className = "cb-pricing-group";

    const pricingToggleBox = document.createElement("div");
    pricingToggleBox.className = "cb-summary-box cb-pricing-toggle";
    const pricingToggleLabel = document.createElement("span");
    pricingToggleLabel.className = "cb-summary-label";
    pricingToggleLabel.textContent = "Pricing";
    const pricingToggleRow = document.createElement("span");
    pricingToggleRow.className = "cb-pricing-toggle-row";
    const pricingToggleText = document.createElement("span");
    pricingToggleText.className = "cb-summary-value";
    pricingToggleText.textContent = "Show";
    const chevronEl = document.createElement("span");
    chevronEl.className = "cb-chevron";
    chevronEl.innerHTML =
      '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" ' +
      'stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">' +
      '<polyline points="9 18 15 12 9 6"/></svg>';
    pricingToggleRow.appendChild(pricingToggleText);
    pricingToggleRow.appendChild(chevronEl);
    pricingToggleBox.appendChild(pricingToggleLabel);
    pricingToggleBox.appendChild(pricingToggleRow);

    const creditCostBox = document.createElement("div");
    creditCostBox.className = "cb-summary-box cb-pricing-card";
    const creditCostLabel = document.createElement("label");
    creditCostLabel.className = "cb-summary-label";
    creditCostLabel.textContent = "Credit Cost";
    creditCostLabel.htmlFor = "cb-credit-cost-input";
    const creditCostInput = document.createElement("input");
    creditCostInput.type = "text";
    creditCostInput.inputMode = "decimal";
    creditCostInput.className = "cb-pricing-input";
    creditCostInput.id = "cb-credit-cost-input";
    creditCostInput.value = "$0.05";
    const creditDollarValue = document.createElement("span");
    creditDollarValue.className = "cb-summary-value cb-pricing-dollar";
    creditDollarValue.id = "cb-credit-dollar-value";
    creditDollarValue.textContent = "$0.00";
    creditCostBox.appendChild(creditCostLabel);
    creditCostBox.appendChild(creditCostInput);
    creditCostBox.appendChild(creditDollarValue);

    const actionCostBox = document.createElement("div");
    actionCostBox.className = "cb-summary-box cb-pricing-card";
    const actionCostLabel = document.createElement("label");
    actionCostLabel.className = "cb-summary-label";
    actionCostLabel.textContent = "Action Cost";
    actionCostLabel.htmlFor = "cb-action-cost-input";
    const actionCostInput = document.createElement("input");
    actionCostInput.type = "text";
    actionCostInput.inputMode = "decimal";
    actionCostInput.className = "cb-pricing-input";
    actionCostInput.id = "cb-action-cost-input";
    actionCostInput.value = "$0.008";
    const actionDollarValue = document.createElement("span");
    actionDollarValue.className = "cb-summary-value cb-pricing-dollar";
    actionDollarValue.id = "cb-action-dollar-value";
    actionDollarValue.textContent = "$0.00";
    actionCostBox.appendChild(actionCostLabel);
    actionCostBox.appendChild(actionCostInput);
    actionCostBox.appendChild(actionDollarValue);

    // "Total Cost" is editable, but deliberately harder to change than the
    // Credit/Action cost inputs: the whole card is a click target that opens
    // a small menu explaining that typing a target spend back-calculates the
    // number of records needed. A hover state + pencil glyph signal it's
    // interactive.
    const totalDollarBox = document.createElement("div");
    totalDollarBox.className = "cb-summary-box cb-pricing-card cb-pricing-total cb-total-cost-editable";
    totalDollarBox.setAttribute("role", "button");
    totalDollarBox.tabIndex = 0;
    totalDollarBox.title = "Set a target total cost to back-calculate the records needed";
    const totalDollarLabel = document.createElement("span");
    totalDollarLabel.className = "cb-summary-label";
    totalDollarLabel.textContent = "Total Cost";
    const totalDollarValue = document.createElement("span");
    totalDollarValue.className = "cb-summary-value";
    totalDollarValue.id = "cb-total-dollar-value";
    totalDollarValue.textContent = "$0";
    const totalDollarEditIcon = document.createElement("span");
    totalDollarEditIcon.className = "cb-total-cost-edit-icon";
    totalDollarEditIcon.setAttribute("aria-hidden", "true");
    totalDollarEditIcon.innerHTML =
      '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" ' +
      'stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>';
    totalDollarBox.appendChild(totalDollarLabel);
    totalDollarBox.appendChild(totalDollarValue);
    totalDollarBox.appendChild(totalDollarEditIcon);
    totalDollarBox.addEventListener("click", () => openTotalCostEditor(totalDollarBox));
    totalDollarBox.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        openTotalCostEditor(totalDollarBox);
      }
    });

    // The three cost cards live inside a grid wrapper so the disclosure can
    // animate open/closed in BOTH axes (width + height) via the CSS
    // grid-template 0fr<->1fr trick — the cards are taller than the other
    // summary boxes, so revealing them grows the whole bar; animating the
    // wrapper height lets every (stretched) box grow smoothly instead of
    // snapping. The inner clips with overflow:hidden so content is wiped in,
    // not squished.
    const pricingCards = document.createElement("div");
    pricingCards.className = "cb-pricing-cards";
    const pricingCardsInner = document.createElement("div");
    pricingCardsInner.className = "cb-pricing-cards-inner";
    pricingCardsInner.appendChild(actionCostBox);
    pricingCardsInner.appendChild(creditCostBox);
    pricingCardsInner.appendChild(totalDollarBox);
    pricingCards.appendChild(pricingCardsInner);

    pricingGroup.appendChild(pricingToggleBox);
    pricingGroup.appendChild(pricingCards);

    // Pricing view: the global mode/cost strip was removed — per-unit costs are
    // now defined per option (the "Discount" row in the body), and the
    // Projected/Actual toggle lives in the table intro row. creditCost/actionCost
    // keep their list defaults (still wired by the Pricing Show cards + tab
    // restore) so the per-use-case metric cards have a cost to render.

    // --- Actual-mode loading state ------------------------------------------
    // Every summary number that reflects real spend in Actual mode. While the
    // session list is being fetched AND nothing has been stamped yet, these
    // boxes shimmer; once any session spend lands they show the running total
    // (which climbs as more tables resolve — see session-cutoff progressive
    // reveal). There is no "Expired" state: the session default always falls
    // back to the most-recent session, so any table with runs gets a number,
    // and a table with zero runs shows the "—" no-sessions notice instead.
    const actualValueEls = [
      creditsValue,
      actionsValue,
      totalValue,
      totalActionsValue,
      creditDollarValue,
      actionDollarValue,
      totalDollarValue,
    ];
    const actualBoxes = [
      creditsBox,
      actionsBox,
      totalBox,
      totalActionsBox,
      creditCostBox,
      actionCostBox,
      totalDollarBox,
    ];
    for (const el of actualValueEls) el._cbActualDependent = true;

    // Blur the Actual numbers only while the session fetch is in flight AND no
    // cost card carries spend yet. Once the first table lands we stop blurring
    // and let the running total show (progressive reveal).
    function currentTabSpendPending() {
      const st = __cb.sessionCutoff?.getState?.();
      if (!st || !st.loading) return false;
      const cards = __cb.canvas?.getCards?.() || [];
      for (const c of cards) {
        const d = c.data;
        if (!d) continue;
        if (d.type === "dp" || d.type === "input" || d.type === "comment") continue;
        const sp = d.stats?.spend;
        if (
          sp &&
          ((sp.cellCount || 0) > 0 ||
            (sp.credits || 0) > 0 ||
            (sp.actionExecutions || 0) > 0)
        ) {
          return false; // have at least one stamped → show the running total
        }
      }
      return true; // loading and nothing stamped yet → shimmer
    }

    // Recompute the loading flag and (re)apply the blur class. Called before each
    // recalc that can change Actual state (setViewMode, session load, tab
    // switch). setSummaryNumber reads __cb.actualLoading to decide what to render.
    __cb.applyActualSummaryState = function () {
      __cb.actualLoading =
        __cb.viewMode === "actual" &&
        (currentTabSpendPending() || !!__cb.actualSpendApplying);
      for (const b of actualBoxes) {
        b.classList.toggle("cb-summary-loading", __cb.actualLoading);
      }
    };

    // The per-scope boxes (Actions/Row, Avg Credits/Row, Records, Frequency)
    // hide together on a multi-import. Group them in one grid collapsible (the
    // .cb-pricing-cards 0fr<->1fr trick) so they wipe out/in smoothly as a unit
    // instead of each box animating its own width. scopeInner clips with
    // overflow:hidden so content is wiped, not squished.
    const scopeWrap = document.createElement("div");
    scopeWrap.className = "cb-summary-scope";
    const scopeInner = document.createElement("div");
    scopeInner.className = "cb-summary-scope-inner";
    // Actions-first ordering, applied to every credit/action pair in the bar.
    scopeInner.appendChild(actionsBox);
    scopeInner.appendChild(creditsBox);
    scopeInner.appendChild(recordsBox);
    scopeInner.appendChild(freqBox);
    scopeWrap.appendChild(scopeInner);

    summaryBar.appendChild(scopeWrap);
    summaryBar.appendChild(totalActionsBox);
    summaryBar.appendChild(totalBox);
    summaryBar.appendChild(pricingGroup);
    // In pricing mode the whole summary bar folds up and disappears (CSS keys
    // off .cb-summary-pricing); there is no longer a cost strip beneath it —
    // per-unit costs are defined per option in the body.

    // Per-row numbers (unweighted) for the "Avg / Row" boxes.
    let currentCreditsPerRow = 0;
    let currentActionsPerRow = 0;
    // Frequency-weighted per-row numbers for the "Total" boxes. The canvas
    // reports both: unweighted drives the per-row display, weighted drives
    // the totals that get multiplied by Records.
    let currentWeightedCreditsPerRow = 0;
    let currentWeightedActionsPerRow = 0;
    let creditCost = 0.05;
    let actionCost = 0.008;

    function formatNumber(n) {
      return n % 1 === 0
        ? n.toLocaleString()
        : n.toLocaleString(undefined, { maximumFractionDigits: 1 });
    }

    function formatWithCommas(numStr) {
      const n = parseInt(numStr, 10);
      return isNaN(n) ? "" : n.toLocaleString();
    }

    function parseRecordsValue() {
      return parseInt(recordsInput.value.replace(/,/g, ""), 10) || 0;
    }

    // Derive the records box's visual state from the live value vs. the
    // imported "actual" (POC) count. No need to detect programmatic vs. user
    // edits — we just compare on every change:
    //   - no import yet (recordsActual null) → neutral, no reset button
    //   - value === actual                   → indigo "actual / POC" outline
    //   - value !== actual                   → amber "override" outline + reset
    function applyRecordsState() {
      const actual =
        typeof __cb.recordsActual === "number" && __cb.recordsActual > 0
          ? __cb.recordsActual
          : null;
      if (actual == null) {
        recordsBox.classList.remove("cb-records-actual", "cb-records-override");
        return;
      }
      const isOverride = parseRecordsValue() !== actual;
      recordsBox.classList.toggle("cb-records-override", isOverride);
      recordsBox.classList.toggle("cb-records-actual", !isOverride);
    }
    __cb.applyRecordsState = applyRecordsState;

    recordsResetBtn.addEventListener("click", () => {
      if (typeof __cb.recordsActual !== "number" || __cb.recordsActual <= 0) return;
      recordsInput.value = __cb.recordsActual.toLocaleString();
      recordsInput.dispatchEvent(new Event("input"));
      if (__cb.debouncedSave) __cb.debouncedSave();
    });

    __cb.getRecordsCount = () => parseRecordsValue();
    __cb.getCreditCost = () => creditCost;
    __cb.getActionCost = () => actionCost;

    function parseDollar(str) {
      const n = parseFloat(String(str).replace(/[^\d.]/g, ""));
      return isNaN(n) ? 0 : n;
    }

    function formatDollar(n) {
      // 2 decimals by default; allow up to 3 if the value has sub-cent precision.
      const rounded = Math.round(n * 1000) / 1000;
      const hasSubCent = Math.abs(rounded * 100 - Math.round(rounded * 100)) > 1e-9;
      return "$" + rounded.toLocaleString(undefined, {
        minimumFractionDigits: 2,
        maximumFractionDigits: hasSubCent ? 3 : 2,
      });
    }

    // Total Cost is always shown as a whole-dollar figure (no cents) — at
    // scoping volumes the cents are noise.
    function formatDollarRounded(n) {
      return "$" + Math.round(n).toLocaleString();
    }

    // Animate a summary number from its previous value up/down to `value` when
    // a mode switch is in flight (__cb._animateSummary); otherwise set it
    // instantly. The last numeric value is cached on the element so the tween
    // runs from the real number rather than a parsed/formatted string. Frequent
    // callers (records typing, edits) leave the flag unset, so only the
    // Projected/Actual flip animates.
    function setSummaryNumber(el, value, format) {
      // Actual flipped before this tab's spend landed: keep the projected
      // number visible and let CSS blur it; don't overwrite with the unknown
      // actual (reads 0). _cbNum stays the projected value, so when data lands
      // the count-up runs from it (projected -> actual). Reads the cached
      // __cb.actualLoading (scoped to the current tab) set by
      // applyActualSummaryState — NOT the global pending set, so a fetch pending
      // on another tab doesn't blur this tab's known numbers.
      if (el._cbActualDependent && __cb.actualLoading) {
        if (el._cbTween) {
          cancelAnimationFrame(el._cbTween);
          el._cbTween = null;
        }
        return;
      }
      // Actual-mode status notice (no sessions selected, or selected sessions
      // ran columns not on this canvas) — set by the session-cutoff controller.
      // Render its label ("—") + tooltip instead of a misleading 0.
      if (el._cbActualDependent && __cb.viewMode === "actual") {
        const notice = __cb.actualSummaryNotice;
        if (notice && notice.label) {
          if (el._cbTween) {
            cancelAnimationFrame(el._cbTween);
            el._cbTween = null;
          }
          el._cbNum = value;
          el.textContent = notice.label;
          el.title = notice.tooltip || "";
          el.classList.add("cb-summary-expired");
          return;
        }
      }
      if (el.classList.contains("cb-summary-expired")) {
        el.classList.remove("cb-summary-expired");
        el.title = "";
      }
      const from = typeof el._cbNum === "number" ? el._cbNum : value;
      el._cbNum = value;
      const reduce =
        window.matchMedia &&
        window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      if (el._cbTween) {
        cancelAnimationFrame(el._cbTween);
        el._cbTween = null;
      }
      if (!__cb._animateSummary || reduce || from === value) {
        el.textContent = format(value);
        return;
      }
      const start = performance.now();
      const dur = 420;
      const ease = (t) => 1 - Math.pow(1 - t, 3);
      const tick = (now) => {
        const t = Math.min(1, (now - start) / dur);
        el.textContent = format(from + (value - from) * ease(t));
        if (t < 1) {
          el._cbTween = requestAnimationFrame(tick);
        } else {
          el._cbTween = null;
          el.textContent = format(value);
        }
      };
      el._cbTween = requestAnimationFrame(tick);
    }

    // Collapse / reveal the whole scope-box group on a multi-import. Uses the
    // .cb-pricing-cards grid 0fr<->1fr trick (see overlay.css) — one class
    // toggle, no JS measuring. The first application snaps (no transition) via a
    // one-frame guard so the initial state doesn't animate from a cold render.
    let scopeCollapseReady = false;
    function setScopeCollapsed(collapsed) {
      if (!scopeWrap) return;
      if (!scopeCollapseReady) {
        // Snap to the initial state without animating.
        scopeWrap.classList.add("cb-summary-scope-no-anim");
        scopeWrap.classList.toggle("cb-summary-scope-collapsed", collapsed);
        requestAnimationFrame(() => {
          scopeWrap.classList.remove("cb-summary-scope-no-anim");
        });
        scopeCollapseReady = true;
        return;
      }
      scopeWrap.classList.toggle("cb-summary-scope-collapsed", collapsed);
    }

    function recalcTotal() {
      // Multi-use-case (2+ imported tables): the grand totals are pre-computed
      // per use case in notifyCreditTotal (each ER x its table's records), so
      // we use them directly instead of weighted-per-row x one global records.
      // At <= 1 use case __cb._multiTotals is null and this is unchanged.
      const multi = __cb._multiTotals;
      const records = parseRecordsValue();
      const totalCredits = multi
        ? multi.grandCredits
        : currentWeightedCreditsPerRow * records;
      const totalActions = multi
        ? multi.grandActions
        : currentWeightedActionsPerRow * records;
      // Totals are whole-number figures in the summary bar — at scoping
      // volumes the fractional tail (e.g. 15,458.4) is noise. The per-row
      // "Avg" boxes keep their decimals via formatNumber.
      const roundComma = (n) => Math.round(n).toLocaleString();
      setSummaryNumber(totalValue, totalCredits, roundComma);
      setSummaryNumber(totalActionsValue, totalActions, roundComma);

      const creditDollars = totalCredits * creditCost;
      const actionDollars = totalActions * actionCost;
      setSummaryNumber(creditDollarValue, creditDollars, formatDollar);
      setSummaryNumber(actionDollarValue, actionDollars, formatDollar);
      setSummaryNumber(totalDollarValue, creditDollars + actionDollars, formatDollarRounded);

      // Amber "pinned" outline on Total Cost while a target budget is held
      // (single-table only — in multi mode the per-use-case pills own the
      // budget). Mirrors the Records override outline.
      totalDollarBox.classList.toggle(
        "cb-total-cost-pinned",
        !multi && __cb.totalCostTarget > 0,
      );

      // Adaptive bar: with 2+ use cases, per-scope controls (Avg/Row, Records,
      // Frequency) move to each table's header — hide them here and show the
      // grand total + a per-use-case breakdown on hover. Pricing mode also
      // collapses the scope group (the cost/savings strip takes over).
      const hideScope = !!multi || !!__cb.pricingMode;
      setScopeCollapsed(hideScope);
      if (multi && Array.isArray(multi.perUseCase)) {
        const lines = multi.perUseCase
          .slice()
          .sort((a, b) => b.credits - a.credits)
          .map(
            (u) =>
              `${u.name}: ${Math.round(u.credits).toLocaleString()} cr` +
              (u.actions > 0 ? ` / ${Math.round(u.actions).toLocaleString()} act` : ""),
          );
        const tip = "Total by use case:\n" + lines.join("\n");
        totalBox.title = tip;
        totalActionsBox.title = tip;
      } else {
        totalBox.removeAttribute("title");
        totalActionsBox.removeAttribute("title");
      }

      // Pricing mode: refresh the cost/savings strip from the per-year volumes
      // and keep every cost input in sync with the shared creditCost/actionCost.
      if (__cb.pricingMode) updatePricingStrip();
      syncStripInputs();

      // Keep the guided rail's "Import" step in sync — this is the chokepoint
      // an import flows through (importTableToCanvas → model.update →
      // notifyCreditTotal → updateCreditTotal → recalcTotal), so the Import
      // step flips to done (and the tail expands) as soon as cards land.
      updateGuidedFlow();
    }

    // --- Pricing view strip computation -------------------------------------

    function syncStripInputs() {
      const setIf = (inp, val) => {
        if (inp && document.activeElement !== inp) inp.value = formatDollar(val);
      };
      setIf(creditCostInput, creditCost);
      setIf(actionCostInput, actionCost);
    }

    // Mode-aware: the per-year volumes follow the Projected/Actual toggle (same
    // as the rest of the table). __cb.getPricingResult is the single source the
    // body total box + the View Bands overlay both read.
    function computePricingResult() {
      const contractYears = Math.min(3, Math.max(1, __cb.contractYears || 1));
      return __cb.cost.computeContractTotals({
        contractYears,
        yearRecordsByUc: __cb.pricingYearRecords || {},
        viewMode: __cb.viewMode,
      });
    }
    __cb.getPricingResult = computePricingResult;

    // The global strip is gone; this just keeps the (hidden) Pricing Show cost
    // inputs and the View Bands overlay in sync with creditCost/actionCost, and
    // is still called on every recalc / volume edit.
    function updatePricingStrip() {
      syncStripInputs();
      if (__cb.pricingBands?.refresh) __cb.pricingBands.refresh(computePricingResult());
    }
    __cb.updatePricingStrip = updatePricingStrip;

    // Enter/leave the multi-year pricing view. Collapses the scope summary into
    // the cost/savings strip (CSS keys off .cb-summary-pricing) and flips the
    // table view (term toggle + per-use-case year editors + View Bands).
    __cb.setPricingMode = function (on) {
      const next = !!on;
      __cb.pricingMode = next;
      if (__cb.overlayEl) __cb.overlayEl.setAttribute("data-cb-pricing-mode", next ? "on" : "off");
      summaryBar.classList.toggle("cb-summary-pricing", next);
      if (pricingBtn) pricingBtn.classList.toggle("cb-toolbar-pricing-active", next);
      if (__cb.tabStore) {
        __cb.tabStore.pricingMode = next;
        const at = __cb.tabStore.tabs?.find((t) => t.id === __cb.tabStore.activeId);
        if (at?.state) at.state.pricingMode = next;
      }
      if (!next && __cb.pricingBands?.close) __cb.pricingBands.close();
      recalcTotal();
      if (__cb.tableView?.refresh) __cb.tableView.refresh();
      if (__cb.debouncedSave) __cb.debouncedSave();
    };

    // Set a use case's records for one year (0-based) in the pricing view.
    // Re-runs the strip + table so the derived volumes / tier / approval track.
    __cb.setPricingYearRecords = function (ucKey, yearIdx, value) {
      if (!ucKey) return;
      __cb.pricingYearRecords = __cb.pricingYearRecords || {};
      const arr = (__cb.pricingYearRecords[ucKey] || []).slice();
      arr[yearIdx] = Math.max(0, Math.round(Number(value) || 0));
      __cb.pricingYearRecords[ucKey] = arr;
      if (__cb.tabStore) {
        __cb.tabStore.pricingYearRecords = __cb.pricingYearRecords;
        const at = __cb.tabStore.tabs?.find((t) => t.id === __cb.tabStore.activeId);
        if (at?.state) at.state.pricingYearRecords = __cb.pricingYearRecords;
      }
      updatePricingStrip();
      if (__cb.tableView?.refresh) __cb.tableView.refresh();
      if (__cb.debouncedSave) __cb.debouncedSave();
    };

    // Pricing options (the editable "Options" group; up to 3). Each option is an
    // independent set of per-year overrides (credits + action tier) over the
    // shared recommended rollup from the use cases. Option A (index 0) is the
    // source of truth for the Summary. Overrides NEVER cascade to the use cases.
    function genPricingOptionId() {
      return "opt_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
    }
    function pricingOptionLetter(i) {
      return String.fromCharCode(65 + i); // A, B, C
    }

    // Ensures __cb.pricingOptions exists, migrating a legacy single override.
    // Each option carries its own contract term (`years`, 1..3) and a
    // `minimized` flag; backfill both for options restored from before they
    // existed (seeding `years` from the legacy global contractYears).
    __cb.getPricingOptions = function () {
      const seedYears = Math.min(3, Math.max(1, __cb.contractYears || 1));
      if (!Array.isArray(__cb.pricingOptions) || __cb.pricingOptions.length === 0) {
        const legacy = __cb.pricingTotalOverride;
        __cb.pricingOptions = [
          {
            id: genPricingOptionId(),
            name: "Option A",
            years: seedYears,
            minimized: false,
            override: {
              credits: { ...(legacy?.credits || {}) },
              actionTier: { ...(legacy?.actionTier || {}) },
            },
          },
        ];
      }
      for (const o of __cb.pricingOptions) {
        if (typeof o.years !== "number") o.years = seedYears;
        o.years = Math.min(3, Math.max(1, o.years));
        if (typeof o.minimized !== "boolean") o.minimized = false;
      }
      return __cb.pricingOptions;
    };

    function persistPricingOptions() {
      if (!__cb.tabStore) return;
      __cb.tabStore.pricingOptions = __cb.pricingOptions;
      const at = __cb.tabStore.tabs?.find((t) => t.id === __cb.tabStore.activeId);
      if (at?.state) at.state.pricingOptions = __cb.pricingOptions;
    }
    function afterPricingOptionsChange() {
      persistPricingOptions();
      updatePricingStrip();
      if (__cb.tableView?.refresh) __cb.tableView.refresh();
      if (__cb.debouncedSave) __cb.debouncedSave();
    }

    __cb.setPricingOptionCredits = function (optIdx, yearIdx, value) {
      const o = __cb.getPricingOptions()[optIdx];
      if (!o) return;
      o.override = o.override || { credits: {}, actionTier: {} };
      o.override.credits = o.override.credits || {};
      o.override.credits[yearIdx] = Math.max(0, Math.round(Number(value) || 0));
      afterPricingOptionsChange();
    };
    __cb.setPricingOptionActionTier = function (optIdx, yearIdx, tierId) {
      const o = __cb.getPricingOptions()[optIdx];
      if (!o) return;
      o.override = o.override || { credits: {}, actionTier: {} };
      o.override.actionTier = o.override.actionTier || {};
      o.override.actionTier[yearIdx] = tierId;
      afterPricingOptionsChange();
    };
    // Clears a year's per-option overrides (credits + action tier) so it tracks
    // the proposed/recommended rollup again.
    __cb.resetPricingOptionYear = function (optIdx, yearIdx) {
      const o = __cb.getPricingOptions()[optIdx];
      if (!o || !o.override) return;
      if (o.override.credits) delete o.override.credits[yearIdx];
      if (o.override.actionTier) delete o.override.actionTier[yearIdx];
      afterPricingOptionsChange();
    };
    // The rep-entered discount price (contract-wide CPC/CPA) for one option.
    // metric: "credit" -> cpc, "action" -> cpa. Defaults to list when unset.
    __cb.setPricingOptionPrice = function (optIdx, metric, value) {
      const o = __cb.getPricingOptions()[optIdx];
      if (!o) return;
      o.override = o.override || { credits: {}, actionTier: {} };
      const v = Math.max(0, Number(value) || 0);
      if (metric === "credit") o.override.cpc = v;
      else o.override.cpa = v;
      afterPricingOptionsChange();
    };
    // Per-option contract term (1..3 years) — drives that option's year rows,
    // averaged tier/floors, and Summary card, independent of other options.
    __cb.setPricingOptionYears = function (optIdx, n) {
      const o = __cb.getPricingOptions()[optIdx];
      if (!o) return;
      o.years = Math.min(3, Math.max(1, Number(n) || 1));
      afterPricingOptionsChange();
    };
    // Minimize / restore an option card (persisted). Minimized cards render as a
    // thin strip showing only the rotated title; restore is right-click only.
    __cb.setPricingOptionMinimized = function (optIdx, on) {
      const o = __cb.getPricingOptions()[optIdx];
      if (!o) return;
      o.minimized = !!on;
      afterPricingOptionsChange();
    };
    __cb.addPricingOption = function () {
      const opts = __cb.getPricingOptions();
      if (opts.length >= 3) return null;
      const last = opts[opts.length - 1];
      const id = genPricingOptionId();
      opts.push({
        id,
        name: `Option ${pricingOptionLetter(opts.length)}`,
        years: Math.min(3, Math.max(1, last?.years || __cb.contractYears || 1)),
        minimized: false,
        override: {
          credits: { ...(last?.override?.credits || {}) },
          actionTier: { ...(last?.override?.actionTier || {}) },
        },
      });
      __cb._pricingOptionJustAdded = id; // drives the enter animation
      __cb._pricingTotalCollapsed = false; // reveal the group if it was collapsed
      afterPricingOptionsChange();
      return id;
    };
    __cb.deletePricingOption = function (optIdx) {
      const opts = __cb.getPricingOptions();
      if (opts.length <= 1) return;
      opts.splice(optIdx, 1);
      afterPricingOptionsChange();
    };
    __cb.renamePricingOption = function (optIdx, name) {
      const o = __cb.getPricingOptions()[optIdx];
      if (!o) return;
      o.name = String(name || "").trim() || `Option ${pricingOptionLetter(optIdx)}`;
      afterPricingOptionsChange();
    };

    function commitPricingInput(input, setter) {
      const parsed = parseDollar(input.value);
      setter(parsed);
      input.value = formatDollar(parsed);
      recalcTotal();
      // A pinned target Total Cost holds the dollar budget when the unit prices
      // change too: re-derive Records at the new per-record cost.
      if (__cb.applyTotalCostTarget) __cb.applyTotalCostTarget();
      if (__cb.canvas?.updateGroupCredits) {
        __cb.canvas.updateGroupCredits();
      }
      // Pricing mode: the body total box derives from these prices, so refresh
      // it. Safe re: focus — commit runs on blur, and the inputs live in the
      // summary-bar strip, not the body being re-rendered.
      if (__cb.pricingMode && __cb.tableView?.refresh) __cb.tableView.refresh();
      if (__cb.debouncedSave) __cb.debouncedSave();
    }

    function wirePricingInput(input, setter) {
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          input.blur();
        }
      });
      input.addEventListener("blur", () => commitPricingInput(input, setter));
      input.addEventListener("focus", () => input.select());
    }

    wirePricingInput(creditCostInput, (v) => { creditCost = v; });
    wirePricingInput(actionCostInput, (v) => { actionCost = v; });

    // ---- Total Cost editor (back-calculates Records from a target spend) ----
    //
    // The dollar cost of one record at the current scope. recordsNeeded =
    // targetTotal / perRowDollarCost(). Uses the frequency-weighted per-row
    // numbers so the derivation matches what recalcTotal multiplies by.
    function perRowDollarCost() {
      return (
        currentWeightedCreditsPerRow * creditCost +
        currentWeightedActionsPerRow * actionCost
      );
    }

    // Re-derive the global Records from a pinned target budget. Called after
    // anything that changes the per-record dollar cost (frequency, unit prices)
    // so a pinned Total Cost stays put and Records absorbs the change instead.
    // No-op unless a budget is pinned, we're in single-table mode, and the per-
    // record cost is computable. The guard stops the records `input` handler
    // from treating this programmatic write as a manual un-pin.
    function applyTotalCostTarget() {
      const target = __cb.totalCostTarget;
      if (!(target > 0) || __cb._multiTotals) return;
      const per = perRowDollarCost();
      if (per <= 0) return;
      const records = Math.max(1, Math.round(target / per));
      if (records === parseRecordsValue()) return;
      __cb._applyingTargetBudget = true;
      recordsInput.value = records.toLocaleString();
      recordsInput.dispatchEvent(new Event("input"));
      __cb._applyingTargetBudget = false;
    }
    __cb.applyTotalCostTarget = applyTotalCostTarget;

    let totalCostEditorEl = null;
    let totalCostEditorBackdrop = null;
    function closeTotalCostEditor() {
      if (totalCostEditorEl) { totalCostEditorEl.remove(); totalCostEditorEl = null; }
      if (totalCostEditorBackdrop) { totalCostEditorBackdrop.remove(); totalCostEditorBackdrop = null; }
    }
    __cb.closeTotalCostEditor = closeTotalCostEditor;

    // Generic "edit total cost" popover, reused by the global summary-bar Total
    // Cost box AND the per-use-case dollar pill in the table header. The caller
    // supplies the anchor, the prefilled text, the dollar cost of ONE record at
    // the current scope (perRecordDollar), and an onApply(targetDollars, perRow)
    // that does the actual back-calculation / state write. Keeps the same
    // .cb-total-cost-editor markup + CSS regardless of caller.
    function openTargetCostEditor(opts) {
      opts = opts || {};
      const anchorEl = opts.anchorEl;
      if (!anchorEl) return;
      const perRow = Number(opts.perRecordDollar) || 0;
      const onApply = typeof opts.onApply === "function" ? opts.onApply : () => {};
      closeTotalCostEditor();

      const backdrop = document.createElement("div");
      backdrop.style.cssText = "position:fixed;inset:0;z-index:9999998;";
      backdrop.addEventListener("mousedown", (evt) => {
        evt.stopPropagation();
        closeTotalCostEditor();
      });

      const menu = document.createElement("div");
      menu.className = "cb-total-cost-editor";
      menu.addEventListener("mousedown", (evt) => evt.stopPropagation());

      const title = document.createElement("div");
      title.className = "cb-total-cost-editor-title";
      title.textContent = opts.title || "Edit total cost";
      const help = document.createElement("p");
      help.className = "cb-total-cost-editor-help";
      menu.appendChild(title);
      menu.appendChild(help);

      // Records drive the total in BOTH modes — Actual measures spend/row and
      // still multiplies by Records — so back-calculating Records from a target
      // total works identically. Gate only on having a non-zero per-row cost.
      const canDerive = perRow > 0;

      if (canDerive) {
        // Semi-bold the "cost per row ($N/record)" phrase so the rate the
        // derivation keys off stands out. formatDollar yields a safe "$N" string.
        help.innerHTML =
          "Type your target spend. We'll back-calculate the number of records " +
          'needed at the current <strong class="cb-total-cost-editor-emph">cost per row (' +
          formatDollar(perRow) +
          "/record)</strong> and update the Records field.";

        const row = document.createElement("div");
        row.className = "cb-total-cost-editor-row";
        const input = document.createElement("input");
        input.type = "text";
        input.inputMode = "decimal";
        input.className = "cb-total-cost-editor-input";
        input.value = opts.currentText || "";
        const applyBtn = document.createElement("button");
        applyBtn.type = "button";
        applyBtn.className = "cb-total-cost-editor-apply";
        applyBtn.textContent = "Apply";
        row.appendChild(input);
        row.appendChild(applyBtn);
        menu.appendChild(row);

        const apply = () => {
          const target = parseDollar(input.value);
          if (perRow > 0 && target > 0) onApply(target, perRow);
          closeTotalCostEditor();
        };
        applyBtn.addEventListener("click", (e) => { e.stopPropagation(); apply(); });
        input.addEventListener("keydown", (e) => {
          if (e.key === "Enter") { e.preventDefault(); apply(); }
          else if (e.key === "Escape") { e.preventDefault(); closeTotalCostEditor(); }
        });
        setTimeout(() => { input.focus(); input.select(); }, 0);
      } else {
        help.classList.add("cb-total-cost-editor-help-muted");
        help.textContent =
          opts.emptyHelp ||
          "Add at least one enrichment with a non-zero cost per row before setting a target total cost.";
      }

      document.body.appendChild(backdrop);
      document.body.appendChild(menu);

      // Right-align under the anchor so the menu stays within the viewport
      // (Total Cost is the right-most summary box; the pill sits at the far
      // right of the table header).
      const rect = anchorEl.getBoundingClientRect();
      const width = 280;
      menu.style.position = "fixed";
      menu.style.zIndex = "9999999";
      menu.style.top = (rect.bottom + 6) + "px";
      menu.style.left = Math.max(8, rect.right - width) + "px";

      totalCostEditorEl = menu;
      totalCostEditorBackdrop = backdrop;
    }
    // Exposed so the table-view per-use-case dollar pill can reuse it.
    __cb.openTargetCostEditor = openTargetCostEditor;

    // Multi-table Total Cost editor: lists every use case (imported table) with
    // its current total cost, each editable. Typing a target for a table sets
    // that table's records to fit it (and pins its budget) — same back-calc as
    // the per-table dollar pill, just gathered in one place off the summary bar.
    function openUseCaseCostEditor(anchorEl) {
      closeTotalCostEditor();
      const rows = __cb._multiTotals?.perUseCase || [];

      const backdrop = document.createElement("div");
      backdrop.style.cssText = "position:fixed;inset:0;z-index:9999998;";
      backdrop.addEventListener("mousedown", (evt) => {
        evt.stopPropagation();
        closeTotalCostEditor();
      });

      const menu = document.createElement("div");
      menu.className = "cb-total-cost-editor cb-uc-cost-editor";
      menu.addEventListener("mousedown", (evt) => evt.stopPropagation());

      const title = document.createElement("div");
      title.className = "cb-total-cost-editor-title";
      title.textContent = "Edit cost by use case";
      const help = document.createElement("p");
      help.className = "cb-total-cost-editor-help";
      help.textContent =
        "Type a target spend for any table; we'll set its records to fit at that table's current cost per record.";
      menu.appendChild(title);
      menu.appendChild(help);

      for (const u of rows.slice().sort((a, b) => b.credits - a.credits)) {
        const dollars = (u.credits || 0) * creditCost + (u.actions || 0) * actionCost;
        const recs = __cb.cost?.useCaseRecords ? Number(__cb.cost.useCaseRecords(u.key)) || 0 : 0;
        const perRecord = recs > 0 ? dollars / recs : 0;

        const row = document.createElement("div");
        row.className = "cb-uc-cost-editor-row";
        const label = document.createElement("span");
        label.className = "cb-uc-cost-editor-label";
        label.textContent = u.name;
        label.title = u.name;
        const input = document.createElement("input");
        input.type = "text";
        input.inputMode = "decimal";
        input.className = "cb-total-cost-editor-input cb-uc-cost-editor-input";
        input.value = "$" + Math.round(dollars).toLocaleString();
        if (perRecord > 0) {
          const commit = () => {
            const target = parseDollar(input.value);
            if (target > 0) {
              const newRecords = Math.max(1, Math.round(target / perRecord));
              __cb.setUseCaseScope?.(u.key, { records: newRecords, budget: target });
            }
          };
          input.addEventListener("keydown", (e) => {
            if (e.key === "Enter") { e.preventDefault(); commit(); closeTotalCostEditor(); }
            else if (e.key === "Escape") { e.preventDefault(); closeTotalCostEditor(); }
          });
          input.addEventListener("blur", commit);
          input.addEventListener("focus", () => input.select());
        } else {
          input.disabled = true;
          input.title = "Add an enrichment with a non-zero cost per row first";
        }
        row.appendChild(label);
        row.appendChild(input);
        menu.appendChild(row);
      }

      document.body.appendChild(backdrop);
      document.body.appendChild(menu);
      const rect = anchorEl.getBoundingClientRect();
      const width = 320;
      menu.style.position = "fixed";
      menu.style.zIndex = "9999999";
      menu.style.top = (rect.bottom + 6) + "px";
      menu.style.left = Math.max(8, rect.right - width) + "px";
      totalCostEditorEl = menu;
      totalCostEditorBackdrop = backdrop;
    }

    // Single-table (global) Total Cost editor: back-calculate the global Records
    // field from a target spend, and PIN that budget so a later frequency / unit-
    // price change re-derives Records instead of inflating the total. In multi-
    // table mode it defers to the per-use-case editor instead (the global Records
    // field is hidden there).
    function openTotalCostEditor(anchorEl) {
      if (__cb._multiTotals && (__cb._multiTotals.perUseCase || []).length) {
        openUseCaseCostEditor(anchorEl);
        return;
      }
      openTargetCostEditor({
        anchorEl,
        currentText: totalDollarValue.textContent,
        perRecordDollar: perRowDollarCost(),
        onApply: (target) => {
          const per = perRowDollarCost();
          if (per <= 0 || target <= 0) return;
          __cb._applyingTargetBudget = true;
          const records = Math.max(1, Math.round(target / per));
          recordsInput.value = records.toLocaleString();
          recordsInput.dispatchEvent(new Event("input"));
          __cb._applyingTargetBudget = false;
          // Pin AFTER the input dispatch: the records handler clears the pin on
          // a (non-programmatic) edit, so we set it once the derive has settled.
          __cb.totalCostTarget = target;
          recalcTotal();
          if (__cb.debouncedSave) __cb.debouncedSave();
        },
      });
    }

    pricingToggleBox.addEventListener("click", () => {
      const expanded = pricingGroup.classList.toggle("is-expanded");
      chevronEl.classList.toggle("cb-chevron-open", expanded);
      pricingToggleText.textContent = expanded ? "Hide" : "Show";
      if (__cb.debouncedSave) __cb.debouncedSave();
    });

    // Signature extended to receive both unweighted and frequency-weighted
    // per-row totals. Old call sites that pass only two args still work:
    // the weighted numbers fall back to the unweighted ones so the totals
    // behave as if every ER were on the default (x1) frequency.
    __cb.updateCreditTotal = function (
      creditsPerRow,
      actionsPerRow,
      weightedCreditsPerRow,
      weightedActionsPerRow
    ) {
      currentCreditsPerRow = creditsPerRow;
      currentActionsPerRow = actionsPerRow;
      currentWeightedCreditsPerRow = weightedCreditsPerRow ?? creditsPerRow;
      currentWeightedActionsPerRow = weightedActionsPerRow ?? actionsPerRow;
      setSummaryNumber(creditsValue, creditsPerRow, formatNumber);
      setSummaryNumber(actionsValue, actionsPerRow, formatNumber);
      recalcTotal();
    };

    recordsInput.addEventListener("input", () => {
      // A manual edit to Records un-pins any target-cost budget: from here on
      // Total Cost is derived (perRow × records) again. Programmatic edits made
      // while deriving records FROM a budget set the guard, so they don't clear
      // the pin they just established.
      if (!__cb._applyingTargetBudget) __cb.totalCostTarget = null;
      const raw = recordsInput.value.replace(/[^\d]/g, "");
      const formatted = formatWithCommas(raw);
      const prevLen = recordsInput.value.length;
      const caretPos = recordsInput.selectionStart || 0;
      recordsInput.value = formatted;
      const diff = formatted.length - prevLen;
      recordsInput.setSelectionRange(caretPos + diff, caretPos + diff);
      const recCount = parseRecordsValue();
      // Records is the table's total rows AND the default coverage. Re-default
      // coverage on every enrichment the user hasn't manually overridden so
      // projected cost tracks the new total (custom coverage is preserved).
      for (const c of (__cb.canvas?.getCards?.() || [])) {
        const t = c.data?.type;
        if (!c.data || t === "dp" || t === "input" || t === "comment") continue;
        if (c.data.coverageCustom) continue;
        c.data.coverageRows = recCount;
      }
      // Keep unedited DP card fill rates in sync with the records count
      // (editable popover values stay locked once the user has touched them).
      if (__cb.canvas?.updateDefaultFillRates) {
        __cb.canvas.updateDefaultFillRates(recCount);
      }
      // refreshCreditTotal recomputes the coverage-weighted totals (and calls
      // recalcTotal internally); fall back to recalcTotal if it's unavailable.
      if (__cb.canvas?.refreshCreditTotal) __cb.canvas.refreshCreditTotal();
      else recalcTotal();
      if (__cb.canvas?.updateGroupCredits) {
        __cb.canvas.updateGroupCredits();
      }
      applyRecordsState();
      if (__cb.tableView?.refresh) __cb.tableView.refresh();
    });

    // ---- Canvas area + toolbox ----

    const canvasArea = document.createElement("div");
    canvasArea.className = "cb-canvas-area";
    canvasArea.id = "cb-canvas-area";

    // Table view host. Mounted in the same flex container as the canvas so
    // the swap is a pure CSS visibility toggle keyed off
    // [data-cb-brainstorm-view]. Stays empty until __cb.setBrainstormView
    // ("table") triggers __cb.tableView.mount.
    const tableArea = document.createElement("div");
    tableArea.className = "cb-table-view-area";
    tableArea.id = "cb-table-view-area";

    const mainArea = document.createElement("div");
    mainArea.className = "cb-main";
    mainArea.appendChild(canvasArea);
    mainArea.appendChild(tableArea);

    const toolbox = document.createElement("div");
    toolbox.className = "cb-toolbox";

    const navHelper = document.createElement("div");
    navHelper.className = "cb-tool-helper";
    navHelper.innerHTML = "Select cards  <kbd>\u23CE</kbd> link \u00A0\u00A0 <kbd>\u21E7\u23CE</kbd> group \u00A0\u00A0 <kbd>\u2318\u23CE</kbd> waterfall";

    const helper = document.createElement("div");
    helper.className = "cb-tool-helper";
    helper.innerHTML = "<kbd>\u21E7</kbd> bulk \u00A0\u00A0 <kbd>\u2325</kbd> comment \u00A0\u00A0 <kbd>\u2318</kbd> input \u00A0\u00A0 <kbd>\u21E7</kbd><kbd>\u2318</kbd> bulk input";

    const erHelper = document.createElement("div");
    erHelper.className = "cb-tool-helper";
    erHelper.innerHTML = "Double <kbd>Click</kbd> a data point to connect";

    const selector = document.createElement("div");
    selector.className = "cb-tool-selector";

    const navBtn = document.createElement("button");
    navBtn.className = "cb-tool-btn";
    navBtn.type = "button";
    navBtn.innerHTML =
      '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" ' +
      'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M11.146 15.854a1.207 1.207 0 0 1 1.708 0l1.56 1.56A2 2 0 0 1 15 18.828V21a1 1 0 0 1-1 1h-4a1 1 0 0 1-1-1v-2.172a2 2 0 0 1 .586-1.414z"/>' +
      '<path d="M18.828 15a2 2 0 0 1-1.414-.586l-1.56-1.56a1.207 1.207 0 0 1 0-1.708l1.56-1.56A2 2 0 0 1 18.828 9H21a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1z"/>' +
      '<path d="M6.586 14.414A2 2 0 0 1 5.172 15H3a1 1 0 0 1-1-1v-4a1 1 0 0 1 1-1h2.172a2 2 0 0 1 1.414.586l1.56 1.56a1.207 1.207 0 0 1 0 1.708z"/>' +
      '<path d="M9 3a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2.172a2 2 0 0 1-.586 1.414l-1.56 1.56a1.207 1.207 0 0 1-1.708 0l-1.56-1.56A2 2 0 0 1 9 5.172z"/></svg>' +
      "<span>Navigate</span>";

    const dpBtn = document.createElement("button");
    dpBtn.className = "cb-tool-btn";
    dpBtn.type = "button";
    dpBtn.innerHTML =
      '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" ' +
      'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M4 7V4h16v3"/><path d="M9 20h6"/><path d="M12 4v16"/></svg>' +
      "<span>Data Points</span>";

    const erBtn = document.createElement("button");
    erBtn.className = "cb-tool-btn";
    erBtn.type = "button";
    erBtn.innerHTML =
      '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" ' +
      'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>' +
      "<span>Enrichments</span>";

    function getModeFromTool(tool) {
      return tool === "dp" || tool === "er" ? tool : "navigate";
    }

    function setSelectedMode(mode) {
      const canvas = __cb.canvas;
      if (!canvas) return;
      canvas.setActiveTool(mode === "navigate" ? null : mode);
      updateToolButtons();
    }

    function updateToolButtons() {
      const canvas = __cb.canvas;
      const mode = getModeFromTool(canvas ? canvas.getActiveTool() : null);
      navBtn.classList.toggle("cb-tool-btn-active", mode === "navigate");
      dpBtn.classList.toggle("cb-tool-btn-active", mode === "dp");
      erBtn.classList.toggle("cb-tool-btn-active", mode === "er");
      navHelper.classList.toggle("cb-tool-helper-visible", mode === "navigate");
      helper.classList.toggle("cb-tool-helper-visible", mode === "dp");
      erHelper.classList.toggle("cb-tool-helper-visible", mode === "er");
      if (tipsTab.classList.contains("cb-help-tab-active")) {
        helpContent.innerHTML = buildTipsHtml(mode);
      }
    }

    navBtn.addEventListener("click", () => setSelectedMode("navigate"));
    dpBtn.addEventListener("click", () => setSelectedMode("dp"));
    erBtn.addEventListener("click", () => setSelectedMode("er"));

    selector.appendChild(navBtn);
    selector.appendChild(dpBtn);
    selector.appendChild(erBtn);
    toolbox.appendChild(navHelper);
    toolbox.appendChild(helper);
    toolbox.appendChild(erHelper);
    toolbox.appendChild(selector);
    mainArea.appendChild(toolbox);

    const zoomControls = document.createElement("div");
    zoomControls.className = "cb-zoom-controls";

    const zoomInBtn = document.createElement("button");
    zoomInBtn.className = "cb-zoom-btn";
    zoomInBtn.type = "button";
    zoomInBtn.innerHTML =
      '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" ' +
      'stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">' +
      '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>';
    zoomInBtn.addEventListener("click", () => { if (__cb.canvas) __cb.canvas.zoomIn(); });

    const zoomOutBtn = document.createElement("button");
    zoomOutBtn.className = "cb-zoom-btn";
    zoomOutBtn.type = "button";
    zoomOutBtn.innerHTML =
      '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" ' +
      'stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">' +
      '<line x1="5" y1="12" x2="19" y2="12"/></svg>';
    zoomOutBtn.addEventListener("click", () => { if (__cb.canvas) __cb.canvas.zoomOut(); });

    zoomControls.appendChild(zoomInBtn);
    zoomControls.appendChild(zoomOutBtn);
    mainArea.appendChild(zoomControls);

    // ---- Help button + popover ----

    const helpWrap = document.createElement("div");
    helpWrap.className = "cb-help-wrap";

    const helpBtn = document.createElement("button");
    helpBtn.className = "cb-help-btn";
    helpBtn.type = "button";
    helpBtn.textContent = "?";

    const helpPopover = document.createElement("div");
    helpPopover.className = "cb-help-popover";

    const helpToggle = document.createElement("div");
    helpToggle.className = "cb-help-toggle";

    const instructionsTab = document.createElement("button");
    instructionsTab.className = "cb-help-tab cb-help-tab-active";
    instructionsTab.type = "button";
    instructionsTab.textContent = "Instructions";

    const tipsTab = document.createElement("button");
    tipsTab.className = "cb-help-tab";
    tipsTab.type = "button";
    tipsTab.textContent = "Tips";

    helpToggle.appendChild(instructionsTab);
    helpToggle.appendChild(tipsTab);

    const helpActions = document.createElement("div");
    helpActions.className = "cb-help-actions";

    const maximizeSvg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" ' +
      'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
      '<polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/>' +
      '<line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>';
    const minimizeSvg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" ' +
      'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
      '<polyline points="4 14 10 14 10 20"/><polyline points="20 10 14 10 14 4"/>' +
      '<line x1="14" y1="10" x2="21" y2="3"/><line x1="3" y1="21" x2="10" y2="14"/></svg>';
    const pinSvg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" ' +
      'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M12 17v5"/>' +
      '<path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/></svg>';
    const pinOffSvg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" ' +
      'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M12 17v5"/><path d="M15 9.34V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H7.89"/>' +
      '<path d="m2 2 20 20"/><path d="M9 9v1.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16h11"/></svg>';

    const expandBtn = document.createElement("button");
    expandBtn.className = "cb-help-action-btn";
    expandBtn.type = "button";
    expandBtn.title = "Expand";
    expandBtn.innerHTML = maximizeSvg;

    const pinBtn = document.createElement("button");
    pinBtn.className = "cb-help-action-btn";
    pinBtn.type = "button";
    pinBtn.title = "Pin";
    pinBtn.innerHTML = pinSvg;

    expandBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const expanded = helpPopover.classList.toggle("cb-help-popover-expanded");
      expandBtn.innerHTML = expanded ? minimizeSvg : maximizeSvg;
      expandBtn.title = expanded ? "Collapse" : "Expand";
    });

    pinBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const pinned = helpPopover.classList.toggle("cb-help-popover-pinned");
      pinBtn.classList.toggle("cb-help-action-btn-active", pinned);
      pinBtn.innerHTML = pinned ? pinOffSvg : pinSvg;
      pinBtn.title = pinned ? "Unpin" : "Pin";
    });

    helpActions.appendChild(expandBtn);
    helpActions.appendChild(pinBtn);
    helpToggle.appendChild(helpActions);

    const helpContent = document.createElement("div");
    helpContent.className = "cb-help-content";

    const brandedButtonName =
      __cb.hasFeature && __cb.hasFeature("internal_branding") ? "Quartz" : "Scoping";
    const instructionsHtml =
      '<div class="cb-help-section">' +
        '<div class="cb-help-section-title">Getting started</div>' +
        `<p>Open the canvas from the <strong>${brandedButtonName}</strong> button on any Clay table. Use the <strong>Enrichments tool</strong> in the toolbar to pick enrichments from the catalog, or <strong>Import Clay Table</strong> to pull in enrichments from an existing table.</p>` +
      '</div>' +
      '<div class="cb-help-section">' +
        '<div class="cb-help-section-title">Tools</div>' +
        '<p>The toolbar at the bottom has three modes: <strong>Navigate</strong> (select, drag, pan), <strong>Data Points</strong> (place data point cards), and <strong>Enrichments</strong> (place enrichment cards). Click the canvas to create cards when a tool is active.</p>' +
      '</div>' +
      '<div class="cb-help-section">' +
        '<div class="cb-help-section-title">Data Points</div>' +
        '<p>Data points represent the fields your customer wants. Click the canvas to add one. Hold modifier keys to create <strong>Input</strong> or <strong>Comment</strong> cards instead.</p>' +
      '</div>' +
      '<div class="cb-help-section">' +
        '<div class="cb-help-section-title">Enrichments</div>' +
        '<p>Enrichments are provider calls that return data points. Click the canvas to open the enrichment picker. You can also <strong>double-click a data point</strong> to add enrichments linked to it.</p>' +
      '</div>' +
      '<div class="cb-help-section">' +
        '<div class="cb-help-section-title">Linking, Grouping &amp; Waterfalls</div>' +
        '<p>Select multiple cards, then press <strong>Enter</strong> to snap-link them into a chain, <strong>Shift+Enter</strong> to group them, or <strong>Cmd+Enter</strong> to fold the selected enrichments into a single waterfall card. Groups display combined credit totals; waterfall cards average their providers\' costs.</p>' +
      '</div>' +
      '<div class="cb-help-section">' +
        '<div class="cb-help-section-title">Cost estimation</div>' +
        '<p>Enter a record count in the <strong>summary bar</strong> at the top to see total estimated credits and actions for your scope.</p>' +
      '</div>';

    const navTipsHtml =
      '<div class="cb-help-section">' +
        '<div class="cb-help-section-title">Navigate mode</div>' +
        '<div class="cb-help-shortcut-list">' +
          '<div class="cb-help-shortcut"><span class="cb-help-shortcut-keys"><kbd>Enter</kbd></span><span class="cb-help-shortcut-desc">Snap-link selected cards</span></div>' +
          '<div class="cb-help-shortcut"><span class="cb-help-shortcut-keys"><kbd>Shift</kbd>+<kbd>Enter</kbd></span><span class="cb-help-shortcut-desc">Group selected cards</span></div>' +
          '<div class="cb-help-shortcut"><span class="cb-help-shortcut-keys"><kbd>\u2318 Cmd</kbd>+<kbd>Enter</kbd></span><span class="cb-help-shortcut-desc">Fold selected ERs into a waterfall card</span></div>' +
          '<div class="cb-help-shortcut"><span class="cb-help-shortcut-keys"><kbd>Delete</kbd>/<kbd>\u232B</kbd></span><span class="cb-help-shortcut-desc">Remove cards or disband group</span></div>' +
          '<div class="cb-help-shortcut"><span class="cb-help-shortcut-keys">Right <kbd>Click</kbd></span><span class="cb-help-shortcut-desc">Context menu when multiple cards are selected</span></div>' +
          '<div class="cb-help-shortcut"><span class="cb-help-shortcut-keys">Right <kbd>Click</kbd> canvas</span><span class="cb-help-shortcut-desc">Recenter view on all cards</span></div>' +
        '</div>' +
      '</div>';

    const dpTipsHtml =
      '<div class="cb-help-section">' +
        '<div class="cb-help-section-title">Data Points mode</div>' +
        '<div class="cb-help-shortcut-list">' +
          '<div class="cb-help-shortcut"><span class="cb-help-shortcut-keys"><kbd>Shift</kbd> + <kbd>Click</kbd></span><span class="cb-help-shortcut-desc">Bulk (comma-separated)</span></div>' +
          '<div class="cb-help-shortcut"><span class="cb-help-shortcut-keys"><kbd>\u2325 Alt</kbd> + <kbd>Click</kbd></span><span class="cb-help-shortcut-desc">Create a comment card</span></div>' +
          '<div class="cb-help-shortcut"><span class="cb-help-shortcut-keys"><kbd>\u2318 Cmd</kbd> + <kbd>Click</kbd></span><span class="cb-help-shortcut-desc">Create an input card</span></div>' +
          '<div class="cb-help-shortcut"><span class="cb-help-shortcut-keys"><kbd>\u21E7 Shift</kbd> + <kbd>\u2318 Cmd</kbd> + <kbd>Click</kbd></span><span class="cb-help-shortcut-desc">Bulk input (comma-separated)</span></div>' +
          '<div class="cb-help-shortcut"><span class="cb-help-shortcut-keys">Double <kbd>Click</kbd> enrichment</span><span class="cb-help-shortcut-desc">Open bulk input next to it</span></div>' +
        '</div>' +
      '</div>';

    const erTipsHtml =
      '<div class="cb-help-section">' +
        '<div class="cb-help-section-title">Enrichments mode</div>' +
        '<div class="cb-help-shortcut-list">' +
          '<div class="cb-help-shortcut"><span class="cb-help-shortcut-keys">Double <kbd>Click</kbd> data point</span><span class="cb-help-shortcut-desc">Add enrichments linked to it</span></div>' +
        '</div>' +
      '</div>';

    const generalTipsHtml =
      '<div class="cb-help-section">' +
        '<div class="cb-help-section-title">General</div>' +
        '<div class="cb-help-shortcut-list">' +
          '<div class="cb-help-shortcut cb-help-shortcut-full"><span class="cb-help-shortcut-keys"><kbd>Space</kbd></span><span class="cb-help-shortcut-desc">Toggle this help panel</span></div>' +
          '<div class="cb-help-shortcut"><span class="cb-help-shortcut-keys"><kbd>1</kbd> <kbd>2</kbd> <kbd>3</kbd></span><span class="cb-help-shortcut-desc">Switch tool</span></div>' +
          '<div class="cb-help-shortcut"><span class="cb-help-shortcut-keys"><kbd>Esc</kbd></span><span class="cb-help-shortcut-desc">Navigate mode</span></div>' +
          '<div class="cb-help-shortcut"><span class="cb-help-shortcut-keys"><kbd>\u2318</kbd>+<kbd>Z</kbd></span><span class="cb-help-shortcut-desc">Undo</span></div>' +
          '<div class="cb-help-shortcut"><span class="cb-help-shortcut-keys"><kbd>\u2318</kbd>+<kbd>Shift</kbd>+<kbd>Z</kbd></span><span class="cb-help-shortcut-desc">Redo</span></div>' +
        '</div>' +
      '</div>';

    function buildTipsHtml(mode) {
      let section = navTipsHtml;
      if (mode === "dp") section = dpTipsHtml;
      else if (mode === "er") section = erTipsHtml;
      return section + generalTipsHtml;
    }

    helpContent.innerHTML = instructionsHtml;

    function setHelpTab(tab) {
      instructionsTab.classList.toggle("cb-help-tab-active", tab === "instructions");
      tipsTab.classList.toggle("cb-help-tab-active", tab === "tips");
      if (tab === "tips") {
        const canvas = __cb.canvas;
        const mode = getModeFromTool(canvas ? canvas.getActiveTool() : null);
        helpContent.innerHTML = buildTipsHtml(mode);
      } else {
        helpContent.innerHTML = instructionsHtml;
      }
    }

    instructionsTab.addEventListener("click", () => setHelpTab("instructions"));
    tipsTab.addEventListener("click", () => setHelpTab("tips"));

    helpBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const isOpen = helpPopover.classList.toggle("cb-help-popover-open");
      helpBtn.classList.toggle("cb-help-btn-open", isOpen);
    });

    __cb._closeHelpPopover = function (e) {
      if (helpPopover.classList.contains("cb-help-popover-pinned")) return;
      if (!helpWrap.contains(e.target)) {
        helpPopover.classList.remove("cb-help-popover-open");
        helpBtn.classList.remove("cb-help-btn-open");
      }
    };
    document.addEventListener("mousedown", __cb._closeHelpPopover);

    helpPopover.appendChild(helpToggle);
    helpPopover.appendChild(helpContent);
    helpWrap.appendChild(helpBtn);
    helpWrap.appendChild(helpPopover);
    mainArea.appendChild(helpWrap);

    __cb.overlayEl.appendChild(topBar);
    __cb.overlayEl.appendChild(summaryBar);
    __cb.overlayEl.appendChild(mainArea);
    document.body.appendChild(__cb.overlayEl);

    document.addEventListener("keydown", handleEscape);
    document.addEventListener("keydown", handleHelpKey);

    if (__cb.initCanvas) {
      __cb.canvas = __cb.initCanvas(canvasArea);
      // When canvas state changes (debounced), save AND refresh collaborators
      // so a contributor you just added shows up without manual reload.
      __cb.onCanvasStateChange = function () {
        __cb.debouncedSave();
        const ids = __cb.parseIdsFromUrl();
        if (ids && __cb.refreshCollaborators) {
          // Delay slightly past the save debounce so the server has the
          // updated contributor row before we re-query.
          setTimeout(() => __cb.refreshCollaborators(ids.workbookId), 800);
        }
        // Spreadsheet view re-derives every row from getCards/getSnapClusters,
        // so any add/remove/edit on the canvas (incl. picker confirms and
        // realtime card moves) propagates here. Cheap when unmounted (early
        // return inside refresh).
        if (__cb.tableView?.refresh) __cb.tableView.refresh();
      };
      __cb.setCanvasMode = setSelectedMode;
      setSelectedMode("navigate");
      updateToolButtons();
    }

    // Mount the collaborators widget in the top-right of the canvas area.
    // The widget positions itself absolutely; mainArea is position:relative.
    if (__cb.mountCollaboratorsWidget) {
      __cb.mountCollaboratorsWidget(mainArea);
      const ids = __cb.parseIdsFromUrl();
      if (ids) {
        // Register our presence before the first refresh so we appear in the
        // widget immediately, even if we haven't edited yet. userIdReady is
        // the one-shot /v3/me fetch kicked off at script init.
        (async () => {
          if (__cb.userIdReady) await __cb.userIdReady;
          if (__cb.markCanvasActivity) await __cb.markCanvasActivity(ids.workbookId);
          if (__cb.refreshCollaborators) __cb.refreshCollaborators(ids.workbookId);

          // Realtime: join the channel, mount the cursor overlay, hook up
          // the postgres-changes save sync. Doing this after userIdReady
          // ensures our presence is tagged with a real user, not "anon".
          if (__cb.realtime?.joinWorkbook) {
            await __cb.realtime.joinWorkbook(ids.workbookId, {
              user_id: __cb.userId,
              name: __cb.user?.name,
              profile_picture: __cb.user?.profilePicture,
            });
            if (__cb.installRealtimeCanvasSync) __cb.installRealtimeCanvasSync();
            if (__cb.installRealtimeTabSync) __cb.installRealtimeTabSync();
            const container = __cb.canvas?.getCardContainer?.();
            if (container && __cb.mountCursorsLayer) {
              __cb.mountCursorsLayer(container);
            }
            // Live card-level action streaming (Tier D): drags and text
            // edits propagate within ~100ms via the same channel.
            if (__cb.mountLiveActions) __cb.mountLiveActions();
          }
        })();
      }
    }

    // Broadcast our cursor position over the realtime channel. The throttle
    // (currently 20fps) lives inside __cb.realtime.broadcastCursor so this
    // listener can stay naive. We use capture-phase on canvasArea so it also
    // fires while we're dragging a card (the drag handler stops propagation
    // on the cards themselves).
    const cursorMoveHandler = (e) => {
      if (!__cb.realtime?.broadcastCursor || !__cb.canvas?.screenToCanvas) return;
      const pt = __cb.canvas.screenToCanvas(e.clientX, e.clientY);
      __cb.realtime.broadcastCursor(pt.x, pt.y);
    };
    canvasArea.addEventListener("mousemove", cursorMoveHandler, true);
    // Remember the handler so closeCanvas can detach it.
    __cb._cursorMoveHandler = cursorMoveHandler;
    __cb._cursorMoveTarget = canvasArea;

    __cb.onEnrichmentToolClick = function (x, y) {
      __cb.enrichmentClickPos = { x, y };
      __cb.startPickerMode();
    };

    __cb.onDpBulkInputForCard = function (cardId) {
      const card = __cb.canvas.getCardById(cardId);
      if (!card) return;
      const w = card.el.offsetWidth || 220;
      __cb.canvas.showBulkInput(card.x + w + 10, card.y);
    };

    const activeTab = __cb.tabStore.tabs.find(t => t.id === __cb.tabStore.activeId);

    // Resolve the per-tab Cards/Tables choice BEFORE restore so we know whether
    // to mount canvas DOM (lazy DOM, C2.2). Defaults to "table" — tabs saved
    // before this feature shipped won't carry the field, and the spreadsheet is
    // the canonical entry point. Canvas is allow-listed (see canUseCanvasView),
    // so a tab last left in "canvas" still opens as a table for locked users.
    let savedBrainstormView = activeTab?.state?.brainstormView === "canvas"
      ? "canvas"
      : "table";
    if (savedBrainstormView === "canvas" && !__cb.canUseCanvasView?.()) {
      savedBrainstormView = "table";
    }
    const mountCanvasDom = savedBrainstormView === "canvas";

    if (activeTab?.state && __cb.canvas) {
      // Table-view tabs restore data-only (mountDom:false) so the canvas
      // builds zero .cb-card elements; canvas-view tabs mount as before.
      __cb.model.restore(activeTab.state, { mountDom: mountCanvasDom });
      __cb.recordsActual = activeTab.state.recordsActual ?? null;
      __cb.useCaseScope = activeTab.state.useCaseScope ?? {};
      if (activeTab.state.records) {
        recordsInput.value = activeTab.state.records;
        recordsInput.dispatchEvent(new Event("input"));
      }
      if (activeTab.state.creditCost) {
        creditCostInput.value = activeTab.state.creditCost;
        creditCost = parseDollar(activeTab.state.creditCost);
      }
      if (activeTab.state.actionCost) {
        actionCostInput.value = activeTab.state.actionCost;
        actionCost = parseDollar(activeTab.state.actionCost);
      }
      if (activeTab.state.pricingExpanded) {
        pricingGroup.classList.add("is-expanded");
        chevronEl.classList.add("cb-chevron-open");
        pricingToggleText.textContent = "Hide";
      }
      // Restore global frequency. `skipSave` avoids kicking off a save for
      // state we just loaded — the first user interaction will save.
      setGlobalFrequency(activeTab.state.frequency || __cb.DEFAULT_FREQUENCY_ID, { skipSave: true });
      recalcTotal();
      applyRecordsState();
    }

    if (initialCards && initialCards.length > 0) {
      for (const card of initialCards) {
        if (__cb.canvas) {
          __cb.canvas.addCard(card);
        }
      }
    }

    // Pro Mode persists per-workbook in localStorage with a 1h TTL — see
    // readProModePreference in tabs.js. The preference is independent of
    // the saved canvas state: cards may have been laid out at one pitch
    // (saved on activeTab.state.proMode) but the user wants to reopen at
    // another. We mirror the manual setProMode toggle flow here: render
    // the cards at the SAVED pitch first so getSnapClusters reads the
    // right offsetHeight, then if target differs, capture clusters, flip
    // the attribute, and reflow Y positions to keep snap adjacency intact.
    const targetProMode = __cb.readProModePreference(__cb.currentWorkbookId);
    const restoredTab = __cb.tabStore.tabs.find(
      (t) => t.id === __cb.tabStore.activeId,
    );
    const savedProMode = !!restoredTab?.state?.proMode;

    if (savedProMode) __cb.overlayEl.setAttribute("data-cb-pro-mode", "");
    else __cb.overlayEl.removeAttribute("data-cb-pro-mode");
    __cb.proMode = savedProMode;

    if (!mountCanvasDom) {
      // Table-view tab (lazy DOM, C2.2): there is no canvas DOM to measure or
      // reflow, so skip all the snap/pitch geometry below. We still adopt the
      // target Pro Mode as state + attribute (the table view's coverage/fill
      // columns are gated on [data-cb-pro-mode]); cards mount at this pitch
      // when the canvas is hydrated on first toggle, so no Y-reflow is needed.
      __cb.proMode = targetProMode;
      if (targetProMode) __cb.overlayEl.setAttribute("data-cb-pro-mode", "");
      else __cb.overlayEl.removeAttribute("data-cb-pro-mode");
    } else if (savedProMode !== targetProMode) {
      const oldH = savedProMode ? 96 : 70;
      const newH = targetProMode ? 96 : 70;
      const clustersBefore = __cb.canvas?.getSnapClusters
        ? __cb.canvas.getSnapClusters()
        : null;

      __cb.proMode = targetProMode;
      if (targetProMode) __cb.overlayEl.setAttribute("data-cb-pro-mode", "");
      else __cb.overlayEl.removeAttribute("data-cb-pro-mode");

      if (clustersBefore && __cb.canvas?.applyClusterReflow) {
        // applyClusterReflow ends in a full refreshClusters at the new
        // pitch, so the relational cluster model is synced from
        // snap-derived geometry once cards have been re-positioned.
        __cb.canvas.applyClusterReflow(clustersBefore, oldH, newH);
      }
      if (__cb.canvas?.updateGroupBounds) __cb.canvas.updateGroupBounds();
      // Persist the reflowed positions + the new state.proMode so the
      // next reopen sees a saved pitch that already matches the
      // localStorage preference (no reflow needed on subsequent opens).
      if (__cb.debouncedSave) __cb.debouncedSave();
    } else if (__cb.canvas?.refreshClusters) {
      // Same-pitch open: canvas.restore ran refreshClusterVisuals only
      // (to avoid clobbering saved clusterIds at the wrong pitch), so
      // we need to drive a full snap-reconcile here now that the
      // attribute matches the saved layout. For legacy state this is
      // where the cluster model first gets populated from geometry;
      // for state with explicit clusterIds the snap-derivation
      // matches and IDs are preserved. Empty dragCardIds keeps any
      // saved cluster id that geometry happens to disagree with —
      // initial restore should be additive only.
      __cb.canvas.refreshClusters({ dragCardIds: new Set() });
    }

    // Rehydrate the Actual session picker from the tab's saved blob (DB) — no
    // fetch. Cards already carry their persisted spend; restore re-stamps from
    // the saved selection to stay consistent, and fills (reuse/fetch) any
    // imported table missing from the blob. Runs before setViewMode so Actual
    // mode reads a ready state.
    __cb.sessionCutoff?.restore?.(restoredTab?.state?.sessionCutoff);

    // Restore the multi-year pricing view (per-tab). closeCanvas does NOT reset
    // __cb.pricingMode and — unlike switchTab — openCanvas never re-applied it,
    // so reopening a canvas left in pricing mode produced a broken hybrid: the
    // stale __cb.pricingMode=true made the table render the pricing grid, but
    // the freshly-built overlay had no data-cb-pricing-mode="on" attribute (and
    // the summary bar lacked its pricing class), so the summary bar still showed
    // in its normal layout. Restore the data first, then setPricingMode (which
    // sets the attribute + summary class + the flag) BEFORE setBrainstormView
    // mounts the table, so the table mounts already consistent. The
    // tableView.refresh inside setPricingMode self-guards while unmounted.
    __cb.contractYears = Math.min(3, Math.max(1, activeTab?.state?.contractYears || 1));
    __cb.pricingYearRecords = activeTab?.state?.pricingYearRecords ?? {};
    __cb.pricingOptions = activeTab?.state?.pricingOptions ?? null;
    __cb.pricingTotalOverride = activeTab?.state?.pricingTotalOverride ?? { credits: {}, actionTier: {} };
    if (__cb.setPricingMode) {
      __cb.setPricingMode(!!activeTab?.state?.pricingMode);
    } else {
      __cb.pricingMode = !!activeTab?.state?.pricingMode;
    }

    // Seed the view from the active tab's saved mode (per-tab). Actual needs an
    // imported tab — fall back to Projected otherwise.
    let initialMode = activeTab?.state?.viewMode === "actual" ? "actual" : "projected";
    if (initialMode === "actual" && !(Number(__cb.recordsActual) > 0)) initialMode = "projected";
    __cb.setViewMode(initialMode);

    // savedBrainstormView was resolved before restore() (above) so we could
    // pick the lazy-DOM mount mode; apply it now.
    __cb.setBrainstormView(savedBrainstormView);

    window.addEventListener("beforeunload", __cb.saveTabs);
  };

  __cb.closeCanvas = function () {
    if (!__cb.overlayEl) return;
    // Stop the header-position watcher/resize listener set up in openCanvas.
    stopOverlayPositionWatch();
    window.removeEventListener("resize", onOverlayReposition);
    // Use the workbook the overlay was mounted for, not parseIdsFromUrl(): if
    // the user just navigated to a different workbook, the URL already points
    // at the new one but we still need to clean up the old workbook's flag.
    if (__cb.currentWorkbookId) {
      localStorage.removeItem(`cb-open-${__cb.currentWorkbookId}`);
    }
    __cb.saveTabs();
    __cb.cancelPendingSave();
    // Unmount the table view BEFORE destroying the canvas so the spreadsheet
    // doesn't try to re-render against an in-progress teardown via any
    // late-firing onCanvasStateChange callback.
    if (__cb.tableView?.unmount) __cb.tableView.unmount();
    if (__cb.canvas) {
      __cb.canvas.destroy();
      __cb.canvas = null;
    }
    // Tear down realtime in reverse order: detach the mousemove, unmount the
    // cursor overlay, unsubscribe from canvas updates, leave the channel.
    if (__cb._cursorMoveHandler && __cb._cursorMoveTarget) {
      __cb._cursorMoveTarget.removeEventListener("mousemove", __cb._cursorMoveHandler, true);
      __cb._cursorMoveHandler = null;
      __cb._cursorMoveTarget = null;
    }
    if (__cb.unmountLiveActions) __cb.unmountLiveActions();
    if (__cb.unmountCursorsLayer) __cb.unmountCursorsLayer();
    if (__cb.uninstallRealtimeCanvasSync) __cb.uninstallRealtimeCanvasSync();
    if (__cb.uninstallRealtimeTabSync) __cb.uninstallRealtimeTabSync();
    if (__cb.realtime?.leaveWorkbook) __cb.realtime.leaveWorkbook();
    if (__cb.unmountCollaboratorsWidget) __cb.unmountCollaboratorsWidget();
    __cb.overlayEl.remove();
    __cb.overlayEl = null;
    __cb.resetTabBar();
    __cb.updateCreditTotal = null;
    __cb.onCanvasStateChange = null;
    __cb.onEnrichmentToolClick = null;
    __cb.onDpBulkInputForCard = null;
    __cb.setCanvasMode = null;
    __cb.setProMode = null;
    __cb.setViewMode = null;
    __cb.buildViewModeToggle = null;
    __cb.setBrainstormView = null;
    __cb.brainstormView = "canvas";
    __cb.setGlobalFrequency = null;
    __cb.setUseCaseScope = null;
    __cb.getRecordsCount = null;
    __cb.getCreditCost = null;
    __cb.getActionCost = null;
    __cb.applyRecordsState = null;
    __cb.recordsActual = null;
    __cb.useCaseScope = {};
    __cb.actualLoading = false;
    __cb.actualSummaryNotice = null;
    __cb.actualSpendApplying = false;
    __cb.sessionCutoff?.invalidate?.();
    __cb.applyActualSummaryState = null;
    if (__cb.closeTotalCostEditor) __cb.closeTotalCostEditor();
    __cb.closeTotalCostEditor = null;
    __cb.proMode = false;
    __cb.viewMode = "projected";
    // Reset pricing-mode globals so a canvas reopened without a saved pricing
    // state (or before openCanvas re-applies it) doesn't inherit this session's
    // mode. openCanvas restores the real value from the active tab on open.
    __cb.pricingMode = false;
    __cb.currentFrequencyId = __cb.DEFAULT_FREQUENCY_ID;
    __cb.closeFrequencyPicker();
    closeMoreMenu();
    // Stop any POC poller and clear its state so the next canvas doesn't
    // inherit this one's spinner / in-flight conversation. setDustPocButtonState
    // is recreated per-open (it closes over the button), so we don't null it
    // here — resetPocState just clears the timer + in-memory state.
    if (__cb.resetPocState) __cb.resetPocState();
    __cb.enrichmentClickPos = null;
    window.removeEventListener("beforeunload", __cb.saveTabs);
    document.removeEventListener("keydown", handleEscape);
    document.removeEventListener("keydown", handleHelpKey);
    if (__cb._closeHelpPopover) {
      document.removeEventListener("mousedown", __cb._closeHelpPopover);
      __cb._closeHelpPopover = null;
    }
    __cb.currentWorkbookId = null;
    __cb.currentWorkspaceId = null;
  };

  // Scrolls a column into view inside Clay's grid (no navigation, no flash).
  // Shared by:
  //   1. src/table-focus.js — after a cross-table reload, replaying the
  //      `cb-focus-field` sentinel once the destination page mounts.
  //   2. __cb.openCardInTable's same-table soft path below — no reload needed.
  // Clay's own scrollToField right-aligns columns coming in from off-screen
  // right (apps/frontend/.../useGridScrollToPosition.ts); we override that by
  // left-aligning the column flush against the pinned strip. Waits (via a
  // MutationObserver, 10s safety cap) for the header to mount — covers both a
  // fresh page load and a virtualized column React Router scrolls into range.
  __cb.focusFieldInGrid = function (fieldId) {
    if (!fieldId) return;
    const HEADER_ID = `table-header-cell-${fieldId}`;
    const CONTAINER_ID = "grid-view-scroll-container";
    const PINNED_CONTAINER_ID = "table-header-pinned-fields-container";
    const POST_MOUNT_DELAY_MS = 200;
    const SAFETY_TIMEOUT_MS = 10000;

    function leftAlign() {
      const container = document.getElementById(CONTAINER_ID);
      const header = document.getElementById(HEADER_ID);
      if (!container || !header) return false;
      // Pinned (sticky) headers always sit in the pinned strip; scrolling
      // won't move them, so there's nothing to do (mirrors Clay's own
      // scrollTableHeaderCellIntoView pinned short-circuit).
      const isPinned = getComputedStyle(header).position === "sticky";
      if (!isPinned) {
        const pinned = document.getElementById(PINNED_CONTAINER_ID);
        const pinnedRight = pinned?.getBoundingClientRect().right ?? 0;
        const headerLeft = header.getBoundingClientRect().left;
        const amount = headerLeft - pinnedRight;
        if (Math.abs(amount) > 1) {
          const target = Math.max(0, container.scrollLeft + amount);
          container.scrollTo({ left: target, behavior: "auto" });
        }
      }
      return true;
    }

    let done = false;
    let observer = null;
    let safetyTimer = null;
    function finish() {
      if (done) return;
      done = true;
      if (observer) observer.disconnect();
      if (safetyTimer) clearTimeout(safetyTimer);
    }
    function attempt() {
      if (done) return;
      if (!document.getElementById(HEADER_ID)) return;
      // Defer past Clay's own ?fieldId= scroll cycle (React commit → effect →
      // scroll may straddle frames); 200ms clears it on every machine tested.
      setTimeout(() => {
        if (done) return;
        if (leftAlign()) finish();
      }, POST_MOUNT_DELAY_MS);
    }
    observer = new MutationObserver(attempt);
    observer.observe(document.body, { childList: true, subtree: true });
    safetyTimer = setTimeout(finish, SAFETY_TIMEOUT_MS);
    attempt();
  };

  // Reads the current table id out of the location path (…/tables/{id}/…).
  function currentTableIdFromUrl() {
    const parts = window.location.pathname.split("/");
    const idx = parts.indexOf("tables");
    return idx !== -1 ? parts[idx + 1] || null : null;
  }

  // Right-click → "Find in table" entry point. Navigates the tab to the source
  // view URL with `?fieldId=...`, which Clay's VirtualizedGrid
  // (apps/frontend/src/components/VirtualizedGrid) consumes via
  // useQuerySchemaActions to scroll the column into view. Only imported cards
  // carry both fieldId and tableId — earlier cards / picker-dropped cards
  // return early and the menu never appears for them anyway (the cards.js
  // guard checks the same fields before showing the menu).
  __cb.openCardInTable = function (card) {
    const data = card?.data;
    if (!data?.fieldId || !data?.tableId) return;
    const ids = __cb.parseIdsFromUrl();
    const workspaceId = ids?.workspaceId ?? __cb.currentWorkspaceId;
    const workbookId = __cb.currentWorkbookId ?? ids?.workbookId;
    if (!workspaceId || !workbookId) return;

    const base = `/workspaces/${workspaceId}/workbooks/${workbookId}/tables/${data.tableId}`;
    const url = data.viewId
      ? `${base}/views/${data.viewId}?fieldId=${encodeURIComponent(data.fieldId)}`
      : `${base}?fieldId=${encodeURIComponent(data.fieldId)}`;

    // Same-table jump: the extension is already overlaying this exact table, so
    // the grid (and the target column's neighborhood) is mounted. Soft-navigate
    // via History + popstate so React Router v5 picks up the new ?fieldId= and
    // runs scrollToField (handles virtualized off-screen columns) — no full page
    // reload — then left-align + flash in place via focusFieldInGrid.
    if (currentTableIdFromUrl() === data.tableId) {
      __cb.closeCanvas();
      try {
        window.history.pushState(window.history.state, "", url);
        window.dispatchEvent(new PopStateEvent("popstate"));
      } catch (_e) {
        // History API unavailable — fall back to a hard navigation.
        window.location.assign(url);
        return;
      }
      __cb.focusFieldInGrid(data.fieldId);
      return;
    }

    // Cross-table jump: stamp the hand-off sentinel and reload. table-focus.js
    // replays it (via focusFieldInGrid) once the destination page mounts. 10s
    // TTL guards against stale entries if the user navigates manually first.
    try {
      sessionStorage.setItem(
        "cb-focus-field",
        JSON.stringify({ fieldId: data.fieldId, ts: Date.now() })
      );
    } catch (_e) { /* private mode etc. — silently fall through */ }

    __cb.closeCanvas();
    window.location.assign(url);
  };

  // "Open function" entry point — jumps to a subroutine's referenced "main
  // function" table. The referenced table can live in a different workbook, so
  // we use the workspace-level table route (/workspaces/{ws}/tables/{tableId}),
  // which Clay resolves to the correct workbook + default view
  // (RedirectWithWorkbookId on ROUTES.table; apps/frontend/src/routes/Workspace.tsx).
  __cb.openReferencedTable = function (er) {
    const refId = er?.referencedTableId;
    if (!refId) return;
    const ids = __cb.parseIdsFromUrl();
    const workspaceId = ids?.workspaceId ?? __cb.currentWorkspaceId;
    if (!workspaceId) return;
    const url = `/workspaces/${workspaceId}/tables/${refId}`;
    __cb.closeCanvas();
    window.location.assign(url);
  };

  function handleEscape(e) {
    if (e.key !== "Escape") return;
    if (__cb.setCanvasMode) {
      __cb.setCanvasMode("navigate");
    } else if (__cb.canvas) {
      __cb.canvas.setActiveTool(null);
    }
  }

  function handleHelpKey(e) {
    if (e.key !== " " || e.repeat) return;
    const tag = e.target.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || e.target.isContentEditable) return;
    if (!__cb.overlayEl) return;
    const helpPopover = __cb.overlayEl.querySelector(".cb-help-popover");
    const helpBtn = __cb.overlayEl.querySelector(".cb-help-btn");
    if (!helpPopover || !helpBtn) return;
    const isOpen = helpPopover.classList.toggle("cb-help-popover-open");
    helpBtn.classList.toggle("cb-help-btn-open", isOpen);
  }
})();
