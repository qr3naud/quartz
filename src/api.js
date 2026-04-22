(function () {
  "use strict";

  const __cb = window.__cb;

  __cb.fetchEnrichments = async function (workspaceId) {
    const res = await fetch(
      `https://api.clay.com/v3/actions?workspaceId=${workspaceId}`,
      { credentials: "include" }
    );
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    const data = await res.json();

    __cb.enrichmentLookup = {};
    __cb.actionByIdLookup = {};
    for (const action of data.actions) {
      const pkgName = action.package?.displayName ?? "Other";
      const iconUrl = action.iconUri ?? action.package?.icon ?? null;
      const ai = __cb.isAiAction(action.key, action.displayName, action.package?.id);
      const post = action.pricing?.postPricingChange2026;
      const fallback = action.pricing;
      const entry = {
        key: action.key,
        packageId: action.package?.id ?? "unknown",
        displayName: action.displayName,
        packageName: pkgName,
        credits: post?.credits?.basic ?? fallback?.credits?.basic ?? null,
        actionExecutions: post?.credits?.actionExecution ?? fallback?.credits?.actionExecution ?? null,
        iconUrl,
        isAi: ai,
        modelOptions: ai ? __cb.getModelOptions() : null,
        requiresApiKey: action.actionLabels?.requiresApiKey ?? false,
      };
      __cb.enrichmentLookup[action.displayName.toLowerCase()] = entry;
      __cb.actionByIdLookup[`${entry.packageId}-${action.key}`] = entry;
    }
  };

  __cb.fetchModelPricing = async function (workspaceId) {
    try {
      const res = await fetch(
        `https://api.clay.com/v3/model-pricing/${workspaceId}/base-costs`,
        { credentials: "include" }
      );
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      const data = await res.json();
      __cb.livePricingByModel = {};
      for (const entry of data.baseCosts ?? []) {
        __cb.livePricingByModel[entry.modelName] = entry.baseCostCredits;
      }
    } catch (err) {
      console.warn("[Clay Scoping] model pricing fetch failed, using defaults:", err);
    }
  };

  // Fetches waterfall names and sets their execution cost to 1.
  // actionExecution is binary (0 or 1) per action; waterfalls cost 1 execution
  // in practice (occasionally 2 for complex ones). No API provides a
  // per-waterfall value, so we default to 1.
  __cb.fetchWaterfallExecCosts = async function () {
    try {
      const res = await fetch(
        "https://api.clay.com/v3/attributes",
        { credentials: "include" }
      );
      if (!res.ok) return;
      const data = await res.json();
      __cb.waterfallExecByName = {};
      for (const attr of Object.values(data.attributeDescriptionsMap?.waterfallAttributes ?? {})) {
        __cb.waterfallExecByName[attr.displayName.toLowerCase()] = 1;
      }
    } catch (err) {
      console.warn("[Clay Scoping] waterfall attributes fetch failed:", err);
    }
  };

  __cb.fetchTableList = async function (workbookId) {
    const res = await fetch(
      `https://api.clay.com/v3/workbooks/${workbookId}/tables`,
      { credentials: "include" }
    );
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    return res.json();
  };

  // -------------------------------------------------------------------------
  // Stats endpoints used by the table import flow.
  //
  // Four reads are stitched together on a successful import to produce the
  // Coverage / Fill rate / Spend numbers shown on every card:
  //
  //   1. fetchViewCount       → fills the Records summary input
  //   2. fetchFieldRunStatus  → ER coverage + fill rate (action fields only)
  //   3. fetchTableContext    → DP fill rate via dataProfile (any field type)
  //   4. fetchColumnSpend     → per-column actual credit spend (Redshift)
  //
  // All four piggyback on the user's Clay session cookies, so no separate
  // auth is required. Field IDs are the join key across every response.
  // -------------------------------------------------------------------------

  __cb.fetchViewCount = async function (tableId, viewId) {
    const res = await fetch(
      `https://api.clay.com/v3/tables/${tableId}/views/${viewId}/count`,
      { credentials: "include" }
    );
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    return res.json();
  };

  // The bulk runstatus endpoint returns the literal string "_pending" while
  // its Redis cache is cold and the backend is still computing per-field
  // counts. Poll a few times so cards can populate, then give up so the
  // import never hangs.
  __cb.fetchFieldRunStatus = async function (workspaceId, tableId) {
    const PENDING = "_pending";
    const DELAYS = [1000, 2000, 4000];
    const url = `https://api.clay.com/v3/workspaces/${workspaceId}/tables/${tableId}/fields/runstatus`;
    for (let attempt = 0; attempt <= DELAYS.length; attempt++) {
      let body;
      try {
        const res = await fetch(url, { credentials: "include" });
        if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
        body = await res.json();
      } catch (err) {
        console.warn("[Clay Scoping] fetchFieldRunStatus failed:", err);
        return null;
      }
      const counts = body?.statusCountsByField;
      if (counts && counts !== PENDING) return counts;
      if (attempt === DELAYS.length) return null;
      await new Promise((r) => setTimeout(r, DELAYS[attempt]));
    }
    return null;
  };

  // Calls the same context endpoint that powers Chat-with-Table. The
  // `sculptor-in-table` preset caps profiling at ~1k sample rows (vs the
  // default `full` preset that profiles every row), so it stays cheap on
  // big tables while still returning per-field dataProfile blocks
  // (valueCount / nullPercentage / sampleSize). Returns the unwrapped
  // `result` object so callers can read `fieldConfigurationsData.fieldConfigs`
  // directly. Fail-soft so a single failure doesn't block the rest of the
  // import.
  __cb.fetchTableContext = async function (workspaceId, tableId) {
    try {
      const res = await fetch(
        `https://api.clay.com/v3/workspaces/${workspaceId}/tables/${tableId}/context`,
        {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            formatAsXML: false,
            contextDetailLevel: "sculptor-in-table",
            getExampleRows: 0,
            customOptions: {},
          }),
        }
      );
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      const body = await res.json();
      return body?.result ?? null;
    } catch (err) {
      console.warn("[Clay Scoping] fetchTableContext failed:", err);
      return null;
    }
  };

  // Per-column actual spend over the last N days. Backed by Redshift via
  // Kinesis ingestion (~minutes of lag). Note: realtime credit usage is only
  // complete from REALTIME_CREDIT_USAGE_START_DATE = 2025-11-05 — for tables
  // older than that, the totals will under-count. Returns an array of
  // { fieldId, creditsSpent, actionExecutionCreditsSpent?, cellCount? }.
  __cb.fetchColumnSpend = async function (workspaceId, tableId, days = 30) {
    try {
      const res = await fetch(
        `https://api.clay.com/v3/realtime-credit-usage/${workspaceId}/table/${tableId}/column/recent?days=${days}`,
        { credentials: "include" }
      );
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      return res.json();
    } catch (err) {
      console.warn("[Clay Scoping] fetchColumnSpend failed:", err);
      return null;
    }
  };
})();
