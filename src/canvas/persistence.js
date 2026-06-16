(function () {
  "use strict";

  window.__cbCanvasModules = window.__cbCanvasModules || {};

  window.__cbCanvasModules.createPersistenceHelpers = function createPersistenceHelpers(deps) {
    const {
      cardsRef,
      groupsRef,
      panRef,
      nextIdsRef,
      // Per-imported-table metadata map { [tableId]: { name, importColor,
      // recordCount, importedAt } }. Optional for back-compat with older
      // canvas modules that don't supply it.
      importedTablesRef,
      setImportedTables,
      setPanScale,
      setNextIds,
      applyTransform,
      addCard,
      addDataPointCard,
      addInputCard,
      addCommentCard,
      restoreGroup,
      updateDpCosts,
      setRestoring,
      // Invoked once after restore() rebuilds the cards: derives clusterId for
      // every ER + its lineage data points (clusterByLineage). Lives in
      // canvas/index.js so persistence stays decoupled from the cluster model.
      deriveClusters,
    } = deps;

    function serialize() {
      // Each branch syncs the latest contentEditable text back onto c.data
      // before snapshotting. With lazy canvas DOM (C2.2) a card can be
      // data-only (c.el === null) while a table-view tab is open — and
      // serialize() runs on that surface too (every notifyChange / save, and
      // at the end of restore). When there's no element, c.data already holds
      // the current text, so `c.el?.` simply skips the DOM read.
      for (const c of cardsRef()) {
        if (c.data.type === "dp") {
          const textEl = c.el?.querySelector(".cb-dp-text");
          if (textEl) {
            c.data.text = textEl.textContent;
            c.data.displayName = textEl.textContent;
          }
        } else if (c.data.type === "input") {
          const textEl = c.el?.querySelector(".cb-input-text");
          if (textEl) {
            c.data.text = textEl.textContent;
            c.data.displayName = textEl.textContent;
          }
        } else if (c.data.type === "comment") {
          const textEl = c.el?.querySelector(".cb-comment-text");
          if (textEl) {
            c.data.text = textEl.textContent;
            c.data.displayName = textEl.textContent;
          }
        } else if (c.data.isAi || c.data.type === "waterfall") {
          // Waterfall cards have an editable title (same contentEditable
          // .cb-card-name element as AI cards) so their displayName can
          // drift from c.data while the user is typing. Sync from DOM at
          // serialize time so undo / reload / realtime sees the latest.
          const nameEl = c.el?.querySelector(".cb-card-name");
          if (nameEl) c.data.displayName = nameEl.textContent;
        }
      }
      const nextIds = nextIdsRef();
      const pan = panRef();
      return {
        // `clusterId` is a first-class relational field — both the canvas
        // and the table view read cluster membership from this directly
        // instead of re-deriving from x/y on every render. Cards that
        // aren't in any cluster carry `clusterId: null` (and are filtered
        // out of getClusters() — singletons aren't returned).
        //
        // `tableOrder` decouples table-view row order from canvas
        // geometry. Null = sort by y in the table (legacy behavior /
        // cards never reordered in the table). Set by the table view's
        // performDrop and survives reload + realtime sync. Ignored
        // anywhere outside the table view.
        cards: cardsRef().map((c) => ({
          id: c.id,
          x: c.x,
          y: c.y,
          data: c.data,
          groupId: c.groupId,
          clusterId: c.clusterId ?? null,
          tableOrder: c.tableOrder ?? null,
        })),
        // Groups are pure data now: membership is each card's `groupId`
        // (serialized above) and nesting is `parentId`. No cardIds, no DOM read.
        //
        // Table-native fields (v7.23+): the table view owns the hierarchy. A
        // top-level group (parentId null) is a "use case" carrying records +
        // frequency + its import source; `kind` flags special groups (e.g.
        // waterfall, Phase 2); `order` is the explicit sibling order (replaces
        // the canvas-y fallback). `level`/`color` are legacy canvas fields kept
        // only so the deprecated canvas renderer doesn't choke on the blob.
        groups: groupsRef().map((g) => ({
          id: g.id,
          label: g.label || "",
          parentId: g.parentId ?? null,
          kind: g.kind || "group",
          order: g.order ?? null,
          source: g.source || null,
          tableId: g.tableId ?? null,
          viewId: g.viewId ?? null,
          records: g.records ?? null,
          frequency: g.frequency ?? null,
          clusterKey: g.clusterKey ?? null,
          level: g.level || 0,
          color: g.color || null,
        })),
        view: { panX: pan.panX, panY: pan.panY, scale: pan.scale },
        nextCardId: nextIds.nextCardId,
        nextGroupId: nextIds.nextGroupId,
        nextClusterId: nextIds.nextClusterId,
        // Per-imported-table metadata (source row count + import time + name +
        // color). Keyed by source tableId. Survives reload + realtime sync.
        importedTables: importedTablesRef ? importedTablesRef() : {},
      };
    }

    function restore(state) {
      if (!state) return;
      setRestoring(true);
      // Per-imported-table metadata. Legacy state has none → reset to {} so a
      // tab switch doesn't leak the previous tab's table headers.
      if (setImportedTables) {
        setImportedTables(state.importedTables && typeof state.importedTables === "object"
          ? state.importedTables
          : {});
      }
      if (state.view) {
        setPanScale({
          panX: state.view.panX ?? 0,
          panY: state.view.panY ?? 0,
          scale: state.view.scale ?? 1,
        });
        applyTransform();
      }
      for (const cs of state.cards || []) {
        if (cs.data.type === "dp") {
          // Pass through everything that influences the visible state so
          // reloads preserve the user's edit decisions AND the import's
          // attached stats blocks. Missing values (legacy cards, or freshly
          // imported DP cards) fall back to defaults inside addDataPointCard;
          // missing `fillRateCustom` defaults to false so legacy cards keep
          // tracking the records input live.
          addDataPointCard(cs.data.text || "", {
            x: cs.x,
            y: cs.y,
            id: cs.id,
            clusterId: cs.clusterId,
            tableOrder: cs.tableOrder,
            fillRate: cs.data.fillRate,
            fillRateCustom: cs.data.fillRateCustom,
            fillExclusions: cs.data.fillExclusions,
            stats: cs.data.stats,
            groupCluster: cs.data.groupCluster,
            fieldId: cs.data.fieldId,
            tableId: cs.data.tableId,
            viewId: cs.data.viewId,
            sourceEnrichmentFieldId: cs.data.sourceEnrichmentFieldId,
            // Multi-ER lineage + run-shares — restore verbatim so a DP linked to
            // several enrichments keeps its chips, % badges, and grouping across
            // reload / tab switch / realtime sync.
            sourceEnrichmentFieldIds: cs.data.sourceEnrichmentFieldIds,
            sourceEnrichmentShares: cs.data.sourceEnrichmentShares,
            note: cs.data.note,
          });
        }
        else if (cs.data.type === "input") addInputCard(cs.data.text || "", {
          x: cs.x,
          y: cs.y,
          id: cs.id,
          clusterId: cs.clusterId,
          tableOrder: cs.tableOrder,
          fieldId: cs.data.fieldId,
          tableId: cs.data.tableId,
          viewId: cs.data.viewId,
          groupCluster: cs.data.groupCluster,
        });
        else if (cs.data.type === "comment") addCommentCard(cs.data.text || "", {
          x: cs.x,
          y: cs.y,
          id: cs.id,
          clusterId: cs.clusterId,
          tableOrder: cs.tableOrder,
          groupCluster: cs.data.groupCluster,
        });
        // ER cards: addCard(cs.data, ...) passes the full data object
        // through — data.stats, data.groupCluster, and data.fieldId ride
        // along automatically since addCard mutates a copy of `data`
        // rather than re-building it from scratch.
        else addCard(cs.data, {
          x: cs.x,
          y: cs.y,
          id: cs.id,
          clusterId: cs.clusterId,
          tableOrder: cs.tableOrder,
        });
      }
      // Membership is card.groupId now — apply the serialized groupId onto the
      // freshly built cards (the add* helpers create them ungrouped).
      const liveById = new Map(cardsRef().map((c) => [c.id, c]));
      for (const cs of state.cards || []) {
        const c = liveById.get(cs.id);
        if (c) c.groupId = cs.groupId ?? null;
      }

      // Groups. New blobs carry `parentId` (and no `cardIds`). Legacy blobs
      // carry `cardIds` (the membership union) and no `parentId` — reconstruct
      // the parentId hierarchy + the most-specific card.groupId from those sets
      // so old saves migrate cleanly into the card.groupId + parentId model.
      const rawGroups = state.groups || [];
      const legacy =
        rawGroups.length > 0 &&
        rawGroups.every((g) => g.parentId === undefined) &&
        rawGroups.some((g) => Array.isArray(g.cardIds));
      if (legacy) {
        const sets = rawGroups.map((g) => ({
          g,
          set: new Set(g.cardIds || []),
          size: (g.cardIds || []).length,
        }));
        // Most-specific (smallest) group containing a card becomes its groupId.
        for (const c of cardsRef()) {
          let best = null;
          for (const s of sets) {
            if (s.set.has(c.id) && (!best || s.size < best.size)) best = s;
          }
          if (best) c.groupId = best.g.id;
        }
        // parentId = the smallest OTHER group strictly containing this set.
        for (const s of sets) {
          let parent = null;
          for (const t of sets) {
            if (t === s) continue;
            if (s.size < t.size && [...s.set].every((id) => t.set.has(id))) {
              if (!parent || t.size < parent.size) parent = t;
            }
          }
          s.g.parentId = parent ? parent.g.id : null;
        }
      }
      for (const gs of rawGroups) {
        restoreGroup(gs);
      }
      setNextIds({
        nextCardId: state.nextCardId,
        nextGroupId: state.nextGroupId,
        nextClusterId: state.nextClusterId,
      });
      setRestoring(false);
      updateDpCosts();

      // Derive cluster membership from lineage now that the cards exist.
      // clusterByLineage is the single writer of clusterId: it stamps every
      // ER + its lineage data points with a shared id. DOM-safe, so it runs on
      // the table-view surface too (co-location / halos self-gate on
      // domHydrated). Idempotent — re-running on applyRemoteCanvas / tab switch
      // only heals, never double-assigns.
      if (deriveClusters) deriveClusters();
    }

    return { serialize, restore };
  };
})();
