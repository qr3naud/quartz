(function () {
  "use strict";

  window.__cbCanvasModules = window.__cbCanvasModules || {};

  const CREDIT_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" fill="currentColor" viewBox="0 0 256 256"><path d="M207.58,63.84C186.85,53.48,159.33,48,128,48S69.15,53.48,48.42,63.84,16,88.78,16,104v48c0,15.22,11.82,29.85,32.42,40.16S96.67,208,128,208s58.85-5.48,79.58-15.84S240,167.22,240,152V104C240,88.78,228.18,74.15,207.58,63.84Z" opacity="0.2"/><path d="M128,64c62.64,0,96,23.23,96,40s-33.36,40-96,40-96-23.23-96-40S65.36,64,128,64Z"/></svg>';
  // Stacked-layers icon — matches the "Enrichments" tool icon in the
  // bottom toolbox (overlay.js erBtn). Used as the always-visible icon on
  // every waterfall card so the card type reads as "stack of providers"
  // at a glance, regardless of which providers are inside.
  const WATERFALL_ICON_SVG =
    '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="cb-card-icon-svg">' +
    '<path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>';
  const KEY_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 256 256"><path fill="#3b82f6" d="M216.57,39.43A80,80,0,0,0,83.91,120.78L28.69,176A15.86,15.86,0,0,0,24,187.31V216a16,16,0,0,0,16,16H72a8,8,0,0,0,8-8V208H96a8,8,0,0,0,8-8V184h16a8,8,0,0,0,5.66-2.34l9.56-9.57A79.73,79.73,0,0,0,160,176h.1A80,80,0,0,0,216.57,39.43Z"/><path fill="#93c5fd" d="M224,98.1c-1.09,34.09-29.75,61.86-63.89,61.9H160a63.7,63.7,0,0,1-23.65-4.51,8,8,0,0,0-8.84,1.68L116.69,168H96a8,8,0,0,0-8,8v16H72a8,8,0,0,0-8,8v16H40V187.31l58.83-58.82a8,8,0,0,0,1.68-8.84A63.72,63.72,0,0,1,96,95.92c0-34.14,27.81-62.8,61.9-63.89A64,64,0,0,1,224,98.1ZM192,76a12,12,0,1,1-12-12A12,12,0,0,1,192,76Z"/></svg>';
  // Pie-slice icon for the Pro Mode fill-rate badge. Solid wedge = "filled
  // portion of a whole", which matches the semantic of fill rate.
  const FILL_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 256 256" fill="currentColor"><path d="M128 24a104 104 0 1 0 104 104A104 104 0 0 0 128 24Zm0 16a88 88 0 0 1 86.5 72H128Z"/></svg>';
  // Donut icon for the coverage badge — visually communicates "% of a whole
  // that's been processed". Distinct from FILL_SVG (which is a single wedge)
  // so users can tell at a glance which pill they're looking at.
  const COVERAGE_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9" opacity="0.35"/><path d="M12 3a9 9 0 0 1 9 9"/></svg>';

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

  // Same shape, different field names. Coverage tracks how many records the
  // ER attempted vs the total in the view; fill rate tracks how many of those
  // attempts returned data. Both render as a single percentage on the card.
  function coveragePercentText(coverage) {
    if (!coverage || !coverage.total) return "\u2014";
    const pct = (coverage.ran / coverage.total) * 100;
    return `${Math.round(pct)}%`;
  }

  // Reusable helper for inputs in the new two-section popover. Number inputs
  // formatted with thousands separators get sticky in two ways: the popover
  // gets too narrow for big numbers and the user can't read what they typed.
  // Using `field-sizing: content` plus a comma-formatted text input lets the
  // input grow with content while staying readable for `1,234,567` inputs.
  function formatThousands(n) {
    if (!Number.isFinite(n)) return "";
    return Math.round(n).toLocaleString();
  }

  function parseThousands(str) {
    if (typeof str !== "string") return NaN;
    const cleaned = str.replace(/[^\d.-]/g, "");
    if (cleaned === "") return NaN;
    return Number(cleaned);
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
      getSnapClusters,
    } = deps;

    // Keep this predicate in sync with the identical one in credits.js —
    // "non-ER" means the card is not an enrichment and therefore doesn't
    // carry credits or a frequency.
    function isNonErType(type) {
      return type === "dp" || type === "input" || type === "comment";
    }

    // Writes the current frequency onto the DOM label inside a card. Called
    // both from the badge factory (initial render) and from the cluster /
    // global propagation helpers when the value changes elsewhere.
    function renderFreqLabel(card) {
      if (!card || !card.el) return;
      const label = card.el.querySelector(".cb-er-freq-label");
      if (!label) return;
      const cb = window.__cb;
      const effectiveId = card.data.frequencyCustom
        ? card.data.frequency
        : (card.data.frequency || cb.getCurrentFrequencyId());
      label.textContent = "\u00d7" + cb.getFrequencyMultiplier(effectiveId);
    }

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

    let cardMenuEl = null;
    let cardMenuBackdrop = null;

    function closeCardMenu() {
      if (cardMenuEl) { cardMenuEl.remove(); cardMenuEl = null; }
      if (cardMenuBackdrop) { cardMenuBackdrop.remove(); cardMenuBackdrop = null; }
    }

    // Single-card right-click menu. Only shown for cards that originated from
    // a table import (i.e. carry both `data.fieldId` and `data.tableId`) — the
    // sole option navigates Clay back to that column in its native grid.
    // Multi-select right-click still goes through the existing showSelectionMenu
    // (which has Group / Align actions); this helper is only invoked when
    // exactly one card is the right-click target.
    function showCardMenu(card, evt) {
      const data = card?.data;
      if (!data?.fieldId || !data?.tableId) return false;

      closeCardMenu();

      cardMenuBackdrop = document.createElement("div");
      cardMenuBackdrop.style.cssText = "position:fixed;inset:0;z-index:9999998;";
      cardMenuBackdrop.addEventListener("mousedown", (e) => {
        e.stopPropagation();
        closeCardMenu();
      });
      cardMenuBackdrop.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        e.stopPropagation();
        closeCardMenu();
      });

      cardMenuEl = document.createElement("div");
      cardMenuEl.className = "cb-card-context-menu";
      cardMenuEl.addEventListener("mousedown", (e) => e.stopPropagation());

      const openBtn = document.createElement("button");
      openBtn.type = "button";
      openBtn.className = "cb-card-context-menu-btn";
      openBtn.textContent = "Open in table";
      openBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        closeCardMenu();
        if (typeof window.__cb.openCardInTable === "function") {
          window.__cb.openCardInTable(card);
        }
      });
      cardMenuEl.appendChild(openBtn);

      document.body.appendChild(cardMenuBackdrop);
      document.body.appendChild(cardMenuEl);
      cardMenuEl.style.position = "fixed";
      cardMenuEl.style.left = evt.clientX + "px";
      cardMenuEl.style.top = evt.clientY + "px";
      cardMenuEl.style.zIndex = "9999999";
      return true;
    }

    let fillPopoverEl = null;
    let fillPopoverBackdrop = null;

    function closeFillPopover() {
      if (fillPopoverEl) { fillPopoverEl.remove(); fillPopoverEl = null; }
      if (fillPopoverBackdrop) { fillPopoverBackdrop.remove(); fillPopoverBackdrop = null; }
    }

    // Two-section popover: Coverage (top) and Fill rate (bottom). The same
    // popover opens from either pill — `focusSection` ("coverage" | "fill")
    // controls which input gets initial focus so clicking the coverage pill
    // doesn't bury the user inside the fill-rate inputs.
    function showFillRatePopover(card, anchorEl, labelEl, focusSection) {
      closeFillPopover();

      fillPopoverBackdrop = document.createElement("div");
      fillPopoverBackdrop.style.cssText = "position:fixed;inset:0;z-index:9999998;";
      fillPopoverBackdrop.addEventListener("mousedown", (evt) => {
        evt.stopPropagation();
        closeFillPopover();
      });

      fillPopoverEl = document.createElement("div");
      fillPopoverEl.className = "cb-dp-fill-popover";
      fillPopoverEl.addEventListener("mousedown", (evt) => evt.stopPropagation());

      // Source ribbon: "From runstatus" / "From dataProfile" / "Manual" — so
      // users know whether the numbers were filled by the import or typed in.
      const sourceLabel = card.data?.stats?.source
        ? (card.data.stats.source === "runstatus"
            ? "From run status"
            : card.data.stats.source === "dataProfile"
              ? "From data profile (sampled)"
              : "Manually edited")
        : null;

      // -- Coverage section ----------------------------------------------
      const cov = card.data?.stats?.coverage || null;
      const coverageRow = document.createElement("div");
      coverageRow.className = "cb-dp-fill-section";

      const coverageTitle = document.createElement("div");
      coverageTitle.className = "cb-dp-fill-popover-title";
      coverageTitle.textContent = "Coverage";
      coverageRow.appendChild(coverageTitle);

      const coverageRatio = document.createElement("div");
      coverageRatio.className = "cb-dp-fill-ratio";

      const covRanInput = document.createElement("input");
      covRanInput.type = "text";
      covRanInput.inputMode = "numeric";
      covRanInput.className = "cb-dp-fill-input";
      covRanInput.value = formatThousands(cov?.ran ?? 0);

      const covSep = document.createElement("span");
      covSep.className = "cb-dp-fill-sep";
      covSep.textContent = "/";

      const covTotalInput = document.createElement("input");
      covTotalInput.type = "text";
      covTotalInput.inputMode = "numeric";
      covTotalInput.className = "cb-dp-fill-input";
      covTotalInput.value = formatThousands(cov?.total ?? 0);

      coverageRatio.appendChild(covRanInput);
      coverageRatio.appendChild(covSep);
      coverageRatio.appendChild(covTotalInput);
      coverageRow.appendChild(coverageRatio);

      const covPctLabel = document.createElement("div");
      covPctLabel.className = "cb-dp-fill-pct";
      covPctLabel.textContent = coveragePercentText(cov || { ran: 0, total: 0 });
      coverageRow.appendChild(covPctLabel);

      const covHint = document.createElement("div");
      covHint.className = "cb-dp-fill-hint";
      covHint.textContent = "Records run / total records";
      coverageRow.appendChild(covHint);

      fillPopoverEl.appendChild(coverageRow);

      // -- Fill-rate section ---------------------------------------------
      const fillRow = document.createElement("div");
      fillRow.className = "cb-dp-fill-section";

      const fillTitle = document.createElement("div");
      fillTitle.className = "cb-dp-fill-popover-title";
      fillTitle.textContent = "Fill rate";
      fillRow.appendChild(fillTitle);

      const ratio = document.createElement("div");
      ratio.className = "cb-dp-fill-ratio";

      const numInput = document.createElement("input");
      numInput.type = "text";
      numInput.inputMode = "numeric";
      numInput.className = "cb-dp-fill-input";
      numInput.value = formatThousands(card.data.fillRate.numerator);

      const sep = document.createElement("span");
      sep.className = "cb-dp-fill-sep";
      sep.textContent = "/";

      const denInput = document.createElement("input");
      denInput.type = "text";
      denInput.inputMode = "numeric";
      denInput.className = "cb-dp-fill-input";
      denInput.value = formatThousands(card.data.fillRate.denominator);

      ratio.appendChild(numInput);
      ratio.appendChild(sep);
      ratio.appendChild(denInput);
      fillRow.appendChild(ratio);

      const pctLabel = document.createElement("div");
      pctLabel.className = "cb-dp-fill-pct";
      pctLabel.textContent = fillPercentText(card.data.fillRate);
      fillRow.appendChild(pctLabel);

      const hint = document.createElement("div");
      hint.className = "cb-dp-fill-hint";
      hint.textContent = "Results found / rows that ran";
      fillRow.appendChild(hint);

      fillPopoverEl.appendChild(fillRow);

      if (sourceLabel) {
        const src = document.createElement("div");
        src.className = "cb-dp-fill-source";
        src.textContent = sourceLabel;
        fillPopoverEl.appendChild(src);
      }

      function commitCoverage() {
        const ran = parseThousands(covRanInput.value);
        const total = parseThousands(covTotalInput.value);
        if (!Number.isFinite(ran) || !Number.isFinite(total) || total <= 0) return;
        card.data.stats = card.data.stats || {};
        card.data.stats.coverage = { ran: Math.max(0, ran), total: Math.max(1, total) };
        card.data.stats.source = "manual";
        covPctLabel.textContent = coveragePercentText(card.data.stats.coverage);
        const coverageEl = card.el?.querySelector(".cb-dp-coverage-label, .cb-er-coverage-label");
        if (coverageEl) coverageEl.textContent = covPctLabel.textContent;
        notifyChange();
        if (window.__cb.saveTabs) window.__cb.saveTabs();
      }

      function commitFill() {
        const next = normalizeFillRate({
          numerator: parseThousands(numInput.value),
          denominator: parseThousands(denInput.value),
        });
        card.data.fillRate = next;
        card.data.fillRateCustom = true;
        const text = fillPercentText(next);
        pctLabel.textContent = text;
        if (labelEl) labelEl.textContent = text;
        notifyChange();
        if (window.__cb.saveTabs) window.__cb.saveTabs();
      }

      // Re-format on blur so partial typing (e.g. "1234" mid-edit) doesn't
      // get clobbered with commas while the user is still in the field.
      function reformatOnBlur(input, valueGetter) {
        input.addEventListener("blur", () => {
          const v = valueGetter();
          if (Number.isFinite(v)) input.value = formatThousands(v);
        });
      }

      covRanInput.addEventListener("input", commitCoverage);
      covTotalInput.addEventListener("input", commitCoverage);
      reformatOnBlur(covRanInput, () => card.data?.stats?.coverage?.ran);
      reformatOnBlur(covTotalInput, () => card.data?.stats?.coverage?.total);

      numInput.addEventListener("input", commitFill);
      denInput.addEventListener("input", commitFill);
      reformatOnBlur(numInput, () => card.data.fillRate.numerator);
      reformatOnBlur(denInput, () => card.data.fillRate.denominator);

      function onKey(evt) {
        if (evt.key === "Escape") closeFillPopover();
        if (evt.key === "Enter") {
          evt.preventDefault();
          closeFillPopover();
        }
      }
      for (const input of [covRanInput, covTotalInput, numInput, denInput]) {
        input.addEventListener("keydown", onKey);
      }

      document.body.appendChild(fillPopoverBackdrop);
      document.body.appendChild(fillPopoverEl);

      // Anchor below the badge, left-aligned, but clamp to the viewport on
      // the right edge so the popover doesn't escape off-screen for badges
      // placed near the right side of the page.
      const rect = anchorEl.getBoundingClientRect();
      fillPopoverEl.style.position = "fixed";
      fillPopoverEl.style.top = (rect.bottom + 6) + "px";
      fillPopoverEl.style.zIndex = "9999999";
      // Force layout so we can read scrollWidth before computing left.
      fillPopoverEl.style.left = "0px";
      const popWidth = fillPopoverEl.offsetWidth;
      const maxLeft = window.innerWidth - popWidth - 8;
      fillPopoverEl.style.left = Math.max(8, Math.min(rect.left, maxLeft)) + "px";

      const focusInput = focusSection === "coverage" ? covRanInput : numInput;
      focusInput.focus();
      focusInput.select();
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

      // Seed frequency defaults on every ER-like card. Doing it here (instead
      // of at every call site in picker/table-import/etc.) means existing
      // state loaded from localStorage or Supabase automatically gets the
      // defaults if it was saved before the frequency feature shipped.
      if (!isNonErType(data.type)) {
        const cb = window.__cb;
        if (data.frequency == null) data.frequency = cb.getCurrentFrequencyId();
        if (data.frequencyCustom == null) data.frequencyCustom = false;
      }

      const card = { id, x, y, data, el: null, handles: {}, groupId: null };
      const el = document.createElement("div");
      el.className = "cb-card";
      el.setAttribute("data-card-id", card.id);
      if (data.groupCluster) el.setAttribute("data-group-cluster", data.groupCluster);
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
      if (data.type === "waterfall") {
        // Always render the same stacked-layers icon for every waterfall card,
        // matching the bottom-toolbox Enrichments tool. The provider chain's
        // own icons are still surfaced through the .cb-card-badge-providers
        // stack on the card and through the showProviderChain popover.
        icon.classList.add("cb-card-icon-waterfall");
        icon.innerHTML = WATERFALL_ICON_SVG;
      } else if (data.iconUrl) {
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
      const isEditableName = data.isAi || data.type === "waterfall";
      const name = document.createElement("span");
      name.className = "cb-card-name" + (isEditableName ? " cb-card-name-editable" : "");
      name.textContent = data.displayName;
      if (isEditableName) {
        // Waterfall and AI cards both let the user retitle in place. For
        // ad-hoc waterfalls created via Cmd+Enter the title starts empty so
        // the user can type it immediately; the contentEditable :empty::before
        // placeholder in cards.css covers that case.
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
      } else {
        // Non-editable ER names: only make them focusable when the text is
        // actually being truncated by line-clamp:1. Names that fit on one
        // line stay as plain spans so clicking falls through to the card's
        // selection/drag handler (matching the rest of the card surface).
        //
        // Deferred to rAF because `name` isn't in the DOM yet — the card
        // element is appended further down in addCard. rAF also batches
        // measurements across many cards into a single layout pass.
        requestAnimationFrame(() => {
          const isTruncated = name.scrollHeight > name.clientHeight + 1;
          if (!isTruncated) return;
          name.tabIndex = 0;
          name.classList.add("cb-card-name-truncated");
          name.addEventListener("mousedown", (evt) => evt.stopPropagation());
          name.addEventListener("keydown", (evt) => {
            if (evt.key === "Enter" || evt.key === "Escape") {
              evt.preventDefault();
              name.blur();
            }
          });
        });
      }
      row_.appendChild(icon);
      row_.appendChild(name);

      const badgeRow = document.createElement("div");
      badgeRow.className = "cb-card-badges";

      // Provider-icons row.
      //
      // For non-waterfall cards every entry in data.badges is rendered as its
      // own <span> badge — that's the existing picker behavior where each
      // badge is one provider icon segment.
      //
      // For waterfall cards we collapse them into a SINGLE clickable badge
      // (.cb-card-badge-providers) — a stack of dedup'd provider icons plus
      // the +N count — that opens the showProviderChain popover. This is the
      // clickable "list of providers + per-step costs" affordance the user
      // explicitly asked for.
      if (data.type === "waterfall") {
        // Always render the providers badge for waterfall cards — it's the
        // entry point to the popover where the user can add / reorder /
        // override credits, even when the chain is empty.
        const providerBadge = document.createElement("button");
        providerBadge.type = "button";
        providerBadge.className = "cb-card-badge cb-card-badge-providers";
        providerBadge.title = "Click to see the provider chain";

        // Provider-icon stack intentionally disabled — the bare "+N" reads
        // cleaner. Keeping the construction commented (not deleted) so we
        // can flip it back without re-deriving the icon stacking logic.
        //
        // const stack = document.createElement("span");
        // stack.className = "cb-card-badge-providers-stack";
        // // Cap the in-card icon stack at 3 to keep the badge compact even
        // // for long chains. The full chain (with names + costs) is always
        // // available in the showProviderChain popover anyway.
        // const MAX_STACK_ICONS = 3;
        // let stackCount = 0;
        // for (const b of data.badges) {
        //   if (!b.imgSrc) continue;
        //   if (stackCount >= MAX_STACK_ICONS) break;
        //   const bImg = document.createElement("img");
        //   bImg.src = b.imgSrc;
        //   bImg.alt = "";
        //   bImg.className = "cb-card-badge-img cb-card-badge-providers-img";
        //   stack.appendChild(bImg);
        //   stackCount++;
        // }
        // providerBadge.appendChild(stack);

        const countText = document.createElement("span");
        countText.className = "cb-card-badge-providers-count";
        countText.textContent = `+${(data.providers || []).length}`;
        providerBadge.appendChild(countText);

        const chev = document.createElement("span");
        chev.className = "cb-card-badge-providers-chev";
        chev.innerHTML =
          '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>';
        providerBadge.appendChild(chev);

        providerBadge.addEventListener("mousedown", (evt) => evt.stopPropagation());
        providerBadge.addEventListener("click", (evt) => {
          evt.stopPropagation();
          if (window.__cb.showProviderChain) {
            window.__cb.showProviderChain(card, providerBadge);
          }
        });

        badgeRow.appendChild(providerBadge);
      } else if (data.badges && data.badges.length > 0) {
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

      // Frequency badge — always rendered for ER cards (anything that reaches
      // addCard, i.e. not DP/input/comment). Sits between the credit pill
      // and the model chip so it slots into the existing segmented-pill
      // border-radius rules (first/last-child) without extra work.
      if (!isNonErType(data.type)) {
        const freqBadge = document.createElement("button");
        freqBadge.type = "button";
        freqBadge.className = "cb-card-badge cb-er-freq";
        freqBadge.title = "Click to change how often this enrichment runs";
        const freqLabelEl = document.createElement("span");
        freqLabelEl.className = "cb-er-freq-label";
        const cb = window.__cb;
        const effectiveId = data.frequencyCustom
          ? data.frequency
          : (data.frequency || cb.getCurrentFrequencyId());
        freqLabelEl.textContent = "\u00d7" + cb.getFrequencyMultiplier(effectiveId);
        freqBadge.appendChild(freqLabelEl);

        freqBadge.addEventListener("mousedown", (evt) => evt.stopPropagation());
        freqBadge.addEventListener("click", (evt) => {
          evt.stopPropagation();
          const currentId = card.data.frequencyCustom
            ? card.data.frequency
            : (card.data.frequency || cb.getCurrentFrequencyId());
          cb.showFrequencyPicker(freqBadge, currentId, (picked) => {
            applyClusterFrequency(card.id, picked);
            notifyCreditTotal();
            if (updateDpCosts) updateDpCosts();
            if (updateGroupCredits) updateGroupCredits();
            notifyChange();
            if (window.__cb.saveTabs) window.__cb.saveTabs();
          });
        });

        badgeRow.appendChild(freqBadge);
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

      // Stats row — only mounted when the card has stats (i.e. came from a
      // table import). Visibility is gated by [data-cb-pro-mode] on the
      // overlay (same gate as DP fill pills) so non-Pro users never see it.
      if (data.stats?.coverage || data.stats?.fillRate) {
        const statsRow = document.createElement("div");
        statsRow.className = "cb-er-stats";

        if (data.stats?.coverage) {
          const coverageBadge = document.createElement("button");
          coverageBadge.type = "button";
          coverageBadge.className = "cb-er-coverage";
          coverageBadge.title = "Click to view coverage (records run / total)";
          const coverageLabel = document.createElement("span");
          coverageLabel.className = "cb-er-coverage-label";
          coverageLabel.textContent = coveragePercentText(data.stats.coverage);
          coverageBadge.innerHTML = COVERAGE_SVG;
          coverageBadge.appendChild(coverageLabel);
          coverageBadge.addEventListener("mousedown", (evt) => evt.stopPropagation());
          coverageBadge.addEventListener("click", (evt) => {
            evt.stopPropagation();
            showFillRatePopover(card, coverageBadge, null, "coverage");
          });
          statsRow.appendChild(coverageBadge);
        }

        if (data.stats?.fillRate) {
          // Mirror the visible fillRate onto the card so the popover reads
          // the same shape as DP cards (it expects card.data.fillRate to
          // exist with numerator/denominator).
          card.data.fillRate = card.data.fillRate || normalizeFillRate({
            numerator: data.stats.fillRate.success,
            denominator: data.stats.fillRate.ran,
          });
          const fillBadge = document.createElement("button");
          fillBadge.type = "button";
          fillBadge.className = "cb-er-fill";
          fillBadge.title = "Click to view fill rate (results found / records run)";
          const fillLabel = document.createElement("span");
          fillLabel.className = "cb-er-fill-label";
          fillLabel.textContent = fillPercentText(card.data.fillRate);
          fillBadge.innerHTML = FILL_SVG;
          fillBadge.appendChild(fillLabel);
          fillBadge.addEventListener("mousedown", (evt) => evt.stopPropagation());
          fillBadge.addEventListener("click", (evt) => {
            evt.stopPropagation();
            showFillRatePopover(card, fillBadge, fillLabel, "fill");
          });
          statsRow.appendChild(fillBadge);
        }

        el.appendChild(statsRow);
      }

      el.addEventListener("contextmenu", (evt) => {
        evt.preventDefault();
        evt.stopPropagation();
        if (selectedCardsRef().size >= 2 && selectedCardsRef().has(card.id)) {
          showSelectionMenu(evt);
          return;
        }
        showCardMenu(card, evt);
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
      //
      // `opts.stats` carries the import-time stats block (coverage, fillRate,
      // spend, source, fetchedAt). When `stats.fillRate` is present and the
      // user hasn't customized, we seed the visible fillRate from it so the
      // pill shows the real number on first render — without locking it
      // (fillRateCustom stays false), so the user can still override it in
      // the popover if they want to.
      const stats = opts?.stats ?? null;
      let fillRate;
      if (opts?.fillRate) {
        fillRate = normalizeFillRate(opts.fillRate);
      } else if (stats?.fillRate && !opts?.fillRateCustom) {
        fillRate = normalizeFillRate({
          numerator: stats.fillRate.success,
          denominator: stats.fillRate.ran,
        });
      } else {
        fillRate = buildDefaultFillRate();
      }
      const data = {
        type: "dp",
        text: text || "",
        displayName: text || "",
        fillRate,
        fillRateCustom: !!opts?.fillRateCustom,
        fieldId: opts?.fieldId ?? null,
        tableId: opts?.tableId ?? null,
        viewId: opts?.viewId ?? null,
        stats,
        groupCluster: opts?.groupCluster ?? null,
      };
      const card = { id, x, y, data, el: null, handles: {}, groupId: null };

      const el = document.createElement("div");
      el.className = "cb-card cb-card-dp";
      el.setAttribute("data-card-id", card.id);
      if (data.groupCluster) el.setAttribute("data-group-cluster", data.groupCluster);
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
        // Stream the typed text to peers (Tier D). Debounced per-card inside
        // realtime.js so rapid typing coalesces before hitting the wire.
        if (window.__cb.realtime?.broadcastCardText) {
          window.__cb.realtime.broadcastCardText(card.id, textEl.textContent);
        }
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

      // Footer row holds the "Not connected / ~N credits / row" pill. Keep
      // this layout untouched in non-Pro mode so the card height stays the
      // same as before; in Pro Mode the .cb-dp-stats row below adds visible
      // height for the coverage + fill pills.
      const footer = document.createElement("div");
      footer.className = "cb-dp-footer";

      const costBar = document.createElement("div");
      costBar.className = "cb-dp-cost";
      costBar.innerHTML =
        '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" fill="currentColor" viewBox="0 0 256 256"><path d="M207.58,63.84C186.85,53.48,159.33,48,128,48S69.15,53.48,48.42,63.84,16,88.78,16,104v48c0,15.22,11.82,29.85,32.42,40.16S96.67,208,128,208s58.85-5.48,79.58-15.84S240,167.22,240,152V104C240,88.78,228.18,74.15,207.58,63.84Z" opacity="0.2"/><path d="M128,64c62.64,0,96,23.23,96,40s-33.36,40-96,40-96-23.23-96-40S65.36,64,128,64Z"/></svg><span>Not connected</span>';
      footer.appendChild(costBar);

      el.appendChild(footer);

      // Stats row — sibling to the footer, hidden by default and only
      // displayed when [data-cb-pro-mode] is set on the overlay (CSS-driven).
      // The whole row is mounted unconditionally so toggling Pro Mode is a
      // pure CSS flip — no card re-render needed. Adding this row makes the
      // card visually grow taller in Pro Mode rather than wrapping the footer.
      const statsRow = document.createElement("div");
      statsRow.className = "cb-dp-stats";

      // Coverage pill — only mounted when the import attached a coverage
      // block (typically via runstatus on a sibling ER or via the waterfall
      // merge pathway). Standalone DPs without a coverage source skip it.
      let coverageLabel = null;
      if (data.stats?.coverage) {
        const coverageBadge = document.createElement("button");
        coverageBadge.className = "cb-dp-coverage";
        coverageBadge.type = "button";
        coverageBadge.title = "Click to view coverage (records run / total)";
        coverageLabel = document.createElement("span");
        coverageLabel.className = "cb-dp-coverage-label";
        coverageLabel.textContent = coveragePercentText(data.stats.coverage);
        coverageBadge.innerHTML = COVERAGE_SVG;
        coverageBadge.appendChild(coverageLabel);
        coverageBadge.addEventListener("mousedown", (evt) => evt.stopPropagation());
        coverageBadge.addEventListener("click", (evt) => {
          evt.stopPropagation();
          showFillRatePopover(card, coverageBadge, null, "coverage");
        });
        statsRow.appendChild(coverageBadge);
      }

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
        showFillRatePopover(card, fillBadge, fillLabel, "fill");
      });
      statsRow.appendChild(fillBadge);

      el.appendChild(statsRow);

      el.addEventListener("contextmenu", (evt) => {
        evt.preventDefault();
        evt.stopPropagation();
        if (selectedCardsRef().size >= 2 && selectedCardsRef().has(card.id)) {
          showSelectionMenu(evt);
          return;
        }
        showCardMenu(card, evt);
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

      const data = {
        type: "input",
        text: text || "",
        displayName: text || "",
        fieldId: opts?.fieldId ?? null,
        tableId: opts?.tableId ?? null,
        viewId: opts?.viewId ?? null,
        groupCluster: opts?.groupCluster ?? null,
      };
      const card = { id, x, y, data, el: null, handles: {}, groupId: null };

      const el = document.createElement("div");
      el.className = "cb-card cb-card-input";
      el.setAttribute("data-card-id", card.id);
      if (data.groupCluster) el.setAttribute("data-group-cluster", data.groupCluster);
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
        if (window.__cb.realtime?.broadcastCardText) {
          window.__cb.realtime.broadcastCardText(card.id, textEl.textContent);
        }
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
        showCardMenu(card, evt);
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

      const data = {
        type: "comment",
        text: text || "",
        displayName: text || "",
        groupCluster: opts?.groupCluster ?? null,
      };
      const card = { id, x, y, data, el: null, handles: {}, groupId: null };

      const el = document.createElement("div");
      el.className = "cb-card cb-card-comment";
      el.setAttribute("data-card-id", card.id);
      if (data.groupCluster) el.setAttribute("data-group-cluster", data.groupCluster);
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
        if (window.__cb.realtime?.broadcastCardText) {
          window.__cb.realtime.broadcastCardText(card.id, textEl.textContent);
        }
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
        showCardMenu(card, evt);
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

    // Global → ER propagation. Mirrors updateDefaultFillRates: when the user
    // picks a new default in the summary bar, walk every ER that hasn't been
    // individually customized and sync its value. Customized ER cards are
    // left alone — their `frequencyCustom` flag is a "user touched this,
    // stop auto-updating" marker, same as fillRateCustom for DP cards.
    function updateDefaultFrequencies(globalFreqId) {
      for (const card of cardsRef()) {
        if (!card?.data || isNonErType(card.data.type)) continue;
        if (card.data.frequencyCustom) continue;
        card.data.frequency = globalFreqId;
        renderFreqLabel(card);
      }
    }

    // Cluster propagation — the "update one, all update" rule. Called by the
    // per-ER badge when the user picks a frequency. Walks the snap-cluster
    // containing the origin card and applies the picked value to every ER
    // in that cluster, marking each as custom so the global default no
    // longer rewrites them. DP / input / comment cards in the same cluster
    // are skipped; they don't carry a frequency. Standalone ERs (no cluster
    // match, or a singleton cluster) update just themselves.
    function applyClusterFrequency(originCardId, freqId) {
      const clusters = typeof getSnapClusters === "function" ? getSnapClusters() : [];
      const match = clusters.find((ids) => ids.includes(originCardId));
      const targetIds = match ? match : [originCardId];
      for (const id of targetIds) {
        const card = getCardById(id);
        if (!card || !card.data || isNonErType(card.data.type)) continue;
        card.data.frequency = freqId;
        card.data.frequencyCustom = true;
        renderFreqLabel(card);
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
      updateDefaultFrequencies,
      applyClusterFrequency,
    };
  };
})();
