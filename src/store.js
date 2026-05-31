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
      return call("getCards", []);
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

    // The single external write path (C3.1). Table view, importers, picker,
    // export, and overlay grouping all call this after mutating the model
    // instead of poking canvas.notifyChange() directly. Today it delegates to
    // the canvas's notifyChange (which still owns undo + debounced persist) and
    // also fires model subscribers; later C3 slices move undo/persist/realtime
    // ownership into the store itself. `mutator` is optional — most callers
    // mutate just before calling update(); pass a function to wrap the mutation
    // once the store owns the transaction (C3.4+).
    update(mutator) {
      if (typeof mutator === "function") mutator();
      const c = canvas();
      if (c && typeof c.notifyChange === "function") c.notifyChange();
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
