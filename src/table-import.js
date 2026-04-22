(function () {
  "use strict";

  const __cb = window.__cb;

  let tablePickerEl = null;
  let tablePickerBackdrop = null;
  let importStatusEl = null;

  // ---------------------------------------------------------------------------
  // Run status aggregation
  //
  // Collapses the raw per-status counts the runstatus endpoint returns into
  // the two numbers we actually display: how many records are "done" (any
  // terminal state — success or error) and how many are "successes". In-flight
  // statuses (RUNNING / QUEUED / RATE_LIMITED / RETRY / AWAITING_CALLBACK) are
  // intentionally excluded so coverage doesn't temporarily inflate while a
  // table is mid-run.
  // ---------------------------------------------------------------------------
  function aggregateRunStatus(counts) {
    let success = 0;
    let noData = 0;
    let blocked = 0;
    let error = 0;
    if (!Array.isArray(counts)) return { success: 0, ran: 0 };
    for (const entry of counts) {
      const s = String(entry?.status || "");
      const c = Number(entry?.count) || 0;
      if (s === "SUCCESS") success += c;
      else if (s === "SUCCESS_NO_DATA") noData += c;
      else if (s === "SUCCESS_BLOCKED_DATA") blocked += c;
      else if (s.startsWith("ERROR")) error += c;
    }
    return { success, ran: success + noData + blocked + error };
  }

  // ---------------------------------------------------------------------------
  // Per-field stats join — fans the four API responses into a single
  // Map<fieldId, statsBlock> indexed by field. The table-stamping pass below
  // then just looks up `statsByFieldId.get(field.id)` and stuffs it onto
  // each card's data. The shape is intentionally tolerant: any of runStatus /
  // context / spend can be null (network failure or _pending after retries)
  // and we just leave that part of `stats` unset.
  // ---------------------------------------------------------------------------
  function buildStatsByFieldId({ fields, runStatus, context, spend, viewCount }) {
    const map = new Map();
    const fetchedAt = Date.now();
    const totalRecords = viewCount?.viewTotalRecordsCount ?? null;

    const profileByFieldId = {};
    const fieldConfigs = context?.fieldConfigurationsData?.fieldConfigs;
    if (Array.isArray(fieldConfigs)) {
      for (const fc of fieldConfigs) {
        if (fc?.id && fc?.dataProfile) profileByFieldId[fc.id] = fc.dataProfile;
      }
    }

    const spendByFieldId = {};
    if (Array.isArray(spend)) {
      for (const row of spend) {
        if (row?.fieldId) spendByFieldId[row.fieldId] = row;
      }
    }

    for (const field of fields ?? []) {
      const stats = { fetchedAt, source: null };
      let hasData = false;

      if (field.type === "action" && runStatus && runStatus[field.id]) {
        const grouped = aggregateRunStatus(runStatus[field.id]);
        if (grouped.ran > 0 && totalRecords != null) {
          stats.coverage = { ran: grouped.ran, total: totalRecords };
          stats.fillRate = { success: grouped.success, ran: grouped.ran };
          stats.source = "runstatus";
          hasData = true;
        }
      }

      // For basic fields (and as a backstop when runstatus didn't yield a
      // fill rate), fall back to the dataProfile from the /context endpoint.
      // Sample size is the denominator we trust: it's whatever the profiler
      // actually inspected (capped at ~1k for the sculptor preset).
      if (!stats.fillRate && profileByFieldId[field.id]) {
        const dp = profileByFieldId[field.id];
        const sampleSize = Number(dp.sampleSize) || 0;
        const valueCount = Number(dp.valueCount) || 0;
        if (sampleSize > 0) {
          stats.fillRate = { success: valueCount, ran: sampleSize };
          if (!stats.source) stats.source = "dataProfile";
          hasData = true;
        }
      }

      if (spendByFieldId[field.id]) {
        const s = spendByFieldId[field.id];
        stats.spend = {
          credits: Number(s.creditsSpent) || 0,
          actionExecutions: Number(s.actionExecutionCreditsSpent) || 0,
          cellCount: Number(s.cellCount) || 0,
        };
        hasData = true;
      }

      if (hasData) map.set(field.id, stats);
    }

    return map;
  }

  // ---------------------------------------------------------------------------
  // Card data factory for an action field (ER) being placed on the canvas.
  // Resolves catalog metadata (icons, AI detection, default model, credits)
  // and folds in optional `stats` and `groupCluster` markers for cluster
  // magneting. Used both for standalone ER columns and for individual
  // waterfall steps (each step is now its own ER card).
  // ---------------------------------------------------------------------------
  function buildErCardData({ field, actionKey, packageId, displayName, stats, groupCluster, fieldId, tableId, viewId }) {
    const lookupKey = `${packageId}-${actionKey}`;
    const info = __cb.actionByIdLookup[lookupKey];
    const ai = info?.isAi ?? __cb.isAiAction(actionKey, info?.displayName ?? displayName, packageId);
    const modelOptions = ai ? (info?.modelOptions ?? __cb.getModelOptions()) : null;
    const defaultModelId = __cb.DEFAULT_AI_MODEL || "clay-argon";
    const selectedModel = ai && modelOptions
      ? (modelOptions.find((m) => m.id === defaultModelId)?.id ?? modelOptions[0].id)
      : null;
    const requiresApiKey = info?.requiresApiKey ?? false;
    const credits = info?.credits ?? null;

    let iconUrl = info?.iconUrl ?? null;
    if (ai && selectedModel) {
      const model = modelOptions?.find((m) => m.id === selectedModel);
      if (model?.provider && __cb.AI_PROVIDER_ICONS?.[model.provider]) {
        iconUrl = __cb.AI_PROVIDER_ICONS[model.provider];
      }
    }

    return {
      actionKey: actionKey ?? (displayName || "field").toLowerCase().replace(/[^a-z0-9]+/g, "_"),
      packageId: packageId ?? "clay",
      displayName: ai ? (displayName || info?.displayName || "Use AI") : (info?.displayName || displayName || "Enrichment"),
      packageName: info?.packageName ?? "Clay",
      credits,
      actionExecutions: info?.actionExecutions ?? 1,
      iconUrl,
      iconSvgHtml: null,
      creditText: credits != null ? `~${credits} / row` : null,
      badges: [],
      isAi: ai,
      modelOptions,
      selectedModel,
      requiresApiKey,
      usePrivateKey: requiresApiKey && credits == null,
      fieldId: fieldId ?? field?.id,
      tableId: tableId ?? null,
      viewId: viewId ?? null,
      stats: stats || null,
      groupCluster: groupCluster || null,
    };
  }

  function mapFieldToCardData(field, statsByFieldId, tableId, viewId) {
    const ts = field.typeSettings ?? {};
    return buildErCardData({
      field,
      actionKey: ts.actionKey,
      packageId: ts.actionPackageId ?? "clay",
      displayName: field.name,
      stats: statsByFieldId?.get(field.id) ?? null,
      fieldId: field.id,
      tableId,
      viewId,
    });
  }

  function getExistingCardKeys() {
    if (!__cb.canvas) return new Set();
    const state = __cb.canvas.serialize();
    const keys = new Set();
    for (const c of state.cards || []) {
      if (c.data.type === "dp" && c.data.fieldId) {
        keys.add(`dp-${c.data.fieldId}`);
      } else if (c.data.type === "input" && c.data.fieldId) {
        keys.add(`input-${c.data.fieldId}`);
      } else if (c.data.isAi && c.data.fieldId) {
        keys.add(`ai-${c.data.fieldId}`);
      } else if (c.data.fieldId) {
        // Action field (waterfall step or standalone ER) — dedupe by fieldId
        // so re-importing the same table doesn't double-stamp the same step.
        keys.add(`field-${c.data.fieldId}`);
      } else if (c.data.waterfallGroupId) {
        keys.add(`wf-${c.data.waterfallGroupId}`);
      } else {
        keys.add(`${c.data.packageId}-${c.data.actionKey}`);
      }
    }
    return keys;
  }

  const CARD_W = 220;
  // Card height in Pro Mode (which import auto-enables). Mirrors the
  // .cb-overlay[data-cb-pro-mode] .cb-card { height: 96px } CSS rule.
  // 96 keeps the badges snug against the card's bottom padding (same gap
  // as the non-Pro 2-line cards) while still giving each card 3 rows of
  // content. Snap-cluster adjacency (snap.js hasFullSideMatch) requires
  // CARD_H to match the actual rendered height, so changing one without
  // the other silently breaks magneting between cards in a cluster.
  const CARD_H = 96;

  function isGreenField(fieldId, viewFields) {
    return viewFields[fieldId]?.color === "green";
  }

  function isRedField(fieldId, viewFields) {
    return viewFields[fieldId]?.color === "red";
  }

  function addDpCard(field, x, y, stats, groupCluster, tableId, viewId) {
    return __cb.canvas.addDataPointCard(field.name, {
      x,
      y,
      stats: stats || null,
      groupCluster: groupCluster || null,
      fieldId: field.id,
      tableId: tableId ?? null,
      viewId: viewId ?? null,
    });
  }

  function addInputCardFromField(field, x, y, tableId, viewId) {
    return __cb.canvas.addInputCard(field.name, {
      x,
      y,
      fieldId: field.id,
      tableId: tableId ?? null,
      viewId: viewId ?? null,
    });
  }

  // ---------------------------------------------------------------------------
  // Loading status banner — replaces the previous "click → silent wait" gap.
  // After the user picks a table, we close the picker and drop a small banner
  // anchored under the import button so they know the four stat fetches are
  // running. closeImportStatus() is called on success or failure.
  // ---------------------------------------------------------------------------
  function showImportStatus(text, anchorEl) {
    closeImportStatus();
    importStatusEl = document.createElement("div");
    importStatusEl.className = "cb-import-status";
    importStatusEl.textContent = text;
    document.body.appendChild(importStatusEl);
    if (anchorEl) {
      const rect = anchorEl.getBoundingClientRect();
      importStatusEl.style.top = (rect.bottom + 4) + "px";
      importStatusEl.style.left = rect.left + "px";
    }
  }

  function closeImportStatus() {
    if (importStatusEl) {
      importStatusEl.remove();
      importStatusEl = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Records prefill — pushes the view's record count into the summary input
  // and dispatches an `input` event so all the dependent recalc paths
  // (default fill rates, total credits) re-run as if the user typed it.
  // ---------------------------------------------------------------------------
  function prefillRecordsCount(viewCount) {
    const total = viewCount?.viewTotalRecordsCount;
    if (typeof total !== "number" || total <= 0) return;
    const input = document.getElementById("cb-records-input");
    if (!input) return;
    input.value = total.toLocaleString();
    input.dispatchEvent(new Event("input"));
  }

  // ---------------------------------------------------------------------------
  // Main import entry point — turns a table response into a fully-populated
  // canvas. Async because we fan out four parallel HTTP calls (view count,
  // run status, table context, column spend) before we start stamping cards;
  // every fetch is fail-soft so the import still produces structural cards
  // even if one or more stat sources are unavailable.
  // ---------------------------------------------------------------------------
  async function importTableToCanvas(table, overrideViewId, anchorEl) {
    if (!__cb.canvas) return false;

    // Auto-enable Pro Mode + Actual view on every successful import. Pro Mode
    // surfaces the coverage / fill-rate pills (otherwise hidden) and unhides
    // the Projected/Actual toggle in the topbar; Actual mode flips the
    // summary totals from catalog projections to real spend pulled from
    // Clay's realtime credit usage pipeline. Both calls are guarded with
    // typeof so they stay no-ops when the surrounding wiring isn't loaded.
    if (typeof __cb.setProMode === "function") __cb.setProMode(true);
    if (typeof __cb.setViewMode === "function") __cb.setViewMode("actual");

    const ids = __cb.parseIdsFromUrl();
    const workspaceId = ids?.workspaceId;
    const tableId = table.id;

    const fieldGroupMap = table.fieldGroupMap ?? {};
    const fieldById = {};
    for (const f of table.fields ?? []) fieldById[f.id] = f;

    const viewId = overrideViewId || table.firstViewId;
    const defaultView = (table.views ?? []).find((v) => v.id === viewId) ?? table.views?.[0];
    const viewFields = defaultView?.fields ?? {};

    showImportStatus(`Importing from ${table.name || "table"}\u2026`, anchorEl);

    let viewCount = null;
    let runStatus = null;
    let context = null;
    let spend = null;
    try {
      [viewCount, runStatus, context, spend] = await Promise.all([
        viewId ? __cb.fetchViewCount(tableId, viewId).catch(() => null) : Promise.resolve(null),
        workspaceId ? __cb.fetchFieldRunStatus(workspaceId, tableId).catch(() => null) : Promise.resolve(null),
        workspaceId ? __cb.fetchTableContext(workspaceId, tableId).catch(() => null) : Promise.resolve(null),
        workspaceId ? __cb.fetchColumnSpend(workspaceId, tableId, 30).catch(() => null) : Promise.resolve(null),
      ]);
    } finally {
      closeImportStatus();
    }

    prefillRecordsCount(viewCount);

    const statsByFieldId = buildStatsByFieldId({
      fields: table.fields ?? [],
      runStatus,
      context,
      spend,
      viewCount,
    });

    const visibleFieldIds = new Set(
      Object.entries(viewFields)
        .filter(([, settings]) => settings.isVisible !== false)
        .map(([id]) => id)
    );

    // Track which fields end up consumed by waterfall step cards so they
    // aren't accidentally double-imported as standalone columns later.
    const waterfallFieldIds = new Set();
    const waterfallMergeFieldIds = new Set();
    for (const group of Object.values(fieldGroupMap)) {
      if (group.type === "waterfall") {
        for (const step of group.groupDetails?.sequenceSteps ?? []) {
          waterfallFieldIds.add(step.fieldId);
        }
        const mergeId = group.groupDetails?.mergeField?.fieldId;
        if (mergeId) waterfallMergeFieldIds.add(mergeId);
      }
    }

    const basicGroupFieldIds = new Set();
    for (const group of Object.values(fieldGroupMap)) {
      if (group.type === "basic") {
        for (const f of group.groupDetails?.fields ?? []) {
          basicGroupFieldIds.add(f.id);
        }
      }
    }

    const groupedFieldIds = new Set([
      ...waterfallFieldIds,
      ...waterfallMergeFieldIds,
      ...basicGroupFieldIds,
    ]);

    // Strict input rule (per plan): red AND basic only. An action field that
    // happens to be colored red is treated as "do not import" — placing it
    // as an input would lose the action semantics, and placing it as an ER
    // would override the user's deliberate "skip" hint.
    const allRedFields = (table.fields ?? []).filter(
      (f) => visibleFieldIds.has(f.id) && f.type === "basic" && isRedField(f.id, viewFields)
    );
    const redFieldIds = new Set(allRedFields.map((f) => f.id));

    // Anything that's red but not a basic field gets explicitly skipped from
    // every downstream pass.
    const skippedRedFieldIds = new Set(
      (table.fields ?? [])
        .filter((f) => visibleFieldIds.has(f.id) && f.type !== "basic" && isRedField(f.id, viewFields))
        .map((f) => f.id)
    );

    const standaloneFields = (table.fields ?? []).filter(
      (f) =>
        visibleFieldIds.has(f.id) &&
        !groupedFieldIds.has(f.id) &&
        !redFieldIds.has(f.id) &&
        !skippedRedFieldIds.has(f.id) &&
        (f.type === "action" || isGreenField(f.id, viewFields))
    );

    const waterfalls = Object.entries(fieldGroupMap)
      .filter(([, g]) => g.type === "waterfall")
      .map(([groupId, g]) => ({
        groupId,
        name: g.name ?? "",
        steps: (g.groupDetails?.sequenceSteps ?? []).filter(
          (s) => s.type === "action" && s.actionKey && visibleFieldIds.has(s.fieldId)
        ),
        mergeFieldId: g.groupDetails?.mergeField?.fieldId ?? null,
      }));

    const basicGroups = Object.entries(fieldGroupMap)
      .filter(([, g]) => g.type === "basic")
      .map(([groupId, g]) => {
        const members = g.groupDetails?.fields ?? [];
        const dpFields = [];
        const erFields = [];
        for (const member of members) {
          const field = fieldById[member.id];
          if (!field) continue;
          if (!visibleFieldIds.has(field.id)) continue;
          if (redFieldIds.has(field.id)) continue;
          if (skippedRedFieldIds.has(field.id)) continue;
          if (field.type === "action") {
            erFields.push(field);
          } else if (isGreenField(field.id, viewFields) || field.type === "basic") {
            // Basic groups represent intentional user/recipe-created clusters,
            // so we include any basic member even if it's not green-flagged.
            dpFields.push(field);
          }
        }
        return { groupId, name: g.name ?? "", dpFields, erFields };
      })
      .filter((g) => g.dpFields.length > 0 || g.erFields.length > 0);

    const existingKeys = getExistingCardKeys();
    const CARD_H_GAP = 230;
    const CARD_V_GAP = 120;
    // Exactly one card height of offset so the comment's bottom edge sits
    // flush against the first member's top edge. The snap-cluster mechanism
    // in canvas/snap.js requires 0–1px adjacency (ADJACENCY_TOLERANCE) for
    // cards to be considered part of the same cluster — any gap larger than
    // that and the comment floats free, breaking the magnet effect.
    const COMMENT_OFFSET = CARD_H;
    const START_X = 80;
    const START_Y = 100;
    const COLS = 4;
    let importedAny = false;

    let currentY = START_Y;

    // -------------------------------------------------------------------------
    // Inputs (red basic fields). Laid out as a single horizontal row at the
    // top — purely positional, no actual links between them. The "chain"
    // term refers to spatial layout, not connections.
    // -------------------------------------------------------------------------
    const inputChain = [];
    for (const field of allRedFields) {
      const inputKey = `input-${field.id}`;
      if (existingKeys.has(inputKey)) continue;
      existingKeys.add(inputKey);
      inputChain.push(field);
    }

    if (inputChain.length > 0) {
      let x = START_X;
      for (const field of inputChain) {
        addInputCardFromField(field, x, currentY, tableId, viewId);
        x += CARD_W;
      }
      currentY += CARD_V_GAP;
      importedAny = true;
    }

    // -------------------------------------------------------------------------
    // Waterfalls — each provider step becomes its own ER card (per plan).
    // Layout: comment with the waterfall name on top, then the action steps
    // in a row, then the merge field DP at the right end. Every member
    // shares `data.groupCluster = wf.groupId` so they magnet visually.
    // -------------------------------------------------------------------------
    for (const wf of waterfalls) {
      if (wf.steps.length === 0) continue;
      const wfKey = `wf-${wf.groupId}`;
      if (existingKeys.has(wfKey)) continue;
      existingKeys.add(wfKey);

      const baseX = START_X;
      const commentY = currentY;
      const stepsY = currentY + COMMENT_OFFSET;

      const commentText = wf.name || "Waterfall";
      __cb.canvas.addCommentCard(commentText, {
        x: baseX,
        y: commentY,
        groupCluster: wf.groupId,
      });

      let stepX = baseX;
      for (const step of wf.steps) {
        const fieldKey = `field-${step.fieldId}`;
        if (existingKeys.has(fieldKey)) continue;
        existingKeys.add(fieldKey);
        const cardData = buildErCardData({
          actionKey: step.actionKey,
          packageId: step.actionPackageId ?? "clay",
          displayName: fieldById[step.fieldId]?.name || step.actionKey,
          stats: statsByFieldId.get(step.fieldId) ?? null,
          groupCluster: wf.groupId,
          fieldId: step.fieldId,
          tableId,
          viewId,
        });
        __cb.canvas.addCard(cardData, { x: stepX, y: stepsY });
        stepX += CARD_W;
      }

      // Merge field DP card pinned to the right of the last step.
      if (wf.mergeFieldId && fieldById[wf.mergeFieldId]) {
        const mergeField = fieldById[wf.mergeFieldId];
        const dpKey = `dp-${mergeField.id}`;
        if (!existingKeys.has(dpKey)) {
          existingKeys.add(dpKey);
          // The merge field doesn't have its own runstatus (it's a basic
          // formula field), but its overall "filledness" is captured by
          // dataProfile. Coverage falls through unset for merge fields —
          // it's not really meaningful at the merge level since each step
          // covers a different subset.
          addDpCard(
            mergeField,
            stepX,
            stepsY,
            statsByFieldId.get(mergeField.id) ?? null,
            wf.groupId,
            tableId,
            viewId
          );
        }
      }

      const stepsTotalHeight = COMMENT_OFFSET + CARD_H;
      currentY += stepsTotalHeight + CARD_V_GAP;
      importedAny = true;
    }

    // -------------------------------------------------------------------------
    // Basic groups — kept as visual clusters of whatever fields the user
    // (or a recipe) explicitly grouped. Comments always render here, even
    // for single-member groups, even when the group has only DPs or only
    // ERs — they're intentional clusters and the comment is how the user
    // navigates them.
    // -------------------------------------------------------------------------
    let groupY = currentY;
    if (basicGroups.length > 0) groupY += COMMENT_OFFSET;

    const GROUP_V_GAP = 40;
    // Width of the DP flow grid inside a basic group. 4 matches the
    // standalone canvas grid so DPs read as a familiar shape; ERs sit in
    // a 5th column to the right of the DP grid (so they magnet to the
    // rightmost DP in their row).
    const DP_COLS = 4;

    for (const bg of basicGroups) {
      const dpFields = [];
      for (const dpField of bg.dpFields) {
        const dpKey = `dp-${dpField.id}`;
        if (existingKeys.has(dpKey)) continue;
        existingKeys.add(dpKey);
        dpFields.push(dpField);
      }

      const erFields = [];
      for (const erField of bg.erFields) {
        const ai = __cb.isAiAction(
          erField.typeSettings?.actionKey,
          erField.name,
          erField.typeSettings?.actionPackageId
        );
        const dedupKey = ai
          ? `ai-${erField.id}`
          : `field-${erField.id}`;
        if (existingKeys.has(dedupKey)) continue;
        existingKeys.add(dedupKey);
        erFields.push(erField);
      }

      if (dpFields.length === 0 && erFields.length === 0) continue;

      // DPs flow left-to-right, top-to-bottom in a 4-col grid; ERs sit in
      // a single column to the right of the DP grid (so the comment magnets
      // to the first DP and ERs magnet to the rightmost DP in their row).
      // When a group has zero DPs we collapse the layout: ERs go in column
      // 0 so the comment still magnets to the first card of the cluster.
      const dpRowCount = Math.ceil(dpFields.length / DP_COLS);
      const erRowCount = erFields.length;
      const rowCount = Math.max(dpRowCount, erRowCount, 1);
      const groupHeight = rowCount * CARD_H;

      const groupX = START_X;

      __cb.canvas.addCommentCard(bg.name || "", {
        x: groupX,
        y: groupY - COMMENT_OFFSET,
        groupCluster: bg.groupId,
      });

      for (let i = 0; i < dpFields.length; i++) {
        const r = Math.floor(i / DP_COLS);
        const c = i % DP_COLS;
        addDpCard(
          dpFields[i],
          groupX + c * CARD_W,
          groupY + r * CARD_H,
          statsByFieldId.get(dpFields[i].id) ?? null,
          bg.groupId,
          tableId,
          viewId
        );
      }

      const erColX = dpFields.length > 0
        ? groupX + DP_COLS * CARD_W
        : groupX;
      for (let i = 0; i < erFields.length; i++) {
        const cardData = mapFieldToCardData(erFields[i], statsByFieldId, tableId, viewId);
        cardData.groupCluster = bg.groupId;
        __cb.canvas.addCard(cardData, {
          x: erColX,
          y: groupY + i * CARD_H,
        });
      }

      // Each basic group fully owns its row — the new layout is up to
      // 5 cards wide (4 DP cols + 1 ER col), which exceeds the 4-col
      // canvas width anyway. Advance past this group by its actual height
      // plus a group gap so the next group / standalone section starts
      // cleanly with no overlap.
      groupY += groupHeight + COMMENT_OFFSET + GROUP_V_GAP;
      importedAny = true;
    }

    // -------------------------------------------------------------------------
    // Standalone fields — green basics → DP, action → ER. Plain 4-column
    // grid below the grouped sections. groupY already sits cleanly past
    // the last group (the loop above advances it after every group), so
    // standaloneY just inherits it directly.
    // -------------------------------------------------------------------------
    let standaloneY = groupY;
    let col = 0;

    for (const field of standaloneFields) {
      if (isGreenField(field.id, viewFields)) {
        const dpKey = `dp-${field.id}`;
        if (existingKeys.has(dpKey)) continue;
        existingKeys.add(dpKey);

        addDpCard(
          field,
          START_X + col * CARD_H_GAP,
          standaloneY,
          statsByFieldId.get(field.id) ?? null,
          null,
          tableId,
          viewId
        );
      } else {
        const cardData = mapFieldToCardData(field, statsByFieldId, tableId, viewId);
        const dedupKey = cardData.isAi
          ? `ai-${field.id}`
          : `field-${field.id}`;
        if (existingKeys.has(dedupKey)) continue;
        existingKeys.add(dedupKey);

        __cb.canvas.addCard(cardData, {
          x: START_X + col * CARD_H_GAP,
          y: standaloneY,
        });
      }

      col++;
      if (col >= COLS) {
        col = 0;
        standaloneY += CARD_V_GAP;
      }
      importedAny = true;
    }

    if (importedAny && __cb.canvas.refreshClusters) {
      __cb.canvas.refreshClusters();
    }

    return importedAny;
  }

  // ---------------------------------------------------------------------------
  // Table picker dropdown
  // ---------------------------------------------------------------------------

  function closeTablePicker() {
    if (tablePickerEl) { tablePickerEl.remove(); tablePickerEl = null; }
    if (tablePickerBackdrop) { tablePickerBackdrop.remove(); tablePickerBackdrop = null; }
  }

  function getNonPreconfiguredViews(table) {
    return (table.views ?? []).filter((v) => !v.typeSettings?.isPreconfigured);
  }

  function showTablePicker(tables, anchorEl) {
    closeTablePicker();

    tablePickerBackdrop = document.createElement("div");
    tablePickerBackdrop.className = "cb-table-picker-backdrop";
    tablePickerBackdrop.addEventListener("click", closeTablePicker);

    tablePickerEl = document.createElement("div");
    tablePickerEl.className = "cb-table-picker";

    const heading = document.createElement("div");
    heading.className = "cb-table-picker-title";
    heading.textContent = "Select a table";
    tablePickerEl.appendChild(heading);

    const sorted = [...tables].sort((a, b) =>
      (a.name || "").localeCompare(b.name || "", undefined, { sensitivity: "base" })
    );

    for (const table of sorted) {
      const views = getNonPreconfiguredViews(table);
      const hasMultipleViews = views.length > 1;

      const row = document.createElement("div");
      row.className = "cb-table-picker-row";

      const item = document.createElement("button");
      item.className = "cb-table-picker-item";
      item.type = "button";

      const nameSpan = document.createElement("span");
      nameSpan.textContent = table.name || "Untitled";
      item.appendChild(nameSpan);

      if (hasMultipleViews) {
        const chevron = document.createElement("span");
        chevron.className = "cb-table-picker-chevron";
        chevron.innerHTML =
          '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 6 15 12 9 18"/></svg>';
        item.appendChild(chevron);
      }

      item.addEventListener("click", () => {
        closeTablePicker();
        importTableToCanvas(table, undefined, anchorEl).catch((err) => {
          console.error("[Clay Scoping] Import failed:", err);
          closeImportStatus();
        });
      });

      row.appendChild(item);

      if (hasMultipleViews) {
        const sub = document.createElement("div");
        sub.className = "cb-table-picker-views";

        for (const view of views) {
          const viewBtn = document.createElement("button");
          viewBtn.className = "cb-table-picker-item";
          viewBtn.type = "button";

          const viewName = document.createElement("span");
          viewName.textContent = view.name || "Untitled view";
          viewBtn.appendChild(viewName);

          if (view.id === table.firstViewId) {
            const defaultBadge = document.createElement("span");
            defaultBadge.className = "cb-table-picker-default";
            defaultBadge.textContent = "default";
            viewBtn.appendChild(defaultBadge);
          }

          viewBtn.addEventListener("click", () => {
            closeTablePicker();
            importTableToCanvas(table, view.id, anchorEl).catch((err) => {
              console.error("[Clay Scoping] Import failed:", err);
              closeImportStatus();
            });
          });

          sub.appendChild(viewBtn);
        }

        row.appendChild(sub);
      }

      tablePickerEl.appendChild(row);
    }

    document.body.appendChild(tablePickerBackdrop);
    document.body.appendChild(tablePickerEl);

    if (anchorEl) {
      const rect = anchorEl.getBoundingClientRect();
      tablePickerEl.style.top = (rect.bottom + 4) + "px";
      tablePickerEl.style.left = rect.left + "px";
    }
  }

  function showLoadingPicker(anchorEl) {
    closeTablePicker();

    tablePickerBackdrop = document.createElement("div");
    tablePickerBackdrop.className = "cb-table-picker-backdrop";
    tablePickerBackdrop.addEventListener("click", closeTablePicker);

    tablePickerEl = document.createElement("div");
    tablePickerEl.className = "cb-table-picker";

    const loading = document.createElement("div");
    loading.className = "cb-table-picker-loading";
    loading.textContent = "Loading tables\u2026";
    tablePickerEl.appendChild(loading);

    document.body.appendChild(tablePickerBackdrop);
    document.body.appendChild(tablePickerEl);

    if (anchorEl) {
      const rect = anchorEl.getBoundingClientRect();
      tablePickerEl.style.top = (rect.bottom + 4) + "px";
      tablePickerEl.style.left = rect.left + "px";
    }
  }

  __cb.startImport = async function (anchorEl) {
    const ids = __cb.parseIdsFromUrl();
    if (!ids) {
      console.error("[Clay Scoping] Not on a Clay workbook page.");
      return;
    }

    showLoadingPicker(anchorEl);

    try {
      if (Object.keys(__cb.actionByIdLookup).length === 0) {
        await __cb.fetchEnrichments(ids.workspaceId);
      }
      if (Object.keys(__cb.livePricingByModel).length === 0) {
        await __cb.fetchModelPricing(ids.workspaceId);
      }

      const tables = await __cb.fetchTableList(ids.workbookId);

      if (!tables || tables.length === 0) {
        closeTablePicker();
        return;
      }

      if (tables.length === 1) {
        closeTablePicker();
        await importTableToCanvas(tables[0], undefined, anchorEl);
      } else {
        showTablePicker(tables, anchorEl);
      }
    } catch (err) {
      console.error("[Clay Scoping] Failed to fetch tables:", err);
      closeTablePicker();
      closeImportStatus();
    }
  };
})();
