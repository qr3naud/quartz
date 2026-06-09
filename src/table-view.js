(function () {
  "use strict";

  const __cb = window.__cb;

  // The table view is a second presentation of the SAME canvas state — cards,
  // clusters, and groups continue to live on `__cb.canvas`. Mounting just
  // builds a sticky-header spreadsheet inside the host element; unmounting
  // empties it. `refresh()` re-renders rows from the current canvas snapshot
  // and is wired into `__cb.onCanvasStateChange` (in overlay.js) so picker
  // confirms, undo, realtime, etc. propagate without manual reloads.
  //
  // Mutation hooks delegate back into the canvas API:
  //   - DP name + fill-rate edits reuse the same writers the Export-as-Table
  //     modal uses (commitDpName / commitFillRate, defined here so the table
  //     view doesn't depend on src/export.js).
  //   - "+ Add data point" calls `__cb.canvas.addDataPointCard`.
  //   - "+ Add enrichment" sets `__cb.linkTargetCardId` then opens the
  //     enrichment picker; picker.js's existing placeCardsAdjacentTo flow
  //     drops the new ER cards next to the DP and calls refreshClusters,
  //     so the new chips appear on the row automatically.
  //   - Row × (DP) and chip × (orphan ER) call `__cb.canvas.removeCard`.

  let hostEl = null;
  let tableEl = null;
  // Store subscription (C3.5): while mounted, the table re-renders whenever the
  // model notifies (any store.update or store.restore), so it's a true store
  // subscriber rather than depending on the canvas's onCanvasStateChange.
  let modelUnsub = null;

  // Tracks which group sections are currently collapsed (Set<groupClusterId>).
  // Lives at module scope so re-renders triggered by canvas state changes
  // (picker confirms, undo, realtime updates) preserve the user's expand /
  // collapse choices instead of snapping every group back open. Cleared
  // implicitly when a group's cluster id disappears from the canvas — the
  // entries become orphan keys that buildRows() never reads.
  const collapsedGroups = new Set();

  // ---- Selection / drag / context menu state ----
  //
  // All transient — lives at module scope for the lifetime of one mount.
  // Cleared on unmount() so re-mounting starts fresh. Selection survives
  // refresh() for any rowId still present on the canvas; orphan ids are
  // dropped silently when applySelectionClasses runs against the new DOM.

  // rowId === cardId for DP / orphan-er rows; sectionKey ("g-{id}") for
  // group header rows. We keep them in the same set so range-select can
  // span row types without special-casing.
  const selectedRowIds = new Set();
  let selectionAnchorId = null;

  // Built fresh on every render() — ordered list of row identifiers that are
  // currently visible (skipping collapsed group bodies). Powers shift+click
  // range selection and drag drop-target resolution.
  let visibleRowOrder = [];

  // Built fresh on every render() — collapsible section keys split by tier so
  // the two-step "collapse" can close small (inner / sub-group) sections first
  // and only close the large (top-level block) sections on a second press.
  //   - renderedTopKeys: imported-table blocks, top-level group sections,
  //     "Other", orphan.
  //   - renderedInnerKeys: table sub-groups + canvas inner child sections.
  // Cmd+E (expand all) clears collapsedGroups entirely.
  let renderedTopKeys = new Set();
  let renderedInnerKeys = new Set();

  // ---- Inline search state ----
  //
  // A collapsed search affordance sits next to the collaborators widget in the
  // table header. It opens on click or Cmd/Ctrl+F, then does a live
  // case-insensitive substring match over DP names, ER chip labels, and group
  // header names. Matching rows get a gentle highlight; the active match is
  // scrolled into view. All state lives at module scope because render()
  // rebuilds the DOM from scratch — applySearchHighlight() re-runs after each
  // render so highlights survive re-renders (mirrors applySelectionClasses()).
  let searchOpen = false;
  let searchQuery = "";
  // Ordered list of matching row ids (strings, matching data-row-id) and the
  // index of the currently-active match for Enter / Shift+Enter cycling.
  let searchMatchIds = [];
  let searchActiveIdx = 0;

  // Drag-and-drop reorder. dragState is non-null only while the user is
  // actively dragging. dragInProgress also gates refresh() so a canvas
  // change mid-drag doesn't tear down the dragged row's DOM.
  let dragState = null;
  let dragInProgress = false;
  let dragMoveHandler = null;
  let dragUpHandler = null;
  let dropIndicatorEl = null;
  // Set true when a threshold drag promotes to a real block drag, so the
  // trailing click on the same gesture doesn't also select a row / toggle a
  // group. Consumed (and cleared) by the next onRowClick / group-toggle click.
  let suppressNextRowClick = false;

  // Context menu — single open instance at a time.
  let contextMenuEl = null;
  let contextMenuBackdrop = null;

  // Row note — body-level editor popover + hover preview, so neither is
  // clipped by the table container's overflow. Single instance each.
  let notePopoverEl = null;
  let notePopoverBackdrop = null;
  let notePreviewEl = null;

  // Run-share popover (the % badge on a multi-ER DP chip). Body-level so it
  // escapes the table's overflow clipping.
  let erShareMenuEl = null;
  let erShareMenuBackdrop = null;
  // Capture-phase outside-mousedown unbind for the run-share popover, so it
  // commits/closes even when the click lands on the ER details menu (which sits
  // a z-index tier above the popover's backdrop and would otherwise swallow it).
  let erShareMenuOutsideUnbind = null;

  // ER chip details menu — anchored popover opened by clicking an ER pill.
  // Single open instance at a time; lives at document.body level (like the
  // context menu) so it escapes the table's overflow clipping.
  let erChipMenuEl = null;
  let erChipMenuBackdrop = null;
  // Card id + preferred (pre-clamp) position of the open details menu, so it
  // can be re-rendered in place (keeping it open) when the table re-renders.
  let erChipMenuCardId = null;
  let erChipMenuPos = null;
  // When the details menu was opened from a multi-ER DP chip, the host DP's id —
  // so an in-place refresh (which rebuilds plain ER card data) can re-derive the
  // per-(DP,ER) run-share and keep the Run-share row alive + current.
  let erChipMenuShareDpId = null;
  // Grouped model picker spawned from the details-menu Model pill (AI columns).
  let erMenuModelPickerEl = null;
  let erMenuModelPickerBackdrop = null;
  let erMenuModelPickerOutsideUnbind = null;
  // "Use private key / use Clay credits" toggle spawned from the cost pill's
  // credit segment.
  let erMenuKeyToggleEl = null;
  let erMenuKeyToggleBackdrop = null;
  let erMenuKeyToggleOutsideUnbind = null;

  // Blue duotone key glyph copied verbatim from the canvas credit pill
  // (src/canvas/cards.js) so the table-view private-key toggle is pixel-identical.
  const KEY_TOGGLE_KEY_SVG =
    '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 256 256"><path fill="#3b82f6" d="M216.57,39.43A80,80,0,0,0,83.91,120.78L28.69,176A15.86,15.86,0,0,0,24,187.31V216a16,16,0,0,0,16,16H72a8,8,0,0,0,8-8V208H96a8,8,0,0,0,8-8V184h16a8,8,0,0,0,5.66-2.34l9.56-9.57A79.73,79.73,0,0,0,160,176h.1A80,80,0,0,0,216.57,39.43Z"/><path fill="#93c5fd" d="M224,98.1c-1.09,34.09-29.75,61.86-63.89,61.9H160a63.7,63.7,0,0,1-23.65-4.51,8,8,0,0,0-8.84,1.68L116.69,168H96a8,8,0,0,0-8,8v16H72a8,8,0,0,0-8,8v16H40V187.31l58.83-58.82a8,8,0,0,0,1.68-8.84A63.72,63.72,0,0,1,96,95.92c0-34.14,27.81-62.8,61.9-63.89A64,64,0,0,1,224,98.1ZM192,76a12,12,0,1,1-12-12A12,12,0,0,1,192,76Z"/></svg>';

  // After a Group action the new section's label input wants focus so the
  // user types the name immediately. We can't focus it synchronously
  // because render() hasn't run yet (it fires off notifyChange →
  // onCanvasStateChange). Stash the section key here and let the next
  // render pick it up + clear it.
  let pendingFocusGroupId = null;

  // DP names are static text by default (so a click selects the row). A
  // "Rename" context-menu action — or inserting a new DP — sets this to the
  // card id so the NEXT render renders that one row's name as a focused input.
  // Consumed + cleared in render() (mirrors pendingFocusGroupId).
  let pendingRenameCardId = null;

  // "Insert below → Enrichment" context: the target row's group, stashed before
  // opening the (unlinked) picker so the resulting orphan ER(s) can be dropped
  // into the same section as the target. Consumed + cleared by
  // placeInsertedEnrichments (the picker hook); cleared by the other picker
  // entry points so a cancelled insert can't misplace a later add.
  let pendingErInsertCtx = null;

  // ---- Row identity helpers ----
  //
  // The id types in play here:
  //   - Canvas cards have NUMERIC ids (canvas/index.js: nextCardId++).
  //     getCardById uses `===` so "5" !== 5 — comparisons must be numeric.
  //   - Section header rows use STRING keys ("g-5" for real cb-groups,
  //     "c-foo" for legacy comment-card sections, "__orphans__" for the
  //     unattached-enrichments section).
  //   - DOM data-row-id attributes are always strings (browser coerces).
  //   - selectedRowIds + visibleRowOrder always store strings (they
  //     originate from attachRowInteractionHandlers which passes
  //     String(row.cardId)).
  //
  // parseCardIdFromRowId normalizes at the canvas boundary: returns the
  // numeric card id for card rows, null for section header keys. EVERY
  // call into the canvas API from a row-id input must go through this
  // helper or the comparisons silently fail (manifests as "right-click
  // menu disabled even with rows selected", "Group does nothing", etc.).
  function parseCardIdFromRowId(rowId) {
    if (rowId == null) return null;
    const s = String(rowId);
    // Pure-digit string → numeric card id. Anything else (g-5 / c-foo /
    // __orphans__) is a section key, not a card id.
    if (!/^\d+$/.test(s)) return null;
    return Number(s);
  }

  function getCardForRowId(rowId) {
    const cardId = parseCardIdFromRowId(rowId);
    if (cardId == null) return null;
    return __cb.canvas?.getCardById?.(cardId) || null;
  }

  // Read the relational cluster id off a canvas card. Used by
  // buildDpRow to surface the membership in `data-cluster-id` so the
  // DOM mirrors the model. Returns null for unclustered cards (or any
  // missing card id).
  function getClusterIdForCardId(cardId) {
    if (cardId == null) return null;
    const card = __cb.canvas?.getCardById?.(cardId);
    return card?.clusterId ?? null;
  }

  // ---- Table-view ordering ----
  //
  // `card.tableOrder` is the source of truth for row order in the table
  // view. It's set by performDrop (drag-to-reorder) and survives reload
  // + realtime sync via persistence.js. Outside the table view, nothing
  // reads or writes it — the canvas keeps using card.x/card.y.
  //
  // Cards without a tableOrder (newly added, or pre-tableOrder legacy
  // state) fall back to y-sort, and sort AFTER cards that do have one
  // — so newly added rows naturally append below already-ordered ones
  // until the user reorders again. Mixed states resolve cleanly the
  // next time performDrop reassigns sequential ids over the section.
  //
  // Single comparator helper used everywhere we sort rows / blocks so
  // the precedence rule stays consistent. `getOrder(item)` returns the
  // item's tableOrder (or null), `getY(item)` returns its y fallback.
  function tableOrderForCardId(cardId) {
    if (cardId == null) return null;
    const card = __cb.canvas?.getCardById?.(cardId);
    return card?.tableOrder ?? null;
  }

  // Min tableOrder across a list of cards (skipping nulls). Returns
  // null when no member has a tableOrder. Used so a multi-card block
  // (snap-cluster, group) sorts at its earliest member's position.
  function tableOrderForCardIds(cardIds) {
    let min = null;
    for (const id of cardIds) {
      const o = tableOrderForCardId(id);
      if (o == null) continue;
      if (min == null || o < min) min = o;
    }
    return min;
  }

  function compareByTableOrderThenY(aOrder, aY, bOrder, bY) {
    if (aOrder != null && bOrder != null) return aOrder - bOrder;
    if (aOrder != null) return -1;
    if (bOrder != null) return 1;
    return aY - bY;
  }

  function isDpRowId(rowId) {
    const card = getCardForRowId(rowId);
    return !!card && card.data?.type === "dp";
  }

  function isErRowId(rowId) {
    const card = getCardForRowId(rowId);
    return !!card && isErType(card.data?.type);
  }

  function getDpRowsInSelection() {
    return [...selectedRowIds].filter(isDpRowId);
  }

  // Card rows in the current selection regardless of type — DPs AND
  // orphan ER rows alike. Used by Group / Link so reps can also bundle
  // unattached enrichments (or mix DPs + ERs in one operation, which
  // pulls the orphan ERs into the resulting snap-cluster).
  function getCardRowsInSelection() {
    return [...selectedRowIds].filter((rowId) => {
      const card = getCardForRowId(rowId);
      if (!card) return false;
      return card.data?.type === "dp" || isErType(card.data?.type);
    });
  }

  function getCardsForSelection() {
    return [...selectedRowIds].map(getCardForRowId).filter(Boolean);
  }

  // ---- Lineage-derived row blocks ----
  //
  // The table view associates a data point with the enrichment(s) it was
  // extracted from PURELY by lineage (`data.sourceEnrichmentFieldId`), never
  // by canvas geometry / clusters — so canvas snap/reconcile can never move
  // or re-bundle the table. These helpers are the single place that resolves
  // "which cards belong to this row's block" for drag-reorder + section
  // bucketing, replacing the old cluster-membership lookup.

  // Read-only lineage key for an enrichment card (action fieldId, or
  // `wf:<groupCluster>`; null when the ER has no key yet). Delegates to the
  // canvas's shared derivation so every surface agrees, with an inline
  // fallback for safety.
  function lineageKeyOf(card) {
    if (!card || !card.data) return null;
    if (__cb.canvas?.erLineageKeyOf) return __cb.canvas.erLineageKeyOf(card);
    if (!isErType(card.data.type)) return null;
    return card.data.type === "waterfall"
      ? (card.data.groupCluster != null ? `wf:${card.data.groupCluster}` : null)
      : (card.data.fieldId ?? null);
  }

  // Enrichment cards a data point points at via lineage (one or more).
  function erCardsForDp(dpCard) {
    const keys = __cb.dpErKeys(dpCard);
    if (keys.length === 0) return [];
    const keySet = new Set(keys);
    return __cb.model.getNodes().filter(
      (c) => isErType(c.data?.type) && keySet.has(lineageKeyOf(c)),
    );
  }

  // Data point cards that point at a given enrichment via lineage (a DP counts
  // if the ER's key is anywhere in the DP's link set).
  function dpCardsForEr(erCard) {
    const key = lineageKeyOf(erCard);
    if (key == null) return [];
    return __cb.model.getNodes().filter(
      (c) => c.data?.type === "dp" && __cb.dpErKeys(c).includes(key),
    );
  }

  // The set of card ids that move together as one table row unit: a data
  // point plus the enrichment(s) it's linked to (those ride along as chips on
  // the DP row), or an enrichment plus any DPs it feeds. Singletons return
  // [self]. Used by drag-reorder so reordering never reads canvas geometry.
  function getBlockForCard(cardId) {
    const card = __cb.canvas?.getCardById?.(cardId) || __cb.model.getNode?.(cardId);
    if (!card) return [cardId];
    if (card.data?.type === "dp") {
      return [card.id, ...erCardsForDp(card).map((c) => c.id)];
    }
    if (isErType(card.data?.type)) {
      return [card.id, ...dpCardsForEr(card).map((c) => c.id)];
    }
    return [card.id];
  }

  // ---- Selection mutators ----

  function setSelection(rowIds, anchor) {
    selectedRowIds.clear();
    for (const id of rowIds) selectedRowIds.add(id);
    selectionAnchorId = anchor ?? (rowIds.length > 0 ? rowIds[0] : null);
    applySelectionClasses();
  }

  function toggleSelection(rowId) {
    if (selectedRowIds.has(rowId)) {
      selectedRowIds.delete(rowId);
      if (selectionAnchorId === rowId) {
        selectionAnchorId = selectedRowIds.size > 0 ? [...selectedRowIds][0] : null;
      }
    } else {
      selectedRowIds.add(rowId);
      selectionAnchorId = rowId;
    }
    applySelectionClasses();
  }

  function extendSelectionTo(rowId) {
    if (!selectionAnchorId || visibleRowOrder.length === 0) {
      setSelection([rowId], rowId);
      return;
    }
    const a = visibleRowOrder.indexOf(selectionAnchorId);
    const b = visibleRowOrder.indexOf(rowId);
    if (a === -1 || b === -1) {
      setSelection([rowId], rowId);
      return;
    }
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    selectedRowIds.clear();
    for (let i = lo; i <= hi; i++) selectedRowIds.add(visibleRowOrder[i]);
    applySelectionClasses();
  }

  function clearSelection() {
    if (selectedRowIds.size === 0 && !selectionAnchorId) return;
    selectedRowIds.clear();
    selectionAnchorId = null;
    applySelectionClasses();
  }

  // Refresh the selection class on every visible row. Cheap — runs over the
  // currently-rendered <tr>s only. Called after any selection change and
  // after every render() so re-renders preserve the highlight.
  function applySelectionClasses() {
    if (!hostEl) return;
    const rows = hostEl.querySelectorAll("[data-row-id]");
    for (const row of rows) {
      const id = row.getAttribute("data-row-id");
      row.classList.toggle("cb-table-view-row-selected", selectedRowIds.has(id));
    }
    // The shared Enrichments cell is rowspanned onto the merge-first row only
    // (Credits/Actions now render per row), so a follower row's selection can't
    // reach it via the per-row class. Flag the first row when ANY row in its run
    // is selected so CSS can light up that shared ERs cell too.
    const firsts = hostEl.querySelectorAll("tr.cb-table-view-dp-row-merge-first");
    for (const first of firsts) {
      let anySel = first.classList.contains("cb-table-view-row-selected");
      let n = first.nextElementSibling;
      while (n && n.classList.contains("cb-table-view-dp-row-merge-follow")) {
        if (n.classList.contains("cb-table-view-row-selected")) anySel = true;
        n = n.nextElementSibling;
      }
      first.classList.toggle("cb-table-view-merge-run-selected", anySel);
    }
  }

  // Click handler factory for row <tr>s. We attach it on the row body and
  // rely on stopPropagation in inputs / chips / buttons (which they already
  // do for editing) so cell-level interactions don't accidentally toggle
  // the row selection.
  function onRowClick(rowId, evt) {
    // Right-click handled separately — bail out so contextmenu doesn't
    // race the click event for the selection state.
    if (evt.button !== 0) return;
    // Suppress the click that trails a drag-to-reorder gesture so it doesn't
    // also (re)select the dropped row.
    if (suppressNextRowClick) {
      suppressNextRowClick = false;
      return;
    }
    if (evt.shiftKey) {
      extendSelectionTo(rowId);
    } else if (evt.metaKey || evt.ctrlKey) {
      toggleSelection(rowId);
    } else {
      setSelection([rowId], rowId);
    }
  }

  // Document-level handlers installed once per mount(). Outside-clicks
  // clear the selection unless they're inside the table or the context
  // menu. Esc clears too.
  function onDocClick(evt) {
    if (!hostEl) return;
    if (contextMenuEl && contextMenuEl.contains(evt.target)) return;
    // Keep the selection only when the click lands on a real row; clicking the
    // empty table area or the chrome around it (inside or outside the host)
    // clears it, matching Escape. Inputs, chips, and body-mounted menu
    // backdrops stopPropagation on mousedown, so they never reach here.
    if (hostEl.contains(evt.target) && evt.target.closest("[data-row-id]")) return;
    clearSelection();
  }

  function onDocKeyDown(evt) {
    // Cmd/Ctrl+F opens the inline search and suppresses the browser's native
    // find bar — only while the table view is mounted, so we don't hijack
    // find on the rest of the Clay page.
    if ((evt.metaKey || evt.ctrlKey) && !evt.altKey && (evt.key === "f" || evt.key === "F")) {
      if (!hostEl) return;
      evt.preventDefault();
      evt.stopPropagation();
      openSearch();
      return;
    }
    // Cmd/Ctrl+E expands, Cmd/Ctrl+Shift+E collapses — both two-step: collapse
    // closes inner sections then top-level blocks; expand opens top-level blocks
    // then inner sections. Mirrors the Cmd+F gating so it only fires while the
    // table is mounted.
    if ((evt.metaKey || evt.ctrlKey) && !evt.altKey && (evt.key === "e" || evt.key === "E")) {
      if (!hostEl) return;
      evt.preventDefault();
      evt.stopPropagation();
      if (evt.shiftKey) collapseGroupsStep();
      else expandGroupsStep();
      return;
    }
    if (evt.key !== "Escape") return;
    // Search closes first so Esc dismisses the bar before clearing selection.
    if (searchOpen) {
      closeSearch();
      evt.preventDefault();
      return;
    }
    if (dragState) {
      cancelDrag();
      evt.preventDefault();
      return;
    }
    if (contextMenuEl) {
      closeContextMenu();
      evt.preventDefault();
      return;
    }
    if (selectedRowIds.size > 0) {
      clearSelection();
      evt.preventDefault();
    }
  }

  // ---- Expand / collapse all groups ----

  // Two-step collapse (Cmd+Shift+E and the collapse button): if any small/inner
  // section is still open, collapse all of those first; once every inner is
  // closed, a second press collapses the large/top-level blocks too.
  function collapseGroupsStep() {
    const innerOpen = [...renderedInnerKeys].some((k) => !collapsedGroups.has(k));
    if (innerOpen) {
      for (const k of renderedInnerKeys) collapsedGroups.add(k);
    } else {
      for (const k of renderedTopKeys) collapsedGroups.add(k);
    }
    render();
  }

  // Two-step expand (Cmd+E and the expand button) — the mirror of
  // collapseGroupsStep: if any large/top-level block is still closed, open all
  // of those first (revealing their inner section headers, which stay closed);
  // once every top-level block is open, a second press expands the small/inner
  // sections too.
  function expandGroupsStep() {
    const topClosed = [...renderedTopKeys].some((k) => collapsedGroups.has(k));
    if (topClosed) {
      for (const k of renderedTopKeys) collapsedGroups.delete(k);
    } else {
      for (const k of renderedInnerKeys) collapsedGroups.delete(k);
    }
    render();
  }

  // Two circular icon buttons (collapse + expand) mounted left of the search
  // control. Styling mirrors the search toggle; each gives a quick press
  // animation on click. Wired to the same logic as Cmd+Shift+E / Cmd+E.
  function buildGroupToggleControls() {
    const wrap = document.createElement("div");
    wrap.className = "cb-table-view-group-toggles";

    const mkBtn = (cls, title, aria, svg, onClick) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = `cb-table-view-group-toggle ${cls}`;
      btn.title = title;
      btn.setAttribute("aria-label", aria);
      btn.innerHTML = svg;
      btn.addEventListener("mousedown", (e) => e.stopPropagation());
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        // Replay the press animation on every click (not just the first).
        btn.classList.remove("cb-table-view-group-toggle-anim");
        void btn.offsetWidth;
        btn.classList.add("cb-table-view-group-toggle-anim");
        onClick();
      });
      btn.addEventListener("animationend", () =>
        btn.classList.remove("cb-table-view-group-toggle-anim"),
      );
      return btn;
    };

    wrap.appendChild(
      mkBtn(
        "cb-table-view-group-toggle-collapse",
        "Collapse groups (\u2318\u21E7E)",
        "Collapse groups",
        collapseAllSvg(15),
        () => (__cb.pricingMode ? pricingCollapseAll() : collapseGroupsStep()),
      ),
    );
    wrap.appendChild(
      mkBtn(
        "cb-table-view-group-toggle-expand",
        "Expand groups (\u2318E)",
        "Expand groups",
        expandAllSvg(15),
        () => (__cb.pricingMode ? pricingExpandAll() : expandGroupsStep()),
      ),
    );
    return wrap;
  }

  // Pricing mode: the collapse/expand-all buttons fold/unfold the use-case
  // boxes (state in __cb._pricingCollapsed, keyed by use-case key).
  function pricingCollapseAll() {
    const collapsed = (__cb._pricingCollapsed = __cb._pricingCollapsed || new Set());
    const ucs = __cb.cost?.computePricingUseCases?.({ viewMode: __cb.viewMode }) || [];
    for (const uc of ucs) collapsed.add(uc.key);
    render();
  }
  function pricingExpandAll() {
    if (__cb._pricingCollapsed) __cb._pricingCollapsed.clear();
    render();
  }

  // ---- Inline search ----

  // Builds the collapsed search control mounted next to the collaborators
  // widget. State is baked in from module scope so the control rebuilds in the
  // correct open/closed state on every render().
  function buildSearchControl() {
    const wrap = document.createElement("div");
    wrap.className = "cb-table-view-search";
    if (searchOpen) wrap.classList.add("cb-table-view-search-open");

    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "cb-table-view-search-toggle";
    toggle.title = "Search data points and enrichments (\u2318F)";
    toggle.setAttribute("aria-label", "Search the table");
    toggle.innerHTML = searchSvg(15);
    toggle.addEventListener("mousedown", (e) => e.stopPropagation());
    toggle.addEventListener("click", (e) => {
      e.stopPropagation();
      if (searchOpen) closeSearch();
      else openSearch();
    });
    wrap.appendChild(toggle);

    const field = document.createElement("div");
    field.className = "cb-table-view-search-field";
    // Keep clicks inside the field from bubbling to the row / document
    // handlers (which would clear selection or start a drag).
    field.addEventListener("mousedown", (e) => e.stopPropagation());
    field.addEventListener("click", (e) => e.stopPropagation());

    const input = document.createElement("input");
    input.type = "text";
    input.className = "cb-table-view-search-input";
    input.placeholder = "Search the table\u2026";
    input.value = searchQuery;
    input.addEventListener("input", () => {
      searchQuery = input.value;
      searchActiveIdx = 0;
      applySearchHighlight({ scroll: true });
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        gotoMatch(e.shiftKey ? -1 : 1);
      } else if (
        searchMatchIds.length > 0 &&
        (e.key === "ArrowDown" || e.key === "ArrowRight")
      ) {
        // Arrow navigation only kicks in once there are matches — otherwise
        // the arrows keep their normal text-cursor behavior in the input.
        e.preventDefault();
        gotoMatch(1);
      } else if (
        searchMatchIds.length > 0 &&
        (e.key === "ArrowUp" || e.key === "ArrowLeft")
      ) {
        e.preventDefault();
        gotoMatch(-1);
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        closeSearch();
      }
    });
    field.appendChild(input);

    const count = document.createElement("span");
    count.className = "cb-table-view-search-count";
    field.appendChild(count);

    const clearBtn = document.createElement("button");
    clearBtn.type = "button";
    clearBtn.className = "cb-table-view-search-clear";
    clearBtn.title = "Close search";
    clearBtn.setAttribute("aria-label", "Close search");
    clearBtn.innerHTML = xSvg(12);
    clearBtn.addEventListener("mousedown", (e) => e.stopPropagation());
    clearBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      closeSearch();
    });
    field.appendChild(clearBtn);

    wrap.appendChild(field);
    return wrap;
  }

  // ---- Pricing mode: View Bands control + per-year volume body -------------

  // Replaces the search affordance in pricing mode. Opens the internal-only
  // floating bands/approval overlay (src/pricing-bands.js). Deliberately a
  // separate click so the customer-facing view never shows floors/approval
  // until the GTME asks for them.
  function buildViewBandsControl() {
    const wrap = document.createElement("div");
    wrap.className = "cb-table-view-bands";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "cb-table-view-bands-toggle";
    btn.title = "View pricing bands + approval (internal only)";
    btn.innerHTML =
      '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>' +
      "<span>View Bands</span>";
    btn.addEventListener("mousedown", (e) => e.stopPropagation());
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (__cb.pricingBands?.toggle) __cb.pricingBands.toggle(btn);
    });
    wrap.appendChild(btn);
    return wrap;
  }

  // The multi-year pricing body (Summary + Options groups, per-use-case year
  // editors, band-matrix popovers) lives in src/pricing-view.js, exposed as
  // __cb.pricingView. It is loaded before this file in the manifest and reaches
  // back via __cb._tvRender (raw re-render), __cb._tvHelpers (shared glyphs), and
  // __cb.buildCostBadges. Entry point: __cb.pricingView.buildPricingBody().

  // Focuses the search input within the currently-mounted control, if any.
  function focusSearchInput() {
    if (!hostEl) return;
    const input = hostEl.querySelector(".cb-table-view-search-input");
    if (input) {
      input.focus();
      input.select();
    }
  }

  function openSearch() {
    if (!hostEl) return;
    searchOpen = true;
    const wrap = hostEl.querySelector(".cb-table-view-search");
    if (wrap) {
      // Expand the existing control in place — avoids a full render() so the
      // focus lands cleanly and the open animation runs.
      wrap.classList.add("cb-table-view-search-open");
      focusSearchInput();
      applySearchHighlight({ scroll: true });
    } else {
      // Control not in the DOM yet (shouldn't normally happen) — rebuild,
      // then focus once the new DOM is in place.
      render();
      focusSearchInput();
    }
  }

  function closeSearch() {
    searchOpen = false;
    searchQuery = "";
    searchMatchIds = [];
    searchActiveIdx = 0;
    if (!hostEl) return;
    const wrap = hostEl.querySelector(".cb-table-view-search");
    if (wrap) wrap.classList.remove("cb-table-view-search-open");
    const input = hostEl.querySelector(".cb-table-view-search-input");
    if (input) input.value = "";
    clearSearchHighlight();
    updateSearchCount();
  }

  function clearSearchHighlight() {
    if (!hostEl) return;
    const marked = hostEl.querySelectorAll(
      ".cb-table-view-row-search-match, .cb-table-view-row-search-active",
    );
    for (const el of marked) {
      el.classList.remove("cb-table-view-row-search-match");
      el.classList.remove("cb-table-view-row-search-active");
    }
  }

  function updateSearchCount() {
    if (!hostEl) return;
    const countEl = hostEl.querySelector(".cb-table-view-search-count");
    if (!countEl) return;
    if (!searchQuery.trim() || searchMatchIds.length === 0) {
      countEl.textContent = searchQuery.trim() ? "0/0" : "";
    } else {
      countEl.textContent = `${searchActiveIdx + 1}/${searchMatchIds.length}`;
    }
  }

  // Reads the searchable text for one body row: the DP name, every ER chip
  // label, and the group header label. Lowercased for case-insensitive match.
  function rowSearchText(tr) {
    const parts = [];
    const dpName = tr.querySelector(".cb-table-view-dp-name");
    if (dpName) parts.push(dpName.textContent || "");
    const groupLabel = tr.querySelector(".cb-table-view-group-row-label");
    if (groupLabel) parts.push(groupLabel.textContent || "");
    const chipLabels = tr.querySelectorAll(".cb-table-view-er-chip-label");
    for (const c of chipLabels) parts.push(c.textContent || "");
    return parts.join(" \u0001 ").toLowerCase();
  }

  // Highlights every row whose searchable text contains the query, tracks the
  // ordered match list, and (optionally) scrolls the active match into view.
  function applySearchHighlight(opts = {}) {
    if (!hostEl) return;
    clearSearchHighlight();
    const q = searchQuery.trim().toLowerCase();
    if (!q) {
      searchMatchIds = [];
      searchActiveIdx = 0;
      updateSearchCount();
      return;
    }
    const rows = hostEl.querySelectorAll("tbody tr[data-row-id]");
    const matchIds = [];
    for (const tr of rows) {
      if (rowSearchText(tr).includes(q)) {
        tr.classList.add("cb-table-view-row-search-match");
        matchIds.push(tr.getAttribute("data-row-id"));
      }
    }
    searchMatchIds = matchIds;
    if (searchActiveIdx >= matchIds.length) searchActiveIdx = 0;
    markActiveMatch(opts.scroll === true);
    updateSearchCount();
  }

  // Applies the "active" class to the current match and optionally scrolls it
  // into view. No-op when there are no matches.
  function markActiveMatch(scroll) {
    if (!hostEl) return;
    const prev = hostEl.querySelector(".cb-table-view-row-search-active");
    if (prev) prev.classList.remove("cb-table-view-row-search-active");
    if (searchMatchIds.length === 0) return;
    const id = searchMatchIds[searchActiveIdx];
    const row = hostEl.querySelector(`tbody tr[data-row-id="${id}"]`);
    if (!row) return;
    row.classList.add("cb-table-view-row-search-active");
    if (scroll) scrollRowIntoView(row);
  }

  // Scrolls a row into the table viewport while accounting for the sticky
  // <thead> (top: 0) — a plain scrollIntoView({ block: "nearest" }) would
  // leave the row tucked partially under the sticky header. Only scrolls when
  // the row is actually outside the visible band so an in-view active match
  // doesn't jump.
  function scrollRowIntoView(row) {
    const container = hostEl && hostEl.querySelector(".cb-table-view-table-container");
    if (!container) {
      row.scrollIntoView({ block: "nearest", behavior: "smooth" });
      return;
    }
    const thead = container.querySelector("thead");
    const headerH = thead ? thead.getBoundingClientRect().height : 0;
    const margin = 1;
    const cRect = container.getBoundingClientRect();
    const rRect = row.getBoundingClientRect();
    const rowTop = rRect.top - cRect.top + container.scrollTop;
    const rowBottom = rowTop + rRect.height;
    const viewTop = container.scrollTop + headerH;
    const viewBottom = container.scrollTop + container.clientHeight;
    if (rowTop < viewTop) {
      container.scrollTo({ top: Math.max(0, rowTop - headerH - margin), behavior: "smooth" });
    } else if (rowBottom > viewBottom) {
      container.scrollTo({ top: rowBottom - container.clientHeight + margin, behavior: "smooth" });
    }
  }

  // Advances the active match by delta (wrapping) and scrolls to it.
  function gotoMatch(delta) {
    if (searchMatchIds.length === 0) return;
    const n = searchMatchIds.length;
    searchActiveIdx = ((searchActiveIdx + delta) % n + n) % n;
    markActiveMatch(true);
    updateSearchCount();
  }

  // Sentinel key for the "Other" pseudo-section at the very bottom — the
  // unscoped parking lot that wraps un-grouped (flat) DP rows AND unattached
  // enrichments (orphan ERs with no DP). Treated like any other group id by
  // collapsedGroups so the rep's expand / collapse choice survives re-renders.
  const OTHER_SECTION_KEY = "__other__";

  // ---- Card-type helpers (mirror src/export.js) ----

  function isNonErType(type) {
    return type === "dp" || type === "input" || type === "comment";
  }

  // Anything that isn't a DP / input / comment is an ER. Note: action cards
  // added via the picker (extractVisualData) intentionally leave `data.type`
  // unset — that's the established convention used in src/export.js
  // (`!isNonErType(c.data.type)`) and in addCard's frequency-seeding path
  // (cards.js line 565, also `!isNonErType(...)`). The previous version
  // here added an extra `type !== undefined` clause that broke that
  // convention: picker-added enrichments slipped through as "non-ER",
  // which meant clicking "Add enrichment" from a DP row produced a card
  // that sat in the cluster but never got listed in the row's chip column.
  function isErType(type) {
    return !isNonErType(type);
  }

  function fillRatePct(fr) {
    if (!fr || !fr.denominator) return 0;
    return Math.round((fr.numerator / fr.denominator) * 100);
  }

  // Coverage = how many times the enrichment behind a data point attempted to
  // run (stats.coverage.ran), out of the table's total rows (coverage.total).
  // Returns { ratio, pct } for the table-view Coverage column, or null when
  // the data point has no run-status-backed coverage (manual DPs, basic
  // columns without runstatus).
  function coverageInfo(cov) {
    if (!cov || !Number(cov.total)) return null;
    const ran = Number(cov.ran) || 0;
    const total = Number(cov.total) || 0;
    return {
      ratio: `${ran.toLocaleString()} / ${total.toLocaleString()}`,
      pct: Math.round((ran / total) * 100),
    };
  }

  // Mode-aware coverage + fill descriptors for a row.
  //   Coverage is per ENRICHMENT (erCard): projected = editable rows (default
  //   total rows, drives cost); actual = real run attempts / total.
  //   Fill is per DATA POINT (dpCard, optional): projected = editable %;
  //   actual = nonNull(from nullPercentage) / ER attempts, with a loading flag
  //   while the full-table profile is still being fetched.
  // The record count an ER's coverage divides against by default: ITS use case's
  // records (per imported table) — not the global Records input, which the most
  // recent import overwrites (so otherwise every table would inherit the last
  // table's count). Falls back to the global count for non-table ("other") cards.
  function erDefaultRecords(erCard) {
    const cb = window.__cb;
    const globalRows = Number(cb?.getRecordsCount?.()) || Number(cb?.recordsActual) || 0;
    if (erCard && cb?.cost?.useCaseRecords && cb?.cost?.useCaseKeyForCard) {
      const r = Number(cb.cost.useCaseRecords(cb.cost.useCaseKeyForCard(erCard)));
      if (r > 0) return r;
    }
    return globalRows;
  }

  // Actual fill % for a data point measured against its (widest) linked
  // enrichment. Single source of truth shared by the table's Actual fill cell
  // (coverageFillFor) and the "Copy coverage & fill from Actual" routine so the
  // copied value always equals what the user sees. Returns one of:
  //   { loading: true }  full-table null% profile still in flight
  //   { pct: <0..100> }  computed actual fill
  //   { pct: null }      no usable signal (no null% / no records)
  function actualFillPct(erCard, dpCard) {
    const cb = window.__cb;
    if (!dpCard) return { pct: null };
    if (cb?.fullProfilePending?.has?.(dpCard.data.tableId)) return { loading: true };
    const np = dpCard.data.stats?.nullPercentage;
    const tot = Number(dpCard.data.stats?.totalRecords) || 0;
    if (np == null || tot <= 0) return { pct: null };
    const nonNull = ((100 - Number(np)) / 100) * tot;
    // Fill divides by rows ATTEMPTED (not coverage.ran, which is now
    // success-only) so the fill % is unchanged by the success-only coverage
    // numerator.
    const cov = erCard?.data?.stats?.coverage;
    const attempted = Number(cov?.attempted ?? cov?.ran) || 0;
    const denom = attempted > 0 ? attempted : tot;
    // `nonNull` / `denom` are surfaced so the table's Fill cell can show the
    // underlying ratio on hover (a bare "1%" is opaque; "~10 / 789" is not).
    return {
      pct: Math.min(100, Math.max(0, Math.round((nonNull / denom) * 100))),
      nonNull: Math.round(nonNull),
      denom,
    };
  }

  function coverageFillFor(erCard, dpCard) {
    const cb = window.__cb;
    const actual = cb?.viewMode === "actual";
    const totalRows = erDefaultRecords(erCard);

    let coverage;
    if (actual) {
      const cov = erCard?.data?.stats?.coverage;
      coverage = cov && Number(cov.total) > 0
        ? { mode: "actual", ran: Number(cov.ran) || 0, total: Number(cov.total) || 0 }
        : { mode: "actual", ran: null, total: null };
    } else {
      const rows = erCard ? (erCard.data.coverageRows ?? totalRows) : totalRows;
      // Per-ER "attempted total" (the division denominator). Defaults to (and
      // tracks) the global Records total until the rep overrides it on this ER;
      // editing it never changes global Records.
      const total = erCard?.data?.coverageTotalCustom
        ? Number(erCard.data.coverageTotal) || 0
        : totalRows;
      coverage = {
        mode: "projected",
        rows,
        total,
        editable: !!erCard,
        locked: !!erCard?.data?.coverageLocked,
        erCardId: erCard ? erCard.id : null,
      };
    }

    let fill = null;
    if (dpCard) {
      if (actual) {
        const af = actualFillPct(erCard, dpCard);
        fill = af.loading
          ? { mode: "actual", loading: true }
          : {
              mode: "actual",
              pct: af.pct,
              // Ratio + the enrichment that defines the denominator, for the
              // Fill cell's hover tooltip (see buildFillCell). The ER's display
              // name lives on displayName/text (mirrors buildErChipData).
              nonNull: af.nonNull,
              denom: af.denom,
              denomLabel: erCard?.data?.displayName || erCard?.data?.text || null,
            };
      } else {
        fill = { mode: "projected", pct: fillRatePct(dpCard.data.fillRate) };
      }
    }
    return { coverage, fill };
  }

  // Resolve an ER's current projected coverage pair: X = coverageRows (rows that
  // run, drives cost), Y = coverageTotal (attempted total). Both default to /
  // track the global records total, mirroring coverageFillFor.
  function erCoveragePair(er) {
    const records = erDefaultRecords(er);
    const x = er.data.coverageRows != null ? Number(er.data.coverageRows) : records;
    const y = er.data.coverageTotalCustom
      ? Number(er.data.coverageTotal) || 0
      : records;
    return { x, y };
  }

  // Commit a projected coverage edit on an ER. `field` is "rows" (X, the cost
  // driver) or "total" (Y, the display denominator). Two invariants:
  //   - X never exceeds Y (you can't run more rows than exist).
  //   - When the ER's ratio is locked (coverageLocked), editing one value
  //     rescales the OTHER to preserve X/Y (rounded), so the % stays put.
  // Coverage lives only on the ER, so one write syncs every DP row + the shared
  // projected cost on the next refresh.
  function commitErCoverageEdit(erCardId, field, value) {
    const cb = window.__cb;
    const er = (cb.canvas?.getCards?.() || []).find((c) => c.id === erCardId);
    if (!er) return;
    const n = Math.max(0, Math.round(Number(String(value).replace(/[^\d]/g, "")) || 0));
    const { x: oldX, y: oldY } = erCoveragePair(er);
    const locked = !!er.data.coverageLocked && oldX > 0 && oldY > 0;

    if (field === "rows") {
      let x = n;
      if (locked) {
        // Preserve X/Y: scale Y with X. ratio <= 1 so Y >= X holds.
        er.data.coverageTotal = Math.max(1, Math.round(x * (oldY / oldX)));
        er.data.coverageTotalCustom = true;
      } else if (oldY > 0) {
        x = Math.min(x, oldY); // clamp numerator <= denominator
      }
      er.data.coverageRows = x;
      er.data.coverageCustom = true;
    } else {
      const y = n;
      if (locked) {
        er.data.coverageRows = Math.max(0, Math.round(y * (oldX / oldY)));
        er.data.coverageCustom = true;
      } else if (oldX > y) {
        er.data.coverageRows = y; // numerator can't exceed the new denominator
        er.data.coverageCustom = true;
      }
      er.data.coverageTotal = y;
      er.data.coverageTotalCustom = true;
    }
    cb.canvas?.refreshCreditTotal?.();
    cb.canvas?.updateGroupCredits?.();
    cb.canvas?.notifyChange?.();
    cb.tableView?.refresh?.();
  }

  // Toggle the per-ER coverage ratio lock. When on, commitErCoverageEdit keeps
  // X/Y constant as either value changes.
  function setErCoverageLocked(erCardId, locked) {
    const cb = window.__cb;
    const er = (cb.canvas?.getCards?.() || []).find((c) => c.id === erCardId);
    if (!er) return;
    er.data.coverageLocked = !!locked;
    cb.canvas?.notifyChange?.();
    cb.tableView?.refresh?.();
  }

  // Toggle an enrichment's "frozen" state. A frozen ER is deactivated for
  // scoping: its cost is zeroed everywhere (perRowCost short-circuits on
  // data.frozen), the table greys its pill, and a row greys fully when all its
  // enrichments are frozen. Lets a GTME see the savings from dropping an ER.
  // Cost changed, so refresh the summary + group credits, not just the table.
  function toggleErFrozen(erCardId) {
    const cb = window.__cb;
    const er = (cb.canvas?.getCards?.() || []).find((c) => c.id === erCardId);
    if (!er) return;
    er.data.frozen = !er.data.frozen;
    cb.canvas?.refreshCreditTotal?.();
    cb.canvas?.updateGroupCredits?.();
    cb.canvas?.notifyChange?.();
    cb.tableView?.refresh?.();
  }

  // Renders a Coverage <td> from a coverage descriptor (see coverageFillFor).
  function buildCoverageCell(coverage) {
    const td = document.createElement("td");
    if (coverage && coverage.mode === "projected" && coverage.editable) {
      td.className = "col-coverage";
      // Editable division: [rows] / [attempted total], both per-ER. Mirrors the
      // Actual mode "ran / total" so the two modes read the same.
      const wrap = document.createElement("div");
      wrap.className = "cb-table-view-cov-edit";

      const mkInput = (val, title, onCommit) => {
        const input = document.createElement("input");
        input.type = "number";
        input.min = "0";
        input.step = "1";
        input.className = "cb-table-view-cell-input cb-table-view-cell-input-num";
        input.value = val != null ? String(val) : "";
        input.title = title;
        input.addEventListener("mousedown", (e) => e.stopPropagation());
        input.addEventListener("click", (e) => e.stopPropagation());
        input.addEventListener("keydown", (e) => { if (e.key === "Enter") e.target.blur(); });
        input.addEventListener("blur", () => onCommit(input.value));
        return input;
      };

      wrap.appendChild(
        mkInput(coverage.rows, "Rows this enrichment runs on (drives projected cost)",
          (v) => commitErCoverageEdit(coverage.erCardId, "rows", v)),
      );
      const sep = document.createElement("span");
      sep.className = "cb-table-view-cov-sep";
      sep.textContent = "/";
      wrap.appendChild(sep);
      wrap.appendChild(
        mkInput(coverage.total, "Attempted total for this enrichment (defaults to total records)",
          (v) => commitErCoverageEdit(coverage.erCardId, "total", v)),
      );

      // Ratio lock: when on, editing rows or total keeps the same % (the other
      // value rescales + rounds). Amber when locked.
      const lockBtn = document.createElement("button");
      lockBtn.type = "button";
      lockBtn.className =
        "cb-table-view-cov-lock" + (coverage.locked ? " cb-table-view-cov-lock-on" : "");
      lockBtn.title = coverage.locked
        ? "Coverage ratio locked \u2014 editing rows or total keeps the same %"
        : "Lock the coverage ratio";
      lockBtn.innerHTML = lockSvg(!!coverage.locked);
      lockBtn.addEventListener("mousedown", (e) => e.stopPropagation());
      lockBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        setErCoverageLocked(coverage.erCardId, !coverage.locked);
      });
      wrap.appendChild(lockBtn);

      const denom = Number(coverage.total) || 0;
      if (denom > 0) {
        td.title = `${Math.min(100, Math.round(((Number(coverage.rows) || 0) / denom) * 100))}% of rows attempted`;
      }
      td.appendChild(wrap);
    } else if (coverage && coverage.mode === "projected") {
      td.className = "col-coverage cb-table-view-cell-readonly";
      td.textContent = coverage.rows ? Number(coverage.rows).toLocaleString() : "\u2014";
    } else if (coverage && coverage.mode === "actual" && coverage.total) {
      td.className = "col-coverage";
      // Mirror the Projected division's structure + box metrics so toggling
      // modes doesn't shift the numbers, and the "/" reads grey like Projected.
      const wrap = document.createElement("div");
      wrap.className = "cb-table-view-cov-edit";
      const mkRo = (n) => {
        const s = document.createElement("span");
        s.className = "cb-table-view-cell-num-ro";
        s.textContent = Number(n || 0).toLocaleString();
        return s;
      };
      const sep = document.createElement("span");
      sep.className = "cb-table-view-cov-sep";
      sep.textContent = "/";
      wrap.appendChild(mkRo(coverage.ran));
      wrap.appendChild(sep);
      wrap.appendChild(mkRo(coverage.total));
      td.title = `${Math.round(((coverage.ran || 0) / coverage.total) * 100)}% of rows succeeded`;
      td.appendChild(wrap);
    } else {
      td.className = "col-coverage cb-table-view-cell-muted";
      td.textContent = "\u2014";
    }
    return td;
  }

  // Renders a Fill rate <td> from a fill descriptor (see coverageFillFor).
  function buildFillCell(fill, cardId) {
    const td = document.createElement("td");
    if (fill && fill.mode === "projected") {
      td.className = "col-fill";
      const input = document.createElement("input");
      input.type = "number";
      input.min = "0";
      input.max = "100";
      input.step = "1";
      input.className = "cb-table-view-cell-input cb-table-view-cell-input-num";
      input.value = String(fill.pct);
      input.addEventListener("mousedown", (e) => e.stopPropagation());
      input.addEventListener("click", (e) => e.stopPropagation());
      input.addEventListener("keydown", (e) => { if (e.key === "Enter") e.target.blur(); });
      input.addEventListener("blur", () => commitFillRate(cardId, input.value));
      const suffix = document.createElement("span");
      suffix.className = "cb-table-view-cell-suffix";
      suffix.textContent = "%";
      td.appendChild(input);
      td.appendChild(suffix);
    } else if (fill && fill.loading) {
      td.className = "col-fill cb-table-view-cell-muted";
      const sp = document.createElement("span");
      sp.className = "cb-table-view-fill-spinner";
      sp.title = "Loading actual fill rate\u2026";
      td.appendChild(sp);
    } else if (fill && fill.pct != null) {
      td.className = "col-fill";
      // Match the Projected input's box metrics + grey "%" so the value sits in
      // the same place and reads the same across modes.
      const numSpan = document.createElement("span");
      numSpan.className = "cb-table-view-cell-num-ro";
      numSpan.textContent = String(fill.pct);
      const suffix = document.createElement("span");
      suffix.className = "cb-table-view-cell-suffix";
      suffix.textContent = "%";
      td.appendChild(numSpan);
      td.appendChild(suffix);
      // Hover tooltip: expose the underlying ratio so a low fill % is legible
      // (e.g. "1%" reads as "~10 / 789"). Numerator = non-empty cells in this
      // column (from its nullPercentage); denominator = rows the data point's
      // widest linked enrichment ran on — the same number the Coverage cell
      // divides against. Naming the enrichment makes it obvious WHY the
      // denominator can dwarf the rows that actually produced this column.
      if (fill.denom != null && fill.nonNull != null) {
        const numTxt = Number(fill.nonNull).toLocaleString();
        const denomTxt = Number(fill.denom).toLocaleString();
        const ratioLine = `~${numTxt} / ${denomTxt} filled`;
        const whyLine = fill.denomLabel
          ? `non-empty cells \u00F7 rows \u201C${fill.denomLabel}\u201D ran on`
          : `non-empty cells \u00F7 rows the enrichment ran on`;
        // Custom two-line tip (body-appended, ~120ms) instead of the native
        // `title`: the browser tooltip is slow (~1s) and unreliable inside the
        // overlay. aria-label keeps the ratio available to screen readers.
        attachInfoTip(td, [ratioLine, whyLine], { delayMs: 120 });
        td.setAttribute("aria-label", `${ratioLine} \u2014 ${whyLine}`);
      }
      // "Spotcheck" affordance: when a DP column isn't fully filled, reveal a
      // small target button (on row hover) that jumps to + highlights the first
      // missing cell in the grid. Gated to imported DPs (need fieldId/tableId)
      // and to <100% fill (nothing to find at 100%).
      const cardForFill = __cb.canvas?.getCardById?.(cardId);
      if (
        cardForFill?.data?.fieldId &&
        cardForFill?.data?.tableId &&
        Number(fill.pct) < 100
      ) {
        const spot = document.createElement("button");
        spot.type = "button";
        spot.className = "cb-fill-spotcheck";
        spot.title = "Jump to the first missing cell in the table";
        spot.setAttribute("aria-label", "Find first missing cell in the table");
        spot.innerHTML = targetSvg(12);
        spot.addEventListener("mousedown", (e) => e.stopPropagation());
        spot.addEventListener("click", (e) => {
          e.stopPropagation();
          spotcheckMissing(cardForFill, spot);
        });
        td.appendChild(spot);
      }
    } else {
      td.className = "col-fill cb-table-view-cell-muted";
      td.textContent = "\u2014";
    }
    return td;
  }

  // "Spotcheck": jump to (and highlight) the first row whose cell for this data
  // point is empty, so a low fill rate is verifiable in one click. Uses the
  // ad-hoc /find endpoint (no view mutation) + the ?recordId=&fieldId= deep
  // link, which makes Clay scroll to the cell and draw its emphasis ring.
  // `anchorBtn` (optional) gets an inline spinner while the lookup is in flight.
  async function spotcheckMissing(card, anchorBtn) {
    const data = card?.data || {};
    if (!data.fieldId || !data.tableId) {
      __cb.showOverlayToast?.("This data point isn't linked to a table column.");
      return;
    }
    let restore = null;
    if (anchorBtn) {
      restore = anchorBtn.innerHTML;
      anchorBtn.disabled = true;
      anchorBtn.innerHTML = '<span class="cb-table-view-fill-spinner"></span>';
    }
    try {
      const recordId = await __cb.fetchFirstEmptyRecord(
        data.tableId,
        data.viewId,
        data.fieldId,
      );
      if (!recordId) {
        __cb.showOverlayToast?.("No missing cells in the current view.");
        return;
      }
      __cb.openCardInTable(card, recordId);
    } catch (_e) {
      __cb.showOverlayToast?.("Couldn't check for missing data \u2014 try again.");
    } finally {
      if (anchorBtn && restore != null) {
        anchorBtn.disabled = false;
        anchorBtn.innerHTML = restore;
      }
    }
  }

  // ---- Actual-spend session cutoff picker ---------------------------------
  // A dropdown next to the Projected/Actual toggle that scopes measured spend
  // to selected work sessions (see src/session-cutoff.js for the controller).
  let sessionPickerSubscribed = false;
  let sessionPopoverEl = null;
  let sessionPopoverBackdrop = null;
  // Load-timer pill (bottom-right of the popover): live-ticks while a network
  // fetch is in flight, then settles to "Fetched <date>". Cache hits show
  // nothing. sessionTookEl (to its left) shows the persisted fetch duration.
  let sessionTimerEl = null;
  let sessionTookEl = null;
  let sessionTimerInterval = null;

  // Number of SELECTED run buckets (sessions) shown in the Actual button's
  // badge. Empty until the session list has loaded, so the badge stays blank on
  // first paint instead of flashing a 0; the count persists across mode
  // switches (the badge just goes grey in Projected — see CSS).
  function actualRunsBadgeText() {
    const cut = window.__cb.sessionCutoff;
    const st = cut?.getState?.();
    if (!st || st.loading) return "";
    // Total selected sessions across every table column.
    return String(cut.totalSelected?.() ?? 0);
  }

  // Last value shown in the Actual badge, tracked at module scope so the pulse
  // fires only on a genuine change. render() rebuilds the badge node (empty)
  // every time, so comparing against the fresh DOM node's text would re-pulse on
  // every group expand/collapse — we compare against this persisted value.
  let lastActualRunsBadgeValue = null;

  // Replay the badge's pop animation. Used on a real count change (loading -> a
  // number, or a new selection count) and when the session-run popover opens.
  function pulseActualBadge() {
    const badge = hostEl?.querySelector(".cb-view-mode-actual-badge");
    if (!badge || !badge.textContent) return;
    badge.classList.remove("cb-view-mode-actual-badge-pulse");
    void badge.offsetWidth; // restart the animation
    badge.classList.add("cb-view-mode-actual-badge-pulse");
  }

  function refreshActualRunsBadge() {
    const badge = hostEl?.querySelector(".cb-view-mode-actual-badge");
    if (!badge) return;
    const next = actualRunsBadgeText();
    badge.textContent = next;
    // Pulse only when the count actually changes — NOT on every re-render. The
    // badge is rebuilt empty on each render(), so we diff against the persisted
    // last value (not the fresh node) to avoid bouncing on every group toggle.
    if (next && next !== lastActualRunsBadgeValue) pulseActualBadge();
    if (next) lastActualRunsBadgeValue = next;
  }

  // Wire the Actual button's session UI: lazy-load the session list, subscribe
  // once so the badge + any open popover stay live, and fill the badge once this
  // render mounts. Replaces the old standalone session-picker button.
  function wireActualSessionUI() {
    const cut = window.__cb.sessionCutoff;
    if (!cut) return;
    cut.ensureLoaded?.();
    if (!sessionPickerSubscribed && cut.subscribe) {
      sessionPickerSubscribed = true;
      cut.subscribe(() => {
        refreshActualRunsBadge();
        if (sessionPopoverEl) renderSessionPopoverRows();
      });
    }
    // Defer to after this render: the toggle (and its badge) is appended to
    // hostEl at the end of render, so fill the badge once it's in the DOM —
    // this is what makes the count show (and persist) even when sessions are
    // already cached and the subscription won't re-fire.
    requestAnimationFrame(refreshActualRunsBadge);
  }

  function fmtSessionDate(iso) {
    try {
      return new Date(iso).toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      });
    } catch {
      return iso;
    }
  }

  function closeSessionPopover() {
    closeSessionSubmenu();
    closeSessionHeaderMenu();
    closeSessionPillMenu();
    if (sessionTimerInterval) { clearInterval(sessionTimerInterval); sessionTimerInterval = null; }
    sessionTimerEl = null;
    sessionTookEl = null;
    if (sessionPopoverEl) { sessionPopoverEl.remove(); sessionPopoverEl = null; }
    if (sessionPopoverBackdrop) { sessionPopoverBackdrop.remove(); sessionPopoverBackdrop = null; }
  }

  // Relative "fetched" label for the footer pill.
  function fmtFetchedAgo(ts) {
    if (ts == null) return "";
    const sec = Math.max(0, (Date.now() - ts) / 1000);
    if (sec < 45) return "just now";
    if (sec < 3600) return `${Math.round(sec / 60)}m ago`;
    if (sec < 86400) return `${Math.round(sec / 3600)}h ago`;
    const d = Math.round(sec / 86400);
    if (d <= 7) return `${d}d ago`;
    try {
      return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });
    } catch {
      return `${d}d ago`;
    }
  }

  // The footer pill is the single Actual-data control: while a fetch is in
  // flight it ticks "Loading… X.Xs"; otherwise it shows when the data was last
  // fetched ("Fetched 2h ago"), turning amber after a re-import to nudge a
  // refresh. Clicking it refetches run/recent (cut.refresh).
  function updateSessionPill() {
    if (!sessionTimerEl) return;
    const cut = window.__cb.sessionCutoff;
    const st = cut?.getState?.();
    const info = cut?.fetchInfo?.() || {
      lastFetchedAt: null, anyReused: false, anyError: false, loading: false, fetchMs: null,
    };
    // Persisted fetch duration, left of the pill — only alongside a real
    // "Fetched <date>" (hidden while loading / on error / when never fetched).
    if (sessionTookEl) {
      const showTook =
        !info.loading && !info.anyError && info.fetchMs != null && info.lastFetchedAt != null;
      sessionTookEl.style.display = showTook ? "" : "none";
      if (showTook) {
        sessionTookEl.textContent = `${(info.fetchMs / 1000).toFixed(1)}s`;
        sessionTookEl.title = `Realtime runs took ${(info.fetchMs / 1000).toFixed(1)}s to fetch`;
      }
    }
    sessionTimerEl.classList.remove(
      "cb-session-pop-timer-loading",
      "cb-session-pop-timer-amber",
      "cb-session-pop-timer-error",
    );
    // Loading: live elapsed tick.
    if (info.loading && st?.fetchStartedAt != null) {
      const now =
        typeof performance !== "undefined" && performance.now
          ? performance.now()
          : Date.now();
      sessionTimerEl.style.display = "";
      sessionTimerEl.textContent = `${((now - st.fetchStartedAt) / 1000).toFixed(1)}s`;
      sessionTimerEl.classList.add("cb-session-pop-timer-loading");
      sessionTimerEl.title = "Fetching realtime runs\u2026";
      return;
    }
    if (sessionTimerInterval) { clearInterval(sessionTimerInterval); sessionTimerInterval = null; }
    // Error: red pill, click to retry.
    if (info.anyError) {
      sessionTimerEl.style.display = "";
      sessionTimerEl.textContent = "Fetch failed \u2014 retry";
      sessionTimerEl.classList.add("cb-session-pop-timer-error");
      sessionTimerEl.title =
        "Couldn't fetch realtime runs (network or timeout). Click to retry.";
      return;
    }
    if (info.lastFetchedAt == null && !info.anyReused) {
      sessionTimerEl.style.display = "none";
      return;
    }
    sessionTimerEl.style.display = "";
    sessionTimerEl.textContent = info.lastFetchedAt != null
      ? `Fetched ${fmtFetchedAgo(info.lastFetchedAt)}`
      : "Refresh";
    if (info.anyReused) {
      sessionTimerEl.classList.add("cb-session-pop-timer-amber");
      sessionTimerEl.title =
        "This data is cached (reused from a previous fetch). If you want fresher " +
        "results, click and refresh.";
    } else {
      sessionTimerEl.title = "Click to refresh runs from Clay.";
    }
  }

  // Keep the pill live while a fetch runs (e.g. after a manual refresh).
  function syncSessionTimer() {
    const st = window.__cb.sessionCutoff?.getState?.();
    if (st?.loading && st?.fetchStartedAt != null && !sessionTimerInterval) {
      sessionTimerInterval = setInterval(updateSessionPill, 100);
    }
    updateSessionPill();
  }

  // Error + retry shown in a session column when its run/recent fetch failed or
  // timed out. Retry refetches all tables (cheap; one stalled table is rare).
  function buildSessionError(cut) {
    const m = document.createElement("div");
    m.className = "cb-session-pop-empty cb-session-pop-error";
    const txt = document.createElement("span");
    txt.textContent = "Couldn't load runs.";
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "cb-session-pop-retry";
    retry.textContent = "Retry";
    retry.addEventListener("mousedown", (e) => e.stopPropagation());
    retry.addEventListener("click", (e) => { e.stopPropagation(); cut.refresh?.(); });
    m.appendChild(txt);
    m.appendChild(retry);
    return m;
  }

  // The footer pill menu: clicking the "Fetched <date>" pill opens a small menu
  // with "Refresh import", which refetches run/recent for ALL imported tables in
  // parallel (so both tables come back together). Anchored above the pill.
  let sessionPillMenuEl = null;
  function closeSessionPillMenu() {
    if (sessionPillMenuEl) { sessionPillMenuEl.remove(); sessionPillMenuEl = null; }
  }
  function openSessionPillMenu(anchorEl) {
    if (sessionPillMenuEl) { closeSessionPillMenu(); return; }
    if (!sessionPopoverEl) return;
    const cut = window.__cb.sessionCutoff;
    const menu = document.createElement("div");
    menu.className = "cb-session-pop-menu cb-session-pill-menu";
    menu.addEventListener("mousedown", (e) => e.stopPropagation());
    const it = document.createElement("button");
    it.type = "button";
    it.className = "cb-session-pop-menu-item";
    it.textContent = "Refresh import";
    it.addEventListener("click", (e) => {
      e.stopPropagation();
      closeSessionPillMenu();
      cut.refresh?.(); // refetches every imported table in parallel
    });
    menu.appendChild(it);
    // Body-mounted + fixed so it isn't clipped by the popover and lands exactly
    // under the pill (right edges aligned). Flips above only if there's no room
    // below.
    document.body.appendChild(menu);
    sessionPillMenuEl = menu;
    const aRect = anchorEl.getBoundingClientRect();
    menu.style.position = "fixed";
    menu.style.zIndex = "10000001";
    const h = menu.offsetHeight || 0;
    const w = menu.offsetWidth || 140;
    let top = aRect.bottom + 4;
    if (top + h > window.innerHeight - 8) top = aRect.top - 4 - h; // flip up if needed
    menu.style.top = `${Math.max(8, top)}px`;
    menu.style.left = `${Math.max(8, aRect.right - w)}px`;
  }

  // The header "..." overflow menu (Select all / Clear all, across every table).
  let sessionHeaderMenuEl = null;
  function closeSessionHeaderMenu() {
    if (sessionHeaderMenuEl) { sessionHeaderMenuEl.remove(); sessionHeaderMenuEl = null; }
  }
  function openSessionHeaderMenu(anchorBtn) {
    if (sessionHeaderMenuEl) { closeSessionHeaderMenu(); return; }
    if (!sessionPopoverEl) return;
    const cut = window.__cb.sessionCutoff;
    const menu = document.createElement("div");
    menu.className = "cb-session-pop-menu";
    menu.addEventListener("mousedown", (e) => e.stopPropagation());
    const mk = (label, fn) => {
      const it = document.createElement("button");
      it.type = "button";
      it.className = "cb-session-pop-menu-item";
      it.textContent = label;
      it.addEventListener("click", (e) => {
        e.stopPropagation();
        fn();
        closeSessionHeaderMenu();
      });
      return it;
    };
    menu.appendChild(mk("Select all", () => cut.setAllTables(true)));
    menu.appendChild(mk("Clear all", () => cut.setAllTables(false)));
    sessionPopoverEl.appendChild(menu);
    sessionHeaderMenuEl = menu;
    // Anchor under the "..." button, relative to the popover.
    const aRect = anchorBtn.getBoundingClientRect();
    const pRect = sessionPopoverEl.getBoundingClientRect();
    menu.style.position = "absolute";
    menu.style.top = `${aRect.bottom - pRect.top + 4}px`;
    menu.style.right = "8px";
  }

  // fieldId -> column display name, from the live cards (for the hover submenu).
  function sessionFieldNameMap() {
    const m = new Map();
    for (const c of window.__cb.canvas?.getCards?.() || []) {
      const d = c.data;
      if (d && d.fieldId && !m.has(d.fieldId)) {
        m.set(d.fieldId, d.displayName || d.text || d.fieldId);
      }
      // waterfall providers carry their own fieldIds
      if (d && d.type === "waterfall" && Array.isArray(d.providers)) {
        for (const p of d.providers) {
          if (p.fieldId && !m.has(p.fieldId)) {
            m.set(p.fieldId, p.displayName || d.displayName || p.fieldId);
          }
        }
      }
    }
    return m;
  }

  // Segmented action|credit pill identical to the ER details cost node
  // (buildErMenuCostNode): StarFour glyph for action executions FIRST, Coin(s)
  // glyph for credits SECOND. Values here are session totals (not "/ row").
  function buildCostBadges(credits, actions, opts) {
    opts = opts || {};
    const pill = document.createElement("span");
    pill.className = "cb-pill cb-table-view-er-cost-pill cb-session-cost-pill";
    const aNum = Number(actions) || 0;
    const cNum = Number(credits) || 0;
    // Per-record values are small fractions, so show up to 2 decimals instead of
    // rounding to whole units (which would collapse e.g. 0.2 credits to "0").
    // Default (session/year totals) keeps the original whole-number formatting.
    const fmt = opts.perRecord
      ? (n) => n.toLocaleString(undefined, { maximumFractionDigits: 2 })
      : (n) => Math.round(n).toLocaleString();
    const showAction = opts.perRecord ? aNum > 0 : Math.round(aNum) > 0;
    if (showAction) {
      const seg = document.createElement("span");
      seg.className = "cb-pill-seg cb-table-view-er-cost-seg cb-table-view-er-cost-actions";
      seg.innerHTML = starFourSvg(12) + `<span>${fmt(aNum)}</span>`;
      pill.appendChild(seg);
    }
    const credSeg = document.createElement("span");
    credSeg.className = "cb-pill-seg cb-table-view-er-cost-seg cb-table-view-er-cost-credits";
    const coin = Math.abs(cNum) <= 1 ? coinSvg(12) : coinsSvg(12);
    credSeg.innerHTML = coin + `<span>${fmt(cNum)}</span>`;
    pill.appendChild(credSeg);
    return pill;
  }

  // Exposed so other modules (e.g. the GTME export modal in export.js) can
  // render the same segmented actions|credits cost pill and the $ glyph without
  // duplicating the markup. dollarSvg is a hoisted declaration defined below.
  window.__cb.buildCostBadges = buildCostBadges;
  window.__cb.dollarSvg = dollarSvg;

  // Hooks consumed by src/pricing-view.js (loaded before this file): the raw
  // re-render (NOT the guarded refresh — pricing's Escape-to-cancel-rename path
  // rebuilds while an input is focused) and the shared glyph builders the
  // spreadsheet uses too. All are hoisted function declarations, so assigning
  // them here (before their definitions further down) is fine.
  window.__cb._tvRender = render;
  window.__cb._tvHelpers = {
    chevronDownSvg,
    coinsSvg,
    folderSvg,
    starFourSvg,
    tableSvg,
  };

  // Hover tooltip for the table header (i) icon. Body-appended + position:fixed
  // (z-index above the overlay) so it shows regardless of whether the table
  // section is expanded or collapsed, and isn't clipped by the table's overflow.
  // The native `title` attribute is unreliable inside the overlay, so we build
  // our own. `lines` render one per row.
  function attachInfoTip(iconEl, lines, opts) {
    const delayMs = (opts && opts.delayMs) || 0;
    let tip = null;
    let showTimer = null;
    const hide = () => {
      if (showTimer) {
        clearTimeout(showTimer);
        showTimer = null;
      }
      if (tip) {
        tip.remove();
        tip = null;
      }
      document.removeEventListener("scroll", hide, true);
    };
    const show = () => {
      hide();
      tip = document.createElement("div");
      tip.className = "cb-uc-info-tip";
      for (const l of lines) {
        const d = document.createElement("div");
        d.textContent = l;
        tip.appendChild(d);
      }
      document.body.appendChild(tip);
      const r = iconEl.getBoundingClientRect();
      const w = tip.offsetWidth;
      let left = r.left + r.width / 2 - w / 2;
      left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
      tip.style.left = `${Math.round(left)}px`;
      tip.style.top = `${Math.round(r.bottom + 6)}px`;
      // Hide if the table scrolls — the fixed tip would otherwise float away.
      document.addEventListener("scroll", hide, true);
    };
    // Optional show-delay: much snappier than the native ~1s title delay, but a
    // small gap avoids flicker when the pointer sweeps a column of tips. delayMs
    // 0 (the default) preserves the original instant behavior for existing
    // callers (the header / use-case (i) icons).
    const onEnter = () => {
      if (delayMs <= 0) { show(); return; }
      if (showTimer) clearTimeout(showTimer);
      showTimer = setTimeout(() => { showTimer = null; show(); }, delayMs);
    };
    iconEl.addEventListener("mouseenter", onEnter);
    iconEl.addEventListener("mouseleave", hide);
    iconEl.addEventListener("mousedown", hide);
  }

  // ---- Click submenu: which columns ran in a session ----
  let sessionSubmenuEl = null;
  let sessionSubmenuOpenId = null;

  function closeSessionSubmenu() {
    sessionSubmenuOpenId = null;
    if (sessionSubmenuEl) { sessionSubmenuEl.remove(); sessionSubmenuEl = null; }
  }

  function openSessionSubmenu(session, anchorEl) {
    // Toggle: clicking the same session's "N cols" trigger again closes it.
    if (sessionSubmenuOpenId === session.id) { closeSessionSubmenu(); return; }
    closeSessionSubmenu();
    const pf = session.perField || {};
    const fids = Object.keys(pf);
    if (!fids.length) return;
    const names = sessionFieldNameMap();
    const el = document.createElement("div");
    el.className = "cb-session-submenu";
    el.addEventListener("mousedown", (e) => e.stopPropagation());
    // Sort columns by credits desc so the expensive ones lead.
    fids.sort((a, b) => (pf[b].credits || 0) - (pf[a].credits || 0));
    for (const fid of fids) {
      const v = pf[fid];
      const r = document.createElement("div");
      r.className = "cb-session-submenu-row";
      const nm = document.createElement("span");
      nm.className = "cb-session-submenu-name";
      nm.textContent = names.get(fid) || fid;
      r.appendChild(nm);
      r.appendChild(buildCostBadges(v.credits || 0, v.actionExecutions || 0));
      el.appendChild(r);
    }
    sessionSubmenuEl = el;
    sessionSubmenuOpenId = session.id;
    document.body.appendChild(el);

    // Position relative to the popover (anchored at the toolbar's right edge):
    // prefer opening to the LEFT of the popover so it never runs off the right
    // of the screen; flip right only when the left has no room. Vertically
    // align to the trigger row, clamped into the viewport. The clamp is done
    // here on purpose — NOT via clampSubmenu, which is built for the model
    // picker's absolutely-positioned submenu and clears `top`, which would
    // throw this fixed menu to the screen corner.
    const popRect = sessionPopoverEl
      ? sessionPopoverEl.getBoundingClientRect()
      : anchorEl.getBoundingClientRect();
    const aRect = anchorEl.getBoundingClientRect();
    const w = el.offsetWidth || 240;
    const h = el.offsetHeight || 0;
    const margin = 8;
    el.style.position = "fixed";
    el.style.zIndex = "10000000";
    let left = popRect.left - 6 - w;
    if (left < margin) left = popRect.right + 6;
    el.style.left = `${Math.max(margin, left)}px`;
    let top = aRect.top;
    if (top + h > window.innerHeight - margin) {
      top = window.innerHeight - margin - h;
    }
    el.style.top = `${Math.max(margin, top)}px`;
  }

  // tid -> { name, color } for the per-table column headers.
  function importedTableMeta() {
    const m = new Map();
    const tables = window.__cb.model?.getImportedTables?.() || {};
    for (const tid of Object.keys(tables)) {
      const meta = tables[tid] || {};
      m.set(tid, { name: meta.name || "Table" });
    }
    return m;
  }

  // One session row (checkbox + date + "N cols" submenu trigger + cost pill).
  // `tid` scopes the toggle to its table's selection.
  function buildSessionRow(cut, tableState, tid, s) {
    const row = document.createElement("label");
    row.className = "cb-session-pop-row";
    const cbx = document.createElement("input");
    cbx.type = "checkbox";
    // s.selected: "all" (checked) | "some" (indeterminate) | "none". A displayed
    // session can merge several 6h base buckets, so a partial selection shows a
    // dash; clicking it selects all its children (see sessionCutoff.toggle).
    cbx.checked = s.selected === "all";
    cbx.indeterminate = s.selected === "some";
    cbx.addEventListener("mousedown", (e) => e.stopPropagation());
    cbx.addEventListener("change", (e) => { e.stopPropagation(); cut.toggle(tid, s.id); });
    const meta = document.createElement("div");
    meta.className = "cb-session-pop-meta";
    const date = document.createElement("div");
    date.className = "cb-session-pop-date";
    date.textContent = fmtSessionDate(s.startISO);
    const sub = document.createElement("div");
    sub.className = "cb-session-pop-sub";
    sub.textContent = `${s.columnsTouched} col${s.columnsTouched === 1 ? "" : "s"}`;
    // Click the "N cols" line to open/close a submenu listing which columns ran
    // in this session. preventDefault stops the wrapping <label> from toggling
    // the row's checkbox; stopPropagation keeps the backdrop from closing.
    sub.addEventListener("mousedown", (e) => e.stopPropagation());
    sub.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      openSessionSubmenu(s, sub);
    });
    meta.appendChild(date);
    meta.appendChild(sub);
    row.appendChild(cbx);
    row.appendChild(meta);
    row.appendChild(buildCostBadges(s.credits || 0, s.actionExec || 0));
    return row;
  }

  // Skeleton rows shown while a table's runs are still loading, so the columns
  // (and their table names) appear immediately instead of one blanket spinner.
  function buildSessionSkeleton(count) {
    const wrap = document.createElement("div");
    for (let i = 0; i < (count || 3); i++) {
      const r = document.createElement("div");
      r.className = "cb-session-pop-skel";
      wrap.appendChild(r);
    }
    return wrap;
  }

  // A single table's column: header (color dot + name) + its rows. When
  // `loading` (or no state yet) the rows are a skeleton placeholder.
  function buildSessionColumn(cut, tableState, tid, meta, loading) {
    const col = document.createElement("div");
    col.className = "cb-session-pop-col";

    const header = document.createElement("div");
    header.className = "cb-session-pop-col-header";
    const dot = document.createElement("span");
    dot.className = "cb-session-pop-col-dot";
    const nm = document.createElement("span");
    nm.className = "cb-session-pop-col-name";
    nm.textContent = meta?.name || "Table";
    nm.title = nm.textContent;
    header.appendChild(dot);
    header.appendChild(nm);
    col.appendChild(header);

    const list = document.createElement("div");
    list.className = "cb-session-pop-col-list";
    // Per-table state drives progressive reveal: each column shows its own
    // skeleton until ITS fetch lands, independent of the slower tables. The
    // global `loading` only matters before per-table state exists.
    if (tableState && tableState.error) {
      list.appendChild(buildSessionError(cut));
    } else if (loading || !tableState || tableState.loading) {
      list.appendChild(buildSessionSkeleton(3));
    } else if (!tableState.sessions.length) {
      const m = document.createElement("div");
      m.className = "cb-session-pop-empty";
      m.textContent = "No runs.";
      list.appendChild(m);
    } else {
      for (const s of tableState.sessions.slice().reverse()) {
        list.appendChild(buildSessionRow(cut, tableState, tid, s));
      }
    }
    col.appendChild(list);
    return col;
  }

  function renderSessionPopoverRows() {
    if (!sessionPopoverEl) return;
    const cut = window.__cb.sessionCutoff;
    const st = cut?.getState?.();
    const body = sessionPopoverEl.querySelector(".cb-session-pop-body");
    if (!body) return;
    closeSessionSubmenu();
    body.replaceChildren();
    // Keep the load-timer pill in sync (and (re)start its ticker after a manual
    // refresh kicks off a new fetch).
    syncSessionTimer();

    const loading = !st || st.loading;

    // Table list. When loaded, the controller's tableIds are authoritative.
    // While loading (or before state exists), fall back to the known imported
    // tables so the columns + table names render immediately ("pre-populated").
    let tableIds = (st && st.tableIds) || [];
    if (!tableIds.length) {
      tableIds = (window.__cb.cost?.listUseCases?.() || []).map((u) => u.tableId);
    }

    if (!tableIds.length) {
      const m = document.createElement("div");
      m.className = "cb-session-pop-empty";
      m.textContent = loading ? "Loading sessions\u2026" : "No realtime runs found.";
      body.appendChild(m);
      return;
    }

    // NOTE: do NOT collapse to a single "No realtime runs found." when 2+ tables
    // all came back empty — that would drop the per-table column structure. Each
    // column renders its own empty/loading/error state below, so the dual layout
    // is preserved even when no table has runs.

    const names = importedTableMeta();

    // Single table: flat list (unchanged look). 2+ tables: one column each.
    if (tableIds.length <= 1) {
      const tid = tableIds[0];
      const t = st?.byTable?.[tid];
      if (t && t.error) {
        body.appendChild(buildSessionError(cut));
      } else if (!t || t.loading) {
        body.appendChild(buildSessionSkeleton(4));
      } else if (!t.sessions.length) {
        const m = document.createElement("div");
        m.className = "cb-session-pop-empty";
        m.textContent = "No realtime runs found.";
        body.appendChild(m);
      } else {
        for (const s of t.sessions.slice().reverse()) {
          body.appendChild(buildSessionRow(cut, t, tid, s));
        }
      }
      return;
    }

    const cols = document.createElement("div");
    cols.className = "cb-session-pop-cols";
    // Order columns by completion (loadedSeq): a table whose runs come back
    // first shows first. Still-loading tables (no loadedSeq) sort last, keeping
    // their original order. Pass loading=false so each column reveals on ITS OWN
    // per-table flag (progressive), not the global loading.
    const ordered = tableIds.slice().sort((a, b) => {
      const sa = st?.byTable?.[a]?.loadedSeq;
      const sb = st?.byTable?.[b]?.loadedSeq;
      const la = sa == null ? Infinity : sa;
      const lb = sb == null ? Infinity : sb;
      if (la !== lb) return la - lb;
      return tableIds.indexOf(a) - tableIds.indexOf(b);
    });
    for (const tid of ordered) {
      const t = st?.byTable?.[tid];
      cols.appendChild(buildSessionColumn(cut, t, tid, names.get(tid), false));
    }
    body.appendChild(cols);
  }

  function toggleSessionPopover(anchorBtn) {
    if (sessionPopoverEl) { closeSessionPopover(); return; }
    // Opening the session run: bounce the Actual badge. Deferred a frame because
    // clicking Actual-while-active re-renders the toggle (rebuilding the badge
    // empty); the badge-fill rAF runs first, so by our frame it has its count.
    requestAnimationFrame(pulseActualBadge);
    const cut = window.__cb.sessionCutoff;

    sessionPopoverBackdrop = document.createElement("div");
    sessionPopoverBackdrop.style.cssText = "position:fixed;inset:0;z-index:9999998;";
    sessionPopoverBackdrop.addEventListener("mousedown", (e) => {
      e.stopPropagation();
      closeSessionPopover();
    });

    sessionPopoverEl = document.createElement("div");
    sessionPopoverEl.className = "cb-session-pop";
    sessionPopoverEl.addEventListener("mousedown", (e) => e.stopPropagation());

    const header = document.createElement("div");
    header.className = "cb-session-pop-header";
    const title = document.createElement("span");
    title.className = "cb-session-pop-title";
    title.textContent = "Actual spend from";
    // Overflow "..." menu — houses the global Select all / Clear all that used
    // to be inline (and the per-column buttons), keeping the header clean.
    const menuBtn = document.createElement("button");
    menuBtn.type = "button";
    menuBtn.className = "cb-session-pop-menu-btn";
    menuBtn.textContent = "\u22ef"; // horizontal ellipsis
    menuBtn.setAttribute("aria-label", "Session options");
    menuBtn.addEventListener("click", (e) => { e.stopPropagation(); openSessionHeaderMenu(menuBtn); });
    header.appendChild(title);
    header.appendChild(menuBtn);
    sessionPopoverEl.appendChild(header);

    const body = document.createElement("div");
    body.className = "cb-session-pop-body";
    sessionPopoverEl.appendChild(body);

    const note = document.createElement("div");
    note.className = "cb-session-pop-note";
    note.style.display = "none";
    note.textContent =
      "Non-adjacent sessions selected \u2014 summed per session.";
    sessionPopoverEl.appendChild(note);

    const footer = document.createElement("div");
    footer.className = "cb-session-pop-footer";
    const gapLbl = document.createElement("span");
    gapLbl.textContent = "Group runs within";
    const gapInput = document.createElement("input");
    gapInput.type = "number";
    // The gap can only be RAISED from the 6h base (display merge is computed
    // from the base buckets; going below 6h would need the raw runs). Floor at 6.
    const minGapH = Math.round(
      (window.__cb.sessionCutoff?.MIN_GAP_MS || 6 * 3600000) / 3600000,
    );
    gapInput.min = String(minGapH);
    gapInput.className = "cb-session-pop-gap";
    const st0 = cut.getState?.();
    gapInput.value = String(
      Math.max(
        minGapH,
        Math.round((st0?.gapMs || window.__cb.cost.DEFAULT_SESSION_GAP_MS) / 3600000),
      ),
    );
    gapInput.addEventListener("mousedown", (e) => e.stopPropagation());
    gapInput.addEventListener("keydown", (e) => { if (e.key === "Enter") e.target.blur(); });
    gapInput.addEventListener("change", (e) => {
      e.stopPropagation();
      const h = Math.max(minGapH, Number(gapInput.value) || minGapH);
      gapInput.value = String(h); // reflect the clamp
      cut.setGapMs(h * 3600000);
    });
    const gapSuffix = document.createElement("span");
    gapSuffix.textContent = "h";
    footer.appendChild(gapLbl);
    footer.appendChild(gapInput);
    footer.appendChild(gapSuffix);
    // Right group: [took duration][Fetched pill], pushed to the bottom-right.
    const footRight = document.createElement("div");
    footRight.className = "cb-session-pop-foot-right";
    // Persisted fetch duration (e.g. "30.5s"), shown left of the pill.
    sessionTookEl = document.createElement("span");
    sessionTookEl.className = "cb-session-pop-took";
    sessionTookEl.style.display = "none";
    footRight.appendChild(sessionTookEl);
    // Fetched-date / refresh pill. Shows when the runs were last fetched (amber
    // after a re-import), ticks while fetching, opens the Refresh import menu on
    // click. Populated by syncSessionTimer.
    sessionTimerEl = document.createElement("span");
    sessionTimerEl.className = "cb-session-pop-timer";
    sessionTimerEl.style.display = "none";
    sessionTimerEl.addEventListener("mousedown", (e) => e.stopPropagation());
    sessionTimerEl.addEventListener("click", (e) => {
      e.stopPropagation();
      const info = cut.fetchInfo?.();
      if (info && info.loading) return; // already fetching
      if (info && info.anyError) { cut.refresh?.(); return; } // error → retry directly
      openSessionPillMenu(sessionTimerEl); // otherwise a "Refresh import" menu
    });
    footRight.appendChild(sessionTimerEl);
    footer.appendChild(footRight);
    sessionPopoverEl.appendChild(footer);

    document.body.appendChild(sessionPopoverBackdrop);
    document.body.appendChild(sessionPopoverEl);

    const rect = anchorBtn.getBoundingClientRect();
    sessionPopoverEl.style.position = "fixed";
    sessionPopoverEl.style.top = `${rect.bottom + 6}px`;
    sessionPopoverEl.style.zIndex = "9999999";

    renderSessionPopoverRows();

    // Clamp left so a wide multi-column popover stays in the viewport (it's
    // rendered before measuring so offsetWidth is real).
    let left = Math.max(8, rect.left);
    const w = sessionPopoverEl.offsetWidth || 320;
    if (left + w > window.innerWidth - 8) {
      left = Math.max(8, window.innerWidth - 8 - w);
    }
    sessionPopoverEl.style.left = `${left}px`;
  }

  // Exposed so the Projected/Actual toggle's Actual button (built in
  // src/overlay.js) can open / close the session popover — it replaces the old
  // standalone session-picker button.
  window.__cb.toggleSessionPopover = toggleSessionPopover;
  window.__cb.closeSessionPopover = closeSessionPopover;

  function formatNumber(n) {
    if (!Number.isFinite(n)) return "0";
    return n % 1 === 0
      ? n.toLocaleString()
      : n.toLocaleString(undefined, { maximumFractionDigits: 1 });
  }

  // Compact relative time ("just now", "5m ago", "3h ago", "2d ago"). Used
  // for the per-table "imported X ago" header; the absolute timestamp rides
  // along in the element's title attribute.
  function relativeTimeText(ts) {
    const diffMs = Date.now() - ts;
    if (!Number.isFinite(diffMs)) return "";
    const sec = Math.max(0, Math.round(diffMs / 1000));
    if (sec < 45) return "just now";
    const min = Math.round(sec / 60);
    if (min < 60) return `${min}m ago`;
    const hr = Math.round(min / 60);
    if (hr < 24) return `${hr}h ago`;
    const day = Math.round(hr / 24);
    if (day < 30) return `${day}d ago`;
    const mo = Math.round(day / 30);
    if (mo < 12) return `${mo}mo ago`;
    return `${Math.round(mo / 12)}y ago`;
  }

  // ---- Row model ----
  //
  // Rows are grouped into three sections by `kind`:
  //   - "orphan-er"  — ER not in any DP-bearing cluster (top of the table)
  //   - "dp"         — data point row (middle, the bulk)
  //   - "add-dp"     — sticky footer row for adding a new DP (rendered separately)

  function buildRows() {
    const canvas = __cb.canvas;
    if (!canvas) return { orphanErRows: [], groupSections: [], dpRows: [] };

    const allCards = __cb.model.getNodes();

    // DP <-> enrichment matching (Phase 1): driven by the first-class
    // `sourceEnrichmentFieldId` lineage field on each data point, NOT canvas
    // clusters/geometry. Cost is shared across exactly the in-view data points
    // of each enrichment: per-DP cost = ER credits / (# imported DPs with that
    // key) — e.g. a 5-credit enrichment with 2 of its DPs in view -> 2.5 each.
    // Enrichments with >=1 matched DP are "claimed" (excluded from the
    // orphan-ER section below); the rest fall through to orphan rows.
    const dpInfoMap = new Map();
    const claimedErIds = new Set();
    const actualMode = window.__cb?.viewMode === "actual";

    // Enrichment cards keyed the way DPs reference them: action field id for
    // standalone / basic-group ERs, "wf:<groupId>" for waterfall cards.
    const erByKey = new Map();
    for (const c of allCards) {
      if (!isErType(c.data.type)) continue;
      const key = c.data.type === "waterfall"
        ? (c.data.groupCluster != null ? `wf:${c.data.groupCluster}` : null)
        : (c.data.fieldId ?? null);
      if (key != null && !erByKey.has(key)) erByKey.set(key, c);
    }

    // Measured "rows this ER ran on" — actual cells, falling back to coverage
    // attempts. Drives the actual-mode run-share (how often a non-primary ER
    // actually ran vs the widest ER in the DP's set).
    function erRanCount(er) {
      const d = er.data || {};
      const cells = Number(d.stats?.spend?.cellCount) || 0;
      if (cells > 0) return cells;
      return Number(d.stats?.coverage?.ran) || 0;
    }

    // A DP can reference MULTIPLE enrichments (OR/waterfall or AND/sum chain).
    // Bucket each DP under EVERY ER key it links, so per-ER cost still splits
    // across all the DPs that key feeds — lineage-global, across groups/tables.
    const dpKeysById = new Map();
    const dpsByEnrichmentKey = new Map();
    for (const c of allCards) {
      if (c.data.type !== "dp") continue;
      const keys = __cb.dpErKeys(c).filter((k) => erByKey.has(k));
      if (keys.length === 0) {
        // Unmatched data point (manual column, source-derived, or its
        // enrichment isn't in view) -> renders as "Not connected".
        dpInfoMap.set(c.id, { credits: 0, actions: 0, ers: [], enrichmentCount: 0 });
        continue;
      }
      dpKeysById.set(c.id, { card: c, keys });
      for (const key of keys) {
        if (!dpsByEnrichmentKey.has(key)) dpsByEnrichmentKey.set(key, []);
        dpsByEnrichmentKey.get(key).push(c);
      }
    }

    // Per-key per-DP cost = ER credits / (# DPs that key feeds). Each linked ER
    // is "claimed" so it never also renders as an orphan row.
    const perDpByKey = new Map();
    for (const [key, dpCards] of dpsByEnrichmentKey) {
      const er = erByKey.get(key);
      claimedErIds.add(er.id);
      const { credits, actions, creditsUnknown } = erPerRowCost(er);
      const n = dpCards.length || 1;
      perDpByKey.set(key, {
        perDpCredits: credits / n,
        perDpActions: actions / n,
        creditsUnknown,
      });
    }

    // Resolve each DP's per-ER run-share, then accumulate its chips + weighted
    // cost. Projected: stored share (dpErShare) else the primary-weighted
    // default split (60/40). Actual: measured ran_i / widest-ran (primary 1.0).
    // DP credits = Σ share_i × (ER credits / #DPs).
    for (const [dpId, { card: dpCard, keys }] of dpKeysById) {
      const n = keys.length;
      const multiEr = n > 1;
      let maxRan = 0;
      if (actualMode && multiEr) {
        for (const key of keys) maxRan = Math.max(maxRan, erRanCount(erByKey.get(key)));
      }
      const ers = [];
      let credits = 0;
      let actions = 0;
      let creditsUnknown = false;
      for (let i = 0; i < n; i++) {
        const key = keys[i];
        const er = erByKey.get(key);
        let share;
        if (!multiEr) {
          share = 1;
        } else if (actualMode) {
          share = maxRan > 0 ? Math.min(1, erRanCount(er) / maxRan) : (i === 0 ? 1 : 0);
        } else {
          const stored = __cb.dpErShare(dpCard, key);
          share = stored != null ? stored : __cb.defaultErShare(i, n);
        }
        const pk = perDpByKey.get(key);
        credits += share * pk.perDpCredits;
        actions += share * pk.perDpActions;
        if (pk.creditsUnknown) creditsUnknown = true;
        ers.push(buildErChipData(er, {
          runShare: share,
          isPrimary: i === 0,
          dpCardId: dpId,
          multiEr,
        }));
      }
      dpInfoMap.set(dpId, { credits, actions, creditsUnknown, ers, enrichmentCount: n });
    }

    // Real cb-groups (Shift+Enter / POC importer / table-view Group
    // action) — keyed by numeric groupId. The label comes off the live
    // group's input element so renames in the canvas propagate without
    // a separate event hookup. We include groups with EMPTY labels too:
    // the table-view Group action creates the cb-group with no name and
    // expects the section header's editable input to be the place where
    // the user types the name. Skipping empty-label groups would hide
    // the just-created group entirely.
    const realGroups = __cb.model?.getGroups?.() || [];
    const groupNameById = new Map();
    const groupById = new Map();
    for (const g of realGroups) {
      groupNameById.set(g.id, (g.label || "").trim());
      groupById.set(g.id, g);
    }

    // Super-group / inner-group hierarchy.
    //
    // The canvas tracks group nesting via a binary `level` flag (0 =
    // regular / inner, 1 = super-group) — see canvas/groups.js
    // groupSelectedCards. There's no explicit parentGroupId; the
    // relationship is derived from the fact that a super-group's
    // cardIds is the UNION of every touched inner group's cards
    // (inner.cardIds stays untouched), so inner.cardIds ⊆ super.cardIds
    // for every inner under a super.
    //
    // We mirror that hierarchy into the table view: super-groups become
    // depth-0 headers, inner groups become depth-1 sub-headers under
    // their parent. Because card.groupId is RE-STAMPED to the super-
    // group when a super is created, every DP whose group is a super
    // also has at most one inner group whose cardIds include it; we
    // route the DP to that inner section so each DP appears in its
    // most-specific bucket.
    // Nesting is explicit now: each group carries `parentId` (its super-group)
    // and `level` (1 = super header). A card's group is its most-specific group
    // via `card.groupId`. The single section-shape resolver both the DP loop
    // and the ER-only-group loop use.
    function sectionInfoForGroup(g) {
      return {
        key: `g-${g.id}`,
        name: groupNameById.get(g.id) || "",
        // Table-native (v7.23+): a top-level group is a "use case" (L1, rendered
        // at depth 0 like a super-group); a nested group is a sub-group (L2,
        // depth 1). Depth is positional via parentId, not a stored flag.
        level: g.parentId != null ? 0 : 1,
        parentId: g.parentId ?? null,
        canvasGroupId: g.id,
        editable: true,
        // Use-case (L1) metadata so the header can show records + apply the
        // green/purple positional color (see buildGroupHeaderRow).
        isUseCase: (g.parentId ?? null) === null,
        records: (g.parentId ?? null) === null ? (g.records ?? null) : null,
        source: g.source || null,
        tableId: g.tableId ?? null,
      };
    }

    // Legacy comment-card-cluster fallback — pre-v3.18.3 POC imports +
    // the Clay-table import's basic-group flow stamp a comment card with
    // a `groupCluster` id and tag DPs with the matching `data.groupCluster`.
    // We keep rendering those as sections so existing canvases don't
    // suddenly lose their grouping after the upgrade.
    const commentByCluster = new Map();
    for (const card of allCards) {
      if (card.data?.type !== "comment") continue;
      const cluster = card.data.groupCluster;
      if (!cluster) continue;
      const text = (card.data.text || card.data.displayName || "").trim();
      if (text && !commentByCluster.has(cluster)) {
        commentByCluster.set(cluster, text);
      }
    }

    // Group-aware DP bucketing. Precedence:
    //   1. Real cb-group (card.groupId set by groupSelectedCards) →
    //      bucket under the group's title.
    //   2. Legacy comment-card cluster (data.groupCluster matches a
    //      titled comment) → bucket under the comment text.
    //   3. Otherwise → flat dpRows (preserves the un-grouped layout
    //      reps already had for canvas-created data points).
    // Quick id → card lookup. Cheaper than calling getCardById in tight
    // loops (Y sort, erKey lookup, drag block resolution).
    const cardById = new Map();
    for (const c of allCards) cardById.set(c.id, c);
    // Per-imported-table metadata (source row count + import time + name +
    // color). Keyed by tableId. Authoritative over per-card tableName /
    // importColor — those aren't restored onto DP/input cards across reloads.
    const importedTables = __cb.model?.getImportedTables?.() || {};

    // erKey: stable string identity for a row's ER set, used to detect
    // contiguous DP rows that share the same ERs (Link result OR organic
    // multi-DP cluster) so render() can collapse the merged ERs / credits
    // / actions cells via rowspan. Empty erList → null erKey, which
    // disqualifies the row from merge runs (we never collapse "no ERs").
    function erKeyForList(ers) {
      if (!ers || ers.length === 0) return null;
      const ids = ers.map((e) => e.id).slice().sort();
      return ids.join("|");
    }

    function buildDpRowFromCard(card) {
      const info = dpInfoMap.get(card.id);
      const ers = info ? info.ers : [];
      // Coverage = the WIDEST linked ER (max coverage). For a DP fed by an
      // always-run primary + a fallback/ancestor, the primary is widest, so
      // coverage reflects "rows the data point is attempted on." Editing it
      // targets that widest ER.
      const linkedKeys = __cb.dpErKeys(card).filter((k) => erByKey.has(k));
      let erCard = null;
      let widest = -1;
      for (const k of linkedKeys) {
        const e = erByKey.get(k);
        const cov = actualMode
          ? erRanCount(e)
          : Number(e.data.coverageRows ?? Infinity);
        if (cov > widest) { widest = cov; erCard = e; }
      }
      return {
        kind: "dp",
        cardId: card.id,
        y: card.y,
        name: card.data.text || card.data.displayName || "",
        fillRatePct: fillRatePct(card.data.fillRate),
        coverage: card.data.stats?.coverage || null,
        coverageFill: coverageFillFor(erCard, card),
        credits: info ? info.credits : 0,
        actions: info ? info.actions : 0,
        creditsUnknown: info ? !!info.creditsUnknown : false,
        ers,
        erKey: erKeyForList(ers),
        connected: !!info && info.enrichmentCount > 0,
      };
    }

    const groupSectionsMap = new Map();
    const flatDpRows = [];

    // Resolve the deepest section a card belongs to. Precedence:
    //   1. Card's groupId is a SUPER-group AND some inner group claims
    //      the card → bucket under the inner group (deepest nesting).
    //   2. Card's groupId references a regular cb-group → bucket under
    //      that group (level=0, no parent).
    //   3. Legacy comment-card cluster (data.groupCluster + matching
    //      titled comment) → bucket under the comment text.
    //   4. Otherwise → flat dpRows.
    //
    // Returns `{ key, name, level, parentId, canvasGroupId, editable }`
    // where `level === 1` is a super-group header and `level === 0` is
    // either a standalone group or an inner group nested under a super
    // (parentId differentiates the two).
    function resolveSectionForCard(card) {
      // Table-native: membership is the card's immediate group only. The legacy
      // comment-cluster basic-group sectioning is retired (the migration
      // adapter folds those cards into their use-case group).
      if (card.groupId != null && groupById.has(card.groupId)) {
        return sectionInfoForGroup(groupById.get(card.groupId));
      }
      return null;
    }

    function ensureSection(sectionInfo) {
      if (groupSectionsMap.has(sectionInfo.key)) {
        return groupSectionsMap.get(sectionInfo.key);
      }
      const section = {
        groupId: sectionInfo.key,
        groupName: sectionInfo.name,
        // Real cb-groups carry an editable label that writes back to
        // the canvas's .cb-group-label input; legacy comment-card
        // sections do not (the canvas has no input element to write
        // through to). buildGroupHeaderRow flips between editable
        // input and read-only span based on this flag.
        editable: sectionInfo.editable,
        // Numeric canvas group id, used by commitGroupLabel to find
        // the live .cb-group-label DOM element via [data-group-id].
        // Null for legacy comment-card sections.
        canvasGroupId: sectionInfo.canvasGroupId,
        // Hierarchy: level === 1 means super-group header, level === 0
        // is either a standalone group OR an inner group nested under
        // a super (parentId differentiates the two — null means
        // top-level, non-null means nested under that super's section).
        level: sectionInfo.level,
        parentId: sectionInfo.parentId,
        // Use-case (L1) metadata for the header (records pill + positional
        // color); undefined for non-group sections.
        isUseCase: !!sectionInfo.isUseCase,
        records: sectionInfo.records ?? null,
        source: sectionInfo.source ?? null,
        tableId: sectionInfo.tableId ?? null,
        rows: [],
        // Tracked for sorting at render time — sections sit above
        // the flat DP rows in topological order, but within that
        // category we order by the topmost member's tableOrder (when
        // any member has one) and fall back to topmost Y. Same
        // precedence rule as compareByTableOrderThenY.
        minY: Infinity,
        minTableOrder: null,
      };
      groupSectionsMap.set(sectionInfo.key, section);
      return section;
    }

    function trackSectionMin(section, y, order) {
      if (y < section.minY) section.minY = y;
      if (order != null && (section.minTableOrder == null || order < section.minTableOrder)) {
        section.minTableOrder = order;
      }
    }
    function trackSectionMinFromCard(section, card) {
      trackSectionMin(section, card.y, card.tableOrder ?? null);
    }

    for (const card of allCards) {
      if (card.data.type !== "dp") continue;
      const row = buildDpRowFromCard(card);
      const sectionInfo = resolveSectionForCard(card);
      if (sectionInfo) {
        const section = ensureSection(sectionInfo);
        section.rows.push(row);
        trackSectionMinFromCard(section, card);
        // Also materialize the parent super-group header so the
        // hierarchy renders even when the super itself has no DPs
        // directly attached (the common case — every DP lives in some
        // inner group).
        if (sectionInfo.parentId != null) {
          const parentGroup = groupById.get(sectionInfo.parentId);
          if (parentGroup) {
            // Materialize the parent with its FULL section shape (isUseCase /
            // records / source / tableId). A bare {level,parentId} object would
            // default isUseCase to false, so a use case whose DPs all live in
            // sub-groups would lose its header Records/Frequency/cost pills.
            const parentSection = ensureSection(sectionInfoForGroup(parentGroup));
            // Track the super's min off its children so render can
            // sort top-level sections by topmost-member tableOrder /
            // Y consistently whether the super has direct DPs or only
            // inner groups.
            trackSectionMinFromCard(parentSection, card);
          }
        }
      } else {
        flatDpRows.push(row);
      }
    }

    // Orphan ERs: any ER card not in a DP-bearing cluster. This includes
    // ERs in ER-only clusters (e.g. a waterfall + its standalone neighbor
    // with no DP attached) AND fully-floating ER cards.
    //
    // Two extensions vs. the simple "one row per ER" model:
    //   1. Multi-ER snap clusters collapse into ONE row with multiple
    //      chips — that's the visible result of Link on orphan ERs
    //      (without it, the link is a canvas-only structural change).
    //   2. ER cards that belong to a real cb-group (Group action on
    //      orphan ERs) get bucketed under that group's section header,
    //      not the orphan section. If the group has no DPs at all, we
    //      synthesize the section here so the rep sees the new group
    //      they just created.
    function buildOrphanRowFromCards(erCards) {
      let credits = 0;
      let actions = 0;
      let creditsUnknown = false;
      for (const er of erCards) {
        const cost = erPerRowCost(er);
        credits += cost.credits;
        actions += cost.actions;
        if (cost.creditsUnknown) creditsUnknown = true;
      }
      // Stable order within a cluster: by Y then X so chips render in
      // the same order as the cards' canvas layout.
      const sorted = erCards.slice().sort((a, b) => a.y - b.y || a.x - b.x);
      return {
        kind: "orphan-er",
        cardId: sorted[0].id, // primary — drives data-row-id, drag handle, etc.
        cardIds: sorted.map((c) => c.id),
        y: sorted[0].y,
        credits,
        actions,
        creditsUnknown,
        // Orphan ER rows show coverage (the ER's own), no DP fill.
        coverageFill: coverageFillFor(sorted[0], null),
        ers: sorted.map((c) => buildErChipData(c)),
      };
    }

    const orphanErRows = [];
    const orphanSeen = new Set();
    // ersByGroupId: groupId → Map(cardId → orphan row). Orphan enrichments
    // (ERs with no visible DP) are grouped SEMANTICALLY (C1.3), never by canvas
    // snap geometry: each orphan ER is its own row, sectioned by its cb-group
    // and otherwise routed under its imported-table section by render(). This
    // is what guarantees canvas snap/reconcile can't re-bundle or move the
    // table. (Waterfalls are already a single card, so they stay one row.)
    const ersByGroupId = new Map();

    for (const card of allCards) {
      if (!isErType(card.data.type)) continue;
      if (claimedErIds.has(card.id)) continue;
      if (orphanSeen.has(card.id)) continue;
      orphanSeen.add(card.id);
      const row = buildOrphanRowFromCards([card]);

      // Section by the ER's own cb-group (a semantic, user-created grouping).
      // Orphan ERs with no cb-group fall through to the flat list, which
      // render() routes under the ER's imported-table section.
      if (card.groupId != null && groupNameById.has(card.groupId)) {
        if (!ersByGroupId.has(card.groupId)) {
          ersByGroupId.set(card.groupId, new Map());
        }
        ersByGroupId.get(card.groupId).set(String(card.id), row);
      } else {
        orphanErRows.push(row);
      }
    }

    // Fold the grouped ER rows into the matching group section. If a
    // group has no DPs at all (Group action ran on orphan ERs only),
    // synthesize the section here so it renders. Routes super-group
    // ERs the same way DPs route — into an inner sub-section when one
    // claims the cluster's primary card.
    for (const [groupId, clusterMap] of ersByGroupId) {
      const ownerGroup = groupById.get(groupId);
      if (!ownerGroup) continue;
      // The ER's most-specific group is its card.groupId; section shape (depth /
      // super vs inner) comes straight from parentId + level.
      const sectionInfo = sectionInfoForGroup(ownerGroup);
      const section = ensureSection(sectionInfo);
      for (const row of clusterMap.values()) {
        section.rows.push(row);
        trackSectionMin(section, row.y, tableOrderForCardId(row.cardId));
      }
      // Materialize parent super if we landed in a nested inner so the
      // hierarchy renders even when no DP routed it in already.
      if (sectionInfo.parentId != null) {
        const parentGroup = groupById.get(sectionInfo.parentId);
        if (parentGroup) {
          // Full section shape so the use-case header keeps its scope pills even
          // when it only owns sub-groups (see the DP loop above).
          const parentSection = ensureSection(sectionInfoForGroup(parentGroup));
          for (const row of clusterMap.values()) {
            trackSectionMin(parentSection, row.y, tableOrderForCardId(row.cardId));
          }
        }
      }
    }

    // Sort everything by tableOrder (set by drag-to-reorder in the
    // table view), falling back to canvas y for cards that have never
    // been reordered in the table. Cards with tableOrder come BEFORE
    // unordered ones so freshly added rows append at the bottom of an
    // already-ordered section. Within a snap-cluster, multiple DP rows
    // share a single (host's) y so the relative order between linked
    // DPs is stable.
    function sortRowsByOrder(rows) {
      rows.sort((a, b) =>
        compareByTableOrderThenY(
          tableOrderForCardId(a.cardId),
          a.y,
          tableOrderForCardId(b.cardId),
          b.y,
        ),
      );
    }
    // Materialize a section for every top-level (use-case) group even when it
    // has no rows yet, so a freshly created / emptied use case still renders
    // its header (the rep can then add data points or drop rows into it).
    for (const g of realGroups) {
      if ((g.parentId ?? null) !== null) continue;
      ensureSection(sectionInfoForGroup(g));
    }
    sortRowsByOrder(flatDpRows);
    sortRowsByOrder(orphanErRows);
    for (const section of groupSectionsMap.values()) {
      sortRowsByOrder(section.rows);
    }

    // Aggregated subtree count for super-group sections so the header
    // badge reflects every row underneath, not just direct attachments.
    // The bucketing in resolveSectionForCard routes most DPs into the
    // claiming inner group, leaving the super's own rows almost always
    // empty — without this aggregation, GHY would read "0 data points"
    // even with 4 DPs spread across DEF + ABC. Standalone groups (no
    // children) leave totalRowCount undefined and the header falls back
    // to section.rows.length unchanged.
    for (const section of groupSectionsMap.values()) {
      if (section.level !== 1) continue;
      let total = section.rows.length;
      for (const child of groupSectionsMap.values()) {
        if (child.parentId === section.canvasGroupId) {
          total += child.rows.length;
        }
      }
      section.totalRowCount = total;
    }

    const groupSections = Array.from(groupSectionsMap.values()).sort(
      (a, b) => compareByTableOrderThenY(a.minTableOrder, a.minY, b.minTableOrder, b.minY),
    );

    // -------------------------------------------------------------------------
    // Source-table grouping (Import Clay Table).
    //
    // Cards imported via "Import Clay Table" carry data.tableId / tableName /
    // importColor (set in src/table-import.js). We present each distinct
    // imported table as its own top-level colored block: the table's
    // basic-group sections nest under it (depth 1), and its loose DP rows
    // (inputs, merge fields) + orphan ER rows (waterfalls, standalone
    // enrichments) render directly beneath the table header. Manually-created
    // cards (no tableId) keep the existing flat / group / orphan layout.
    //
    // Imports never create real cb-groups (super/inner), so the canvas
    // super-group machinery above is orthogonal here — a table's sections are
    // always comment-cluster or standalone, which is why we can re-home them
    // without touching the parentId-based super/inner nesting.
    // -------------------------------------------------------------------------
    function tableTagForCardId(cardId) {
      // Table-native (v7.23+): imported tables are now real use-case groups
      // (the migration adapter creates them), so the legacy tableId-block
      // re-home is disabled — every card renders via the group tree above.
      return null;
      // eslint-disable-next-line no-unreachable
      const c = cardById.get(cardId);
      const d = c?.data;
      if (!d || !d.tableId) return null;
      // Resolve presentation from the per-table metadata map first (survives
      // reload), falling back to the card's own tags for ER cards / older
      // states that predate the map.
      const meta = importedTables[d.tableId] || null;
      const tableName = meta?.name || d.tableName;
      if (!tableName) return null;
      return {
        tableId: d.tableId,
        tableName,
        importColor: meta?.importColor || d.importColor || null,
        recordCount: meta?.recordCount ?? null,
        importedAt: meta?.importedAt ?? null,
      };
    }
    function rowTableTag(row) {
      return tableTagForCardId(row.cardId);
    }
    function sectionTableTag(section) {
      for (const r of section.rows) {
        const tag = tableTagForCardId(r.cardId);
        if (tag) return tag;
      }
      return null;
    }

    const tableGroupsMap = new Map();
    function ensureTableGroup(tag) {
      let tg = tableGroupsMap.get(tag.tableId);
      if (!tg) {
        tg = {
          // Synthetic section key — distinct from canvas-group `g-` and
          // comment-cluster `c-` keys so collapse state doesn't collide.
          key: `t-${tag.tableId}`,
          tableId: tag.tableId,
          tableName: tag.tableName,
          importColor: tag.importColor,
          recordCount: tag.recordCount ?? null,
          importedAt: tag.importedAt ?? null,
          sections: [],
          rows: [],
          minY: Infinity,
          minTableOrder: null,
        };
        tableGroupsMap.set(tag.tableId, tg);
      }
      return tg;
    }
    function trackTableGroupMin(tg, y, order) {
      if (y < tg.minY) tg.minY = y;
      if (order != null && (tg.minTableOrder == null || order < tg.minTableOrder)) {
        tg.minTableOrder = order;
      }
    }

    // Partition top-level group sections: tabled ones move under their table
    // group as depth-1 sub-sections; the rest stay top-level. Nested inner
    // sections (parentId != null) are never re-homed — they belong to a real
    // canvas super-group, which imports don't produce.
    const remainingGroupSections = [];
    for (const section of groupSections) {
      const tag = section.parentId == null ? sectionTableTag(section) : null;
      if (tag) {
        const tg = ensureTableGroup(tag);
        tg.sections.push(section);
        trackTableGroupMin(tg, section.minY, section.minTableOrder);
      } else {
        remainingGroupSections.push(section);
      }
    }

    // Partition flat DP rows + orphan ER rows.
    const remainingDpRows = [];
    for (const row of flatDpRows) {
      const tag = rowTableTag(row);
      if (tag) {
        const tg = ensureTableGroup(tag);
        tg.rows.push(row);
        trackTableGroupMin(tg, row.y, tableOrderForCardId(row.cardId));
      } else {
        remainingDpRows.push(row);
      }
    }
    const remainingOrphanRows = [];
    for (const row of orphanErRows) {
      const tag = rowTableTag(row);
      if (tag) {
        const tg = ensureTableGroup(tag);
        tg.rows.push(row);
        trackTableGroupMin(tg, row.y, tableOrderForCardId(row.cardId));
      } else {
        remainingOrphanRows.push(row);
      }
    }

    // Sort each table group's direct rows + sub-sections, and compute the
    // header's aggregate row count (direct rows + every sub-section's rows).
    for (const tg of tableGroupsMap.values()) {
      sortRowsByOrder(tg.rows);
      tg.sections.sort((a, b) =>
        compareByTableOrderThenY(a.minTableOrder, a.minY, b.minTableOrder, b.minY),
      );
      let total = tg.rows.length;
      for (const s of tg.sections) total += s.rows.length;
      tg.totalRowCount = total;
    }

    const tableGroups = Array.from(tableGroupsMap.values()).sort(
      (a, b) => compareByTableOrderThenY(a.minTableOrder, a.minY, b.minTableOrder, b.minY),
    );

    return {
      orphanErRows: remainingOrphanRows,
      groupSections: remainingGroupSections,
      dpRows: remainingDpRows,
      tableGroups,
    };
  }

  // Per-row credit/action cost for an enrichment card, view-mode-aware.
  //   Projected: the card's resolved catalog / subroutine credits.
  //   Actual: real spend (data.stats.spend) averaged over its cellCount; falls
  //     back to the projected value when an ER has no spend yet so the column
  //     never blanks. `creditsUnknown` is set when a function's projected cost
  //     hasn't resolved yet (resolveSubroutineCostsForCards still in flight)
  //     so the cell can show a placeholder instead of a misleading 0.
  function erPerRowCost(er) {
    // Shared cost model (src/cost-model.js). Default fallbackToProjected:true
    // keeps the table column from blanking when an ER has no spend yet, and
    // creditsUnknown still flags unresolved subroutine functions.
    return window.__cb.cost.perRowCost(er);
  }

  function buildErChipData(er, opts) {
    const d = er.data || {};
    const isWaterfall = d.type === "waterfall";
    const providerChain = isWaterfall
      ? (d.providers || []).map((p) => p.displayName || "Provider").join(" \u2192 ")
      : null;
    // Effective frequency mirrors the canvas freqBadge logic (cards.js
    // ~line 830): a per-ER override wins, otherwise fall back to the
    // tab's global default. Read via __cb so we stay in sync with
    // whatever the summary bar most recently set.
    const cb = window.__cb;
    const frequencyId = d.frequencyCustom
      ? d.frequency
      : (d.frequency || cb?.getCurrentFrequencyId?.() || cb?.DEFAULT_FREQUENCY_ID);
    const multiplier = cb?.getFrequencyMultiplier?.(frequencyId) ?? 1;
    const frequencyLabel = cb?.getFrequencyLabel?.(frequencyId) || "Annually";

    const isFunction = d.actionKey === "execute-subroutine";
    const isSource = !!d.isSource;
    const isAi = !!d.isAi;

    // Resolve the selected AI model (name + provider + per-row credits) so the
    // chip menu can show "which model this AI column runs". modelOptions is
    // stamped at import time (buildErCardData) with live workspace pricing.
    let model = null;
    if (isAi && Array.isArray(d.modelOptions) && d.modelOptions.length > 0) {
      const sel = d.modelOptions.find((m) => m.id === d.selectedModel) || d.modelOptions[0];
      if (sel) model = { id: sel.id, name: sel.name, provider: sel.provider, credits: sel.credits };
    }

    // One-word kind label; precedence mirrors the chip color precedence in
    // buildErChipEl (waterfall > function > source > ai > action).
    const kind = isWaterfall
      ? "Waterfall"
      : isFunction
        ? "Function"
        : isSource
          ? "Source"
          : isAi
            ? "AI"
            : "Action";

    // Scoped Records for this ER's use case (matches the per-use-case header in
    // multi-import; falls back to the global Records otherwise) + whether it's
    // been overridden from the imported baseline (drives the Total(actual) amber).
    const ucKey = cb?.cost?.useCaseKeyForCard ? cb.cost.useCaseKeyForCard(er) : null;
    // Table-native (v7.23+): per-use-case records drive cost whenever there's a
    // use case (>= 1), so the per-row records/override display follows the same
    // threshold (was 2+, which left a single imported table on global records).
    const multiUC =
      cb?.cost?.useCaseCount?.() >= 1 && ucKey && ucKey !== cb.cost.OTHER_USE_CASE;
    const scopedRecords = multiUC
      ? Number(cb.cost.useCaseRecords(ucKey)) || 0
      : Number(cb?.getRecordsCount?.()) || 0;
    const recordsBaseline = multiUC
      ? cb.cost.useCaseRecordsActual(ucKey)
      : typeof cb?.recordsActual === "number" && cb.recordsActual > 0
        ? cb.recordsActual
        : null;
    const recordsOverridden =
      recordsBaseline != null && recordsBaseline > 0 && scopedRecords !== recordsBaseline;
    const actualCov =
      d.stats?.coverage && Number(d.stats.coverage.total) > 0
        ? { ran: Number(d.stats.coverage.ran) || 0, total: Number(d.stats.coverage.total) || 0 }
        : null;

    return {
      id: er.id,
      name: d.displayName || d.text || (isWaterfall ? "Waterfall" : "Untitled enrichment"),
      isWaterfall,
      // Type flags for per-kind chip color (see buildErChipEl): function =
      // subroutine ("Run function"), source = source-type enrichment.
      isFunction,
      isSource,
      isAi,
      kind,
      providerChain,
      packageName: d.packageName || null,
      // Logo inputs (mirror the canvas card icon logic in cards.js).
      iconUrl: d.iconUrl || null,
      iconSvgHtml: d.iconSvgHtml || null,
      model,
      // Numeric "Clay Credit Budget" (runBudget) when this AI column's per-row
      // cost was set from it at import — drives the conditional "Clay Budgeted"
      // provenance row in the details menu. null = not budgeted.
      clayBudget: d.clayBudget ?? null,
      // Per-row cost (view-mode-aware) for the details menu — in Actual mode this
      // is measured spend ÷ rows that ran (coverage.ran via actualRowDenominator).
      cost: erPerRowCost(er),
      // Run-total inputs for the details-menu "Total" row. Projected total =
      // per-row × records × coverage × frequency; actual total = measured spend ×
      // (records / coverage.total) × frequency (matches the use-case header).
      records: scopedRecords,
      recordsOverridden,
      actualCoverage: actualCov,
      coverageRows: d.coverageRows != null ? Number(d.coverageRows) : null,
      spendTotal: d.stats?.spend
        ? {
            credits: Number(d.stats.spend.credits) || 0,
            actions: Number(d.stats.spend.actionExecutions) || 0,
          }
        : null,
      usePrivateKey: !!d.usePrivateKey,
      // Frozen (deactivated) ERs grey their pill and contribute no cost; a note
      // surfaces as a badge on the chip (the ER's own note, not the DP row's).
      frozen: !!d.frozen,
      note: d.note || null,
      frequencyId,
      frequencyLabel,
      multiplier,
      // True when the user pinned a per-ER frequency override. The chip only
      // shows the ×N badge in that case; otherwise frequency lives in the
      // details menu (it inherits the global default).
      frequencyCustom: !!d.frequencyCustom,
      // Navigation back to the source Clay column ("Find in table"). Present
      // only on imported cards; gates the menu footer action.
      fieldId: d.fieldId || null,
      tableId: d.tableId || null,
      viewId: d.viewId || null,
      // Subroutine ("Run function") cards reference a "main function" table.
      // Gates the function-only "Open function" footer action.
      referencedTableId: d.referencedTableId || null,
      // Multi-ER lineage context (only set when this chip belongs to a DP row):
      // the per-(DP,ER) run-share, whether it's the primary (#1), and the host
      // DP card so the % pill can read/write the share on the right edge.
      runShare: opts && opts.runShare != null ? opts.runShare : null,
      isPrimary: opts ? !!opts.isPrimary : false,
      dpCardId: opts && opts.dpCardId != null ? opts.dpCardId : null,
      // True when the DP links 2+ ERs — the chip shows its run-share badge.
      multiEr: opts ? !!opts.multiEr : false,
    };
  }

  // ---- Mutation handlers ----
  //
  // Mirrors the writers in src/export.js — kept duplicated so the table view
  // doesn't have to depend on the export modal's IIFE-private functions.
  // Both code paths converge on __cb.model.update() (+ saveTabs()), the single
  // write path (C3.1), so undo history and persistence behave identically.

  function commitDpName(cardId, value) {
    const canvas = __cb.canvas;
    if (!canvas) return;
    const card = canvas.getCardById(cardId);
    if (!card) return;
    const next = (value || "").trim();
    const prev = card.data.text || card.data.displayName || "";

    if (next !== prev) {
      card.data.text = next;
      card.data.displayName = next;

      const textEl = card.el?.querySelector(".cb-dp-text");
      if (textEl) {
        textEl.textContent = next;
        if (next) textEl.removeAttribute("data-placeholder");
        else textEl.setAttribute("data-placeholder", "Type data point\u2026");
      }

      __cb.model.update();
      if (__cb.saveTabs) __cb.saveTabs();
    }

    // Always re-render so the rename input reverts to static text on commit
    // (Enter / blur), even when the name is unchanged. pendingRenameCardId was
    // already cleared by the render focus pass, so this rebuilds the static row.
    if (__cb.tableView?.refresh) __cb.tableView.refresh();
  }

  function commitFillRate(cardId, rawValue) {
    const canvas = __cb.canvas;
    if (!canvas) return;
    const card = canvas.getCardById(cardId);
    if (!card) return;

    const parsed = Number(rawValue);
    const pct = Number.isFinite(parsed) ? Math.max(0, Math.min(100, parsed)) : 0;

    const fr = card.data.fillRate || { numerator: 0, denominator: 100 };
    const denominator = fr.denominator > 0 ? fr.denominator : 100;
    const numerator = Math.round((pct / 100) * denominator);
    card.data.fillRate = { numerator, denominator };
    card.data.fillRateCustom = true;

    const labelEl = card.el?.querySelector(".cb-dp-fill-label");
    if (labelEl) labelEl.textContent = `${pct}%`;

    __cb.model.update();
    if (__cb.saveTabs) __cb.saveTabs();
  }

  // Actual "rows this enrichment ran on" — measured cells, falling back to
  // coverage attempts. Mirrors erRanCount in buildRows so the widest-ER pick
  // for a DP's fill matches what Actual mode displays.
  function erActualRanCount(er) {
    const d = er?.data || {};
    const cells = Number(d.stats?.spend?.cellCount) || 0;
    if (cells > 0) return cells;
    return Number(d.stats?.coverage?.ran) || 0;
  }

  // The widest linked enrichment for a data point (max actual run count). The
  // table's Actual fill cell divides by THIS ER's attempted rows, so the copy
  // routine resolves the same ER to reproduce the displayed %.
  function widestActualErForDp(dpCard) {
    const ers = erCardsForDp(dpCard);
    if (ers.length === 0) return null;
    let best = null;
    let widest = -1;
    for (const e of ers) {
      const n = erActualRanCount(e);
      if (n > widest) { widest = n; best = e; }
    }
    return best || ers[0];
  }

  // "Copy coverage & fill from Actual": seed the editable PROJECTED fields from
  // the loaded actual results so the rep can re-scope (add/remove use cases)
  // off a real baseline. Copies ONLY volume signals — coverage (ran/total) per
  // enrichment and fill % per data point. Cost is never copied: per-row credits,
  // model selection, and pricing stay catalog-based, so the projected total
  // recomputes from the new volume rather than importing actual spend. The whole
  // copy is one undoable transaction.
  function copyActualToProjected() {
    const cb = window.__cb;
    const cards = cb.model?.getNodes?.() || [];
    let touched = false;

    // Enrichments: actual ran -> coverageRows (X, drives projected cost),
    // actual total -> coverageTotal (Y, display denominator). Marked custom so
    // they don't snap back to the default records total on the next refresh.
    for (const er of cards) {
      if (!isErType(er.data?.type)) continue;
      const cov = er.data.stats?.coverage;
      if (!cov || !(Number(cov.total) > 0)) continue;
      er.data.coverageRows = Number(cov.ran) || 0;
      er.data.coverageCustom = true;
      er.data.coverageTotal = Number(cov.total) || 0;
      er.data.coverageTotalCustom = true;
      touched = true;
    }

    // Data points: actual fill % -> fillRate {numerator: pct, denominator: 100}.
    // Skip when the full-table profile is still loading or there's no usable
    // null% signal (those DPs keep their current projected fill).
    for (const dp of cards) {
      if (dp.data?.type !== "dp") continue;
      const er = widestActualErForDp(dp);
      const af = actualFillPct(er, dp);
      if (af.loading || af.pct == null) continue;
      dp.data.fillRate = { numerator: af.pct, denominator: 100 };
      dp.data.fillRateCustom = true;
      touched = true;
    }

    // Multi-ER data points: copy the MEASURED run-share (each linked ER's actual
    // ran ÷ the widest linked ER, mirroring the Actual chip badge) into the
    // projected stored shares, so the % badges in Projected reflect what Actual
    // measured rather than the default split. Cost stays coverage-driven — the
    // ERs above are now coverageCustom, so cost.erShareMult ignores the share —
    // so this is a display copy and never double-discounts.
    const erByKey = new Map();
    for (const c of cards) {
      if (!isErType(c.data?.type)) continue;
      const k = lineageKeyOf(c);
      if (k != null && !erByKey.has(k)) erByKey.set(k, c);
    }
    for (const dp of cards) {
      if (dp.data?.type !== "dp") continue;
      const keys = cb.dpErKeys(dp);
      if (keys.length < 2) continue;
      let maxRan = 0;
      for (const k of keys) {
        const er = erByKey.get(k);
        if (er) maxRan = Math.max(maxRan, erActualRanCount(er));
      }
      if (maxRan <= 0) continue; // no measured signal yet — keep projected shares
      for (let i = 0; i < keys.length; i++) {
        const er = erByKey.get(keys[i]);
        if (!er) continue;
        cb.setDpErShare(dp, keys[i], Math.min(1, erActualRanCount(er) / maxRan));
      }
      touched = true;
    }

    if (!touched) return;
    // update() captures one undo snapshot, notifies subscribers (which refreshes
    // the table) and schedules persist; saveTabs forces an immediate write to
    // match the other coverage/fill commit paths.
    cb.model?.update?.();
    if (cb.saveTabs) cb.saveTabs();
    cb.canvas?.refreshCreditTotal?.();
    cb.canvas?.updateGroupCredits?.();
    cb.tableView?.refresh?.();
  }

  // Whether any enrichment in the current tab has loaded actual coverage —
  // gates the "Copy coverage & fill from Actual" menu item (nothing to copy
  // before an import's run-status stats have landed).
  function hasActualCoverage() {
    const cards = window.__cb.model?.getNodes?.() || [];
    return cards.some(
      (c) =>
        isErType(c.data?.type) &&
        Number(c.data?.stats?.coverage?.total) > 0,
    );
  }

  // Per-row note commit. Writes the free-text note onto the row's primary
  // card (DP card for DP rows, ER card for orphan-ER rows) so it round-trips
  // through persistence. Empty text clears the note (drops the badge).
  function commitNote(cardId, text) {
    const canvas = __cb.canvas;
    if (!canvas?.getCardById) return;
    const card = canvas.getCardById(cardId);
    if (!card) return;
    const next = (text || "").trim();
    const prev = (card.data.note || "").trim();
    if (next === prev) return;
    card.data.note = next || null;
    __cb.model.update();
    if (__cb.saveTabs) __cb.saveTabs();
  }

  // ---- Row note popover + hover preview ----

  function hideNotePreview() {
    if (notePreviewEl) { notePreviewEl.remove(); notePreviewEl = null; }
  }

  // Read-only hover preview of the note text, anchored above/below the badge.
  // Body-appended (position: fixed) so the table's overflow doesn't clip it.
  function showNotePreview(text, anchorEl) {
    hideNotePreview();
    const note = (text || "").trim();
    if (!note || !anchorEl) return;
    const box = document.createElement("div");
    box.className = "cb-table-view-note-preview";
    box.textContent = note;
    document.body.appendChild(box);
    notePreviewEl = box;
    const aRect = anchorEl.getBoundingClientRect();
    const bRect = box.getBoundingClientRect();
    let left = Math.min(aRect.left, window.innerWidth - bRect.width - 8);
    let top = aRect.bottom + 6;
    if (top + bRect.height > window.innerHeight - 8) {
      top = Math.max(8, aRect.top - 6 - bRect.height);
    }
    box.style.left = `${Math.max(8, left)}px`;
    box.style.top = `${top}px`;
  }

  function closeNotePopover() {
    if (notePopoverEl) { notePopoverEl.remove(); notePopoverEl = null; }
    if (notePopoverBackdrop) { notePopoverBackdrop.remove(); notePopoverBackdrop = null; }
  }

  // Editor popover: a textarea prefilled with the current note. Enter commits,
  // Shift+Enter inserts a newline, Escape cancels, outside-click commits.
  function openNotePopover(cardId, anchorEl) {
    closeNotePopover();
    hideNotePreview();
    closeContextMenu();
    const card = __cb.canvas?.getCardById?.(cardId);
    if (!card) return;

    notePopoverBackdrop = document.createElement("div");
    notePopoverBackdrop.className = "cb-table-view-note-backdrop";
    notePopoverBackdrop.addEventListener("mousedown", (evt) => {
      evt.stopPropagation();
      // Commit on outside-click so a quick note isn't lost.
      const ta = notePopoverEl?.querySelector("textarea");
      if (ta) commitNote(cardId, ta.value);
      closeNotePopover();
    });

    const pop = document.createElement("div");
    pop.className = "cb-table-view-note-popover";
    pop.addEventListener("mousedown", (evt) => evt.stopPropagation());

    const ta = document.createElement("textarea");
    ta.className = "cb-table-view-note-textarea";
    ta.value = card.data.note || "";
    ta.placeholder = "Leave a note\u2026";
    ta.rows = 3;
    ta.addEventListener("keydown", (evt) => {
      if (evt.key === "Enter" && !evt.shiftKey) {
        evt.preventDefault();
        commitNote(cardId, ta.value);
        closeNotePopover();
      } else if (evt.key === "Escape") {
        evt.preventDefault();
        evt.stopPropagation();
        closeNotePopover();
      }
    });
    pop.appendChild(ta);

    document.body.appendChild(notePopoverBackdrop);
    document.body.appendChild(pop);
    notePopoverEl = pop;

    // Anchor below the badge/cell, clamped to the viewport (flip above when it
    // would overflow the bottom).
    pop.style.position = "fixed";
    pop.style.zIndex = "9999999";
    const aRect = (anchorEl || hostEl).getBoundingClientRect();
    const pRect = pop.getBoundingClientRect();
    let left = Math.min(aRect.left, window.innerWidth - pRect.width - 8);
    let top = aRect.bottom + 6;
    if (top + pRect.height > window.innerHeight - 8) {
      top = Math.max(8, aRect.top - 6 - pRect.height);
    }
    pop.style.left = `${Math.max(8, left)}px`;
    pop.style.top = `${top}px`;

    ta.focus();
    // Place the caret at the end rather than selecting everything, so typing
    // appends to an existing note.
    ta.setSelectionRange(ta.value.length, ta.value.length);
  }

  // Per-ER frequency commit. Mirrors the canvas freqBadge callback
  // (cards.js ~line 837): we route through applyClusterFrequency so
  // every ER in the origin card's snap-cluster picks up the same
  // value (and gets marked `frequencyCustom` so the global default
  // stops auto-overwriting them). The credit-total + group-credit
  // refreshes keep the summary bar and any visible group cards in
  // sync; notifyChange propagates to onCanvasStateChange so the
  // table view (and collaborators) re-render with the new ×N badges.
  function commitFrequency(cardId, freqId) {
    const canvas = __cb.canvas;
    if (!canvas?.applyClusterFrequency) return;
    canvas.applyClusterFrequency(cardId, freqId);
    if (canvas.refreshCreditTotal) canvas.refreshCreditTotal();
    if (canvas.updateGroupCredits) canvas.updateGroupCredits();
    __cb.model.update();
    if (__cb.saveTabs) __cb.saveTabs();
  }

  // ---- Run-share (multi-ER) mutations + popover --------------------------

  // Freeze a DP's effective shares into stored values so editing one ER's share
  // doesn't drop the others back to their implicit defaults.
  function materializeDpShares(dp) {
    if (dp.data.sourceEnrichmentShares) return;
    const keys = __cb.dpErKeys(dp);
    for (let i = 0; i < keys.length; i++) {
      __cb.setDpErShare(dp, keys[i], __cb.defaultErShare(i, keys.length));
    }
  }

  function lineageKeyForCardId(cardId) {
    const er = __cb.canvas?.getCardById?.(cardId);
    if (!er) return null;
    return __cb.canvas.erLineageKeyOf ? __cb.canvas.erLineageKeyOf(er) : lineageKeyOf(er);
  }

  // The DP's row base for the run-share popover: the widest linked ER's coverage
  // numerator — measured coverage.ran when present, else the projected
  // coverageRows, else the scoped records. The % <-> rows conversion keys off
  // this (rows = share x base), so it reads "13% of ~650 rows".
  function dpRowBase(dpCardId) {
    const records = __cb.getRecordsCount ? Number(__cb.getRecordsCount()) || 0 : 0;
    const dp = __cb.canvas?.getCardById?.(dpCardId);
    if (!dp) return records;
    const erByKey = new Map();
    for (const c of __cb.model?.getNodes?.() || []) {
      if (!c.data || !isErType(c.data.type)) continue;
      const k = lineageKeyOf(c);
      if (k != null && !erByKey.has(k)) erByKey.set(k, c);
    }
    let base = 0;
    for (const key of __cb.dpErKeys(dp)) {
      const er = erByKey.get(key);
      if (!er) continue;
      const d = er.data || {};
      const ran = Number(d.stats?.coverage?.ran) || 0;
      const cov = ran > 0 ? ran : d.coverageRows != null ? Number(d.coverageRows) : records;
      if (cov > base) base = cov;
    }
    return base > 0 ? base : records;
  }

  // Re-derive the per-(DP, ER) run-share context outside the main render loop
  // (used by the details menu's in-place refresh). Mirrors buildRows' resolution
  // exactly: projected = stored share else the primary-weighted default split;
  // actual = measured cellCount (else coverage.ran) vs the widest linked ER.
  function erRunShareFor(dpCardId, erCardId) {
    const dp = __cb.canvas?.getCardById?.(dpCardId);
    if (!dp) return null;
    const key = lineageKeyForCardId(erCardId);
    const keys = __cb.dpErKeys(dp);
    const idx = keys.indexOf(key);
    if (idx < 0) return null;
    const n = keys.length;
    if (n <= 1) return { runShare: 1, isPrimary: idx === 0, dpCardId, multiEr: false };
    let share;
    if (window.__cb?.viewMode === "actual") {
      const erByKey = new Map();
      for (const c of __cb.model?.getNodes?.() || []) {
        if (!c.data || !isErType(c.data.type)) continue;
        const k = lineageKeyOf(c);
        if (k != null && !erByKey.has(k)) erByKey.set(k, c);
      }
      const ranOf = (k) => {
        const d = erByKey.get(k)?.data || {};
        const cells = Number(d.stats?.spend?.cellCount) || 0;
        return cells > 0 ? cells : Number(d.stats?.coverage?.ran) || 0;
      };
      let maxRan = 0;
      for (const k of keys) maxRan = Math.max(maxRan, ranOf(k));
      share = maxRan > 0 ? Math.min(1, ranOf(key) / maxRan) : idx === 0 ? 1 : 0;
    } else {
      const stored = __cb.dpErShare(dp, key);
      share = stored != null ? stored : __cb.defaultErShare(idx, n);
    }
    return { runShare: share, isPrimary: idx === 0, dpCardId, multiEr: true };
  }

  // Keep a multi-ER "fully linked": copy sourceDp's ordered keys + run-shares to
  // every OTHER DP that links the exact same SET of ERs (order-independent
  // match), so editing the % / order on one DP applies the same proportion to
  // every DP the multi-ER spans. Lineage-global (all model nodes), mirroring the
  // cost split. No model.update here — the caller batches one update.
  function propagateDpMultiEr(sourceDp) {
    if (!sourceDp || !sourceDp.data) return;
    const srcKeys = __cb.dpErKeys(sourceDp);
    if (srcKeys.length < 2) return; // single-ER: nothing to share
    const sig = srcKeys.slice().sort().join("|");
    const hasShares = !!sourceDp.data.sourceEnrichmentShares;
    for (const c of __cb.model?.getNodes?.() || []) {
      if (!c || c === sourceDp || !c.data || c.data.type !== "dp") continue;
      const keys = __cb.dpErKeys(c);
      if (keys.length !== srcKeys.length) continue;
      if (keys.slice().sort().join("|") !== sig) continue;
      __cb.setDpErKeys(c, srcKeys); // unify order
      if (hasShares) {
        for (let i = 0; i < srcKeys.length; i++) {
          const s = __cb.dpErShare(sourceDp, srcKeys[i]);
          __cb.setDpErShare(c, srcKeys[i], s != null ? s : __cb.defaultErShare(i, srcKeys.length));
        }
      } else if (c.data.sourceEnrichmentShares) {
        delete c.data.sourceEnrichmentShares; // keep them on the same default too
      }
    }
  }

  // Commit one ER's run-share (% -> 0..N share) AND its 1-based order on a DP in
  // a single model update. Run-share drives projected cost (share x base); the
  // use case is inferred purely from the sum of the percentages (~100% = clean
  // merge, 200%+ = needs two or more full ERs). Order just re-positions chips.
  // The edit then propagates to every DP sharing the same multi-ER set.
  function commitDpShareAndOrder(dpCardId, erCardId, pct, pos) {
    const dp = __cb.canvas?.getCardById?.(dpCardId);
    const key = lineageKeyForCardId(erCardId);
    if (!dp || key == null) return;
    materializeDpShares(dp);
    __cb.setDpErShare(dp, key, Math.max(0, Number(pct) || 0) / 100);
    const keys = __cb.dpErKeys(dp);
    const from = keys.indexOf(key);
    const to = Math.min(keys.length - 1, Math.max(0, (Number(pos) || 1) - 1));
    if (from >= 0 && from !== to) {
      keys.splice(from, 1);
      keys.splice(to, 0, key);
      __cb.setDpErKeys(dp, keys);
    }
    propagateDpMultiEr(dp);
    __cb.model.update();
    if (__cb.saveTabs) __cb.saveTabs();
  }

  function closeErShareMenu() {
    // Defensive: blur + Enter can both fire commit -> closeErShareMenu, and a
    // commit re-render can detach the nodes first, so guard the removals.
    if (erShareMenuOutsideUnbind) { erShareMenuOutsideUnbind(); erShareMenuOutsideUnbind = null; }
    try { if (erShareMenuEl) erShareMenuEl.remove(); } catch (e) { /* already detached */ }
    try { if (erShareMenuBackdrop) erShareMenuBackdrop.remove(); } catch (e) { /* already detached */ }
    erShareMenuEl = null;
    erShareMenuBackdrop = null;
  }

  // Popover anchored to a chip's % badge (or the details-menu Run-share row).
  // Three linked rows — % of rows, the equivalent row count (share x base off
  // the coverage numerator), and the chip order (1..N) — with NO preset buttons:
  // the merge (~100%) vs needs-all (200%+) use case is inferred from the sum,
  // shown as a Σ hint. % and rows stay in sync live; commit writes share+order
  // in one model update.
  function openErShareMenu(er, anchorEl) {
    closeErShareMenu();
    const dp = __cb.canvas?.getCardById?.(er.dpCardId);
    const key = lineageKeyForCardId(er.id);
    const keys = dp ? __cb.dpErKeys(dp) : [];
    const n = keys.length || 1;
    const curIdx = Math.max(0, keys.indexOf(key));
    const base = dpRowBase(er.dpCardId);
    // Actual mode = measured run-share (this ER's runs ÷ the widest linked ER).
    // Same popover, but read-only: inputs disabled, no order/Σ, no commit.
    const readOnly = window.__cb?.viewMode === "actual";

    erShareMenuBackdrop = document.createElement("div");
    erShareMenuBackdrop.className = "cb-table-view-note-backdrop";

    const pop = document.createElement("div");
    pop.className = "cb-table-view-share-popover";
    pop.addEventListener("mousedown", (evt) => evt.stopPropagation());

    const title = document.createElement("div");
    title.className = "cb-table-view-share-title";
    title.textContent = readOnly ? "Run-share \u00b7 measured" : "Run-share";
    pop.appendChild(title);

    const pctToRows = (pct) => (base > 0 ? Math.round(((Number(pct) || 0) / 100) * base) : 0);
    const rowsToPct = (rows) => (base > 0 ? Math.round(((Number(rows) || 0) / base) * 100) : 0);

    const mkRow = (labelText) => {
      const row = document.createElement("div");
      row.className = "cb-table-view-share-row";
      const input = document.createElement("input");
      input.type = "number";
      input.min = "0";
      input.className = "cb-table-view-share-input";
      const label = document.createElement("span");
      label.textContent = labelText;
      row.appendChild(input);
      row.appendChild(label);
      pop.appendChild(row);
      return input;
    };

    // Row 1: % of rows.
    const pctInput = mkRow("% of rows");
    pctInput.max = "1000";
    pctInput.value = String(Math.round((er.runShare ?? 0) * 100));

    // Row 2: equivalent rows (= % x base) — linked to row 1 both ways.
    const rowsInput = mkRow(base > 0 ? `of ~${formatNumber(base)} rows` : "rows");
    rowsInput.value = String(pctToRows(pctInput.value));

    // Read-only (Actual) view: the % is measured, so skip the order row, the
    // editable Σ hint, and all commit wiring. Inputs are disabled; a short note
    // names the denominator (mirrors the Fill cell tooltip). Outside-click,
    // backdrop, Enter, and Escape all just close.
    if (readOnly) {
      pctInput.disabled = true;
      rowsInput.disabled = true;
      const note = document.createElement("div");
      note.className = "cb-table-view-share-sum";
      note.textContent =
        "Measured \u2014 rows that ran \u00f7 the widest linked enrichment";
      pop.appendChild(note);

      const close = () => closeErShareMenu();
      pop.tabIndex = -1;
      pop.addEventListener("keydown", (evt) => {
        if (evt.key === "Escape" || evt.key === "Enter") {
          evt.preventDefault();
          close();
        }
      });
      erShareMenuBackdrop.addEventListener("mousedown", (evt) => {
        evt.stopPropagation();
        close();
      });

      document.body.appendChild(erShareMenuBackdrop);
      document.body.appendChild(pop);
      erShareMenuEl = pop;
      erShareMenuOutsideUnbind =
        window.__cb.bindOutsideMousedown?.(pop, close) ?? null;
      pop.style.position = "fixed";
      pop.style.zIndex = "9999999";
      __cb.placePopover?.(pop, anchorEl || hostEl, { gap: 6, align: "left" });
      pop.focus({ preventScroll: true });
      return;
    }

    // Row 3: order (1..N) — reposition this chip among the DP's ERs.
    const orderInput = mkRow(n > 1 ? `order (1\u2013${n})` : "order");
    orderInput.min = "1";
    orderInput.max = String(n);
    orderInput.value = String(curIdx + 1);

    // Σ hint: the inferred use case, read off the sum of all ERs' shares.
    const sumEl = document.createElement("div");
    sumEl.className = "cb-table-view-share-sum";
    const renderSum = () => {
      let total = 0;
      for (let i = 0; i < keys.length; i++) {
        const k = keys[i];
        if (k === key) { total += Math.round(Number(pctInput.value) || 0); continue; }
        const stored = dp ? __cb.dpErShare(dp, k) : null;
        const s = stored != null ? stored : __cb.defaultErShare(i, keys.length);
        total += Math.round(s * 100);
      }
      const mode = total >= 150 ? "needs all" : "clean merge";
      sumEl.textContent = keys.length > 1 ? `\u03a3 ${total}% \u00b7 ${mode}` : `${total}%`;
    };
    renderSum();
    pop.appendChild(sumEl);

    pctInput.addEventListener("input", () => {
      rowsInput.value = String(pctToRows(pctInput.value));
      renderSum();
    });
    rowsInput.addEventListener("input", () => {
      pctInput.value = String(rowsToPct(rowsInput.value));
      renderSum();
    });

    let committed = false;
    function commit() {
      if (committed) return; // blur + outside click + Enter can all fire
      committed = true;
      const pos = Math.min(n, Math.max(1, Math.round(Number(orderInput.value) || curIdx + 1)));
      commitDpShareAndOrder(er.dpCardId, er.id, pctInput.value, pos);
      closeErShareMenu();
    }
    for (const input of [pctInput, rowsInput, orderInput]) {
      input.addEventListener("keydown", (evt) => {
        if (evt.key === "Enter") { evt.preventDefault(); commit(); }
        else if (evt.key === "Escape") { evt.preventDefault(); committed = true; closeErShareMenu(); }
      });
    }
    pop.addEventListener("focusout", (evt) => {
      if (!pop.contains(evt.relatedTarget)) commit();
    });
    erShareMenuBackdrop.addEventListener("mousedown", (evt) => {
      evt.stopPropagation();
      commit();
    });

    document.body.appendChild(erShareMenuBackdrop);
    document.body.appendChild(pop);
    erShareMenuEl = pop;
    // Capture-phase outside mousedown -> commit (mirrors the backdrop), so an
    // edit isn't lost when the click lands on the ER details menu, which sits a
    // z-index tier above our backdrop and would otherwise swallow it. commit()
    // is idempotent, so this never double-fires with the backdrop or focusout.
    erShareMenuOutsideUnbind =
      window.__cb.bindOutsideMousedown?.(pop, commit) ?? null;
    pop.style.position = "fixed";
    pop.style.zIndex = "9999999";
    __cb.placePopover?.(pop, anchorEl || hostEl, { gap: 6, align: "left" });
    pctInput.focus();
    pctInput.select();
  }

  // Table-view-safe model switch for AI columns. Mirrors the canvas applyModel
  // (src/canvas/ui.js) data writes — selectedModel + credits + provider icon —
  // but persists through the table view's canonical path (model.update +
  // saveTabs) instead of touching card.el, which is null under the lazy canvas.
  // model.update() notifies subscribers, so the table re-renders (which also
  // closes this menu) with the new per-row credits.
  function commitModel(cardId, model) {
    const canvas = __cb.canvas;
    if (!canvas?.getCardById) return;
    const card = canvas.getCardById(cardId);
    if (!card) return;
    const d = card.data;
    d.selectedModel = model.id;
    // Manually picking a model drops the column's "Clay Credit Budget"
    // (runBudget) provenance — the per-row cost is now the picked model's flat
    // credit, so the "Clay Budgeted" details row no longer applies.
    d.clayBudget = null;
    if (d.usePrivateKey) {
      d._originalCredits = model.credits;
    } else {
      d.credits = model.credits;
      d.creditText =
        model.credits != null ? `${window.__cb.aiTilde(model.id)}${model.credits} / row` : null;
    }
    const provIcon = model.provider && window.__cb.AI_PROVIDER_ICONS
      ? window.__cb.AI_PROVIDER_ICONS[model.provider]
      : null;
    if (provIcon) d.iconUrl = provIcon;
    if (canvas.refreshCreditTotal) canvas.refreshCreditTotal();
    if (canvas.updateGroupCredits) canvas.updateGroupCredits();
    __cb.model.update();
    if (__cb.saveTabs) __cb.saveTabs();
  }

  // Grouped provider → model picker, reusing the canvas picker's CSS classes
  // (styles/pickers.css) so it looks identical to the canvas model chip's
  // dropdown. Picking a model commits via commitModel; selection triggers a
  // table refresh that closes the details menu.
  function closeErMenuModelPicker() {
    if (erMenuModelPickerOutsideUnbind) { erMenuModelPickerOutsideUnbind(); erMenuModelPickerOutsideUnbind = null; }
    if (erMenuModelPickerEl) { erMenuModelPickerEl.remove(); erMenuModelPickerEl = null; }
    if (erMenuModelPickerBackdrop) { erMenuModelPickerBackdrop.remove(); erMenuModelPickerBackdrop = null; }
  }

  function openErMenuModelPicker(er, anchorEl) {
    closeErMenuModelPicker();
    const cb = window.__cb;
    const card = cb?.canvas?.getCardById?.(er.id);
    const options = (cb?.getModelOptions ? cb.getModelOptions() : null) || [];
    if (!card || options.length === 0) return;
    const selectedId = card.data.selectedModel;

    const providers = new Map();
    for (const m of options) {
      const key = m.provider || "Other";
      if (!providers.has(key)) providers.set(key, []);
      providers.get(key).push(m);
    }
    const selectedProvider = options.find((m) => m.id === selectedId)?.provider || null;

    erMenuModelPickerBackdrop = document.createElement("div");
    erMenuModelPickerBackdrop.className = "cb-model-picker-backdrop";
    erMenuModelPickerBackdrop.addEventListener("mousedown", (e) => {
      e.stopPropagation();
      closeErMenuModelPicker();
    });

    const picker = document.createElement("div");
    picker.className = "cb-model-picker cb-model-picker-grouped";
    picker.addEventListener("mousedown", (e) => e.stopPropagation());

    for (const [providerName, models] of providers) {
      const row = document.createElement("div");
      row.className = "cb-model-provider-row";
      if (providerName === selectedProvider) row.classList.add("cb-model-provider-active");

      const label = document.createElement("span");
      label.className = "cb-model-provider-name";
      label.textContent = providerName;
      const chevron = document.createElement("span");
      chevron.className = "cb-model-provider-chevron";
      chevron.innerHTML =
        '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" ' +
        'fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" ' +
        'stroke-linejoin="round"><polyline points="15 6 9 12 15 18"/></svg>';
      // Submenu flies out to the LEFT, so the chevron leads (points left).
      row.appendChild(chevron);
      row.appendChild(label);

      const sub = document.createElement("div");
      sub.className = "cb-model-submenu";
      const subInner = document.createElement("div");
      subInner.className = "cb-model-submenu-inner";
      row.addEventListener("mouseenter", () => window.__cb.clampSubmenu?.(sub));
      for (const model of models) {
        const opt = document.createElement("button");
        opt.type = "button";
        opt.className = "cb-model-option";
        if (model.id === selectedId) opt.classList.add("cb-model-option-active");
        const nameSpan = document.createElement("span");
        nameSpan.className = "cb-model-option-name";
        nameSpan.textContent = model.name;
        const costSpan = document.createElement("span");
        costSpan.className = "cb-model-option-cost";
        costSpan.textContent =
          model.credits != null ? `${window.__cb.aiTilde(model.id)}${model.credits} / row` : "";
        opt.appendChild(nameSpan);
        opt.appendChild(costSpan);
        opt.addEventListener("click", (e) => {
          e.stopPropagation();
          // Close the picker first so it's gone before commit → refresh
          // re-renders the (still-open) details menu in place.
          closeErMenuModelPicker();
          commitModel(er.id, model);
        });
        subInner.appendChild(opt);
      }
      sub.appendChild(subInner);
      row.appendChild(sub);
      picker.appendChild(row);
    }

    document.body.appendChild(erMenuModelPickerBackdrop);
    document.body.appendChild(picker);
    erMenuModelPickerEl = picker;
    // Capture-phase outside mousedown so the picker closes even when the click
    // lands on the ER details menu chrome above its backdrop.
    erMenuModelPickerOutsideUnbind =
      window.__cb.bindOutsideMousedown?.(picker, closeErMenuModelPicker) ?? null;

    // Clamp the picker to the viewport. Provider submenus always fly out to the
    // LEFT (see pickers.css + builder above), so there's no right-edge flip to
    // compute — clampSubmenu handles vertical overflow on hover.
    window.__cb.placePopover?.(picker, anchorEl, { gap: 4 });
  }

  // Table-view-safe private-key toggle. Mirrors the canvas credit pill's
  // showKeyToggle data writes (usePrivateKey + _originalCredits round-trip) but
  // persists via model.update + saveTabs instead of touching card.el. Private
  // key zeroes data credits (erPerRowCost returns 0 when usePrivateKey) but
  // leaves action executions unchanged.
  function commitPrivateKey(cardId, useKey) {
    const canvas = __cb.canvas;
    if (!canvas?.getCardById) return;
    const card = canvas.getCardById(cardId);
    if (!card) return;
    const d = card.data;
    if (useKey) {
      if (d._originalCredits == null && d.credits != null) d._originalCredits = d.credits;
      d.usePrivateKey = true;
    } else {
      d.usePrivateKey = false;
      if (d._originalCredits != null) {
        d.credits = d._originalCredits;
        const t = d.isAi ? window.__cb.aiTilde(d.selectedModel) : "~";
        d.creditText = `${t}${d._originalCredits} / row`;
      }
    }
    if (canvas.refreshCreditTotal) canvas.refreshCreditTotal();
    if (canvas.updateGroupCredits) canvas.updateGroupCredits();
    if (canvas.updateDpCosts) canvas.updateDpCosts();
    __cb.model.update();
    if (__cb.saveTabs) __cb.saveTabs();
  }

  function closeErMenuKeyToggle() {
    if (erMenuKeyToggleOutsideUnbind) { erMenuKeyToggleOutsideUnbind(); erMenuKeyToggleOutsideUnbind = null; }
    if (erMenuKeyToggleEl) { erMenuKeyToggleEl.remove(); erMenuKeyToggleEl = null; }
    if (erMenuKeyToggleBackdrop) { erMenuKeyToggleBackdrop.remove(); erMenuKeyToggleBackdrop = null; }
  }

  // The cost pill's credit-segment popover, reusing the canvas .cb-key-toggle
  // styling (styles/cards.css) so it's identical to the canvas. One option that
  // flips between "Use private key" and "Use Clay credits".
  function openErMenuKeyToggle(er, anchorEl) {
    closeErMenuKeyToggle();
    const isKeyMode = !!er.usePrivateKey;

    erMenuKeyToggleBackdrop = document.createElement("div");
    erMenuKeyToggleBackdrop.style.cssText = "position:fixed;inset:0;z-index:9999998;";
    erMenuKeyToggleBackdrop.addEventListener("mousedown", (e) => {
      e.stopPropagation();
      closeErMenuKeyToggle();
    });

    const el = document.createElement("div");
    el.className = "cb-key-toggle";
    el.addEventListener("mousedown", (e) => e.stopPropagation());

    const option = document.createElement("button");
    option.type = "button";
    option.className = "cb-key-toggle-option";
    option.innerHTML = isKeyMode
      ? '<span style="color:#0dac65;display:flex">' + coinSvg(14) + "</span><span>Use Clay credits</span>"
      : KEY_TOGGLE_KEY_SVG + "<span>Use private key</span>";
    option.addEventListener("click", (e) => {
      e.stopPropagation();
      closeErMenuKeyToggle();
      commitPrivateKey(er.id, !isKeyMode);
    });
    el.appendChild(option);

    document.body.appendChild(erMenuKeyToggleBackdrop);
    document.body.appendChild(el);
    // Track the element so closeErMenuKeyToggle can actually remove it — without
    // this assignment each toggle orphaned on document.body and never closed.
    erMenuKeyToggleEl = el;
    // Capture-phase outside mousedown so it closes even when the click lands on
    // the ER details menu chrome above its backdrop.
    erMenuKeyToggleOutsideUnbind =
      window.__cb.bindOutsideMousedown?.(el, closeErMenuKeyToggle) ?? null;
    el.style.zIndex = "9999999";
    window.__cb.placePopover?.(el, anchorEl, { gap: 4 });
  }

  // Picker entry point. Setting linkTargetCardId hands placement off to
  // picker.js → placeCardsAdjacentTo, which now reads the target's
  // `clusterId` and stamps it on every newly-added card so the ER joins
  // the cluster relationally at creation time (not just geometrically
  // via the next snap-reconcile). For targets that aren't yet in any
  // cluster, the new card lands as a singleton and refreshClusters
  // promotes the adjacency into a fresh cluster id.
  function startAddEnrichment(targetCardId) {
    if (!__cb.canvas || !__cb.startPickerMode) return;
    pendingErInsertCtx = null;
    if (targetCardId) __cb.linkTargetCardId = targetCardId;
    __cb.startPickerMode();
  }

  function startAddOrphanEnrichment() {
    if (!__cb.startPickerMode) return;
    pendingErInsertCtx = null;
    // No link target → picker drops cards at enrichmentClickPos (null here)
    // which falls through to canvas-center placement in picker.js.
    __cb.linkTargetCardId = null;
    __cb.enrichmentClickPos = null;
    __cb.startPickerMode();
  }

  // "Insert below → Enrichment": add an UNLINKED (orphan) enrichment via the
  // picker, dropped just below the target row and into the target's section
  // (same group / use case), so it reads as a standalone enrichment row rather
  // than a chip on the data point. Contrast startAddEnrichment, which LINKS the
  // pick to the DP via placeCardsAdjacentTo.
  function insertEnrichmentBelow(targetRowId) {
    const target = getCardForRowId(targetRowId);
    if (!target || !__cb.startPickerMode) {
      startAddOrphanEnrichment();
      return;
    }
    pendingErInsertCtx = { groupId: target.groupId ?? null };
    __cb.linkTargetCardId = null;
    // Drop just below the target on the canvas so the table's y-ordering slots
    // the new orphan ER right after the target row within the section.
    __cb.enrichmentClickPos = {
      x: Number(target.x) || 0,
      y: (Number(target.y) || 0) + 80,
    };
    __cb.startPickerMode();
  }

  // Picker hook (picker.js, orphan branch): assign freshly-picked orphan ER(s)
  // the target row's group so they render in the same section as the target
  // (unlinked). No-ops unless an "Insert below → Enrichment" is pending.
  function placeInsertedEnrichments(cards) {
    if (!pendingErInsertCtx) return;
    const ctx = pendingErInsertCtx;
    pendingErInsertCtx = null;
    const ers = (cards || []).filter((c) => c && isErType(c.data?.type));
    if (ers.length === 0) return;
    let changed = false;
    for (const c of ers) {
      if (ctx.groupId != null && c.groupId !== ctx.groupId) {
        c.groupId = ctx.groupId;
        changed = true;
      }
    }
    if (changed) {
      __cb.model.update();
      if (__cb.saveTabs) __cb.saveTabs();
    }
    if (__cb.tableView && __cb.tableView.refresh) __cb.tableView.refresh();
  }

  // "Scope Ads" / "Scope Audiences" intro shortcuts. Behavior is not wired up
  // yet — this is a no-op placeholder so the buttons render without side
  // effects until we decide what each should do.
  function startScope(kind) {
    console.log(`[Clay Scoping] Scope ${kind} clicked (not wired up yet).`);
  }

  function removeCardById(cardId) {
    const canvas = __cb.canvas;
    if (!canvas?.getCardById) return;
    const card = canvas.getCardById(cardId);
    if (!card) return;
    // Delete through the canvas's removeCard (group cleanup, cluster recalc,
    // credit total, notifyChange all flow through the canonical path). We used
    // to simulate a click on the card's .cb-card-delete button, but that
    // element only exists when the canvas DOM is hydrated — under the lazy
    // canvas (table view is the active surface) card.el is null, so the row ×
    // / chip × silently did nothing.
    if (typeof canvas.removeCard === "function") {
      canvas.removeCard(cardId);
      if (__cb.saveTabs) __cb.saveTabs();
      return;
    }
    // Fallback for older canvas builds without an exposed removeCard.
    const del = card.el?.querySelector(".cb-card-delete");
    if (del) del.click();
  }

  // Detach one enrichment from a data point (remove just that lineage key +
  // its run-share), leaving the ER card on the canvas. This is the chip-×
  // behavior on a DP row — distinct from removeCardById, which deletes the ER
  // card entirely (the chip-× behavior on an orphan-ER row).
  function detachErFromDp(dpCardId, erCardId) {
    const canvas = __cb.canvas;
    const dp = canvas?.getCardById?.(dpCardId);
    const er = canvas?.getCardById?.(erCardId);
    if (!dp || !er) return;
    const key = canvas.erLineageKeyOf ? canvas.erLineageKeyOf(er) : lineageKeyOf(er);
    if (key == null) return;
    __cb.setDpErKeys(dp, __cb.dpErKeys(dp).filter((k) => k !== key));
    if (__cb.setDpErShare) __cb.setDpErShare(dp, key, null);
    __cb.model.update();
    if (__cb.saveTabs) __cb.saveTabs();
  }

  // Detach EVERY enrichment from one or more data points (the row-level
  // "Unlink", inverse of Link). Clears each DP's lineage keys + run-shares so it
  // renders as "Not connected"; the ER cards stay (becoming orphan rows if
  // nothing else references them). Batches one model update.
  function unlinkDpCards(cards) {
    let changed = false;
    for (const dp of cards || []) {
      if (!dp || dp.data?.type !== "dp") continue;
      if (__cb.dpErKeys(dp).length === 0) continue;
      __cb.setDpErKeys(dp, []);
      changed = true;
    }
    if (!changed) return;
    __cb.model.update();
    if (__cb.saveTabs) __cb.saveTabs();
  }

  function startAddDataPoint(text) {
    const canvas = __cb.canvas;
    if (!canvas?.addDataPointCard) return null;
    // Drop the new DP below the lowest existing card so the canvas layout
    // isn't disturbed when the user switches back. Using offsets relative
    // to existing cards (vs canvas center) avoids stacking many new DPs on
    // top of each other when the user adds several from the table view.
    const cards = __cb.model.getNodes();
    let nextX = 0;
    let nextY = 0;
    if (cards.length > 0) {
      let maxBottom = -Infinity;
      let leftMostXAtMax = 0;
      for (const c of cards) {
        const bottom = c.y + 70;
        if (bottom > maxBottom) {
          maxBottom = bottom;
          leftMostXAtMax = c.x;
        }
      }
      nextX = leftMostXAtMax;
      nextY = maxBottom + 40;
    }
    const card = canvas.addDataPointCard(text || "", { x: nextX, y: nextY });
    __cb.model.update();
    return card;
  }

  // Header "Add data point" action: create an empty DP and immediately open
  // its name for inline editing (the footer row used to do this inline).
  function addDataPointInteractive() {
    const card = startAddDataPoint("");
    if (!card) return;
    pendingRenameCardId = card.id;
    render();
  }

  // Header "Add multiple data points" action: a small modal where the rep
  // pastes a comma- (or newline-) separated list; each entry becomes a data
  // point via the same startAddDataPoint path as the single add. Reuses the
  // shared cb-export-modal shell so it matches the extension's other modals.
  function openBulkAddDataPoints() {
    const backdrop = document.createElement("div");
    backdrop.className = "cb-export-modal-backdrop";

    function close() {
      backdrop.remove();
      document.removeEventListener("keydown", onKey);
    }
    function onKey(evt) {
      if (evt.key === "Escape") { evt.preventDefault(); close(); }
    }
    // Click on the dimmed area (not the modal) closes.
    backdrop.addEventListener("mousedown", (evt) => {
      if (evt.target === backdrop) close();
    });

    const modal = document.createElement("div");
    modal.className = "cb-export-modal cb-gtme-modal cb-bulk-dp-modal";

    const header = document.createElement("div");
    header.className = "cb-export-modal-header";
    const titleWrap = document.createElement("div");
    titleWrap.className = "cb-export-modal-title-wrap";
    const title = document.createElement("h2");
    title.className = "cb-export-modal-title";
    title.textContent = "Add multiple data points";
    const subtitle = document.createElement("div");
    subtitle.className = "cb-export-modal-subtitle";
    subtitle.textContent =
      "Paste a comma-separated list of the data points you want to add.";
    titleWrap.appendChild(title);
    titleWrap.appendChild(subtitle);
    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "cb-export-modal-close";
    closeBtn.setAttribute("aria-label", "Close");
    closeBtn.innerHTML =
      '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
    closeBtn.addEventListener("click", close);
    header.appendChild(titleWrap);
    header.appendChild(closeBtn);

    const body = document.createElement("div");
    body.className = "cb-export-modal-body cb-gtme-body";
    const textarea = document.createElement("textarea");
    textarea.className = "cb-bulk-dp-textarea";
    textarea.placeholder = "Company domain, LinkedIn URL, Job title, \u2026";
    textarea.rows = 6;
    body.appendChild(textarea);

    function submit() {
      // Tolerate commas and newlines; trim, drop empties, and de-dupe the
      // pasted list case-insensitively so an accidental repeat is ignored.
      const names = textarea.value
        .split(/[,\n]+/)
        .map((s) => s.trim())
        .filter(Boolean);
      const seen = new Set();
      let added = 0;
      for (const name of names) {
        const k = name.toLowerCase();
        if (seen.has(k)) continue;
        seen.add(k);
        if (startAddDataPoint(name)) added++;
      }
      if (added === 0) { textarea.focus(); return; }
      render();
      close();
    }

    // Cmd/Ctrl+Enter submits; plain Enter stays a newline (multi-line input).
    textarea.addEventListener("keydown", (evt) => {
      if ((evt.metaKey || evt.ctrlKey) && evt.key === "Enter") {
        evt.preventDefault();
        submit();
      }
    });

    const footer = document.createElement("div");
    footer.className = "cb-modal-footer";
    const footerActions = document.createElement("div");
    footerActions.className = "cb-modal-footer-actions";
    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.className = "cb-modal-btn cb-modal-btn-ghost";
    cancelBtn.textContent = "Cancel";
    cancelBtn.addEventListener("click", close);
    const addBtn = document.createElement("button");
    addBtn.type = "button";
    addBtn.className = "cb-modal-btn cb-modal-btn-primary";
    addBtn.textContent = "Add";
    addBtn.addEventListener("click", submit);
    footerActions.appendChild(cancelBtn);
    footerActions.appendChild(addBtn);
    footer.appendChild(footerActions);

    modal.appendChild(header);
    modal.appendChild(body);
    modal.appendChild(footer);
    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);
    document.addEventListener("keydown", onKey);
    setTimeout(() => textarea.focus(), 0);
  }

  // Create a new data point and slot it immediately after `targetRowId`
  // within the same section, then open its name for inline editing.
  function insertDataPointBelow(targetRowId) {
    const canvas = __cb.canvas;
    const target = getCardForRowId(targetRowId);
    if (!canvas?.addDataPointCard || !target) return;

    const newDp = startAddDataPoint("");
    if (!newDp) return;

    // Match the target's section membership so the new DP lands in the same
    // block group (flat / real cb-group / legacy comment-card cluster).
    if (target.groupId != null) newDp.groupId = target.groupId;
    if (target.data?.groupCluster != null) {
      newDp.data.groupCluster = target.data.groupCluster;
    }

    // Order it right after the target: collect the section's blocks (now
    // including the new DP), move the new block directly below the target,
    // and reindex sequential tableOrders over the whole section.
    const blocks = collectSectionBlocks(targetRowId);
    const newKey = `row:${newDp.id}`;
    const targetCardId = parseCardIdFromRowId(targetRowId);
    const movedIdx = blocks.findIndex((b) => b.key === newKey);
    if (movedIdx !== -1) {
      const [moved] = blocks.splice(movedIdx, 1);
      let targetIdx = blocks.findIndex(
        (b) => targetCardId != null && b.cardIds.includes(targetCardId),
      );
      if (targetIdx === -1) targetIdx = blocks.length - 1;
      blocks.splice(targetIdx + 1, 0, moved);
      reindexBlocks(blocks);
    }

    // Set the rename flag BEFORE model.update(): the update notifies the
    // store subscription, which synchronously refreshes the table and
    // consumes the flag (rendering + focusing the new row's name input).
    pendingRenameCardId = newDp.id;
    __cb.model.update();
    if (__cb.saveTabs) __cb.saveTabs();
  }

  // ---- Group action ----
  //
  // Mirrors a canvas Shift+Enter onto the selected DPs. Reuses the existing
  // canvas.groupCardsByIds helper so theming, undo, persistence, and the
  // Supabase round-trip all flow through the canonical path. We pass
  // skipFocus because canvas.groupCardsByIds tries to focus the new
  // group's label input on the (display:none) canvas — useless in Tables
  // mode. Instead we stash the new group's section key in
  // pendingFocusGroupId so the next render() can focus the section's
  // header input in the table.

  // The L1 use-case ancestor id shared by every given card, or null when they
  // span multiple use cases (or none). Lets a new group nest under its use case
  // as an L2 sub-group instead of becoming a top-level use case.
  function commonUseCaseIdForCards(cardIds) {
    const model = __cb.model;
    if (!model || !model.useCaseGroupForCard) return null;
    let ucId;
    for (const id of cardIds) {
      const card = model.getNode(id);
      if (!card) continue;
      const uc = model.useCaseGroupForCard(card);
      const cur = uc ? uc.id : null;
      if (ucId === undefined) ucId = cur;
      else if (ucId !== cur) return null;
    }
    return ucId === undefined ? null : ucId;
  }

  function groupSelected() {
    const canvas = __cb.canvas;
    if (!canvas?.groupCardsByIds) return;
    // Commit any in-progress cell edit BEFORE mutating the canvas. The
    // refresh inside notifyChange below short-circuits when an INPUT in
    // the table is focused (to avoid stealing the user's keystrokes mid-
    // typing). Without this blur, a Group click made while a DP name
    // input still had focus would silently no-op the table refresh.
    const active = document.activeElement;
    if (
      active &&
      active.tagName === "INPUT" &&
      hostEl?.contains(active)
    ) {
      active.blur();
    }
    // selectedRowIds holds string row-ids; canvas.groupCardsByIds
    // compares against numeric card.id with === so we MUST hand it
    // numbers (silently fails otherwise — the canvas just ignores every
    // id and the group never forms). Accepts both DP and ER cards so
    // reps can group orphan enrichments into a labeled section too.
    const cardIds = getCardRowsInSelection()
      .map(parseCardIdFromRowId)
      .filter((id) => id != null);
    if (cardIds.length < 2) return;
    // Table-native (v7.23+): if the grouped rows all belong to one use case,
    // the new group nests under it as an L2 sub-group (not a new top-level use
    // case). Captured BEFORE grouping, which reassigns card.groupId.
    const parentUseCaseId = commonUseCaseIdForCards(cardIds);
    const beforeIds = new Set(
      (canvas.getGroups?.() || []).map((g) => g.id),
    );
    // forceDirect: the table view is a 2-level tree, so never auto-build a
    // canvas "super group". parentId nests the new group under its use case at
    // creation time (before pruning) so an all-rows group doesn't drop the use
    // case.
    canvas.groupCardsByIds(cardIds, "", {
      skipFocus: true,
      forceDirect: true,
      parentId: parentUseCaseId,
    });
    const afterGroups = canvas.getGroups?.() || [];
    // Newest group = the one whose id we didn't see before. There's at
    // most one because groupCardsByIds creates exactly one group per call.
    const newGroup = afterGroups.find((g) => !beforeIds.has(g.id));
    if (newGroup) {
      pendingFocusGroupId = `g-${newGroup.id}`;
      // Selection becomes meaningless once the rows are grouped (the user
      // is about to type a name) — clear so the section header focus
      // ring is the only highlight on screen.
      clearSelection();
      // notifyChange (inside groupCardsByIds) already triggered a refresh,
      // but it ran BEFORE pendingFocusGroupId was set — so the new
      // section appeared without focusing its label input. Trigger an
      // explicit second refresh now to consume the focus request.
      if (__cb.tableView?.refresh) __cb.tableView.refresh();
    }
  }

  // Promote the current selection into its OWN top-level use case. Unlike
  // groupSelected (which nests the rows as an L2 sub-group under their shared
  // use case), this forces a top-level group (parentId null) — re-parenting the
  // cards out of their current use case. Drops straight into renaming it.
  function createUseCaseFromSelection() {
    const canvas = __cb.canvas;
    if (!canvas?.groupCardsByIds) return;
    const active = document.activeElement;
    if (active && active.tagName === "INPUT" && hostEl?.contains(active)) {
      active.blur();
    }
    const cardIds = getCardRowsInSelection()
      .map(parseCardIdFromRowId)
      .filter((id) => id != null);
    if (cardIds.length < 1) return;
    const beforeIds = new Set((canvas.getGroups?.() || []).map((g) => g.id));
    // parentId null = a use case; forceDirect keeps the table's 2-level tree;
    // allowSingle so a lone row can become a use case too.
    canvas.groupCardsByIds(cardIds, "", {
      skipFocus: true,
      forceDirect: true,
      allowSingle: true,
      parentId: null,
    });
    const newGroup = (canvas.getGroups?.() || []).find((g) => !beforeIds.has(g.id));
    if (newGroup) {
      pendingFocusGroupId = `g-${newGroup.id}`;
      clearSelection();
      if (__cb.tableView?.refresh) __cb.tableView.refresh();
    }
  }

  function commitGroupLabel(canvasGroupId, value) {
    if (canvasGroupId == null) return;
    // Table-native (v7.23+): write the group's label directly through the model
    // (the canvas is headless now, so there's no .cb-group DOM to drive). The
    // model.update() captures undo + notifies the table to re-render.
    const g = __cb.model?.getGroup?.(canvasGroupId);
    if (!g) return;
    const v = (value || "").trim();
    if ((g.label || "") === v) return;
    __cb.model.update(() => {
      g.label = v;
    });
    if (__cb.saveTabs) __cb.saveTabs();
  }

  // Promote a sub-group (L2) to a top-level use case (L1).
  function convertGroupToUseCase(groupId) {
    const g = __cb.model?.getGroup?.(groupId);
    if (!g || (g.parentId ?? null) === null) return;
    __cb.model.update(() => {
      g.parentId = null;
      if (!g.source) g.source = "manual";
    });
    __cb.canvas?.refreshCreditTotal?.();
    __cb.canvas?.updateGroupCredits?.();
    if (__cb.saveTabs) __cb.saveTabs();
  }

  // Demote a use case (L1) to a sub-group nested under another use case (L2).
  // Guarded by the caller to the 2-level cap (only offered when the group has
  // no sub-groups of its own).
  function nestGroupUnder(groupId, parentId) {
    const g = __cb.model?.getGroup?.(groupId);
    const parent = __cb.model?.getGroup?.(parentId);
    if (!g || !parent || g.id === parentId) return;
    __cb.model.update(() => {
      g.parentId = parentId;
    });
    __cb.canvas?.refreshCreditTotal?.();
    __cb.canvas?.updateGroupCredits?.();
    if (__cb.saveTabs) __cb.saveTabs();
  }

  // Create a new, empty user use case (top-level group) and drop straight into
  // renaming its header.
  function addUseCase() {
    if (!__cb.model?.createGroup) return;
    const g = __cb.model.createGroup({ parentId: null, source: "manual", label: "" });
    __cb.model.update();
    if (__cb.saveTabs) __cb.saveTabs();
    pendingFocusGroupId = `g-${g.id}`;
    if (__cb.tableView?.refresh) __cb.tableView.refresh();
  }

  // Rename a legacy comment-cluster "basic group" (Clay-table import) by
  // writing its title comment card's text. A blank name is ignored — the
  // section is keyed off a titled comment, so an empty title would drop the
  // group on the next render; we re-render to restore the prior label instead.
  function commitClusterLabel(clusterId, value) {
    const v = (value || "").trim();
    if (!v) {
      render();
      return;
    }
    let changed = false;
    for (const c of __cb.model?.getNodes?.() || []) {
      if (c?.data?.type === "comment" && c.data.groupCluster === clusterId) {
        if (c.data.text !== v || c.data.displayName !== v) {
          c.data.text = v;
          c.data.displayName = v;
          changed = true;
        }
        break;
      }
    }
    if (changed) {
      __cb.model.update();
      if (__cb.saveTabs) __cb.saveTabs();
      render();
    }
  }

  // Rename an imported-table block (Import Clay Table). The name is resolved
  // from the imported-table metadata first (meta.name || card.tableName), so we
  // update the authoritative metadata and keep the per-card fallback in sync. A
  // blank name is ignored (re-render restores the prior label).
  function commitTableLabel(tableId, value) {
    const v = (value || "").trim();
    if (!v) {
      render();
      return;
    }
    const canvas = __cb.canvas;
    const meta = canvas?.getImportedTables?.()[tableId];
    let changed = false;
    if (!meta || meta.name !== v) {
      if (canvas?.setImportedTable) canvas.setImportedTable(tableId, { name: v });
      changed = true;
    }
    for (const c of __cb.model?.getNodes?.() || []) {
      if (c?.data?.tableId === tableId && c.data.tableName !== v) {
        c.data.tableName = v;
        changed = true;
      }
    }
    if (changed) {
      __cb.model.update();
      if (__cb.saveTabs) __cb.saveTabs();
      render();
    }
  }

  // ---- Link action ----
  //
  // Merge the selected rows into a single cluster via the relational
  // model (`canvas.linkCardsByIds`). The canvas takes care of:
  //   - allocating / reusing a cluster id (existing cluster ids on
  //     any input are preserved so saved state stays stable across
  //     repeated link operations)
  //   - pulling in cluster-mates (an ER attached to one of the
  //     selected DPs joins the merged cluster automatically)
  //   - laying out the resulting cluster into snap-adjacent positions
  //     so canvas-mode geometry agrees with the model
  //
  // Pre-refactor this function stacked card.y values and relied on
  // refreshClusters' snap-derivation to imply membership; now the
  // membership is the source of truth and geometry is the consequence.

  function linkSelected() {
    const canvas = __cb.canvas;
    if (!canvas?.linkCardsByIds) return;
    const cardIds = getCardRowsInSelection()
      .map(parseCardIdFromRowId)
      .filter((id) => id != null);
    if (cardIds.length < 2) return;

    canvas.linkCardsByIds(cardIds);
    // Membership was just set explicitly; refreshClusters here is
    // confirmatory + cosmetic. Empty dragCardIds keeps the model
    // durable against any unrelated geometry that snap-derive happens
    // to read on this pass.
    if (canvas.refreshClusters) canvas.refreshClusters({ dragCardIds: new Set() });
    __cb.model.update();
  }

  // ---- Move into group (Add to group / Remove from group / New group) ----
  //
  // Re-parent a row's whole block (the DP plus its lineage enrichments) into a
  // different cb-group, out of all groups, or into a brand-new group. Group
  // membership is a canvas construct (card.groupId), so these flow through the
  // canvas helpers and the table re-derives its sections from the new state.

  // Commit any in-progress cell edit before mutating, mirroring groupSelected —
  // the refresh that follows would otherwise be suppressed mid-typing.
  function blurActiveCellInput() {
    const active = document.activeElement;
    if (active && active.tagName === "INPUT" && hostEl?.contains(active)) {
      active.blur();
    }
  }

  // Give the block one shared tableOrder past the global max so it lands at the
  // bottom of whatever destination section it joins (each section sorts by
  // tableOrder, so a global-max value is >= any in-section value). Used for
  // moves into any group type (real cb-group or comment cluster).
  function setBlockTableOrderGlobalBottom(blockCardIds) {
    const canvas = __cb.canvas;
    if (!canvas?.getCardById) return;
    let maxOrder = -Infinity;
    for (const node of (__cb.model?.getNodes?.() || [])) {
      const o = typeof node.tableOrder === "number" ? node.tableOrder : null;
      if (o != null && o > maxOrder) maxOrder = o;
    }
    const next = maxOrder === -Infinity ? 0 : maxOrder + 1;
    for (const id of blockCardIds) {
      const c = canvas.getCardById(id);
      if (c) c.tableOrder = next;
    }
  }

  // Hierarchical "Move to" targets for the given current `membership`: top-level
  // use cases first (each clickable = move into the use case), and when a use
  // case has sub-groups it also carries a chevron flyout whose FIRST option is
  // the use case itself, then a divider, then the sub-groups. The current group
  // is disabled (can't move where it already is) and a childless current use
  // case is skipped. Legacy comment-clusters are appended flat. `moveFn(kind,
  // id)` performs the move (single row vs multi-select supply their own). Each
  // entry is a renderContextItem shape ({ label, action?, submenu?, disabled?,
  // hint? }).
  function buildMoveToTargets(membership, moveFn) {
    const model = __cb.model;
    const out = [];
    const ord = (a, b) => (a.order ?? 0) - (b.order ?? 0);
    const isCurrent = (kind, id) => membership.kind === kind && membership.id === id;
    const moveTo = (kind, id) => () => moveFn(kind, id);
    const labelOf = (g, fallback) =>
      g.label && g.label.trim() ? g.label.trim() : fallback;

    for (const uc of (model?.childGroups?.(null) || []).slice().sort(ord)) {
      const children = (model?.childGroups?.(uc.id) || []).slice().sort(ord);
      const ucCurrent = isCurrent("group", uc.id);
      if (ucCurrent && children.length === 0) continue; // nothing reachable here
      const ucLabel = labelOf(uc, "Untitled use case");
      const entry = {
        label: ucLabel,
        action: ucCurrent ? undefined : moveTo("group", uc.id),
        disabled: ucCurrent,
      };
      if (children.length > 0) {
        const sub = [
          {
            label: ucLabel,
            hint: "Whole use case",
            action: ucCurrent ? undefined : moveTo("group", uc.id),
            disabled: ucCurrent,
          },
          { separator: true },
        ];
        for (const ch of children) {
          const chCurrent = isCurrent("group", ch.id);
          sub.push({
            label: labelOf(ch, "Untitled group"),
            action: chCurrent ? undefined : moveTo("group", ch.id),
            disabled: chCurrent,
          });
        }
        entry.submenu = sub;
      }
      out.push(entry);
    }

    // Legacy comment-cluster basic groups (flat — no parent/child hierarchy).
    const seen = new Set();
    for (const node of (model?.getNodes?.() || [])) {
      if (node.data?.type !== "comment") continue;
      const cid = node.data.groupCluster;
      if (cid == null || seen.has(cid)) continue;
      const text = (node.data.text || node.data.displayName || "").trim();
      if (!text) continue;
      seen.add(cid);
      const cur = isCurrent("cluster", cid);
      if (cur) continue;
      out.push({ label: text, action: moveTo("cluster", cid) });
    }
    return out;
  }

  // ---- Selection context (one source of truth for the menu's enable logic) ---

  // Display label for a group (use case or sub-group), with a sensible fallback.
  function groupDisplayLabel(g) {
    const t = (g && g.label ? g.label : "").trim();
    if (t) return t;
    return g && (g.parentId ?? null) === null ? "Untitled use case" : "Untitled group";
  }

  // The deepest group ALL of `numIds` share: their common immediate cb-group if
  // identical, else their shared L1 use case, else null. { group, isUseCase }.
  function homeGroupForCards(numIds) {
    if (!numIds || numIds.length === 0) return null;
    let immediate;
    let same = true;
    for (const id of numIds) {
      const c = __cb.canvas?.getCardById?.(id);
      const gid = c && c.groupId != null ? c.groupId : null;
      if (immediate === undefined) immediate = gid;
      else if (immediate !== gid) { same = false; break; }
    }
    if (same && immediate != null) {
      const g = __cb.model?.getGroup?.(immediate);
      if (g) return { group: g, isUseCase: (g.parentId ?? null) === null };
    }
    const ucId = commonUseCaseIdForCards(numIds);
    if (ucId != null) {
      const g = __cb.model?.getGroup?.(ucId);
      if (g) return { group: g, isUseCase: true };
    }
    return null;
  }

  // Selectable rows (data points + enrichments) that belong to `group` — for an
  // L1 use case, everything in it or its sub-groups; for an L2 sub-group, its
  // immediate members. Comments / inputs are excluded so the count matches the
  // rows a user can actually select (drives the exact-fill no-op detection).
  function groupMemberCards(group) {
    const isUC = (group.parentId ?? null) === null;
    const out = [];
    for (const c of __cb.model?.getNodes?.() || []) {
      if (!c.data) continue;
      if (!(c.data.type === "dp" || isErType(c.data.type))) continue;
      if (isUC) {
        const uc = __cb.model.useCaseGroupForCard?.(c);
        if (uc && uc.id === group.id) out.push(c);
      } else if (c.groupId === group.id) {
        out.push(c);
      }
    }
    return out;
  }

  // The existing group whose membership the selection EXACTLY fills (use case or
  // sub-group), else null. Drives the "already a group / use case" no-op guards.
  function selectionFillsGroup(numIds) {
    const home = homeGroupForCards(numIds);
    if (!home || !home.group) return null;
    const members = groupMemberCards(home.group);
    const selSet = new Set(numIds);
    // selection ⊆ members (they all share home), so it fills iff every member is
    // selected.
    if (members.length > 0 && members.every((c) => selSet.has(c.id))) {
      return home.group;
    }
    return null;
  }

  // Move every selected row's block into a target membership (real group,
  // cluster, or none). The multi-row analogue of applyGroupMembership.
  function moveCardsTo(numIds, target) {
    blurActiveCellInput();
    const blockIds = [
      ...new Set((numIds || []).flatMap((id) => getBlockForCard(id))),
    ];
    applyMembershipToBlock(blockIds, target);
    if (__cb.tableView?.refresh) __cb.tableView.refresh();
  }

  // Promote a single row into its OWN top-level use case (parentId null) — the
  // single-row analogue of createUseCaseFromSelection.
  function newUseCaseFromRow(rowId) {
    const canvas = __cb.canvas;
    if (!canvas?.groupCardsByIds) return;
    blurActiveCellInput();
    const blockIds = getBlockCardIdsForRow(rowId);
    if (blockIds.length === 0) return;
    for (const id of blockIds) {
      const c = canvas.getCardById?.(id);
      if (c?.data?.type === "dp") c.data.groupCluster = null;
    }
    const beforeIds = new Set((canvas.getGroups?.() || []).map((g) => g.id));
    canvas.groupCardsByIds(blockIds, "", {
      skipFocus: true,
      allowSingle: true,
      forceDirect: true,
      parentId: null,
    });
    const newGroup = (canvas.getGroups?.() || []).find((g) => !beforeIds.has(g.id));
    if (newGroup) {
      pendingFocusGroupId = `g-${newGroup.id}`;
      clearSelection();
      if (__cb.tableView?.refresh) __cb.tableView.refresh();
    }
  }

  // "Create" submenu (Group / Use case) for a selection. `actions` supplies the
  // create fns ({ group, useCase }) so single rows and multi-select reuse it.
  // Group needs one parent use case and a selection that doesn't already fill a
  // group; Use case is a no-op only when the selection already fills a use case.
  // Disabled items keep a reason (mix policy: disable-with-reason for no-ops).
  function buildCreateSubmenu(numIds, actions) {
    if (!numIds || numIds.length === 0) return null;
    const ucId = commonUseCaseIdForCards(numIds);
    const filled = selectionFillsGroup(numIds);
    const filledIsUseCase = !!filled && (filled.parentId ?? null) === null;
    const groupEnabled = ucId != null && !filled;
    const useCaseEnabled = !filledIsUseCase;
    // Nothing to create here (the selection already is a use case) → hide Create
    // rather than show an all-disabled submenu.
    if (!groupEnabled && !useCaseEnabled) return null;
    const groupItem = groupEnabled
      ? { label: "Group", action: actions.group }
      : {
          label: "Group",
          disabled: true,
          hint:
            ucId == null
              ? "Groups live inside a use case"
              : `Already \u201c${groupDisplayLabel(filled)}\u201d`,
        };
    const useCaseItem = useCaseEnabled
      ? { label: "Use case", action: actions.useCase }
      : {
          label: "Use case",
          disabled: true,
          hint: `Already \u201c${groupDisplayLabel(filled)}\u201d`,
        };
    return [groupItem, useCaseItem];
  }

  // "Move to" submenu: a context-aware "Remove from group/use case" (when the
  // rows share one) then the existing-target hierarchy. `moveFn(kind, id)`
  // performs the move (single row vs multi-select supply their own). No "New…"
  // here — that lives under "Create".
  function buildMoveToSubmenu(numIds, moveFn) {
    const home = homeGroupForCards(numIds);
    const out = [];
    if (home && home.group) {
      if (home.isUseCase) {
        out.push({
          label: "Remove from use case",
          action: () => moveFn("none", null),
        });
      } else {
        const parentUcId = home.group.parentId ?? null;
        out.push({
          label: "Remove from group",
          action: () =>
            parentUcId != null ? moveFn("group", parentUcId) : moveFn("none", null),
        });
      }
    }
    const membership =
      home && home.group ? { kind: "group", id: home.group.id } : { kind: "none" };
    const targets = buildMoveToTargets(membership, moveFn);
    if (out.length > 0 && targets.length > 0) out.push({ separator: true });
    for (const t of targets) out.push(t);
    return out;
  }

  // ER card ids that ONLY the given DPs reference — so deleting those DPs can
  // cascade-delete the enrichments exclusive to them (shared ERs are kept).
  function exclusiveErIdsForDps(dpIdSet) {
    const nodes = __cb.model?.getNodes?.() || [];
    const erByKey = new Map();
    for (const c of nodes) {
      if (!c.data || !isErType(c.data.type)) continue;
      const key = lineageKeyOf(c);
      if (key != null && !erByKey.has(key)) erByKey.set(key, c.id);
    }
    const referencedByDeleted = new Set();
    for (const id of dpIdSet) {
      const dp = __cb.canvas?.getCardById?.(id);
      if (!dp || dp.data?.type !== "dp") continue;
      for (const k of __cb.dpErKeys(dp)) referencedByDeleted.add(k);
    }
    const stillNeeded = new Set();
    for (const c of nodes) {
      if (c.data?.type !== "dp" || dpIdSet.has(c.id)) continue;
      for (const k of __cb.dpErKeys(c)) {
        if (referencedByDeleted.has(k)) stillNeeded.add(k);
      }
    }
    const out = [];
    for (const k of referencedByDeleted) {
      if (stillNeeded.has(k)) continue;
      const erId = erByKey.get(k);
      if (erId != null) out.push(erId);
    }
    return out;
  }

  // Delete the given rows. Deleting a data point cascade-deletes the enrichments
  // ONLY it used (shared ones stay); selected enrichment rows delete outright.
  // Undoable via the canvas history; confirms only for large removals.
  function deleteRows(numIds) {
    const canvas = __cb.canvas;
    if (!canvas?.removeCard) return;
    blurActiveCellInput();
    const ids = (numIds || []).filter((id) => id != null);
    if (ids.length === 0) return;
    const dpIds = ids.filter(
      (id) => canvas.getCardById?.(id)?.data?.type === "dp",
    );
    const exclusiveEr = dpIds.length ? exclusiveErIdsForDps(new Set(dpIds)) : [];
    const toDelete = [...new Set([...ids, ...exclusiveEr])];
    if (toDelete.length >= 5) {
      const extra = exclusiveEr.length
        ? ` and ${exclusiveEr.length} enrichment${exclusiveEr.length === 1 ? "" : "s"} only they use`
        : "";
      const msg = `Delete ${ids.length} row${ids.length === 1 ? "" : "s"}${extra}? You can undo this.`;
      if (!window.confirm(msg)) return;
    }
    for (const id of toDelete) canvas.removeCard(id);
    if (__cb.saveTabs) __cb.saveTabs();
    clearSelection();
    if (__cb.tableView?.refresh) __cb.tableView.refresh();
  }

  // Join groups of menu items with separators, skipping empty groups so there
  // are never leading / trailing / doubled dividers.
  function joinMenuGroups(groups) {
    const out = [];
    for (const g of groups) {
      if (!g || g.length === 0) continue;
      if (out.length > 0) out.push({ separator: true });
      for (const it of g) out.push(it);
    }
    return out;
  }

  // Re-parent a block of cards into a target — a real cb-group ({kind:"group"}),
  // a comment cluster ({kind:"cluster"}), or out of all groups ({kind:"none"}).
  // Real-group membership flows through the canvas helper; comment-cluster
  // membership is a data tag the table buckets by. We always clear the OTHER
  // mechanism so a card never double-buckets. Shared by the menu + cross-group
  // drag.
  function applyMembershipToBlock(blockIds, target) {
    const canvas = __cb.canvas;
    if (!canvas?.moveCardsToGroup || !blockIds || blockIds.length === 0) return;
    setBlockTableOrderGlobalBottom(blockIds);
    const setClusterOnDps = (clusterId) => {
      for (const id of blockIds) {
        const c = canvas.getCardById?.(id);
        // Only DP cards carry the bucketing tag; ERs follow as lineage chips.
        if (c?.data?.type === "dp") c.data.groupCluster = clusterId;
      }
    };
    if (target.kind === "group") {
      setClusterOnDps(null);
      canvas.moveCardsToGroup(blockIds, target.id);
    } else if (target.kind === "cluster") {
      canvas.moveCardsToGroup(blockIds, null);
      setClusterOnDps(target.id);
    } else {
      setClusterOnDps(null);
      canvas.moveCardsToGroup(blockIds, null);
    }
    // moveCardsToGroup → notifyChange already refreshes the table; persist too.
    __cb.model.update();
  }

  function applyGroupMembership(rowId, target) {
    blurActiveCellInput();
    applyMembershipToBlock(getBlockCardIdsForRow(rowId), target);
    if (__cb.tableView?.refresh) __cb.tableView.refresh();
  }

  function newGroupFromRow(rowId) {
    const canvas = __cb.canvas;
    if (!canvas?.groupCardsByIds) return;
    blurActiveCellInput();
    const blockIds = getBlockCardIdsForRow(rowId);
    if (blockIds.length === 0) return;
    // A new real cb-group supersedes any comment-cluster tag on the DP(s).
    for (const id of blockIds) {
      const c = canvas.getCardById?.(id);
      if (c?.data?.type === "dp") c.data.groupCluster = null;
    }
    // Nest the new group under the row's use case (L2) when there is one.
    const parentUseCaseId = commonUseCaseIdForCards(blockIds);
    const beforeIds = new Set((canvas.getGroups?.() || []).map((g) => g.id));
    // allowSingle: a lone DP (no linked enrichments) can still start a group.
    // forceDirect: the table is a 2-level tree (no canvas super-groups).
    // parentId: nest under the use case at creation (before pruning).
    canvas.groupCardsByIds(blockIds, "", {
      skipFocus: true,
      allowSingle: true,
      forceDirect: true,
      parentId: parentUseCaseId,
    });
    const newGroup = (canvas.getGroups?.() || []).find((g) => !beforeIds.has(g.id));
    if (newGroup) {
      // Focus the new section's label input on the next render so the user can
      // name it immediately (mirrors groupSelected).
      pendingFocusGroupId = `g-${newGroup.id}`;
      clearSelection();
      if (__cb.tableView?.refresh) __cb.tableView.refresh();
    }
  }

  // Rename a group from its header context menu: focus + select the header's
  // inline label input via the same pendingFocusGroupId pass groupSelected /
  // newGroupFromRow use. `groupRowId` is the section key (e.g. "g-123").
  function startGroupRename(groupRowId) {
    blurActiveCellInput();
    pendingFocusGroupId = groupRowId;
    render();
  }

  // Every card in a legacy comment-cluster "basic group": the title comment
  // card(s) plus each tagged data point's lineage block (the DP + its
  // enrichments). Clusters tag only DPs (ERs follow by lineage), so we expand
  // each DP through getBlockForCard. Deduped via a Set since DPs can share ERs.
  function clusterBlockCardIds(clusterId) {
    const ids = new Set();
    for (const c of __cb.model?.getNodes?.() || []) {
      if (!c?.data) continue;
      if (c.data.type === "comment" && c.data.groupCluster === clusterId) {
        ids.add(c.id);
      } else if (c.data.type === "dp" && c.data.groupCluster === clusterId) {
        for (const bid of getBlockForCard(c.id)) ids.add(bid);
      }
    }
    return [...ids];
  }

  // Every card belonging to an imported-table block. All imported cards (DPs,
  // ERs, inputs, and the cluster title comments) carry data.tableId, so a flat
  // scan captures the entire block including its nested basic groups.
  function tableBlockCardIds(tableId) {
    const ids = [];
    for (const c of __cb.model?.getNodes?.() || []) {
      if (c?.data?.tableId === tableId) ids.push(c.id);
    }
    return ids;
  }

  // Delete a whole group and EVERYTHING inside it — every data point and
  // enrichment. `target` is a real cb-group ({ canvasGroupId }), a
  // comment-cluster basic group ({ clusterId }), or an imported-table block
  // ({ tableId }). For real groups, removeCard prunes groups that become empty,
  // so deleting all member cards disposes the inner groups first and then the
  // now-childless super-group. `noun` is "group" / "super group" / "table".
  function deleteGroupWithCards(target, name, noun) {
    const canvas = __cb.canvas;
    if (!canvas?.removeCard) return;
    blurActiveCellInput();
    const cardIds =
      target.canvasGroupId != null
        ? getBlockCardIdsForGroup(target.canvasGroupId)
        : target.clusterId != null
          ? clusterBlockCardIds(target.clusterId)
          : target.tableId != null
            ? tableBlockCardIds(target.tableId)
            : [];
    if (cardIds.length === 0) return;
    // Count only data points + enrichments for the prompt (the cluster's title
    // comment card is deleted too but isn't part of the user's mental model).
    const contentCount = cardIds.filter((id) => {
      const c = canvas.getCardById?.(id);
      return c && (c.data?.type === "dp" || isErType(c.data?.type));
    }).length;
    const label = name && name.trim() ? `"${name.trim()}"` : `this ${noun}`;
    const msg = `Delete ${label} and its ${contentCount} card${contentCount === 1 ? "" : "s"} (data points + enrichments)? This can't be undone.`;
    if (!window.confirm(msg)) return;
    // Snapshot first — removeCard mutates the card list as it goes.
    for (const id of cardIds) canvas.removeCard(id);
    // Belt-and-suspenders for real groups: if the group survived (e.g. it had
    // no member cards), disband it so the empty section doesn't linger.
    if (target.canvasGroupId != null) {
      const survives = (canvas.getGroups?.() || []).some(
        (g) => g.id === target.canvasGroupId,
      );
      if (survives && canvas.disbandGroup) canvas.disbandGroup(target.canvasGroupId);
    }
    if (__cb.saveTabs) __cb.saveTabs();
    if (__cb.tableView?.refresh) __cb.tableView.refresh();
  }

  // ---- Drag-and-reorder ----
  //
  // The "block" being dragged is the natural unit of the row:
  //   - DP row → its snap-cluster (DPs + ERs together).
  //   - Orphan-ER row → that single ER card.
  //   - Group header → every card in the cb-group.
  //
  // Drops are limited to the SAME section (orphan rows reorder within
  // orphans, in-group rows within their group, flat DPs within flat DPs,
  // groups within groups). Cross-section drops are out of scope for v1
  // because they require group reassignment.

  function getBlockCardIdsForRow(rowId) {
    const card = getCardForRowId(rowId);
    if (!card) return [];
    // DP rows carry their linked enrichments as chips; orphan-ER rows are a
    // lone ER (no DP points at them). getBlockForCard resolves both by
    // lineage, not geometry.
    return getBlockForCard(card.id);
  }

  function getBlockCardIdsForGroup(canvasGroupId) {
    // Deep membership: a super-group block carries its nested inner cards too.
    return (__cb.model?.cardsInGroup?.(canvasGroupId, { deep: true }) || []).map((c) => c.id);
  }

  function getBlockMinY(cardIds) {
    const canvas = __cb.canvas;
    if (!canvas?.getCardById) return 0;
    let min = Infinity;
    for (const id of cardIds) {
      const c = canvas.getCardById(id);
      if (c && c.y < min) min = c.y;
    }
    return Number.isFinite(min) ? min : 0;
  }

  function startBlockDrag(blockKind, blockKey, evt) {
    if (evt.button !== 0) return;
    evt.preventDefault();
    evt.stopPropagation();
    let cardIds = [];
    if (blockKind === "row") {
      cardIds = getBlockCardIdsForRow(blockKey);
    } else if (blockKind === "group") {
      cardIds = getBlockCardIdsForGroup(blockKey);
    }
    if (cardIds.length === 0) return;
    // Swallow the click that fires at the end of this drag gesture.
    suppressNextRowClick = true;
    dragInProgress = true;
    // Source group of a row block (the DP's groupId) — drives whether a drop
    // into another section is a same-group reorder or a cross-group move.
    let sourceGroupId = null;
    if (blockKind === "row") {
      const primary = __cb.canvas?.getCardById?.(cardIds[0]);
      sourceGroupId = primary?.groupId ?? null;
    }
    dragState = {
      blockKind,
      blockKey,
      cardIds,
      sourceGroupId,
      startY: evt.clientY,
      hoverRowId: null,
      dropPosition: null,
      // When set on drop, the block is re-parented into this group (or null to
      // ungroup) instead of being reordered within its current section.
      moveToGroupId: undefined,
    };
    // Visual cue on the source row(s).
    if (hostEl) {
      for (const cardId of cardIds) {
        const r = hostEl.querySelector(`[data-row-id="${cardId}"]`);
        if (r) r.classList.add("cb-table-view-row-dragging");
      }
      if (blockKind === "group") {
        const r = hostEl.querySelector(`[data-row-id="g-${blockKey}"]`);
        if (r) r.classList.add("cb-table-view-row-dragging");
      }
    }
    dragMoveHandler = (e) => onDragMove(e);
    dragUpHandler = (e) => onDragUp(e);
    document.addEventListener("mousemove", dragMoveHandler);
    document.addEventListener("mouseup", dragUpHandler);
  }

  // Resolve which real cb-group a hovered row represents as a drop target for a
  // cross-group MOVE. Returns { groupId } where groupId is a real canvas group
  // id or null (the ungrouped "Other" area), or null when the hovered row isn't
  // a valid group-move destination (table blocks, orphan-ER section, etc.).
  function resolveRowDropTarget(hoverRowId) {
    const card = getCardForRowId(hoverRowId);
    if (card) {
      // Dropping onto another row joins that row's group (null = ungrouped).
      return { groupId: card.groupId ?? null };
    }
    // A real cb-group header carries the numeric group id as its data-row-id.
    const gid = Number(hoverRowId);
    if (Number.isFinite(gid) && (__cb.canvas?.getGroups?.() || []).some((g) => g.id === gid)) {
      return { groupId: gid };
    }
    // The "Other" header is the ungroup target.
    if (hoverRowId === OTHER_SECTION_KEY) return { groupId: null };
    return null;
  }

  function clearDropTarget() {
    hideDropIndicator();
    dragState.hoverRowId = null;
    dragState.dropPosition = null;
    dragState.moveToGroupId = undefined;
  }

  function onDragMove(evt) {
    if (!dragState || !hostEl) return;
    const target = evt.target instanceof Element
      ? evt.target.closest("[data-row-id]")
      : null;
    if (!target) {
      clearDropTarget();
      return;
    }
    const hoverRowId = target.getAttribute("data-row-id");
    // Block dropping onto the dragged block itself.
    if (isOwnBlock(hoverRowId)) {
      clearDropTarget();
      return;
    }
    const rect = target.getBoundingClientRect();
    const above = evt.clientY < rect.top + rect.height / 2;
    const dropPosition = above ? "above" : "below";

    // Group-header drags only reorder among same-section siblings (no
    // cross-group nesting). Keep the original same-section reorder behavior.
    if (dragState.blockKind === "group") {
      if (!isSameSection(hoverRowId)) { clearDropTarget(); return; }
      const plan = computeDropInsert(hoverRowId, dropPosition);
      if (!plan || plan.insertIdx === plan.draggedIdx) { clearDropTarget(); return; }
      dragState.hoverRowId = hoverRowId;
      dragState.dropPosition = dropPosition;
      dragState.moveToGroupId = undefined;
      showDropIndicator(target, above);
      return;
    }

    // Row drags: decide reorder vs cross-group move from the hovered row.
    const dropTarget = resolveRowDropTarget(hoverRowId);
    const sameGroup =
      dropTarget != null && (dropTarget.groupId ?? null) === (dragState.sourceGroupId ?? null);

    if (sameGroup) {
      // Same group → pure reorder, and only within the same rendered section.
      if (!isSameSection(hoverRowId)) { clearDropTarget(); return; }
      const plan = computeDropInsert(hoverRowId, dropPosition);
      if (!plan || plan.insertIdx === plan.draggedIdx) { clearDropTarget(); return; }
      dragState.hoverRowId = hoverRowId;
      dragState.dropPosition = dropPosition;
      dragState.moveToGroupId = undefined;
      showDropIndicator(target, above);
      return;
    }

    if (dropTarget == null) {
      // Not a valid group-move destination (table block, orphan section...).
      clearDropTarget();
      return;
    }

    // Cross-group move: re-parent the block into the hovered row's group.
    dragState.hoverRowId = hoverRowId;
    dragState.dropPosition = dropPosition;
    dragState.moveToGroupId = dropTarget.groupId; // may be null (ungroup)
    showDropIndicator(target, above);
  }

  function onDragUp() {
    if (!dragState) {
      cleanupDrag();
      return;
    }
    const { hoverRowId, dropPosition, moveToGroupId, cardIds } = dragState;
    // Lower the dragInProgress gate BEFORE the mutation runs. performDrop /
    // moveCardsToGroup call canvas.notifyChange, which fires
    // onCanvasStateChange → tableView.refresh synchronously. The refresh
    // short-circuits when `dragInProgress` is true (so the dragged row's DOM
    // doesn't get torn down mid-gesture). If we don't release the gate here,
    // the post-drop refresh is suppressed and the table keeps showing the
    // pre-drop order. cleanupDrag below re-sets it to false (idempotent).
    dragInProgress = false;
    if (moveToGroupId !== undefined) {
      // Cross-group move (moveToGroupId may be null = ungroup). Routed through
      // applyMembershipToBlock so any comment-cluster tag is cleared too.
      applyMembershipToBlock(
        cardIds,
        moveToGroupId == null ? { kind: "none" } : { kind: "group", id: moveToGroupId },
      );
    } else if (hoverRowId && dropPosition) {
      performDrop(hoverRowId, dropPosition);
    }
    cleanupDrag();
  }

  function cancelDrag() {
    cleanupDrag();
  }

  function cleanupDrag() {
    if (hostEl) {
      const dragging = hostEl.querySelectorAll(".cb-table-view-row-dragging");
      for (const r of dragging) r.classList.remove("cb-table-view-row-dragging");
    }
    hideDropIndicator();
    if (dragMoveHandler) document.removeEventListener("mousemove", dragMoveHandler);
    if (dragUpHandler) document.removeEventListener("mouseup", dragUpHandler);
    dragMoveHandler = null;
    dragUpHandler = null;
    dragState = null;
    dragInProgress = false;
  }

  // True when hoverRowId belongs to the same set of cards we're dragging.
  // Prevents reordering against ourselves (e.g. dropping a multi-card
  // cluster onto one of its own DP rows). dragState.cardIds is numeric
  // (canvas-native), hoverRowId is string (from data-row-id) — normalize
  // before comparison.
  function isOwnBlock(hoverRowId) {
    if (!dragState) return false;
    if (dragState.blockKind === "group" && hoverRowId === `g-${dragState.blockKey}`) {
      return true;
    }
    const cardId = parseCardIdFromRowId(hoverRowId);
    if (cardId != null && dragState.cardIds.includes(cardId)) return true;
    return false;
  }

  function getRowSection(rowId) {
    if (!hostEl) return null;
    const tr = hostEl.querySelector(`[data-row-id="${rowId}"]`);
    return tr ? tr.getAttribute("data-row-section") : null;
  }

  function isSameSection(hoverRowId) {
    if (!dragState) return false;
    const sourceKey = dragState.blockKind === "group"
      ? `g-${dragState.blockKey}`
      : dragState.cardIds[0];
    const sourceSection = getRowSection(sourceKey) || "";
    const targetSection = getRowSection(hoverRowId) || "";
    return sourceSection === targetSection;
  }

  function showDropIndicator(rowEl, above) {
    if (!hostEl) return;
    // Re-create the indicator if it's missing OR if it's been orphaned
    // by a render() that wiped hostEl.innerHTML (eg. table refresh after
    // notifyChange — typical on the first drag of a fresh page open and
    // on every drag after the first since render() runs in performDrop's
    // tail). Without the isConnected check, only the very first drag
    // produced a visible indicator; subsequent drags applied styles to
    // the orphaned node and the user saw no drop hint at all.
    if (!dropIndicatorEl || !dropIndicatorEl.isConnected) {
      dropIndicatorEl = document.createElement("div");
      dropIndicatorEl.className = "cb-table-view-drop-indicator";
      hostEl.appendChild(dropIndicatorEl);
    }
    const hostRect = hostEl.getBoundingClientRect();
    const rect = rowEl.getBoundingClientRect();
    // Indicator is positioned absolutely inside the host. We want it to
    // sit at the top or bottom edge of the hovered row, accounting for
    // the host's scroll offset (the table can scroll vertically when
    // there are many rows).
    const top = above
      ? rect.top - hostRect.top + hostEl.scrollTop
      : rect.bottom - hostRect.top + hostEl.scrollTop;
    dropIndicatorEl.style.top = `${top}px`;
    dropIndicatorEl.style.left = `${rect.left - hostRect.left}px`;
    dropIndicatorEl.style.width = `${rect.width}px`;
    dropIndicatorEl.style.display = "block";
  }

  function hideDropIndicator() {
    if (dropIndicatorEl) dropIndicatorEl.style.display = "none";
  }

  // tableOrder approach (v3.22+): drag-to-reorder writes to a
  // dedicated `card.tableOrder` field instead of mutating card.x/y.
  // The canvas geometry is left exactly as the user last arranged it,
  // and the two views can show the same data in different orders
  // without one bleeding into the other.
  //
  // Why we don't reflow card.y any more: table-view reorders must never
  // touch canvas geometry. Cluster membership is owned by lineage
  // (clusterByLineage), not geometry, so keeping table-view reorders
  // geometry-free guarantees the canvas stays bit-for-bit unchanged.
  // Resolve where the dragged block would land for a given hover target +
  // position WITHOUT mutating anything persistent. Returns the section's
  // blocks with the dragged block already spliced OUT, plus its original index
  // (`draggedIdx`) and the index it would be re-inserted at (`insertIdx`).
  // insertIdx === draggedIdx means the drop is a no-op — the two slots
  // immediately adjacent to the block's current spot (row directly above with
  // "below", row directly below with "above"). Shared by onDragMove (to gate
  // the indicator) and performDrop (to apply the move) so the math is identical.
  function computeDropInsert(hoverRowId, dropPosition) {
    const sectionBlocks = collectSectionBlocks(hoverRowId);
    if (sectionBlocks.length < 2) return null;
    const draggedKey = dragState.blockKind === "group"
      ? `group:${dragState.blockKey}`
      : `row:${dragState.cardIds[0]}`;
    const draggedIdx = sectionBlocks.findIndex((b) => b.key === draggedKey);
    if (draggedIdx === -1) return null;
    const [moved] = sectionBlocks.splice(draggedIdx, 1);
    // hoverRowId is string-form; b.cardIds are numeric. Normalize before
    // findIndex or it never matches.
    const hoverCardId = parseCardIdFromRowId(hoverRowId);
    let insertIdx = sectionBlocks.findIndex((b) =>
      (hoverCardId != null && b.cardIds.includes(hoverCardId)) ||
      b.key === `group:${hoverRowId.startsWith("g-") ? hoverRowId.slice(2) : hoverRowId}`,
    );
    if (insertIdx === -1) return null;
    if (dropPosition === "below") insertIdx += 1;
    return { sectionBlocks, moved, draggedIdx, insertIdx };
  }

  function performDrop(hoverRowId, dropPosition) {
    const canvas = __cb.canvas;
    if (!canvas) return;
    const plan = computeDropInsert(hoverRowId, dropPosition);
    if (!plan) return;
    const { sectionBlocks, moved, draggedIdx, insertIdx } = plan;
    // No-op when the block would land back in its own slot (adjacent drop).
    if (insertIdx === draggedIdx) return;
    sectionBlocks.splice(insertIdx, 0, moved);

    reindexBlocks(sectionBlocks);
    // No geometry change → no refreshClusters needed (snap-derive has
    // nothing new to discover). Just persist + re-render.
    __cb.model.update();
  }

  // Sequentially reassign tableOrder over EVERY block in the given (already
  // ordered) list, not just one. This "captures" any newly added / unordered
  // blocks at their effective sort position, so future drops see a fully
  // ordered section. Every card in a block gets the same tableOrder so
  // clusters stay grouped in the table view (matches the canvas's "linked
  // cards share Y" invariant). Shared by performDrop + insertDataPointBelow.
  function reindexBlocks(orderedBlocks) {
    const canvas = __cb.canvas;
    if (!canvas) return;
    let order = 0;
    for (const block of orderedBlocks) {
      for (const id of block.cardIds) {
        const c = canvas.getCardById?.(id);
        if (c) c.tableOrder = order;
      }
      order += 1;
    }
  }

  // Build the list of {key, cardIds, minY, tableOrder} blocks for
  // whatever section the dragged row belongs to. Same-section
  // restriction is already enforced upstream, so we only need to
  // enumerate one section.
  //
  // Block sort precedence matches the rest of the table view: by
  // tableOrder when set, falling back to canvas y. `height` was
  // tracked under the legacy y-reflow approach; no longer needed.
  function makeBlock(key, cardIds) {
    return {
      key,
      cardIds,
      minY: getBlockMinY(cardIds),
      tableOrder: tableOrderForCardIds(cardIds),
    };
  }
  function collectSectionBlocks(hoverRowId) {
    const canvas = __cb.canvas;
    if (!canvas) return [];
    const section = getRowSection(hoverRowId) || "";
    const blocks = [];
    if (section === "groups") {
      // Groups section: each block is one TOP-LEVEL cb-group (inners reorder
      // within their super's subgroup section, not here).
      for (const g of __cb.model?.getGroups?.() || []) {
        if (g.parentId != null) continue;
        const cardIds = (__cb.model?.cardsInGroup?.(g.id, { deep: true }) || []).map((c) => c.id);
        if (cardIds.length === 0) continue;
        blocks.push(makeBlock(`group:${g.id}`, cardIds));
      }
    } else if (section === "orphan") {
      // Orphan section: each enrichment with NO data point pointing at it
      // (by lineage) is its own row/block.
      for (const c of __cb.model.getNodes()) {
        if (!isErType(c.data?.type)) continue;
        if (dpCardsForEr(c).length > 0) continue; // attached -> lives on a DP row
        blocks.push(makeBlock(`row:${c.id}`, [c.id]));
      }
    } else if (section === "flat") {
      // Flat DP rows (no group, no comment-card cluster) — one block per DP,
      // its linked enrichments riding along via getBlockForCard.
      for (const c of __cb.model.getNodes()) {
        if (c.data?.type !== "dp") continue;
        if (c.groupId != null) continue;
        if (c.data.groupCluster) continue;
        blocks.push(makeBlock(`row:${c.id}`, getBlockForCard(c.id)));
      }
    } else if (section.startsWith("section:")) {
      // Inside a group (real cb-group OR legacy comment-card section) — one
      // block per DP in that group.
      const sectionKey = section.slice("section:".length);
      const isRealGroup = sectionKey.startsWith("g-");
      const realGroupId = isRealGroup ? Number(sectionKey.slice(2)) : null;
      const commentClusterId = !isRealGroup && sectionKey.startsWith("c-")
        ? sectionKey.slice(2)
        : null;
      for (const c of __cb.model.getNodes()) {
        if (c.data?.type !== "dp") continue;
        if (isRealGroup && c.groupId !== realGroupId) continue;
        if (commentClusterId != null && c.data.groupCluster !== commentClusterId) continue;
        blocks.push(makeBlock(`row:${c.id}`, getBlockForCard(c.id)));
      }
    }
    blocks.sort((a, b) =>
      compareByTableOrderThenY(a.tableOrder, a.minY, b.tableOrder, b.minY),
    );
    return blocks;
  }

  // ---- Context menu ----
  //
  // The menu adapts to the selection and the column the user right-clicked
  // in, and only ever shows applicable actions (no greyed-out entries):
  //   - single data point row → Rename + Insert data point/enrichment below
  //   - single orphan enrichment row → Insert data point/enrichment below
  //   - 2+ card rows → Group (and Link when the selection can share an
  //     enrichment)
  // `ctx` carries { rowId } from onRowContextMenu identifying the right-
  // clicked row both insert actions anchor to.

  // Right-click menu for a single enrichment — a chip in the Enrichments
  // column or a standalone orphan ER row. Intentionally just two items:
  // leave/edit a note, and freeze/unfreeze (deactivate to model savings).
  function erContextItems(erCard) {
    if (!erCard) return [];
    const cardId = erCard.id;
    const items = [];
    const hasNote = !!(erCard.data?.note || "").trim();
    items.push({
      label: hasNote ? "Edit note" : "Leave a note",
      action: () => {
        const anchor =
          hostEl?.querySelector(`[data-er-id="${cardId}"]`) ||
          hostEl?.querySelector(`[data-row-id="${cardId}"] .col-ers`) ||
          hostEl?.querySelector(`[data-row-id="${cardId}"]`) ||
          hostEl;
        openNotePopover(cardId, anchor);
      },
    });
    items.push({
      label: erCard.data?.frozen ? "Unfreeze" : "Freeze",
      action: () => toggleErFrozen(cardId),
    });
    return items;
  }

  function buildContextItems(ctx) {
    const items = [];

    // Group header right-click → rename + delete (with all the data points and
    // enrichments inside). Handles real cb-groups, legacy comment-cluster basic
    // groups, AND the imported-table block (the "super group" / table-level
    // import). The Other / orphan headers aren't groups, so they get no menu.
    if (ctx?.groupRow) {
      const gr = ctx.groupRow;
      const isRealGroup = gr.canvasGroupId != null;
      const gid = typeof gr.groupId === "string" ? gr.groupId : "";
      const isTable = !!gr.isTable; // imported-table block ("t-" key)
      const isCluster = !isRealGroup && !isTable && gid.startsWith("c-");
      if (isRealGroup || isCluster || isTable) {
        const noun = isTable ? "table" : gr.level === 1 ? "use case" : "group";
        const target = isRealGroup
          ? { canvasGroupId: gr.canvasGroupId }
          : isTable
            ? { tableId: gid.slice(2) }
            : { clusterId: gid.slice(2) };
        items.push({ label: "Rename", action: () => startGroupRename(gr.groupId) });
        // Convert between levels (table-native v7.23+). Real cb-groups only.
        if (isRealGroup) {
          const g = __cb.model?.getGroup?.(gr.canvasGroupId);
          if (g) {
            const isTopLevel = (g.parentId ?? null) === null;
            const hasChildren = (__cb.model?.childGroups?.(g.id) || []).length > 0;
            if (!isTopLevel) {
              // Sub-group (L2) -> promote to a use case (L1).
              items.push({
                label: "Convert to use case",
                action: () => convertGroupToUseCase(g.id),
              });
            } else if (!hasChildren) {
              // Use case (L1) -> nest under another use case (L2). Offered only
              // when it has no sub-groups (keeps the 2-level cap) and there's
              // another use case to nest under.
              const others = (__cb.model?.childGroups?.(null) || []).filter(
                (o) => o.id !== g.id,
              );
              if (others.length > 0) {
                items.push({
                  label: "Nest under",
                  submenu: others.map((o) => ({
                    label: o.label || "Untitled use case",
                    action: () => nestGroupUnder(g.id, o.id),
                  })),
                });
              }
            }
          }
        }
        items.push({
          label: `Delete ${noun}`,
          action: () => deleteGroupWithCards(target, gr.name, noun),
        });
      }
      return items;
    }

    // Enrichment chip right-click (Enrichments column). erCardId is set by the
    // chip's contextmenu handler and wins over row selection so it always
    // targets that specific enrichment, regardless of which row is selected.
    if (ctx?.erCardId != null) {
      return erContextItems(__cb.canvas?.getCardById?.(ctx.erCardId));
    }

    const cardIds = getCardRowsInSelection();

    if (cardIds.length >= 2) {
      const selCards = cardIds.map(getCardForRowId).filter(Boolean);
      const erCount = selCards.filter((c) => isErType(c.data?.type)).length;
      const dpCards = selCards.filter((c) => c.data?.type === "dp");
      const dpWithLineage = dpCards.some(
        (c) => (c.data?.sourceEnrichmentFieldId ?? null) != null,
      );
      const selNumIds = cardIds.map(parseCardIdFromRowId).filter((x) => x != null);

      // Structure: make a NEW container (Create) or move into / out of an
      // EXISTING one (Move to). Create owns "new"; Move to owns "existing".
      const structure = [];
      const createSub = buildCreateSubmenu(selNumIds, {
        group: () => groupSelected(),
        useCase: () => createUseCaseFromSelection(),
      });
      if (createSub) structure.push({ label: "Create", submenu: createSub });
      const moveSub = buildMoveToSubmenu(selNumIds, (kind, id) =>
        moveCardsTo(selNumIds, { kind, id }),
      );
      if (moveSub.length > 0) structure.push({ label: "Move to", submenu: moveSub });

      // Lineage: share an enrichment across the DPs (Link), or detach (Unlink).
      const lineage = [];
      const canShareEnrichment =
        (erCount >= 1 && dpCards.length >= 1) ||
        (erCount === 0 && dpCards.length >= 2 && dpWithLineage);
      if (canShareEnrichment) {
        lineage.push({
          label: "Link data points and enrichments",
          action: () => linkSelected(),
        });
      }
      const linkedDpCards = dpCards.filter((c) => __cb.dpErKeys(c).length > 0);
      if (erCount === 0 && linkedDpCards.length > 0) {
        lineage.push({
          label: "Unlink enrichments",
          action: () => unlinkDpCards(linkedDpCards),
        });
      }

      const destructive = [
        { label: `Delete ${cardIds.length} rows`, action: () => deleteRows(selNumIds) },
      ];

      return joinMenuGroups([structure, lineage, destructive]);
    }

    // Single row — grouped logically: Create / Move to (structure), lineage +
    // annotate (content), then Delete. ER rows and DP rows differ only by which
    // actions apply (mix policy: hide what can't apply to that kind).
    if (ctx?.rowId != null) {
      const card = getCardForRowId(ctx.rowId);
      const numIds = [parseCardIdFromRowId(ctx.rowId)].filter((x) => x != null);
      const cardId = numIds[0] ?? null;

      // Orphan enrichment row: note + freeze, scope it (Create / Move to), then
      // Delete. Rename / Insert / Unlink don't apply to a lone enrichment.
      if (card && isErType(card.data?.type)) {
        const annotate = erContextItems(card); // note + freeze
        const structure = [];
        const createSub = buildCreateSubmenu(numIds, {
          group: () => newGroupFromRow(ctx.rowId),
          useCase: () => newUseCaseFromRow(ctx.rowId),
        });
        if (createSub) structure.push({ label: "Create", submenu: createSub });
        const moveSub = buildMoveToSubmenu(numIds, (kind, id) =>
          applyGroupMembership(ctx.rowId, { kind, id }),
        );
        if (moveSub.length > 0) structure.push({ label: "Move to", submenu: moveSub });
        const destructive = [
          { label: "Delete enrichment", action: () => deleteRows(numIds) },
        ];
        return joinMenuGroups([annotate, structure, destructive]);
      }

      if (card?.data?.type === "dp") {
        const edit = [
          { label: "Rename", action: () => startInlineRename(ctx.rowId) },
        ];
        const createSub = buildCreateSubmenu(numIds, {
          group: () => newGroupFromRow(ctx.rowId),
          useCase: () => newUseCaseFromRow(ctx.rowId),
        });
        if (createSub) edit.push({ label: "Create", submenu: createSub });
        const moveSub = buildMoveToSubmenu(numIds, (kind, id) =>
          applyGroupMembership(ctx.rowId, { kind, id }),
        );
        if (moveSub.length > 0) edit.push({ label: "Move to", submenu: moveSub });
        edit.push({
          label: "Insert below",
          submenu: [
            { label: "Data point", action: () => insertDataPointBelow(ctx.rowId) },
            { label: "Enrichment", action: () => insertEnrichmentBelow(ctx.rowId) },
          ],
        });

        const content = [];
        // Unlink only when the DP actually links an enrichment (else hidden).
        if (__cb.dpErKeys(card).length > 0) {
          content.push({
            label: "Unlink enrichments",
            action: () => unlinkDpCards([card]),
          });
        }
        const hasNote = !!(card?.data?.note || "").trim();
        content.push({
          label: hasNote ? "Edit note" : "Leave a note",
          action: () => {
            const anchor =
              hostEl?.querySelector(`[data-row-id="${ctx.rowId}"] .col-ers`) ||
              hostEl?.querySelector(`[data-row-id="${ctx.rowId}"]`);
            openNotePopover(cardId, anchor);
          },
        });

        if (card.data.fieldId && card.data.tableId) {
          content.push({
            label: "Find first missing data",
            action: () => spotcheckMissing(card),
          });
        }

        const destructive = [
          { label: "Delete data point", action: () => deleteRows(numIds) },
        ];

        const out = joinMenuGroups([edit, content, destructive]);
        // Footer: "Find in table" for imported DPs (manual DPs have no column).
        if (card.data.fieldId && card.data.tableId) {
          out.push({
            footer: true,
            label: "Find in table",
            action: () => __cb.openCardInTable(card),
          });
        }
        return out;
      }
    }
    return items;
  }

  // Render one context-menu entry. Leaf items are buttons that run their
  // action and close the menu; `separator` items render a divider; items with a
  // `submenu` render a parent row (label + chevron) whose flyout panel opens to
  // the side on hover (CSS), flipping left / nudging up near a viewport edge.
  function renderContextItem(item) {
    if (item.separator) {
      const sep = document.createElement("div");
      sep.className = "cb-table-view-context-menu-sep";
      return sep;
    }
    if (item.submenu) {
      const wrap = document.createElement("div");
      wrap.className = "cb-table-view-context-menu-submenu-wrap";
      const btn = document.createElement("button");
      btn.type = "button";
      // A parent can ALSO be a direct target (e.g. a use case with sub-groups):
      // clicking the row runs its action while the flyout still opens on hover.
      const actionable = typeof item.action === "function" && !item.disabled;
      btn.className =
        "cb-table-view-context-menu-option cb-table-view-context-menu-option-parent" +
        (actionable ? " cb-table-view-context-menu-option-actionable" : "") +
        (item.disabled ? " cb-table-view-context-menu-option-disabled" : "");
      const labelEl = document.createElement("div");
      labelEl.className = "cb-table-view-context-menu-option-label";
      labelEl.textContent = item.label;
      btn.appendChild(labelEl);
      const chev = document.createElement("span");
      chev.className = "cb-table-view-context-menu-chevron";
      chev.innerHTML = chevronRightSvg(13);
      btn.appendChild(chev);
      if (actionable) {
        // Clicking the parent commits its action (move into the use case);
        // hovering still reveals the flyout for the sub-groups.
        btn.addEventListener("click", (evt) => {
          evt.stopPropagation();
          closeContextMenu();
          item.action();
        });
      } else {
        // Plain/disabled parent: click only toggles the flyout (hover opens it),
        // never closes the menu or runs an action.
        btn.addEventListener("click", (evt) => evt.stopPropagation());
      }
      wrap.appendChild(btn);

      const panel = document.createElement("div");
      panel.className = "cb-table-view-context-submenu";
      // A panel that itself holds nested flyouts (e.g. use cases with sub-groups)
      // must not clip them — overflow-y:auto would hide the second-level flyout.
      if (item.submenu.some((s) => s && s.submenu)) {
        panel.classList.add("cb-table-view-context-submenu-nested");
      }
      for (const sub of item.submenu) panel.appendChild(renderContextItem(sub));
      wrap.appendChild(panel);

      wrap.addEventListener("mouseenter", () => positionSubmenu(wrap, panel));
      return wrap;
    }
    if (item.footer) {
      // Footer action ("Find in table") — rendered identically to the ER
      // details-menu footer: a centered, bordered pill with the table icon.
      const wrap = document.createElement("div");
      wrap.className = "cb-table-view-er-menu-footer";
      const fbtn = document.createElement("button");
      fbtn.type = "button";
      fbtn.className =
        "cb-table-view-er-menu-open" +
        (item.disabled ? " cb-table-view-er-menu-open-disabled" : "");
      fbtn.innerHTML = tableSvg(13);
      const fspan = document.createElement("span");
      fspan.textContent = item.label;
      fbtn.appendChild(fspan);
      if (item.disabled) {
        fbtn.disabled = true;
        if (item.hint) fbtn.title = item.hint;
      } else {
        fbtn.addEventListener("click", () => {
          closeContextMenu();
          item.action();
        });
      }
      wrap.appendChild(fbtn);
      return wrap;
    }
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className =
      "cb-table-view-context-menu-option" +
      (item.disabled ? " cb-table-view-context-menu-option-disabled" : "");
    const labelEl = document.createElement("div");
    labelEl.className = "cb-table-view-context-menu-option-label";
    labelEl.textContent = item.label;
    btn.appendChild(labelEl);
    // Optional secondary hint line (e.g. why a disabled item is disabled).
    if (item.hint) {
      const hintEl = document.createElement("div");
      hintEl.className = "cb-table-view-context-menu-option-hint";
      hintEl.textContent = item.hint;
      btn.appendChild(hintEl);
    }
    if (item.disabled) {
      btn.disabled = true;
    } else {
      btn.addEventListener("click", () => {
        closeContextMenu();
        item.action();
      });
    }
    return btn;
  }

  // Decide which side a flyout submenu opens on so it stays in the viewport.
  // Force-measures the panel (it's display:none until hover) by toggling
  // display inline, then flips left and/or nudges up as needed.
  function positionSubmenu(wrap, panel) {
    wrap.classList.remove("cb-table-view-context-submenu-left");
    panel.style.top = "";
    const prevDisplay = panel.style.display;
    panel.style.display = "flex";
    const parentRect = wrap.getBoundingClientRect();
    const panelRect = panel.getBoundingClientRect();
    panel.style.display = prevDisplay;
    if (parentRect.right + panelRect.width + 8 > window.innerWidth) {
      wrap.classList.add("cb-table-view-context-submenu-left");
    }
    const overflowBottom =
      parentRect.top + panelRect.height + 8 - window.innerHeight;
    if (overflowBottom > 0) {
      panel.style.top = `${-Math.min(overflowBottom, Math.max(0, parentRect.top - 8))}px`;
    }
  }

  function openContextMenu(x, y, ctx) {
    closeContextMenu();
    const items = buildContextItems(ctx);
    // Nothing actionable for this selection/column → don't open an empty menu.
    if (items.length === 0) return;

    contextMenuBackdrop = document.createElement("div");
    contextMenuBackdrop.className = "cb-table-view-context-backdrop";
    contextMenuBackdrop.addEventListener("mousedown", (evt) => {
      evt.stopPropagation();
      closeContextMenu();
    });
    // Right-click on the backdrop should ALSO close the menu rather than
    // re-opening Clay's default context menu over the empty space.
    contextMenuBackdrop.addEventListener("contextmenu", (evt) => {
      evt.preventDefault();
      closeContextMenu();
    });

    contextMenuEl = document.createElement("div");
    contextMenuEl.className = "cb-table-view-context-menu";
    contextMenuEl.addEventListener("mousedown", (evt) => evt.stopPropagation());
    contextMenuEl.addEventListener("contextmenu", (evt) => evt.preventDefault());
    for (const item of items) {
      contextMenuEl.appendChild(renderContextItem(item));
    }

    document.body.appendChild(contextMenuBackdrop);
    document.body.appendChild(contextMenuEl);
    // Keep the menu inside the viewport even when right-clicking near the
    // bottom-right edge.
    const rect = contextMenuEl.getBoundingClientRect();
    const left = Math.min(x, window.innerWidth - rect.width - 8);
    const top = Math.min(y, window.innerHeight - rect.height - 8);
    contextMenuEl.style.left = `${Math.max(8, left)}px`;
    contextMenuEl.style.top = `${Math.max(8, top)}px`;
  }

  function closeContextMenu() {
    if (contextMenuEl) { contextMenuEl.remove(); contextMenuEl = null; }
    if (contextMenuBackdrop) { contextMenuBackdrop.remove(); contextMenuBackdrop = null; }
  }

  function onRowContextMenu(rowId, evt) {
    evt.preventDefault();
    evt.stopPropagation();
    if (!selectedRowIds.has(rowId)) {
      setSelection([rowId], rowId);
    }
    openContextMenu(evt.clientX, evt.clientY, { rowId });
  }

  // Dropdown under the header "Add" button. Reuses the context-menu DOM +
  // slots (so only one menu is open at a time and the existing Escape /
  // outside-click teardown applies) but anchors below the button instead of
  // at a cursor position.
  function openAddMenu(anchorEl) {
    closeContextMenu();
    const items = [
      { label: "Add data point", action: () => addDataPointInteractive() },
      { label: "Add multiple data points", action: () => openBulkAddDataPoints() },
      { label: "Add enrichment", action: () => startAddOrphanEnrichment() },
    ];

    contextMenuBackdrop = document.createElement("div");
    contextMenuBackdrop.className = "cb-table-view-context-backdrop";
    contextMenuBackdrop.addEventListener("mousedown", (evt) => {
      evt.stopPropagation();
      closeContextMenu();
    });

    contextMenuEl = document.createElement("div");
    contextMenuEl.className = "cb-table-view-context-menu";
    contextMenuEl.addEventListener("mousedown", (evt) => evt.stopPropagation());
    for (const item of items) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "cb-table-view-context-menu-option";
      const labelEl = document.createElement("div");
      labelEl.className = "cb-table-view-context-menu-option-label";
      labelEl.textContent = item.label;
      btn.appendChild(labelEl);
      btn.addEventListener("click", () => {
        closeContextMenu();
        item.action();
      });
      contextMenuEl.appendChild(btn);
    }

    document.body.appendChild(contextMenuBackdrop);
    document.body.appendChild(contextMenuEl);
    // Anchor below the button, left-aligned, clamped to the viewport.
    const aRect = anchorEl.getBoundingClientRect();
    const rect = contextMenuEl.getBoundingClientRect();
    const left = Math.min(aRect.left, window.innerWidth - rect.width - 8);
    let top = aRect.bottom + 6;
    if (top + rect.height > window.innerHeight - 8) {
      top = Math.max(8, aRect.top - 6 - rect.height);
    }
    contextMenuEl.style.left = `${Math.max(8, left)}px`;
    contextMenuEl.style.top = `${top}px`;
  }

  // Dropdown under the Projected toggle button. Mirrors openAddMenu's anchored
  // pattern + the shared context-menu teardown (one menu at a time, Escape /
  // outside-click close). Opened by re-clicking Projected while already in
  // projected mode (see buildViewModeToggle). Gated on actual data existing so
  // it never opens an empty / no-op menu before an import's stats have landed.
  function openProjectedMenu(anchorEl) {
    closeContextMenu();
    if (!hasActualCoverage()) return;
    const items = [
      {
        label: "Copy coverage & fill from Actual",
        hint: "Sets projected coverage and fill rate to the actual results. Doesn\u2019t change cost.",
        action: () => copyActualToProjected(),
      },
    ];

    contextMenuBackdrop = document.createElement("div");
    contextMenuBackdrop.className = "cb-table-view-context-backdrop";
    contextMenuBackdrop.addEventListener("mousedown", (evt) => {
      evt.stopPropagation();
      closeContextMenu();
    });

    contextMenuEl = document.createElement("div");
    contextMenuEl.className = "cb-table-view-context-menu";
    contextMenuEl.addEventListener("mousedown", (evt) => evt.stopPropagation());
    for (const item of items) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "cb-table-view-context-menu-option";
      const labelEl = document.createElement("div");
      labelEl.className = "cb-table-view-context-menu-option-label";
      labelEl.textContent = item.label;
      btn.appendChild(labelEl);
      if (item.hint) {
        const hintEl = document.createElement("div");
        hintEl.className = "cb-table-view-context-menu-option-hint";
        hintEl.textContent = item.hint;
        btn.appendChild(hintEl);
      }
      btn.addEventListener("click", () => {
        closeContextMenu();
        item.action();
      });
      contextMenuEl.appendChild(btn);
    }

    document.body.appendChild(contextMenuBackdrop);
    document.body.appendChild(contextMenuEl);
    // Anchor below the button, left-aligned, clamped to the viewport.
    const aRect = anchorEl.getBoundingClientRect();
    const rect = contextMenuEl.getBoundingClientRect();
    const left = Math.min(aRect.left, window.innerWidth - rect.width - 8);
    let top = aRect.bottom + 6;
    if (top + rect.height > window.innerHeight - 8) {
      top = Math.max(8, aRect.top - 6 - rect.height);
    }
    contextMenuEl.style.left = `${Math.max(8, left)}px`;
    contextMenuEl.style.top = `${top}px`;
  }

  // One-shot guard: animate the Projected/Actual toggle in the first time it
  // appears (an import populated the header). Not reset on unmount, so flipping
  // between canvas/table view doesn't replay it.
  let viewToggleSeen = false;

  function prefersReducedMotion() {
    return (
      window.matchMedia &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    );
  }

  // ---- Rendering ----

  function render() {
    if (!hostEl) return;
    // Capture the scroll position BEFORE we wipe the DOM so every re-render
    // (group collapse/expand, rename, add-data-point, expand/collapse-all,
    // pricing collapse) restores it in place instead of snapping to the top.
    // Normal mode scrolls the inner table container; pricing mode has no inner
    // scroller and scrolls hostEl (.cb-table-view-area) itself. restoreScroll()
    // re-resolves the scroller after the rebuild and clamps to its new size.
    const prevScroller =
      hostEl.querySelector(".cb-table-view-table-container") || hostEl;
    const prevScrollTop = prevScroller.scrollTop;
    const prevScrollLeft = prevScroller.scrollLeft;
    const restoreScroll = () => {
      if (prevScrollTop <= 0 && prevScrollLeft <= 0) return;
      const nextScroller =
        hostEl.querySelector(".cb-table-view-table-container") || hostEl;
      const maxTop = nextScroller.scrollHeight - nextScroller.clientHeight;
      const maxLeft = nextScroller.scrollWidth - nextScroller.clientWidth;
      nextScroller.scrollTop = Math.min(prevScrollTop, Math.max(0, maxTop));
      nextScroller.scrollLeft = Math.min(prevScrollLeft, Math.max(0, maxLeft));
    };
    // Table-native groups (v7.23+): make sure every imported (tableId-tagged)
    // card belongs to its use-case group before we read the tree. Idempotent +
    // render-safe (only assigns ungrouped cards), so it covers fresh imports and
    // legacy data alike. Persist (debounced, no notify) when it materializes
    // groups so they survive reload.
    if (__cb.model?.ensureTableNativeGroups?.()) __cb.saveTabs?.();
    // Pinned band matrices belong to pricing mode only; clear them on the way out.
    if (!__cb.pricingMode) __cb.pricingView?.closeMenus();
    hostEl.innerHTML = "";

    const wrap = document.createElement("div");
    wrap.className = "cb-table-view-wrap";

    const intro = document.createElement("div");
    intro.className = "cb-table-view-intro";

    // Left side of the intro row: the collaborators presence widget, mounted
    // inline here (it floats top-right on the canvas). The widget is a
    // singleton — mounting it here moves it off the canvas; setBrainstormView
    // re-mounts it on the canvas when switching back. Data (contributors +
    // presence) persists at the module level, so this re-mount is cheap and
    // doesn't refetch. Replaces the old "Spreadsheet view" title.
    const introLead = document.createElement("div");
    introLead.className = "cb-table-view-intro-lead";
    intro.appendChild(introLead);
    if (typeof __cb.mountCollaboratorsWidget === "function") {
      __cb.mountCollaboratorsWidget(introLead, { inline: true });
    }
    // Collapse / expand-all group controls, sitting just left of the search
    // affordance. Wired to the same two-step collapse / expand-all behavior as
    // Cmd+Shift+E / Cmd+E. In pricing mode the body is headers-only, so the
    // group toggles + search are replaced by the internal-only "View Bands"
    // control.
    // Collapse / expand-all buttons sit next to presence in both modes; in
    // pricing mode they fold/unfold the use-case boxes. Search becomes the
    // internal-only "View Bands" control.
    introLead.appendChild(buildGroupToggleControls());
    if (!__cb.pricingMode) {
      // Collapsed search affordance — sits to the right of the collaborators
      // pill, expands inline on click or Cmd/Ctrl+F. State is module-scoped so
      // applySearchHighlight() (end of render) restores highlights afterwards.
      // (Pricing mode shows per-option band matrices instead of a global control.)
      introLead.appendChild(buildSearchControl());
    }

    const introActions = document.createElement("div");
    introActions.className = "cb-table-view-intro-actions";

    // Projected / Actual cost toggle leads the action row (furthest left). It
    // used to live in the overlay topbar; it sits here now because the
    // Projected/Actual columns it switches are part of this table. Built via
    // the overlay helper so the toggle logic stays in one place; rebuilt on
    // every render (setViewMode reflects the active half by query, not ref).
    //
    // Only meaningful once a table has been imported: "Actual" reads real
    // spend that the import stamps onto the cards, so before that the toggle
    // is noise. recordsActual is the canonical "an import happened" signal
    // (null until prefillRecordsCount runs on import; restored per tab) — the
    // same flag the Records box uses for its "actual / POC" state.
    const importedYet =
      typeof __cb.recordsActual === "number" && __cb.recordsActual > 0;
    if (importedYet && typeof __cb.buildViewModeToggle === "function") {
      const viewToggle = __cb.buildViewModeToggle();
      viewToggle.classList.add("cb-table-view-mode-toggle");
      // Slide it in the first time it appears (import just populated the header).
      if (!viewToggleSeen && !prefersReducedMotion()) {
        viewToggle.classList.add("cb-view-mode-toggle-intro");
      }
      viewToggleSeen = true;
      // Centered in the intro row (grid column 2) instead of leading the action
      // cluster.
      intro.appendChild(viewToggle);
      // Load sessions + wire the Actual button's badge / popover (replaces the
      // standalone session-picker button). Runs in both modes so the run-bucket
      // badge is ready before the user flips to Actual.
      if (__cb.sessionCutoff) wireActualSessionUI();
    }

    // "Scope Ads" / "Scope Audiences" / "Add" lead the action row as scoping
    // quick-starts. Hidden in pricing mode (the view is for pricing an
    // already-built scope, not adding to it).
    if (!__cb.pricingMode) {
      const scopeAdsBtn = document.createElement("button");
      scopeAdsBtn.type = "button";
      scopeAdsBtn.className = "cb-table-view-add-er-btn";
      scopeAdsBtn.title = "Scope an Ads use case";
      scopeAdsBtn.innerHTML = targetSvg(12) + "<span>Scope Ads</span>";
      scopeAdsBtn.addEventListener("click", () => startScope("ads"));
      introActions.appendChild(scopeAdsBtn);

      const scopeAudiencesBtn = document.createElement("button");
      scopeAudiencesBtn.type = "button";
      scopeAudiencesBtn.className = "cb-table-view-add-er-btn";
      scopeAudiencesBtn.title = "Scope an Audiences use case";
      scopeAudiencesBtn.innerHTML = targetSvg(12) + "<span>Scope Audiences</span>";
      scopeAudiencesBtn.addEventListener("click", () => startScope("audiences"));
      introActions.appendChild(scopeAudiencesBtn);

      // Single "Add" control — opens a dropdown with the two granular add
      // actions (data point / enrichment) so the header stays compact now that
      // the sticky footer row is gone.
      const addBtn = document.createElement("button");
      addBtn.type = "button";
      addBtn.className = "cb-table-view-add-er-btn";
      addBtn.title = "Add a data point or enrichment";
      addBtn.innerHTML = plusSvg(12) + "<span>Add</span>" + chevronDownSvg(12);
      addBtn.addEventListener("click", (evt) => {
        evt.stopPropagation();
        openAddMenu(addBtn);
      });
      introActions.appendChild(addBtn);
    }

    // Pricing mode: the contract-term toggle is now per option (in each option
    // card header), so the intro row no longer carries a global term toggle.
    intro.appendChild(introActions);

    wrap.appendChild(intro);

    // Pricing mode renders a dedicated, simplified body (use-case headers with
    // per-year volume editors) instead of the full data-point table.
    if (__cb.pricingMode) {
      wrap.appendChild(__cb.pricingView.buildPricingBody());
      hostEl.appendChild(wrap);
      restoreScroll();
      return;
    }

    const tableContainer = document.createElement("div");
    tableContainer.className = "cb-table-view-table-container";

    const { orphanErRows, groupSections, dpRows, tableGroups } = buildRows();

    const table = document.createElement("table");
    table.className = "cb-table-view-table";
    tableEl = table;

    const thead = document.createElement("thead");
    const headRow = document.createElement("tr");
    // Rows are drag-anywhere (no dedicated handle column): a mousedown on any
    // non-interactive part of a row arms a threshold drag — see attachRowDrag.
    const headers = [
      { label: "Data point", cls: "col-dp" },
      { label: "Coverage", cls: "col-coverage" },
      { label: "Fill rate (%)", cls: "col-fill" },
      { label: "Actions / row", cls: "col-actions" },
      { label: "Credits / row", cls: "col-credits" },
      { label: "Enrichments", cls: "col-ers" },
      { label: "", cls: "col-actions-end" },
    ];
    for (const h of headers) {
      const th = document.createElement("th");
      th.textContent = h.label;
      th.className = h.cls;
      headRow.appendChild(th);
    }
    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = document.createElement("tbody");

    const tableGroupRowCount = (tableGroups || []).reduce(
      (sum, tg) =>
        sum + tg.rows.length + tg.sections.reduce((s2, sec) => s2 + sec.rows.length, 0),
      0,
    );
    const totalDpCount =
      dpRows.length +
      groupSections.reduce((sum, g) => sum + g.rows.length, 0) +
      tableGroupRowCount;

    // Reset the rendered-row-order list every render(). Built incrementally
    // as we append rows so shift+click range select uses the same order
    // the user sees on screen.
    visibleRowOrder = [];
    // Reset the collapsible-section key tiers; repopulated as headers append.
    renderedTopKeys = new Set();
    renderedInnerKeys = new Set();

    if (orphanErRows.length === 0 && totalDpCount === 0) {
      const empty = document.createElement("tr");
      empty.className = "cb-table-view-empty-row";
      const td = document.createElement("td");
      td.colSpan = headers.length;
      td.textContent =
        "No data points yet. Use \u201cAdd\u201d above to add a data point (or paste several at once), or \u201cAdd enrichment\u201d to get started.";
      empty.appendChild(td);
      tbody.appendChild(empty);
    } else {
      // ---- Imported tables (Import Clay Table) ----
      // Each imported table renders as its own top-level green super-group
      // block at the very top: a table header, then its basic-group
      // sub-sections (depth 1), then the table's loose / ungrouped rows at
      // the BOTTOM of the block (so grouped data points read first).
      for (const tg of (tableGroups || [])) {
        const appendRow = (rowEl, rowId) => {
          tbody.appendChild(rowEl);
          if (rowId != null) visibleRowOrder.push(String(rowId));
        };
        const emitRows = (rows, sectionTag) => {
          annotateMergeRuns(rows.filter((r) => r.kind === "dp"));
          for (const row of rows) {
            const rowEl = row.kind === "orphan-er"
              ? buildOrphanDpStyleRow(row, sectionTag)
              : buildDpRow(row, sectionTag);
            appendRow(rowEl, row.cardId);
          }
        };

        const tableSection = {
          groupId: tg.key,
          groupName: tg.tableName,
          // Editable so the table-import header renders an inline label input —
          // renaming writes the imported-table metadata via commitTableLabel
          // (the blur handler routes by section kind).
          editable: true,
          canvasGroupId: null,
          level: 1,
          parentId: null,
          rows: tg.rows,
          totalRowCount: tg.totalRowCount,
        };
        const tableCollapsed = collapsedGroups.has(tg.key);
        const header = buildGroupHeaderRow(tableSection, headers.length, tableCollapsed, 0, {
          isTable: true,
          recordCount: tg.recordCount,
          importedAt: tg.importedAt,
        });
        tbody.appendChild(header);
        visibleRowOrder.push(tg.key);
        renderedTopKeys.add(tg.key);
        if (tableCollapsed) continue;

        // Basic-group sub-sections first, indented at depth 1.
        for (const sub of tg.sections) {
          const subCollapsed = collapsedGroups.has(sub.groupId);
          const subHeader = buildGroupHeaderRow(sub, headers.length, subCollapsed, 1);
          tbody.appendChild(subHeader);
          visibleRowOrder.push(sub.groupId);
          renderedInnerKeys.add(sub.groupId);
          if (subCollapsed) continue;
          emitRows(sub.rows, `section:${sub.groupId}`);
        }

        // Then the table's loose / ungrouped rows (inputs, merge DPs,
        // waterfalls, standalone ERs) at the bottom of the block.
        emitRows(tg.rows, `table:${tg.key}`);
      }

      // Group sections render as a header row spanning all columns,
      // followed by the cluster's rows (unless collapsed). Within each
      // section we run rowspan-merge annotation so contiguous DPs that
      // share the same ER list collapse into a single visual cell — the
      // direct outcome of Link, plus a passive polish for any other
      // multi-DP cluster that organically forms on the canvas. ER-only
      // groups (Group action on orphan ERs) render their orphan rows
      // here too, dispatched by row.kind.
      //
      // Hierarchy: super-group sections (level=1) render at depth 0 and
      // each owns a sublist of inner sections (level=0 with
      // parentId=this.canvasGroupId) emitted at depth 1, indented by
      // CSS via [data-depth]. Standalone (non-super) groups render at
      // depth 0 with no children. Collapsing a super hides every
      // inner-section AND every DP beneath it; collapsing only an
      // inner hides just its own DPs.
      const topLevelSections = groupSections.filter((s) => !s.parentId);
      const childSectionsByParent = new Map();
      for (const s of groupSections) {
        if (s.parentId == null) continue;
        const parentKey = `g-${s.parentId}`;
        if (!childSectionsByParent.has(parentKey)) {
          childSectionsByParent.set(parentKey, []);
        }
        childSectionsByParent.get(parentKey).push(s);
      }
      for (const children of childSectionsByParent.values()) {
        children.sort((a, b) =>
          compareByTableOrderThenY(a.minTableOrder, a.minY, b.minTableOrder, b.minY),
        );
      }

      function emitSectionRows(section, sectionTag) {
        annotateMergeRuns(section.rows.filter((r) => r.kind === "dp"));
        for (const row of section.rows) {
          if (row.kind === "orphan-er") {
            tbody.appendChild(buildOrphanDpStyleRow(row, sectionTag));
          } else {
            tbody.appendChild(buildDpRow(row, sectionTag));
          }
          visibleRowOrder.push(String(row.cardId));
        }
      }

      for (const section of topLevelSections) {
        const isCollapsed = collapsedGroups.has(section.groupId);
        tbody.appendChild(
          buildGroupHeaderRow(section, headers.length, isCollapsed, 0),
        );
        visibleRowOrder.push(section.groupId);
        renderedTopKeys.add(section.groupId);
        if (isCollapsed) continue;
        // Direct rows on the top-level header (DPs whose groupId is
        // this section's id but no inner claimed them, plus standalone
        // group rows).
        emitSectionRows(section, `section:${section.groupId}`);
        // Then nested inner sections (only present when this is a
        // super-group with at least one claimed inner).
        const children = childSectionsByParent.get(section.groupId) || [];
        for (const child of children) {
          const childCollapsed = collapsedGroups.has(child.groupId);
          tbody.appendChild(
            buildGroupHeaderRow(child, headers.length, childCollapsed, 1),
          );
          visibleRowOrder.push(child.groupId);
          renderedInnerKeys.add(child.groupId);
          if (childCollapsed) continue;
          emitSectionRows(child, `section:${child.groupId}`);
        }
      }
      // "Other" — the unscoped parking lot: ungrouped data points AND
      // unattached enrichments (orphan ERs, no DP) under ONE collapsible
      // header at the very bottom, below every use case / group. Excluded
      // from the grand total (the cost model drops the "other" bucket); each
      // row still shows its own per-row cost for visibility, and the header
      // carries a "not counted" cue.
      //
      // Shown when there's any unscoped content AND either a real section
      // exists above OR there are orphan ERs (so the "not counted" cue is
      // always visible for unattached enrichments). A pure-manual tab with
      // only ungrouped DPs and no sections keeps the clean headerless layout.
      const hasSectionsAbove =
        groupSections.length > 0 || (tableGroups || []).length > 0;
      const showOtherHeader =
        dpRows.length + orphanErRows.length > 0 &&
        (hasSectionsAbove || orphanErRows.length > 0);
      const otherCollapsed =
        showOtherHeader && collapsedGroups.has(OTHER_SECTION_KEY);
      if (showOtherHeader) {
        tbody.appendChild(
          buildOtherHeaderRow(
            dpRows.length,
            orphanErRows.length,
            headers.length,
            otherCollapsed,
          ),
        );
        visibleRowOrder.push(OTHER_SECTION_KEY);
        renderedTopKeys.add(OTHER_SECTION_KEY);
      }
      if (!otherCollapsed) {
        // Ungrouped data points first (normal rows — a DP whose source ER
        // lives in a use case is still counted there, so they stay editable).
        annotateMergeRuns(dpRows);
        for (const row of dpRows) {
          tbody.appendChild(buildDpRow(row, "flat"));
          visibleRowOrder.push(String(row.cardId));
        }
        // Then unattached enrichments (orphan ERs). Each row keeps its inline
        // "+ data point" affordance to attach a DP and promote into a real,
        // counted row. The "orphan" section tag preserves drag-reorder scope.
        for (const row of orphanErRows) {
          tbody.appendChild(buildOrphanDpStyleRow(row, "orphan"));
          visibleRowOrder.push(String(row.cardId));
        }
      }
    }

    table.appendChild(tbody);
    tableContainer.appendChild(table);
    wrap.appendChild(tableContainer);

    hostEl.appendChild(wrap);

    // Re-apply selection highlight and consume any pending focus request
    // (Group action stashes the new section's key here; we focus the
    // matching label input now that it's in the DOM).
    applySelectionClasses();
    // Restore scroll before the focus pass below: a plain re-render (group
    // toggle, rename of an on-screen row) keeps its position, while
    // add-data-point can still scroll its freshly-focused (off-screen) row
    // into view via input.focus().
    restoreScroll();
    if (pendingFocusGroupId) {
      const labelInput = hostEl.querySelector(
        `[data-row-id="${pendingFocusGroupId}"] .cb-table-view-group-row-label-input`,
      );
      if (labelInput) {
        labelInput.focus();
        labelInput.select();
      }
      pendingFocusGroupId = null;
    }
    // Consume a pending rename: the matching DP row rendered its name as an
    // input (see buildDpRow) — focus + select it now that it's in the DOM.
    if (pendingRenameCardId != null) {
      const nameInput = hostEl.querySelector(
        `[data-row-id="${pendingRenameCardId}"] .cb-table-view-cell-input-text`,
      );
      if (nameInput) {
        nameInput.focus();
        // Caret at the far right (end of the name) rather than selecting all,
        // so the rep appends/edits from the end.
        const end = nameInput.value.length;
        nameInput.setSelectionRange(end, end);
      }
      pendingRenameCardId = null;
    }
    // Re-apply search highlights against the freshly-built rows. No scroll —
    // a background model update shouldn't yank the user's scroll position.
    if (searchQuery.trim()) applySearchHighlight({ scroll: false });
  }

  // Re-render with the given DP row's name as a focused input (the rename
  // affordance, since the name is otherwise static text).
  function startInlineRename(rowId) {
    const cardId = parseCardIdFromRowId(rowId);
    if (cardId == null) return;
    pendingRenameCardId = cardId;
    render();
  }

  // Walk a section's DP rows in render order, group consecutive rows by
  // erKey, and stamp each row with mergeMode + mergeSpan. mergeMode is one
  // of "first" (host of a >=2-row merge — render the merged cells with
  // rowspan), "skip" (a follower in a merge run — don't emit the merged
  // cells), or "single" (no merge). The row builder reads these flags
  // when constructing <td>s.
  function annotateMergeRuns(rows) {
    let i = 0;
    while (i < rows.length) {
      const key = rows[i].erKey;
      // erKey is null for rows with no enrichments; never merge those —
      // collapsing "no ERs" cells across rows would visually imply a
      // shared ER set when there's nothing to share.
      if (!key) {
        rows[i].mergeMode = "single";
        rows[i].mergeSpan = 1;
        i++;
        continue;
      }
      let j = i;
      while (j < rows.length && rows[j].erKey === key) j++;
      const span = j - i;
      if (span === 1) {
        rows[i].mergeMode = "single";
        rows[i].mergeSpan = 1;
      } else {
        rows[i].mergeMode = "first";
        rows[i].mergeSpan = span;
        for (let k = i + 1; k < j; k++) {
          rows[k].mergeMode = "skip";
          rows[k].mergeSpan = 1;
        }
      }
      i = j;
    }
  }

  // "Other" header — the unscoped parking lot at the very bottom: ungrouped
  // data points AND unattached enrichments (orphan ERs, no DP) share this one
  // collapsible section. Excluded from the grand total (the cost model drops
  // the "other" use-case bucket), so the header carries a "not counted" cue —
  // reps move items into a use case to price them. Virtual section (sentinel
  // key in collapsedGroups); no drag handle, no editable label.
  function buildOtherHeaderRow(dpCount, erCount, colSpan, isCollapsed) {
    const tr = document.createElement("tr");
    tr.className =
      "cb-table-view-group-row cb-table-view-other-group-row" +
      (isCollapsed ? " cb-table-view-group-row-collapsed" : "");
    tr.setAttribute("data-group-id", OTHER_SECTION_KEY);
    tr.setAttribute("data-row-id", OTHER_SECTION_KEY);
    tr.setAttribute("data-row-section", "groups");
    tr.setAttribute("role", "button");
    tr.setAttribute("aria-expanded", isCollapsed ? "false" : "true");
    tr.tabIndex = 0;
    const td = document.createElement("td");
    td.colSpan = colSpan;
    const wrap = document.createElement("div");
    wrap.className = "cb-table-view-group-row-inner";

    const chevron = document.createElement("span");
    chevron.className = "cb-table-view-group-row-chevron";
    chevron.innerHTML = chevronDownSvg(12);
    chevron.setAttribute("aria-hidden", "true");

    const icon = document.createElement("span");
    icon.className = "cb-table-view-group-row-icon";
    icon.innerHTML = listSvg(13);

    const label = document.createElement("span");
    label.className = "cb-table-view-group-row-label";
    label.textContent = "Other";

    // (i) info icon — data points / enrichments behind a hover tip, matching
    // the use-case headers.
    const infoParts = [];
    if (dpCount > 0) infoParts.push(`${dpCount} data point${dpCount === 1 ? "" : "s"}`);
    if (erCount > 0) infoParts.push(`${erCount} enrichment${erCount === 1 ? "" : "s"}`);
    const info = document.createElement("span");
    info.className = "cb-uc-info";
    info.innerHTML = infoSvg(14);
    info.setAttribute("aria-label", infoParts.join(", "));
    attachInfoTip(info, infoParts);
    info.addEventListener("click", (e) => e.stopPropagation());
    info.addEventListener("mousedown", (e) => e.stopPropagation());

    // Amber "Not counted" cue so reps see at a glance this section is excluded
    // from the totals (most pointed for the unattached enrichments here).
    const cue = document.createElement("span");
    cue.className = "cb-table-view-other-uncounted";
    cue.innerHTML = warningSvg(11) + "<span>Not counted</span>";
    attachInfoTip(cue, [
      "Excluded from the totals.",
      "Move items into a use case to price them.",
    ]);

    wrap.appendChild(chevron);
    wrap.appendChild(icon);
    wrap.appendChild(label);
    wrap.appendChild(info);
    wrap.appendChild(cue);
    td.appendChild(wrap);
    tr.appendChild(td);

    const toggle = () => {
      if (collapsedGroups.has(OTHER_SECTION_KEY)) {
        collapsedGroups.delete(OTHER_SECTION_KEY);
      } else {
        collapsedGroups.add(OTHER_SECTION_KEY);
      }
      render();
    };
    tr.addEventListener("click", (evt) => {
      if (evt.button !== 0) return;
      toggle();
    });
    tr.addEventListener("contextmenu", (evt) => {
      evt.preventDefault();
      evt.stopPropagation();
      openContextMenu(evt.clientX, evt.clientY);
    });
    tr.addEventListener("keydown", (evt) => {
      if (evt.key === "Enter" || evt.key === " ") {
        evt.preventDefault();
        toggle();
      }
    });
    return tr;
  }

  // Arms a threshold-based drag on a whole row / group header (drag-anywhere,
  // no dedicated handle). On mousedown over a NON-interactive part of the row
  // we listen for movement; once the pointer travels past DRAG_THRESHOLD_PX we
  // promote it to a real block drag via startBlockDrag. Short of that the
  // gesture stays a plain click (select a row / toggle a group), so editing,
  // chips, and buttons are unaffected. startBlockDrag also sets
  // suppressNextRowClick so the trailing click doesn't double-fire selection.
  const DRAG_THRESHOLD_PX = 5;
  function attachRowDrag(tr, blockKind, blockKey) {
    tr.addEventListener("mousedown", (evt) => {
      if (evt.button !== 0) return;
      // Don't hijack drags that begin on interactive controls — let them
      // edit/click. Most already stopPropagation on mousedown; this is a
      // backstop that also covers bubbled events.
      if (
        evt.target instanceof Element &&
        evt.target.closest(
          'input, textarea, select, button, a, [contenteditable="true"], .cb-table-view-cell-input-text',
        )
      ) {
        return;
      }
      // Fresh gesture — clear any stale suppression left over from a drag that
      // ended on a different row (where no trailing click fired to consume it).
      suppressNextRowClick = false;
      const startX = evt.clientX;
      const startY = evt.clientY;
      let armed = true;
      const onArmMove = (e) => {
        if (!armed) return;
        if (
          Math.abs(e.clientX - startX) > DRAG_THRESHOLD_PX ||
          Math.abs(e.clientY - startY) > DRAG_THRESHOLD_PX
        ) {
          disarm();
          startBlockDrag(blockKind, blockKey, e);
        }
      };
      const onArmUp = () => disarm();
      const disarm = () => {
        armed = false;
        document.removeEventListener("mousemove", onArmMove);
        document.removeEventListener("mouseup", onArmUp);
      };
      document.addEventListener("mousemove", onArmMove);
      document.addEventListener("mouseup", onArmUp);
    });
  }

  // Wires generic row interaction handlers (selection click, right-click
  // context menu, drag-to-reorder) onto a <tr>. Caller is responsible for
  // adding the data-row-id and data-row-section attributes before calling.
  function attachRowInteractionHandlers(tr, rowId) {
    tr.addEventListener("click", (evt) => onRowClick(rowId, evt));
    tr.addEventListener("contextmenu", (evt) => onRowContextMenu(rowId, evt));
    attachRowDrag(tr, "row", rowId);
  }

  // Looks like a regular DP row but the DP cell carries an editable
  // placeholder input ("Add data point name…") rather than a value bound
  // to an existing card. Committing a non-empty name calls
  // attachDpToOrphanCluster which stamps a new DP card edge-to-edge with
  // the topmost-leftmost ER so the next refreshClusters round picks
  // them up as a single cluster — the row promotes itself out of the
  // orphan section on the next render. For Link-merged multi-ER rows,
  // the same call attaches the new DP to the entire cluster (one DP +
  // N ERs all clustered together).
  function buildOrphanDpStyleRow(row, sectionId) {
    // Backward-compat: legacy single-ER rows had `er`/`cardId`. The
    // current row shape is `cardIds`/`ers` arrays (so Link on orphan
    // ERs collapses the cluster into one row with multiple chips).
    // Normalize here so we can render either shape uniformly.
    const ers = row.ers || (row.er ? [row.er] : []);
    const cardIds = row.cardIds || (row.cardId != null ? [row.cardId] : []);
    const primaryCardId = row.cardId;

    const tr = document.createElement("tr");
    const orphanClasses = ["cb-table-view-dp-row", "cb-table-view-orphan-dp-row"];
    // Grey the orphan ER row when all its enrichment pills are frozen.
    if (ers.length > 0 && ers.every((e) => e.frozen))
      orphanClasses.push("cb-table-view-dp-row-frozen");
    tr.className = orphanClasses.join(" ");
    tr.setAttribute("data-card-id", String(primaryCardId));
    tr.setAttribute("data-row-id", String(primaryCardId));
    tr.setAttribute("data-row-section", sectionId || "orphan");
    attachRowInteractionHandlers(tr, String(primaryCardId));

    const dpCell = document.createElement("td");
    dpCell.className = "col-dp";
    // Grey "+" (mirrors the ER-column add chip) that reveals an inline input
    // on click — naming it attaches a new DP card to this orphan cluster.
    const addDpBtn = document.createElement("button");
    addDpBtn.type = "button";
    addDpBtn.className = "cb-table-view-add-dp-chip";
    addDpBtn.title = "Add a data point name for this enrichment";
    addDpBtn.innerHTML = plusSvg(11);
    addDpBtn.addEventListener("mousedown", (evt) => evt.stopPropagation());
    addDpBtn.addEventListener("click", (evt) => {
      evt.stopPropagation();
      const dpInput = document.createElement("input");
      dpInput.type = "text";
      dpInput.className = "cb-table-view-cell-input cb-table-view-cell-input-text";
      dpInput.placeholder = "Add data point name\u2026";
      dpInput.addEventListener("mousedown", (e) => e.stopPropagation());
      dpInput.addEventListener("click", (e) => e.stopPropagation());
      let committed = false;
      dpInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          e.target.blur();
        } else if (e.key === "Escape") {
          e.preventDefault();
          committed = true; // cancel without creating
          render();
        }
      });
      dpInput.addEventListener("blur", () => {
        if (committed) return;
        const text = dpInput.value.trim();
        if (text.length === 0) {
          render(); // restore the "+"
          return;
        }
        committed = true;
        attachDpToOrphanCluster(cardIds, text);
      });
      dpCell.replaceChildren(dpInput);
      dpInput.focus();
    });
    dpCell.appendChild(addDpBtn);
    tr.appendChild(dpCell);

    // Coverage = the ER's own coverage (editable in projected, run attempts in
    // actual). Fill is a per-data-point signal and doesn't belong on an
    // enrichment row, so this cell is left blank (keeps the column grid aligned)
    // instead of rendering a "—".
    tr.appendChild(buildCoverageCell(row.coverageFill?.coverage));
    const orphanFillTd = document.createElement("td");
    orphanFillTd.className = "col-fill";
    tr.appendChild(orphanFillTd);

    const actionsCell = document.createElement("td");
    actionsCell.className = "col-actions cb-table-view-cell-readonly";
    actionsCell.textContent = formatNumber(row.actions);
    tr.appendChild(actionsCell);

    const creditsCell = document.createElement("td");
    creditsCell.className = "col-credits cb-table-view-cell-readonly";
    if (row.creditsUnknown) {
      creditsCell.textContent = "\u2014";
      creditsCell.title = "Function cost is loading\u2026 switch to Actual for real spend";
    } else {
      creditsCell.textContent = formatNumber(row.credits);
    }
    tr.appendChild(creditsCell);

    const ersCell = document.createElement("td");
    ersCell.className = "col-ers";
    const chipsWrap = document.createElement("div");
    chipsWrap.className = "cb-table-view-er-chips";
    // Removable chip: the only way to delete an unattached enrichment,
    // since orphan-ER rows have no row-level × (the row goes away with
    // the ER itself). For Link-merged multi-chip rows, removing one
    // chip drops just that ER from the cluster — the row collapses
    // naturally on the next refresh.
    for (const er of ers) {
      chipsWrap.appendChild(buildErChipEl(er, /* removable */ true));
    }
    // Note badge sits to the right of the ER pills (orphan rows have no "+").
    const orphanNote = getCardForRowId(primaryCardId)?.data?.note;
    if (orphanNote && orphanNote.trim()) {
      chipsWrap.appendChild(buildNoteBadge(primaryCardId, orphanNote));
    }
    ersCell.appendChild(chipsWrap);
    tr.appendChild(ersCell);

    const endCell = document.createElement("td");
    endCell.className = "col-actions-end";
    tr.appendChild(endCell);

    return tr;
  }

  // Promote an orphan ER row by attaching a freshly-named DP card to
  // its cluster. Drives the relational model directly:
  //   1. Resolve the cluster id BEFORE addDataPointCard fires — reuse
  //      the orphan ERs' existing cluster id when present, otherwise
  //      allocate a fresh one and stamp it on every orphan ER.
  //   2. addDataPointCard with the resolved clusterId so the new DP
  //      joins the cluster from the moment its internal notifyChange
  //      propagates to the table view (no intermediate "DP shows up
  //      as orphan" frame, no second notifyChange that would push a
  //      bogus undo entry).
  //   3. Lay the cluster out into a snap-adjacent arrangement (DP on
  //      the left, ERs on the right) so canvas-mode geometry agrees.
  //   4. refreshClusters confirms the membership via snap-reconcile.
  function attachDpToOrphanCluster(erCardIds, text) {
    const canvas = __cb.canvas;
    if (!canvas?.getCardById || !canvas.addDataPointCard) return;
    if (!Array.isArray(erCardIds) || erCardIds.length === 0) return;
    const ers = erCardIds.map((id) => canvas.getCardById(id)).filter(Boolean);
    if (ers.length === 0) return;

    // Anchor on the topmost-leftmost ER so the new cluster lands near
    // where the user was looking on the canvas.
    const anchor = ers.slice().sort((a, b) => a.y - b.y || a.x - b.x)[0];

    // Resolve cluster id pre-add. The orphan ERs may already share a
    // cluster (multi-ER orphan via Link in the table view) or be
    // singletons. Reuse the smallest existing id so persisted state
    // stays stable; otherwise allocate fresh + stamp every ER so the
    // new DP isn't the lone first member.
    const existingIds = ers
      .map((c) => c.clusterId)
      .filter((id) => id != null);
    let clusterId = null;
    if (existingIds.length > 0) {
      clusterId = Math.min(...existingIds);
      // Defensive: if the inputs straddled multiple cluster ids,
      // unify them before adding the DP so the post-add cluster is
      // a single coherent unit.
      if (canvas.assignToCluster) canvas.assignToCluster(erCardIds, clusterId);
    } else if (canvas.allocateClusterId && canvas.assignToCluster) {
      clusterId = canvas.allocateClusterId();
      canvas.assignToCluster(erCardIds, clusterId);
    }

    const DP_W = 220;
    const newDp = canvas.addDataPointCard(text, {
      x: anchor.x - DP_W,
      y: anchor.y,
      clusterId,
    });
    if (!newDp) return;

    // Lineage link (Phase 2.c). The table view matches DP -> ER by lineage
    // keys, NOT by cluster, so a cluster-only attach would leave the freshly-
    // named DP as a separate "Not connected" row. Stamp the new DP with EVERY
    // ER key in the attached cluster (synthesizing stable local keys for
    // picker-authored ERs) so it reads as their shared output.
    const erKeys = erCardIds
      .map((id) => canvas.getCardById?.(id))
      .filter(Boolean)
      .map((er) => canvas.ensureErLineageKey?.(er))
      .filter((k) => k != null);
    if (erKeys.length > 0) __cb.setDpErKeys(newDp, erKeys);

    // Lay out the cluster so canvas-mode geometry matches the new
    // membership (DP on the LEFT of the ER column). Same bucketing
    // primitive linkCardsByIds uses; we don't call linkCardsByIds
    // itself because that would re-derive a cluster id from member
    // state and we already own the assignment above.
    if (clusterId != null && canvas.layoutCardsAsCluster) {
      canvas.layoutCardsAsCluster([newDp.id, ...erCardIds], {
        anchorX: anchor.x,
        anchorY: anchor.y,
      });
    }

    // Membership was set explicitly above; this refreshClusters is
    // confirmatory + cosmetic. Empty dragCardIds keeps unrelated cards
    // from being demoted on this pass.
    if (canvas.refreshClusters) canvas.refreshClusters({ dragCardIds: new Set() });
    // addDataPointCard fired a notifyChange BEFORE the lineage stamp above,
    // so that first render saw the DP as orphan. Re-notify + persist so the
    // row picks up the freshly-stamped link.
    __cb.model.update();
    if (__cb.saveTabs) __cb.saveTabs();
  }

  function buildDpRow(row, sectionId) {
    const tr = document.createElement("tr");
    const mergeMode = row.mergeMode || "single";
    const mergeSpan = row.mergeSpan || 1;
    const classes = ["cb-table-view-dp-row"];
    if (!row.connected) classes.push("cb-table-view-dp-row-unconnected");
    // Whole-row grey only when EVERY enrichment on the row is frozen (so the
    // row's enrichment cost is fully zero). Multi-ER rows with one active ER
    // keep their normal style — only the frozen pill greys.
    if (row.ers && row.ers.length > 0 && row.ers.every((e) => e.frozen))
      classes.push("cb-table-view-dp-row-frozen");
    if (mergeMode === "first" && mergeSpan > 1) classes.push("cb-table-view-dp-row-merge-first");
    if (mergeMode === "skip") classes.push("cb-table-view-dp-row-merge-follow");
    tr.className = classes.join(" ");
    tr.setAttribute("data-card-id", String(row.cardId));
    tr.setAttribute("data-row-id", String(row.cardId));
    tr.setAttribute("data-row-section", sectionId || "flat");
    // Surface the relational cluster id in the DOM so future features
    // (sort/filter, cluster naming, "select all in cluster", etc.) can
    // attach without re-deriving membership. Null when the DP isn't
    // in any cluster — emitted as the literal "null" so attribute-
    // selector queries can target unclustered rows specifically.
    const clusterId = getClusterIdForCardId(row.cardId);
    tr.setAttribute("data-cluster-id", clusterId == null ? "null" : String(clusterId));
    attachRowInteractionHandlers(tr, String(row.cardId));

    const dpCell = document.createElement("td");
    dpCell.className = "col-dp";
    if (pendingRenameCardId === row.cardId) {
      // Rename mode (or a freshly inserted DP): render a focused input. The
      // render() focus pass selects it; commit writes via commitDpName.
      const dpInput = document.createElement("input");
      dpInput.type = "text";
      dpInput.className = "cb-table-view-cell-input cb-table-view-cell-input-text";
      dpInput.value = row.name;
      dpInput.placeholder = "Type data point\u2026";
      // Stop propagation on the input itself so editing doesn't also toggle
      // row selection. Same trick the existing chip x button uses.
      dpInput.addEventListener("mousedown", (evt) => evt.stopPropagation());
      dpInput.addEventListener("click", (evt) => evt.stopPropagation());
      dpInput.addEventListener("keydown", (evt) => {
        if (evt.key === "Enter") evt.target.blur();
      });
      dpInput.addEventListener("blur", () => commitDpName(row.cardId, dpInput.value));
      dpCell.appendChild(dpInput);
    } else {
      // Static text — single click anywhere on the row (including the name)
      // selects it; DOUBLE-click the name renames inline (quick entry point
      // alongside the right-click "Rename"). Selection only toggles classes (no
      // re-render), so the dblclick fires reliably on the same element.
      const dpText = document.createElement("div");
      dpText.className = "cb-table-view-dp-name";
      if (row.name) {
        dpText.textContent = row.name;
      } else {
        dpText.classList.add("cb-table-view-dp-name-empty");
        dpText.textContent = "Untitled data point";
      }
      dpText.addEventListener("dblclick", (evt) => {
        evt.preventDefault();
        evt.stopPropagation();
        pendingRenameCardId = row.cardId;
        render();
      });
      dpCell.appendChild(dpText);
    }
    tr.appendChild(dpCell);

    // Coverage (per enrichment): projected = editable rows (default total rows,
    // drives cost); actual = real run attempts / total. Editing it from any one
    // DP row writes the ER once, syncing every DP it returns.
    tr.appendChild(buildCoverageCell(row.coverageFill?.coverage));

    // Fill rate (per DP): projected = editable %; actual = nonNull / ER coverage
    // (read-only), spinner while the full profile loads.
    tr.appendChild(buildFillCell(row.coverageFill?.fill, row.cardId));

    // Actions / credits render per DP row — each carries its own split share
    // (ER credits ÷ #DPs the ER feeds), so a merge run still sums to the ER's
    // true per-row cost. Only the ERs chips collapse into the "first" row of a
    // merge run via rowspan; followers ("skip") omit just that one cell.
    const actionsCell = document.createElement("td");
    actionsCell.className = "col-actions cb-table-view-cell-readonly";
    actionsCell.textContent = formatNumber(row.actions);
    tr.appendChild(actionsCell);

    const creditsCell = document.createElement("td");
    creditsCell.className = "col-credits cb-table-view-cell-readonly";
    if (row.creditsUnknown) {
      creditsCell.textContent = "\u2014";
      creditsCell.title = "Function cost is loading\u2026 switch to Actual for real spend";
    } else {
      creditsCell.textContent = formatNumber(row.credits);
    }
    tr.appendChild(creditsCell);

    if (mergeMode !== "skip") {
      const ersCell = document.createElement("td");
      ersCell.className = "col-ers" + (mergeSpan > 1 ? " cb-table-view-cell-merged" : "");
      if (mergeSpan > 1) ersCell.rowSpan = mergeSpan;
      const chipsWrap = document.createElement("div");
      chipsWrap.className = "cb-table-view-er-chips";
      for (const er of row.ers) {
        chipsWrap.appendChild(buildErChipEl(er, /* removable */ true));
      }
      // Note badge sits to the right of the ER pills, just before the "+".
      const dpNote = getCardForRowId(row.cardId)?.data?.note;
      if (dpNote && dpNote.trim()) {
        chipsWrap.appendChild(buildNoteBadge(row.cardId, dpNote));
      }
      const addErBtn = document.createElement("button");
      addErBtn.type = "button";
      addErBtn.className = "cb-table-view-add-er-chip";
      addErBtn.title = "Add an enrichment to this data point";
      // Icon-only "+" — the row context already makes the action clear; the
      // title carries the label for hover/a11y.
      addErBtn.innerHTML = plusSvg(11);
      addErBtn.addEventListener("mousedown", (evt) => evt.stopPropagation());
      addErBtn.addEventListener("click", (evt) => {
        evt.stopPropagation();
        startAddEnrichment(row.cardId);
      });
      chipsWrap.appendChild(addErBtn);
      ersCell.appendChild(chipsWrap);
      tr.appendChild(ersCell);
    }

    const endCell = document.createElement("td");
    endCell.className = "col-actions-end";
    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.className = "cb-table-view-row-delete";
    delBtn.title = "Delete this data point from the canvas";
    delBtn.setAttribute("aria-label", "Delete data point");
    delBtn.innerHTML = xSvg(13);
    delBtn.addEventListener("mousedown", (evt) => evt.stopPropagation());
    delBtn.addEventListener("click", (evt) => {
      evt.stopPropagation();
      removeCardById(row.cardId);
    });
    endCell.appendChild(delBtn);
    tr.appendChild(endCell);

    return tr;
  }

  // Yellow comment badge shown to the left of the ER pills when the row's
  // primary card carries a note. Hover previews the note text; click opens the
  // editor. `cardId` is the row's primary card id (DP or orphan ER).
  function buildNoteBadge(cardId, note) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "cb-table-view-note-badge";
    btn.title = "Note (click to edit)";
    btn.setAttribute("aria-label", "Row note");
    btn.innerHTML = noteSvg(12);
    btn.addEventListener("mousedown", (evt) => evt.stopPropagation());
    btn.addEventListener("mouseenter", () => showNotePreview(note, btn));
    btn.addEventListener("mouseleave", () => hideNotePreview());
    btn.addEventListener("click", (evt) => {
      evt.stopPropagation();
      hideNotePreview();
      openNotePopover(cardId, btn);
    });
    return btn;
  }

  function buildErChipEl(er, removable) {
    const chip = document.createElement("span");
    // Uniform classic-white pill for every kind — the enrichment kind is
    // surfaced in the details-menu badge, not the pill color.
    chip.className = "cb-table-view-er-chip";
    // Frozen (deactivated) ER: grey the pill. Cost is already zeroed upstream
    // (perRowCost short-circuits on data.frozen).
    if (er.frozen) chip.classList.add("cb-table-view-er-chip-frozen");
    // Lets erContextItems / openNotePopover anchor to this chip by ER id.
    chip.setAttribute("data-er-id", String(er.id));
    chip.title =
      er.isWaterfall && er.providerChain
        ? `${er.name} \u2014 ${er.providerChain}`
        : er.name;
    // Right-click a chip → the enrichment-only menu (Leave a note + Freeze),
    // not the host row's menu. stopPropagation keeps the row handler from also
    // firing; preventDefault suppresses the browser's native menu.
    chip.addEventListener("contextmenu", (evt) => {
      evt.preventDefault();
      evt.stopPropagation();
      openContextMenu(evt.clientX, evt.clientY, { erCardId: er.id });
    });

    // Icon + label form a single clickable trigger that opens the details
    // menu underneath the pill. mousedown stopPropagation keeps the click
    // from starting row selection / row drag (same trick the freq + remove
    // buttons use). The freq badge and remove × stay separate siblings.
    const trigger = document.createElement("button");
    trigger.type = "button";
    trigger.className = "cb-table-view-er-chip-trigger";
    trigger.setAttribute("aria-haspopup", "true");
    trigger.appendChild(buildErChipIcon(er));
    const label = document.createElement("span");
    label.className = "cb-table-view-er-chip-label";
    label.textContent = er.name;
    trigger.appendChild(label);
    trigger.addEventListener("mousedown", (evt) => evt.stopPropagation());
    trigger.addEventListener("click", (evt) => {
      evt.stopPropagation();
      openErChipMenu(er, trigger);
    });
    chip.appendChild(trigger);

    // Run-share % badge — only on a data point row that links 2+ ERs. Shows
    // the fraction of rows this ER runs (drives the projected per-row cost).
    // Clicking opens the share popover (% / rows / order) in both modes; in
    // Actual the popover is read-only since the % is measured (this ER's runs
    // vs the widest linked ER).
    if (er.multiEr && er.runShare != null && er.dpCardId != null) {
      const actual = window.__cb?.viewMode === "actual";
      const shareBtn = document.createElement("button");
      shareBtn.type = "button";
      shareBtn.className = "cb-table-view-er-chip-share";
      const pct = Math.round(er.runShare * 100);
      shareBtn.textContent = pct + "%";
      shareBtn.title = actual
        ? `Ran on ~${pct}% of rows \u2014 click for the breakdown`
        : "Run-share \u2014 click to edit % / rows / order";
      shareBtn.addEventListener("mousedown", (evt) => evt.stopPropagation());
      shareBtn.addEventListener("click", (evt) => {
        evt.stopPropagation();
        openErShareMenu(er, shareBtn);
      });
      chip.appendChild(shareBtn);
    }

    // Per-ER frequency badge — same "×N" affordance as the canvas freqBadge
    // (cards.js ~line 822). Only rendered when the user pinned a per-ER
    // override (frequencyCustom); otherwise frequency lives in the details
    // menu and inherits the global default. Clicking opens the shared picker.
    if (er.frequencyCustom) {
      const freqBtn = document.createElement("button");
      freqBtn.type = "button";
      freqBtn.className = "cb-table-view-er-chip-freq";
      freqBtn.title = `Runs ${er.frequencyLabel || "annually"} \u2014 click to change`;
      freqBtn.textContent = "\u00d7" + (er.multiplier ?? 1);
      freqBtn.addEventListener("mousedown", (evt) => evt.stopPropagation());
      freqBtn.addEventListener("click", (evt) => {
        evt.stopPropagation();
        const cb = window.__cb;
        if (!cb?.showFrequencyPicker) return;
        cb.showFrequencyPicker(freqBtn, er.frequencyId, (picked) => {
          commitFrequency(er.id, picked);
        });
      });
      chip.appendChild(freqBtn);
    }

    if (removable) {
      const x = document.createElement("button");
      x.type = "button";
      x.className = "cb-table-view-er-chip-remove";
      // On a data point row, the × DETACHES this enrichment from the DP (the ER
      // card stays). On an orphan-ER row (no dpCardId) it deletes the ER card.
      const onDpRow = er.dpCardId != null;
      x.title = onDpRow
        ? "Detach this enrichment from the data point"
        : "Remove this enrichment from the canvas";
      x.setAttribute("aria-label", onDpRow ? "Detach enrichment" : "Remove enrichment");
      x.innerHTML = xSvg(10);
      x.addEventListener("mousedown", (evt) => evt.stopPropagation());
      x.addEventListener("click", (evt) => {
        evt.stopPropagation();
        if (onDpRow) {
          detachErFromDp(er.dpCardId, er.id);
        } else {
          removeCardById(er.id);
        }
      });
      chip.appendChild(x);
    }

    // The enrichment's own note (set via the chip's right-click "Leave a
    // note"). Sits inside the pill so it travels with the ER across every row
    // it chips into, distinct from a data-point row's note badge.
    if (er.note && String(er.note).trim()) {
      chip.appendChild(buildNoteBadge(er.id, er.note));
    }
    return chip;
  }

  // Builds the logo node for an ER chip, mirroring the canvas card icon
  // logic (src/canvas/cards.js ~639-666): waterfalls get the stacked-layers
  // glyph; otherwise an <img> (with a first-letter fallback on error), then
  // inline SVG, then a colored first-letter monogram. Returns a fresh node
  // each call so the same `er` can render an icon in both the chip and the
  // details-menu header.
  function buildErChipIcon(er) {
    const icon = document.createElement("span");
    icon.className = "cb-table-view-er-chip-icon";
    if (er.isWaterfall) {
      icon.classList.add("cb-table-view-er-chip-icon-waterfall");
      icon.innerHTML = waterfallSvg(13);
      return icon;
    }
    if (er.iconUrl) {
      const img = document.createElement("img");
      img.src = er.iconUrl;
      img.alt = "";
      img.className = "cb-table-view-er-chip-icon-img";
      img.onerror = () => {
        img.remove();
        icon.textContent = (er.packageName || er.name || "C").charAt(0).toUpperCase();
      };
      icon.appendChild(img);
      return icon;
    }
    if (er.iconSvgHtml) {
      icon.innerHTML = er.iconSvgHtml;
      icon.querySelector("svg")?.setAttribute("class", "cb-table-view-er-chip-icon-svg");
      return icon;
    }
    const color = __cb.stringToColor ? __cb.stringToColor(er.packageName || er.name || "Clay") : "#6366f1";
    icon.style.backgroundColor = color + "18";
    icon.style.color = color;
    icon.textContent = (er.packageName || er.name || "C").charAt(0).toUpperCase();
    return icon;
  }

  // ---- ER chip details menu ----
  //
  // Anchored popover opened by clicking an ER pill. Summarizes the
  // enrichment (kind + provider/model), its per-row cost + frequency, the
  // AI model (when applicable), and offers "Find in table" — the same
  // navigation the canvas right-click menu uses (__cb.openCardInTable),
  // gated on the card carrying fieldId + tableId. Functions additionally get
  // "Open function" (jumps to the referenced table). Built on click (not per
  // chip) so a large import only pays for the logo per pill.

  function closeErChipMenu() {
    closeErMenuModelPicker();
    closeErMenuKeyToggle();
    window.__cb.closeFrequencyPicker?.();
    if (erChipMenuEl) { erChipMenuEl.remove(); erChipMenuEl = null; }
    if (erChipMenuBackdrop) { erChipMenuBackdrop.remove(); erChipMenuBackdrop = null; }
    erChipMenuCardId = null;
    erChipMenuPos = null;
    erChipMenuShareDpId = null;
    document.removeEventListener("keydown", onErChipMenuKey);
  }

  function onErChipMenuKey(evt) {
    if (evt.key === "Escape") closeErChipMenu();
  }

  // Value may be a string (plain text) or a DOM Node (icon pills/badges).
  function erMenuRow(labelText, value) {
    const row = document.createElement("div");
    row.className = "cb-table-view-er-menu-row";
    const l = document.createElement("span");
    l.className = "cb-table-view-er-menu-row-label";
    l.textContent = labelText;
    const v = document.createElement("span");
    v.className = "cb-table-view-er-menu-row-value";
    if (value instanceof Node) v.appendChild(value);
    else v.textContent = value;
    row.appendChild(l);
    row.appendChild(v);
    return row;
  }

  // Builds the Cost value as Clay's segmented credit/action pill (matches the
  // ActionExecutionBadge + CreditPriceBadge group in the column editor): a
  // StarFour glyph for action executions (nightshade) and a Coin/Coins glyph
  // for data credits (matcha). The credit segment is clickable — it opens the
  // same "use private key / use Clay credits" toggle as the canvas credit pill
  // (private key zeroes data credits but not action executions, so the actions
  // segment stays). Shows the blue key glyph + "Private key" when in key mode.
  function buildErMenuCostNode(er) {
    const c = er.cost || {};
    const calculating = !!c.creditsUnknown;
    // Annualize the per-row figures when the ER runs more than once a year
    // (frequency override); the pill then gets an amber outline to flag it.
    const freqMult = er.multiplier ?? 1;
    const overridden = freqMult !== 1;
    const mult = overridden ? freqMult : 1;
    const actions = (Number(c.actions) || 0) * mult;

    const pill = document.createElement("span");
    pill.className = "cb-pill cb-table-view-er-cost-pill";
    if (overridden) pill.classList.add("cb-table-view-er-cost-pill-override");

    if (!calculating && actions > 0) {
      const seg = document.createElement("span");
      seg.className = "cb-pill-seg cb-table-view-er-cost-seg cb-table-view-er-cost-actions";
      seg.title = `${formatNumber(actions)} action${actions === 1 ? "" : "s"}`;
      seg.innerHTML = starFourSvg(12) + `<span>${formatNumber(actions)}</span>`;
      pill.appendChild(seg);
    }

    const credSeg = document.createElement("span");
    credSeg.className = "cb-pill-seg cb-table-view-er-cost-seg cb-table-view-er-cost-credits";
    if (calculating) {
      credSeg.innerHTML = coinSvg(12) + "<span>Calculating\u2026</span>";
    } else if (er.usePrivateKey) {
      credSeg.classList.add("cb-table-view-er-cost-credits-key");
      credSeg.title = "Billing against your private key (0 credits) \u2014 click to change";
      credSeg.innerHTML = KEY_TOGGLE_KEY_SVG + "<span>Private key</span>";
    } else {
      const credits = (Number(c.credits) || 0) * mult;
      // Variable-priced AI models are estimates, so prefix "~" to match the
      // model picker; fixed-price models and non-AI enrichments show the exact
      // figure without it.
      const tilde = er.isAi && __cb.isVariableModelId(er.model?.id) ? "~" : "";
      credSeg.title = `${tilde}${formatNumber(credits)} credit${credits === 1 ? "" : "s"} \u2014 click to change`;
      const coin = Math.abs(credits) <= 1 ? coinSvg(12) : coinsSvg(12);
      credSeg.innerHTML = coin + `<span>${tilde}${formatNumber(credits)}</span>`;
    }

    // Resolved cost → the credit segment toggles private key on click, exactly
    // like the canvas credit pill's showKeyToggle.
    if (!calculating) {
      credSeg.classList.add("cb-table-view-er-cost-credits-toggle");
      credSeg.setAttribute("role", "button");
      credSeg.setAttribute("aria-haspopup", "true");
      credSeg.addEventListener("mousedown", (evt) => evt.stopPropagation());
      credSeg.addEventListener("click", (evt) => {
        evt.stopPropagation();
        openErMenuKeyToggle(er, credSeg);
      });
    }

    pill.appendChild(credSeg);
    return pill;
  }

  // Read-only "Total" cost node (run total over all records) — StarFour + Coin
  // pair. `which` = "projected" (per-row × records × coverage × frequency) or
  // "actual" (measured spend totals). Returns null when not computable.
  function buildErMenuTotalNode(er, which) {
    const records = Number(er.records) || 0;
    const mult = er.multiplier ?? 1;
    const freqOverridden = mult !== 1;
    let credits, actions;
    if (which === "actual") {
      if (!er.spendTotal) return null;
      // Scale measured spend to the scoped Records: spend × (records / total) ×
      // frequency — matches the use-case header. Falls back to raw × frequency
      // when there's no coverage total to scale by.
      const total = er.actualCoverage && er.actualCoverage.total > 0 ? er.actualCoverage.total : 0;
      const scale = total > 0 && records > 0 ? records / total : 1;
      credits = (Number(er.spendTotal.credits) || 0) * scale * mult;
      actions = (Number(er.spendTotal.actions) || 0) * scale * mult;
    } else {
      if (!records || (er.cost && er.cost.creditsUnknown)) return null;
      const cov = er.coverageRows != null && records > 0
        ? Math.min(1, er.coverageRows / records)
        : 1;
      const perCr = er.usePrivateKey ? 0 : (Number(er.cost?.credits) || 0);
      const perAct = Number(er.cost?.actions) || 0;
      credits = perCr * records * cov * mult;
      actions = perAct * records * cov * mult;
    }
    if (credits <= 0 && actions <= 0) return null;
    const pill = document.createElement("span");
    pill.className = "cb-pill cb-table-view-er-cost-pill";
    // Amber when frequency is overridden, or (Actual) when Records is overridden
    // from the imported baseline — same convention as the Records field.
    if (freqOverridden || (which === "actual" && er.recordsOverridden)) {
      pill.classList.add("cb-table-view-er-cost-pill-override");
    }
    if (actions > 0) {
      const seg = document.createElement("span");
      seg.className = "cb-pill-seg cb-table-view-er-cost-seg cb-table-view-er-cost-actions";
      seg.title = `${formatNumber(actions)} action${actions === 1 ? "" : "s"} total`;
      seg.innerHTML = starFourSvg(12) + `<span>${formatNumber(Math.round(actions))}</span>`;
      pill.appendChild(seg);
    }
    const credSeg = document.createElement("span");
    credSeg.className = "cb-pill-seg cb-table-view-er-cost-seg cb-table-view-er-cost-credits";
    credSeg.title = `${formatNumber(credits)} credits total`;
    const coin = Math.abs(credits) <= 1 ? coinSvg(12) : coinsSvg(12);
    credSeg.innerHTML = coin + `<span>${formatNumber(Math.round(credits))}</span>`;
    pill.appendChild(credSeg);
    return pill;
  }

  // The "cute little badge" — the same amber ×N pill the chips use, editable:
  // clicking opens the shared frequency picker and commits through the same
  // path as the chip badge (commitFrequency → applyClusterFrequency).
  function buildErMenuFrequencyNode(er) {
    const badge = document.createElement("button");
    badge.type = "button";
    badge.className = "cb-table-view-er-chip-freq cb-table-view-er-menu-freq";
    badge.title = `Runs ${er.frequencyLabel || "annually"} \u2014 click to change`;
    badge.textContent = "\u00d7" + (er.multiplier ?? 1);
    badge.addEventListener("mousedown", (evt) => evt.stopPropagation());
    badge.addEventListener("click", (evt) => {
      evt.stopPropagation();
      const cb = window.__cb;
      if (!cb?.showFrequencyPicker) return;
      cb.showFrequencyPicker(badge, er.frequencyId, (picked) => {
        commitFrequency(er.id, picked);
      });
    });
    return badge;
  }

  // Run-share value for the details menu (multi-ER DP chips only) — a second
  // entry point to the % / rows / order editor. Projected is an editable pill
  // that opens the popover; Actual shows the measured "X% · ~N rows" read-only.
  function buildErMenuShareNode(er, which) {
    const pct = Math.round((er.runShare ?? 0) * 100);
    const base = dpRowBase(er.dpCardId);
    const rows = Math.round((er.runShare ?? 0) * base);
    const text = base > 0 ? `${pct}% \u00b7 ~${formatNumber(rows)} rows` : `${pct}%`;
    if (which === "actual") {
      const span = document.createElement("span");
      span.className = "cb-table-view-er-menu-share";
      span.textContent = text;
      span.title = `Ran on ~${pct}% of rows`;
      return span;
    }
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "cb-table-view-er-menu-share cb-table-view-er-menu-share-edit";
    btn.textContent = text;
    btn.title = "Run-share \u2014 click to edit % / rows / order";
    btn.addEventListener("mousedown", (evt) => evt.stopPropagation());
    btn.addEventListener("click", (evt) => {
      evt.stopPropagation();
      openErShareMenu(er, btn);
    });
    return btn;
  }

  // Model value — an indigo pill (mirrors the canvas model chip) that opens the
  // same grouped provider/model picker. AI columns only.
  function buildErMenuModelNode(er) {
    const pill = document.createElement("button");
    pill.type = "button";
    pill.className = "cb-table-view-er-menu-model";
    pill.title = er.model.provider
      ? `${er.model.name} \u00b7 ${er.model.provider} \u2014 click to change`
      : `${er.model.name} \u2014 click to change`;
    const nameSpan = document.createElement("span");
    nameSpan.className = "cb-table-view-er-menu-model-name";
    nameSpan.textContent = er.model.name;
    pill.appendChild(nameSpan);
    pill.insertAdjacentHTML("beforeend", chevronDownSvg(11));
    pill.addEventListener("mousedown", (evt) => evt.stopPropagation());
    pill.addEventListener("click", (evt) => {
      evt.stopPropagation();
      openErMenuModelPicker(er, pill);
    });
    return pill;
  }

  // Read-only provenance pill for the "Clay Budgeted" row: shows the per-row
  // "Clay Credit Budget" (runBudget) that an expensive Use AI model's cost was
  // set from, so the rep knows the number came from the column's configured
  // budget rather than a misread. Reuses buildErMenuCostNode's coin glyph.
  function buildClayBudgetNode(er) {
    const budget = Number(er.clayBudget) || 0;
    const pill = document.createElement("span");
    pill.className = "cb-pill cb-table-view-er-cost-pill";
    pill.title =
      "Per-row cost uses the Clay Credit Budget set on this column in Clay " +
      "(the maximum credits to spend per row for this AI model).";
    const seg = document.createElement("span");
    seg.className = "cb-pill-seg cb-table-view-er-cost-seg cb-table-view-er-cost-credits";
    const coin = Math.abs(budget) <= 1 ? coinSvg(12) : coinsSvg(12);
    seg.innerHTML = coin + `<span>${formatNumber(budget)}</span>`;
    pill.appendChild(seg);
    return pill;
  }

  // Builds (or rebuilds) the menu's contents into `menu`. Split out from
  // openErChipMenu so the menu can be re-rendered in place after an edit
  // (frequency / model / private-key) without tearing it down — the user keeps
  // it open to change other things. Editing controls close only their own
  // sub-popover; the commit flows back here via refreshOpenErMenu.
  function renderErMenuBody(menu, er) {
    menu.innerHTML = "";

    // Header: logo + name + kind badge.
    const header = document.createElement("div");
    header.className = "cb-table-view-er-menu-header";
    header.appendChild(buildErChipIcon(er));
    const title = document.createElement("div");
    title.className = "cb-table-view-er-menu-title";
    title.textContent = er.name;
    header.appendChild(title);
    const kindBadge = document.createElement("span");
    kindBadge.className =
      "cb-table-view-er-menu-kind cb-table-view-er-menu-kind-" + er.kind.toLowerCase();
    kindBadge.textContent = er.kind;
    header.appendChild(kindBadge);
    menu.appendChild(header);

    // Cost section, mode-dependent: only the active view's "Cost per row" +
    // "Total", labeled (proj.)/(actual). Frequency is its own row BELOW the two
    // pills (editable ×N badge); changing it annualizes + ambers both pills
    // above. The model row (AI columns only) stays an editable pill here.
    const costSection = document.createElement("div");
    costSection.className = "cb-table-view-er-menu-section";
    const which = window.__cb?.viewMode === "actual" ? "actual" : "projected";
    const modeLabel = which === "actual" ? " (actual)" : " (proj.)";

    costSection.appendChild(erMenuRow("Cost per row" + modeLabel, buildErMenuCostNode(er)));

    const totalNode = buildErMenuTotalNode(er, which);
    if (totalNode) costSection.appendChild(erMenuRow("Total" + modeLabel, totalNode));

    // Frequency on its own row, beneath the two pills it drives.
    costSection.appendChild(erMenuRow("Frequency", buildErMenuFrequencyNode(er)));

    // Run-share row — only when this chip belongs to a multi-ER DP. A second
    // entry point to the % / rows / order editor (the chip % badge is the other).
    if (er.multiEr && er.dpCardId != null && er.runShare != null) {
      costSection.appendChild(erMenuRow("Run-share" + modeLabel, buildErMenuShareNode(er, which)));
    }

    if (er.isAi && er.model) {
      costSection.appendChild(erMenuRow("Model", buildErMenuModelNode(er)));
    }

    // Provenance row: the per-row cost above was set from the column's "Clay
    // Credit Budget" (runBudget) on an expensive Use AI model. Hidden for BYOK
    // (Clay bills 0, so the budget doesn't apply).
    if (er.isAi && er.clayBudget != null && !er.usePrivateKey) {
      costSection.appendChild(erMenuRow("Clay Budgeted", buildClayBudgetNode(er)));
    }
    menu.appendChild(costSection);

    // Footer: "Find in table" scrolls the source column into view (reuses the
    // canvas navigation). Functions also get "Open function", which jumps to
    // the subroutine's referenced "main function" table. CSS flex:1 makes a
    // lone button full-width and splits two buttons into equal halves.
    const canOpen = !!(er.fieldId && er.tableId);
    const footer = document.createElement("div");
    footer.className = "cb-table-view-er-menu-footer";

    const openBtn = document.createElement("button");
    openBtn.type = "button";
    openBtn.className =
      "cb-table-view-er-menu-open" + (canOpen ? "" : " cb-table-view-er-menu-open-disabled");
    openBtn.innerHTML = tableSvg(13) + "<span>Find in table</span>";
    if (canOpen) {
      openBtn.addEventListener("click", (evt) => {
        evt.stopPropagation();
        closeErChipMenu();
        const card = __cb.canvas?.getCardById?.(er.id);
        if (card && typeof __cb.openCardInTable === "function") {
          __cb.openCardInTable(card);
        }
      });
    } else {
      openBtn.disabled = true;
      openBtn.title = "This enrichment wasn't imported from a Clay table";
    }
    footer.appendChild(openBtn);

    if (er.isFunction && er.referencedTableId) {
      const openFnBtn = document.createElement("button");
      openFnBtn.type = "button";
      openFnBtn.className = "cb-table-view-er-menu-open";
      openFnBtn.innerHTML = externalLinkSvg(13) + "<span>Open function</span>";
      openFnBtn.addEventListener("click", (evt) => {
        evt.stopPropagation();
        closeErChipMenu();
        if (typeof __cb.openReferencedTable === "function") {
          __cb.openReferencedTable(er);
        }
      });
      footer.appendChild(openFnBtn);
    }

    // Waterfalls get "View providers" — opens the same provider-chain popover
    // as the canvas "+N" badge (reorder / add / per-step costs / validation).
    // The details menu stays open underneath; the popover anchors to the button.
    if (er.isWaterfall) {
      const providersBtn = document.createElement("button");
      providersBtn.type = "button";
      providersBtn.className = "cb-table-view-er-menu-open cb-table-view-er-menu-providers";
      providersBtn.innerHTML = waterfallSvg(13) + "<span>View providers</span>";
      providersBtn.addEventListener("click", (evt) => {
        evt.stopPropagation();
        const card = __cb.canvas?.getCardById?.(er.id);
        if (card && typeof __cb.showProviderChain === "function") {
          // besideEl = the details menu, so the popover sits next to it instead
          // of covering it.
          __cb.showProviderChain(card, providersBtn, { besideEl: erChipMenuEl });
        }
      });
      footer.appendChild(providersBtn);
    }

    menu.appendChild(footer);
  }

  // Clamp the open menu to the viewport given preferred (pre-clamp) coords.
  function positionErMenu(preferredLeft, preferredTop) {
    if (!erChipMenuEl) return;
    const mw = erChipMenuEl.offsetWidth;
    const mh = erChipMenuEl.offsetHeight;
    const left = Math.max(8, Math.min(preferredLeft, window.innerWidth - mw - 8));
    let top = preferredTop;
    if (top + mh > window.innerHeight - 8) {
      top = Math.max(8, window.innerHeight - mh - 8);
    }
    erChipMenuEl.style.left = `${left}px`;
    erChipMenuEl.style.top = `${top}px`;
  }

  // Re-render the open details menu from fresh card data after an edit/refresh,
  // keeping it open. Skips while a sub-popover (model / key / frequency) is
  // open so its in-menu anchor isn't torn out from under it.
  function refreshOpenErMenu() {
    if (!erChipMenuEl || erChipMenuCardId == null) return;
    // Note: the provider-chain popover is intentionally NOT in this skip list —
    // editing providers should live-update the menu's cost pill. The popover is
    // a separate body-mounted panel positioned once, so re-rendering the menu
    // underneath (rebuilding the "View providers" anchor) doesn't disturb it.
    if (erMenuModelPickerEl || erMenuKeyToggleEl || window.__cb._freqPickerEl) return;
    const card = __cb.canvas?.getCardById?.(erChipMenuCardId);
    if (!card) { closeErChipMenu(); return; }
    const data = buildErChipData(card);
    // Re-attach the per-(DP,ER) run-share context lost by the plain rebuild, so
    // the Run-share row stays and reflects the just-committed value.
    if (erChipMenuShareDpId != null) {
      const ctx = erRunShareFor(erChipMenuShareDpId, erChipMenuCardId);
      if (ctx) Object.assign(data, ctx);
    }
    renderErMenuBody(erChipMenuEl, data);
    if (erChipMenuPos) positionErMenu(erChipMenuPos.left, erChipMenuPos.top);
  }

  // `fixedPos` ({ left, top }) re-opens the menu at saved viewport coords
  // instead of anchoring to a chip — used when re-opening after the waterfall
  // "+" picker hand-off, where the original chip node has been re-rendered.
  function openErChipMenu(er, anchorEl, fixedPos = null) {
    closeErChipMenu();
    closeContextMenu();

    erChipMenuBackdrop = document.createElement("div");
    erChipMenuBackdrop.className = "cb-table-view-er-menu-backdrop";
    erChipMenuBackdrop.addEventListener("mousedown", (evt) => {
      evt.stopPropagation();
      closeErChipMenu();
    });
    erChipMenuBackdrop.addEventListener("contextmenu", (evt) => {
      evt.preventDefault();
      closeErChipMenu();
    });

    const menu = document.createElement("div");
    menu.className = "cb-table-view-er-menu";
    menu.addEventListener("mousedown", (evt) => evt.stopPropagation());

    document.body.appendChild(erChipMenuBackdrop);
    document.body.appendChild(menu);
    erChipMenuEl = menu;
    erChipMenuCardId = er.id;
    // Remember the host DP when this chip belongs to a multi-ER DP, so a refresh
    // can re-derive the Run-share row instead of dropping it.
    erChipMenuShareDpId = er.multiEr && er.dpCardId != null ? er.dpCardId : null;

    renderErMenuBody(menu, er);

    // Position below the chip, left-aligned, clamped to the viewport (flip
    // above when it would overflow the bottom). The preferred coords are
    // stashed so an in-place re-render re-clamps to the same anchor.
    menu.style.position = "fixed";
    menu.style.zIndex = "9999999";
    menu.style.left = "0px";
    menu.style.top = "0px";
    if (fixedPos) {
      erChipMenuPos = { left: fixedPos.left, top: fixedPos.top };
    } else {
      const rect = anchorEl.getBoundingClientRect();
      let preferredTop = rect.bottom + 6;
      if (preferredTop + menu.offsetHeight > window.innerHeight - 8) {
        const above = rect.top - 6 - menu.offsetHeight;
        if (above > 8) preferredTop = above;
      }
      erChipMenuPos = { left: rect.left, top: preferredTop };
    }
    positionErMenu(erChipMenuPos.left, erChipMenuPos.top);

    document.addEventListener("keydown", onErChipMenuKey);
  }

  // Group-section header row. For real cb-groups the label is an inline
  // input that writes back to the canvas's .cb-group-label on commit;
  // legacy comment-card sections render a non-editable span (no canvas
  // input to write through to). Clicking the chevron / icon / count
  // toggles collapse; clicking the label focuses the input. Drag handle
  // on the leftmost column reorders groups.
  // Per-use-case (per imported table) scope controls shown in the table header
  // when 2+ use cases exist: editable Records, a Frequency picker, and this use
  // case's sub-total. Writes via __cb.setUseCaseScope (re-runs the roll-up).
  // Global cost-display unit for the per-use-case credit/action cost badges:
  // "year" (the annualized totals) or "record" (one row's share for the year).
  // Persisted in page localStorage so the rep's choice survives reloads.
  function getCostUnit() {
    const cb = window.__cb;
    if (cb.costUnit == null) {
      try { cb.costUnit = localStorage.getItem("cb-cost-unit") || "year"; }
      catch (_) { cb.costUnit = "year"; }
    }
    return cb.costUnit === "record" ? "record" : "year";
  }
  function setCostUnit(unit) {
    const cb = window.__cb;
    cb.costUnit = unit === "record" ? "record" : "year";
    try { localStorage.setItem("cb-cost-unit", cb.costUnit); } catch (_) {}
  }

  // Dropdown to switch the credit/action cost badges between "Per year" and
  // "Per record". Mounted on body + fixed-positioned like the other overlay
  // popovers; toggling re-renders the table so every use case stays in sync.
  let costUnitMenuEl = null;
  let costUnitMenuBackdrop = null;
  function closeCostUnitMenu() {
    if (costUnitMenuEl) { costUnitMenuEl.remove(); costUnitMenuEl = null; }
    if (costUnitMenuBackdrop) { costUnitMenuBackdrop.remove(); costUnitMenuBackdrop = null; }
  }
  function showCostUnitMenu(anchorEl, opts) {
    const cb = window.__cb;
    opts = opts || {};
    closeCostUnitMenu();

    const backdrop = document.createElement("div");
    backdrop.style.cssText = "position:fixed;inset:0;z-index:9999998;";
    backdrop.addEventListener("mousedown", (e) => { e.stopPropagation(); closeCostUnitMenu(); });

    const menu = document.createElement("div");
    menu.className = "cb-uc-cost-menu";
    menu.addEventListener("mousedown", (e) => e.stopPropagation());

    const current = getCostUnit();
    const mkOption = (unit, label) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className =
        "cb-uc-cost-menu-option" +
        (current === unit ? " cb-uc-cost-menu-option-active" : "");
      // Selection is shown by the green-surface highlight on the active option
      // (see styles/table-view.css), not a checkmark.
      b.textContent = label;
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        setCostUnit(unit);
        closeCostUnitMenu();
        if (cb.tableView?.refresh) cb.tableView.refresh();
      });
      return b;
    };
    menu.appendChild(mkOption("year", "Per year"));
    menu.appendChild(mkOption("record", "Per record"));

    document.body.appendChild(backdrop);
    document.body.appendChild(menu);
    const rect = anchorEl.getBoundingClientRect();
    const width = 180;
    menu.style.position = "fixed";
    menu.style.zIndex = "9999999";
    menu.style.top = (rect.bottom + 6) + "px";
    menu.style.left = Math.max(8, rect.right - width) + "px";
    costUnitMenuEl = menu;
    costUnitMenuBackdrop = backdrop;
  }

  function buildUseCaseScopeControls(ucKey) {
    const cb = window.__cb;
    const scope = cb.useCaseScope?.[ucKey] || {};
    const wrap = document.createElement("span");
    wrap.className = "cb-uc-scope";
    wrap.addEventListener("mousedown", (e) => e.stopPropagation());
    wrap.addEventListener("click", (e) => e.stopPropagation());

    // Records
    const recWrap = document.createElement("span");
    recWrap.className = "cb-uc-scope-field";
    const recLbl = document.createElement("span");
    recLbl.className = "cb-uc-scope-label";
    recLbl.textContent = "Records";
    const recInput = document.createElement("input");
    recInput.type = "text";
    recInput.inputMode = "numeric";
    recInput.className = "cb-uc-scope-records";
    recInput.value = Number(cb.cost.useCaseRecords(ucKey) || 0).toLocaleString();

    // Amber "override" outline when the records differ from the table's as-
    // imported row count — same affordance as the single-table summary Records
    // box (cb-records-override). recordsActual is null when there's no resolvable
    // imported count, in which case we never highlight.
    const recordsActual = cb.cost.useCaseRecordsActual
      ? cb.cost.useCaseRecordsActual(ucKey)
      : null;
    const applyRecOverride = () => {
      if (recordsActual == null) {
        recInput.classList.remove("cb-uc-scope-records-override");
        resetBtn.classList.remove("cb-uc-scope-reset-shown");
        return;
      }
      const cur = parseInt(recInput.value.replace(/[^\d]/g, ""), 10);
      const isOverride = Number.isFinite(cur) && cur !== recordsActual;
      recInput.classList.toggle("cb-uc-scope-records-override", isOverride);
      resetBtn.classList.toggle("cb-uc-scope-reset-shown", isOverride);
    };

    // Reset-to-imported affordance (hidden until overridden). Clears the records
    // override AND any pinned budget so the table falls back to its imported count.
    const resetBtn = document.createElement("button");
    resetBtn.type = "button";
    resetBtn.className = "cb-uc-scope-reset";
    resetBtn.title = "Reset to imported record count";
    resetBtn.setAttribute("aria-label", "Reset to imported record count");
    resetBtn.innerHTML =
      '<svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" ' +
      'stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">' +
      '<polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>';
    resetBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      cb.setUseCaseScope?.(ucKey, { records: null, budget: null });
    });

    const commitRecords = () => {
      const n = parseInt(recInput.value.replace(/[^\d]/g, ""), 10);
      // A manual records edit clears any pinned budget for this use case (Total
      // Cost goes back to derived = perRow × records × frequency).
      if (Number.isFinite(n) && n >= 0) cb.setUseCaseScope?.(ucKey, { records: n, budget: null });
    };
    recInput.addEventListener("keydown", (e) => { if (e.key === "Enter") e.target.blur(); });
    recInput.addEventListener("input", applyRecOverride);
    recInput.addEventListener("blur", commitRecords);
    recInput.addEventListener("focus", () => recInput.select());
    recWrap.appendChild(recLbl);
    recWrap.appendChild(recInput);
    recWrap.appendChild(resetBtn);
    wrap.appendChild(recWrap);
    applyRecOverride();

    // Frequency
    const freqWrap = document.createElement("span");
    freqWrap.className = "cb-uc-scope-field";
    const freqLbl = document.createElement("span");
    freqLbl.className = "cb-uc-scope-label";
    freqLbl.textContent = "Frequency";
    const freqBtn = document.createElement("button");
    freqBtn.type = "button";
    freqBtn.className = "cb-uc-scope-freq";
    const freqId = cb.cost.useCaseFrequencyId(ucKey);
    freqBtn.textContent = cb.getFrequencyLabel ? cb.getFrequencyLabel(freqId) : "Annually";
    // Amber when the frequency differs from the as-imported default (annually) —
    // signals "this knob has been touched", same idea as the records override.
    const defaultFreqId = cb.DEFAULT_FREQUENCY_ID || "annually";
    freqBtn.classList.toggle("cb-uc-scope-freq-override", freqId !== defaultFreqId);
    freqBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      cb.showFrequencyPicker?.(freqBtn, cb.cost.useCaseFrequencyId(ucKey), (picked) => {
        // If a target budget is pinned, hold the dollar figure: change the
        // frequency, then re-derive records from the refreshed per-use-case
        // total so total cost ≈ budget and records absorb the frequency change.
        const budget = cb.useCaseScope?.[ucKey]?.budget;
        cb.setUseCaseScope?.(ucKey, { frequency: picked });
        if (budget > 0) {
          // setUseCaseScope synchronously refreshed cb._multiTotals.
          const fresh = (cb._multiTotals?.perUseCase || []).find((u) => u.key === ucKey);
          const recs = cb.cost.useCaseRecords(ucKey);
          if (fresh && recs > 0) {
            const creditCost = cb.getCreditCost ? cb.getCreditCost() : 0;
            const actionCost = cb.getActionCost ? cb.getActionCost() : 0;
            const dollars = (fresh.credits || 0) * creditCost + (fresh.actions || 0) * actionCost;
            const perRecord = dollars / recs;
            if (perRecord > 0) {
              const newRecords = Math.max(1, Math.round(budget / perRecord));
              cb.setUseCaseScope?.(ucKey, { records: newRecords, budget });
            }
          }
        }
      });
    });
    freqWrap.appendChild(freqLbl);
    freqWrap.appendChild(freqBtn);
    wrap.appendChild(freqWrap);

    // Sub-total for this use case, from the last roll-up — rendered as the same
    // segmented cost pill as the ER details view (StarFour actions first, Coin
    // credits second).
    const sub = (cb._multiTotals?.perUseCase || []).find((u) => u.key === ucKey);
    if (sub) {
      const recs = cb.cost.useCaseRecords(ucKey);
      // "Per year" (annualized totals) vs "Per record" (one row's share for the
      // year). The toggle governs the CREDIT + ACTION cost badges; clicking the
      // label text opens the unit menu.
      const unit = getCostUnit();
      const perRecordView = unit === "record" && recs > 0;
      const unitBtn = document.createElement("button");
      unitBtn.type = "button";
      unitBtn.className = "cb-uc-scope-unit";
      unitBtn.title = "Show credits & actions per year or per record";
      unitBtn.innerHTML =
        `<span>${unit === "record" ? "Per record" : "Per year"}</span>` + chevronDownSvg(11);
      unitBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        showCostUnitMenu(unitBtn, {});
      });
      wrap.appendChild(unitBtn);

      // Credit + action cost badges, in the chosen unit. Per record divides the
      // annual totals by this use case's records.
      const badgeCredits = perRecordView ? (sub.credits || 0) / recs : sub.credits || 0;
      const badgeActions = perRecordView ? (sub.actions || 0) / recs : sub.actions || 0;
      wrap.appendChild(buildCostBadges(badgeCredits, badgeActions, { perRecord: perRecordView }));

      // Dollar pill = this use case's total cost (always the per-year total).
      // Clicking it opens the target-cost editor to back-calculate records.
      const creditCost = cb.getCreditCost ? cb.getCreditCost() : 0;
      const actionCost = cb.getActionCost ? cb.getActionCost() : 0;
      const dollars = (sub.credits || 0) * creditCost + (sub.actions || 0) * actionCost;
      const perRecord = recs > 0 ? dollars / recs : 0;
      const dol = document.createElement("span");
      dol.className = "cb-uc-scope-dollar";
      const budgetPinned = scope.budget > 0;
      if (budgetPinned) dol.classList.add("cb-uc-scope-dollar-pinned");
      dol.innerHTML = dollarSvg(12) + `<span>${Math.round(dollars).toLocaleString()}</span>`;
      // Only interactive when we can derive records (non-zero per-record cost
      // and a working editor).
      if (perRecord > 0 && cb.openTargetCostEditor) {
        dol.classList.add("cb-uc-scope-dollar-editable");
        dol.setAttribute("role", "button");
        dol.tabIndex = 0;
        dol.title = "Set a target cost for this table to back-calculate its records";
        const openEditor = () => {
          cb.openTargetCostEditor({
            anchorEl: dol,
            title: "Edit table cost",
            currentText: "$" + Math.round(dollars).toLocaleString(),
            perRecordDollar: perRecord,
            onApply: (target) => {
              const newRecords = Math.max(1, Math.round(target / perRecord));
              cb.setUseCaseScope?.(ucKey, { records: newRecords, budget: target });
            },
          });
        };
        dol.addEventListener("click", (e) => { e.stopPropagation(); openEditor(); });
        dol.addEventListener("keydown", (e) => {
          if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openEditor(); }
        });
      }
      wrap.appendChild(dol);
    }
    return wrap;
  }

  // Count the data points vs. enrichments a section owns, deep (its whole
  // subtree). Counts each card by its immediate groupId within the section
  // group's subtree, so a use-case (L1) header reflects everything beneath it
  // and a sub-group (L2) header reflects only itself. Folded orphan-ER rows
  // count as enrichments (not data points) — fixing the inflated "data points"
  // tally the old `rows.length` gave. Falls back to the section's own rows for
  // virtual (non-group) sections.
  function sectionCounts(section) {
    const cb = window.__cb;
    const gid = section.canvasGroupId;
    if (gid == null || !cb?.model?.getNodes) {
      let dp = 0;
      let er = 0;
      for (const r of section.rows || []) {
        if (r.kind === "orphan-er") er += r.cardIds?.length || 1;
        else dp += 1;
      }
      return { dp, er };
    }
    const subtree = cb.model.groupSubtreeIds
      ? cb.model.groupSubtreeIds(gid)
      : new Set([gid]);
    let dp = 0;
    let er = 0;
    for (const n of cb.model.getNodes()) {
      const d = n && n.data;
      if (!d || d.type === "comment") continue;
      if (n.groupId == null || !subtree.has(n.groupId)) continue;
      if (d.type === "dp") dp += 1;
      else if (isErType(d.type)) er += 1;
    }
    return { dp, er };
  }

  // The "rows" figure for a use case's (i) tooltip = its source imported
  // table's row count (the tableId's recordCount metadata). Manual use cases
  // (no source table) have no row count → null, so the tooltip omits the line.
  function useCaseRowCount(section) {
    const cb = window.__cb;
    const tid = section && section.tableId;
    if (!tid) return null;
    const meta = (cb.model?.getImportedTables?.() || {})[tid];
    const rc = meta && meta.recordCount;
    return Number.isFinite(Number(rc)) && Number(rc) > 0 ? Number(rc) : null;
  }

  function buildGroupHeaderRow(section, colSpan, isCollapsed, depth = 0, opts = {}) {
    const tr = document.createElement("tr");
    tr.className =
      "cb-table-view-group-row" +
      (isCollapsed ? " cb-table-view-group-row-collapsed" : "") +
      (opts.isTable ? " cb-table-view-table-row" : "");
    tr.setAttribute("data-group-id", String(section.groupId));
    tr.setAttribute("data-row-id", String(section.groupId));
    // Per-table color (Import Clay Table). When set, CSS tints this header
    // and — via the same attribute stamped on the body rows + sub-headers
    // below — the whole table block reads as one color.
    if (opts.color) tr.setAttribute("data-group-color", opts.color);
    // Sub-headers live inside their parent super-group's section so
    // drag-to-reorder is scoped per super-group rather than across
    // top-level groups. Top-level headers stay in the broader "groups"
    // section so they reorder against each other.
    tr.setAttribute(
      "data-row-section",
      depth === 0 ? "groups" : `subgroups:g-${section.parentId}`,
    );
    tr.setAttribute("data-depth", String(depth));
    // `data-group-level` lets CSS pick up the canvas's super-group
    // (level=1) palette without re-encoding the binary in classes.
    tr.setAttribute("data-group-level", String(section.level || 0));
    tr.setAttribute("role", "button");
    tr.setAttribute("aria-expanded", isCollapsed ? "false" : "true");
    tr.tabIndex = 0;
    const td = document.createElement("td");
    td.colSpan = colSpan;
    const wrap = document.createElement("div");
    wrap.className = "cb-table-view-group-row-inner";

    // Group headers are drag-anywhere too: a threshold drag anywhere on the
    // header row reorders the group (only real cb-groups — legacy virtual
    // comment-card sections have no group object to shift). A plain click still
    // toggles collapse (suppressNextRowClick guards the trailing click).
    if (section.canvasGroupId != null) {
      attachRowDrag(tr, "group", section.canvasGroupId);
    }

    const chevron = document.createElement("span");
    chevron.className = "cb-table-view-group-row-chevron";
    chevron.innerHTML = chevronDownSvg(12);
    chevron.setAttribute("aria-hidden", "true");

    const icon = document.createElement("span");
    icon.className = "cb-table-view-group-row-icon";
    // Table sections (Import Clay Table) get a grid/table glyph; everything
    // else keeps the folder. tableSvg falls back to folder if unavailable.
    icon.innerHTML = opts.isTable && typeof tableSvg === "function"
      ? tableSvg(13)
      : folderSvg(13);

    let labelEl;
    // Like DP rows, the label is static text by default and only becomes an
    // input while this section is the active rename target (pendingFocusGroupId,
    // set by the "Rename" context action + new-group creation). The input
    // reverts to static text on Enter / blur. pendingFocusGroupId is a one-shot
    // (cleared in render()'s focus pass), and refresh() skips re-rendering while
    // an input is focused, so the field survives until the user commits.
    const isRenaming = section.editable && pendingFocusGroupId === section.groupId;
    if (isRenaming) {
      // Mirror pattern (same idiom as canvas/groups.js's createGroupLabel):
      // the .cb-table-view-group-row-label-mirror is a hidden span that
      // shadows the input's text and dictates the wrap's width via
      // visibility:hidden + white-space:pre. The input is positioned
      // absolutely on top, sized to fill the wrap. This way long use-case
      // names ("Use case: Detailed enterprise POC scope…") expand the
      // input to fit without truncation, and short names keep the input
      // narrow without lots of empty space.
      const labelWrap = document.createElement("span");
      labelWrap.className = "cb-table-view-group-row-label-wrap";
      const mirror = document.createElement("span");
      mirror.className = "cb-table-view-group-row-label-mirror";
      const labelInput = document.createElement("input");
      labelInput.type = "text";
      labelInput.className = "cb-table-view-group-row-label-input";
      labelInput.value = section.groupName || "";
      labelInput.placeholder = "Group name";
      const PLACEHOLDER = "Group name";
      const syncMirror = () => {
        mirror.textContent = labelInput.value || PLACEHOLDER;
      };
      syncMirror();
      labelInput.addEventListener("mousedown", (evt) => evt.stopPropagation());
      labelInput.addEventListener("click", (evt) => evt.stopPropagation());
      labelInput.addEventListener("input", syncMirror);
      labelInput.addEventListener("keydown", (evt) => {
        if (evt.key === "Enter") {
          evt.preventDefault();
          evt.target.blur();
        } else if (evt.key === "Escape") {
          evt.preventDefault();
          labelInput.value = section.groupName || "";
          syncMirror();
          evt.target.blur();
        }
      });
      labelInput.addEventListener("blur", () => {
        // Real cb-groups write through the canvas label element; legacy
        // comment-cluster sections (no canvas group) write the cluster's
        // title comment; table-import blocks write the imported-table metadata.
        const gid = section.groupId;
        if (section.canvasGroupId != null) {
          commitGroupLabel(section.canvasGroupId, labelInput.value);
        } else if (typeof gid === "string" && gid.startsWith("c-")) {
          commitClusterLabel(gid.slice(2), labelInput.value);
        } else if (typeof gid === "string" && gid.startsWith("t-")) {
          commitTableLabel(gid.slice(2), labelInput.value);
        }
        // Revert the header to static text once editing ends (pendingFocusGroupId
        // is already cleared). Commit paths that route through the canvas don't
        // re-render synchronously, so do it here for all kinds.
        render();
      });
      labelWrap.appendChild(mirror);
      labelWrap.appendChild(labelInput);
      labelEl = labelWrap;
    } else {
      labelEl = document.createElement("span");
      labelEl.className = "cb-table-view-group-row-label";
      const nm = (section.groupName || "").trim();
      if (nm) {
        labelEl.textContent = nm;
      } else {
        // Only real cb-groups can be nameless (freshly created); show a muted
        // placeholder so the row isn't blank when not being renamed.
        labelEl.classList.add("cb-table-view-group-row-label-empty");
        labelEl.textContent = "Untitled group";
      }
      // DOUBLE-click the title to rename inline (quick entry point alongside the
      // right-click "Rename"). Stop the click from reaching the row's collapse
      // toggle — the toggle re-renders, which would swallow the second click;
      // collapse still works via the chevron / the rest of the header row.
      if (section.editable) {
        labelEl.classList.add("cb-table-view-group-row-label-renamable");
        labelEl.addEventListener("click", (evt) => evt.stopPropagation());
        labelEl.addEventListener("dblclick", (evt) => {
          evt.preventDefault();
          evt.stopPropagation();
          startGroupRename(section.groupId);
        });
      }
    }

    const counts = sectionCounts(section);
    const dpCount = counts.dp;

    // Top-level use-case headers (and the legacy imported-table block) carry an
    // (i) info icon whose tooltip lists "N data points / N enrichments / N
    // rows" — the v7.21 affordance. Nested sub-groups keep a plain inline "N
    // data points" count next to the title.
    const isTopLevelUseCase = !!section.isUseCase && depth === 0;
    const showInfoIcon = opts.isTable || isTopLevelUseCase;

    const count = document.createElement("span");
    count.className = "cb-table-view-group-row-count";
    count.textContent = `${dpCount} data point${dpCount === 1 ? "" : "s"}`;

    wrap.appendChild(chevron);
    wrap.appendChild(icon);
    wrap.appendChild(labelEl);
    // Nested / non-use-case headers show the inline data-point count; top-level
    // use cases tuck the counts behind the (i) icon instead (below).
    if (!showInfoIcon) wrap.appendChild(count);

    // (i) info icon — data points / enrichments / rows behind a hover tip.
    if (showInfoIcon) {
      const infoParts = [`${dpCount} data point${dpCount === 1 ? "" : "s"}`];
      if (counts.er > 0) {
        infoParts.push(`${counts.er} enrichment${counts.er === 1 ? "" : "s"}`);
      }
      // "rows" = the use case's source row count; the legacy table block passes
      // it via opts.recordCount, use-case groups derive it from their tableId.
      const rowCount = opts.isTable
        ? Number.isFinite(opts.recordCount)
          ? opts.recordCount
          : null
        : useCaseRowCount(section);
      if (Number.isFinite(rowCount) && rowCount > 0) {
        infoParts.push(`${rowCount.toLocaleString()} row${rowCount === 1 ? "" : "s"}`);
      }
      const info = document.createElement("span");
      info.className = "cb-uc-info";
      info.innerHTML = infoSvg(14);
      info.setAttribute("aria-label", infoParts.join(", "));
      // Custom hover tooltip (native title is unreliable in the overlay).
      attachInfoTip(info, infoParts);
      // Don't let interacting with the icon toggle the section collapse.
      info.addEventListener("click", (e) => e.stopPropagation());
      info.addEventListener("mousedown", (e) => e.stopPropagation());
      wrap.appendChild(info);
    }

    // Per-use-case scope controls (Records + Frequency + cost) on use-case (L1)
    // headers — table-native v7.23+: reads/writes the group via the group-aware
    // cost fns + setUseCaseScope.
    if (section.isUseCase && typeof section.groupId === "string") {
      wrap.appendChild(buildUseCaseScopeControls(section.groupId));
    }

    // Imported-at stamp, pinned to the far right (margin-left:auto via CSS) —
    // legacy imported-table block only.
    if (opts.isTable && Number.isFinite(opts.importedAt) && opts.importedAt > 0) {
      const when = document.createElement("span");
      when.className = "cb-table-view-group-row-meta cb-table-view-group-row-imported";
      when.textContent = `imported ${relativeTimeText(opts.importedAt)}`;
      when.title = new Date(opts.importedAt).toLocaleString();
      wrap.appendChild(when);
    }

    td.appendChild(wrap);
    tr.appendChild(td);

    const toggle = () => {
      if (collapsedGroups.has(section.groupId)) {
        collapsedGroups.delete(section.groupId);
      } else {
        collapsedGroups.add(section.groupId);
      }
      render();
    };

    // Click toggles collapse. Header rows intentionally don't enter the
    // row-selection state — there's no Group / Link action that applies
    // to a section header itself, so highlighting it would be confusing.
    tr.addEventListener("click", (evt) => {
      if (evt.button !== 0) return;
      // Swallow the click that trails a group drag-to-reorder gesture.
      if (suppressNextRowClick) {
        suppressNextRowClick = false;
        return;
      }
      toggle();
    });
    // Right-click on a header opens the context menu. For real cb-groups it
    // offers Rename + Delete (super)group; the group context is passed through
    // so buildContextItems can target this specific section. Suppresses the
    // browser's default menu so the affordance is consistent with row clicks.
    tr.addEventListener("contextmenu", (evt) => {
      evt.preventDefault();
      evt.stopPropagation();
      openContextMenu(evt.clientX, evt.clientY, {
        groupRow: {
          groupId: section.groupId,
          canvasGroupId: section.canvasGroupId,
          level: section.level || 0,
          name: section.groupName,
          isTable: !!opts.isTable,
        },
      });
    });
    // Keyboard parity for accessibility: Enter / Space mirrors the click
    // toggle. preventDefault on Space keeps the page from scrolling.
    // Skipped when focus is in the label input (Enter there commits).
    tr.addEventListener("keydown", (evt) => {
      if (evt.target.tagName === "INPUT") return;
      if (evt.key === "Enter" || evt.key === " ") {
        evt.preventDefault();
        toggle();
      }
    });

    return tr;
  }

  function searchSvg(size) {
    const s = String(size);
    return (
      `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}" viewBox="0 0 24 24" ` +
      'fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" ' +
      'stroke-linejoin="round" aria-hidden="true">' +
      '<circle cx="11" cy="11" r="7"/>' +
      '<line x1="21" y1="21" x2="16.5" y2="16.5"/>' +
      '</svg>'
    );
  }

  // Collapse-all glyph — two chevrons pointing inward (toward a center line).
  function collapseAllSvg(size) {
    const s = String(size);
    return (
      `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}" viewBox="0 0 24 24" ` +
      'fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" ' +
      'stroke-linejoin="round" aria-hidden="true">' +
      '<polyline points="7 5 12 10 17 5"/>' +
      '<polyline points="7 19 12 14 17 19"/>' +
      '</svg>'
    );
  }

  // Expand-all glyph — two chevrons pointing outward (away from center).
  function expandAllSvg(size) {
    const s = String(size);
    return (
      `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}" viewBox="0 0 24 24" ` +
      'fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" ' +
      'stroke-linejoin="round" aria-hidden="true">' +
      '<polyline points="7 10 12 5 17 10"/>' +
      '<polyline points="7 14 12 19 17 14"/>' +
      '</svg>'
    );
  }

  // Filled comment / speech-bubble glyph for the row-note badge.
  function noteSvg(size) {
    const s = String(size);
    return (
      `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}" viewBox="0 0 24 24" ` +
      'fill="currentColor" aria-hidden="true">' +
      '<path d="M4 3h16a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H8l-4 4V5a2 2 0 0 1 2-2z"/>' +
      '</svg>'
    );
  }

  function plusSvg(size) {
    const s = String(size);
    return (
      `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}" viewBox="0 0 24 24" ` +
      'fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" ' +
      'stroke-linejoin="round" aria-hidden="true">' +
      '<line x1="12" y1="5" x2="12" y2="19"/>' +
      '<line x1="5" y1="12" x2="19" y2="12"/>' +
      '</svg>'
    );
  }

  // Padlock glyph. `closed` = locked (shackle down); otherwise an open shackle.
  function lockSvg(closed) {
    const shackle = closed
      ? '<path d="M7 11V7a5 5 0 0 1 10 0v4"/>'
      : '<path d="M7 11V7a5 5 0 0 1 9.5-1.5"/>';
    return (
      '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" ' +
      'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" ' +
      'stroke-linejoin="round" aria-hidden="true">' +
      '<rect x="4" y="11" width="16" height="10" rx="2"/>' + shackle +
      '</svg>'
    );
  }

  function xSvg(size) {
    const s = String(size);
    return (
      `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}" viewBox="0 0 24 24" ` +
      'fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" ' +
      'stroke-linejoin="round" aria-hidden="true">' +
      '<line x1="18" y1="6" x2="6" y2="18"/>' +
      '<line x1="6" y1="6" x2="18" y2="18"/>' +
      '</svg>'
    );
  }

  function targetSvg(size) {
    const s = String(size);
    return (
      `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}" viewBox="0 0 24 24" ` +
      'fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" ' +
      'stroke-linejoin="round" aria-hidden="true">' +
      '<circle cx="12" cy="12" r="9"/>' +
      '<circle cx="12" cy="12" r="4"/>' +
      '</svg>'
    );
  }

  function chevronDownSvg(size) {
    const s = String(size);
    return (
      `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}" viewBox="0 0 24 24" ` +
      'fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" ' +
      'stroke-linejoin="round" aria-hidden="true">' +
      '<polyline points="6 9 12 15 18 9"/>' +
      '</svg>'
    );
  }

  function chevronRightSvg(size) {
    const s = String(size);
    return (
      `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}" viewBox="0 0 24 24" ` +
      'fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" ' +
      'stroke-linejoin="round" aria-hidden="true">' +
      '<polyline points="9 6 15 12 9 18"/>' +
      '</svg>'
    );
  }

  // Stacked-layers glyph — the ER-chip logo for waterfall enrichments,
  // matching the canvas waterfall card icon (cards.js WATERFALL_ICON_SVG)
  // so the "stack of providers" reads the same across views.
  function waterfallSvg(size) {
    const s = String(size);
    return (
      `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}" viewBox="0 0 24 24" ` +
      'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" ' +
      'stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/>' +
      '</svg>'
    );
  }

  function folderSvg(size) {
    const s = String(size);
    return (
      `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}" viewBox="0 0 24 24" ` +
      'fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" ' +
      'stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>' +
      '</svg>'
    );
  }

  function warningSvg(size) {
    const s = String(size);
    return (
      `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}" viewBox="0 0 24 24" ` +
      'fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" ' +
      'stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>' +
      '<line x1="12" y1="9" x2="12" y2="13"/>' +
      '<line x1="12" y1="17" x2="12.01" y2="17"/>' +
      '</svg>'
    );
  }

  // Circle-"i" glyph — the info affordance that holds the per-table counts
  // (data points / enrichments / rows) behind a hover tooltip.
  function infoSvg(size) {
    const s = String(size);
    return (
      `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}" viewBox="0 0 24 24" ` +
      'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" ' +
      'stroke-linejoin="round" aria-hidden="true">' +
      '<circle cx="12" cy="12" r="10"/>' +
      '<line x1="12" y1="16" x2="12" y2="12"/>' +
      '<line x1="12" y1="8" x2="12.01" y2="8"/>' +
      '</svg>'
    );
  }

  // Dollar-sign glyph for the per-use-case cost badge.
  function dollarSvg(size) {
    const s = String(size);
    return (
      `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}" viewBox="0 0 24 24" ` +
      'fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" ' +
      'stroke-linejoin="round" aria-hidden="true">' +
      '<line x1="12" y1="1" x2="12" y2="23"/>' +
      '<path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>' +
      '</svg>'
    );
  }

  // Grid / table glyph — marks the per-table section headers created by the
  // Import Clay Table flow so they read as a whole source table, distinct
  // from the folder icon used by use-case / basic-group sections.
  function tableSvg(size) {
    const s = String(size);
    return (
      `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}" viewBox="0 0 24 24" ` +
      'fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" ' +
      'stroke-linejoin="round" aria-hidden="true">' +
      '<rect x="3" y="3" width="18" height="18" rx="2"/>' +
      '<line x1="3" y1="9" x2="21" y2="9"/>' +
      '<line x1="3" y1="15" x2="21" y2="15"/>' +
      '<line x1="9" y1="3" x2="9" y2="21"/>' +
      '</svg>'
    );
  }

  // Phosphor "StarFour" (duotone) — action-execution glyph, mirroring Clay's
  // ActionExecutionBadge (Badge defaults to duotone weight). The 0.2-opacity
  // fill + solid outline give the two-tone look; color set in CSS.
  function starFourSvg(size) {
    const s = String(size);
    return (
      `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}" viewBox="0 0 256 256" ` +
      'fill="currentColor" aria-hidden="true">' +
      '<path opacity="0.2" d="M226.76,135.48l-66.94,24.34-24.34,66.94a8,8,0,0,1-15,0L96.18,159.82,29.24,135.48a8,8,0,0,1,0-15L96.18,96.18l24.34-66.94a8,8,0,0,1,15,0l24.34,66.94,66.94,24.34A8,8,0,0,1,226.76,135.48Z"/>' +
      '<path d="M229.5,113,166.06,89.94,143,26.5a16,16,0,0,0-30,0L89.94,89.94,26.5,113a16,16,0,0,0,0,30l63.44,23.07L113,229.5a16,16,0,0,0,30,0l23.07-63.44L229.5,143a16,16,0,0,0,0-30ZM157.08,152.3a8,8,0,0,0-4.78,4.78L128,223.9l-24.3-66.82a8,8,0,0,0-4.78-4.78L32.1,128l66.82-24.3a8,8,0,0,0,4.78-4.78L128,32.1l24.3,66.82a8,8,0,0,0,4.78,4.78L223.9,128Z"/></svg>'
    );
  }

  // Phosphor "Coin" (duotone) — single data-credit glyph (used for <= 1 credit),
  // mirroring Clay's CreditPriceBadge. Solid outline (darker rim/top) + lighter
  // 0.2-opacity fill.
  function coinSvg(size) {
    const s = String(size);
    return (
      `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}" viewBox="0 0 256 256" ` +
      'fill="currentColor" aria-hidden="true">' +
      '<path opacity="0.2" d="M232,104c0,24-40,48-104,48S24,128,24,104,64,56,128,56,232,80,232,104Z"/>' +
      '<path d="M207.58,63.84C186.85,53.48,159.33,48,128,48S69.15,53.48,48.42,63.84,16,88.78,16,104v48c0,15.22,11.82,29.85,32.42,40.16S96.67,208,128,208s58.85-5.48,79.58-15.84S240,167.22,240,152V104C240,88.78,228.18,74.15,207.58,63.84ZM128,64c62.64,0,96,23.23,96,40s-33.36,40-96,40-96-23.23-96-40S65.36,64,128,64Zm-8,95.86v32c-19-.62-35-3.42-48-7.49V153.05A203.43,203.43,0,0,0,120,159.86Zm16,0a203.43,203.43,0,0,0,48-6.81v31.31c-13,4.07-29,6.87-48,7.49ZM32,152V133.53a82.88,82.88,0,0,0,16.42,10.63c2.43,1.21,5,2.35,7.58,3.43V178C40.17,170.16,32,160.29,32,152Zm168,26V147.59c2.61-1.08,5.15-2.22,7.58-3.43A82.88,82.88,0,0,0,224,133.53V152C224,160.29,215.83,170.16,200,178Z"/></svg>'
    );
  }

  // Phosphor "Coins" (duotone) — stacked data-credit glyph (used for > 1 credit).
  function coinsSvg(size) {
    const s = String(size);
    return (
      `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}" viewBox="0 0 256 256" ` +
      'fill="currentColor" aria-hidden="true">' +
      '<path opacity="0.2" d="M240,132c0,19.88-35.82,36-80,36-19.6,0-37.56-3.17-51.47-8.44h0C146.76,156.85,176,142,176,124V96.72h0C212.52,100.06,240,114.58,240,132ZM176,84c0-19.88-35.82-36-80-36S16,64.12,16,84s35.82,36,80,36S176,103.88,176,84Z"/>' +
      '<path d="M184,89.57V84c0-25.08-37.83-44-88-44S8,58.92,8,84v40c0,20.89,26.25,37.49,64,42.46V172c0,25.08,37.83,44,88,44s88-18.92,88-44V132C248,111.3,222.58,94.68,184,89.57ZM232,132c0,13.22-30.79,28-72,28-3.73,0-7.43-.13-11.08-.37C170.49,151.77,184,139,184,124V105.74C213.87,110.19,232,122.27,232,132ZM72,150.25V126.46A183.74,183.74,0,0,0,96,128a183.74,183.74,0,0,0,24-1.54v23.79A163,163,0,0,1,96,152,163,163,0,0,1,72,150.25Zm96-40.32V124c0,8.39-12.41,17.4-32,22.87V123.5C148.91,120.37,159.84,115.71,168,109.93ZM96,56c41.21,0,72,14.78,72,28s-30.79,28-72,28S24,97.22,24,84,54.79,56,96,56ZM24,124V109.93c8.16,5.78,19.09,10.44,32,13.57v23.37C36.41,141.4,24,132.39,24,124Zm64,48v-4.17c2.63.1,5.29.17,8,.17,3.88,0,7.67-.13,11.39-.35A121.92,121.92,0,0,0,120,171.41v23.46C100.41,189.4,88,180.39,88,172Zm48,26.25V174.4a179.48,179.48,0,0,0,24,1.6,183.74,183.74,0,0,0,24-1.54v23.79a165.45,165.45,0,0,1-48,0Zm64-3.38V171.5c12.91-3.13,23.84-7.79,32-13.57V172C232,180.39,219.59,189.4,200,194.87Z"/></svg>'
    );
  }

  // Box with an out-arrow — signals "opens another table" for the
  // function-only "Open function" footer action.
  function externalLinkSvg(size) {
    const s = String(size);
    return (
      `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}" viewBox="0 0 24 24" ` +
      'fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" ' +
      'stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>' +
      '<polyline points="15 3 21 3 21 9"/>' +
      '<line x1="10" y1="14" x2="21" y2="3"/>' +
      '</svg>'
    );
  }

  // Three horizontal lines (list / unordered icon) — used for the
  // "Other" virtual section header. Visually distinct from the folder
  // icon used by real cb-group sections so reps see at-a-glance that
  // it's not a real group.
  function listSvg(size) {
    const s = String(size);
    return (
      `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}" viewBox="0 0 24 24" ` +
      'fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" ' +
      'stroke-linejoin="round" aria-hidden="true">' +
      '<line x1="8" y1="6" x2="21" y2="6"/>' +
      '<line x1="8" y1="12" x2="21" y2="12"/>' +
      '<line x1="8" y1="18" x2="21" y2="18"/>' +
      '<line x1="3" y1="6" x2="3.01" y2="6"/>' +
      '<line x1="3" y1="12" x2="3.01" y2="12"/>' +
      '<line x1="3" y1="18" x2="3.01" y2="18"/>' +
      '</svg>'
    );
  }

  // ---- Public API ----

  __cb.tableView = {
    // Close the ER details menu (used by the waterfall "+" hand-off so the menu
    // doesn't sit in front of the enrichment picker).
    closeErMenu() {
      closeErChipMenu();
    },
    // Re-open the ER details menu for a card at a saved viewport position, then
    // open the provider-chain popover beside it. Called by picker.js after the
    // waterfall "+" pick so the user lands back where they were. Returns false
    // when the table isn't mounted or the card is gone.
    reopenErMenuWithProviders(cardId, pos) {
      if (!hostEl) return false;
      const card = __cb.canvas?.getCardById?.(cardId);
      if (!card) return false;
      openErChipMenu(buildErChipData(card), null, pos);
      const btn = erChipMenuEl?.querySelector(".cb-table-view-er-menu-providers");
      if (btn && __cb.showProviderChain) {
        __cb.showProviderChain(card, btn, { besideEl: erChipMenuEl });
      }
      return true;
    },
    // Open the Projected toggle's dropdown ("Copy coverage & fill from Actual").
    // Called by overlay.js's buildViewModeToggle when the Projected button is
    // re-clicked while already in projected mode.
    openProjectedMenu(anchorEl) {
      openProjectedMenu(anchorEl);
    },
    // Picker hand-off (picker.js, orphan branch): place freshly-picked orphan
    // enrichments from an "Insert below → Enrichment" into the target row's
    // section. No-ops otherwise.
    placeInsertedEnrichments(cards) {
      placeInsertedEnrichments(cards);
    },
    mount(host) {
      hostEl = host;
      render();
      // Subscribe to the store: any model change (edit, undo/redo, restore,
      // remote sync) re-renders the table. refresh() self-guards mid-edit/drag.
      if (!modelUnsub && __cb.model && __cb.model.subscribe) {
        modelUnsub = __cb.model.subscribe(() => {
          if (__cb.tableView && __cb.tableView.refresh) __cb.tableView.refresh();
        });
      }
      // Document-level listeners: outside-clicks clear the selection;
      // Esc cancels drag / closes context menu / clears selection. Both
      // are removed on unmount() so they don't leak across mode toggles.
      document.addEventListener("mousedown", onDocClick);
      document.addEventListener("keydown", onDocKeyDown);
    },
    unmount() {
      if (modelUnsub) { modelUnsub(); modelUnsub = null; }
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onDocKeyDown);
      // Clear transient state so a remount starts fresh — selection and
      // drag indicators wouldn't make sense across a tear-down.
      cleanupDrag();
      closeContextMenu();
      closeErChipMenu();
      closeNotePopover();
      hideNotePreview();
      __cb.pricingView?.closeMenus();
      selectedRowIds.clear();
      selectionAnchorId = null;
      visibleRowOrder = [];
      pendingFocusGroupId = null;
      pendingRenameCardId = null;
      searchOpen = false;
      searchQuery = "";
      searchMatchIds = [];
      searchActiveIdx = 0;
      // Reset so a fresh mount pulses the Actual badge on first resolve again.
      lastActualRunsBadgeValue = null;
      if (hostEl) hostEl.innerHTML = "";
      hostEl = null;
      tableEl = null;
    },
    refresh() {
      if (!hostEl) return;
      // Skip the re-render while the user is mid-edit on a cell — re-rendering
      // would steal focus and drop their in-progress input. The blur handler
      // (which fires on commit) will trigger the next refresh via
      // notifyChange → onCanvasStateChange.
      const active = document.activeElement;
      if (active && hostEl.contains(active) && active.tagName === "INPUT") return;
      // Skip during an active drag so the dragged row's DOM doesn't get
      // torn down mid-gesture (which would crash mouseup with no source).
      if (dragInProgress) return;
      // render() rebuilds the table from scratch but captures + restores the
      // scroll position itself, so a background commit (coverage/fill edit,
      // chip-×, row-×, picker-confirm) stays in place instead of snapping the
      // user back to the top.
      render();
      // The details menu lives on document.body (survives the table rebuild) —
      // re-render its contents in place so an edit keeps it open with fresh data
      // instead of tearing it down.
      refreshOpenErMenu();
    },
    isMounted() {
      return !!hostEl;
    },
  };
})();
