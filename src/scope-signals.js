/**
 * "Scope Signals" flow — quote native Clay monitoring signals from scratch,
 * without importing a table (wired from the table-view "Scope" dropdown).
 *
 * A single-step modal: one row per signal the rep wants to monitor. Each row
 * picks a signal type, a name, an estimated volume, and a run cadence. On
 * confirm it creates a normal "Signals" L1 use case with, per row, a DP
 * ("Job changes", …) linked to one signal ER card carrying the recurring
 * per-run / per-result cost.
 *
 * Pricing is a hardcoded static catalog (no trigger definition exists yet, so
 * the server /estimated-signal-cost endpoint can't be called). Figures mirror
 * clay-base — resync if Clay changes them:
 *   - Per-run people signals (JobChange / NewHire / JobPost / Promotion):
 *       0.2 credits + 1 action per MONITORED RECORD
 *       (libs/api-contract/src/signals/lib/credits/get-total-estimated-credit-cost-per-run.ts,
 *        signal-execution-cost.ts)
 *   - News & fundraising (per-result): 6 credits + 1 action per RESULT
 *       (Intellizence get-news-source action:
 *        libs/shared-backend/public-actions/apps/intellizence/.../action-definition.ts)
 *
 * Signal ER cards are priced by the existing cost model with NO x Records
 * multiply — driven entirely by the fields stamped here (isSignal /
 * signalChargeUnit / credits / actionExecutions / monitoredRecordCount /
 * signalResultCount), the same shape table-import.js applySignalCardData sets.
 * See cost-model.js signalRunVolume / annualVolume.
 *
 * Reuses the cb-export-modal / cb-gtme-* shell from styles/export.css; the
 * Signals-specific pieces live in styles/scope-signals.css (cb-scope-signals-*).
 */
(function () {
  "use strict";

  const __cb = (window.__cb = window.__cb || {});

  let modalEl = null;
  let backdropEl = null;

  // Static signal catalog (the "basics" with known, stable prices). `chargeUnit`
  // drives the count label + the cost-model volume path: "record" multiplies the
  // per-unit cost by monitoredRecordCount, "result" by signalResultCount.
  const SIGNAL_TYPES = [
    {
      id: "JobChange", label: "Job Change", signalType: "JobChange",
      chargeUnit: "record", creditsPerUnit: 0.2, actionsPerUnit: 1,
      blurb: "Detect when monitored people change jobs.",
    },
    {
      id: "NewHire", label: "New Hire", signalType: "NewHire",
      chargeUnit: "record", creditsPerUnit: 0.2, actionsPerUnit: 1,
      blurb: "Detect new hires at monitored companies.",
    },
    {
      id: "JobPost", label: "Job Post", signalType: "JobPost",
      chargeUnit: "record", creditsPerUnit: 0.2, actionsPerUnit: 1,
      blurb: "Detect new job postings at monitored companies.",
    },
    {
      id: "Promotion", label: "Promotion", signalType: "Promotion",
      chargeUnit: "record", creditsPerUnit: 0.2, actionsPerUnit: 1,
      blurb: "Detect promotions among monitored people.",
    },
    {
      id: "News", label: "News & Fundraising", signalType: "News",
      chargeUnit: "result", creditsPerUnit: 6, actionsPerUnit: 1,
      blurb: "Pull news & fundraising events for monitored companies.",
    },
  ];

  const DEFAULT_FREQUENCY_ID = "monthly";

  // Phosphor "Bell" glyph — distinct from Ads' broadcast; tinted via currentColor.
  const SIGNAL_ICON_SVG =
    '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" viewBox="0 0 256 256" aria-hidden="true">' +
    '<path d="M221.8,175.94C216.25,166.38,208,139.33,208,104a80,80,0,1,0-160,0c0,35.34-8.26,62.38-13.81,71.94A16,16,0,0,0,48,200H88.81a40,40,0,0,0,78.38,0H208a16,16,0,0,0,13.8-24.06ZM128,216a24,24,0,0,1-22.62-16h45.24A24,24,0,0,1,128,216ZM48,184c7.7-13.24,16-43.92,16-80a64,64,0,1,1,128,0c0,36.05,8.28,66.73,16,80Z"/></svg>';

  // Phosphor "Coins" glyph (matches Clay's credit badge); tinted via currentColor.
  const COIN_SVG =
    '<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 256 256" fill="currentColor" aria-hidden="true"><path opacity="0.2" d="M240,132c0,19.88-35.82,36-80,36-19.6,0-37.56-3.17-51.47-8.44h0C146.76,156.85,176,142,176,124V96.72h0C212.52,100.06,240,114.58,240,132ZM176,84c0-19.88-35.82-36-80-36S16,64.12,16,84s35.82,36,80,36S176,103.88,176,84Z"/><path d="M184,89.57V84c0-25.08-37.83-44-88-44S8,58.92,8,84v40c0,20.89,26.25,37.49,64,42.46V172c0,25.08,37.83,44,88,44s88-18.92,88-44V132C248,111.3,222.58,94.68,184,89.57ZM232,132c0,13.22-30.79,28-72,28-3.73,0-7.43-.13-11.08-.37C170.49,151.77,184,139,184,124V105.74C213.87,110.19,232,122.27,232,132ZM72,150.25V126.46A183.74,183.74,0,0,0,96,128a183.74,183.74,0,0,0,24-1.54v23.79A163,163,0,0,1,96,152,163,163,0,0,1,72,150.25Zm96-40.32V124c0,8.39-12.41,17.4-32,22.87V123.5C148.91,120.37,159.84,115.71,168,109.93ZM96,56c41.21,0,72,14.78,72,28s-30.79,28-72,28S24,97.22,24,84,54.79,56,96,56ZM24,124V109.93c8.16,5.78,19.09,10.44,32,13.57v23.37C36.41,141.4,24,132.39,24,124Zm64,48v-4.17c2.63.1,5.29.17,8,.17,3.88,0,7.67-.13,11.39-.35A121.92,121.92,0,0,0,120,171.41v23.46C100.41,189.4,88,180.39,88,172Zm48,26.25V174.4a179.48,179.48,0,0,0,24,1.6,183.74,183.74,0,0,0,24-1.54v23.79a165.45,165.45,0,0,1-48,0Zm64-3.38V171.5c12.91-3.13,23.84-7.79,32-13.57V172C232,180.39,219.59,189.4,200,194.87Z"/></svg>';

  const CHEVRON_DOWN_SVG =
    '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>';

  function signalDef(typeId) {
    return SIGNAL_TYPES.find((t) => t.id === typeId) || SIGNAL_TYPES[0];
  }

  function fmtNum(n) {
    const v = Number(n) || 0;
    // Keep one decimal for sub-unit credits (0.2 / record); whole numbers otherwise.
    return Number.isInteger(v) ? v.toLocaleString() : v.toLocaleString(undefined, { maximumFractionDigits: 2 });
  }

  function freqMultiplier(freqId) {
    const opt = (__cb.FREQUENCY_OPTIONS || []).find((o) => o.id === freqId);
    return opt ? opt.multiplier : 1;
  }

  function frequencyLabel(id) {
    const opt = (__cb.FREQUENCY_OPTIONS || []).find((o) => o.id === id);
    return opt ? opt.label : id;
  }

  // Per-run + annualized figures for one signal row (matches cost-model math:
  // credits = perUnit x count x frequencyMult).
  function computeSignal(sig) {
    const def = signalDef(sig.typeId);
    const count = Math.max(0, Number(sig.count) || 0);
    const perRunCredits = def.creditsPerUnit * count;
    const perRunActions = def.actionsPerUnit * count;
    const mult = freqMultiplier(sig.frequencyId);
    return {
      def,
      count,
      perRunCredits,
      perRunActions,
      annualCredits: perRunCredits * mult,
      annualActions: perRunActions * mult,
    };
  }

  // ---- Custom frequency dropdown (body-appended menu, one at a time) --------
  let freqMenuEl = null;

  function closeFreqMenu() {
    if (freqMenuEl) {
      freqMenuEl.remove();
      freqMenuEl = null;
    }
    document.removeEventListener("mousedown", onFreqMenuDocClick, true);
  }

  function onFreqMenuDocClick(evt) {
    if (freqMenuEl && !freqMenuEl.contains(evt.target)) closeFreqMenu();
  }

  function openFreqMenu(anchor, currentId, onPick) {
    closeFreqMenu();
    const menu = document.createElement("div");
    menu.className = "cb-scope-signals-freq-menu";
    menu.setAttribute("role", "listbox");
    menu.addEventListener("mousedown", (evt) => evt.stopPropagation());
    const opts = __cb.FREQUENCY_OPTIONS || [
      { id: "annually", label: "Annually" }, { id: "monthly", label: "Monthly" },
    ];
    for (const o of opts) {
      const opt = document.createElement("button");
      opt.type = "button";
      opt.className =
        "cb-scope-signals-freq-menu-opt" +
        (o.id === currentId ? " cb-scope-signals-freq-menu-opt-active" : "");
      opt.setAttribute("role", "option");
      opt.setAttribute("aria-selected", o.id === currentId ? "true" : "false");
      opt.textContent = o.label;
      opt.addEventListener("click", (evt) => {
        evt.stopPropagation();
        closeFreqMenu();
        onPick(o.id);
      });
      menu.appendChild(opt);
    }
    document.body.appendChild(menu);
    const r = anchor.getBoundingClientRect();
    menu.style.position = "fixed";
    menu.style.left = `${Math.round(r.left)}px`;
    menu.style.top = `${Math.round(r.bottom + 4)}px`;
    menu.style.minWidth = `${Math.round(r.width)}px`;
    freqMenuEl = menu;
    document.addEventListener("mousedown", onFreqMenuDocClick, true);
  }

  function buildFrequencyDropdown(currentId, onPick) {
    const trigger = document.createElement("button");
    trigger.type = "button";
    trigger.className = "cb-scope-signals-freq-trigger";
    trigger.setAttribute("aria-haspopup", "listbox");
    const labelSpan = document.createElement("span");
    labelSpan.className = "cb-scope-signals-freq-label";
    labelSpan.textContent = frequencyLabel(currentId);
    const chev = document.createElement("span");
    chev.className = "cb-scope-signals-freq-chevron";
    chev.innerHTML = CHEVRON_DOWN_SVG;
    trigger.appendChild(labelSpan);
    trigger.appendChild(chev);
    trigger.addEventListener("mousedown", (evt) => evt.stopPropagation());
    trigger.addEventListener("click", (evt) => {
      evt.stopPropagation();
      openFreqMenu(trigger, currentId, (nextId) => {
        currentId = nextId;
        labelSpan.textContent = frequencyLabel(nextId);
        onPick(nextId);
      });
    });
    return trigger;
  }

  // ---- Modal shell ---------------------------------------------------------

  function close() {
    closeFreqMenu();
    if (modalEl) { modalEl.remove(); modalEl = null; }
    if (backdropEl) { backdropEl.remove(); backdropEl = null; }
    document.removeEventListener("keydown", onKeydown);
  }
  __cb.closeScopeSignalsModal = close;

  function onKeydown(evt) {
    if (evt.key === "Escape") { evt.preventDefault(); close(); }
  }

  function makeCloseButton() {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "cb-export-modal-close";
    btn.setAttribute("aria-label", "Close");
    btn.innerHTML =
      '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
    btn.addEventListener("click", close);
    return btn;
  }

  // ---- Entry point ---------------------------------------------------------

  __cb.startScopeSignals = function startScopeSignals() {
    close();

    backdropEl = document.createElement("div");
    backdropEl.className = "cb-export-modal-backdrop";
    backdropEl.addEventListener("mousedown", (evt) => {
      if (evt.target === backdropEl) close();
    });

    modalEl = document.createElement("div");
    modalEl.className = "cb-export-modal cb-gtme-modal cb-scope-signals-modal";
    modalEl.addEventListener("mousedown", (evt) => evt.stopPropagation());

    backdropEl.appendChild(modalEl);
    document.body.appendChild(backdropEl);
    document.addEventListener("keydown", onKeydown);

    renderBuilder();
  };

  function newSignal() {
    const def = SIGNAL_TYPES[0];
    return { typeId: def.id, name: def.label, count: "", frequencyId: DEFAULT_FREQUENCY_ID, nameEdited: false };
  }

  function renderBuilder() {
    closeFreqMenu();
    const signals = [newSignal()];

    modalEl.innerHTML = "";

    const header = document.createElement("div");
    header.className = "cb-export-modal-header";
    const titleWrap = document.createElement("div");
    titleWrap.className = "cb-export-modal-title-wrap";
    const title = document.createElement("h2");
    title.className = "cb-export-modal-title";
    title.textContent = "Scope signals";
    const subtitle = document.createElement("div");
    subtitle.className = "cb-export-modal-subtitle";
    subtitle.textContent = "Quote monitoring signals from scratch \u2014 no table import needed.";
    titleWrap.appendChild(title);
    titleWrap.appendChild(subtitle);
    header.appendChild(titleWrap);
    header.appendChild(makeCloseButton());

    const body = document.createElement("div");
    body.className = "cb-export-modal-body cb-gtme-body";

    const note = document.createElement("p");
    note.className = "cb-scope-signals-note";
    note.innerHTML =
      "Signals run on a schedule and bill recurring credits \u2014 per <strong>monitored record</strong> " +
      "for people signals (job changes, hires\u2026), or per <strong>result</strong> for News. " +
      "Enter your estimates below.";
    body.appendChild(note);

    const list = document.createElement("div");
    list.className = "cb-scope-signals-list";
    body.appendChild(list);

    const addRowBtn = document.createElement("button");
    addRowBtn.type = "button";
    addRowBtn.className = "cb-scope-signals-add";
    addRowBtn.innerHTML =
      '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg><span>Add signal</span>';
    addRowBtn.addEventListener("click", () => {
      signals.push(newSignal());
      renderList();
    });
    body.appendChild(addRowBtn);

    const footer = document.createElement("div");
    footer.className = "cb-modal-footer";
    const footerHint = document.createElement("div");
    footerHint.className = "cb-export-modal-footer-hint";
    const footerActions = document.createElement("div");
    footerActions.className = "cb-modal-footer-actions";
    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.className = "cb-modal-btn cb-modal-btn-ghost";
    cancelBtn.textContent = "Cancel";
    cancelBtn.addEventListener("click", close);
    const confirmBtn = document.createElement("button");
    confirmBtn.type = "button";
    confirmBtn.className = "cb-modal-btn cb-modal-btn-primary";
    footerActions.appendChild(cancelBtn);
    footerActions.appendChild(confirmBtn);
    footer.appendChild(footerHint);
    footer.appendChild(footerActions);

    function billableSignals() {
      return signals.filter((s) => Number(s.count) > 0);
    }

    function updateFooter() {
      const billable = billableSignals();
      confirmBtn.textContent = "Add to scope";
      if (billable.length === 0) {
        confirmBtn.disabled = true;
        footerHint.textContent = "Enter a volume to quote a signal.";
      } else {
        confirmBtn.disabled = false;
        const totalAnnual = billable.reduce((s, sig) => s + computeSignal(sig).annualCredits, 0);
        footerHint.textContent =
          `${billable.length} signal${billable.length > 1 ? "s" : ""} \u00b7 ${fmtNum(totalAnnual)} credits / yr`;
      }
    }

    confirmBtn.addEventListener("click", () => {
      const billable = billableSignals();
      if (billable.length === 0) return;
      createSignalsScope(billable);
      close();
    });

    function renderList() {
      list.innerHTML = "";
      signals.forEach((sig, idx) => {
        list.appendChild(buildSignalRow(sig, idx, signals, renderList, updateFooter));
      });
      updateFooter();
    }

    renderList();

    modalEl.appendChild(header);
    modalEl.appendChild(body);
    modalEl.appendChild(footer);
  }

  function buildSignalRow(sig, idx, signals, rerender, updateFooter) {
    const row = document.createElement("div");
    row.className = "cb-scope-signals-signal";

    // --- Line 1: signal type + name (+ remove) ---
    const top = document.createElement("div");
    top.className = "cb-scope-signals-top";

    const typeField = document.createElement("label");
    typeField.className = "cb-gtme-field cb-scope-signals-field-type";
    typeField.innerHTML = '<span class="cb-gtme-field-label">Signal</span>';
    const typeSelect = document.createElement("select");
    typeSelect.className = "cb-gtme-input cb-scope-signals-select";
    for (const def of SIGNAL_TYPES) {
      const opt = document.createElement("option");
      opt.value = def.id;
      opt.textContent = def.label;
      typeSelect.appendChild(opt);
    }
    typeSelect.value = sig.typeId;
    typeField.appendChild(typeSelect);
    top.appendChild(typeField);

    const nameField = document.createElement("label");
    nameField.className = "cb-gtme-field cb-scope-signals-field-name";
    nameField.innerHTML = '<span class="cb-gtme-field-label">Name</span>';
    const nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.className = "cb-gtme-input";
    nameInput.autocomplete = "off";
    nameInput.value = sig.name;
    nameInput.addEventListener("input", () => {
      sig.name = nameInput.value;
      sig.nameEdited = true;
    });
    nameField.appendChild(nameInput);
    top.appendChild(nameField);

    if (signals.length > 1) {
      const removeWrap = document.createElement("div");
      removeWrap.className = "cb-scope-signals-remove-wrap";
      const removeSpacer = document.createElement("span");
      removeSpacer.className = "cb-gtme-field-label cb-scope-signals-remove-spacer";
      removeSpacer.setAttribute("aria-hidden", "true");
      removeSpacer.innerHTML = "&nbsp;";
      const removeBtn = document.createElement("button");
      removeBtn.type = "button";
      removeBtn.className = "cb-scope-signals-remove";
      removeBtn.setAttribute("aria-label", "Remove signal");
      removeBtn.innerHTML =
        '<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>';
      removeBtn.addEventListener("click", () => {
        signals.splice(idx, 1);
        rerender();
      });
      removeWrap.appendChild(removeSpacer);
      removeWrap.appendChild(removeBtn);
      top.appendChild(removeWrap);
    }

    row.appendChild(top);

    // --- Line 2: volume + frequency ---
    const meta = document.createElement("div");
    meta.className = "cb-scope-signals-meta";

    const countField = document.createElement("label");
    countField.className = "cb-gtme-field cb-scope-signals-field-count";
    const countLabel = document.createElement("span");
    countLabel.className = "cb-gtme-field-label";
    countField.appendChild(countLabel);
    const countInput = document.createElement("input");
    countInput.type = "number";
    countInput.min = "0";
    countInput.step = "1";
    countInput.className = "cb-gtme-input cb-gtme-input-num";
    countInput.value = sig.count;
    countInput.addEventListener("input", () => {
      sig.count = countInput.value;
      refreshRow();
      updateFooter();
    });
    countField.appendChild(countInput);
    meta.appendChild(countField);

    const freqField = document.createElement("div");
    freqField.className = "cb-gtme-field cb-scope-signals-field-freq";
    const freqLabel = document.createElement("span");
    freqLabel.className = "cb-gtme-field-label";
    freqLabel.textContent = "Frequency";
    freqField.appendChild(freqLabel);
    const freqDropdown = buildFrequencyDropdown(sig.frequencyId, (nextId) => {
      sig.frequencyId = nextId;
      refreshRow();
      updateFooter();
    });
    freqField.appendChild(freqDropdown);
    meta.appendChild(freqField);

    row.appendChild(meta);

    // --- Line 3: live cost estimate ---
    const cost = document.createElement("div");
    cost.className = "cb-scope-signals-cost";
    row.appendChild(cost);

    // In-place refresh: count label + placeholder follow the charge unit, and
    // the cost line recomputes on any edit (avoids re-rendering the whole list).
    function refreshRow() {
      const def = signalDef(sig.typeId);
      const isResult = def.chargeUnit === "result";
      countLabel.textContent = isResult ? "Estimated results / run" : "Monitored records";
      countInput.placeholder = isResult ? "e.g. 50" : "e.g. 50000";

      const c = computeSignal(sig);
      if (c.count > 0) {
        const unit = isResult ? "result" : "record";
        cost.innerHTML =
          `${COIN_SVG}<span>${fmtNum(def.creditsPerUnit)} / ${unit} \u00b7 ` +
          `<strong>${fmtNum(c.perRunCredits)}</strong> credits + ${fmtNum(c.perRunActions)} actions / run \u00b7 ` +
          `<strong>${fmtNum(c.annualCredits)}</strong> credits / yr</span>`;
        cost.classList.remove("cb-scope-signals-cost-empty");
      } else {
        cost.innerHTML = `<span>${def.blurb}</span>`;
        cost.classList.add("cb-scope-signals-cost-empty");
      }
    }

    typeSelect.addEventListener("change", () => {
      sig.typeId = typeSelect.value;
      const def = signalDef(sig.typeId);
      if (!sig.nameEdited) {
        sig.name = def.label;
        nameInput.value = def.label;
      }
      refreshRow();
      updateFooter();
    });

    refreshRow();
    return row;
  }

  // ---- Create the Signals use case + per-signal DP/ER cards ----------------

  function createSignalsScope(signals) {
    const model = __cb.model;
    const canvas = __cb.canvas;
    if (!model?.createGroup || !canvas?.addCard || !canvas?.addDataPointCard) {
      console.warn("[Clay Scoping] Scope Signals: model/canvas API unavailable.");
      return;
    }

    // Signals don't scale by the use case Records denominator (the cost model
    // prices them per run / per result), but the group still needs a records
    // value for its header. Sum the volumes so per-ER coverage ratios stay <= 1.
    const totalCount = signals.reduce((s, sig) => s + (Number(sig.count) || 0), 0);
    const group = model.createGroup({
      parentId: null,
      source: "manual",
      label: "Signals",
      records: totalCount,
    });

    // Stack the new cards below existing canvas content (mirrors createAdsScope).
    const existing = model.getNodes ? model.getNodes() : [];
    let baseX = 0;
    let baseY = 0;
    if (existing.length > 0) {
      let maxBottom = -Infinity;
      let leftMostXAtMax = 0;
      for (const c of existing) {
        const bottom = c.y + 70;
        if (bottom > maxBottom) { maxBottom = bottom; leftMostXAtMax = c.x; }
      }
      baseX = leftMostXAtMax;
      baseY = maxBottom + 40;
    }

    signals.forEach((sig, i) => {
      const def = signalDef(sig.typeId);
      const count = Number(sig.count) || 0;
      const isResult = def.chargeUnit === "result";
      const unitLabel = isResult ? "result" : "record";
      const y = baseY + i * 120;
      const name = sig.name || def.label;

      const dp = canvas.addDataPointCard(name, { x: baseX, y });
      dp.groupId = group.id;

      const er = canvas.addCard(
        {
          displayName: name,
          packageName: "Clay",
          iconSvgHtml: SIGNAL_ICON_SVG,
          isSource: true,
          isSignal: true,
          isAi: false,
          signalType: def.signalType,
          signalChargeUnit: def.chargeUnit,
          credits: def.creditsPerUnit,
          actionExecutions: def.actionsPerUnit,
          creditText: `~${fmtNum(def.creditsPerUnit)} / ${unitLabel}`,
          // Volume multiplier for the cost model (cost-model.js signalRunVolume):
          // per-record uses monitoredRecordCount, per-result uses signalResultCount.
          monitoredRecordCount: isResult ? null : count,
          signalResultCount: isResult ? count : null,
          // Coverage: signal cost ignores this, but set custom so a refresh pass
          // (syncUseCaseCoverage) doesn't reset it and the column reads 100%.
          coverageRows: count,
          coverageCustom: true,
          coverageTotal: count,
          coverageTotalCustom: true,
          // Cadence is intrinsic to the signal — custom so the use-case frequency
          // doesn't override it (mirrors table-import.js applySignalCardData).
          frequency: sig.frequencyId,
          frequencyCustom: true,
        },
        { x: baseX + 230, y },
      );
      er.groupId = group.id;

      // Lineage link (table view matches DP -> ER by lineage key, not geometry).
      const key = canvas.ensureErLineageKey(er);
      if (key != null && __cb.setDpErKeys) {
        __cb.setDpErKeys(dp, [...__cb.dpErKeys(dp), key]);
      }

      // Distinct cluster per DP+ER pair so a per-signal frequency edit (which
      // applies to the whole cluster) never bleeds into other signals.
      const clusterId = `scope-signals-${group.id}-${i}`;
      dp.clusterId = clusterId;
      er.clusterId = clusterId;
    });

    model.update();
    if (canvas.refreshClusters) canvas.refreshClusters({ dragCardIds: new Set() });
    if (canvas.refreshCreditTotal) canvas.refreshCreditTotal();
    if (__cb.saveTabs) __cb.saveTabs();
    if (__cb.tableView?.refresh) __cb.tableView.refresh();
  }
})();
