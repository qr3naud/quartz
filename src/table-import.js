(function () {
  "use strict";

  const __cb = window.__cb;

  let tablePickerEl = null;
  let tablePickerBackdrop = null;
  let importStatusEl = null;

  // ---------------------------------------------------------------------------
  // Combines per-provider stats blocks into a single coverage / fillRate
  // pair for the parent waterfall card.
  //
  // Coverage: MAX of step coverage.ran. Step 1 runs on the entire eligible
  // input set; subsequent steps run on diminishing subsets (only the rows
  // earlier steps didn't fill). The largest step.ran IS the waterfall's
  // true denominator — summing would double-count rows that flow through
  // multiple steps.
  //
  // Fill rate: success summed across providers that have runstatus-based
  // coverage (each row succeeds at most once across the chain, so summing
  // per-step successes equals the waterfall's total successes). Denominator
  // anchored to coverage.ran — the waterfall's true denominator. Avoids
  // mixing dataProfile sample sizes (often hundreds) with runstatus counts.
  //
  // Spend: SUM (each provider charges for whatever it ran).
  //
  // Returns null when no provider has data so the card omits the stats row.
  function aggregateWaterfallStats(providers) {
    let coverageRan = 0;
    let coverageTotal = 0;
    let fillSuccess = 0;
    let spendCredits = 0;
    let spendActions = 0;
    let spendCells = 0;
    let any = false;
    let source = null;
    let fetchedAt = null;
    for (const p of providers || []) {
      const s = p?.stats;
      if (!s) continue;
      any = true;
      if (!source && s.source) source = s.source;
      if (!fetchedAt && s.fetchedAt) fetchedAt = s.fetchedAt;

      if (s.coverage) {
        coverageRan = Math.max(coverageRan, Number(s.coverage.ran) || 0);
        coverageTotal = Math.max(coverageTotal, Number(s.coverage.total) || 0);
      }

      // Only count fill-rate success from providers backed by runstatus
      // coverage. dataProfile-based fillRate uses sample sizes that can't
      // be meaningfully combined with runstatus counts.
      if (s.coverage && s.fillRate) {
        fillSuccess += Number(s.fillRate.success) || 0;
      }

      if (s.spend) {
        spendCredits += Number(s.spend.credits) || 0;
        spendActions += Number(s.spend.actionExecutions) || 0;
        spendCells += Number(s.spend.cellCount) || 0;
      }
    }
    if (!any) return null;
    const out = { source, fetchedAt };
    if (coverageRan > 0 && coverageTotal > 0) {
      out.coverage = { ran: coverageRan, total: coverageTotal };
      // Fill rate denominator = waterfall coverage. "Of the records the
      // waterfall attempted, how many got a result." Both popover sections
      // (coverage + fill rate) now share the same record count.
      out.fillRate = { success: fillSuccess, ran: coverageRan };
    }
    if (spendCredits > 0 || spendActions > 0 || spendCells > 0) {
      out.spend = {
        credits: spendCredits,
        actionExecutions: spendActions,
        cellCount: spendCells,
      };
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // Pulls every {{fieldId}} reference out of an action field's
  // `inputsBinding`. The format depends on how the binding was authored:
  //
  //   - Object-shaped (the common case for real Clay actions):
  //       { "0": { name: "personFullName", formulaText: "{{abc-fieldId}}" }, ... }
  //   - String-shaped (rare, set by some legacy paths):
  //       { personFullName: "{{abc-fieldId}}" }
  //
  // We walk every value, peel out the `formulaText` if present, and run the
  // same `{{...}}` regex Clay's own formula engine uses. The regex matches
  // any `{{token}}` — table-level (t_xxx) and source-level (s_xxx)
  // references will leak through, but the caller intersects against the
  // table's actual `fields[].id` so non-field tokens get filtered out at
  // the next step. Returns a Set of raw IDs.
  // ---------------------------------------------------------------------------
  function extractInputFieldRefs(inputsBinding) {
    const ids = new Set();
    if (!inputsBinding || typeof inputsBinding !== "object") return ids;
    const re = /\{\{\s*([a-zA-Z0-9_-]+)\s*\}\}/g;
    for (const v of Object.values(inputsBinding)) {
      if (!v) continue;
      const text = typeof v === "string"
        ? v
        : (typeof v === "object" && typeof v.formulaText === "string"
            ? v.formulaText
            : "");
      if (!text) continue;
      let m;
      re.lastIndex = 0;
      while ((m = re.exec(text)) !== null) {
        if (m[1]) ids.add(m[1]);
      }
    }
    return ids;
  }

  __cb.extractInputFieldRefs = extractInputFieldRefs;

  // Exposed so other modules can reuse the same model resolution path the
  // import uses for AI cards (read the user-selected model off
  // field.typeSettings.inputsBinding, then match against the catalog with
  // quote-stripping + longest-includes fallback). Function declarations
  // below are hoisted within this IIFE so the assignment is safe even
  // though the definitions appear further down in the file.
  __cb.readInputBindingValue = readInputBindingValue;
  __cb.matchKnownModel = matchKnownModel;

  // ---------------------------------------------------------------------------
  // Resolves the value of a single named input on an action field's
  // `inputsBinding`. Used to read the user-selected `model` off AI actions
  // (Claygent / Use AI) so imports don't fall back to DEFAULT_AI_MODEL —
  // the catalog's base credit cost (0.1 for use-ai, 1 for claygent) is
  // misleading because Claygent costs depend on the model picked.
  //
  // Mirrors the server-side parsing in
  // libs/shared/src/credits/credit-cost-utils.ts line 337 which does the
  // same `actionInputs.find(i => i.name === 'model').formulaText`. Returns
  // null when the param is unset, the binding is missing, or the value
  // isn't a primitive string we can use directly.
  // ---------------------------------------------------------------------------
  function readInputBindingValue(inputsBinding, paramName) {
    if (!inputsBinding || typeof inputsBinding !== "object" || !paramName) return null;
    if (typeof inputsBinding[paramName] === "string") return inputsBinding[paramName];
    for (const v of Object.values(inputsBinding)) {
      if (v && typeof v === "object" && v.name === paramName) {
        if (typeof v.formulaText === "string") return v.formulaText;
        if (typeof v.value === "string") return v.value;
        return null;
      }
    }
    return null;
  }

  // Strips surrounding quotes + whitespace, the same way the server's
  // findModelOption does in libs/shared/src/ai/models.ts line 1280. Bindings
  // sometimes arrive as `"\"gpt-5.4\""` (quoted JSON literal) instead of
  // bare `gpt-5.4`, depending on how the user authored the field.
  function normalizeModelValue(raw) {
    if (typeof raw !== "string") return null;
    const cleaned = raw.trim().replace(/^"|"$/g, "").trim();
    return cleaned || null;
  }

  // Mirrors libs/shared/src/ai/models.ts line 1281 findModelOption: prefer
  // an exact id match, otherwise pick the modelOptions entry whose id is
  // contained in the binding value (longest match wins so "gpt-4.1-mini"
  // beats "gpt-4.1" when the binding is the longer string). Returns the
  // matched modelOptions entry or null.
  function matchKnownModel(normalized, modelOptions) {
    if (!normalized || !Array.isArray(modelOptions) || modelOptions.length === 0) {
      return null;
    }
    const exact = modelOptions.find((m) => m.id === normalized);
    if (exact) return exact;
    const candidates = modelOptions
      .filter((m) => m?.id && normalized.includes(m.id))
      .sort((a, b) => b.id.length - a.id.length);
    return candidates[0] || null;
  }

  // Best-effort provider inference for an unknown model name (or for
  // non-Use-AI/Claygent actions where the action key implies the provider).
  // Returned values match the keys in __cb.AI_PROVIDER_ICONS so the icon
  // override in buildErCardData picks up the right brand mark — falls back
  // to "Custom" when nothing matches, which leaves the original action
  // icon intact instead of showing a misleading provider mark.
  function inferModelProvider(modelValue, actionKey) {
    const m = (modelValue || "").toLowerCase();
    const a = (actionKey || "").toLowerCase();
    if (/^(gpt|chatgpt)/.test(m) || /^o[1-9](\b|-|_)/.test(m)) return "OpenAI";
    if (/^claude/.test(m)) return "Anthropic";
    if (/^gemini/.test(m)) return "Gemini";
    if (/^(clay|operator-clay)/.test(m)) return "Clay";
    if (a.includes("claude")) return "Anthropic";
    if (a.includes("gemini")) return "Gemini";
    if (a.includes("chat-gpt") || a.includes("chatgpt") || a.includes("openai")) return "OpenAI";
    if (a.includes("claygent")) return "Clay";
    return "Custom";
  }

  // Returns { selectedId, modelOptions } where modelOptions has the chosen
  // model in it (either matched against the catalog or appended as a custom
  // entry so the card chip renders the actual model name instead of the
  // Argon default). Always returns an entry; the only time we fall back to
  // DEFAULT_AI_MODEL is when the field has no model binding at all.
  function resolveModelForCard({ rawModel, modelOptions, defaultModelId, actionKey, costFromStats }) {
    const baseOptions = Array.isArray(modelOptions) ? modelOptions : [];
    const normalized = normalizeModelValue(rawModel);

    if (!normalized) {
      const def = baseOptions.find((m) => m.id === defaultModelId) || baseOptions[0];
      return { selectedId: def?.id || null, modelOptions: baseOptions };
    }

    // Skip ad-hoc creation when the binding looks like a formula (per-row
    // model selection). We can't display N models on one card; fall back
    // to the default and let the user re-select if they want to commit to
    // one for the canvas estimate.
    const looksLikeFormula = /[(){}=,]/.test(normalized) || /\s+(IF|AND|OR)\s+/i.test(normalized);
    if (looksLikeFormula) {
      const def = baseOptions.find((m) => m.id === defaultModelId) || baseOptions[0];
      return { selectedId: def?.id || null, modelOptions: baseOptions };
    }

    const matched = matchKnownModel(normalized, baseOptions);
    if (matched) {
      return { selectedId: matched.id, modelOptions: baseOptions };
    }

    // No match — synthesize a custom entry using the server-resolved cost
    // when available so the chip shows accurate per-row credits without
    // any extra plumbing. The `custom: true` marker is informational
    // (current renderers don't read it) for future code that wants to
    // distinguish synthesized vs catalog entries.
    const custom = {
      id: normalized,
      name: normalized,
      credits: typeof costFromStats === "number" ? costFromStats : null,
      provider: inferModelProvider(normalized, actionKey),
      custom: true,
    };
    return {
      selectedId: custom.id,
      modelOptions: [...baseOptions, custom],
    };
  }

  // ---------------------------------------------------------------------------
  // Coverage / fill-rate semantics.
  //
  // `ERROR_RUN_CONDITION_NOT_MET` is bucketed into `successCount`
  // server-side via isStatusTreatedAsSuccess
  // (libs/shared/src/fields/status-processing-utils.ts line 5). Rows where
  // the user's run-condition formula evaluated to false were never actually
  // attempted, so we peel them out of the NUMERATOR using the raw
  // `statusBreakdown` array.
  //
  // Coverage = ran / total, where:
  //   - `ran` (numerator) = rows the enrichment actually executed on
  //     (success − condNotMet + error + inProgress). Excludes condition-skipped
  //     and not-yet-run rows.
  //   - `total` (denominator) = the WHOLE table (totalRecords). Keeping
  //     condNotMet + notRun in the denominator is the point: coverage should
  //     read as "this enrichment ran on X of N rows" — a real fraction. (Using
  //     total − condNotMet made it ~N/N whenever the table was fully run, which
  //     told the user nothing.)
  // Fill rate keeps the tighter `ran` denominator ("of what ran, how much
  // filled").
  //
  // Returns a stat block matching the rest of buildStatsByFieldId's output
  // shape, or null when there's no usable data on this field.
  // ---------------------------------------------------------------------------
  // Statuses where the enrichment never actually EXECUTED on the row (no API
  // call, no credits) — so they must be peeled out of the coverage numerator:
  //   - ERROR_RUN_CONDITION_NOT_MET — the run-condition formula was false. The
  //     server buckets this into successCount (isStatusTreatedAsSuccess), so we
  //     subtract it from success.
  //   - ERROR_MISSING_INPUT ("Missing input") / ERROR_BLANK_TOKEN ("Some inputs
  //     missing") — the action's required input was empty, so it was skipped.
  //     These land in errorCount, so we subtract them from error.
  // Without peeling the input-missing ones, a fallback/second-tier enrichment
  // that's skipped on most rows reads as 100% coverage (verified: "Validate
  // Claygent Domain" showed 650/650 while most cells said "Missing input").
  const COND_SKIP_STATUS = "ERROR_RUN_CONDITION_NOT_MET";
  const INPUT_MISSING_STATUSES = new Set(["ERROR_MISSING_INPUT", "ERROR_BLANK_TOKEN"]);

  function deriveActionStatsFromDataProfile(dp) {
    if (!dp) return null;
    const success = Number(dp.successCount) || 0;
    const error = Number(dp.errorCount) || 0;
    const inProgress = Number(dp.inProgressCount) || 0;
    const total = Number(dp.totalRecords) || 0;

    let condNotMet = 0;     // not-run rows the server counted as success
    let inputMissing = 0;   // not-run rows the server counted as error
    if (Array.isArray(dp.statusBreakdown)) {
      for (const entry of dp.statusBreakdown) {
        const c = Number(entry?.count) || 0;
        if (entry?.status === COND_SKIP_STATUS) condNotMet += c;
        else if (INPUT_MISSING_STATUSES.has(entry?.status)) inputMissing += c;
      }
    }

    const adjustedSuccess = Math.max(0, success - condNotMet);
    const adjustedError = Math.max(0, error - inputMissing);
    const ran = adjustedSuccess + adjustedError + inProgress;

    if (ran <= 0 || total <= 0) return null;
    return {
      coverage: { ran, total },
      fillRate: { success: adjustedSuccess, ran },
      condNotMet: condNotMet + inputMissing,
    };
  }

  // ---------------------------------------------------------------------------
  // Per-field stats join — folds the /context (`full` preset) response and
  // the /realtime-credit-usage spend response into a single Map<fieldId,
  // statsBlock>. With `full`, the dataProfile already carries server-side
  // run status counts (successCount / errorCount / inProgressCount /
  // notRunCount) for action fields AND a per-field `creditCost` block
  // resolved against the field's actual inputsBinding (so AI cost is
  // model-aware), so we don't need a separate runstatus leg anymore.
  //
  // Coverage / fill rate semantics:
  //   - Action fields  → deriveActionStatsFromDataProfile peels
  //                      ERROR_RUN_CONDITION_NOT_MET out of successCount
  //                      and the totalRecords denominator so coverage
  //                      reflects "rows the user actually wanted to run".
  //   - Basic fields   → valueCount / sampleSize from the /context
  //                      dataProfile. With `full`'s sampleSize: 0 the
  //                      profile spans every row (no 1k sculptor cap),
  //                      so empty cells in a DP column drag fillRate down
  //                      the way users expect.
  //
  // Credit cost (`stats.cost`) is a forward of the server-resolved
  // ActionCostMetadata for the field. Card construction uses it to override
  // the catalog-default `credits` so per-row cost reflects the user's actual
  // configured model / private-key wiring.
  //
  // The `runStatus` and `viewCount` parameters are kept on the signature for
  // back-compat with the JSON export modal's "Combined" option, which still
  // fetches them so the timing chip can attribute latency per leg. The join
  // itself ignores them — full's dataProfile is the single source of truth.
  // ---------------------------------------------------------------------------
  function buildStatsByFieldId({ fields, context, spend }) {
    const map = new Map();
    const fetchedAt = Date.now();

    const profileByFieldId = {};
    const creditCostByFieldId = {};
    const fieldConfigs = context?.fieldConfigurationsData?.fieldConfigs;
    if (Array.isArray(fieldConfigs)) {
      for (const fc of fieldConfigs) {
        if (!fc?.id) continue;
        if (fc.dataProfile) profileByFieldId[fc.id] = fc.dataProfile;
        if (fc.creditCost) creditCostByFieldId[fc.id] = fc.creditCost;
      }
    }

    const spendByFieldId = {};
    if (Array.isArray(spend)) {
      for (const row of spend) {
        if (row?.fieldId) spendByFieldId[row.fieldId] = row;
      }
    }

    for (const field of fields ?? []) {
      const stats = { fetchedAt, source: null };
      let hasData = false;

      const dp = profileByFieldId[field.id];

      if (field.type === "action" && dp) {
        const derived = deriveActionStatsFromDataProfile(dp);
        if (derived) {
          stats.coverage = derived.coverage;
          stats.fillRate = derived.fillRate;
          stats.condNotMet = derived.condNotMet;
          stats.source = "dataProfile-full";
          hasData = true;
        }
      }

      // DP (basic) columns: carry nullPercentage + totalRecords so the table
      // view can compute actual fill as nonNull / ER coverage. NOTE: for basic
      // columns the profile's valueCount equals sampleSize, so the old
      // valueCount/sampleSize ratio was always 100% — nullPercentage is the only
      // real per-column fill signal (fill% = 100 - nullPercentage). It's exact
      // only at sampleSize 0 (the background full-profile fetch); the import's
      // sampled value is a fallback shown if that fetch fails.
      if (field.type !== "action" && dp && dp.nullPercentage != null) {
        stats.nullPercentage = Number(dp.nullPercentage) || 0;
        stats.totalRecords = Number(dp.totalRecords) || 0;
        if (!stats.source) stats.source = "dataProfile";
        hasData = true;
      } else if (!stats.fillRate && dp) {
        // Action field whose dataProfile lacked status counts — fall back to
        // valueCount / sampleSize so it still shows something.
        const sampleSize = Number(dp.sampleSize) || 0;
        const valueCount = Number(dp.valueCount) || 0;
        if (sampleSize > 0) {
          stats.fillRate = { success: valueCount, ran: sampleSize };
          if (!stats.source) stats.source = "dataProfile";
          hasData = true;
        }
      }

      // Per-field cost — server-resolved ActionCostMetadata. The shape
      // matches libs/shared/src/credits/credit-types.ts ActionCostMetadata:
      //   { cost, costBy, isPrivateKey, unlimited, maxResultsPerRow, ... }
      // We forward the whole block so card construction can reason about
      // private-key zeroing, per-result actions, and unlimited flags
      // uniformly with how the rest of Clay computes cost.
      if (creditCostByFieldId[field.id]) {
        stats.cost = creditCostByFieldId[field.id];
        hasData = true;
      }

      if (spendByFieldId[field.id]) {
        const s = spendByFieldId[field.id];
        stats.spend = {
          credits: Number(s.creditsSpent) || 0,
          actionExecutions: Number(s.actionExecutionCreditsSpent) || 0,
          cellCount: Number(s.cellCount) || 0,
        };
        hasData = true;
      }

      if (hasData) map.set(field.id, stats);
    }

    return map;
  }

  // Resolves the effective per-row credit cost for an action field, given
  // the catalog default ("info.credits") and the server-side
  // ActionCostMetadata when available. Centralized so the standalone-ER
  // path, the waterfall provider loop, and the validation row all agree.
  //
  //   - unlimited     → 0 (e.g. LinkedIn under the unlimited flag)
  //   - isPrivateKey  → 0 (private-key invocations charge nothing in Clay)
  //   - costBy=RESULT → cost × (maxResultsPerRow ?? FALLBACK)
  //                     Mirrors calculatePerResultCost /
  //                     getWaterfallCreditEstimate in
  //                     libs/shared/src/credits/credit-cost-utils.ts: it
  //                     multiplies by maxResultsPerRow with a fallback of
  //                     FALLBACK_ESTIMATED_RESULTS_PER_ROW = 3 and NO upper
  //                     cap. (Previously this capped at 5 / fell back to 5,
  //                     which under/over-counted per-result enrichments
  //                     relative to Clay's own estimate.)
  //
  // Falls back to the catalog default when the server didn't attach a
  // creditCost block (rare — happens when getActionCost throws or the field
  // has no action definition).
  const FALLBACK_ESTIMATED_RESULTS_PER_ROW = 3;
  //
  // `baseOverride` (optional): use this base cost instead of
  // `creditCost.cost`, while still honoring the server's resolution flags
  // (unlimited / isPrivateKey / costBy / maxResultsPerRow). The import uses
  // it to substitute the plan-correct catalog base on MODERN plans, because
  // /context computes creditCost.cost at LEGACY pricing (getActionCost is
  // called without billingPlanType server-side → defaults to legacy).
  function resolveEffectiveCredits(creditCost, fallback, baseOverride) {
    if (!creditCost) return baseOverride ?? fallback ?? null;
    if (creditCost.unlimited) return 0;
    if (creditCost.isPrivateKey) return 0;
    let cost = baseOverride != null ? Number(baseOverride) : Number(creditCost.cost);
    if (!Number.isFinite(cost)) return fallback ?? null;
    if (creditCost.costBy === "result") {
      const max = Number(creditCost.maxResultsPerRow);
      const n = Number.isFinite(max) && max > 0 ? max : FALLBACK_ESTIMATED_RESULTS_PER_ROW;
      cost = cost * n;
    }
    return cost;
  }
  __cb.resolveEffectiveCredits = resolveEffectiveCredits;

  // ---------------------------------------------------------------------------
  // Plan-aware catalog credit selection.
  //
  // Each catalog entry (from fetchEnrichments) carries BOTH pricing tiers:
  //   - modern (post-2026): `credits` / `actionExecutions` / `privateKeyCredits`
  //   - legacy (pre-2026):  `legacyCredits` / `legacyActionExecutions` / `legacyPrivateKeyCredits`
  // /context's per-field creditCost is always legacy (server defaults), so on
  // a modern-plan workspace we read the modern tier from the catalog instead.
  // Defaults to legacy when the plan is unknown — matching /context.
  // ---------------------------------------------------------------------------
  function importPlanIsModern() {
    return !!__cb.currentPlanPricing?.planIsModern;
  }
  function planAwareBaseCredits(info) {
    if (!info) return null;
    return importPlanIsModern()
      ? (info.credits ?? info.legacyCredits ?? null)
      : (info.legacyCredits ?? info.credits ?? null);
  }
  function planAwarePrivateKeyCredits(info) {
    if (!info) return 0;
    const v = importPlanIsModern()
      ? (info.privateKeyCredits ?? info.legacyPrivateKeyCredits ?? 0)
      : (info.legacyPrivateKeyCredits ?? info.privateKeyCredits ?? 0);
    return Number(v) || 0;
  }
  function planAwareActionExecutions(info) {
    if (!info) return 0;
    // Legacy plans have no actionExecution billing dimension, so this is
    // typically 0 on legacy and 0/1 on modern.
    const v = importPlanIsModern()
      ? (info.actionExecutions ?? info.legacyActionExecutions ?? 0)
      : (info.legacyActionExecutions ?? info.actionExecutions ?? 0);
    return Number(v) || 0;
  }
  __cb.importPlanIsModern = importPlanIsModern;
  __cb.planAwareBaseCredits = planAwareBaseCredits;

  // Re-exposed under __cb so the JSON export modal can run the exact same
  // join the import flow uses, without re-implementing the per-field merge
  // logic. Returns a Map; the export modal converts it to a plain object
  // before serializing. Extra args (runStatus, viewCount) are tolerated and
  // ignored so older Combined-mode callers keep working unchanged.
  __cb.joinTableStats = buildStatsByFieldId;

  // ---------------------------------------------------------------------------
  // Card data factory for an action field (ER) being placed on the canvas.
  // Resolves catalog metadata (icons, AI detection, model, credits) and
  // folds in optional `stats` and `groupCluster` markers for cluster
  // magneting. Used both for standalone ER columns and for individual
  // waterfall steps (each step is now its own ER card).
  //
  // AI columns: prior versions hardcoded `selectedModel = DEFAULT_AI_MODEL`
  // and `credits = info.credits` (the catalog base cost — 0.1 for use-ai,
  // 1 for claygent), so every imported AI card showed up as Argon at 0.1
  // credit regardless of what the user actually picked. We now read the
  // configured model out of `field.typeSettings.inputsBinding[*].model`
  // and use the server-resolved `stats.cost` (ActionCostMetadata) when
  // available — that block is computed by getActionCost server-side with
  // the field's actual inputsBinding, so per-row cost reflects the real
  // model + private-key wiring.
  // ---------------------------------------------------------------------------
  function buildErCardData({ field, actionKey, packageId, displayName, stats, groupCluster, fieldId, tableId, viewId }) {
    const lookupKey = `${packageId}-${actionKey}`;
    const info = __cb.actionByIdLookup[lookupKey];
    const ai = info?.isAi ?? __cb.isAiAction(actionKey, info?.displayName ?? displayName, packageId);
    // Prefer the LIVE getModelOptions() over info.modelOptions because
    // info.modelOptions is frozen at fetchEnrichments time. fetchEnrichments
    // runs BEFORE fetchModelPricing in __cb.startImport, so info.modelOptions
    // captures DEFAULT_AI_MODELS without the workspace-scaled livePricingByModel
    // overlay — meaning variable-priced models (e.g. workspace-tier GPT 5.4
    // = 2.8 credits, not the static default 15) would render with the wrong
    // per-row cost on the canvas card. getModelOptions() is recomputed every
    // call and reads the current livePricingByModel.
    const baseModelOptions = ai ? (__cb.getModelOptions?.() ?? info?.modelOptions) : null;
    const defaultModelId = __cb.DEFAULT_AI_MODEL || "clay-argon";

    // Read the configured model off the field's actual inputsBinding and
    // resolve it through the catalog (with quote-stripping + longest-
    // includes fallback that matches the server's findModelOption). When
    // the model isn't in our catalog (e.g. a brand-new GPT release we
    // haven't sync'd yet, or a custom Anthropic model id), we synthesize
    // an ad-hoc modelOptions entry so the card chip renders the actual
    // model name + provider rather than silently falling back to Argon.
    const modelFromBinding = ai
      ? readInputBindingValue(field?.typeSettings?.inputsBinding, "model")
      : null;
    const { selectedId: selectedModel, modelOptions } = ai && baseModelOptions
      ? resolveModelForCard({
          rawModel: modelFromBinding,
          modelOptions: baseModelOptions,
          defaultModelId,
          actionKey,
          costFromStats: stats?.cost?.cost,
        })
      : { selectedId: null, modelOptions: baseModelOptions };

    const requiresApiKey = info?.requiresApiKey ?? false;

    // Catalog default, plan-aware (modern vs legacy tier). For AI actions
    // this is the action-level base cost (e.g. 0.1 for use-ai), so it's wrong
    // for any non-default model — we override below from either the matched
    // modelOption or the server-resolved stats.cost.
    let credits = planAwareBaseCredits(info);

    // Prefer the model's own creditCostMetadata when this is an AI card —
    // matches what the canvas's model picker shows when the user later
    // changes models, so the imported cost is consistent with the
    // post-import cost.
    if (ai && modelOptions && selectedModel) {
      const modelOpt = modelOptions.find((m) => m.id === selectedModel);
      if (modelOpt && Number.isFinite(modelOpt.credits)) {
        credits = modelOpt.credits;
      }
    }

    // Server-resolved cost is authoritative for non-AI fields (it already
    // accounts for private-key zeroing, per-result multiplication, unlimited
    // flags, and the right pricing bucket).
    //
    // For AI fields we deliberately do NOT let stats.cost override the live
    // per-model credit resolved above. The /context creditCost on an AI
    // field reflects the value the *server* last computed — for variable-
    // priced models (Claygent, GPT, etc.) this is a snapshot tied to the
    // field's history, not the current workspace-scaled price. Letting it
    // override produces a chip ("~12 / row") that disagrees with the chip
    // the canvas's own model dropdown shows for the same model ("~6.8 /
    // row"). We still honor the unlimited / isPrivateKey flags from
    // stats.cost because those are per-field signals the model lookup
    // can't infer (an AI field configured against a custom auth account
    // that brings its own key bills 0 regardless of the model's list price).
    if (stats?.cost) {
      if (stats.cost.unlimited || stats.cost.isPrivateKey) {
        credits = 0;
      } else if (!ai) {
        // On modern plans, substitute the plan-correct catalog base for
        // /context's legacy-priced cost while keeping its resolution flags
        // (costBy / maxResultsPerRow). On legacy plans, /context's cost is
        // already correct (and richer — it includes per-action toggle/override
        // deltas), so we pass no override.
        const baseOverride = importPlanIsModern() ? planAwareBaseCredits(info) : null;
        const resolved = resolveEffectiveCredits(stats.cost, credits, baseOverride);
        if (resolved != null) credits = resolved;
      }
    }

    // Private-key state: prefer the server signal (stats.cost.isPrivateKey)
    // because it reflects the field's actual authAccountId resolution. Falls
    // back to the catalog "requiresApiKey + no shared cost" heuristic.
    const usePrivateKey = stats?.cost?.isPrivateKey
      ? true
      : (requiresApiKey && credits == null);

    let iconUrl = info?.iconUrl ?? null;
    if (ai && selectedModel) {
      const model = modelOptions?.find((m) => m.id === selectedModel);
      if (model?.provider && __cb.AI_PROVIDER_ICONS?.[model.provider]) {
        iconUrl = __cb.AI_PROVIDER_ICONS[model.provider];
      }
    }

    return {
      actionKey: actionKey ?? (displayName || "field").toLowerCase().replace(/[^a-z0-9]+/g, "_"),
      packageId: packageId ?? "clay",
      // Prefer the column name (field.name) over the catalog action name for
      // every enrichment — that's the label the user gave the column and what
      // they see in Clay. It also fixes generic actions like "Run function"
      // (execute-subroutine), whose catalog displayName masked the real column
      // name. Falls back to the catalog name, then a generic label.
      displayName: ai ? (displayName || info?.displayName || "Use AI") : (displayName || info?.displayName || "Enrichment"),
      packageName: info?.packageName ?? "Clay",
      credits,
      // Default to 0, NOT 1 — read / lookup / source actions
      // intentionally omit `pricing.credits.actionExecution` and bill 0
      // actions per row server-side (calculateActionExecutionCost in
      // apps/api uses `?? 0` for the same reason). The previous `?? 1`
      // default overcounted every Salesforce / Pardot lookup + every
      // records-* source action in the canvas's "Total Actions" / "Avg
      // Actions / Row" headlines. Plan-aware: legacy plans have no
      // actionExecution dimension, so this resolves to 0 there.
      actionExecutions: planAwareActionExecutions(info),
      iconUrl,
      iconSvgHtml: null,
      creditText:
        credits != null
          ? `${ai ? __cb.aiTilde(selectedModel) : "~"}${credits} / row`
          : null,
      badges: [],
      isAi: ai,
      // Marks source-type enrichments (vs actions) so the table view can color
      // their chip distinctly. Persists with the card.
      isSource: field?.type === "source",
      // Projected coverage: how many rows this enrichment runs on. Defaults to
      // the table's total rows; editable in the table view (Coverage column) and
      // drives projected cost (credits/row x coverage). One ER -> many DPs all
      // share this single value. coverageCustom tracks a manual override so a
      // later Records change only re-defaults un-edited enrichments.
      coverageRows: Number(__cb.recordsActual) > 0 ? Number(__cb.recordsActual) : null,
      coverageCustom: false,
      modelOptions,
      selectedModel,
      requiresApiKey,
      usePrivateKey,
      fieldId: fieldId ?? field?.id,
      tableId: tableId ?? null,
      viewId: viewId ?? null,
      // Subroutine ("Run function") fields reference a "main function" table.
      // Carried so fetchSubroutineCostsInBackground can resolve the projected
      // cost (sum of that table's per-field credit costs — what Clay shows in
      // the Edit-column panel) and stamp it onto data.credits. Persists with
      // the card, so a reload keeps the resolved cost.
      referencedTableId: field?.typeSettings?.referencedTableId ?? null,
      stats: stats || null,
      groupCluster: groupCluster || null,
    };
  }

  function mapFieldToCardData(field, statsByFieldId, tableId, viewId) {
    const ts = field.typeSettings ?? {};
    const cardData = buildErCardData({
      field,
      actionKey: ts.actionKey,
      packageId: ts.actionPackageId ?? "clay",
      displayName: field.name,
      stats: statsByFieldId?.get(field.id) ?? null,
      fieldId: field.id,
      tableId,
      viewId,
    });
    // ER cards (standalone + basic-group) carry the same source-table tags as
    // DP/input cards so the table view can bucket every card by tableId.
    cardData.tableName = currentImportTags.tableName;
    cardData.importColor = currentImportTags.importColor;
    return cardData;
  }

  function getExistingCardKeys() {
    if (!__cb.canvas) return new Set();
    const state = __cb.model.serialize();
    const keys = new Set();
    for (const c of state.cards || []) {
      if (c.data.type === "dp" && c.data.fieldId) {
        keys.add(`dp-${c.data.fieldId}`);
      } else if (c.data.type === "input" && c.data.fieldId) {
        keys.add(`input-${c.data.fieldId}`);
      } else if (c.data.type === "waterfall") {
        // Composite waterfall card. The groupCluster carries the original
        // table fieldGroupId — same key the import side uses to dedupe a
        // re-imported waterfall against an already-placed one. Also stamp
        // the embedded provider fieldIds so a later standalone ER pass
        // doesn't re-place a step as its own card.
        if (c.data.groupCluster) keys.add(`wf-${c.data.groupCluster}`);
        for (const p of c.data.providers || []) {
          if (p?.fieldId) keys.add(`field-${p.fieldId}`);
        }
      } else if (c.data.isAi && c.data.fieldId) {
        keys.add(`ai-${c.data.fieldId}`);
      } else if (c.data.fieldId) {
        // Action field (standalone ER) — dedupe by fieldId so re-importing
        // the same table doesn't double-stamp the same step.
        keys.add(`field-${c.data.fieldId}`);
      } else if (c.data.waterfallGroupId) {
        keys.add(`wf-${c.data.waterfallGroupId}`);
      } else {
        keys.add(`${c.data.packageId}-${c.data.actionKey}`);
      }
    }
    return keys;
  }

  const CARD_W = 220;
  // Card height in Pro Mode (which import auto-enables). Mirrors the
  // .cb-overlay[data-cb-pro-mode] .cb-card { height: 96px } CSS rule.
  // 96 keeps the badges snug against the card's bottom padding (same gap
  // as the non-Pro 2-line cards) while still giving each card 3 rows of
  // content. Snap-cluster adjacency (snap.js hasFullSideMatch) requires
  // CARD_H to match the actual rendered height, so changing one without
  // the other silently breaks magneting between cards in a cluster.
  const CARD_H = 96;

  // Per-table presentation color cycle for the table view. These ids match
  // the canvas GROUP_COLOR_OPTIONS palette (src/canvas/groups.js); the actual
  // colors are applied by table-view CSS keyed on data-group-color.
  const IMPORT_COLOR_CYCLE = ["violet", "teal", "blue", "amber", "rose"];

  // Picks the import color for `tableId`. Reuses the color already on this
  // table's cards (so a re-import — or the merge-field DP placed after the
  // first card — keeps the same color, and it survives a reload because we
  // read from the live cards), otherwise assigns the next color in the cycle
  // by the count of distinct already-imported tables.
  function pickImportColorForTable(tableId) {
    if (!__cb.canvas || !tableId) return IMPORT_COLOR_CYCLE[0];
    const colorByTable = new Map();
    for (const c of __cb.canvas.getCards()) {
      const tid = c.data?.tableId;
      const col = c.data?.importColor;
      if (tid && col && !colorByTable.has(tid)) colorByTable.set(tid, col);
    }
    if (colorByTable.has(tableId)) return colorByTable.get(tableId);
    return IMPORT_COLOR_CYCLE[colorByTable.size % IMPORT_COLOR_CYCLE.length];
  }

  // Source-table presentation tags for the current import. Set at the top of
  // importTableToCanvas so the card-add helpers below can stamp tableName +
  // importColor without threading two more params through every signature.
  // importTableToCanvas runs awaited-sequentially per table, so there's no
  // interleaving concern across a multi-table import.
  let currentImportTags = { tableName: null, importColor: null };

  // `sourceEnrichmentKeys` may be a single key (string) or a curated array
  // (primary first + any rescued astray ancestors — see the astray-rescue pass
  // in buildImportDecisionSet). index 0 = the DP's nearest billable ancestor;
  // any extra keys are upstream ERs that would otherwise be stranded, so they
  // ride along as AND/sum links (each runs to produce the DP -> share 100%).
  function addDpCard(field, x, y, stats, groupCluster, tableId, viewId, sourceEnrichmentKeys) {
    const card = __cb.canvas.addDataPointCard(field.name, {
      x,
      y,
      stats: stats || null,
      groupCluster: groupCluster || null,
      fieldId: field.id,
      tableId: tableId ?? null,
      viewId: viewId ?? null,
      tableName: currentImportTags.tableName,
      importColor: currentImportTags.importColor,
    });
    if (card) {
      const keys = Array.isArray(sourceEnrichmentKeys)
        ? sourceEnrichmentKeys.filter((k) => k != null)
        : (sourceEnrichmentKeys != null ? [sourceEnrichmentKeys] : []);
      if (keys.length > 0) {
        // Leave run-shares UNSET — most rescued multi-ER DPs are fallback merges
        // (try-first/try-second), so the table's defaults are the right read:
        // projected = primary-weighted split (sums to ~100%, one runs per row),
        // actual = each ER's MEASURED run-share (cellCount / widest). Forcing
        // every share to 100% would overstate a fallback. Users can switch a
        // genuine AND/chain to sum via the chip's "+".
        __cb.setDpErKeys(card, keys);
      }
    }
    return card;
  }

  function addInputCardFromField(field, x, y, tableId, viewId) {
    return __cb.canvas.addInputCard(field.name, {
      x,
      y,
      fieldId: field.id,
      tableId: tableId ?? null,
      viewId: viewId ?? null,
      tableName: currentImportTags.tableName,
      importColor: currentImportTags.importColor,
    });
  }

  // ---------------------------------------------------------------------------
  // Loading status banner — replaces the previous "click → silent wait" gap.
  // After the user picks a table, we close the picker and drop a small banner
  // anchored under the import button so they know the four stat fetches are
  // running. closeImportStatus() is called on success or failure.
  // ---------------------------------------------------------------------------
  function showImportStatus(text, anchorEl) {
    closeImportStatus();
    importStatusEl = document.createElement("div");
    importStatusEl.className = "cb-import-status";
    importStatusEl.textContent = text;
    document.body.appendChild(importStatusEl);
    if (anchorEl) {
      const rect = anchorEl.getBoundingClientRect();
      importStatusEl.style.top = (rect.bottom + 4) + "px";
      importStatusEl.style.left = rect.left + "px";
    }
  }

  function closeImportStatus() {
    if (importStatusEl) {
      importStatusEl.remove();
      importStatusEl = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Records prefill — pushes the table's record count into the summary input
  // and dispatches an `input` event so all the dependent recalc paths
  // (default fill rates, total credits) re-run as if the user typed it.
  //
  // With the import's 2-leg fan-out we no longer fetch /views/:id/count, so
  // the denominator comes from the /context (full) response instead. We
  // prefer `tableRunInfo.tableRowCount` (the canonical whole-table count)
  // and fall back to any field's `dataProfile.totalRecords` because every
  // field in the response carries the same totalRecords.
  // ---------------------------------------------------------------------------
  function prefillRecordsCount(context) {
    const fromRunInfo = context?.tableRunInfo?.tableRowCount;
    const firstProfile = context?.fieldConfigurationsData?.fieldConfigs?.find(
      (fc) => fc?.dataProfile?.totalRecords != null,
    );
    const fromProfile = firstProfile?.dataProfile?.totalRecords;
    const total = typeof fromRunInfo === "number" && fromRunInfo > 0
      ? fromRunInfo
      : (typeof fromProfile === "number" && fromProfile > 0 ? fromProfile : null);
    if (total == null) return null;
    const input = document.getElementById("cb-records-input");
    if (!input) return total;
    // Remember the imported count as the "actual" (POC) number. Set it BEFORE
    // dispatching so overlay.js's input handler styles the box as indigo
    // (value === actual) rather than as an override.
    __cb.recordsActual = total;
    input.value = total.toLocaleString();
    input.dispatchEvent(new Event("input"));
    return total;
  }

  // ---------------------------------------------------------------------------
  // Pure compute phase shared by importTableToCanvas and the JSON export
  // modal's "Import" option. Takes a `table` (from /v3/workbooks/.../tables),
  // an optional `viewId`, the `/context` (full preset) response and the
  // /realtime-credit-usage column spend response; returns the entire
  // decision set the import flow needs before stamping cards:
  //
  //   - visibleFieldIds   : ids visible in the picked view
  //   - groupedFieldIds   : per-bucket sets of fields consumed by groups
  //   - inputs            : leaf-input classification (the rule that
  //                         replaced the legacy red/green view-color hint)
  //   - waterfalls        : per-group { steps[], mergeFieldId, attributeEnum }
  //   - basicGroups       : per-group { dpFields[], erFields[] }
  //   - standaloneFields  : action fields not inside any group
  //   - joined            : the per-fieldId stats Map (from buildStatsByFieldId)
  //
  // The returned object is JSON-safe (Sets serialized to arrays, Maps to
  // plain objects, field objects trimmed to the few props the canvas
  // actually reads). The live Set/Map/full-field-object versions the
  // import flow uses internally are stashed on a non-enumerable Symbol
  // slot so importTableToCanvas can pull them out without re-walking the
  // table — and so JSON.stringify silently drops them when the export
  // modal serializes the payload (Symbol-keyed properties are ignored by
  // the default stringifier).
  // ---------------------------------------------------------------------------
  const IMPORT_DECISION_INTERNAL = Symbol("cb.importDecisionInternal");

  function buildImportDecisionSet({ table, viewId, context, spend, ignoreViewVisibility = false }) {
    const fieldGroupMap = table?.fieldGroupMap ?? {};
    const fieldById = {};
    for (const f of table?.fields ?? []) fieldById[f.id] = f;

    const resolvedViewId = viewId || table?.firstViewId || null;
    const defaultView = (table?.views ?? []).find((v) => v.id === resolvedViewId) ?? table?.views?.[0];
    const viewFields = defaultView?.fields ?? {};

    // Full-table mode (ignoreViewVisibility): the import bypasses the
    // active view's hidden/visible flags and treats every field on the
    // table as visible. Card stamping still uses `resolvedViewId` so
    // right-click → "Open in table" lands on the default view, where
    // hidden columns at least have a chance of being visible. Coverage
    // and record-count denominators are already whole-table regardless
    // of this flag (see the comment on importTableToCanvas).
    const visibleFieldIds = ignoreViewVisibility
      ? new Set((table?.fields ?? []).map((f) => f.id))
      : new Set(
          Object.entries(viewFields)
            .filter(([, settings]) => settings.isVisible !== false)
            .map(([id]) => id)
        );

    // Per-field stats (coverage / fill / cost). Built early so we can tell a
    // billable enrichment from a free one before the ER buckets + lineage run.
    const statsByFieldId = buildStatsByFieldId({
      fields: table?.fields ?? [],
      context,
      spend,
    });

    // A column counts as a billable enrichment if it has any cost: a positive
    // /context credit cost (not zeroed by private-key / unlimited), a positive
    // catalog base-credit or action-execution, it's a subroutine (cost resolved
    // in the background), or it's an AI action (model credits). Free columns —
    // free CSV sources, "Send table data" / write-to-cell, and other 0-credit
    // 0-action actions — are NOT imported as enrichments and don't link as a
    // data point's source.
    function fieldIsBillable(f) {
      if (!f) return false;
      const ts = f.typeSettings || {};
      // Subroutines are billable (cost resolved in the background). Scope to the
      // subroutine actionKey — other actions (e.g. route-row / "Send table data")
      // also carry a referencedTableId (their write target) but are free.
      if (ts.actionKey === "execute-subroutine") return true;
      if (__cb.isAiAction?.(ts.actionKey, f.name, ts.actionPackageId)) return true;
      const sc = statsByFieldId.get(f.id)?.cost;
      if (sc && !sc.unlimited && !sc.isPrivateKey && Number(sc.cost) > 0) return true;
      const info = __cb.actionByIdLookup?.[`${ts.actionPackageId}-${ts.actionKey}`];
      if (info) {
        if ((planAwareBaseCredits(info) || 0) > 0) return true;
        if ((planAwareActionExecutions(info) || 0) > 0) return true;
      }
      return false;
    }

    // Group buckets — same logic that used to live inline in
    // importTableToCanvas. Each set is a single-purpose index so the
    // downstream filters stay O(1) per field.
    //
    // Per-waterfall: track which groups are "visible in this view" so
    // the waterfall enumeration below can include their steps even when
    // the individual step fields are hidden by the view config. In
    // Clay's typical setup the waterfall renders as a single visual
    // column whose merge field is the only entry in viewFields — the
    // step fields don't appear there at all (or appear with
    // isVisible:false), so a per-step visibleFieldIds check would drop
    // the entire waterfall. Treating the merge / validation / any step
    // field as a proxy for "the waterfall column is visible" matches
    // user intuition ("if I see the waterfall in the grid, import it").
    const waterfallFieldIds = new Set();
    const waterfallMergeFieldIds = new Set();
    const waterfallValidationFieldIds = new Set();
    const visibleWaterfallGroupIds = new Set();
    for (const [groupId, group] of Object.entries(fieldGroupMap)) {
      if (group.type === "waterfall") {
        let groupVisible = false;
        for (const step of group.groupDetails?.sequenceSteps ?? []) {
          waterfallFieldIds.add(step.fieldId);
          if (visibleFieldIds.has(step.fieldId)) groupVisible = true;
          if (step.validation?.fieldId) {
            waterfallValidationFieldIds.add(step.validation.fieldId);
            if (visibleFieldIds.has(step.validation.fieldId)) groupVisible = true;
          }
        }
        const mergeId = group.groupDetails?.mergeField?.fieldId;
        if (mergeId) {
          waterfallMergeFieldIds.add(mergeId);
          if (visibleFieldIds.has(mergeId)) groupVisible = true;
        }
        if (groupVisible) visibleWaterfallGroupIds.add(groupId);
      }
    }

    const basicGroupFieldIds = new Set();
    for (const group of Object.values(fieldGroupMap)) {
      if (group.type === "basic") {
        for (const f of group.groupDetails?.fields ?? []) {
          basicGroupFieldIds.add(f.id);
        }
      }
    }

    const groupedFieldIds = new Set([
      ...waterfallFieldIds,
      ...waterfallValidationFieldIds,
      ...waterfallMergeFieldIds,
      ...basicGroupFieldIds,
    ]);

    // Leaf-input rule (replaces the v3.8 red-color hint): a field qualifies
    // as an Input iff it's basic, visible, non-formula, referenced by some
    // action's inputsBinding, not itself an action's output, and not
    // already consumed by a group.
    const allInputRefs = new Set();
    const actionOutputIds = new Set();
    for (const f of table?.fields ?? []) {
      if (f.type === "action") actionOutputIds.add(f.id);
      const bindings = f.typeSettings?.inputsBinding;
      if (bindings) {
        for (const id of extractInputFieldRefs(bindings)) allInputRefs.add(id);
      }
    }

    // "basic" field = NOT an action or source. The /v3/workbooks/.../tables
    // serializer reports a basic field's DATA type (text / formula / boolean /
    // date / ...), never the literal "basic", so we detect it by exclusion.
    const isBasicField = (f) => f.type !== "action" && f.type !== "source";

    const leafInputFields = (table?.fields ?? []).filter(
      (f) =>
        visibleFieldIds.has(f.id) &&
        isBasicField(f) &&
        !f.typeSettings?.formula &&
        !f.typeSettings?.formulaText &&
        !f.typeSettings?.formulaType &&
        allInputRefs.has(f.id) &&
        !actionOutputIds.has(f.id) &&
        !groupedFieldIds.has(f.id)
    );
    const leafInputFieldIds = new Set(leafInputFields.map((f) => f.id));

    const standaloneFields = (table?.fields ?? []).filter(
      (f) =>
        visibleFieldIds.has(f.id) &&
        !groupedFieldIds.has(f.id) &&
        !leafInputFieldIds.has(f.id) &&
        (f.type === "action" || f.type === "source") &&
        fieldIsBillable(f)
    );

    // Waterfall enumeration — see visibleWaterfallGroupIds above for why
    // step-level visibility is intentionally NOT applied here. A
    // waterfall whose merge / validation / any step field is visible is
    // included with ALL its action steps; only fully-invisible
    // waterfalls (every constituent field hidden) get dropped.
    const waterfalls = Object.entries(fieldGroupMap)
      .filter(([groupId, g]) => g.type === "waterfall" && visibleWaterfallGroupIds.has(groupId))
      .map(([groupId, g]) => ({
        groupId,
        name: g.name ?? "",
        attributeEnum: g.settings?.attribute ?? null,
        steps: (g.groupDetails?.sequenceSteps ?? []).filter(
          (s) => s.type === "action" && s.actionKey
        ),
        mergeFieldId: g.groupDetails?.mergeField?.fieldId ?? null,
      }));

    const basicGroups = Object.entries(fieldGroupMap)
      .filter(([, g]) => g.type === "basic")
      .map(([groupId, g]) => {
        const members = g.groupDetails?.fields ?? [];
        const dpFields = [];
        const erFields = [];
        for (const member of members) {
          const field = fieldById[member.id];
          if (!field) continue;
          if (!visibleFieldIds.has(field.id)) continue;
          if (leafInputFieldIds.has(field.id)) continue;
          // Actions AND sources are enrichments (both can be paid); everything
          // else in the group is a data point. Free (0-credit/0-action)
          // enrichments are skipped entirely — neither ER nor DP.
          if (field.type === "action" || field.type === "source") {
            if (fieldIsBillable(field)) erFields.push(field);
          } else {
            dpFields.push(field);
          }
        }
        return { groupId, name: g.name ?? "", dpFields, erFields };
      })
      .filter((g) => g.dpFields.length > 0 || g.erFields.length > 0);

    // -------------------------------------------------------------------------
    // Lineage resolution (Phase 1) — map each visible data-point column to the
    // enrichment it was extracted from, the same way Clay's "Show extracted
    // fields" graph does (server getExtractedFieldMap). This is the source of
    // truth for DP<->ER matching: the table view reads `sourceEnrichmentFieldId`
    // off each DP card directly instead of deriving from canvas clusters.
    //
    // Enrichment key:
    //   - waterfall step / merge / validation field -> "wf:<groupId>" (the
    //     single waterfall card)
    //   - any other action field -> its own field id (standalone / basic-group ER)
    //   - basic extracted field -> resolved to its parent enrichment
    //   - source field / unmatched -> null (no enrichment, no shared cost)
    // -------------------------------------------------------------------------
    const waterfallGroupByFieldId = new Map();
    for (const [groupId, group] of Object.entries(fieldGroupMap)) {
      if (group.type !== "waterfall") continue;
      for (const step of group.groupDetails?.sequenceSteps ?? []) {
        if (step.fieldId) waterfallGroupByFieldId.set(step.fieldId, groupId);
        if (step.validation?.fieldId) waterfallGroupByFieldId.set(step.validation.fieldId, groupId);
      }
      const mergeId = group.groupDetails?.mergeField?.fieldId;
      if (mergeId) waterfallGroupByFieldId.set(mergeId, groupId);
    }

    // {{fieldId}} references in a formula — the extracted column's parent(s).
    // A plain extracted column has one; a MERGE column (special formula, e.g.
    // "try Validate Input Domain first, then Validate Claygent Domain") coalesces
    // SEVERAL, so we parse them all so the merge DP links to every ER it merges.
    const FORMULA_PARENT_RE = /\{\{\s*([a-zA-Z0-9_-]+)\s*\}\}/g;
    function parseFormulaParents(formulaText) {
      const ids = [];
      if (typeof formulaText !== "string") return ids;
      let m;
      FORMULA_PARENT_RE.lastIndex = 0;
      while ((m = FORMULA_PARENT_RE.exec(formulaText)) !== null) {
        if (m[1]) ids.push(m[1]);
      }
      return ids;
    }

    // Resolve ALL billable enrichment ancestors of a column, nearest-first. A
    // data point can derive from a chain: e.g. "final email" (basic) is
    // extracted from a cheap AI column whose INPUT was an expensive enrichment.
    // We record the nearest billable ancestor (the AI column = primary) AND keep
    // walking through that action's inputs to capture the upstream ER too, so
    // both are linked + costed. Free (0-credit/0-action) ancestors are skipped
    // (noise reduction — formatting helpers etc. don't matter for scoping).
    function resolveEnrichmentKeys(fieldId) {
      const out = [];
      const seenKeys = new Set();
      const visited = new Set();
      const addKey = (k) => {
        if (k != null && !seenKeys.has(k)) { seenKeys.add(k); out.push(k); }
      };
      function walk(fid) {
        if (!fid || visited.has(fid)) return;
        visited.add(fid);
        const wfGroup = waterfallGroupByFieldId.get(fid);
        if (wfGroup) { addKey(`wf:${wfGroup}`); return; }
        const field = fieldById[fid];
        if (!field) return;
        if (field.type === "action" || field.type === "source") {
          if (fieldIsBillable(field)) addKey(fid);
          // Continue through this action's inputs to reach upstream ancestors
          // (the expensive ER feeding a cheap AI column). A free action still
          // forwards its inputs so a billable ancestor behind it is captured.
          const refs = field.typeSettings?.inputsBinding
            ? extractInputFieldRefs(field.typeSettings.inputsBinding)
            : null;
          if (refs) for (const r of refs) walk(r);
          if (Array.isArray(field.inputFieldIds)) for (const r of field.inputFieldIds) walk(r);
          return;
        }
        // basic / formula column: walk to EVERY field it derives from. A merge
        // column references multiple sources (try-first / try-second fallback),
        // so we follow all of them — not just the first — so each merged ER is
        // captured (then the astray-rescue attaches the non-primary ones).
        const parents = new Set();
        if (field.extractedField?.fieldIdExtractedFrom) {
          parents.add(field.extractedField.fieldIdExtractedFrom);
        }
        if (Array.isArray(field.inputFieldIds)) {
          for (const id of field.inputFieldIds) parents.add(id);
        }
        for (const id of parseFormulaParents(field.typeSettings?.formulaText)) parents.add(id);
        if (field.typeSettings?.inputsBinding) {
          for (const id of extractInputFieldRefs(field.typeSettings.inputsBinding)) parents.add(id);
        }
        for (const id of parents) walk(id);
      }
      walk(fieldId);
      return out;
    }

    // Every visible basic data point that resolves to an enrichment (excludes
    // leaf inputs). dpEnrichmentKeyById is the per-DP lineage link the import
    // stamps onto cards; dataPointFields is the full set to import.
    // chainKeysById maps each DP field id -> its FULL transitive billable
    // ancestor chain (nearest/primary first). Used for promotion + the
    // astray-rescue pass; the final per-DP link set (dpEnrichmentKeyById) is
    // derived from it further below.
    const chainKeysById = new Map();
    const dataPointFields = [];
    for (const f of table?.fields ?? []) {
      if (!visibleFieldIds.has(f.id)) continue;
      // Data points are basic columns (formula / text / boolean / date / ...),
      // not actions or sources — see isBasicField above.
      if (!isBasicField(f)) continue;
      if (leafInputFieldIds.has(f.id)) continue;
      const keys = resolveEnrichmentKeys(f.id);
      if (!keys.length) continue;
      chainKeysById.set(f.id, keys);
      dataPointFields.push(f);
    }

    // Promotion: an enrichment a visible data point was extracted from MUST be
    // imported even if its own column is hidden in the view — otherwise the DP
    // renders "Not connected" and its cost silently vanishes. Collect the
    // required enrichment field ids (action or source) that the visible buckets
    // above didn't already cover, and import them too. Waterfall keys (wf:<gid>)
    // are handled by visibleWaterfallGroupIds and skipped here.
    const importedErIds = new Set([
      ...standaloneFields.map((f) => f.id),
      ...basicGroups.flatMap((g) => g.erFields.map((f) => f.id)),
    ]);
    // Promote EVERY billable ancestor (primary + upstream chain) a visible DP
    // references, not just the nearest one — otherwise the expensive upstream
    // ER renders "Not connected" and its cost silently vanishes.
    const promotedErFields = [];
    const promotedSeen = new Set();
    for (const keys of chainKeysById.values()) {
      for (const key of keys) {
        if (!key || typeof key !== "string" || key.startsWith("wf:")) continue;
        if (importedErIds.has(key) || promotedSeen.has(key)) continue;
        const f = fieldById[key];
        if (!f || (f.type !== "action" && f.type !== "source")) continue;
        if (!fieldIsBillable(f)) continue;
        promotedSeen.add(key);
        promotedErFields.push(f);
      }
    }

    // ---- Astray-ER rescue -----------------------------------------------------
    // Each DP links to its NEAREST billable ancestor only (chain[0]) — auto-
    // linking the whole transitive chain over-links interconnected tables. An
    // imported enrichment that NO DP claims as its nearest is "astray" (it would
    // render as an orphan row). Re-attach each astray ER to its NEAREST
    // DOWNSTREAM data point(s) — a forward walk through consumers that stops at
    // the first DP layer — so e.g. a merge column ("try Validate Input Domain,
    // then Validate Claygent Domain") picks up every validation ER it merges,
    // while a validation ER reused deep in the graph attaches only to the column
    // that directly merges it, not to every transitive descendant. A truly
    // standalone ER (no downstream DP) legitimately stays its own row.
    const importedErKeys = new Set();
    for (const w of waterfalls) importedErKeys.add(`wf:${w.groupId}`);
    for (const f of standaloneFields) importedErKeys.add(f.id);
    for (const g of basicGroups) for (const f of g.erFields) importedErKeys.add(f.id);
    for (const f of promotedErFields) importedErKeys.add(f.id);

    const nearestKeys = new Set();
    for (const chain of chainKeysById.values()) {
      if (chain[0] != null) nearestKeys.add(chain[0]);
    }
    const astrayKeys = [...importedErKeys].filter((k) => !nearestKeys.has(k));

    // Forward consumer index: field id -> fields that DIRECTLY reference it.
    function directRefsOf(field) {
      const refs = new Set();
      if (!field) return refs;
      if (field.extractedField?.fieldIdExtractedFrom) refs.add(field.extractedField.fieldIdExtractedFrom);
      if (Array.isArray(field.inputFieldIds)) for (const id of field.inputFieldIds) refs.add(id);
      for (const id of parseFormulaParents(field.typeSettings?.formulaText)) refs.add(id);
      if (field.typeSettings?.inputsBinding) {
        for (const id of extractInputFieldRefs(field.typeSettings.inputsBinding)) refs.add(id);
      }
      return refs;
    }
    const consumersByRef = new Map();
    for (const f of table?.fields ?? []) {
      for (const r of directRefsOf(f)) {
        if (!consumersByRef.has(r)) consumersByRef.set(r, new Set());
        consumersByRef.get(r).add(f.id);
      }
    }
    const dpFieldIdSet = new Set(dataPointFields.map((f) => f.id));

    // The field ids a key points at (a waterfall key spans its step/merge fields).
    function sourceFieldIdsForKey(key) {
      if (typeof key === "string" && key.startsWith("wf:")) {
        const g = fieldGroupMap[key.slice(3)];
        const ids = [];
        const mid = g?.groupDetails?.mergeField?.fieldId;
        if (mid) ids.push(mid);
        for (const s of g?.groupDetails?.sequenceSteps ?? []) if (s.fieldId) ids.push(s.fieldId);
        return ids;
      }
      return [key];
    }

    // BFS forward to the first DP layer.
    function nearestDownstreamDps(key) {
      const targets = new Set();
      const seen = new Set();
      const queue = sourceFieldIdsForKey(key);
      for (const s of queue) seen.add(s);
      while (queue.length) {
        const cur = queue.shift();
        const consumers = consumersByRef.get(cur);
        if (!consumers) continue;
        for (const c of consumers) {
          if (seen.has(c)) continue;
          seen.add(c);
          if (dpFieldIdSet.has(c)) targets.add(c); // first DP on this path — stop
          else queue.push(c);
        }
      }
      return targets;
    }

    const attachByDp = new Map();
    for (const key of astrayKeys) {
      for (const dpId of nearestDownstreamDps(key)) {
        if (!attachByDp.has(dpId)) attachByDp.set(dpId, []);
        attachByDp.get(dpId).push(key);
      }
    }

    // Final per-DP link set: nearest ancestor + any astray ER whose nearest
    // downstream DP is this one. dpEnrichmentKeyById is the source of truth the
    // card stamping + public shape both read.
    const dpEnrichmentKeyById = new Map();
    for (const [fid, chain] of chainKeysById) {
      const nearest = chain[0];
      const extra = (attachByDp.get(fid) || []).filter((k) => k !== nearest);
      dpEnrichmentKeyById.set(fid, [...new Set([nearest, ...extra])]);
    }

    // ---- JSON-safe public shape ----
    //
    // Field objects from /v3/workbooks/.../tables are big (settings,
    // typeSettings, abilities, etc.) — for export we only need enough to
    // identify each field. Trim aggressively to keep the payload digestible.
    const trimField = (f) => {
      const out = { id: f.id, name: f.name, type: f.type };
      if (f.typeSettings?.actionKey) out.actionKey = f.typeSettings.actionKey;
      if (f.typeSettings?.actionPackageId) out.actionPackageId = f.typeSettings.actionPackageId;
      return out;
    };

    const publicShape = {
      context,
      spend,
      view: {
        viewId: resolvedViewId,
        viewName: defaultView?.name ?? null,
      },
      visibleFieldIds: Array.from(visibleFieldIds),
      inputs: {
        allInputRefs: Array.from(allInputRefs),
        actionOutputIds: Array.from(actionOutputIds),
        leafInputFieldIds: Array.from(leafInputFieldIds),
        leafInputFields: leafInputFields.map(trimField),
      },
      groupedFieldIds: {
        waterfall: Array.from(waterfallFieldIds),
        waterfallValidation: Array.from(waterfallValidationFieldIds),
        waterfallMerge: Array.from(waterfallMergeFieldIds),
        basicGroup: Array.from(basicGroupFieldIds),
        all: Array.from(groupedFieldIds),
      },
      waterfalls: waterfalls.map((w) => ({
        groupId: w.groupId,
        name: w.name,
        attributeEnum: w.attributeEnum,
        mergeFieldId: w.mergeFieldId,
        steps: w.steps.map((s) => ({
          fieldId: s.fieldId,
          actionKey: s.actionKey,
          actionPackageId: s.actionPackageId,
          validation: s.validation
            ? {
                fieldId: s.validation.fieldId ?? null,
                actionKey: s.validation.actionKey ?? null,
                actionPackageId: s.validation.actionPackageId ?? null,
                authAccountId: s.validation.authAccountId ?? null,
              }
            : null,
        })),
      })),
      basicGroups: basicGroups.map((g) => ({
        groupId: g.groupId,
        name: g.name,
        dpFields: g.dpFields.map(trimField),
        erFields: g.erFields.map(trimField),
      })),
      standaloneFields: standaloneFields.map(trimField),
      // Enrichments rescued because a visible data point points at them even
      // though their own column is hidden.
      promotedErFields: promotedErFields.map(trimField),
      // Lineage: each visible data point + the enrichment(s) it derives from.
      // `sourceEnrichmentFieldIds` is the ordered ancestor chain (primary
      // first); `sourceEnrichmentFieldId` keeps the primary for back-compat.
      dataPoints: dataPointFields.map((f) => {
        const keys = dpEnrichmentKeyById.get(f.id) ?? [];
        return {
          id: f.id,
          name: f.name,
          sourceEnrichmentFieldId: keys[0] ?? null,
          sourceEnrichmentFieldIds: keys.slice(),
        };
      }),
      joined: Object.fromEntries(statsByFieldId),
    };

    // Stash live structures on a Symbol-keyed slot. JSON.stringify ignores
    // Symbol-keyed properties, so the export modal serializes only the
    // public shape; importTableToCanvas pulls these out via the symbol so
    // it doesn't have to rebuild Sets from arrays or re-resolve trimmed
    // field summaries back to full field objects.
    Object.defineProperty(publicShape, IMPORT_DECISION_INTERNAL, {
      value: {
        fieldById,
        viewFields,
        visibleFieldIds,
        groupedFieldIds,
        waterfallFieldIds,
        waterfallValidationFieldIds,
        waterfallMergeFieldIds,
        basicGroupFieldIds,
        allInputRefs,
        actionOutputIds,
        leafInputFieldIds,
        leafInputFields,
        waterfalls,
        basicGroups,
        standaloneFields,
        promotedErFields,
        statsByFieldId,
        dataPointFields,
        dpEnrichmentKeyById,
      },
      enumerable: false,
      writable: false,
      configurable: false,
    });

    return publicShape;
  }

  __cb.buildImportDecisionSet = buildImportDecisionSet;
  __cb.IMPORT_DECISION_INTERNAL = IMPORT_DECISION_INTERNAL;

  // ---------------------------------------------------------------------------
  // Main import entry point — turns a table response into a fully-populated
  // canvas. Async because we fan out two parallel HTTP calls (table context
  // at `full` detail level + column spend) before we start stamping cards;
  // both fetches are fail-soft so the import still produces structural cards
  // even if one or both stat sources are unavailable.
  //
  // Why just two calls (down from four):
  //   - /context with `contextDetailLevel: "full"` rolls in the per-field
  //     run-status counts (dataProfile.successCount/errorCount/...) and
  //     full-table profiling that the old `runStatus` and sculptor
  //     `context` legs used to provide separately.
  //   - The old `viewCount` leg was for view-filtered denominators; we now
  //     use the whole-table count from dataProfile.totalRecords. We
  //     accept this regression in exchange for one fewer round-trip and
  //     for dropping the up-to-7s `_pending` polling on runstatus.
  //   - `fetchColumnSpend` stays as its own leg because no /context preset
  //     surfaces actual Redshift-billed credit usage — only policy
  //     pricing.
  // ---------------------------------------------------------------------------
  async function importTableToCanvas(table, overrideViewId, anchorEl) {
    if (!__cb.canvas) return false;

    // Auto-enable Pro Mode on every successful import. Pro Mode surfaces
    // the coverage / fill-rate pills (otherwise hidden) and unhides the
    // Projected/Actual toggle in the topbar. The view-mode flip to
    // "actual" is deferred until after the spend fetch returns — we only
    // switch to Actual when there's actual Redshift-billed spend to show
    // (otherwise the summary boxes would display 0 / 0 since Actual mode
    // sums card.data.stats.spend, and Projected mode at least shows the
    // model-aware catalog credits).
    if (typeof __cb.setProMode === "function") __cb.setProMode(true);

    const ids = __cb.parseIdsFromUrl();
    const workspaceId = ids?.workspaceId;
    const tableId = table.id;

    // Source-table presentation tags for this import. Computed once here so
    // every card-add helper below stamps a consistent tableName + cycling
    // importColor (read off currentImportTags). pickImportColorForTable reads
    // the live canvas, so a re-import reuses the table's existing color and a
    // multi-table import advances the cycle as each table's cards land.
    currentImportTags = {
      tableName: table.name || "Untitled",
      importColor: pickImportColorForTable(tableId),
    };

    // fieldById is used by the rendering loops below to resolve waterfall
    // step / merge-field IDs back to full field objects (the decision set
    // helper trims its public field summaries). Keep it local to the
    // import flow.
    const fieldById = {};
    for (const f of table.fields ?? []) fieldById[f.id] = f;

    // Three-state convention for `overrideViewId`:
    //   - undefined    → fall back to table.firstViewId (default view)
    //   - <view.id>    → use that specific view's visibility map
    //   - null         → "Full table" — bypass view-visibility filtering
    //                    entirely (every field on the table is treated
    //                    as visible). We still pick firstViewId for card
    //                    stamping so deep-linking lands somewhere useful.
    const isFullTable = overrideViewId === null;
    const viewId = isFullTable
      ? (table.firstViewId ?? null)
      : (overrideViewId || table.firstViewId);

    showImportStatus(`Importing from ${table.name || "table"}\u2026`, anchorEl);

    // PROJECTED leg only — the fast /context (small sample) call. Actual
    // spend (GET /realtime-credit-usage) is fetched in the background AFTER
    // the projected rows land (see fetchSpendInBackground below), so the
    // import never blocks on it and the Actual toggle has data ready.
    let context = null;
    const spend = null;
    try {
      context = workspaceId
        ? await __cb.fetchTableContextForImport(workspaceId, tableId).catch(() => null)
        : null;
    } finally {
      closeImportStatus();
    }

    const tableRecordCount = prefillRecordsCount(context);

    // Record per-table metadata (source row count + import time + name +
    // color) in the canvas state so the table-view per-table header can show
    // "N rows · imported X ago" and so tableName/importColor survive reload
    // (the DP/input restore path doesn't carry those on the card).
    if (typeof __cb.canvas.setImportedTable === "function") {
      __cb.canvas.setImportedTable(tableId, {
        name: currentImportTags.tableName,
        importColor: currentImportTags.importColor,
        recordCount: tableRecordCount ?? null,
        importedAt: Date.now(),
      });
    }

    // Single source of truth for the compute phase — re-used by the JSON
    // export modal's Import option so users can preview / download exactly
    // what gets stamped onto the canvas. The Symbol slot exposes the live
    // Set/Map/full-field-object structures the rendering loops below
    // expect (avoids re-resolving from the JSON-safe public summary).
    const decisionSet = buildImportDecisionSet({
      table,
      viewId,
      context,
      spend,
      ignoreViewVisibility: isFullTable,
    });
    const internal = decisionSet[IMPORT_DECISION_INTERNAL];
    const visibleFieldIds = internal.visibleFieldIds;
    const groupedFieldIds = internal.groupedFieldIds;
    const leafInputFields = internal.leafInputFields;
    const leafInputFieldIds = internal.leafInputFieldIds;
    const standaloneFields = internal.standaloneFields;
    const promotedErFields = internal.promotedErFields ?? [];
    const waterfalls = internal.waterfalls;
    const basicGroups = internal.basicGroups;
    const statsByFieldId = internal.statsByFieldId;
    // Lineage (Phase 1): per-DP enrichment key + the full set of visible data
    // points to import. The table view matches/costs DPs by this key.
    const dpEnrichmentKeyById = internal.dpEnrichmentKeyById ?? new Map();
    const dataPointFields = internal.dataPointFields ?? [];

    const existingKeys = getExistingCardKeys();
    const CARD_H_GAP = 230;
    const CARD_V_GAP = 120;
    // Exactly one card height of offset so the comment's bottom edge sits
    // flush against the first member's top edge. The snap-cluster mechanism
    // in canvas/snap.js requires 0–1px adjacency (ADJACENCY_TOLERANCE) for
    // cards to be considered part of the same cluster — any gap larger than
    // that and the comment floats free, breaking the magnet effect.
    const COMMENT_OFFSET = CARD_H;
    const START_X = 80;
    const START_Y = 100;
    const COLS = 4;
    let importedAny = false;

    let currentY = START_Y;

    // -------------------------------------------------------------------------
    // Inputs (leaf basic fields referenced by some enrichment). Laid out as
    // a single horizontal row at the top — purely positional, no actual
    // links between them. The "chain" term refers to spatial layout, not
    // connections.
    // -------------------------------------------------------------------------
    const inputChain = [];
    for (const field of leafInputFields) {
      const inputKey = `input-${field.id}`;
      if (existingKeys.has(inputKey)) continue;
      existingKeys.add(inputKey);
      inputChain.push(field);
    }

    if (inputChain.length > 0) {
      let x = START_X;
      for (const field of inputChain) {
        addInputCardFromField(field, x, currentY, tableId, viewId);
        x += CARD_W;
      }
      currentY += CARD_V_GAP;
      importedAny = true;
    }

    // -------------------------------------------------------------------------
    // Waterfalls — collapsed into a single composite waterfall card per
    // attribute. Each provider step becomes an entry in the card's
    // providers[] array, with its own per-step stats (fillRate / spend)
    // attached so the popover can show real numbers per provider.
    //
    // Layout: waterfall card on the left, optional merge-field DP pinned
    // to its right, both magneted via the shared groupCluster (same as
    // the previous exploded layout — but only two cards now instead of
    // 1 + N + 1).
    // -------------------------------------------------------------------------
    for (const wf of waterfalls) {
      if (wf.steps.length === 0) continue;
      const wfKey = `wf-${wf.groupId}`;
      if (existingKeys.has(wfKey)) continue;
      existingKeys.add(wfKey);

      const baseX = START_X;
      const stepsY = currentY;

      // Build providers[] from each step. We resolve via actionByIdLookup
      // (same as buildErCardData would have done per-step) so providers
      // carry the catalog credits / icon / packageName, plus the per-step
      // stats map for the popover.
      //
      // We also mark every step's fieldId as consumed so existingKeys
      // dedup keeps preventing the same field from being placed as a
      // standalone ER card later in the import (basic-groups / standalone
      // sections both check `field-${id}` keys before placing).
      const providers = [];
      for (const step of wf.steps) {
        const fieldKey = `field-${step.fieldId}`;
        existingKeys.add(fieldKey);
        const lookupKey = `${step.actionPackageId ?? "clay"}-${step.actionKey}`;
        const info = __cb.actionByIdLookup?.[lookupKey] ?? {};
        const ai = info.isAi ?? __cb.isAiAction(step.actionKey, info.displayName, step.actionPackageId);
        const stepStats = statsByFieldId.get(step.fieldId) ?? null;
        // Per-step cost. For AI steps (Claygent inside a waterfall) we
        // resolve the live per-model credit the same way standalone AI
        // cards do — see buildErCardData's AI branch for the rationale.
        // The server's stats.cost.cost on a Claygent step is a snapshot of
        // the field's last computed cost and goes stale relative to the
        // workspace-scaled per-model price, so the chip ends up out of
        // sync with the canvas's own model dropdown. We still honor the
        // unlimited / isPrivateKey flags (per-step authAccountId →
        // private-key billing → 0 credits).
        const catalogCredits = planAwareBaseCredits(info);
        let stepCredits;
        if (ai) {
          const stepField = fieldById[step.fieldId];
          const modelOptions = __cb.getModelOptions?.() ?? info.modelOptions;
          const rawModel = __cb.readInputBindingValue?.(
            stepField?.typeSettings?.inputsBinding,
            "model"
          );
          let modelCredit = null;
          if (modelOptions && rawModel) {
            const matched = __cb.matchKnownModel?.(
              String(rawModel).replace(/^"|"$/g, "").trim(),
              modelOptions
            );
            if (matched && Number.isFinite(matched.credits)) modelCredit = matched.credits;
          }
          if (modelCredit == null) modelCredit = catalogCredits;
          if (stepStats?.cost?.unlimited || stepStats?.cost?.isPrivateKey) {
            stepCredits = 0;
          } else {
            stepCredits = modelCredit;
          }
        } else {
          const baseOverride = importPlanIsModern() ? catalogCredits : null;
          stepCredits = stepStats?.cost
            ? resolveEffectiveCredits(stepStats.cost, catalogCredits, baseOverride)
            : catalogCredits;
        }
        providers.push({
          actionKey: step.actionKey,
          packageId: step.actionPackageId ?? "clay",
          displayName: fieldById[step.fieldId]?.name || info.displayName || step.actionKey,
          packageName: info.packageName,
          iconUrl: info.iconUrl ?? null,
          credits: stepCredits,
          isAi: !!ai,
          // Same staleness fix as buildErCardData above — prefer the
          // live getModelOptions() so the popover dropdown shows
          // workspace-scaled variable-priced credits.
          modelOptions: ai ? (__cb.getModelOptions?.() ?? info.modelOptions) : null,
          requiresApiKey: !!info.requiresApiKey,
          // usePrivateKey on a provider is what deriveWaterfallTotals reads
          // to decide whether to add this step's `credits` to the per-row
          // average. Setting it from the server signal keeps the math
          // consistent with what Clay actually charges.
          usePrivateKey: !!stepStats?.cost?.isPrivateKey,
          stats: stepStats,
          fieldId: step.fieldId,
        });
      }

      // ---- Validation row pre-fill ----
      //
      // Clay attaches a validation column to each waterfall step (e.g.
      // ZeroBounce verifying every Apollo email). Without this pre-fill
      // those columns import as N standalone "Validate Email" cards; the
      // groupedFieldIds change above already suppresses those. Here we
      // reverse-engineer the user's validator choice from the first
      // step's `validation` block (Clay's pattern is one validator across
      // the whole waterfall) and seed the validation row in the popover
      // so it pre-selects the right provider with the right cost / key
      // mode.
      const firstValidation = wf.steps.find((s) => s.validation)?.validation ?? null;
      let validationName = null;
      let validationPrice = 0;
      let validationRequiresApiKey = false;
      let validationUsePrivateKey = false;
      let validationOptions = [];
      let validationProvider = null;

      if (firstValidation) {
        validationProvider = `${firstValidation.actionPackageId}/${firstValidation.actionKey}`;
        // authAccountId on the validation column means the user wired up
        // their own credentials there — treat it as private-key mode so
        // the validation cost contributes 0.
        validationUsePrivateKey = !!firstValidation.authAccountId;
        const entry = __cb.actionByIdLookup?.[validationProvider];
        if (entry) {
          const keyOnly = !!(entry.requiresApiKey || entry.disableSharedKey);
          validationName = entry.packageName || entry.displayName || null;
          // Prefer the validation field's own server-resolved cost when
          // available — for AI validators or per-result validators the
          // catalog default is wrong. Falls back to the catalog rule
          // (shared-key vs key-only) when the server didn't price it.
          const validationFieldId = firstValidation.fieldId;
          const validationStats = validationFieldId
            ? statsByFieldId.get(validationFieldId)
            : null;
          const catalogValidationPrice = keyOnly
            ? planAwarePrivateKeyCredits(entry)
            : (planAwareBaseCredits(entry) ?? 0);
          const validationBaseOverride = importPlanIsModern() ? catalogValidationPrice : null;
          const resolvedValidationPrice = validationStats?.cost
            ? resolveEffectiveCredits(validationStats.cost, catalogValidationPrice, validationBaseOverride)
            : catalogValidationPrice;
          validationPrice = resolvedValidationPrice ?? 0;
          validationRequiresApiKey = !!entry.requiresApiKey;
          // Key-only validators (Debounce / LeadMagic / Enrow / etc.):
          // auto-flip even when authAccountId is null on the column,
          // because the only valid invocation IS with a private key.
          if (keyOnly) validationUsePrivateKey = true;
          // Server-side signal also flips it to private-key when the
          // resolved appAccount isn't shared, so we don't undercharge
          // a private-key validator that wasn't keyOnly in the catalog.
          if (validationStats?.cost?.isPrivateKey) validationUsePrivateKey = true;
        }
      }

      // ---- Per-row action-executions ----
      //
      // Hardcoded to __cb.WATERFALL_ACTION_EXECUTIONS (3). Real billed run
      // data (sum of provider-step + per-step validation runs, over the rows
      // the waterfall actually ran on) shows email / phone waterfalls average
      // ~3 action-executions per row: the finder cascade runs ~1.5-1.7
      // providers per row and validation fires ~1.4-1.5x per row, both > 1.
      // The prior avg(per-step) + validation estimate assumed 1 finder + 1
      // validation = 2 and undercounted. See config.js WATERFALL_ACTION_EXECUTIONS.

      // Look up the curated swap-out list for this attribute so the
      // popover dropdown can offer alternatives. Mirrors the picker
      // path. Falls through silently when the attribute isn't in
      // __cb.waterfallByName (e.g. Clay added a new attribute we don't
      // know about yet) — the row still renders with the inferred
      // provider, just without alternative choices.
      if (wf.attributeEnum && __cb.waterfallByName) {
        const wfMeta = Object.values(__cb.waterfallByName).find(
          (w) => w.attributeEnum === wf.attributeEnum,
        );
        if (wfMeta && typeof __cb.getValidationInfoForAttribute === "function") {
          const v = __cb.getValidationInfoForAttribute(wfMeta);
          validationOptions = v.options;
          // If the imported provider isn't in the curated list (custom
          // validator or older attribute mapping), clear the selection
          // so the dropdown reads "No validation" rather than mis-
          // selecting. The price/name we already inferred still stands
          // and is honored by the cost math.
          if (validationProvider && !validationOptions.some((o) => o.actionId === validationProvider)) {
            validationProvider = null;
          }
        }
      }

      const wfData = __cb.buildWaterfallCardData({
        displayName: wf.name || "Waterfall",
        providers,
        attributeEnum: wf.attributeEnum,
        packageId: "clay",
        validationPrice,
        validationName,
        validationRequiresApiKey,
        validationUsePrivateKey,
        validationOptions,
        validationProvider,
        // Force-show the validation row whenever the imported table
        // configured a validator, even if validationOptions is empty
        // (attribute not in our curated map). Passing this at build
        // time (instead of mutating wfData after) ensures the initial
        // averageCost / credits include the validation surcharge — no
        // need for the user to toggle Remove / Add to "kick" the math.
        validationVisible: !!firstValidation,
        actionExecutions: __cb.WATERFALL_ACTION_EXECUTIONS,
        groupCluster: wf.groupId,
        // Anchor the card to the waterfall group so re-imports dedupe via
        // `wf-${groupId}` (set on existingKeys above) AND its own data
        // exposes both the field-equivalent linkage and the table linkage
        // to "Open in table" (Clay's grid jump-to-column wiring).
        fieldId: wf.steps[0]?.fieldId ?? null,
        tableId,
        viewId,
      });
      // Source-table tags so the waterfall card buckets with the rest of its
      // table in the table view (buildWaterfallCardData doesn't take these,
      // so stamp them on the returned data before addCard stores it raw).
      wfData.tableName = currentImportTags.tableName;
      wfData.importColor = currentImportTags.importColor;
      // Aggregate stats across the steps for the always-visible per-card
      // pills (Pro Mode coverage / fill rate). Average the numerators and
      // denominators across providers that reported data; this is a rough
      // proxy that matches user intuition ("how much of this waterfall is
      // covered overall"), even if it's not a strict cover-set computation.
      const aggregated = aggregateWaterfallStats(providers);
      if (aggregated) wfData.stats = aggregated;

      __cb.canvas.addCard(wfData, { x: baseX, y: stepsY });

      // Merge field DP card pinned to the right of the waterfall card.
      let mergeX = baseX + CARD_W;
      if (wf.mergeFieldId && fieldById[wf.mergeFieldId]) {
        const mergeField = fieldById[wf.mergeFieldId];
        const dpKey = `dp-${mergeField.id}`;
        if (!existingKeys.has(dpKey)) {
          existingKeys.add(dpKey);
          // Use the merge field's own dataProfile rather than the waterfall
          // aggregate. With `full`'s sampleSize: 0 the merge column is
          // profiled across every row, so empty cells (rows where every
          // provider in the chain returned no data) drag fillRate down the
          // way users expect. The pre-`full` workaround that overrode this
          // with the aggregated step-by-step success rate hid those misses.
          //
          // When the merge field has no profile (e.g. /context fetch
          // failed), fall back to the aggregated waterfall stats so the
          // card isn't completely blank.
          const mergeStats = statsByFieldId.get(mergeField.id) || aggregated || null;
          addDpCard(
            mergeField,
            mergeX,
            stepsY,
            mergeStats,
            wf.groupId,
            tableId,
            viewId,
            dpEnrichmentKeyById.get(mergeField.id) ?? `wf:${wf.groupId}`
          );
        }
      }

      currentY += CARD_H + CARD_V_GAP;
      importedAny = true;
    }

    // -------------------------------------------------------------------------
    // Basic groups — kept as visual clusters of whatever fields the user
    // (or a recipe) explicitly grouped. Comments always render here, even
    // for single-member groups, even when the group has only DPs or only
    // ERs — they're intentional clusters and the comment is how the user
    // navigates them.
    // -------------------------------------------------------------------------
    let groupY = currentY;
    if (basicGroups.length > 0) groupY += COMMENT_OFFSET;

    const GROUP_V_GAP = 40;
    // Width of the DP flow grid inside a basic group. 4 matches the
    // standalone canvas grid so DPs read as a familiar shape; ERs sit in
    // a 5th column to the right of the DP grid (so they magnet to the
    // rightmost DP in their row).
    const DP_COLS = 4;

    for (const bg of basicGroups) {
      const dpFields = [];
      for (const dpField of bg.dpFields) {
        const dpKey = `dp-${dpField.id}`;
        if (existingKeys.has(dpKey)) continue;
        existingKeys.add(dpKey);
        dpFields.push(dpField);
      }

      const erFields = [];
      for (const erField of bg.erFields) {
        const ai = __cb.isAiAction(
          erField.typeSettings?.actionKey,
          erField.name,
          erField.typeSettings?.actionPackageId
        );
        const dedupKey = ai
          ? `ai-${erField.id}`
          : `field-${erField.id}`;
        if (existingKeys.has(dedupKey)) continue;
        existingKeys.add(dedupKey);
        erFields.push(erField);
      }

      if (dpFields.length === 0 && erFields.length === 0) continue;

      // DPs flow left-to-right, top-to-bottom in a 4-col grid; ERs sit in
      // a single column to the right of the DP grid (so the comment magnets
      // to the first DP and ERs magnet to the rightmost DP in their row).
      // When a group has zero DPs we collapse the layout: ERs go in column
      // 0 so the comment still magnets to the first card of the cluster.
      const dpRowCount = Math.ceil(dpFields.length / DP_COLS);
      const erRowCount = erFields.length;
      const rowCount = Math.max(dpRowCount, erRowCount, 1);
      const groupHeight = rowCount * CARD_H;

      const groupX = START_X;

      __cb.canvas.addCommentCard(bg.name || "", {
        x: groupX,
        y: groupY - COMMENT_OFFSET,
        groupCluster: bg.groupId,
        tableId,
        tableName: currentImportTags.tableName,
        importColor: currentImportTags.importColor,
      });

      for (let i = 0; i < dpFields.length; i++) {
        const r = Math.floor(i / DP_COLS);
        const c = i % DP_COLS;
        addDpCard(
          dpFields[i],
          groupX + c * CARD_W,
          groupY + r * CARD_H,
          statsByFieldId.get(dpFields[i].id) ?? null,
          bg.groupId,
          tableId,
          viewId,
          dpEnrichmentKeyById.get(dpFields[i].id) ?? null
        );
      }

      const erColX = dpFields.length > 0
        ? groupX + DP_COLS * CARD_W
        : groupX;
      for (let i = 0; i < erFields.length; i++) {
        const cardData = mapFieldToCardData(erFields[i], statsByFieldId, tableId, viewId);
        cardData.groupCluster = bg.groupId;
        __cb.canvas.addCard(cardData, {
          x: erColX,
          y: groupY + i * CARD_H,
        });
      }

      // Each basic group fully owns its row — the new layout is up to
      // 5 cards wide (4 DP cols + 1 ER col), which exceeds the 4-col
      // canvas width anyway. Advance past this group by its actual height
      // plus a group gap so the next group / standalone section starts
      // cleanly with no overlap.
      groupY += groupHeight + COMMENT_OFFSET + GROUP_V_GAP;
      importedAny = true;
    }

    // -------------------------------------------------------------------------
    // Standalone fields — action fields placed as ER cards in a plain
    // 4-column grid below the grouped sections. (Basic fields outside
    // groups are either Inputs, already handled above, or skipped — same
    // as today's "no view color = no import" default.) groupY already sits
    // cleanly past the last group (the loop above advances it after every
    // group), so standaloneY just inherits it directly.
    // -------------------------------------------------------------------------
    let standaloneY = groupY;
    let col = 0;

    // Standalone enrichments + promoted (hidden-but-referenced) enrichments are
    // placed in a plain grid. Lineage grouping (each ER + its extracted data
    // points sharing a cluster) is applied uniformly on the canvas by
    // canvas.clusterByLineage() at hydration — it handles standalone,
    // basic-group, and waterfall ERs together with real card heights, which is
    // far more reliable than positioning here. So placement here is purely
    // cosmetic; the table groups by lineage (sourceEnrichmentFieldId) anyway.
    for (const field of [...standaloneFields, ...promotedErFields]) {
      const cardData = mapFieldToCardData(field, statsByFieldId, tableId, viewId);
      const dedupKey = cardData.isAi
        ? `ai-${field.id}`
        : `field-${field.id}`;
      if (existingKeys.has(dedupKey)) continue;
      existingKeys.add(dedupKey);

      __cb.canvas.addCard(cardData, {
        x: START_X + col * CARD_H_GAP,
        y: standaloneY,
      });

      col++;
      if (col >= COLS) {
        col = 0;
        standaloneY += CARD_V_GAP;
      }
      importedAny = true;
    }

    // -------------------------------------------------------------------------
    // Lineage data points (Phase 1) — every visible extracted data point not
    // already placed by a group / waterfall above. Each is stamped with its
    // sourceEnrichmentFieldId; the table matches + costs it by that key, and
    // canvas.clusterByLineage() groups it with its source ER on the canvas at
    // hydration. Placement here is a simple grid below the rest.
    // -------------------------------------------------------------------------
    let dpY = standaloneY + (col > 0 ? CARD_V_GAP : 0);
    let dpCol = 0;
    for (const field of dataPointFields) {
      const dpKey = `dp-${field.id}`;
      if (existingKeys.has(dpKey)) continue;
      existingKeys.add(dpKey);
      addDpCard(
        field,
        START_X + dpCol * CARD_W,
        dpY,
        statsByFieldId.get(field.id) ?? null,
        null,
        tableId,
        viewId,
        dpEnrichmentKeyById.get(field.id) ?? null
      );
      dpCol++;
      if (dpCol >= COLS) {
        dpCol = 0;
        dpY += CARD_H + CARD_V_GAP;
      }
      importedAny = true;
    }

    if (importedAny && __cb.canvas.refreshClusters) {
      // Importer drops new cards adjacent to each other; snap-derive
      // assigns them cluster ids on this pass. Empty dragCardIds keeps
      // pre-existing cards on the canvas from being re-bucketed when
      // the import runs against an already-populated tab.
      __cb.canvas.refreshClusters({ dragCardIds: new Set() });
    }

    // Start in Projected mode — its numbers are ready the moment rows land,
    // while actual spend is still being fetched in the background. When that
    // fetch resolves with real spend, fetchSpendInBackground auto-flips to
    // Actual (unless the user picks a mode first). _autoActualPending arms that
    // flip; actualSpendExpired is reset so a prior import's state doesn't leak.
    if (typeof __cb.setViewMode === "function") {
      __cb.setViewMode("projected");
    }
    __cb._autoActualPending = importedAny && !!workspaceId;
    __cb.actualSpendExpired = false;

    // Bulk imports add many cards in sequence. Each addCard internally
    // calls notifyCreditTotal, but the topbar summary ("Avg Credits / Row"
    // / "Actions / Row") only reaches the user once view mode has been
    // committed AND every card is in the array. Calling refreshCreditTotal
    // explicitly at the end guarantees the summary reflects the imported
    // cards without requiring a page refresh. Same idea for the per-group
    // credit badges, which only update when their cluster membership
    // settles — refreshClusters above takes care of cluster bookkeeping
    // but doesn't push the credit badge text. setViewMode itself also
    // calls refreshCreditTotal, but we run it again here so a no-op view
    // change (e.g. user already on Projected) still produces a fresh
    // recompute against the just-added cards.
    if (importedAny) {
      if (typeof __cb.canvas.refreshCreditTotal === "function") {
        __cb.canvas.refreshCreditTotal();
      }
      if (typeof __cb.canvas.updateGroupCredits === "function") {
        __cb.canvas.updateGroupCredits();
      }
    }

    // Background ACTUAL leg: fetch the 30-day realtime spend without blocking
    // the import, then stamp card.data.stats.spend so the Projected -> Actual
    // toggle has real numbers ready by the time the user flips it.
    if (importedAny && workspaceId) {
      // Track this table's spend leg as in-flight so the summary boxes shimmer
      // if the user flips to Actual before it lands.
      __cb.actualSpendPending = __cb.actualSpendPending || new Set();
      __cb.actualSpendPending.add(tableId);
      fetchSpendInBackground(workspaceId, tableId);
      // New import → the run set changed; drop any cached sessions, then
      // start fetching the run list in the background so the picker pre-selects
      // the last-7-days sessions and the badge animates in without the user
      // having to open it first.
      __cb.sessionCutoff?.invalidateCache();
      __cb.sessionCutoff?.ensureLoaded?.();
      // Resolve projected cost for "Run function" (subroutine) cards, whose
      // cost lives in the table they reference rather than the catalog.
      fetchSubroutineCostsInBackground(workspaceId, tableId);
      // Accurate per-DP fill rate (full-table nullPercentage). The import's
      // sampled profile is only ~50 rows, so actual fill needs sampleSize 0.
      fetchFullProfileInBackground(workspaceId, tableId);
    }

    return importedAny;
  }

  // Subroutine ("Run function") fields have no catalog or /context cost of
  // their own — their projected credits + actions live in the table they
  // reference (data.referencedTableId). Resolve them via the SAME endpoint
  // Clay's column editor uses (__cb.fetchSubroutineCosts -> listSubroutines),
  // which returns the authoritative per-row cost (standalone sub-columns summed,
  // waterfall steps averaged). The old approach flat-summed every sub-table
  // field's creditCost, which overcounted waterfalls (e.g. 33.9 vs Clay's 17.4).
  async function fetchSubroutineCostsInBackground(workspaceId, tableId) {
    if (!__cb.canvas || typeof __cb.fetchSubroutineCosts !== "function") return;

    const fnCards = [];
    const refIds = new Set();
    for (const card of __cb.canvas.getCards()) {
      const d = card.data;
      if (!d || d.tableId !== tableId) continue;
      if (d.actionKey !== "execute-subroutine" || !d.referencedTableId) continue;
      fnCards.push(card);
      refIds.add(d.referencedTableId);
    }
    if (refIds.size === 0) return;

    __cb._subroutineCostCache = __cb._subroutineCostCache || new Map();
    const cache = __cb._subroutineCostCache;

    await Promise.all(
      Array.from(refIds).map(async (refId) => {
        if (cache.has(refId)) return;
        const v = await __cb.fetchSubroutineCosts(workspaceId, refId);
        if (v) cache.set(refId, { credits: v.cost, actions: v.actionExecutionCost });
      })
    );

    let stamped = false;
    for (const card of fnCards) {
      const v = cache.get(card.data.referencedTableId);
      if (v == null) continue;
      card.data.credits = v.credits;
      card.data.creditText = v.credits != null ? `~${v.credits} / row` : null;
      card.data.actionExecutions = v.actions;
      stamped = true;
    }
    if (!stamped) return;
    if (typeof __cb.canvas.refreshCreditTotal === "function") __cb.canvas.refreshCreditTotal();
    if (typeof __cb.canvas.updateGroupCredits === "function") __cb.canvas.updateGroupCredits();
    __cb.model.update();
    if (__cb.tableView?.refresh) __cb.tableView.refresh();
  }

  // Fetches realtime column spend after the projected import has rendered and
  // folds it into the already-placed cards' stats. Standalone / basic ER + DP
  // cards carry data.fieldId; waterfall cards carry per-provider fieldIds, so
  // we stamp each provider then re-aggregate the parent card's stats (which
  // sums provider spend). Refreshes the credit total + table view so Actual
  // mode reflects the new numbers, and persists via notifyChange.
  async function fetchSpendInBackground(workspaceId, tableId) {
    let spendRows = null;
    try {
      spendRows = await __cb.fetchColumnSpend(workspaceId, tableId, __cb.ACTUAL_IMPORT_DAYS);
    } catch {
      spendRows = null;
    }
    // This table's spend leg is done (success / empty / failure) — drop it from
    // the pending set so any Actual-mode loading shimmer can resolve.
    __cb.actualSpendPending?.delete(tableId);

    // Settle the summary once the fetch resolves. didStamp = we folded real
    // spend into the cards. When armed (_autoActualPending) and we have data,
    // auto-flip to Actual (setViewMode animates the count-up + pill slide and
    // refreshes everything). Otherwise refresh in place — applyActualSummaryState
    // clears the shimmer and flags "Expired" when the window returned nothing.
    const settle = (didStamp) => {
      if (!__cb.canvas) return;
      // Auto-flip to Actual only when the user is actually viewing THIS table's
      // tab (its cards are on the live canvas) and hasn't opted into Projected.
      // The onThisTab gate is what keeps a fetch finishing in the background
      // from yanking a different tab the user has since switched to.
      const onThisTab = (__cb.canvas.getCards?.() || []).some(
        (c) => c.data?.tableId === tableId,
      );
      const autoFlip =
        didStamp &&
        onThisTab &&
        __cb._autoActualPending &&
        __cb.viewMode !== "actual" &&
        typeof __cb.setViewMode === "function";
      if (autoFlip) {
        __cb._autoActualPending = false;
        __cb.setViewMode("actual");
      } else {
        __cb.applyActualSummaryState?.();
        __cb._animateSummary = true;
        try {
          if (typeof __cb.canvas.refreshCreditTotal === "function") {
            __cb.canvas.refreshCreditTotal();
          }
        } finally {
          __cb._animateSummary = false;
        }
        if (typeof __cb.canvas.updateGroupCredits === "function") {
          __cb.canvas.updateGroupCredits();
        }
        if (__cb.tableView?.refresh) __cb.tableView.refresh();
      }
      if (didStamp) __cb.model.update();
    };

    if (!Array.isArray(spendRows) || !__cb.canvas) { settle(false); return; }

    const spendByFieldId = spendRowsToMap(spendRows);
    if (spendByFieldId.size === 0) { settle(false); return; }

    settle(stampSpend(spendByFieldId, tableId));
  }

  // Convert a byColumn / column-recent response (array of
  // {fieldId, creditsSpent, actionExecutionCreditsSpent, cellCount}) into the
  // Map<fieldId, {credits, actionExecutions, cellCount}> the stamper expects.
  function spendRowsToMap(rows) {
    const m = new Map();
    if (!Array.isArray(rows)) return m;
    for (const row of rows) {
      if (!row?.fieldId) continue;
      m.set(row.fieldId, {
        credits: Number(row.creditsSpent) || 0,
        actionExecutions: Number(row.actionExecutionCreditsSpent) || 0,
        cellCount: Number(row.cellCount) || 0,
      });
    }
    return m;
  }
  __cb.spendRowsToMap = spendRowsToMap;

  // Fold a spend map onto a table's cards (standalone/basic ER+DP via fieldId;
  // waterfalls per-provider then re-aggregated). Returns whether anything was
  // stamped. Shared by the import's background fetch and the session cutoff
  // picker so re-selecting sessions re-stamps through the exact same path.
  function stampSpend(spendByFieldId, tableId) {
    if (!__cb.canvas || !spendByFieldId || spendByFieldId.size === 0) return false;
    let stamped = false;
    for (const card of __cb.canvas.getCards()) {
      const d = card.data;
      if (!d || d.tableId !== tableId) continue;

      if (d.type === "waterfall" && Array.isArray(d.providers)) {
        let any = false;
        for (const p of d.providers) {
          const sp = p?.fieldId ? spendByFieldId.get(p.fieldId) : null;
          if (!sp) continue;
          p.stats = { ...(p.stats || {}), spend: sp };
          any = true;
        }
        if (any) {
          d.stats = aggregateWaterfallStats(d.providers) || d.stats || null;
          stamped = true;
        }
      } else if (d.fieldId) {
        const sp = spendByFieldId.get(d.fieldId);
        if (sp) {
          d.stats = { ...(d.stats || {}), spend: sp };
          stamped = true;
        }
      }
    }
    return stamped;
  }
  __cb.applyActualSpend = stampSpend;

  // Background ACTUAL fill: the fast import profiles only a ~50-row sample, so
  // per-DP nullPercentage (the fill signal) is approximate. Re-fetch /context at
  // sampleSize 0 (full table) and stamp exact nullPercentage + totalRecords on
  // each DP card so Actual fill rate is accurate. Coverage is left alone — its
  // run-status counts are already full-table from the import. While this is in
  // flight the table sits in __cb.fullProfilePending so the table view shows a
  // spinner in the Fill column (Actual mode) instead of a stale value.
  async function fetchFullProfileInBackground(workspaceId, tableId) {
    if (!__cb.canvas) return;
    __cb.fullProfilePending = __cb.fullProfilePending || new Set();
    __cb.fullProfilePending.add(tableId);
    if (__cb.tableView?.refresh) __cb.tableView.refresh();

    let nullByFieldId = null;
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
              includeCreditCosts: false,
              includeStatusCounts: false,
              includeDataProfiling: true,
              sampleSize: 0,
            },
          }),
        }
      );
      if (res.ok) {
        const body = await res.json();
        const fcs = body?.result?.fieldConfigurationsData?.fieldConfigs;
        if (Array.isArray(fcs)) {
          nullByFieldId = new Map();
          for (const fc of fcs) {
            const prof = fc?.dataProfile;
            if (!fc?.id || !prof || prof.nullPercentage == null) continue;
            nullByFieldId.set(fc.id, {
              nullPercentage: Number(prof.nullPercentage) || 0,
              totalRecords: Number(prof.totalRecords) || 0,
            });
          }
        }
      }
    } catch (err) {
      console.warn("[Clay Scoping] fetchFullProfileInBackground failed:", err);
    }

    __cb.fullProfilePending.delete(tableId);

    let stamped = false;
    if (nullByFieldId && nullByFieldId.size > 0) {
      for (const card of __cb.canvas.getCards()) {
        const d = card.data;
        if (!d || d.tableId !== tableId || d.type !== "dp" || !d.fieldId) continue;
        const np = nullByFieldId.get(d.fieldId);
        if (!np) continue;
        d.stats = {
          ...(d.stats || {}),
          nullPercentage: np.nullPercentage,
          totalRecords: np.totalRecords,
        };
        stamped = true;
      }
    }
    if (stamped) __cb.model.update();
    // Always refresh so the Fill spinner clears (whether data arrived or the
    // fetch failed — in which case the sampled fill is used as a fallback).
    if (__cb.tableView?.refresh) __cb.tableView.refresh();
  }

  // ---------------------------------------------------------------------------
  // Table picker dropdown
  //
  // Promoted to a shared helper under __cb.tablePicker so other flows can
  // reuse the exact same UX — table list with view sub-rows + "Full table"
  // — without duplicating ~70 lines of DOM construction. Each click invokes
  // the supplied `onPick(table, viewId)` callback with the Import flow's
  // three-state viewId convention preserved:
  //   - undefined  → use the table's default view
  //   - <view.id>  → that specific view's visibility map
  //   - null       → "Full table" (skip view filtering entirely)
  // ---------------------------------------------------------------------------

  function closeTablePicker() {
    closeOpenViewMenu();
    if (tablePickerEl) { tablePickerEl.remove(); tablePickerEl = null; }
    if (tablePickerBackdrop) { tablePickerBackdrop.remove(); tablePickerBackdrop = null; }
  }

  function getNonPreconfiguredViews(table) {
    return (table.views ?? []).filter((v) => !v.typeSettings?.isPreconfigured);
  }

  // ---------------------------------------------------------------------------
  // Custom view dropdown for the import picker. A styled trigger + a
  // body-positioned (fixed) menu so it isn't clipped by the picker list's
  // overflow. Each option shows the view's visible-column count. Only one menu
  // is open at a time.
  // ---------------------------------------------------------------------------
  let openViewMenu = null;

  function closeOpenViewMenu() {
    if (!openViewMenu) return;
    openViewMenu.menu.remove();
    document.removeEventListener("mousedown", openViewMenu.onDoc, true);
    document.removeEventListener("keydown", openViewMenu.onKey, true);
    window.removeEventListener("resize", openViewMenu.onReposition, true);
    openViewMenu = null;
  }

  const VIEW_DD_CHEVRON =
    '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>';

  function buildViewDropdown(options, defaultValue, onChange) {
    const wrap = document.createElement("div");
    wrap.className = "cb-view-dd";

    const trigger = document.createElement("button");
    trigger.type = "button";
    trigger.className = "cb-view-dd-trigger";
    const labelSpan = document.createElement("span");
    labelSpan.className = "cb-view-dd-label";
    const chevron = document.createElement("span");
    chevron.className = "cb-view-dd-chevron";
    chevron.innerHTML = VIEW_DD_CHEVRON;
    trigger.appendChild(labelSpan);
    trigger.appendChild(chevron);
    wrap.appendChild(trigger);

    let current = defaultValue;
    const labelFor = (val) => {
      const o = options.find((x) => x.value === val);
      return o ? o.label : "Select view";
    };
    labelSpan.textContent = labelFor(current);

    function positionMenu(menu) {
      const r = trigger.getBoundingClientRect();
      menu.style.top = `${r.bottom + 4}px`;
      // Right-align the menu to the trigger so it pans LEFT — the per-view
      // column counts sit near the picker / viewport right edge and would
      // otherwise be clipped.
      menu.style.left = "auto";
      menu.style.right = `${Math.max(8, window.innerWidth - r.right)}px`;
      menu.style.minWidth = `${r.width}px`;
    }

    trigger.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const mineOpen = openViewMenu && openViewMenu.trigger === trigger;
      closeOpenViewMenu();
      if (mineOpen) return;

      const menu = document.createElement("div");
      menu.className = "cb-view-dd-menu";
      for (const o of options) {
        const item = document.createElement("button");
        item.type = "button";
        item.className = "cb-view-dd-item" + (o.value === current ? " cb-view-dd-item-active" : "");
        const nm = document.createElement("span");
        nm.className = "cb-view-dd-item-name";
        nm.textContent = o.label;
        const colsEl = document.createElement("span");
        colsEl.className = "cb-view-dd-item-cols";
        colsEl.textContent = `${o.cols} col${o.cols === 1 ? "" : "s"}`;
        item.appendChild(nm);
        item.appendChild(colsEl);
        item.addEventListener("click", (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          current = o.value;
          labelSpan.textContent = labelFor(current);
          closeOpenViewMenu();
          onChange(o.value);
        });
        menu.appendChild(item);
      }
      document.body.appendChild(menu);
      positionMenu(menu);

      const onDoc = (ev) => {
        if (!menu.contains(ev.target) && !trigger.contains(ev.target)) closeOpenViewMenu();
      };
      const onKey = (ev) => {
        if (ev.key === "Escape") { ev.stopPropagation(); closeOpenViewMenu(); }
      };
      const onReposition = () => positionMenu(menu);
      // Capture phase so we beat the picker backdrop's own mousedown handler.
      document.addEventListener("mousedown", onDoc, true);
      document.addEventListener("keydown", onKey, true);
      window.addEventListener("resize", onReposition, true);
      openViewMenu = { menu, trigger, onDoc, onKey, onReposition };
    });

    return wrap;
  }

  function showTablePicker(tables, anchorEl, onPick, opts) {
    closeTablePicker();
    // `fullTableOnly`: hide per-view sub-rows entirely and always invoke
    // onPick(table, null) — used by the Old vs New Pricing flow which
    // always wants whole-table coverage. Default behavior (Import) keeps
    // the per-view dropdown so reps can scope to a specific view.
    const fullTableOnly = !!opts?.fullTableOnly;

    tablePickerBackdrop = document.createElement("div");
    tablePickerBackdrop.className = "cb-table-picker-backdrop";
    tablePickerBackdrop.addEventListener("click", closeTablePicker);

    tablePickerEl = document.createElement("div");
    tablePickerEl.className = "cb-table-picker";

    const heading = document.createElement("div");
    heading.className = "cb-table-picker-title";
    heading.textContent = "Select a table";
    tablePickerEl.appendChild(heading);

    const sorted = [...tables].sort((a, b) =>
      (a.name || "").localeCompare(b.name || "", undefined, { sensitivity: "base" })
    );

    for (const table of sorted) {
      const views = getNonPreconfiguredViews(table);
      const hasMultipleViews = !fullTableOnly && views.length > 1;

      const row = document.createElement("div");
      row.className = "cb-table-picker-row";

      const item = document.createElement("button");
      item.className = "cb-table-picker-item";
      item.type = "button";

      const nameSpan = document.createElement("span");
      nameSpan.textContent = table.name || "Untitled";
      item.appendChild(nameSpan);

      if (hasMultipleViews) {
        const chevron = document.createElement("span");
        chevron.className = "cb-table-picker-chevron";
        chevron.innerHTML =
          '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 6 15 12 9 18"/></svg>';
        item.appendChild(chevron);
      }

      // In fullTableOnly mode the click yields viewId=null directly so
      // the consumer (pricing comparison) gets the same "ignore view
      // visibility" semantic the multi-view "Full table" sub-row
      // produces in normal mode.
      item.addEventListener("click", () => {
        closeTablePicker();
        onPick(table, fullTableOnly ? null : undefined);
      });

      row.appendChild(item);

      if (hasMultipleViews) {
        const sub = document.createElement("div");
        sub.className = "cb-table-picker-views";

        // "Full table" entry — sits above the per-view list and ignores
        // view-visibility filtering on import. Only offered when the user
        // has multiple views (single-view tables already show every column
        // in their default view, so the option would be a no-op there).
        const fullBtn = document.createElement("button");
        fullBtn.className = "cb-table-picker-item";
        fullBtn.type = "button";

        const fullName = document.createElement("span");
        fullName.textContent = "Full table";
        fullBtn.appendChild(fullName);

        const fullBadge = document.createElement("span");
        fullBadge.className = "cb-table-picker-default";
        fullBadge.textContent = "all columns";
        fullBtn.appendChild(fullBadge);

        fullBtn.addEventListener("click", () => {
          closeTablePicker();
          onPick(table, null);
        });

        sub.appendChild(fullBtn);

        for (const view of views) {
          const viewBtn = document.createElement("button");
          viewBtn.className = "cb-table-picker-item";
          viewBtn.type = "button";

          const viewName = document.createElement("span");
          viewName.textContent = view.name || "Untitled view";
          viewBtn.appendChild(viewName);

          if (view.id === table.firstViewId) {
            const defaultBadge = document.createElement("span");
            defaultBadge.className = "cb-table-picker-default";
            defaultBadge.textContent = "default";
            viewBtn.appendChild(defaultBadge);
          }

          viewBtn.addEventListener("click", () => {
            closeTablePicker();
            onPick(table, view.id);
          });

          sub.appendChild(viewBtn);
        }

        row.appendChild(sub);
      }

      tablePickerEl.appendChild(row);
    }

    document.body.appendChild(tablePickerBackdrop);
    document.body.appendChild(tablePickerEl);

    if (anchorEl) {
      // Clamp to the viewport so a wide picker (or a narrow window) never
      // pushes the panel off-screen — shared helper, same as the model picker.
      __cb.placePopover(tablePickerEl, anchorEl, { gap: 4 });
    }
  }

  function showLoadingPicker(anchorEl) {
    closeTablePicker();

    tablePickerBackdrop = document.createElement("div");
    tablePickerBackdrop.className = "cb-table-picker-backdrop";
    tablePickerBackdrop.addEventListener("click", closeTablePicker);

    tablePickerEl = document.createElement("div");
    tablePickerEl.className = "cb-table-picker";

    const loading = document.createElement("div");
    loading.className = "cb-table-picker-loading";
    loading.textContent = "Loading tables\u2026";
    tablePickerEl.appendChild(loading);

    document.body.appendChild(tablePickerBackdrop);
    document.body.appendChild(tablePickerEl);

    if (anchorEl) {
      __cb.placePopover(tablePickerEl, anchorEl, { gap: 4 });
    }
  }

  // Pulls the record count out of the /views/:id/count response. The
  // endpoint returns `{ viewTotalRecordsCount }`; we accept a couple of
  // alternate key names defensively in case the shape ever drifts.
  function extractViewCount(res) {
    if (res == null) return null;
    if (typeof res === "number") return res;
    const n =
      res.viewTotalRecordsCount ??
      res.totalRecordsCount ??
      res.recordCount ??
      res.count ??
      null;
    return typeof n === "number" && Number.isFinite(n) ? n : null;
  }

  function columnsLabel(table) {
    const n = Array.isArray(table?.fields) ? table.fields.length : 0;
    return `${n} ${n === 1 ? "column" : "columns"}`;
  }

  // Multi-select import modal. Lists every workbook table with a checkbox,
  // its column count (free off the list response) and its row count (fetched
  // lazily per row via the view-count API — the table-list response carries
  // no record count). The footer imports every checked table.
  // The table + view the user currently has open, parsed from the URL. Used
  // to default each picker row's view selector to "what I'm looking at". Works
  // for both /tables/:id/views/:vid and /graphs/:id/views/:vid (graph view).
  function currentImportTableAndView() {
    try {
      const parts = window.location.pathname.split("/");
      const tIdx = parts.indexOf("tables");
      const gIdx = parts.indexOf("graphs");
      const vIdx = parts.indexOf("views");
      const tableId =
        tIdx !== -1 ? (parts[tIdx + 1] || null) : gIdx !== -1 ? (parts[gIdx + 1] || null) : null;
      const viewId = vIdx !== -1 ? (parts[vIdx + 1] || null) : null;
      return { tableId, viewId };
    } catch {
      return { tableId: null, viewId: null };
    }
  }

  function showMultiTablePicker(tables, anchorEl, onImport) {
    closeTablePicker();

    tablePickerBackdrop = document.createElement("div");
    tablePickerBackdrop.className = "cb-table-picker-backdrop";
    tablePickerBackdrop.addEventListener("click", closeTablePicker);

    tablePickerEl = document.createElement("div");
    tablePickerEl.className = "cb-table-picker cb-table-picker-multi";

    const heading = document.createElement("div");
    heading.className = "cb-table-picker-title";
    heading.textContent = "Select tables to import";
    tablePickerEl.appendChild(heading);

    const list = document.createElement("div");
    list.className = "cb-table-picker-list";
    tablePickerEl.appendChild(list);

    const sorted = [...tables].sort((a, b) =>
      (a.name || "").localeCompare(b.name || "", undefined, { sensitivity: "base" })
    );

    const selected = new Set();
    // Per-table chosen view: a view id, or null = "Full table" (no view filter).
    const viewByTable = new Map();
    const { tableId: curTableId, viewId: curViewId } = currentImportTableAndView();

    // Default a table's view selector to the view the user has open (when this
    // is that table), else its first/default view.
    function defaultViewIdFor(table) {
      const views = getNonPreconfiguredViews(table);
      if (table.id === curTableId && curViewId && views.some((v) => v.id === curViewId)) {
        return curViewId;
      }
      if (table.firstViewId && views.some((v) => v.id === table.firstViewId)) {
        return table.firstViewId;
      }
      return views[0]?.id ?? table.firstViewId ?? null;
    }

    // Update a row's "N cols · M rows" meta for the chosen view. For "Full
    // table" (null) we use firstViewId's count as a proxy for total rows.
    function refreshRowCount(table, viewId, metaEl, cols) {
      const countViewId = viewId || table.firstViewId;
      if (countViewId && __cb.fetchViewCount) {
        __cb.fetchViewCount(table.id, countViewId)
          .then((res) => {
            const count = extractViewCount(res);
            metaEl.textContent =
              count == null
                ? cols
                : `${cols} \u00b7 ${count.toLocaleString()} ${count === 1 ? "row" : "rows"}`;
          })
          .catch(() => {
            metaEl.textContent = cols;
          });
      } else {
        metaEl.textContent = cols;
      }
    }

    const footer = document.createElement("div");
    footer.className = "cb-table-picker-footer";

    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.className = "cb-table-picker-btn cb-table-picker-btn-secondary";
    cancelBtn.textContent = "Cancel";
    cancelBtn.addEventListener("click", closeTablePicker);

    const importBtn = document.createElement("button");
    importBtn.type = "button";
    importBtn.className = "cb-table-picker-btn cb-table-picker-btn-primary";
    importBtn.textContent = "Import";
    importBtn.disabled = true;

    function updateFooter() {
      const n = selected.size;
      importBtn.disabled = n === 0;
      importBtn.textContent = n > 0 ? `Import ${n}` : "Import";
    }

    for (const table of sorted) {
      const row = document.createElement("label");
      row.className = "cb-table-picker-checkrow";

      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.className = "cb-table-picker-checkbox";
      cb.addEventListener("change", () => {
        if (cb.checked) selected.add(table);
        else selected.delete(table);
        row.classList.toggle("cb-table-picker-checkrow-checked", cb.checked);
        updateFooter();
      });

      const main = document.createElement("div");
      main.className = "cb-table-picker-checkrow-main";

      const nameEl = document.createElement("div");
      nameEl.className = "cb-table-picker-checkrow-name";
      nameEl.textContent = table.name || "Untitled";

      const meta = document.createElement("div");
      meta.className = "cb-table-picker-checkrow-meta";
      const cols = columnsLabel(table);
      meta.textContent = `${cols} \u00b7 \u2026 rows`;

      main.appendChild(nameEl);
      main.appendChild(meta);

      // Per-table view selector (re-introduced): the table's selectable views
      // + a "Full table" option. Defaults to the view the user has open. The
      // chosen view scopes which fields/data points the import brings in. Each
      // option shows that view's visible-column count.
      const views = getNonPreconfiguredViews(table);
      const defaultViewId = defaultViewIdFor(table);
      viewByTable.set(table, defaultViewId);

      const colsForView = (v) =>
        Object.values(v.fields || {}).filter((s) => s.isVisible !== false).length;
      const viewOptions = views.map((v) => ({
        value: v.id,
        label: v.name || "View",
        cols: colsForView(v),
      }));
      // "Full table" = every field, regardless of view visibility.
      viewOptions.push({ value: null, label: "Full table", cols: (table.fields || []).length });

      const viewDd = buildViewDropdown(viewOptions, defaultViewId, (val) => {
        viewByTable.set(table, val);
        refreshRowCount(table, val, meta, cols);
      });

      row.appendChild(cb);
      row.appendChild(main);
      row.appendChild(viewDd);
      list.appendChild(row);

      // Single-table workbooks: pre-check the only table so the user just
      // confirms the view + clicks Import.
      if (sorted.length === 1) {
        cb.checked = true;
        selected.add(table);
        row.classList.add("cb-table-picker-checkrow-checked");
      }

      refreshRowCount(table, defaultViewId, meta, cols);
    }
    updateFooter();

    importBtn.addEventListener("click", () => {
      if (selected.size === 0) return;
      // Preserve the sorted display order for a predictable color cycle. Each
      // chosen table carries its selected view (id, or null = Full table).
      const chosen = sorted
        .filter((t) => selected.has(t))
        .map((t) => ({ table: t, viewId: viewByTable.get(t) }));
      closeTablePicker();
      onImport(chosen);
    });

    footer.appendChild(cancelBtn);
    footer.appendChild(importBtn);
    tablePickerEl.appendChild(footer);

    document.body.appendChild(tablePickerBackdrop);
    document.body.appendChild(tablePickerEl);

    if (anchorEl) {
      const rect = anchorEl.getBoundingClientRect();
      tablePickerEl.style.top = (rect.bottom + 4) + "px";
      tablePickerEl.style.left = rect.left + "px";
    }
  }

  // Shared picker namespace. Any caller that wants to prompt the user for a
  // workbook table drives the same DOM via these entry points.
  __cb.tablePicker = {
    show: showTablePicker,
    showMulti: showMultiTablePicker,
    showLoading: showLoadingPicker,
    close: closeTablePicker,
  };

  __cb.startImport = async function (anchorEl) {
    const ids = __cb.parseIdsFromUrl();
    if (!ids) {
      console.error("[Clay Scoping] Not on a Clay workbook page.");
      return;
    }

    showLoadingPicker(anchorEl);

    try {
      // Catalog + model pricing + billing plan: hydrate instantly from the
      // 24h localStorage cache when available, fetch only what's missing, and
      // revalidate stale entries in the background. This is what makes the
      // first import fast on a warm cache. ensureStaticData also populates
      // __cb.currentPlanPricing so the import's projected cost is plan-aware.
      await __cb.ensureStaticData(ids.workspaceId);
      // Pre-fetch the curated attribute → validators map so imported
      // waterfall cards can render the validation dropdown with options.
      // Without this, an "open overlay → import" path runs before the
      // picker has been touched, leaving __cb.waterfallByName empty and
      // validationOptions = [] on imported cards (which renders the
      // editable-text fallback instead of the branded dropdown).
      if (!__cb.waterfallByName || Object.keys(__cb.waterfallByName).length === 0) {
        await __cb.fetchWaterfallExecCosts();
      }

      const tables = await __cb.fetchTableList(ids.workbookId);

      if (!tables || tables.length === 0) {
        closeTablePicker();
        return;
      }

      // Sequentially import each selected table at its CHOSEN view. Awaiting
      // one before the next keeps card placement deterministic (each import
      // appends below the previous) and lets the per-table color cycle read a
      // stable "already imported" set as it advances. `chosen` is an array of
      // { table, viewId } where viewId is a view id or null = Full table.
      const importSelected = async (chosen) => {
        for (const { table, viewId } of chosen) {
          try {
            await importTableToCanvas(table, viewId, anchorEl);
          } catch (err) {
            console.error(`[Clay Scoping] Import failed for ${table?.name}:`, err);
            closeImportStatus();
          }
        }
      };

      // Always show the picker — even for a single-table workbook — so the
      // user can choose which view (or Full table) to import.
      showMultiTablePicker(tables, anchorEl, (chosen) => {
        importSelected(chosen);
      });
    } catch (err) {
      console.error("[Clay Scoping] Failed to fetch tables:", err);
      closeTablePicker();
      closeImportStatus();
    }
  };
})();
