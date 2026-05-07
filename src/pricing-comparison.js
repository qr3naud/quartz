(function () {
  "use strict";

  const __cb = window.__cb;

  let modalEl = null;
  let modalBackdrop = null;

  // Per-modal-instance state. Reset on every openComparisonModal so the
  // modal always opens with Pricing OFF and the fixed default rates,
  // regardless of what the user did in a previous session.
  //
  // Why module-scoped (not closure-scoped per modal): the toggle button,
  // the in-place re-render path, and the download functions all need to
  // read the same state, and several of them are wired up via small
  // helper functions defined at module scope. Stashing on a single
  // namespace `state` object is just enough indirection to make the
  // wiring readable without paying for a class.
  const FIXED_LEGACY_CREDIT_RATE = 0.05;
  const FIXED_MODERN_CREDIT_RATE = 0.05;
  const FIXED_ACTION_RATE = 0.008;
  const FIXED_RECORDS_DEFAULT = 1000;

  const state = {
    pricingMode: false,
    legacyCreditRate: FIXED_LEGACY_CREDIT_RATE,
    modernCreditRate: FIXED_MODERN_CREDIT_RATE,
    actionRate: FIXED_ACTION_RATE,
    // Records multiplier for the "Total per table" row. Initialized
    // from the topbar's records input on modal open (so the comparison
    // matches whatever volume the rep already had in mind on the
    // canvas), falling back to FIXED_RECORDS_DEFAULT when the topbar
    // value is unset / 0.
    recordsCount: FIXED_RECORDS_DEFAULT,
    rows: null,            // last buildComparisonRows result, cached for download + re-render
    totals: null,
    table: null,           // the picked Clay table (used for download filename)
    tableContainer: null,  // <div> wrapping the <table> so toggle can replace it in place
    pricingToggleBtn: null,
  };

  function resetModalState() {
    state.pricingMode = false;
    state.legacyCreditRate = FIXED_LEGACY_CREDIT_RATE;
    state.modernCreditRate = FIXED_MODERN_CREDIT_RATE;
    state.actionRate = FIXED_ACTION_RATE;
    state.recordsCount = FIXED_RECORDS_DEFAULT;
    state.rows = null;
    state.totals = null;
    state.table = null;
    state.tableContainer = null;
    state.pricingToggleBtn = null;
  }

  // Dollar formatting / parsing — duplicated from src/overlay.js (parseDollar /
  // formatDollar around lines 459-472). Those helpers aren't exposed via __cb,
  // and inlining them here keeps this module self-contained without making
  // overlay.js export internals it doesn't otherwise need to share.
  function parseDollar(str) {
    const n = parseFloat(String(str).replace(/[^\d.]/g, ""));
    return Number.isFinite(n) && n >= 0 ? n : 0;
  }

  function formatDollar(n) {
    const rounded = Math.round(n * 1000) / 1000;
    const hasSubCent = Math.abs(rounded * 100 - Math.round(rounded * 100)) > 1e-9;
    return "$" + rounded.toLocaleString(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: hasSubCent ? 3 : 2,
    });
  }

  function formatRecords(n) {
    return Number(n || 0).toLocaleString();
  }

  // Whole-dollar formatter for the per-table row (where amounts are
  // large enough that sub-cent precision is noise). Always emits an
  // integer-formatted dollar string with thousands separators.
  function formatDollarWhole(n) {
    return "$" + Math.round(Number(n) || 0).toLocaleString();
  }

  function parseRecords(s) {
    const n = parseInt(String(s).replace(/[^\d]/g, ""), 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }

  // Per-row dollar totals shared by the breakdown rendering, the dollar-Δ
  // computation, and the CSV/JSON exports. Keeps the formula in one place.
  function rowDollars(row) {
    const legacy$ = (Number(row.legacyCredits) || 0) * state.legacyCreditRate;
    const modernCredit$ = (Number(row.modernCredits) || 0) * state.modernCreditRate;
    const modernAction$ = (Number(row.modernActions) || 0) * state.actionRate;
    return {
      legacy: legacy$,
      modernCredit: modernCredit$,
      modernAction: modernAction$,
      modernTotal: modernCredit$ + modernAction$,
    };
  }

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
    closeDownloadMenu();
    if (modalEl) { modalEl.remove(); modalEl = null; }
    if (modalBackdrop) { modalBackdrop.remove(); modalBackdrop = null; }
    document.removeEventListener("keydown", onKeydown);
    resetModalState();
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

  // Modern plans bill an actionExecution per row when the action's
  // catalog entry sets pricing.credits.actionExecution. Read / lookup /
  // source actions intentionally omit that field — they bill 0 actions
  // per row (the server-side rule in calculateActionExecutionCost is
  // `pricing?.credits?.actionExecution ?? 0`). Defaulting the missing
  // value to 1 was overcounting every Salesforce / Pardot lookup +
  // every records-* source action. Return 0 when the catalog says 0.
  // Counted regardless of private-key state — matches canvas/credits.js
  // which sums er.data.actionExecutions unconditionally.
  function modernActionsForField(info) {
    const n = Number(info?.actionExecutions);
    return Number.isFinite(n) && n > 0 ? n : 0;
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
      let validationActions = 0;
      let validationActive = false;
      let validationUsesPrivateKey = false;
      if (firstValidation) {
        const vKey = `${firstValidation.actionPackageId ?? "clay"}-${firstValidation.actionKey}`;
        const vInfo = __cb.actionByIdLookup?.[vKey];
        if (vInfo) {
          // authAccountId on the validation column = user wired their own
          // creds, treat as private key (zero cost) for both tiers.
          const vKeyOnly = !!(vInfo.requiresApiKey || vInfo.disableSharedKey);
          validationUsesPrivateKey = !!firstValidation.authAccountId || vKeyOnly;
          validationLegacy = validationUsesPrivateKey
            ? (Number(vInfo.legacyPrivateKeyCredits) || 0)
            : (Number(vInfo.legacyCredits) || 0);
          validationModern = validationUsesPrivateKey
            ? (Number(vInfo.privateKeyCredits) || 0)
            : (Number(vInfo.credits) || 0);
          // Action executions: counted regardless of private-key state
          // (canvas/credits.js sums actionExecutions unconditionally),
          // but only when the validator actually runs (validationActive).
          // Read-only validators with no actionExecution catalog field
          // contribute 0.
          validationActions = modernActionsForField(vInfo);
          validationActive = true;
        }
      }

      let legacySum = 0;
      let modernSum = 0;
      let modernActionsSum = 0;
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
        // Action-execution averaging mirrors the credit math: per step,
        // sum the step's own actions + the validator's actions when the
        // validator actually runs. Private-key state on the STEP doesn't
        // suppress the validator's action count (the validator is a
        // separate billed run); this matches how canvas/credits.js
        // attributes actions per card. A waterfall of read-only lookups
        // with a key-only validator now correctly reads as ~0 actions/row
        // instead of the previous hardcoded 1.
        modernActionsSum += modernActionsForField(info) + (validationActive ? validationActions : 0);
      }

      const legacyAvg = Math.round((legacySum / steps.length) * 100) / 100;
      const modernAvg = Math.round((modernSum / steps.length) * 100) / 100;
      const modernActionsAvg = Math.round((modernActionsSum / steps.length) * 100) / 100;

      const firstStepInfo =
        __cb.actionByIdLookup?.[`${steps[0].actionPackageId ?? "clay"}-${steps[0].actionKey}`];
      rows.push({
        kind: "waterfall",
        name: group.name || fieldById[steps[0].fieldId]?.name || "Waterfall",
        iconUrl: firstStepInfo?.iconUrl ?? null,
        subtitle: `Waterfall · ${steps.length} step${steps.length > 1 ? "s" : ""}`,
        legacyCredits: legacyAvg,
        modernCredits: modernAvg,
        modernActions: modernActionsAvg,
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

  // Computes the % delta for a row in either credit-count terms (the
  // structural pricing-model change) or dollar-total terms (what the
  // customer actually pays). The dollar form folds in legacy $/credit,
  // modern $/credit, and modern $/action — when any rate changes, the
  // delta updates without rebuilding the row.
  function rowDeltaPct(row, mode) {
    if (mode === "dollars") {
      const d = rowDollars(row);
      return deltaPct(d.legacy, d.modernTotal);
    }
    return deltaPct(row.legacyCredits, row.modernCredits);
  }

  // Renders the Δ cell content. Always shows a % line; when pricing is
  // on, also stacks a $-difference line below it (modernTotal$ -
  // legacy$, multiplied by the row's records multiplier when applicable).
  // Per-table rows use whole-dollar formatting for the $ diff so the
  // numbers stay scannable.
  function applyDeltaToCell(cell, ctx) {
    const { row, multiplier = 1, mode = "credits" } = ctx;
    cell.classList.remove("cb-pricing-delta-up", "cb-pricing-delta-down");
    cell.innerHTML = "";

    const pct = rowDeltaPct(row, mode);
    const pctEl = document.createElement("div");
    pctEl.className = "cb-pricing-delta-pct";
    if (pct === null) {
      pctEl.textContent = "new";
      cell.classList.add("cb-pricing-delta-up");
    } else if (pct === 0) {
      pctEl.textContent = "\u2014";
    } else {
      const sign = pct > 0 ? "+" : "";
      pctEl.textContent = `${sign}${formatNumber(Math.round(pct * 10) / 10)}%`;
      cell.classList.add(pct < 0 ? "cb-pricing-delta-down" : "cb-pricing-delta-up");
    }
    cell.appendChild(pctEl);

    if (state.pricingMode && pct !== null && pct !== 0) {
      const d = rowDollars(row);
      const diff = (d.modernTotal - d.legacy) * multiplier;
      if (diff !== 0) {
        const dollarEl = document.createElement("div");
        dollarEl.className = "cb-pricing-delta-dollar";
        const sign = diff > 0 ? "+" : "-";
        const abs = Math.abs(diff);
        const formatted = multiplier > 1 ? formatDollarWhole(abs) : formatDollar(abs);
        dollarEl.textContent = `${sign}${formatted}`;
        cell.appendChild(dollarEl);
      }
    }
  }

  function renderDeltaCell(ctx) {
    const cell = document.createElement("td");
    cell.className = "col-delta cb-pricing-num";
    cell.setAttribute("data-delta-cell", "1");
    applyDeltaToCell(cell, ctx);
    return cell;
  }

  function openComparisonModal({ table, viewId, ignoreViewVisibility }) {
    closeModal();

    const { rows, totals } = buildComparisonRows(table, viewId, ignoreViewVisibility);

    // Stash on module state so the toggle handler, the rate-input
    // commit handler, and the download functions can all read from
    // the same source of truth without re-walking the table.
    state.rows = rows;
    state.totals = totals;
    state.table = table;

    // Pre-fill the per-table multiplier from whatever the rep already
    // had in mind on the canvas (topbar Records input). Falls back to
    // 1000 when no value is set so the per-table row always has
    // something to show.
    const fromTopbar = typeof __cb.getRecordsCount === "function" ? __cb.getRecordsCount() : 0;
    state.recordsCount = fromTopbar > 0 ? fromTopbar : FIXED_RECORDS_DEFAULT;

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
    subtitle.textContent = `${table.name || "Table"} \u2014 every column`;
    titleWrap.appendChild(title);
    titleWrap.appendChild(subtitle);

    const headerActions = document.createElement("div");
    headerActions.className = "cb-export-modal-header-actions";

    // Pricing toggle — flips cb-pricing-on on the modal root, which
    // unhides the 3 dollar columns + widens the table via CSS. Δ
    // computation also switches from credit % to dollar % when on
    // (rebuilt by the toggle handler so the per-row delta values
    // pick up the new mode immediately).
    const pricingToggleBtn = document.createElement("button");
    pricingToggleBtn.type = "button";
    pricingToggleBtn.className = "cb-pricing-toggle-btn";
    pricingToggleBtn.title = "Show $ rates and per-row dollar amounts";
    pricingToggleBtn.innerHTML =
      '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>' +
      '<span>Pricing</span>';
    pricingToggleBtn.addEventListener("click", () => {
      state.pricingMode = !state.pricingMode;
      pricingToggleBtn.classList.toggle("cb-pricing-toggle-on", state.pricingMode);
      modalEl.classList.toggle("cb-pricing-on", state.pricingMode);
      // Δ mode flipped — recompute every delta cell in place so the
      // existing rows pick up the new credits-vs-dollars formula
      // without rebuilding the table DOM.
      refreshDollarCellsAndDeltas();
    });
    state.pricingToggleBtn = pricingToggleBtn;

    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "cb-export-modal-close";
    closeBtn.setAttribute("aria-label", "Close");
    closeBtn.innerHTML =
      '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
    closeBtn.addEventListener("click", closeModal);

    headerActions.appendChild(pricingToggleBtn);
    headerActions.appendChild(closeBtn);

    header.appendChild(titleWrap);
    header.appendChild(headerActions);

    // ---- Body ----
    const body = document.createElement("div");
    body.className = "cb-export-modal-body cb-pricing-body";

    if (rows.length === 0) {
      const empty = document.createElement("div");
      empty.className = "cb-export-empty";
      empty.textContent = "No enrichment fields to compare on this table.";
      body.appendChild(empty);
    } else {
      // Wrap the table in a stable container so the toggle handler can
      // replace the inner <table> in place without losing scroll
      // position or having to re-find the body.
      const tableContainer = document.createElement("div");
      tableContainer.className = "cb-pricing-table-container";
      tableContainer.appendChild(buildBreakdownTable(rows, totals));
      body.appendChild(tableContainer);
      state.tableContainer = tableContainer;
    }

    // ---- Footer ----
    const footer = document.createElement("div");
    footer.className = "cb-export-modal-footer";
    const footerHint = document.createElement("div");
    footerHint.className = "cb-export-modal-footer-hint";
    footerHint.textContent =
      "Catalog projections \u2014 actual cost depends on selected AI model and private-key wiring.";

    const footerActions = document.createElement("div");
    footerActions.className = "cb-gtme-footer-actions";

    const doneBtn = document.createElement("button");
    doneBtn.type = "button";
    doneBtn.className = "cb-export-modal-done";
    doneBtn.textContent = "Done";
    doneBtn.addEventListener("click", closeModal);

    // Download trigger — opens a small dropdown anchored above the
    // button with CSV / JSON options. Reuses the cb-export-menu
    // styling so it matches the topbar Export menu pattern.
    const downloadBtn = document.createElement("button");
    downloadBtn.type = "button";
    downloadBtn.className = "cb-gtme-submit cb-pricing-download";
    downloadBtn.innerHTML =
      '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>' +
      '<span>Download</span>' +
      '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>';
    downloadBtn.addEventListener("click", (evt) => {
      evt.stopPropagation();
      openDownloadMenu(downloadBtn);
    });

    footerActions.appendChild(doneBtn);
    footerActions.appendChild(downloadBtn);

    footer.appendChild(footerHint);
    footer.appendChild(footerActions);

    modalEl.appendChild(header);
    modalEl.appendChild(body);
    modalEl.appendChild(footer);

    modalBackdrop.appendChild(modalEl);
    document.body.appendChild(modalBackdrop);

    document.addEventListener("keydown", onKeydown);
  }

  // Builds one row. Used for both the per-field rows and the Total row
  // at the top — `opts.isTotal` tweaks the name cell (no icon, bold
  // "Total" label) and turns the dollar cells into editable rate inputs
  // (instead of computed text).
  //
  // The 3 `$` cells (col-legacy-dollar, col-modern-credits-dollar,
  // col-modern-actions-dollar) are always present in the DOM; CSS
  // hides them when the modal isn't in `cb-pricing-on` mode. Cheaper
  // than re-rendering the whole table on toggle.
  function buildRowEl(row, opts) {
    const isTotal = !!opts?.isTotal;
    const tr = document.createElement("tr");
    if (isTotal) tr.className = "cb-pricing-total-row";

    const nameCell = document.createElement("td");
    nameCell.className = "col-name";
    if (isTotal) {
      const totalLabel = document.createElement("div");
      totalLabel.className = "cb-pricing-name-text cb-pricing-total-label";
      totalLabel.textContent = "Total per row";
      nameCell.appendChild(totalLabel);
    } else {
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
    }
    tr.appendChild(nameCell);

    const legacyCell = document.createElement("td");
    legacyCell.className = "col-legacy cb-pricing-num";
    legacyCell.textContent = formatNumber(row.legacyCredits);
    tr.appendChild(legacyCell);

    tr.appendChild(buildDollarCell({
      colClass: "col-legacy-dollar",
      derivedClass: "cb-pricing-derived-legacy",
      rateClass: "cb-pricing-rate-legacy",
      isTotal,
      rateValue: state.legacyCreditRate,
      derivedValue: (Number(row.legacyCredits) || 0) * state.legacyCreditRate,
    }));

    const modernCreditsCell = document.createElement("td");
    modernCreditsCell.className = "col-modern-credits cb-pricing-num";
    modernCreditsCell.textContent = formatNumber(row.modernCredits);
    tr.appendChild(modernCreditsCell);

    tr.appendChild(buildDollarCell({
      colClass: "col-modern-credits-dollar",
      derivedClass: "cb-pricing-derived-modern-credits",
      rateClass: "cb-pricing-rate-modern-credits",
      isTotal,
      rateValue: state.modernCreditRate,
      derivedValue: (Number(row.modernCredits) || 0) * state.modernCreditRate,
    }));

    const modernActionsCell = document.createElement("td");
    modernActionsCell.className = "col-modern-actions cb-pricing-num";
    modernActionsCell.textContent = formatNumber(row.modernActions);
    tr.appendChild(modernActionsCell);

    tr.appendChild(buildDollarCell({
      colClass: "col-modern-actions-dollar",
      derivedClass: "cb-pricing-derived-modern-actions",
      rateClass: "cb-pricing-rate-modern-actions",
      isTotal,
      rateValue: state.actionRate,
      derivedValue: (Number(row.modernActions) || 0) * state.actionRate,
    }));

    // Modern total $ — credits$ + actions$ for this row. Read-only
    // (no rate input), shown only when pricing is on (CSS hides the
    // column otherwise). Refreshed by refreshDollarCellsAndDeltas
    // whenever any rate input changes.
    const modernTotal = (Number(row.modernCredits) || 0) * state.modernCreditRate
                      + (Number(row.modernActions) || 0) * state.actionRate;
    tr.appendChild(buildDollarCell({
      colClass: "col-modern-total-dollar",
      derivedClass: "cb-pricing-derived-modern-total",
      rateClass: "",
      isTotal: false,
      rateValue: 0,
      derivedValue: modernTotal,
    }));

    tr.appendChild(renderDeltaCell({
      row,
      multiplier: 1,
      mode: state.pricingMode ? "dollars" : "credits",
    }));

    // Stash the row context so refreshDollarCellsAndDeltas can update
    // every cell on rate / records changes without rebuilding. The
    // multiplier is 1 for per-row Total + per-enrichment rows; the
    // per-table row uses the same expando shape with multiplier =
    // state.recordsCount (set in buildTotalPerTableRowEl).
    tr._priceRowContext = { row, multiplier: 1 };
    return tr;
  }

  // Per-table summary row — sits directly under the per-row Total. All
  // numeric / dollar values are per-row × records. The records input
  // lives in the col-name cell below the "Total per table" label, and
  // commits on Enter / blur to push state.recordsCount + trigger an
  // in-place refresh that re-multiplies every cell on this row.
  //
  // Δ here uses the raw per-row totals (not the multiplied values)
  // because the records multiplier cancels out in the % calc — saves
  // an unnecessary recompute path and keeps Δ semantically the same
  // across both total rows.
  function buildTotalPerTableRowEl(totals) {
    const tr = document.createElement("tr");
    tr.className = "cb-pricing-table-row";
    const mul = state.recordsCount;

    const nameCell = document.createElement("td");
    nameCell.className = "col-name";

    const labelWrap = document.createElement("div");
    labelWrap.className = "cb-pricing-table-label-wrap";

    const totalLabel = document.createElement("div");
    totalLabel.className = "cb-pricing-name-text cb-pricing-total-label";
    totalLabel.textContent = "Total per table";
    labelWrap.appendChild(totalLabel);

    const recordsRow = document.createElement("div");
    recordsRow.className = "cb-pricing-records-row";

    const xLabel = document.createElement("span");
    xLabel.className = "cb-pricing-records-x";
    xLabel.textContent = "\u00d7";
    recordsRow.appendChild(xLabel);

    const recordsInput = document.createElement("input");
    recordsInput.type = "text";
    recordsInput.inputMode = "numeric";
    recordsInput.className = "cb-pricing-records-input";
    recordsInput.value = formatRecords(state.recordsCount);
    recordsRow.appendChild(recordsInput);

    const recordsLabel = document.createElement("span");
    recordsLabel.className = "cb-pricing-records-label";
    recordsLabel.textContent = "records";
    recordsRow.appendChild(recordsLabel);

    labelWrap.appendChild(recordsRow);
    nameCell.appendChild(labelWrap);
    tr.appendChild(nameCell);

    // Per-table row rounds every numeric/dollar value to whole numbers
    // (large amounts make sub-unit precision visual noise). Numeric
    // cells: Math.round on count × records; dollar cells:
    // formatDollarWhole via wholeDollar:true on buildDollarCell.
    const legacyCell = document.createElement("td");
    legacyCell.className = "col-legacy cb-pricing-num";
    legacyCell.textContent = formatNumber(Math.round((Number(totals.legacyCredits) || 0) * mul));
    tr.appendChild(legacyCell);

    tr.appendChild(buildDollarCell({
      colClass: "col-legacy-dollar",
      derivedClass: "cb-pricing-derived-legacy",
      rateClass: "cb-pricing-rate-legacy",
      isTotal: false,
      rateValue: state.legacyCreditRate,
      derivedValue: (Number(totals.legacyCredits) || 0) * mul * state.legacyCreditRate,
      wholeDollar: true,
    }));

    const modernCreditsCell = document.createElement("td");
    modernCreditsCell.className = "col-modern-credits cb-pricing-num";
    modernCreditsCell.textContent = formatNumber(Math.round((Number(totals.modernCredits) || 0) * mul));
    tr.appendChild(modernCreditsCell);

    tr.appendChild(buildDollarCell({
      colClass: "col-modern-credits-dollar",
      derivedClass: "cb-pricing-derived-modern-credits",
      rateClass: "cb-pricing-rate-modern-credits",
      isTotal: false,
      rateValue: state.modernCreditRate,
      derivedValue: (Number(totals.modernCredits) || 0) * mul * state.modernCreditRate,
      wholeDollar: true,
    }));

    const modernActionsCell = document.createElement("td");
    modernActionsCell.className = "col-modern-actions cb-pricing-num";
    modernActionsCell.textContent = formatNumber(Math.round((Number(totals.modernActions) || 0) * mul));
    tr.appendChild(modernActionsCell);

    tr.appendChild(buildDollarCell({
      colClass: "col-modern-actions-dollar",
      derivedClass: "cb-pricing-derived-modern-actions",
      rateClass: "cb-pricing-rate-modern-actions",
      isTotal: false,
      rateValue: state.actionRate,
      derivedValue: (Number(totals.modernActions) || 0) * mul * state.actionRate,
      wholeDollar: true,
    }));

    const modernTotal = (Number(totals.modernCredits) || 0) * state.modernCreditRate
                      + (Number(totals.modernActions) || 0) * state.actionRate;
    tr.appendChild(buildDollarCell({
      colClass: "col-modern-total-dollar",
      derivedClass: "cb-pricing-derived-modern-total",
      rateClass: "",
      isTotal: false,
      rateValue: 0,
      derivedValue: modernTotal * mul,
      wholeDollar: true,
    }));

    tr.appendChild(renderDeltaCell({
      row: totals,
      multiplier: mul,
      mode: state.pricingMode ? "dollars" : "credits",
    }));

    const commitRecords = () => {
      state.recordsCount = parseRecords(recordsInput.value);
      recordsInput.value = formatRecords(state.recordsCount);
      if (tr._priceRowContext) tr._priceRowContext.multiplier = state.recordsCount;
      refreshDollarCellsAndDeltas();
    };
    recordsInput.addEventListener("blur", commitRecords);
    recordsInput.addEventListener("keydown", (evt) => {
      if (evt.key === "Enter") {
        evt.preventDefault();
        recordsInput.blur();
      }
    });
    recordsInput.addEventListener("focus", () => recordsInput.select());

    tr._priceRowContext = { row: totals, multiplier: mul };
    return tr;
  }

  // Builds a single dollar cell. Per-enrichment rows show just the
  // computed dollar text (e.g., "$0.36"). The Total row shows the
  // editable rate input on top + the computed total dollar amount
  // below. The input commits on Enter / blur and triggers an in-place
  // refresh of every dollar cell + every delta cell, no full rebuild.
  //
  // `wholeDollar`: forces the displayed value (and refreshes that look
  // it up via .data-whole-dollar="1") to round to the nearest whole
  // dollar. Used by the per-table row where amounts are large enough
  // that sub-cent precision is noise.
  function buildDollarCell({ colClass, derivedClass, rateClass, isTotal, rateValue, derivedValue, wholeDollar = false }) {
    const cell = document.createElement("td");
    cell.className = `${colClass} cb-pricing-num`;
    const fmt = wholeDollar ? formatDollarWhole : formatDollar;
    if (!isTotal) {
      const span = document.createElement("span");
      span.className = `cb-pricing-derived ${derivedClass}`;
      if (wholeDollar) span.setAttribute("data-whole-dollar", "1");
      span.textContent = fmt(derivedValue);
      cell.appendChild(span);
      return cell;
    }
    const wrap = document.createElement("div");
    wrap.className = "cb-pricing-rate-wrap";
    const input = document.createElement("input");
    input.type = "text";
    input.inputMode = "decimal";
    input.className = `cb-pricing-rate-input ${rateClass}`;
    input.value = formatDollar(rateValue);
    wrap.appendChild(input);
    const derived = document.createElement("div");
    derived.className = `cb-pricing-derived ${derivedClass}`;
    derived.textContent = formatDollar(derivedValue);
    wrap.appendChild(derived);
    cell.appendChild(wrap);

    const commit = () => {
      const next = parseDollar(input.value);
      if (rateClass === "cb-pricing-rate-legacy") state.legacyCreditRate = next;
      else if (rateClass === "cb-pricing-rate-modern-credits") state.modernCreditRate = next;
      else if (rateClass === "cb-pricing-rate-modern-actions") state.actionRate = next;
      input.value = formatDollar(next);
      refreshDollarCellsAndDeltas();
    };
    input.addEventListener("blur", commit);
    input.addEventListener("keydown", (evt) => {
      if (evt.key === "Enter") {
        evt.preventDefault();
        input.blur();
      }
    });
    input.addEventListener("focus", () => input.select());

    return cell;
  }

  // In-place updater — runs after a rate input commits, the records
  // input commits, OR the pricing toggle flips (Δ mode changes).
  // Reads each row's stored `_priceRowContext` expando ({ row,
  // multiplier }) so the math is consistent for the per-row Total
  // (multiplier 1), the per-table Total (multiplier = recordsCount),
  // and per-enrichment rows (multiplier 1). Updates:
  //   - Numeric cells when multiplier !== 1 (per-table only)
  //   - The 3 dollar cells everywhere
  //   - The Δ cell everywhere (multiplier cancels in the % calc, so
  //     the same rowDeltaPct(row, mode) call works for any row)
  function refreshDollarCellsAndDeltas() {
    if (!state.tableContainer) return;
    const tbl = state.tableContainer.firstChild;
    if (!tbl) return;

    const trs = tbl.querySelectorAll("tbody > tr");
    trs.forEach((tr) => {
      const ctx = tr._priceRowContext;
      if (!ctx) return;
      const row = ctx.row;
      const mul = ctx.multiplier || 1;

      if (mul !== 1) {
        // `.col-legacy` is a strict class match — does NOT match
        // `.col-legacy-dollar` (those are separate class names, not
        // a prefix relationship), so we get the credit/action numeric
        // cell directly without needing a :not() exclusion.
        // Per-table rows round to whole numbers (large-volume noise).
        const lc = tr.querySelector(".col-legacy");
        const mc = tr.querySelector(".col-modern-credits");
        const ma = tr.querySelector(".col-modern-actions");
        if (lc) lc.textContent = formatNumber(Math.round((Number(row.legacyCredits) || 0) * mul));
        if (mc) mc.textContent = formatNumber(Math.round((Number(row.modernCredits) || 0) * mul));
        if (ma) ma.textContent = formatNumber(Math.round((Number(row.modernActions) || 0) * mul));
      }

      // Dollar cells share one formatter selection per row: per-row
      // values keep cents, per-table values round to whole dollars
      // (consistent with the initial render via wholeDollar:true).
      const fmt = mul > 1 ? formatDollarWhole : formatDollar;
      const dl = tr.querySelector(".cb-pricing-derived-legacy");
      const dmc = tr.querySelector(".cb-pricing-derived-modern-credits");
      const dma = tr.querySelector(".cb-pricing-derived-modern-actions");
      const dmt = tr.querySelector(".cb-pricing-derived-modern-total");
      if (dl) dl.textContent = fmt((Number(row.legacyCredits) || 0) * mul * state.legacyCreditRate);
      if (dmc) dmc.textContent = fmt((Number(row.modernCredits) || 0) * mul * state.modernCreditRate);
      if (dma) dma.textContent = fmt((Number(row.modernActions) || 0) * mul * state.actionRate);
      if (dmt) {
        const modernTotal = (Number(row.modernCredits) || 0) * state.modernCreditRate
                          + (Number(row.modernActions) || 0) * state.actionRate;
        dmt.textContent = fmt(modernTotal * mul);
      }

      const delta = tr.querySelector("[data-delta-cell]");
      if (delta) applyDeltaToCell(delta, {
        row,
        multiplier: mul,
        mode: state.pricingMode ? "dollars" : "credits",
      });
    });
  }

  // Always emits the full 8-column table (Enrichment | Legacy: Credits,
  // $ | Modern: Credits, $, Actions, $ | Δ). The 3 dollar columns are
  // hidden via CSS when the modal isn't in `cb-pricing-on` mode. This
  // keeps toggle re-render trivial — flip a class, no DOM rebuild.
  // Colspans on the section headers stay at 2/4 so the LEGACY pill
  // always covers credits + $ and MODERN always covers credits + $ +
  // actions + $; the visible visual spans collapse naturally because
  // the hidden columns have width: 0.
  function buildBreakdownTable(rows, totals) {
    const tbl = document.createElement("table");
    tbl.className = "cb-pricing-table";

    // <colgroup> with explicit per-column widths is the only reliable
    // way to size individual columns in a `table-layout: fixed` table
    // when the first row uses colspan-spanning section headers (without
    // colgroup, browsers split each colspan equally across its child
    // columns, so OFF-mode would allocate width to display:none cells
    // and leave huge empty gaps in the visible columns). The matching
    // CSS controls the actual width per col class — including
    // collapsing the dollar cols to width:0 when not in pricing-on
    // mode, so they don't claim any space.
    const colgroup = document.createElement("colgroup");
    const colClasses = [
      "col-name",
      "col-legacy",
      "col-legacy-dollar",
      "col-modern-credits",
      "col-modern-credits-dollar",
      "col-modern-actions",
      "col-modern-actions-dollar",
      "col-modern-total-dollar",
      "col-delta",
    ];
    for (const cls of colClasses) {
      const c = document.createElement("col");
      c.className = cls;
      colgroup.appendChild(c);
    }
    tbl.appendChild(colgroup);

    const thead = document.createElement("thead");

    const headRowSections = document.createElement("tr");
    headRowSections.className = "cb-pricing-head-sections";

    // The Enrichment column header is intentionally blank — the column
    // is self-evident from its content (provider icon + field name) and
    // the empty header gives the LEGACY / MODERN section pills more
    // visual room.
    const enrichmentTh = document.createElement("th");
    enrichmentTh.className = "col-name";
    enrichmentTh.rowSpan = 2;
    enrichmentTh.textContent = "";
    headRowSections.appendChild(enrichmentTh);

    const legacySectionTh = document.createElement("th");
    legacySectionTh.className = "cb-pricing-head-section cb-pricing-head-section-legacy";
    legacySectionTh.colSpan = 2;
    legacySectionTh.textContent = "Legacy";
    headRowSections.appendChild(legacySectionTh);

    const modernSectionTh = document.createElement("th");
    modernSectionTh.className = "cb-pricing-head-section cb-pricing-head-section-modern";
    // 5 sub-columns when pricing is on (Credits, $, Actions, $, Total $);
    // when off, all 4 dollar sub-cols are width:0 / display:none so the
    // visible span collapses to just Credits + Actions.
    modernSectionTh.colSpan = 5;
    modernSectionTh.textContent = "Modern";
    headRowSections.appendChild(modernSectionTh);

    const deltaTh = document.createElement("th");
    deltaTh.className = "col-delta";
    deltaTh.rowSpan = 2;
    deltaTh.textContent = "\u0394";
    headRowSections.appendChild(deltaTh);

    thead.appendChild(headRowSections);

    const headRowCols = document.createElement("tr");
    headRowCols.className = "cb-pricing-head-cols";

    const makeColTh = (cls, label) => {
      const th = document.createElement("th");
      th.className = cls;
      th.textContent = label;
      return th;
    };

    headRowCols.appendChild(makeColTh("col-legacy", "Credits"));
    headRowCols.appendChild(makeColTh("col-legacy-dollar", "$"));
    headRowCols.appendChild(makeColTh("col-modern-credits", "Credits"));
    headRowCols.appendChild(makeColTh("col-modern-credits-dollar", "$"));
    headRowCols.appendChild(makeColTh("col-modern-actions", "Actions"));
    headRowCols.appendChild(makeColTh("col-modern-actions-dollar", "$"));
    headRowCols.appendChild(makeColTh("col-modern-total-dollar", "Total $"));

    thead.appendChild(headRowCols);
    tbl.appendChild(thead);

    const tbody = document.createElement("tbody");

    const totalRow = {
      legacyCredits: totals.legacyCredits,
      modernCredits: totals.modernCredits,
      modernActions: totals.modernActions,
    };

    tbody.appendChild(buildRowEl(totalRow, { isTotal: true }));
    tbody.appendChild(buildTotalPerTableRowEl(totalRow));

    for (const row of rows) {
      tbody.appendChild(buildRowEl(row));
    }
    tbl.appendChild(tbody);
    return tbl;
  }

  // ---------------------------------------------------------------------------
  // Download menu (CSV / JSON)
  //
  // Anchored above the Download trigger button. Mirrors the topbar
  // Export menu pattern in src/export.js: invisible full-viewport
  // backdrop catches outside clicks; the menu is a floating list of
  // option buttons. Both download formats honor the current pricing
  // mode so the file matches what's on screen.
  // ---------------------------------------------------------------------------

  let downloadMenuEl = null;
  let downloadMenuBackdrop = null;

  function closeDownloadMenu() {
    if (downloadMenuEl) { downloadMenuEl.remove(); downloadMenuEl = null; }
    if (downloadMenuBackdrop) { downloadMenuBackdrop.remove(); downloadMenuBackdrop = null; }
  }

  function openDownloadMenu(anchorEl) {
    closeDownloadMenu();

    downloadMenuBackdrop = document.createElement("div");
    downloadMenuBackdrop.style.cssText = "position:fixed;inset:0;z-index:9999998;";
    downloadMenuBackdrop.addEventListener("mousedown", (evt) => {
      evt.stopPropagation();
      closeDownloadMenu();
    });

    downloadMenuEl = document.createElement("div");
    downloadMenuEl.className = "cb-export-menu";
    downloadMenuEl.addEventListener("mousedown", (evt) => evt.stopPropagation());

    const csvOpt = document.createElement("button");
    csvOpt.type = "button";
    csvOpt.className = "cb-export-menu-option";
    csvOpt.textContent = "Download CSV";
    csvOpt.addEventListener("click", () => { closeDownloadMenu(); downloadCsv(); });

    const jsonOpt = document.createElement("button");
    jsonOpt.type = "button";
    jsonOpt.className = "cb-export-menu-option";
    jsonOpt.textContent = "Download JSON";
    jsonOpt.addEventListener("click", () => { closeDownloadMenu(); downloadJson(); });

    downloadMenuEl.appendChild(csvOpt);
    downloadMenuEl.appendChild(jsonOpt);

    document.body.appendChild(downloadMenuBackdrop);
    document.body.appendChild(downloadMenuEl);

    // Anchor above-right of the trigger so the menu doesn't get clipped
    // by the modal footer or fall off the bottom of the viewport.
    const rect = anchorEl.getBoundingClientRect();
    downloadMenuEl.style.position = "fixed";
    downloadMenuEl.style.bottom = (window.innerHeight - rect.top + 6) + "px";
    downloadMenuEl.style.right = Math.max(8, window.innerWidth - rect.right) + "px";
    downloadMenuEl.style.zIndex = "9999999";
  }

  // Slugify the table name for filenames. Lowercase + non-alphanumeric
  // → hyphen, collapse repeats, trim. Falls back to "untitled" so we
  // always have something useful in the filename.
  function slugify(s) {
    const base = String(s || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
    return base || "untitled";
  }

  function timestamp() {
    return new Date().toISOString().replace(/[:.]/g, "-");
  }

  // Browsers force-name downloads via a synthetic <a download> click.
  // Same pattern src/export.js uses for its JSON export.
  function triggerDownload(filename, text, mimeType) {
    const blob = new Blob([text], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // Builds the row matrix the CSV serializer consumes. When
  // state.pricingMode is on, includes the 3 dollar columns; otherwise
  // sticks to the 5 visible columns. The Total row is included as the
  // last entry (CSVs are usually consumed in spreadsheet apps where a
  // bottom totals row reads more naturally).
  function buildExportMatrix() {
    const pricing = state.pricingMode;
    const headers = pricing
      ? [
          "Enrichment",
          "Legacy credits",
          "Legacy $ rate",
          "Legacy $",
          "Modern credits",
          "Modern $ rate",
          "Modern credit $",
          "Modern actions",
          "Action $ rate",
          "Modern action $",
          "Modern total $",
          "Δ $ %",
          "Δ $",
        ]
      : [
          "Enrichment",
          "Legacy credits",
          "Modern credits",
          "Modern actions",
          "Δ credits %",
        ];

    // `whole` flag: per-table rows render every number rounded to whole
    // units (matches the on-screen treatment). Per-row + per-enrichment
    // keep their natural precision.
    const rowToCells = (label, row, whole = false) => {
      const d = rowDollars(row);
      const pct = rowDeltaPct(row, pricing ? "dollars" : "credits");
      const pctText = pct === null
        ? "new"
        : (pct === 0 ? "0" : `${pct > 0 ? "+" : ""}${(Math.round(pct * 10) / 10).toString()}`);
      const num = (n) => {
        if (!Number.isFinite(n)) return "0";
        return whole ? Math.round(n).toString() : n.toString();
      };
      const dollar = (n) => {
        if (whole) return "$" + Math.round(Number(n) || 0).toLocaleString();
        return "$" + (Math.round(n * 1000) / 1000).toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
      };
      if (!pricing) {
        return [label, num(row.legacyCredits), num(row.modernCredits), num(row.modernActions), pctText];
      }
      const dollarDiff = d.modernTotal - d.legacy;
      const dollarDiffText = dollarDiff === 0
        ? "0"
        : (dollarDiff > 0 ? "+" : "-") + dollar(Math.abs(dollarDiff));
      return [
        label,
        num(row.legacyCredits),
        dollar(state.legacyCreditRate),
        dollar(d.legacy),
        num(row.modernCredits),
        dollar(state.modernCreditRate),
        dollar(d.modernCredit),
        num(row.modernActions),
        dollar(state.actionRate),
        dollar(d.modernAction),
        dollar(d.modernTotal),
        pctText,
        dollarDiffText,
      ];
    };

    const totalRow = {
      legacyCredits: state.totals?.legacyCredits ?? 0,
      modernCredits: state.totals?.modernCredits ?? 0,
      modernActions: state.totals?.modernActions ?? 0,
    };

    // Per-table row = per-row × records, computed by multiplying each
    // total field. Rendered with a label that bakes in the records
    // multiplier so the CSV is self-describing without needing a
    // separate column. Numeric values are rounded to whole units so
    // the CSV mirrors the on-screen Total per table row.
    const records = state.recordsCount;
    const totalPerTableRow = {
      legacyCredits: totalRow.legacyCredits * records,
      modernCredits: totalRow.modernCredits * records,
      modernActions: totalRow.modernActions * records,
    };

    const dataRows = (state.rows || []).map((r) => rowToCells(r.name || "", r));
    dataRows.push(rowToCells("Total per row", totalRow));
    dataRows.push(
      rowToCells(`Total per table (\u00d7 ${records.toLocaleString()} records)`, totalPerTableRow, true),
    );
    return { headers, rows: dataRows };
  }

  function downloadCsv() {
    if (!state.rows || !state.totals) return;
    const escape = (v) => {
      const s = String(v ?? "");
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const { headers, rows } = buildExportMatrix();
    const csv = [headers, ...rows].map((r) => r.map(escape).join(",")).join("\n");
    const filename = `clay-pricing-comparison-${slugify(state.table?.name)}-${timestamp()}.csv`;
    triggerDownload(filename, csv, "text/csv;charset=utf-8");
  }

  function downloadJson() {
    if (!state.rows || !state.totals) return;
    const pricing = state.pricingMode;
    const payload = {
      table: {
        id: state.table?.id ?? null,
        name: state.table?.name ?? null,
      },
      pricingMode: pricing,
      rates: pricing
        ? {
            legacyCreditRate: state.legacyCreditRate,
            modernCreditRate: state.modernCreditRate,
            actionRate: state.actionRate,
          }
        : null,
      totals: {
        legacyCredits: state.totals.legacyCredits,
        modernCredits: state.totals.modernCredits,
        modernActions: state.totals.modernActions,
        ...(pricing
          ? (() => {
              const d = rowDollars(state.totals);
              return {
                legacyDollar: d.legacy,
                modernCreditDollar: d.modernCredit,
                modernActionDollar: d.modernAction,
                modernTotalDollar: d.modernTotal,
              };
            })()
          : {}),
      },
      // Per-table totals — same numbers multiplied by the records
      // multiplier the user set on the modal. Always emitted so the
      // download is self-contained even when pricing mode is off.
      // Values are rounded to whole units to match the on-screen
      // Total per table row.
      records: state.recordsCount,
      totalsPerTable: (() => {
        const m = state.recordsCount;
        const t = state.totals;
        const base = {
          legacyCredits: Math.round(t.legacyCredits * m),
          modernCredits: Math.round(t.modernCredits * m),
          modernActions: Math.round(t.modernActions * m),
        };
        if (!pricing) return base;
        const d = rowDollars(t);
        return {
          ...base,
          legacyDollar: Math.round(d.legacy * m),
          modernCreditDollar: Math.round(d.modernCredit * m),
          modernActionDollar: Math.round(d.modernAction * m),
          modernTotalDollar: Math.round(d.modernTotal * m),
        };
      })(),
      rows: state.rows.map((r) => {
        const base = {
          name: r.name,
          kind: r.kind,
          legacyCredits: r.legacyCredits,
          modernCredits: r.modernCredits,
          modernActions: r.modernActions,
        };
        if (!pricing) return base;
        const d = rowDollars(r);
        return {
          ...base,
          legacyDollar: d.legacy,
          modernCreditDollar: d.modernCredit,
          modernActionDollar: d.modernAction,
          modernTotalDollar: d.modernTotal,
        };
      }),
    };
    const filename = `clay-pricing-comparison-${slugify(state.table?.name)}-${timestamp()}.json`;
    triggerDownload(filename, JSON.stringify(payload, null, 2), "application/json;charset=utf-8");
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

      // Always full-table coverage. The comparison's purpose is "what
      // would the whole table cost on the new pricing", so per-view
      // scoping would be misleading — a hidden column still gets billed
      // when the recipe runs.
      const onPick = (table) => {
        openComparisonModal({
          table,
          viewId: table.firstViewId ?? null,
          ignoreViewVisibility: true,
        });
      };

      if (tables.length === 1) {
        __cb.tablePicker.close();
        onPick(tables[0]);
      } else {
        __cb.tablePicker.show(tables, anchorEl, onPick, { fullTableOnly: true });
      }
    } catch (err) {
      console.error("[Clay Scoping] Failed to fetch tables:", err);
      __cb.tablePicker.close();
    }
  };
})();
