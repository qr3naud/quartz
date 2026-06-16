(function () {
  "use strict";

  // ---------------------------------------------------------------------------
  // "Stamp the time" markers — per Clay table, persisted in TAB STATE
  // (canvas_tabs.state.stampsByTable) so they sync across devices and
  // collaborators through the normal saveTabs / realtime path. NOT localStorage.
  //
  // Shape: { [clayTableId]: [isoString, isoString] } — sorted ascending, max 2.
  // The FIRST (earliest) stamp drives the default Actual-spend window
  // (session-cutoff.js); a second stamp is a visual-only marker in the picker.
  //
  // Writes go to the ACTIVE tab of the current workbook; reads merge every
  // tab's blob (a stamp may have been written while a different tab was
  // active). To keep that merge from resurrecting deleted stamps, persist()
  // mirrors the authoritative in-memory map onto every tab in the loaded
  // store — rows are only pushed for the active tab; the rest sync whenever
  // they're saved next.
  // ---------------------------------------------------------------------------

  const cb = (window.__cb = window.__cb || {});

  const MAX_STAMPS = 2;

  let map = {}; // { [tableId]: [iso, ...] } — authoritative once hydrated
  let hydrated = false;
  let hydrating = null;
  const listeners = new Set();

  function notify() {
    for (const fn of listeners) {
      try { fn(); } catch {}
    }
  }

  function normalize(arr) {
    const out = [...new Set((arr || []).filter((s) => typeof s === "string" && s))].sort();
    return out.slice(0, MAX_STAMPS);
  }

  function hydrateFromTabStore() {
    const tabs = cb.tabStore?.tabs || [];
    const merged = {};
    for (const tab of tabs) {
      const m = tab?.state?.stampsByTable;
      if (!m || typeof m !== "object") continue;
      for (const tid of Object.keys(m)) {
        merged[tid] = normalize([...(merged[tid] || []), ...(m[tid] || [])]);
      }
    }
    map = merged;
    hydrated = true;
  }

  // Lazy hydration for pages where the overlay was never opened (the stamp
  // button lives on the Clay table page itself): load the tabStore once
  // (Supabase-first via loadTabs) and read stamps out of it.
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
        // Don't clobber a store that landed while we were fetching.
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

  // Mirror the map onto every loaded tab's state, then persist all tab rows
  // (see tabs.js persistSharedTabBlobs — merge-on-hydrate reads every tab).
  async function persist() {
    await ensureHydrated();
    const store = cb.tabStore;
    if (!store || !store.tabs?.length) return;
    for (const tab of store.tabs) {
      tab.state = tab.state || {};
      tab.state.stampsByTable = { ...map };
    }
    if (cb.persistSharedTabBlobs) {
      await cb.persistSharedTabBlobs();
    }
  }

  cb.stamps = {
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },

    ensureHydrated,

    get(tableId) {
      if (!hydrated && cb.tabStore) hydrateFromTabStore();
      return map[tableId] ? [...map[tableId]] : [];
    },

    // First (earliest) stamp as unix SECONDS — the session-cutoff timescale.
    getFirstSec(tableId) {
      const arr = this.get(tableId);
      if (!arr.length) return null;
      const t = Date.parse(arr[0]);
      return Number.isFinite(t) ? t / 1000 : null;
    },

    async add(tableId) {
      if (!tableId) return;
      await ensureHydrated();
      const cur = map[tableId] || [];
      if (cur.length >= MAX_STAMPS) return;
      map[tableId] = normalize([...cur, new Date().toISOString()]);
      notify();
      persist();
    },

    async remove(tableId, iso) {
      await ensureHydrated();
      const cur = map[tableId] || [];
      const next = cur.filter((s) => s !== iso);
      if (next.length === cur.length) return;
      if (next.length) map[tableId] = next;
      else delete map[tableId];
      notify();
      persist();
    },

    // Active-tab blob for saveTabs (mirrors sessionCutoff.serialize). Null
    // means "never hydrated — keep whatever the tab already has"; an empty
    // object is a real "all stamps deleted" and must overwrite.
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
