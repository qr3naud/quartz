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

  // Exposed so src/pricing-comparison.js can reuse the same model
  // resolution path the import uses for AI cards (read the user-
  // selected model off field.typeSettings.inputsBinding, then match
  // against the catalog with quote-stripping + longest-includes
  // fallback). Function declarations below are hoisted within this
  // IIFE so the assignment is safe even though the definitions
  // appear further down in the file.
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
  // (libs/shared/src/fields/status-processing-utils.ts line 5). For the
  // canvas, that's misleading: rows where the user's run-condition formula
  // evaluated to false were never actually attempted, so they shouldn't
  // count toward coverage OR fill rate. We peel them back out using the
  // raw `statusBreakdown` array.
  //
  // Returns a stat block matching the rest of buildStatsByFieldId's output
  // shape, or null when there's no usable data on this field.
  // ---------------------------------------------------------------------------
  function deriveActionStatsFromDataProfile(dp) {
    if (!dp) return null;
    const success = Number(dp.successCount) || 0;
    const error = Number(dp.errorCount) || 0;
    const inProgress = Number(dp.inProgressCount) || 0;
    const total = Number(dp.totalRecords) || 0;

    let condNotMet = 0;
    if (Array.isArray(dp.statusBreakdown)) {
      for (const entry of dp.statusBreakdown) {
        if (entry?.status === "ERROR_RUN_CONDITION_NOT_MET") {
          condNotMet += Number(entry.count) || 0;
        }
      }
    }

    const adjustedSuccess = Math.max(0, success - condNotMet);
    const adjustedTotal = Math.max(0, total - condNotMet);
    const ran = adjustedSuccess + error + inProgress;

    if (ran <= 0 || adjustedTotal <= 0) return null;
    return {
      coverage: { ran, total: adjustedTotal },
      fillRate: { success: adjustedSuccess, ran },
      condNotMet,
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

      // Basic fields (and any action field whose dataProfile lacks status
      // counts) fall back to valueCount / sampleSize. With `full`'s
      // sampleSize: 0 the profile spans every row, so empty cells in the
      // column reduce fillRate accurately.
      if (!stats.fillRate && dp) {
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
  //   - costBy=RESULT → cost × min(maxResultsPerRow, fallback)
  //                     Mirrors getWaterfallCreditEstimate's per-result
  //                     handling in libs/shared/src/credits/credit-cost-utils.ts
  //                     line 555. Fallback of 5 matches
  //                     FALLBACK_ESTIMATED_RESULTS_PER_ROW.
  //
  // Falls back to the catalog default when the server didn't attach a
  // creditCost block (rare — happens when getActionCost throws or the field
  // has no action definition).
  function resolveEffectiveCredits(creditCost, fallback) {
    if (!creditCost) return fallback ?? null;
    if (creditCost.unlimited) return 0;
    if (creditCost.isPrivateKey) return 0;
    let cost = Number(creditCost.cost);
    if (!Number.isFinite(cost)) return fallback ?? null;
    if (creditCost.costBy === "result") {
      const max = Number(creditCost.maxResultsPerRow);
      const n = Number.isFinite(max) && max > 0 ? Math.min(max, 5) : 5;
      cost = cost * n;
    }
    return cost;
  }
  __cb.resolveEffectiveCredits = resolveEffectiveCredits;

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

    // Catalog default. For AI actions this is the action-level base cost
    // (e.g. 0.1 for use-ai), so it's wrong for any non-default model — we
    // override below from either the matched modelOption or the
    // server-resolved stats.cost.
    let credits = info?.credits ?? null;

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
        const resolved = resolveEffectiveCredits(stats.cost, credits);
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
      displayName: ai ? (displayName || info?.displayName || "Use AI") : (info?.displayName || displayName || "Enrichment"),
      packageName: info?.packageName ?? "Clay",
      credits,
      // Default to 0, NOT 1 — read / lookup / source actions
      // intentionally omit `pricing.credits.actionExecution` and bill 0
      // actions per row server-side (calculateActionExecutionCost in
      // apps/api uses `?? 0` for the same reason). The previous `?? 1`
      // default overcounted every Salesforce / Pardot lookup + every
      // records-* source action in the canvas's "Total Actions" / "Avg
      // Actions / Row" headlines.
      actionExecutions: info?.actionExecutions ?? 0,
      iconUrl,
      iconSvgHtml: null,
      creditText: credits != null ? `~${credits} / row` : null,
      badges: [],
      isAi: ai,
      modelOptions,
      selectedModel,
      requiresApiKey,
      usePrivateKey,
      fieldId: fieldId ?? field?.id,
      tableId: tableId ?? null,
      viewId: viewId ?? null,
      stats: stats || null,
      groupCluster: groupCluster || null,
    };
  }

  function mapFieldToCardData(field, statsByFieldId, tableId, viewId) {
    const ts = field.typeSettings ?? {};
    return buildErCardData({
      field,
      actionKey: ts.actionKey,
      packageId: ts.actionPackageId ?? "clay",
      displayName: field.name,
      stats: statsByFieldId?.get(field.id) ?? null,
      fieldId: field.id,
      tableId,
      viewId,
    });
  }

  function getExistingCardKeys() {
    if (!__cb.canvas) return new Set();
    const state = __cb.canvas.serialize();
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

  function addDpCard(field, x, y, stats, groupCluster, tableId, viewId) {
    return __cb.canvas.addDataPointCard(field.name, {
      x,
      y,
      stats: stats || null,
      groupCluster: groupCluster || null,
      fieldId: field.id,
      tableId: tableId ?? null,
      viewId: viewId ?? null,
    });
  }

  function addInputCardFromField(field, x, y, tableId, viewId) {
    return __cb.canvas.addInputCard(field.name, {
      x,
      y,
      fieldId: field.id,
      tableId: tableId ?? null,
      viewId: viewId ?? null,
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
    if (total == null) return;
    const input = document.getElementById("cb-records-input");
    if (!input) return;
    input.value = total.toLocaleString();
    input.dispatchEvent(new Event("input"));
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

    const leafInputFields = (table?.fields ?? []).filter(
      (f) =>
        visibleFieldIds.has(f.id) &&
        f.type === "basic" &&
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
        f.type === "action"
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
          if (field.type === "action") {
            erFields.push(field);
          } else {
            dpFields.push(field);
          }
        }
        return { groupId, name: g.name ?? "", dpFields, erFields };
      })
      .filter((g) => g.dpFields.length > 0 || g.erFields.length > 0);

    const statsByFieldId = buildStatsByFieldId({
      fields: table?.fields ?? [],
      context,
      spend,
    });

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
        statsByFieldId,
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

    let context = null;
    let spend = null;
    try {
      [context, spend] = await Promise.all([
        workspaceId ? __cb.fetchTableContextFull(workspaceId, tableId).catch(() => null) : Promise.resolve(null),
        workspaceId ? __cb.fetchColumnSpend(workspaceId, tableId, 30).catch(() => null) : Promise.resolve(null),
      ]);
    } finally {
      closeImportStatus();
    }

    prefillRecordsCount(context);

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
    const waterfalls = internal.waterfalls;
    const basicGroups = internal.basicGroups;
    const statsByFieldId = internal.statsByFieldId;

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
        const catalogCredits = typeof info.credits === "number" ? info.credits : null;
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
          stepCredits = stepStats?.cost
            ? resolveEffectiveCredits(stepStats.cost, catalogCredits)
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
            ? (entry.privateKeyCredits ?? 0)
            : (entry.credits ?? 0);
          const resolvedValidationPrice = validationStats?.cost
            ? resolveEffectiveCredits(validationStats.cost, catalogValidationPrice)
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

      // ---- Per-row action-execution averaging ----
      //
      // Mirrors the credit averaging deriveWaterfallTotals already does
      // (mean of per-step cost + validation when active). Read-only
      // lookup steps (no `pricing.credits.actionExecution` set in their
      // action-definition) genuinely bill 0 actions per row server-side
      // — see calculateActionExecutionCost in apps/api which falls back
      // to 0. The previous hardcoded `actionExecutions: 1` constant was
      // overcounting waterfalls of all-lookup steps as 1 action / row.
      // Validation contributes its own action execution per step it
      // runs; a key-only validator still bills an actionExecution
      // (private-key state suppresses credit cost, NOT the action
      // billing line — same rule canvas/credits.js applies).
      const validationActionsPerStep = firstValidation
        ? (Number(__cb.actionByIdLookup?.[
            `${firstValidation.actionPackageId ?? "clay"}-${firstValidation.actionKey}`
          ]?.actionExecutions) || 0)
        : 0;
      let stepActionsSum = 0;
      for (const step of wf.steps) {
        const stepInfo = __cb.actionByIdLookup?.[
          `${step.actionPackageId ?? "clay"}-${step.actionKey}`
        ];
        const stepActions = Number(stepInfo?.actionExecutions) || 0;
        stepActionsSum += stepActions + validationActionsPerStep;
      }
      const wfActionsAvg = wf.steps.length > 0
        ? Math.round((stepActionsSum / wf.steps.length) * 100) / 100
        : 0;

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
        actionExecutions: wfActionsAvg,
        groupCluster: wf.groupId,
        // Anchor the card to the waterfall group so re-imports dedupe via
        // `wf-${groupId}` (set on existingKeys above) AND its own data
        // exposes both the field-equivalent linkage and the table linkage
        // to "Open in table" (Clay's grid jump-to-column wiring).
        fieldId: wf.steps[0]?.fieldId ?? null,
        tableId,
        viewId,
      });
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
            viewId
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
          viewId
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

    for (const field of standaloneFields) {
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

    if (importedAny && __cb.canvas.refreshClusters) {
      __cb.canvas.refreshClusters();
    }

    // Decide the view mode AFTER cards are placed (so we can read
    // statsByFieldId, which carries the joined spend rows). Actual only
    // makes sense when at least one imported field has real billed spend
    // — otherwise the summary boxes would display 0 / 0 because Actual
    // mode sums card.data.stats.spend and ignores card.data.credits.
    // Projected mode falls back to the model-aware catalog credits, which
    // is the right "what would this cost?" answer when there's no
    // historical spend to anchor on (e.g. a brand-new table or one with
    // no runs in the last 30 days).
    const hasAnySpend = Array.isArray(spend)
      && spend.some((row) => Number(row?.creditsSpent) > 0
        || Number(row?.actionExecutionCreditsSpent) > 0
        || Number(row?.cellCount) > 0);
    if (typeof __cb.setViewMode === "function") {
      __cb.setViewMode(hasAnySpend ? "actual" : "projected");
    }

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

    return importedAny;
  }

  // ---------------------------------------------------------------------------
  // Table picker dropdown
  //
  // Promoted to a shared helper under __cb.tablePicker so the Old vs New
  // Pricing flow (src/pricing-comparison.js) can reuse the exact same UX
  // — table list with view sub-rows + "Full table" — without duplicating
  // ~70 lines of DOM construction. Each click invokes the supplied
  // `onPick(table, viewId)` callback with the Import flow's three-state
  // viewId convention preserved:
  //   - undefined  → use the table's default view
  //   - <view.id>  → that specific view's visibility map
  //   - null       → "Full table" (skip view filtering entirely)
  // ---------------------------------------------------------------------------

  function closeTablePicker() {
    if (tablePickerEl) { tablePickerEl.remove(); tablePickerEl = null; }
    if (tablePickerBackdrop) { tablePickerBackdrop.remove(); tablePickerBackdrop = null; }
  }

  function getNonPreconfiguredViews(table) {
    return (table.views ?? []).filter((v) => !v.typeSettings?.isPreconfigured);
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
      const rect = anchorEl.getBoundingClientRect();
      tablePickerEl.style.top = (rect.bottom + 4) + "px";
      tablePickerEl.style.left = rect.left + "px";
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
      const rect = anchorEl.getBoundingClientRect();
      tablePickerEl.style.top = (rect.bottom + 4) + "px";
      tablePickerEl.style.left = rect.left + "px";
    }
  }

  // Shared picker namespace. Both __cb.startImport (below) and
  // __cb.startPricingComparison (src/pricing-comparison.js) drive the
  // same DOM via these three entry points.
  __cb.tablePicker = {
    show: showTablePicker,
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
      if (Object.keys(__cb.actionByIdLookup).length === 0) {
        await __cb.fetchEnrichments(ids.workspaceId);
      }
      if (Object.keys(__cb.livePricingByModel).length === 0) {
        await __cb.fetchModelPricing(ids.workspaceId);
      }
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

      const onPick = (table, viewId) => {
        importTableToCanvas(table, viewId, anchorEl).catch((err) => {
          console.error("[Clay Scoping] Import failed:", err);
          closeImportStatus();
        });
      };

      if (tables.length === 1) {
        closeTablePicker();
        onPick(tables[0], undefined);
      } else {
        showTablePicker(tables, anchorEl, onPick);
      }
    } catch (err) {
      console.error("[Clay Scoping] Failed to fetch tables:", err);
      closeTablePicker();
      closeImportStatus();
    }
  };
})();
