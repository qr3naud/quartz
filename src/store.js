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

  // Owned canonical state (C3.2+). The store physically owns the node array;
  // the canvas and table read/write the SAME live instance via getNodes(). The
  // array is never reassigned — only mutated in place — so all holders stay in
  // sync. (groups + importedTables still facade to the canvas for now; they
  // relocate in a later slice.)
  const state = {
    cards: [],
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
    getGroups() {
      return call("getGroups", []);
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
      lastSnapshot = model.serialize();
      model.notify();
      const cb = window.__cb;
      if (cb && typeof cb.onCanvasStateChange === "function") cb.onCanvasStateChange();
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
      lastSnapshot = model.serialize();
      undoStack = [];
      redoStack = [];
    },
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
