(function () {
  "use strict";

  const __cb = window.__cb;

  // The table view is a second presentation of the SAME canvas state — cards,
  // clusters, and groups continue to live on `__cb.canvas`. Mounting just
  // builds a sticky-header spreadsheet inside the host element; unmounting
  // empties it. `refresh()` re-renders rows from the current canvas snapshot
  // and is wired into `__cb.onCanvasStateChange` (in overlay.js) so picker
  // confirms, undo, realtime, etc. propagate without manual reloads.
  //
  // Mutation hooks delegate back into the canvas API:
  //   - DP name + fill-rate edits reuse the same writers the Export-as-Table
  //     modal uses (commitDpName / commitFillRate, defined here so the table
  //     view doesn't depend on src/export.js).
  //   - "+ Add data point" calls `__cb.canvas.addDataPointCard`.
  //   - "+ Add enrichment" sets `__cb.linkTargetCardId` then opens the
  //     enrichment picker; picker.js's existing placeCardsAdjacentTo flow
  //     drops the new ER cards next to the DP and calls refreshClusters,
  //     so the new chips appear on the row automatically.
  //   - Row × (DP) and chip × (orphan ER) call `__cb.canvas.removeCard`.

  let hostEl = null;
  let tableEl = null;

  // ---- Card-type helpers (mirror src/export.js) ----

  function isNonErType(type) {
    return type === "dp" || type === "input" || type === "comment";
  }

  function isErType(type) {
    return !isNonErType(type) && type !== undefined;
  }

  function fillRatePct(fr) {
    if (!fr || !fr.denominator) return 0;
    return Math.round((fr.numerator / fr.denominator) * 100);
  }

  function formatNumber(n) {
    if (!Number.isFinite(n)) return "0";
    return n % 1 === 0
      ? n.toLocaleString()
      : n.toLocaleString(undefined, { maximumFractionDigits: 1 });
  }

  // ---- Row model ----
  //
  // Rows are grouped into three sections by `kind`:
  //   - "orphan-er"  — ER not in any DP-bearing cluster (top of the table)
  //   - "dp"         — data point row (middle, the bulk)
  //   - "add-dp"     — sticky footer row for adding a new DP (rendered separately)

  function buildRows() {
    const canvas = __cb.canvas;
    if (!canvas) return { orphanErRows: [], dpRows: [] };

    const allCards = canvas.getCards();
    const clusters = canvas.getSnapClusters();

    // Map each cluster's ER cards to the DPs that "claim" them. Clusters
    // without DPs leave their ERs eligible for the orphan section below.
    const dpInfoMap = new Map();
    const claimedErIds = new Set();

    for (const cluster of clusters) {
      const clusterCards = cluster
        .map((id) => allCards.find((c) => c.id === id))
        .filter(Boolean);
      const erCards = clusterCards.filter((c) => isErType(c.data.type));
      const dpCards = clusterCards.filter((c) => c.data.type === "dp");
      if (dpCards.length === 0) continue;

      let totalCredits = 0;
      let totalActions = 0;
      for (const er of erCards) {
        if (!er.data.usePrivateKey && er.data.credits != null) {
          totalCredits += er.data.credits;
        }
        if (er.data.actionExecutions != null) {
          totalActions += er.data.actionExecutions;
        }
        claimedErIds.add(er.id);
      }

      const perDpCredits = dpCards.length > 0 ? totalCredits / dpCards.length : 0;
      const perDpActions = dpCards.length > 0 ? totalActions / dpCards.length : 0;
      const erList = erCards.map((er) => buildErChipData(er));

      for (const dp of dpCards) {
        dpInfoMap.set(dp.id, {
          credits: perDpCredits,
          actions: perDpActions,
          ers: erList,
          enrichmentCount: erCards.length,
        });
      }
    }

    const dpRows = [];
    for (const card of allCards) {
      if (card.data.type !== "dp") continue;
      const info = dpInfoMap.get(card.id);
      dpRows.push({
        kind: "dp",
        cardId: card.id,
        name: card.data.text || card.data.displayName || "",
        fillRatePct: fillRatePct(card.data.fillRate),
        credits: info ? info.credits : 0,
        actions: info ? info.actions : 0,
        ers: info ? info.ers : [],
        connected: !!info && info.enrichmentCount > 0,
      });
    }

    // Orphan ERs: any ER card not in a DP-bearing cluster. This includes
    // ERs in ER-only clusters (e.g. a waterfall + its standalone neighbor
    // with no DP attached) AND fully-floating ER cards.
    const orphanErRows = [];
    for (const card of allCards) {
      if (!isErType(card.data.type)) continue;
      if (claimedErIds.has(card.id)) continue;
      const credits = !card.data.usePrivateKey && card.data.credits != null
        ? card.data.credits
        : 0;
      const actions = card.data.actionExecutions != null
        ? card.data.actionExecutions
        : 0;
      orphanErRows.push({
        kind: "orphan-er",
        cardId: card.id,
        credits,
        actions,
        er: buildErChipData(card),
      });
    }

    return { orphanErRows, dpRows };
  }

  function buildErChipData(er) {
    const isWaterfall = er.data.type === "waterfall";
    const providerChain = isWaterfall
      ? (er.data.providers || []).map((p) => p.displayName || "Provider").join(" \u2192 ")
      : null;
    return {
      id: er.id,
      name: er.data.displayName || er.data.text || (isWaterfall ? "Waterfall" : "Untitled enrichment"),
      isWaterfall,
      providerChain,
    };
  }

  // ---- Mutation handlers ----
  //
  // Mirrors the writers in src/export.js — kept duplicated so the table view
  // doesn't have to depend on the export modal's IIFE-private functions.
  // Both code paths converge on canvas.notifyChange() + saveTabs(), so undo
  // history and persistence behave identically.

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

    const parsed = Number(rawValue);
    const pct = Number.isFinite(parsed) ? Math.max(0, Math.min(100, parsed)) : 0;

    const fr = card.data.fillRate || { numerator: 0, denominator: 100 };
    const denominator = fr.denominator > 0 ? fr.denominator : 100;
    const numerator = Math.round((pct / 100) * denominator);
    card.data.fillRate = { numerator, denominator };
    card.data.fillRateCustom = true;

    const labelEl = card.el?.querySelector(".cb-dp-fill-label");
    if (labelEl) labelEl.textContent = `${pct}%`;

    if (canvas.notifyChange) canvas.notifyChange();
    if (__cb.saveTabs) __cb.saveTabs();
  }

  // Picker entry point. Setting linkTargetCardId hands placement off to
  // picker.js → placeCardsAdjacentTo, which finds the best adjacent side and
  // calls refreshClusters() so the new ER joins the DP's snap-cluster
  // automatically. We don't need to compute coordinates ourselves.
  function startAddEnrichment(targetCardId) {
    if (!__cb.canvas || !__cb.startPickerMode) return;
    if (targetCardId) __cb.linkTargetCardId = targetCardId;
    __cb.startPickerMode();
  }

  function startAddOrphanEnrichment() {
    if (!__cb.startPickerMode) return;
    // No link target → picker drops cards at enrichmentClickPos (null here)
    // which falls through to canvas-center placement in picker.js.
    __cb.linkTargetCardId = null;
    __cb.enrichmentClickPos = null;
    __cb.startPickerMode();
  }

  function removeCardById(cardId) {
    const canvas = __cb.canvas;
    if (!canvas?.getCardById) return;
    const card = canvas.getCardById(cardId);
    if (!card) return;
    // The card's own .cb-card-delete button calls removeCard() through the
    // cards.js IIFE. Replicate that by simulating the click — keeps undo /
    // group cleanup / cluster recalc all flowing through the canonical path.
    const del = card.el?.querySelector(".cb-card-delete");
    if (del) del.click();
  }

  function startAddDataPoint(text) {
    const canvas = __cb.canvas;
    if (!canvas?.addDataPointCard) return null;
    // Drop the new DP below the lowest existing card so the canvas layout
    // isn't disturbed when the user switches back. Using offsets relative
    // to existing cards (vs canvas center) avoids stacking many new DPs on
    // top of each other when the user adds several from the table view.
    const cards = canvas.getCards();
    let nextX = 0;
    let nextY = 0;
    if (cards.length > 0) {
      let maxBottom = -Infinity;
      let leftMostXAtMax = 0;
      for (const c of cards) {
        const bottom = c.y + 70;
        if (bottom > maxBottom) {
          maxBottom = bottom;
          leftMostXAtMax = c.x;
        }
      }
      nextX = leftMostXAtMax;
      nextY = maxBottom + 40;
    }
    const card = canvas.addDataPointCard(text || "", { x: nextX, y: nextY });
    if (canvas.notifyChange) canvas.notifyChange();
    return card;
  }

  // ---- Rendering ----

  function render() {
    if (!hostEl) return;
    hostEl.innerHTML = "";

    const wrap = document.createElement("div");
    wrap.className = "cb-table-view-wrap";

    const intro = document.createElement("div");
    intro.className = "cb-table-view-intro";
    const introTitle = document.createElement("div");
    introTitle.className = "cb-table-view-intro-title";
    introTitle.textContent = "Spreadsheet view";
    const introSub = document.createElement("div");
    introSub.className = "cb-table-view-intro-sub";
    introSub.textContent =
      "Edit data points and add enrichments inline. Changes write back to the canvas immediately.";
    intro.appendChild(introTitle);
    intro.appendChild(introSub);

    const introActions = document.createElement("div");
    introActions.className = "cb-table-view-intro-actions";
    const addOrphanErBtn = document.createElement("button");
    addOrphanErBtn.type = "button";
    addOrphanErBtn.className = "cb-table-view-add-er-btn";
    addOrphanErBtn.title = "Add an enrichment without attaching it to a data point";
    addOrphanErBtn.innerHTML = plusSvg(12) + "<span>Add enrichment</span>";
    addOrphanErBtn.addEventListener("click", () => startAddOrphanEnrichment());
    introActions.appendChild(addOrphanErBtn);
    intro.appendChild(introActions);

    wrap.appendChild(intro);

    const tableContainer = document.createElement("div");
    tableContainer.className = "cb-table-view-table-container";

    const { orphanErRows, dpRows } = buildRows();

    const table = document.createElement("table");
    table.className = "cb-table-view-table";
    tableEl = table;

    const thead = document.createElement("thead");
    const headRow = document.createElement("tr");
    const headers = [
      { label: "Data point", cls: "col-dp" },
      { label: "Fill rate (%)", cls: "col-fill" },
      { label: "Credits / row", cls: "col-credits" },
      { label: "Actions / row", cls: "col-actions" },
      { label: "Enrichments", cls: "col-ers" },
      { label: "", cls: "col-actions-end" },
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

    if (orphanErRows.length === 0 && dpRows.length === 0) {
      const empty = document.createElement("tr");
      empty.className = "cb-table-view-empty-row";
      const td = document.createElement("td");
      td.colSpan = headers.length;
      td.className = "cb-table-view-empty";
      td.textContent =
        "No data points yet. Click \u201c+ Add data point\u201d below or \u201cAdd enrichment\u201d above to get started.";
      empty.appendChild(td);
      tbody.appendChild(empty);
    } else {
      for (const row of orphanErRows) tbody.appendChild(buildOrphanErRow(row));
      for (const row of dpRows) tbody.appendChild(buildDpRow(row));
    }

    tbody.appendChild(buildAddDpRow(headers.length));

    table.appendChild(tbody);
    tableContainer.appendChild(table);
    wrap.appendChild(tableContainer);

    hostEl.appendChild(wrap);
  }

  function buildOrphanErRow(row) {
    const tr = document.createElement("tr");
    tr.className = "cb-table-view-orphan-er-row";
    tr.setAttribute("data-card-id", String(row.cardId));

    const dpCell = document.createElement("td");
    dpCell.className = "col-dp";
    const placeholder = document.createElement("span");
    placeholder.className = "cb-table-view-orphan-placeholder";
    placeholder.textContent = "Unattached enrichment";
    dpCell.appendChild(placeholder);
    tr.appendChild(dpCell);

    const fillCell = document.createElement("td");
    fillCell.className = "col-fill cb-table-view-cell-muted";
    fillCell.textContent = "\u2014";
    tr.appendChild(fillCell);

    const creditsCell = document.createElement("td");
    creditsCell.className = "col-credits cb-table-view-cell-readonly";
    creditsCell.textContent = formatNumber(row.credits);
    tr.appendChild(creditsCell);

    const actionsCell = document.createElement("td");
    actionsCell.className = "col-actions cb-table-view-cell-readonly";
    actionsCell.textContent = formatNumber(row.actions);
    tr.appendChild(actionsCell);

    const ersCell = document.createElement("td");
    ersCell.className = "col-ers";
    ersCell.appendChild(buildErChipEl(row.er, /* removable */ true));
    tr.appendChild(ersCell);

    const endCell = document.createElement("td");
    endCell.className = "col-actions-end";
    tr.appendChild(endCell);

    return tr;
  }

  function buildDpRow(row) {
    const tr = document.createElement("tr");
    tr.className = "cb-table-view-dp-row" + (row.connected ? "" : " cb-table-view-dp-row-unconnected");
    tr.setAttribute("data-card-id", String(row.cardId));

    const dpCell = document.createElement("td");
    dpCell.className = "col-dp";
    const dpInput = document.createElement("input");
    dpInput.type = "text";
    dpInput.className = "cb-table-view-cell-input cb-table-view-cell-input-text";
    dpInput.value = row.name;
    dpInput.placeholder = "Type data point\u2026";
    dpInput.addEventListener("keydown", (evt) => {
      if (evt.key === "Enter") evt.target.blur();
    });
    dpInput.addEventListener("blur", () => commitDpName(row.cardId, dpInput.value));
    dpCell.appendChild(dpInput);
    tr.appendChild(dpCell);

    const fillCell = document.createElement("td");
    fillCell.className = "col-fill";
    const fillInput = document.createElement("input");
    fillInput.type = "number";
    fillInput.min = "0";
    fillInput.max = "100";
    fillInput.step = "1";
    fillInput.className = "cb-table-view-cell-input cb-table-view-cell-input-num";
    fillInput.value = String(row.fillRatePct);
    fillInput.addEventListener("keydown", (evt) => {
      if (evt.key === "Enter") evt.target.blur();
    });
    fillInput.addEventListener("blur", () => commitFillRate(row.cardId, fillInput.value));
    const fillSuffix = document.createElement("span");
    fillSuffix.className = "cb-table-view-cell-suffix";
    fillSuffix.textContent = "%";
    fillCell.appendChild(fillInput);
    fillCell.appendChild(fillSuffix);
    tr.appendChild(fillCell);

    const creditsCell = document.createElement("td");
    creditsCell.className = "col-credits cb-table-view-cell-readonly";
    creditsCell.textContent = formatNumber(row.credits);
    tr.appendChild(creditsCell);

    const actionsCell = document.createElement("td");
    actionsCell.className = "col-actions cb-table-view-cell-readonly";
    actionsCell.textContent = formatNumber(row.actions);
    tr.appendChild(actionsCell);

    const ersCell = document.createElement("td");
    ersCell.className = "col-ers";
    const chipsWrap = document.createElement("div");
    chipsWrap.className = "cb-table-view-er-chips";
    for (const er of row.ers) {
      chipsWrap.appendChild(buildErChipEl(er, /* removable */ false));
    }
    const addErBtn = document.createElement("button");
    addErBtn.type = "button";
    addErBtn.className = "cb-table-view-add-er-chip";
    addErBtn.title = "Add an enrichment to this data point";
    addErBtn.innerHTML = plusSvg(11) + "<span>Add enrichment</span>";
    addErBtn.addEventListener("click", () => startAddEnrichment(row.cardId));
    chipsWrap.appendChild(addErBtn);
    ersCell.appendChild(chipsWrap);
    tr.appendChild(ersCell);

    const endCell = document.createElement("td");
    endCell.className = "col-actions-end";
    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.className = "cb-table-view-row-delete";
    delBtn.title = "Delete this data point from the canvas";
    delBtn.setAttribute("aria-label", "Delete data point");
    delBtn.innerHTML = xSvg(13);
    delBtn.addEventListener("click", () => removeCardById(row.cardId));
    endCell.appendChild(delBtn);
    tr.appendChild(endCell);

    return tr;
  }

  function buildErChipEl(er, removable) {
    const chip = document.createElement("span");
    chip.className =
      "cb-table-view-er-chip" + (er.isWaterfall ? " cb-table-view-er-chip-waterfall" : "");
    chip.title =
      er.isWaterfall && er.providerChain
        ? `${er.name} \u2014 ${er.providerChain}`
        : er.name;
    const label = document.createElement("span");
    label.className = "cb-table-view-er-chip-label";
    label.textContent = er.name;
    chip.appendChild(label);
    if (removable) {
      const x = document.createElement("button");
      x.type = "button";
      x.className = "cb-table-view-er-chip-remove";
      x.title = "Remove this enrichment from the canvas";
      x.setAttribute("aria-label", "Remove enrichment");
      x.innerHTML = xSvg(10);
      x.addEventListener("click", (evt) => {
        evt.stopPropagation();
        removeCardById(er.id);
      });
      chip.appendChild(x);
    }
    return chip;
  }

  function buildAddDpRow(colSpan) {
    const tr = document.createElement("tr");
    tr.className = "cb-table-view-add-dp-row";
    const td = document.createElement("td");
    td.colSpan = colSpan;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "cb-table-view-add-dp-btn";
    btn.innerHTML = plusSvg(12) + "<span>Add data point</span>";
    btn.addEventListener("click", () => {
      // Render an inline input in place of the button so the user can type
      // immediately without a modal. On Enter we create the canvas card and
      // re-render, which puts the new row into the table. On blur with empty
      // text we drop the input and restore the button.
      td.innerHTML = "";
      const input = document.createElement("input");
      input.type = "text";
      input.className = "cb-table-view-add-dp-input";
      input.placeholder = "Type data point name and press Enter\u2026";
      td.appendChild(input);
      input.focus();
      let committed = false;
      input.addEventListener("keydown", (evt) => {
        if (evt.key === "Enter") {
          evt.preventDefault();
          commit();
        } else if (evt.key === "Escape") {
          evt.preventDefault();
          render();
        }
      });
      input.addEventListener("blur", () => {
        if (!committed) commit();
      });
      function commit() {
        if (committed) return;
        committed = true;
        const text = input.value.trim();
        if (text.length > 0) {
          startAddDataPoint(text);
        }
        render();
      }
    });
    td.appendChild(btn);
    tr.appendChild(td);
    return tr;
  }

  function plusSvg(size) {
    const s = String(size);
    return (
      `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}" viewBox="0 0 24 24" ` +
      'fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" ' +
      'stroke-linejoin="round" aria-hidden="true">' +
      '<line x1="12" y1="5" x2="12" y2="19"/>' +
      '<line x1="5" y1="12" x2="19" y2="12"/>' +
      '</svg>'
    );
  }

  function xSvg(size) {
    const s = String(size);
    return (
      `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}" viewBox="0 0 24 24" ` +
      'fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" ' +
      'stroke-linejoin="round" aria-hidden="true">' +
      '<line x1="18" y1="6" x2="6" y2="18"/>' +
      '<line x1="6" y1="6" x2="18" y2="18"/>' +
      '</svg>'
    );
  }

  // ---- Public API ----

  __cb.tableView = {
    mount(host) {
      hostEl = host;
      render();
    },
    unmount() {
      if (hostEl) hostEl.innerHTML = "";
      hostEl = null;
      tableEl = null;
    },
    refresh() {
      if (!hostEl) return;
      // Skip the re-render while the user is mid-edit on a cell — re-rendering
      // would steal focus and drop their in-progress input. The blur handler
      // (which fires on commit) will trigger the next refresh via
      // notifyChange → onCanvasStateChange.
      const active = document.activeElement;
      if (active && hostEl.contains(active) && active.tagName === "INPUT") return;
      render();
    },
    isMounted() {
      return !!hostEl;
    },
  };
})();
