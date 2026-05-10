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

  // Find the cluster a card belongs to. cardId must already be the
  // canvas-native NUMERIC id. Returns the array of cardIds (the
  // cluster), or [cardId] if the card sits alone (getClusters() only
  // emits clusters of size >= 2). Reads the model-backed cluster id
  // off the canvas card so the lookup is O(N) over cards, not O(N²)
  // over snap-derived geometry.
  function getClusterForCard(cardId) {
    const canvas = __cb.canvas;
    if (!canvas?.getClusters) return [cardId];
    for (const cl of canvas.getClusters()) {
      if (cl.cardIds.includes(cardId)) return cl.cardIds.slice();
    }
    return [cardId];
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

  function formatNumber(n) {
    if (!Number.isFinite(n)) return "0";
    return n % 1 === 0
      ? n.toLocaleString()
      : n.toLocaleString(undefined, { maximumFractionDigits: 1 });
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

    const allCards = canvas.getCards();
    // Model-backed cluster membership: each cluster is `{id, cardIds}`.
    // We only need cardIds for the cost/coverage reducers below so flatten
    // here; richer per-cluster metadata (name, ordering, etc.) can be
    // surfaced once we have a use case that needs it.
    const clusters = canvas.getClusters().map((cl) => cl.cardIds);

    // Map each cluster's ER cards to the DPs that "claim" them. Clusters
    // without DPs leave their ERs eligible for the orphan section below.
    const dpInfoMap = new Map();
    const claimedErIds = new Set();

    for (const cluster of clusters) {
      const clusterCards = cluster
        .map((id) => allCards.find((c) => c.id === id))
        .filter(Boolean);
      const erCards = clusterCards.filter((c) => isErType(c.data.type));
      const dpCards = clusterCards.filter((c) => c.data.type === "dp");
      if (dpCards.length === 0) continue;

      let totalCredits = 0;
      let totalActions = 0;
      for (const er of erCards) {
        if (!er.data.usePrivateKey && er.data.credits != null) {
          totalCredits += er.data.credits;
        }
        if (er.data.actionExecutions != null) {
          totalActions += er.data.actionExecutions;
        }
        claimedErIds.add(er.id);
      }

      const perDpCredits = dpCards.length > 0 ? totalCredits / dpCards.length : 0;
      const perDpActions = dpCards.length > 0 ? totalActions / dpCards.length : 0;
      const erList = erCards.map((er) => buildErChipData(er));

      for (const dp of dpCards) {
        dpInfoMap.set(dp.id, {
          credits: perDpCredits,
          actions: perDpActions,
          ers: erList,
          enrichmentCount: erCards.length,
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
    const realGroups = typeof canvas.getGroups === "function" ? canvas.getGroups() : [];
    const groupNameById = new Map();
    for (const g of realGroups) {
      groupNameById.set(g.id, (g.label || "").trim());
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
      return {
        kind: "dp",
        cardId: card.id,
        y: card.y,
        name: card.data.text || card.data.displayName || "",
        fillRatePct: fillRatePct(card.data.fillRate),
        credits: info ? info.credits : 0,
        actions: info ? info.actions : 0,
        ers,
        erKey: erKeyForList(ers),
        connected: !!info && info.enrichmentCount > 0,
      };
    }

    const groupSectionsMap = new Map();
    const flatDpRows = [];
    for (const card of allCards) {
      if (card.data.type !== "dp") continue;
      const row = buildDpRowFromCard(card);

      let sectionKey = null;
      let sectionName = null;
      if (card.groupId != null && groupNameById.has(card.groupId)) {
        sectionKey = `g-${card.groupId}`;
        sectionName = groupNameById.get(card.groupId);
      } else {
        const cluster = card.data.groupCluster;
        if (cluster && commentByCluster.has(cluster)) {
          sectionKey = `c-${cluster}`;
          sectionName = commentByCluster.get(cluster);
        }
      }

      if (sectionKey) {
        if (!groupSectionsMap.has(sectionKey)) {
          groupSectionsMap.set(sectionKey, {
            groupId: sectionKey,
            groupName: sectionName,
            // Real cb-groups carry an editable label that writes back to
            // the canvas's .cb-group-label input; legacy comment-card
            // sections do not (the canvas has no input element to write
            // through to). buildGroupHeaderRow flips between editable
            // input and read-only span based on this flag.
            editable: sectionKey.startsWith("g-"),
            // Numeric canvas group id, used by commitGroupLabel to find
            // the live .cb-group-label DOM element via [data-group-id].
            // Null for legacy comment-card sections.
            canvasGroupId: sectionKey.startsWith("g-")
              ? Number(sectionKey.slice(2))
              : null,
            rows: [],
            // Tracked for Y sorting at render time — sections sit above
            // the flat DP rows in topological order, but within that
            // category we order by the topmost member's Y so reorder
            // results are visible after refresh.
            minY: Infinity,
          });
        }
        const section = groupSectionsMap.get(sectionKey);
        section.rows.push(row);
        if (card.y < section.minY) section.minY = card.y;
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
      for (const er of erCards) {
        if (!er.data.usePrivateKey && er.data.credits != null) credits += er.data.credits;
        if (er.data.actionExecutions != null) actions += er.data.actionExecutions;
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
        ers: sorted.map((c) => buildErChipData(c)),
      };
    }

    const orphanErRows = [];
    const orphanClusterSeen = new Set();
    // ersByGroupId: groupId → Map(clusterKey → orphan row). Two layers
    // because multiple clusters can land in the same cb-group (e.g. two
    // separate ER clusters both grouped together).
    const ersByGroupId = new Map();

    for (const card of allCards) {
      if (!isErType(card.data.type)) continue;
      if (claimedErIds.has(card.id)) continue;
      // Snap-cluster of this ER. May include other ER cards (Link
      // result) or just this one card.
      const clusterIds = getClusterForCard(card.id);
      const clusterKey = clusterIds.slice().sort((a, b) => a - b).join("|");
      if (orphanClusterSeen.has(clusterKey)) continue;
      orphanClusterSeen.add(clusterKey);
      // Filter to ER cards only (snap cluster is bounded by DP-presence
      // check above so this is mostly defensive — a DP in the cluster
      // would have placed it in claimedErIds).
      const erCards = clusterIds
        .map((id) => cardById.get(id))
        .filter((c) => c && isErType(c.data?.type));
      if (erCards.length === 0) continue;
      const row = buildOrphanRowFromCards(erCards);

      // Bucket by groupId of the first (primary) ER. cb-groups apply to
      // every member, so all ERs in the cluster share the same groupId
      // when they were grouped together; mixed-group clusters are rare
      // and map to the primary's group for consistency.
      const primary = erCards.find((c) => c.id === row.cardId) || erCards[0];
      if (primary.groupId != null && groupNameById.has(primary.groupId)) {
        if (!ersByGroupId.has(primary.groupId)) {
          ersByGroupId.set(primary.groupId, new Map());
        }
        ersByGroupId.get(primary.groupId).set(clusterKey, row);
      } else {
        orphanErRows.push(row);
      }
    }

    // Fold the grouped ER rows into the matching group section. If a
    // group has no DPs at all (Group action ran on orphan ERs only),
    // synthesize the section here so it renders.
    for (const [groupId, clusterMap] of ersByGroupId) {
      const sectionKey = `g-${groupId}`;
      let section = groupSectionsMap.get(sectionKey);
      if (!section) {
        section = {
          groupId: sectionKey,
          groupName: groupNameById.get(groupId) || "",
          editable: true,
          canvasGroupId: groupId,
          rows: [],
          minY: Infinity,
        };
        groupSectionsMap.set(sectionKey, section);
      }
      for (const row of clusterMap.values()) {
        section.rows.push(row);
        if (row.y < section.minY) section.minY = row.y;
      }
    }

    // Y-sort everything — drag-to-reorder shifts cards' y values directly
    // on the canvas, and refresh() re-runs buildRows; sorting here is
    // what makes the new order visible. Within a snap-cluster, multiple
    // DP rows share a single (host's) y so the relative order between
    // linked DPs is stable.
    flatDpRows.sort((a, b) => a.y - b.y);
    orphanErRows.sort((a, b) => a.y - b.y);
    for (const section of groupSectionsMap.values()) {
      section.rows.sort((a, b) => a.y - b.y);
    }
    const groupSections = Array.from(groupSectionsMap.values()).sort(
      (a, b) => a.minY - b.minY,
    );

    return {
      orphanErRows,
      groupSections,
      dpRows: flatDpRows,
    };
  }

  function buildErChipData(er) {
    const isWaterfall = er.data.type === "waterfall";
    const providerChain = isWaterfall
      ? (er.data.providers || []).map((p) => p.displayName || "Provider").join(" \u2192 ")
      : null;
    return {
      id: er.id,
      name: er.data.displayName || er.data.text || (isWaterfall ? "Waterfall" : "Untitled enrichment"),
      isWaterfall,
      providerChain,
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
    const cards = canvas.getCards();
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

  // Direct (x, y) mutation on a card — same pattern attachDpToOrphanCluster
  // uses to drop a new card at a precise position. We also need to update
  // the card.el's transform so the visual matches the model immediately;
  // refreshClusters reads the model values, but render() pulls Y from
  // card.y so the table sort lands correctly.
  function moveCardTo(card, x, y) {
    if (!card) return;
    card.x = x;
    card.y = y;
    if (card.el) card.el.style.transform = `translate(${x}px, ${y}px)`;
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
    if (card.data?.type === "dp") {
      return getClusterForCard(card.id);
    }
    if (isErType(card.data?.type)) {
      // Orphan ER rows never share their cluster with DPs, so the block
      // is just the ER itself plus any other ERs adjacent to it (rare).
      return getClusterForCard(card.id);
    }
    return [card.id];
  }

  function getBlockCardIdsForGroup(canvasGroupId) {
    const groups = __cb.canvas?.getGroups?.() || [];
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

  function shiftBlockY(cardIds, deltaY) {
    const canvas = __cb.canvas;
    if (!canvas?.getCardById) return;
    for (const id of cardIds) {
      const c = canvas.getCardById(id);
      if (!c) continue;
      moveCardTo(c, c.x, c.y + deltaY);
    }
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
    if (!dropIndicatorEl) {
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

  // Re-stack approach: gather every block in the affected section, sort
  // by current minY, splice the dragged block to its new index, then
  // assign sequential Y values starting from the section's current top.
  // This avoids overlap on the canvas AND keeps the table sort visible
  // because sort-by-Y + sequential Y == sort-by-position.
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

    // Re-stack from the section's current minY (preserves the section's
    // vertical position on the canvas). Sequential gap = 0 keeps clusters
    // tight; the cards' own heights provide the visual spacing.
    const baseY = Math.min(...sectionBlocks.map((b) => b.minY));
    let cursorY = baseY;
    for (const block of sectionBlocks) {
      const deltaY = cursorY - block.minY;
      if (deltaY !== 0) shiftBlockY(block.cardIds, deltaY);
      cursorY += block.height;
    }
    // Reorder shifts whole cluster blocks together so internal
    // adjacency is preserved per block. Empty dragCardIds keeps
    // cross-block cluster membership durable.
    if (canvas.refreshClusters) canvas.refreshClusters({ dragCardIds: new Set() });
    if (canvas.notifyChange) canvas.notifyChange();
  }

  // Build the list of {key, cardIds, minY, height} blocks for whatever
  // section the dragged row belongs to. Same-section restriction is
  // already enforced upstream, so we only need to enumerate one section.
  function collectSectionBlocks(hoverRowId) {
    const canvas = __cb.canvas;
    if (!canvas) return [];
    const section = getRowSection(hoverRowId) || "";
    const blocks = [];
    if (section === "groups") {
      // Groups section: each block is one cb-group.
      for (const g of canvas.getGroups?.() || []) {
        const cardIds = g.cardIds.slice();
        if (cardIds.length === 0) continue;
        const minY = getBlockMinY(cardIds);
        const height = blockHeight(cardIds);
        blocks.push({
          key: `group:${g.id}`,
          cardIds,
          minY,
          height,
        });
      }
    } else if (section === "orphan") {
      // Orphan section: each ER (or ER-only cluster) is its own block.
      const seen = new Set();
      for (const c of canvas.getCards()) {
        if (!isErType(c.data?.type)) continue;
        if (seen.has(c.id)) continue;
        const cluster = getClusterForCard(c.id);
        // Skip clusters that contain a DP — they belong to a DP section,
        // not the orphan section.
        const hasDp = cluster.some((id) => {
          const cc = canvas.getCardById(id);
          return cc?.data?.type === "dp";
        });
        if (hasDp) continue;
        for (const id of cluster) seen.add(id);
        blocks.push({
          key: `row:${c.id}`,
          cardIds: cluster,
          minY: getBlockMinY(cluster),
          height: blockHeight(cluster),
        });
      }
    } else if (section === "flat") {
      // Flat DP rows (no group, no comment-card cluster) — one block per
      // snap-cluster.
      const seen = new Set();
      for (const c of canvas.getCards()) {
        if (c.data?.type !== "dp") continue;
        if (c.groupId != null) continue;
        if (c.data.groupCluster) continue;
        if (seen.has(c.id)) continue;
        const cluster = getClusterForCard(c.id);
        for (const id of cluster) seen.add(id);
        blocks.push({
          key: `row:${c.id}`,
          cardIds: cluster,
          minY: getBlockMinY(cluster),
          height: blockHeight(cluster),
        });
      }
    } else if (section.startsWith("section:")) {
      // Inside a group (real cb-group OR legacy comment-card section) —
      // each snap-cluster of DPs in that group is one block.
      const sectionKey = section.slice("section:".length);
      const isRealGroup = sectionKey.startsWith("g-");
      const realGroupId = isRealGroup ? Number(sectionKey.slice(2)) : null;
      const commentClusterId = !isRealGroup && sectionKey.startsWith("c-")
        ? sectionKey.slice(2)
        : null;
      const seen = new Set();
      for (const c of canvas.getCards()) {
        if (c.data?.type !== "dp") continue;
        if (isRealGroup && c.groupId !== realGroupId) continue;
        if (commentClusterId != null && c.data.groupCluster !== commentClusterId) continue;
        if (seen.has(c.id)) continue;
        const cluster = getClusterForCard(c.id);
        for (const id of cluster) seen.add(id);
        blocks.push({
          key: `row:${c.id}`,
          cardIds: cluster,
          minY: getBlockMinY(cluster),
          height: blockHeight(cluster),
        });
      }
    }
    blocks.sort((a, b) => a.minY - b.minY);
    return blocks;
  }

  // Vertical span of a block — max(card.y + card.h) - min(card.y). Used
  // to size the post-drop sequential layout so blocks don't overlap.
  function blockHeight(cardIds) {
    const canvas = __cb.canvas;
    if (!canvas?.getCardById) return 0;
    let minY = Infinity;
    let maxBottom = -Infinity;
    for (const id of cardIds) {
      const c = canvas.getCardById(id);
      if (!c) continue;
      const h = c.el?.offsetHeight || (__cb.proMode ? 96 : 70);
      if (c.y < minY) minY = c.y;
      const bottom = c.y + h;
      if (bottom > maxBottom) maxBottom = bottom;
    }
    if (!Number.isFinite(minY) || !Number.isFinite(maxBottom)) return 0;
    return maxBottom - minY;
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
    const introTitle = document.createElement("div");
    introTitle.className = "cb-table-view-intro-title";
    introTitle.textContent = "Spreadsheet view";
    intro.appendChild(introTitle);

    const introActions = document.createElement("div");
    introActions.className = "cb-table-view-intro-actions";

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

    const { orphanErRows, groupSections, dpRows } = buildRows();

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

    const totalDpCount =
      dpRows.length +
      groupSections.reduce((sum, g) => sum + g.rows.length, 0);

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
      for (const section of groupSections) {
        const isCollapsed = collapsedGroups.has(section.groupId);
        tbody.appendChild(buildGroupHeaderRow(section, headers.length, isCollapsed));
        visibleRowOrder.push(section.groupId);
        if (!isCollapsed) {
          // mergeMode annotation only applies to DP rows. ER rows pass
          // through with mergeMode = "single" so the rowspan logic
          // doesn't touch them.
          annotateMergeRuns(section.rows.filter((r) => r.kind === "dp"));
          for (const row of section.rows) {
            if (row.kind === "orphan-er") {
              tbody.appendChild(
                buildOrphanDpStyleRow(row, `section:${section.groupId}`),
              );
            } else {
              tbody.appendChild(buildDpRow(row, `section:${section.groupId}`));
            }
            visibleRowOrder.push(String(row.cardId));
          }
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

    // Fill rate stays muted until the row promotes to a real DP — there's
    // no card to write the value to yet. The rep can edit it from the
    // promoted row on the next render.
    const fillCell = document.createElement("td");
    fillCell.className = "col-fill cb-table-view-cell-muted";
    fillCell.textContent = "\u2014";
    tr.appendChild(fillCell);

    const creditsCell = document.createElement("td");
    creditsCell.className = "col-credits cb-table-view-cell-readonly";
    creditsCell.textContent = formatNumber(row.credits);
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
    // No explicit notifyChange — addDataPointCard already fired one
    // with the cluster set, so the table view's render saw the link
    // on the first pass.
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

    const fillCell = document.createElement("td");
    fillCell.className = "col-fill";
    const fillInput = document.createElement("input");
    fillInput.type = "number";
    fillInput.min = "0";
    fillInput.max = "100";
    fillInput.step = "1";
    fillInput.className = "cb-table-view-cell-input cb-table-view-cell-input-num";
    fillInput.value = String(row.fillRatePct);
    fillInput.addEventListener("mousedown", (evt) => evt.stopPropagation());
    fillInput.addEventListener("click", (evt) => evt.stopPropagation());
    fillInput.addEventListener("keydown", (evt) => {
      if (evt.key === "Enter") evt.target.blur();
    });
    fillInput.addEventListener("blur", () => commitFillRate(row.cardId, fillInput.value));
    const fillSuffix = document.createElement("span");
    fillSuffix.className = "cb-table-view-cell-suffix";
    fillSuffix.textContent = "%";
    fillCell.appendChild(fillInput);
    fillCell.appendChild(fillSuffix);
    tr.appendChild(fillCell);

    // Credits / actions / ERs collapse into the "first" row of a merge
    // run via rowspan. Followers ("skip") emit no <td> for these columns
    // — the host's rowspan covers them.
    if (mergeMode !== "skip") {
      const creditsCell = document.createElement("td");
      creditsCell.className = "col-credits cb-table-view-cell-readonly";
      if (mergeSpan > 1) creditsCell.rowSpan = mergeSpan;
      creditsCell.textContent = formatNumber(row.credits);
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
      addErBtn.innerHTML = plusSvg(11) + "<span>Add enrichment</span>";
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
    chip.className =
      "cb-table-view-er-chip" + (er.isWaterfall ? " cb-table-view-er-chip-waterfall" : "");
    chip.title =
      er.isWaterfall && er.providerChain
        ? `${er.name} \u2014 ${er.providerChain}`
        : er.name;
    const label = document.createElement("span");
    label.className = "cb-table-view-er-chip-label";
    label.textContent = er.name;
    chip.appendChild(label);
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

  // Group-section header row. For real cb-groups the label is an inline
  // input that writes back to the canvas's .cb-group-label on commit;
  // legacy comment-card sections render a non-editable span (no canvas
  // input to write through to). Clicking the chevron / icon / count
  // toggles collapse; clicking the label focuses the input. Drag handle
  // on the leftmost column reorders groups.
  function buildGroupHeaderRow(section, colSpan, isCollapsed) {
    const tr = document.createElement("tr");
    tr.className =
      "cb-table-view-group-row" +
      (isCollapsed ? " cb-table-view-group-row-collapsed" : "");
    tr.setAttribute("data-group-id", String(section.groupId));
    tr.setAttribute("data-row-id", String(section.groupId));
    tr.setAttribute("data-row-section", "groups");
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
    icon.innerHTML = folderSvg(13);

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
    const dpCount = section.rows.length;
    count.textContent = `${dpCount} data point${dpCount === 1 ? "" : "s"}`;

    wrap.appendChild(dragHandle);
    wrap.appendChild(chevron);
    wrap.appendChild(icon);
    wrap.appendChild(labelEl);
    wrap.appendChild(count);
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
      // Skip the re-render while the user is mid-edit on a cell — re-rendering
      // would steal focus and drop their in-progress input. The blur handler
      // (which fires on commit) will trigger the next refresh via
      // notifyChange → onCanvasStateChange.
      const active = document.activeElement;
      if (active && hostEl.contains(active) && active.tagName === "INPUT") return;
      // Skip during an active drag so the dragged row's DOM doesn't get
      // torn down mid-gesture (which would crash mouseup with no source).
      if (dragInProgress) return;
      // hostEl IS the scroll container (.cb-table-view-area has overflow:
      // auto). render() wipes hostEl.innerHTML, which resets scrollTop to 0,
      // making every chip-× / row-× / picker-confirm snap the user back to
      // the top. Capture and restore around the re-render so the table
      // looks visually stable across mutations.
      const prevScrollTop = hostEl.scrollTop;
      render();
      if (prevScrollTop > 0) {
        const maxScroll = hostEl.scrollHeight - hostEl.clientHeight;
        hostEl.scrollTop = Math.min(prevScrollTop, Math.max(0, maxScroll));
      }
    },
    isMounted() {
      return !!hostEl;
    },
  };
})();
