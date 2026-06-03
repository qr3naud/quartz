(function () {
  "use strict";

  // ---------------------------------------------------------------------------
  // Actual-spend session cutoff (v6.1 — per-table).
  //
  // The realtime credit endpoints are per-table and aggregate the whole window.
  // This controller lets a user scope Actual spend to specific work sessions
  // (time-gap clusters of runs from /run/recent) and re-stamps the cards'
  // measured spend.
  //
  // Per-table (v6.1): run/recent is fetched per table and runs carry no tableId,
  // so we keep runs/sessions/selection grouped BY TABLE (state.byTable[tid]).
  // The picker renders one column per imported table and the user selects
  // sessions per table; the Actual badge shows the TOTAL selected across tables.
  // Each table's spend is summed and stamped independently (applyActualSpend is
  // tid-scoped), which also makes attribution exact (no cross-table bucket).
  //
  // Numbers model: credits/actions for any selection are summed LOCALLY from the
  // per-session per-column rollup already carried in each bucketed session
  // (run/recent has a full per-column breakdown, and summing runs equals
  // byColumn exactly for credits/actions — verified). So selecting is instant:
  // no byColumn fetch, no token race. The per-row DISPLAY denominator is
  // coverage.ran (run-status, frozen at import) via cost-model.perRowCost.
  //
  // Default selection (per table): sessions within the last ACTUAL_IMPORT_DAYS
  // (7), matching the import's initial 7-day stamp. If a table had no runs in
  // the last 7 days, fall back to its single most-recent session.
  // ---------------------------------------------------------------------------

  const cb = (window.__cb = window.__cb || {});

  const CACHE_TTL_MS = 60 * 60 * 1000; // sessions cache is good for 1h

  let state = null;
  // { tableIds:[tid], gapMs, loaded, loading,
  //   byTable: { [tid]: { runs (null when from cache), sessions, selectedIds:Set } } }
  let loadingPromise = null; // de-dupes concurrent ensureLoaded calls
  const listeners = new Set();

  function notify() {
    for (const fn of listeners) {
      try { fn(); } catch {}
    }
  }

  function importDays() {
    return Number(cb.ACTUAL_IMPORT_DAYS) || 7;
  }
  function discoveryDays() {
    return Number(cb.SESSION_DISCOVERY_DAYS) || 365;
  }

  function workspaceId() {
    return cb.currentWorkspaceId || cb.parseIdsFromUrl?.()?.workspaceId || null;
  }

  function storageKey() {
    const wb = cb.currentWorkbookId || cb.parseIdsFromUrl?.()?.workbookId || "";
    const tab = cb.tabStore?.activeId || "";
    return `cb-session-cutoff-${wb}-${tab}`;
  }

  function loadCache() {
    try {
      return JSON.parse(localStorage.getItem(storageKey()) || "null");
    } catch {
      return null;
    }
  }

  // Persist per-table sessions (incl. per-column rollup) + selection + gap so a
  // refresh is instant and selection can re-sum without re-fetching run/recent.
  function persist() {
    if (!state) return;
    try {
      const byTable = {};
      for (const tid of state.tableIds) {
        const t = state.byTable[tid];
        if (!t) continue;
        byTable[tid] = { sessions: t.sessions, selectedIds: [...t.selectedIds] };
      }
      localStorage.setItem(
        storageKey(),
        JSON.stringify({ byTable, gapMs: state.gapMs, ts: Date.now() }),
      );
    } catch {}
  }

  function clearCache() {
    try {
      localStorage.removeItem(storageKey());
    } catch {}
  }

  function distinctTableIds() {
    const ids = new Set();
    for (const c of cb.canvas?.getCards?.() || []) {
      const t = c.data?.tableId;
      if (t) ids.add(t);
    }
    return [...ids].sort();
  }

  function sameSet(a, b) {
    if (a.length !== b.length) return false;
    const sb = new Set(b);
    return a.every((x) => sb.has(x));
  }

  // Bucket one table's runs into sessions, namespacing ids with the table id so
  // they're globally unique (cache keys, submenu open-id) even if two tables
  // ran at identical timestamps.
  function bucketForTable(tid, runs, gapMs) {
    const sessions = cb.cost.bucketRunsIntoSessions(runs || [], gapMs);
    for (const s of sessions) s.id = `${tid}::${s.id}`;
    return sessions;
  }

  // Default = sessions active within the last ACTUAL_IMPORT_DAYS; if none ran
  // recently, fall back to the single most-recent session (sessions are
  // oldest→newest). Empty only when the table has no sessions at all.
  function defaultSelection(sessions) {
    if (!sessions.length) return new Set();
    const cutoffSec = Date.now() / 1000 - importDays() * 86400;
    const recent = sessions.filter((s) => s.lastTs >= cutoffSec);
    if (recent.length) return new Set(recent.map((s) => s.id));
    return new Set([sessions[sessions.length - 1].id]);
  }

  function hasAnySessions() {
    return !!state && state.tableIds.some((tid) => state.byTable[tid]?.sessions?.length);
  }

  // Fetch run/recent for every imported table and bucket PER TABLE. Only called
  // on a cache miss (or a forced refresh / gap change).
  async function loadFromNetwork(tableIds, gapMs, prevByTableSel) {
    // Don't lock in an empty result if the workspace isn't resolvable yet
    // (ensureLoaded can fire on an early render before openCanvas sets it).
    // Leave state null so the next ensureLoaded retries once ws is available.
    const ws = workspaceId();
    if (!ws) {
      state = null;
      return null;
    }

    state = { tableIds, gapMs, loaded: false, loading: true, byTable: {} };
    for (const tid of tableIds) {
      state.byTable[tid] = { runs: [], sessions: [], selectedIds: new Set() };
    }
    notify();

    for (const tid of tableIds) {
      const runs = await cb.fetchRunSpend(ws, tid, discoveryDays());
      const t = state.byTable[tid];
      t.runs = Array.isArray(runs) ? runs : [];
      t.sessions = bucketForTable(tid, t.runs, gapMs);
      const valid = new Set(t.sessions.map((s) => s.id));
      const restored = (prevByTableSel?.[tid] || []).filter((id) => valid.has(id));
      t.selectedIds = restored.length ? new Set(restored) : defaultSelection(t.sessions);
    }

    state.loaded = true;
    state.loading = false;
    persist();
    notify();

    // Re-derive the number from the selected sessions (instant, local). For the
    // recent default this matches the import's 7-day stamp (no visible jump);
    // for the most-recent fallback it fills in the meaningful number.
    if (hasAnySessions()) applySelection({ silent: true });
    return state;
  }

  // Idempotent loader. Cache hit → instant (cards already carry the last applied
  // spend, so no re-stamp). Cache miss → fetch + bucket + apply.
  function ensureLoaded(opts) {
    opts = opts || {};
    const tableIds = distinctTableIds();
    if (!tableIds.length) {
      state = null;
      notify();
      return Promise.resolve(null);
    }
    if (!opts.force && state && state.loaded && sameSet(state.tableIds, tableIds)) {
      return Promise.resolve(state);
    }
    if (loadingPromise && !opts.force) return loadingPromise;

    loadingPromise = (async () => {
      try {
        const cache = loadCache();
        const gapMs = opts.gapMs || cache?.gapMs || cb.cost.DEFAULT_SESSION_GAP_MS;

        // Cache hit requires a per-table entry for EVERY current table, each
        // carrying the per-column rollup (perField). Pre-v6.1 caches (flat
        // `sessions`) and pre-v5 caches (no perField) fail this → network.
        const cacheValid =
          !opts.force &&
          cache?.byTable &&
          cache.ts &&
          Date.now() - cache.ts < CACHE_TTL_MS &&
          tableIds.every((tid) => {
            const ct = cache.byTable[tid];
            return ct?.sessions && (!ct.sessions.length || ct.sessions[0].perField);
          });

        if (cacheValid) {
          state = { tableIds, gapMs, loaded: true, loading: false, byTable: {} };
          for (const tid of tableIds) {
            const ct = cache.byTable[tid];
            const sessions = ct.sessions || [];
            const valid = new Set(sessions.map((s) => s.id));
            const sel = (ct.selectedIds || []).filter((id) => valid.has(id));
            state.byTable[tid] = {
              runs: null, // refetched only if the gap changes
              sessions,
              selectedIds: sel.length ? new Set(sel) : defaultSelection(sessions),
            };
          }
          notify();
          return state;
        }

        const prevSel = {};
        if (cache?.byTable) {
          for (const tid of Object.keys(cache.byTable)) {
            prevSel[tid] = cache.byTable[tid]?.selectedIds;
          }
        }
        return await loadFromNetwork(tableIds, gapMs, prevSel);
      } finally {
        loadingPromise = null;
      }
    })();
    return loadingPromise;
  }

  // Remove previously-stamped measured spend from a table's cards so a new
  // selection fully replaces it.
  function clearTableSpend(tid) {
    for (const card of cb.canvas?.getCards?.() || []) {
      const d = card.data;
      if (!d || d.tableId !== tid) continue;
      if (d.stats && d.stats.spend) {
        const { spend, ...rest } = d.stats;
        d.stats = rest;
      }
      if (d.type === "waterfall" && Array.isArray(d.providers)) {
        for (const p of d.providers) {
          if (p.stats && p.stats.spend) {
            const { spend, ...rest } = p.stats;
            p.stats = rest;
          }
        }
      }
    }
  }

  // Sum ONE table's selected sessions' per-column rollups into a fieldId -> spend
  // map. fieldId is globally unique, so applyActualSpend(map, tid) safely filters
  // to that table's cards.
  function buildSelectedSpendMapForTable(tid) {
    const merged = new Map();
    const t = state.byTable[tid];
    if (!t) return merged;
    for (const s of t.sessions) {
      if (!t.selectedIds.has(s.id)) continue;
      const pf = s.perField || {};
      for (const fid of Object.keys(pf)) {
        const v = pf[fid];
        const e =
          merged.get(fid) || { credits: 0, actionExecutions: 0, cellCount: 0 };
        e.credits += Number(v.credits) || 0;
        e.actionExecutions += Number(v.actionExecutions) || 0;
        e.cellCount += Number(v.cellCount) || 0;
        merged.set(fid, e);
      }
    }
    return merged;
  }

  function totalSelected() {
    if (!state) return 0;
    let n = 0;
    for (const tid of state.tableIds) n += state.byTable[tid]?.selectedIds?.size || 0;
    return n;
  }

  function setNotice(notice) {
    cb.actualSummaryNotice = notice || null;
  }

  function refreshSummary(silent) {
    // Recompute the Actual loading/expired flags BEFORE the recalc. The summary
    // renderer (setSummaryNumber) reads __cb.actualSpendExpired synchronously,
    // so if we recalc first the numbers paint against the PREVIOUS selection's
    // flag — e.g. selecting a run right after clearing all shows a stale
    // "Expired" until the next toggle catches the flag up. Matches the order in
    // overlay.js setViewMode.
    cb.applyActualSummaryState?.();
    cb._animateSummary = true;
    try {
      cb.canvas?.refreshCreditTotal?.();
    } finally {
      cb._animateSummary = false;
    }
    cb.canvas?.updateGroupCredits?.();
    cb.model?.update?.();
    if (!silent && cb.tableView?.refresh) cb.tableView.refresh();
  }

  // Re-derive Actual spend from the selected sessions (local sum) and re-stamp,
  // per table. Synchronous and instant — no network. No selection anywhere →
  // clear + "—" notice.
  function applySelection(opts) {
    opts = opts || {};
    if (!state || !state.loaded) return;
    cb.actualSpendApplying = false;

    if (totalSelected() === 0) {
      for (const tid of state.tableIds) clearTableSpend(tid);
      setNotice({
        label: "\u2014",
        tooltip:
          "No sessions selected \u2014 pick at least one session to count Actual spend.",
      });
      refreshSummary(opts.silent);
      persist();
      return;
    }

    setNotice(null);
    let anySelected = false;
    let stamped = false;
    for (const tid of state.tableIds) {
      clearTableSpend(tid);
      const map = buildSelectedSpendMapForTable(tid);
      if (map.size) {
        anySelected = true;
        if (cb.applyActualSpend(map, tid)) stamped = true;
      }
    }
    // The selection has spend but none of its columns are cost cards on this
    // canvas — e.g. a session that only ran a since-deleted column. Show a clear
    // "—" + tooltip rather than the "Expired" state (which means "no realtime
    // data at all"), which would otherwise mislead.
    if (anySelected && !stamped) {
      setNotice({
        label: "\u2014",
        tooltip:
          "The selected session(s) ran columns that aren't on this canvas. " +
          "Pick a session that ran these enrichments to count its Actual spend.",
      });
    }
    refreshSummary(opts.silent);
    persist();
  }

  // ---- Public API (consumed by the picker UI in table-view.js) -------------

  cb.sessionCutoff = {
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    ensureLoaded,
    invalidate() {
      state = null;
      loadingPromise = null;
      cb.actualSummaryNotice = null;
      cb.actualSpendApplying = false;
    },
    invalidateCache() {
      clearCache();
      state = null;
      loadingPromise = null;
      cb.actualSummaryNotice = null;
      cb.actualSpendApplying = false;
    },
    getState() {
      return state;
    },
    // Total selected sessions across all tables (the Actual badge count).
    totalSelected,
    toggle(tid, id) {
      const t = state?.byTable?.[tid];
      if (!t) return;
      if (t.selectedIds.has(id)) t.selectedIds.delete(id);
      else t.selectedIds.add(id);
      persist();
      notify();
      applySelection();
    },
    setAll(tid, on) {
      const t = state?.byTable?.[tid];
      if (!t) return;
      t.selectedIds = on ? new Set(t.sessions.map((s) => s.id)) : new Set();
      persist();
      notify();
      applySelection();
    },
    setAllTables(on) {
      if (!state) return;
      for (const tid of state.tableIds) {
        const t = state.byTable[tid];
        if (!t) continue;
        t.selectedIds = on ? new Set(t.sessions.map((s) => s.id)) : new Set();
      }
      persist();
      notify();
      applySelection();
    },
    setGapMs(gapMs) {
      if (!state || !gapMs || gapMs <= 0 || gapMs === state.gapMs) return;
      // Re-bucketing needs the raw runs. If any table loaded from cache (runs
      // null), force a network reload with the new gap.
      const haveRuns = state.tableIds.every((tid) =>
        Array.isArray(state.byTable[tid]?.runs),
      );
      if (!haveRuns) {
        ensureLoaded({ force: true, gapMs });
        return;
      }
      state.gapMs = gapMs;
      for (const tid of state.tableIds) {
        const t = state.byTable[tid];
        t.sessions = bucketForTable(tid, t.runs, gapMs);
        t.selectedIds = defaultSelection(t.sessions); // ids change on re-bucket
      }
      persist();
      notify();
      applySelection();
    },
  };
})();
