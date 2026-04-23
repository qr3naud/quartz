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

  // Fetches Clay's built-in waterfall attributes (the WaterfallRow rows in
  // the picker). For each attribute we keep:
  //   - displayName, attributeEnum, icon
  //   - actionIds[]                — Clay's curated default provider chain
  //   - validationProviderActionId — first validationProviders entry, used
  //                                  to compute per-step validation price at
  //                                  buildWaterfallCardData time
  // We don't resolve actionIds → action records here because actionByIdLookup
  // (built by fetchEnrichments) may not be populated yet — the picker
  // prefetches both in Promise.all. Resolution happens lazily inside
  // extractVisualData where actionByIdLookup is guaranteed available.
  //
  // waterfallExecByName is preserved for backward compat: it's what the old
  // flat-card path falls back to for actionExecutions when the waterfall
  // doesn't get upgraded to a waterfall card (i.e. no row match in the
  // picker DOM, or actionIds couldn't be resolved).
  __cb.fetchWaterfallExecCosts = async function () {
    try {
      const res = await fetch(
        "https://api.clay.com/v3/attributes",
        { credentials: "include" }
      );
      if (!res.ok) return;
      const data = await res.json();
      __cb.waterfallExecByName = {};
      __cb.waterfallByName = {};
      for (const attr of Object.values(data.attributeDescriptionsMap?.waterfallAttributes ?? {})) {
        const name = attr.displayName?.toLowerCase();
        if (!name) continue;
        __cb.waterfallExecByName[name] = 1;
        __cb.waterfallByName[name] = {
          displayName: attr.displayName,
          attributeEnum: attr.enum ?? null,
          icon: attr.icon ?? null,
          actionIds: Array.isArray(attr.actionIds) ? [...attr.actionIds] : [],
          validationProviderActionId: attr.validationProviders?.[0] ?? null,
        };
      }
    } catch (err) {
      console.warn("[Clay Scoping] waterfall attributes fetch failed:", err);
    }
  };

  // Fetches workspace-level waterfall presets (PresetType.WATERFALL and
  // PARENT_WATERFALL). These are the user-saved / org-shared customized
  // waterfalls that appear as PresetRow rows in the picker. Indexed by
  // lowercased preset name so extractVisualData can match a row's text to
  // the structured preset data.
  //
  // The endpoint is documented in apps/api/v3/presets/routes/presets.routes.ts
  // (`GET /presets/workspace/:workspaceId`), the same one usePresets() uses.
  // Failures are swallowed: presets only enrich the picker — without them
  // the user still gets a flat card via the action-row fallback path.
  __cb.fetchWaterfallPresets = async function (workspaceId) {
    try {
      const res = await fetch(
        `https://api.clay.com/v3/presets/workspace/${workspaceId}`,
        { credentials: "include" }
      );
      if (!res.ok) return;
      const presets = await res.json();
      __cb.waterfallPresetByName = {};
      __cb.waterfallParentPresetById = {};

      // First pass: index PARENT_WATERFALL by id so we can resolve their
      // default child preset in the second pass without a second walk.
      for (const ps of Array.isArray(presets) ? presets : []) {
        if (ps?.preset?.type === "parent_waterfall") {
          __cb.waterfallParentPresetById[ps.id] = ps;
        }
      }

      for (const ps of Array.isArray(presets) ? presets : []) {
        const t = ps?.preset?.type;
        if (t !== "waterfall" && t !== "parent_waterfall") continue;
        const name = (ps?.name || "").toLowerCase();
        if (!name) continue;

        let configs = [];
        let attributeEnum = null;

        if (t === "waterfall") {
          configs = Array.isArray(ps.preset?.waterfallConfigs) ? ps.preset.waterfallConfigs : [];
          attributeEnum = ps.preset?.attributeEnum ?? null;
        } else {
          // PARENT_WATERFALL: resolve the default child preset's configs.
          // The child should be in the same `presets` list (same workspace
          // request) — we look it up by id, not by walking again.
          const childId = ps.preset?.defaultWaterfallPresetId;
          const child = (presets || []).find(
            (p) => p?.id === childId && p?.preset?.type === "waterfall",
          );
          if (child) {
            configs = Array.isArray(child.preset?.waterfallConfigs) ? child.preset.waterfallConfigs : [];
            attributeEnum = child.preset?.attributeEnum ?? ps.preset?.attributeEnum ?? null;
          } else {
            attributeEnum = ps.preset?.attributeEnum ?? null;
          }
        }

        __cb.waterfallPresetByName[name] = {
          presetId: ps.id,
          displayName: ps.name,
          attributeEnum,
          waterfallConfigs: configs,
        };
      }
    } catch (err) {
      console.warn("[Clay Scoping] waterfall presets fetch failed:", err);
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
