(function () {
  "use strict";

  // ---------------------------------------------------------------------------
  // Actual-spend session cutoff (v5.0).
  //
  // The realtime credit endpoints are per-table and aggregate the whole window.
  // This controller lets a user scope Actual spend to specific work sessions
  // (time-gap clusters of runs from /run/recent) and re-stamps the cards'
  // measured spend.
  //
  // Numbers model (v5.0): credits/actions for any selection are summed LOCALLY
  // from the per-session per-column rollup already carried in each bucketed
  // session (run/recent has a full per-column breakdown, and summing runs equals
  // byColumn exactly for credits/actions — verified). So selecting is instant:
  // no byColumn fetch, no contiguous/non-contiguous branching, no token race.
  // The per-row DISPLAY denominator is coverage.ran (run-status, frozen at
  // import) via cost-model.perRowCost — not the noisy cellCount.
  //
  // Default selection: sessions within the last ACTUAL_IMPORT_DAYS (7), which
  // matches the import's initial 7-day stamp so the number doesn't jump when the
  // run list finishes loading. If nothing ran in the last 7 days, fall back to
  // the single most-recent session (cheap — it's a local re-sum).
  // ---------------------------------------------------------------------------

  const cb = (window.__cb = window.__cb || {});

  const CACHE_TTL_MS = 60 * 60 * 1000; // sessions cache is good for 1h

  let state = null;
  // { tableIds, runs (null when loaded from cache), sessions, selectedIds:Set,
  //   gapMs, loaded, loading }
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

  // Persist sessions (incl. per-column rollup) + selection + gap so a refresh is
  // instant and selection can still be re-summed without re-fetching run/recent.
  function persist() {
    if (!state) return;
    try {
      localStorage.setItem(
        storageKey(),
        JSON.stringify({
          sessions: state.sessions,
          selectedIds: [...state.selectedIds],
          gapMs: state.gapMs,
          ts: Date.now(),
        }),
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

  function rebucket() {
    state.sessions = cb.cost.bucketRunsIntoSessions(state.runs || [], state.gapMs);
  }

  // Default = sessions active within the last ACTUAL_IMPORT_DAYS; if none ran
  // recently, fall back to the single most-recent session (sessions are
  // oldest→newest). Empty only when there are no sessions at all.
  function defaultSelection(sessions) {
    if (!sessions.length) return new Set();
    const cutoffSec = Date.now() / 1000 - importDays() * 86400;
    const recent = sessions.filter((s) => s.lastTs >= cutoffSec);
    if (recent.length) return new Set(recent.map((s) => s.id));
    return new Set([sessions[sessions.length - 1].id]);
  }

  // Fetch run/recent for every imported table and bucket into sessions. Only
  // called on a cache miss (or a forced refresh / gap change).
  async function loadFromNetwork(tableIds, gapMs, prevSelectedIds) {
    // Don't lock in an empty result if the workspace isn't resolvable yet
    // (ensureLoaded can fire on an early render before openCanvas sets it).
    // Leave state null so the next ensureLoaded retries once ws is available.
    const ws = workspaceId();
    if (!ws) {
      state = null;
      return null;
    }

    state = {
      tableIds,
      runs: [],
      sessions: [],
      selectedIds: new Set(),
      gapMs,
      loaded: false,
      loading: true,
    };
    notify();

    const all = [];
    for (const tid of tableIds) {
      const runs = await cb.fetchRunSpend(ws, tid, discoveryDays());
      if (Array.isArray(runs)) for (const r of runs) all.push(r);
    }
    state.runs = all;
    rebucket();

    const valid = new Set(state.sessions.map((s) => s.id));
    const restored = (prevSelectedIds || []).filter((id) => valid.has(id));
    state.selectedIds = restored.length
      ? new Set(restored)
      : defaultSelection(state.sessions);

    state.loaded = true;
    state.loading = false;
    persist();
    notify();

    // Re-derive the number from the selected sessions (instant, local). For the
    // recent default this matches the import's 7-day stamp (no visible jump);
    // for the most-recent fallback it fills in the meaningful number.
    if (state.sessions.length) applySelection({ silent: true });
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

        if (
          !opts.force &&
          cache?.sessions?.length &&
          cache.sessions[0].perField && // pre-v5 caches lack the per-column rollup
          cache.ts &&
          Date.now() - cache.ts < CACHE_TTL_MS
        ) {
          // Cache hit: show stored sessions immediately. Cards already restored
          // their persisted spend with the tab, so no re-stamp.
          const valid = new Set(cache.sessions.map((s) => s.id));
          const sel = (cache.selectedIds || []).filter((id) => valid.has(id));
          state = {
            tableIds,
            runs: null, // refetched only if the gap changes
            sessions: cache.sessions,
            selectedIds: sel.length
              ? new Set(sel)
              : defaultSelection(cache.sessions),
            gapMs,
            loaded: true,
            loading: false,
          };
          notify();
          return state;
        }

        return await loadFromNetwork(tableIds, gapMs, cache?.selectedIds);
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

  // Sum the selected sessions' per-column rollups into a fieldId -> spend map.
  // fieldId is globally unique, so one map covers all tables; applyActualSpend
  // filters to each table's cards.
  function buildSelectedSpendMap() {
    const merged = new Map();
    for (const s of state.sessions) {
      if (!state.selectedIds.has(s.id)) continue;
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

  // Re-derive Actual spend from the selected sessions (local sum) and re-stamp.
  // Synchronous and instant — no network. No selection → clear + "—" notice.
  function applySelection(opts) {
    opts = opts || {};
    if (!state || !state.loaded) return;
    cb.actualSpendApplying = false;

    const selected = state.sessions.filter((s) => state.selectedIds.has(s.id));
    if (!selected.length) {
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
    const merged = buildSelectedSpendMap();
    let stamped = false;
    for (const tid of state.tableIds) {
      clearTableSpend(tid);
      if (merged.size && cb.applyActualSpend(merged, tid)) stamped = true;
    }
    // The selection has spend (merged.size) but none of its columns are cost
    // cards on this canvas — e.g. a session that only ran a column on another
    // tab or a since-deleted one. Show a clear "—" + tooltip rather than the
    // "Expired" state (which means "no realtime data at all"), which would
    // otherwise mislead until another, mapping session is added.
    if (merged.size && !stamped) {
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
    toggle(id) {
      if (!state) return;
      if (state.selectedIds.has(id)) state.selectedIds.delete(id);
      else state.selectedIds.add(id);
      persist();
      notify();
      applySelection();
    },
    setAll(on) {
      if (!state) return;
      if (on) state.selectedIds = new Set(state.sessions.map((s) => s.id));
      else state.selectedIds = new Set();
      persist();
      notify();
      applySelection();
    },
    setGapMs(gapMs) {
      if (!state || !gapMs || gapMs <= 0 || gapMs === state.gapMs) return;
      // Re-bucketing needs the raw runs. If they came from cache (runs null),
      // force a network reload with the new gap.
      if (!state.runs || !state.runs.length) {
        ensureLoaded({ force: true, gapMs });
        return;
      }
      state.gapMs = gapMs;
      rebucket();
      state.selectedIds = defaultSelection(state.sessions); // ids change on re-bucket
      persist();
      notify();
      applySelection();
    },
  };
})();
