(function () {
  "use strict";

  const __cb = window.__cb;

  // ===========================================================================
  // Static-data cache (stale-while-revalidate, localStorage)
  //
  // The action catalog, AI model pricing, and the workspace billing plan
  // rarely change but are (re-)fetched at startup on every page load, which
  // delays the first import. We cache them per workspace in localStorage with
  // a 24h TTL and a version stamp (so an extension update never reads a stale
  // shape). On open we hydrate instantly from cache, then refetch in the
  // background when the entry is older than the TTL. localStorage is the same
  // store the extension already uses for tabs — no new permission needed.
  // ===========================================================================
  const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
  const CACHE_KEYS = {
    actions: (ws) => `cb-cache-actions-${ws}`,
    modelpricing: (ws) => `cb-cache-modelpricing-${ws}`,
    plan: (ws) => `cb-cache-plan-${ws}`,
    workspace: (ws) => `cb-cache-workspace-${ws}`,
  };

  // Every static-cache key is suffixed with the workspace id. Switching
  // workspaces (or impersonating into another) writes a fresh blob under the
  // new key and orphans the old one forever — the action catalog alone is
  // ~600KB per workspace, so a few switches exhaust the ~5MB localStorage
  // budget app.clay.com shares between Clay and Quartz. We only ever need the
  // current workspace's static data, so drop every other workspace's caches.
  // Best-effort: never throw (a prune failure must not block an import).
  __cb.pruneStaticCaches = function (currentWorkspaceId) {
    if (!currentWorkspaceId) return;
    const suffix = `-${currentWorkspaceId}`;
    try {
      const doomed = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (!k || !k.startsWith("cb-cache-")) continue;
        // `cb-cache-subroutines-*` is a deprecated prefix — we no longer
        // persist it (it could be hundreds of KB), so drop it unconditionally,
        // including for the current workspace where it would otherwise never be
        // overwritten and linger forever.
        if (k.startsWith("cb-cache-subroutines-") || !k.endsWith(suffix)) doomed.push(k);
      }
      for (const k of doomed) localStorage.removeItem(k);
    } catch (err) {
      console.warn("[Clay Scoping] pruneStaticCaches failed:", err);
    }
  };

  function extVersion() {
    try {
      return chrome.runtime.getManifest().version;
    } catch {
      return "0";
    }
  }

  // Reads a cache entry, returning the full `{ workspaceId, version,
  // fetchedAt, data }` wrapper or null when missing / for a different
  // workspace / from an older extension version (shape may have changed).
  __cb.readStaticCache = function (key, workspaceId) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || parsed.workspaceId !== workspaceId || parsed.version !== extVersion()) {
        return null;
      }
      return parsed;
    } catch {
      return null;
    }
  };

  __cb.writeStaticCache = function (key, workspaceId, data) {
    const payload = JSON.stringify({
      workspaceId,
      version: extVersion(),
      fetchedAt: Date.now(),
      data,
    });
    try {
      localStorage.setItem(key, payload);
    } catch (err) {
      // Most likely a quota error: app.clay.com's localStorage is shared with
      // Clay and capped at ~5MB. Prune other workspaces' caches and retry once
      // before giving up — caching is an optimization, so a final failure is
      // non-fatal (the in-memory lookups are already populated by the caller).
      try {
        __cb.pruneStaticCaches(workspaceId);
        localStorage.setItem(key, payload);
      } catch (retryErr) {
        console.warn("[Clay Scoping] static cache write failed:", retryErr);
      }
    }
  };

  function isCacheFresh(entry) {
    return !!entry && Number.isFinite(entry.fetchedAt) && Date.now() - entry.fetchedAt < CACHE_TTL_MS;
  }

  // Rebuilds the enrichment lookups from a flat array of catalog entries.
  // Used both after a live fetch and when hydrating from cache. Indexing by
  // both `packageId/key` and `packageId-key` mirrors fetchEnrichments so all
  // existing call sites keep working.
  function applyEnrichmentEntries(entries) {
    __cb.enrichmentLookup = {};
    __cb.actionByIdLookup = {};
    for (const entry of entries ?? []) {
      if (!entry?.displayName) continue;
      __cb.enrichmentLookup[entry.displayName.toLowerCase()] = entry;
      __cb.actionByIdLookup[`${entry.packageId}/${entry.key}`] = entry;
      __cb.actionByIdLookup[`${entry.packageId}-${entry.key}`] = entry;
    }
  }
  __cb.applyEnrichmentEntries = applyEnrichmentEntries;

  // Hydrate-then-revalidate orchestrator for the three rarely-changing
  // datasets. Hydrates from cache synchronously (so the caller can proceed
  // immediately), awaits a real fetch only for datasets with no cache and no
  // in-memory value (first run), and fires a background refetch for stale
  // entries. Safe to call repeatedly — subsequent calls are cheap.
  __cb.ensureStaticData = async function (workspaceId) {
    if (!workspaceId) return;

    // Drop every OTHER workspace's static caches first — this is the natural
    // "we know the current workspace" point (hit on every import), and keeps
    // localStorage scoped to the workspace we're actually using.
    __cb.pruneStaticCaches(workspaceId);

    const actionsCache = __cb.readStaticCache(CACHE_KEYS.actions(workspaceId), workspaceId);
    const modelCache = __cb.readStaticCache(CACHE_KEYS.modelpricing(workspaceId), workspaceId);
    const planCache = __cb.readStaticCache(CACHE_KEYS.plan(workspaceId), workspaceId);

    // 1. Hydrate in-memory state from cache (instant, no network).
    if (Object.keys(__cb.actionByIdLookup || {}).length === 0 && Array.isArray(actionsCache?.data)) {
      applyEnrichmentEntries(actionsCache.data);
    }
    if (Object.keys(__cb.livePricingByModel || {}).length === 0 && modelCache?.data) {
      __cb.livePricingByModel = modelCache.data;
    }
    if (!__cb.currentPlanPricing && planCache && "data" in planCache) {
      __cb.currentPlanPricing = planCache.data;
    }

    // 2. Decide what to fetch now (no usable value) vs in the background (stale).
    const mustAwait = [];
    const background = [];

    if (Object.keys(__cb.actionByIdLookup || {}).length === 0) {
      mustAwait.push(__cb.fetchEnrichments(workspaceId));
    } else if (!isCacheFresh(actionsCache)) {
      background.push(() => __cb.fetchEnrichments(workspaceId));
    }

    if (Object.keys(__cb.livePricingByModel || {}).length === 0) {
      mustAwait.push(__cb.fetchModelPricing(workspaceId));
    } else if (!isCacheFresh(modelCache)) {
      background.push(() => __cb.fetchModelPricing(workspaceId));
    }

    if (!planCache) {
      mustAwait.push(__cb.fetchCurrentPlanPricing(workspaceId));
    } else if (!isCacheFresh(planCache)) {
      background.push(() => __cb.fetchCurrentPlanPricing(workspaceId));
    }

    // Subroutines are no longer persisted to localStorage (the workspace blob
    // can be hundreds of KB — e.g. 830 functions in workspace 4515). Warm the
    // in-memory map once per session in the background; per-table cost still
    // resolves authoritatively on demand via fetchSubroutineCosts when a
    // function card is added (see resolveSubroutineCostsForCards).
    if (!__cb.subroutineByTableId) {
      background.push(() => __cb.fetchSubroutines(workspaceId));
    }

    for (const run of background) {
      Promise.resolve()
        .then(run)
        .catch((err) => console.warn("[Clay Scoping] background cache refresh failed:", err));
    }

    await Promise.all(mustAwait);
  };

  __cb.fetchEnrichments = async function (workspaceId) {
    const res = await fetch(
      `https://api.clay.com/v3/actions?workspaceId=${workspaceId}`,
      { credentials: "include" }
    );
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    const data = await res.json();

    // Build a flat entry array first so we can both hydrate the lookups and
    // cache the (trimmed) entries — caching the raw /v3/actions response
    // would be far larger and is unnecessary since only these fields are read.
    const entries = [];
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
      // `pre` powers the legacy side of the Old vs New Pricing comparison
      // modal (gated by the `pricing_comparison` feature flag in the UI
      // layer). Computing it unconditionally is cheap (one optional chain)
      // and avoids having to await __cb.supabaseJwtReady inside this hot
      // loop just to skip three field assignments below.
      const pre = action.pricing?.prePricingChange2026;
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
        // Legacy (pre-2026) pricing siblings. Same fallback chain as
        // above so actions that only carry the root `pricing.credits`
        // block (un-migrated) report the same number on both sides.
        // Populated for everyone; the pricing comparison UI that reads
        // them is gated by the `pricing_comparison` feature flag.
        legacyCredits: pre?.credits?.basic ?? fallback?.credits?.basic ?? null,
        legacyActionExecutions:
          pre?.credits?.actionExecution ?? fallback?.credits?.actionExecution ?? null,
        legacyPrivateKeyCredits:
          pre?.usesPrivateKeyCredits?.basic ??
          fallback?.usesPrivateKeyCredits?.basic ??
          0,
      };
      entries.push(entry);
    }
    // Clay's canonical action-id format is `${packageId}/${actionKey}`
    // (see libs/shared/src/actions/build-action-ids.ts). applyEnrichmentEntries
    // indexes by both the slash form and the hyphen form for legacy call-sites
    // in table-import.js / picker.js.
    applyEnrichmentEntries(entries);
    __cb.writeStaticCache(CACHE_KEYS.actions(workspaceId), workspaceId, entries);
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
      __cb.writeStaticCache(CACHE_KEYS.modelpricing(workspaceId), workspaceId, __cb.livePricingByModel);
    } catch (err) {
      console.warn("[Clay Scoping] model pricing fetch failed, using defaults:", err);
    }
  };

  // Fetches EVERY function (subroutine) in the workspace in one unfiltered call
  // to the same endpoint Clay's column editor uses for a single function
  // (GET /v3/workspaces/:ws/subroutines). Omitting the subroutineTableIds[]
  // filter returns all non-managed subroutine tables (see
  // apps/api/v3/tables/endpoints/subroutines.endpoints.ts). We index them by
  // referenced table id AND lowercased name so the picker can resolve a picked
  // function's projected cost + referenced table without a per-function
  // round-trip, and the import flow can stamp cost synchronously. `cost` is the
  // same getRunCostEstimate number __cb.fetchSubroutineCosts returns for a
  // single table (standalone sub-columns summed, waterfall steps averaged).
  //
  // NOT persisted to localStorage: the full workspace blob is large (e.g. 830
  // functions / ~230KB in workspace 4515) and would compete with Clay for the
  // shared ~5MB origin budget. The map is warmed in memory once per session
  // (ensureStaticData / startPickerMode); any function added afterwards still
  // gets an authoritative cost on demand via fetchSubroutineCosts (see
  // resolveSubroutineCostsForCards), so dropping the cache costs at most one
  // bulk fetch per session, never correctness.
  __cb.fetchSubroutines = async function (workspaceId) {
    try {
      const res = await fetch(
        `https://api.clay.com/v3/workspaces/${workspaceId}/subroutines`,
        { credentials: "include" }
      );
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      const body = await res.json();
      const arr = Array.isArray(body) ? body : body?.subroutines || [];
      const byTableId = {};
      const byName = {};
      for (const s of arr) {
        const t = s?.table;
        if (!t?.id) continue;
        const entry = {
          tableId: t.id,
          name: t.name ?? null,
          sourceId: s.sourceId ?? null,
          cost: s.cost ?? null,
          actionExecutionCost: s.actionExecutionCost ?? null,
        };
        byTableId[t.id] = entry;
        if (t.name) byName[t.name.toLowerCase()] = entry;
      }
      __cb.subroutineByTableId = byTableId;
      __cb.subroutineByName = byName;
    } catch (err) {
      console.warn("[Clay Scoping] subroutines fetch failed:", err);
      // Keep any previously-hydrated map; ensure the lookups exist so callers
      // can read them with optional chaining without an undefined guard.
      __cb.subroutineByTableId = __cb.subroutineByTableId || {};
      __cb.subroutineByName = __cb.subroutineByName || {};
    }
  };

  // Fetches the workspace's currently-active billing plan + price tier and
  // derives a CPC ($/credit) from the contract numbers. Used by the Old vs
  // New comparison modal (gated by the `pricing_comparison` feature flag)
  // to auto-fill the matching side's editable rate input (legacy plan ->
  // legacy rate, modern plan -> modern rate). The other side stays at its
  // FIXED list-price default so the comparison still shows a meaningful
  // "what would you pay on the other catalog" contrast even when one side
  // is anchored to the customer's contract.
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
        __cb.writeStaticCache(CACHE_KEYS.plan(workspaceId), workspaceId, null);
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
        // Raw plan-type classification for credit math (independent of the
        // cpc !== null guard the comparison modal's auto-fill needs). Lets
        // the import pick the pre/post-2026 catalog tier even for Enterprise
        // placeholder plans whose priceInfo isn't usable for a CPC.
        planIsLegacy: isLegacyType,
        planIsModern: isModernType,
      };
      __cb.writeStaticCache(CACHE_KEYS.plan(workspaceId), workspaceId, __cb.currentPlanPricing);
    } catch (err) {
      console.warn("[Clay Scoping] current plan pricing fetch failed:", err);
      __cb.currentPlanPricing = null;
    }
  };

  /** Returns a workspace's display name + icon URL from Clay. Cached in
   *  localStorage (24h TTL) like other static datasets. Safe to call from
   *  the content script while viewing that workspace — the session is always
   *  a member there, including during impersonation. */
  __cb.getWorkspaceMeta = async function (workspaceId) {
    if (!workspaceId) return { name: null, iconUrl: null };
    const cacheKey = CACHE_KEYS.workspace(workspaceId);
    const cached = __cb.readStaticCache(cacheKey, workspaceId);
    if (cached?.data) return cached.data;

    let meta = { name: null, iconUrl: null };
    try {
      const res = await fetch(`https://api.clay.com/v3/workspaces/${workspaceId}`, {
        credentials: "include",
      });
      if (res.ok) {
        const data = await res.json();
        meta = {
          name: data?.name || null,
          iconUrl: data?.icon?.url || null,
        };
        __cb.writeStaticCache(cacheKey, workspaceId, meta);
      }
    } catch (err) {
      console.warn("[Clay Scoping] workspace meta fetch failed:", err);
    }
    return meta;
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
        // Hardcoded to 3 (see config.js WATERFALL_ACTION_EXECUTIONS). This is
        // the flat-card fallback's per-row action-executions for a waterfall
        // that didn't get upgraded to a waterfall card.
        __cb.waterfallExecByName[name] = __cb.WATERFALL_ACTION_EXECUTIONS;
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

  // Single source record. A `type: "source"` field stores only `sourceIds` in
  // its typeSettings — the real billing identity (actionKey / actionPackageId /
  // inputs for a v3-action source) lives on the source record fetched here.
  // Response shape (verified): { id, workspaceId, name, type, typeSettings,
  // state, sourceSubscriptions, ... } where `type` is one of SourceType
  // ('v3-action', 'csv', 'webhook', 'trigger-source', 'audience-source',
  // 'big-source', 'prospector-source', 'manual', ...). Fail-soft: returns null
  // on any HTTP/network error so the import still produces structural cards.
  __cb.fetchSource = async function (sourceId) {
    if (!sourceId) return null;
    try {
      const res = await fetch(
        `https://api.clay.com/v3/sources/${sourceId}`,
        { credentials: "include" }
      );
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      return await res.json();
    } catch (err) {
      console.warn("[Clay Scoping] fetchSource failed:", sourceId, err);
      return null;
    }
  };

  // Batch-resolves a list of source ids into a Map<sourceId, sourceRecord>,
  // deduping and fetching in parallel. Missing / failed ids are simply absent
  // from the map (fetchSource swallows their errors), so callers can treat a
  // miss the same as an unresolved source.
  __cb.fetchSourcesByIds = async function (sourceIds) {
    const map = new Map();
    const unique = [...new Set((sourceIds || []).filter(Boolean))];
    if (unique.length === 0) return map;
    const records = await Promise.all(unique.map((id) => __cb.fetchSource(id)));
    for (let i = 0; i < unique.length; i++) {
      if (records[i]) map.set(unique[i], records[i]);
    }
    return map;
  };

  // Trigger definition for a native Clay signal source. A `trigger-source`
  // field's source record carries only `{ signalType, triggerDefinitionId }`
  // (no action identity) — the backing action, monitored table/view, and
  // schedule live on the trigger definition fetched here. Response shape
  // (verified): { triggerDefinition: { id, schedule, signal: { type, settings:
  // { tableId, viewId, actionKey, actionPackageId, ... } }, ... } }. Returns
  // the unwrapped triggerDefinition object, or null on any error (fail-soft so
  // the import still produces a structural source chip).
  __cb.fetchTriggerDefinition = async function (workspaceId, triggerDefinitionId) {
    if (!workspaceId || !triggerDefinitionId) return null;
    try {
      const res = await fetch(
        `https://api.clay.com/v3/workspaces/${workspaceId}/trigger-definitions/${triggerDefinitionId}`,
        { credentials: "include" }
      );
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      const body = await res.json();
      return body?.triggerDefinition ?? body ?? null;
    } catch (err) {
      console.warn("[Clay Scoping] fetchTriggerDefinition failed:", triggerDefinitionId, err);
      return null;
    }
  };

  // Server-authoritative estimated cost for a signal. Returns the `signalCost`
  // block: { cost, chargeUnit: "run"|"result"|"record"|"dynamic",
  // actionExecutionCost }. The server resolves the monitored record count from
  // the signal definition itself, so the `numberOfRecords` query param is
  // effectively ignored (verified: identical cost for 0/1/467). Returns null on
  // error or for signal types the server can't price.
  __cb.fetchEstimatedSignalCost = async function (workspaceId, triggerDefinitionId) {
    if (!workspaceId || !triggerDefinitionId) return null;
    try {
      const res = await fetch(
        `https://api.clay.com/v3/workspaces/${workspaceId}/trigger-definitions/${triggerDefinitionId}/estimated-signal-cost`,
        { credentials: "include" }
      );
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      const body = await res.json();
      return body?.signalCost ?? null;
    } catch (err) {
      console.warn("[Clay Scoping] fetchEstimatedSignalCost failed:", triggerDefinitionId, err);
      return null;
    }
  };

  // Batch-resolves a list of trigger definition ids into a
  // Map<triggerDefinitionId, { definition, signalCost }>, deduped and fetched in
  // parallel. Each entry pairs the definition (monitored table/action/schedule)
  // with its server-estimated signal cost. Missing / failed ids are absent from
  // the map (both fetchers swallow their errors).
  __cb.fetchTriggerDefinitionsByIds = async function (workspaceId, triggerDefinitionIds) {
    const map = new Map();
    const unique = [...new Set((triggerDefinitionIds || []).filter(Boolean))];
    if (unique.length === 0 || !workspaceId) return map;
    const results = await Promise.all(
      unique.map(async (id) => {
        const [definition, signalCost] = await Promise.all([
          __cb.fetchTriggerDefinition(workspaceId, id),
          __cb.fetchEstimatedSignalCost(workspaceId, id),
        ]);
        return { id, definition, signalCost };
      })
    );
    for (const r of results) {
      if (r.definition || r.signalCost) {
        map.set(r.id, { definition: r.definition, signalCost: r.signalCost });
      }
    }
    return map;
  };

  // Single-table schema by table id. NOTE: `GET /v3/workbooks/:wb/tables/:id`
  // 404s — the canonical single-table path is `GET /v3/tables/:id` (returns
  // the table object, sometimes wrapped as `{ table }`). Used defensively when
  // a `fetchTableList` row is missing `extractedField` / `typeSettings`. Returns
  // the unwrapped table object, or null on error.
  __cb.fetchTable = async function (tableId) {
    if (!tableId) return null;
    try {
      const res = await fetch(
        `https://api.clay.com/v3/tables/${tableId}`,
        { credentials: "include" }
      );
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      const body = await res.json();
      return body?.table ?? body ?? null;
    } catch (err) {
      console.warn("[Clay Scoping] fetchTable failed:", tableId, err);
      return null;
    }
  };

  // Workbook detail (name, parentFolderId, ...). We only need parentFolderId
  // here: folder membership is a direct pointer on the workbook row
  // (clay_admin.workflows.parent_folder_id), null = workspace root. The import
  // flow reads it to discover the folder a workbook lives in so it can offer
  // tables from every workbook in that folder. Same endpoint workbook-info.js
  // uses for the name, but that helper only caches the name string.
  __cb.fetchWorkbookDetail = async function (workspaceId, workbookId) {
    const res = await fetch(
      `https://api.clay.com/v3/${workspaceId}/workbooks/${workbookId}`,
      { credentials: "include" }
    );
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    return res.json();
  };

  // Lists the workbooks that live directly inside `folderId` (or at the
  // workspace root when folderId is null). Mirrors Clay's own file browser
  // (useWorkspaceResources -> POST /v3/workspaces/:ws/resources_v2/). The
  // server filters to WORKBOOK resources and returns a flat array of
  // SerializedWorkbook objects (each carries id, name, parentFolderId,
  // resourceType). Direct children only (no recursion into subfolders) — the
  // resources_v2 default scope. Returns [] on a shape we don't recognize.
  __cb.fetchFolderWorkbooks = async function (workspaceId, folderId) {
    const parentResource = folderId ? { id: folderId, type: "FOLDER" } : null;
    const res = await fetch(
      `https://api.clay.com/v3/workspaces/${workspaceId}/resources_v2/`,
      {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          parentResource,
          filters: { resourceTypes: ["WORKBOOK"] },
        }),
      }
    );
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    const data = await res.json();
    const resources = Array.isArray(data?.resources) ? data.resources : [];
    return resources.filter((r) => r && r.resourceType === "WORKBOOK" && r.id);
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

  // Finds the FIRST record (in the view's display order) whose `fieldId` cell is
  // empty, WITHOUT mutating the view. Reads the view's persisted filter + sort,
  // ANDs in an emptiness clause for the field, and asks the ad-hoc /find
  // endpoint (POST /v3/tables/:id/find) for a single match. `operator` is the
  // emptiness operator: "EMPTY" for basic columns, or a run-status operator
  // ("NO_RESULTS"/"HAS_NOT_RUN") for action columns. Returns the recordId
  // string, or null when nothing is missing. Throws on network/HTTP error so
  // the caller can surface a toast. Used by the table-view "spotcheck" button.
  //
  // The view-filter -> pagination-filter conversion mirrors the server's
  // gridViewFilterConfigToPaginationFilter (apps/api/v3/tables/services/
  // view.service.ts) so /find matches exactly what the grid shows.
  __cb.fetchFirstEmptyRecord = async function (tableId, viewId, fieldId, operator = "EMPTY") {
    if (!tableId || !fieldId) return null;

    const toField = (it) => ({
      type: "FIELD",
      fieldId: it.fieldId,
      filterConfig: { type: "OPERATOR", operator: it.type, value: it.value },
    });
    const viewFilterToPagination = (vf) => {
      if (!vf || !Array.isArray(vf.items)) return null;
      const operands = [];
      for (const it of vf.items) {
        if (!it || it.disabled) continue;
        if (it.filterType === "Group") {
          const enabled = (it.items || []).filter((x) => x && !x.disabled);
          if (!enabled.length) continue;
          operands.push({
            type: it.combinationMode === "OR" ? "OR" : "AND",
            operands: enabled.map(toField),
          });
        } else {
          operands.push(toField(it));
        }
      }
      if (!operands.length) return null;
      return { type: vf.combinationMode === "OR" ? "OR" : "AND", operands };
    };

    // View filter + sort make the match respect the view's display order. Best
    // effort: if the view fetch fails, fall back to an unfiltered default-order
    // search (still finds a genuinely-missing cell).
    let viewFilter = null;
    let sorts = [];
    if (viewId) {
      try {
        const vres = await fetch(
          `https://api.clay.com/v3/tables/${tableId}/views/${viewId}`,
          { credentials: "include" }
        );
        if (vres.ok) {
          const vbody = await vres.json();
          const view = vbody?.result ?? vbody;
          viewFilter = viewFilterToPagination(view?.filter);
          const items = view?.sort?.items;
          if (Array.isArray(items)) {
            sorts = items
              .filter((s) => s && s.fieldId)
              .map((s) => ({
                fieldId: s.fieldId,
                sortOrder:
                  String(s.direction || "").toLowerCase() === "desc" ? "desc" : "asc",
              }));
          }
        }
      } catch (_e) {
        /* non-fatal — fall through to an unfiltered search */
      }
    }

    const emptyClause = {
      type: "FIELD",
      fieldId,
      filterConfig: { type: "OPERATOR", operator },
    };
    const filter = viewFilter
      ? { type: "AND", operands: [viewFilter, emptyClause] }
      : emptyClause;
    const body = sorts.length ? { filter, sorts } : { filter };

    const res = await fetch(
      `https://api.clay.com/v3/tables/${tableId}/find?limit=1`,
      {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }
    );
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    const data = await res.json();
    const first = Array.isArray(data?.results) ? data.results[0] : null;
    return first?.id ?? null;
  };

  // Read-only exact row count for a single field value — the on-demand fallback
  // for the Actual-mode fill editor when a sentinel value is too rare to appear
  // in the server-gated `commonValues` (top-5 / >3 occurrences / >5%). There's
  // no count endpoint, so we POST the smallest possible /find filter (one FIELD
  // clause scoped to just the excluded value, so the match set stays small) and
  // count `results.length`. No view filter is ANDed — fill is whole-table,
  // matching the full-profile import context.
  //
  // `operator` is "EQUAL" for a concrete value or "EMPTY" for null-or-blank
  // cells (the value is omitted for EMPTY). `totalRecords` sizes the limit so
  // we fetch every match in one call; we cap it to keep payloads sane (each
  // /find result is a full record). When the match set hits the cap the count
  // is flagged `approximate` so the UI can show "≥ N".
  __cb.fetchFieldValueCount = async function (
    tableId,
    fieldId,
    { operator = "EQUAL", value, totalRecords } = {}
  ) {
    if (!tableId || !fieldId) return { count: 0, approximate: false };
    const CAP = 5000;
    const limit = Math.min(CAP, Math.max(1, Number(totalRecords) || CAP));

    const filterConfig =
      operator === "EMPTY"
        ? { type: "OPERATOR", operator: "EMPTY" }
        : { type: "OPERATOR", operator, value };
    const filter = { type: "FIELD", fieldId, filterConfig };

    const res = await fetch(
      `https://api.clay.com/v3/tables/${tableId}/find?limit=${limit}`,
      {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filter }),
      }
    );
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    const data = await res.json();
    const count = Array.isArray(data?.results) ? data.results.length : 0;
    return { count, approximate: count >= limit };
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

  // Fast import context — the import path's projected leg. Same /context
  // endpoint, but instead of the `full` preset (DEFAULT_FIELD_CONFIG_OPTIONS,
  // sampleSize: 0 = profile EVERY row) we send customOptions that:
  //   - keep includeCreditCosts (per-field ActionCostMetadata → Layer A)
  //   - keep includeStatusCounts + includeDataProfiling with a TINY sampleSize
  //     so the server still folds in the all-rows run-status aggregation
  //     (coverage / fill for action fields stays exact — it comes from
  //     getRunStatusCounts, not the sample) without the all-rows value scan
  //   - turn OFF the heavy error/example/schema analysis the import never uses
  // customOptions is spread over the base preset server-side
  // ({ ...MEDIUM_FIELD_CONFIG_OPTIONS, ...customOptions }), so no backend
  // change is needed. See apps/api/v3/clay-context/services/table-context.service.ts.
  //
  // Why sampleSize 1 is enough (verified against table-context.service.ts):
  //   - profiling must stay ON (includeDataProfiling gates the dataProfile
  //     block that carries the status counts), but the sampled stats inside it
  //     are only FALLBACKS for the import:
  //       a) basic-column nullPercentage — superseded by
  //          fetchFullProfileInBackground (sampleSize: 0 = all rows) minutes
  //          later; the 1-row value is shown only until/unless that fails.
  //       b) action-field valueCount/sampleSize — used only when the server's
  //          run-status read came back pending (Redis cache miss). At 1 row
  //          this fallback is binary (0% or 100%) instead of a rough %.
  //   - everything the import actually keys on is sample-independent:
  //     getRunStatusCounts (full-table SQL), creditCost (in-memory
  //     getActionCost), dataProfile.totalRecords (full record count).
  //   - sampling is deterministic first-N (getSampleIds slices, no shuffle),
  //     so 1 profiles exactly the first row.
  __cb.IMPORT_CONTEXT_SAMPLE_SIZE = 1;
  __cb.fetchTableContextForImport = async function (workspaceId, tableId) {
    try {
      const res = await fetch(
        `https://api.clay.com/v3/workspaces/${workspaceId}/tables/${tableId}/context`,
        {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            formatAsXML: false,
            contextDetailLevel: "medium",
            getExampleRows: 0,
            customOptions: {
              includeCreditCosts: true,
              includeStatusCounts: true,
              includeDataProfiling: true,
              sampleSize: __cb.IMPORT_CONTEXT_SAMPLE_SIZE,
              includeActionFieldAnalysis: false,
              includeFormulaFieldAnalysis: false,
              includeExampleValues: false,
              includeErrorExamples: false,
              includeFullSchemas: false,
            },
          }),
        }
      );
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      const body = await res.json();
      return body?.result ?? null;
    } catch (err) {
      console.warn("[Clay Scoping] fetchTableContextForImport failed:", err);
      return null;
    }
  };

  // Per-field configs for a referenced "main function" table. A subroutine
  // ("Run function") field has no cost of its own — its projected credits AND
  // actions are the sum of the table it points at (typeSettings.referencedTableId):
  //   - credits → sum of each field's `creditCost` (what Clay's Edit-column panel shows)
  //   - actions → sum of each action field's catalog actionExecutions, looked up
  //     via the `actionInfo` block (actionKey + actionPackageId)
  // `includeFullSchemas: true` is REQUIRED to get `actionInfo`, and (unlike
  // `false`, which suppresses it) still returns `creditCost`. Returns the raw
  // fieldConfigs array (each may carry `creditCost` and/or `actionInfo`), or null.
  __cb.fetchReferencedTableFieldConfigs = async function (workspaceId, tableId) {
    try {
      const res = await fetch(
        `https://api.clay.com/v3/workspaces/${workspaceId}/tables/${tableId}/context`,
        {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            formatAsXML: false,
            contextDetailLevel: "medium",
            getExampleRows: 0,
            customOptions: {
              includeCreditCosts: true,
              includeStatusCounts: false,
              includeDataProfiling: false,
              sampleSize: 1,
              includeFullSchemas: true,
            },
          }),
        }
      );
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      const body = await res.json();
      const fcs = body?.result?.fieldConfigurationsData?.fieldConfigs;
      return Array.isArray(fcs) ? fcs : null;
    } catch (err) {
      console.warn("[Clay Scoping] fetchReferencedTableFieldConfigs failed:", err);
      return null;
    }
  };

  // App accounts (auth accounts) for the workspace. Used by the Old vs New
  // Pricing comparison modal (gated by the `pricing_comparison` feature
  // flag) to differentiate "Clay-managed shared key" (bills credits) from
  // "user-pasted private key" (BYOK, free) on AI fields where the user
  // picked a non-default authAccountId. Mirrors the server-side rule in
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

  // Default-selection fallback before a table's probe lands. Per-table
  // actualImportDays (session-cutoff) is set to whichever SESSION_PROBE_DAYS
  // window first returns runs (7, 30, or 90); if all are empty, 180 is tried.
  __cb.ACTUAL_IMPORT_DAYS = 7;
  // Exponential run/recent probe order; session-cutoff stops at the first hit.
  __cb.SESSION_PROBE_DAYS = [7, 30, 90];
  // Background widen after a probe hit (7/30 → 90; 90 → 180). If 90 fails, 180.
  __cb.SESSION_WIDE_DAYS = 90;
  __cb.SESSION_FALLBACK_DAYS = 180;

  // Per-column actual spend over the last N days. Backed by Redshift
  // (credit_usage_mv_v4, fed via Kinesis, ~minutes of lag). `days` is a rolling
  // window on approximate_arrival_timestamp ending now; the server default is 7
  // and there is NO max (zod: int().positive() only). The real floor is
  // REALTIME_CREDIT_USAGE_START_DATE =
  // 2025-11-05: data before that is incomplete (under-counts), regardless of
  // how large `days` is. Returns an array of
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

  // Per-RUN realtime spend over the last N days. Each entry carries a runId, a
  // timestamp (MIN arrival, unix seconds), totals, and a per-column breakdown
  // (columns[].{fieldId, creditsSpent, actionExecutionCreditsSpent, cellCount}).
  // Used to discover "sessions" (time-gap clusters of runs) for the Actual
  // spend cutoff picker. Same coverage window caveat as fetchColumnSpend
  // (realtime data only complete from 2025-11-05).
  __cb.fetchRunSpend = async function (workspaceId, tableId, days = 210) {
    try {
      const res = await fetch(
        `https://api.clay.com/v3/realtime-credit-usage/${workspaceId}/table/${tableId}/run/recent?days=${days}`,
        { credentials: "include" }
      );
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      return res.json();
    } catch (err) {
      console.warn("[Clay Scoping] fetchRunSpend failed:", err);
      return null;
    }
  };

  // Authoritative per-row credit + action cost for a subroutine (function)
  // table — the same number Clay's column editor shows. A function field has NO
  // creditCost in /context (the wrapper bills only action executions; cost lives
  // in the referenced sub-table). Clay computes it server-side via
  // getRunCostEstimate (standalone sub-columns summed, waterfall steps
  // AVERAGED). Reconstructing it client-side by flat-summing sub-table field
  // creditCosts overcounts waterfalls, so we call the same endpoint instead.
  //   GET /v3/workspaces/:ws/subroutines?subroutineTableIds[]=<refTableId>
  //   -> { subroutines: [{ table, cost, actionExecutionCost, ... }] }
  // Bracket array encoding is required (repeated ?key=v returns 400). Returns
  // { cost, actionExecutionCost } for the referenced table, or null on failure.
  __cb.fetchSubroutineCosts = async function (workspaceId, referencedTableId) {
    try {
      const url =
        `https://api.clay.com/v3/workspaces/${workspaceId}/subroutines` +
        `?subroutineTableIds[]=${encodeURIComponent(referencedTableId)}`;
      const res = await fetch(url, { credentials: "include" });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      const body = await res.json();
      const arr = Array.isArray(body) ? body : body?.subroutines || [];
      const hit = arr[0];
      if (!hit) return null;
      return {
        cost: Number(hit.cost) || 0,
        actionExecutionCost: Number(hit.actionExecutionCost) || 0,
      };
    } catch (err) {
      console.warn("[Clay Scoping] fetchSubroutineCosts failed:", err);
      return null;
    }
  };

  // -------------------------------------------------------------------------
  // Clay table CSV export jobs — same async API the Clay UI "Download CSV"
  // button uses. Session cookies authenticate; no separate auth needed.
  // -------------------------------------------------------------------------

  async function parseClayApiError(res) {
    let msg = `HTTP ${res.status} ${res.statusText}`;
    try {
      const body = await res.json();
      if (body?.message) msg = body.message;
    } catch {
      /* ignore */
    }
    return msg;
  }

  __cb.startTableViewExport = async function (tableId, viewId, queryParams) {
    if (!tableId || !viewId) throw new Error("tableId and viewId required");
    const qs = queryParams ? `?${new URLSearchParams(queryParams)}` : "";
    const res = await fetch(
      `https://api.clay.com/v3/tables/${tableId}/views/${viewId}/export${qs}`,
      {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      },
    );
    if (!res.ok) throw new Error(await parseClayApiError(res));
    return res.json();
  };

  __cb.startTableExport = async function (tableId, queryParams) {
    if (!tableId) throw new Error("tableId required");
    const qs = queryParams ? `?${new URLSearchParams(queryParams)}` : "";
    const res = await fetch(
      `https://api.clay.com/v3/tables/${tableId}/export${qs}`,
      {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      },
    );
    if (!res.ok) throw new Error(await parseClayApiError(res));
    return res.json();
  };

  __cb.fetchExportJob = async function (exportJobId) {
    const res = await fetch(
      `https://api.clay.com/v3/exports/${exportJobId}`,
      { credentials: "include" },
    );
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    return res.json();
  };

  // Poll until FINISHED (or throw on FAILED / timeout). Mirrors the Clay UI's
  // 5s refresh interval in BaseExportRow.tsx.
  __cb.waitForExportJob = async function waitForExportJob(exportJobId, opts) {
    const pollIntervalMs = (opts && opts.pollIntervalMs) || 5000;
    const timeoutMs = (opts && opts.timeoutMs) || 10 * 60 * 1000;
    const onProgress = opts && opts.onProgress;
    const start = Date.now();

    while (true) {
      const job = await __cb.fetchExportJob(exportJobId);
      if (onProgress) onProgress(job);
      if (job.status === "FINISHED") return job;
      if (job.status === "FAILED") {
        throw new Error("Clay export job failed");
      }
      if (Date.now() - start > timeoutMs) {
        throw new Error("Clay export timed out");
      }
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
  };
})();
