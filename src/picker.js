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

  __cb.buildWaterfallCardData = function buildWaterfallCardData({
    displayName,
    providers,
    attributeEnum = null,
    packageId = "clay",
    validationPrice = 0,
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

    const v = Number.isFinite(validationPrice) ? validationPrice : 0;
    const creditsList = norm.map((p) => (p.credits ?? 0) + v);
    const totalCost = creditsList.reduce((s, c) => s + c, 0);
    const averageCost = norm.length === 0
      ? 0
      : Math.round((totalCost / norm.length) * 10) / 10;
    const maxCost = norm.length === 0 ? 0 : Math.max(...creditsList);

    const requiresApiKey = norm.some((p) => p.requiresApiKey);
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
      credits: averageCost,
      creditText: averageCost > 0 ? `~${averageCost} / row (avg)` : null,
      averageCost,
      maxCost,
      validationPrice: v,
      actionExecutions,
      providers: norm,
      badges: buildBadgesFromProviders(norm),
      isAi: false,
      modelOptions: null,
      selectedModel: null,
      requiresApiKey,
      usePrivateKey: false,
      groupCluster,
      fieldId,
      tableId,
      viewId,
    };
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

  // Resolve a list of action IDs (Clay's `${packageId}-${actionKey}` format)
  // against the cached actionByIdLookup. Anything that doesn't resolve is
  // dropped — without action metadata we have no credits / icon and can't
  // render a useful provider row.
  function resolveActionIdsToProviders(actionIds) {
    const providers = [];
    for (const id of actionIds || []) {
      if (!id) continue;
      const entry = __cb.actionByIdLookup?.[id];
      if (!entry) continue;
      providers.push({
        actionKey: entry.key,
        packageId: entry.packageId,
        displayName: entry.displayName,
        packageName: entry.packageName,
        iconUrl: entry.iconUrl,
        credits: entry.credits ?? null,
        creditText: entry.credits != null ? `~${entry.credits} / row` : null,
        isAi: !!entry.isAi,
        modelOptions: entry.modelOptions ?? null,
        requiresApiKey: !!entry.requiresApiKey,
      });
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
      providers.push({
        actionKey: entry.key,
        packageId: entry.packageId,
        displayName: entry.displayName,
        packageName: entry.packageName,
        iconUrl: entry.iconUrl,
        credits: entry.credits ?? null,
        creditText: entry.credits != null ? `~${entry.credits} / row` : null,
        isAi: !!entry.isAi,
        modelOptions: entry.modelOptions ?? null,
        requiresApiKey: !!entry.requiresApiKey,
      });
    }
    return providers;
  }

  // Looks up the per-action validation cost for an attribute. Mirrors
  // getValidationPriceFromAttribute in apps/frontend/src/hooks/credits/attributes.ts:
  // the validation price is the cost of the FIRST action in
  // attribute.validationProviders, applied per provider step.
  function getValidationPriceForAttribute(wfMeta) {
    const id = wfMeta?.validationProviderActionId;
    if (!id) return 0;
    const entry = __cb.actionByIdLookup?.[id];
    return entry?.credits ?? 0;
  }

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
        return __cb.buildWaterfallCardData({
          displayName: presetMeta.displayName || name,
          providers,
          attributeEnum: presetMeta.attributeEnum,
          presetId: presetMeta.presetId,
          packageId: "clay",
          validationPrice: getValidationPriceForAttribute(builtInForValidation),
          actionExecutions: 1,
        });
      }
    }

    const wfMeta = __cb.waterfallByName?.[lname];
    if (wfMeta && wfMeta.actionIds?.length > 0) {
      const providers = resolveActionIdsToProviders(wfMeta.actionIds);
      if (providers.length > 0) {
        return __cb.buildWaterfallCardData({
          displayName: wfMeta.displayName || name,
          providers,
          attributeEnum: wfMeta.attributeEnum,
          packageId: "clay",
          validationPrice: getValidationPriceForAttribute(wfMeta),
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

    let resolvedCredits = apiMatch.credits ?? (creditMatch ? parseFloat(creditMatch[1]) : null);
    let resolvedCreditText = creditText;

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
      usePrivateKey: requiresApiKey && resolvedCredits == null,
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

  async function finishPicker() {
    const cards = [...selectedEnrichments.values()];
    closePicker();
    cleanupPicker();

    if (__cb.overlayEl) {
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
