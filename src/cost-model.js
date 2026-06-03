(function () {
  "use strict";

  // ---------------------------------------------------------------------------
  // Shared cost model (Phase: cost-model consolidation, v4.0).
  //
  // Single source of truth for "what does an enrichment cost", consumed by the
  // canvas summary (src/canvas/credits.js), the table view's per-row + DP
  // columns (src/table-view.js), and the export / discount calculator
  // (src/export.js). Previously each of those re-implemented the same
  // projected-vs-actual arithmetic and they had drifted (e.g. the export calc
  // ignored coverage; the summary skipped no-spend cards in Actual while the
  // table fell back to projected). Centralizing it here keeps every surface in
  // agreement and makes the projected→fill change a one-place edit.
  //
  // Loaded right after src/store.js (the model layer) so it's available to the
  // canvas, table view, and export modules. Pure functions — no DOM, no canvas
  // dependency; everything is derived from `card.data`, so it works on live
  // cards AND serialized tab.state cards alike.
  // ---------------------------------------------------------------------------

  const cb = (window.__cb = window.__cb || {});

  function isNonErType(type) {
    return type === "dp" || type === "input" || type === "comment";
  }

  // Rows an enrichment actually ran on — the per-row denominator for Actual.
  // Order: run-status coverage.ran (genuine "did it run", frozen at import) →
  // the Records field → cellCount (last resort). NOT cellCount-first: cellCount
  // is credits÷cost (a billing artifact) and is fan-out-inflated for function
  // columns, which understates true per-row cost. See ARCHITECTURE.md.
  function actualRowDenominator(card) {
    const d = (card && card.data) || {};
    const ran = Number(d.stats?.coverage?.ran) || 0;
    if (ran > 0) return ran;
    const recs = cb.getRecordsCount ? Number(cb.getRecordsCount()) || 0 : 0;
    if (recs > 0) return recs;
    return Number(d.stats?.spend?.cellCount) || 0;
  }

  // Per-row (per-execution) cost for one enrichment card, view-mode aware.
  //   Projected: the card's resolved catalog / subroutine credits + actions.
  //   Actual:    measured spend (data.stats.spend) ÷ rows that ran (coverage.ran).
  //
  // Options:
  //   viewMode            - "projected" | "actual" (defaults to __cb.viewMode)
  //   fallbackToProjected - in Actual mode, when a card has no spend yet:
  //                           true  (default) → return the projected value, so
  //                                  a column never blanks (table-view behavior)
  //                           false → return 0 (so it contributes nothing to a
  //                                  total — the canvas summary's behavior)
  //
  // `creditsUnknown` is set when a function's projected cost hasn't resolved
  // yet (fetchSubroutineCostsInBackground still in flight) so callers can show
  // a placeholder instead of a misleading 0.
  function perRowCost(card, opts) {
    opts = opts || {};
    const viewMode = opts.viewMode || cb.viewMode;
    const fallbackToProjected = opts.fallbackToProjected !== false;
    const d = (card && card.data) || {};
    const sp = d.stats && d.stats.spend;

    if (viewMode === "actual" && sp) {
      const denom = actualRowDenominator(card);
      if (denom > 0) {
        return {
          credits: (Number(sp.credits) || 0) / denom,
          actions: (Number(sp.actionExecutions) || 0) / denom,
          creditsUnknown: false,
        };
      }
    }
    if (viewMode === "actual" && !fallbackToProjected) {
      return { credits: 0, actions: 0, creditsUnknown: false, noSpend: true };
    }

    const credits = d.usePrivateKey ? 0 : d.credits != null ? Number(d.credits) : 0;
    const actions = d.actionExecutions != null ? Number(d.actionExecutions) : 0;
    const creditsUnknown =
      d.actionKey === "execute-subroutine" && d.credits == null && !d.usePrivateKey;
    return { credits, actions, creditsUnknown };
  }

  // Per-ER coverage ratio: coverageRows / total-rows (defaults to 1). Pure
  // coverage primitive — the projected cost multiplier (billableFraction) folds
  // fill in on top of this.
  function coverageRatio(card, records) {
    if (!records || records <= 0) return 1;
    const cov =
      card.data.coverageRows != null ? Number(card.data.coverageRows) : records;
    return Number.isFinite(cov) && cov >= 0 ? cov / records : 1;
  }

  // Lineage key for an enrichment card (must match table-view + credits.js):
  // the action field id for standalone / basic-group ERs, "wf:<groupCluster>"
  // for waterfalls.
  function erLineageKey(card) {
    const d = (card && card.data) || {};
    if (isNonErType(d.type)) return null;
    return d.type === "waterfall"
      ? d.groupCluster != null
        ? `wf:${d.groupCluster}`
        : null
      : d.fieldId ?? null;
  }

  // Projected fill fraction (0..1) for a data point. DP cards always carry a
  // normalized fillRate {numerator, denominator} (denominator > 0), defaulting
  // to 100% (n/n) — so an un-edited DP returns 1.0 and doesn't change cost.
  function fillFraction(dpCard) {
    const fr = dpCard && dpCard.data && dpCard.data.fillRate;
    if (!fr || !fr.denominator) return 1;
    const f = Number(fr.numerator) / Number(fr.denominator);
    if (!Number.isFinite(f)) return 1;
    return Math.max(0, Math.min(1, f));
  }

  // Map<erLineageKey, fillRatio> = the average projected fill of the data points
  // each enrichment feeds. Built once per recompute so billableFraction is O(1)
  // per ER (avoids an O(N^2) scan over the summary loop). ERs with no data
  // points are simply absent → billableFraction treats them as fill 1.0.
  function buildErFillMap(cards) {
    const dpErKeys = cb.dpErKeys;
    const acc = new Map(); // key -> { sum, n }
    for (const c of cards) {
      if (!c || !c.data || c.data.type !== "dp") continue;
      const keys = dpErKeys ? dpErKeys(c) : [];
      const f = fillFraction(c);
      for (const k of keys) {
        const e = acc.get(k) || { sum: 0, n: 0 };
        e.sum += f;
        e.n += 1;
        acc.set(k, e);
      }
    }
    const map = new Map();
    for (const [k, e] of acc) map.set(k, e.n > 0 ? e.sum / e.n : 1);
    return map;
  }

  // Projected billable fraction of total rows for an ER = coverage x fill.
  // This is what scales the frequency-weighted "Total" slots (× records).
  //
  // Why fill and not coverage alone: enrichments that run but return no data
  // are refunded, so the billable unit is FILLED cells, not attempted cells.
  // fill is expressed as a fraction of coverage, so absolute billable =
  // coverage × fill. Default fill is 100% → this equals plain coverage until a
  // DP's fill is lowered. See ARCHITECTURE.md "projected cost should key off
  // fill rate" for the rationale + the AI/Claygent caveat (those bill
  // regardless of output, so fill under-counts them — deferred follow-up).
  //
  // `erFillMap` (from buildErFillMap) is optional; when omitted, fill = 1.0.
  function billableFraction(erCard, records, erFillMap) {
    const cov = coverageRatio(erCard, records);
    const key = erLineageKey(erCard);
    const fill =
      key != null && erFillMap && erFillMap.has(key) ? erFillMap.get(key) : 1;
    return cov * fill;
  }

  // Default gap between runs (ms) that starts a new "session". A burst of
  // runs within this window is one work session; a larger gap splits them.
  const DEFAULT_SESSION_GAP_MS = 6 * 60 * 60 * 1000;

  // Cluster per-run spend (from __cb.fetchRunSpend) into time-gap sessions.
  // `runs` is the raw run/recent array; `gapMs` defaults to 6h and is
  // user-editable. Returns sessions oldest→newest, each with ISO bounds
  // (endISO padded +1s for an inclusive byColumn timeRange), rollup totals,
  // and how many columns it touched. Pure — no fetching.
  function bucketRunsIntoSessions(runs, gapMs) {
    if (!Array.isArray(runs) || runs.length === 0) return [];
    const gapSec = (gapMs || DEFAULT_SESSION_GAP_MS) / 1000;
    const sorted = runs.slice().sort((a, b) => a.timestamp - b.timestamp);
    const raw = [];
    let cur = null;
    for (const r of sorted) {
      if (!cur || r.timestamp - cur.lastTs > gapSec) {
        cur = {
          startTs: r.timestamp,
          lastTs: r.timestamp,
          runs: 0,
          credits: 0,
          actionExec: 0,
          cells: 0,
          // Per-column rollup (normalized to the spend-map shape) so the picker
          // can re-derive selection numbers by summing locally — no byColumn
          // fetch. JSON-safe (plain object) so it survives the localStorage cache.
          perField: {},
        };
        raw.push(cur);
      }
      cur.lastTs = r.timestamp;
      cur.runs += 1;
      cur.credits += r.creditsSpent || 0;
      cur.actionExec += r.actionExecutionCreditsSpent || 0;
      cur.cells += r.cellCount || 0;
      for (const c of r.columns || []) {
        if (!c || !c.fieldId) continue;
        const e =
          cur.perField[c.fieldId] ||
          (cur.perField[c.fieldId] = { credits: 0, actionExecutions: 0, cellCount: 0 });
        e.credits += Number(c.creditsSpent) || 0;
        e.actionExecutions += Number(c.actionExecutionCreditsSpent) || 0;
        e.cellCount += Number(c.cellCount) || 0;
      }
    }
    return raw.map((s) => ({
      id: `sess_${s.startTs}_${s.lastTs}`,
      startTs: s.startTs,
      lastTs: s.lastTs,
      startISO: new Date(s.startTs * 1000).toISOString(),
      endISO: new Date((s.lastTs + 1) * 1000).toISOString(),
      runs: s.runs,
      credits: s.credits,
      actionExec: s.actionExec,
      cells: s.cells,
      columnsTouched: Object.keys(s.perField).length,
      perField: s.perField,
    }));
  }

  // ---------------------------------------------------------------------------
  // Use cases (Increment A): a use case = an imported table. The top-level
  // scoping unit that owns its own records + frequency. Cards that don't belong
  // to an imported table map to the "other" bucket, which is excluded from the
  // grand total once there are 2+ table use cases.
  // ---------------------------------------------------------------------------
  const OTHER_USE_CASE = "other";

  function importedTablesMap() {
    return (cb.model && cb.model.getImportedTables && cb.model.getImportedTables()) || {};
  }

  // Is this card's tableId a real imported table (has resolvable metadata)?
  function isImportedTableCard(card) {
    const d = (card && card.data) || {};
    if (!d.tableId) return false;
    const meta = importedTablesMap()[d.tableId];
    return !!(meta?.name || d.tableName);
  }

  // The use-case key that owns a card's COST. Increment A: imported table
  // (`t-${tableId}`) else "other". A data point's cost belongs to its SOURCE
  // ER's use case, so resolve a DP via its source ER when possible.
  function useCaseKeyForCard(card) {
    const d = (card && card.data) || {};
    if (d.type === "dp") {
      const srcKey = d.sourceEnrichmentFieldId;
      if (srcKey != null) {
        const er = (cb.model?.getNodes?.() || []).find(
          (n) =>
            n?.data &&
            !isNonErType(n.data.type) &&
            (n.data.fieldId === srcKey ||
              (n.data.type === "waterfall" && `wf:${n.data.groupCluster}` === srcKey)),
        );
        if (er) return useCaseKeyForCard(er);
      }
    }
    return isImportedTableCard(card) ? `t-${d.tableId}` : OTHER_USE_CASE;
  }

  // Distinct imported-table use cases that contain at least one cost-bearing ER.
  // Returns [{ key, tableId, name, color, recordCount }], table order is the
  // caller's concern (cost doesn't care). Excludes "other".
  function listUseCases() {
    const tables = importedTablesMap();
    const seen = new Map();
    for (const n of cb.model?.getNodes?.() || []) {
      const d = n?.data;
      if (!d || isNonErType(d.type)) continue;
      if (!isImportedTableCard(n)) continue;
      const key = `t-${d.tableId}`;
      if (!seen.has(key)) {
        const meta = tables[d.tableId] || {};
        seen.set(key, {
          key,
          tableId: d.tableId,
          name: meta.name || d.tableName || "Table",
          color: meta.color || meta.importColor || d.importColor || null,
          recordCount: meta.recordCount ?? null,
        });
      }
    }
    return [...seen.values()];
  }

  function useCaseCount() {
    return listUseCases().length;
  }

  // Per-use-case records + frequency live on tab state (useCaseScope), keyed by
  // use-case key. Falls back to the global records/frequency (the single-scope
  // controls) so behavior is identical until 2+ tables exist.
  function useCaseRecords(key) {
    const scope = cb.useCaseScope?.[key];
    if (scope && scope.records != null && Number(scope.records) >= 0) {
      return Number(scope.records);
    }
    // Default: the table's imported row count, else the global records.
    if (key && key.startsWith("t-")) {
      const meta = importedTablesMap()[key.slice(2)];
      if (meta?.recordCount > 0) return Number(meta.recordCount);
    }
    return cb.getRecordsCount ? Number(cb.getRecordsCount()) || 0 : 0;
  }

  function useCaseFrequencyId(key) {
    const scope = cb.useCaseScope?.[key];
    if (scope && scope.frequency) return scope.frequency;
    return cb.getCurrentFrequencyId ? cb.getCurrentFrequencyId() : cb.DEFAULT_FREQUENCY_ID;
  }

  // Grand total + per-use-case breakdown for the multi-use-case (2+ tables)
  // case. Each ER is multiplied by ITS use case's records + frequency; the
  // "other" bucket is excluded. Mirrors the single-mode math (weighted per-row
  // x records) but per use case. `cards` = all model nodes; returns
  // { grandCredits, grandActions, perUseCase:[{key,name,credits,actions}] }.
  function computeUseCaseTotals(cards, opts) {
    opts = opts || {};
    const projected = (opts.viewMode || cb.viewMode) !== "actual";
    const erFillMap = projected ? buildErFillMap(cards) : null;
    const freqMult = (id) => (cb.getFrequencyMultiplier ? cb.getFrequencyMultiplier(id) : 1);
    const buckets = new Map(); // key -> { credits, actions }
    for (const c of cards) {
      const d = c && c.data;
      if (!d || isNonErType(d.type)) continue;
      const key = useCaseKeyForCard(c);
      if (key === OTHER_USE_CASE) continue; // unscoped, excluded from the quote
      const pr = perRowCost(
        c,
        projected
          ? { viewMode: "projected" }
          : { viewMode: "actual", fallbackToProjected: false },
      );
      if (pr.noSpend) continue;
      const freqId = d.frequencyCustom ? d.frequency : d.frequency || useCaseFrequencyId(key);
      const mult = freqMult(freqId);
      const recs = useCaseRecords(key);
      // billableFraction folds coverage x fill (projected only); x recs turns the
      // per-row figure into the use case's absolute billable volume.
      const billable = projected ? billableFraction(c, recs, erFillMap) : 1;
      const b = buckets.get(key) || { credits: 0, actions: 0 };
      b.credits += pr.credits * mult * billable * recs;
      b.actions += pr.actions * mult * billable * recs;
      buckets.set(key, b);
    }
    const meta = new Map(listUseCases().map((u) => [u.key, u]));
    let grandCredits = 0;
    let grandActions = 0;
    const perUseCase = [];
    for (const [key, b] of buckets) {
      grandCredits += b.credits;
      grandActions += b.actions;
      perUseCase.push({ key, name: meta.get(key)?.name || key, credits: b.credits, actions: b.actions });
    }
    return { grandCredits, grandActions, perUseCase };
  }

  cb.cost = {
    isNonErType,
    perRowCost,
    actualRowDenominator,
    coverageRatio,
    erLineageKey,
    fillFraction,
    buildErFillMap,
    billableFraction,
    DEFAULT_SESSION_GAP_MS,
    bucketRunsIntoSessions,
    OTHER_USE_CASE,
    isImportedTableCard,
    useCaseKeyForCard,
    listUseCases,
    useCaseCount,
    useCaseRecords,
    useCaseFrequencyId,
    computeUseCaseTotals,
  };
})();
