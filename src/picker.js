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

  __cb.startPickerMode = function () {
    const ids = __cb.parseIdsFromUrl();
    if (!ids) {
      console.error("[Clay Scoping] Not on a Clay workbook page.");
      return;
    }

    selectedEnrichments.clear();
    Promise.all([
      __cb.fetchEnrichments(ids.workspaceId),
      __cb.fetchWaterfallExecCosts(),
    ]).catch((err) => console.error("[Clay Scoping] enrichment prefetch failed:", err));
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

  function extractVisualData(row, name) {
    const apiMatch = __cb.enrichmentLookup[name.toLowerCase()] || {};

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
        ?? __cb.waterfallExecByName[name.toLowerCase()]
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
