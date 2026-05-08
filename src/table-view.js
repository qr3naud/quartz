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

  // Tracks which group sections are currently collapsed (Set<groupClusterId>).
  // Lives at module scope so re-renders triggered by canvas state changes
  // (picker confirms, undo, realtime updates) preserve the user's expand /
  // collapse choices instead of snapping every group back open. Cleared
  // implicitly when a group's cluster id disappears from the canvas — the
  // entries become orphan keys that buildRows() never reads.
  const collapsedGroups = new Set();

  // Sentinel key for the "Unattached enrichments" pseudo-section at the
  // top of the table. Treated like any other group id by collapsedGroups
  // so the rep's expand / collapse choice survives re-renders.
  const ORPHAN_SECTION_KEY = "__orphans__";

  // ---- Card-type helpers (mirror src/export.js) ----

  function isNonErType(type) {
    return type === "dp" || type === "input" || type === "comment";
  }

  // Anything that isn't a DP / input / comment is an ER. Note: action cards
  // added via the picker (extractVisualData) intentionally leave `data.type`
  // unset — that's the established convention used in src/export.js
  // (`!isNonErType(c.data.type)`) and in addCard's frequency-seeding path
  // (cards.js line 565, also `!isNonErType(...)`). The previous version
  // here added an extra `type !== undefined` clause that broke that
  // convention: picker-added enrichments slipped through as "non-ER",
  // which meant clicking "Add enrichment" from a DP row produced a card
  // that sat in the cluster but never got listed in the row's chip column.
  function isErType(type) {
    return !isNonErType(type);
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
    if (!canvas) return { orphanErRows: [], groupSections: [], dpRows: [] };

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

    // Real cb-groups (Shift+Enter / POC importer) — keyed by numeric
    // groupId. The label comes off the live group's input element so
    // renames in the canvas propagate without a separate event hookup.
    const realGroups = typeof canvas.getGroups === "function" ? canvas.getGroups() : [];
    const groupNameById = new Map();
    for (const g of realGroups) {
      const name = (g.label || "").trim();
      if (name) groupNameById.set(g.id, name);
    }

    // Legacy comment-card-cluster fallback — pre-v3.18.3 POC imports +
    // the Clay-table import's basic-group flow stamp a comment card with
    // a `groupCluster` id and tag DPs with the matching `data.groupCluster`.
    // We keep rendering those as sections so existing canvases don't
    // suddenly lose their grouping after the upgrade.
    const commentByCluster = new Map();
    for (const card of allCards) {
      if (card.data?.type !== "comment") continue;
      const cluster = card.data.groupCluster;
      if (!cluster) continue;
      const text = (card.data.text || card.data.displayName || "").trim();
      if (text && !commentByCluster.has(cluster)) {
        commentByCluster.set(cluster, text);
      }
    }

    // Group-aware DP bucketing. Precedence:
    //   1. Real cb-group (card.groupId set by groupSelectedCards) →
    //      bucket under the group's title.
    //   2. Legacy comment-card cluster (data.groupCluster matches a
    //      titled comment) → bucket under the comment text.
    //   3. Otherwise → flat dpRows (preserves the un-grouped layout
    //      reps already had for canvas-created data points).
    const groupSectionsMap = new Map();
    const flatDpRows = [];
    for (const card of allCards) {
      if (card.data.type !== "dp") continue;
      const info = dpInfoMap.get(card.id);
      const row = {
        kind: "dp",
        cardId: card.id,
        name: card.data.text || card.data.displayName || "",
        fillRatePct: fillRatePct(card.data.fillRate),
        credits: info ? info.credits : 0,
        actions: info ? info.actions : 0,
        ers: info ? info.ers : [],
        connected: !!info && info.enrichmentCount > 0,
      };

      let sectionKey = null;
      let sectionName = null;
      if (card.groupId != null && groupNameById.has(card.groupId)) {
        sectionKey = `g-${card.groupId}`;
        sectionName = groupNameById.get(card.groupId);
      } else {
        const cluster = card.data.groupCluster;
        if (cluster && commentByCluster.has(cluster)) {
          sectionKey = `c-${cluster}`;
          sectionName = commentByCluster.get(cluster);
        }
      }

      if (sectionKey) {
        if (!groupSectionsMap.has(sectionKey)) {
          groupSectionsMap.set(sectionKey, {
            groupId: sectionKey,
            groupName: sectionName,
            rows: [],
          });
        }
        groupSectionsMap.get(sectionKey).rows.push(row);
      } else {
        flatDpRows.push(row);
      }
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

    return {
      orphanErRows,
      groupSections: Array.from(groupSectionsMap.values()),
      dpRows: flatDpRows,
    };
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
    intro.appendChild(introTitle);

    const introActions = document.createElement("div");
    introActions.className = "cb-table-view-intro-actions";

    // "Upload POC" sits to the LEFT of "Add enrichment" so the rep's eye
    // lands on the import option first when they're starting fresh — POC
    // import is the bulk-action shortcut, "Add enrichment" is the granular
    // follow-up. uploadSvg is a stylized cloud-upload icon distinct from
    // the plus glyph used for additive actions.
    const uploadPocBtn = document.createElement("button");
    uploadPocBtn.type = "button";
    uploadPocBtn.className = "cb-table-view-add-er-btn cb-table-view-upload-poc-btn";
    uploadPocBtn.title = "Import data points from a POC overview document";
    uploadPocBtn.innerHTML = uploadSvg(13) + "<span>Upload POC</span>";
    uploadPocBtn.addEventListener("click", () => {
      if (typeof __cb.startPocImport === "function") {
        __cb.startPocImport(uploadPocBtn);
      } else {
        console.error("[Clay Scoping] POC import module not loaded.");
      }
    });
    introActions.appendChild(uploadPocBtn);

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

    const { orphanErRows, groupSections, dpRows } = buildRows();

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

    const totalDpCount =
      dpRows.length +
      groupSections.reduce((sum, g) => sum + g.rows.length, 0);

    if (orphanErRows.length === 0 && totalDpCount === 0) {
      const empty = document.createElement("tr");
      empty.className = "cb-table-view-empty-row";
      const td = document.createElement("td");
      td.colSpan = headers.length;
      td.textContent =
        "No data points yet. Click \u201cUpload POC\u201d to import from a doc, \u201c+ Add data point\u201d below, or \u201cAdd enrichment\u201d above to get started.";
      empty.appendChild(td);
      tbody.appendChild(empty);
    } else {
      // Unattached enrichments live under their own yellow header section
      // at the top — visually parallel to the purple Use Case / group
      // sections below. Each row inside looks like a regular DP row, with
      // an editable name input that, when committed, creates a new DP
      // adjacent to the ER (forming a snap-cluster) so the row promotes
      // itself to a connected DP row on the next render.
      if (orphanErRows.length > 0) {
        const orphansCollapsed = collapsedGroups.has(ORPHAN_SECTION_KEY);
        tbody.appendChild(buildOrphanGroupHeaderRow(orphanErRows, headers.length, orphansCollapsed));
        if (!orphansCollapsed) {
          for (const row of orphanErRows) tbody.appendChild(buildOrphanDpStyleRow(row));
        }
      }
      // Group sections render as a header row spanning all columns,
      // followed by the cluster's DP rows (unless collapsed). Order matches
      // the canvas (groups in insertion order = top-to-bottom layout order).
      for (const section of groupSections) {
        const isCollapsed = collapsedGroups.has(section.groupId);
        tbody.appendChild(buildGroupHeaderRow(section, headers.length, isCollapsed));
        if (!isCollapsed) {
          for (const row of section.rows) tbody.appendChild(buildDpRow(row));
        }
      }
      for (const row of dpRows) tbody.appendChild(buildDpRow(row));
    }

    tbody.appendChild(buildAddDpRow(headers.length));

    table.appendChild(tbody);
    tableContainer.appendChild(table);
    wrap.appendChild(tableContainer);

    hostEl.appendChild(wrap);
  }

  // Yellow group-header row that sits above the unattached-enrichments
  // section. Reuses the .cb-table-view-group-row scaffolding (chevron +
  // icon + label + count + collapse toggle) so the orphan section
  // collapses the same way Use Case sections do; the yellow palette is
  // applied via .cb-table-view-orphan-group-row.
  function buildOrphanGroupHeaderRow(orphanErRows, colSpan, isCollapsed) {
    const tr = document.createElement("tr");
    tr.className =
      "cb-table-view-group-row cb-table-view-orphan-group-row" +
      (isCollapsed ? " cb-table-view-group-row-collapsed" : "");
    tr.setAttribute("data-group-id", ORPHAN_SECTION_KEY);
    tr.setAttribute("role", "button");
    tr.setAttribute("aria-expanded", isCollapsed ? "false" : "true");
    tr.tabIndex = 0;
    const td = document.createElement("td");
    td.colSpan = colSpan;
    const wrap = document.createElement("div");
    wrap.className = "cb-table-view-group-row-inner";

    const chevron = document.createElement("span");
    chevron.className = "cb-table-view-group-row-chevron";
    chevron.innerHTML = chevronDownSvg(12);
    chevron.setAttribute("aria-hidden", "true");

    const icon = document.createElement("span");
    icon.className = "cb-table-view-group-row-icon";
    icon.innerHTML = warningSvg(13);

    const label = document.createElement("span");
    label.className = "cb-table-view-group-row-label";
    label.textContent = "Unattached enrichments";

    const count = document.createElement("span");
    count.className = "cb-table-view-group-row-count";
    const n = orphanErRows.length;
    count.textContent = `${n} enrichment${n === 1 ? "" : "s"}`;

    wrap.appendChild(chevron);
    wrap.appendChild(icon);
    wrap.appendChild(label);
    wrap.appendChild(count);
    td.appendChild(wrap);
    tr.appendChild(td);

    const toggle = () => {
      if (collapsedGroups.has(ORPHAN_SECTION_KEY)) {
        collapsedGroups.delete(ORPHAN_SECTION_KEY);
      } else {
        collapsedGroups.add(ORPHAN_SECTION_KEY);
      }
      render();
    };
    tr.addEventListener("click", toggle);
    tr.addEventListener("keydown", (evt) => {
      if (evt.key === "Enter" || evt.key === " ") {
        evt.preventDefault();
        toggle();
      }
    });

    return tr;
  }

  // Looks like a regular DP row but the DP cell carries an editable
  // placeholder input ("Add data point name…") rather than a value bound
  // to an existing card. Committing a non-empty name calls
  // attachDpToOrphanEr which stamps a new DP card edge-to-edge with the
  // ER so the next refreshClusters round picks them up as a single
  // cluster — and the row promotes itself out of the orphan section on
  // the next render.
  function buildOrphanDpStyleRow(row) {
    const tr = document.createElement("tr");
    tr.className = "cb-table-view-dp-row cb-table-view-orphan-dp-row";
    tr.setAttribute("data-card-id", String(row.cardId));

    const dpCell = document.createElement("td");
    dpCell.className = "col-dp";
    const dpInput = document.createElement("input");
    dpInput.type = "text";
    dpInput.className = "cb-table-view-cell-input cb-table-view-cell-input-text";
    dpInput.placeholder = "Add data point name\u2026";
    let committed = false;
    dpInput.addEventListener("keydown", (evt) => {
      if (evt.key === "Enter") {
        evt.preventDefault();
        evt.target.blur();
      }
    });
    dpInput.addEventListener("blur", () => {
      if (committed) return;
      const text = dpInput.value.trim();
      if (text.length === 0) return;
      committed = true;
      attachDpToOrphanEr(row.cardId, text);
    });
    dpCell.appendChild(dpInput);
    tr.appendChild(dpCell);

    // Fill rate stays muted until the row promotes to a real DP — there's
    // no card to write the value to yet. The rep can edit it from the
    // promoted row on the next render.
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
    const chipsWrap = document.createElement("div");
    chipsWrap.className = "cb-table-view-er-chips";
    // Removable chip: the only way to delete an unattached enrichment,
    // since orphan-ER rows have no row-level × (the row goes away with
    // the ER itself).
    chipsWrap.appendChild(buildErChipEl(row.er, /* removable */ true));
    ersCell.appendChild(chipsWrap);
    tr.appendChild(ersCell);

    const endCell = document.createElement("td");
    endCell.className = "col-actions-end";
    tr.appendChild(endCell);

    return tr;
  }

  // Stamps a new DP card flush against the ER's left edge (at y matching
  // the ER) so the snap-cluster mechanism picks them up as a single
  // cluster on the next refreshClusters round. Uses CARD_W=220 because
  // every other layout helper in the extension assumes that width — we
  // can't read the prospective DP's offsetWidth before the card exists.
  function attachDpToOrphanEr(erCardId, text) {
    const canvas = __cb.canvas;
    if (!canvas?.getCardById || !canvas.addDataPointCard) return;
    const er = canvas.getCardById(erCardId);
    if (!er) return;
    const DP_W = 220;
    canvas.addDataPointCard(text, {
      x: er.x - DP_W,
      y: er.y,
    });
    if (canvas.refreshClusters) canvas.refreshClusters();
    if (canvas.notifyChange) canvas.notifyChange();
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
      // DP rows used to render non-removable chips on the theory that the
      // row's × delete handled cleanup. That breaks for DPs with 2+ ERs:
      // there's no way to drop a single enrichment without leaving the
      // table view. The row × still deletes the DP itself; the chip ×
      // only deletes the ER it sits on.
      chipsWrap.appendChild(buildErChipEl(er, /* removable */ true));
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

  // Group-section header row — non-editable, spans every column. Used to
  // visually segment the table when the user has imported clusters via the
  // POC importer (or the Clay-table import's basic-group flow). Clicking
  // anywhere on the row toggles collapse — collapsed groups render the
  // header alone (the DP rows are skipped in render()), with the chevron
  // rotated to point right.
  function buildGroupHeaderRow(section, colSpan, isCollapsed) {
    const tr = document.createElement("tr");
    tr.className =
      "cb-table-view-group-row" +
      (isCollapsed ? " cb-table-view-group-row-collapsed" : "");
    tr.setAttribute("data-group-id", String(section.groupId));
    tr.setAttribute("role", "button");
    tr.setAttribute("aria-expanded", isCollapsed ? "false" : "true");
    tr.tabIndex = 0;
    const td = document.createElement("td");
    td.colSpan = colSpan;
    const wrap = document.createElement("div");
    wrap.className = "cb-table-view-group-row-inner";

    const chevron = document.createElement("span");
    chevron.className = "cb-table-view-group-row-chevron";
    chevron.innerHTML = chevronDownSvg(12);
    chevron.setAttribute("aria-hidden", "true");

    const icon = document.createElement("span");
    icon.className = "cb-table-view-group-row-icon";
    icon.innerHTML = folderSvg(13);
    const label = document.createElement("span");
    label.className = "cb-table-view-group-row-label";
    label.textContent = section.groupName;
    const count = document.createElement("span");
    count.className = "cb-table-view-group-row-count";
    const dpCount = section.rows.length;
    count.textContent = `${dpCount} data point${dpCount === 1 ? "" : "s"}`;

    wrap.appendChild(chevron);
    wrap.appendChild(icon);
    wrap.appendChild(label);
    wrap.appendChild(count);
    td.appendChild(wrap);
    tr.appendChild(td);

    const toggle = () => {
      if (collapsedGroups.has(section.groupId)) {
        collapsedGroups.delete(section.groupId);
      } else {
        collapsedGroups.add(section.groupId);
      }
      render();
    };

    tr.addEventListener("click", toggle);
    // Keyboard parity for accessibility: Enter / Space mirrors the click
    // toggle. preventDefault on Space keeps the page from scrolling.
    tr.addEventListener("keydown", (evt) => {
      if (evt.key === "Enter" || evt.key === " ") {
        evt.preventDefault();
        toggle();
      }
    });

    return tr;
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

  function uploadSvg(size) {
    const s = String(size);
    return (
      `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}" viewBox="0 0 24 24" ` +
      'fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" ' +
      'stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>' +
      '<polyline points="17 8 12 3 7 8"/>' +
      '<line x1="12" y1="3" x2="12" y2="15"/>' +
      '</svg>'
    );
  }

  function chevronDownSvg(size) {
    const s = String(size);
    return (
      `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}" viewBox="0 0 24 24" ` +
      'fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" ' +
      'stroke-linejoin="round" aria-hidden="true">' +
      '<polyline points="6 9 12 15 18 9"/>' +
      '</svg>'
    );
  }

  function folderSvg(size) {
    const s = String(size);
    return (
      `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}" viewBox="0 0 24 24" ` +
      'fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" ' +
      'stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>' +
      '</svg>'
    );
  }

  function warningSvg(size) {
    const s = String(size);
    return (
      `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}" viewBox="0 0 24 24" ` +
      'fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" ' +
      'stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>' +
      '<line x1="12" y1="9" x2="12" y2="13"/>' +
      '<line x1="12" y1="17" x2="12.01" y2="17"/>' +
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
      // hostEl IS the scroll container (.cb-table-view-area has overflow:
      // auto). render() wipes hostEl.innerHTML, which resets scrollTop to 0,
      // making every chip-× / row-× / picker-confirm snap the user back to
      // the top. Capture and restore around the re-render so the table
      // looks visually stable across mutations.
      const prevScrollTop = hostEl.scrollTop;
      render();
      if (prevScrollTop > 0) {
        const maxScroll = hostEl.scrollHeight - hostEl.clientHeight;
        hostEl.scrollTop = Math.min(prevScrollTop, Math.max(0, maxScroll));
      }
    },
    isMounted() {
      return !!hostEl;
    },
  };
})();
