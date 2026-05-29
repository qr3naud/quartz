(function () {
  "use strict";

  const __cb = window.__cb;

  __cb.updateGroupButtonVisibility = function () {};

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

  // Kebab/overflow icon for the topbar "more" button. Three vertical dots
  // is the conventional affordance for "secondary options live here".
  const MORE_ICON_SVG =
    '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" ' +
    'fill="currentColor" aria-hidden="true">' +
    '<circle cx="12" cy="5"  r="1.6"/>' +
    '<circle cx="12" cy="12" r="1.6"/>' +
    '<circle cx="12" cy="19" r="1.6"/></svg>';

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

  let moreMenuEl = null;
  let moreMenuBackdrop = null;

  function closeMoreMenu() {
    if (moreMenuEl) { moreMenuEl.remove(); moreMenuEl = null; }
    if (moreMenuBackdrop) { moreMenuBackdrop.remove(); moreMenuBackdrop = null; }
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

    // View (Canvas / Tables) — leads the menu since "what am I looking at"
    // is the most fundamental choice. State pill shows the current view
    // name; clicking flips to the other and closes the menu, mirroring
    // the Pro Mode row's UX one level down.
    const inTable = __cb.brainstormView === "table";
    const currentViewLabel = inTable ? "Tables" : "Canvas";
    const otherViewLabel = inTable ? "Canvas" : "Tables";
    const viewItem = document.createElement("button");
    viewItem.type = "button";
    viewItem.className = "cb-export-menu-option cb-more-menu-option";
    viewItem.title = `Switch to the ${otherViewLabel.toLowerCase()} view`;
    viewItem.innerHTML =
      `<span class="cb-more-menu-icon">${SWAP_VIEW_ICON_SVG}</span>` +
      `<span class="cb-more-menu-label">View</span>` +
      `<span class="cb-more-menu-state">${currentViewLabel}</span>`;
    viewItem.addEventListener("click", (evt) => {
      evt.stopPropagation();
      closeMoreMenu();
      if (__cb.setBrainstormView) {
        __cb.setBrainstormView(inTable ? "canvas" : "table");
      }
    });
    moreMenuEl.appendChild(viewItem);

    // Pro Mode — always available. Renders as a toggle row: clicking
    // closes the menu and flips __cb.setProMode, which already handles
    // the cluster reflow + visual updates downstream.
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
    moreMenuEl.appendChild(proItem);

    // Old vs New Pricing — gated by the pricing_comparison feature flag,
    // same gate the standalone toolbar button used to carry. When the
    // flag is off the menu shrinks to a single Pro Mode row (still
    // useful — non-internal users get Pro Mode too).
    if (__cb.hasFeature?.("pricing_comparison") && __cb.startPricingComparison) {
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

    const clayHeader =
      document.querySelector("#clay-app header") ??
      document.querySelector("#clay-app nav") ??
      document.querySelector("#clay-app > div > div:first-child");
    if (clayHeader) {
      __cb.overlayEl.style.top = clayHeader.getBoundingClientRect().bottom + "px";
    }

    const topBar = document.createElement("div");
    topBar.className = "cb-topbar";

    const leftGroup = document.createElement("div");
    leftGroup.className = "cb-topbar-left";

    __cb.buildTabBar(leftGroup);

    const rightGroup = document.createElement("div");
    rightGroup.className = "cb-topbar-right";

    // Export button replaces the old "+ Add More" entry point. Click opens a
    // dropdown of export options the rep can run on the current scope. The
    // chevron is part of the button so it visually communicates "menu opens
    // here" the same way the model chip and frequency trigger do elsewhere.
    const exportBtn = document.createElement("button");
    exportBtn.className = "cb-toolbar-btn cb-toolbar-btn-primary cb-toolbar-export";
    exportBtn.type = "button";
    exportBtn.innerHTML =
      '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>' +
      '<span>Export</span>' +
      '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>';
    exportBtn.addEventListener("click", (evt) => {
      evt.stopPropagation();
      if (__cb.openExportMenu) __cb.openExportMenu(exportBtn);
    });

    const closeBtn = document.createElement("button");
    closeBtn.className = "cb-toolbar-btn cb-toolbar-close";
    closeBtn.textContent = "Close";
    closeBtn.addEventListener("click", __cb.closeCanvas);

    // Generate POC is constructed below inside its feature-flag block so
    // non-internal users don't allocate an unused DOM node. Declared
    // here as null and reassigned only when the feature is enabled.
    // Pro Mode + Old vs New Pricing used to live in this stretch as
    // standalone buttons; both now live inside the overflow menu the
    // kebab "more" button surfaces — see __cb.openMoreMenu above.
    let dustBtn = null;
    if (__cb.hasFeature?.("dust")) {
      // Generate POC — opens a small popover with a customer-name input and
      // POSTs to Dust to create a new conversation mentioning the POC agent.
      dustBtn = document.createElement("button");
      dustBtn.className = "cb-toolbar-btn cb-toolbar-dust-poc";
      dustBtn.type = "button";
      dustBtn.title = "Generate a POC scope in Dust for a customer";
      // Two icons live in the button: the sparkles glyph (default) and a
      // check (shown in the "done" state). CSS shows exactly one based on
      // the state class; the loading state hides both and draws a spinner
      // via ::before. Label is wrapped in <span> so the button's `gap` rule
      // has real flex children to space out (matches Export / Import).
      dustBtn.innerHTML =
        '<svg class="cb-toolbar-dust-poc-spark" xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l1.9 4.6L18.5 9l-4.6 1.9L12 15l-1.9-4.1L5.5 9l4.6-1.4L12 3z"/><path d="M19 15l.8 1.9L21.5 17.5l-1.7.6L19 20l-.8-1.9L16.5 17.5l1.7-.6L19 15z"/><path d="M5 14l.6 1.4L7 16l-1.4.6L5 18l-.6-1.4L3 16l1.4-.6L5 14z"/></svg>' +
        '<svg class="cb-toolbar-dust-poc-check" xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>' +
        "<span>Generate POC</span>";
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
      //   "idle"    → default sparkles, neutral toolbar styling
      // The button stays clickable in every state (we never set `disabled`)
      // so the rep can always open the popover to watch progress or grab the
      // finished doc link.
      __cb.setDustPocButtonState = function (state) {
        dustBtn.classList.toggle("cb-toolbar-dust-poc-loading", state === "loading");
        dustBtn.classList.toggle("cb-toolbar-dust-poc-done", state === "done");
      };
    }

    const importBtn = document.createElement("button");
    importBtn.className = "cb-toolbar-btn cb-toolbar-import";
    importBtn.innerHTML =
      '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>' +
      " Import from Table";
    importBtn.addEventListener("click", () => __cb.startImport(importBtn));

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

    // Canvas / Tables view switching lives inside the overflow ("more")
    // menu — see the View row in __cb.openMoreMenu above. The toolbar
    // doesn't carry a dedicated toggle button anymore; users open the
    // menu, pick the view they want, and the menu re-reads
    // __cb.brainstormView on each open so the state pill stays current.
    __cb.setBrainstormView = function (value) {
      const next = value === "table" ? "table" : "canvas";
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
        if (__cb.tableView?.unmount) __cb.tableView.unmount();
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
            // adjacencies, then push the moved positions through the
            // canonical save path.
            if (__cb.canvas.refreshClusters) {
              __cb.canvas.refreshClusters({ dragCardIds: new Set() });
            }
            if (__cb.canvas.updateGroupBounds) __cb.canvas.updateGroupBounds();
            if (__cb.canvas.notifyChange) __cb.canvas.notifyChange();
          }
        }
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

    // Projected / Actual mode toggle. "Projected" uses catalog credit costs
    // multiplied by record count (the existing behavior). "Actual" pulls
    // realtime credit usage from Redshift via /column/recent and sums the
    // observed spend. Source of truth lives on `__cb.viewMode` and
    // `tabStore.viewMode` so it survives reloads and tab switches. Visual
    // gating is CSS-driven via `[data-cb-view-mode]` on the overlay, AND
    // the toggle itself is hidden when Pro Mode is off (CSS rule in
    // overlay.css) — non-Pro users don't see the stat pills anyway.
    const viewModeWrap = document.createElement("div");
    viewModeWrap.className = "cb-view-mode-toggle";

    const viewModeProjected = document.createElement("button");
    viewModeProjected.className = "cb-view-mode-btn cb-view-mode-projected";
    viewModeProjected.type = "button";
    viewModeProjected.title = "Projected: catalog credits \u00d7 records";
    viewModeProjected.textContent = "Projected";

    const viewModeActual = document.createElement("button");
    viewModeActual.className = "cb-view-mode-btn cb-view-mode-actual";
    viewModeActual.type = "button";
    viewModeActual.title = "Actual: real spend from Clay's billing pipeline";
    viewModeActual.textContent = "Actual";

    viewModeWrap.appendChild(viewModeProjected);
    viewModeWrap.appendChild(viewModeActual);

    viewModeProjected.addEventListener("click", () => __cb.setViewMode("projected"));
    viewModeActual.addEventListener("click", () => __cb.setViewMode("actual"));

    __cb.setViewMode = function (value) {
      const next = value === "actual" ? "actual" : "projected";
      __cb.viewMode = next;
      if (__cb.overlayEl) __cb.overlayEl.setAttribute("data-cb-view-mode", next);
      viewModeProjected.classList.toggle("cb-view-mode-btn-active", next === "projected");
      viewModeActual.classList.toggle("cb-view-mode-btn-active", next === "actual");
      if (__cb.tabStore) __cb.tabStore.viewMode = next;
      // Re-run credit math so the summary boxes flip immediately.
      if (__cb.canvas?.refreshCreditTotal) {
        __cb.canvas.refreshCreditTotal();
      } else {
        recalcTotal();
      }
      if (__cb.canvas?.updateGroupCredits) __cb.canvas.updateGroupCredits();
      if (__cb.debouncedSave) __cb.debouncedSave();
    };

    rightGroup.appendChild(viewModeWrap);
    // Salesforce opportunity link — leads the action-button cluster
    // (Link opp → Generate POC → Import → Export). The element
    // internally swaps between a "Link opportunity" button and a
    // linked-opp pill ("Acme Inc — Q3 Expansion") based on the
    // canvases row's sfdc_opportunity_* columns. See src/sfdc.js for
    // the picker. The src/sfdc.js IIFE only assigns to __cb.sfdc when
    // the `sfdc` feature flag is on, so this `?.` check is the runtime
    // gate.
    if (__cb.sfdc?.buildToolbarElement) {
      const sfdcEl = __cb.sfdc.buildToolbarElement();
      rightGroup.appendChild(sfdcEl);
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
    rightGroup.appendChild(importBtn);
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

    // ---- Summary bar ----

    const summaryBar = document.createElement("div");
    summaryBar.className = "cb-summary-bar";

    const creditsBox = document.createElement("div");
    creditsBox.className = "cb-summary-box";
    const creditsLabel = document.createElement("span");
    creditsLabel.className = "cb-summary-label";
    creditsLabel.textContent = "Avg Credits / Row";
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
      if (opts?.skipSave) return;
      if (__cb.debouncedSave) __cb.debouncedSave();
    }

    // Exposed so tabs.js can reset the summary-bar frequency when the user
    // switches tabs. closeCanvas clears this again.
    __cb.setGlobalFrequency = setGlobalFrequency;

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

    const totalDollarBox = document.createElement("div");
    totalDollarBox.className = "cb-summary-box cb-pricing-card cb-pricing-total";
    const totalDollarLabel = document.createElement("span");
    totalDollarLabel.className = "cb-summary-label";
    totalDollarLabel.textContent = "Total Cost";
    const totalDollarValue = document.createElement("span");
    totalDollarValue.className = "cb-summary-value";
    totalDollarValue.id = "cb-total-dollar-value";
    totalDollarValue.textContent = "$0.00";
    totalDollarBox.appendChild(totalDollarLabel);
    totalDollarBox.appendChild(totalDollarValue);

    pricingGroup.appendChild(pricingToggleBox);
    pricingGroup.appendChild(creditCostBox);
    pricingGroup.appendChild(actionCostBox);
    pricingGroup.appendChild(totalDollarBox);

    summaryBar.appendChild(creditsBox);
    summaryBar.appendChild(actionsBox);
    summaryBar.appendChild(recordsBox);
    summaryBar.appendChild(freqBox);
    summaryBar.appendChild(totalBox);
    summaryBar.appendChild(totalActionsBox);
    summaryBar.appendChild(pricingGroup);

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

    function recalcTotal() {
      const records = parseRecordsValue();
      const isActual = __cb.viewMode === "actual";
      // Projected mode: totals = per-row × records.
      // Actual mode: totals come straight from credits.js (which sums
      // data.stats.spend across ER cards). The "weighted" slots already
      // hold absolute spend in actual mode, so we skip the multiplication.
      const totalCredits = isActual
        ? currentWeightedCreditsPerRow
        : currentWeightedCreditsPerRow * records;
      const totalActions = isActual
        ? currentWeightedActionsPerRow
        : currentWeightedActionsPerRow * records;
      totalValue.textContent = formatNumber(totalCredits);
      totalActionsValue.textContent = formatNumber(totalActions);

      const creditDollars = totalCredits * creditCost;
      const actionDollars = totalActions * actionCost;
      creditDollarValue.textContent = formatDollar(creditDollars);
      actionDollarValue.textContent = formatDollar(actionDollars);
      totalDollarValue.textContent = formatDollar(creditDollars + actionDollars);
    }

    function commitPricingInput(input, setter) {
      const parsed = parseDollar(input.value);
      setter(parsed);
      input.value = formatDollar(parsed);
      recalcTotal();
      if (__cb.canvas?.updateGroupCredits) {
        __cb.canvas.updateGroupCredits();
      }
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
      creditsValue.textContent = formatNumber(creditsPerRow);
      actionsValue.textContent = formatNumber(actionsPerRow);
      recalcTotal();
    };

    recordsInput.addEventListener("input", () => {
      const raw = recordsInput.value.replace(/[^\d]/g, "");
      const formatted = formatWithCommas(raw);
      const prevLen = recordsInput.value.length;
      const caretPos = recordsInput.selectionStart || 0;
      recordsInput.value = formatted;
      const diff = formatted.length - prevLen;
      recordsInput.setSelectionRange(caretPos + diff, caretPos + diff);
      recalcTotal();
      // Keep unedited DP card fill rates in sync with the records count
      // (editable popover values stay locked once the user has touched them).
      if (__cb.canvas?.updateDefaultFillRates) {
        __cb.canvas.updateDefaultFillRates(parseRecordsValue());
      }
      if (__cb.canvas?.updateGroupCredits) {
        __cb.canvas.updateGroupCredits();
      }
      applyRecordsState();
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
        `<p>Open the canvas from the <strong>${brandedButtonName}</strong> button on any Clay table. Use the <strong>Enrichments tool</strong> in the toolbar to pick enrichments from the catalog, or <strong>Import from Table</strong> to pull in enrichments from an existing table.</p>` +
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
    if (activeTab?.state && __cb.canvas) {
      __cb.canvas.restore(activeTab.state);
      __cb.recordsActual = activeTab.state.recordsActual ?? null;
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

    if (savedProMode !== targetProMode) {
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

    __cb.setViewMode(__cb.tabStore.viewMode || "projected");

    // Restore the per-tab Cards/Tables choice. Defaults to "table" — tabs
    // saved before this feature shipped won't carry the field, and the
    // spreadsheet is now the canonical entry point for scoping. Explicit
    // "canvas" choices the user made via the toggle are still respected.
    const savedBrainstormView = restoredTab?.state?.brainstormView === "canvas"
      ? "canvas"
      : "table";
    __cb.setBrainstormView(savedBrainstormView);

    window.addEventListener("beforeunload", __cb.saveTabs);
  };

  __cb.closeCanvas = function () {
    if (!__cb.overlayEl) return;
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
    __cb.setBrainstormView = null;
    __cb.brainstormView = "canvas";
    __cb.setGlobalFrequency = null;
    __cb.getRecordsCount = null;
    __cb.getCreditCost = null;
    __cb.getActionCost = null;
    __cb.applyRecordsState = null;
    __cb.recordsActual = null;
    __cb.proMode = false;
    __cb.viewMode = "projected";
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

  // Right-click → "Open in table" entry point. Closes the canvas overlay and
  // navigates the tab to the source view URL with `?fieldId=...`, which
  // Clay's VirtualizedGrid (apps/frontend/src/components/VirtualizedGrid)
  // consumes via useQuerySchemaActions to scroll the column into view. Only
  // imported cards carry both fieldId and tableId — earlier cards / picker-
  // dropped cards return early and the menu never appears for them anyway
  // (the cards.js guard checks the same fields before showing the menu).
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

    // Hand-off sentinel for src/table-focus.js on the destination page:
    // it left-aligns the column (overriding Clay's default right-aligned
    // scroll) and pulses an outline on the header so the user spots it
    // immediately. 10s TTL guards against stale entries if the user
    // navigates manually before the destination page loads.
    try {
      sessionStorage.setItem(
        "cb-focus-field",
        JSON.stringify({ fieldId: data.fieldId, ts: Date.now() })
      );
    } catch (_e) { /* private mode etc. — silently fall through */ }

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
