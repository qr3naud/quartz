/**
 * "Scope Ads" flow (wired from the table-view "Scope" dropdown in
 * src/table-view.js — openScopeMenu; the dropdown is open to everyone).
 *
 * A two-step modal that scopes an Ads usage-based sync:
 *   Step 1 — disclaimer: Ads pricing is now usage-based (Before/After table).
 *   Step 2 — audience builder: one or more audiences, each with a name, a record
 *            count, a refresh frequency, and an enhanced-matching tier
 *            (Premium / Standard / None).
 *
 * On confirm it creates a normal L1 "Ads" use case and, for every non-None
 * audience, a DP row ("Audience N") linked to one custom matching ER pill:
 *   - "Standard matching" = 1 credit / 1 action per row
 *   - "Premium matching"  = 2 credits / 1 action per row
 * Each audience's record count lives on its ER as `coverageRows` (the use-case
 * records term cancels in the cost math: perRow x freqMult x coverageRows), and
 * each ER carries its own frequency. This means ZERO changes to the header /
 * cost-model / persistence / export logic — these are ordinary ER cards.
 *
 * Creation invariants (see cost-model.js syncUseCaseCoverage / cards.js
 * applyClusterFrequency):
 *   - coverageCustom + coverageTotalCustom MUST be set or a refresh pass resets
 *     each audience's coverageRows back to the use case's records.
 *   - frequencyCustom MUST be set or the use case frequency overrides per-ER.
 *   - each DP+ER pair gets its own clusterId so frequency edits stay isolated.
 *
 * Reuses the cb-export-modal / cb-gtme-* shell from styles/export.css; the
 * Scope-Ads-specific pieces live in styles/scope-ads.css (cb-scope-ads-*).
 */
(function () {
  "use strict";

  const __cb = (window.__cb = window.__cb || {});

  let modalEl = null;
  let backdropEl = null;

  const MATCH_DESC =
    "Improve match rates by finding identifiers your contacts used when signing up for LinkedIn.";

  // Matching tiers. credits = per-row Clay credits; actions is always 1/row.
  const TIERS = {
    premium: { id: "premium", label: "Premium", credits: 2,
      blurb: "Highest quality provider + Standard matches", match: "\u2264 95%" },
    standard: { id: "standard", label: "Standard", credits: 1,
      blurb: "Looks across 2 providers to find most likely identifiers", match: "\u2264 80%" },
    none: { id: "none", label: "None", credits: 0,
      blurb: "Continue without improving match rates", match: "< 60%" },
  };

  // Phosphor "Coins" glyph (matches Clay's credit badge); tinted via currentColor.
  const COIN_SVG =
    '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 256 256" fill="currentColor" aria-hidden="true"><path opacity="0.2" d="M240,132c0,19.88-35.82,36-80,36-19.6,0-37.56-3.17-51.47-8.44h0C146.76,156.85,176,142,176,124V96.72h0C212.52,100.06,240,114.58,240,132ZM176,84c0-19.88-35.82-36-80-36S16,64.12,16,84s35.82,36,80,36S176,103.88,176,84Z"/><path d="M184,89.57V84c0-25.08-37.83-44-88-44S8,58.92,8,84v40c0,20.89,26.25,37.49,64,42.46V172c0,25.08,37.83,44,88,44s88-18.92,88-44V132C248,111.3,222.58,94.68,184,89.57ZM232,132c0,13.22-30.79,28-72,28-3.73,0-7.43-.13-11.08-.37C170.49,151.77,184,139,184,124V105.74C213.87,110.19,232,122.27,232,132ZM72,150.25V126.46A183.74,183.74,0,0,0,96,128a183.74,183.74,0,0,0,24-1.54v23.79A163,163,0,0,1,96,152,163,163,0,0,1,72,150.25Zm96-40.32V124c0,8.39-12.41,17.4-32,22.87V123.5C148.91,120.37,159.84,115.71,168,109.93ZM96,56c41.21,0,72,14.78,72,28s-30.79,28-72,28S24,97.22,24,84,54.79,56,96,56ZM24,124V109.93c8.16,5.78,19.09,10.44,32,13.57v23.37C36.41,141.4,24,132.39,24,124Zm64,48v-4.17c2.63.1,5.29.17,8,.17,3.88,0,7.67-.13,11.39-.35A121.92,121.92,0,0,0,120,171.41v23.46C100.41,189.4,88,180.39,88,172Zm48,26.25V174.4a179.48,179.48,0,0,0,24,1.6,183.74,183.74,0,0,0,24-1.54v23.79a165.45,165.45,0,0,1-48,0Zm64-3.38V171.5c12.91-3.13,23.84-7.79,32-13.57V172C232,180.39,219.59,189.4,200,194.87Z"/></svg>';

  // Official LinkedIn glyph (matches Clay's match-rate line).
  const LINKEDIN_SVG =
    '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 72 72" aria-hidden="true"><g fill="none" fill-rule="evenodd"><path d="M8,72 L64,72 C68.418278,72 72,68.418278 72,64 L72,8 C72,3.581722 68.418278,0 64,0 L8,0 C3.581722,0 0,3.581722 0,8 L0,64 C0,68.418278 3.581722,72 8,72 Z" fill="#007EBB"/><path d="M62,62 L51.32,62 L51.32,43.8 C51.32,38.81 49.42,36.02 45.47,36.02 C41.17,36.02 38.93,38.93 38.93,43.8 L38.93,62 L28.63,62 L28.63,27.33 L38.93,27.33 L38.93,32 C38.93,32 42.03,26.27 49.38,26.27 C56.74,26.27 62,30.76 62,40.05 L62,62 Z M16.35,22.79 C12.84,22.79 10,19.93 10,16.4 C10,12.86 12.84,10 16.35,10 C19.86,10 22.7,12.86 22.7,16.4 C22.7,19.93 19.86,22.79 16.35,22.79 Z M11.03,62 L21.77,62 L21.77,27.33 L11.03,27.33 L11.03,62 Z" fill="#FFF"/></g></svg>';

  // Phosphor "Broadcast" glyph from Clay's Ads sidebar nav (app.clay.com/.../ads).
  const ADS_ICON_SVG =
    '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" viewBox="0 0 256 256" aria-hidden="true">' +
    '<path d="M168,128a40,40,0,1,1-40-40A40,40,0,0,1,168,128Zm40,0a79.74,79.74,0,0,0-20.37-53.33,8,8,0,1,0-11.92,10.67,64,64,0,0,1,0,85.33,8,8,0,0,0,11.92,10.67A79.79,79.79,0,0,0,208,128ZM80.29,85.34A8,8,0,1,0,68.37,74.67a79.94,79.94,0,0,0,0,106.67,8,8,0,0,0,11.92-10.67,63.95,63.95,0,0,1,0-85.33Zm158.28-4A119.48,119.48,0,0,0,213.71,44a8,8,0,1,0-11.42,11.2,103.9,103.9,0,0,1,0,145.56A8,8,0,1,0,213.71,212,120.12,120.12,0,0,0,238.57,81.29ZM32.17,168.48A103.9,103.9,0,0,1,53.71,55.22,8,8,0,1,0,42.29,44a119.87,119.87,0,0,0,0,168,8,8,0,1,0,11.42-11.2A103.61,103.61,0,0,1,32.17,168.48Z"/></svg>';
  __cb.ADS_ICON_SVG = ADS_ICON_SVG;

  const PLAYBOOK_URL =
    "https://app.notion.com/p/clayrun/Clay-Ads-Product-Playbook-3097e66eb014801eb5c8e1995913784a?pvs=32";

  const CHEVRON_DOWN_SVG =
    '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>';

  // Custom frequency dropdown (body-appended menu). One menu at a time.
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

  function frequencyLabel(id) {
    const opt = (__cb.FREQUENCY_OPTIONS || []).find((o) => o.id === id);
    return opt ? opt.label : id;
  }

  function openFreqMenu(anchor, currentId, onPick) {
    closeFreqMenu();
    const menu = document.createElement("div");
    menu.className = "cb-scope-ads-freq-menu";
    menu.setAttribute("role", "listbox");
    menu.addEventListener("mousedown", (evt) => evt.stopPropagation());
    const opts = __cb.FREQUENCY_OPTIONS || [
      { id: "annually", label: "Annually" }, { id: "monthly", label: "Monthly" },
    ];
    for (const o of opts) {
      const opt = document.createElement("button");
      opt.type = "button";
      opt.className =
        "cb-scope-ads-freq-menu-opt" +
        (o.id === currentId ? " cb-scope-ads-freq-menu-opt-active" : "");
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
    trigger.className = "cb-scope-ads-freq-trigger";
    trigger.setAttribute("aria-haspopup", "listbox");
    const labelSpan = document.createElement("span");
    labelSpan.className = "cb-scope-ads-freq-label";
    labelSpan.textContent = frequencyLabel(currentId);
    const chev = document.createElement("span");
    chev.className = "cb-scope-ads-freq-chevron";
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

  function close() {
    closeFreqMenu();
    if (modalEl) { modalEl.remove(); modalEl = null; }
    if (backdropEl) { backdropEl.remove(); backdropEl = null; }
    document.removeEventListener("keydown", onKeydown);
  }
  __cb.closeScopeAdsModal = close;

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

  function fmtNum(n) {
    const v = Number(n) || 0;
    return v.toLocaleString();
  }

  // ---- Entry point -------------------------------------------------------

  __cb.startScopeAds = function startScopeAds() {
    close();

    backdropEl = document.createElement("div");
    backdropEl.className = "cb-export-modal-backdrop";
    backdropEl.addEventListener("mousedown", (evt) => {
      if (evt.target === backdropEl) close();
    });

    modalEl = document.createElement("div");
    modalEl.className = "cb-export-modal cb-gtme-modal cb-scope-ads-modal";
    modalEl.addEventListener("mousedown", (evt) => evt.stopPropagation());

    backdropEl.appendChild(modalEl);
    document.body.appendChild(backdropEl);
    document.addEventListener("keydown", onKeydown);

    renderDisclaimerStep();
  };

  // ---- Step 1: disclaimer ------------------------------------------------

  /** Label column = widest row header (Monetization); Before/After split the rest. */
  function sizeCompareLabelColumn(table) {
    const labelCol = table.querySelector(".cb-scope-ads-compare-col-label");
    const rowHeaders = table.querySelectorAll("tbody th[scope='row']");
    if (!labelCol || !rowHeaders.length) return;

    const prevLayout = table.style.tableLayout;
    table.style.tableLayout = "auto";
    let maxW = 0;
    rowHeaders.forEach((th) => {
      maxW = Math.max(maxW, th.offsetWidth);
    });
    table.style.tableLayout = prevLayout;

    if (maxW > 0) labelCol.style.width = `${maxW}px`;
  }

  function renderDisclaimerStep() {
    closeFreqMenu();
    modalEl.innerHTML = "";

    const header = document.createElement("div");
    header.className = "cb-export-modal-header";
    const titleWrap = document.createElement("div");
    titleWrap.className = "cb-export-modal-title-wrap";
    const title = document.createElement("h2");
    title.className = "cb-export-modal-title";
    title.textContent = "Disclaimer: Ads pricing is now usage-based";
    const subtitle = document.createElement("div");
    subtitle.className = "cb-export-modal-subtitle";
    subtitle.textContent = "How Ad syncs and audiences are billed under the new model.";
    titleWrap.appendChild(title);
    titleWrap.appendChild(subtitle);
    header.appendChild(titleWrap);
    header.appendChild(makeCloseButton());

    const body = document.createElement("div");
    body.className = "cb-export-modal-body cb-gtme-body cb-scope-ads-disclaimer-step";

    const tldr = document.createElement("div");
    tldr.className = "cb-scope-ads-tldr";
    const tldrLead = document.createElement("p");
    tldrLead.className = "cb-scope-ads-tldr-lead";
    tldrLead.innerHTML =
      "<strong>TL;DR:</strong> Clay Ads lets you build always-on audiences straight from your CRM, " +
      "and sync them to LinkedIn + Meta + Google, so your targeting stays up to date and you stop " +
      "managing manual CSV uploads.";
    const tldrRoi = document.createElement("p");
    tldrRoi.className = "cb-scope-ads-tldr-roi";
    tldrRoi.innerHTML =
      "<strong>Higher Match Rates = lower cost per qualified lead (CPQL) = more ROI per ad dollar</strong>";
    tldr.appendChild(tldrLead);
    tldr.appendChild(tldrRoi);
    body.appendChild(tldr);

    const recent = document.createElement("details");
    recent.className = "cb-scope-ads-recent";
    const recentSummary = document.createElement("summary");
    recentSummary.className = "cb-scope-ads-recent-summary";
    recentSummary.textContent = "What's changed recently?";
    recent.appendChild(recentSummary);

    const recentBody = document.createElement("div");
    recentBody.className = "cb-scope-ads-recent-body";

    const rows = [
      ["Ad Syncs", "Per-Sync add-on fee for Enterprise customers",
        "<strong>Unlimited</strong> for all Enterprise customers"],
      ["Audiences", "Only 2 included in plan <em>(additional added per tier for a variable fee)</em>",
        "<strong>Unlimited</strong> for all Enterprise customers"],
      ["Monetization", "Via Ads add-on fee",
        "Via Credits / Action for hashed emails"],
    ];
    const table = document.createElement("table");
    table.className = "cb-scope-ads-compare";
    table.innerHTML =
      '<colgroup><col class="cb-scope-ads-compare-col-label"><col><col></colgroup>' +
      '<thead><tr><th scope="col" class="cb-scope-ads-compare-corner"></th>' +
      '<th scope="col">Before</th><th scope="col">After</th></tr></thead><tbody>' +
      rows.map((r) =>
        `<tr><th scope="row">${r[0]}</th><td>${r[1]}</td><td>${r[2]}</td></tr>`,
      ).join("") +
      "</tbody>";
    recentBody.appendChild(table);
    recent.appendChild(recentBody);
    recent.addEventListener("toggle", () => {
      if (recent.open) requestAnimationFrame(() => sizeCompareLabelColumn(table));
    });
    body.appendChild(recent);

    const footer = document.createElement("div");
    footer.className = "cb-modal-footer";
    const footerActions = document.createElement("div");
    footerActions.className = "cb-modal-footer-actions";
    const playbookBtn = document.createElement("a");
    playbookBtn.className = "cb-modal-btn cb-modal-btn-ghost";
    playbookBtn.href = PLAYBOOK_URL;
    playbookBtn.target = "_blank";
    playbookBtn.rel = "noopener noreferrer";
    playbookBtn.textContent = "Product playbook";
    const continueBtn = document.createElement("button");
    continueBtn.type = "button";
    continueBtn.className = "cb-modal-btn cb-modal-btn-primary";
    continueBtn.textContent = "Continue";
    continueBtn.addEventListener("click", renderAudienceStep);
    footerActions.appendChild(playbookBtn);
    footerActions.appendChild(continueBtn);
    footer.appendChild(footerActions);

    modalEl.appendChild(header);
    modalEl.appendChild(body);
    modalEl.appendChild(footer);
  }

  // ---- Step 2: audience builder ------------------------------------------

  // Working state: a list of audiences. Each row is rebuilt from this model so
  // add/remove and tier selection stay in sync without per-node bookkeeping.
  function renderAudienceStep() {
    closeFreqMenu();
    const audiences = [newAudience(1)];

    function newAudience(n) {
      return { name: `Audience ${n}`, records: "", frequencyId: "monthly", tier: "premium" };
    }

    modalEl.innerHTML = "";

    const header = document.createElement("div");
    header.className = "cb-export-modal-header";
    const titleWrap = document.createElement("div");
    titleWrap.className = "cb-export-modal-title-wrap";
    const title = document.createElement("h2");
    title.className = "cb-export-modal-title";
    title.textContent = "Scope your Ad audiences";
    const subtitle = document.createElement("div");
    subtitle.className = "cb-export-modal-subtitle";
    subtitle.textContent = "Add one row per audience you want to sync.";
    titleWrap.appendChild(title);
    titleWrap.appendChild(subtitle);
    header.appendChild(titleWrap);
    header.appendChild(makeCloseButton());

    const body = document.createElement("div");
    body.className = "cb-export-modal-body cb-gtme-body";

    const list = document.createElement("div");
    list.className = "cb-scope-ads-audiences";
    body.appendChild(list);

    const addRowBtn = document.createElement("button");
    addRowBtn.type = "button";
    addRowBtn.className = "cb-scope-ads-add-audience";
    addRowBtn.innerHTML =
      '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg><span>Add audience</span>';
    addRowBtn.addEventListener("click", () => {
      audiences.push(newAudience(audiences.length + 1));
      renderList();
    });
    body.appendChild(addRowBtn);

    const footer = document.createElement("div");
    footer.className = "cb-modal-footer";
    const footerHint = document.createElement("div");
    footerHint.className = "cb-export-modal-footer-hint";
    const footerActions = document.createElement("div");
    footerActions.className = "cb-modal-footer-actions";
    const backBtn = document.createElement("button");
    backBtn.type = "button";
    backBtn.className = "cb-modal-btn cb-modal-btn-ghost";
    backBtn.textContent = "Back";
    backBtn.addEventListener("click", renderDisclaimerStep);
    const confirmBtn = document.createElement("button");
    confirmBtn.type = "button";
    confirmBtn.className = "cb-modal-btn cb-modal-btn-primary";
    footerActions.appendChild(backBtn);
    footerActions.appendChild(confirmBtn);
    footer.appendChild(footerHint);
    footer.appendChild(footerActions);

    function billableAudiences() {
      return audiences.filter((a) => a.tier !== "none" && Number(a.records) > 0);
    }

    function updateFooter() {
      const billable = billableAudiences();
      if (billable.length === 0) {
        confirmBtn.textContent = "Done";
        const noneCount = audiences.filter((a) => a.tier === "none").length;
        footerHint.textContent = noneCount === audiences.length
          ? "None tier is free \u2014 nothing to scope."
          : "Enter an audience size to scope it.";
      } else {
        confirmBtn.textContent = "Add to scope";
        const totalRecords = billable.reduce((s, a) => s + Number(a.records), 0);
        footerHint.textContent =
          `${billable.length} audience${billable.length > 1 ? "s" : ""} \u00b7 ${fmtNum(totalRecords)} records`;
      }
    }

    confirmBtn.addEventListener("click", () => {
      const billable = billableAudiences();
      if (billable.length === 0) { close(); return; }
      createAdsScope(billable);
      close();
    });

    function renderList() {
      list.innerHTML = "";
      audiences.forEach((aud, idx) => {
        list.appendChild(buildAudienceRow(aud, idx, audiences, renderList, updateFooter));
      });
      updateFooter();
    }

    renderList();

    modalEl.appendChild(header);
    modalEl.appendChild(body);
    modalEl.appendChild(footer);
  }

  function buildAudienceRow(aud, idx, audiences, rerender, updateFooter) {
    const row = document.createElement("div");
    row.className = "cb-scope-ads-audience";

    // --- Top line: name + records + frequency + remove ---
    const top = document.createElement("div");
    top.className = "cb-scope-ads-audience-top";

    const nameField = document.createElement("label");
    nameField.className = "cb-gtme-field cb-scope-ads-field-name";
    nameField.innerHTML = '<span class="cb-gtme-field-label">Audience name</span>';
    const nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.className = "cb-gtme-input";
    nameInput.autocomplete = "off";
    nameInput.value = aud.name;
    nameInput.addEventListener("input", () => { aud.name = nameInput.value; });
    nameField.appendChild(nameInput);
    top.appendChild(nameField);

    const recField = document.createElement("label");
    recField.className = "cb-gtme-field cb-scope-ads-field-size";
    recField.innerHTML = '<span class="cb-gtme-field-label">Size</span>';
    const recInput = document.createElement("input");
    recInput.type = "number";
    recInput.min = "0";
    recInput.step = "1";
    recInput.className = "cb-gtme-input cb-gtme-input-num";
    recInput.placeholder = "e.g. 50000";
    recInput.value = aud.records;
    recInput.addEventListener("input", () => {
      aud.records = recInput.value;
      updateFooter();
    });
    recField.appendChild(recInput);
    top.appendChild(recField);

    const freqField = document.createElement("div");
    freqField.className = "cb-gtme-field cb-scope-ads-field-freq";
    const freqLabel = document.createElement("span");
    freqLabel.className = "cb-gtme-field-label";
    freqLabel.textContent = "Frequency";
    freqField.appendChild(freqLabel);
    const freqDropdown = buildFrequencyDropdown(aud.frequencyId, (nextId) => {
      aud.frequencyId = nextId;
    });
    freqField.appendChild(freqDropdown);
    top.appendChild(freqField);

    if (audiences.length > 1) {
      const removeWrap = document.createElement("div");
      removeWrap.className = "cb-scope-ads-audience-remove-wrap";
      const removeSpacer = document.createElement("span");
      removeSpacer.className = "cb-gtme-field-label cb-scope-ads-remove-spacer";
      removeSpacer.setAttribute("aria-hidden", "true");
      removeSpacer.innerHTML = "&nbsp;";
      const removeBtn = document.createElement("button");
      removeBtn.type = "button";
      removeBtn.className = "cb-scope-ads-audience-remove";
      removeBtn.setAttribute("aria-label", "Remove audience");
      removeBtn.innerHTML =
        '<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>';
      removeBtn.addEventListener("click", () => {
        audiences.splice(idx, 1);
        rerender();
      });
      removeWrap.appendChild(removeSpacer);
      removeWrap.appendChild(removeBtn);
      top.appendChild(removeWrap);
    }

    row.appendChild(top);

    // --- Matching tier picker ---
    const matchWrap = document.createElement("div");
    matchWrap.className = "cb-scope-ads-match";
    const matchLabel = document.createElement("div");
    matchLabel.className = "cb-scope-ads-match-label";
    matchLabel.textContent = "Do you need enhanced matching?";
    const matchDesc = document.createElement("div");
    matchDesc.className = "cb-scope-ads-match-desc";
    matchDesc.textContent = MATCH_DESC;
    matchWrap.appendChild(matchLabel);
    matchWrap.appendChild(matchDesc);

    const cards = document.createElement("div");
    cards.className = "cb-scope-ads-tiers";
    ["premium", "standard", "none"].forEach((tierId) => {
      cards.appendChild(buildTierCard(tierId, aud, cards));
    });
    matchWrap.appendChild(cards);
    row.appendChild(matchWrap);

    return row;
  }

  function buildTierCard(tierId, aud, cardsContainer) {
    const tier = TIERS[tierId];
    const card = document.createElement("button");
    card.type = "button";
    card.className = "cb-scope-ads-tier" + (aud.tier === tierId ? " cb-scope-ads-tier-active" : "");
    card.dataset.tier = tierId;

    const radio = document.createElement("span");
    radio.className = "cb-scope-ads-tier-radio";

    const main = document.createElement("span");
    main.className = "cb-scope-ads-tier-main";
    const name = document.createElement("span");
    name.className = "cb-scope-ads-tier-name";
    name.textContent = tier.label;
    const blurb = document.createElement("span");
    blurb.className = "cb-scope-ads-tier-blurb";
    blurb.textContent = tier.blurb;
    const matchLine = document.createElement("span");
    matchLine.className = "cb-scope-ads-tier-match";
    matchLine.innerHTML =
      `<span class="cb-scope-ads-tier-match-key">Match rate:</span>${LINKEDIN_SVG}<strong>${tier.match}</strong>`;
    main.appendChild(name);
    main.appendChild(blurb);
    main.appendChild(matchLine);

    card.appendChild(radio);
    card.appendChild(main);

    if (tier.credits > 0) {
      const badge = document.createElement("span");
      badge.className = "cb-scope-ads-tier-cost";
      badge.innerHTML = `${COIN_SVG}<span>${tier.credits} / row</span>`;
      card.appendChild(badge);
    }

    card.addEventListener("click", () => {
      aud.tier = tierId;
      for (const el of cardsContainer.querySelectorAll(".cb-scope-ads-tier")) {
        el.classList.toggle("cb-scope-ads-tier-active", el.dataset.tier === tierId);
      }
    });

    return card;
  }

  // ---- Create the Ads use case + per-audience DP/ER cards ----------------

  function createAdsScope(audiences) {
    const model = __cb.model;
    const canvas = __cb.canvas;
    if (!model?.createGroup || !canvas?.addCard || !canvas?.addDataPointCard) {
      console.warn("[Clay Scoping] Scope Ads: model/canvas API unavailable.");
      return;
    }

    const totalRecords = audiences.reduce((s, a) => s + Number(a.records), 0);
    const group = model.createGroup({
      parentId: null,
      source: "manual",
      label: "Ads",
      records: totalRecords, // sum keeps every per-ER coverage ratio <= 1
    });

    // Stack the new cards below existing canvas content so the canvas layout
    // isn't disturbed (mirrors startAddDataPoint's placement heuristic).
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

    audiences.forEach((aud, i) => {
      const tier = TIERS[aud.tier];
      const records = Number(aud.records) || 0;
      const y = baseY + i * 120;

      const dp = canvas.addDataPointCard(aud.name || `Audience ${i + 1}`, { x: baseX, y });
      dp.groupId = group.id;

      const er = canvas.addCard(
        {
          displayName: `${tier.label} matching`,
          packageName: "Clay",
          iconSvgHtml: ADS_ICON_SVG,
          credits: tier.credits,
          actionExecutions: 1,
          creditText: `${tier.credits} / row`,
          // Per-audience volume — must be custom so syncUseCaseCoverage doesn't
          // reset it to the use case's records on the next refresh.
          coverageRows: records,
          coverageCustom: true,
          coverageTotal: records,
          coverageTotalCustom: true,
          // Per-audience cadence — custom so the use-case frequency doesn't win.
          frequency: aud.frequencyId,
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

      // Distinct cluster per DP+ER pair so a per-audience frequency edit (which
      // applies to the whole cluster) never bleeds into other audiences.
      const clusterId = `scope-ads-${group.id}-${i}`;
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
