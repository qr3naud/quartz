(function () {
  "use strict";

  const __cb = window.__cb;

  let tablePickerEl = null;
  let tablePickerBackdrop = null;

  function mapFieldToCardData(field) {
    const ts = field.typeSettings ?? {};
    const actionId = `${ts.actionPackageId}-${ts.actionKey}`;
    const info = __cb.actionByIdLookup[actionId];
    const ai = info?.isAi ?? __cb.isAiAction(ts.actionKey, info?.displayName ?? field.name, ts.actionPackageId);
    const modelOptions = ai ? (info?.modelOptions ?? __cb.getModelOptions()) : null;
    const defaultModelId = __cb.DEFAULT_AI_MODEL || "clay-argon";
    const selectedModel = ai && modelOptions
      ? (modelOptions.find(m => m.id === defaultModelId)?.id ?? modelOptions[0].id)
      : null;
    const requiresApiKey = info?.requiresApiKey ?? false;
    const credits = info?.credits ?? null;

    let iconUrl = info?.iconUrl ?? null;
    if (ai && selectedModel) {
      const model = modelOptions?.find(m => m.id === selectedModel);
      if (model?.provider && __cb.AI_PROVIDER_ICONS?.[model.provider]) {
        iconUrl = __cb.AI_PROVIDER_ICONS[model.provider];
      }
    }

    return {
      actionKey: ts.actionKey ?? field.name.toLowerCase().replace(/[^a-z0-9]+/g, "_"),
      packageId: ts.actionPackageId ?? "clay",
      displayName: ai ? field.name : (info?.displayName ?? field.name),
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
      fieldId: field.id,
    };
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
      } else if (c.data.waterfallGroupId) {
        keys.add(`wf-${c.data.waterfallGroupId}`);
      } else {
        keys.add(`${c.data.packageId}-${c.data.actionKey}`);
      }
    }
    return keys;
  }

  const CARD_W = 220;
  const CARD_H = 70;

  function isGreenField(fieldId, viewFields) {
    return viewFields[fieldId]?.color === "green";
  }

  function isRedField(fieldId, viewFields) {
    return viewFields[fieldId]?.color === "red";
  }

  function addDpCard(field, x, y) {
    return __cb.canvas.addDataPointCard(field.name, { x, y });
  }

  function addInputCardFromField(field, x, y) {
    return __cb.canvas.addInputCard(field.name, { x, y });
  }

  function importTableToCanvas(table, overrideViewId) {
    if (!__cb.canvas) return false;

    const fieldGroupMap = table.fieldGroupMap ?? {};
    const fieldById = {};
    for (const f of table.fields ?? []) fieldById[f.id] = f;

    const viewId = overrideViewId || table.firstViewId;
    const defaultView = (table.views ?? []).find(v => v.id === viewId) ?? table.views?.[0];
    const viewFields = defaultView?.fields ?? {};

    const visibleFieldIds = new Set(
      Object.entries(viewFields)
        .filter(([, settings]) => settings.isVisible !== false)
        .map(([id]) => id)
    );

    const waterfallFieldIds = new Set();
    for (const group of Object.values(fieldGroupMap)) {
      if (group.type === "waterfall") {
        for (const step of group.groupDetails?.sequenceSteps ?? []) {
          waterfallFieldIds.add(step.fieldId);
        }
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

    const groupedFieldIds = new Set([...waterfallFieldIds, ...basicGroupFieldIds]);

    const allRedFields = (table.fields ?? []).filter(f =>
      visibleFieldIds.has(f.id) && isRedField(f.id, viewFields));

    const redFieldIds = new Set(allRedFields.map(f => f.id));

    const standaloneFields = (table.fields ?? [])
      .filter(f => visibleFieldIds.has(f.id) && !groupedFieldIds.has(f.id) && !redFieldIds.has(f.id) &&
        (f.type === "action" || isGreenField(f.id, viewFields)));

    const waterfalls = Object.entries(fieldGroupMap)
      .filter(([, g]) => g.type === "waterfall")
      .map(([groupId, g]) => ({
        groupId,
        name: g.name ?? "",
        steps: (g.groupDetails?.sequenceSteps ?? []).filter(s => s.type === "action" && s.actionKey && visibleFieldIds.has(s.fieldId)),
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
          if (isGreenField(field.id, viewFields)) {
            dpFields.push(field);
          } else if (field.type === "action") {
            erFields.push(field);
          }
        }
        return { groupId, name: g.name ?? "", dpFields, erFields };
      })
      .filter(g => g.dpFields.length > 0 || g.erFields.length > 0);

    const existingKeys = getExistingCardKeys();
    const CARD_H_GAP = 230;
    const CARD_V_GAP = 120;
    const START_X = 80;
    const START_Y = 100;
    const COLS = 4;
    let col = 0;
    let currentY = START_Y;
    let importedAny = false;

    // --- Input cards (red): placed as one linked horizontal chain at the top ---

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
        const card = addInputCardFromField(field, x, currentY);
        card.data.fieldId = field.id;
        x += CARD_W;
      }
      currentY += CARD_V_GAP;
      importedAny = true;
    }

    // --- Waterfalls ---

    for (const wf of waterfalls) {
      if (wf.steps.length === 0) continue;
      const wfKey = `wf-${wf.groupId}`;
      if (existingKeys.has(wfKey)) continue;
      existingKeys.add(wfKey);

      const costs = [];
      let firstIcon = null;

      for (const step of wf.steps) {
        const info = __cb.actionByIdLookup[`${step.actionPackageId}-${step.actionKey}`];
        if (!firstIcon && info?.iconUrl) firstIcon = info.iconUrl;
        if (info?.credits != null) costs.push(info.credits);
      }

      const avgCost = costs.length > 0
        ? parseFloat((costs.reduce((a, b) => a + b, 0) / costs.length).toFixed(1))
        : null;

      const badges = [];
      if (firstIcon) {
        badges.push({
          imgSrc: firstIcon,
          text: `+${wf.steps.length}`,
        });
      }

      const cardData = {
        waterfallGroupId: wf.groupId,
        actionKey: wf.steps[0].actionKey,
        packageId: wf.steps[0].actionPackageId ?? "clay",
        displayName: wf.name || "Waterfall",
        packageName: "Waterfall",
        credits: avgCost,
        actionExecutions: 1,
        iconUrl: null,
        iconSvgHtml: null,
        creditText: avgCost != null ? `~${avgCost} / row` : null,
        badges,
      };

      __cb.canvas.addCard(cardData, {
        x: START_X + col * CARD_H_GAP,
        y: currentY,
      });

      col++;
      if (col >= COLS) {
        col = 0;
        currentY += CARD_V_GAP;
      }
      importedAny = true;
    }

    // --- Basic groups: comment on top of DP (left), ERs stacked vertically to the right ---

    let groupY = col > 0 ? currentY + CARD_V_GAP : currentY;
    col = 0;
    // Leave room above the first row for the comment card sitting on top of each DP.
    groupY += CARD_H;

    const GROUP_H_GAP = 40;
    const GROUP_V_GAP = 40;

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
          : `${erField.typeSettings?.actionPackageId ?? "clay"}-${erField.typeSettings?.actionKey}`;
        if (existingKeys.has(dedupKey)) continue;
        existingKeys.add(dedupKey);
        erFields.push(erField);
      }

      if (dpFields.length === 0 && erFields.length === 0) continue;

      const groupCols = erFields.length > 0 ? 2 : 1;
      const groupWidth = groupCols * CARD_W;
      const rowCount = Math.max(dpFields.length, erFields.length, 1);
      const groupHeight = rowCount * CARD_H;

      const rightEdge = START_X + col * CARD_H_GAP + groupWidth;
      const canvasRight = START_X + COLS * CARD_H_GAP;
      if (col > 0 && rightEdge > canvasRight) {
        col = 0;
        groupY += groupHeight + CARD_H + GROUP_V_GAP;
      }

      const groupX = START_X + col * CARD_H_GAP;

      if (bg.name) {
        __cb.canvas.addCommentCard(bg.name, { x: groupX, y: groupY - CARD_H });
      }

      for (let i = 0; i < dpFields.length; i++) {
        const card = addDpCard(dpFields[i], groupX, groupY + i * CARD_H);
        card.data.fieldId = dpFields[i].id;
      }

      for (let i = 0; i < erFields.length; i++) {
        __cb.canvas.addCard(mapFieldToCardData(erFields[i]), {
          x: groupX + CARD_W,
          y: groupY + i * CARD_H,
        });
      }

      col += Math.ceil((groupWidth + GROUP_H_GAP) / CARD_H_GAP);
      if (col >= COLS) {
        col = 0;
        groupY += groupHeight + CARD_H + GROUP_V_GAP;
      }
      importedAny = true;
    }

    // After groups, advance to a new row below the tallest group placed on the current row.
    if (col > 0) {
      groupY += CARD_H;
      col = 0;
    }

    // --- Standalone fields: green → DP, action → ER ---

    let standaloneY = col > 0 ? groupY + CARD_V_GAP : groupY;
    col = 0;

    for (const field of standaloneFields) {
      if (isGreenField(field.id, viewFields)) {
        const dpKey = `dp-${field.id}`;
        if (existingKeys.has(dpKey)) continue;
        existingKeys.add(dpKey);

        const card = addDpCard(field, START_X + col * CARD_H_GAP, standaloneY);
        card.data.fieldId = field.id;
      } else {
        const cardData = mapFieldToCardData(field);
        const dedupKey = cardData.isAi ? `ai-${field.id}` : `${cardData.packageId}-${cardData.actionKey}`;
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

  // ---- Table picker dropdown ----

  function closeTablePicker() {
    if (tablePickerEl) { tablePickerEl.remove(); tablePickerEl = null; }
    if (tablePickerBackdrop) { tablePickerBackdrop.remove(); tablePickerBackdrop = null; }
  }

  function getNonPreconfiguredViews(table) {
    return (table.views ?? []).filter(v => !v.typeSettings?.isPreconfigured);
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
        importTableToCanvas(table);
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
            importTableToCanvas(table, view.id);
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
        importTableToCanvas(tables[0]);
      } else {
        showTablePicker(tables, anchorEl);
      }
    } catch (err) {
      console.error("[Clay Scoping] Failed to fetch tables:", err);
      closeTablePicker();
    }
  };
})();
