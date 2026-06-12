(function () {
  "use strict";

  // ---------------------------------------------------------------------------
  // Demo-spotlight highlights — per Clay table, persisted in TAB STATE
  // (canvas_tabs.state.highlightsByTable) so they sync across devices and
  // collaborators through the normal saveTabs / realtime path, exactly like
  // stamps.js. NOT localStorage.
  //
  // Shape: { [clayTableId]: [highlight, ...] } where a highlight is
  //   { id, kind: "results" | "config", fieldId, recordId, fieldName,
  //     isAction, note, createdAt }
  // Replay order = array order (save order). recordId is null for config
  // highlights (a column has one config regardless of row).
  // ---------------------------------------------------------------------------

  const cb = (window.__cb = window.__cb || {});

  let map = {}; // { [tableId]: [highlight, ...] } — authoritative once hydrated
  let hydrated = false;
  let hydrating = null;
  const listeners = new Set();

  function notify() {
    for (const fn of listeners) {
      try { fn(); } catch {}
    }
  }

  function sanitize(arr) {
    const seen = new Set();
    const out = [];
    for (const h of arr || []) {
      if (!h || typeof h !== "object") continue;
      if (!h.id || !h.fieldId || (h.kind !== "results" && h.kind !== "config")) continue;
      if (seen.has(h.id)) continue;
      seen.add(h.id);
      out.push(h);
    }
    return out;
  }

  function hydrateFromTabStore() {
    const tabs = cb.tabStore?.tabs || [];
    const merged = {};
    for (const tab of tabs) {
      const m = tab?.state?.highlightsByTable;
      if (!m || typeof m !== "object") continue;
      for (const tid of Object.keys(m)) {
        merged[tid] = sanitize([...(merged[tid] || []), ...(m[tid] || [])]);
      }
    }
    map = merged;
    hydrated = true;
  }

  // Lazy hydration for pages where the overlay was never opened (the save
  // flow lives on the Clay table page itself) — same approach as stamps.js.
  function ensureHydrated() {
    if (hydrated) return Promise.resolve();
    if (cb.tabStore) {
      hydrateFromTabStore();
      return Promise.resolve();
    }
    if (hydrating) return hydrating;
    if (!cb.parseIdsFromUrl?.()) return Promise.resolve(); // no workbook context
    hydrating = (cb.loadTabs ? cb.loadTabs() : Promise.resolve(null))
      .then((store) => {
        if (store && !cb.tabStore) cb.tabStore = store;
        hydrateFromTabStore();
        notify();
      })
      .catch(() => {})
      .finally(() => {
        hydrating = null;
      });
    return hydrating;
  }

  // Mirror onto every loaded tab's state (so the merge-on-hydrate can't
  // resurrect deleted highlights), then persist via the canvas save path or a
  // direct row push when the overlay is closed.
  async function persist() {
    await ensureHydrated();
    const store = cb.tabStore;
    if (!store || !store.tabs?.length) return;
    for (const tab of store.tabs) {
      tab.state = tab.state || {};
      tab.state.highlightsByTable = { ...map };
    }
    const active = store.tabs.find((t) => t.id === store.activeId) || store.tabs[0];
    if (cb.canvas && cb.debouncedSave) {
      cb.debouncedSave();
    } else if (cb.saveTabRow) {
      cb.saveTabRow(active.id);
    }
  }

  cb.highlights = {
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },

    ensureHydrated,

    get(tableId) {
      if (!hydrated && cb.tabStore) hydrateFromTabStore();
      return map[tableId] ? [...map[tableId]] : [];
    },

    async add(tableId, highlight) {
      if (!tableId || !highlight?.fieldId) return null;
      await ensureHydrated();
      const h = {
        id: `hl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        kind: highlight.kind === "config" ? "config" : "results",
        fieldId: highlight.fieldId,
        recordId: highlight.recordId || null,
        fieldName: highlight.fieldName || null,
        isAction: !!highlight.isAction,
        note: typeof highlight.note === "string" ? highlight.note : "",
        createdAt: new Date().toISOString(),
      };
      map[tableId] = [...(map[tableId] || []), h];
      notify();
      persist();
      return h;
    },

    async remove(tableId, id) {
      await ensureHydrated();
      const cur = map[tableId] || [];
      const next = cur.filter((h) => h.id !== id);
      if (next.length === cur.length) return;
      if (next.length) map[tableId] = next;
      else delete map[tableId];
      notify();
      persist();
    },

    // Active-tab blob for saveTabs (mirrors stamps.serialize). Null means
    // "never hydrated — keep whatever the tab already has"; an empty object
    // is a real all-deleted state and must overwrite.
    serialize() {
      if (!hydrated) return null;
      return { ...map };
    },

    // Tab switch / remote tab update: re-read from the (updated) tabStore.
    rehydrate() {
      if (!cb.tabStore) return;
      hydrateFromTabStore();
      notify();
    },
  };
})();
