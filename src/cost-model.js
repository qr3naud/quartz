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

  // Action executions are a MODERN-plan-only billing dimension: the 2026 pricing
  // split introduced them, so legacy (pre-2026) plans never bill them — even
  // though Clay's action catalog carries a per-action `actionExecution` count on
  // its LEGACY tier too (e.g. use-ai's prePricingChange2026 lists actionExecution
  // 1). The catalog value only says an action *can* bill an execution; whether it
  // *is* billed is a plan property. Gate on the plan, not the catalog. An unknown
  // plan (fetch failed) keeps actions so we never hide real modern spend.
  function planBillsActions() {
    return cb.currentPlanPricing?.planIsLegacy !== true;
  }
  cb.planBillsActions = planBillsActions;

  // Rows an enrichment actually ran on — the per-row denominator for Actual.
  // Order: run-status coverage.ran (genuine "did it run", frozen at import) →
  // the Records field → cellCount (last resort). NOT cellCount-first: cellCount
  // is credits÷cost (a billing artifact) and is fan-out-inflated for function
  // columns, which understates true per-row cost. See ARCHITECTURE.md.
  function actualRowDenominator(card) {
    const d = (card && card.data) || {};
    // Signal spend is a per-run total, not per-output-row — never divide it by
    // the table's Records. perRowCost handles signals directly, but guard here
    // so any other caller can't re-divide signal spend.
    if (isSignalCard(card)) return 1;
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
  // yet (resolveSubroutineCostsForCards still in flight) so callers can show
  // a placeholder instead of a misleading 0.
  function perRowCostRaw(card, opts) {
    opts = opts || {};
    const viewMode = opts.viewMode || cb.viewMode;
    const fallbackToProjected = opts.fallbackToProjected !== false;
    const d = (card && card.data) || {};
    // Frozen enrichment: the rep deactivated it to model "what if we drop this".
    // It contributes no cost anywhere — every total (table per-row/per-DP, the
    // canvas summary, use-case/tab totals, and pricing) funnels through here.
    if (d.frozen) {
      return { credits: 0, actions: 0, creditsUnknown: false, frozen: true };
    }
    const sp = d.stats && d.stats.spend;

    // Signal sources bill per monitoring run (or per result), NOT per output
    // row. Measured spend is already the full run total (e.g. 2 cr / 10 act for
    // one run across 10 monitored records). Dividing it by the output table's
    // Records (464) would zero the display — so handle signals before the
    // generic per-row divide.
    if (viewMode === "actual" && sp && isSignalCard(card)) {
      const unit = d.signalChargeUnit || "run";
      if (unit === "result") {
        // Per-result spend is per-event; divide by results pulled, never by the
        // full output-table Records denominator.
        const denom =
          signalRunVolume(card) || Number(sp.cellCount) || 1;
        return {
          credits: (Number(sp.credits) || 0) / denom,
          actions: (Number(sp.actionExecutions) || 0) / denom,
          creditsUnknown: false,
        };
      }
      // Per-run / per-record: spend IS the full run total — return as-is.
      return {
        credits: Number(sp.credits) || 0,
        actions: Number(sp.actionExecutions) || 0,
        creditsUnknown: false,
      };
    }

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

  // Public per-row cost. Wraps perRowCostRaw with the plan-level action gate:
  // legacy plans never bill action executions, so zero them here — the single
  // chokepoint every surface funnels through (per-row columns, ER chips,
  // computeUseCaseTotals, the summary grand total, and computeTabTotals/exports).
  // credits are left to perRowCostRaw (usePrivateKey / actual spend / catalog).
  function perRowCost(card, opts) {
    const r = perRowCostRaw(card, opts);
    if (r && r.actions && !planBillsActions()) r.actions = 0;
    return r;
  }

  // Native signal source: its credits/actions are a RECURRING per-run (or
  // per-result) monitoring cost, not a per-output-row cost. Stamped at import
  // (table-import.js applySignalCardData / buildSignalSourceFieldCost).
  function isSignalCard(card) {
    const d = (card && card.data) || {};
    return !!(d.isSignal || d.signalChargeUnit);
  }
  cb.isSignalCard = isSignalCard;

  // Per-run unit count for a signal before frequency. Per-run signals return a
  // server-total cost (already × monitored records), so volume is 1. Per-result
  // signals return a per-event rate — multiply by results pulled. Clay stores
  // that in source.state.numSourceRecords UNLESS forwardRecords is true (native
  // scheduler signals), in which case numSourceRecords stays 0 and the count is
  // the output table's row count (stamped as signalResultCount at import).
  function signalRunVolume(card) {
    const d = (card && card.data) || {};
    if (!isSignalCard(card)) return 1;
    const unit = d.signalChargeUnit || "run";
    // Per-result signals with forwardRecords: numSourceRecords is always 0 on
    // the API (rows land on the output table, not source_records). Fall back
    // to the output table row count at import time.
    if (unit === "result") {
      const n = Number(d.signalResultCount);
      if (Number.isFinite(n) && n > 0) return n;
      return 1;
    }
    if (unit === "record") {
      const n = Number(d.monitoredRecordCount);
      return Number.isFinite(n) && n > 0 ? n : 1;
    }
    return 1;
  }
  cb.signalRunVolume = signalRunVolume;

  // Annual VOLUME multiplier for a card: how many "units" its per-unit cost
  // applies to in a year, before frequency. Normal enrichments scale by the
  // rows that run (projected billable fraction × records). Signals bill per
  // monitoring run (volume = signalRunVolume) — NOT × the output table's
  // Records denominator. Centralizes the "no × records for signals" rule.
  function annualVolume(card, records, billable) {
    if (isSignalCard(card)) return signalRunVolume(card);
    return (Number(billable) || 0) * (Number(records) || 0);
  }
  cb.annualVolume = annualVolume;

  // Per-ER coverage ratio: coverageRows / total-rows (defaults to 1, capped at
  // 1). The numerator (rows that run) can never exceed the denominator (records),
  // so a coverageRows override above records still costs at most the full table.
  function coverageRatio(card, records) {
    if (!records || records <= 0) return 1;
    const cov =
      card.data.coverageRows != null ? Number(card.data.coverageRows) : records;
    return Number.isFinite(cov) && cov >= 0 ? Math.min(1, cov / records) : 1;
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

  // Projected billable fraction of total rows for an ER = coverage only.
  //
  // Cost is incurred when a row RUNS, so it keys off coverage (rows attempted),
  // NOT fill: fill rate is a performance metric ("did Clay return data"), and a
  // row that ran has already incurred its cost regardless of whether it filled.
  // (fillFraction / buildErFillMap remain for the DP fill DISPLAY, but no longer
  // scale cost.)
  function billableFraction(erCard, records) {
    return coverageRatio(erCard, records);
  }

  // Projected run rate (0..1) for an ER = rows it's set to run on ÷ its
  // attempted total — the editable coverage pair the run-rate popover edits,
  // both defaulting to the ER's scoped records (per-use-case records when the
  // ER lives in an imported table, the global Records otherwise). This is the
  // SINGLE projected weight for an ER on a multi-ER data point: a DP linking
  // two ERs costs Σ credits_i × runRate_i, so two untouched ERs (100% each)
  // are additive — the healthy default. Mirrors buildErChipData's
  // projectedRunRate so the chip % badge and the cost always agree.
  function projectedRunRate(erCard) {
    const d = (erCard && erCard.data) || {};
    const ucKey = useCaseKeyForCard(erCard);
    const scoped =
      useCaseCount() >= 1 && ucKey && ucKey !== OTHER_USE_CASE
        ? Number(useCaseRecords(ucKey)) || 0
        : Number(cb.getRecordsCount ? cb.getRecordsCount() : 0) || 0;
    const rows = d.coverageRows != null ? Number(d.coverageRows) || 0 : scoped;
    const total = d.coverageTotalCustom ? Number(d.coverageTotal) || 0 : scoped;
    if (!(total > 0)) return 1;
    return Math.max(0, Math.min(1, rows / total));
  }

  // Measured (Actual) coverage ratio for an ER = stats.coverage.ran / total,
  // i.e. the fraction of the table's rows the enrichment actually ran on. Used
  // to scale measured spend to the scoped Records: combined with the per-row
  // denominator (coverage.ran) the `ran` cancels, so an Actual use-case total
  // becomes sessionSpend × Records / total. Defaults to 1 when no coverage
  // stats exist (then Actual cost is just spend × Records, the prior behavior).
  function actualCoverageRatio(card) {
    const cov = card && card.data && card.data.stats && card.data.stats.coverage;
    const ran = Number(cov && cov.ran) || 0;
    const total = Number(cov && cov.total) || 0;
    return ran > 0 && total > 0 ? ran / total : 1;
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
    // Table-native (v7.23+): a card's use case is its top-level (L1) group.
    const uc =
      cb.model && cb.model.useCaseGroupForCard
        ? cb.model.useCaseGroupForCard(card)
        : null;
    if (uc) return `g-${uc.id}`;
    // A data point with no group of its own inherits its source ER's use case.
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
    // An enrichment with no group of its own inherits the use case of the
    // grouped data points it feeds — the rep groups DP rows, and the ER is a
    // chip on them, so the ER's cost should land in the same use case. (A
    // grouped DP short-circuits at the top, so there's no recursion.)
    if (!isNonErType(d.type) && cb.dpErKeys) {
      const erKey = erLineageKey(card);
      if (erKey != null) {
        for (const n of cb.model?.getNodes?.() || []) {
          if (!n || !n.data || n.data.type !== "dp" || n.groupId == null) continue;
          if (cb.dpErKeys(n).includes(erKey)) {
            const g = cb.model.useCaseGroupForCard(n);
            if (g) return `g-${g.id}`;
          }
        }
      }
    }
    // Legacy fallback (pre-migration data): imported-table tag.
    return isImportedTableCard(card) ? `t-${d.tableId}` : OTHER_USE_CASE;
  }

  // Resolve a use-case group object from a `g-<id>` key (null otherwise).
  function groupForUseCaseKey(key) {
    if (typeof key !== "string" || !key.startsWith("g-")) return null;
    const id = Number(key.slice(2));
    return (cb.model && cb.model.getGroup && cb.model.getGroup(id)) || null;
  }

  // Distinct imported-table use cases that contain at least one cost-bearing ER.
  // Returns [{ key, tableId, name, color, recordCount }], table order is the
  // caller's concern (cost doesn't care). Excludes "other".
  function listUseCases() {
    // Table-native: every top-level (L1) group is a use case (import-derived or
    // user-created). The migration adapter guarantees imported tables have one.
    const groups = cb.model?.getGroups?.() || [];
    const tops = groups.filter((g) => (g.parentId ?? null) === null);
    if (tops.length > 0) {
      const tables = importedTablesMap();
      return tops
        .slice()
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
        .map((g) => ({
          key: `g-${g.id}`,
          groupId: g.id,
          tableId: g.tableId ?? null,
          name: g.label || (g.source === "import-table" ? "Table" : "Use case"),
          color: null,
          recordCount:
            g.records != null
              ? Number(g.records)
              : g.tableId
                ? tables[g.tableId]?.recordCount ?? null
                : null,
        }));
    }
    // Legacy fallback (pre-migration / no groups yet): imported tables.
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
    // Table-native: records live on the L1 use-case group.
    const g = groupForUseCaseKey(key);
    if (g) {
      if (g.records != null && Number(g.records) >= 0) return Number(g.records);
      if (g.tableId) {
        const meta = importedTablesMap()[g.tableId];
        if (meta?.recordCount > 0) return Number(meta.recordCount);
      }
      return cb.getRecordsCount ? Number(cb.getRecordsCount()) || 0 : 0;
    }
    // Legacy tableId-keyed scope.
    const scope = cb.useCaseScope?.[key];
    if (scope && scope.records != null && Number(scope.records) >= 0) {
      return Number(scope.records);
    }
    if (key && key.startsWith("t-")) {
      const meta = importedTablesMap()[key.slice(2)];
      if (meta?.recordCount > 0) return Number(meta.recordCount);
    }
    return cb.getRecordsCount ? Number(cb.getRecordsCount()) || 0 : 0;
  }

  function useCaseFrequencyId(key) {
    const g = groupForUseCaseKey(key);
    if (g) {
      if (g.frequency) return g.frequency;
      return cb.getCurrentFrequencyId ? cb.getCurrentFrequencyId() : cb.DEFAULT_FREQUENCY_ID;
    }
    const scope = cb.useCaseScope?.[key];
    if (scope && scope.frequency) return scope.frequency;
    return cb.getCurrentFrequencyId ? cb.getCurrentFrequencyId() : cb.DEFAULT_FREQUENCY_ID;
  }

  // The "as-imported" baseline records for a use case (the table's own row
  // count), independent of any user override in useCaseScope. Used by the header
  // controls to decide whether the records field is in an "override" (amber)
  // state — mirrors __cb.recordsActual for the single-table summary bar. Returns
  // null when there is no resolvable imported count.
  function useCaseRecordsActual(key) {
    // Table-native: the import baseline for a use-case group is its table's
    // recordCount (drives the records-override amber on the header).
    const g = groupForUseCaseKey(key);
    if (g) {
      if (g.tableId) {
        const meta = importedTablesMap()[g.tableId];
        if (meta && meta.recordCount > 0) return Number(meta.recordCount);
      }
      return null;
    }
    if (key && key.startsWith("t-")) {
      const meta = importedTablesMap()[key.slice(2)];
      if (meta && meta.recordCount > 0) return Number(meta.recordCount);
    }
    return null;
  }

  // Materialize each use case's records into its non-custom ERs' coverageRows,
  // so cost AND the Coverage column share one source of truth and default to the
  // per-table records. Needed because multi-table import seeds every ER's
  // coverageRows from the global recordsActual (the last table's), and a
  // persisted records override must re-apply on load. Skips "other" and per-ER
  // manual coverage (coverageCustom). Returns whether anything changed.
  function syncUseCaseCoverage() {
    let changed = false;
    for (const c of cb.model?.getNodes?.() || []) {
      const d = c && c.data;
      if (!d || isNonErType(d.type) || d.coverageCustom) continue;
      const key = useCaseKeyForCard(c);
      if (key === OTHER_USE_CASE) continue;
      const recs = useCaseRecords(key);
      if (d.coverageRows !== recs) {
        d.coverageRows = recs;
        changed = true;
      }
    }
    return changed;
  }

  // Materialize each use case's frequency onto its non-custom ERs' d.frequency,
  // so the per-ER chips + details popover (which read d.frequency) reflect the
  // table's frequency instead of the stale global default. Mirrors
  // syncUseCaseCoverage. Skips "other" and per-ER overrides (frequencyCustom).
  // Without this, a table set to e.g. Monthly shows x12 in its header sub-total
  // but x1 on its ERs' details. Returns whether anything changed.
  function syncUseCaseFrequency() {
    let changed = false;
    for (const c of cb.model?.getNodes?.() || []) {
      const d = c && c.data;
      if (!d || isNonErType(d.type) || d.frequencyCustom) continue;
      const key = useCaseKeyForCard(c);
      if (key === OTHER_USE_CASE) continue;
      const freqId = useCaseFrequencyId(key);
      if (d.frequency !== freqId) {
        d.frequency = freqId;
        changed = true;
      }
    }
    return changed;
  }

  // Grand total + per-use-case breakdown for the multi-use-case (2+ tables)
  // case. Each ER is multiplied by ITS use case's records + frequency; the
  // "other" bucket is excluded. Mirrors the single-mode math (weighted per-row
  // x records) but per use case. `cards` = all model nodes; returns
  // { grandCredits, grandActions, perUseCase:[{key,name,credits,actions}] }.
  function computeUseCaseTotals(cards, opts) {
    opts = opts || {};
    const projected = (opts.viewMode || cb.viewMode) !== "actual";
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
      // A per-ER override (frequencyCustom) wins; otherwise the ER inherits its
      // use case's frequency. We deliberately do NOT fall back to the per-card
      // d.frequency here: import seeds every ER's d.frequency to the global
      // default (never null), so the old `d.frequency || useCaseFrequencyId(key)`
      // always short-circuited and the per-table frequency picker had no effect
      // on the totals.
      const freqId = d.frequencyCustom ? d.frequency : useCaseFrequencyId(key);
      const mult = freqMult(freqId);
      const recs = useCaseRecords(key);
      // Projected: coverage (rows that run — the same run rate the multi-ER DP
      // split uses). Actual: measured coverage ran/total, so (spend/ran) × recs
      // × (ran/total) = spend × recs/total (ran cancels). x recs turns the
      // per-row figure into the use case's absolute volume.
      const billable = projected
        ? billableFraction(c, recs)
        : actualCoverageRatio(c);
      // Signals: per-run total or per-result × results pulled (annualVolume).
      const volume = annualVolume(c, recs, billable);
      const b = buckets.get(key) || { credits: 0, actions: 0 };
      b.credits += pr.credits * mult * volume;
      b.actions += pr.actions * mult * volume;
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

  // Self-contained per-tab grand total for a SERIALIZED tab.state (cards +
  // useCaseScope + records/frequency), so the export / deal-desk paths produce
  // the SAME numbers the table shows for that tab — active or not. Reads only
  // tabState (no live summary-bar globals), and mirrors computeUseCaseTotals
  // (2+ imported tables: per-use-case records/frequency, "other" excluded) and
  // the single-scope summary path (one global records/frequency). Honors
  // Projected (coverage) vs Actual (measured spend × records/total).
  function computeTabTotals(tabState, opts) {
    opts = opts || {};
    const cards = tabState && Array.isArray(tabState.cards) ? tabState.cards : [];
    const projected = (opts.viewMode || "projected") !== "actual";
    const scope = (tabState && tabState.useCaseScope) || {};
    const parseRecs = (r) => {
      const n = parseInt(String(r == null ? "" : r).replace(/[^\d]/g, ""), 10);
      return Number.isFinite(n) && n > 0 ? n : 0;
    };
    const globalRecords = parseRecs(tabState && tabState.records);
    const globalFreq = (tabState && tabState.frequency) || cb.DEFAULT_FREQUENCY_ID;
    const freqMult = (id) => (cb.getFrequencyMultiplier ? cb.getFrequencyMultiplier(id) : 1);

    // Table-native: resolve use cases from THIS tab's serialized group tree
    // (this runs on non-active tabs, so we must NOT read the live model). Only
    // ER cards are summed below, so groupId-based L1 resolution is enough.
    const tabGroups = tabState && Array.isArray(tabState.groups) ? tabState.groups : [];
    const groupById = new Map(tabGroups.map((g) => [g.id, g]));
    const l1ForCard = (c) => {
      let gid = c && c.groupId != null ? c.groupId : null;
      const seen = new Set();
      let g = null;
      while (gid != null && !seen.has(gid)) {
        seen.add(gid);
        g = groupById.get(gid);
        if (!g) return null;
        if ((g.parentId ?? null) == null) return g;
        gid = g.parentId;
      }
      return g && (g.parentId ?? null) == null ? g : null;
    };
    const topGroups = tabGroups.filter((g) => (g.parentId ?? null) == null);
    const useGroups = topGroups.length > 0;

    // Legacy imported-table use cases (only when there's no group tree).
    const ucKeys = new Set();
    for (const c of cards) {
      const d = c && c.data;
      if (!d || isNonErType(d.type)) continue;
      if (isImportedTableCard(c)) ucKeys.add(`t-${d.tableId}`);
    }
    const multi = useGroups ? topGroups.length >= 2 : ucKeys.size >= 2;

    const recordsForGroup = (g) => {
      if (g.records != null && Number(g.records) >= 0) return Number(g.records);
      if (g.tableId) {
        const meta = importedTablesMap()[g.tableId];
        if (meta && meta.recordCount > 0) return Number(meta.recordCount);
      }
      return globalRecords;
    };
    const recordsForKey = (key) => {
      const sc = scope[key];
      if (sc && sc.records != null && Number(sc.records) >= 0) return Number(sc.records);
      if (key && key.startsWith("t-")) {
        const meta = importedTablesMap()[key.slice(2)];
        if (meta && meta.recordCount > 0) return Number(meta.recordCount);
      }
      return globalRecords;
    };
    const freqForKey = (key) => {
      const sc = scope[key];
      return (sc && sc.frequency) || globalFreq;
    };

    let credits = 0;
    let actions = 0;
    for (const c of cards) {
      const d = c && c.data;
      if (!d || isNonErType(d.type)) continue;
      let recs;
      let freqId;
      if (multi) {
        if (useGroups) {
          const g = l1ForCard(c);
          if (!g) continue; // unscoped, excluded from the quote
          recs = recordsForGroup(g);
          freqId = d.frequencyCustom ? d.frequency : g.frequency || globalFreq;
        } else {
          const key = useCaseKeyForCard(c);
          if (key === OTHER_USE_CASE) continue; // unscoped, excluded
          recs = recordsForKey(key);
          freqId = d.frequencyCustom ? d.frequency : freqForKey(key);
        }
      } else {
        recs = globalRecords;
        freqId = d.frequencyCustom ? d.frequency : d.frequency || globalFreq;
      }
      const pr = perRowCost(
        c,
        projected
          ? { viewMode: "projected" }
          : { viewMode: "actual", fallbackToProjected: false },
      );
      if (pr.noSpend) continue;
      const mult = freqMult(freqId);
      const billable = projected
        ? billableFraction(c, recs)
        : actualCoverageRatio(c);
      // Signals: per-run total or per-result × results pulled; see annualVolume.
      const volume = annualVolume(c, recs, billable);
      credits += pr.credits * mult * volume;
      actions += pr.actions * mult * volume;
    }
    return {
      creditsPerYear: Math.max(0, Math.round(credits)),
      actionsPerYear: Math.max(0, Math.round(actions)),
    };
  }

  // ---------------------------------------------------------------------------
  // Pricing view (multi-year): per-use-case per-ROW credits/actions, decoupled
  // from records, so a per-year records value can be multiplied in to get that
  // year's volume. Mirrors computeUseCaseTotals' weighting (frequency x
  // coverage baseline) but divides out records so the result is a stable
  // per-record figure. When no imported-table use case exists, the unscoped
  // ("other") cards collapse into a single synthetic "Scope" use case so a
  // canvas-only scope still prices.
  // ---------------------------------------------------------------------------
  function computePricingUseCases(opts) {
    opts = opts || {};
    const projected = (opts.viewMode || cb.viewMode) !== "actual";
    const cards = cb.model?.getNodes?.() || [];
    const freqMult = (id) => (cb.getFrequencyMultiplier ? cb.getFrequencyMultiplier(id) : 1);
    const hasImported = listUseCases().length > 0;
    const buckets = new Map(); // key -> { perRowCredits, perRowActions }
    for (const c of cards) {
      const d = c && c.data;
      if (!d || isNonErType(d.type)) continue;
      const key = useCaseKeyForCard(c);
      // When imported tables exist, unscoped canvas cards are excluded from the
      // quote (same as computeUseCaseTotals). With no tables, "other" IS the
      // scope, so keep it.
      if (key === OTHER_USE_CASE && hasImported) continue;
      // Signals bill per run, not per record. This multi-year calculator is
      // records-driven (perRow × records per year), which can't represent a
      // fixed per-run monitoring cost, so signal sources are excluded here for
      // now (they're still counted in the projected/actual summary totals via
      // annualVolume). TODO: model recurring signal cost in the contract view.
      if (isSignalCard(c)) continue;
      // Mode-aware: Projected uses catalog credits; Actual uses measured per-row
      // spend (spend/ran) and skips cards with no spend yet.
      const pr = perRowCost(
        c,
        projected
          ? { viewMode: "projected" }
          : { viewMode: "actual", fallbackToProjected: false },
      );
      if (pr.noSpend) continue;
      const freqId = d.frequencyCustom
        ? d.frequency
        : key === OTHER_USE_CASE
          ? cb.getCurrentFrequencyId?.()
          : useCaseFrequencyId(key);
      const mult = freqMult(freqId);
      const baseRecs =
        key === OTHER_USE_CASE
          ? cb.getRecordsCount?.() || 0
          : useCaseRecords(key);
      // Coverage baseline at the use case's own records (defaults to 1 after
      // syncUseCaseCoverage; <1 only when the rep set a custom coverage / run
      // rate — the same run rate the multi-ER DP split uses).
      const billable = billableFraction(c, baseRecs);
      const b = buckets.get(key) || { perRowCredits: 0, perRowActions: 0 };
      b.perRowCredits += pr.credits * mult * billable;
      b.perRowActions += pr.actions * mult * billable;
      buckets.set(key, b);
    }
    const meta = new Map(listUseCases().map((u) => [u.key, u]));
    const out = [];
    for (const [key, b] of buckets) {
      out.push({
        key,
        name: key === OTHER_USE_CASE ? "Scope" : meta.get(key)?.name || key,
        perRowCredits: b.perRowCredits,
        perRowActions: b.perRowActions,
        baselineRecords:
          key === OTHER_USE_CASE ? cb.getRecordsCount?.() || 0 : useCaseRecords(key),
      });
    }
    return out;
  }

  // Per-year contract totals for the pricing view. `yearRecordsByUc` maps a use
  // case key to a [y1, y2, y3] records array (any missing entry defaults to that
  // use case's baseline records). Returns per-year grand {credits, actions} for
  // years 1..contractYears, the cross-year averages (which drive tier
  // selection), and the resolved use cases (with perRow + baseline). Pure.
  function computeContractTotals(opts) {
    opts = opts || {};
    const contractYears = Math.min(3, Math.max(1, Number(opts.contractYears) || 1));
    const yearRecordsByUc = opts.yearRecordsByUc || {};
    const useCases = Array.isArray(opts.useCases)
      ? opts.useCases
      : computePricingUseCases({ viewMode: opts.viewMode });
    const years = [];
    for (let i = 0; i < contractYears; i++) {
      let credits = 0;
      let actions = 0;
      const perUseCase = [];
      for (const uc of useCases) {
        const arr = yearRecordsByUc[uc.key];
        const recs = arr && arr[i] != null ? Number(arr[i]) : uc.baselineRecords;
        const ucCredits = uc.perRowCredits * recs;
        const ucActions = uc.perRowActions * recs;
        credits += ucCredits;
        actions += ucActions;
        perUseCase.push({ key: uc.key, records: recs, credits: ucCredits, actions: ucActions });
      }
      years.push({ year: i + 1, credits, actions, perUseCase });
    }
    const n = years.length || 1;
    const avgCredits = years.reduce((s, y) => s + y.credits, 0) / n;
    const avgActions = years.reduce((s, y) => s + y.actions, 0) / n;
    return { contractYears, useCases, years, avgCredits, avgActions };
  }

  cb.cost = {
    isNonErType,
    perRowCost,
    actualRowDenominator,
    coverageRatio,
    actualCoverageRatio,
    erLineageKey,
    fillFraction,
    buildErFillMap,
    billableFraction,
    projectedRunRate,
    DEFAULT_SESSION_GAP_MS,
    bucketRunsIntoSessions,
    OTHER_USE_CASE,
    isImportedTableCard,
    useCaseKeyForCard,
    listUseCases,
    useCaseCount,
    useCaseRecords,
    useCaseRecordsActual,
    useCaseFrequencyId,
    syncUseCaseCoverage,
    syncUseCaseFrequency,
    computeUseCaseTotals,
    computeTabTotals,
    computePricingUseCases,
    computeContractTotals,
  };
})();
