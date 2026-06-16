(function () {
  "use strict";

  // ---------------------------------------------------------------------------
  // Actual-spend session cutoff (v7.0 — DB-persisted, base-bucket model).
  //
  // Realtime credit data for a table is fetched ONCE from /run/recent (per-run,
  // with a per-column breakdown). We cluster the runs into "sessions" and let the
  // user scope Actual spend to the sessions they care about. The selected
  // sessions' per-column spend is summed locally and stamped onto the cards.
  //
  // Key model (v7.0):
  //  - SOURCE OF TRUTH is the session data, persisted to the DB at the TAB level
  //    (tab.state.sessionCutoff) via the normal model.serialize/saveTabs path —
  //    NOT localStorage. So a reload/another device restores instantly with no
  //    fetch, and re-importing an already-imported table reuses it (amber pill).
  //  - BASE buckets are clustered at a fixed 6h gap and are immutable until a
  //    manual refresh. The user-facing "Group runs within Nh" gap only changes
  //    how the base buckets are MERGED for display (>= 6h). Merging is computed
  //    from the base buckets' start/last stamps + per-column rollups — never from
  //    raw runs — so a gap change needs no refetch and is fully reversible.
  //  - SELECTION lives at the base-bucket granularity, so changing the gap never
  //    changes the counted total; it only regroups the display. A merged session
  //    is checked when all its base children are selected, indeterminate when
  //    some, unchecked when none.
  //  - Per table, the default selection is the base buckets within the probe
  //    window that first returned runs (7, 30, or 90 days — stored as
  //    actualImportDays); if none ran in that window, the single most-recent
  //    base bucket (the fallback drives the stamp — there is no "Expired").
  //    After the probe lands, a wider window is fetched in the background
  //    (7/30 → 90; 90 → 180; if 90 fails → 180).
  //
  // Cross-tab safety: fetches are keyed to a monotonic load token; switching
  // tabs / refreshing supersedes an in-flight load so it can't clobber the tab
  // you moved to (the "same table in two tabs" hazard).
  // ---------------------------------------------------------------------------

  const cb = (window.__cb = window.__cb || {});

  // Base clustering gap (fixed) and the floor for the display gap. Importing
  // always buckets at 6h; the gap can only be raised from here (merging), which
  // is why a gap change never needs the raw runs.
  const BASE_GAP_MS = 6 * 60 * 60 * 1000;
  const MIN_GAP_MS = BASE_GAP_MS;

  let state = null;
  // {
  //   tableIds:[tid], gapMs, loaded, loading, fetchStartedAt, fetchMs,
  //   byTable: { [tid]: {
  //     base: [{ id, startTs, lastTs, runs, credits, actionExec, cells, perField }],
  //     sessions: [displayed merge of base — see recomputeDisplayed],
  //     selectedBaseIds: Set<baseId>,
  //     actualImportDays: 7|30|90|180 (probe window that first hit),
  //     loading, error, reused, lastFetchedAt
  //   } }
  // }
  let loadToken = 0; // bumped ONLY on context change (tab switch / restore /
  // refresh); in-flight loads bail if stale. NOT bumped per ensureLoaded call —
  // doing so orphaned in-flight fetches when a re-render re-entered ensureLoaded.
  let loadSeq = 0; // monotonic; stamped on each table as its base lands so the
  // picker can order columns by completion (first back → first column).
  const tableLoads = new Map(); // tid -> in-flight Promise (per-table dedupe)
  const listeners = new Set();

  function notify() {
    for (const fn of listeners) {
      try { fn(); } catch {}
    }
  }

  function probeDaysList() {
    const raw = cb.SESSION_PROBE_DAYS;
    if (Array.isArray(raw) && raw.length) {
      return raw.map((d) => Number(d)).filter((d) => d > 0);
    }
    return [7, 30, 90];
  }
  function wideDays() {
    return Number(cb.SESSION_WIDE_DAYS) || 90;
  }
  function fallbackDays() {
    return Number(cb.SESSION_FALLBACK_DAYS) || 180;
  }
  function importDaysForTable(tid) {
    const t = state?.byTable?.[tid];
    if (t?.actualImportDays > 0) return t.actualImportDays;
    return Number(cb.ACTUAL_IMPORT_DAYS) || 7;
  }
  // Wider /run/recent window to fetch in the background after a probe hit.
  function backgroundWideDays(hitDays) {
    if (!hitDays || hitDays <= 0) return null;
    const wide = wideDays();
    const fall = fallbackDays();
    if (hitDays <= 30) return wide > hitDays ? wide : null;
    if (hitDays <= wide) return fall > hitDays ? fall : null;
    return null;
  }
  // 7 → 30 → 90 until runs appear; if all empty, one 180-day attempt.
  async function probeRunSpend(ws, tid, token) {
    for (const days of probeDaysList()) {
      const runs = await withTimeout(cb.fetchRunSpend(ws, tid, days));
      if (token !== loadToken) return { hitDays: null, runs: [] };
      const arr = Array.isArray(runs) ? runs : [];
      if (arr.length) return { hitDays: days, runs: arr };
    }
    const fall = fallbackDays();
    const runs = await withTimeout(cb.fetchRunSpend(ws, tid, fall));
    if (token !== loadToken) return { hitDays: null, runs: [] };
    const arr = Array.isArray(runs) ? runs : [];
    return { hitDays: arr.length ? fall : null, runs: arr };
  }
  // Replace base buckets with a wider run/recent window; preserve selection.
  async function loadWideBackground(ws, tid, hitDays, token) {
    let target = backgroundWideDays(hitDays);
    if (!target) return;
    const t = state?.byTable?.[tid];
    if (!t) return;

    let runs = null;
    try {
      runs = await withTimeout(cb.fetchRunSpend(ws, tid, target));
    } catch {
      if (target === wideDays()) {
        target = fallbackDays();
        try {
          runs = await withTimeout(cb.fetchRunSpend(ws, tid, target));
        } catch {
          return;
        }
      } else {
        return;
      }
    }
    if (token !== loadToken) return;
    const arr = Array.isArray(runs) ? runs : [];
    if (!arr.length) return;

    const prevSel = new Set(t.selectedBaseIds);
    t.base = bucketBase(tid, arr);
    t.lastFetchedAt = Date.now();
    const valid = new Set(t.base.map((b) => b.id));
    const kept = [...prevSel].filter((id) => valid.has(id));
    t.selectedBaseIds = kept.length
      ? new Set(kept)
      : defaultSelectionBase(t.base, tid);
    recomputeDisplayed(tid);
    notify();
    applySelection({ silent: true, noPersist: true });
    persist();
  }

  function workspaceId() {
    return cb.currentWorkspaceId || cb.parseIdsFromUrl?.()?.workspaceId || null;
  }

  // First (earliest) "stamp the time" marker for a table, unix seconds, or
  // null. The stamp forces a base-bucket boundary and anchors the default
  // selection (see src/stamps.js). Only the FIRST stamp affects bucketing;
  // a second stamp is a visual-only divider in the picker.
  function firstStampSec(tid) {
    const s = cb.stamps?.getFirstSec?.(tid);
    return Number.isFinite(s) ? s : null;
  }

  function nowMs() {
    return typeof performance !== "undefined" && performance.now
      ? performance.now()
      : Date.now();
  }

  // A run/recent fetch can hang. Cap it so one stalled request resolves to an
  // error+retry instead of a permanent spinner. Pure backstop, not a latency
  // budget (the query is server-side expensive — measured ~32s for a 2.6k-run /
  // 365-day table); the footer pill shows live progress meanwhile.
  const FETCH_TIMEOUT_MS = 120000;
  function withTimeout(promise) {
    return Promise.race([
      promise,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("fetchRunSpend timeout")), FETCH_TIMEOUT_MS),
      ),
    ]);
  }

  function distinctTableIds() {
    const ids = new Set();
    for (const c of cb.canvas?.getCards?.() || []) {
      const t = c.data?.tableId;
      if (t) ids.add(t);
    }
    return [...ids].sort();
  }

  // Cluster a table's raw runs into immutable BASE buckets at the fixed 6h gap.
  // Reuses cost-model's bucketer, then namespaces ids with the table id (+ a
  // "base" marker) so they're globally unique and stable across reloads.
  function bucketBase(tid, runs) {
    const all = Array.isArray(runs) ? runs : [];
    // A stamp must be an exact bucket boundary so the default selection can
    // start precisely at it. Pre-partition the runs at the first stamp and
    // bucket each side separately — a 6h-adjacent pair straddling the stamp
    // would otherwise fuse into one bucket the stamp falls inside of.
    const sSec = firstStampSec(tid);
    let sessions;
    if (sSec != null) {
      sessions = [
        ...cb.cost.bucketRunsIntoSessions(all.filter((r) => r.timestamp < sSec), BASE_GAP_MS),
        ...cb.cost.bucketRunsIntoSessions(all.filter((r) => r.timestamp >= sSec), BASE_GAP_MS),
      ];
    } else {
      sessions = cb.cost.bucketRunsIntoSessions(all, BASE_GAP_MS);
    }
    return sessions.map((s) => ({
      id: `${tid}::base_${s.startTs}_${s.lastTs}`,
      startTs: s.startTs,
      lastTs: s.lastTs,
      runs: s.runs || 0,
      credits: s.credits || 0,
      actionExec: s.actionExec || 0,
      cells: s.cells || 0,
      perField: s.perField || {},
    }));
  }

  // Merge BASE buckets into displayed sessions at the given gap (>= 6h). Adjacent
  // base buckets whose inter-gap <= gapMs collapse into one session whose totals
  // and per-column rollup are the sum of its children. `selected` is derived from
  // the base-level selection set: all / some (indeterminate) / none.
  function mergeBase(tid, base, gapMs, selectedBaseIds) {
    const gapSec = Math.max(MIN_GAP_MS, gapMs || BASE_GAP_MS) / 1000;
    // Never merge a displayed session across the first stamp — the picker's
    // amber divider needs to sit BETWEEN sessions, and "reset to stamp" needs
    // the boundary visible at any gap setting.
    const sSec = firstStampSec(tid);
    const groups = [];
    let cur = null;
    for (const b of base) {
      const crossesStamp = sSec != null && cur && cur.lastTs < sSec && b.startTs >= sSec;
      if (!cur || b.startTs - cur.lastTs > gapSec || crossesStamp) {
        cur = {
          childIds: [],
          startTs: b.startTs,
          lastTs: b.lastTs,
          runs: 0,
          credits: 0,
          actionExec: 0,
          cells: 0,
          perField: {},
        };
        groups.push(cur);
      }
      cur.lastTs = b.lastTs;
      cur.childIds.push(b.id);
      cur.runs += b.runs || 0;
      cur.credits += b.credits || 0;
      cur.actionExec += b.actionExec || 0;
      cur.cells += b.cells || 0;
      for (const fid of Object.keys(b.perField || {})) {
        const v = b.perField[fid];
        const e =
          cur.perField[fid] ||
          (cur.perField[fid] = { credits: 0, actionExecutions: 0, cellCount: 0 });
        e.credits += Number(v.credits) || 0;
        e.actionExecutions += Number(v.actionExecutions) || 0;
        e.cellCount += Number(v.cellCount) || 0;
      }
    }
    return groups.map((g) => {
      const selCount = g.childIds.filter((id) => selectedBaseIds.has(id)).length;
      return {
        id: `${tid}::disp_${g.startTs}_${g.lastTs}`,
        startTs: g.startTs,
        lastTs: g.lastTs,
        startISO: new Date(g.startTs * 1000).toISOString(),
        endISO: new Date((g.lastTs + 1) * 1000).toISOString(),
        runs: g.runs,
        credits: g.credits,
        actionExec: g.actionExec,
        cells: g.cells,
        columnsTouched: Object.keys(g.perField).length,
        perField: g.perField,
        childIds: g.childIds,
        selected: selCount === 0 ? "none" : selCount === g.childIds.length ? "all" : "some",
      };
    });
  }

  // Recompute the displayed (merged) sessions for one table (or all) from its
  // base + the current gap + selection. Called after any load / selection / gap
  // change, before notify, so the UI reads fresh `sessions`.
  function recomputeDisplayed(tid) {
    if (!state) return;
    const ids = tid ? [tid] : state.tableIds;
    for (const id of ids) {
      const t = state.byTable[id];
      if (!t) continue;
      t.sessions = mergeBase(id, t.base || [], state.gapMs, t.selectedBaseIds);
    }
  }

  // Default = base buckets at/after the table's first stamp when one exists;
  // else base buckets within the table's probe window (actualImportDays); else the
  // single most-recent base bucket (base is oldest→newest). The fallback is what
  // makes the most-recent session drive the stamp when nothing ran in the window.
  function defaultSelectionBase(base, tid) {
    if (!base.length) return new Set();
    const sSec = firstStampSec(tid);
    if (sSec != null) {
      const since = base.filter((b) => b.startTs >= sSec);
      // Nothing ran since the stamp → fall through to the regular default
      // (the picker still shows the divider above an older selection).
      if (since.length) return new Set(since.map((b) => b.id));
    }
    const cutoffSec = Date.now() / 1000 - importDaysForTable(tid) * 86400;
    const recent = base.filter((b) => b.lastTs >= cutoffSec);
    if (recent.length) return new Set(recent.map((b) => b.id));
    return new Set([base[base.length - 1].id]);
  }

  function hasAnySessions() {
    return !!state && state.tableIds.some((tid) => state.byTable[tid]?.base?.length);
  }

  // Scan every loaded tab's saved session blob for this table's base buckets, so
  // a re-import (or a 2nd tab importing an already-imported table) reuses them
  // with no fetch. Tab states come from the DB on a cold load, so this works
  // cross-device too. Returns { base, lastFetchedAt } or null.
  function findSavedBase(tid) {
    for (const tab of cb.tabStore?.tabs || []) {
      const ct = tab?.state?.sessionCutoff?.byTable?.[tid];
      if (ct?.base?.length) {
        return {
          base: ct.base,
          lastFetchedAt: ct.lastFetchedAt || null,
          actualImportDays: ct.actualImportDays || null,
        };
      }
    }
    return null;
  }

  // Load one table's base data. Order: reuse a saved blob from any tab (no
  // fetch, amber) → exponential probe 7→30→90 (then 180 if empty) → background
  // widen (7/30→90, 90→180). `force` skips reuse. Progressive reveal on probe
  // hit; wider window merges in without blocking the spinner.
  async function loadOne(tid, token, force) {
    if (!state || !state.byTable[tid]) return;
    const t = state.byTable[tid];
    let probeHitDays = null;
    try {
      let saved = force ? null : findSavedBase(tid);
      // A blob bucketed BEFORE the stamp existed may have a bucket spanning
      // it — the stamp wouldn't be a selectable boundary. Refetch fresh so
      // bucketBase can split exactly at the stamp.
      const sSec = firstStampSec(tid);
      if (
        saved &&
        sSec != null &&
        saved.base.some((b) => b.startTs < sSec && b.lastTs >= sSec)
      ) {
        saved = null;
      }
      if (saved && saved.base.length) {
        t.base = saved.base;
        t.lastFetchedAt = saved.lastFetchedAt;
        t.actualImportDays = saved.actualImportDays || 7;
        t.reused = true; // stale-ish (came from a prior fetch) → amber pill
        t.selectedBaseIds = defaultSelectionBase(t.base, tid); // fresh choice for this tab
        t.error = false;
        t.loadedSeq = ++loadSeq; // completion order → first back, first column
      } else {
        const ws = workspaceId();
        if (!ws) throw new Error("no workspace");
        const { hitDays, runs } = await probeRunSpend(ws, tid, token);
        if (token !== loadToken) return; // superseded (tab switch / refresh)
        probeHitDays = hitDays;
        t.actualImportDays = hitDays || 7;
        t.base = bucketBase(tid, runs);
        t.lastFetchedAt = Date.now();
        t.reused = false;
        t.selectedBaseIds = defaultSelectionBase(t.base, tid);
        t.error = false;
        t.loadedSeq = ++loadSeq;
      }
    } catch {
      if (token === loadToken) {
        t.base = null; // null (not []) so a retry re-attempts it
        t.selectedBaseIds = new Set();
        t.error = true;
      }
    } finally {
      if (token === loadToken && state?.byTable?.[tid]) {
        t.loading = false;
        recomputeDisplayed(tid);
        notify();
        applySelection({ silent: true, noPersist: true });
        if (probeHitDays && !t.reused) {
          const ws = workspaceId();
          if (ws) {
            loadWideBackground(ws, tid, probeHitDays, token).catch(() => {});
          }
        }
      }
    }
  }

  // Idempotent, INCREMENTAL loader. Seeds a state shell, then starts a load for
  // each current table that lacks base data and isn't already loading. Safe to
  // call on every render: it never restarts an in-flight load or bumps the token
  // (that was the v7.0 bug — re-entrant calls orphaned the fetch). New imports
  // add their table; removed tables are dropped. `force` reloads from network.
  function ensureLoaded(opts) {
    opts = opts || {};
    const tableIds = distinctTableIds();
    if (!tableIds.length) {
      state = null;
      notify();
      return Promise.resolve(null);
    }

    if (!state) {
      state = {
        tableIds: [],
        gapMs: BASE_GAP_MS,
        loaded: false,
        loading: false,
        byTable: {},
        fetchStartedAt: null,
        fetchMs: null,
      };
    }
    state.tableIds = tableIds;

    // Drop tables no longer on the canvas.
    for (const tid of Object.keys(state.byTable)) {
      if (!tableIds.includes(tid)) {
        delete state.byTable[tid];
        tableLoads.delete(tid);
      }
    }

    const token = loadToken; // current context — NOT bumped here
    const wasLoading = tableLoads.size > 0;
    let willFetch = false;

    for (const tid of tableIds) {
      let t = state.byTable[tid];
      if (opts.force) {
        if (t) { t.base = null; t.reused = false; }
        tableLoads.delete(tid); // allow a fresh load even if one was running
      }
      t = state.byTable[tid];
      if (t && t.base && t.base.length) continue; // already loaded
      if (tableLoads.has(tid)) continue; // already loading — don't restart
      // (Re)skeleton this table and start its load.
      state.byTable[tid] = {
        base: null,
        sessions: [],
        selectedBaseIds: new Set(),
        actualImportDays: 7,
        loading: true,
        error: false,
        reused: false,
        lastFetchedAt: t?.lastFetchedAt ?? null,
      };
      if (opts.force || !findSavedBase(tid)) willFetch = true;
      const p = loadOne(tid, token, opts.force).finally(() => tableLoads.delete(tid));
      tableLoads.set(tid, p);
    }

    state.loading = tableLoads.size > 0;
    // Start the load-timer afresh only when a new fetch batch begins from idle.
    if (willFetch && !wasLoading) {
      state.fetchStartedAt = nowMs();
      state.fetchMs = null;
    }
    if (!state.loading) state.loaded = true;
    recomputeDisplayed();
    notify();

    const pending = [...tableLoads.values()];
    if (!pending.length) return Promise.resolve(state);

    return Promise.allSettled(pending).then(() => {
      if (token !== loadToken) return null;
      if (tableLoads.size === 0) {
        state.loaded = true;
        state.loading = false;
        if (state.fetchStartedAt != null && state.fetchMs == null) {
          state.fetchMs = nowMs() - state.fetchStartedAt;
        }
        recomputeDisplayed();
        notify();
        if (hasAnySessions()) applySelection({ silent: true, noPersist: true });
        // Persist freshly loaded sessions to the DB so a reload/re-import reuses
        // them with no refetch (the whole point of the cache).
        persist();
      }
      return state;
    });
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

  // Sum ONE table's selected BASE buckets' per-column rollups into a fieldId ->
  // spend map. Selection is at base granularity, so the gap (display merge) never
  // affects this total.
  function buildSelectedSpendMapForTable(tid) {
    const merged = new Map();
    const t = state.byTable[tid];
    if (!t || !t.base) return merged;
    for (const b of t.base) {
      if (!t.selectedBaseIds.has(b.id)) continue;
      const pf = b.perField || {};
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

  // Count of selected DISPLAYED sessions across all tables (the Actual badge).
  // Counts grouped sessions, not raw 6h base buckets — a merged session with any
  // selected child counts once, so the badge matches what the user sees at the
  // current gap.
  function totalSelected() {
    if (!state) return 0;
    let n = 0;
    for (const tid of state.tableIds) {
      const t = state.byTable[tid];
      if (!t || !t.sessions) continue;
      for (const s of t.sessions) if (s.selected && s.selected !== "none") n++;
    }
    return n;
  }

  function setNotice(notice) {
    cb.actualSummaryNotice = notice || null;
  }

  // Persist the active tab's session state to the DB (debounced, via saveTabs ->
  // serialize). No localStorage anymore.
  function persist() {
    cb.debouncedSave?.();
  }

  function refreshSummary(silent) {
    // Recompute the Actual loading flag BEFORE the recalc — the summary renderer
    // reads it synchronously (matches overlay.js setViewMode order).
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

  // Re-derive Actual spend from the selected base buckets (local sum) and
  // re-stamp, per table. Synchronous and instant — no network.
  function applySelection(opts) {
    opts = opts || {};
    if (!state) return;
    cb.actualSpendApplying = false;

    if (totalSelected() === 0) {
      for (const tid of state.tableIds) clearTableSpend(tid);
      // Quiet while still loading (avoid a flash before defaults land).
      setNotice(
        state.loading
          ? null
          : {
              label: "\u2014",
              tooltip:
                "No sessions selected \u2014 pick at least one session to count Actual spend.",
            },
      );
      refreshSummary(opts.silent);
      if (!opts.noPersist) persist();
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
    // Selection has spend but none of its columns are cost cards on this canvas
    // (e.g. a since-deleted column). Show "—" rather than a misleading number.
    if (anySelected && !stamped && !state.loading) {
      setNotice({
        label: "\u2014",
        tooltip:
          "The selected session(s) ran columns that aren't on this canvas. " +
          "Pick a session that ran these enrichments to count its Actual spend.",
      });
    }
    refreshSummary(opts.silent);
    if (!opts.noPersist) persist();
  }

  // Toggle a DISPLAYED session: flip ALL its base children together. If every
  // child is already selected, clear them; otherwise select them all (so a
  // partial/indeterminate session becomes fully selected on click).
  function toggleDisplayed(tid, displayedId) {
    const t = state?.byTable?.[tid];
    if (!t) return;
    const sess = (t.sessions || []).find((s) => s.id === displayedId);
    if (!sess) return;
    const allSelected = sess.childIds.every((id) => t.selectedBaseIds.has(id));
    for (const id of sess.childIds) {
      if (allSelected) t.selectedBaseIds.delete(id);
      else t.selectedBaseIds.add(id);
    }
  }

  // ---- Public API (consumed by the picker UI in table-view.js) -------------

  cb.sessionCutoff = {
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    ensureLoaded,

    // Tab switch / canvas teardown: drop in-memory state (DB has the truth).
    // Supersede any in-flight load so it can't stamp the tab we moved to.
    invalidate() {
      loadToken++;
      tableLoads.clear();
      state = null;
      cb.actualSummaryNotice = null;
      cb.actualSpendApplying = false;
    },

    // Rehydrate from a tab's saved blob (DB) — instant, no fetch. Cards already
    // carry their persisted spend, but we re-stamp from the saved selection to
    // stay consistent. Called on tab open / switch (see overlay.js, tabs.js).
    restore(saved) {
      loadToken++;
      tableLoads.clear();
      cb.actualSummaryNotice = null;
      cb.actualSpendApplying = false;
      const tableIds = distinctTableIds();
      if (!saved || !saved.byTable || !tableIds.length) {
        state = null;
        return;
      }
      state = {
        tableIds,
        gapMs: Math.max(MIN_GAP_MS, saved.gapMs || BASE_GAP_MS),
        loaded: true,
        loading: false,
        byTable: {},
        fetchStartedAt: null,
        fetchMs: saved.fetchMs ?? null, // last fetch duration, for the pill
      };
      for (const tid of tableIds) {
        const ct = saved.byTable[tid];
        if (ct && Array.isArray(ct.base)) {
          const valid = new Set(ct.base.map((b) => b.id));
          const sel = (ct.selectedBaseIds || []).filter((id) => valid.has(id));
          state.byTable[tid] = {
            base: ct.base,
            sessions: [],
            actualImportDays: ct.actualImportDays || 7,
            selectedBaseIds: new Set(),
            loading: false,
            error: false,
            // Persisted amber "cached" state survives the reload (cleared only
            // by an explicit refresh, which refetches fresh).
            reused: !!ct.reused,
            lastFetchedAt: ct.lastFetchedAt || null,
            loadedSeq: ++loadSeq, // keep saved order on reopen
          };
          state.byTable[tid].selectedBaseIds = sel.length
            ? new Set(sel)
            : defaultSelectionBase(ct.base, tid);
        } else {
          // On the canvas but not in the saved blob (e.g. imported in another
          // session) — mark for ensureLoaded to fill.
          state.byTable[tid] = {
            base: null,
            sessions: [],
            selectedBaseIds: new Set(),
            actualImportDays: 7,
            loading: true,
            error: false,
            reused: false,
            lastFetchedAt: null,
          };
        }
      }
      recomputeDisplayed();
      notify();
      if (hasAnySessions()) applySelection({ silent: true, noPersist: true });
      // Fill any table that wasn't in the saved blob.
      if (tableIds.some((tid) => !state.byTable[tid].base)) ensureLoaded();
    },

    // Serialize the active tab's session state for tab.state (called by saveTabs).
    // Stores the immutable base buckets + base-level selection + when it was
    // fetched. No raw runs, no displayed merge (recomputed from base on restore).
    serialize() {
      if (!state) return null;
      const byTable = {};
      for (const tid of state.tableIds) {
        const t = state.byTable[tid];
        if (!t || !t.base) continue;
        byTable[tid] = {
          base: t.base,
          selectedBaseIds: [...t.selectedBaseIds],
          actualImportDays: t.actualImportDays || 7,
          lastFetchedAt: t.lastFetchedAt || null,
          reused: !!t.reused, // persist the amber "cached" state across reloads
        };
      }
      if (!Object.keys(byTable).length) return null;
      return { byTable, gapMs: state.gapMs, fetchMs: state.fetchMs ?? null };
    },

    // Manual refresh from the footer pill: re-probe all current tables (force).
    refresh() {
      loadToken++;
      tableLoads.clear();
      if (state) {
        for (const tid of state.tableIds) {
          const t = state.byTable[tid];
          if (t) { t.base = null; t.reused = false; }
        }
      }
      return ensureLoaded({ force: true });
    },

    // Called by table-import after (re)importing a table's cards. If we already
    // have its base in memory, it's a re-import → mark amber + re-stamp the fresh
    // cards. If not, ensureLoaded will fill it (reused/amber if found elsewhere).
    noteImport(tid) {
      if (!state || !state.byTable?.[tid]) return;
      const t = state.byTable[tid];
      if (t.base && t.base.length) {
        t.reused = true;
        recomputeDisplayed(tid);
        notify();
        applySelection({ silent: true });
      }
    },

    getState() {
      return state;
    },

    // Footer pill: oldest fetch time across current tables + whether any table is
    // a reuse (→ amber nudge) + whether any errored (→ red) + in-flight.
    fetchInfo() {
      if (!state) {
        return {
          lastFetchedAt: null, anyReused: false, anyError: false,
          loading: false, fetchMs: null,
        };
      }
      let oldest = null;
      let anyReused = false;
      let anyError = false;
      for (const tid of state.tableIds) {
        const t = state.byTable[tid];
        if (!t) continue;
        if (t.reused) anyReused = true;
        if (t.error) anyError = true;
        if (t.lastFetchedAt != null) {
          oldest = oldest == null ? t.lastFetchedAt : Math.min(oldest, t.lastFetchedAt);
        }
      }
      return {
        lastFetchedAt: oldest, anyReused, anyError,
        loading: !!state.loading, fetchMs: state.fetchMs ?? null,
      };
    },

    totalSelected,

    toggle(tid, displayedId) {
      toggleDisplayed(tid, displayedId);
      recomputeDisplayed(tid);
      notify();
      applySelection();
    },

    // "Reset selection to stamp": re-apply the stamp-anchored default for one
    // table (everything at/after the first stamp). Wired to the picker's
    // amber Stamp pill so the marker has an active role, not just decoration.
    resetToStamp(tid) {
      const t = state?.byTable?.[tid];
      if (!t || !t.base || !t.base.length) return;
      t.selectedBaseIds = defaultSelectionBase(t.base, tid);
      recomputeDisplayed(tid);
      notify();
      applySelection();
    },

    setAll(tid, on) {
      const t = state?.byTable?.[tid];
      if (!t || !t.base) return;
      t.selectedBaseIds = on ? new Set(t.base.map((b) => b.id)) : new Set();
      recomputeDisplayed(tid);
      notify();
      applySelection();
    },

    setAllTables(on) {
      if (!state) return;
      for (const tid of state.tableIds) {
        const t = state.byTable[tid];
        if (!t || !t.base) continue;
        t.selectedBaseIds = on ? new Set(t.base.map((b) => b.id)) : new Set();
      }
      recomputeDisplayed();
      notify();
      applySelection();
    },

    // Change the display grouping. Floored at 6h and computed by re-merging the
    // base buckets — never a refetch, fully reversible. Selection is at base
    // granularity, so the counted total is unchanged; only the grouping shifts.
    setGapMs(gapMs) {
      if (!state) return;
      const next = Math.max(MIN_GAP_MS, Number(gapMs) || BASE_GAP_MS);
      if (next === state.gapMs) return;
      state.gapMs = next;
      recomputeDisplayed();
      notify();
      // Re-stamp is a no-op for totals (base selection unchanged) but refreshes
      // the table view; persist the new gap.
      applySelection();
    },

    MIN_GAP_MS,
    BASE_GAP_MS,
  };
})();
