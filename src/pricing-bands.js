/**
 * View Bands overlay (internal-only) for the multi-year pricing view.
 *
 * A floating panel the GTME opens from the "View Bands" control while pricing
 * mode is on. It shows the enterprise credit + action bands, the tier the
 * current deal lands in (by the cross-year average volume), the contract-length
 * derived rep/manager/dealDesk floors, and the resulting approval status +
 * reasons. Everything here is internal: the main pricing view stays free of
 * floors/approval so it's safe to screen-share with a customer; this panel is a
 * deliberate, dismissable reveal.
 *
 * Reads live state via __cb.getPricingResult() (per-year grand volumes),
 * __cb.getCreditCost()/getActionCost() (the contract CPC/CPA), and the band
 * data + math from __cb.pricing.*. Re-renders on demand via refresh(), which
 * overlay.js calls from updatePricingStrip whenever the volumes/prices change.
 */
(function () {
  "use strict";

  const __cb = (window.__cb = window.__cb || {});

  let panelEl = null;
  let backdropEl = null;
  let anchorEl = null;

  function money4(n) {
    return "$" + (Number(n) || 0).toFixed(4);
  }
  function int(n) {
    return Math.max(0, Math.round(Number(n) || 0)).toLocaleString();
  }

  function isOpen() {
    return !!panelEl;
  }

  function close() {
    if (panelEl) {
      panelEl.remove();
      panelEl = null;
    }
    if (backdropEl) {
      backdropEl.remove();
      backdropEl = null;
    }
    document.removeEventListener("keydown", onKey);
    window.removeEventListener("resize", position);
  }

  function onKey(e) {
    if (e.key === "Escape") {
      e.stopPropagation();
      close();
    }
  }

  function toggle(anchor) {
    if (isOpen()) {
      close();
      return;
    }
    anchorEl = anchor || null;
    open();
  }

  function open() {
    backdropEl = document.createElement("div");
    backdropEl.className = "cb-bands-backdrop";
    backdropEl.addEventListener("mousedown", () => close());

    panelEl = document.createElement("div");
    panelEl.className = "cb-bands-panel";
    panelEl.addEventListener("mousedown", (e) => e.stopPropagation());

    document.body.appendChild(backdropEl);
    document.body.appendChild(panelEl);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", position);
    render();
    position();
  }

  function position() {
    if (!panelEl) return;
    const r = anchorEl && anchorEl.getBoundingClientRect && anchorEl.getBoundingClientRect();
    const w = panelEl.getBoundingClientRect().width || 520;
    if (r) {
      const left = Math.min(Math.max(8, r.left), window.innerWidth - w - 8);
      panelEl.style.top = `${Math.round(r.bottom + 8)}px`;
      panelEl.style.left = `${Math.round(left)}px`;
    } else {
      panelEl.style.top = "84px";
      panelEl.style.left = "84px";
    }
  }

  function statusInfo(status) {
    if (status === "pending_exception")
      return { label: "Deal desk approval required", cls: "cb-bands-badge-red" };
    if (status === "pending_standard")
      return { label: "Manager approval required", cls: "cb-bands-badge-amber" };
    return { label: "Auto-approved", cls: "cb-bands-badge-green" };
  }

  // One bands table (credit or action). Highlights the selected tier and, on
  // that row, shows the contract-derived floors; other rows show the 1-year
  // base floors. `actual` is the current CPC/CPA so we can flag the cell.
  function buildBandsTable(titleText, dataset, selectedTier, floors, contractYears, actual) {
    const section = document.createElement("div");
    section.className = "cb-bands-section";

    const title = document.createElement("div");
    title.className = "cb-bands-section-title";
    title.textContent = titleText;
    section.appendChild(title);

    const table = document.createElement("table");
    table.className = "cb-bands-table";
    const thead = document.createElement("thead");
    thead.innerHTML =
      "<tr><th>Tier</th><th>Volume</th><th>Rep</th><th>Mgr</th><th>Deal desk</th></tr>";
    table.appendChild(thead);

    const tbody = document.createElement("tbody");
    const bands = (dataset && dataset.bands) || [];
    const selKey = selectedTier ? String(selectedTier.tier) : null;
    for (const b of bands) {
      const tr = document.createElement("tr");
      const isSel = selKey != null && String(b.tier) === selKey;
      if (isSel) tr.className = "cb-bands-row-selected";
      const f = b.floors || {};
      const cells = [
        String(b.tier),
        int(b.volume),
        money4(f.rep),
        money4(f.manager),
        money4(f.dealDesk),
      ];
      for (const c of cells) {
        const td = document.createElement("td");
        td.textContent = c;
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    section.appendChild(table);

    // Contract-derived floor line for the selected tier + the actual price.
    if (selectedTier && floors) {
      const note = document.createElement("div");
      note.className = "cb-bands-note";
      const below =
        Number.isFinite(actual) &&
        (actual < floors.manager
          ? "manager"
          : actual < floors.rep
            ? "rep"
            : null);
      const priceCls =
        below === "manager"
          ? "cb-bands-price-red"
          : below === "rep"
            ? "cb-bands-price-amber"
            : "cb-bands-price-ok";
      note.innerHTML =
        `Tier <b>${selectedTier.tier}</b> \u00b7 ${contractYears}-year floors: ` +
        `rep ${money4(floors.rep)} \u00b7 mgr ${money4(floors.manager)} \u00b7 dd ${money4(floors.dealDesk)} ` +
        `\u2014 <span class="${priceCls}">your ${money4(actual)}</span>`;
      section.appendChild(note);
    }
    return section;
  }

  function render() {
    if (!panelEl) return;
    panelEl.innerHTML = "";

    const pricing = __cb.pricing;
    const res = __cb.getPricingResult ? __cb.getPricingResult() : null;
    const cpc = __cb.getCreditCost ? __cb.getCreditCost() : 0.05;
    const cpa = __cb.getActionCost ? __cb.getActionCost() : 0.008;
    const contractYears = (res && res.contractYears) || __cb.contractYears || 1;
    const years = (res && res.years) || [];

    const approval = pricing && pricing.approvalForContract
      ? pricing.approvalForContract({ years, contractYears, cpc, cpa })
      : { status: null, reasons: [], avgCredits: 0, avgActions: 0, creditTier: null, actionTier: null, creditFloors: null, actionFloors: null };

    // ---- Header ----
    const header = document.createElement("div");
    header.className = "cb-bands-header";
    const h = document.createElement("div");
    h.className = "cb-bands-title";
    h.textContent = "Pricing bands \u00b7 internal";
    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "cb-bands-close";
    closeBtn.setAttribute("aria-label", "Close");
    closeBtn.innerHTML =
      '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
    closeBtn.addEventListener("click", close);
    header.appendChild(h);
    header.appendChild(closeBtn);
    panelEl.appendChild(header);

    // ---- Approval status ----
    const info = statusInfo(approval.status);
    const statusRow = document.createElement("div");
    statusRow.className = "cb-bands-status";
    const badge = document.createElement("span");
    badge.className = `cb-bands-badge ${info.cls}`;
    badge.textContent = info.label;
    statusRow.appendChild(badge);
    const avg = document.createElement("span");
    avg.className = "cb-bands-avg";
    avg.textContent =
      `${contractYears}-yr avg: ${int(approval.avgCredits)} cr \u00b7 ${int(approval.avgActions)} act`;
    statusRow.appendChild(avg);
    panelEl.appendChild(statusRow);

    if (approval.reasons && approval.reasons.length) {
      const reasons = document.createElement("ul");
      reasons.className = "cb-bands-reasons";
      for (const r of approval.reasons) {
        const li = document.createElement("li");
        li.textContent = r;
        reasons.appendChild(li);
      }
      panelEl.appendChild(reasons);
    }

    // ---- Bands tables ----
    const creditSet = pricing && pricing.enterpriseCreditFloors && pricing.enterpriseCreditFloors();
    const actionSet = pricing && pricing.enterpriseActionFloors && pricing.enterpriseActionFloors();
    panelEl.appendChild(
      buildBandsTable("Credit bands (per credit)", creditSet, approval.creditTier, approval.creditFloors, contractYears, cpc),
    );
    panelEl.appendChild(
      buildBandsTable("Action bands (per action)", actionSet, approval.actionTier, approval.actionFloors, contractYears, cpa),
    );
  }

  function refresh() {
    if (isOpen()) render();
  }

  __cb.pricingBands = { toggle, close, refresh, isOpen };
})();
