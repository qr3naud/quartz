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
      // Each action carries up to two pricing tiers on its catalog entry:
      //   - prePricingChange2026 → "legacy" plans (the old single-credit
      //     dimension; actionExecution as a separate billable line did not
      //     exist on these plans)
      //   - postPricingChange2026 → "modern" plans (basic credits + a
      //     separate actionExecution dimension)
      // The default `credits / actionExecutions / privateKeyCredits`
      // exposed below mean "modern" so the canvas / cost math keeps the
      // pre-existing behavior. Falls back to the root pricing block when
      // an action hasn't been migrated to the split shape yet (matches
      // the server-side logic in libs/shared/src/credits/credit-cost-utils.ts
      // getActionPricing).
      const post = action.pricing?.postPricingChange2026;
      // __CB_INTERNAL_ONLY_BEGIN: legacyPricing
      const pre = action.pricing?.prePricingChange2026;
      // __CB_INTERNAL_ONLY_END
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
        // Two flags from action.actionLabels disambiguate "requires
        // your own credentials" from "supports both shared and private
        // keys". Together they form the canonical "key-only" predicate
        // (see checkRequiresCredentials in
        // libs/shared/src/credits/credit-cost-utils.ts). When either is
        // true, the action's effective cost is `usesPrivateKeyCredits`,
        // which is usually 0 — same logic getActionCost runs server-side.
        requiresApiKey: action.actionLabels?.requiresApiKey ?? false,
        disableSharedKey: action.actionLabels?.disableSharedKey ?? false,
        privateKeyCredits:
          post?.usesPrivateKeyCredits?.basic ??
          fallback?.usesPrivateKeyCredits?.basic ??
          0,
        // __CB_INTERNAL_ONLY_BEGIN: legacyPricing
        // Legacy (pre-2026) pricing siblings. Same fallback chain as
        // above so actions that only carry the root `pricing.credits`
        // block (un-migrated) report the same number on both sides.
        legacyCredits: pre?.credits?.basic ?? fallback?.credits?.basic ?? null,
        legacyActionExecutions:
          pre?.credits?.actionExecution ?? fallback?.credits?.actionExecution ?? null,
        legacyPrivateKeyCredits:
          pre?.usesPrivateKeyCredits?.basic ??
          fallback?.usesPrivateKeyCredits?.basic ??
          0,
        // __CB_INTERNAL_ONLY_END
      };
      __cb.enrichmentLookup[action.displayName.toLowerCase()] = entry;
      // Clay's canonical action-id format is `${packageId}/${actionKey}`
      // (see libs/shared/src/actions/build-action-ids.ts). Indexing here
      // with the same format lets attribute.actionIds and
      // attribute.validationProviders look up entries directly without a
      // conversion step. The hyphen form is also indexed for legacy
      // call-sites in table-import.js / picker.js until those switch.
      const slashId = `${entry.packageId}/${action.key}`;
      const dashId = `${entry.packageId}-${action.key}`;
      __cb.actionByIdLookup[slashId] = entry;
      __cb.actionByIdLookup[dashId] = entry;
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

  // __CB_INTERNAL_ONLY_BEGIN: pricingComparison
  // Fetches the workspace's currently-active billing plan + price tier and
  // derives a CPC ($/credit) from the contract numbers. Used by the Old vs
  // New comparison modal to auto-fill the matching side's editable rate
  // input (legacy plan -> legacy rate, modern plan -> modern rate). The
  // other side stays at its FIXED list-price default so the comparison
  // still shows a meaningful "what would you pay on the other catalog"
  // contrast even when one side is anchored to the customer's contract.
  //
  // Source: GET /v3/billingplans/:workspaceId?source=frontend, the same
  // endpoint useBillingPlans drives in apps/frontend (see
  // apps/frontend/src/state/Billing/useBillingPlans.ts). We only read
  // currentPlan.priceInfo here — publicPlans aren't needed for the modal.
  //
  // Plan classification mirrors libs/shared/src/billing/Billing.ts:
  //   - Legacy: April-2023 generation + the older basic/explorer/pro/proV2
  //   - Modern: launch / growth / postPricingChange2026* (the
  //     NewAvailableBillingPlanTypes set)
  // Free / Trial plans skip auto-fill entirely (no meaningful CPC).
  // Enterprise placeholder rows (amount: 0, basicCredits: 1B "unlimited"
  // sentinel) are guarded out via the hasUsablePrice check below — they'd
  // produce a $0 / call CPC that would lie about the customer's spend.
  __cb.fetchCurrentPlanPricing = async function (workspaceId) {
    // Mirrors the legacy/modern split in libs/shared/src/billing/Billing.ts:
    // anything not in NewAvailableBillingPlanTypes is legacy. The bare
    // "enterprise" type is canonical for custom-negotiated contracts on
    // the legacy catalog (most real Enterprise customers, e.g. workspace
    // 348241). "enterpriseApril2023" is deprecated but still in flight
    // for a few accounts. "postPricingChange2026Enterprise" is the modern
    // Enterprise catalog (e.g. internal Clay workspace 4515, which uses
    // a $0/1B-credit placeholder Stripe subscription billed manually —
    // its priceInfo can't be derived from, so the hasUsablePrice guard
    // below skips auto-fill for it without needing a workspace allowlist).
    const LEGACY_TYPES = new Set([
      "starterApril2023", "explorerApril2023", "proApril2023",
      "basic", "explorer", "pro", "proV2",
      "enterprise", "enterpriseApril2023",
    ]);
    const MODERN_TYPES = new Set([
      "launch", "growth",
      "postPricingChange2026Free", "postPricingChange2026Trial",
      "postPricingChange2026Enterprise",
    ]);

    try {
      // Fan out to both endpoints in parallel — billingplans gives us the
      // plan type + per-credit numbers, workspaces gives us the action
      // execution limit. The action limit lets applyCurrentPlanAutoFill
      // match the workspace to a row in the public action-tier catalog
      // (fetched separately by fetchActionTiers below), which is what
      // unlocks CPA auto-fill for modern Launch / Growth customers.
      const [billingRes, workspaceRes] = await Promise.all([
        fetch(
          `https://api.clay.com/v3/billingplans/${workspaceId}?source=frontend`,
          { credentials: "include" }
        ),
        fetch(
          `https://api.clay.com/v3/workspaces/${workspaceId}`,
          { credentials: "include" }
        ),
      ]);
      if (!billingRes.ok) throw new Error(`billingplans HTTP ${billingRes.status} ${billingRes.statusText}`);
      const data = await billingRes.json();
      const cp = data?.currentPlan;
      if (!cp) {
        __cb.currentPlanPricing = null;
        return;
      }

      // The /v3/workspaces fetch is best-effort — its only job here is
      // unlocking action-rate auto-fill for self-serve modern plans. A
      // failure (or an Enterprise placeholder limit) just leaves the
      // action-rate input at its FIXED default. The credit auto-fill
      // path, the higher-value side, only depends on billingplans.
      let actionLimit = null;
      if (workspaceRes.ok) {
        try {
          const wsData = await workspaceRes.json();
          const limit = Number(wsData?.creditBudgets?.actionExecution);
          // Same sentinel guard as basicCredits: Enterprise placeholders
          // come back as 1B+ ("unlimited") and don't correspond to any
          // public action tier, so reject them.
          if (Number.isFinite(limit) && limit > 0 && limit < 100_000_000) {
            actionLimit = limit;
          }
        } catch {
          // Non-fatal — leave actionLimit null.
        }
      }

      // The action-tier catalog is keyed by Clay-internal billingPlanId
      // (e.g., plan_vsdV8nMgFJ4eq for Launch), not the human plan type.
      // billingplans returns the id alongside type on each entry in
      // publicPlans, so we just look ours up there — no extra fetch.
      const planId = (data?.publicPlans ?? []).find((p) => p?.type === cp.type)?.id ?? null;

      const isLegacyType = LEGACY_TYPES.has(cp.type);
      const isModernType = MODERN_TYPES.has(cp.type);
      const pi = cp.priceInfo ?? {};
      const amount = Number(pi.amount);
      const credits = Number(pi.basicCredits);
      // basicCredits cap (100M) excludes the Enterprise "unlimited"
      // sentinel value (1B credits, $0 amount) which would otherwise
      // produce a degenerate $0/credit and silently mislead the rep.
      const hasUsablePrice =
        Number.isFinite(amount) && amount > 0 &&
        Number.isFinite(credits) && credits > 0 && credits < 100_000_000;
      const cpc = hasUsablePrice ? (amount / 100) / credits : null;

      __cb.currentPlanPricing = {
        planType: cp.type,
        planId,
        displayName: cp.displayName ?? cp.type,
        billingSchedule: pi.billingSchedule ?? null,
        basicCredits: credits || null,
        amountCents: amount || null,
        actionLimit,
        cpc,
        isLegacy: isLegacyType && cpc !== null,
        isModern: isModernType && cpc !== null,
      };
    } catch (err) {
      console.warn("[Clay Scoping] current plan pricing fetch failed:", err);
      __cb.currentPlanPricing = null;
    }
  };

  // Fetches the public action-tier catalog (every Launch/Growth tier
  // with its Stripe-derived amount). Used by applyCurrentPlanAutoFill
  // to look up the workspace's specific tier price by joining
  // (currentPlanPricing.planId, currentPlanPricing.actionLimit,
  // currentPlanPricing.billingSchedule) → tier.amount, then deriving
  // CPA = (amount / 100) / actionExecutionLimit.
  //
  // Catalog rarely changes (action tier prices are catalog-wide, not
  // per-workspace), so the fetch is cached on __cb.actionTiersCatalog
  // for the page session — same caching pattern as livePricingByModel
  // and currentPlanPricing.
  __cb.fetchActionTiers = async function () {
    try {
      const res = await fetch(
        "https://api.clay.com/v3/action-tiers-with-prices",
        { credentials: "include" }
      );
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      const data = await res.json();
      __cb.actionTiersCatalog = Array.isArray(data?.result) ? data.result : [];
    } catch (err) {
      console.warn("[Clay Scoping] action tiers fetch failed:", err);
      __cb.actionTiersCatalog = [];
    }
  };
  // __CB_INTERNAL_ONLY_END

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
        const validationIds = Array.isArray(attr.validationProviders) ? [...attr.validationProviders] : [];
        __cb.waterfallByName[name] = {
          displayName: attr.displayName,
          attributeEnum: attr.enum ?? null,
          icon: attr.icon ?? null,
          actionIds: Array.isArray(attr.actionIds) ? [...attr.actionIds] : [],
          // Full validation provider list (in Clay's preferred order). The
          // first entry is what the picker would default to. The popover
          // exposes this whole list as a dropdown so users can swap the
          // validator (e.g. ZeroBounce → Findymail) without leaving the
          // canvas.
          validationProviderActionIds: validationIds,
          // Kept for back-compat with code that only ever used the default.
          validationProviderActionId: validationIds[0] ?? null,
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
  // Stats endpoints.
  //
  // As of v3.9 the import flow only fans out two of these in parallel:
  //
  //   - fetchTableContextFull → schema + dataProfile (status counts,
  //                             value counts, group info) for every field
  //                             in one server-side pass
  //   - fetchColumnSpend      → per-column actual credit spend (Redshift)
  //
  // The remaining helpers (fetchViewCount, fetchFieldRunStatus,
  // fetchTableContext) are kept exclusively for the JSON export modal's
  // "Combined" option, which still fans out all four for per-leg latency
  // comparison against the import flow's 2-call fan-out. They are NOT used
  // by the import flow itself anymore.
  //
  // Everything piggybacks on the user's Clay session cookies, so no
  // separate auth is required. Field IDs are the join key across responses.
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

  // Same endpoint as fetchTableContext, but with contextDetailLevel "full"
  // — the DEFAULT_FIELD_CONFIG_OPTIONS preset on the server (every toggle on:
  // status counts, action/formula error analysis, example values, error
  // examples, full schemas, policy credit costs, profiling at sampleSize=0).
  // Used by the JSON export modal so reps can compare a single rich call
  // against the cheaper sculptor-in-table preset and against the multi-call
  // combined join. NOT used by the table-import flow because the join
  // already gives us view-filtered counts and actual Redshift spend, which
  // the full preset can't.
  __cb.fetchTableContextFull = async function (workspaceId, tableId) {
    try {
      const res = await fetch(
        `https://api.clay.com/v3/workspaces/${workspaceId}/tables/${tableId}/context`,
        {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            formatAsXML: false,
            contextDetailLevel: "full",
            getExampleRows: 0,
            customOptions: {},
          }),
        }
      );
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      const body = await res.json();
      return body?.result ?? null;
    } catch (err) {
      console.warn("[Clay Scoping] fetchTableContextFull failed:", err);
      return null;
    }
  };

  // __CB_INTERNAL_ONLY_BEGIN: pricingComparison
  // App accounts (auth accounts) for the workspace. Used to differentiate
  // "Clay-managed shared key" (bills credits) from "user-pasted private key"
  // (BYOK, free) on AI fields where the user picked a non-default
  // authAccountId. Mirrors the server-side rule in
  // libs/shared/src/credits/credit-cost-utils.ts:
  //   isPublicKey = appAccount.isSharedPublicKey
  //   isPrivateKey = Boolean(authAccountId) && !isPublicKey
  // Without this lookup, the comparison modal can't tell the two apart from
  // typeSettings.authAccountId alone (the import flow gets it for free via
  // /context's stats.cost.isPrivateKey, but the modal doesn't fetch /context).
  // Caches into __cb.appAccountById so repeated comparison runs don't refetch.
  __cb.appAccountById = __cb.appAccountById || {};
  __cb.fetchAppAccounts = async function (workspaceId) {
    try {
      const res = await fetch(
        `https://api.clay.com/v3/workspaces/${workspaceId}/app-accounts`,
        { credentials: "include" }
      );
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      const accounts = await res.json();
      if (Array.isArray(accounts)) {
        for (const a of accounts) {
          if (a?.id) __cb.appAccountById[a.id] = a;
        }
      }
      return accounts;
    } catch (err) {
      console.warn("[Clay Scoping] fetchAppAccounts failed:", err);
      return null;
    }
  };
  // __CB_INTERNAL_ONLY_END

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
