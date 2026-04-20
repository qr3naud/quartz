(function () {
  "use strict";

  window.__cbCanvasModules = window.__cbCanvasModules || {};

  window.__cbCanvasModules.createUiHelpers = function createUiHelpers(deps) {
    const {
      addDataPointCard,
      addInputCard,
      cardContainerRef,
      canvasAreaRef,
      screenToCanvas,
      activeToolRef,
      interactionStateRef,
      notifyCreditTotal,
      updateGroupCredits,
      updateDpCosts,
      notifyChange,
      getCardById,
      serializeRef,
      refreshClusters,
    } = deps;

    let hoverPreviewEl = null;
    let bulkInputEl = null;
    let bulkCommitting = false;
    let modelPickerEl = null;
    let modelPickerBackdrop = null;

    function closeModelPicker() {
      if (modelPickerEl) {
        modelPickerEl.remove();
        modelPickerEl = null;
      }
      if (modelPickerBackdrop) {
        modelPickerBackdrop.remove();
        modelPickerBackdrop = null;
      }
    }

    function applyModel(card, model) {
      card.data.selectedModel = model.id;

      if (card.data.usePrivateKey) {
        card.data._originalCredits = model.credits;
      } else {
        card.data.credits = model.credits;
        card.data.creditText = model.credits != null ? `~${model.credits} / row` : null;

        const creditEl = card.el.querySelector(".cb-card-badge-credit");
        if (creditEl) {
          const textSpan = creditEl.querySelector("span");
          if (textSpan) textSpan.textContent = card.data.creditText || `~${card.data.credits} / row`;
        }
      }

      const chipName = card.el.querySelector(".cb-model-chip-name");
      if (chipName) chipName.textContent = model.name;

      if (card.data.isAi && model.provider && window.__cb.AI_PROVIDER_ICONS?.[model.provider]) {
        const iconEl = card.el.querySelector(".cb-card-icon");
        if (iconEl) {
          card.data.iconUrl = window.__cb.AI_PROVIDER_ICONS[model.provider];
          iconEl.innerHTML = "";
          const img = document.createElement("img");
          img.src = card.data.iconUrl;
          img.alt = "";
          img.className = "cb-card-icon-img";
          iconEl.appendChild(img);
        }
      }

      notifyCreditTotal();
      updateGroupCredits();
      updateDpCosts();
      notifyChange();
    }

    function showModelPicker(card, anchorEl) {
      closeModelPicker();
      if (!card.data.modelOptions) return;

      // Always pull fresh options so we have provider info even for
      // cards that were persisted before the provider field existed.
      const freshOptions = window.__cb.getModelOptions();
      card.data.modelOptions = freshOptions;

      const providers = new Map();
      for (const model of freshOptions) {
        const key = model.provider || "Other";
        if (!providers.has(key)) providers.set(key, []);
        providers.get(key).push(model);
      }

      const selectedProvider =
        freshOptions.find((m) => m.id === card.data.selectedModel)?.provider || null;

      modelPickerBackdrop = document.createElement("div");
      modelPickerBackdrop.className = "cb-model-picker-backdrop";
      modelPickerBackdrop.addEventListener("mousedown", (e) => {
        e.stopPropagation();
        closeModelPicker();
      });

      modelPickerEl = document.createElement("div");
      modelPickerEl.className = "cb-model-picker cb-model-picker-grouped";
      modelPickerEl.addEventListener("mousedown", (e) => e.stopPropagation());

      for (const [providerName, models] of providers) {
        const row = document.createElement("div");
        row.className = "cb-model-provider-row";
        if (providerName === selectedProvider) row.classList.add("cb-model-provider-active");

        const label = document.createElement("span");
        label.className = "cb-model-provider-name";
        label.textContent = providerName;

        const chevron = document.createElement("span");
        chevron.className = "cb-model-provider-chevron";
        chevron.innerHTML =
          '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 6 15 12 9 18"/></svg>';

        row.appendChild(label);
        row.appendChild(chevron);

        const sub = document.createElement("div");
        sub.className = "cb-model-submenu";
        const subInner = document.createElement("div");
        subInner.className = "cb-model-submenu-inner";

        for (const model of models) {
          const opt = document.createElement("button");
          opt.className = "cb-model-option";
          if (model.id === card.data.selectedModel) opt.classList.add("cb-model-option-active");
          opt.type = "button";

          const nameSpan = document.createElement("span");
          nameSpan.className = "cb-model-option-name";
          nameSpan.textContent = model.name;

          const costSpan = document.createElement("span");
          costSpan.className = "cb-model-option-cost";
          costSpan.textContent = model.credits != null ? `~${model.credits} / row` : "";

          opt.appendChild(nameSpan);
          opt.appendChild(costSpan);
          opt.addEventListener("click", (e) => {
            e.stopPropagation();
            applyModel(card, model);
            closeModelPicker();
          });

          subInner.appendChild(opt);
        }

        sub.appendChild(subInner);
        row.appendChild(sub);
        modelPickerEl.appendChild(row);
      }

      document.body.appendChild(modelPickerBackdrop);
      document.body.appendChild(modelPickerEl);

      const rect = anchorEl.getBoundingClientRect();
      modelPickerEl.style.top = rect.bottom + 4 + "px";
      modelPickerEl.style.left = rect.left + "px";
    }

    const CARD_W = 220;
    const CARD_H = 70;

    function placeDpsAdjacentTo(targetCardId, texts) {
      const target = getCardById(targetCardId);
      if (!target) return;

      const tw = target.el.offsetWidth || CARD_W;
      const th = target.el.offsetHeight || CARD_H;
      const state = serializeRef();
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
        for (let i = 0; i < texts.length; i++) {
          const nx = target.x + side.dx + i * side.stackDx;
          const ny = target.y + side.dy + i * side.stackDy;
          for (const c of allCards) {
            if (c.id === targetCardId) continue;
            if (nx < c.x + CARD_W && nx + CARD_W > c.x && ny < c.y + CARD_H && ny + CARD_H > c.y) {
              overlaps++;
            }
          }
        }
        if (overlaps < bestOverlaps) {
          bestOverlaps = overlaps;
          bestSide = side;
        }
      }

      for (let i = 0; i < texts.length; i++) {
        const x = target.x + bestSide.dx + i * bestSide.stackDx;
        const y = target.y + bestSide.dy + i * bestSide.stackDy;
        addDataPointCard(texts[i], { x, y });
      }

      if (refreshClusters) refreshClusters();
    }

    function showBulkInput(canvasX, canvasY, options) {
      // `type` chooses which card factory + placeholder to use. "dp" is the
      // original behavior (Shift+Click); "input" is the new Cmd+Shift+Click
      // bulk-input flow. Only these two are supported — anything else falls
      // back to "dp" so callers can't silently request an unsupported type.
      const type = options?.type === "input" ? "input" : "dp";
      removeBulkInput();

      const cardContainer = cardContainerRef();
      if (!cardContainer) return;

      const el = document.createElement("div");
      el.className = "cb-bulk-input";
      el.style.transform = `translate(${canvasX}px, ${canvasY}px)`;

      const textarea = document.createElement("textarea");
      textarea.className = "cb-bulk-textarea";
      textarea.placeholder = type === "input"
        ? "Type inputs, separated by commas..."
        : "Type data points, separated by commas...";
      textarea.rows = 4;
      textarea.addEventListener("mousedown", (e) => e.stopPropagation());

      function commit() {
        if (bulkCommitting) return;
        bulkCommitting = true;
        const raw = textarea.value.trim();
        removeBulkInput();
        bulkCommitting = false;
        if (!raw) return;

        const entries = raw
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s.length > 0);
        const unique = [...new Set(entries)];

        const linkTargetId = window.__cb.linkTargetCardId;
        window.__cb.linkTargetCardId = null;

        if (linkTargetId) {
          // ER-linked bulk is DP-only — that flow is only reachable from the
          // DP-double-clicks-ER gesture, which always seeds DP cards next to
          // the ER. Generalizing placeDpsAdjacentTo isn't needed for Cmd+Shift
          // since that never sets linkTargetCardId.
          placeDpsAdjacentTo(linkTargetId, unique);
        } else {
          const V_GAP = 80;
          const addFn = type === "input" ? addInputCard : addDataPointCard;
          for (let i = 0; i < unique.length; i++) {
            addFn(unique[i], { x: canvasX, y: canvasY + i * V_GAP });
          }
        }
      }

      textarea.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          commit();
        }
        if (e.key === "Escape") {
          bulkCommitting = true;
          removeBulkInput();
          bulkCommitting = false;
        }
      });
      textarea.addEventListener("blur", commit);

      el.appendChild(textarea);
      cardContainer.appendChild(el);
      bulkInputEl = el;
      requestAnimationFrame(() => textarea.focus());
    }

    function removeBulkInput() {
      if (bulkInputEl) {
        bulkInputEl.remove();
        bulkInputEl = null;
      }
    }

    function ensureHoverPreview() {
      if (hoverPreviewEl || !cardContainerRef()) return;
      hoverPreviewEl = document.createElement("div");
      hoverPreviewEl.className = "cb-hover-preview";
      hoverPreviewEl.setAttribute("aria-hidden", "true");
      cardContainerRef().appendChild(hoverPreviewEl);
    }

    function hideHoverPreview() {
      if (hoverPreviewEl) hoverPreviewEl.style.display = "none";
    }

    function isCreateToolActive() {
      const tool = activeToolRef();
      return tool === "dp" || tool === "er";
    }

    function updateHoverPreview({ clientX, clientY, metaKey, ctrlKey, altKey, shiftKey, target }) {
      if (!canvasAreaRef() || !cardContainerRef() || !isCreateToolActive()) {
        hideHoverPreview();
        return;
      }

      const interaction = interactionStateRef();
      if (
        interaction.dragState ||
        interaction.groupDragState ||
        interaction.panState ||
        interaction.selBoxState ||
        interaction.toolClickPending ||
        bulkInputEl
      ) {
        hideHoverPreview();
        return;
      }

      const editingText = cardContainerRef()?.querySelector(
        ".cb-dp-text:focus, .cb-input-text:focus, .cb-comment-text:focus, .cb-card-name:focus"
      );
      if (editingText) {
        hideHoverPreview();
        return;
      }

      const rect = canvasAreaRef().getBoundingClientRect();
      const insideCanvas =
        clientX >= rect.left &&
        clientX <= rect.right &&
        clientY >= rect.top &&
        clientY <= rect.bottom;

      if (!insideCanvas) {
        hideHoverPreview();
        return;
      }

      const overCard = target?.closest(".cb-card, .cb-group");
      if (overCard) {
        hideHoverPreview();
        return;
      }

      ensureHoverPreview();
      if (!hoverPreviewEl) return;

      const pt = screenToCanvas(clientX, clientY);
      const isDp = activeToolRef() === "dp";
      // Alt wins over Cmd/Ctrl (matches the click dispatch in index.js).
      // `isModCombo` is the Cmd-or-Ctrl-held-and-not-Alt state; Shift within
      // that state distinguishes bulk-input from plain-input.
      const isModCombo = (metaKey || ctrlKey) && !altKey;
      const isComment = isDp && altKey;
      const isBulkInput = isDp && isModCombo && shiftKey;
      const isInput = isDp && isModCombo && !shiftKey;
      const isBulkDp = isDp && !isModCombo && !altKey && shiftKey;
      const isPlainDp = isDp && !isInput && !isComment && !isBulkInput && !isBulkDp;

      // `cb-hover-preview-input` carries the rose color; `cb-hover-preview-bulk`
      // is a pure size modifier (wider, taller). Composing them gives us
      // rose-bulk (for bulk-input) without needing new CSS.
      hoverPreviewEl.classList.toggle("cb-hover-preview-dp", isPlainDp || isBulkDp);
      hoverPreviewEl.classList.toggle("cb-hover-preview-input", isInput || isBulkInput);
      hoverPreviewEl.classList.toggle("cb-hover-preview-comment", isComment);
      hoverPreviewEl.classList.toggle("cb-hover-preview-er", activeToolRef() === "er");
      hoverPreviewEl.classList.toggle("cb-hover-preview-bulk", isBulkDp || isBulkInput);

      let label = "";
      if (isComment) label = "Comment";
      else if (isBulkInput || isBulkDp) label = "Bulk";
      else if (isInput) label = "Input";
      else if (isPlainDp) label = "Data Point";
      else if (activeToolRef() === "er") label = "Enrichment";
      hoverPreviewEl.textContent = label;

      hoverPreviewEl.style.transform = `translate(${pt.x}px, ${pt.y}px)`;
      hoverPreviewEl.style.display = "flex";
    }

    function destroy() {
      closeModelPicker();
      removeBulkInput();
      if (hoverPreviewEl) {
        hoverPreviewEl.remove();
        hoverPreviewEl = null;
      }
    }

    return {
      closeModelPicker,
      showModelPicker,
      applyModel,
      showBulkInput,
      removeBulkInput,
      ensureHoverPreview,
      hideHoverPreview,
      updateHoverPreview,
      isCreateToolActive,
      destroy,
    };
  };
})();
