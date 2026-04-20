(function () {
  "use strict";

  const __cb = window.__cb;

  let menuEl = null;
  let menuBackdrop = null;
  let modalEl = null;
  let modalBackdrop = null;

  // The four export options. Only "table" is wired up at this stage —
  // the other three are placeholder slots so the menu communicates the
  // intended scope, and so adding their handlers later is a one-liner.
  const EXPORT_OPTIONS = [
    { id: "gtme",   label: "Export to GTME Calculator", enabled: true  },
    { id: "dealops", label: "Export to DealOps",         enabled: false },
    { id: "table",  label: "Export as Table",            enabled: true  },
    { id: "json",   label: "Export as JSON",             enabled: false },
  ];

  // ---- Menu ----

  function closeExportMenu() {
    if (menuEl) { menuEl.remove(); menuEl = null; }
    if (menuBackdrop) { menuBackdrop.remove(); menuBackdrop = null; }
  }

  __cb.closeExportMenu = closeExportMenu;

  __cb.openExportMenu = function openExportMenu(anchorEl) {
    closeExportMenu();

    // Mirrors the backdrop+menu pattern used by showFrequencyPicker in
    // src/config.js — full-viewport invisible backdrop catches outside
    // clicks and dismisses the menu.
    menuBackdrop = document.createElement("div");
    menuBackdrop.style.cssText = "position:fixed;inset:0;z-index:9999998;";
    menuBackdrop.addEventListener("mousedown", (evt) => {
      evt.stopPropagation();
      closeExportMenu();
    });

    menuEl = document.createElement("div");
    menuEl.className = "cb-export-menu";
    menuEl.addEventListener("mousedown", (evt) => evt.stopPropagation());

    for (const opt of EXPORT_OPTIONS) {
      const item = document.createElement("button");
      item.type = "button";
      item.className =
        "cb-export-menu-option" +
        (opt.enabled ? "" : " cb-export-menu-option-disabled");
      item.textContent = opt.label;
      if (!opt.enabled) {
        // Placeholder rows are visible but inert. We still mark them as
        // disabled at the DOM level so screenreaders skip them and the
        // browser declines to focus them with the keyboard.
        item.disabled = true;
        item.setAttribute("aria-disabled", "true");
      } else {
        item.addEventListener("click", (evt) => {
          evt.stopPropagation();
          closeExportMenu();
          if (opt.id === "table") __cb.openExportTableModal();
          else if (opt.id === "gtme") __cb.openGtmeExportModal();
        });
      }
      menuEl.appendChild(item);
    }

    document.body.appendChild(menuBackdrop);
    document.body.appendChild(menuEl);

    // Anchor below the trigger and right-aligned with it: the Export button
    // lives on the right edge of the topbar, so left-aligning would push the
    // menu off-screen. We compute "right" by the anchor's right edge so the
    // menu's right edge sits flush with the button's.
    const rect = anchorEl.getBoundingClientRect();
    menuEl.style.position = "fixed";
    menuEl.style.top = (rect.bottom + 6) + "px";
    menuEl.style.right = Math.max(8, window.innerWidth - rect.right) + "px";
    menuEl.style.zIndex = "9999999";
  };

  // ---- Per-DP row computation (mirrors updateDpCosts in canvas/credits.js) ----

  function isNonErType(type) {
    return type === "dp" || type === "input" || type === "comment";
  }

  function fillRatePct(fr) {
    if (!fr || !fr.denominator) return 0;
    return Math.round((fr.numerator / fr.denominator) * 100);
  }

  // Returns one row per DP card. Rows for unconnected DPs (DPs not in any
  // snap-cluster, or in a cluster with no ER cards) carry credits=0,
  // actions=0, ers=[]. Caller decides whether to filter those out.
  function buildRows() {
    const canvas = __cb.canvas;
    if (!canvas) return [];

    const allCards = canvas.getCards();
    const clusters = canvas.getSnapClusters();

    // Map dpId -> { credits, actions, ers, enrichmentCount }. Built from
    // clusters first; DPs not in the map fall through to the unconnected
    // default at row time.
    const dpInfoMap = new Map();

    for (const cluster of clusters) {
      const clusterCards = cluster
        .map((id) => allCards.find((c) => c.id === id))
        .filter(Boolean);
      const erCards = clusterCards.filter((c) => !isNonErType(c.data.type));
      const dpCards = clusterCards.filter((c) => c.data.type === "dp");
      if (dpCards.length === 0) continue;

      // Mirror the cost-attribution rule in canvas/credits.js: sum credits
      // across the cluster's ERs (skipping private-key ones) then divide by
      // the number of DPs sharing the cluster. Same idea for actions, except
      // private-key doesn't suppress action counts (matches the existing
      // updateGroupCredits rule).
      let totalCredits = 0;
      let totalActions = 0;
      for (const er of erCards) {
        if (!er.data.usePrivateKey && er.data.credits != null) {
          totalCredits += er.data.credits;
        }
        if (er.data.actionExecutions != null) {
          totalActions += er.data.actionExecutions;
        }
      }

      const perDpCredits = totalCredits / dpCards.length;
      const perDpActions = totalActions / dpCards.length;
      const erList = erCards.map((er) => ({
        id: er.id,
        name: er.data.displayName || er.data.text || "Untitled enrichment",
      }));

      for (const dp of dpCards) {
        dpInfoMap.set(dp.id, {
          credits: perDpCredits,
          actions: perDpActions,
          ers: erList,
          enrichmentCount: erCards.length,
        });
      }
    }

    const rows = [];
    for (const card of allCards) {
      if (card.data.type !== "dp") continue;
      const info = dpInfoMap.get(card.id);
      rows.push({
        cardId: card.id,
        name: card.data.text || card.data.displayName || "",
        fillRatePct: fillRatePct(card.data.fillRate),
        credits: info ? info.credits : 0,
        actions: info ? info.actions : 0,
        ers: info ? info.ers : [],
        connected: !!info && info.enrichmentCount > 0,
      });
    }
    return rows;
  }

  function formatNumber(n) {
    if (!Number.isFinite(n)) return "0";
    return n % 1 === 0
      ? n.toLocaleString()
      : n.toLocaleString(undefined, { maximumFractionDigits: 1 });
  }

  // ---- Modal ----

  function closeExportTableModal() {
    if (modalEl) { modalEl.remove(); modalEl = null; }
    if (modalBackdrop) { modalBackdrop.remove(); modalBackdrop = null; }
    document.removeEventListener("keydown", onModalKeydown);
  }

  __cb.closeExportTableModal = closeExportTableModal;

  function onModalKeydown(evt) {
    if (evt.key === "Escape") {
      // Don't bubble Escape into the canvas's escape-to-navigate handler when
      // the user is just dismissing the modal.
      evt.stopPropagation();
      closeExportTableModal();
    }
  }

  __cb.openExportTableModal = function openExportTableModal() {
    closeExportTableModal();

    // Default the filter on; persist on __cb so reopening within the same
    // session keeps the user's choice without us having to wire localStorage.
    if (typeof __cb._exportShowUnconnected !== "boolean") {
      __cb._exportShowUnconnected = true;
    }

    modalBackdrop = document.createElement("div");
    modalBackdrop.className = "cb-export-modal-backdrop";
    modalBackdrop.addEventListener("mousedown", (evt) => {
      // Only the bare backdrop (not the modal itself) dismisses on click.
      if (evt.target === modalBackdrop) closeExportTableModal();
    });

    modalEl = document.createElement("div");
    modalEl.className = "cb-export-modal";

    // ---- Header ----

    const header = document.createElement("div");
    header.className = "cb-export-modal-header";

    const titleWrap = document.createElement("div");
    titleWrap.className = "cb-export-modal-title-wrap";
    const title = document.createElement("h2");
    title.className = "cb-export-modal-title";
    title.textContent = "Export as table";
    const subtitle = document.createElement("div");
    subtitle.className = "cb-export-modal-subtitle";
    subtitle.textContent = "Spreadsheet view of your data points and the enrichments serving them.";
    titleWrap.appendChild(title);
    titleWrap.appendChild(subtitle);

    const headerActions = document.createElement("div");
    headerActions.className = "cb-export-modal-header-actions";

    // Filter toggle (controlled checkbox styled as a pill).
    const filterLabel = document.createElement("label");
    filterLabel.className = "cb-export-filter-toggle";
    const filterInput = document.createElement("input");
    filterInput.type = "checkbox";
    filterInput.checked = !!__cb._exportShowUnconnected;
    const filterText = document.createElement("span");
    filterText.textContent = "Show unconnected DPs";
    filterLabel.appendChild(filterInput);
    filterLabel.appendChild(filterText);
    filterInput.addEventListener("change", () => {
      __cb._exportShowUnconnected = filterInput.checked;
      renderTable();
    });

    // Download CSV button — visual only. Click is a no-op intentionally;
    // wiring this up is the next milestone.
    const downloadBtn = document.createElement("button");
    downloadBtn.type = "button";
    downloadBtn.className = "cb-export-download-btn";
    downloadBtn.title = "Download CSV (coming soon)";
    downloadBtn.innerHTML =
      '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>' +
      '<span>Download CSV</span>';

    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "cb-export-modal-close";
    closeBtn.setAttribute("aria-label", "Close");
    closeBtn.innerHTML =
      '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
    closeBtn.addEventListener("click", closeExportTableModal);

    headerActions.appendChild(filterLabel);
    headerActions.appendChild(downloadBtn);
    headerActions.appendChild(closeBtn);

    header.appendChild(titleWrap);
    header.appendChild(headerActions);

    // ---- Body (table container) ----

    const body = document.createElement("div");
    body.className = "cb-export-modal-body";

    function renderTable() {
      body.innerHTML = "";

      const allRows = buildRows();
      const showUnconnected = !!__cb._exportShowUnconnected;
      const visibleRows = showUnconnected
        ? allRows
        : allRows.filter((r) => r.connected);

      if (allRows.length === 0) {
        const empty = document.createElement("div");
        empty.className = "cb-export-empty";
        empty.textContent = "No data points yet. Add a DP card to the canvas to see rows here.";
        body.appendChild(empty);
        return;
      }

      if (visibleRows.length === 0) {
        const empty = document.createElement("div");
        empty.className = "cb-export-empty";
        empty.textContent = "No connected data points. Toggle \u201cShow unconnected DPs\u201d to see all rows.";
        body.appendChild(empty);
        return;
      }

      const table = document.createElement("table");
      table.className = "cb-export-table";

      const thead = document.createElement("thead");
      const headRow = document.createElement("tr");
      const headers = [
        { label: "DP",            cls: "col-dp" },
        { label: "Fill rate (%)", cls: "col-fill" },
        { label: "Credits",       cls: "col-credits" },
        { label: "Actions",       cls: "col-actions" },
        { label: "ERs",           cls: "col-ers" },
      ];
      for (const h of headers) {
        const th = document.createElement("th");
        th.textContent = h.label;
        th.className = h.cls;
        headRow.appendChild(th);
      }
      thead.appendChild(headRow);
      table.appendChild(thead);

      const tbody = document.createElement("tbody");
      for (const row of visibleRows) {
        tbody.appendChild(buildRowEl(row));
      }
      table.appendChild(tbody);

      body.appendChild(table);
    }

    // ---- Footer ----

    const footer = document.createElement("div");
    footer.className = "cb-export-modal-footer";
    const footerHint = document.createElement("div");
    footerHint.className = "cb-export-modal-footer-hint";
    footerHint.textContent = "Edits to DP names and fill rates apply to the canvas immediately.";
    const doneBtn = document.createElement("button");
    doneBtn.type = "button";
    doneBtn.className = "cb-export-modal-done";
    doneBtn.textContent = "Done";
    doneBtn.addEventListener("click", closeExportTableModal);
    footer.appendChild(footerHint);
    footer.appendChild(doneBtn);

    modalEl.appendChild(header);
    modalEl.appendChild(body);
    modalEl.appendChild(footer);

    modalBackdrop.appendChild(modalEl);
    document.body.appendChild(modalBackdrop);

    document.addEventListener("keydown", onModalKeydown);

    renderTable();
  };

  // ---- Row construction (with edit handlers) ----

  function buildRowEl(row) {
    const tr = document.createElement("tr");
    tr.className = row.connected ? "" : "cb-export-row-unconnected";
    tr.setAttribute("data-card-id", String(row.cardId));

    // DP name — editable. Writing back updates card.data and the live
    // canvas DOM so the side-by-side view stays in sync.
    const dpCell = document.createElement("td");
    dpCell.className = "col-dp";
    const dpInput = document.createElement("input");
    dpInput.type = "text";
    dpInput.className = "cb-export-cell-input cb-export-cell-input-text";
    dpInput.value = row.name;
    dpInput.placeholder = "Type data point\u2026";
    dpInput.addEventListener("keydown", (evt) => {
      if (evt.key === "Enter") evt.target.blur();
    });
    dpInput.addEventListener("blur", () => {
      commitDpName(row.cardId, dpInput.value);
    });
    dpCell.appendChild(dpInput);
    tr.appendChild(dpCell);

    // Fill rate (%) — editable single-percentage input. Mirrors the
    // numerator-only edit path the in-card popover takes when committing,
    // and flips fillRateCustom so the records-input live updater stops
    // overwriting it.
    const fillCell = document.createElement("td");
    fillCell.className = "col-fill";
    const fillInput = document.createElement("input");
    fillInput.type = "number";
    fillInput.min = "0";
    fillInput.max = "100";
    fillInput.step = "1";
    fillInput.className = "cb-export-cell-input cb-export-cell-input-num";
    fillInput.value = String(row.fillRatePct);
    fillInput.addEventListener("keydown", (evt) => {
      if (evt.key === "Enter") evt.target.blur();
    });
    fillInput.addEventListener("blur", () => {
      commitFillRate(row.cardId, fillInput.value);
    });
    const fillSuffix = document.createElement("span");
    fillSuffix.className = "cb-export-cell-suffix";
    fillSuffix.textContent = "%";
    fillCell.appendChild(fillInput);
    fillCell.appendChild(fillSuffix);
    tr.appendChild(fillCell);

    // Credits — read-only.
    const creditsCell = document.createElement("td");
    creditsCell.className = "col-credits cb-export-cell-readonly";
    creditsCell.textContent = formatNumber(row.credits);
    tr.appendChild(creditsCell);

    // Actions — read-only.
    const actionsCell = document.createElement("td");
    actionsCell.className = "col-actions cb-export-cell-readonly";
    actionsCell.textContent = formatNumber(row.actions);
    tr.appendChild(actionsCell);

    // ERs — chip pills. Empty cluster shows an em-dash.
    const ersCell = document.createElement("td");
    ersCell.className = "col-ers";
    if (row.ers.length === 0) {
      const dash = document.createElement("span");
      dash.className = "cb-export-empty-cell";
      dash.textContent = "\u2014";
      ersCell.appendChild(dash);
    } else {
      const chips = document.createElement("div");
      chips.className = "cb-export-er-chips";
      for (const er of row.ers) {
        const chip = document.createElement("span");
        chip.className = "cb-export-er-chip";
        chip.textContent = er.name;
        chip.title = er.name;
        chips.appendChild(chip);
      }
      ersCell.appendChild(chips);
    }
    tr.appendChild(ersCell);

    return tr;
  }

  function commitDpName(cardId, value) {
    const canvas = __cb.canvas;
    if (!canvas) return;
    const card = canvas.getCardById(cardId);
    if (!card) return;
    const next = (value || "").trim();
    const prev = card.data.text || card.data.displayName || "";
    if (next === prev) return;

    card.data.text = next;
    card.data.displayName = next;

    // Update the live canvas card's text node so the user sees the change
    // immediately if they close the modal.
    const textEl = card.el?.querySelector(".cb-dp-text");
    if (textEl) {
      textEl.textContent = next;
      if (next) textEl.removeAttribute("data-placeholder");
      else textEl.setAttribute("data-placeholder", "Type data point\u2026");
    }

    if (canvas.notifyChange) canvas.notifyChange();
    if (__cb.saveTabs) __cb.saveTabs();
  }

  function commitFillRate(cardId, rawValue) {
    const canvas = __cb.canvas;
    if (!canvas) return;
    const card = canvas.getCardById(cardId);
    if (!card) return;

    // Clamp to 0-100. Empty/non-numeric input falls back to 0 — matches the
    // permissive behavior of the in-card popover.
    const parsed = Number(rawValue);
    const pct = Number.isFinite(parsed) ? Math.max(0, Math.min(100, parsed)) : 0;

    const fr = card.data.fillRate || { numerator: 0, denominator: 100 };
    const denominator = fr.denominator > 0 ? fr.denominator : 100;
    const numerator = Math.round((pct / 100) * denominator);
    card.data.fillRate = { numerator, denominator };
    // Same flag the in-card popover sets — tells the records-input live
    // updater "user has touched this, stop auto-rewriting it".
    card.data.fillRateCustom = true;

    // Refresh the canvas card's fill-rate label so the chip text matches.
    const labelEl = card.el?.querySelector(".cb-dp-fill-label");
    if (labelEl) labelEl.textContent = `${pct}%`;

    if (canvas.notifyChange) canvas.notifyChange();
    if (__cb.saveTabs) __cb.saveTabs();
  }

  // ==========================================================================
  // EXPORT TO GTME CALCULATOR
  //
  // Flow:
  //   1. saveTabs() — flushes the live canvas into __cb.tabStore.tabs[i].state
  //      so the active tab's volumes are current.
  //   2. Modal: customer name + contract length (default 12 months) + tab
  //      checklist with per-tab volume preview.
  //   3. On submit: encode payload (base64url), open
  //      `${GTME_CALCULATOR_BASE_URL}/import?payload=...` in a new tab. The
  //      calculator handles auth, account creation, and config insertion
  //      (see apps/gtme-calculator/apps/mono-calculator/src/components/import).
  // ==========================================================================

  let gtmeModalEl = null;
  let gtmeModalBackdrop = null;

  function closeGtmeExportModal() {
    if (gtmeModalEl) { gtmeModalEl.remove(); gtmeModalEl = null; }
    if (gtmeModalBackdrop) { gtmeModalBackdrop.remove(); gtmeModalBackdrop = null; }
    document.removeEventListener("keydown", onGtmeModalKeydown);
  }

  __cb.closeGtmeExportModal = closeGtmeExportModal;

  function onGtmeModalKeydown(evt) {
    if (evt.key === "Escape") {
      evt.stopPropagation();
      closeGtmeExportModal();
    }
  }

  // ---- Compute per-tab year-1 volumes ----

  function parseRecordsValue(raw) {
    if (raw == null) return 0;
    const n = parseInt(String(raw).replace(/,/g, ""), 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }

  // Strips currency formatting ("$0.05" → 0.05) and returns a positive
  // number, or null if parsing failed. Mirrors parseDollar() in overlay.js
  // so prices read from a saved tab match what overlay.js renders.
  function parseDollarValue(raw) {
    if (raw == null) return null;
    const n = parseFloat(String(raw).replace(/[^\d.]/g, ""));
    return Number.isFinite(n) && n > 0 ? n : null;
  }

  function frequencyMultiplier(id) {
    return __cb.getFrequencyMultiplier ? __cb.getFrequencyMultiplier(id || __cb.DEFAULT_FREQUENCY_ID) : 1;
  }

  // Mirrors notifyCreditTotal in canvas/credits.js but operates on a
  // serialized tab.state instead of the live canvas, so it works for tabs
  // the user isn't currently looking at. Returns year-1 volumes (because
  // the frequency multipliers are already annualized) plus the per-tab
  // credit/action list prices the rep set in the summary bar — null when
  // the tab predates the price inputs or has no value yet.
  function computeTabVolumes(tabState) {
    if (!tabState || !Array.isArray(tabState.cards)) {
      return {
        creditsPerYear: 0,
        actionsPerYear: 0,
        creditListPrice: null,
        actionListPrice: null,
      };
    }
    const records = parseRecordsValue(tabState.records);
    const globalFreqId = tabState.frequency || __cb.DEFAULT_FREQUENCY_ID;

    let weightedCreditsPerRow = 0;
    let weightedActionsPerRow = 0;
    for (const c of tabState.cards) {
      if (!c?.data || isNonErType(c.data.type)) continue;
      const credits = c.data.credits ?? 0;
      const actions = c.data.actionExecutions ?? 0;
      const freqId = c.data.frequencyCustom
        ? c.data.frequency
        : (c.data.frequency || globalFreqId);
      const mult = frequencyMultiplier(freqId);
      // Private-key ERs don't burn Clay credits but their action calls still
      // run, so we exclude them from credits but keep them in actions —
      // same rule the canvas uses everywhere else.
      if (!c.data.usePrivateKey) {
        weightedCreditsPerRow += credits * mult;
      }
      weightedActionsPerRow += actions * mult;
    }

    return {
      creditsPerYear: Math.max(0, Math.round(weightedCreditsPerRow * records)),
      actionsPerYear: Math.max(0, Math.round(weightedActionsPerRow * records)),
      creditListPrice: parseDollarValue(tabState.creditCost),
      actionListPrice: parseDollarValue(tabState.actionCost),
    };
  }

  // ---- base64url encode a UTF-8 string ----

  function encodePayload(obj) {
    const json = JSON.stringify(obj);
    const utf8 = new TextEncoder().encode(json);
    let bin = "";
    for (let i = 0; i < utf8.length; i++) bin += String.fromCharCode(utf8[i]);
    return btoa(bin)
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  }

  function formatVolumeNumber(n) {
    if (!Number.isFinite(n)) return "0";
    return n.toLocaleString();
  }

  // ---- Modal ----

  __cb.openGtmeExportModal = function openGtmeExportModal() {
    closeGtmeExportModal();

    // Flush the active tab so its in-memory state matches what the user
    // sees. Other tabs are already in sync with their last-active save.
    if (__cb.saveTabs) __cb.saveTabs();

    const visibleTabs = (__cb.tabStore?.tabs || []).filter((t) => !t.hidden);
    const activeTabId = __cb.tabStore?.activeId;

    // Per-tab state: { id -> { tab, checked, volumes } }. We build it once
    // upfront so re-rendering the table after a checkbox toggle is cheap.
    const rowState = new Map();
    for (const tab of visibleTabs) {
      rowState.set(tab.id, {
        tab,
        checked: tab.id === activeTabId,
        volumes: computeTabVolumes(tab.state),
      });
    }

    let customerName = "";
    // Contract length is fixed at 12 months for now. The calculator's
    // contractYears comes from this; year2/year3 stay zeroed. If we ever
    // want multi-year exports we'd reintroduce the editable input.
    const contractLengthMonths = 12;
    let submitting = false;

    gtmeModalBackdrop = document.createElement("div");
    gtmeModalBackdrop.className = "cb-export-modal-backdrop";
    gtmeModalBackdrop.addEventListener("mousedown", (evt) => {
      if (evt.target === gtmeModalBackdrop) closeGtmeExportModal();
    });

    gtmeModalEl = document.createElement("div");
    gtmeModalEl.className = "cb-export-modal cb-gtme-modal";

    // ---- Header ----
    const header = document.createElement("div");
    header.className = "cb-export-modal-header";
    const titleWrap = document.createElement("div");
    titleWrap.className = "cb-export-modal-title-wrap";
    const title = document.createElement("h2");
    title.className = "cb-export-modal-title";
    title.textContent = "Export to GTME Calculator";
    const subtitle = document.createElement("div");
    subtitle.className = "cb-export-modal-subtitle";
    subtitle.textContent = "Creates a customer account and one pricing config per scoping tab.";
    titleWrap.appendChild(title);
    titleWrap.appendChild(subtitle);

    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "cb-export-modal-close";
    closeBtn.setAttribute("aria-label", "Close");
    closeBtn.innerHTML =
      '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
    closeBtn.addEventListener("click", closeGtmeExportModal);

    header.appendChild(titleWrap);
    header.appendChild(closeBtn);

    // ---- Body ----
    const body = document.createElement("div");
    body.className = "cb-export-modal-body cb-gtme-body";

    // Form fields (customer name + contract length).
    const fieldsRow = document.createElement("div");
    fieldsRow.className = "cb-gtme-fields";

    const nameField = document.createElement("label");
    nameField.className = "cb-gtme-field cb-gtme-field-grow";
    const nameLabel = document.createElement("span");
    nameLabel.className = "cb-gtme-field-label";
    nameLabel.textContent = "Customer name";
    const nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.className = "cb-gtme-input";
    nameInput.placeholder = "e.g. Acme Corp";
    nameInput.autocomplete = "off";
    nameInput.addEventListener("input", () => {
      customerName = nameInput.value;
      updateSubmitState();
    });
    nameField.appendChild(nameLabel);
    nameField.appendChild(nameInput);

    // Contract length is read-only — show it as a static chip so the user
    // sees what will be sent to the calculator without being able to edit
    // it. Title attribute explains the rationale on hover.
    const contractField = document.createElement("div");
    contractField.className = "cb-gtme-field";
    const contractLabel = document.createElement("span");
    contractLabel.className = "cb-gtme-field-label";
    contractLabel.textContent = "Contract length";
    const contractValue = document.createElement("span");
    contractValue.className = "cb-gtme-static-value";
    contractValue.textContent = "1 year";
    contractValue.title = "Contract length is fixed at 1 year for Clay exports.";
    contractField.appendChild(contractLabel);
    contractField.appendChild(contractValue);

    fieldsRow.appendChild(nameField);
    fieldsRow.appendChild(contractField);
    body.appendChild(fieldsRow);

    // Tab picker.
    const tabsHeader = document.createElement("div");
    tabsHeader.className = "cb-gtme-tabs-header";
    const tabsTitle = document.createElement("div");
    tabsTitle.className = "cb-gtme-tabs-title";
    tabsTitle.textContent = "Tabs to export";
    const tabsHint = document.createElement("div");
    tabsHint.className = "cb-gtme-tabs-hint";
    tabsHint.textContent = "Each checked tab becomes one pricing config.";
    tabsHeader.appendChild(tabsTitle);
    tabsHeader.appendChild(tabsHint);
    body.appendChild(tabsHeader);

    const tabsContainer = document.createElement("div");
    tabsContainer.className = "cb-gtme-tabs";
    body.appendChild(tabsContainer);

    function renderTabs() {
      tabsContainer.innerHTML = "";
      if (visibleTabs.length === 0) {
        const empty = document.createElement("div");
        empty.className = "cb-export-empty";
        empty.textContent = "No scoping tabs to export. Create one first.";
        tabsContainer.appendChild(empty);
        return;
      }

      for (const tab of visibleTabs) {
        const row = rowState.get(tab.id);
        const item = document.createElement("label");
        item.className = "cb-gtme-tab-row" + (row.checked ? " cb-gtme-tab-row-checked" : "");

        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.checked = row.checked;
        cb.addEventListener("change", () => {
          row.checked = cb.checked;
          item.classList.toggle("cb-gtme-tab-row-checked", cb.checked);
          updateSubmitState();
        });

        const meta = document.createElement("div");
        meta.className = "cb-gtme-tab-meta";
        const nm = document.createElement("div");
        nm.className = "cb-gtme-tab-name";
        nm.textContent = tab.name || "Scoping";
        const stats = document.createElement("div");
        stats.className = "cb-gtme-tab-stats";
        if (row.volumes.creditsPerYear === 0 && row.volumes.actionsPerYear === 0) {
          stats.textContent = "No volume yet — add records and enrichments to this tab.";
          stats.classList.add("cb-gtme-tab-stats-empty");
        } else {
          stats.textContent =
            `${formatVolumeNumber(row.volumes.creditsPerYear)} credits / yr · ` +
            `${formatVolumeNumber(row.volumes.actionsPerYear)} actions / yr`;
        }
        meta.appendChild(nm);
        meta.appendChild(stats);

        // Surface the per-tab credit/action prices we'll inject into the
        // calculator. Only render when at least one is set so blank tabs
        // stay visually quiet.
        if (row.volumes.creditListPrice != null || row.volumes.actionListPrice != null) {
          const prices = document.createElement("div");
          prices.className = "cb-gtme-tab-prices";
          const parts = [];
          if (row.volumes.creditListPrice != null) {
            parts.push(`$${row.volumes.creditListPrice} / credit`);
          }
          if (row.volumes.actionListPrice != null) {
            parts.push(`$${row.volumes.actionListPrice} / action`);
          }
          prices.textContent = parts.join(" · ");
          meta.appendChild(prices);
        }

        item.appendChild(cb);
        item.appendChild(meta);
        tabsContainer.appendChild(item);
      }
    }

    // Optional inline error surface. Shown when window.open is blocked or
    // the payload is too long.
    const errorEl = document.createElement("div");
    errorEl.className = "cb-gtme-error";
    errorEl.style.display = "none";
    body.appendChild(errorEl);

    function showError(msg) {
      errorEl.textContent = msg;
      errorEl.style.display = "";
    }

    function clearError() {
      errorEl.textContent = "";
      errorEl.style.display = "none";
    }

    // ---- Footer ----
    const footer = document.createElement("div");
    footer.className = "cb-export-modal-footer";
    const footerHint = document.createElement("div");
    footerHint.className = "cb-export-modal-footer-hint";
    footerHint.textContent = "Opens the GTME Calculator in a new tab with everything pre-filled.";

    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.className = "cb-export-modal-done";
    cancelBtn.textContent = "Cancel";
    cancelBtn.addEventListener("click", closeGtmeExportModal);

    const submitBtn = document.createElement("button");
    submitBtn.type = "button";
    submitBtn.className = "cb-gtme-submit";
    submitBtn.textContent = "Export";
    submitBtn.addEventListener("click", () => {
      if (submitting) return;
      const selected = visibleTabs.filter((t) => rowState.get(t.id).checked);
      if (selected.length === 0 || !customerName.trim()) return;

      submitting = true;
      submitBtn.disabled = true;
      clearError();

      const payload = {
        v: 1,
        customerName: customerName.trim(),
        contractLengthMonths,
        source: {
          kind: "clay-brainstorm",
          workbookId: __cb.currentWorkbookId || undefined,
          exportedAt: new Date().toISOString(),
        },
        configs: selected.map((tab) => {
          const volumes = rowState.get(tab.id).volumes;
          const config = {
            name: tab.name || "Scoping",
            creditsPerYear: volumes.creditsPerYear,
            actionsPerYear: volumes.actionsPerYear,
          };
          // Only attach prices when the user explicitly set them in this
          // tab. Sending undefined would still serialize as missing keys,
          // but explicit omission keeps the URL payload smaller.
          if (volumes.creditListPrice != null) {
            config.creditListPrice = volumes.creditListPrice;
          }
          if (volumes.actionListPrice != null) {
            config.actionListPrice = volumes.actionListPrice;
          }
          return config;
        }),
      };

      let encoded;
      try {
        encoded = encodePayload(payload);
      } catch (err) {
        submitting = false;
        submitBtn.disabled = false;
        showError("Could not serialize the export payload. Please try again.");
        console.error("[Clay Scoping] GTME export encode failed", err);
        return;
      }

      // Defensive: if the constant was wiped (e.g. local edit reverted),
      // refuse to open a URL that would be relative to the current page —
      // that would silently land the user back on app.clay.com instead of
      // the calculator. We require a real http(s) origin or we abort.
      const rawBase = (__cb.GTME_CALCULATOR_BASE_URL || "").trim();
      if (!/^https?:\/\//i.test(rawBase)) {
        submitting = false;
        submitBtn.disabled = false;
        showError("GTME calculator URL is not configured. Set GTME_CALCULATOR_BASE_URL in src/config.js.");
        console.error("[Clay Scoping] GTME export aborted: invalid GTME_CALCULATOR_BASE_URL =", rawBase);
        return;
      }
      const base = rawBase.replace(/\/+$/, "");
      const url = `${base}/import?payload=${encoded}`;
      // Intentionally NOT passing "noopener,noreferrer" in the third arg:
      // when noopener is set, window.open returns null even on success
      // (per the WHATWG spec — the whole point of noopener is severing the
      // opener<->openee reference). We need a meaningful return value to
      // distinguish "popup blocked" from "popup opened", so we accept the
      // small tradeoff that the calculator can read window.opener — that's
      // safe because the calculator is our own code, not an arbitrary site.
      const opened = window.open(url, "_blank");
      if (!opened) {
        submitting = false;
        submitBtn.disabled = false;
        showError("Browser blocked the popup. Allow popups for app.clay.com and try again.");
        return;
      }

      closeGtmeExportModal();
    });

    const footerActions = document.createElement("div");
    footerActions.className = "cb-gtme-footer-actions";
    footerActions.appendChild(cancelBtn);
    footerActions.appendChild(submitBtn);

    footer.appendChild(footerHint);
    footer.appendChild(footerActions);

    // Disabled until a name and at least one tab are present.
    function updateSubmitState() {
      const hasName = customerName.trim().length > 0;
      const hasTab = visibleTabs.some((t) => rowState.get(t.id).checked);
      submitBtn.disabled = !hasName || !hasTab || submitting;
    }

    gtmeModalEl.appendChild(header);
    gtmeModalEl.appendChild(body);
    gtmeModalEl.appendChild(footer);
    gtmeModalBackdrop.appendChild(gtmeModalEl);
    document.body.appendChild(gtmeModalBackdrop);

    document.addEventListener("keydown", onGtmeModalKeydown);

    renderTabs();
    updateSubmitState();
    requestAnimationFrame(() => nameInput.focus());
  };
})();
