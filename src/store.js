(function () {
  "use strict";

  // ---------------------------------------------------------------------------
  // Independent model store (Phase 2.c, step C1).
  //
  // The long-term target is an independent source of truth that both the table
  // view and the canvas render from as subscribers — so the table never depends
  // on canvas DOM/geometry, and canvas interactions can't mutate what the table
  // shows. We get there incrementally:
  //
  //   C1 (this step): a thin FACADE over the existing canvas card model. The
  //     data still physically lives in the canvas (`cards[]`), but every
  //     consumer reads it through `__cb.model` instead of poking `__cb.canvas`
  //     directly. This establishes the single seam with zero behavior change.
  //   C2: canvas becomes a lazy renderer built from the model on toggle.
  //   C3: serialize / realtime / undo-redo ownership relocates onto this module.
  //
  // The store deliberately exposes only SEMANTIC reads (nodes + groups +
  // imported tables). Geometry/cluster fields still ride on the node objects in
  // C1, but the table view must stop reading them (that's the semantic-grouping
  // step) so canvas snap/geometry can never move the table.
  // ---------------------------------------------------------------------------

  const listeners = new Set();

  // Owned canonical state (C3.2+). The store physically owns the node array AND
  // the groups array; the canvas and table read/write the SAME live instances.
  // The arrays are never reassigned — only mutated in place — so all holders
  // stay in sync. Groups are PURE DATA `{ id, label, level, color, parentId }`:
  // membership is `card.groupId` (single source of truth) and super/inner
  // nesting is `group.parentId`. The canvas owns the group DOM elements
  // separately (a renderer keyed by id); nothing canvas/DOM lives here.
  // (importedTables still facades to the canvas for now; relocates in a later
  // slice.)
  const state = {
    cards: [],
    groups: [],
  };

  // Undo/redo + change-notification ownership (C3.4). The store is the single
  // transaction: update() mutates -> captures an undo snapshot -> notifies
  // subscribers -> schedules persist. `restoring` suppresses capture/persist
  // while a restore rebuilds the model (matches the canvas's old notifyChange
  // guard). lastSnapshot holds the pre-edit blob, pushed onto undoStack on the
  // next change.
  let restoring = false;
  let lastSnapshot = null;
  let undoStack = [];
  let redoStack = [];
  const MAX_UNDO = 50;

  function canvas() {
    return (window.__cb && window.__cb.canvas) || null;
  }

  // Deep-clone a serialized snapshot so undo/redo entries are frozen in time.
  // serialize() returns card objects whose `data` (incl. nested arrays like a
  // waterfall's `providers`) is a LIVE reference; without cloning, an in-place
  // edit (e.g. reordering providers) would mutate the historical snapshots too,
  // making undo a no-op. The blob is pure data (no DOM/functions), so
  // structuredClone is safe, with a JSON fallback.
  function cloneSnapshot(s) {
    if (s == null) return s;
    try {
      return typeof structuredClone === "function"
        ? structuredClone(s)
        : JSON.parse(JSON.stringify(s));
    } catch (_e) {
      try { return JSON.parse(JSON.stringify(s)); } catch (_e2) { return s; }
    }
  }

  function call(method, fallback) {
    const c = canvas();
    return c && typeof c[method] === "function" ? c[method]() : fallback;
  }

  const model = {
    // Semantic nodes = the card data model: each carries `id`, `data` (type,
    // fieldId, lineage `sourceEnrichmentFieldId`, credits/actionExecutions,
    // frequency, stats, coverageRows, fillRate, ...) plus presentation fields
    // (x/y/clusterId for the canvas, tableOrder for the table). Consumers should
    // read `node.data` + `node.tableOrder`/`node.y`, NOT `node.clusterId`.
    getNodes() {
      // Store-owned live array (C3.2). Read-only for consumers — mutate through
      // the canvas card helpers / update(), never by reassigning or splicing
      // the returned array directly.
      return state.cards;
    },
    getNode(id) {
      return model.getNodes().find((n) => n && n.id === id) || null;
    },
    // Store-owned live groups array. Pure metadata `{ id, label, level, color,
    // parentId }`; read-only for consumers — mutate via setGroups / the canvas
    // group lifecycle helpers, never by reassigning the returned array.
    getGroups() {
      return state.groups;
    },
    // In-place replace (preserve the shared reference, like getNodes/setCards).
    setGroups(next) {
      state.groups.length = 0;
      if (Array.isArray(next)) for (const g of next) state.groups.push(g);
      return model;
    },
    // Cards that belong to a group. `deep` also pulls in cards of descendant
    // groups (a super-group's members = its own direct cards + every nested
    // inner group's cards), resolved via parentId. The single membership query
    // shared by the canvas (bounds, credits, drag) and the table view, so
    // there's no `cardIds` field to keep in sync.
    cardsInGroup(groupId, opts) {
      if (groupId == null) return [];
      const ids = new Set([groupId]);
      if (opts && opts.deep) {
        let grew = true;
        while (grew) {
          grew = false;
          for (const g of state.groups) {
            if (g.parentId != null && ids.has(g.parentId) && !ids.has(g.id)) {
              ids.add(g.id);
              grew = true;
            }
          }
        }
      }
      return state.cards.filter((c) => c.groupId != null && ids.has(c.groupId));
    },
    // True when a group has no direct member cards AND no child groups — i.e.
    // safe to remove. Used by the canvas to prune emptied groups.
    isGroupEmpty(groupId) {
      const hasDirect = state.cards.some((c) => c.groupId === groupId);
      if (hasDirect) return false;
      const hasChild = state.groups.some((g) => g.parentId === groupId);
      return !hasChild;
    },
    // Cluster membership is canvas PRESENTATION. Exposed here only so the read
    // seam is complete during C1; the table view stops using it in the
    // semantic-grouping step. Returns model-backed `{ id, cardIds }[]`.
    getClusters() {
      return call("getClusters", []);
    },
    // Per-imported-table metadata (name, color, recordCount, importedAt), keyed
    // by tableId.
    getImportedTables() {
      return call("getImportedTables", {});
    },

    // ---- Table-native group tree (v7.23+) -------------------------------
    // Groups are an ordered tree. A top-level group (parentId null) is a "use
    // case" that carries records/frequency/source; nested groups are
    // sub-groups. Card membership is `card.groupId` (immediate parent). These
    // are low-level mutators — callers wrap them in update() to capture undo +
    // persist + notify (see the table view's group ops).
    getGroup(id) {
      return state.groups.find((g) => g && g.id === id) || null;
    },
    // Immediate child groups of `id` (top-level groups when id == null).
    childGroups(id) {
      const pid = id ?? null;
      return state.groups.filter((g) => (g.parentId ?? null) === pid);
    },
    // The top-level ("use case") ancestor group for a card, walking
    // groupId -> parentId. Null when the card is ungrouped. Cycle-guarded.
    useCaseGroupForCard(card) {
      let gid = card && card.groupId != null ? card.groupId : null;
      const seen = new Set();
      let group = null;
      while (gid != null && !seen.has(gid)) {
        seen.add(gid);
        group = model.getGroup(gid);
        if (!group) return null;
        if (group.parentId == null) return group;
        gid = group.parentId;
      }
      return group && group.parentId == null ? group : null;
    },
    // Depth of a group: 0 = top-level (use case), 1 = sub-group, ...
    groupDepth(id) {
      let depth = 0;
      let g = model.getGroup(id);
      const seen = new Set();
      while (g && g.parentId != null && !seen.has(g.id)) {
        seen.add(g.id);
        depth += 1;
        g = model.getGroup(g.parentId);
      }
      return depth;
    },
    // All descendant group ids (inclusive), via parentId.
    groupSubtreeIds(id) {
      const ids = new Set([id]);
      let grew = true;
      while (grew) {
        grew = false;
        for (const g of state.groups) {
          if (g.parentId != null && ids.has(g.parentId) && !ids.has(g.id)) {
            ids.add(g.id);
            grew = true;
          }
        }
      }
      return ids;
    },
    createGroup(opts) {
      opts = opts || {};
      const cb = window.__cb;
      const id =
        cb && cb.canvas && typeof cb.canvas.allocateGroupId === "function"
          ? cb.canvas.allocateGroupId()
          : state.groups.reduce((m, g) => Math.max(m, Number(g.id) || 0), 0) + 1;
      const siblings = model.childGroups(opts.parentId ?? null);
      const maxOrder = siblings.reduce(
        (m, g) => (g.order != null ? Math.max(m, Number(g.order)) : m),
        -1,
      );
      const group = {
        id,
        parentId: opts.parentId ?? null,
        label: opts.label || "",
        kind: opts.kind || "group",
        order: opts.order != null ? opts.order : maxOrder + 1,
        source: opts.source || null,
        tableId: opts.tableId ?? null,
        viewId: opts.viewId ?? null,
        records: opts.records ?? null,
        frequency: opts.frequency ?? null,
        level: 0,
        color: null,
      };
      state.groups.push(group);
      return group;
    },
    updateGroup(id, patch) {
      const g = model.getGroup(id);
      if (g && patch) Object.assign(g, patch);
      return g;
    },
    setCardGroup(cardId, groupId) {
      const c = model.getNode(cardId);
      if (c) c.groupId = groupId ?? null;
      return c;
    },
    // Remove a group. `withCards`: also delete every card in the subtree.
    // Otherwise the subtree's cards + child groups re-parent to this group's
    // parent (promote one level) so nothing is orphaned.
    deleteGroup(id, opts) {
      const g = model.getGroup(id);
      if (!g) return;
      if (opts && opts.withCards) {
        const ids = model.groupSubtreeIds(id);
        for (let i = state.cards.length - 1; i >= 0; i--) {
          const c = state.cards[i];
          if (c.groupId != null && ids.has(c.groupId)) state.cards.splice(i, 1);
        }
        for (let i = state.groups.length - 1; i >= 0; i--) {
          if (ids.has(state.groups[i].id)) state.groups.splice(i, 1);
        }
      } else {
        const parentId = g.parentId ?? null;
        for (const c of state.cards) if (c.groupId === id) c.groupId = parentId;
        for (const child of state.groups) if (child.parentId === id) child.parentId = parentId;
        const idx = state.groups.findIndex((x) => x.id === id);
        if (idx >= 0) state.groups.splice(idx, 1);
      }
    },
    // Migration / load-time adapter (v7.23+): derive the table-native group
    // tree from legacy state so existing scopes (and freshly imported cards
    // tagged only with data.tableId) render as use cases. Idempotent — safe to
    // run on every restore:
    //   - find-or-create one L1 use-case group per distinct card.data.tableId
    //     (label + records from the importedTables metadata),
    //   - put each tabled card under its use case UNLESS it already lives in a
    //     sub-group of that use case (so user sub-grouping survives reloads),
    //   - prune leftover empties (old emptied cb-groups / comment-clusters),
    //     keeping user-created empty use cases (source "manual").
    // Returns true if it changed anything (caller may persist).
    ensureTableNativeGroups() {
      const tables = model.getImportedTables() || {};
      let changed = false;
      // Existing L1 use-case groups, keyed by their source tableId.
      const ucByTableId = new Map();
      for (const g of state.groups) {
        if ((g.parentId ?? null) === null && g.source === "import-table" && g.tableId != null) {
          if (!ucByTableId.has(g.tableId)) ucByTableId.set(g.tableId, g);
        }
      }
      const ensureUseCase = (tid, card) => {
        let uc = ucByTableId.get(tid);
        if (!uc) {
          const meta = tables[tid] || {};
          uc = model.createGroup({
            parentId: null,
            source: "import-table",
            tableId: tid,
            viewId: (card && card.data && card.data.viewId) ?? null,
            label: meta.name || (card && card.data && card.data.tableName) || "Table",
            records: meta.recordCount != null ? Number(meta.recordCount) : null,
          });
          ucByTableId.set(tid, uc);
          changed = true;
        }
        return uc;
      };
      // Clay column groups arrive as legacy comment-cluster "basic groups": a
      // titled comment card + member cards sharing a groupCluster. Map each
      // cluster to its title so we can rebuild it as a real L2 sub-group under
      // the table's use case (the comment card then renders as an invisible
      // no-op in the table — its title lives on the L2 group).
      const titleByCluster = new Map();
      for (const c of state.cards) {
        if (c.data && c.data.type === "comment" && c.data.groupCluster != null) {
          const txt = (c.data.text || c.data.displayName || "").trim();
          if (txt && !titleByCluster.has(c.data.groupCluster)) {
            titleByCluster.set(c.data.groupCluster, txt);
          }
        }
      }
      const l2ByCluster = new Map();
      // Assign every ungrouped, table-tagged card to its use case (loose) or its
      // column group's L2 sub-group. Only touches cards with no groupId, so it
      // never fights user edits and is safe to run on every render.
      for (const c of state.cards) {
        const d = c.data || {};
        if (!d.tableId || d.type === "comment") continue;
        if (c.groupId != null) continue;
        const uc = ensureUseCase(d.tableId, c);
        const cluster = d.groupCluster;
        if (cluster != null && titleByCluster.has(cluster)) {
          let l2 = l2ByCluster.get(cluster);
          if (!l2) {
            l2 = model.createGroup({
              parentId: uc.id,
              source: "import-cluster",
              label: titleByCluster.get(cluster),
            });
            l2ByCluster.set(cluster, l2);
          }
          c.groupId = l2.id;
        } else {
          c.groupId = uc.id;
        }
        changed = true;
      }
      return changed;
    },
    // Drop SUB-groups with no member cards and no child groups. Empty
    // top-level use cases are kept (a freshly created one is valid).
    pruneEmptyGroups() {
      let removed = true;
      while (removed) {
        removed = false;
        for (let i = state.groups.length - 1; i >= 0; i--) {
          const grp = state.groups[i];
          if (grp.parentId == null) continue; // never prune a use case
          const hasCards = state.cards.some((c) => c.groupId === grp.id);
          const hasChild = state.groups.some((g) => g.parentId === grp.id);
          if (!hasCards && !hasChild) {
            state.groups.splice(i, 1);
            removed = true;
          }
        }
      }
    },

    // The single write path + transaction (C3.1 + C3.4). Every write — external
    // (table view, importers, picker, export, overlay) and canvas-internal
    // (canvas.notifyChange delegates here) — runs through update(): apply the
    // mutation, capture an undo snapshot, notify subscribers, schedule persist.
    // `mutator` is optional (most callers mutate just before calling update()).
    update(mutator) {
      if (typeof mutator === "function") mutator();
      // Edits applied while a restore is rebuilding the model aren't their own
      // undo steps and must not persist mid-rebuild (matches the canvas's old
      // notifyChange `if (restoring) return`).
      if (restoring) return model;
      if (lastSnapshot != null) {
        undoStack.push(lastSnapshot);
        if (undoStack.length > MAX_UNDO) undoStack.shift();
        redoStack = [];
      }
      lastSnapshot = cloneSnapshot(model.serialize());
      model.notify();
      const cb = window.__cb;
      if (cb && typeof cb.onCanvasStateChange === "function") cb.onCanvasStateChange();
      return model;
    },

    // Apply a REMOTE-origin change (C3.6): run the mutation, then notify
    // subscribers so both views reflect a peer's edit. Unlike update(), it does
    // NOT capture undo, persist, or re-broadcast — the sender already owns
    // those, and doing them here would echo back to peers and pollute local
    // undo with remote edits. Used by live-actions for per-card text sync;
    // whole-state remote sync goes through restore() (which also notifies).
    applyRemote(mutator) {
      if (typeof mutator === "function") mutator();
      model.notify();
      return model;
    },

    // ---- Undo / redo history (C3.4) ----
    // The store owns the stacks; the canvas does the actual re-render for an
    // undo/redo (clearCanvas + restore the returned snapshot).
    setRestoring(v) { restoring = !!v; },
    isRestoring() { return restoring; },
    canUndo() { return undoStack.length > 0; },
    canRedo() { return redoStack.length > 0; },
    historyUndo() {
      if (undoStack.length === 0) return null;
      redoStack.push(lastSnapshot);
      lastSnapshot = undoStack.pop();
      return lastSnapshot;
    },
    historyRedo() {
      if (redoStack.length === 0) return null;
      undoStack.push(lastSnapshot);
      lastSnapshot = redoStack.pop();
      return lastSnapshot;
    },
    // After a fresh restore: set the baseline snapshot + clear history.
    historyResetBaseline() {
      lastSnapshot = cloneSnapshot(model.serialize());
      undoStack = [];
      redoStack = [];
    },

    // Deep-clone helper exposed so the canvas can freeze a history snapshot
    // before restoring from it (keeps the live model independent of the
    // retained undo/redo entry).
    cloneSnapshot,
    // Full teardown (canvas destroy).
    historyClear() {
      lastSnapshot = null;
      undoStack = [];
      redoStack = [];
    },

    // Persistence entry points (C3.3). The store is the public serialize /
    // restore API; the canvas is the registered renderer (it still owns the
    // DOM build loop, lazy-DOM mountDom/hydrate/clusterByLineage, and the blob
    // assembly for the not-yet-relocated slices). External callers — saveTabs,
    // importers, realtime apply, tab switch, overlay restore — go through here.
    serialize() {
      return call("serialize", null);
    },
    restore(stateArg, opts) {
      const c = canvas();
      if (c && typeof c.restore === "function") c.restore(stateArg, opts);
      // Derive the table-native group tree from legacy tags so existing scopes
      // render as use cases. In-memory only (no undo capture); the derived
      // groups serialize on the next save.
      try {
        model.ensureTableNativeGroups();
      } catch (err) {
        console.warn("[Clay Scoping] ensureTableNativeGroups failed:", err);
      }
      // Notify subscribers after the rebuild (C3.5) so a mounted table view
      // re-renders on restore / tab switch / remote canvas sync. (During the
      // rebuild, `restoring` suppressed per-card notifies.)
      model.notify();
      return model;
    },

    subscribe(listener) {
      if (typeof listener !== "function") return function () {};
      listeners.add(listener);
      return function () {
        listeners.delete(listener);
      };
    },

    notify() {
      for (const listener of listeners) {
        try {
          listener();
        } catch (err) {
          console.warn("[Clay Scoping] model listener failed:", err);
        }
      }
    },
  };

  window.__cb = window.__cb || {};
  window.__cb.model = model;
})();
