(function () {
  "use strict";

  const __cb = window.__cb;

  let menuEl = null;
  let menuBackdrop = null;
  let modalEl = null;
  let modalBackdrop = null;

  // Export options the menu surfaces. Each row has a handler in
  // openExportMenu's click switch below; new options drop in as a single
  // line here plus a branch there.
  //
  // `feature` (optional): name of the feature flag that must be present in
  // the JWT for the row to render. Options without a `feature` field show
  // for everyone. The runtime filter sits at the top of openExportMenu.
  const EXPORT_OPTIONS = [
    { id: "gtme",    label: "Export to GTME Calculator", enabled: true,  feature: "gtme_export" },
    { id: "dealops", label: "Export to DealOps",         enabled: false, feature: "gtme_export" },
    { id: "table",   label: "Export as Table",           enabled: true  },
    { id: "json",    label: "Export as JSON",            enabled: true  },
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

    // Filter options the JWT doesn't entitle this user to see. Internal
    // GTMEs get every row; non-internal users get just `table` + `json`.
    // The handler switch below doesn't need its own feature checks because
    // gated branches are unreachable when the row isn't rendered.
    const visibleOptions = EXPORT_OPTIONS.filter(
      (opt) => !opt.feature || (__cb.hasFeature && __cb.hasFeature(opt.feature)),
    );

    for (const opt of visibleOptions) {
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
          else if (opt.id === "json") __cb.openExportJsonModal();
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
    // Model-backed cluster membership; getClusters() returns
    // `{id, cardIds}[]` and we only need cardIds for the cost reducer.
    const clusters = canvas.getClusters().map((cl) => cl.cardIds);

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
      const erList = erCards.map((er) => {
        const isWaterfall = er.data.type === "waterfall";
        const providerChain = isWaterfall
          ? (er.data.providers || []).map((p) => p.displayName || "Provider").join(" → ")
          : null;
        return {
          id: er.id,
          name: er.data.displayName || er.data.text || (isWaterfall ? "Waterfall" : "Untitled enrichment"),
          isWaterfall,
          providerChain,
        };
      });

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
        chip.className = "cb-export-er-chip" + (er.isWaterfall ? " cb-export-er-chip-waterfall" : "");
        chip.textContent = er.name;
        // Surface the provider chain on hover for waterfall chips so users
        // can verify the steps without leaving the modal. Standalone ERs
        // get just the name as the tooltip (matches old behavior).
        chip.title = er.isWaterfall && er.providerChain
          ? `${er.name} — ${er.providerChain}`
          : er.name;
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
  // Gated by the `gtme_export` feature flag — the menu row that triggers
  // this modal is filtered out for non-internal users in openExportMenu
  // above, so the function below is defined for everyone but only ever
  // invoked by Clay-internal users.
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
  // credit/action prices the rep set in the summary bar — null when the
  // tab predates the price inputs or has no value yet. These prices are
  // adjusted (negotiated) prices, not list prices: the calculator slots
  // them into adjustedCPC / adjustedYear1CPA so the discount band reflects
  // what the rep is pitching, while list prices keep their canonical
  // policy values.
  function computeTabVolumes(tabState) {
    if (!tabState || !Array.isArray(tabState.cards)) {
      return {
        creditsPerYear: 0,
        actionsPerYear: 0,
        creditPrice: null,
        actionPrice: null,
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
      creditPrice: parseDollarValue(tabState.creditCost),
      actionPrice: parseDollarValue(tabState.actionCost),
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
        // calculator's adjusted (year-1) price fields. Only render when at
        // least one is set so blank tabs stay visually quiet.
        if (row.volumes.creditPrice != null || row.volumes.actionPrice != null) {
          const prices = document.createElement("div");
          prices.className = "cb-gtme-tab-prices";
          const parts = [];
          if (row.volumes.creditPrice != null) {
            parts.push(`$${row.volumes.creditPrice} / credit`);
          }
          if (row.volumes.actionPrice != null) {
            parts.push(`$${row.volumes.actionPrice} / action`);
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
    submitBtn.className = "cb-export-submit";
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
          if (volumes.creditPrice != null) {
            config.creditPrice = volumes.creditPrice;
          }
          if (volumes.actionPrice != null) {
            config.actionPrice = volumes.actionPrice;
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
    footerActions.className = "cb-export-footer-actions";
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

  // ==========================================================================
  // EXPORT AS JSON
  //
  // Three-way endpoint picker for getting a Clay table's structure + stats
  // out as JSON. The same data the table-import flow consumes — surfaced
  // here so reps can grab it without going through the canvas.
  //
  //   1. Sculptor in-table — one cheap call. Schema-only on big tables.
  //   2. Full preset       — one richer (slower) call. Adds status counts,
  //                          example values, error analysis, policy credit
  //                          costs. No view filter, no actual spend.
  //   3. Combined join     — four parallel calls joined per fieldId, exact
  //                          shape the import flow uses. Adds view-filtered
  //                          record count and Redshift-backed real spend.
  //
  // Right column shows either a hand-written schema sample (so users can
  // download/inspect the shape without touching the network) or the live
  // payload for the active table. Live mode reports wall-clock latency in
  // the header chip — for the combined option it also flags the slowest
  // leg, since the four legs run in parallel.
  // ==========================================================================

  let jsonModalEl = null;
  let jsonModalBackdrop = null;

  // Per-endpoint metadata that drives the left-column explanation block.
  // Kept as a plain array so the renderer can iterate it once and so adding
  // a fourth option in the future is a one-row diff.
  const JSON_ENDPOINT_DEFS = [
    {
      id: "sculptor",
      label: "Sculptor in-table",
      tag: "1 call · cheap",
      summary:
        "Single POST to /context with contextDetailLevel \"sculptor-in-table\". " +
        "Authoritative schema — exactly what Clay's in-table sculptor LLM sees.",
      whatYouGet: [
        "Per-field schema (action input/output parameters, formulas, sources)",
        "Field group info (waterfall steps, basic groups, sequence)",
        "tableMetadata + viewInfo for the current view",
        "dataProfile only on tables under ~1k rows (server's conditional profiling rule)",
      ],
      tradeoffs: [
        "No runtime status counts — can't tell success vs error breakdowns",
        "No fill rate on tables ≥ 1k rows (profiling skipped to stay cheap)",
        "No example values, no error examples, no credit costs",
      ],
      whenToUse:
        "You want the cheapest, most-faithful snapshot of the schema and don't need runtime stats.",
      calls: [
        'POST /v3/workspaces/:workspaceId/tables/:tableId/context  body { contextDetailLevel: "sculptor-in-table" }',
      ],
    },
    {
      id: "full",
      label: "Full preset",
      tag: "1 call · rich · slow on big tables",
      summary:
        "Single POST to /context with contextDetailLevel \"full\". Every server toggle on " +
        "(DEFAULT_FIELD_CONFIG_OPTIONS): profiling at sampleSize=0, status counts, error " +
        "analysis, example values, policy credit costs.",
      whatYouGet: [
        "Everything sculptor-in-table returns",
        "dataProfile.* on every field at any table size (no 1k cap)",
        "statusBreakdown / successCount / errorCount per field (server-side runstatus join)",
        "exampleValues + errorExamples per field",
        "Action / formula error analysis with descriptions",
        "creditCost per action — list / policy values from the pricing config",
      ],
      tradeoffs: [
        "Slowest single request on big tables — profiles every row (sampleSize: 0)",
        "Returns tableRecordCount (whole table), not the view-filtered count",
        "creditCost is policy / list pricing — NOT actual billed spend",
      ],
      whenToUse:
        "You need a single rich JSON file and don't care about view filters or actual spend.",
      calls: [
        'POST /v3/workspaces/:workspaceId/tables/:tableId/context  body { contextDetailLevel: "full" }',
      ],
    },
    {
      id: "import",
      label: "Import (v3.9)",
      tag: "3 calls · what import would stamp",
      summary:
        "Mirrors the v3.9 table-import flow exactly. Fetches the workbook's table list (for fieldGroupMap + view), /context at full detail, and 30-day Redshift spend; then runs the same buildImportDecisionSet helper that importTableToCanvas calls — so the JSON you preview here is byte-for-byte what the canvas would receive.",
      whatYouGet: [
        "context + spend: same as the Full + spend legs of the import flow",
        "joined: per-fieldId { coverage, fillRate, source, spend } — the exact stats map stamped onto cards",
        "inputs.{ allInputRefs, actionOutputIds, leafInputFieldIds, leafInputFields }: leaf-input classification (replaces the v3.8 red-color hint)",
        "groupedFieldIds.{ waterfall, waterfallValidation, waterfallMerge, basicGroup, all }",
        "waterfalls / basicGroups / standaloneFields: the pre-render decision set",
        "view.{ viewId, viewName }: which view the classification was computed against",
      ],
      tradeoffs: [
        "3 network calls (table list + context-full + spend) — slightly slower than Full alone",
        "Whole-table denominators (no view filter) — same as the import flow",
        "Only meaningful when a real Clay table is in scope on the page",
      ],
      whenToUse:
        "You want to debug or audit what the import flow would stamp onto the canvas without actually triggering it.",
      calls: [
        "GET  /v3/workbooks/:workbookId/tables  (for fieldGroupMap + view + fields)",
        'POST /v3/workspaces/:workspaceId/tables/:tableId/context  body { contextDetailLevel: "full" }',
        "GET  /v3/realtime-credit-usage/:workspaceId/table/:tableId/column/recent?days=30",
      ],
    },
    {
      id: "combined",
      label: "Combined join",
      tag: "4 calls · legacy fan-out",
      summary:
        "Four parallel calls joined per fieldId — the exact same shape the brainstorm's " +
        "table-import flow consumes. Adds view-filtered record count and last-30-day actual " +
        "credit spend from Redshift on top of the sculptor context.",
      whatYouGet: [
        "viewCount: the view-filtered record count (still fetched so the timing chip can show its latency, but no longer fed into joined)",
        "runStatus: per-field SUCCESS / ERROR / RUNNING counts (also fetched for latency visibility only — joined now reads status counts straight from full's dataProfile)",
        "context: same sculptor-in-table response above",
        "spend: per-column credits + actionExecutions + cellCount over the last 30 days (Redshift)",
        "joined: the fieldId-keyed merge { coverage, fillRate, source, spend } — derived from context + spend only as of v3.9",
      ],
      tradeoffs: [
        "Slowest wall-clock — bottlenecked by whichever leg is slowest (usually runstatus)",
        "runStatus may still be \"_pending\" on big or recently-edited tables",
        "Redshift spend is only complete since 2025-11-05",
        "Only meaningful when a real Clay table is in scope on the page",
        "Since v3.9 the joiner ignores viewCount + runStatus — they're only here for per-leg latency comparison against the import flow's 2-call fan-out",
      ],
      whenToUse:
        "You want to compare per-leg latency of the legacy 4-call fan-out against the v3.9 import flow's 2-call (full + spend) approach. For real scoping, prefer Full unless you specifically need the view-filtered count or the live runstatus payload.",
      calls: [
        "GET  /v3/tables/:tableId/views/:viewId/count",
        "GET  /v3/workspaces/:workspaceId/tables/:tableId/fields/runstatus",
        'POST /v3/workspaces/:workspaceId/tables/:tableId/context  body { contextDetailLevel: "sculptor-in-table" }',
        "GET  /v3/realtime-credit-usage/:workspaceId/table/:tableId/column/recent?days=30",
      ],
    },
  ];

  // Hand-written sample shapes. Stay in sync with:
  //   apps/api/v3/clay-context/domain/table-context.ts   (TableContext, FieldConfiguration, DataProfileStats)
  //   apps/clay-brainstorm-extension/src/api.js          (fetch wrappers)
  //   apps/clay-brainstorm-extension/src/table-import.js (buildStatsByFieldId)
  // These are illustrative — fields trimmed for readability. Live mode is
  // the source of truth for the real shape on a given table.
  const JSON_SCHEMA_SAMPLES = {
    sculptor: `{
  "fieldConfigurationsData": {
    "fieldConfigs": [
      {
        "id": "<fieldId>",
        "index": 0,
        "name": "Company Domain",
        "type": "basic",
        "dataType": "text",
        "dataProfile": {
          "valueCount": 842,
          "nullPercentage": 15.8,
          "uniqueValueCount": 837,
          "totalRecords": 1000,
          "sampleSize": 1000,
          "commonValues": [{ "value": "...", "percentage": 0 }]
        }
      },
      {
        "id": "<actionFieldId>",
        "index": 1,
        "name": "Find Work Email (Waterfall)",
        "type": "action",
        "actionInfo": {
          "actionKey": "find_work_email_waterfall",
          "actionPackageId": "clay",
          "displayName": "Find Work Email",
          "inputsBinding": { "personFullName": "/{Full Name}" },
          "inputParameterSchema": [/* ... */],
          "outputParameterSchema": [/* ... */]
        },
        "groupInfo": {
          "groupId": "<groupId>",
          "groupType": "waterfall",
          "groupName": "Find Work Email",
          "roleInGroup": "sequence_step",
          "waterfallPosition": 0,
          "waterfallAttribute": "Person_WorkEmail",
          "totalWaterfallSteps": 4
        },
        "dataProfile": {
          "valueCount": 0,
          "nullPercentage": 0,
          "uniqueValueCount": 0,
          "totalRecords": 1000,
          "sampleSize": 0,
          "commonValues": []
        }
      }
    ],
    "configOptions": {
      "includeDataProfiling": false,
      "includeStatusCounts": false,
      "includeFullSchemas": true,
      "sampleSize": 1000
      /* ... see SCULPTOR_IN_TABLE_FIELD_CONFIG_OPTIONS in table-context.ts */
    }
  },
  "tableMetadata": {
    "tableId": "<tableId>",
    "tableName": "Outbound — Q2",
    "workspaceName": "Acme",
    "workbookId": "<workbookId>",
    "viewInfo": {
      "viewId": "<viewId>",
      "viewName": "Default view",
      "hasFilters": false
    }
  },
  "sampleData": []
}`,
    full: `{
  "fieldConfigurationsData": {
    "fieldConfigs": [
      {
        "id": "<fieldId>",
        "name": "Find Work Email (Waterfall)",
        "type": "action",
        "actionInfo": { /* full input/output schemas */ },
        "dataProfile": {
          "valueCount": 842,
          "nullPercentage": 15.8,
          "uniqueValueCount": 837,
          "totalRecords": 12480,
          "sampleSize": 12480,
          "successCount": 842,
          "errorCount": 95,
          "inProgressCount": 0,
          "notRunCount": 63,
          "exampleValues": ["jane@acme.com", "..."],
          "statusBreakdown": [
            { "status": "SUCCESS", "count": 842, "description": "..." },
            { "status": "ERROR_PROVIDER_ERROR", "count": 21, "description": "..." }
          ],
          "commonValues": [/* ... */]
        },
        "creditCost": {
          "creditsPerCall": 1,
          "actionExecutionCreditsPerCall": 1
          /* policy / list pricing — NOT actual spend */
        }
      }
    ],
    "configOptions": {
      "includeDataProfiling": true,
      "includeStatusCounts": true,
      "includeActionFieldAnalysis": true,
      "includeFormulaFieldAnalysis": true,
      "includeExampleValues": true,
      "includeErrorExamples": true,
      "includeCreditCosts": true,
      "sampleSize": 0
      /* ... see DEFAULT_FIELD_CONFIG_OPTIONS in table-context.ts */
    }
  },
  "tableMetadata": { /* same as sculptor; tableRecordCount = whole table */ },
  "sampleData": [/* up to getExampleRows rows */]
}`,
    combined: `{
  /* viewCount and runStatus are still fetched in Combined mode so the
     timing chip can show their per-leg latency, but as of v3.9 they are
     NOT consumed by the joiner — coverage / fillRate now derive from
     full's dataProfile.successCount + errorCount + inProgressCount. The
     fields are kept on the payload for inspection. */
  "viewCount": {
    "viewTotalRecordsCount": 8240
  },
  "runStatus": {
    "<actionFieldId>": [
      { "status": "SUCCESS",              "count": 7180 },
      { "status": "SUCCESS_NO_DATA",      "count": 730  },
      { "status": "ERROR_PROVIDER_ERROR", "count": 21   }
    ]
  },
  "context": {
    /* Sculptor-in-table response — same shape as the "Sculptor in-table"
       option above. Use that tab for the detailed schema. */
  },
  "spend": [
    {
      "fieldId": "<actionFieldId>",
      "creditsSpent": 7843,
      "actionExecutionCreditsSpent": 7901,
      "cellCount": 7931
    }
  ],
  "joined": {
    /* Derived from context.fieldConfigurationsData.fieldConfigs[*].dataProfile
       + spend. Combined mode still fetches sculptor (not full) context, so
       action-field coverage falls back to valueCount/sampleSize instead of
       successCount/errorCount. Use the Full option above for status-count-
       backed coverage. */
    "<fieldId>": {
      "fetchedAt": 1714000000000,
      "source": "dataProfile",
      "fillRate": { "success": 842, "ran": 1000 },
      "spend": { "credits": 7843, "actionExecutions": 7901, "cellCount": 7931 }
    }
  }
}`,
    import: `{
  /* The full pre-render decision set the v3.9 import flow consumes.
     Built by __cb.buildImportDecisionSet in src/table-import.js — same
     helper importTableToCanvas calls, so this preview matches what the
     canvas would receive byte-for-byte. */

  "context": { /* /context (full preset) response — see Full tab above for the detailed shape */ },
  "spend":   [ /* /realtime-credit-usage column spend rows — see Combined tab above */ ],

  "view": {
    "viewId":   "<viewId>",
    "viewName": "Default view"
  },

  "visibleFieldIds": ["<fieldA>", "<fieldB>", "<actionFieldId>", "<mergeFieldId>"],

  "inputs": {
    /* Leaf-input rule: basic + visible + non-formula + referenced by some
       action's inputsBinding + not itself an action output + not in any
       group. Replaces the v3.8 red-color hint. */
    "allInputRefs":      ["<fieldA>", "<fieldB>", "<intermediateFieldId>"],
    "actionOutputIds":   ["<actionFieldId>", "<otherActionFieldId>"],
    "leafInputFieldIds": ["<fieldA>", "<fieldB>"],
    "leafInputFields": [
      { "id": "<fieldA>", "name": "Full Name",      "type": "basic" },
      { "id": "<fieldB>", "name": "Company Domain", "type": "basic" }
    ]
  },

  "groupedFieldIds": {
    "waterfall":           ["<step1FieldId>", "<step2FieldId>"],
    "waterfallValidation": ["<validationFieldId>"],
    "waterfallMerge":      ["<mergeFieldId>"],
    "basicGroup":          ["<bg1Field1>", "<bg1Field2>"],
    "all":                 ["<step1FieldId>", "<step2FieldId>", "<validationFieldId>", "<mergeFieldId>", "<bg1Field1>", "<bg1Field2>"]
  },

  "waterfalls": [
    {
      "groupId":       "<groupId>",
      "name":          "Find Work Email",
      "attributeEnum": "Person_WorkEmail",
      "mergeFieldId":  "<mergeFieldId>",
      "steps": [
        {
          "fieldId":         "<step1FieldId>",
          "actionKey":       "find_email_apollo",
          "actionPackageId": "clay",
          "validation": {
            "fieldId":         "<validationFieldId>",
            "actionKey":       "validate_email_zerobounce",
            "actionPackageId": "clay",
            "authAccountId":   null
          }
        }
      ]
    }
  ],

  "basicGroups": [
    {
      "groupId":  "<bgGroupId>",
      "name":     "Person Enrichment",
      "dpFields": [{ "id": "<bg1Field1>", "name": "Job Title", "type": "basic" }],
      "erFields": [{ "id": "<bg1Field2>", "name": "Find Job Title", "type": "action", "actionKey": "find_job_title", "actionPackageId": "clay" }]
    }
  ],

  "standaloneFields": [
    { "id": "<actionFieldId>", "name": "Score Lead (AI)", "type": "action", "actionKey": "use_ai", "actionPackageId": "clay" }
  ],

  "joined": {
    "<actionFieldId>": {
      "fetchedAt": 1714000000000,
      "source":    "dataProfile-full",
      "coverage":  { "ran": 7201, "total": 12480 },
      "fillRate":  { "success": 7180, "ran": 7201 },
      "spend":     { "credits": 7843, "actionExecutions": 7901, "cellCount": 7931 }
    },
    "<fieldA>": {
      "fetchedAt": 1714000000000,
      "source":    "dataProfile",
      "fillRate":  { "success": 9800, "ran": 12480 }
    }
  }
}`,
  };

  // Pulls workspace / workbook / table / view IDs out of the current Clay URL
  // path. parseIdsFromUrl in config.js stops at workbook — it's wired into
  // the canvas which doesn't care about the table. The export modal does, so
  // we extend it locally rather than retrofit config.js.
  function parseTableIdsFromUrl() {
    const parts = window.location.pathname.split("/");
    const wsIdx = parts.indexOf("workspaces");
    const wbIdx = parts.indexOf("workbooks");
    const tIdx = parts.indexOf("tables");
    const vIdx = parts.indexOf("views");
    if (wsIdx === -1 || wbIdx === -1) return null;
    return {
      workspaceId: parts[wsIdx + 1] || null,
      workbookId: parts[wbIdx + 1] || null,
      tableId: tIdx !== -1 ? parts[tIdx + 1] || null : null,
      viewId: vIdx !== -1 ? parts[vIdx + 1] || null : null,
    };
  }

  // Resolves a viewId for the combined endpoint when the URL doesn't have one
  // (e.g. user opened the modal from the workbook home). Falls back to the
  // table's firstViewId — same default the import flow uses.
  async function resolveViewId(workbookId, tableId, knownViewId) {
    if (knownViewId) return knownViewId;
    if (!workbookId || !tableId || !__cb.fetchTableList) return null;
    try {
      const list = await __cb.fetchTableList(workbookId);
      const tables = list?.tables || list || [];
      const match = (Array.isArray(tables) ? tables : []).find((t) => t.id === tableId);
      return match?.firstViewId || match?.views?.[0]?.id || null;
    } catch (err) {
      console.warn("[Clay Scoping] resolveViewId failed:", err);
      return null;
    }
  }

  // Resolves the full table object (with fields, fieldGroupMap, views) for
  // the Import option. The decision-set helper needs all three to build the
  // group/input classification, so we fetch the same /v3/workbooks/.../tables
  // payload the picker uses. Returns null on failure so the calling fetch
  // branch can surface a graceful error in the preview.
  async function resolveTable(workbookId, tableId) {
    if (!workbookId || !tableId || !__cb.fetchTableList) return null;
    try {
      const list = await __cb.fetchTableList(workbookId);
      const tables = list?.tables || list || [];
      return (Array.isArray(tables) ? tables : []).find((t) => t.id === tableId) || null;
    } catch (err) {
      console.warn("[Clay Scoping] resolveTable failed:", err);
      return null;
    }
  }

  function formatDuration(ms) {
    if (ms == null || !Number.isFinite(ms)) return "—";
    if (ms < 1000) return `${Math.round(ms)} ms`;
    return `${(ms / 1000).toFixed(2)} s`;
  }

  // Tiny HTML-escape pass for safe innerHTML injection. Live JSON payloads
  // can contain user-typed strings with `<` / `&` / quotes (think of a
  // Claygent prompt or a scraped page snippet living in a cell value), so
  // we always escape before wrapping matches in <mark> tags.
  const HTML_ENTITIES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => HTML_ENTITIES[c]);
  }

  function escapeRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  // Builds an HTML string with case-insensitive matches of `query` wrapped
  // in <mark class="cb-export-json-match"> tags, escaping non-match text
  // as we go. Returns the count alongside so the caller can render
  // "N / M" without re-querying the DOM. Empty / no-match queries fall
  // through to a plain escaped string with count = 0.
  function buildHighlightedHtml(text, query) {
    if (!query) return { html: escapeHtml(text), count: 0 };
    const re = new RegExp(escapeRegex(query), "gi");
    let out = "";
    let lastIdx = 0;
    let count = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      // Zero-width matches (shouldn't happen with our literal-escape, but
      // belt + braces) would otherwise spin forever — bump lastIndex.
      if (m[0].length === 0) { re.lastIndex++; continue; }
      out += escapeHtml(text.slice(lastIdx, m.index));
      out += `<mark class="cb-export-json-match">${escapeHtml(m[0])}</mark>`;
      lastIdx = m.index + m[0].length;
      count++;
    }
    out += escapeHtml(text.slice(lastIdx));
    return { html: out, count };
  }

  // Wraps a Promise<T> with performance.now() bookends and returns the
  // measured duration alongside the resolved value (or the rejection,
  // re-thrown). Single helper so every leg is timed identically.
  async function timed(label, promise) {
    const started = performance.now();
    try {
      const value = await promise;
      return { label, value, durationMs: performance.now() - started, error: null };
    } catch (error) {
      return { label, value: null, durationMs: performance.now() - started, error };
    }
  }

  // Per-endpoint live fetch. Returns { payload, durationMs, legDurations? }.
  // Throws when prerequisite IDs are missing so the caller can render an
  // empty-state hint instead of a JSON blob.
  async function fetchJsonForEndpoint(endpointId) {
    const ids = parseTableIdsFromUrl();
    const workspaceId = ids?.workspaceId;
    const tableId = ids?.tableId;
    if (!workspaceId || !tableId) {
      const err = new Error("Open a Clay table to fetch live data.");
      err.code = "missing_table";
      throw err;
    }

    if (endpointId === "sculptor") {
      const t = await timed("context", __cb.fetchTableContext(workspaceId, tableId));
      if (t.error) throw t.error;
      return { payload: t.value, durationMs: t.durationMs };
    }

    if (endpointId === "full") {
      const t = await timed("context-full", __cb.fetchTableContextFull(workspaceId, tableId));
      if (t.error) throw t.error;
      return { payload: t.value, durationMs: t.durationMs };
    }

    if (endpointId === "import") {
      // Mirrors importTableToCanvas's two-leg fan-out plus the table-list
      // fetch the picker normally hands the import flow. We re-use the
      // exact helper (__cb.buildImportDecisionSet) the canvas calls so the
      // preview is byte-for-byte what would get stamped.
      if (!__cb.buildImportDecisionSet) {
        throw new Error("buildImportDecisionSet is not loaded — reload the extension and try again.");
      }
      const overall = performance.now();
      const [tableR, contextR, spendR] = await Promise.all([
        timed("table", resolveTable(ids.workbookId, tableId)),
        timed("context-full", __cb.fetchTableContextFull(workspaceId, tableId)),
        timed("spend", __cb.fetchColumnSpend(workspaceId, tableId, 30)),
      ]);
      const durationMs = performance.now() - overall;
      if (!tableR.value) {
        throw new Error(
          "Table not found in workbook listing. Open the workbook this table belongs to and try again."
        );
      }
      const decisionSet = __cb.buildImportDecisionSet({
        table: tableR.value,
        viewId: ids.viewId,
        context: contextR.value,
        spend: spendR.value,
      });
      return {
        payload: decisionSet,
        durationMs,
        legDurations: {
          table: tableR.durationMs,
          context: contextR.durationMs,
          spend: spendR.durationMs,
        },
      };
    }

    if (endpointId === "combined") {
      const viewId = await resolveViewId(ids.workbookId, tableId, ids.viewId);
      const overall = performance.now();
      const [viewCountR, runStatusR, contextR, spendR] = await Promise.all([
        viewId
          ? timed("viewCount", __cb.fetchViewCount(tableId, viewId))
          : Promise.resolve({ label: "viewCount", value: null, durationMs: 0, error: null }),
        timed("runStatus", __cb.fetchFieldRunStatus(workspaceId, tableId)),
        timed("context", __cb.fetchTableContext(workspaceId, tableId)),
        timed("spend", __cb.fetchColumnSpend(workspaceId, tableId, 30)),
      ]);
      const durationMs = performance.now() - overall;

      const fields = contextR.value?.fieldConfigurationsData?.allFields
        || contextR.value?.fieldConfigurationsData?.fieldConfigs
        || [];
      const joinedMap = __cb.joinTableStats
        ? __cb.joinTableStats({
            fields,
            runStatus: runStatusR.value,
            context: contextR.value,
            spend: spendR.value,
            viewCount: viewCountR.value,
          })
        : new Map();
      const joined = {};
      for (const [fieldId, stats] of joinedMap.entries()) {
        joined[fieldId] = stats;
      }

      const legDurations = {
        viewCount: viewCountR.durationMs,
        runStatus: runStatusR.durationMs,
        context: contextR.durationMs,
        spend: spendR.durationMs,
      };

      return {
        payload: {
          viewCount: viewCountR.value,
          runStatus: runStatusR.value,
          context: contextR.value,
          spend: spendR.value,
          joined,
        },
        durationMs,
        legDurations,
      };
    }

    throw new Error(`Unknown endpoint: ${endpointId}`);
  }

  // Browsers force-name downloads via a synthetic <a download> click. The
  // URL needs to be revoked or it leaks the Blob until the page closes.
  function downloadJson(filename, text) {
    const blob = new Blob([text], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  function closeExportJsonModal() {
    if (jsonModalEl) { jsonModalEl.remove(); jsonModalEl = null; }
    if (jsonModalBackdrop) { jsonModalBackdrop.remove(); jsonModalBackdrop = null; }
    document.removeEventListener("keydown", onJsonModalKeydown);
  }

  __cb.closeExportJsonModal = closeExportJsonModal;

  function onJsonModalKeydown(evt) {
    if (evt.key === "Escape") {
      evt.stopPropagation();
      closeExportJsonModal();
    }
  }

  __cb.openExportJsonModal = function openExportJsonModal() {
    closeExportJsonModal();

    // Per-endpoint live cache so toggling between options doesn't refetch
    // and the timing chip can show the prior measurement at a glance.
    const cache = {
      sculptor: { state: "idle", payload: null, durationMs: null, error: null, legDurations: null },
      full:     { state: "idle", payload: null, durationMs: null, error: null, legDurations: null },
      combined: { state: "idle", payload: null, durationMs: null, error: null, legDurations: null },
    };
    let selectedEndpoint = "sculptor";
    let mode = "schema";

    jsonModalBackdrop = document.createElement("div");
    jsonModalBackdrop.className = "cb-export-modal-backdrop";
    jsonModalBackdrop.addEventListener("mousedown", (evt) => {
      if (evt.target === jsonModalBackdrop) closeExportJsonModal();
    });

    jsonModalEl = document.createElement("div");
    jsonModalEl.className = "cb-export-modal cb-export-json-modal";

    // ---- Header ----
    const header = document.createElement("div");
    header.className = "cb-export-modal-header";
    const titleWrap = document.createElement("div");
    titleWrap.className = "cb-export-modal-title-wrap";
    const title = document.createElement("h2");
    title.className = "cb-export-modal-title";
    title.textContent = "Export as JSON";
    const subtitle = document.createElement("div");
    subtitle.className = "cb-export-modal-subtitle";
    subtitle.textContent =
      "Pick which Clay endpoint to pull the table's structure + stats from. " +
      "Preview the schema or fetch live data, then download.";
    titleWrap.appendChild(title);
    titleWrap.appendChild(subtitle);

    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "cb-export-modal-close";
    closeBtn.setAttribute("aria-label", "Close");
    closeBtn.innerHTML =
      '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
    closeBtn.addEventListener("click", closeExportJsonModal);

    header.appendChild(titleWrap);
    header.appendChild(closeBtn);

    // ---- Body (two columns) ----
    const body = document.createElement("div");
    body.className = "cb-export-modal-body cb-export-json-body";

    // Left column ----------------------------------------------------------
    const left = document.createElement("div");
    left.className = "cb-export-json-left";

    const picker = document.createElement("div");
    picker.className = "cb-export-json-picker";
    picker.setAttribute("role", "tablist");
    const pickerButtons = new Map();
    for (const def of JSON_ENDPOINT_DEFS) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "cb-export-json-endpoint";
      btn.setAttribute("role", "tab");
      btn.dataset.endpointId = def.id;
      const label = document.createElement("span");
      label.className = "cb-export-json-endpoint-label";
      label.textContent = def.label;
      const tag = document.createElement("span");
      tag.className = "cb-export-json-endpoint-tag";
      tag.textContent = def.tag;
      btn.appendChild(label);
      btn.appendChild(tag);
      btn.addEventListener("click", () => {
        if (selectedEndpoint === def.id) return;
        selectedEndpoint = def.id;
        renderAll();
        if (mode === "live") refreshLive();
      });
      picker.appendChild(btn);
      pickerButtons.set(def.id, btn);
    }
    left.appendChild(picker);

    const explain = document.createElement("div");
    explain.className = "cb-export-json-explain";
    left.appendChild(explain);

    // Right column ---------------------------------------------------------
    const right = document.createElement("div");
    right.className = "cb-export-json-right";

    const rightHeader = document.createElement("div");
    rightHeader.className = "cb-export-json-right-header";

    const modeToggle = document.createElement("div");
    modeToggle.className = "cb-export-json-mode-toggle";
    modeToggle.setAttribute("role", "tablist");
    const modeButtons = new Map();
    for (const m of [{ id: "schema", label: "Schema" }, { id: "live", label: "Live data" }]) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "cb-export-json-mode-btn";
      btn.dataset.modeId = m.id;
      btn.textContent = m.label;
      btn.addEventListener("click", () => {
        if (mode === m.id) return;
        mode = m.id;
        renderAll();
        if (mode === "live") refreshLive();
      });
      modeToggle.appendChild(btn);
      modeButtons.set(m.id, btn);
    }
    rightHeader.appendChild(modeToggle);

    const timing = document.createElement("div");
    timing.className = "cb-export-json-timing";
    rightHeader.appendChild(timing);

    right.appendChild(rightHeader);

    // Search bar — only meaningful in live mode (the schemas are short
    // enough to skim). Hidden via the visible-modifier class so the
    // mode-toggle stays as the lone right-of-header concern when user is
    // looking at the schema.
    const searchBar = document.createElement("div");
    searchBar.className = "cb-export-json-search-bar";
    const searchInput = document.createElement("input");
    searchInput.type = "search";
    searchInput.className = "cb-export-json-search-input";
    searchInput.placeholder = "Search live data\u2026  (Enter \u2014 next, Shift+Enter \u2014 prev)";
    searchInput.autocomplete = "off";
    searchInput.spellcheck = false;
    const searchCounter = document.createElement("span");
    searchCounter.className = "cb-export-json-search-counter";
    searchBar.appendChild(searchInput);
    searchBar.appendChild(searchCounter);
    right.appendChild(searchBar);

    const previewWrap = document.createElement("div");
    previewWrap.className = "cb-export-json-preview-wrap";
    const preview = document.createElement("pre");
    preview.className = "cb-export-json-preview";
    previewWrap.appendChild(preview);
    right.appendChild(previewWrap);

    // Search state. `searchText` caches the raw JSON string so re-running
    // the highlighter on each keystroke doesn't have to JSON.stringify the
    // payload again. `currentMatchIdx` is -1 when there are no matches or
    // no query.
    let searchQuery = "";
    let searchText = "";
    let currentMatchIdx = -1;
    let currentMatchCount = 0;

    searchInput.addEventListener("input", () => {
      searchQuery = searchInput.value;
      // Always reset to the first match when the query changes — keeps
      // jump-to-next predictable as the user refines the term.
      currentMatchIdx = searchQuery ? 0 : -1;
      applySearchHighlight({ scroll: !!searchQuery });
    });

    searchInput.addEventListener("keydown", (evt) => {
      if (evt.key === "Enter") {
        evt.preventDefault();
        if (currentMatchCount === 0) return;
        currentMatchIdx = evt.shiftKey
          ? (currentMatchIdx - 1 + currentMatchCount) % currentMatchCount
          : (currentMatchIdx + 1) % currentMatchCount;
        focusActiveMatch();
        renderSearchCounter();
      } else if (evt.key === "Escape") {
        // Local escape clears the query; we deliberately do NOT close the
        // modal here, even though the global Escape handler would —
        // stopPropagation prevents that from firing while the search input
        // has focus.
        if (searchQuery) {
          evt.stopPropagation();
          searchQuery = "";
          searchInput.value = "";
          currentMatchIdx = -1;
          applySearchHighlight({ scroll: false });
        }
      }
    });

    body.appendChild(left);
    body.appendChild(right);

    // ---- Footer ----
    const footer = document.createElement("div");
    footer.className = "cb-export-modal-footer";
    const footerHint = document.createElement("div");
    footerHint.className = "cb-export-modal-footer-hint";
    footerHint.textContent =
      "Live mode hits Clay's APIs with your session cookies. Nothing is uploaded anywhere.";

    const downloadBtn = document.createElement("button");
    downloadBtn.type = "button";
    downloadBtn.className = "cb-export-submit cb-export-json-download";
    downloadBtn.textContent = "Download JSON";
    downloadBtn.addEventListener("click", () => {
      const def = JSON_ENDPOINT_DEFS.find((d) => d.id === selectedEndpoint);
      const ids = parseTableIdsFromUrl();
      const tablePart = ids?.tableId ? `-${ids.tableId}` : "";
      if (mode === "schema") {
        downloadJson(
          `clay-context-${def.id}-schema.json`,
          JSON_SCHEMA_SAMPLES[def.id] || "{}"
        );
        return;
      }
      const entry = cache[selectedEndpoint];
      if (entry.state !== "ready" || entry.payload == null) return;
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      downloadJson(
        `clay-context-${def.id}${tablePart}-${stamp}.json`,
        JSON.stringify(entry.payload, null, 2)
      );
    });

    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.className = "cb-export-modal-done";
    cancelBtn.textContent = "Done";
    cancelBtn.addEventListener("click", closeExportJsonModal);

    const footerActions = document.createElement("div");
    footerActions.className = "cb-export-footer-actions";
    footerActions.appendChild(cancelBtn);
    footerActions.appendChild(downloadBtn);

    footer.appendChild(footerHint);
    footer.appendChild(footerActions);

    jsonModalEl.appendChild(header);
    jsonModalEl.appendChild(body);
    jsonModalEl.appendChild(footer);
    jsonModalBackdrop.appendChild(jsonModalEl);
    document.body.appendChild(jsonModalBackdrop);
    document.addEventListener("keydown", onJsonModalKeydown);

    // ---- Render helpers ----

    function renderPicker() {
      for (const [id, btn] of pickerButtons.entries()) {
        btn.classList.toggle("cb-export-json-endpoint-active", id === selectedEndpoint);
        btn.setAttribute("aria-selected", id === selectedEndpoint ? "true" : "false");
      }
    }

    function renderModeButtons() {
      for (const [id, btn] of modeButtons.entries()) {
        btn.classList.toggle("cb-export-json-mode-btn-active", id === mode);
        btn.setAttribute("aria-selected", id === mode ? "true" : "false");
      }
    }

    function renderExplain() {
      const def = JSON_ENDPOINT_DEFS.find((d) => d.id === selectedEndpoint);
      explain.innerHTML = "";
      if (!def) return;

      const h = (text) => {
        const el = document.createElement("div");
        el.className = "cb-export-json-explain-h";
        el.textContent = text;
        return el;
      };
      const p = (text, cls) => {
        const el = document.createElement("p");
        el.className = "cb-export-json-explain-p" + (cls ? " " + cls : "");
        el.textContent = text;
        return el;
      };
      const list = (items, cls) => {
        const ul = document.createElement("ul");
        ul.className = "cb-export-json-explain-list" + (cls ? " " + cls : "");
        for (const item of items) {
          const li = document.createElement("li");
          li.textContent = item;
          ul.appendChild(li);
        }
        return ul;
      };

      explain.appendChild(p(def.summary, "cb-export-json-explain-summary"));

      explain.appendChild(h("What you get"));
      explain.appendChild(list(def.whatYouGet));

      explain.appendChild(h("Trade-offs"));
      explain.appendChild(list(def.tradeoffs, "cb-export-json-explain-cons"));

      explain.appendChild(h("When to use"));
      explain.appendChild(p(def.whenToUse));

      explain.appendChild(h("Calls"));
      const callsList = document.createElement("ul");
      callsList.className = "cb-export-json-explain-calls";
      for (const c of def.calls) {
        const li = document.createElement("li");
        li.textContent = c;
        callsList.appendChild(li);
      }
      explain.appendChild(callsList);
    }

    function renderTimingChip() {
      timing.className = "cb-export-json-timing";
      if (mode !== "live") {
        timing.style.visibility = "hidden";
        timing.textContent = "";
        return;
      }
      timing.style.visibility = "visible";
      const entry = cache[selectedEndpoint];
      if (entry.state === "loading") {
        timing.classList.add("cb-export-json-timing-loading");
        timing.textContent = "Fetching…";
        return;
      }
      if (entry.state === "error") {
        timing.classList.add("cb-export-json-timing-error");
        timing.textContent = entry.error?.message
          ? `Error · ${formatDuration(entry.durationMs)}`
          : `Error`;
        timing.title = entry.error?.message || "";
        return;
      }
      if (entry.state === "ready") {
        timing.classList.add("cb-export-json-timing-ready");
        let text = formatDuration(entry.durationMs);
        if (entry.legDurations) {
          let slowestKey = null;
          let slowestMs = -1;
          for (const [k, v] of Object.entries(entry.legDurations)) {
            if (v != null && v > slowestMs) { slowestMs = v; slowestKey = k; }
          }
          if (slowestKey) {
            text += ` (slowest: ${slowestKey} ${formatDuration(slowestMs)})`;
          }
        }
        timing.textContent = text;
        timing.title = "Wall-clock latency of the network call(s) that produced this payload.";
        return;
      }
      timing.textContent = "";
    }

    function renderPreview() {
      preview.classList.remove("cb-export-json-preview-error", "cb-export-json-preview-empty");
      // Clear cached search text — only the live/ready branch sets it
      // back, which is also the only branch where search makes sense.
      searchText = "";
      if (mode === "schema") {
        preview.textContent = JSON_SCHEMA_SAMPLES[selectedEndpoint] || "{}";
        applySearchHighlight({ scroll: false });
        return;
      }
      const entry = cache[selectedEndpoint];
      if (entry.state === "idle") {
        preview.classList.add("cb-export-json-preview-empty");
        preview.textContent = "Click \u201cLive data\u201d again or switch endpoints to fetch.";
        applySearchHighlight({ scroll: false });
        return;
      }
      if (entry.state === "loading") {
        preview.classList.add("cb-export-json-preview-empty");
        preview.textContent = "Fetching from Clay…";
        applySearchHighlight({ scroll: false });
        return;
      }
      if (entry.state === "error") {
        preview.classList.add("cb-export-json-preview-error");
        preview.textContent =
          (entry.error?.message || "Request failed.") +
          "\n\n" +
          "If you're not on a Clay table page, open one and reopen this dialog. " +
          "Otherwise, check the browser console for the underlying error.";
        applySearchHighlight({ scroll: false });
        return;
      }
      if (entry.state === "ready") {
        try {
          searchText = JSON.stringify(entry.payload, null, 2);
        } catch (err) {
          preview.classList.add("cb-export-json-preview-error");
          preview.textContent = `Could not stringify payload: ${err.message}`;
          applySearchHighlight({ scroll: false });
          return;
        }
        applySearchHighlight({ scroll: false });
      }
    }

    // Renders the preview's body, applying the current search highlight if
    // one is set and we're in live/ready mode. When no query is set we use
    // textContent (cheaper, no parse), otherwise we build escaped HTML
    // with <mark> wrappers around matches and inject it via innerHTML.
    function applySearchHighlight({ scroll }) {
      const canSearch = mode === "live" && searchText !== "";
      searchBar.classList.toggle("cb-export-json-search-bar-visible", canSearch);

      if (!canSearch) {
        currentMatchCount = 0;
        currentMatchIdx = -1;
        renderSearchCounter();
        // searchText is empty here, so renderPreview already wrote the
        // appropriate placeholder/error text via textContent. Nothing
        // more to do.
        return;
      }

      if (!searchQuery) {
        preview.textContent = searchText;
        currentMatchCount = 0;
        currentMatchIdx = -1;
        renderSearchCounter();
        return;
      }

      const { html, count } = buildHighlightedHtml(searchText, searchQuery);
      preview.innerHTML = html;
      currentMatchCount = count;
      if (count === 0) {
        currentMatchIdx = -1;
      } else {
        // Clamp so a stale idx (from a prior, larger result set) doesn't
        // point past the end after the user narrows the query.
        if (currentMatchIdx < 0 || currentMatchIdx >= count) currentMatchIdx = 0;
        markActiveMatch();
        if (scroll) focusActiveMatch();
      }
      renderSearchCounter();
    }

    function markActiveMatch() {
      const marks = preview.querySelectorAll(".cb-export-json-match");
      for (const el of marks) el.classList.remove("cb-export-json-match-active");
      if (currentMatchIdx >= 0 && marks[currentMatchIdx]) {
        marks[currentMatchIdx].classList.add("cb-export-json-match-active");
      }
    }

    function focusActiveMatch() {
      markActiveMatch();
      const marks = preview.querySelectorAll(".cb-export-json-match");
      const target = marks[currentMatchIdx];
      if (target && typeof target.scrollIntoView === "function") {
        target.scrollIntoView({ block: "center", inline: "nearest" });
      }
    }

    function renderSearchCounter() {
      if (!searchQuery) {
        searchCounter.textContent = "";
        searchCounter.classList.remove("cb-export-json-search-counter-empty");
        return;
      }
      if (currentMatchCount === 0) {
        searchCounter.textContent = "0 matches";
        searchCounter.classList.add("cb-export-json-search-counter-empty");
        return;
      }
      searchCounter.classList.remove("cb-export-json-search-counter-empty");
      searchCounter.textContent = `${currentMatchIdx + 1} / ${currentMatchCount}`;
    }

    function renderDownloadButton() {
      // Always enabled in schema mode (we ship hand-written samples). In
      // live mode, gate on a successful fetch so we never download an empty
      // or in-flight payload.
      const enabled = mode === "schema" || cache[selectedEndpoint].state === "ready";
      downloadBtn.disabled = !enabled;
      downloadBtn.classList.toggle("cb-export-json-download-disabled", !enabled);
    }

    function renderAll() {
      renderPicker();
      renderModeButtons();
      renderExplain();
      renderTimingChip();
      renderPreview();
      renderDownloadButton();
    }

    async function refreshLive() {
      const entry = cache[selectedEndpoint];
      // Already-fetched payloads are reused — saves a roundtrip when the
      // user toggles back to a previously-viewed endpoint.
      if (entry.state === "ready") {
        renderTimingChip();
        renderPreview();
        renderDownloadButton();
        return;
      }
      entry.state = "loading";
      entry.error = null;
      renderTimingChip();
      renderPreview();
      renderDownloadButton();

      const endpointAtStart = selectedEndpoint;
      try {
        const result = await fetchJsonForEndpoint(endpointAtStart);
        // Bail if the user switched endpoints while we were waiting — the
        // result still gets cached for whichever endpoint requested it.
        cache[endpointAtStart].state = "ready";
        cache[endpointAtStart].payload = result.payload;
        cache[endpointAtStart].durationMs = result.durationMs;
        cache[endpointAtStart].legDurations = result.legDurations || null;
      } catch (err) {
        cache[endpointAtStart].state = "error";
        cache[endpointAtStart].error = err;
      }
      if (selectedEndpoint === endpointAtStart) {
        renderTimingChip();
        renderPreview();
        renderDownloadButton();
      }
    }

    renderAll();
  };
})();
