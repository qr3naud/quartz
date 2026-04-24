(function () {
  "use strict";

  const __cb = window.__cb;

  let selectedEnrichments = new Map();
  let dialogObserver = null;
  let contentObserver = null;
  let selectionBanner = null;
  let managedDialog = null;
  let promotedPortal = null;
  let promotedPortalOriginalZIndex = null;

  // ---------------------------------------------------------------------------
  // Waterfall card data shape
  //
  // A waterfall card is one composite ER-like card that carries an ordered
  // `providers[]` array. Visually it renders the same way every other ER card
  // does, except its provider-icons badge is clickable and opens a popover
  // listing each provider with its individual cost. `credits` mirrors
  // `averageCost` so the existing summary-bar / per-DP-cluster math sums it
  // exactly the same as a single ER.
  //
  // Cost math intentionally mirrors getWaterfallCreditEstimate in
  // libs/shared/src/credits/credit-cost-utils.ts so our totals line up with
  // what the picker's WaterfallRow / PresetRow display:
  //   averageCost = mean(provider.credits + validationPrice)
  //   maxCost     = max(provider.credits + validationPrice)
  // ---------------------------------------------------------------------------
  function normalizeWaterfallProvider(p) {
    if (!p) return null;
    const credits = typeof p.credits === "number" && Number.isFinite(p.credits) ? p.credits : null;
    return {
      actionKey: p.actionKey ?? null,
      packageId: p.packageId ?? "clay",
      displayName: p.displayName ?? p.name ?? "Provider",
      packageName: p.packageName ?? null,
      iconUrl: p.iconUrl ?? null,
      iconSvgHtml: p.iconSvgHtml ?? null,
      credits,
      creditText: p.creditText ?? (credits != null ? `~${credits} / row` : null),
      isAi: !!p.isAi,
      modelOptions: p.modelOptions ?? null,
      selectedModel: p.selectedModel ?? null,
      requiresApiKey: !!p.requiresApiKey,
      // Per-provider key toggle. When true the provider doesn't burn Clay
      // credits (its actionable cost falls to 0) but still triggers a
      // validation call, which IS billed unless the validation itself is
      // toggled to API-key mode.
      usePrivateKey: !!p.usePrivateKey,
      stats: p.stats ?? null,
      fieldId: p.fieldId ?? null,
    };
  }

  function buildBadgesFromProviders(providers) {
    // Compact provider-icon badges. We collapse duplicates by iconUrl so a
    // waterfall with five Apollo steps doesn't render five identical icons in
    // the always-visible badge row — the popover still shows every step.
    const seen = new Set();
    const badges = [];
    for (const p of providers) {
      if (!p?.iconUrl) continue;
      if (seen.has(p.iconUrl)) continue;
      seen.add(p.iconUrl);
      badges.push({ imgSrc: p.iconUrl, text: null });
    }
    if (badges.length > 0) {
      badges[badges.length - 1] = {
        ...badges[badges.length - 1],
        text: `+${providers.length}`,
      };
    }
    return badges;
  }

  // Display helper used by both the card pill and the popover so the
  // numbers are formatted identically.
  const formatWaterfallCost = (n) =>
    Number.isFinite(n) ? n.toFixed(1) : "0.0";
  __cb.formatWaterfallCost = formatWaterfallCost;

  // Whether validation should be billed for this waterfall card. Honors
  // the right-click "Add / Remove validation" toggle (data.validationVisible)
  // and falls back to "active iff options exist" when the user hasn't
  // explicitly toggled.
  //
  // Removing validation via the right-click menu sets validationVisible
  // to false → this returns false → validationPrice contributes 0 to
  // every per-provider cost → averageCost / maxCost drop accordingly.
  function isValidationActive(data) {
    if (data?.validationVisible === false) return false;
    if (data?.validationVisible === true) return true;
    return Array.isArray(data?.validationOptions) && data.validationOptions.length > 0;
  }
  __cb.isValidationActive = isValidationActive;

  // Computes derived fields (averageCost / maxCost / credits / creditText /
  // badges / requiresApiKey) from a providers[] + validation settings.
  // Called both at construction (buildWaterfallCardData) AND after popover
  // edits (recomputeWaterfallCardData) so the math stays consistent.
  //
  // Cost model:
  //   validationActive = data.validationVisible OR (default = hasOptions)
  //   per-provider cost = (provider.usePrivateKey ? 0 : provider.credits) +
  //                       ((validationActive && !validationUsePrivateKey)
  //                          ? validationPrice
  //                          : 0)
  //   averageCost       = mean(per-provider cost)
  //   maxCost           = max(per-provider cost)
  function deriveWaterfallTotals(providers, validationPrice, validationUsePrivateKey, validationActive) {
    const useValidation = validationActive !== false && !validationUsePrivateKey;
    const v = useValidation
      ? (Number.isFinite(validationPrice) ? validationPrice : 0)
      : 0;
    const creditsList = providers.map((p) => {
      const c = p.usePrivateKey ? 0 : (p.credits ?? 0);
      return c + v;
    });
    const totalCost = creditsList.reduce((s, c) => s + c, 0);
    const averageCost = providers.length === 0
      ? 0
      : Math.round((totalCost / providers.length) * 10) / 10;
    const maxCost = providers.length === 0 ? 0 : Math.max(...creditsList);
    return {
      averageCost,
      maxCost,
      requiresApiKey: providers.some((p) => p.requiresApiKey),
      badges: buildBadgesFromProviders(providers),
    };
  }

  __cb.buildWaterfallCardData = function buildWaterfallCardData({
    displayName,
    providers,
    attributeEnum = null,
    packageId = "clay",
    validationPrice = 0,
    validationName = null,
    validationRequiresApiKey = false,
    validationUsePrivateKey = false,
    validationOptions = [],
    validationProvider = null,
    // Explicit override for whether the validation row contributes to
    // the cost math AND renders. `undefined` = use the default (active
    // iff validationOptions has items). `true` = force-show (e.g. table
    // imports with a configured validator but no curated options list).
    // `false` = force-hide (right-click "Remove validation" path).
    validationVisible,
    iconUrl = null,
    iconSvgHtml = null,
    actionExecutions = 1,
    groupCluster = null,
    fieldId = null,
    tableId = null,
    viewId = null,
    presetId = null,
  }) {
    const norm = (Array.isArray(providers) ? providers : [])
      .map(normalizeWaterfallProvider)
      .filter(Boolean);

    // Same predicate as isValidationActive(data) so the initial
    // averageCost / maxCost match what recomputeWaterfallCardData would
    // derive after any popover edit. Without this honoring, callers
    // that flip validationVisible on the returned data afterwards would
    // see stale credits until the user opened the popover.
    const initialValidationActive = typeof validationVisible === "boolean"
      ? validationVisible
      : (Array.isArray(validationOptions) && validationOptions.length > 0);
    const totals = deriveWaterfallTotals(norm, validationPrice, validationUsePrivateKey, initialValidationActive);
    const safeName = (displayName ?? "").trim();

    return {
      type: "waterfall",
      displayName: safeName,
      attributeEnum,
      presetId,
      packageId,
      packageName: "Clay",
      // First provider's icon as the card's primary icon when no explicit one
      // was passed. Mirrors the picker's WaterfallRow which uses the
      // attribute icon — but for ad-hoc waterfalls (no attribute) the first
      // provider gives a more recognizable visual.
      iconUrl: iconUrl ?? norm[0]?.iconUrl ?? null,
      iconSvgHtml,
      // Generated key — only used for dedup against existing canvas cards in
      // some flows. Doesn't have to match Clay's API since waterfalls aren't
      // resolved against actionByIdLookup.
      actionKey: attributeEnum
        ? `waterfall-${attributeEnum}`
        : (presetId ? `waterfall-preset-${presetId}` : `waterfall-${safeName.toLowerCase().replace(/[^a-z0-9]+/g, "_") || "adhoc"}`),
      credits: totals.averageCost,
      // Same `~N / row` format the rest of the cards use — the "average
      // across providers" semantic is implicit for waterfall cards (and
      // surfaced explicitly in the showProviderChain popover footer).
      // Always one decimal so the pill reads as "12.0" not "12".
      creditText: totals.averageCost > 0 ? `~${formatWaterfallCost(totals.averageCost)} / row` : null,
      // creditsCustom flips to true the moment the user moves the override
      // slider in the popover, pinning `credits` independent of providers[]
      // changes. Adding/removing/reordering providers updates averageCost
      // and maxCost but leaves `credits` alone when this flag is true.
      creditsCustom: false,
      averageCost: totals.averageCost,
      maxCost: totals.maxCost,
      validationPrice: Number.isFinite(validationPrice) ? validationPrice : 0,
      // Validation row metadata (popover-editable). Lets the user surface
      // and tweak the cost of the validation provider Clay runs after each
      // step (e.g. ZeroBounce verifying an email). validationUsePrivateKey
      // zeroes out the validation contribution to averageCost / maxCost.
      validationName: validationName || null,
      validationRequiresApiKey: !!validationRequiresApiKey,
      validationUsePrivateKey: !!validationUsePrivateKey,
      // Validation provider dropdown options (resolved against
      // actionByIdLookup at extract time). Each entry is
      // { actionId, name, packageName, actionName, iconUrl, credits, requiresApiKey }.
      // Empty for ad-hoc waterfalls — those fall back to an editable text
      // input. Selecting a different option in the popover updates
      // validationName / validationPrice / validationRequiresApiKey atomically.
      validationOptions: Array.isArray(validationOptions) ? validationOptions : [],
      validationProvider: validationProvider ?? null,
      // Persist the explicit visibility override on data when the caller
      // supplied one. `undefined` means "fall back to the default
      // visibility predicate" (read by isValidationActive at recompute
      // time). The popover's right-click context menu writes this same
      // field to flip Add / Remove.
      validationVisible: typeof validationVisible === "boolean" ? validationVisible : undefined,
      actionExecutions,
      providers: norm,
      badges: totals.badges,
      isAi: false,
      modelOptions: null,
      selectedModel: null,
      requiresApiKey: totals.requiresApiKey,
      usePrivateKey: false,
      groupCluster,
      fieldId,
      tableId,
      viewId,
    };
  };

  // Recomputes derived fields on an existing waterfall card after the
  // popover has mutated providers[]. Honors creditsCustom: when the user
  // has overridden the credit cost, averageCost/maxCost still recompute
  // but `credits` and `creditText` stay pinned to the override.
  __cb.recomputeWaterfallCardData = function recomputeWaterfallCardData(data) {
    if (!data || data.type !== "waterfall") return data;
    const norm = (Array.isArray(data.providers) ? data.providers : [])
      .map(normalizeWaterfallProvider)
      .filter(Boolean);
    const totals = deriveWaterfallTotals(
      norm,
      data.validationPrice,
      data.validationUsePrivateKey,
      isValidationActive(data),
    );
    data.providers = norm;
    data.badges = totals.badges;
    data.averageCost = totals.averageCost;
    data.maxCost = totals.maxCost;
    data.requiresApiKey = totals.requiresApiKey;
    if (!data.creditsCustom) {
      data.credits = totals.averageCost;
      data.creditText = totals.averageCost > 0
        ? `~${formatWaterfallCost(totals.averageCost)} / row`
        : null;
    }
    return data;
  };

  // Pushes the current waterfall card data to the canvas DOM + summary
  // bar. Called after popover edits so the badge / +N / cluster credit
  // total reflect the new numbers without rebuilding the whole card.
  __cb.refreshWaterfallCardDom = function refreshWaterfallCardDom(card) {
    if (!card?.el || card.data?.type !== "waterfall") return;
    const data = card.data;

    // Credit pill (.cb-card-badge-credit > span). The credit pill is
    // rebuilt by addCard's renderCreditMode helper from data.creditText
    // each render, but since we don't re-mount the card we update the
    // text node directly.
    const creditEl = card.el.querySelector(".cb-card-badge-credit span");
    if (creditEl) {
      creditEl.textContent = data.creditText || (data.credits != null ? `~${data.credits} / row` : "");
    }

    // +N count.
    const countEl = card.el.querySelector(".cb-card-badge-providers-count");
    if (countEl) {
      countEl.textContent = `+${(data.providers || []).length}`;
    }

    // Re-run summary-bar / per-cluster math so totals reflect the change.
    // notifyChange pushes an undo entry and triggers the existing debounced
    // save through onCanvasStateChange, so we don't need to call saveTabs
    // directly — that would fire a synchronous save on every keystroke.
    if (window.__cb.canvas?.refreshCreditTotal) window.__cb.canvas.refreshCreditTotal();
    if (window.__cb.canvas?.updateGroupCredits) window.__cb.canvas.updateGroupCredits();
    if (window.__cb.canvas?.notifyChange) window.__cb.canvas.notifyChange();
  };

  __cb.startPickerMode = function () {
    const ids = __cb.parseIdsFromUrl();
    if (!ids) {
      console.error("[Clay Scoping] Not on a Clay workbook page.");
      return;
    }

    selectedEnrichments.clear();
    // Run actions BEFORE waterfall fetches: both waterfallByName and
    // waterfallPresetByName store raw actionIds that we resolve against
    // __cb.actionByIdLookup at extractVisualData time. If actions hadn't
    // resolved yet we'd downgrade to a flat card on the first checkbox
    // click. Sequencing here costs ~one round-trip but avoids that race.
    __cb.fetchEnrichments(ids.workspaceId)
      .then(() => Promise.all([
        __cb.fetchWaterfallExecCosts(),
        __cb.fetchWaterfallPresets(ids.workspaceId),
      ]))
      .catch((err) => console.error("[Clay Scoping] enrichment prefetch failed:", err));
    __cb.fetchModelPricing(ids.workspaceId);

    watchForDialog();

    if (!tryOpenPicker()) {
      if (tryOpenToolsSidebar()) {
        setTimeout(() => tryOpenPicker(), 150);
      }
    }
  };

  function tryOpenPicker() {
    const testIdBtn = document.querySelector('[data-testid="title-bar-enrich-data"]');
    if (testIdBtn) { testIdBtn.click(); return true; }

    const buttons = document.querySelectorAll(
      'button, [role="button"], [role="menuitem"]'
    );
    for (const btn of buttons) {
      const text = (btn.textContent || "").trim().toLowerCase();
      const label = (btn.getAttribute("aria-label") || "").toLowerCase();
      if (
        text === "add enrichment" ||
        text === "enrich data" ||
        text.includes("view all enrichments") ||
        label.includes("add enrichment") ||
        label.includes("add column")
      ) {
        btn.click();
        return true;
      }
    }
    return false;
  }

  function tryOpenToolsSidebar() {
    const buttons = document.querySelectorAll('button, [role="button"]');
    for (const btn of buttons) {
      const text = (btn.textContent || "").trim().toLowerCase();
      if (text === "tools" || text === "actions") {
        btn.click();
        return true;
      }
    }
    return false;
  }

  // ---- Dialog detection ----

  function watchForDialog() {
    stopWatching();

    dialogObserver = new MutationObserver(() => {
      if (managedDialog && !managedDialog.isConnected) {
        cleanupPicker();
      }

      const dialog = findPickerDialog();
      if (dialog && !dialog.hasAttribute("data-cb-managed")) {
        dialog.setAttribute("data-cb-managed", "true");
        onDialogFound(dialog);
      }
    });
    dialogObserver.observe(document.body, { childList: true, subtree: true });

    const existing = findPickerDialog();
    if (existing && !existing.hasAttribute("data-cb-managed")) {
      existing.setAttribute("data-cb-managed", "true");
      onDialogFound(existing);
    }
  }

  function findPickerDialog() {
    for (const d of document.querySelectorAll('[role="dialog"]')) {
      const title = d.querySelector("h2");
      if (title && title.textContent.trim().toLowerCase().includes("add enrichment")) {
        return d;
      }
    }
    return null;
  }

  function stopWatching() {
    if (dialogObserver) {
      dialogObserver.disconnect();
      dialogObserver = null;
    }
    if (contentObserver) {
      contentObserver.disconnect();
      contentObserver = null;
    }
  }

  // ---- Checkbox injection ----

  let promotedPortalOriginalPosition = null;

  function promoteDialogAboveOverlay(dialog) {
    let el = dialog;
    while (el.parentElement && el.parentElement !== document.body) {
      el = el.parentElement;
    }
    promotedPortal = el;
    promotedPortalOriginalZIndex = el.style.zIndex;
    promotedPortalOriginalPosition = el.style.position;
    el.style.position = "relative";
    el.style.zIndex = "10000000";
  }

  function onDialogFound(dialog) {
    managedDialog = dialog;
    promoteDialogAboveOverlay(dialog);
    showSelectionBanner();

    dialog.addEventListener("click", onDialogClick, true);
    dialog.addEventListener("keydown", onDialogKeyDown, true);

    injectCheckboxes(dialog);

    contentObserver = new MutationObserver(() => injectCheckboxes(dialog));
    contentObserver.observe(dialog, { childList: true, subtree: true });
  }

  function onDialogKeyDown(e) {
    if (e.key !== "Enter") return;
    const tag = e.target.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || e.target.isContentEditable) return;
    if (selectedEnrichments.size === 0) return;
    e.preventDefault();
    e.stopPropagation();
    finishPicker();
  }

  function findEnrichmentName(row) {
    const primary = row.querySelector('p[data-slot="text"]');
    if (primary) return primary.textContent.trim();

    const contentDiv = row.querySelector('div.flex.min-w-0');
    if (contentDiv) {
      const p = contentDiv.querySelector("p");
      if (p) return p.textContent.trim();
      const span = contentDiv.querySelector("span");
      if (span) return span.textContent.trim();
    }

    return null;
  }

  function injectCheckboxes(dialog) {
    const rows = dialog.querySelectorAll('[role="button"], button:has(div.flex.min-w-0)');

    for (const row of rows) {
      if (row.hasAttribute("data-cb-item")) continue;
      if (row.closest(".cb-selection-banner")) continue;

      const name = findEnrichmentName(row);
      if (!name || name.length < 2) continue;

      row.setAttribute("data-cb-item", name);

      const wrap = document.createElement("div");
      wrap.className = "cb-check-wrap";

      const input = document.createElement("input");
      input.type = "checkbox";
      input.className = "cb-check-input";
      input.checked = selectedEnrichments.has(name);

      input.addEventListener("click", (e) => e.stopPropagation());
      input.addEventListener("change", (e) => {
        e.stopPropagation();
        toggleSelection(name, input.checked, row);
      });

      wrap.appendChild(input);
      row.insertBefore(wrap, row.firstChild);

      if (selectedEnrichments.has(name)) {
        row.classList.add("cb-item-checked");
      }
    }

    for (const row of dialog.querySelectorAll("[data-cb-item]")) {
      const name = row.getAttribute("data-cb-item");
      const input = row.querySelector(".cb-check-input");
      if (input) input.checked = selectedEnrichments.has(name);
    }
  }

  function onDialogClick(e) {
    if (e.target.closest(".cb-check-wrap")) return;
    if (e.target.closest('[aria-label="Add to favorites"]')) return;
    if (e.target.closest('[aria-label="Remove from favorites"]')) return;

    const row = e.target.closest('[data-cb-item]');
    if (!row) return;

    e.stopPropagation();
    e.preventDefault();

    const name = row.getAttribute("data-cb-item");
    const input = row.querySelector(".cb-check-input");
    if (!input) return;

    input.checked = !input.checked;
    toggleSelection(name, input.checked, row);
  }

  // True when the action can ONLY be used with the user's own key
  // (either disableSharedKey or requiresApiKey is set). For these actions
  // the catalog `credits` field is misleading — Clay charges
  // `usesPrivateKeyCredits.basic` (usually 0) when the user brings a
  // key, which is the only way they can be invoked. Mirrors
  // checkRequiresCredentials in libs/shared/src/credits/credit-cost-utils.ts.
  function isKeyOnlyEntry(entry) {
    return !!entry && (entry.requiresApiKey || entry.disableSharedKey);
  }

  // Builds the provider entry for a resolved catalog action, honoring
  // key-only pricing: when the action requires the user's own key, the
  // effective per-row cost is `privateKeyCredits` (usually 0), and we
  // seed `usePrivateKey: true` so the credit pill renders in key mode
  // by default. Shared by all three resolvers below so they stay
  // consistent.
  function providerFromEntry(entry) {
    const keyOnly = isKeyOnlyEntry(entry);
    const credits = keyOnly
      ? (entry.privateKeyCredits ?? 0)
      : (entry.credits ?? null);
    return {
      actionKey: entry.key,
      packageId: entry.packageId,
      displayName: entry.displayName,
      packageName: entry.packageName,
      iconUrl: entry.iconUrl,
      credits,
      creditText: credits != null ? `${credits} / row` : null,
      isAi: !!entry.isAi,
      modelOptions: entry.modelOptions ?? null,
      requiresApiKey: !!entry.requiresApiKey,
      disableSharedKey: !!entry.disableSharedKey,
      keyOnly,
      // Auto-flip to private-key mode for key-only actions so the
      // averageCost math zeroes their contribution (per
      // deriveWaterfallTotals' handling of usePrivateKey).
      usePrivateKey: keyOnly,
    };
  }

  // Resolve a list of action IDs (Clay's `${packageId}/${actionKey}` format)
  // against the cached actionByIdLookup. Anything that doesn't resolve is
  // dropped — without action metadata we have no credits / icon and can't
  // render a useful provider row.
  function resolveActionIdsToProviders(actionIds) {
    const providers = [];
    for (const id of actionIds || []) {
      if (!id) continue;
      const entry = __cb.actionByIdLookup?.[id];
      if (!entry) continue;
      providers.push(providerFromEntry(entry));
    }
    return providers;
  }

  // Same idea, but for waterfall preset configs which carry
  // (actionPackageId, actionKey) tuples instead of pre-built action IDs.
  // Filters out FormulaConfig steps — only Action_Config steps map to
  // a billable provider; formula steps don't have a cost.
  function resolveWaterfallConfigsToProviders(waterfallConfigs) {
    const providers = [];
    for (const cfg of waterfallConfigs || []) {
      if (!cfg) continue;
      const isAction = cfg.type === "actionConfig" || cfg.type === undefined;
      if (!isAction) continue;
      if (!cfg.actionKey || !cfg.actionPackageId) continue;
      const id = `${cfg.actionPackageId}-${cfg.actionKey}`;
      const entry = __cb.actionByIdLookup?.[id];
      if (!entry) continue;
      providers.push(providerFromEntry(entry));
    }
    return providers;
  }

  // Looks up the validation provider list for an attribute and returns
  // both the default (price/name/requiresApiKey from the first option)
  // AND the full list of options for the popover dropdown. Mirrors
  // getValidationPriceFromAttribute in apps/frontend/src/hooks/credits/attributes.ts:
  // the picker's WaterfallRow defaults to the first validation provider
  // and exposes the full list as a swap-out menu.
  function getValidationInfoForAttribute(wfMeta) {
    const ids = wfMeta?.validationProviderActionIds
      ?? (wfMeta?.validationProviderActionId ? [wfMeta.validationProviderActionId] : []);
    if (!ids || ids.length === 0) {
      return { price: 0, name: null, requiresApiKey: false, options: [], selectedActionId: null };
    }
    const options = [];
    for (const id of ids) {
      const entry = __cb.actionByIdLookup?.[id];
      if (!entry) continue;
      const keyOnly = isKeyOnlyEntry(entry);
      const credits = keyOnly
        ? (entry.privateKeyCredits ?? 0)
        : (typeof entry.credits === "number" ? entry.credits : 0);
      options.push({
        actionId: id,
        name: entry.packageName || entry.displayName || null,
        actionName: entry.displayName || null,
        packageName: entry.packageName || null,
        iconUrl: entry.iconUrl || null,
        credits,
        requiresApiKey: !!entry.requiresApiKey,
        disableSharedKey: !!entry.disableSharedKey,
        keyOnly,
      });
    }
    const first = options[0];
    return {
      price: first?.credits ?? 0,
      name: first?.name ?? null,
      requiresApiKey: !!first?.requiresApiKey,
      options,
      selectedActionId: first?.actionId ?? null,
    };
  }
  // Exposed so table-import.js can pre-fill the validation row on
  // imported waterfall cards using the same options-resolution logic
  // the picker uses.
  __cb.getValidationInfoForAttribute = getValidationInfoForAttribute;

  function extractVisualData(row, name) {
    const lname = name.toLowerCase();

    // ---- Waterfall detection (presets first, then built-ins) ----
    //
    // Waterfall presets can shadow built-in attribute names (e.g. a saved
    // "Find Email" preset that customizes the default chain). We check
    // presets first so the user's customization wins.
    //
    // For each match, we resolve the provider chain through actionByIdLookup
    // and emit a waterfall card via buildWaterfallCardData. If resolution
    // produces zero providers (action catalog hasn't loaded, or all entries
    // are unknown), we fall through to the standard action-card path so the
    // user still gets something on the canvas.
    const presetMeta = __cb.waterfallPresetByName?.[lname];
    if (presetMeta) {
      const providers = resolveWaterfallConfigsToProviders(presetMeta.waterfallConfigs);
      if (providers.length > 0) {
        const builtInForValidation =
          presetMeta.attributeEnum
            ? Object.values(__cb.waterfallByName || {}).find(
                (w) => w.attributeEnum === presetMeta.attributeEnum,
              )
            : null;
        const v = getValidationInfoForAttribute(builtInForValidation);
        return __cb.buildWaterfallCardData({
          displayName: presetMeta.displayName || name,
          providers,
          attributeEnum: presetMeta.attributeEnum,
          presetId: presetMeta.presetId,
          packageId: "clay",
          validationPrice: v.price,
          validationName: v.name,
          validationRequiresApiKey: v.requiresApiKey,
          validationOptions: v.options,
          validationProvider: v.selectedActionId,
          actionExecutions: 1,
        });
      }
    }

    const wfMeta = __cb.waterfallByName?.[lname];
    if (wfMeta && wfMeta.actionIds?.length > 0) {
      const providers = resolveActionIdsToProviders(wfMeta.actionIds);
      if (providers.length > 0) {
        const v = getValidationInfoForAttribute(wfMeta);
        return __cb.buildWaterfallCardData({
          displayName: wfMeta.displayName || name,
          providers,
          attributeEnum: wfMeta.attributeEnum,
          packageId: "clay",
          validationPrice: v.price,
          validationName: v.name,
          validationRequiresApiKey: v.requiresApiKey,
          validationOptions: v.options,
          validationProvider: v.selectedActionId,
          actionExecutions: 1,
        });
      }
    }

    // ---- Standard action-row path ----

    const apiMatch = __cb.enrichmentLookup[lname] || {};

    // Provider badges: badge elements use data-slot="badge" (stable attribute
    // from the Badge component). Provider badges have "+N" text; credit badges
    // have "~N / row" text.
    const badges = [];
    for (const badge of row.querySelectorAll('[data-slot="badge"]')) {
      const text = badge.textContent.trim();
      if (!/^\+\d+$/.test(text)) continue;
      const img = badge.querySelector('img');
      badges.push({ imgSrc: img?.src ?? null, text });
    }

    // Enrichment icon: lives inside the content area (div.flex.min-w-0),
    // NOT in row.children[0] which is a tooltip wrapper enclosing everything.
    const contentDiv = row.querySelector('div.flex.min-w-0');
    const iconImg = contentDiv?.querySelector('img') ?? null;
    const iconSvg = !iconImg ? (contentDiv?.querySelector('svg') ?? null) : null;
    const iconUrl = iconImg?.src ?? (badges.length === 0 ? apiMatch.iconUrl : null) ?? null;
    const iconSvgHtml = iconSvg ? iconSvg.outerHTML : null;

    const allText = row.innerText || "";
    const creditMatch = allText.match(/~?([\d.]+)\s*\/\s*row/);
    const creditText = creditMatch ? creditMatch[0] : null;

    const ai = apiMatch.isAi ?? __cb.isAiAction(apiMatch.key ?? "", name, apiMatch.packageId);
    const modelOptions = ai ? (apiMatch.modelOptions ?? __cb.getModelOptions()) : null;
    const defaultModelId = __cb.DEFAULT_AI_MODEL || "clay-argon";
    const selectedModel = ai && modelOptions
      ? (modelOptions.find(m => m.id === defaultModelId)?.id ?? modelOptions[0].id)
      : null;

    let requiresApiKey = apiMatch.requiresApiKey ?? false;
    if (!requiresApiKey) {
      for (const badge of row.querySelectorAll('[data-slot="badge"]')) {
        const svg = badge.querySelector("svg");
        if (svg && badge.classList.contains("text-text-blue")) { requiresApiKey = true; break; }
        const badgeText = badge.textContent.trim().toLowerCase();
        if (badgeText === "api" || badgeText === "key") { requiresApiKey = true; break; }
      }
    }

    // Key-only detection: when the action has disableSharedKey OR
    // requiresApiKey, Clay charges privateKeyCredits (usually 0) — the
    // public-key cost on apiMatch.credits is misleading. Default the
    // card to private-key mode and override the displayed credits.
    const keyOnly = isKeyOnlyEntry(apiMatch);
    let resolvedCredits = keyOnly
      ? (apiMatch.privateKeyCredits ?? 0)
      : (apiMatch.credits ?? (creditMatch ? parseFloat(creditMatch[1]) : null));
    let resolvedCreditText = keyOnly
      ? (resolvedCredits != null ? `${resolvedCredits} / row` : null)
      : creditText;

    let resolvedIconUrl = iconUrl;
    let resolvedIconSvgHtml = iconSvgHtml;
    if (ai && selectedModel) {
      const model = modelOptions?.find(m => m.id === selectedModel);
      if (model?.credits != null) {
        resolvedCredits = model.credits;
        resolvedCreditText = `~${model.credits} / row`;
      }
      if (model?.provider && __cb.AI_PROVIDER_ICONS?.[model.provider]) {
        resolvedIconUrl = __cb.AI_PROVIDER_ICONS[model.provider];
        resolvedIconSvgHtml = null;
      }
    }

    return {
      actionKey: apiMatch.key ?? name.toLowerCase().replace(/[^a-z0-9]+/g, "_"),
      packageId: apiMatch.packageId ?? "clay",
      displayName: name,
      packageName: apiMatch.packageName ?? "Clay",
      credits: resolvedCredits,
      actionExecutions: apiMatch.actionExecutions
        ?? __cb.waterfallExecByName[lname]
        ?? 1,
      iconUrl: resolvedIconUrl,
      iconSvgHtml: resolvedIconSvgHtml,
      creditText: resolvedCreditText,
      badges,
      isAi: ai,
      modelOptions,
      selectedModel,
      requiresApiKey,
      // Auto-flip to private-key mode for key-only catalog entries
      // (Debounce / Lead Magic / Enrow / etc.) so the card pill renders
      // blue and the credits sum to 0. Falls back to the existing
      // "requires key + no credits known" heuristic for actions whose
      // pricing isn't in the catalog.
      usePrivateKey: keyOnly || (requiresApiKey && resolvedCredits == null),
    };
  }

  function toggleSelection(name, checked, el) {
    if (checked) {
      selectedEnrichments.set(name, extractVisualData(el, name));
    } else {
      selectedEnrichments.delete(name);
    }
    el.classList.toggle("cb-item-checked", checked);
    updateSelectionCount();
  }

  // ---- Selection banner ----

  function showSelectionBanner() {
    if (selectionBanner) return;

    selectionBanner = document.createElement("div");
    selectionBanner.className = "cb-selection-banner";

    const cancelBtn = document.createElement("button");
    cancelBtn.className = "cb-banner-btn cb-banner-cancel";
    cancelBtn.textContent = "Cancel";
    cancelBtn.addEventListener("click", cancelPicker);

    const doneBtn = document.createElement("button");
    doneBtn.className = "cb-banner-btn cb-banner-done";
    doneBtn.textContent = "Add to Canvas";
    doneBtn.disabled = true;
    doneBtn.addEventListener("click", finishPicker);

    selectionBanner.appendChild(cancelBtn);
    selectionBanner.appendChild(doneBtn);
    if (managedDialog) {
      managedDialog.appendChild(selectionBanner);
    } else {
      document.body.appendChild(selectionBanner);
    }
  }

  function updateSelectionCount() {
    const n = selectedEnrichments.size;
    const doneBtn = selectionBanner?.querySelector(".cb-banner-done");
    if (doneBtn) {
      doneBtn.disabled = n === 0;
      doneBtn.textContent =
        n === 0 ? "Add to Canvas" : `Add ${n} to Canvas`;
    }
  }

  function cleanupPicker() {
    stopWatching();

    if (promotedPortal) {
      promotedPortal.style.zIndex = promotedPortalOriginalZIndex ?? "";
      promotedPortal.style.position = promotedPortalOriginalPosition ?? "";
      promotedPortal = null;
      promotedPortalOriginalZIndex = null;
      promotedPortalOriginalPosition = null;
    }

    if (managedDialog) {
      managedDialog.removeEventListener("click", onDialogClick, true);
      managedDialog.removeEventListener("keydown", onDialogKeyDown, true);
      managedDialog.removeAttribute("data-cb-managed");
      for (const wrap of managedDialog.querySelectorAll(".cb-check-wrap")) {
        wrap.remove();
      }
      for (const item of managedDialog.querySelectorAll("[data-cb-item]")) {
        item.removeAttribute("data-cb-item");
        item.classList.remove("cb-item-checked");
      }
      managedDialog = null;
    }

    if (selectionBanner) {
      selectionBanner.remove();
      selectionBanner = null;
    }
  }

  function closePicker() {
    if (managedDialog) {
      const closeBtn =
        managedDialog.querySelector('[aria-label="Close"]') ??
        managedDialog.querySelector("button:has(svg)");
      if (closeBtn) {
        closeBtn.click();
      } else {
        document.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "Escape",
            code: "Escape",
            bubbles: true,
          })
        );
      }
    }
  }

  function cancelPicker() {
    selectedEnrichments.clear();
    closePicker();
    cleanupPicker();
  }

  const CARD_W = 220;
  const CARD_H = 70;

  function placeCardsAdjacentTo(targetCardId, newCards) {
    const target = __cb.canvas.getCardById(targetCardId);
    if (!target) return;

    const tw = target.el.offsetWidth || CARD_W;
    const th = target.el.offsetHeight || CARD_H;
    const state = __cb.canvas.serialize();
    const allCards = state.cards || [];

    const sides = [
      { name: "right",  dx: tw, dy: 0,   stackDx: 0,  stackDy: CARD_H },
      { name: "bottom", dx: 0,  dy: th,  stackDx: CARD_W, stackDy: 0 },
      { name: "left",   dx: -CARD_W, dy: 0, stackDx: 0, stackDy: CARD_H },
      { name: "top",    dx: 0, dy: -CARD_H, stackDx: CARD_W, stackDy: 0 },
    ];

    let bestSide = sides[0];
    let bestOverlaps = Infinity;

    for (const side of sides) {
      let overlaps = 0;
      for (let i = 0; i < newCards.length; i++) {
        const nx = target.x + side.dx + i * side.stackDx;
        const ny = target.y + side.dy + i * side.stackDy;
        for (const c of allCards) {
          if (c.id === targetCardId) continue;
          const cw = CARD_W;
          const ch = CARD_H;
          if (nx < c.x + cw && nx + CARD_W > c.x && ny < c.y + ch && ny + CARD_H > c.y) {
            overlaps++;
          }
        }
      }
      if (overlaps < bestOverlaps) {
        bestOverlaps = overlaps;
        bestSide = side;
      }
    }

    for (let i = 0; i < newCards.length; i++) {
      const x = target.x + bestSide.dx + i * bestSide.stackDx;
      const y = target.y + bestSide.dy + i * bestSide.stackDy;
      __cb.canvas.addCard(newCards[i], { x, y });
    }

    if (__cb.canvas.refreshClusters) __cb.canvas.refreshClusters();
  }

  // Convert a picked enrichment's card data into a provider entry suitable
  // for pushing into a waterfall card's providers[]. Mirrors the shape
  // normalizeWaterfallProvider expects so recomputeWaterfallCardData can
  // immediately re-derive averageCost / maxCost.
  //
  // If the picked enrichment is itself a waterfall (built-in attribute or
  // workspace preset), we flatten its providers chain into the target —
  // adding "Find Email" as a step adds Apollo/ZeroBounce/etc., not a
  // nested waterfall.
  function pickedCardToProviders(picked) {
    if (!picked) return [];
    if (picked.type === "waterfall" && Array.isArray(picked.providers)) {
      return picked.providers.map((p) => ({ ...p }));
    }
    return [{
      actionKey: picked.actionKey,
      packageId: picked.packageId,
      displayName: picked.displayName,
      packageName: picked.packageName,
      iconUrl: picked.iconUrl,
      iconSvgHtml: picked.iconSvgHtml,
      credits: typeof picked.credits === "number" ? picked.credits : null,
      creditText: picked.creditText,
      isAi: !!picked.isAi,
      modelOptions: picked.modelOptions,
      selectedModel: picked.selectedModel,
      requiresApiKey: !!picked.requiresApiKey,
      // extractVisualData already auto-flips usePrivateKey for key-only
      // catalog entries; flow it through so the in-popover credit pill
      // renders blue and the provider's contribution to averageCost is 0.
      usePrivateKey: !!picked.usePrivateKey,
    }];
  }

  async function finishPicker() {
    const cards = [...selectedEnrichments.values()];
    closePicker();
    cleanupPicker();

    if (__cb.overlayEl) {
      // "Add to waterfall" mode: + button in the provider-chain popover
      // sets addToWaterfallCardId before calling startPickerMode. Picked
      // enrichments become providers in the target waterfall card; no new
      // canvas cards are created. Re-opens the popover after so the user
      // sees the additions in context.
      const addToCardId = __cb.addToWaterfallCardId;
      __cb.addToWaterfallCardId = null;
      if (addToCardId != null && __cb.canvas) {
        const target = __cb.canvas.getCardById(addToCardId);
        if (target?.data?.type === "waterfall") {
          for (const picked of cards) {
            for (const provider of pickedCardToProviders(picked)) {
              target.data.providers.push(provider);
            }
          }
          if (__cb.recomputeWaterfallCardData) __cb.recomputeWaterfallCardData(target.data);
          if (__cb.refreshWaterfallCardDom) __cb.refreshWaterfallCardDom(target);

          // Re-anchor the popover to the (refreshed) badge so the user can
          // see the new providers immediately. The badge element id is
          // stable (created during the original addCard render), so a
          // simple querySelector is enough.
          const anchor = target.el?.querySelector(".cb-card-badge-providers");
          if (anchor && __cb.showProviderChain) {
            __cb.showProviderChain(target, anchor);
          }
        }
        return;
      }

      const linkTargetId = __cb.linkTargetCardId;
      __cb.linkTargetCardId = null;
      const pos = __cb.enrichmentClickPos;
      __cb.enrichmentClickPos = null;

      if (linkTargetId && __cb.canvas) {
        placeCardsAdjacentTo(linkTargetId, cards);
      } else {
        for (let i = 0; i < cards.length; i++) {
          if (__cb.canvas) {
            if (pos) {
              __cb.canvas.addCard(cards[i], { x: pos.x, y: pos.y + i * 90 });
            } else {
              __cb.canvas.addCard(cards[i]);
            }
          }
        }
      }
    } else {
      __cb.tabStore = await __cb.loadTabs();
      __cb.openCanvas(cards);
    }
  }
})();
