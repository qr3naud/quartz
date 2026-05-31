(function () {
  "use strict";

  const __cb = window.__cb;

  let canvasArea, svgLayer, cardContainer;
  let panX = 0, panY = 0, scale = 1;
  let cards = [], groups = [];
  // Per-imported-table metadata keyed by source tableId:
  //   { name, importColor, recordCount, importedAt }
  // Single source of truth for the table-view per-table headers (source row
  // count + import time) and for repairing tableName/importColor on reload
  // (the DP/input/comment restore path doesn't carry those on the card).
  // Serialized + restored with the rest of the canvas state.
  let importedTables = {};
  let nextCardId = 1, nextGroupId = 1;
  // Monotonic id counter for relational cluster membership (see
  // `getClusters` / `assignToCluster`). Survives across snap-reconcile
  // because `syncClusterModelFromSnap` reuses existing cluster ids
  // whenever any member already has one — only fully-new clusters
  // bump the counter.
  let nextClusterId = 1;
  let selectedCards = new Set();
  let dragState = null, panState = null, selBoxState = null, groupDragState = null;
  let spaceHeld = false;
  let activeTool = null;
  let toolClickPending = null;
  let selectedGroupId = null;
  let groupColorMenuEl = null;
  let groupColorMenuGroupId = null;
  let selectionHintEl = null;
  let selectionMenuEl = null;
  let undoStack = [];
  let redoStack = [];
  let lastSnapshot = null;
  let lastMouse = null;
  // Lazy canvas DOM gate (C2.2). False while a table-view tab is open: the
  // model (`cards`) is fully built but no `.cb-card` elements are mounted, so
  // the table view (the primary surface) renders from the store with zero
  // canvas DOM. Flipped true by hydrateCanvasDom() on first toggle to the
  // canvas, and set directly by restore() per the tab's saved view. Every
  // function that touches `card.el` and can run while this is false must
  // tolerate `el === null` (see the guards below + cards.js / geometry.js /
  // persistence.js / live-actions.js).
  let domHydrated = false;
  const MAX_UNDO = 50;
  const __cbCanvasModules = window.__cbCanvasModules || {};
  const __geometry = __cbCanvasModules.createGeometryHelpers
    ? __cbCanvasModules.createGeometryHelpers()
    : null;
  const __groupThemes = __cbCanvasModules.createGroupThemeHelpers
    ? __cbCanvasModules.createGroupThemeHelpers()
    : null;
  let __graphQueries = null;
  let __credits = null;
  let __ui = null;
  let __groupLifecycle = null;
  let __cards = null;
  let __persistence = null;
  let __snap = null;

  function getUiHelpers() {
    if (!__ui) {
      __ui = __cbCanvasModules.createUiHelpers({
        addDataPointCard,
        addInputCard,
        cardContainerRef: () => cardContainer,
        canvasAreaRef: () => canvasArea,
        screenToCanvas,
        activeToolRef: () => activeTool,
        interactionStateRef: () => ({
          dragState,
          groupDragState,
          panState,
          selBoxState,
          toolClickPending,
        }),
        notifyCreditTotal,
        updateGroupCredits,
        updateDpCosts,
        notifyChange,
        getCardById,
        serializeRef: () => getPersistenceHelpers().serialize(),
        refreshClusters,
      });
    }
    return __ui;
  }

  function getGroupLifecycleHelpers() {
    if (!__groupLifecycle) {
      __groupLifecycle = __cbCanvasModules.createGroupLifecycleHelpers({
        cardsRef: () => cards,
        groupsRef: () => groups,
        setGroups: (next) => {
          groups = next;
        },
        selectedCardsRef: () => selectedCards,
        clearSelection,
        cardContainerRef: () => cardContainer,
        getCardRect,
        applyGroupTheme,
        getGroupTheme,
        notifyChange,
        updateGroupCredits,
        getNextGroupId: () => nextGroupId++,
        ensureNextGroupId: (id) => {
          if (id >= nextGroupId) nextGroupId = id + 1;
        },
        setGroupDragState: (next) => {
          groupDragState = next;
        },
        getGroupColorMenuEl: () => groupColorMenuEl,
        setGroupColorMenuEl: (next) => {
          groupColorMenuEl = next;
        },
        getGroupColorMenuGroupId: () => groupColorMenuGroupId,
        setGroupColorMenuGroupId: (next) => {
          groupColorMenuGroupId = next;
        },
      });
    }
    return __groupLifecycle;
  }

  function getCardHelpers() {
    if (!__cards) {
      __cards = __cbCanvasModules.createCardHelpers({
        cbRef: () => __cb,
        cardsRef: () => cards,
        setCards: (next) => {
          cards = next;
        },
        groupsRef: () => groups,
        setGroups: (next) => {
          groups = next;
        },
        selectedCardsRef: () => selectedCards,
        getGroupColorMenuGroupId: () => groupColorMenuGroupId,
        closeGroupColorMenu,
        canvasAreaRef: () => canvasArea,
        panRef: () => ({ panX, panY }),
        scaleRef: () => scale,
        cardContainerRef: () => cardContainer,
        getNextCardId: () => nextCardId++,
        ensureNextCardId: (id) => {
          if (id >= nextCardId) nextCardId = id + 1;
        },
        getCardById,
        selectCard,
        clearSelection,
        setDragState: (next) => {
          dragState = next;
        },
        showModelPicker,
        updateGroupBounds,
        notifySelection,
        notifyCreditTotal,
        notifyChange,
        getCardType,
        isOppositeType,
        showSelectionMenu,
        refreshClusters,
        updateGroupCredits,
        updateDpCosts,
        // Used by the per-ER frequency badge to propagate a picked
        // value across every ER in the same cluster ("update one, all
        // update"). Now reads from the relational model rather than
        // re-deriving from snap geometry.
        getClusters,
        // Lazy-DOM gate (C2.2): addX wrappers mount DOM only when the
        // canvas view is hydrated; otherwise they build data-only cards.
        isDomHydrated: () => domHydrated,
      });
    }
    return __cards;
  }

  function getPersistenceHelpers() {
    if (!__persistence) {
      __persistence = __cbCanvasModules.createPersistenceHelpers({
        cardsRef: () => cards,
        groupsRef: () => groups,
        panRef: () => ({ panX, panY, scale }),
        nextIdsRef: () => ({ nextCardId, nextGroupId, nextClusterId }),
        importedTablesRef: () => importedTables,
        setImportedTables: (next) => {
          importedTables = next && typeof next === "object" ? next : {};
        },
        setPanScale: (next) => {
          panX = next.panX;
          panY = next.panY;
          scale = next.scale;
        },
        setNextIds: (next) => {
          nextCardId = next.nextCardId ?? nextCardId;
          nextGroupId = next.nextGroupId ?? nextGroupId;
          nextClusterId = next.nextClusterId ?? nextClusterId;
        },
        applyTransform,
        addCard,
        addDataPointCard,
        addInputCard,
        addCommentCard,
        restoreGroup,
        updateDpCosts,
        setRestoring: (next) => {
          restoring = next;
        },
        // Legacy state migration: persistence calls this once after
        // restore() if the loaded blob carried no cluster ids. We use
        // snap-derived geometry as the seed and stamp explicit ids so
        // subsequent saves carry the model forward.
        backfillClusterModel: () => {
          syncClusterModelFromSnap();
        },
      });
    }
    return __persistence;
  }

  function getSnapHelpers() {
    if (!__snap) {
      __snap = __cbCanvasModules.createSnapHelpers({
        cardsRef: () => cards,
        getCardRect,
      });
    }
    return __snap;
  }

  // ---- Cluster model (relational) ----
  //
  // The relational model is the source of truth for cluster membership;
  // snap-adjacency is just the writer that keeps the model in sync with
  // canvas geometry on every settle point (drag-end, restore, picker
  // placement, undo/redo, importer drops). Writers that originate
  // OUTSIDE the canvas (e.g. table-view "link") call assignToCluster +
  // layoutCluster so canvas geometry is also kept consistent.
  //
  // `getClusters()` returns an array of `{ id, cardIds }` for clusters
  // of size >= 2 — singletons (clusterId === null) are filtered out for
  // parity with the legacy `getSnapClusters()` shape.

  function getClusters() {
    const byId = new Map();
    for (const c of cards) {
      if (c.clusterId == null) continue;
      const arr = byId.get(c.clusterId);
      if (arr) arr.push(c.id);
      else byId.set(c.clusterId, [c.id]);
    }
    const out = [];
    for (const [id, cardIds] of byId) {
      if (cardIds.length < 2) continue;
      out.push({ id, cardIds });
    }
    return out;
  }

  // Convenience for callers that previously used the cardIds-only shape
  // returned by getSnapClusters(). Returned arrays are independent
  // copies (safe to sort/mutate by callers).
  function getClusterCardIds() {
    return getClusters().map((cl) => cl.cardIds.slice());
  }

  // Assign a set of cards to a cluster id. Pass `null` to detach. After
  // the assignment, callers SHOULD layout the affected cards into a
  // snap-adjacent arrangement so the next snap-reconcile cycle (in
  // refreshClusters) doesn't immediately clear the new membership.
  // assignToCluster does NOT call layoutCluster automatically because
  // the canvas itself uses this internally during snap-reconcile.
  function assignToCluster(cardIds, clusterId) {
    if (!Array.isArray(cardIds)) return;
    if (clusterId != null) ensureNextClusterId(clusterId);
    for (const id of cardIds) {
      const c = getCardById(id);
      if (!c) continue;
      c.clusterId = clusterId;
    }
  }

  function ensureNextClusterId(id) {
    if (typeof id === "number" && id >= nextClusterId) {
      nextClusterId = id + 1;
    }
  }

  function allocateClusterId() {
    return nextClusterId++;
  }

  // Reconcile the model from current geometry. Called from
  // refreshClusters() so snap-adjacency stays the dominant writer in
  // canvas-driven flows (drag-end, picker placement, importer drops).
  // Existing cluster ids are preserved whenever possible: if any member
  // of a snap-cluster already has a clusterId, that id wins (smallest if
  // multiple). Only fully-new snap-clusters allocate a new id.
  //
  // `opts.dragCardIds` (Set<cardId> | null) scopes both PROMOTION and
  // DEMOTION to a known set of cards. Snap-as-writer is a UX shortcut
  // for explicit user drags and for legacy backfill — non-drag callers
  // should never have their geometry silently rewrite saved cluster
  // membership.
  //
  // - Demotion (clearing clusterId on cards no longer geometrically
  //   adjacent): only cards in `dragCardIds` are eligible. Without this
  //   guard, deleting a "bridge" card from a chain-shaped cluster
  //   (DP — ER1 — ER2 — ER3) demotes the now-isolated DP as collateral
  //   damage on the snap-reconcile that follows the remove. Added in
  //   v3.20.2.
  //
  // - Promotion: standard promotion (assign canonical clusterId to all
  //   members of a snap-cluster) runs unconditionally for snap-clusters
  //   whose existing non-null clusterIds are all the SAME id (or all
  //   null) — those are pure backfill / canonicalization and never
  //   destroy saved membership. Snap-clusters that span TWO OR MORE
  //   distinct existing cluster ids ("cross-cluster merges") only
  //   promote when a dragged card is present. This is what stops the
  //   table-view "swap two independent DPs → they get linked" bug:
  //   non-drag flows that happen to land previously independent
  //   clusters snap-adjacent leave their cluster ids intact.
  //
  // Drag handlers pass the cards the user actually moved; every other
  // caller (removeCard, picker placement, importers, link, waterfall,
  // align, reflow, table-view writers, overlay first-open refresh)
  // passes an empty Set so demotion stays scoped AND cross-cluster
  // merges are blocked. A null `dragCardIds` preserves the legacy
  // "snap is the dominant writer" behavior for both directions — we
  // still pass it through internal callers (eg. legacy backfill) where
  // the model is being seeded from scratch and geometry is the only
  // available signal.
  function syncClusterModelFromSnap(opts) {
    const dragCardIds = opts?.dragCardIds ?? null;
    const snapClusters = getSnapHelpers().getSnapClusters();
    const inAnyCluster = new Set();

    for (const cluster of snapClusters) {
      // Inspect existing clusterIds among members up front. A snap-
      // cluster whose members carry 2+ distinct non-null clusterIds is
      // a cross-cluster merge candidate — only allowed when a dragged
      // card is involved. Pure backfill (all null) and canonicalization
      // (all share one id, or fill-in nulls toward one id) is always
      // safe and runs regardless of dragCardIds.
      const existingIds = new Set();
      for (const id of cluster) {
        const c = getCardById(id);
        if (c?.clusterId != null) existingIds.add(c.clusterId);
      }
      const isCrossClusterMerge = existingIds.size >= 2;
      if (
        isCrossClusterMerge &&
        dragCardIds &&
        !cluster.some((id) => dragCardIds.has(id))
      ) {
        // Track membership so demotion below doesn't strip clusterId
        // from cards that are still geometrically in some cluster —
        // we just aren't re-canonicalizing this one.
        for (const id of cluster) inAnyCluster.add(id);
        continue;
      }

      let canonical = null;
      for (const id of cluster) {
        const c = getCardById(id);
        if (c?.clusterId == null) continue;
        if (canonical == null || c.clusterId < canonical) canonical = c.clusterId;
      }
      if (canonical == null) {
        canonical = allocateClusterId();
      } else {
        ensureNextClusterId(canonical);
      }
      for (const id of cluster) {
        const c = getCardById(id);
        if (!c) continue;
        c.clusterId = canonical;
        inAnyCluster.add(id);
      }
    }

    // Demote cards that snap-derive no longer sees in any cluster.
    // Scoped: only cards in `dragCardIds` are eligible — anything else
    // keeps its saved `clusterId` so the table view's mutations don't
    // accidentally bleed into the model.
    for (const c of cards) {
      if (inAnyCluster.has(c.id)) continue;
      if (dragCardIds && !dragCardIds.has(c.id)) continue;
      c.clusterId = null;
    }
  }

  // Render-only variant: redraws snap outlines and recomputes costs
  // from the current relational model, WITHOUT running snap-reconcile.
  // Called from persistence paths (restore, undo, redo) where the
  // model is already settled and a snap-reconcile would clobber saved
  // membership when geometry hasn't been remeasured at the right
  // proMode pitch yet (overlay.js applies the saved Pro Mode attribute
  // AFTER restore, so cards are temporarily measured at the wrong
  // height). Geometry-driven flows (drag-end, picker placement,
  // importer drops) call refreshClusters() instead, which IS the
  // snap-as-writer path.
  function refreshClusterVisuals() {
    // Lazy DOM (C2.2): renderClusterOutlines stamps snap classes onto
    // card.el, which is null while a table-view tab is open. Skip entirely —
    // there's nothing visual to update without canvas DOM, and clusterId is
    // already persisted so the table view never needs a reconcile. Re-runs on
    // hydrateCanvasDom() once the elements exist.
    if (!domHydrated) return;
    getSnapHelpers().renderClusterOutlines();
    updateDpCosts();
    updateGroupCredits();
  }

  function refreshClusters(opts) {
    // Snap-as-writer reads geometry off card.el (via getCardRect) and writes
    // classes during refreshClusterVisuals. Both require canvas DOM, so this
    // is a no-op while unhydrated (table-view surface). hydrateCanvasDom()
    // runs a full refreshClusters once the cards are mounted.
    if (!domHydrated) return;
    syncClusterModelFromSnap(opts);
    refreshClusterVisuals();
  }

  // Reposition a set of cards into a snap-adjacent arrangement so
  // canvas-mode geometry agrees with the assignment. Mirrors the
  // bucketing rule used by the canvas Enter shortcut (linkSelectedCards):
  // comments above, inputs to the LEFT, DPs in an adaptive grid, ERs to
  // the RIGHT. Uses the cluster's topmost-leftmost member as the anchor
  // so existing clusters stay near their original canvas position.
  // Used by table-view-driven mutations (link, attach DP to cluster) to
  // keep the canvas representation valid without making the table view
  // care about coordinates.
  function layoutCardsAsCluster(cardIds, opts) {
    if (!Array.isArray(cardIds) || cardIds.length === 0) return;
    const list = cardIds
      .map((id) => getCardById(id))
      .filter(Boolean);
    if (list.length === 0) return;

    const anchorX = opts?.anchorX != null
      ? opts.anchorX
      : Math.min(...list.map((c) => c.x));
    const anchorY = opts?.anchorY != null
      ? opts.anchorY
      : Math.min(...list.map((c) => c.y));

    const commentCards = list.filter((c) => c.data.type === "comment");
    const inputCards = list.filter((c) => c.data.type === "input");
    const dpCards = list.filter((c) => c.data.type === "dp");
    const erCards = list.filter((c) =>
      c.data.type !== "comment" && c.data.type !== "input" && c.data.type !== "dp",
    );
    for (const arr of [commentCards, inputCards, dpCards, erCards]) {
      arr.sort((a, b) => a.y - b.y || a.x - b.x);
    }

    const cardW = getCardRect(list[0]).w;
    const cardH = getCardRect(list[0]).h;
    const dpCols = dpCards.length > 0
      ? Math.max(1, Math.ceil(Math.sqrt(dpCards.length)))
      : 0;
    const inputColW = inputCards.length > 0 ? cardW : 0;
    const commentRowH = commentCards.length > 0 ? cardH : 0;

    const dpOriginX = anchorX + inputColW;
    const dpOriginY = anchorY + commentRowH;

    // Always update the model x/y so the relational layout is correct even on
    // the table-view surface (lazy DOM, C2.2); only write the transform when
    // the element exists. When unhydrated, hydrateCanvasDom mounts each card
    // at its model x/y and tightenBrokenClusters tidies adjacency on toggle.
    for (let i = 0; i < commentCards.length; i++) {
      commentCards[i].x = dpOriginX + i * cardW;
      commentCards[i].y = anchorY;
      if (commentCards[i].el) commentCards[i].el.style.transform =
        `translate(${commentCards[i].x}px, ${commentCards[i].y}px)`;
    }
    for (let i = 0; i < inputCards.length; i++) {
      inputCards[i].x = anchorX;
      inputCards[i].y = dpOriginY + i * cardH;
      if (inputCards[i].el) inputCards[i].el.style.transform =
        `translate(${inputCards[i].x}px, ${inputCards[i].y}px)`;
    }
    for (let i = 0; i < dpCards.length; i++) {
      const r = Math.floor(i / dpCols);
      const c = i % dpCols;
      dpCards[i].x = dpOriginX + c * cardW;
      dpCards[i].y = dpOriginY + r * cardH;
      if (dpCards[i].el) dpCards[i].el.style.transform =
        `translate(${dpCards[i].x}px, ${dpCards[i].y}px)`;
    }
    const erColX = dpCards.length > 0
      ? dpOriginX + dpCols * cardW
      : dpOriginX;
    for (let i = 0; i < erCards.length; i++) {
      erCards[i].x = erColX;
      erCards[i].y = dpOriginY + i * cardH;
      if (erCards[i].el) erCards[i].el.style.transform =
        `translate(${erCards[i].x}px, ${erCards[i].y}px)`;
    }
  }

  // Programmatic cluster join — the relational counterpart to the
  // canvas Enter shortcut. Used by the table view to merge selected
  // rows into one cluster without manipulating x/y. Reuses any
  // existing cluster id present among the inputs (topmost-leftmost
  // wins) so dragging a row into an established cluster keeps the
  // cluster's stable id, which surfaces in saved state and undo.
  function linkCardsByIds(cardIds) {
    if (!Array.isArray(cardIds) || cardIds.length < 2) return null;
    const list = cardIds
      .map((id) => getCardById(id))
      .filter(Boolean);
    if (list.length < 2) return null;

    const anchor = list.slice().sort((a, b) => a.y - b.y || a.x - b.x)[0];
    const existingIds = list
      .map((c) => c.clusterId)
      .filter((id) => id != null);
    const targetId = existingIds.length > 0
      ? Math.min(...existingIds)
      : allocateClusterId();

    // Pull every card that previously shared a cluster with one of our
    // inputs: when a DP gets linked, its existing ER cluster-mates have
    // to come along, otherwise refreshClusters' snap-reconcile would
    // strand them. Defensive against the (rare) case where a caller
    // hands in only a subset of the cluster.
    const all = new Set();
    for (const c of list) all.add(c.id);
    for (const id of existingIds) {
      for (const c of cards) {
        if (c.clusterId === id) all.add(c.id);
      }
    }

    // Intentional-link lineage (Phase 2.c / C1.4). A deliberate link — the
    // canvas Enter shortcut and the table-view "Link" button both route here —
    // with exactly one enrichment commits semantic lineage on the linked data
    // point(s): each DP's `sourceEnrichmentFieldId` is set to that ER's key
    // (action field id, or `wf:<groupCluster>` for waterfalls). This is how
    // manually authored canvas links flow into the table. Passive snap-reconcile
    // (refreshClusters) never calls this, so geometry alone never writes
    // lineage. Multi-ER links are ambiguous, so they cluster but write none. We
    // only stamp the explicitly-selected `list`, not the cluster-mates pulled
    // into `all` for membership integrity.
    const isErCard = (c) =>
      c && c.data && c.data.type !== "dp" && c.data.type !== "input" && c.data.type !== "comment";
    const linkedErs = list.filter(isErCard);
    const linkedDps = list.filter((c) => c && c.data && c.data.type === "dp");
    if (linkedErs.length === 1 && linkedDps.length > 0) {
      const er = linkedErs[0];
      const erKey = er.data.type === "waterfall"
        ? (er.data.groupCluster != null ? `wf:${er.data.groupCluster}` : null)
        : (er.data.fieldId ?? null);
      if (erKey != null) {
        for (const dp of linkedDps) dp.data.sourceEnrichmentFieldId = erKey;
      }
    }

    assignToCluster([...all], targetId);
    layoutCardsAsCluster([...all], { anchorX: anchor.x, anchorY: anchor.y });
    return targetId;
  }

  // Find clusters whose members aren't all geometrically connected via
  // snap-adjacency and re-run layoutCardsAsCluster on them so the
  // canvas representation matches the relational model again. Used by
  // overlay.js when switching from the table view back to the canvas:
  // table-side mutations (delete a bridge ER, merge orphan clusters,
  // etc.) can leave the model intact while geometry shows the cluster
  // as scattered cards. This is a "tidy on entry" pass — cards that
  // form a single connected component already are left alone, so the
  // user's hand-arranged canvas layouts survive untouched.
  //
  // Returns true if any cluster was re-laid out (caller should
  // notifyChange + persist), false otherwise.
  function tightenBrokenClusters() {
    const clusters = getClusters();
    if (clusters.length === 0) return false;
    const adjacencyPairs = getSnapHelpers().getAdjacentPairs();

    let mutated = false;
    for (const cluster of clusters) {
      if (cluster.cardIds.length < 2) continue;

      // Build adjacency restricted to this cluster's members.
      const memberSet = new Set(cluster.cardIds);
      const adj = new Map();
      for (const id of cluster.cardIds) adj.set(id, []);
      for (const pair of adjacencyPairs) {
        if (memberSet.has(pair.id1) && memberSet.has(pair.id2)) {
          adj.get(pair.id1).push(pair.id2);
          adj.get(pair.id2).push(pair.id1);
        }
      }

      // BFS from the first member; if the visited set covers every
      // cluster member, the cluster is geometrically intact.
      const visited = new Set();
      const queue = [cluster.cardIds[0]];
      while (queue.length > 0) {
        const cur = queue.shift();
        if (visited.has(cur)) continue;
        visited.add(cur);
        for (const neighbor of adj.get(cur) || []) {
          if (!visited.has(neighbor)) queue.push(neighbor);
        }
      }
      if (visited.size === cluster.cardIds.length) continue;

      // Multiple components — re-layout the whole cluster anchored on
      // the topmost-leftmost member so the broken pieces snap back
      // together using the standard bucketing (comments above, inputs
      // LEFT, DPs grid, ERs RIGHT).
      const memberCards = cluster.cardIds
        .map((id) => getCardById(id))
        .filter(Boolean);
      if (memberCards.length === 0) continue;
      const anchor = memberCards.slice().sort((a, b) => a.y - b.y || a.x - b.x)[0];
      layoutCardsAsCluster(cluster.cardIds, {
        anchorX: anchor.x,
        anchorY: anchor.y,
      });
      // Stream the moved positions to peers so the cluster re-tighten
      // shows up live for collaborators viewing the canvas. Mirrors the
      // applyClusterReflow broadcast loop.
      if (__cb.realtime?.broadcastCardMove) {
        for (const c of memberCards) {
          __cb.realtime.broadcastCardMove(c.id, c.x, c.y);
        }
      }
      mutated = true;
    }

    return mutated;
  }

  function screenToCanvas(sx, sy) {
    const rect = canvasArea.getBoundingClientRect();
    return { x: (sx - rect.left - panX) / scale, y: (sy - rect.top - panY) / scale };
  }

  function applyTransform() {
    const t = `translate(${panX}px, ${panY}px) scale(${scale})`;
    cardContainer.style.transform = t;
    svgLayer.style.transform = t;
  }

  function createSvgEl(tag) {
    return __cbCanvasModules.createSvgEl(tag);
  }

  function bezier(x1, y1, x2, y2) {
    return __geometry.bezier(x1, y1, x2, y2);
  }

  function getCardRect(c) {
    return __geometry.getCardRect(c);
  }

  function edgePoint(c, side) {
    return __geometry.edgePoint(c, side);
  }

  function closestEdge(c, cx, cy) {
    return __geometry.closestEdge(c, cx, cy);
  }

  let restoring = false;

  function captureSnapshot() {
    return getPersistenceHelpers().serialize();
  }

  function notifyChange() {
    if (restoring) return;
    if (lastSnapshot) {
      undoStack.push(lastSnapshot);
      if (undoStack.length > MAX_UNDO) undoStack.shift();
      redoStack = [];
    }
    lastSnapshot = captureSnapshot();
    if (__cb.onCanvasStateChange) __cb.onCanvasStateChange();
  }

  function clearCanvas() {
    closeSelectionMenu();
    closeGroupColorMenu();
    closeCanvasMenu();

    // Null-safe on card.el: with lazy DOM (C2.2) cards can be data-only when
    // clearCanvas runs (undo/redo restore, or re-restore in a table-view tab).
    // Groups stay eager, so g.el always exists.
    for (const c of cards) c.el?.remove();
    for (const g of groups) g.el.remove();
    if (selectionHintEl) selectionHintEl.classList.remove("cb-selection-hint-visible");

    cards = [];
    groups = [];
    selectedCards.clear();
    selectedGroupId = null;
    nextCardId = nextGroupId = nextClusterId = 1;
  }

  function undo() {
    if (undoStack.length === 0) return;
    if (dragState || groupDragState || panState || selBoxState) return;
    redoStack.push(lastSnapshot);
    lastSnapshot = undoStack.pop();
    clearCanvas();
    restoring = true;
    const { view: _v, ...stateToRestore } = lastSnapshot;
    getPersistenceHelpers().restore(stateToRestore);
    restoring = false;
    // Visuals-only: the undo snapshot already carries the relational
    // cluster model, so re-running snap-reconcile would only risk
    // clobbering saved membership. See refreshClusterVisuals comment.
    refreshClusterVisuals();
    notifyCreditTotal();
    if (__cb.onCanvasStateChange) __cb.onCanvasStateChange();
  }

  function redo() {
    if (redoStack.length === 0) return;
    if (dragState || groupDragState || panState || selBoxState) return;
    undoStack.push(lastSnapshot);
    lastSnapshot = redoStack.pop();
    clearCanvas();
    restoring = true;
    const { view: _v, ...stateToRestore } = lastSnapshot;
    getPersistenceHelpers().restore(stateToRestore);
    restoring = false;
    refreshClusterVisuals();
    notifyCreditTotal();
    if (__cb.onCanvasStateChange) __cb.onCanvasStateChange();
  }

  function linePath(x1, y1, x2, y2) {
    return __geometry.linePath(x1, y1, x2, y2);
  }

  function getCardById(id) {
    return cards.find((c) => c.id === id) || null;
  }

  function getCardType(card) {
    if (!__graphQueries) {
      __graphQueries = __cbCanvasModules.createGraphQueries({
        cardsRef: () => cards,
        getCardById,
      });
    }
    return __graphQueries.getCardType(card);
  }

  function isOppositeType(sourceCard, targetCard) {
    if (!__graphQueries) {
      __graphQueries = __cbCanvasModules.createGraphQueries({
        cardsRef: () => cards,
        getCardById,
      });
    }
    return __graphQueries.isOppositeType(sourceCard, targetCard);
  }

  function getGroupTheme(group) {
    return __groupThemes.getGroupTheme(group);
  }

  function applyGroupTheme(group) {
    __groupThemes.applyGroupTheme(group);
  }

  function closeGroupColorMenu() {
    getGroupLifecycleHelpers().closeGroupColorMenu();
  }

  function syncDpText(card, textEl) {
    getCardHelpers().syncDpText(card, textEl);
  }

  function openGroupColorMenu(group, e) {
    getGroupLifecycleHelpers().openGroupColorMenu(group, e);
  }

  // ---- Cards ----

  function startCardMouseInteraction(card, e) {
    getCardHelpers().startCardMouseInteraction(card, e);
  }

  function addCard(data, opts) {
    return getCardHelpers().addCard(data, opts);
  }

  function removeCard(id) {
    getCardHelpers().removeCard(id);
  }

  // ---- Data Point Cards ----

  function addDataPointCard(text, opts) {
    return getCardHelpers().addDataPointCard(text, opts);
  }

  // ---- Input Cards ----

  function addInputCard(text, opts) {
    return getCardHelpers().addInputCard(text, opts);
  }

  // ---- Comment Cards ----

  function addCommentCard(text, opts) {
    return getCardHelpers().addCommentCard(text, opts);
  }

  // ---- Bulk Data Point Input ----

  function showBulkInput(canvasX, canvasY, options) {
    getUiHelpers().showBulkInput(canvasX, canvasY, options);
  }

  function removeBulkInput() {
    getUiHelpers().removeBulkInput();
  }

  function ensureHoverPreview() {
    getUiHelpers().ensureHoverPreview();
  }

  function hideHoverPreview() {
    getUiHelpers().hideHoverPreview();
  }

  function isCreateToolActive() {
    return getUiHelpers().isCreateToolActive();
  }

  function updateHoverPreview(e) {
    getUiHelpers().updateHoverPreview(e);
  }

  // ---- Selection ----

  function notifyCreditTotal() {
    if (!__credits) {
      __credits = __cbCanvasModules.createCreditHelpers({
        cardsRef: () => cards,
        groupsRef: () => groups,
        getCardById,
        getClusters,
      });
    }
    return __credits.notifyCreditTotal();
  }

  function selectCard(id) { clearGroupSelection(); selectedCards.add(id); cards.find((c) => c.id === id)?.el.classList.add("cb-card-selected"); notifySelection(); }
  function clearSelection() { for (const id of selectedCards) cards.find((c) => c.id === id)?.el.classList.remove("cb-card-selected"); selectedCards.clear(); clearGroupSelection(); notifySelection(); }

  function selectGroup(id) {
    clearSelection();
    selectedGroupId = id;
    const g = groups.find((gg) => gg.id === id);
    if (g) g.el.classList.add("cb-group-selected");
  }
  function clearGroupSelection() {
    if (selectedGroupId != null) {
      const g = groups.find((gg) => gg.id === selectedGroupId);
      if (g) g.el.classList.remove("cb-group-selected");
      selectedGroupId = null;
    }
  }
  function notifySelection() { updateSelectionHint(); }


  // ---- Selection hint ----

  function ensureSelectionHint() {
    if (!selectionHintEl && cardContainer) {
      selectionHintEl = document.createElement("div");
      selectionHintEl.className = "cb-selection-hint";
      cardContainer.appendChild(selectionHintEl);
    }
  }

  function updateSelectionHint() {
    ensureSelectionHint();
    if (!selectionHintEl) return;

    if (selectedCards.size >= 2) {
      // Model-backed cluster lookup so the hint hides correctly even
      // when relational membership exists without snap-adjacency
      // (e.g. a table-view link that hasn't yet been laid out into
      // adjacent positions on the canvas).
      const clusters = getClusters();
      const allInOneCluster = clusters.some((cl) => {
        const clSet = new Set(cl.cardIds);
        for (const id of selectedCards) { if (!clSet.has(id)) return false; }
        return true;
      });
      if (allInOneCluster) {
        selectionHintEl.classList.remove("cb-selection-hint-visible");
        return;
      }

      // Cmd+Enter ⇒ waterfall is only valid when ≥2 ER-like cards are
      // selected (createWaterfallFromSelection bails otherwise). We hide
      // the hint segment when it wouldn't fire — keeps the affordance
      // honest for selections that contain DPs / inputs / comments only.
      const erLikeCount = [...selectedCards]
        .map((id) => getCardById(id))
        .filter(
          (c) =>
            c?.data &&
            c.data.type !== "comment" &&
            c.data.type !== "input" &&
            c.data.type !== "dp",
        ).length;
      const showWaterfall = erLikeCount >= 2;

      selectionHintEl.innerHTML = showWaterfall
        ? "<kbd>\u23CE</kbd> link · <kbd>\u21E7\u23CE</kbd> group · <kbd>\u2318\u23CE</kbd> waterfall"
        : "<kbd>\u23CE</kbd> link or <kbd>\u21E7\u23CE</kbd> group";
      positionHintAboveCards([...selectedCards]);
      selectionHintEl.classList.add("cb-selection-hint-visible");
      return;
    }

    selectionHintEl.classList.remove("cb-selection-hint-visible");
  }

  function positionHintAboveCards(cardIds) {
    if (!selectionHintEl) return;
    let minY = Infinity, sumX = 0, sumW = 0, count = 0;
    for (const id of cardIds) {
      const c = getCardById(id);
      if (!c) continue;
      const r = getCardRect(c);
      if (r.y < minY) minY = r.y;
      sumX += r.x + r.w / 2;
      count++;
    }
    if (count === 0) return;
    selectionHintEl.style.left = (sumX / count) + "px";
    selectionHintEl.style.top = (minY - 10) + "px";
  }

  // ---- Selection context menu ----

  function closeSelectionMenu() {
    if (selectionMenuEl) {
      selectionMenuEl.remove();
      selectionMenuEl = null;
    }
  }

  function showSelectionMenu(e) {
    closeSelectionMenu();
    closeGroupColorMenu();

    const menu = document.createElement("div");
    menu.className = "cb-card-context-menu";
    menu.addEventListener("mousedown", (evt) => evt.stopPropagation());

    // "Group as waterfall" is only meaningful when ≥2 selected cards are
    // ER-like (anything that has a provider chain to fold into the new
    // waterfall). Skipping it for selections containing only DPs / inputs /
    // comments matches what createWaterfallFromSelection itself bails on.
    const erLikeSelected = [...selectedCards]
      .map((id) => getCardById(id))
      .filter(
        (c) =>
          c?.data &&
          c.data.type !== "comment" &&
          c.data.type !== "input" &&
          c.data.type !== "dp",
      );
    if (erLikeSelected.length >= 2) {
      const wfBtn = document.createElement("button");
      wfBtn.type = "button";
      wfBtn.className = "cb-card-context-menu-btn";
      wfBtn.textContent = "Group as waterfall";
      wfBtn.addEventListener("click", (evt) => {
        evt.stopPropagation();
        closeSelectionMenu();
        createWaterfallFromSelection();
      });
      menu.appendChild(wfBtn);
    }

    const groupBtn = document.createElement("button");
    groupBtn.type = "button";
    groupBtn.className = "cb-card-context-menu-btn";
    groupBtn.textContent = "Group";
    groupBtn.addEventListener("click", (evt) => {
      evt.stopPropagation();
      closeSelectionMenu();
      groupSelectedCards();
    });
    menu.appendChild(groupBtn);

    const alignBtn = document.createElement("button");
    alignBtn.type = "button";
    alignBtn.className = "cb-card-context-menu-btn";
    alignBtn.textContent = "Align left";
    alignBtn.addEventListener("click", (evt) => {
      evt.stopPropagation();
      closeSelectionMenu();
      let minX = Infinity;
      for (const id of selectedCards) {
        const c = getCardById(id);
        if (c) minX = Math.min(minX, c.x);
      }
      for (const id of selectedCards) {
        const c = getCardById(id);
        if (!c) continue;
        c.x = minX;
        c.el.style.transform = `translate(${c.x}px, ${c.y}px)`;
      }
      updateGroupBounds();
      // Align is a deliberate cosmetic reflow within the existing
      // selection — cards keep their cluster membership regardless of
      // whether the new positions stay snap-adjacent.
      refreshClusters({ dragCardIds: new Set() });
      notifyChange();
    });
    menu.appendChild(alignBtn);

    const alignBottomBtn = document.createElement("button");
    alignBottomBtn.type = "button";
    alignBottomBtn.className = "cb-card-context-menu-btn";
    alignBottomBtn.textContent = "Align bottom";
    alignBottomBtn.addEventListener("click", (evt) => {
      evt.stopPropagation();
      closeSelectionMenu();
      let maxBottom = -Infinity;
      for (const id of selectedCards) {
        const c = getCardById(id);
        if (!c) continue;
        const r = getCardRect(c);
        maxBottom = Math.max(maxBottom, r.y + r.h);
      }
      for (const id of selectedCards) {
        const c = getCardById(id);
        if (!c) continue;
        const r = getCardRect(c);
        c.y = maxBottom - r.h;
        c.el.style.transform = `translate(${c.x}px, ${c.y}px)`;
      }
      updateGroupBounds();
      refreshClusters({ dragCardIds: new Set() });
      notifyChange();
    });
    menu.appendChild(alignBottomBtn);

    document.body.appendChild(menu);
    selectionMenuEl = menu;
    menu.style.left = e.clientX + "px";
    menu.style.top = e.clientY + "px";
  }

  // ---- Canvas context menu (empty-space right-click) ----

  let canvasMenuEl = null;

  function closeCanvasMenu() {
    if (canvasMenuEl) { canvasMenuEl.remove(); canvasMenuEl = null; }
  }

  function showCanvasMenu(e) {
    closeCanvasMenu();
    closeSelectionMenu();
    closeGroupColorMenu();

    const menu = document.createElement("div");
    menu.className = "cb-card-context-menu";
    menu.addEventListener("mousedown", (evt) => evt.stopPropagation());

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "cb-card-context-menu-btn";
    btn.textContent = "Recenter view";
    btn.addEventListener("click", (evt) => {
      evt.stopPropagation();
      closeCanvasMenu();
      recenterView();
    });
    menu.appendChild(btn);

    document.body.appendChild(menu);
    canvasMenuEl = menu;
    menu.style.left = e.clientX + "px";
    menu.style.top = e.clientY + "px";
  }

  // ---- Model picker (AI cards) ----

  function closeModelPicker() {
    getUiHelpers().closeModelPicker();
  }

  function showModelPicker(card, anchorEl) {
    getUiHelpers().showModelPicker(card, anchorEl);
  }

  function applyModel(card, model) {
    getUiHelpers().applyModel(card, model);
  }

  function updateDpCosts() {
    if (!__credits) {
      __credits = __cbCanvasModules.createCreditHelpers({
        cardsRef: () => cards,
        groupsRef: () => groups,
        getCardById,
        getClusters,
      });
    }
    return __credits.updateDpCosts();
  }

  function updateDefaultFillRates(records) {
    return getCardHelpers().updateDefaultFillRates(records);
  }

  function updateDefaultFrequencies(globalFreqId) {
    return getCardHelpers().updateDefaultFrequencies(globalFreqId);
  }

  function applyClusterFrequency(originCardId, freqId) {
    return getCardHelpers().applyClusterFrequency(originCardId, freqId);
  }

  // Public hook used by overlay.js when the global frequency changes — it
  // lets the summary bar re-run the credit math without having to know about
  // the internal notifyCreditTotal function.
  function refreshCreditTotal() {
    return notifyCreditTotal();
  }

  // ---- Groups ----

  function createGroupLabel(initialValue) {
    return getGroupLifecycleHelpers().createGroupLabel(initialValue);
  }

  function groupSelectedCards(initialLabel, opts) {
    getGroupLifecycleHelpers().groupSelectedCards(initialLabel, opts);
  }

  // Programmatic counterpart to the Shift+Enter shortcut: wraps a known set
  // of card ids in a real cb-group with `label` as the editable title.
  // Used by the POC importer so each Use Case becomes a labeled group
  // (rather than a comment-card cluster). Implementation drives the
  // existing groupSelectedCards path by temporarily seeding the selection
  // with the target ids — that way one code path owns group lifecycle,
  // theming, credit recompute, and undo bookkeeping.
  function groupCardsByIds(cardIds, label, opts) {
    if (!Array.isArray(cardIds) || cardIds.length < 2) return;
    for (const id of selectedCards) {
      cards.find((c) => c.id === id)?.el.classList.remove("cb-card-selected");
    }
    selectedCards.clear();
    clearGroupSelection();
    for (const id of cardIds) {
      const c = cards.find((cc) => cc.id === id);
      if (!c) continue;
      selectedCards.add(id);
      c.el?.classList.add("cb-card-selected");
    }
    groupSelectedCards(label || "", { skipFocus: true, ...(opts || {}) });
  }

  function disbandGroup(id) {
    getGroupLifecycleHelpers().disbandGroup(id);
  }

  function updateGroupBounds() {
    getGroupLifecycleHelpers().updateGroupBounds();
  }

  function updateGroupCredits() {
    if (!__credits) {
      __credits = __cbCanvasModules.createCreditHelpers({
        cardsRef: () => cards,
        groupsRef: () => groups,
        getCardById,
        getClusters,
      });
    }
    return __credits.updateGroupCredits();
  }

  function startGroupDrag(group, e) {
    getGroupLifecycleHelpers().startGroupDrag(group, e);
  }

  // ---- Link selected cards ----
  //
  // Canvas Enter shortcut. Delegates to the relational
  // `linkCardsByIds` helper so the magnet-link UX shares one code path
  // with the table view's "Link" action — both flow through
  // assignToCluster + layoutCardsAsCluster, which preserves the legacy
  // bucketing layout (comments on top, inputs LEFT, DPs grid, ERs RIGHT)
  // while making cluster membership relational instead of geometry-
  // implicit.
  function linkSelectedCards() {
    if (selectedCards.size < 2) return;
    const ids = [...selectedCards];
    const targetClusterId = linkCardsByIds(ids);
    if (targetClusterId == null) return;
    updateGroupBounds();
    // Membership was just set explicitly via linkCardsByIds; the
    // refreshClusters call here is purely confirmatory + cosmetic
    // (renderClusterOutlines, updateDpCosts). Skip demotion so any
    // unrelated card that happens to have lost snap-adjacency for
    // unrelated reasons doesn't get clobbered.
    refreshClusters({ dragCardIds: new Set() });
    notifyChange();
  }

  // ---- Create waterfall from selection (Cmd+Enter) ----
  //
  // Collapse 2+ selected ER-like cards into a single composite waterfall
  // card. The source cards are CONSUMED (deleted) and their actionKey /
  // packageId / credits become the providers[] inside the new card. The
  // new card lands at the bbox center of the consumed cards and its title
  // is auto-focused so the user can type the waterfall name immediately.
  //
  // Comment / input / DP cards in the selection are skipped — they don't
  // map to providers and would be silently destroyed otherwise.
  function createWaterfallFromSelection() {
    if (selectedCards.size < 2) return;
    const all = [...selectedCards].map((id) => getCardById(id)).filter(Boolean);

    // Sort by current position so the resulting provider chain reads
    // top-to-bottom, left-to-right — matching how the user laid the cards
    // out spatially.
    const sources = all
      .filter((c) =>
        c.data &&
        c.data.type !== "comment" &&
        c.data.type !== "input" &&
        c.data.type !== "dp",
      )
      .sort((a, b) => a.y - b.y || a.x - b.x);

    if (sources.length < 2) return;

    const providers = sources.map((c) => ({
      actionKey: c.data.actionKey,
      packageId: c.data.packageId,
      displayName: c.data.displayName || c.data.text || "Provider",
      packageName: c.data.packageName,
      iconUrl: c.data.iconUrl,
      iconSvgHtml: c.data.iconSvgHtml,
      credits: typeof c.data.credits === "number" ? c.data.credits : null,
      isAi: !!c.data.isAi,
      modelOptions: c.data.modelOptions ?? null,
      selectedModel: c.data.selectedModel ?? null,
      requiresApiKey: !!c.data.requiresApiKey,
    }));

    // Use the first source card's groupCluster (if any) so the new
    // waterfall card inherits the cluster membership of the cards it
    // replaces. Picking the first one is a heuristic — when cards from
    // multiple clusters are selected we'd lose information either way.
    const groupCluster = sources[0].data.groupCluster ?? null;

    const wfData = window.__cb.buildWaterfallCardData({
      displayName: "",
      providers,
      attributeEnum: null,
      packageId: "clay",
      validationPrice: 0,
      actionExecutions: 1,
      groupCluster,
    });

    // Drop the new card at the centroid of the consumed cards. We use the
    // first card's measured rect as the proxy for w/h (all canvas cards
    // share the same width and an ER-like card's height is uniform too).
    const r0 = getCardRect(sources[0]);
    const centerX =
      sources.reduce((s, c) => s + c.x + r0.w / 2, 0) / sources.length;
    const centerY =
      sources.reduce((s, c) => s + c.y + r0.h / 2, 0) / sources.length;
    const wfX = Math.round(centerX - r0.w / 2);
    const wfY = Math.round(centerY - r0.h / 2);

    // Delete sources first so removeCard's selection / cluster bookkeeping
    // settles before the new card lands. We collected sources up front so
    // mutating selectedCards inside removeCard doesn't disturb our list.
    const sourceIds = sources.map((c) => c.id);
    for (const id of sourceIds) removeCard(id);

    const newCard = addCard(wfData, { x: wfX, y: wfY });

    // Auto-focus the title so the user can name the waterfall immediately.
    // Defer to rAF so the cb-card-name node is mounted; selectAll-style
    // caret placement isn't worth the complexity here — empty editable
    // shows the placeholder and any keystroke replaces it.
    if (newCard?.el) {
      requestAnimationFrame(() => {
        const nameEl = newCard.el.querySelector(".cb-card-name");
        if (nameEl) nameEl.focus();
      });
    }

    clearSelection();
    // The waterfall card replaces the consumed source cards; survivors
    // that didn't take part in the collapse keep their cluster
    // membership. Empty dragCardIds prevents accidental demotion.
    refreshClusters({ dragCardIds: new Set() });
    notifyChange();
    if (window.__cb.saveTabs) window.__cb.saveTabs();
  }

  // Re-position the Y of every card in each cluster so the snap mechanism
  // can keep them magneted across a card-height change. Called by
  // setProMode in overlay.js: at toggle time card width stays at 220px but
  // height changes between 70 and 96, opening (or closing) gaps that snap
  // adjacency (1px tolerance) can't bridge. We compute each member's row
  // index in the OLD layout, then re-emit at `leadY + row * newH`. X
  // positions are untouched. Singletons (clusters of size < 2) are filtered
  // out by getClusters already, so isolated cards aren't affected.
  function applyClusterReflow(clusters, oldH, newH) {
    if (!clusters || oldH === newH) return;
    for (const cluster of clusters) {
      if (!cluster || cluster.length < 2) continue;
      const members = cluster.map((id) => getCardById(id)).filter(Boolean);
      if (members.length < 2) continue;
      const leadY = Math.min(...members.map((c) => c.y));
      for (const c of members) {
        const row = Math.round((c.y - leadY) / oldH);
        c.y = leadY + row * newH;
        if (c.el) c.el.style.transform = `translate(${c.x}px, ${c.y}px)`;
        // Stream new positions to peers so collaborators tracking the
        // canvas don't fall out of sync. Cross-user Pro Mode mismatches
        // can still cause transient magnet desync — a known caveat.
        if (__cb.realtime?.broadcastCardMove) {
          __cb.realtime.broadcastCardMove(c.id, c.x, c.y);
        }
      }
    }
    // Pro Mode reflow re-pitches Y values within each existing cluster
    // so members stay snap-adjacent across the height change. No
    // membership changes are intended here, so skip demotion.
    refreshClusters({ dragCardIds: new Set() });
    notifyChange();
  }

  // ---- Selection box ----

  function startSelectionBox(e) {
    const pt = screenToCanvas(e.clientX, e.clientY);
    const el = document.createElement("div"); el.className = "cb-selection-box"; cardContainer.appendChild(el);
    selBoxState = { startX: pt.x, startY: pt.y, el };
  }
  function updateSelectionBox(e) {
    if (!selBoxState) return;
    const pt = screenToCanvas(e.clientX, e.clientY);
    const x = Math.min(selBoxState.startX, pt.x), y = Math.min(selBoxState.startY, pt.y);
    const w = Math.abs(pt.x - selBoxState.startX), h = Math.abs(pt.y - selBoxState.startY);
    selBoxState.el.style.transform = `translate(${x}px, ${y}px)`; selBoxState.el.style.width = w + "px"; selBoxState.el.style.height = h + "px";
    clearSelection();
    for (const c of cards) { const cr = getCardRect(c); if (cr.x < x + w && cr.x + cr.w > x && cr.y < y + h && cr.y + cr.h > y) selectCard(c.id); }
  }
  function endSelectionBox() { if (selBoxState) { selBoxState.el.remove(); selBoxState = null; } }

  // ---- Global mouse ----

  function mouseEventToPreviewParams(e) {
    return {
      clientX: e.clientX, clientY: e.clientY,
      metaKey: e.metaKey, ctrlKey: e.ctrlKey,
      altKey: e.altKey, shiftKey: e.shiftKey,
      target: e.target,
    };
  }

  function onMouseMove(e) {
    lastMouse = { clientX: e.clientX, clientY: e.clientY };
    if (toolClickPending) {
      const dx = e.clientX - toolClickPending.x;
      const dy = e.clientY - toolClickPending.y;
      if (Math.abs(dx) > 5 || Math.abs(dy) > 5) toolClickPending = null;
    }
    if (dragState) {
      hideHoverPreview();
      if (!dragState.hasMoved) {
        const moveX = Math.abs(e.clientX - dragState.startMouseX);
        const moveY = Math.abs(e.clientY - dragState.startMouseY);
        dragState.hasMoved = moveX > 3 || moveY > 3;
      }
      const dx = (e.clientX - dragState.startMouseX) / scale, dy = (e.clientY - dragState.startMouseY) / scale;
      for (const [cid, sp] of dragState.startPositions) { const c = cards.find((cc) => cc.id === cid); if (!c) continue; c.x = sp.x + dx; c.y = sp.y + dy; }
      const snap = getSnapHelpers().findSnapTarget(new Set(dragState.startPositions.keys()), dragState.cardId);
      for (const [cid, sp] of dragState.startPositions) {
        const c = cards.find((cc) => cc.id === cid);
        if (!c) continue;
        c.x = sp.x + dx + snap.dx;
        c.y = sp.y + dy + snap.dy;
        c.el.style.transform = `translate(${c.x}px, ${c.y}px)`;
        // Stream the position to peers (Tier D). Realtime handles per-card
        // throttling internally so this is cheap even at native mousemove rate.
        if (__cb.realtime?.broadcastCardMove) {
          __cb.realtime.broadcastCardMove(c.id, c.x, c.y);
        }
      }
      updateGroupBounds(); updateSelectionHint(); return;
    }
    if (groupDragState) {
      hideHoverPreview();
      if (!groupDragState.hasMoved) {
        const moveX = Math.abs(e.clientX - groupDragState.startMouseX);
        const moveY = Math.abs(e.clientY - groupDragState.startMouseY);
        groupDragState.hasMoved = moveX > 3 || moveY > 3;
      }
      if (!groupDragState.hasMoved) return;
      const dx = (e.clientX - groupDragState.startMouseX) / scale, dy = (e.clientY - groupDragState.startMouseY) / scale;
      for (const [cid, sp] of groupDragState.startPositions) {
        const c = cards.find((cc) => cc.id === cid);
        if (!c) continue;
        c.x = sp.x + dx;
        c.y = sp.y + dy;
        c.el.style.transform = `translate(${c.x}px, ${c.y}px)`;
        if (__cb.realtime?.broadcastCardMove) {
          __cb.realtime.broadcastCardMove(c.id, c.x, c.y);
        }
      }
      updateGroupBounds(); return;
    }
    if (panState) { hideHoverPreview(); panX = panState.startPanX + (e.clientX - panState.startMouseX); panY = panState.startPanY + (e.clientY - panState.startMouseY); applyTransform(); return; }
    if (selBoxState) { hideHoverPreview(); updateSelectionBox(e); return; }
    updateHoverPreview(mouseEventToPreviewParams(e));
  }

  function onMouseUp(e) {
    if (toolClickPending) {
      hideHoverPreview();
      const pending = toolClickPending;
      toolClickPending = null;
      endSelectionBox();
      const pt = screenToCanvas(pending.x, pending.y);
      if (activeTool === "dp") {
        // Ordering matters: Alt wins (matches the hover-preview state machine
        // in ui.js), then Cmd+Shift (bulk input) wins over plain Shift (bulk
        // DP) and plain Cmd (single input). `pending.metaKey` is already
        // normalized to `e.metaKey || e.ctrlKey` at mousedown time, so
        // Ctrl+Shift works the same on Windows/Linux.
        if (pending.altKey) {
          const card = addCommentCard("", { x: pt.x, y: pt.y });
          requestAnimationFrame(() => {
            const textEl = card.el.querySelector(".cb-comment-text");
            if (textEl) textEl.focus();
          });
        } else if (pending.metaKey && pending.shiftKey) {
          showBulkInput(pt.x, pt.y, { type: "input" });
        } else if (pending.shiftKey) {
          showBulkInput(pt.x, pt.y);
        } else if (pending.metaKey) {
          const card = addInputCard("", { x: pt.x, y: pt.y });
          requestAnimationFrame(() => {
            const textEl = card.el.querySelector(".cb-input-text");
            if (textEl) textEl.focus();
          });
        } else {
          const card = addDataPointCard("", { x: pt.x, y: pt.y });
          requestAnimationFrame(() => {
            const textEl = card.el.querySelector(".cb-dp-text");
            if (textEl) textEl.focus();
          });
        }
      } else if (activeTool === "er") {
        if (__cb.onEnrichmentToolClick) __cb.onEnrichmentToolClick(pt.x, pt.y);
      }
      return;
    }
    if (dragState) {
      const pendingDrag = dragState;
      dragState = null;
      if (pendingDrag.hasMoved) {
        // Card drag-end is THE explicit "I moved these" signal that
        // earns demotion: a card the user dragged out of a cluster
        // legitimately leaves it. Pass the dragged ids so unrelated
        // cards keep their saved clusterId regardless of geometry.
        const dragCardIds = new Set(pendingDrag.startPositions.keys());
        refreshClusters({ dragCardIds });
        notifyChange();
      }
      return;
    }
    if (groupDragState) {
      const gid = groupDragState.groupId;
      const wasMoved = groupDragState.hasMoved;
      const dragCardIds = new Set(groupDragState.startPositions.keys());
      groupDragState = null;
      if (wasMoved) {
        // Same scoping as card drag — every card that moved with the
        // group is eligible for demotion / re-bucketing; everyone else
        // keeps their cluster.
        refreshClusters({ dragCardIds });
        notifyChange();
      } else {
        selectGroup(gid);
      }
      return;
    }
    if (panState) { panState = null; return; }
    if (selBoxState) endSelectionBox();
    updateHoverPreview(mouseEventToPreviewParams(e));
  }

  function onCanvasMouseDown(e) {
    if (e.target !== canvasArea && e.target !== cardContainer) return;
    const editingDp = cardContainer?.querySelector(".cb-dp-text:focus");
    if (editingDp) {
      editingDp.blur();
      return;
    }
    hideHoverPreview();
    closeSelectionMenu();
    closeGroupColorMenu();
    closeCanvasMenu();
    if (e.button === 1) { e.preventDefault(); panState = { startMouseX: e.clientX, startMouseY: e.clientY, startPanX: panX, startPanY: panY }; return; }
    if (e.button === 0) {
      if (spaceHeld) {
        panState = { startMouseX: e.clientX, startMouseY: e.clientY, startPanX: panX, startPanY: panY };
      } else if (activeTool) {
        toolClickPending = { x: e.clientX, y: e.clientY, shiftKey: e.shiftKey, metaKey: e.metaKey || e.ctrlKey, altKey: e.altKey };
        clearSelection();
        startSelectionBox(e);
      } else {
        clearSelection();
        startSelectionBox(e);
      }
    }
  }

  function onWheel(e) {
    if (!e.ctrlKey && !e.metaKey) { panX -= e.deltaX; panY -= e.deltaY; applyTransform(); return; }
    e.preventDefault();
    const rect = canvasArea.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    const prev = scale; scale = Math.min(3, Math.max(0.15, scale - e.deltaY * 0.002));
    const ratio = scale / prev; panX = mx - ratio * (mx - panX); panY = my - ratio * (my - panY);
    applyTransform();
  }

  function zoomBy(delta) {
    const rect = canvasArea.getBoundingClientRect();
    const mx = rect.width / 2, my = rect.height / 2;
    const prev = scale;
    scale = Math.min(3, Math.max(0.15, scale + delta));
    const ratio = scale / prev;
    panX = mx - ratio * (mx - panX);
    panY = my - ratio * (my - panY);
    applyTransform();
  }

  function recenterView() {
    if (cards.length === 0) return;
    const rect = canvasArea.getBoundingClientRect();
    const vw = rect.width, vh = rect.height;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const c of cards) {
      const r = getCardRect(c);
      minX = Math.min(minX, r.x);
      minY = Math.min(minY, r.y);
      maxX = Math.max(maxX, r.x + r.w);
      maxY = Math.max(maxY, r.y + r.h);
    }
    const bw = maxX - minX, bh = maxY - minY;
    const pad = 60;
    const fitScale = Math.min((vw - pad * 2) / bw, (vh - pad * 2) / bh, 1);
    scale = Math.max(0.15, Math.min(3, fitScale));
    panX = (vw - bw * scale) / 2 - minX * scale;
    panY = (vh - bh * scale) / 2 - minY * scale;
    applyTransform();
  }

  // ---- Keyboard ----

  function onKeyDown(e) {
    if ((e.metaKey || e.ctrlKey) && e.key === "z" && !isEditingText(e)) {
      e.preventDefault();
      if (e.shiftKey) redo();
      else undo();
      return;
    }
    if (e.code === "Space" && !e.repeat && !isEditingText(e)) {
      e.preventDefault();
      spaceHeld = true;
      if (canvasArea) canvasArea.classList.add("cb-space-pan");
    }
    if (e.key === "Escape" && selectionMenuEl) {
      closeSelectionMenu();
      return;
    }
    if (e.key === "Escape" && groupColorMenuEl) {
      closeGroupColorMenu();
    }
    if (e.key === "Escape" && selectedGroupId != null) {
      clearGroupSelection();
    }
    if (e.key === "Enter" && !isEditingText(e) && selectedCards.size >= 2) {
      e.preventDefault();
      // Cmd/Ctrl+Enter: collapse the selection into a single waterfall card.
      // Shift+Enter:    group (existing).
      // Plain Enter:    link / cluster (existing).
      if (e.metaKey || e.ctrlKey) createWaterfallFromSelection();
      else if (e.shiftKey) groupSelectedCards();
      else linkSelectedCards();
    }
    if ((e.key === "Delete" || e.key === "Backspace") && !isEditingText(e) && (selectedCards.size > 0 || selectedGroupId != null)) {
      e.preventDefault();
      if (selectedGroupId != null) {
        const gid = selectedGroupId;
        clearGroupSelection();
        disbandGroup(gid);
      }
      for (const id of [...selectedCards]) removeCard(id);
    }
    if (!isEditingText(e) && !e.metaKey && !e.ctrlKey && !e.altKey) {
      if (e.key === "1") { if (__cb.setCanvasMode) __cb.setCanvasMode("navigate"); return; }
      if (e.key === "2") { if (__cb.setCanvasMode) __cb.setCanvasMode("dp"); return; }
      if (e.key === "3") { if (__cb.setCanvasMode) __cb.setCanvasMode("er"); return; }
    }
    if (lastMouse && (e.key === "Meta" || e.key === "Control" || e.key === "Alt" || e.key === "Shift")) {
      updateHoverPreview({
        ...lastMouse,
        metaKey: e.metaKey, ctrlKey: e.ctrlKey,
        altKey: e.altKey, shiftKey: e.shiftKey,
        target: null,
      });
    }
  }

  function onKeyUp(e) {
    if (e.code === "Space") {
      spaceHeld = false;
      if (canvasArea) canvasArea.classList.remove("cb-space-pan");
    }
    if (lastMouse && (e.key === "Meta" || e.key === "Control" || e.key === "Alt" || e.key === "Shift")) {
      updateHoverPreview({
        ...lastMouse,
        metaKey: e.metaKey, ctrlKey: e.ctrlKey,
        altKey: e.altKey, shiftKey: e.shiftKey,
        target: null,
      });
    }
  }

  function isEditingText(e) {
    const tag = e.target.tagName;
    return tag === "INPUT" || tag === "TEXTAREA" || e.target.isContentEditable;
  }

  // ---- Serialize / Restore ----

  function serialize() {
    return getPersistenceHelpers().serialize();
  }

  function restoreGroup(gs) {
    getGroupLifecycleHelpers().restoreGroup(gs);
  }

  function restore(state, opts) {
    // Always clear before re-applying. Without this, repeated restores (live
    // save propagation in particular) accumulate duplicate cards/groups in
    // both the cards array and the DOM, because addCard and friends never
    // check for existing ids. No-op when the canvas is already empty (first
    // restore on canvas open / tab switch). Mirrors the explicit clear that
    // undo/redo already do before calling persistence.restore.
    clearCanvas();
    // Lazy DOM (C2.2): the caller MAY declare whether this tab should mount
    // canvas DOM. Table-view tabs pass mountDom:false → the persistence build
    // loop's addX calls stay data-only (they self-gate on isDomHydrated());
    // canvas-view tabs pass mountDom:true → DOM mounts during the build, as
    // before. Callers that omit mountDom (remote canvas/tab sync, tab switch)
    // are re-restoring into whatever view is already showing, so we preserve
    // the current hydration state. Set BEFORE persistence.restore so the build
    // loop sees it.
    if (opts && typeof opts.mountDom === "boolean") {
      domHydrated = opts.mountDom;
    }
    getPersistenceHelpers().restore(state);
    // Visuals-only after restore: the saved state already carries the
    // relational cluster model (or has just been backfilled from snap
    // by persistence). Running a full snap-reconcile here would
    // clobber saved membership when overlay.js hasn't yet applied the
    // saved Pro Mode pitch — the next user-initiated geometry change
    // (drag-end) goes through the full refreshClusters path and re-
    // reconciles from snap with the correct card heights. No-ops when
    // unhydrated (table-view tab) — hydrateCanvasDom runs it on toggle.
    refreshClusterVisuals();
    lastSnapshot = captureSnapshot();
    undoStack = [];
    redoStack = [];
  }

  // Mount canvas DOM for every card on first switch to the canvas view
  // (C2.2). Idempotent: a no-op once hydrated, so the overlay can call it
  // unconditionally before revealing the canvas. We flip domHydrated BEFORE
  // the work so the guarded ops below (refreshClusters → snap, credit DOM)
  // run for real. Groups stay eager, so their elements already exist; we
  // re-derive their bounds here because they were sized against default card
  // boxes while the cards were data-only during the table-view restore.
  function hydrateCanvasDom() {
    if (domHydrated) return;
    domHydrated = true;
    const helpers = getCardHelpers();
    for (const c of cards) helpers.mountCardElForType(c);
    refreshClusters({ dragCardIds: new Set() });
    notifyCreditTotal();
    updateDpCosts();
    updateGroupCredits();
    updateGroupBounds();
  }

  // ---- Init / Destroy ----

  function init(areaEl) {
    canvasArea = areaEl;
    svgLayer = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svgLayer.setAttribute("class", "cb-svg-layer");
    svgLayer.innerHTML = '';
    canvasArea.appendChild(svgLayer);
    cardContainer = document.createElement("div"); cardContainer.className = "cb-card-container"; canvasArea.appendChild(cardContainer);
    canvasArea.addEventListener("mousedown", onCanvasMouseDown);
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("keyup", onKeyUp);
    document.addEventListener("mousedown", onDocumentMouseDown);
    canvasArea.addEventListener("wheel", onWheel, { passive: false });
    canvasArea.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      if (e.target === canvasArea || e.target === cardContainer) {
        showCanvasMenu(e);
      }
    });
    return api;
  }

  function destroy() {
    cards = []; groups = []; selectedCards.clear(); selectedGroupId = null;
    dragState = panState = selBoxState = groupDragState = null;
    toolClickPending = null; activeTool = null;
    closeGroupColorMenu();
    closeSelectionMenu();
    closeCanvasMenu();
    getUiHelpers().destroy();
    if (selectionHintEl) { selectionHintEl.remove(); selectionHintEl = null; }
    panX = panY = 0; scale = 1; nextCardId = nextGroupId = nextClusterId = 1;
    if (canvasArea) { canvasArea.removeEventListener("mousedown", onCanvasMouseDown); canvasArea.removeEventListener("wheel", onWheel); }
    document.removeEventListener("mousemove", onMouseMove); document.removeEventListener("mouseup", onMouseUp);
    document.removeEventListener("keydown", onKeyDown); document.removeEventListener("keyup", onKeyUp);
    document.removeEventListener("mousedown", onDocumentMouseDown);
    spaceHeld = false;
    undoStack = [];
    redoStack = [];
    lastSnapshot = null;
    // Reset the lazy-DOM gate so the next openCanvas starts unhydrated and the
    // first restore re-establishes it from the tab's saved view.
    domHydrated = false;
    canvasArea = svgLayer = cardContainer = null;
  }

  function setActiveTool(tool) {
    activeTool = tool;
    if (canvasArea) {
      canvasArea.classList.toggle("cb-tool-active", isCreateToolActive());
    }
    if (!isCreateToolActive()) {
      hideHoverPreview();
    } else if (lastMouse) {
      updateHoverPreview({
        ...lastMouse,
        metaKey: false, ctrlKey: false,
        altKey: false, shiftKey: false,
        target: null,
      });
    }
  }

  function getActiveTool() { return activeTool; }

  function onDocumentMouseDown(e) {
    if (selectionMenuEl && !selectionMenuEl.contains(e.target)) {
      closeSelectionMenu();
    }
    if (groupColorMenuEl && !groupColorMenuEl.contains(e.target)) {
      closeGroupColorMenu();
    }
    if (canvasMenuEl && !canvasMenuEl.contains(e.target)) {
      closeCanvasMenu();
    }
  }

  const api = {
    addCard, addDataPointCard, addInputCard, addCommentCard, groupSelectedCards,
    groupCardsByIds,
    // Live snapshot of cb-groups (the labeled card containers Shift+Enter
    // creates). Read-only consumers — currently the table view, which
    // renders group-titled sections — should treat the returned objects
    // as plain data. The label is read out of the input element each
    // call, mirroring how persistence.js serializes groups, so renames
    // propagate without callers having to subscribe to anything extra.
    getGroups: () => groups.map((g) => ({
      id: g.id,
      level: g.level,
      cardIds: Array.from(g.cardIds),
      label: g.el?.querySelector(".cb-group-label")?.value || "",
    })),
    destroy, serialize, restore, setActiveTool, getActiveTool,
    // Lazy canvas DOM (C2.2). hydrateCanvasDom mounts every card element on
    // first switch to the canvas view (idempotent); isDomHydrated lets
    // callers (and verification) check whether canvas DOM is currently built.
    hydrateCanvasDom,
    isDomHydrated: () => domHydrated,
    zoomIn: () => zoomBy(0.15),
    zoomOut: () => zoomBy(-0.15),
    refreshClusters,
    getCardById,
    // Live snapshot of cluster membership backed by the explicit
    // `card.clusterId` model. Both the canvas (credits) and the table
    // view read this. Returns clusters of size >= 2 only — singletons
    // are filtered out for parity with the previous getSnapClusters
    // shape that callers were built against.
    getClusters,
    // Same shape as the legacy getSnapClusters() (array of cardId
    // arrays). Kept as a separate accessor so callers that only need
    // the cardIds don't have to map themselves; new code should prefer
    // getClusters() because the {id, cardIds} shape lets you address
    // a specific cluster.
    getSnapClusters: getClusterCardIds,
    // Programmatic write paths — use these from the table view instead
    // of stacking x/y to imply cluster membership. assignToCluster sets
    // the relational id; layoutCardsAsCluster repositions the cards
    // into a snap-adjacent arrangement so canvas geometry agrees;
    // linkCardsByIds is the convenience that does both.
    assignToCluster,
    layoutCardsAsCluster,
    linkCardsByIds,
    // Find clusters whose members aren't all snap-adjacent and re-run
    // layoutCardsAsCluster to bring them back together. Called by
    // overlay.js on table → canvas view switch so a session of
    // table-side editing doesn't leave the canvas with scattered
    // cluster members. Returns true if any cluster moved (caller is
    // responsible for notifyChange + a follow-up refreshClusters).
    tightenBrokenClusters,
    // Mint a fresh cluster id without assigning anyone to it. Used by
    // adjacency-driven adders (picker, attach-DP-to-orphan) that need
    // the new card to be in a cluster from the moment addCard's
    // internal notifyChange propagates to the table view — without
    // this, refreshClusters' snap-reconcile only assigns membership
    // AFTER addCard's notifyChange has already triggered a table-view
    // render, leaving the new card visibly unlinked until the next
    // refresh. Callers should follow up with assignToCluster on the
    // existing target so the new card joins a real (size >= 2)
    // cluster from the first render.
    allocateClusterId,
    applyClusterReflow,
    // Live snapshot of the cards array. External read-only consumers (e.g. the
    // export-as-table modal) need this to enumerate every card. Mutating the
    // returned array directly would corrupt internal state — go through addCard
    // / removeCard / card.data setters instead.
    getCards: () => cards.slice(),
    // Per-imported-table metadata (source row count + import time + name +
    // color), keyed by source tableId. setImportedTable is called by the
    // import flow once per table; getImportedTables feeds the table-view
    // per-table headers and repairs tableName/importColor on reload.
    getImportedTables: () => ({ ...importedTables }),
    setImportedTable: (tableId, meta) => {
      if (!tableId) return;
      importedTables[tableId] = { ...(importedTables[tableId] || {}), ...(meta || {}) };
    },
    // Exposed so external editors (e.g. the export-as-table modal) can mark
    // canvas-data edits — both for undo history and for kicking the
    // debounced save / collaborator refresh that onCanvasStateChange does.
    notifyChange,
    showBulkInput,
    recenterView,
    updateDefaultFillRates,
    updateDefaultFrequencies,
    applyClusterFrequency,
    refreshCreditTotal,
    updateGroupCredits,
    // Exposed for the cursor overlay: cursors are rendered inside cardContainer
    // so they inherit pan/zoom. screenToCanvas converts mousemove events from
    // viewport pixels to the canvas's coordinate space before broadcasting.
    getCardContainer: () => cardContainer,
    getCanvasArea: () => canvasArea,
    screenToCanvas,
    // Exposed for live-actions.js: lets remote cardMove apply safely check
    // whether we're dragging this card ourselves (local-drag-wins rule) and
    // re-run the post-move bookkeeping we'd normally do inside onMouseMove.
    isDraggingCard: (cardId) =>
      !!(
        (dragState?.startPositions && dragState.startPositions.has(cardId)) ||
        (groupDragState?.startPositions && groupDragState.startPositions.has(cardId))
      ),
    updateGroupBounds,
  };
  __cb.initCanvas = init;
})();
