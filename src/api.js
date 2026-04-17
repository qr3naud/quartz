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
})();
