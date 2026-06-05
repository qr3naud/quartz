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
  // for everyone. `ownerOnly` (optional): when true the row only renders for
  // the maintainer (the signed `is_admin` claim, __cb.isAdmin) — a UX gate
  // while these surfaces are still being iterated on. The runtime filter sits
  // at the top of openExportMenu.
  const EXPORT_OPTIONS = [
    { id: "gtme",     label: "Export to GTME Calculator", enabled: true,  feature: "gtme_export" },
    { id: "dealdesk", label: "Submit to deal desk",       enabled: true,  feature: "gtme_export", ownerOnly: true },
    { id: "dealops",  label: "Export to DealOps",         enabled: false, feature: "gtme_export" },
    { id: "table",    label: "Export as Table",           enabled: true,  ownerOnly: true },
    // "Import Inspector" (formerly "Export as JSON") moved to the three-dots
    // ("more") menu — see __cb.openMoreMenu in src/overlay.js.
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
    // GTMEs get the feature-flagged rows; `ownerOnly` rows (Submit to deal
    // desk, Export as Table) are further restricted to the maintainer via the
    // signed `is_admin` claim. The handler switch below doesn't need its own
    // checks because gated branches are unreachable when the row isn't rendered.
    const isOwner = !!__cb.isAdmin;
    const visibleOptions = EXPORT_OPTIONS.filter(
      (opt) =>
        (!opt.feature || (__cb.hasFeature && __cb.hasFeature(opt.feature))) &&
        (!opt.ownerOnly || isOwner),
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
          else if (opt.id === "dealdesk" && __cb.openDealDeskModal) __cb.openDealDeskModal();
        });
      }
      menuEl.appendChild(item);
    }

    // With the export rows now gated (feature flags + owner-only), some users
    // entitle to nothing. Show an inert placeholder so the menu doesn't render
    // as an empty, broken-looking box.
    if (visibleOptions.length === 0) {
      const empty = document.createElement("button");
      empty.type = "button";
      empty.className = "cb-export-menu-option cb-export-menu-option-disabled";
      empty.textContent = "No export options available";
      empty.disabled = true;
      empty.setAttribute("aria-disabled", "true");
      menuEl.appendChild(empty);
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

    __cb.model.update();
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

    __cb.model.update();
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

  // Strips currency formatting ("$0.05" → 0.05) and returns a positive
  // number, or null if parsing failed. Mirrors parseDollar() in overlay.js
  // so prices read from a saved tab match what overlay.js renders.
  function parseDollarValue(raw) {
    if (raw == null) return null;
    const n = parseFloat(String(raw).replace(/[^\d.]/g, ""));
    return Number.isFinite(n) && n > 0 ? n : null;
  }

  // Per-tab year-1 volumes for export / deal-desk, computed off a serialized
  // tab.state (so it works for tabs the user isn't currently viewing) via the
  // shared cost-model.computeTabTotals — identical to what the table shows for
  // that tab. Also returns the per-tab credit/action prices the rep set in the
  // summary bar (null when the tab predates the price inputs or has no value),
  // and the tab's `mode` (projected/actual). Prices are adjusted (negotiated)
  // prices, not list: the calculator slots them into adjustedCPC /
  // adjustedYear1CPA so the discount band reflects what the rep is pitching,
  // while list prices keep their canonical policy values.
  function computeTabVolumes(tabState) {
    if (!tabState || !Array.isArray(tabState.cards)) {
      return {
        creditsPerYear: 0,
        actionsPerYear: 0,
        creditPrice: null,
        actionPrice: null,
        mode: "projected",
      };
    }
    // Single source of truth: cost-model.computeTabTotals reproduces exactly what
    // the table/summary shows for this tab — coverage, per-use-case records +
    // frequency (multi-table), "other" excluded — in the tab's own saved view
    // mode (Projected catalog, or Actual measured spend scaled to Records). This
    // is what both the GTME calculator export and the Deal Desk submission send.
    const mode = tabState.viewMode === "actual" ? "actual" : "projected";
    const totals = window.__cb.cost.computeTabTotals(tabState, { viewMode: mode });

    return {
      creditsPerYear: totals.creditsPerYear,
      actionsPerYear: totals.actionsPerYear,
      creditPrice: parseDollarValue(tabState.creditCost),
      actionPrice: parseDollarValue(tabState.actionCost),
      mode,
    };
  }

  // Exposed so src/deal-desk.js can build the same per-tab volumes/prices
  // without duplicating the cost-model walk.
  __cb.computeTabVolumes = computeTabVolumes;

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

        const hasVolume =
          row.volumes.creditsPerYear !== 0 || row.volumes.actionsPerYear !== 0;

        // Title row: tab name + an inline mode pill (white, indigo for Projected
        // / green for Actual) so the rep sees at a glance how each tab exports.
        const titleRow = document.createElement("div");
        titleRow.className = "cb-gtme-tab-title";
        const nm = document.createElement("div");
        nm.className = "cb-gtme-tab-name";
        nm.textContent = tab.name || "Scoping";
        titleRow.appendChild(nm);
        if (hasVolume) {
          const isActual = row.volumes.mode === "actual";
          const modePill = document.createElement("span");
          modePill.className =
            "cb-gtme-mode-pill " +
            (isActual ? "cb-gtme-mode-pill-actual" : "cb-gtme-mode-pill-projected");
          modePill.textContent = isActual ? "Actual" : "Projected";
          titleRow.appendChild(modePill);
        }
        meta.appendChild(titleRow);

        if (!hasVolume) {
          const stats = document.createElement("div");
          stats.className = "cb-gtme-tab-stats cb-gtme-tab-stats-empty";
          stats.textContent = "No volume yet — add records and enrichments to this tab.";
          meta.appendChild(stats);
        } else {
          // Reuse the canvas/table cost pill (actions | credits) plus a $ total
          // pill, so the modal reads the same as the table. Total uses the tab's
          // negotiated credit/action prices (defaults match the summary bar).
          const pills = document.createElement("div");
          pills.className = "cb-gtme-tab-pills";
          if (__cb.buildCostBadges) {
            pills.appendChild(
              __cb.buildCostBadges(row.volumes.creditsPerYear, row.volumes.actionsPerYear),
            );
          }
          const creditPrice = row.volumes.creditPrice != null ? row.volumes.creditPrice : 0.05;
          const actionPrice = row.volumes.actionPrice != null ? row.volumes.actionPrice : 0.008;
          const dollars =
            row.volumes.creditsPerYear * creditPrice +
            row.volumes.actionsPerYear * actionPrice;
          const dol = document.createElement("span");
          dol.className = "cb-gtme-tab-dollar";
          dol.title = "Total cost / yr at the tab's credit & action prices";
          dol.innerHTML =
            (__cb.dollarSvg ? __cb.dollarSvg(12) : "$") +
            `<span>${Math.round(dollars).toLocaleString()}</span>`;
          pills.appendChild(dol);
          meta.appendChild(pills);
        }

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
            // Whether these volumes are the Projected estimate or Actual measured
            // spend (per-tab), so the calculator can label/trace the basis.
            basis: volumes.mode || "projected",
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
  // The import flow's API calls, in execution order, grouped into the
  // Projected phase (everything needed to show rows immediately) and the
  // Actual phase (ground-truth spend, fetched in the background). The leading
  // "breakdown" entry isn't a call — it's the readable "what's being imported"
  // view the right pane shows by default. Field names (summary / whatYouGet /
  // tradeoffs / whenToUse / calls) match what renderExplain consumes.
  const IMPORT_FLOW_STEPS = [
    {
      id: "breakdown",
      phase: "summary",
      label: "What's being imported",
      tag: "readable",
      fetchable: false,
      summary:
        "The decision set the import stamps onto the table view — per field: projected credits/row, coverage, fill rate, then real billed spend once the Actual leg lands.",
      whatYouGet: [
        "Resolved billing plan (legacy vs modern) used for projected credits",
        "Counts: standalone enrichments, waterfalls, basic groups, inputs",
        "Per-field projected credits/row, coverage (ran/total), fill rate",
        "Actual spend per field once the background leg returns",
      ],
      tradeoffs: [
        "Projected uses the model-aware catalog cost; Actual is 30-day Redshift spend",
        "Coverage/fill come from run-status counts (exact); basic-field fill is sampled",
      ],
      whenToUse: "Default view — see exactly what the table-view import produces.",
      calls: ["(computed from the steps below — no call of its own)"],
    },
    {
      id: "catalog",
      phase: "projected",
      label: "Action catalog",
      tag: "cached · 24h",
      fetchable: true,
      summary:
        "Enrichment catalog: base credits per action (both pricing tiers), AI detection, and action-execution flags. Cached in localStorage for 24h.",
      whatYouGet: [
        "Per-action base credits (modern + legacy tiers)",
        "AI detection + model options",
        "actionExecution + private-key credit flags",
      ],
      tradeoffs: ["Cached up to 24h — a brand-new action can be a day stale"],
      whenToUse: "Inspect the catalog entry behind any imported enrichment.",
      calls: ["GET /v3/actions?workspaceId=:ws"],
    },
    {
      id: "modelpricing",
      phase: "projected",
      label: "AI model pricing",
      tag: "cached · 24h",
      fetchable: true,
      summary:
        "Per-model AI credit costs, workspace-scaled. Drives the projected cost of Use AI / Claygent columns. Cached 24h.",
      whatYouGet: ["modelName → base credit cost for the workspace"],
      tradeoffs: ["Cached up to 24h"],
      whenToUse: "Check the per-row cost the canvas uses for a given AI model.",
      calls: ["GET /v3/model-pricing/:ws/base-costs"],
    },
    {
      id: "plan",
      phase: "projected",
      label: "Billing plan",
      tag: "cached · 24h",
      fetchable: true,
      summary:
        "The workspace's active billing plan, classified legacy (pre-2026) vs modern (post-2026). Determines which catalog pricing tier projected credits use.",
      whatYouGet: ["planType", "isLegacy / isModern", "per-credit rate when available"],
      tradeoffs: ["Cached up to 24h"],
      whenToUse: "Confirm which pricing tier the projected credits are computed against.",
      calls: ["GET /v3/billingplans/:ws?source=frontend"],
    },
    {
      id: "tables",
      phase: "projected",
      label: "Table list",
      tag: "1 call",
      fetchable: true,
      summary:
        "The workbook's tables with fields, field groups, and views. Drives the import classification (inputs / waterfalls / basic groups / standalone) and cluster cost-sharing.",
      whatYouGet: ["fields[]", "fieldGroupMap (waterfalls + basic groups)", "views[]"],
      tradeoffs: ["Whole-workbook payload — but the import only reads the open table"],
      whenToUse: "Inspect the raw field + group structure the classifier consumes.",
      calls: ["GET /v3/workbooks/:wb/tables"],
    },
    {
      id: "context",
      phase: "projected",
      label: "Field context (fast)",
      tag: "1 call · small sample",
      fetchable: true,
      summary:
        "The fast /context call: per-field credit cost + run-status coverage/fill, with a small sample size so it skips the all-rows value scan the old `full` preset did.",
      whatYouGet: [
        "Per-field creditCost (ActionCostMetadata)",
        "Coverage + fill from run-status counts (exact, all rows)",
        "Whole-table record count",
      ],
      tradeoffs: [
        "Basic-field value fill is sampled (small sampleSize), not all rows",
        "creditCost is computed legacy-side; modern plans get the catalog tier swapped in",
      ],
      whenToUse: "See the projected per-field cost + coverage the import reads.",
      calls: [
        "POST /v3/workspaces/:ws/tables/:id/context  customOptions { includeCreditCosts, includeStatusCounts, sampleSize: " +
          (__cb.IMPORT_CONTEXT_SAMPLE_SIZE ?? 50) +
          " }",
      ],
    },
    {
      id: "spend",
      phase: "actual",
      label: "Realtime spend",
      tag: "background · ground truth",
      fetchable: true,
      summary:
        "The Actual leg: real billed credits + action executions per column over the last 30 days. Fetched in the background after projected rows render, so toggling Actual is instant.",
      whatYouGet: ["Per-field creditsSpent", "actionExecutionCreditsSpent", "cellCount"],
      tradeoffs: [
        "Only complete since 2025-11-05; older tables under-count",
        "Lags real time by a few minutes (Redshift via Kinesis)",
      ],
      whenToUse: "Compare projected estimates against what Clay actually billed.",
      calls: ["GET /v3/realtime-credit-usage/:ws/table/:id/column/recent?days=30"],
    },
  ];

  // Static sample model shown when no Clay table is open, so the import flow
  // stays explorable offline. Mirrors the live model shape buildInspectorModel
  // returns: { plan, recordCount, counts, fieldRows }.
  const SAMPLE_MODEL = {
    sample: true,
    plan: { planType: "growth", isModern: true, planIsModern: true },
    recordCount: 12480,
    counts: { standalone: 1, waterfalls: 1, basicGroups: 1, inputs: 2 },
    fieldRows: [
      { name: "Full Name", type: "—", group: "Input", projected: null, coverage: null, fill: null, spend: null },
      { name: "Company Domain", type: "—", group: "Input", projected: null, coverage: null, fill: null, spend: null },
      {
        name: "Score Lead (AI)", type: "Enrichment", group: "Standalone",
        projected: 6.8,
        coverage: { ran: 12480, total: 12480 },
        fill: { success: 11900, ran: 12480 },
        spend: { credits: 84864, actionExecutions: 12480, cellCount: 12480 },
      },
      {
        name: "Find Work Email · find_email_apollo", type: "Enrichment", group: "Waterfall",
        projected: 1,
        coverage: { ran: 12480, total: 12480 },
        fill: { success: 7201, ran: 12480 },
        spend: { credits: 7843, actionExecutions: 7901, cellCount: 7931 },
      },
      {
        name: "Find Job Title", type: "Enrichment", group: "Person Enrichment",
        projected: 2,
        coverage: { ran: 12480, total: 12480 },
        fill: { success: 9800, ran: 12480 },
        spend: { credits: 19600, actionExecutions: 9800, cellCount: 9800 },
      },
    ],
  };

  // ---- Inspector model helpers (shared by live + sample rendering) ----

  function inspectorCatalogInfo(field) {
    if (!field?.actionKey) return null;
    const pkg = field.actionPackageId || "clay";
    return (
      __cb.actionByIdLookup?.[`${pkg}-${field.actionKey}`] ||
      __cb.actionByIdLookup?.[`${pkg}/${field.actionKey}`] ||
      null
    );
  }

  // Projected per-row credits for a field, mirroring the import's Layer A:
  // plan-aware catalog base + the server's resolution flags (per-result /
  // private-key / unlimited). Returns null for non-action fields.
  function projectedCreditsForField(field, stats) {
    if (field.type !== "action") return null;
    const info = inspectorCatalogInfo(field);
    const base = info
      ? (__cb.planAwareBaseCredits ? __cb.planAwareBaseCredits(info) : (info.credits ?? null))
      : null;
    if (!stats?.cost) return base;
    if (stats.cost.unlimited || stats.cost.isPrivateKey) return 0;
    const override = __cb.importPlanIsModern && __cb.importPlanIsModern() ? base : null;
    return __cb.resolveEffectiveCredits
      ? __cb.resolveEffectiveCredits(stats.cost, base, override)
      : base;
  }

  function inspectorCounts(decision) {
    return {
      standalone: (decision.standaloneFields || []).length,
      waterfalls: (decision.waterfalls || []).length,
      basicGroups: (decision.basicGroups || []).length,
      inputs: (decision.inputs?.leafInputFields || []).length,
    };
  }

  function contextRecordCount(context) {
    const fromRunInfo = context?.tableRunInfo?.tableRowCount;
    if (typeof fromRunInfo === "number" && fromRunInfo > 0) return fromRunInfo;
    const fc = context?.fieldConfigurationsData?.fieldConfigs?.find(
      (f) => f?.dataProfile?.totalRecords != null
    );
    return fc?.dataProfile?.totalRecords ?? null;
  }

  // Flattens the decision set into readable per-field rows: one row per field,
  // grouped by its role (Input / Standalone / Waterfall / basic group name).
  function buildInspectorFieldRows(decision) {
    if (!decision) return [];
    const joined = decision.joined || {};
    const rows = [];

    // Enrichment display name by lineage key (action field id, or
    // "wf:<groupId>"), so each data point row can show its source enrichment.
    const enrichmentNameByKey = new Map();
    for (const f of decision.standaloneFields || []) enrichmentNameByKey.set(f.id, f.name || f.id);
    for (const bg of decision.basicGroups || []) {
      for (const f of bg.erFields || []) enrichmentNameByKey.set(f.id, f.name || f.id);
    }
    for (const wf of decision.waterfalls || []) {
      enrichmentNameByKey.set(`wf:${wf.groupId}`, wf.name || "Waterfall");
    }

    const push = (field, group, source) => {
      const stats = joined[field.id] || null;
      rows.push({
        name: field.name || field.id,
        type: field.type === "action" ? "Enrichment" : (field.type || "—"),
        group,
        source: source ?? "\u2014",
        projected: projectedCreditsForField(field, stats),
        coverage: stats?.coverage || null,
        fill: stats?.fillRate || null,
        spend: stats?.spend || null,
      });
    };
    for (const f of decision.inputs?.leafInputFields || []) push(f, "Input", "\u2014");
    for (const f of decision.standaloneFields || []) push(f, "Standalone", "\u2014");
    for (const wf of decision.waterfalls || []) {
      for (const s of wf.steps || []) {
        push(
          {
            id: s.fieldId,
            name: `${wf.name || "Waterfall"} \u00b7 ${s.actionKey}`,
            type: "action",
            actionKey: s.actionKey,
            actionPackageId: s.actionPackageId,
          },
          "Waterfall",
          "\u2014"
        );
      }
    }
    for (const bg of decision.basicGroups || []) {
      for (const f of bg.erFields || []) push(f, bg.name || "Group", "\u2014");
    }
    // Data points (lineage) — each shows the enrichment(s) it derives from. A
    // DP can resolve to multiple ancestors (chain/fallback); join their names.
    for (const dp of decision.dataPoints || []) {
      const keys = Array.isArray(dp.sourceEnrichmentFieldIds) && dp.sourceEnrichmentFieldIds.length
        ? dp.sourceEnrichmentFieldIds
        : (dp.sourceEnrichmentFieldId != null ? [dp.sourceEnrichmentFieldId] : []);
      const sourceName =
        keys.map((k) => enrichmentNameByKey.get(k) || k).join(" + ") || "\u2014";
      push({ id: dp.id, name: dp.name, type: "data point" }, "Data point", sourceName);
    }
    return rows;
  }

  // Builds the readable inspector model from the live legs. Spend is optional
  // — pass null for the projected-first pass, then rebuild with spend once the
  // Actual leg lands.
  function buildInspectorModel({ table, context, spend, viewId }) {
    const decision = __cb.buildImportDecisionSet({ table, viewId, context, spend });
    return {
      plan: __cb.currentPlanPricing || null,
      recordCount: contextRecordCount(context),
      counts: inspectorCounts(decision),
      fieldRows: buildInspectorFieldRows(decision),
      decision,
    };
  }

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
  // Fetches the raw payload for one import-flow step (for the per-step JSON
  // view). Cached static steps resolve via ensureStaticData and return the
  // in-memory lookups; the rest hit their endpoint. Returns { payload,
  // durationMs }; throws with code "missing_table" when a table is required
  // but none is open.
  async function fetchStepPayload(stepId) {
    const ids = parseTableIdsFromUrl();
    const workspaceId = ids?.workspaceId;
    const tableId = ids?.tableId;
    if (!workspaceId) {
      const err = new Error("Open a Clay workspace to inspect the import flow.");
      err.code = "missing_table";
      throw err;
    }

    if (stepId === "catalog") {
      const t = await timed("catalog", __cb.ensureStaticData(workspaceId));
      if (t.error) throw t.error;
      return { payload: { actions: Object.values(__cb.enrichmentLookup || {}) }, durationMs: t.durationMs };
    }
    if (stepId === "modelpricing") {
      const t = await timed("modelpricing", __cb.ensureStaticData(workspaceId));
      if (t.error) throw t.error;
      return { payload: __cb.livePricingByModel || {}, durationMs: t.durationMs };
    }
    if (stepId === "plan") {
      const t = await timed("plan", __cb.ensureStaticData(workspaceId));
      if (t.error) throw t.error;
      return { payload: __cb.currentPlanPricing || null, durationMs: t.durationMs };
    }
    if (stepId === "tables") {
      const t = await timed("tables", __cb.fetchTableList(ids.workbookId));
      if (t.error) throw t.error;
      return { payload: t.value, durationMs: t.durationMs };
    }

    if (!tableId) {
      const err = new Error("Open a Clay table to inspect this step.");
      err.code = "missing_table";
      throw err;
    }

    if (stepId === "context") {
      const t = await timed("context", __cb.fetchTableContextForImport(workspaceId, tableId));
      if (t.error) throw t.error;
      return { payload: t.value, durationMs: t.durationMs };
    }
    if (stepId === "spend") {
      const t = await timed("spend", __cb.fetchColumnSpend(workspaceId, tableId, 30));
      if (t.error) throw t.error;
      return { payload: t.value, durationMs: t.durationMs };
    }

    throw new Error(`Unknown step: ${stepId}`);
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

    // Per-step JSON cache (the raw payload behind each call), fetched lazily
    // when a step is selected.
    const stepCache = {};
    for (const s of IMPORT_FLOW_STEPS) {
      if (s.fetchable) stepCache[s.id] = { state: "idle", payload: null, durationMs: null, error: null };
    }
    // The readable "what's being imported" model. Projected first; the Actual
    // (spend) leg fills in afterwards.
    let model = null;
    let modelState = "idle"; // idle | loading | ready | error | sample
    let modelError = null;
    let spendState = "idle"; // idle | loading | ready | error
    let selected = "breakdown";

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
    title.textContent = "Import flow inspector";
    const subtitle = document.createElement("div");
    subtitle.className = "cb-export-modal-subtitle";
    subtitle.textContent =
      "Every API call the table import makes, in order — Projected first, then Actual. " +
      "See what gets imported and inspect any call's raw JSON.";
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

    // Left column: ordered API-call breakdown grouped by phase ------------
    const left = document.createElement("div");
    left.className = "cb-export-json-left";

    const picker = document.createElement("div");
    picker.className = "cb-export-json-picker";
    picker.setAttribute("role", "tablist");
    const pickerButtons = new Map();

    const phaseLabel = (text) => {
      const el = document.createElement("div");
      el.className = "cb-export-json-phase-label";
      el.textContent = text;
      return el;
    };

    let lastPhase = null;
    for (const def of IMPORT_FLOW_STEPS) {
      if (def.phase !== lastPhase) {
        lastPhase = def.phase;
        if (def.phase === "projected") picker.appendChild(phaseLabel("Projected \u2014 on import"));
        else if (def.phase === "actual") picker.appendChild(phaseLabel("Actual \u2014 background"));
      }
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
        if (selected === def.id) return;
        selected = def.id;
        renderAll();
        if (def.fetchable) loadStep(def.id);
      });
      picker.appendChild(btn);
      pickerButtons.set(def.id, btn);
    }
    left.appendChild(picker);

    const explain = document.createElement("div");
    explain.className = "cb-export-json-explain";
    left.appendChild(explain);

    // Right column --------------------------------------------------------
    const right = document.createElement("div");
    right.className = "cb-export-json-right";

    const rightHeader = document.createElement("div");
    rightHeader.className = "cb-export-json-right-header";

    // Projected -> Actual progress indicator.
    const phaseStatus = document.createElement("div");
    phaseStatus.className = "cb-export-json-phase-status";
    rightHeader.appendChild(phaseStatus);

    const timing = document.createElement("div");
    timing.className = "cb-export-json-timing";
    rightHeader.appendChild(timing);

    right.appendChild(rightHeader);

    // Search bar (JSON view only).
    const searchBar = document.createElement("div");
    searchBar.className = "cb-export-json-search-bar";
    const searchInput = document.createElement("input");
    searchInput.type = "search";
    searchInput.className = "cb-export-json-search-input";
    searchInput.placeholder = "Search JSON\u2026  (Enter \u2014 next, Shift+Enter \u2014 prev)";
    searchInput.autocomplete = "off";
    searchInput.spellcheck = false;
    const searchCounter = document.createElement("span");
    searchCounter.className = "cb-export-json-search-counter";
    searchBar.appendChild(searchInput);
    searchBar.appendChild(searchCounter);
    right.appendChild(searchBar);

    // Readable breakdown container (shown for the "breakdown" selection).
    const breakdownWrap = document.createElement("div");
    breakdownWrap.className = "cb-export-json-breakdown-wrap";
    right.appendChild(breakdownWrap);

    // Raw JSON preview (shown for any individual call).
    const previewWrap = document.createElement("div");
    previewWrap.className = "cb-export-json-preview-wrap";
    const preview = document.createElement("pre");
    preview.className = "cb-export-json-preview";
    previewWrap.appendChild(preview);
    right.appendChild(previewWrap);

    let searchQuery = "";
    let searchText = "";
    let currentMatchIdx = -1;
    let currentMatchCount = 0;

    searchInput.addEventListener("input", () => {
      searchQuery = searchInput.value;
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
      "Read-only — hits Clay's APIs with your session cookies. Nothing is uploaded anywhere.";

    const downloadBtn = document.createElement("button");
    downloadBtn.type = "button";
    downloadBtn.className = "cb-export-submit cb-export-json-download";
    downloadBtn.textContent = "Download JSON";
    downloadBtn.addEventListener("click", () => {
      const dl = currentDownload();
      if (dl) downloadJson(dl.filename, dl.text);
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

    // ---- Formatters ----
    const creditText = (n) =>
      n == null || !Number.isFinite(n) ? "\u2014" : (n % 1 === 0 ? String(n) : n.toFixed(1));
    const coverageText = (cov) =>
      cov && Number(cov.total)
        ? `${Number(cov.ran).toLocaleString()} / ${Number(cov.total).toLocaleString()}`
        : "\u2014";
    const fillText = (fr) =>
      fr && Number(fr.ran) ? `${Math.round((Number(fr.success) / Number(fr.ran)) * 100)}%` : "\u2014";
    const actualText = (sp) => {
      if (sp) return `${Number(sp.credits).toLocaleString()} cr`;
      if (spendState === "loading") return "computing\u2026";
      return "\u2014";
    };

    // ---- Render helpers ----
    function renderPicker() {
      for (const [id, btn] of pickerButtons.entries()) {
        btn.classList.toggle("cb-export-json-endpoint-active", id === selected);
        btn.setAttribute("aria-selected", id === selected ? "true" : "false");
        const def = IMPORT_FLOW_STEPS.find((d) => d.id === id);
        let dot = "";
        if (def?.fetchable) {
          const st = stepCache[id]?.state;
          dot =
            st === "ready" ? " \u2713" : st === "loading" ? " \u2026" : st === "error" ? " !" : "";
        }
        const labelEl = btn.querySelector(".cb-export-json-endpoint-label");
        if (labelEl) labelEl.textContent = def.label + dot;
      }
    }

    function renderPhaseStatus() {
      const proj =
        modelState === "ready" ? "\u2713" : modelState === "loading" ? "\u2026" : modelState === "error" ? "!" : "";
      const act =
        spendState === "ready" ? "\u2713" : spendState === "loading" ? "\u2026" : "";
      phaseStatus.innerHTML =
        `<span class="cb-export-json-phase-pill cb-export-json-phase-pill-${modelState}">Projected ${proj}</span>` +
        `<span class="cb-export-json-phase-arrow">\u2192</span>` +
        `<span class="cb-export-json-phase-pill cb-export-json-phase-pill-${spendState}">Actual ${act}</span>`;
    }

    function renderExplain() {
      const def = IMPORT_FLOW_STEPS.find((d) => d.id === selected);
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
      if (selected === "breakdown") {
        timing.style.visibility = "hidden";
        timing.textContent = "";
        return;
      }
      timing.style.visibility = "visible";
      const entry = stepCache[selected];
      if (!entry || entry.state === "idle") { timing.textContent = ""; return; }
      if (entry.state === "loading") {
        timing.classList.add("cb-export-json-timing-loading");
        timing.textContent = "Fetching\u2026";
        return;
      }
      if (entry.state === "error") {
        timing.classList.add("cb-export-json-timing-error");
        timing.textContent = `Error \u00b7 ${formatDuration(entry.durationMs)}`;
        timing.title = entry.error?.message || "";
        return;
      }
      timing.classList.add("cb-export-json-timing-ready");
      timing.textContent = formatDuration(entry.durationMs);
      timing.title = "Wall-clock latency of this call.";
    }

    // Renders the readable "what's being imported" table.
    function renderBreakdown() {
      breakdownWrap.innerHTML = "";
      if (modelState === "loading") {
        breakdownWrap.innerHTML = `<div class="cb-export-json-breakdown-empty">Running the projected import legs\u2026</div>`;
        return;
      }
      if (modelState === "error") {
        breakdownWrap.innerHTML = `<div class="cb-export-json-breakdown-empty">${escapeHtml(modelError?.message || "Could not load the import flow.")}<br><br>Open a Clay table and reopen this dialog.</div>`;
        return;
      }
      if (!model) {
        breakdownWrap.innerHTML = `<div class="cb-export-json-breakdown-empty">Open a Clay table to inspect the import.</div>`;
        return;
      }
      const plan = model.plan;
      const planText = plan
        ? `${plan.displayName || plan.planType || "plan"} (${plan.planIsModern || plan.isModern ? "modern" : "legacy"} pricing)`
        : "unknown plan";
      const c = model.counts || {};
      const rec = Number.isFinite(model.recordCount) ? model.recordCount.toLocaleString() : "\u2014";
      const sampleNote = model.sample
        ? `<div class="cb-export-json-breakdown-sample">Sample data — open a Clay table for live values.</div>`
        : "";

      let rowsHtml = "";
      for (const r of model.fieldRows || []) {
        rowsHtml +=
          "<tr>" +
          `<td class="cb-bd-name" title="${escapeHtml(r.name)}">${escapeHtml(r.name)}</td>` +
          `<td>${escapeHtml(r.group)}</td>` +
          `<td class="cb-bd-name" title="${escapeHtml(r.source || "\u2014")}">${escapeHtml(r.source || "\u2014")}</td>` +
          `<td class="cb-bd-num">${r.type === "Enrichment" ? creditText(r.projected) : "\u2014"}</td>` +
          `<td class="cb-bd-num">${coverageText(r.coverage)}</td>` +
          `<td class="cb-bd-num">${fillText(r.fill)}</td>` +
          `<td class="cb-bd-num cb-bd-actual">${actualText(r.spend)}</td>` +
          "</tr>";
      }

      breakdownWrap.innerHTML =
        sampleNote +
        `<div class="cb-export-json-breakdown-summary">` +
          `<span class="cb-bd-chip">Plan: ${escapeHtml(planText)}</span>` +
          `<span class="cb-bd-chip">${rec} rows</span>` +
          `<span class="cb-bd-chip">${c.standalone || 0} standalone</span>` +
          `<span class="cb-bd-chip">${c.waterfalls || 0} waterfalls</span>` +
          `<span class="cb-bd-chip">${c.basicGroups || 0} groups</span>` +
          `<span class="cb-bd-chip">${c.inputs || 0} inputs</span>` +
        `</div>` +
        `<table class="cb-export-json-breakdown-table"><thead><tr>` +
          `<th>Field</th><th>Group</th><th>Source enrichment</th><th class="cb-bd-num">Projected cr/row</th>` +
          `<th class="cb-bd-num">Coverage</th><th class="cb-bd-num">Fill</th>` +
          `<th class="cb-bd-num">Actual</th>` +
        `</tr></thead><tbody>${rowsHtml}</tbody></table>`;
    }

    function renderStepJson() {
      preview.classList.remove("cb-export-json-preview-error", "cb-export-json-preview-empty");
      searchText = "";
      const entry = stepCache[selected];
      if (!entry || entry.state === "idle" || entry.state === "loading") {
        preview.classList.add("cb-export-json-preview-empty");
        preview.textContent = "Fetching from Clay\u2026";
        applySearchHighlight({ scroll: false });
        return;
      }
      if (entry.state === "error") {
        preview.classList.add("cb-export-json-preview-error");
        preview.textContent =
          (entry.error?.message || "Request failed.") +
          "\n\nOpen a Clay table and reopen this dialog, or check the console.";
        applySearchHighlight({ scroll: false });
        return;
      }
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

    function renderRight() {
      const isBreakdown = selected === "breakdown";
      breakdownWrap.style.display = isBreakdown ? "" : "none";
      previewWrap.style.display = isBreakdown ? "none" : "";
      if (isBreakdown) {
        searchBar.classList.remove("cb-export-json-search-bar-visible");
        renderBreakdown();
      } else {
        renderStepJson();
      }
    }

    function applySearchHighlight({ scroll }) {
      const canSearch = selected !== "breakdown" && searchText !== "";
      searchBar.classList.toggle("cb-export-json-search-bar-visible", canSearch);
      if (!canSearch) {
        currentMatchCount = 0; currentMatchIdx = -1; renderSearchCounter(); return;
      }
      if (!searchQuery) {
        preview.textContent = searchText;
        currentMatchCount = 0; currentMatchIdx = -1; renderSearchCounter(); return;
      }
      const { html, count } = buildHighlightedHtml(searchText, searchQuery);
      preview.innerHTML = html;
      currentMatchCount = count;
      if (count === 0) {
        currentMatchIdx = -1;
      } else {
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

    function currentDownload() {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      if (selected === "breakdown") {
        if (!model) return null;
        const payload = model.decision || model;
        return { filename: `clay-import-breakdown-${stamp}.json`, text: JSON.stringify(payload, null, 2) };
      }
      const entry = stepCache[selected];
      if (!entry || entry.state !== "ready" || entry.payload == null) return null;
      return { filename: `clay-import-${selected}-${stamp}.json`, text: JSON.stringify(entry.payload, null, 2) };
    }

    function renderDownloadButton() {
      const enabled = !!currentDownload();
      downloadBtn.disabled = !enabled;
      downloadBtn.classList.toggle("cb-export-json-download-disabled", !enabled);
    }

    function renderAll() {
      renderPicker();
      renderPhaseStatus();
      renderExplain();
      renderTimingChip();
      renderRight();
      renderDownloadButton();
    }

    // Lazily fetch a single step's raw payload for the JSON view.
    async function loadStep(stepId) {
      const entry = stepCache[stepId];
      if (!entry || entry.state === "ready" || entry.state === "loading") {
        renderAll();
        return;
      }
      entry.state = "loading";
      entry.error = null;
      renderAll();
      try {
        const result = await fetchStepPayload(stepId);
        entry.state = "ready";
        entry.payload = result.payload;
        entry.durationMs = result.durationMs;
      } catch (err) {
        entry.state = "error";
        entry.error = err;
      }
      if (selected === stepId || selected === "breakdown") renderAll();
    }

    // Runs the projected legs, renders the breakdown, then fills in actuals.
    async function loadModel() {
      const ids = parseTableIdsFromUrl();
      if (!ids?.tableId) {
        model = SAMPLE_MODEL;
        modelState = "sample";
        spendState = "idle";
        renderAll();
        return;
      }
      if (!__cb.buildImportDecisionSet) {
        modelState = "error";
        modelError = new Error("buildImportDecisionSet not loaded — reload the extension.");
        renderAll();
        return;
      }
      modelState = "loading";
      renderAll();
      try {
        await __cb.ensureStaticData(ids.workspaceId);
        const [table, context] = await Promise.all([
          resolveTable(ids.workbookId, ids.tableId),
          __cb.fetchTableContextForImport(ids.workspaceId, ids.tableId),
        ]);
        if (!table) throw new Error("Table not found in this workbook's listing.");
        model = buildInspectorModel({ table, context, spend: null, viewId: ids.viewId });
        modelState = "ready";
        renderAll();

        // Actual leg in the background — rebuild with spend when it lands.
        spendState = "loading";
        renderAll();
        try {
          const spend = await __cb.fetchColumnSpend(ids.workspaceId, ids.tableId, 30);
          model = buildInspectorModel({ table, context, spend, viewId: ids.viewId });
          spendState = "ready";
        } catch {
          spendState = "error";
        }
        renderAll();
      } catch (err) {
        modelState = "error";
        modelError = err;
        renderAll();
      }
    }

    renderAll();
    loadModel();
  };
})();
