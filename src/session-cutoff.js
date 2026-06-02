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
  // Multi-table tabs: sessions are bucketed over the COMBINED run timeline of
  // every imported table; the selected window is fetched per table and stamped
  // onto that table's cards. (Per-table session lists are a future refinement.)
  // ---------------------------------------------------------------------------

  const cb = (window.__cb = window.__cb || {});

  // Runtime state for the active tab. Rebuilt when the tab/table set changes.
  let state = null;
  // {
  //   tableIds: string[], runsByTable: {tid: runs[]}, runs: run[],
  //   sessions: session[], selectedIds: Set<string>, gapMs: number,
  //   loaded: bool, loading: bool, loadToken: number,
  // }
  let loadToken = 0;
  // Listeners (the picker UI) notified when state changes so it can re-render.
  const listeners = new Set();

  function notify() {
    for (const fn of listeners) {
      try {
        fn();
      } catch {}
    }
  }

  function workspaceId() {
    return (
      cb.currentWorkspaceId ||
      cb.parseIdsFromUrl?.()?.workspaceId ||
      null
    );
  }

  function storageKey() {
    const wb = cb.currentWorkbookId || cb.parseIdsFromUrl?.()?.workbookId || "";
    const tab = cb.tabStore?.activeId || "";
    return `cb-session-cutoff-${wb}-${tab}`;
  }

  function loadPersisted() {
    try {
      return JSON.parse(localStorage.getItem(storageKey()) || "null");
    } catch {
      return null;
    }
  }

  function persist() {
    if (!state) return;
    try {
      localStorage.setItem(
        storageKey(),
        JSON.stringify({
          selectedIds: [...state.selectedIds],
          gapMs: state.gapMs,
        }),
      );
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
    state.sessions = cb.cost.bucketRunsIntoSessions(state.runs, state.gapMs);
  }

  function selectAll() {
    state.selectedIds = new Set(state.sessions.map((s) => s.id));
  }

  // Load run/recent for every imported table, bucket, and seed the selection.
  // Idempotent: a no-op when already loaded for the same table set (unless
  // forced). Auto-applies the resolved selection once after a fresh load.
  async function ensureLoaded(opts) {
    opts = opts || {};
    const tableIds = distinctTableIds();
    if (!tableIds.length) {
      state = null;
      notify();
      return null;
    }
    if (state && state.loaded && !opts.force && sameSet(state.tableIds, tableIds)) {
      return state;
    }
    const token = ++loadToken;
    const persisted = loadPersisted();
    const gapMs = persisted?.gapMs || cb.cost.DEFAULT_SESSION_GAP_MS;
    state = {
      tableIds,
      runsByTable: {},
      runs: [],
      sessions: [],
      selectedIds: new Set(),
      gapMs,
      loaded: false,
      loading: true,
      loadToken: token,
    };
    notify();

    const ws = workspaceId();
    const all = [];
    for (const tid of tableIds) {
      const runs = ws ? await cb.fetchRunSpend(ws, tid, 210) : null;
      if (token !== loadToken) return null; // superseded
      if (Array.isArray(runs)) {
        state.runsByTable[tid] = runs;
        for (const r of runs) all.push(r);
      }
    }
    state.runs = all;
    rebucket();

    // Restore a valid persisted selection, else default to ALL sessions.
    const valid = new Set(state.sessions.map((s) => s.id));
    const restored = (persisted?.selectedIds || []).filter((id) => valid.has(id));
    if (restored.length) state.selectedIds = new Set(restored);
    else selectAll();

    state.loading = false;
    state.loaded = true;
    notify();

    // Apply the resolved window so Actual reflects the selected sessions
    // (replacing the import's quick 30-day default).
    if (state.sessions.length) await applySelection({ silent: true });
    return state;
  }

  // Remove any previously-stamped measured spend from a table's cards so a new
  // selection fully replaces it (deselected sessions don't leave stale spend).
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

  // Fetch the selected window(s) per table (hybrid contiguous/non-contiguous),
  // re-stamp the cards, and refresh the summary + table.
  async function applySelection(opts) {
    opts = opts || {};
    if (!state || !state.loaded) return;
    const ws = workspaceId();
    if (!ws) return;

    const idxById = new Map(state.sessions.map((s, i) => [s.id, i]));
    const selected = state.sessions.filter((s) => state.selectedIds.has(s.id));
    const selIdx = selected.map((s) => idxById.get(s.id));
    const contiguous = cb.cost.selectionIsContiguous(selIdx);

    for (const tid of state.tableIds) {
      let merged = new Map();
      if (selected.length) {
        if (contiguous) {
          const startISO = selected[0].startISO;
          const endISO = selected[selected.length - 1].endISO;
          const rows = await cb.fetchColumnSpendForRange(ws, tid, startISO, endISO);
          merged = cb.spendRowsToMap(rows);
        } else {
          for (const s of selected) {
            const rows = await cb.fetchColumnSpendForRange(ws, tid, s.startISO, s.endISO);
            mergeSpendMaps(merged, cb.spendRowsToMap(rows));
          }
        }
      }
      clearTableSpend(tid);
      if (merged.size) cb.applyActualSpend(merged, tid);
    }

    // Refresh through the same path the import settle() uses.
    cb._animateSummary = true;
    try {
      cb.canvas?.refreshCreditTotal?.();
    } finally {
      cb._animateSummary = false;
    }
    cb.canvas?.updateGroupCredits?.();
    cb.applyActualSummaryState?.();
    cb.model?.update?.();
    if (!opts.silent && cb.tableView?.refresh) cb.tableView.refresh();
    persist();
  }

  // ---- Public API (consumed by the picker UI in table-view.js) -------------

  cb.sessionCutoff = {
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    ensureLoaded,
    // Reset when switching tabs so the next render reloads for the new tab.
    invalidate() {
      state = null;
      loadToken++;
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
      if (!state || !gapMs || gapMs <= 0) return;
      const prevSelectedAll =
        state.selectedIds.size === state.sessions.length;
      state.gapMs = gapMs;
      rebucket();
      // Re-bucketing changes session ids; default to all unless the user had a
      // partial selection we can't meaningfully remap.
      selectAll();
      if (!prevSelectedAll) {
        // Keep "all" — partial selections don't survive a re-bucket cleanly.
      }
      persist();
      notify();
      applySelection();
    },
  };
})();
