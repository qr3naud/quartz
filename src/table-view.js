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

  // Drag-and-drop reorder. dragState is non-null only while the user is
  // actively dragging. dragInProgress also gates refresh() so a canvas
  // change mid-drag doesn't tear down the dragged row's DOM.
  let dragState = null;
  let dragInProgress = false;
  let dragMoveHandler = null;
  let dragUpHandler = null;
  let dropIndicatorEl = null;

  // Context menu — single open instance at a time.
  let contextMenuEl = null;
  let contextMenuBackdrop = null;

  // ER chip details menu — anchored popover opened by clicking an ER pill.
  // Single open instance at a time; lives at document.body level (like the
  // context menu) so it escapes the table's overflow clipping.
  let erChipMenuEl = null;
  let erChipMenuBackdrop = null;

  // After a Group action the new section's label input wants focus so the
  // user types the name immediately. We can't focus it synchronously
  // because render() hasn't run yet (it fires off notifyChange →
  // onCanvasStateChange). Stash the section key here and let the next
  // render pick it up + clear it.
  let pendingFocusGroupId = null;

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

  // Enrichment cards a data point points at via lineage.
  function erCardsForDp(dpCard) {
    const key = dpCard?.data?.sourceEnrichmentFieldId ?? null;
    if (key == null) return [];
    return __cb.model.getNodes().filter(
      (c) => isErType(c.data?.type) && lineageKeyOf(c) === key,
    );
  }

  // Data point cards that point at a given enrichment via lineage.
  function dpCardsForEr(erCard) {
    const key = lineageKeyOf(erCard);
    if (key == null) return [];
    return __cb.model.getNodes().filter(
      (c) => c.data?.type === "dp" && (c.data.sourceEnrichmentFieldId ?? null) === key,
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
  }

  // Click handler factory for row <tr>s. We attach it on the row body and
  // rely on stopPropagation in inputs / chips / buttons (which they already
  // do for editing) so cell-level interactions don't accidentally toggle
  // the row selection.
  function onRowClick(rowId, evt) {
    // Right-click handled separately — bail out so contextmenu doesn't
    // race the click event for the selection state.
    if (evt.button !== 0) return;
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
    if (hostEl.contains(evt.target)) return;
    if (contextMenuEl && contextMenuEl.contains(evt.target)) return;
    clearSelection();
  }

  function onDocKeyDown(evt) {
    if (evt.key !== "Escape") return;
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

  // Sentinel key for the "Unattached enrichments" pseudo-section at the
  // top of the table. Treated like any other group id by collapsedGroups
  // so the rep's expand / collapse choice survives re-renders.
  const ORPHAN_SECTION_KEY = "__orphans__";

  // Sentinel key for the "Other" pseudo-section that wraps un-grouped
  // (flat) DP rows when at least one real cb-group exists. Without the
  // wrapper, ungrouped DPs visually run together with the grouped ones,
  // making it unclear which DPs belong to which use case.
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
  function coverageFillFor(erCard, dpCard) {
    const cb = window.__cb;
    const actual = cb?.viewMode === "actual";
    const totalRows = Number(cb?.getRecordsCount?.()) || Number(cb?.recordsActual) || 0;

    let coverage;
    if (actual) {
      const cov = erCard?.data?.stats?.coverage;
      coverage = cov && Number(cov.total) > 0
        ? { mode: "actual", ran: Number(cov.ran) || 0, total: Number(cov.total) || 0 }
        : { mode: "actual", ran: null, total: null };
    } else {
      const rows = erCard ? (erCard.data.coverageRows ?? totalRows) : totalRows;
      coverage = { mode: "projected", rows, editable: !!erCard, erCardId: erCard ? erCard.id : null };
    }

    let fill = null;
    if (dpCard) {
      if (actual) {
        if (cb?.fullProfilePending?.has?.(dpCard.data.tableId)) {
          fill = { mode: "actual", loading: true };
        } else {
          const np = dpCard.data.stats?.nullPercentage;
          const tot = Number(dpCard.data.stats?.totalRecords) || 0;
          if (np != null && tot > 0) {
            const nonNull = ((100 - Number(np)) / 100) * tot;
            const ran = Number(erCard?.data?.stats?.coverage?.ran) || 0;
            const denom = ran > 0 ? ran : tot;
            fill = { mode: "actual", pct: Math.min(100, Math.max(0, Math.round((nonNull / denom) * 100))) };
          } else {
            fill = { mode: "actual", pct: null };
          }
        }
      } else {
        fill = { mode: "projected", pct: fillRatePct(dpCard.data.fillRate) };
      }
    }
    return { coverage, fill };
  }

  // Writes the projected coverage onto an enrichment card. Coverage lives only
  // on the ER, so this single write syncs every DP row the enrichment returns
  // (and the shared projected cost) on the next refresh.
  function setErCoverage(erCardId, value) {
    const cb = window.__cb;
    const er = (cb.canvas?.getCards?.() || []).find((c) => c.id === erCardId);
    if (!er) return;
    const n = Math.max(0, Math.round(Number(String(value).replace(/[^\d]/g, "")) || 0));
    if (er.data.coverageRows === n && er.data.coverageCustom) return;
    er.data.coverageRows = n;
    er.data.coverageCustom = true;
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
      const input = document.createElement("input");
      input.type = "number";
      input.min = "0";
      input.step = "1";
      input.className = "cb-table-view-cell-input cb-table-view-cell-input-num";
      input.value = coverage.rows != null ? String(coverage.rows) : "";
      input.title = "Rows this enrichment runs on (drives projected cost)";
      input.addEventListener("mousedown", (e) => e.stopPropagation());
      input.addEventListener("click", (e) => e.stopPropagation());
      input.addEventListener("keydown", (e) => { if (e.key === "Enter") e.target.blur(); });
      input.addEventListener("blur", () => setErCoverage(coverage.erCardId, input.value));
      td.appendChild(input);
    } else if (coverage && coverage.mode === "projected") {
      td.className = "col-coverage cb-table-view-cell-readonly";
      td.textContent = coverage.rows ? Number(coverage.rows).toLocaleString() : "\u2014";
    } else if (coverage && coverage.mode === "actual" && coverage.total) {
      td.className = "col-coverage cb-table-view-cell-readonly";
      td.textContent = `${(coverage.ran || 0).toLocaleString()} / ${coverage.total.toLocaleString()}`;
      td.title = `${Math.round(((coverage.ran || 0) / coverage.total) * 100)}% of rows attempted`;
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
      td.className = "col-fill cb-table-view-cell-readonly";
      td.textContent = `${fill.pct}%`;
    } else {
      td.className = "col-fill cb-table-view-cell-muted";
      td.textContent = "\u2014";
    }
    return td;
  }

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

    const dpsByEnrichmentKey = new Map();
    for (const c of allCards) {
      if (c.data.type !== "dp") continue;
      const key = c.data.sourceEnrichmentFieldId ?? null;
      if (key == null || !erByKey.has(key)) {
        // Unmatched data point (manual column, source-derived, or its
        // enrichment isn't in view) -> renders as "Not connected".
        dpInfoMap.set(c.id, { credits: 0, actions: 0, ers: [], enrichmentCount: 0 });
        continue;
      }
      if (!dpsByEnrichmentKey.has(key)) dpsByEnrichmentKey.set(key, []);
      dpsByEnrichmentKey.get(key).push(c);
    }

    for (const [key, dpCards] of dpsByEnrichmentKey) {
      const er = erByKey.get(key);
      claimedErIds.add(er.id);
      const { credits, actions, creditsUnknown } = erPerRowCost(er);
      const perDpCredits = dpCards.length > 0 ? credits / dpCards.length : 0;
      const perDpActions = dpCards.length > 0 ? actions / dpCards.length : 0;
      const erList = [buildErChipData(er)];
      for (const dp of dpCards) {
        dpInfoMap.set(dp.id, {
          credits: perDpCredits,
          actions: perDpActions,
          creditsUnknown,
          ers: erList,
          enrichmentCount: 1,
        });
      }
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
    const supers = realGroups.filter((g) => g.level === 1);
    const inners = realGroups.filter((g) => g.level !== 1);
    const innerToSuperId = new Map();
    const childrenBySuperId = new Map();
    for (const inner of inners) {
      let parentId = null;
      for (const sup of supers) {
        const supSet = new Set(sup.cardIds);
        let allIn = true;
        for (const cid of inner.cardIds) {
          if (!supSet.has(cid)) { allIn = false; break; }
        }
        if (allIn && inner.cardIds.length > 0) {
          parentId = sup.id;
          break;
        }
      }
      innerToSuperId.set(inner.id, parentId);
      if (parentId != null) {
        if (!childrenBySuperId.has(parentId)) childrenBySuperId.set(parentId, []);
        childrenBySuperId.get(parentId).push(inner.id);
      }
    }
    // Indexed inner-group-cards-by-card-id so the DP-bucketing loop
    // below can do an O(1) "which inner group claims this DP?" lookup
    // per DP, instead of an inner-loop over every group.
    const innerByCardId = new Map();
    for (const inner of inners) {
      for (const cid of inner.cardIds) {
        if (!innerByCardId.has(cid)) innerByCardId.set(cid, inner.id);
      }
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
      const erKey = card.data.sourceEnrichmentFieldId ?? null;
      const erCard = erKey != null ? erByKey.get(erKey) : null;
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
      if (card.groupId != null && groupById.has(card.groupId)) {
        const direct = groupById.get(card.groupId);
        if (direct.level === 1) {
          // Super-group: prefer the inner group that claims this card,
          // so the DP renders under the most specific sub-header.
          const innerId = innerByCardId.get(card.id);
          if (innerId != null && innerToSuperId.get(innerId) === direct.id) {
            return {
              key: `g-${innerId}`,
              name: groupNameById.get(innerId) || "",
              level: 0,
              parentId: direct.id,
              canvasGroupId: innerId,
              editable: true,
            };
          }
          // Direct member of a super-group with no inner claim — rare
          // but possible if an outside DP gets stamped with a super's
          // groupId via direct mutation. Render under the super header.
          return {
            key: `g-${direct.id}`,
            name: groupNameById.get(direct.id) || "",
            level: 1,
            parentId: null,
            canvasGroupId: direct.id,
            editable: true,
          };
        }
        // Standalone (non-super) cb-group.
        return {
          key: `g-${direct.id}`,
          name: groupNameById.get(direct.id) || "",
          level: 0,
          parentId: null,
          canvasGroupId: direct.id,
          editable: true,
        };
      }
      const cluster = card.data.groupCluster;
      if (cluster && commentByCluster.has(cluster)) {
        return {
          key: `c-${cluster}`,
          name: commentByCluster.get(cluster),
          level: 0,
          parentId: null,
          canvasGroupId: null,
          editable: false,
        };
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
            const parentSection = ensureSection({
              key: `g-${parentGroup.id}`,
              name: groupNameById.get(parentGroup.id) || "",
              level: 1,
              parentId: null,
              canvasGroupId: parentGroup.id,
              editable: true,
            });
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
      let sectionInfo;
      if (ownerGroup?.level === 1) {
        // Super-group: try to nest under the inner group that claims
        // the cluster's primary ER. Each clusterMap entry represents
        // ONE adjacency cluster; we pick the inner group based on the
        // primary card. In practice all members share an inner group
        // when grouped together.
        const firstRow = clusterMap.values().next().value;
        const primaryCardId = firstRow?.cardId ?? null;
        const innerId = primaryCardId != null ? innerByCardId.get(primaryCardId) : null;
        if (innerId != null && innerToSuperId.get(innerId) === ownerGroup.id) {
          sectionInfo = {
            key: `g-${innerId}`,
            name: groupNameById.get(innerId) || "",
            level: 0,
            parentId: ownerGroup.id,
            canvasGroupId: innerId,
            editable: true,
          };
        } else {
          sectionInfo = {
            key: `g-${ownerGroup.id}`,
            name: groupNameById.get(ownerGroup.id) || "",
            level: 1,
            parentId: null,
            canvasGroupId: ownerGroup.id,
            editable: true,
          };
        }
      } else {
        sectionInfo = {
          key: `g-${groupId}`,
          name: groupNameById.get(groupId) || "",
          level: 0,
          parentId: null,
          canvasGroupId: groupId,
          editable: true,
        };
      }
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
          const parentSection = ensureSection({
            key: `g-${parentGroup.id}`,
            name: groupNameById.get(parentGroup.id) || "",
            level: 1,
            parentId: null,
            canvasGroupId: parentGroup.id,
            editable: true,
          });
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
  //     hasn't resolved yet (fetchSubroutineCostsInBackground still in flight)
  //     so the cell can show a placeholder instead of a misleading 0.
  function erPerRowCost(er) {
    const d = er.data || {};
    const sp = d.stats && d.stats.spend;
    if (window.__cb?.viewMode === "actual" && sp && Number(sp.cellCount) > 0) {
      return {
        credits: (Number(sp.credits) || 0) / Number(sp.cellCount),
        actions: (Number(sp.actionExecutions) || 0) / Number(sp.cellCount),
        creditsUnknown: false,
      };
    }
    const credits = d.usePrivateKey ? 0 : (d.credits != null ? Number(d.credits) : 0);
    const actions = d.actionExecutions != null ? Number(d.actionExecutions) : 0;
    // Only functions get the "loading" placeholder — a normal enrichment with
    // null credits (e.g. an HTTP API that bills only action executions) still
    // reads as 0 credits, which is accurate for it.
    const creditsUnknown =
      d.actionKey === "execute-subroutine" && d.credits == null && !d.usePrivateKey;
    return { credits, actions, creditsUnknown };
  }

  function buildErChipData(er) {
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
      if (sel) model = { name: sel.name, provider: sel.provider, credits: sel.credits };
    }

    // One-word kind label; precedence mirrors the chip color precedence in
    // buildErChipEl (waterfall > function > source > ai > action).
    const kind = isWaterfall
      ? "Waterfall"
      : isFunction
        ? "Formula"
        : isSource
          ? "Source"
          : isAi
            ? "AI"
            : "Action";

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
      // Per-row cost (view-mode-aware) for the details menu.
      cost: erPerRowCost(er),
      usePrivateKey: !!d.usePrivateKey,
      frequencyId,
      frequencyLabel,
      multiplier,
      // Navigation back to the source Clay column ("Open in table"). Present
      // only on imported cards; gates the menu footer action.
      fieldId: d.fieldId || null,
      tableId: d.tableId || null,
      viewId: d.viewId || null,
    };
  }

  // ---- Mutation handlers ----
  //
  // Mirrors the writers in src/export.js — kept duplicated so the table view
  // doesn't have to depend on the export modal's IIFE-private functions.
  // Both code paths converge on canvas.notifyChange() + saveTabs(), so undo
  // history and persistence behave identically.

  function commitDpName(cardId, value) {
    const canvas = __cb.canvas;
    if (!canvas) return;
    const card = canvas.getCardById(cardId);
    if (!card) return;
    const next = (value || "").trim();
    const prev = card.data.text || card.data.displayName || "";
    if (next === prev) return;

    card.data.text = next;
    card.data.displayName = next;

    const textEl = card.el?.querySelector(".cb-dp-text");
    if (textEl) {
      textEl.textContent = next;
      if (next) textEl.removeAttribute("data-placeholder");
      else textEl.setAttribute("data-placeholder", "Type data point\u2026");
    }

    if (canvas.notifyChange) canvas.notifyChange();
    if (__cb.saveTabs) __cb.saveTabs();
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

    if (canvas.notifyChange) canvas.notifyChange();
    if (__cb.saveTabs) __cb.saveTabs();
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
    if (canvas.notifyChange) canvas.notifyChange();
    if (__cb.saveTabs) __cb.saveTabs();
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
    if (targetCardId) __cb.linkTargetCardId = targetCardId;
    __cb.startPickerMode();
  }

  function startAddOrphanEnrichment() {
    if (!__cb.startPickerMode) return;
    // No link target → picker drops cards at enrichmentClickPos (null here)
    // which falls through to canvas-center placement in picker.js.
    __cb.linkTargetCardId = null;
    __cb.enrichmentClickPos = null;
    __cb.startPickerMode();
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
    // The card's own .cb-card-delete button calls removeCard() through the
    // cards.js IIFE. Replicate that by simulating the click — keeps undo /
    // group cleanup / cluster recalc all flowing through the canonical path.
    const del = card.el?.querySelector(".cb-card-delete");
    if (del) del.click();
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
    if (canvas.notifyChange) canvas.notifyChange();
    return card;
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
    const beforeIds = new Set(
      (canvas.getGroups?.() || []).map((g) => g.id),
    );
    canvas.groupCardsByIds(cardIds, "", { skipFocus: true });
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

  function commitGroupLabel(canvasGroupId, value) {
    if (canvasGroupId == null) return;
    const groupEl = document.querySelector(
      `.cb-group[data-group-id="${canvasGroupId}"]`,
    );
    if (!groupEl) return;
    const labelInput = groupEl.querySelector(".cb-group-label");
    if (!labelInput) return;
    if (labelInput.value === value) return;
    labelInput.value = value;
    // Dispatch the same input event the user typing in the canvas would
    // fire, so canvas/groups.js's listener (sync mirror, updateGroupBounds,
    // notifyChange) runs without us replicating its bookkeeping.
    labelInput.dispatchEvent(new Event("input", { bubbles: true }));
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
    if (canvas.notifyChange) canvas.notifyChange();
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
    const groups = __cb.model?.getGroups?.() || [];
    const g = groups.find((gg) => gg.id === canvasGroupId);
    return g ? g.cardIds.slice() : [];
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
    dragInProgress = true;
    dragState = {
      blockKind,
      blockKey,
      cardIds,
      startY: evt.clientY,
      hoverRowId: null,
      dropPosition: null,
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

  function onDragMove(evt) {
    if (!dragState || !hostEl) return;
    const target = evt.target instanceof Element
      ? evt.target.closest("[data-row-id]")
      : null;
    if (!target) {
      hideDropIndicator();
      dragState.hoverRowId = null;
      dragState.dropPosition = null;
      return;
    }
    const hoverRowId = target.getAttribute("data-row-id");
    // Block dropping onto the dragged block itself.
    if (isOwnBlock(hoverRowId)) {
      hideDropIndicator();
      dragState.hoverRowId = null;
      dragState.dropPosition = null;
      return;
    }
    // Restrict to same section (group block of the hover target must
    // match the dragged block's section).
    if (!isSameSection(hoverRowId)) {
      hideDropIndicator();
      dragState.hoverRowId = null;
      dragState.dropPosition = null;
      return;
    }
    const rect = target.getBoundingClientRect();
    const above = evt.clientY < rect.top + rect.height / 2;
    dragState.hoverRowId = hoverRowId;
    dragState.dropPosition = above ? "above" : "below";
    showDropIndicator(target, above);
  }

  function onDragUp() {
    if (!dragState) {
      cleanupDrag();
      return;
    }
    const { hoverRowId, dropPosition } = dragState;
    // Lower the dragInProgress gate BEFORE performDrop runs. performDrop
    // mutates card.y values and calls canvas.notifyChange, which fires
    // onCanvasStateChange → tableView.refresh synchronously. The refresh
    // short-circuits when `dragInProgress` is true (so the dragged row's
    // DOM doesn't get torn down mid-gesture). If we don't release the
    // gate here, the post-drop refresh is suppressed and the table view
    // keeps showing the pre-drop row order even though the underlying
    // card.y values reflect the new arrangement. cleanupDrag below
    // re-sets it to false (idempotent) and clears the rest of the
    // transient drag state.
    dragInProgress = false;
    if (hoverRowId && dropPosition) {
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
  // Why we don't reflow card.y any more: under the legacy approach
  // (`shiftBlockY` + sequential zero-gap restacking) the new geometry
  // could land previously independent clusters snap-adjacent. The
  // follow-up `refreshClusters` would then promote them into a single
  // cluster id ("swap two orphan DPs → they get linked"). Even with
  // promotion now scoped to user drags in canvas/index.js's
  // `syncClusterModelFromSnap`, keeping table-view reorders geometry-
  // free guarantees the canvas stays bit-for-bit unchanged.
  function performDrop(hoverRowId, dropPosition) {
    const canvas = __cb.canvas;
    if (!canvas) return;
    const sectionBlocks = collectSectionBlocks(hoverRowId);
    if (sectionBlocks.length < 2) return;
    const draggedKey = dragState.blockKind === "group"
      ? `group:${dragState.blockKey}`
      : `row:${dragState.cardIds[0]}`;
    const draggedIdx = sectionBlocks.findIndex((b) => b.key === draggedKey);
    if (draggedIdx === -1) return;
    const [moved] = sectionBlocks.splice(draggedIdx, 1);
    // hoverRowId is string-form; b.cardIds are numeric. Normalize before
    // findIndex or it never matches.
    const hoverCardId = parseCardIdFromRowId(hoverRowId);
    let targetIdx = sectionBlocks.findIndex((b) =>
      (hoverCardId != null && b.cardIds.includes(hoverCardId)) ||
      b.key === `group:${hoverRowId.startsWith("g-") ? hoverRowId.slice(2) : hoverRowId}`,
    );
    if (targetIdx === -1) {
      // Couldn't resolve target — bail without mutating.
      sectionBlocks.splice(draggedIdx, 0, moved);
      return;
    }
    if (dropPosition === "below") targetIdx += 1;
    sectionBlocks.splice(targetIdx, 0, moved);

    // Sequentially reassign tableOrder over EVERY block in the section,
    // not just the dragged one. This "captures" any newly added /
    // unordered blocks at their effective sort position, so future
    // drops see a fully ordered section. Every card in a block gets
    // the same tableOrder so clusters stay grouped in the table view
    // (matches the canvas's "linked cards share Y" invariant).
    let order = 0;
    for (const block of sectionBlocks) {
      for (const id of block.cardIds) {
        const c = canvas.getCardById?.(id);
        if (c) c.tableOrder = order;
      }
      order += 1;
    }
    // No geometry change → no refreshClusters needed (snap-derive has
    // nothing new to discover). Just persist + re-render.
    if (canvas.notifyChange) canvas.notifyChange();
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
      // Groups section: each block is one cb-group.
      for (const g of __cb.model?.getGroups?.() || []) {
        const cardIds = g.cardIds.slice();
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
  // The menu always opens on right-click — even with a single row selected
  // — and gates Group / Link as `enabled: false` with a hint label when
  // the selection isn't sufficient. Earlier behavior was to silently
  // bail when fewer than 2 DPs were selected, which made the right-click
  // feel completely broken (single-row right-clicks were the common case).

  function openContextMenu(x, y) {
    closeContextMenu();
    const cardIds = getCardRowsInSelection();
    const enough = cardIds.length >= 2;
    // Adaptive label so the menu reads naturally for each selection
    // shape (DPs, ERs, or a mix). `noun` flips between "data points",
    // "enrichments", and "rows" depending on what's actually selected.
    let noun = "rows";
    if (enough) {
      const types = new Set(
        cardIds.map((id) => {
          const card = getCardForRowId(id);
          return card?.data?.type === "dp" ? "dp" : "er";
        }),
      );
      if (types.size === 1 && types.has("dp")) noun = "data points";
      else if (types.size === 1 && types.has("er")) noun = "enrichments";
    }
    const items = [
      {
        id: "group",
        label: enough ? `Group ${cardIds.length} ${noun}` : "Group selected",
        hint: enough ? null : "Shift+click another row to enable",
        enabled: enough,
        action: () => groupSelected(),
      },
      {
        id: "link",
        label: enough
          ? `Link ${cardIds.length} ${noun} (share cluster)`
          : "Link selected",
        hint: enough ? null : "Shift+click another row to enable",
        enabled: enough,
        action: () => linkSelected(),
      },
    ];

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
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className =
        "cb-table-view-context-menu-option" +
        (item.enabled ? "" : " cb-table-view-context-menu-option-disabled");
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
      if (item.enabled) {
        btn.addEventListener("click", () => {
          closeContextMenu();
          item.action();
        });
      } else {
        btn.disabled = true;
        btn.setAttribute("aria-disabled", "true");
      }
      contextMenuEl.appendChild(btn);
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
    openContextMenu(evt.clientX, evt.clientY);
  }

  // ---- Rendering ----

  function render() {
    if (!hostEl) return;
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

    const introActions = document.createElement("div");
    introActions.className = "cb-table-view-intro-actions";

    // Projected / Actual cost toggle leads the action row (furthest left). It
    // used to live in the overlay topbar; it sits here now because the
    // Projected/Actual columns it switches are part of this table. Built via
    // the overlay helper so the toggle logic stays in one place; rebuilt on
    // every render (setViewMode reflects the active half by query, not ref).
    if (typeof __cb.buildViewModeToggle === "function") {
      const viewToggle = __cb.buildViewModeToggle();
      viewToggle.classList.add("cb-table-view-mode-toggle");
      introActions.appendChild(viewToggle);
    }

    // "Upload POC" sits to the LEFT of "Add enrichment" so the rep's eye
    // lands on the import option first when they're starting fresh — POC
    // import is the bulk-action shortcut, "Add enrichment" is the granular
    // follow-up. uploadSvg is a stylized cloud-upload icon distinct from
    // the plus glyph used for additive actions.
    const uploadPocBtn = document.createElement("button");
    uploadPocBtn.type = "button";
    uploadPocBtn.className = "cb-table-view-add-er-btn cb-table-view-upload-poc-btn";
    uploadPocBtn.title = "Import data points from a POC overview document";
    uploadPocBtn.innerHTML = uploadSvg(13) + "<span>Upload POC</span>";
    uploadPocBtn.addEventListener("click", () => {
      if (typeof __cb.startPocImport === "function") {
        __cb.startPocImport(uploadPocBtn);
      } else {
        console.error("[Clay Scoping] POC import module not loaded.");
      }
    });
    introActions.appendChild(uploadPocBtn);

    // "Scope Ads" / "Scope Audiences" sit between the POC import and the
    // granular "Add enrichment" action as scoping quick-starts.
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

    const addOrphanErBtn = document.createElement("button");
    addOrphanErBtn.type = "button";
    addOrphanErBtn.className = "cb-table-view-add-er-btn";
    addOrphanErBtn.title = "Add an enrichment without attaching it to a data point";
    addOrphanErBtn.innerHTML = plusSvg(12) + "<span>Add enrichment</span>";
    addOrphanErBtn.addEventListener("click", () => startAddOrphanEnrichment());
    introActions.appendChild(addOrphanErBtn);
    intro.appendChild(introActions);

    wrap.appendChild(intro);

    const tableContainer = document.createElement("div");
    tableContainer.className = "cb-table-view-table-container";

    const { orphanErRows, groupSections, dpRows, tableGroups } = buildRows();

    const table = document.createElement("table");
    table.className = "cb-table-view-table";
    tableEl = table;

    const thead = document.createElement("thead");
    const headRow = document.createElement("tr");
    // Leftmost "drag" column carries the gripper handle on every body row.
    // Empty header label so the column reads as control affordance, not data.
    const headers = [
      { label: "", cls: "col-drag" },
      { label: "Data point", cls: "col-dp" },
      { label: "Coverage", cls: "col-coverage" },
      { label: "Fill rate (%)", cls: "col-fill" },
      { label: "Credits / row", cls: "col-credits" },
      { label: "Actions / row", cls: "col-actions" },
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

    if (orphanErRows.length === 0 && totalDpCount === 0) {
      const empty = document.createElement("tr");
      empty.className = "cb-table-view-empty-row";
      const td = document.createElement("td");
      td.colSpan = headers.length;
      td.textContent =
        "No data points yet. Click \u201cUpload POC\u201d to import from a doc, \u201c+ Add data point\u201d below, or \u201cAdd enrichment\u201d above to get started.";
      empty.appendChild(td);
      tbody.appendChild(empty);
    } else {
      // ---- Imported tables (Import Clay Table) ----
      // Each imported table renders as its own top-level colored block at the
      // very top: a table header, the table's loose DP / orphan-ER rows, then
      // its basic-group sub-sections (depth 1). Every row + sub-header carries
      // the table's data-group-color so the block reads as one color.
      for (const tg of (tableGroups || [])) {
        const color = tg.importColor || null;
        // Stamp the table color on a freshly-built row and append it.
        const appendColored = (rowEl, rowId) => {
          if (color) rowEl.setAttribute("data-group-color", color);
          tbody.appendChild(rowEl);
          if (rowId != null) visibleRowOrder.push(String(rowId));
        };
        const emitColoredRows = (rows, sectionTag) => {
          annotateMergeRuns(rows.filter((r) => r.kind === "dp"));
          for (const row of rows) {
            const rowEl = row.kind === "orphan-er"
              ? buildOrphanDpStyleRow(row, sectionTag)
              : buildDpRow(row, sectionTag);
            appendColored(rowEl, row.cardId);
          }
        };

        const tableSection = {
          groupId: tg.key,
          groupName: tg.tableName,
          editable: false,
          canvasGroupId: null,
          level: 1,
          parentId: null,
          rows: tg.rows,
          totalRowCount: tg.totalRowCount,
        };
        const tableCollapsed = collapsedGroups.has(tg.key);
        const header = buildGroupHeaderRow(tableSection, headers.length, tableCollapsed, 0, {
          color,
          isTable: true,
          recordCount: tg.recordCount,
          importedAt: tg.importedAt,
        });
        tbody.appendChild(header);
        visibleRowOrder.push(tg.key);
        if (tableCollapsed) continue;

        // Direct rows (inputs, merge DPs, waterfalls, standalone ERs).
        emitColoredRows(tg.rows, `table:${tg.key}`);

        // Basic-group sub-sections, indented at depth 1, same color.
        for (const sub of tg.sections) {
          const subCollapsed = collapsedGroups.has(sub.groupId);
          const subHeader = buildGroupHeaderRow(sub, headers.length, subCollapsed, 1, { color });
          tbody.appendChild(subHeader);
          visibleRowOrder.push(sub.groupId);
          if (subCollapsed) continue;
          emitColoredRows(sub.rows, `section:${sub.groupId}`);
        }
      }

      // Unattached enrichments live under their own yellow header section
      // at the top — visually parallel to the purple Use Case / group
      // sections below. Each row inside looks like a regular DP row, with
      // an editable name input that, when committed, creates a new DP
      // adjacent to the ER (forming a snap-cluster) so the row promotes
      // itself to a connected DP row on the next render.
      if (orphanErRows.length > 0) {
        const orphansCollapsed = collapsedGroups.has(ORPHAN_SECTION_KEY);
        tbody.appendChild(buildOrphanGroupHeaderRow(orphanErRows, headers.length, orphansCollapsed));
        if (!orphansCollapsed) {
          for (const row of orphanErRows) {
            tbody.appendChild(buildOrphanDpStyleRow(row, "orphan"));
            visibleRowOrder.push(String(row.cardId));
          }
        }
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
          if (childCollapsed) continue;
          emitSectionRows(child, `section:${child.groupId}`);
        }
      }
      // "Other" wrapper around the flat DP rows. Only shown when there's
      // at least one real cb-group section above — without that, flat
      // rows are the only DPs and don't need a header. With groups, the
      // wrapper makes it visually clear which DPs are ungrouped vs.
      // belonging to a use case.
      const showOtherHeader = groupSections.length > 0 && dpRows.length > 0;
      const otherCollapsed =
        showOtherHeader && collapsedGroups.has(OTHER_SECTION_KEY);
      if (showOtherHeader) {
        tbody.appendChild(
          buildOtherHeaderRow(dpRows.length, headers.length, otherCollapsed),
        );
        visibleRowOrder.push(OTHER_SECTION_KEY);
      }
      if (!otherCollapsed) {
        annotateMergeRuns(dpRows);
        for (const row of dpRows) {
          tbody.appendChild(buildDpRow(row, "flat"));
          visibleRowOrder.push(String(row.cardId));
        }
      }
    }

    tbody.appendChild(buildAddDpRow(headers.length));

    table.appendChild(tbody);
    tableContainer.appendChild(table);
    wrap.appendChild(tableContainer);

    hostEl.appendChild(wrap);

    // Re-apply selection highlight and consume any pending focus request
    // (Group action stashes the new section's key here; we focus the
    // matching label input now that it's in the DOM).
    applySelectionClasses();
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

  // Yellow group-header row that sits above the unattached-enrichments
  // section. Reuses the .cb-table-view-group-row scaffolding (chevron +
  // icon + label + count + collapse toggle) so the orphan section
  // collapses the same way Use Case sections do; the yellow palette is
  // applied via .cb-table-view-orphan-group-row. Not draggable — orphan
  // section position is fixed at the top.
  function buildOrphanGroupHeaderRow(orphanErRows, colSpan, isCollapsed) {
    const tr = document.createElement("tr");
    tr.className =
      "cb-table-view-group-row cb-table-view-orphan-group-row" +
      (isCollapsed ? " cb-table-view-group-row-collapsed" : "");
    tr.setAttribute("data-group-id", ORPHAN_SECTION_KEY);
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
    icon.innerHTML = warningSvg(13);

    const label = document.createElement("span");
    label.className = "cb-table-view-group-row-label";
    label.textContent = "Unattached enrichments";

    const count = document.createElement("span");
    count.className = "cb-table-view-group-row-count";
    const n = orphanErRows.length;
    count.textContent = `${n} enrichment${n === 1 ? "" : "s"}`;

    wrap.appendChild(chevron);
    wrap.appendChild(icon);
    wrap.appendChild(label);
    wrap.appendChild(count);
    td.appendChild(wrap);
    tr.appendChild(td);

    const toggle = () => {
      if (collapsedGroups.has(ORPHAN_SECTION_KEY)) {
        collapsedGroups.delete(ORPHAN_SECTION_KEY);
      } else {
        collapsedGroups.add(ORPHAN_SECTION_KEY);
      }
      render();
    };
    tr.addEventListener("click", toggle);
    tr.addEventListener("keydown", (evt) => {
      if (evt.key === "Enter" || evt.key === " ") {
        evt.preventDefault();
        toggle();
      }
    });

    return tr;
  }

  // "Other" header — wraps the flat (un-grouped) DP rows when at least
  // one real cb-group exists. Same collapse mechanics as the orphan
  // section (sentinel key in collapsedGroups). No drag handle, no
  // editable label — it's a virtual section, not a real cb-group.
  function buildOtherHeaderRow(dpCount, colSpan, isCollapsed) {
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

    const count = document.createElement("span");
    count.className = "cb-table-view-group-row-count";
    count.textContent = `${dpCount} data point${dpCount === 1 ? "" : "s"}`;

    wrap.appendChild(chevron);
    wrap.appendChild(icon);
    wrap.appendChild(label);
    wrap.appendChild(count);
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

  // Build a drag-handle <td> for the leftmost column. Mousedown initiates
  // a drag of `blockKind` (`row` for an orphan/DP row, `group` for a
  // group header) keyed by `blockKey`. Visual: a 6-dot gripper icon that
  // shows on row hover (CSS controls visibility).
  function buildDragHandleCell(blockKind, blockKey) {
    const td = document.createElement("td");
    td.className = "col-drag";
    const handle = document.createElement("span");
    handle.className = "cb-table-view-drag-handle";
    handle.title = "Drag to reorder";
    handle.setAttribute("aria-hidden", "true");
    handle.innerHTML = gripperSvg(12);
    handle.addEventListener("mousedown", (evt) => {
      // Stop propagation so the row click handler doesn't toggle selection
      // when the user starts a drag.
      evt.stopPropagation();
      startBlockDrag(blockKind, blockKey, evt);
    });
    td.appendChild(handle);
    return td;
  }

  // Wires generic row interaction handlers (selection click, right-click
  // context menu) onto a <tr>. Caller is responsible for adding the
  // data-row-id and data-row-section attributes before calling.
  function attachRowInteractionHandlers(tr, rowId) {
    tr.addEventListener("click", (evt) => onRowClick(rowId, evt));
    tr.addEventListener("contextmenu", (evt) => onRowContextMenu(rowId, evt));
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
    tr.className = "cb-table-view-dp-row cb-table-view-orphan-dp-row";
    tr.setAttribute("data-card-id", String(primaryCardId));
    tr.setAttribute("data-row-id", String(primaryCardId));
    tr.setAttribute("data-row-section", sectionId || "orphan");
    attachRowInteractionHandlers(tr, String(primaryCardId));

    tr.appendChild(buildDragHandleCell("row", String(primaryCardId)));

    const dpCell = document.createElement("td");
    dpCell.className = "col-dp";
    const dpInput = document.createElement("input");
    dpInput.type = "text";
    dpInput.className = "cb-table-view-cell-input cb-table-view-cell-input-text";
    dpInput.placeholder = "Add data point name\u2026";
    let committed = false;
    dpInput.addEventListener("keydown", (evt) => {
      if (evt.key === "Enter") {
        evt.preventDefault();
        evt.target.blur();
      }
    });
    dpInput.addEventListener("blur", () => {
      if (committed) return;
      const text = dpInput.value.trim();
      if (text.length === 0) return;
      committed = true;
      attachDpToOrphanCluster(cardIds, text);
    });
    dpCell.appendChild(dpInput);
    tr.appendChild(dpCell);

    // Coverage = the ER's own coverage (editable in projected, run attempts in
    // actual). Fill stays muted — there's no data point on this row yet.
    tr.appendChild(buildCoverageCell(row.coverageFill?.coverage));
    tr.appendChild(buildFillCell(null, row.cardId));

    const creditsCell = document.createElement("td");
    creditsCell.className = "col-credits cb-table-view-cell-readonly";
    if (row.creditsUnknown) {
      creditsCell.textContent = "\u2014";
      creditsCell.title = "Function cost is loading\u2026 switch to Actual for real spend";
    } else {
      creditsCell.textContent = formatNumber(row.credits);
    }
    tr.appendChild(creditsCell);

    const actionsCell = document.createElement("td");
    actionsCell.className = "col-actions cb-table-view-cell-readonly";
    actionsCell.textContent = formatNumber(row.actions);
    tr.appendChild(actionsCell);

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

    // Lineage link (Phase 2.c). The table view matches DP -> ER by
    // `sourceEnrichmentFieldId`, NOT by cluster, so a cluster-only attach
    // would leave the freshly-named DP as a separate "Not connected" row.
    // Stamp the new DP's lineage to the anchor ER's key via the canvas's
    // shared writer (synthesizes a stable local key for picker-authored ERs).
    const erKey = __cb.canvas?.ensureErLineageKey?.(anchor) ?? null;
    if (erKey != null) newDp.data.sourceEnrichmentFieldId = erKey;

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
    if (canvas.notifyChange) canvas.notifyChange();
    if (__cb.saveTabs) __cb.saveTabs();
  }

  function buildDpRow(row, sectionId) {
    const tr = document.createElement("tr");
    const mergeMode = row.mergeMode || "single";
    const mergeSpan = row.mergeSpan || 1;
    const classes = ["cb-table-view-dp-row"];
    if (!row.connected) classes.push("cb-table-view-dp-row-unconnected");
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

    tr.appendChild(buildDragHandleCell("row", String(row.cardId)));

    const dpCell = document.createElement("td");
    dpCell.className = "col-dp";
    const dpInput = document.createElement("input");
    dpInput.type = "text";
    dpInput.className = "cb-table-view-cell-input cb-table-view-cell-input-text";
    dpInput.value = row.name;
    dpInput.placeholder = "Type data point\u2026";
    // Stop propagation on the input itself so clicking-to-edit doesn't
    // also toggle row selection. Same trick the existing chip x button uses.
    dpInput.addEventListener("mousedown", (evt) => evt.stopPropagation());
    dpInput.addEventListener("click", (evt) => evt.stopPropagation());
    dpInput.addEventListener("keydown", (evt) => {
      if (evt.key === "Enter") evt.target.blur();
    });
    dpInput.addEventListener("blur", () => commitDpName(row.cardId, dpInput.value));
    dpCell.appendChild(dpInput);
    tr.appendChild(dpCell);

    // Coverage (per enrichment): projected = editable rows (default total rows,
    // drives cost); actual = real run attempts / total. Editing it from any one
    // DP row writes the ER once, syncing every DP it returns.
    tr.appendChild(buildCoverageCell(row.coverageFill?.coverage));

    // Fill rate (per DP): projected = editable %; actual = nonNull / ER coverage
    // (read-only), spinner while the full profile loads.
    tr.appendChild(buildFillCell(row.coverageFill?.fill, row.cardId));

    // Credits / actions / ERs collapse into the "first" row of a merge
    // run via rowspan. Followers ("skip") emit no <td> for these columns
    // — the host's rowspan covers them.
    if (mergeMode !== "skip") {
      const creditsCell = document.createElement("td");
      creditsCell.className = "col-credits cb-table-view-cell-readonly";
      if (mergeSpan > 1) creditsCell.rowSpan = mergeSpan;
      if (row.creditsUnknown) {
        creditsCell.textContent = "\u2014";
        creditsCell.title = "Function cost is loading\u2026 switch to Actual for real spend";
      } else {
        creditsCell.textContent = formatNumber(row.credits);
      }
      tr.appendChild(creditsCell);

      const actionsCell = document.createElement("td");
      actionsCell.className = "col-actions cb-table-view-cell-readonly";
      if (mergeSpan > 1) actionsCell.rowSpan = mergeSpan;
      actionsCell.textContent = formatNumber(row.actions);
      tr.appendChild(actionsCell);

      const ersCell = document.createElement("td");
      ersCell.className = "col-ers" + (mergeSpan > 1 ? " cb-table-view-cell-merged" : "");
      if (mergeSpan > 1) ersCell.rowSpan = mergeSpan;
      const chipsWrap = document.createElement("div");
      chipsWrap.className = "cb-table-view-er-chips";
      for (const er of row.ers) {
        chipsWrap.appendChild(buildErChipEl(er, /* removable */ true));
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

  function buildErChipEl(er, removable) {
    const chip = document.createElement("span");
    // One color per enrichment kind (precedence: waterfall > function > source
    // > normal ER). CSS defines the palette.
    const typeClass = er.isWaterfall
      ? " cb-table-view-er-chip-waterfall"
      : er.isFunction
        ? " cb-table-view-er-chip-function"
        : er.isSource
          ? " cb-table-view-er-chip-source"
          : "";
    chip.className = "cb-table-view-er-chip" + typeClass;
    chip.title =
      er.isWaterfall && er.providerChain
        ? `${er.name} \u2014 ${er.providerChain}`
        : er.name;

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

    // Per-ER frequency badge — same "×N" affordance as the canvas
    // freqBadge (cards.js ~line 822). Clicking opens the shared
    // frequency picker; the pick routes through commitFrequency →
    // applyClusterFrequency so the rest of the cluster's ERs stay in
    // sync, mirroring canvas behavior. mousedown stopPropagation
    // keeps the click from triggering row selection / row drag.
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

    if (removable) {
      const x = document.createElement("button");
      x.type = "button";
      x.className = "cb-table-view-er-chip-remove";
      x.title = "Remove this enrichment from the canvas";
      x.setAttribute("aria-label", "Remove enrichment");
      x.innerHTML = xSvg(10);
      x.addEventListener("click", (evt) => {
        evt.stopPropagation();
        removeCardById(er.id);
      });
      chip.appendChild(x);
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
  // AI model (when applicable), and offers "Open in table" — the same
  // navigation the canvas right-click menu uses (__cb.openCardInTable),
  // gated on the card carrying fieldId + tableId. Built on click (not per
  // chip) so a large import only pays for the logo per pill.

  function closeErChipMenu() {
    if (erChipMenuEl) { erChipMenuEl.remove(); erChipMenuEl = null; }
    if (erChipMenuBackdrop) { erChipMenuBackdrop.remove(); erChipMenuBackdrop = null; }
    document.removeEventListener("keydown", onErChipMenuKey);
  }

  function onErChipMenuKey(evt) {
    if (evt.key === "Escape") closeErChipMenu();
  }

  function erMenuRow(labelText, valueText) {
    const row = document.createElement("div");
    row.className = "cb-table-view-er-menu-row";
    const l = document.createElement("span");
    l.className = "cb-table-view-er-menu-row-label";
    l.textContent = labelText;
    const v = document.createElement("span");
    v.className = "cb-table-view-er-menu-row-value";
    v.textContent = valueText;
    row.appendChild(l);
    row.appendChild(v);
    return row;
  }

  // One-line "what this is" summary, composed from available fields (there's
  // no rich description on the catalog entry).
  function erMenuSummaryText(er) {
    if (er.isWaterfall) {
      return er.providerChain ? `Waterfall: ${er.providerChain}` : "Waterfall enrichment";
    }
    if (er.isFunction) return "Run function (formula)";
    if (er.isAi) {
      const prov = er.model?.provider;
      return prov ? `AI column \u00b7 ${prov}` : "AI column";
    }
    if (er.isSource) return er.packageName ? `Source \u00b7 ${er.packageName}` : "Source enrichment";
    return er.packageName ? `Action \u00b7 ${er.packageName}` : "Enrichment";
  }

  function erMenuCostText(er) {
    if (er.usePrivateKey) return "Private key (0 credits / row)";
    const c = er.cost || {};
    if (c.creditsUnknown) return "Calculating\u2026";
    const credits = Number(c.credits) || 0;
    const actions = Number(c.actions) || 0;
    const creditPart = `${formatNumber(credits)} credit${credits === 1 ? "" : "s"} / row`;
    if (actions > 0) {
      return `${creditPart} \u00b7 ${formatNumber(actions)} action${actions === 1 ? "" : "s"} / row`;
    }
    return creditPart;
  }

  // Annualized per-row cost — only meaningful when the enrichment runs more
  // than once a year (multiplier > 1), otherwise it equals the per-row cost.
  function erMenuAnnualText(er) {
    if (er.usePrivateKey) return null;
    const c = er.cost || {};
    if (c.creditsUnknown) return null;
    const mult = er.multiplier ?? 1;
    if (mult <= 1) return null;
    const perYear = (Number(c.credits) || 0) * mult;
    return `${formatNumber(perYear)} credits / row`;
  }

  function openErChipMenu(er, anchorEl) {
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

    // Summary line.
    const summaryText = erMenuSummaryText(er);
    if (summaryText) {
      const summary = document.createElement("div");
      summary.className = "cb-table-view-er-menu-summary";
      summary.textContent = summaryText;
      menu.appendChild(summary);
    }

    // Cost + frequency section.
    const costSection = document.createElement("div");
    costSection.className = "cb-table-view-er-menu-section";
    costSection.appendChild(erMenuRow("Cost", erMenuCostText(er)));
    costSection.appendChild(
      erMenuRow("Frequency", `${er.frequencyLabel} (\u00d7${er.multiplier ?? 1})`),
    );
    const annual = erMenuAnnualText(er);
    if (annual) costSection.appendChild(erMenuRow("Per year", annual));
    menu.appendChild(costSection);

    // Model section — AI columns only.
    if (er.isAi && er.model) {
      const modelSection = document.createElement("div");
      modelSection.className = "cb-table-view-er-menu-section";
      const modelVal = er.model.provider
        ? `${er.model.name} \u00b7 ${er.model.provider}`
        : er.model.name;
      modelSection.appendChild(erMenuRow("Model", modelVal));
      if (er.model.credits != null) {
        modelSection.appendChild(
          erMenuRow("Model cost", `${formatNumber(Number(er.model.credits))} credits / row`),
        );
      }
      menu.appendChild(modelSection);
    }

    // Footer: Open in table (reuses the canvas navigation). Disabled when the
    // card wasn't imported from a Clay table (no fieldId / tableId).
    const canOpen = !!(er.fieldId && er.tableId);
    const footer = document.createElement("div");
    footer.className = "cb-table-view-er-menu-footer";
    const openBtn = document.createElement("button");
    openBtn.type = "button";
    openBtn.className =
      "cb-table-view-er-menu-open" + (canOpen ? "" : " cb-table-view-er-menu-open-disabled");
    openBtn.innerHTML = tableSvg(13) + "<span>Open in table</span>";
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
    menu.appendChild(footer);

    document.body.appendChild(erChipMenuBackdrop);
    document.body.appendChild(menu);
    erChipMenuEl = menu;

    // Position below the chip, left-aligned, clamped to the viewport. Flip
    // above the chip when it would overflow the bottom edge.
    const rect = anchorEl.getBoundingClientRect();
    menu.style.position = "fixed";
    menu.style.zIndex = "9999999";
    menu.style.left = "0px";
    menu.style.top = "0px";
    const menuWidth = menu.offsetWidth;
    const menuHeight = menu.offsetHeight;
    const maxLeft = window.innerWidth - menuWidth - 8;
    menu.style.left = `${Math.max(8, Math.min(rect.left, maxLeft))}px`;
    let top = rect.bottom + 6;
    if (top + menuHeight > window.innerHeight - 8) {
      const above = rect.top - 6 - menuHeight;
      top = above > 8 ? above : Math.max(8, window.innerHeight - menuHeight - 8);
    }
    menu.style.top = `${top}px`;

    document.addEventListener("keydown", onErChipMenuKey);
  }

  // Group-section header row. For real cb-groups the label is an inline
  // input that writes back to the canvas's .cb-group-label on commit;
  // legacy comment-card sections render a non-editable span (no canvas
  // input to write through to). Clicking the chevron / icon / count
  // toggles collapse; clicking the label focuses the input. Drag handle
  // on the leftmost column reorders groups.
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

    // Drag handle lives inside the group-row inner container so it sits
    // flush with the chevron / icon / label flex axis. Stops propagation
    // so the toggle handler below doesn't fire on mousedown.
    const dragHandle = document.createElement("span");
    dragHandle.className = "cb-table-view-drag-handle cb-table-view-drag-handle-group";
    dragHandle.title = "Drag to reorder group";
    dragHandle.setAttribute("aria-hidden", "true");
    dragHandle.innerHTML = gripperSvg(12);
    dragHandle.addEventListener("mousedown", (evt) => {
      // Only real cb-groups can reorder (canvas Group order persists).
      // Legacy comment-card sections are virtual — no group object to
      // shift — so the handle is dead for them.
      if (section.canvasGroupId == null) return;
      evt.stopPropagation();
      startBlockDrag("group", section.canvasGroupId, evt);
    });

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
    if (section.editable) {
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
        commitGroupLabel(section.canvasGroupId, labelInput.value);
      });
      labelWrap.appendChild(mirror);
      labelWrap.appendChild(labelInput);
      labelEl = labelWrap;
    } else {
      labelEl = document.createElement("span");
      labelEl.className = "cb-table-view-group-row-label";
      labelEl.textContent = section.groupName;
    }

    const count = document.createElement("span");
    count.className = "cb-table-view-group-row-count";
    // Super-group sections get a buildRows-stamped totalRowCount that
    // sums every row in their inner sub-sections; falling back to
    // section.rows.length keeps standalone (non-super) sections behaving
    // exactly as before.
    const dpCount = section.totalRowCount ?? section.rows.length;
    count.textContent = `${dpCount} data point${dpCount === 1 ? "" : "s"}`;

    wrap.appendChild(dragHandle);
    wrap.appendChild(chevron);
    wrap.appendChild(icon);
    wrap.appendChild(labelEl);
    wrap.appendChild(count);

    // Per-table header extras (Import Clay Table): the SOURCE table's total
    // row count and when it was imported. Distinct from the "N data points"
    // count above (which is imported columns, not source rows).
    if (opts.isTable) {
      if (Number.isFinite(opts.recordCount) && opts.recordCount > 0) {
        const rows = document.createElement("span");
        rows.className = "cb-table-view-group-row-meta";
        rows.textContent = `${opts.recordCount.toLocaleString()} row${opts.recordCount === 1 ? "" : "s"}`;
        wrap.appendChild(rows);
      }
      if (Number.isFinite(opts.importedAt) && opts.importedAt > 0) {
        const when = document.createElement("span");
        when.className = "cb-table-view-group-row-meta";
        when.textContent = `imported ${relativeTimeText(opts.importedAt)}`;
        when.title = new Date(opts.importedAt).toLocaleString();
        wrap.appendChild(when);
      }
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
      toggle();
    });
    // Right-click on a header opens the context menu so reps see the
    // disabled-state hint ("Shift+click another data point to enable")
    // even before they've built a selection. Suppresses the browser's
    // default menu so the affordance is consistent with row right-clicks.
    tr.addEventListener("contextmenu", (evt) => {
      evt.preventDefault();
      evt.stopPropagation();
      openContextMenu(evt.clientX, evt.clientY);
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

  function buildAddDpRow(colSpan) {
    const tr = document.createElement("tr");
    tr.className = "cb-table-view-add-dp-row";
    const td = document.createElement("td");
    td.colSpan = colSpan;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "cb-table-view-add-dp-btn";
    btn.innerHTML = plusSvg(12) + "<span>Add data point</span>";
    btn.addEventListener("click", () => {
      // Render an inline input in place of the button so the user can type
      // immediately without a modal. On Enter we create the canvas card and
      // re-render, which puts the new row into the table. On blur with empty
      // text we drop the input and restore the button.
      td.innerHTML = "";
      const input = document.createElement("input");
      input.type = "text";
      input.className = "cb-table-view-add-dp-input";
      input.placeholder = "Type data point name and press Enter\u2026";
      td.appendChild(input);
      input.focus();
      let committed = false;
      input.addEventListener("keydown", (evt) => {
        if (evt.key === "Enter") {
          evt.preventDefault();
          commit();
        } else if (evt.key === "Escape") {
          evt.preventDefault();
          render();
        }
      });
      input.addEventListener("blur", () => {
        if (!committed) commit();
      });
      function commit() {
        if (committed) return;
        committed = true;
        const text = input.value.trim();
        if (text.length > 0) {
          startAddDataPoint(text);
        }
        render();
      }
    });
    td.appendChild(btn);
    tr.appendChild(td);
    return tr;
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

  function uploadSvg(size) {
    const s = String(size);
    return (
      `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}" viewBox="0 0 24 24" ` +
      'fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" ' +
      'stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>' +
      '<polyline points="17 8 12 3 7 8"/>' +
      '<line x1="12" y1="3" x2="12" y2="15"/>' +
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

  // Six-dot gripper — same visual idiom Notion / Linear use for drag
  // affordances. Renders inside the leftmost col-drag cell (or, on group
  // header rows, inside the inner flex container next to the chevron).
  function gripperSvg(size) {
    const s = String(size);
    return (
      `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}" viewBox="0 0 24 24" ` +
      'fill="currentColor" aria-hidden="true">' +
      '<circle cx="9" cy="6" r="1.5"/>' +
      '<circle cx="15" cy="6" r="1.5"/>' +
      '<circle cx="9" cy="12" r="1.5"/>' +
      '<circle cx="15" cy="12" r="1.5"/>' +
      '<circle cx="9" cy="18" r="1.5"/>' +
      '<circle cx="15" cy="18" r="1.5"/>' +
      '</svg>'
    );
  }

  // ---- Public API ----

  __cb.tableView = {
    mount(host) {
      hostEl = host;
      render();
      // Document-level listeners: outside-clicks clear the selection;
      // Esc cancels drag / closes context menu / clears selection. Both
      // are removed on unmount() so they don't leak across mode toggles.
      document.addEventListener("mousedown", onDocClick);
      document.addEventListener("keydown", onDocKeyDown);
    },
    unmount() {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onDocKeyDown);
      // Clear transient state so a remount starts fresh — selection and
      // drag indicators wouldn't make sense across a tear-down.
      cleanupDrag();
      closeContextMenu();
      closeErChipMenu();
      selectedRowIds.clear();
      selectionAnchorId = null;
      visibleRowOrder = [];
      pendingFocusGroupId = null;
      if (hostEl) hostEl.innerHTML = "";
      hostEl = null;
      tableEl = null;
    },
    refresh() {
      if (!hostEl) return;
      // A render() rebuilds every row, so the chip that anchors an open
      // details menu is about to be torn down — close it first so it doesn't
      // hang detached over the table.
      closeErChipMenu();
      // Skip the re-render while the user is mid-edit on a cell — re-rendering
      // would steal focus and drop their in-progress input. The blur handler
      // (which fires on commit) will trigger the next refresh via
      // notifyChange → onCanvasStateChange.
      const active = document.activeElement;
      if (active && hostEl.contains(active) && active.tagName === "INPUT") return;
      // Skip during an active drag so the dragged row's DOM doesn't get
      // torn down mid-gesture (which would crash mouseup with no source).
      if (dragInProgress) return;
      // The single scroll viewport is the INNER .cb-table-view-table-container
      // (hostEl / .cb-table-view-area is overflow:hidden). render() rebuilds
      // that container from scratch, resetting it to (0,0) — so every commit
      // (coverage/fill edit, chip-×, row-×, picker-confirm) snaps the user
      // back to the top. Capture both axes off the old container and restore
      // them onto the freshly-built one so the re-render feels in-place.
      const prevScroller = hostEl.querySelector(".cb-table-view-table-container");
      const prevTop = prevScroller ? prevScroller.scrollTop : 0;
      const prevLeft = prevScroller ? prevScroller.scrollLeft : 0;
      render();
      if (prevTop > 0 || prevLeft > 0) {
        const nextScroller = hostEl.querySelector(".cb-table-view-table-container");
        if (nextScroller) {
          const maxTop = nextScroller.scrollHeight - nextScroller.clientHeight;
          const maxLeft = nextScroller.scrollWidth - nextScroller.clientWidth;
          nextScroller.scrollTop = Math.min(prevTop, Math.max(0, maxTop));
          nextScroller.scrollLeft = Math.min(prevLeft, Math.max(0, maxLeft));
        }
      }
    },
    isMounted() {
      return !!hostEl;
    },
  };
})();
