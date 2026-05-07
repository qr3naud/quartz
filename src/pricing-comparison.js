(function () {
  "use strict";

  const __cb = window.__cb;

  let modalEl = null;
  let modalBackdrop = null;

  // ---------------------------------------------------------------------------
  // Old vs New Pricing comparison
  //
  // Renders a centered modal that breaks down per-row credit cost on the
  // user's table under both the legacy (pre-2026) and modern (post-2026)
  // Clay pricing plans. Catalog-driven: for each ER field on the table we
  // look up its catalog entry in __cb.actionByIdLookup and read both the
  // pre- and post-2026 pricing tiers (stashed by fetchEnrichments in
  // src/api.js as `legacyCredits` / `credits` etc.). No /context fetch is
  // required because the server-resolved `creditCost` block is plan-aware
  // and only returns a single tier — to show *both* tiers we have to
  // compute them ourselves from the raw catalog.
  //
  // Trade-off: AI fields show the action-level base catalog cost on both
  // sides instead of the user's selected model's cost. This is fine for
  // the comparison's purpose (the legacy vs modern split is mostly about
  // the new actionExecution dimension, which AI doesn't differ on) and
  // keeps the modal load instant. Reps who need model-accurate cost can
  // use the canvas's import flow.
  // ---------------------------------------------------------------------------

  function closeModal() {
    if (modalEl) { modalEl.remove(); modalEl = null; }
    if (modalBackdrop) { modalBackdrop.remove(); modalBackdrop = null; }
    document.removeEventListener("keydown", onKeydown);
  }

  __cb.closePricingComparisonModal = closeModal;

  function onKeydown(evt) {
    if (evt.key === "Escape") {
      // Don't bubble Escape into the canvas's escape-to-navigate handler
      // when the user is just dismissing the modal.
      evt.stopPropagation();
      closeModal();
    }
  }

  // Returns { credits, isPrivateKey } for the given catalog `info` and
  // pricing tier. Mirrors checkRequiresCredentials in
  // libs/shared/src/credits/credit-cost-utils.ts: when the action requires
  // its own auth (requiresApiKey || disableSharedKey), the effective
  // billable cost is `usesPrivateKeyCredits` (usually 0). Otherwise it's
  // the shared-key `credits.basic` value.
  //
  // tier "legacy" reads the prePricingChange2026 sibling (legacyCredits /
  // legacyPrivateKeyCredits); tier "modern" reads the post-2026 fields
  // (credits / privateKeyCredits) — the same numbers the canvas already
  // uses for its cost math.
  function resolveTierCredits(info, tier) {
    if (!info) return { credits: 0, isPrivateKey: false };
    const isPrivateKey = !!(info.requiresApiKey || info.disableSharedKey);
    if (tier === "legacy") {
      const credits = isPrivateKey
        ? (Number(info.legacyPrivateKeyCredits) || 0)
        : (Number(info.legacyCredits) || 0);
      return { credits, isPrivateKey };
    }
    const credits = isPrivateKey
      ? (Number(info.privateKeyCredits) || 0)
      : (Number(info.credits) || 0);
    return { credits, isPrivateKey };
  }

  // Modern plans bill an actionExecution per row; legacy plans don't have
  // that dimension at all. Counted regardless of private-key state — same
  // rule canvas/credits.js applies (er.data.actionExecutions is summed
  // unconditionally).
  function modernActionsForField(info) {
    const n = Number(info?.actionExecutions);
    return Number.isFinite(n) && n > 0 ? n : 1;
  }

  // ---------------------------------------------------------------------------
  // Per-table comparison rows
  //
  // Walks the table's fieldGroupMap + standalone action fields and
  // produces one entry per "logical enrichment" — waterfall groups
  // collapse into a single row using mean(per-step cost) (matches the
  // averageCost semantic deriveWaterfallTotals applies in src/picker.js),
  // standalone ER fields each get their own row.
  // ---------------------------------------------------------------------------
  function buildComparisonRows(table, viewId, ignoreViewVisibility) {
    const fieldGroupMap = table?.fieldGroupMap ?? {};
    const fieldById = {};
    for (const f of table?.fields ?? []) fieldById[f.id] = f;

    const resolvedViewId = viewId || table?.firstViewId || null;
    const defaultView =
      (table?.views ?? []).find((v) => v.id === resolvedViewId) ?? table?.views?.[0];
    const viewFields = defaultView?.fields ?? {};

    // Same three-state visibility convention as buildImportDecisionSet
    // in src/table-import.js: ignoreViewVisibility = "Full table" pick
    // means treat every field as visible.
    const visibleFieldIds = ignoreViewVisibility
      ? new Set((table?.fields ?? []).map((f) => f.id))
      : new Set(
          Object.entries(viewFields)
            .filter(([, settings]) => settings.isVisible !== false)
            .map(([id]) => id)
        );

    // Index waterfall step / merge / validation field ids so the
    // standalone-fields pass below doesn't double-count them as their
    // own rows. Mirrors the same exclusion the import decision set
    // applies via groupedFieldIds.
    //
    // visibleWaterfallGroupIds: in Clay's typical view config a
    // waterfall renders as a single visual column whose merge field is
    // the only entry in viewFields — the step fields don't appear there
    // at all (or appear with isVisible:false). Filtering steps by
    // per-step visibility would drop the entire waterfall. Instead we
    // mark a group as "visible" iff any of its constituent fields
    // (steps, validation, merge) is visible, then include all its
    // action steps unconditionally below. Same fix applied to the
    // import flow's buildImportDecisionSet in src/table-import.js.
    const waterfallFieldIds = new Set();
    const visibleWaterfallGroupIds = new Set();
    for (const [groupId, group] of Object.entries(fieldGroupMap)) {
      if (group.type !== "waterfall") continue;
      let groupVisible = false;
      for (const step of group.groupDetails?.sequenceSteps ?? []) {
        waterfallFieldIds.add(step.fieldId);
        if (visibleFieldIds.has(step.fieldId)) groupVisible = true;
        if (step.validation?.fieldId) {
          waterfallFieldIds.add(step.validation.fieldId);
          if (visibleFieldIds.has(step.validation.fieldId)) groupVisible = true;
        }
      }
      const mergeId = group.groupDetails?.mergeField?.fieldId;
      if (mergeId) {
        waterfallFieldIds.add(mergeId);
        if (visibleFieldIds.has(mergeId)) groupVisible = true;
      }
      if (groupVisible) visibleWaterfallGroupIds.add(groupId);
    }

    const rows = [];

    for (const [groupId, group] of Object.entries(fieldGroupMap)) {
      if (group.type !== "waterfall") continue;
      if (!visibleWaterfallGroupIds.has(groupId)) continue;
      const steps = (group.groupDetails?.sequenceSteps ?? []).filter(
        (s) => s.type === "action" && s.actionKey
      );
      if (steps.length === 0) continue;

      // Validation cost reverse-engineered from the first step that
      // declares a validation block. Same pattern as the import flow's
      // firstValidation handling in src/table-import.js — a configured
      // validator is shared across the whole waterfall in Clay.
      const firstValidation = steps.find((s) => s.validation)?.validation ?? null;
      let validationLegacy = 0;
      let validationModern = 0;
      let validationActive = false;
      if (firstValidation) {
        const vKey = `${firstValidation.actionPackageId ?? "clay"}-${firstValidation.actionKey}`;
        const vInfo = __cb.actionByIdLookup?.[vKey];
        if (vInfo) {
          // authAccountId on the validation column = user wired their own
          // creds, treat as private key (zero cost) for both tiers.
          const vKeyOnly = !!(vInfo.requiresApiKey || vInfo.disableSharedKey);
          const vUsesPrivateKey = !!firstValidation.authAccountId || vKeyOnly;
          validationLegacy = vUsesPrivateKey
            ? (Number(vInfo.legacyPrivateKeyCredits) || 0)
            : (Number(vInfo.legacyCredits) || 0);
          validationModern = vUsesPrivateKey
            ? (Number(vInfo.privateKeyCredits) || 0)
            : (Number(vInfo.credits) || 0);
          validationActive = true;
        }
      }

      let legacySum = 0;
      let modernSum = 0;
      for (const step of steps) {
        const lookupKey = `${step.actionPackageId ?? "clay"}-${step.actionKey}`;
        const info = __cb.actionByIdLookup?.[lookupKey];
        const legacy = resolveTierCredits(info, "legacy");
        const modern = resolveTierCredits(info, "modern");
        // Validation surcharge contributes per step only when the step's
        // own provider isn't private-key (validator runs after a real
        // billed call). Matches deriveWaterfallTotals's per-provider
        // c + v formula in src/picker.js.
        legacySum +=
          legacy.credits + (validationActive && !legacy.isPrivateKey ? validationLegacy : 0);
        modernSum +=
          modern.credits + (validationActive && !modern.isPrivateKey ? validationModern : 0);
      }

      const legacyAvg = Math.round((legacySum / steps.length) * 100) / 100;
      const modernAvg = Math.round((modernSum / steps.length) * 100) / 100;

      const firstStepInfo =
        __cb.actionByIdLookup?.[`${steps[0].actionPackageId ?? "clay"}-${steps[0].actionKey}`];
      rows.push({
        kind: "waterfall",
        name: group.name || fieldById[steps[0].fieldId]?.name || "Waterfall",
        iconUrl: firstStepInfo?.iconUrl ?? null,
        subtitle: `Waterfall · ${steps.length} step${steps.length > 1 ? "s" : ""}`,
        legacyCredits: legacyAvg,
        modernCredits: modernAvg,
        // Waterfall = 1 action execution per row (matches the
        // `actionExecutions: 1` constant the import flow passes to
        // buildWaterfallCardData — only one step succeeds per row on
        // average, so each row counts as one billed action).
        modernActions: 1,
      });
    }

    for (const field of table?.fields ?? []) {
      if (!visibleFieldIds.has(field.id)) continue;
      if (waterfallFieldIds.has(field.id)) continue;
      if (field.type !== "action") continue;

      const ts = field.typeSettings ?? {};
      const lookupKey = `${ts.actionPackageId ?? "clay"}-${ts.actionKey}`;
      const info = __cb.actionByIdLookup?.[lookupKey];
      const legacy = resolveTierCredits(info, "legacy");
      const modern = resolveTierCredits(info, "modern");

      rows.push({
        kind: "field",
        name: field.name || info?.displayName || "Enrichment",
        iconUrl: info?.iconUrl ?? null,
        subtitle: info?.packageName || "",
        legacyCredits: legacy.credits,
        modernCredits: modern.credits,
        modernActions: modernActionsForField(info),
      });
    }

    const totals = rows.reduce(
      (acc, r) => ({
        legacyCredits: acc.legacyCredits + (Number(r.legacyCredits) || 0),
        modernCredits: acc.modernCredits + (Number(r.modernCredits) || 0),
        modernActions: acc.modernActions + (Number(r.modernActions) || 0),
      }),
      { legacyCredits: 0, modernCredits: 0, modernActions: 0 }
    );

    return { rows, totals, viewName: defaultView?.name ?? null };
  }

  function formatNumber(n) {
    if (!Number.isFinite(n)) return "0";
    return n % 1 === 0
      ? n.toLocaleString()
      : n.toLocaleString(undefined, { maximumFractionDigits: 2 });
  }

  // Returns the % change from legacy -> modern, or null when the math
  // doesn't apply (both 0, or legacy 0 with non-zero modern = "new").
  function deltaPct(legacy, modern) {
    const a = Number(legacy) || 0;
    const b = Number(modern) || 0;
    if (a === 0 && b === 0) return 0;
    if (a === 0) return null;
    return ((b - a) / a) * 100;
  }

  function renderDeltaCell(legacy, modern) {
    const cell = document.createElement("td");
    cell.className = "col-delta cb-pricing-num";
    const pct = deltaPct(legacy, modern);
    if (pct === null) {
      cell.textContent = "new";
      cell.classList.add("cb-pricing-delta-up");
      return cell;
    }
    if (pct === 0) {
      cell.textContent = "—";
      return cell;
    }
    const sign = pct > 0 ? "+" : "";
    cell.textContent = `${sign}${formatNumber(Math.round(pct * 10) / 10)}%`;
    cell.classList.add(pct < 0 ? "cb-pricing-delta-down" : "cb-pricing-delta-up");
    return cell;
  }

  function openComparisonModal({ table, viewId, ignoreViewVisibility }) {
    closeModal();

    const { rows, totals, viewName } = buildComparisonRows(table, viewId, ignoreViewVisibility);

    modalBackdrop = document.createElement("div");
    modalBackdrop.className = "cb-export-modal-backdrop";
    modalBackdrop.addEventListener("mousedown", (evt) => {
      if (evt.target === modalBackdrop) closeModal();
    });

    modalEl = document.createElement("div");
    modalEl.className = "cb-export-modal cb-pricing-modal";

    // ---- Header ----
    const header = document.createElement("div");
    header.className = "cb-export-modal-header";

    const titleWrap = document.createElement("div");
    titleWrap.className = "cb-export-modal-title-wrap";
    const title = document.createElement("h2");
    title.className = "cb-export-modal-title";
    title.textContent = "Old vs New Pricing";
    const subtitle = document.createElement("div");
    subtitle.className = "cb-export-modal-subtitle";
    const viewLabel = ignoreViewVisibility
      ? "Full table"
      : (viewName ? `View: ${viewName}` : "Default view");
    subtitle.textContent = `${table.name || "Table"} \u2014 ${viewLabel}`;
    titleWrap.appendChild(title);
    titleWrap.appendChild(subtitle);

    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "cb-export-modal-close";
    closeBtn.setAttribute("aria-label", "Close");
    closeBtn.innerHTML =
      '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
    closeBtn.addEventListener("click", closeModal);

    header.appendChild(titleWrap);
    header.appendChild(closeBtn);

    // ---- Body ----
    const body = document.createElement("div");
    body.className = "cb-export-modal-body cb-pricing-body";

    // Totals strip — two side-by-side panels matching the per-row table
    // columns below so the eye lines up totals with the underlying rows.
    const totalsStrip = document.createElement("div");
    totalsStrip.className = "cb-pricing-totals";

    const legacyTotalCol = document.createElement("div");
    legacyTotalCol.className = "cb-pricing-total-col cb-pricing-col-legacy";
    legacyTotalCol.appendChild(makeTotalLabel("Legacy"));
    legacyTotalCol.appendChild(
      makeTotalCell("Avg credits / row", formatNumber(totals.legacyCredits))
    );

    const modernTotalCol = document.createElement("div");
    modernTotalCol.className = "cb-pricing-total-col cb-pricing-col-modern";
    modernTotalCol.appendChild(makeTotalLabel("Modern"));
    const modernCellRow = document.createElement("div");
    modernCellRow.className = "cb-pricing-total-row";
    modernCellRow.appendChild(
      makeTotalCell("Avg credits / row", formatNumber(totals.modernCredits))
    );
    modernCellRow.appendChild(
      makeTotalCell("Avg actions / row", formatNumber(totals.modernActions))
    );
    modernTotalCol.appendChild(modernCellRow);

    totalsStrip.appendChild(legacyTotalCol);
    totalsStrip.appendChild(modernTotalCol);
    body.appendChild(totalsStrip);

    // Per-field breakdown
    if (rows.length === 0) {
      const empty = document.createElement("div");
      empty.className = "cb-export-empty";
      empty.textContent = "No enrichment fields to compare on this table.";
      body.appendChild(empty);
    } else {
      body.appendChild(buildBreakdownTable(rows));
    }

    // ---- Footer ----
    const footer = document.createElement("div");
    footer.className = "cb-export-modal-footer";
    const footerHint = document.createElement("div");
    footerHint.className = "cb-export-modal-footer-hint";
    footerHint.textContent =
      "Catalog projections \u2014 actual cost depends on selected AI model and private-key wiring.";
    const doneBtn = document.createElement("button");
    doneBtn.type = "button";
    doneBtn.className = "cb-export-modal-done";
    doneBtn.textContent = "Done";
    doneBtn.addEventListener("click", closeModal);
    footer.appendChild(footerHint);
    footer.appendChild(doneBtn);

    modalEl.appendChild(header);
    modalEl.appendChild(body);
    modalEl.appendChild(footer);

    modalBackdrop.appendChild(modalEl);
    document.body.appendChild(modalBackdrop);

    document.addEventListener("keydown", onKeydown);
  }

  function makeTotalLabel(text) {
    const el = document.createElement("div");
    el.className = "cb-pricing-total-label";
    el.textContent = text;
    return el;
  }

  function makeTotalCell(sublabel, value) {
    const wrap = document.createElement("div");
    wrap.className = "cb-pricing-total-cell";
    const sub = document.createElement("div");
    sub.className = "cb-pricing-total-sub";
    sub.textContent = sublabel;
    const val = document.createElement("div");
    val.className = "cb-pricing-total-value";
    val.textContent = value;
    wrap.appendChild(sub);
    wrap.appendChild(val);
    return wrap;
  }

  function buildBreakdownTable(rows) {
    const tbl = document.createElement("table");
    tbl.className = "cb-pricing-table";

    const thead = document.createElement("thead");
    const headRow = document.createElement("tr");
    const headers = [
      { label: "Enrichment", cls: "col-name" },
      { label: "Legacy credits / row", cls: "col-legacy" },
      { label: "Modern credits / row", cls: "col-modern-credits" },
      { label: "Modern actions / row", cls: "col-modern-actions" },
      { label: "\u0394 credits", cls: "col-delta" },
    ];
    for (const h of headers) {
      const th = document.createElement("th");
      th.textContent = h.label;
      th.className = h.cls;
      headRow.appendChild(th);
    }
    thead.appendChild(headRow);
    tbl.appendChild(thead);

    const tbody = document.createElement("tbody");
    for (const row of rows) {
      const tr = document.createElement("tr");

      const nameCell = document.createElement("td");
      nameCell.className = "col-name";
      const nameWrap = document.createElement("div");
      nameWrap.className = "cb-pricing-name";
      if (row.iconUrl) {
        const img = document.createElement("img");
        img.src = row.iconUrl;
        img.alt = "";
        img.className = "cb-pricing-icon";
        nameWrap.appendChild(img);
      }
      const nameTextWrap = document.createElement("div");
      nameTextWrap.className = "cb-pricing-name-text-wrap";
      const nameText = document.createElement("div");
      nameText.className = "cb-pricing-name-text";
      nameText.textContent = row.name;
      nameTextWrap.appendChild(nameText);
      if (row.subtitle) {
        const sub = document.createElement("div");
        sub.className = "cb-pricing-name-sub";
        sub.textContent = row.subtitle;
        nameTextWrap.appendChild(sub);
      }
      nameWrap.appendChild(nameTextWrap);
      nameCell.appendChild(nameWrap);
      tr.appendChild(nameCell);

      const legacyCell = document.createElement("td");
      legacyCell.className = "col-legacy cb-pricing-num";
      legacyCell.textContent = formatNumber(row.legacyCredits);
      tr.appendChild(legacyCell);

      const modernCreditsCell = document.createElement("td");
      modernCreditsCell.className = "col-modern-credits cb-pricing-num";
      modernCreditsCell.textContent = formatNumber(row.modernCredits);
      tr.appendChild(modernCreditsCell);

      const modernActionsCell = document.createElement("td");
      modernActionsCell.className = "col-modern-actions cb-pricing-num";
      modernActionsCell.textContent = formatNumber(row.modernActions);
      tr.appendChild(modernActionsCell);

      tr.appendChild(renderDeltaCell(row.legacyCredits, row.modernCredits));
      tbody.appendChild(tr);
    }
    tbl.appendChild(tbody);
    return tbl;
  }

  // ---------------------------------------------------------------------------
  // Entry point — wired to the topbar "Old vs New Pricing" button in
  // src/overlay.js. Mirrors __cb.startImport's prefetch-then-pick flow but
  // skips fetchModelPricing / fetchWaterfallExecCosts (the comparison
  // doesn't need either) and skips the post-pick /context fetch (the
  // comparison is catalog-driven so the table schema from fetchTableList
  // is sufficient).
  // ---------------------------------------------------------------------------
  __cb.startPricingComparison = async function (anchorEl) {
    const ids = __cb.parseIdsFromUrl();
    if (!ids) {
      console.error("[Clay Scoping] Not on a Clay workbook page.");
      return;
    }

    if (!__cb.tablePicker) {
      console.error("[Clay Scoping] Table picker helper unavailable.");
      return;
    }

    __cb.tablePicker.showLoading(anchorEl);

    try {
      if (Object.keys(__cb.actionByIdLookup ?? {}).length === 0) {
        await __cb.fetchEnrichments(ids.workspaceId);
      }

      const tables = await __cb.fetchTableList(ids.workbookId);

      if (!tables || tables.length === 0) {
        __cb.tablePicker.close();
        return;
      }

      const onPick = (table, viewId) => {
        const isFullTable = viewId === null;
        const finalViewId = isFullTable
          ? (table.firstViewId ?? null)
          : (viewId || table.firstViewId);
        openComparisonModal({
          table,
          viewId: finalViewId,
          ignoreViewVisibility: isFullTable,
        });
      };

      if (tables.length === 1) {
        __cb.tablePicker.close();
        onPick(tables[0], undefined);
      } else {
        __cb.tablePicker.show(tables, anchorEl, onPick);
      }
    } catch (err) {
      console.error("[Clay Scoping] Failed to fetch tables:", err);
      __cb.tablePicker.close();
    }
  };
})();
