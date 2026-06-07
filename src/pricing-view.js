/**
 * Multi-year pricing view (extracted from table-view.js).
 *
 * Owns the pricing-mode body: the Summary group (one read-only card per option),
 * the editable Options group (per-year volumes, Average row + band matrix, List /
 * Authorized / Discount / Approval rows), the per-use-case year editors, and the
 * vol-dropdown / option-context / band-matrix popovers.
 *
 * The table view drives it through a tiny public surface:
 *   - __cb.pricingView.buildPricingBody()  -> the pricing body element
 *   - __cb.pricingView.closeMenus()        -> tear down every transient popover
 *
 * It depends on table-view.js for a few shared bits, published on __cb at load:
 *   - __cb._tvRender      the table view's raw render() (re-renders the body)
 *   - __cb._tvHelpers     shared SVG glyph builders (also used by the spreadsheet)
 *   - __cb.buildCostBadges the action/credit cost badge builder
 * This file is listed BEFORE table-view.js in the manifest; those hooks are only
 * read at runtime (render time), by which point table-view.js has loaded.
 */
(function () {
  "use strict";

  const __cb = (window.__cb = window.__cb || {});

  // ---- Shims to table-view.js -----------------------------------------------
  // Pricing handlers re-render via the table view's RAW render() (not its public
  // refresh(), which skips while an input is focused) so the Escape-to-cancel
  // rename path still rebuilds while the rename input holds focus.
  function render() {
    if (__cb._tvRender) __cb._tvRender();
  }
  // Shared glyph builders live in table-view.js (the spreadsheet uses them too)
  // and are published on __cb._tvHelpers; these shims keep the moved code intact.
  function chevronDownSvg(size) {
    return __cb._tvHelpers ? __cb._tvHelpers.chevronDownSvg(size) : "";
  }
  function coinsSvg(size) {
    return __cb._tvHelpers ? __cb._tvHelpers.coinsSvg(size) : "";
  }
  function folderSvg(size) {
    return __cb._tvHelpers ? __cb._tvHelpers.folderSvg(size) : "";
  }
  function starFourSvg(size) {
    return __cb._tvHelpers ? __cb._tvHelpers.starFourSvg(size) : "";
  }
  function tableSvg(size) {
    return __cb._tvHelpers ? __cb._tvHelpers.tableSvg(size) : "";
  }

  function pricingFmt(n) {
    return Math.max(0, Math.round(Number(n) || 0)).toLocaleString();
  }
  function pricingDollar(n) {
    return "$" + Math.round(Number(n) || 0).toLocaleString();
  }

  // Action volume is tier-quantized (calculator parity): a derived action
  // volume bills at the smallest action tier whose volume covers it — exceed a
  // tier and you bump up to the next. Pricing-mode only. Returns the clamped
  // volume + tier label; falls back to the raw volume if bands are unavailable.
  function clampActionVolume(actions) {
    const a = Math.max(0, Number(actions) || 0);
    const set = __cb.pricing?.enterpriseActionFloors?.();
    const bands = set && Array.isArray(set.bands) ? set.bands : null;
    if (!bands || !bands.length || a <= 0) return { volume: a, tier: null };
    const sorted = bands.slice().sort((x, y) => x.volume - y.volume);
    for (const b of sorted) {
      if (a <= b.volume) return { volume: b.volume, tier: b.tier };
    }
    const top = sorted[sorted.length - 1];
    return { volume: top.volume, tier: top.tier };
  }

  // Action tier helpers for the editable Total group.
  function actionVolumeForTier(tierId) {
    if (tierId == null) return 0;
    const set = __cb.pricing?.enterpriseActionFloors?.();
    const bands = set && Array.isArray(set.bands) ? set.bands : null;
    const b = bands && bands.find((x) => String(x.tier) === String(tierId));
    return b ? b.volume : 0;
  }
  function actionTierOptions() {
    const set = __cb.pricing?.enterpriseActionFloors?.();
    const bands = set && Array.isArray(set.bands) ? set.bands : [];
    return bands.slice().sort((a, b) => a.volume - b.volume);
  }

  // The pricing body: a total box at the TOP, then one collapsible box per use
  // case (reusing the green super-group header look), each with N per-year
  // columns (N = contractYears). Each year column: Records driver + Actions
  // (tier-quantized, read-only) + Credits (editable), each metric stacking its
  // volume over its dollar cost. Mode-aware: volumes follow Projected/Actual.
  function buildPricingBody() {
    closeAvgHover();
    hidePricingTip();
    const wrap = document.createElement("div");
    wrap.className = "cb-pricing-body";

    // Contract term is per option now: each option has its own `years`, and the
    // body renders enough year columns for the longest option (maxYears).
    const LIST_CPC = __cb.pricing?.LIST_CPC ?? 0.05;
    const LIST_CPA = __cb.pricing?.LIST_CPA ?? 0.008;
    const options = __cb.getPricingOptions
      ? __cb.getPricingOptions()
      : [{ id: "a", name: "Option A", years: 1, minimized: false, override: { credits: {}, actionTier: {} } }];
    const optYearsOf = (o) => Math.min(3, Math.max(1, (o && o.years) || 1));
    const maxYears = Math.min(3, Math.max(1, ...options.map(optYearsOf)));
    // Reverse so the order matches the normal table view (cards iterate newest
    // first; the table renders use cases in the opposite order).
    const ucs = (__cb.cost?.computePricingUseCases?.({ viewMode: __cb.viewMode }) || [])
      .slice()
      .reverse();
    const yrMap = __cb.pricingYearRecords || {};
    const creditCost = __cb.getCreditCost ? __cb.getCreditCost() : 0.05;
    const actionCost = __cb.getActionCost ? __cb.getActionCost() : 0.008;

    if (ucs.length === 0) {
      const empty = document.createElement("div");
      empty.className = "cb-pricing-body-empty";
      empty.textContent =
        "Scope some enrichments first, then set per-year records to price the deal.";
      wrap.appendChild(empty);
      return wrap;
    }

    const collapsed = (__cb._pricingCollapsed = __cb._pricingCollapsed || new Set());

    // First pass: resolve per-UC per-year records + RAW per-year volumes, and
    // the per-year recommended rollup (sum of credits; sum of raw actions).
    // Actions are tier-quantized at the DEAL level (the Total group), not per UC.
    const rec = Array.from({ length: maxYears }, () => ({ credits: 0, actionsRaw: 0 }));
    const ucData = [];
    for (const uc of ucs) {
      const arr = yrMap[uc.key] || [];
      const yearRecs = [];
      let ucCredits = 0;
      let ucActions = 0;
      for (let i = 0; i < maxYears; i++) {
        const recs = arr[i] != null ? Number(arr[i]) : uc.baselineRecords;
        yearRecs.push(recs);
        const c = uc.perRowCredits * recs;
        const a = uc.perRowActions * recs;
        ucCredits += c;
        ucActions += a;
        rec[i].credits += c;
        rec[i].actionsRaw += a;
      }
      ucData.push({ uc, yearRecs, ucCredits, ucActions });
    }

    // Shared recommended rollup per year (credits sum; action tier from the raw
    // action sum). Each option applies its own overrides over this.
    const recommended = rec.map((r) => ({
      recCredits: Math.round(r.credits),
      recTier: clampActionVolume(r.actionsRaw).tier,
    }));

    // Each option is an independent override over `recommended` + a rep-entered
    // discount price (CPC/CPA, default list), sliced to its own contract term.
    const optionsData = options.map((opt) => {
      const optYears = optYearsOf(opt);
      return {
        opt,
        years: optYears,
        perYear: effectivePerYear(recommended, opt.override, optYears),
        cpc: opt.override && opt.override.cpc != null ? Number(opt.override.cpc) : LIST_CPC,
        cpa: opt.override && opt.override.cpa != null ? Number(opt.override.cpa) : LIST_CPA,
      };
    });

    // ---- Summary group FIRST (top): one read-only summary card per option -
    wrap.appendChild(buildPricingSummaryGroup(optionsData));

    // ---- Editable "Options" group (deal-level source of truth) -----------
    wrap.appendChild(buildPricingOptionsGroup(optionsData));

    // Keep any pinned band matrices live: their floors + authority pill follow
    // the current discount / volumes / term, so the approval level updates too.
    syncPinnedAvgMatrices(optionsData);

    for (const { uc, yearRecs, ucCredits, ucActions } of ucData) {
      const box = document.createElement("div");
      box.className = "cb-pricing-uc";
      const isCollapsed = collapsed.has(uc.key);
      if (isCollapsed) box.classList.add("cb-pricing-uc-collapsed");

      // ---- Collapsible green header (mirrors the super-group header) --------
      const header = document.createElement("div");
      header.className = "cb-pricing-uc-header";
      header.setAttribute("role", "button");
      header.tabIndex = 0;
      // Keep the header mousedown from reaching the document selection-clearer.
      header.addEventListener("mousedown", (e) => e.stopPropagation());
      const chevron = document.createElement("span");
      chevron.className = "cb-pricing-uc-chevron";
      chevron.innerHTML = chevronDownSvg(12);
      const icon = document.createElement("span");
      icon.className = "cb-pricing-uc-icon";
      icon.innerHTML = typeof tableSvg === "function" ? tableSvg(13) : folderSvg(13);
      const nm = document.createElement("span");
      nm.className = "cb-pricing-uc-name";
      nm.textContent = uc.name;
      header.appendChild(chevron);
      header.appendChild(icon);
      header.appendChild(nm);
      // Contract-total cost pill (actions|credits) + $ on the right.
      const pillWrap = document.createElement("span");
      pillWrap.className = "cb-pricing-uc-pills";
      if (__cb.buildCostBadges) pillWrap.appendChild(__cb.buildCostBadges(ucCredits, ucActions));
      const dol = document.createElement("span");
      dol.className = "cb-pricing-uc-dollar";
      dol.textContent = pricingDollar(ucCredits * creditCost + ucActions * actionCost);
      pillWrap.appendChild(dol);
      header.appendChild(pillWrap);
      // NOTE: render() (not refresh()) — there is no module-scoped refresh; the
      // public refresh lives on __cb.tableView. render() rebuilds the body with
      // the new collapse state (matches how the normal group rows toggle).
      const toggle = () => {
        if (collapsed.has(uc.key)) collapsed.delete(uc.key);
        else collapsed.add(uc.key);
        render();
      };
      header.addEventListener("click", (e) => {
        e.stopPropagation();
        toggle();
      });
      header.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          toggle();
        }
      });
      box.appendChild(header);

      // ---- Per-year columns (hidden when collapsed) ------------------------
      if (!isCollapsed) {
        const yearsWrap = document.createElement("div");
        yearsWrap.className = "cb-pricing-uc-years";
        yearsWrap.style.gridTemplateColumns = `repeat(${maxYears}, minmax(0, 1fr))`;
        for (let i = 0; i < maxYears; i++) {
          yearsWrap.appendChild(
            buildPricingYearCell(uc, i, yearRecs[i], creditCost, actionCost),
          );
        }
        box.appendChild(yearsWrap);
      }
      wrap.appendChild(box);
    }
    return wrap;
  }

  // A metric card (summary-card style): icon at top, divider, total volume,
  // divider, total cost — all centered. The icon (StarFour = actions, Coins =
  // credits) plus the `kind` tone ("actions" #717989 / "credits" #0dac65) color
  // the icon + cost. `tier` (actions only) shows as a tiny caption under the
  // icon.
  function buildPricingMetricCard(iconSvg, tier, volume, dollar, kind) {
    const card = document.createElement("div");
    card.className = "cb-surface cb-pricing-metric-card" + (kind ? " cb-pricing-metric-" + kind : "");

    const iconWrap = document.createElement("div");
    iconWrap.className = "cb-pricing-metric-iconwrap";
    const icon = document.createElement("span");
    icon.className = "cb-pricing-metric-icon";
    icon.innerHTML = iconSvg;
    iconWrap.appendChild(icon);
    if (tier) {
      const t = document.createElement("span");
      t.className = "cb-pricing-metric-tier";
      t.textContent = `Tier ${tier}`;
      iconWrap.appendChild(t);
    }
    card.appendChild(iconWrap);

    const div1 = document.createElement("div");
    div1.className = "cb-pricing-metric-divider";
    card.appendChild(div1);

    const vol = document.createElement("div");
    vol.className = "cb-pricing-metric-vol";
    vol.textContent = pricingFmt(volume);
    card.appendChild(vol);

    const div2 = document.createElement("div");
    div2.className = "cb-pricing-metric-divider";
    card.appendChild(div2);

    const cost = document.createElement("div");
    cost.className = "cb-pricing-metric-cost";
    cost.textContent = pricingDollar(dollar);
    card.appendChild(cost);

    return card;
  }

  // One year column: a header line (Year N + Records input + year total cost),
  // then two metric cards (Actions, then Credits). Records is the single
  // editable driver; the cards are display-only. These are the per-use-case
  // RAW contributions — action tiering happens at the deal level (Total group).
  function buildPricingYearCell(uc, yearIdx, records, creditCost, actionCost) {
    const cell = document.createElement("div");
    cell.className = "cb-pricing-year";

    const credits = uc.perRowCredits * records;
    const actions = uc.perRowActions * records;
    const actionDollars = actions * actionCost;
    const creditDollars = credits * creditCost;
    const yearTotal = creditDollars + actionDollars;

    // Header line: Year N | Records [input] | total cost.
    const head = document.createElement("div");
    head.className = "cb-pricing-year-head";

    const name = document.createElement("span");
    name.className = "cb-pricing-year-name";
    name.textContent = `Year ${yearIdx + 1}`;

    const recWrap = document.createElement("label");
    recWrap.className = "cb-pricing-year-records";
    const recLabel = document.createElement("span");
    recLabel.className = "cb-pricing-year-records-label";
    recLabel.textContent = "Records";
    const recInput = document.createElement("input");
    recInput.type = "text";
    recInput.inputMode = "numeric";
    recInput.className = "cb-pricing-year-records-input";
    recInput.value = pricingFmt(records);
    const commitRecords = () => {
      const raw = parseInt(recInput.value.replace(/[^\d]/g, ""), 10);
      __cb.setPricingYearRecords(uc.key, yearIdx, Number.isFinite(raw) ? raw : 0);
    };
    recInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        recInput.blur();
      }
    });
    recInput.addEventListener("blur", commitRecords);
    recInput.addEventListener("focus", () => recInput.select());
    recWrap.appendChild(recLabel);
    recWrap.appendChild(recInput);

    const total = document.createElement("span");
    total.className = "cb-pricing-year-total";
    total.textContent = pricingDollar(yearTotal);

    head.appendChild(name);
    head.appendChild(recWrap);
    head.appendChild(total);
    cell.appendChild(head);

    // Metric cards: Actions first, then Credits (raw per-use-case volumes).
    const cards = document.createElement("div");
    cards.className = "cb-pricing-year-cards";
    const starIcon = typeof starFourSvg === "function" ? starFourSvg(18) : "";
    const coinIcon = typeof coinsSvg === "function" ? coinsSvg(18) : "";
    cards.appendChild(buildPricingMetricCard(starIcon, null, actions, actionDollars, "actions"));
    cards.appendChild(buildPricingMetricCard(coinIcon, null, credits, creditDollars, "credits"));
    cell.appendChild(cards);

    return cell;
  }

  // The collapsible grey "Summary" group: a header (no add button) and a
  // horizontal row of read-only summary cards, one per option. Mirrors the
  // "Options" group beneath it so the two read as a matched pair.
  function buildPricingSummaryGroup(optionsData) {
    const box = document.createElement("div");
    box.className = "cb-pricing-totalgrp cb-pricing-summarygrp";
    const collapsed = !!__cb._pricingSummaryCollapsed;
    if (collapsed) box.classList.add("cb-pricing-totalgrp-collapsed");

    const header = document.createElement("div");
    header.className = "cb-pricing-totalgrp-header";
    header.setAttribute("role", "button");
    header.tabIndex = 0;
    header.addEventListener("mousedown", (e) => e.stopPropagation());
    const chevron = document.createElement("span");
    chevron.className = "cb-pricing-totalgrp-chevron";
    chevron.innerHTML = chevronDownSvg(12);
    const nm = document.createElement("span");
    nm.className = "cb-pricing-totalgrp-name";
    nm.textContent = "Summary";
    header.appendChild(chevron);
    header.appendChild(nm);

    const toggle = () => {
      __cb._pricingSummaryCollapsed = !__cb._pricingSummaryCollapsed;
      render();
    };
    header.addEventListener("click", (e) => {
      e.stopPropagation();
      toggle();
    });
    header.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        toggle();
      }
    });
    box.appendChild(header);

    if (collapsed) return box;

    const row = document.createElement("div");
    row.className = "cb-pricing-options-row";
    optionsData.forEach(({ opt, perYear, cpc, cpa, years }) => {
      row.appendChild(buildPricingSummaryCard(opt, perYear, cpc, cpa, years));
    });
    box.appendChild(row);
    return box;
  }

  // One read-only summary card for an option: the option name + four rows
  // (Total action cost, Total credit cost, Total cost, Savings vs list),
  // formatted like the Options grid's price rows. Priced at the option's
  // discount CPC/CPA over its effective per-year volumes.
  function buildPricingSummaryCard(opt, perYear, cpc, cpa, years) {
    let totalCredits = 0;
    let totalActions = 0;
    for (const y of perYear) {
      totalCredits += y.credits;
      totalActions += y.actionVolume;
    }
    const creditDollars = totalCredits * cpc;
    const actionDollars = totalActions * cpa;
    const total = creditDollars + actionDollars;
    const listCpc = __cb.pricing?.LIST_CPC ?? 0.05;
    const listCpa = __cb.pricing?.LIST_CPA ?? 0.008;
    const listTotal = totalCredits * listCpc + totalActions * listCpa;
    const savings = Math.max(0, listTotal - total);
    const savingsPct = listTotal > 0 ? (savings / listTotal) * 100 : 0;

    const box = document.createElement("div");
    box.className = "cb-pricing-option cb-pricing-summary-card";

    const nameRow = document.createElement("div");
    nameRow.className = "cb-pricing-option-namerow";
    const name = document.createElement("span");
    name.className = "cb-pricing-option-name";
    name.textContent = opt.name;
    nameRow.appendChild(name);
    const term = document.createElement("span");
    term.className = "cb-pricing-summary-term";
    term.textContent = `${years}Y`;
    nameRow.appendChild(term);
    box.appendChild(nameRow);

    const grid = document.createElement("div");
    grid.className = "cb-pricing-summary-grid";
    const mkRow = (labelText, valueText, mod) => {
      const l = document.createElement("div");
      l.className = "cb-ptg-rowlabel cb-pricing-summary-label" + (mod ? " " + mod : "");
      l.textContent = labelText;
      const v = document.createElement("div");
      v.className = "cb-pricing-summary-value" + (mod ? " " + mod : "");
      v.textContent = valueText;
      grid.appendChild(l);
      grid.appendChild(v);
    };
    // Actions before credits, matching the rest of the pricing view.
    mkRow("Total action cost", pricingDollar(actionDollars));
    mkRow("Total credit cost", pricingDollar(creditDollars));
    mkRow("Total cost", pricingDollar(total), "cb-pricing-summary-grand");
    mkRow(
      "Savings vs list",
      `${pricingDollar(savings)} \u00b7 ${savingsPct.toFixed(0)}%`,
      "cb-pricing-summary-savings",
    );
    box.appendChild(grid);
    return box;
  }

  // 4-decimal rate ($0.0360) for the floor cells.
  function pricingRate(n) {
    return "$" + (Number(n) || 0).toFixed(4);
  }

  // Rep floor for a metric, from the tier the AVERAGE volume across years lands
  // in, derived for the contract length. Used by the Discount row.
  function pricingRepFloor(metric, avgVolume, years) {
    if (!__cb.pricing) return null;
    const set =
      metric === "credit"
        ? __cb.pricing.enterpriseCreditFloors?.()
        : __cb.pricing.enterpriseActionFloors?.();
    if (!set) return null;
    const tier = __cb.pricing.selectBand(set, avgVolume);
    if (!tier) return null;
    const floors = __cb.pricing.resolveFloors(tier, years);
    return floors ? floors.rep : null;
  }

  // Custom volume dropdown (replaces the native <select>; shows the volume only,
  // no tier letter). Trigger + a body-appended menu listing the tier volumes.
  let pricingVolMenuEl = null;
  function closePricingVolMenu() {
    if (pricingVolMenuEl) {
      pricingVolMenuEl.remove();
      pricingVolMenuEl = null;
    }
    document.removeEventListener("mousedown", onPricingVolMenuDocClick, true);
  }
  function onPricingVolMenuDocClick(e) {
    if (pricingVolMenuEl && !pricingVolMenuEl.contains(e.target)) closePricingVolMenu();
  }
  function openPricingVolMenu(anchor, currentTier, onPick) {
    closePricingVolMenu();
    const menu = document.createElement("div");
    menu.className = "cb-ptg-volmenu";
    menu.addEventListener("mousedown", (e) => e.stopPropagation());
    for (const b of actionTierOptions()) {
      const opt = document.createElement("button");
      opt.type = "button";
      opt.className =
        "cb-ptg-volmenu-opt" +
        (String(b.tier) === String(currentTier) ? " cb-ptg-volmenu-opt-active" : "");
      opt.textContent = pricingFmt(b.volume);
      opt.addEventListener("click", (e) => {
        e.stopPropagation();
        closePricingVolMenu();
        onPick(String(b.tier));
      });
      menu.appendChild(opt);
    }
    document.body.appendChild(menu);
    const r = anchor.getBoundingClientRect();
    menu.style.position = "fixed";
    menu.style.left = `${Math.round(r.left)}px`;
    menu.style.top = `${Math.round(r.bottom + 4)}px`;
    menu.style.minWidth = `${Math.round(r.width)}px`;
    pricingVolMenuEl = menu;
    document.addEventListener("mousedown", onPricingVolMenuDocClick, true);
  }

  function buildPricingVolDropdown(tier, overridden, onPick) {
    const trigger = document.createElement("button");
    trigger.type = "button";
    trigger.className = "cb-input-box cb-ptg-vol";
    if (overridden) trigger.classList.add("cb-pricing-overridden");
    const volSpan = document.createElement("span");
    volSpan.textContent = pricingFmt(actionVolumeForTier(tier));
    trigger.appendChild(volSpan);
    const chev = document.createElement("span");
    chev.className = "cb-ptg-vol-chevron";
    chev.innerHTML = chevronDownSvg(11);
    trigger.appendChild(chev);
    trigger.addEventListener("mousedown", (e) => e.stopPropagation());
    trigger.addEventListener("click", (e) => {
      e.stopPropagation();
      openPricingVolMenu(trigger, tier, onPick);
    });
    return trigger;
  }

  // ---- Average-row band matrix: hover to preview, click/pin to keep ----------
  // Hovering an Average cell opens a transient matrix (Tier / Floor / 1-3 Yr
  // floors) with the active-year column, the landed band, and their
  // intersection highlighted in the metric's tone (grey actions / green credits).
  // The floors shown escalate rep -> manager -> deal desk as the Discount drops
  // below each authority level (the header pill names the active level).
  // Clicking it (or its pin icon) pins it open + draggable; multiple can be
  // pinned at once to compare. Pinned panels are snapshots taken at pin time.
  let pricingAvgHoverEl = null;
  let pricingAvgHoverTimer = null;
  const pricingAvgPinnedEls = new Set();

  function closeAvgHover() {
    if (pricingAvgHoverTimer) {
      clearTimeout(pricingAvgHoverTimer);
      pricingAvgHoverTimer = null;
    }
    if (pricingAvgHoverEl) {
      pricingAvgHoverEl.remove();
      pricingAvgHoverEl = null;
    }
  }
  function scheduleAvgHoverClose() {
    if (pricingAvgHoverTimer) clearTimeout(pricingAvgHoverTimer);
    pricingAvgHoverTimer = setTimeout(closeAvgHover, 140);
  }
  // Closes the transient hover panel; with force, also removes every pinned one.
  function closeAllAvgMatrices(force) {
    closeAvgHover();
    hidePricingTip();
    if (force) {
      for (const el of pricingAvgPinnedEls) el.remove();
      pricingAvgPinnedEls.clear();
    }
  }
  // The pinned matrix for this option+metric key, or null.
  function findPinnedAvgMatrix(key) {
    if (!key) return null;
    for (const el of pricingAvgPinnedEls) {
      if (el.dataset.pamKey === key) return el;
    }
    return null;
  }
  // True when a pinned matrix already exists for this option+metric key, so the
  // Average cell shouldn't reopen a transient hover over it.
  function isAvgMatrixPinned(key) {
    return !!findPinnedAvgMatrix(key);
  }

  // Tiny instant tooltip for the "% off list" chips. Native title tooltips are
  // slow/unreliable inside the overlay, and the chips hide the cursor.
  let pricingTipEl = null;
  function hidePricingTip() {
    if (pricingTipEl) {
      pricingTipEl.remove();
      pricingTipEl = null;
    }
  }
  function showPricingTip(anchor, text) {
    hidePricingTip();
    const tip = document.createElement("div");
    tip.className = "cb-pricing-tip";
    tip.textContent = text;
    document.body.appendChild(tip);
    // Fixed before measuring so the width is the tip's own, not the body width
    // (a static block would report full width and get clamped to the left edge).
    tip.style.position = "fixed";
    const r = anchor.getBoundingClientRect();
    const tw = tip.getBoundingClientRect().width || 0;
    let left = Math.round(r.left + r.width / 2 - tw / 2);
    left = Math.max(8, Math.min(left, window.innerWidth - tw - 8));
    tip.style.left = `${left}px`;
    tip.style.top = `${Math.round(r.bottom + 6)}px`;
    pricingTipEl = tip;
  }

  function pinIconSvg() {
    return '<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="17" x2="12" y2="22"/><path d="M9 2h6l-1 7 3 3v2H7v-2l3-3-1-7z"/></svg>';
  }

  function pinAvgMatrix(panel) {
    if (!panel) return;
    // Don't pin a duplicate of a band that's already pinned (same option+metric).
    const dupKey = panel.dataset.pamKey;
    if (dupKey) {
      for (const el of pricingAvgPinnedEls) {
        if (el !== panel && el.dataset.pamKey === dupKey) {
          if (pricingAvgHoverEl === panel) {
            panel.remove();
            pricingAvgHoverEl = null;
          }
          return;
        }
      }
    }
    panel.classList.add("cb-pam-pinned");
    const pin = panel.querySelector(".cb-pam-pin");
    if (pin) {
      pin.classList.add("cb-pam-pin-active");
      pin.title = "Unpin";
    }
    // Detach from the hover slot so it survives the next hover / re-render.
    if (pricingAvgHoverEl === panel) pricingAvgHoverEl = null;
    if (pricingAvgHoverTimer) {
      clearTimeout(pricingAvgHoverTimer);
      pricingAvgHoverTimer = null;
    }
    pricingAvgPinnedEls.add(panel);
  }
  function unpinAvgMatrix(panel) {
    pricingAvgPinnedEls.delete(panel);
    panel.remove();
  }

  // Re-render every pinned matrix from the current option data so their floors
  // and authority pill track live edits (discount, volumes, term, rename) — not
  // just the state captured at pin time. Each panel keeps its on-screen position
  // and pinned/draggable state; only its content is rebuilt. Called from
  // buildPricingBody after the options group renders.
  function syncPinnedAvgMatrices(optionsData) {
    if (!pricingAvgPinnedEls.size) return;
    for (const oldPanel of Array.from(pricingAvgPinnedEls)) {
      const key = oldPanel.dataset.pamKey || "";
      const sep = key.indexOf("|");
      if (sep < 0) continue;
      const optIdx = Number(key.slice(0, sep));
      const metric = key.slice(sep + 1);
      const od = optionsData[optIdx];
      // Option deleted: drop its now-orphaned pinned panel.
      if (!od) {
        unpinAvgMatrix(oldPanel);
        continue;
      }
      const n = od.perYear.length || 1;
      const avgVolume =
        metric === "credit"
          ? od.perYear.reduce((s, y) => s + y.credits, 0) / n
          : od.perYear.reduce((s, y) => s + y.actionVolume, 0) / n;
      const actual = metric === "credit" ? od.cpc : od.cpa;
      const fresh = buildAvgMatrixPanel({
        metric,
        avgVolume,
        years: od.years,
        optName: od.opt.name,
        key,
        actual,
      });
      if (!fresh) continue;
      // Preserve position + pinned/draggable state from the old panel.
      fresh.style.position = "fixed";
      if (oldPanel.style.left) fresh.style.left = oldPanel.style.left;
      if (oldPanel.style.top) fresh.style.top = oldPanel.style.top;
      fresh.classList.add("cb-pam-pinned");
      const pin = fresh.querySelector(".cb-pam-pin");
      if (pin) {
        pin.classList.add("cb-pam-pin-active");
        pin.title = "Unpin";
      }
      oldPanel.replaceWith(fresh);
      pricingAvgPinnedEls.delete(oldPanel);
      pricingAvgPinnedEls.add(fresh);
    }
  }

  // Drag a pinned panel by its header. No-op until the panel is pinned.
  function makeAvgMatrixDraggable(panel, header) {
    header.addEventListener("mousedown", (e) => {
      if (e.target.closest(".cb-pam-pin")) return;
      if (!panel.classList.contains("cb-pam-pinned")) return;
      e.preventDefault();
      const rect = panel.getBoundingClientRect();
      const sx = e.clientX;
      const sy = e.clientY;
      const ox = rect.left;
      const oy = rect.top;
      panel.style.left = `${ox}px`;
      panel.style.top = `${oy}px`;
      const move = (ev) => {
        panel.style.left = `${Math.max(8, ox + ev.clientX - sx)}px`;
        panel.style.top = `${Math.max(8, oy + ev.clientY - sy)}px`;
      };
      const up = () => {
        document.removeEventListener("mousemove", move);
        document.removeEventListener("mouseup", up);
      };
      document.addEventListener("mousemove", move);
      document.addEventListener("mouseup", up);
    });
  }

  // Builds one matrix panel (header + band table). Starts unpinned.
  function buildAvgMatrixPanel(opts) {
    const { metric, avgVolume, years, optName, key, actual } = opts || {};
    if (!__cb.pricing) return null;
    const set =
      metric === "credit"
        ? __cb.pricing.enterpriseCreditFloors?.()
        : __cb.pricing.enterpriseActionFloors?.();
    const bands = (set && set.bands) || [];
    if (!bands.length) return null;
    const selected = __cb.pricing.selectBand(set, avgVolume);
    const selKey = selected ? String(selected.tier) : null;
    const activeYear = Math.min(3, Math.max(1, years || 1));

    // Authority level for the current Discount vs the avg-volume tier's floors
    // (derived for the option's term). Drives which floor the band table shows
    // and the header pill: rep (Authorized) -> manager -> deal desk. Mirrors the
    // thresholds in pricing.approvalForContract.
    const selFloors = selected ? __cb.pricing.resolveFloors(selected, activeYear) : null;
    let level = "rep";
    if (selFloors && Number.isFinite(actual)) {
      if (actual < selFloors.manager) level = "dealDesk";
      else if (actual < selFloors.rep) level = "manager";
    }

    const panel = document.createElement("div");
    panel.className =
      "cb-pricing-avgmatrix " + (metric === "credit" ? "cb-pam-credits" : "cb-pam-actions");
    if (key) panel.dataset.pamKey = key;
    // Keep mousedowns inside the panel from reaching the document (selection
    // clear / outside-click closers).
    panel.addEventListener("mousedown", (e) => e.stopPropagation());

    // ---- Header: option name + metric pill + pin icon (also the drag handle) -
    const header = document.createElement("div");
    header.className = "cb-pam-header";
    const nm = document.createElement("span");
    nm.className = "cb-pam-optname";
    nm.textContent = optName || "Option";
    const pill = document.createElement("span");
    pill.className = "cb-pam-metricpill";
    pill.textContent = metric === "credit" ? "Credits" : "Actions";
    // Authority pill: which approval level the current Discount lands in.
    const AUTH = {
      rep: { label: "Rep", cls: "cb-pam-authpill-rep" },
      manager: { label: "Manager", cls: "cb-pam-authpill-manager" },
      dealDesk: { label: "Deal Desk", cls: "cb-pam-authpill-dealdesk" },
    };
    const authPill = document.createElement("span");
    authPill.className = "cb-pam-authpill " + AUTH[level].cls;
    authPill.textContent = AUTH[level].label;
    const pin = document.createElement("button");
    pin.type = "button";
    pin.className = "cb-pam-pin";
    pin.title = "Pin";
    pin.setAttribute("aria-label", "Pin");
    pin.innerHTML = pinIconSvg();
    pin.addEventListener("mousedown", (e) => e.stopPropagation());
    pin.addEventListener("click", (e) => {
      e.stopPropagation();
      if (panel.classList.contains("cb-pam-pinned")) unpinAvgMatrix(panel);
      else pinAvgMatrix(panel);
    });
    header.appendChild(nm);
    header.appendChild(pill);
    header.appendChild(authPill);
    header.appendChild(pin);
    panel.appendChild(header);

    // ---- Band table ----
    const table = document.createElement("table");
    const thead = document.createElement("thead");
    const htr = document.createElement("tr");
    // Columns: Tier, Floor (band start volume), then the 1/2/3-year floors for
    // the active authority level. i 0=Tier, 1=Floor, 2..4 = year columns (year = i - 1).
    ["Tier", "Floor", "1 Yr", "2 Yr", "3 Yr"].forEach((label, i) => {
      const th = document.createElement("th");
      th.textContent = label;
      if (i >= 2 && i - 1 === activeYear) th.className = "cb-pam-col-active";
      htr.appendChild(th);
    });
    thead.appendChild(htr);
    table.appendChild(thead);

    const tbody = document.createElement("tbody");
    for (const b of bands) {
      const isSel = selKey != null && String(b.tier) === selKey;
      const tr = document.createElement("tr");
      if (isSel) tr.className = "cb-pam-row-sel";
      const tierTd = document.createElement("td");
      tierTd.className = "cb-pam-tier";
      tierTd.textContent = String(b.tier);
      tr.appendChild(tierTd);
      const limitTd = document.createElement("td");
      limitTd.className = "cb-pam-limit";
      limitTd.textContent = Math.max(0, Math.round(Number(b.volume) || 0)).toLocaleString();
      tr.appendChild(limitTd);
      for (let y = 1; y <= 3; y++) {
        const td = document.createElement("td");
        const floors = __cb.pricing.resolveFloors(b, y);
        td.textContent = floors ? pricingRate(floors[level]) : "\u2014";
        const cls = [];
        if (y === activeYear) cls.push("cb-pam-col-active");
        if (isSel && y === activeYear) cls.push("cb-pam-cell-active");
        if (cls.length) td.className = cls.join(" ");
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    panel.appendChild(table);

    // Pinning is via the pin icon (on the modal) or a click on the Average cell
    // only - clicking the modal body does not pin.
    makeAvgMatrixDraggable(panel, header);
    return panel;
  }

  // Opens the transient hover panel near an Average cell. Pinned panels untouched.
  function openAvgMatrixHover(anchor, metric, avgVolume, years, optName, key, actual) {
    closeAvgHover();
    const panel = buildAvgMatrixPanel({ metric, avgVolume, years, optName, key, actual });
    if (!panel) return;
    panel.addEventListener("mouseenter", () => {
      if (pricingAvgHoverTimer) {
        clearTimeout(pricingAvgHoverTimer);
        pricingAvgHoverTimer = null;
      }
    });
    panel.addEventListener("mouseleave", () => {
      if (!panel.classList.contains("cb-pam-pinned")) scheduleAvgHoverClose();
    });
    document.body.appendChild(panel);
    // Fixed before measuring so the width is the panel's own, not the body width.
    panel.style.position = "fixed";
    const r = anchor.getBoundingClientRect();
    const mw = panel.getBoundingClientRect().width || 280;
    let left = Math.round(r.left);
    if (left + mw > window.innerWidth - 8) left = Math.round(window.innerWidth - mw - 8);
    panel.style.left = `${Math.max(8, left)}px`;
    panel.style.top = `${Math.round(r.bottom + 6)}px`;
    pricingAvgHoverEl = panel;
  }

  // Effective per-year values for one option = the recommended rollup with the
  // option's per-year overrides applied (credits + action tier). Flags whether
  // each value deviates from the recommendation (drives the amber outline).
  function effectivePerYear(recommended, override, years) {
    override = override || { credits: {}, actionTier: {} };
    return recommended.slice(0, years).map((r, i) => {
      const ovC = override.credits ? override.credits[i] : undefined;
      const ovT = override.actionTier ? override.actionTier[i] : undefined;
      const credits = ovC != null ? Number(ovC) : r.recCredits;
      const tier = ovT != null ? ovT : r.recTier;
      return {
        recCredits: r.recCredits,
        recTier: r.recTier,
        credits,
        tier,
        actionVolume: actionVolumeForTier(tier),
        creditsOverridden: ovC != null && Number(ovC) !== r.recCredits,
        tierOverridden: ovT != null && String(ovT) !== String(r.recTier),
      };
    });
  }

  // The years-rows grid for ONE option: Actions + Credits columns, the per-year
  // volume rows, then the price rows — List, Discount (rep-entered, defaults to
  // list), Authorized (rep floor). Discount + Authorized show % off list.
  function buildOptionGrid(perYear, optIdx, years, cpc, cpa, optName) {
    const LIST_CPC = __cb.pricing?.LIST_CPC ?? 0.05;
    const LIST_CPA = __cb.pricing?.LIST_CPA ?? 0.008;
    // Small "% off list" chip: shows just "N%"; the full phrase is the tooltip.
    const pctBox = (price, list) => {
      if (!(list > 0) || price == null) return null;
      const p = Math.round(((list - price) / list) * 100);
      const box = document.createElement("span");
      box.className = "cb-ptg-pct-box";
      box.textContent = `${p}%`;
      const tip = `${p}% off list`;
      box.addEventListener("mouseenter", () => showPricingTip(box, tip));
      box.addEventListener("mouseleave", hidePricingTip);
      return box;
    };

    const grid = document.createElement("div");
    grid.className = "cb-pricing-totalgrp-grid";

    grid.appendChild(document.createElement("div")).className = "cb-ptg-corner";
    const colHead = (labelText, iconSvg, cls) => {
      const h = document.createElement("div");
      h.className = "cb-ptg-colhead " + cls;
      h.innerHTML = iconSvg + `<span>${labelText}</span>`;
      return h;
    };
    grid.appendChild(
      colHead("Actions", typeof starFourSvg === "function" ? starFourSvg(13) : "", "cb-ptg-actions"),
    );
    grid.appendChild(
      colHead("Credits", typeof coinsSvg === "function" ? coinsSvg(13) : "", "cb-ptg-credits"),
    );

    perYear.forEach((y, i) => {
      const lbl = document.createElement("div");
      lbl.className = "cb-ptg-rowlabel cb-ptg-yearlabel";
      const lblText = document.createElement("span");
      lblText.textContent = `Year ${i + 1}`;
      lbl.appendChild(lblText);
      // Reset-to-proposed: shown only when this year's volume was overridden.
      if (y.creditsOverridden || y.tierOverridden) {
        const reset = document.createElement("button");
        reset.type = "button";
        reset.className = "cb-ptg-reset";
        reset.title = "Reset to proposed";
        reset.setAttribute("aria-label", "Reset to proposed");
        reset.innerHTML =
          '<svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>';
        reset.addEventListener("mousedown", (e) => e.stopPropagation());
        reset.addEventListener("click", (e) => {
          e.stopPropagation();
          if (__cb.resetPricingOptionYear) __cb.resetPricingOptionYear(optIdx, i);
        });
        lbl.appendChild(reset);
      }
      grid.appendChild(lbl);

      const aCell = document.createElement("div");
      aCell.className = "cb-ptg-cell";
      aCell.appendChild(
        buildPricingVolDropdown(y.tier, y.tierOverridden, (tierId) =>
          __cb.setPricingOptionActionTier(optIdx, i, tierId),
        ),
      );
      grid.appendChild(aCell);

      const cCell = document.createElement("div");
      cCell.className = "cb-ptg-cell";
      const cInput = document.createElement("input");
      cInput.type = "text";
      cInput.inputMode = "numeric";
      cInput.className = "cb-input-box cb-ptg-input";
      if (y.creditsOverridden) cInput.classList.add("cb-pricing-overridden");
      cInput.value = pricingFmt(y.credits);
      const commitCredits = () => {
        const raw = parseInt(cInput.value.replace(/[^\d]/g, ""), 10);
        __cb.setPricingOptionCredits(optIdx, i, Number.isFinite(raw) ? raw : 0);
      };
      cInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          cInput.blur();
        }
      });
      cInput.addEventListener("blur", commitCredits);
      cInput.addEventListener("focus", () => cInput.select());
      cCell.appendChild(cInput);
      grid.appendChild(cCell);
    });

    // Rep floors from the avg-volume tier (derived for N years) → Authorized.
    const n = perYear.length || 1;
    const avgCredits = perYear.reduce((s, y) => s + y.credits, 0) / n;
    const avgActions = perYear.reduce((s, y) => s + y.actionVolume, 0) / n;
    const actionRep = pricingRepFloor("action", avgActions, years);
    const creditRep = pricingRepFloor("credit", avgCredits, years);

    // ---- Price rows: List, Discount (editable), Authorized (rep floor) ----
    const mkRowLabel = (text, cls) => {
      const d = document.createElement("div");
      d.className = "cb-ptg-rowlabel" + (cls ? " " + cls : "");
      d.textContent = text;
      return d;
    };
    // Read-only price box (+ optional % off list).
    const priceBox = (rate, list, opts) => {
      const cell = document.createElement("div");
      cell.className = "cb-ptg-cell cb-ptg-pricecell";
      const b = document.createElement("div");
      b.className = "cb-ptg-repfloor" + (opts?.list ? " cb-ptg-listbox" : "");
      b.textContent = rate != null ? pricingRate(rate) : "\u2014";
      cell.appendChild(b);
      if (opts?.showPct) {
        const pb = pctBox(rate, list);
        if (pb) cell.appendChild(pb);
      }
      return cell;
    };
    // Editable discount price input (+ % off list).
    const priceInput = (value, list, onCommit) => {
      const cell = document.createElement("div");
      cell.className = "cb-ptg-cell cb-ptg-pricecell";
      const inp = document.createElement("input");
      inp.type = "text";
      inp.inputMode = "decimal";
      inp.className = "cb-input-box cb-ptg-input cb-ptg-price-input";
      inp.value = pricingRate(value);
      const commit = () => {
        const raw = parseFloat(inp.value.replace(/[^\d.]/g, ""));
        onCommit(Number.isFinite(raw) ? raw : 0);
      };
      inp.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          inp.blur();
        }
      });
      inp.addEventListener("blur", commit);
      inp.addEventListener("focus", () => inp.select());
      cell.appendChild(inp);
      const pb = pctBox(value, list);
      if (pb) cell.appendChild(pb);
      return cell;
    };

    // Average row: read-only avg volumes that pick the tier; a separator divides
    // the year rows from the avg + price block. Hover a cell for the band matrix.
    const mkAvgCell = (metric, avgVol) => {
      const cell = document.createElement("div");
      cell.className = "cb-ptg-cell";
      const v = document.createElement("div");
      v.className = "cb-ptg-avg";
      v.textContent = pricingFmt(Math.round(avgVol));
      const key = `${optIdx}|${metric}`;
      // The metric's current Discount (defaults to list) drives the band table's
      // authority level (rep/manager/dealDesk).
      const actual = metric === "credit" ? cpc : cpa;
      v.addEventListener("mouseenter", () => {
        // Already pinned for this option+metric: don't reopen a hover preview.
        if (isAvgMatrixPinned(key)) return;
        openAvgMatrixHover(v, metric, avgVol, years, optName, key, actual);
      });
      v.addEventListener("mouseleave", scheduleAvgHoverClose);
      // Click the Average value to toggle its matrix: pin it (opening the hover
      // first if needed), or unpin it if this option+metric is already pinned.
      v.addEventListener("mousedown", (e) => e.stopPropagation());
      v.addEventListener("click", (e) => {
        e.stopPropagation();
        const pinned = findPinnedAvgMatrix(key);
        if (pinned) {
          unpinAvgMatrix(pinned);
          return;
        }
        if (!pricingAvgHoverEl) openAvgMatrixHover(v, metric, avgVol, years, optName, key, actual);
        if (pricingAvgHoverEl) pinAvgMatrix(pricingAvgHoverEl);
      });
      cell.appendChild(v);
      return cell;
    };
    // One continuous divider spanning all columns (a per-cell border-top would be
    // chopped up by the grid's column gaps).
    const divider = document.createElement("div");
    divider.className = "cb-ptg-divider";
    grid.appendChild(divider);
    grid.appendChild(mkRowLabel("Average"));
    grid.appendChild(mkAvgCell("action", avgActions));
    grid.appendChild(mkAvgCell("credit", avgCredits));

    // Authorized (rep floor) — sits above Discount as the reference ceiling.
    grid.appendChild(mkRowLabel("Authorized"));
    grid.appendChild(priceBox(actionRep, LIST_CPA, { showPct: true }));
    grid.appendChild(priceBox(creditRep, LIST_CPC, { showPct: true }));

    // Discount (rep-entered; defaults to list).
    grid.appendChild(mkRowLabel("Discount", "cb-ptg-rowlabel-discount"));
    grid.appendChild(
      priceInput(cpa, LIST_CPA, (v) => __cb.setPricingOptionPrice(optIdx, "action", v)),
    );
    grid.appendChild(
      priceInput(cpc, LIST_CPC, (v) => __cb.setPricingOptionPrice(optIdx, "credit", v)),
    );

    // Approval — deal-level status for this option's discount vs the avg-tier
    // floors over the contract term (auto-approved / manager / deal desk).
    const approval = __cb.pricing?.approvalForContract
      ? __cb.pricing.approvalForContract({
          years: perYear.map((y) => ({ credits: y.credits, actions: y.actionVolume })),
          contractYears: years,
          cpc,
          cpa,
        })
      : null;
    const apInfo =
      approval && approval.status === "pending_exception"
        ? { label: "Deal desk approval", cls: "cb-ptg-approval-red" }
        : approval && approval.status === "pending_standard"
          ? { label: "Manager approval", cls: "cb-ptg-approval-amber" }
          : { label: "Auto-approved", cls: "cb-ptg-approval-green" };
    grid.appendChild(mkRowLabel("Approval"));
    const apCell = document.createElement("div");
    apCell.className = "cb-ptg-cell cb-ptg-approval";
    const apBadge = document.createElement("span");
    apBadge.className = "cb-ptg-approval-badge " + apInfo.cls;
    apBadge.textContent = apInfo.label;
    apCell.appendChild(apBadge);
    grid.appendChild(apCell);

    return grid;
  }

  // ---- Option right-click menu (Rename / Delete) ----
  let pricingOptMenuEl = null;
  function closePricingOptMenu() {
    if (pricingOptMenuEl) {
      pricingOptMenuEl.remove();
      pricingOptMenuEl = null;
    }
    document.removeEventListener("mousedown", onPricingOptMenuDocClick, true);
  }
  function onPricingOptMenuDocClick(e) {
    if (pricingOptMenuEl && !pricingOptMenuEl.contains(e.target)) closePricingOptMenu();
  }
  function openPricingOptionMenu(evt, optIdx, opt, box, total) {
    closePricingOptMenu();
    const menu = document.createElement("div");
    menu.className = "cb-ptg-optmenu";
    menu.addEventListener("mousedown", (e) => e.stopPropagation());
    const mk = (label, fn, disabled) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "cb-ptg-optmenu-item" + (disabled ? " cb-ptg-optmenu-item-disabled" : "");
      b.textContent = label;
      if (!disabled) {
        b.addEventListener("click", (e) => {
          e.stopPropagation();
          closePricingOptMenu();
          fn();
        });
      }
      menu.appendChild(b);
    };
    mk(
      "Rename",
      () => {
        __cb._pricingOptionRenaming = opt.id;
        render();
      },
      opt.minimized,
    );
    mk(opt.minimized ? "Restore" : "Minimize", () => {
      if (opt.minimized) {
        __cb._pricingOptionJustRestored = opt.id;
        __cb.setPricingOptionMinimized(optIdx, false);
      } else {
        // Smooth collapse: pin the card's current size + capture its pre-collapse
        // height (the strip keeps that length), then crossfade the content out and
        // a rotated title in while the width shrinks. Persist + re-render at the end.
        const rect = box.getBoundingClientRect();
        opt.minH = Math.round(rect.height);
        box.style.position = "relative";
        box.style.overflow = "hidden";
        // Pin the height up front so the grid reflowing as it narrows can't push
        // the card (and the row) taller mid-animation.
        box.style.height = `${rect.height}px`;
        box.style.flex = `0 0 ${rect.width}px`;
        box.style.maxWidth = `${rect.width}px`;
        for (const child of Array.from(box.children)) {
          child.style.transition = "opacity 0.16s ease";
          child.style.opacity = "0";
        }
        const tmpTitle = document.createElement("div");
        tmpTitle.className = "cb-pricing-option-min-title";
        tmpTitle.textContent = opt.name;
        tmpTitle.style.opacity = "0";
        box.appendChild(tmpTitle);
        requestAnimationFrame(() => {
          box.style.transition = "flex-basis 0.26s ease, max-width 0.26s ease";
          box.style.flexBasis = "46px";
          box.style.maxWidth = "46px";
          tmpTitle.style.transition = "opacity 0.22s ease 0.08s";
          tmpTitle.style.opacity = "1";
        });
        setTimeout(() => __cb.setPricingOptionMinimized(optIdx, true), 300);
      }
    });
    mk(
      "Delete",
      () => {
        box.classList.add("cb-pricing-option-leaving");
        setTimeout(() => __cb.deletePricingOption(optIdx), 200);
      },
      total <= 1,
    );
    document.body.appendChild(menu);
    // Set fixed positioning BEFORE measuring: a still-static block reports the
    // full body width, so the right-edge clamp would pin it to the left edge.
    menu.style.position = "fixed";
    const x = Math.min(evt.clientX, window.innerWidth - menu.offsetWidth - 8);
    const yPos = Math.min(evt.clientY, window.innerHeight - menu.offsetHeight - 8);
    menu.style.left = `${Math.round(Math.max(8, x))}px`;
    menu.style.top = `${Math.round(Math.max(8, yPos))}px`;
    pricingOptMenuEl = menu;
    document.addEventListener("mousedown", onPricingOptMenuDocClick, true);
  }

  // Compact per-option contract-term toggle (1Y / 2Y / 3Y). Sits in the option
  // header where the hint used to be; sets that option's own term.
  function buildOptionTermToggle(optIdx, optYears) {
    const wrap = document.createElement("div");
    wrap.className = "cb-option-term-toggle";
    wrap.addEventListener("mousedown", (e) => e.stopPropagation());
    const active = Math.min(3, Math.max(1, optYears || 1));
    [1, 2, 3].forEach((n) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "cb-option-term-btn" + (n === active ? " cb-option-term-btn-active" : "");
      b.textContent = `${n}Y`;
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        if (n !== active && __cb.setPricingOptionYears) __cb.setPricingOptionYears(optIdx, n);
      });
      wrap.appendChild(b);
    });
    return wrap;
  }

  // One option box: name header (term toggle + right-click rename / delete /
  // minimize) + its grid. When minimized, renders as a thin strip showing only
  // the title rotated 90deg (grid hidden); restore is right-click only.
  function buildPricingOptionBox(opt, optIdx, perYear, years, total, cpc, cpa) {
    const box = document.createElement("div");
    box.className = "cb-pricing-option";
    box.dataset.optId = opt.id;

    const wireContextMenu = () => {
      box.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        e.stopPropagation();
        openPricingOptionMenu(e, optIdx, opt, box, total);
      });
    };

    // Minimized: thin strip with only the rotated title (right-click → Restore).
    // The strip keeps the card's pre-collapse height (opt.minH).
    if (opt.minimized) {
      box.classList.add("cb-pricing-option-min");
      if (opt.minH) box.style.height = `${opt.minH}px`;
      const title = document.createElement("div");
      title.className = "cb-pricing-option-min-title";
      title.textContent = opt.name;
      box.appendChild(title);
      wireContextMenu();
      return box;
    }

    if (__cb._pricingOptionJustAdded === opt.id) {
      box.classList.add("cb-pricing-option-enter");
      __cb._pricingOptionJustAdded = null;
    }
    // Just restored from minimized: reuse the option enter animation.
    if (__cb._pricingOptionJustRestored === opt.id) {
      box.classList.add("cb-pricing-option-enter");
      __cb._pricingOptionJustRestored = null;
    }

    const nameRow = document.createElement("div");
    nameRow.className = "cb-pricing-option-namerow";
    if (__cb._pricingOptionRenaming === opt.id) {
      const inp = document.createElement("input");
      inp.className = "cb-pricing-option-name-input";
      inp.value = opt.name;
      const commit = () => {
        if (__cb._pricingOptionRenaming !== opt.id) return;
        __cb._pricingOptionRenaming = null;
        __cb.renamePricingOption(optIdx, inp.value);
      };
      inp.addEventListener("mousedown", (e) => e.stopPropagation());
      inp.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          inp.blur();
        } else if (e.key === "Escape") {
          __cb._pricingOptionRenaming = null;
          render();
        }
      });
      inp.addEventListener("blur", commit);
      nameRow.appendChild(inp);
      requestAnimationFrame(() => {
        inp.focus();
        inp.select();
      });
    } else {
      const name = document.createElement("span");
      name.className = "cb-pricing-option-name";
      name.textContent = opt.name;
      nameRow.appendChild(name);
      nameRow.appendChild(buildOptionTermToggle(optIdx, years));
    }
    box.appendChild(nameRow);
    box.appendChild(buildOptionGrid(perYear, optIdx, years, cpc, cpa, opt.name));

    wireContextMenu();
    return box;
  }

  // The collapsible grey "Options" group: a header (with a + to add an option,
  // up to 3) and a horizontal row of option boxes. Option A feeds the Summary.
  function buildPricingOptionsGroup(optionsData) {
    const box = document.createElement("div");
    box.className = "cb-pricing-totalgrp";
    const collapsed = !!__cb._pricingTotalCollapsed;
    if (collapsed) box.classList.add("cb-pricing-totalgrp-collapsed");

    const header = document.createElement("div");
    header.className = "cb-pricing-totalgrp-header";
    header.setAttribute("role", "button");
    header.tabIndex = 0;
    header.addEventListener("mousedown", (e) => e.stopPropagation());
    const chevron = document.createElement("span");
    chevron.className = "cb-pricing-totalgrp-chevron";
    chevron.innerHTML = chevronDownSvg(12);
    const nm = document.createElement("span");
    nm.className = "cb-pricing-totalgrp-name";
    nm.textContent = "Options";
    header.appendChild(chevron);
    header.appendChild(nm);

    // "+" to add an option (hidden at the 3-option cap). Sits at the right.
    if (optionsData.length < 3) {
      const addBtn = document.createElement("button");
      addBtn.type = "button";
      addBtn.className = "cb-pricing-totalgrp-add";
      addBtn.title = "Add an option";
      addBtn.setAttribute("aria-label", "Add an option");
      addBtn.innerHTML =
        '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>';
      addBtn.addEventListener("mousedown", (e) => e.stopPropagation());
      addBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        if (__cb.addPricingOption) __cb.addPricingOption();
      });
      header.appendChild(addBtn);
    }

    const toggle = () => {
      __cb._pricingTotalCollapsed = !__cb._pricingTotalCollapsed;
      render();
    };
    header.addEventListener("click", (e) => {
      e.stopPropagation();
      toggle();
    });
    header.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        toggle();
      }
    });
    box.appendChild(header);

    if (collapsed) return box;

    const row = document.createElement("div");
    row.className = "cb-pricing-options-row";
    optionsData.forEach(({ opt, perYear, cpc, cpa, years }, idx) => {
      row.appendChild(
        buildPricingOptionBox(opt, idx, perYear, years, optionsData.length, cpc, cpa),
      );
    });
    box.appendChild(row);
    return box;
  }

  // ---- Public API consumed by table-view.js ---------------------------------
  __cb.pricingView = {
    buildPricingBody,
    // Tear down every transient pricing popover (vol dropdown, option menu, and
    // the band matrices including pinned ones). Called from the table view's
    // unmount and when leaving pricing mode.
    closeMenus() {
      closePricingVolMenu();
      closePricingOptMenu();
      closeAllAvgMatrices(true);
    },
  };
})();
