(function () {
  "use strict";

  // ---------------------------------------------------------------------------
  // Actual-spend session cutoff (v4.0).
  //
  // The realtime credit endpoints are per-table and aggregate the whole window,
  // so "Actual" used to mean "last 30 days, everything". This controller lets a
  // user scope Actual spend to specific work sessions (time-gap clusters of
  // runs from /run/recent). It owns the session state per tab and re-stamps the
  // cards' measured spend through the same path the import uses.
  //
  // Numbers strategy (hybrid):
  //   - contiguous selection → ONE byColumn?timeRange call over the span
  //     (accurate: collapses a row's re-runs to ~distinct rows, catches credit
  //     events that arrived in the gaps between sessions),
  //   - non-contiguous selection → per-session byColumn calls summed (any
  //     subset; credits/actions accurate, cellCount becomes executions-style).
  //
  // Robustness (v4.0.1):
  //   - sessions are cached in localStorage so a page refresh shows them
  //     instantly instead of re-fetching the (large) /run/recent payload,
  //   - a single in-flight load promise prevents the loader from restarting on
  //     every table re-render,
  //   - applySelection is serialized (fetch everything first, then stamp only
  //     if still the latest call) so rapid toggles can't leave cards with their
  //     spend cleared (which showed up as "Expired").
  // ---------------------------------------------------------------------------

  const cb = (window.__cb = window.__cb || {});

  const CACHE_TTL_MS = 60 * 60 * 1000; // sessions cache is good for 1h

  // Runtime state for the active tab.
  let state = null;
  // {
  //   tableIds, runsByTable, runs (null when loaded from cache), sessions,
  //   selectedIds:Set, gapMs, loaded, loading,
  // }
  let loadingPromise = null; // de-dupes concurrent ensureLoaded calls
  let applyToken = 0; // serializes applySelection (latest wins)
  const listeners = new Set();

  function notify() {
    for (const fn of listeners) {
      try { fn(); } catch {}
    }
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

  // Persist sessions + selection + gap so a refresh is instant.
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

  function selectAll() {
    state.selectedIds = new Set(state.sessions.map((s) => s.id));
  }

  // Fetch run/recent for every imported table and bucket into sessions. Only
  // called on a cache miss (or a forced refresh / gap change).
  async function loadFromNetwork(tableIds, gapMs, prevSelectedIds) {
    state = {
      tableIds,
      runsByTable: {},
      runs: [],
      sessions: [],
      selectedIds: new Set(),
      gapMs,
      loaded: false,
      loading: true,
    };
    notify();

    const ws = workspaceId();
    const all = [];
    for (const tid of tableIds) {
      const runs = ws ? await cb.fetchRunSpend(ws, tid, 210) : null;
      if (Array.isArray(runs)) {
        state.runsByTable[tid] = runs;
        for (const r of runs) all.push(r);
      }
    }
    state.runs = all;
    rebucket();

    const valid = new Set(state.sessions.map((s) => s.id));
    const restored = (prevSelectedIds || []).filter((id) => valid.has(id));
    if (restored.length) state.selectedIds = new Set(restored);
    else selectAll();

    state.loaded = true;
    state.loading = false;
    persist();
    notify();

    // Apply the resolved window so Actual reflects the selected sessions
    // (replacing the import's quick 30-day default). Silent — no table refresh
    // loop; the summary refresh inside applySelection is enough.
    if (state.sessions.length) await applySelection({ silent: true });
    return state;
  }

  // Idempotent loader. Cache hit → instant (cards already carry the last
  // applied spend, so no re-stamp). Cache miss → fetch + bucket + apply.
  function ensureLoaded(opts) {
    opts = opts || {};
    const tableIds = distinctTableIds();
    if (!tableIds.length) {
      state = null;
      notify();
      return Promise.resolve(null);
    }
    if (
      !opts.force &&
      state &&
      state.loaded &&
      sameSet(state.tableIds, tableIds)
    ) {
      return Promise.resolve(state);
    }
    if (loadingPromise && !opts.force) return loadingPromise;

    loadingPromise = (async () => {
      try {
        const cache = loadCache();
        const gapMs = opts.gapMs || cache?.gapMs || cb.cost.DEFAULT_SESSION_GAP_MS;

        // Cache hit: show the stored sessions immediately, no network, no
        // re-stamp (the tab's cards already restored their persisted spend).
        if (
          !opts.force &&
          cache?.sessions?.length &&
          cache.ts &&
          Date.now() - cache.ts < CACHE_TTL_MS
        ) {
          const valid = new Set(cache.sessions.map((s) => s.id));
          const sel = (cache.selectedIds || []).filter((id) => valid.has(id));
          state = {
            tableIds,
            runsByTable: {},
            runs: null, // lazy — refetched only if the gap changes
            sessions: cache.sessions,
            selectedIds: new Set(sel.length ? sel : cache.sessions.map((s) => s.id)),
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

  function mergeSpendMaps(target, src) {
    for (const [fid, v] of src) {
      const e = target.get(fid) || { credits: 0, actionExecutions: 0, cellCount: 0 };
      e.credits += v.credits;
      e.actionExecutions += v.actionExecutions;
      e.cellCount += v.cellCount;
      target.set(fid, e);
    }
    return target;
  }

  // Drives the summary status text in Actual mode (overlay.setSummaryNumber):
  //   null          → show real numbers
  //   {label,tooltip}→ show the label (e.g. "Error" / "—") instead of a number
  function setNotice(notice) {
    cb.actualSummaryNotice = notice || null;
  }

  function refreshSummary(silent) {
    cb._animateSummary = true;
    try {
      cb.canvas?.refreshCreditTotal?.();
    } finally {
      cb._animateSummary = false;
    }
    cb.canvas?.updateGroupCredits?.();
    cb.applyActualSummaryState?.();
    cb.model?.update?.();
    if (!silent && cb.tableView?.refresh) cb.tableView.refresh();
  }

  // Fetch the selected window(s) per table, then re-stamp + refresh. Serialized
  // via applyToken: all fetches run first and we only mutate cards if this is
  // still the latest call, so overlapping toggles can't clear-then-leave-empty
  // (which used to surface as a false "Expired"). Distinguishes:
  //   - no sessions selected  → "—" notice (intentional empty),
  //   - fetch failure (null)  → "Error" notice, existing numbers preserved,
  //   - success with no spend → genuine "Expired" (now rare),
  //   - success with spend    → real numbers.
  async function applySelection(opts) {
    opts = opts || {};
    if (!state || !state.loaded) return;
    const ws = workspaceId();
    if (!ws) return;

    const myToken = ++applyToken;
    const idxById = new Map(state.sessions.map((s, i) => [s.id, i]));
    const selected = state.sessions.filter((s) => state.selectedIds.has(s.id));

    // Nothing selected → clear spend and show a "no selection" notice (not
    // "Expired", which would imply the data is gone).
    if (!selected.length) {
      for (const tid of state.tableIds) clearTableSpend(tid);
      cb.actualSpendApplying = false;
      setNotice({
        label: "\u2014",
        tooltip:
          "No sessions selected \u2014 pick at least one session to count Actual spend.",
      });
      refreshSummary(opts.silent);
      persist();
      return;
    }

    const selIdx = selected.map((s) => idxById.get(s.id));
    const contiguous = cb.cost.selectionIsContiguous(selIdx);

    // Loading shimmer while fetching.
    cb.actualSpendApplying = true;
    cb.applyActualSummaryState?.();

    // Phase 1: fetch everything (no card mutation yet). fetchColumnSpendForRange
    // returns null on a real failure vs [] for a legitimately empty window.
    const results = [];
    let hadError = false;
    for (const tid of state.tableIds) {
      const merged = new Map();
      if (contiguous) {
        const rows = await cb.fetchColumnSpendForRange(
          ws,
          tid,
          selected[0].startISO,
          selected[selected.length - 1].endISO,
        );
        if (myToken !== applyToken) return; // superseded — drop silently
        if (rows == null) hadError = true;
        else mergeSpendMaps(merged, cb.spendRowsToMap(rows));
      } else {
        for (const s of selected) {
          const rows = await cb.fetchColumnSpendForRange(ws, tid, s.startISO, s.endISO);
          if (myToken !== applyToken) return; // superseded
          if (rows == null) hadError = true;
          else mergeSpendMaps(merged, cb.spendRowsToMap(rows));
        }
      }
      results.push([tid, merged]);
    }
    if (myToken !== applyToken) return; // superseded before mutating

    cb.actualSpendApplying = false;

    // A fetch failed → keep the existing numbers, surface an error, let a retry
    // (re-toggle) recover. Never blank the cards on a transient failure.
    if (hadError) {
      setNotice({
        label: "Error",
        tooltip:
          "Couldn't load actual spend for the selected sessions. Check your " +
          "connection, then toggle a session to retry.",
      });
      refreshSummary(opts.silent);
      return;
    }

    // Phase 2: mutate atomically (only the latest call reaches here).
    setNotice(null);
    for (const [tid, merged] of results) {
      clearTableSpend(tid);
      if (merged.size) cb.applyActualSpend(merged, tid);
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
    // Reset when switching tabs / re-importing so the next render reloads.
    invalidate() {
      state = null;
      loadingPromise = null;
      applyToken++;
      cb.actualSummaryNotice = null;
      cb.actualSpendApplying = false;
    },
    // Drop the cached sessions too (new import → run set changed).
    invalidateCache() {
      clearCache();
      state = null;
      loadingPromise = null;
      applyToken++;
      cb.actualSummaryNotice = null;
      cb.actualSpendApplying = false;
    },
    getState() {
      return state;
    },
    isContiguous() {
      if (!state) return true;
      const idxById = new Map(state.sessions.map((s, i) => [s.id, i]));
      const selIdx = state.sessions
        .filter((s) => state.selectedIds.has(s.id))
        .map((s) => idxById.get(s.id));
      return cb.cost.selectionIsContiguous(selIdx);
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
      if (on) selectAll();
      else state.selectedIds = new Set();
      persist();
      notify();
      applySelection();
    },
    setGapMs(gapMs) {
      if (!state || !gapMs || gapMs <= 0 || gapMs === state.gapMs) return;
      // Re-bucketing needs the raw runs. If they were loaded from cache (runs
      // null), force a network reload with the new gap.
      if (!state.runs || !state.runs.length) {
        ensureLoaded({ force: true, gapMs });
        return;
      }
      state.gapMs = gapMs;
      rebucket();
      selectAll(); // session ids change on re-bucket; default to all
      persist();
      notify();
      applySelection();
    },
  };
})();
