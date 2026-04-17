(function () {
  "use strict";

  window.__cbCanvasModules = window.__cbCanvasModules || {};

  const CREDIT_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" fill="currentColor" viewBox="0 0 256 256"><path d="M207.58,63.84C186.85,53.48,159.33,48,128,48S69.15,53.48,48.42,63.84,16,88.78,16,104v48c0,15.22,11.82,29.85,32.42,40.16S96.67,208,128,208s58.85-5.48,79.58-15.84S240,167.22,240,152V104C240,88.78,228.18,74.15,207.58,63.84Z" opacity="0.2"/><path d="M128,64c62.64,0,96,23.23,96,40s-33.36,40-96,40-96-23.23-96-40S65.36,64,128,64Z"/></svg>';
  const KEY_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 256 256"><path fill="#3b82f6" d="M216.57,39.43A80,80,0,0,0,83.91,120.78L28.69,176A15.86,15.86,0,0,0,24,187.31V216a16,16,0,0,0,16,16H72a8,8,0,0,0,8-8V208H96a8,8,0,0,0,8-8V184h16a8,8,0,0,0,5.66-2.34l9.56-9.57A79.73,79.73,0,0,0,160,176h.1A80,80,0,0,0,216.57,39.43Z"/><path fill="#93c5fd" d="M224,98.1c-1.09,34.09-29.75,61.86-63.89,61.9H160a63.7,63.7,0,0,1-23.65-4.51,8,8,0,0,0-8.84,1.68L116.69,168H96a8,8,0,0,0-8,8v16H72a8,8,0,0,0-8,8v16H40V187.31l58.83-58.82a8,8,0,0,0,1.68-8.84A63.72,63.72,0,0,1,96,95.92c0-34.14,27.81-62.8,61.9-63.89A64,64,0,0,1,224,98.1ZM192,76a12,12,0,1,1-12-12A12,12,0,0,1,192,76Z"/></svg>';
  // Pie-slice icon for the Pro Mode fill-rate badge. Solid wedge = "filled
  // portion of a whole", which matches the semantic of fill rate.
  const FILL_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 256 256" fill="currentColor"><path d="M128 24a104 104 0 1 0 104 104A104 104 0 0 0 128 24Zm0 16a88 88 0 0 1 86.5 72H128Z"/></svg>';

  // Absolute last-resort fallback when the records input is empty. Phase 2
  // will override fillRate for table-imported DP cards using Clay's runstatus
  // endpoints; canvas-created cards use the logic below.
  const FALLBACK_FILL = 100;

  // Reads the summary bar's Records input and returns a non-negative integer
  // (0 if blank / unparseable). Declared outside the helper factory so it can
  // be called from anywhere in this IIFE.
  function readRecordsCount() {
    const input = document.getElementById("cb-records-input");
    if (!input) return 0;
    const parsed = parseInt((input.value || "").replace(/[^\d]/g, ""), 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  }

  // Default fillRate for a freshly created DP card: `records || 100` for both
  // numerator and denominator, which renders as 100% — the user's natural
  // starting point when planning a scope ("we expect all rows to fill").
  function buildDefaultFillRate() {
    const n = readRecordsCount() || FALLBACK_FILL;
    return { numerator: n, denominator: n };
  }

  function normalizeFillRate(raw) {
    if (!raw || typeof raw !== "object") return buildDefaultFillRate();
    const n = Number(raw.numerator);
    const d = Number(raw.denominator);
    const safeDen = Number.isFinite(d) && d > 0 ? d : FALLBACK_FILL;
    const safeNum = Number.isFinite(n) && n >= 0 ? n : safeDen;
    return { numerator: safeNum, denominator: safeDen };
  }

  function fillPercentText(fillRate) {
    if (!fillRate || !fillRate.denominator) return "—";
    const pct = (fillRate.numerator / fillRate.denominator) * 100;
    return `${Math.round(pct)}%`;
  }

  window.__cbCanvasModules.createCardHelpers = function createCardHelpers(deps) {
    const {
      cbRef,
      cardsRef,
      setCards,
      groupsRef,
      setGroups,
      selectedCardsRef,
      getGroupColorMenuGroupId,
      closeGroupColorMenu,
      canvasAreaRef,
      panRef,
      scaleRef,
      cardContainerRef,
      getNextCardId,
      ensureNextCardId,
      getCardById,
      selectCard,
      clearSelection,
      setDragState,
      showModelPicker,
      updateGroupBounds,
      notifySelection,
      notifyCreditTotal,
      notifyChange,
      getCardType,
      isOppositeType,
      showSelectionMenu,
      refreshClusters,
      updateGroupCredits,
      updateDpCosts,
    } = deps;

    const EDITABLE_PLACEHOLDERS = {
      dp: "Type data point\u2026",
      input: "Type input\u2026",
      comment: "Type comment\u2026",
    };

    function syncEditableText(card, textEl) {
      const value = textEl.textContent || "";
      card.data.text = value;
      card.data.displayName = value;
      const placeholder = EDITABLE_PLACEHOLDERS[card.data.type] || "Type\u2026";
      if (value) textEl.removeAttribute("data-placeholder");
      else textEl.setAttribute("data-placeholder", placeholder);
    }

    function syncDpText(card, textEl) {
      syncEditableText(card, textEl);
    }

    let keyToggleEl = null;
    let keyToggleBackdrop = null;

    function closeKeyToggle() {
      if (keyToggleEl) { keyToggleEl.remove(); keyToggleEl = null; }
      if (keyToggleBackdrop) { keyToggleBackdrop.remove(); keyToggleBackdrop = null; }
    }

    function showKeyToggle(card, anchorEl, renderCreditMode, renderKeyMode) {
      closeKeyToggle();

      keyToggleBackdrop = document.createElement("div");
      keyToggleBackdrop.style.cssText = "position:fixed;inset:0;z-index:9999998;";
      keyToggleBackdrop.addEventListener("mousedown", (e) => {
        e.stopPropagation();
        closeKeyToggle();
      });

      keyToggleEl = document.createElement("div");
      keyToggleEl.className = "cb-key-toggle";
      keyToggleEl.addEventListener("mousedown", (e) => e.stopPropagation());

      const isKeyMode = !!card.data.usePrivateKey;

      const option = document.createElement("button");
      option.className = "cb-key-toggle-option";
      option.type = "button";

      if (isKeyMode) {
        option.innerHTML = '<span style="color:#059669;display:flex">' + CREDIT_SVG + "</span><span>Use Clay credits</span>";
      } else {
        option.innerHTML = KEY_SVG + "<span>Use private key</span>";
      }

      option.addEventListener("click", (e) => {
        e.stopPropagation();
        closeKeyToggle();

        if (isKeyMode) {
          card.data.usePrivateKey = false;
          if (card.data._originalCredits != null) {
            card.data.credits = card.data._originalCredits;
            card.data.creditText = `~${card.data._originalCredits} / row`;
          }
          renderCreditMode();
        } else {
          card.data._originalCredits = card.data.credits;
          card.data.usePrivateKey = true;
          renderKeyMode();
        }

        notifyCreditTotal();
        if (updateGroupCredits) updateGroupCredits();
        if (updateDpCosts) updateDpCosts();
        notifyChange();
        if (window.__cb.saveTabs) window.__cb.saveTabs();
      });

      keyToggleEl.appendChild(option);
      document.body.appendChild(keyToggleBackdrop);
      document.body.appendChild(keyToggleEl);

      const rect = anchorEl.getBoundingClientRect();
      keyToggleEl.style.position = "fixed";
      keyToggleEl.style.top = (rect.bottom + 4) + "px";
      keyToggleEl.style.left = rect.left + "px";
      keyToggleEl.style.zIndex = "9999999";
    }

    let fillPopoverEl = null;
    let fillPopoverBackdrop = null;

    function closeFillPopover() {
      if (fillPopoverEl) { fillPopoverEl.remove(); fillPopoverEl = null; }
      if (fillPopoverBackdrop) { fillPopoverBackdrop.remove(); fillPopoverBackdrop = null; }
    }

    function showFillRatePopover(card, anchorEl, labelEl) {
      closeFillPopover();

      // Full-viewport backdrop: catches outside clicks to close, but doesn't
      // block events inside the popover (z-index ordering + stopPropagation
      // on the popover handle that).
      fillPopoverBackdrop = document.createElement("div");
      fillPopoverBackdrop.style.cssText = "position:fixed;inset:0;z-index:9999998;";
      fillPopoverBackdrop.addEventListener("mousedown", (evt) => {
        evt.stopPropagation();
        closeFillPopover();
      });

      fillPopoverEl = document.createElement("div");
      fillPopoverEl.className = "cb-dp-fill-popover";
      // Stop drag from starting and prevent the backdrop from closing when
      // the user clicks inside the popover (e.g. focusing an input).
      fillPopoverEl.addEventListener("mousedown", (evt) => evt.stopPropagation());

      const title = document.createElement("div");
      title.className = "cb-dp-fill-popover-title";
      title.textContent = "Fill rate";
      fillPopoverEl.appendChild(title);

      const ratio = document.createElement("div");
      ratio.className = "cb-dp-fill-ratio";

      const numInput = document.createElement("input");
      numInput.type = "number";
      numInput.min = "0";
      numInput.step = "1";
      numInput.className = "cb-dp-fill-input";
      numInput.value = String(card.data.fillRate.numerator);

      const sep = document.createElement("span");
      sep.className = "cb-dp-fill-sep";
      sep.textContent = "/";

      const denInput = document.createElement("input");
      denInput.type = "number";
      denInput.min = "1";
      denInput.step = "1";
      denInput.className = "cb-dp-fill-input";
      denInput.value = String(card.data.fillRate.denominator);

      ratio.appendChild(numInput);
      ratio.appendChild(sep);
      ratio.appendChild(denInput);
      fillPopoverEl.appendChild(ratio);

      const pctLabel = document.createElement("div");
      pctLabel.className = "cb-dp-fill-pct";
      pctLabel.textContent = fillPercentText(card.data.fillRate);
      fillPopoverEl.appendChild(pctLabel);

      const hint = document.createElement("div");
      hint.className = "cb-dp-fill-hint";
      hint.textContent = "Results found / rows that ran";
      fillPopoverEl.appendChild(hint);

      function commit() {
        // Re-normalize on every edit so we never persist invalid values.
        // Empty input yields NaN → normalizeFillRate falls back to defaults.
        const next = normalizeFillRate({
          numerator: numInput.value === "" ? NaN : Number(numInput.value),
          denominator: denInput.value === "" ? NaN : Number(denInput.value),
        });
        card.data.fillRate = next;
        // The user opened the popover and typed a value — lock this card so
        // the records input's live-update no longer rewrites it.
        card.data.fillRateCustom = true;
        const text = fillPercentText(next);
        pctLabel.textContent = text;
        if (labelEl) labelEl.textContent = text;
        notifyChange();
        if (window.__cb.saveTabs) window.__cb.saveTabs();
      }

      numInput.addEventListener("input", commit);
      denInput.addEventListener("input", commit);

      // Close on Escape, blur on Enter (mirrors the canvas's other inline
      // editors). Use keydown so we can preventDefault on Enter to stop
      // accidental form-submit-like behavior in some browsers.
      function onKey(evt) {
        if (evt.key === "Escape") closeFillPopover();
        if (evt.key === "Enter") {
          evt.preventDefault();
          closeFillPopover();
        }
      }
      numInput.addEventListener("keydown", onKey);
      denInput.addEventListener("keydown", onKey);

      document.body.appendChild(fillPopoverBackdrop);
      document.body.appendChild(fillPopoverEl);

      // Anchor below the badge, left-aligned with it. Use fixed positioning
      // because the popover lives at document.body level (outside the
      // canvas's pan/zoom transform).
      const rect = anchorEl.getBoundingClientRect();
      fillPopoverEl.style.position = "fixed";
      fillPopoverEl.style.top = (rect.bottom + 6) + "px";
      fillPopoverEl.style.left = rect.left + "px";
      fillPopoverEl.style.zIndex = "9999999";

      numInput.focus();
      numInput.select();
    }

    function handleCardDblClick(card, evt) {
      evt.stopPropagation();
      const cb = cbRef();
      if (!cb.canvas) return;
      const tool = cb.canvas.getActiveTool();
      const type = getCardType(card);

      if (tool === "er" && type !== "er") {
        cb.linkTargetCardId = card.id;
        if (cb.onEnrichmentToolClick) cb.onEnrichmentToolClick(null, null);
      } else if (tool === "dp" && type === "er") {
        cb.linkTargetCardId = card.id;
        if (cb.onDpBulkInputForCard) cb.onDpBulkInputForCard(card.id);
      }
    }

    function startCardMouseInteraction(card, e) {
      if (e.button !== 0) return;
      e.stopPropagation();

      if (!e.shiftKey && !e.ctrlKey && !e.metaKey && !selectedCardsRef().has(card.id)) clearSelection();
      selectCard(card.id);
      const dragState = {
        cardId: card.id,
        startMouseX: e.clientX,
        startMouseY: e.clientY,
        startPositions: new Map(),
        hasMoved: false,
        connectPickOnly: false,
      };
      for (const cid of selectedCardsRef()) {
        const cc = cardsRef().find((c) => c.id === cid);
        if (cc) dragState.startPositions.set(cid, { x: cc.x, y: cc.y });
      }
      setDragState(dragState);
    }

    function addCard(data, opts) {
      let x;
      let y;
      let id;
      if (opts && opts.x !== undefined) {
        x = opts.x;
        y = opts.y;
        id = opts.id ?? getNextCardId();
      } else {
        const COLS = 4;
        const H_GAP = 230;
        const V_GAP = 120;
        const areaRect = canvasAreaRef().getBoundingClientRect();
        const cx = (areaRect.width / 2 - panRef().panX) / scaleRef();
        const cy = (areaRect.height / 2 - panRef().panY) / scaleRef();
        const col = cardsRef().length % COLS;
        const row = Math.floor(cardsRef().length / COLS);
        x = cx - ((COLS - 1) * H_GAP) / 2 + col * H_GAP;
        y = cy - 35 + row * V_GAP;
        id = getNextCardId();
      }
      ensureNextCardId(id);

      const card = { id, x, y, data, el: null, handles: {}, groupId: null };
      const el = document.createElement("div");
      el.className = "cb-card";
      el.setAttribute("data-card-id", card.id);
      el.style.transform = `translate(${x}px, ${y}px)`;

      const del = document.createElement("button");
      del.className = "cb-card-delete";
      del.innerHTML = "&#x2715;";
      del.addEventListener("mousedown", (evt) => evt.stopPropagation());
      del.addEventListener("click", (evt) => {
        evt.stopPropagation();
        removeCard(card.id);
      });
      el.appendChild(del);

      const row_ = document.createElement("div");
      row_.className = "cb-card-row";
      const icon = document.createElement("span");
      icon.className = "cb-card-icon";
      if (data.iconUrl) {
        const img = document.createElement("img");
        img.src = data.iconUrl;
        img.alt = "";
        img.className = "cb-card-icon-img";
        img.onerror = () => {
          img.remove();
          icon.textContent = (data.packageName || "C").charAt(0).toUpperCase();
        };
        icon.appendChild(img);
      } else if (data.iconSvgHtml) {
        icon.innerHTML = data.iconSvgHtml;
        icon.querySelector("svg")?.setAttribute("class", "cb-card-icon-svg");
      } else {
        const color = cbRef().stringToColor(data.packageName || "Clay");
        icon.style.backgroundColor = color + "18";
        icon.style.color = color;
        icon.textContent = (data.packageName || "C").charAt(0).toUpperCase();
      }
      const name = document.createElement("span");
      name.className = "cb-card-name" + (data.isAi ? " cb-card-name-editable" : "");
      name.textContent = data.displayName;
      if (data.isAi) {
        name.contentEditable = "true";
        name.spellcheck = false;
        name.addEventListener("mousedown", (evt) => evt.stopPropagation());
        name.addEventListener("input", () => {
          data.displayName = name.textContent || "";
          notifyChange();
        });
        name.addEventListener("keydown", (evt) => {
          if (evt.key === "Enter" && !evt.shiftKey) {
            evt.preventDefault();
            name.blur();
          }
        });
      }
      row_.appendChild(icon);
      row_.appendChild(name);

      const badgeRow = document.createElement("div");
      badgeRow.className = "cb-card-badges";
      if (data.badges && data.badges.length > 0) {
        for (const b of data.badges) {
          const badge = document.createElement("span");
          badge.className = "cb-card-badge";
          if (b.imgSrc) {
            const bImg = document.createElement("img");
            bImg.src = b.imgSrc;
            bImg.alt = "";
            bImg.className = "cb-card-badge-img";
            badge.appendChild(bImg);
          }
          if (b.text) {
            const bText = document.createElement("span");
            bText.textContent = b.text;
            badge.appendChild(bText);
          }
          badgeRow.appendChild(badge);
        }
      }

      const hasCreditInfo = data.creditText || data.credits !== null;
      const canToggleKey = hasCreditInfo;

      if (hasCreditInfo || data.usePrivateKey || data.requiresApiKey) {
        const costBadge = document.createElement("span");
        costBadge.style.position = "relative";

        function renderCreditMode() {
          costBadge.className = "cb-card-badge cb-card-badge-credit" + (canToggleKey ? " cb-card-badge-toggleable" : "");
          costBadge.innerHTML = CREDIT_SVG;
          const cText = document.createElement("span");
          cText.textContent = data.creditText || (data.credits != null ? `~${data.credits} / row` : "");
          costBadge.appendChild(cText);
        }

        function renderKeyMode() {
          costBadge.className = "cb-card-badge cb-card-badge-key";
          costBadge.innerHTML = KEY_SVG;
          const kText = document.createElement("span");
          kText.textContent = "Private key";
          costBadge.appendChild(kText);
        }

        const defaultToKey = data.usePrivateKey || (data.requiresApiKey && !hasCreditInfo);
        if (defaultToKey) {
          data.usePrivateKey = true;
          if (!data._originalCredits && data.credits != null) data._originalCredits = data.credits;
          renderKeyMode();
        } else {
          renderCreditMode();
        }

        if (canToggleKey) {
          costBadge.addEventListener("mousedown", (evt) => evt.stopPropagation());
          costBadge.addEventListener("click", (evt) => {
            evt.stopPropagation();
            showKeyToggle(card, costBadge, renderCreditMode, renderKeyMode);
          });
        }

        badgeRow.appendChild(costBadge);
      }

      if (data.isAi && data.modelOptions && data.modelOptions.length > 0) {
        const selected = data.modelOptions.find((m) => m.id === data.selectedModel) || data.modelOptions[0];
        const chip = document.createElement("button");
        chip.className = "cb-model-chip";
        chip.type = "button";
        chip.innerHTML =
          `<span class="cb-model-chip-name">${selected.name}</span>` +
          '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>';
        chip.addEventListener("mousedown", (evt) => evt.stopPropagation());
        chip.addEventListener("click", (evt) => {
          evt.stopPropagation();
          showModelPicker(card, chip);
        });
        badgeRow.appendChild(chip);
      }

      el.appendChild(row_);
      el.appendChild(badgeRow);

      el.addEventListener("contextmenu", (evt) => {
        evt.preventDefault();
        evt.stopPropagation();
        if (selectedCardsRef().size >= 2 && selectedCardsRef().has(card.id)) {
          showSelectionMenu(evt);
          return;
        }
      });
      el.addEventListener("mousedown", (evt) => startCardMouseInteraction(card, evt));
      el.addEventListener("dblclick", (evt) => handleCardDblClick(card, evt));

      card.el = el;
      cardsRef().push(card);
      cardContainerRef().appendChild(el);
      notifyCreditTotal();
      notifyChange();
      return card;
    }

    function removeCard(id) {
      const card = cardsRef().find((c) => c.id === id);
      if (card) {
        card.el.remove();
        setCards(cardsRef().filter((c) => c.id !== id));
        selectedCardsRef().delete(id);
        for (const g of groupsRef()) g.cardIds.delete(id);
        setGroups(
          groupsRef().filter((g) => {
            if (g.cardIds.size < 2) {
              g.el.remove();
              return false;
            }
            return true;
          })
        );
        if (getGroupColorMenuGroupId() != null && !groupsRef().some((g) => g.id === getGroupColorMenuGroupId())) {
          closeGroupColorMenu();
        }
        updateGroupBounds();
      }

      refreshClusters();
      notifySelection();
      notifyCreditTotal();
      notifyChange();
    }

    function addDataPointCard(text, opts) {
      let x;
      let y;
      let id;
      if (opts && opts.x !== undefined) {
        x = opts.x;
        y = opts.y;
        id = opts.id ?? getNextCardId();
      } else {
        const areaRect = canvasAreaRef().getBoundingClientRect();
        x = (areaRect.width / 2 - panRef().panX) / scaleRef();
        y = (areaRect.height / 2 - panRef().panY) / scaleRef();
        id = getNextCardId();
      }
      ensureNextCardId(id);

      // `opts.fillRate` lets persistence/restore preserve the user's edited
      // value. New cards (no opts.fillRate) get a smart default of
      // `records / records` — i.e. 100% of the current records count, falling
      // back to 100/100 when the records input is empty.
      //
      // `fillRateCustom` tracks whether the user has explicitly set values in
      // the popover. When false, the card tracks the records input live (so
      // typing "1000" into records auto-updates unedited DP cards to 1000/1000).
      // Once the user commits a change in the popover, the flag flips to true
      // and we stop auto-updating that card.
      const fillRate = opts?.fillRate ? normalizeFillRate(opts.fillRate) : buildDefaultFillRate();
      const data = {
        type: "dp",
        text: text || "",
        displayName: text || "",
        fillRate,
        fillRateCustom: !!opts?.fillRateCustom,
      };
      const card = { id, x, y, data, el: null, handles: {}, groupId: null };

      const el = document.createElement("div");
      el.className = "cb-card cb-card-dp";
      el.setAttribute("data-card-id", card.id);
      el.style.transform = `translate(${x}px, ${y}px)`;

      const del = document.createElement("button");
      del.className = "cb-card-delete";
      del.innerHTML = "&#x2715;";
      del.addEventListener("mousedown", (evt) => evt.stopPropagation());
      del.addEventListener("click", (evt) => {
        evt.stopPropagation();
        removeCard(card.id);
      });
      el.appendChild(del);

      const row_ = document.createElement("div");
      row_.className = "cb-card-row";
      const icon = document.createElement("span");
      icon.className = "cb-card-icon";
      icon.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="cb-card-icon-svg"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>';
      row_.appendChild(icon);

      const textEl = document.createElement("span");
      textEl.className = "cb-dp-text";
      textEl.contentEditable = "true";
      textEl.spellcheck = false;
      textEl.textContent = text || "";
      if (!text) textEl.setAttribute("data-placeholder", "Type data point\u2026");
      textEl.addEventListener("input", () => {
        syncDpText(card, textEl);
        notifyChange();
      });
      textEl.addEventListener("mousedown", (evt) => evt.stopPropagation());
      textEl.addEventListener("keydown", (evt) => {
        if (evt.key === "Enter" && !evt.shiftKey) {
          evt.preventDefault();
          textEl.blur();
        }
      });
      row_.appendChild(textEl);
      el.appendChild(row_);

      // Footer row holds the "Not connected / ~N credits / row" pill on the
      // left and (in Pro Mode only) the editable fill-rate badge on the right.
      // The footer is always mounted; CSS hides .cb-dp-fill when the overlay
      // doesn't carry the [data-cb-pro-mode] attribute.
      const footer = document.createElement("div");
      footer.className = "cb-dp-footer";

      const costBar = document.createElement("div");
      costBar.className = "cb-dp-cost";
      costBar.innerHTML =
        '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" fill="currentColor" viewBox="0 0 256 256"><path d="M207.58,63.84C186.85,53.48,159.33,48,128,48S69.15,53.48,48.42,63.84,16,88.78,16,104v48c0,15.22,11.82,29.85,32.42,40.16S96.67,208,128,208s58.85-5.48,79.58-15.84S240,167.22,240,152V104C240,88.78,228.18,74.15,207.58,63.84Z" opacity="0.2"/><path d="M128,64c62.64,0,96,23.23,96,40s-33.36,40-96,40-96-23.23-96-40S65.36,64,128,64Z"/></svg><span>Not connected</span>';
      footer.appendChild(costBar);

      const fillBadge = document.createElement("button");
      fillBadge.className = "cb-dp-fill";
      fillBadge.type = "button";
      fillBadge.title = "Click to edit fill rate";
      const fillLabel = document.createElement("span");
      fillLabel.className = "cb-dp-fill-label";
      fillLabel.textContent = fillPercentText(card.data.fillRate);
      fillBadge.innerHTML = FILL_SVG;
      fillBadge.appendChild(fillLabel);
      // Stop propagation so clicking the badge doesn't start a card drag /
      // selection. mousedown matters because the canvas drag listener is on
      // mousedown, not click.
      fillBadge.addEventListener("mousedown", (evt) => evt.stopPropagation());
      fillBadge.addEventListener("click", (evt) => {
        evt.stopPropagation();
        showFillRatePopover(card, fillBadge, fillLabel);
      });
      footer.appendChild(fillBadge);

      el.appendChild(footer);

      el.addEventListener("contextmenu", (evt) => {
        evt.preventDefault();
        evt.stopPropagation();
        if (selectedCardsRef().size >= 2 && selectedCardsRef().has(card.id)) {
          showSelectionMenu(evt);
          return;
        }
      });
      el.addEventListener("mousedown", (evt) => startCardMouseInteraction(card, evt));
      el.addEventListener("dblclick", (evt) => handleCardDblClick(card, evt));

      card.el = el;
      cardsRef().push(card);
      cardContainerRef().appendChild(el);
      notifyChange();
      return card;
    }

    function addInputCard(text, opts) {
      let x, y, id;
      if (opts && opts.x !== undefined) {
        x = opts.x;
        y = opts.y;
        id = opts.id ?? getNextCardId();
      } else {
        const areaRect = canvasAreaRef().getBoundingClientRect();
        x = (areaRect.width / 2 - panRef().panX) / scaleRef();
        y = (areaRect.height / 2 - panRef().panY) / scaleRef();
        id = getNextCardId();
      }
      ensureNextCardId(id);

      const data = { type: "input", text: text || "", displayName: text || "" };
      const card = { id, x, y, data, el: null, handles: {}, groupId: null };

      const el = document.createElement("div");
      el.className = "cb-card cb-card-input";
      el.setAttribute("data-card-id", card.id);
      el.style.transform = `translate(${x}px, ${y}px)`;

      const del = document.createElement("button");
      del.className = "cb-card-delete";
      del.innerHTML = "&#x2715;";
      del.addEventListener("mousedown", (evt) => evt.stopPropagation());
      del.addEventListener("click", (evt) => {
        evt.stopPropagation();
        removeCard(card.id);
      });
      el.appendChild(del);

      const row_ = document.createElement("div");
      row_.className = "cb-card-row";
      const icon = document.createElement("span");
      icon.className = "cb-card-icon";
      icon.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="cb-card-icon-svg"><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><polyline points="10 17 15 12 10 7"/><line x1="15" y1="12" x2="3" y2="12"/></svg>';
      row_.appendChild(icon);

      const textEl = document.createElement("span");
      textEl.className = "cb-input-text";
      textEl.contentEditable = "true";
      textEl.spellcheck = false;
      textEl.textContent = text || "";
      if (!text) textEl.setAttribute("data-placeholder", "Type input\u2026");
      textEl.addEventListener("input", () => {
        syncEditableText(card, textEl);
        notifyChange();
      });
      textEl.addEventListener("mousedown", (evt) => evt.stopPropagation());
      textEl.addEventListener("keydown", (evt) => {
        if (evt.key === "Enter" && !evt.shiftKey) {
          evt.preventDefault();
          textEl.blur();
        }
      });
      row_.appendChild(textEl);
      el.appendChild(row_);

      el.addEventListener("contextmenu", (evt) => {
        evt.preventDefault();
        evt.stopPropagation();
        if (selectedCardsRef().size >= 2 && selectedCardsRef().has(card.id)) {
          showSelectionMenu(evt);
          return;
        }
      });
      el.addEventListener("mousedown", (evt) => startCardMouseInteraction(card, evt));
      el.addEventListener("dblclick", (evt) => handleCardDblClick(card, evt));

      card.el = el;
      cardsRef().push(card);
      cardContainerRef().appendChild(el);
      notifyChange();
      return card;
    }

    function addCommentCard(text, opts) {
      let x, y, id;
      if (opts && opts.x !== undefined) {
        x = opts.x;
        y = opts.y;
        id = opts.id ?? getNextCardId();
      } else {
        const areaRect = canvasAreaRef().getBoundingClientRect();
        x = (areaRect.width / 2 - panRef().panX) / scaleRef();
        y = (areaRect.height / 2 - panRef().panY) / scaleRef();
        id = getNextCardId();
      }
      ensureNextCardId(id);

      const data = { type: "comment", text: text || "", displayName: text || "" };
      const card = { id, x, y, data, el: null, handles: {}, groupId: null };

      const el = document.createElement("div");
      el.className = "cb-card cb-card-comment";
      el.setAttribute("data-card-id", card.id);
      el.style.transform = `translate(${x}px, ${y}px)`;

      const del = document.createElement("button");
      del.className = "cb-card-delete";
      del.innerHTML = "&#x2715;";
      del.addEventListener("mousedown", (evt) => evt.stopPropagation());
      del.addEventListener("click", (evt) => {
        evt.stopPropagation();
        removeCard(card.id);
      });
      el.appendChild(del);

      const row_ = document.createElement("div");
      row_.className = "cb-card-row";
      const icon = document.createElement("span");
      icon.className = "cb-card-icon";
      icon.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="cb-card-icon-svg"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';
      row_.appendChild(icon);

      const textEl = document.createElement("span");
      textEl.className = "cb-comment-text";
      textEl.contentEditable = "true";
      textEl.spellcheck = false;
      textEl.textContent = text || "";
      if (!text) textEl.setAttribute("data-placeholder", "Type comment\u2026");
      textEl.addEventListener("input", () => {
        syncEditableText(card, textEl);
        notifyChange();
      });
      textEl.addEventListener("mousedown", (evt) => evt.stopPropagation());
      textEl.addEventListener("keydown", (evt) => {
        if (evt.key === "Enter" && !evt.shiftKey) {
          evt.preventDefault();
          textEl.blur();
        }
      });
      row_.appendChild(textEl);
      el.appendChild(row_);

      el.addEventListener("contextmenu", (evt) => {
        evt.preventDefault();
        evt.stopPropagation();
        if (selectedCardsRef().size >= 2 && selectedCardsRef().has(card.id)) {
          showSelectionMenu(evt);
          return;
        }
      });
      el.addEventListener("mousedown", (evt) => startCardMouseInteraction(card, evt));
      el.addEventListener("dblclick", (evt) => handleCardDblClick(card, evt));

      card.el = el;
      cardsRef().push(card);
      cardContainerRef().appendChild(el);
      notifyChange();
      return card;
    }

    // Called whenever the summary bar's Records input changes. Walks every
    // DP card and, for those that haven't been customized, rewrites both the
    // numerator and denominator to the new records value (keeping 100%).
    // Custom cards are left alone — the user already expressed an opinion.
    function updateDefaultFillRates(recordsOrNull) {
      const next = Number.isFinite(recordsOrNull) && recordsOrNull > 0
        ? recordsOrNull
        : FALLBACK_FILL;
      for (const card of cardsRef()) {
        if (!card || card.data.type !== "dp") continue;
        if (card.data.fillRateCustom) continue;
        card.data.fillRate = { numerator: next, denominator: next };
        const labelEl = card.el?.querySelector(".cb-dp-fill-label");
        if (labelEl) labelEl.textContent = fillPercentText(card.data.fillRate);
      }
    }

    return {
      addCard,
      addDataPointCard,
      addInputCard,
      addCommentCard,
      removeCard,
      startCardMouseInteraction,
      syncDpText,
      updateDefaultFillRates,
    };
  };
})();
