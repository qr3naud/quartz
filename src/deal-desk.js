/**
 * Deal-desk submission modal (internal-only).
 *
 * Builds a pricing submission from the scoping tabs and sends it to the
 * deal-desk Slack app via the deal-desk-submit Edge Function (through the
 * service worker, message type "cb:dealdesk:submit"). Each checked tab becomes
 * one config: we compute year-1 volumes + costs (rep-adjusted price, else the
 * list-price fallback in __cb.pricing) and the approval status from the
 * internal pricing floors (__cb.pricing.approvalFor). The function records a
 * pending row per config; the approve/reject decision flows back via the
 * approval-callback function and surfaces here under "Recent submissions".
 *
 * Reuses the cb-export-modal / cb-gtme-* styles from styles/export.css for
 * layout; a few small inline styles cover the approval badges + status list.
 */
(function () {
  "use strict";

  const __cb = (window.__cb = window.__cb || {});

  let modalEl = null;
  let backdropEl = null;

  function sendMessage(payload) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(payload, (resp) => {
          if (chrome.runtime.lastError) {
            resolve({ ok: false, error: chrome.runtime.lastError.message });
            return;
          }
          resolve(resp || { ok: false, error: "no response" });
        });
      } catch (e) {
        resolve({ ok: false, error: String(e) });
      }
    });
  }

  function close() {
    if (modalEl) { modalEl.remove(); modalEl = null; }
    if (backdropEl) { backdropEl.remove(); backdropEl = null; }
    document.removeEventListener("keydown", onKeydown);
  }
  __cb.closeDealDeskModal = close;

  function onKeydown(evt) {
    if (evt.key === "Escape") { evt.stopPropagation(); close(); }
  }

  function fmt(n) {
    return Number.isFinite(n) ? n.toLocaleString() : "0";
  }
  function money(n) {
    return "$" + Math.round(Number(n) || 0).toLocaleString();
  }

  // Approval status -> {label, color} for the inline badge. Mirrors the
  // calculator's getApprovalStatusLabel / badge variants.
  function approvalBadge(status) {
    if (status === "pending_exception") return { label: "Deal desk approval", bg: "#fee2e2", fg: "#b91c1c" };
    if (status === "pending_standard") return { label: "Manager approval", bg: "#ffedd5", fg: "#c2410c" };
    return { label: "Auto-approved", bg: "#dcfce7", fg: "#15803d" };
  }

  function statusBadge(status) {
    if (status === "approved") return { label: "Approved", bg: "#dcfce7", fg: "#15803d" };
    if (status === "rejected") return { label: "Rejected", bg: "#fee2e2", fg: "#b91c1c" };
    return { label: "Pending", bg: "#f1f5f9", fg: "#475569" };
  }

  // Builds one WebhookConfig from a tab + its computed volumes.
  function buildConfig(tab, volumes, justification) {
    const pricing = __cb.pricing;
    const listCpc = pricing ? pricing.LIST_CPC : 0.05;
    const listCpa = pricing ? pricing.LIST_CPA : 0.0083;
    const creditPrice = volumes.creditPrice != null ? volumes.creditPrice : listCpc;
    const actionPrice = volumes.actionPrice != null ? volumes.actionPrice : listCpa;
    const creditCost = Math.round(volumes.creditsPerYear * creditPrice);
    const actionCost = Math.round(volumes.actionsPerYear * actionPrice);
    const acv = creditCost + actionCost;

    const approval = pricing && pricing.approvalFor
      ? pricing.approvalFor({
          creditsPerYear: volumes.creditsPerYear,
          actionsPerYear: volumes.actionsPerYear,
          contractYears: 1,
          creditPrice: volumes.creditPrice != null ? volumes.creditPrice : undefined,
          actionPrice: volumes.actionPrice != null ? volumes.actionPrice : undefined,
        })
      : { status: null, reasons: [] };

    const config = {
      config_id:
        (crypto && crypto.randomUUID && crypto.randomUUID()) ||
        `cfg_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
      config_name: tab.name || "Scoping",
      years: [
        {
          year: 1,
          credits: volumes.creditsPerYear,
          actions: volumes.actionsPerYear,
          credit_cost: creditCost,
          action_cost: actionCost,
          acv,
          // Projected estimate vs Actual measured spend (per-tab), so the deal
          // desk knows the basis of the submitted volumes.
          basis: volumes.mode || "projected",
        },
      ],
      approval_required: approval.status,
      approval_details: { status: approval.status, reasons: approval.reasons },
      rep_justification: approval.status ? (justification || null) : null,
    };
    return { config, approval, acv };
  }

  async function fetchRecentSubmissions(workbookId) {
    const supa = window.__cbSupabase;
    if (!supa || !workbookId) return [];
    try {
      const rows = await supa.supabaseFetch("deal_desk_submissions", "GET", {
        query: {
          workbook_id: `eq.${workbookId}`,
          select: "config_id,config_name,account_name,status,approved_by,slack_permalink,updated_at",
          order: "updated_at.desc",
          limit: "10",
        },
      });
      return rows || [];
    } catch (err) {
      console.warn("[Clay Scoping] failed to load deal-desk submissions:", err?.message || err);
      return [];
    }
  }

  __cb.openDealDeskModal = function openDealDeskModal() {
    close();
    if (__cb.saveTabs) __cb.saveTabs();

    const workbookId = __cb.currentWorkbookId || null;
    const workspaceId = __cb.currentWorkspaceId || null;
    const linkedOpp = (__cb.sfdc && __cb.sfdc.getLinkedOpportunity && __cb.sfdc.getLinkedOpportunity()) || null;

    const visibleTabs = (__cb.tabStore?.tabs || []).filter((t) => !t.hidden);
    const activeTabId = __cb.tabStore?.activeId;

    const rowState = new Map();
    for (const tab of visibleTabs) {
      rowState.set(tab.id, {
        tab,
        checked: tab.id === activeTabId,
        volumes: __cb.computeTabVolumes
          ? __cb.computeTabVolumes(tab.state)
          : { creditsPerYear: 0, actionsPerYear: 0, creditPrice: null, actionPrice: null },
      });
    }

    let customerName = linkedOpp?.name || "";
    let channel = "";
    let justification = "";
    let submitting = false;

    backdropEl = document.createElement("div");
    backdropEl.className = "cb-export-modal-backdrop";
    backdropEl.addEventListener("mousedown", (evt) => {
      if (evt.target === backdropEl) close();
    });

    modalEl = document.createElement("div");
    modalEl.className = "cb-export-modal cb-gtme-modal";

    // ---- Header ----
    const header = document.createElement("div");
    header.className = "cb-export-modal-header";
    const titleWrap = document.createElement("div");
    titleWrap.className = "cb-export-modal-title-wrap";
    const title = document.createElement("h2");
    title.className = "cb-export-modal-title";
    title.textContent = "Submit to deal desk";
    const subtitle = document.createElement("div");
    subtitle.className = "cb-export-modal-subtitle";
    subtitle.textContent = "Posts each checked tab as a pricing config to the deal-desk Slack channel for approval.";
    titleWrap.appendChild(title);
    titleWrap.appendChild(subtitle);
    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "cb-export-modal-close";
    closeBtn.setAttribute("aria-label", "Close");
    closeBtn.innerHTML =
      '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
    closeBtn.addEventListener("click", close);
    header.appendChild(titleWrap);
    header.appendChild(closeBtn);

    // ---- Body ----
    const body = document.createElement("div");
    body.className = "cb-export-modal-body cb-gtme-body";

    // Customer + channel fields.
    const fieldsRow = document.createElement("div");
    fieldsRow.className = "cb-gtme-fields";

    const nameField = document.createElement("label");
    nameField.className = "cb-gtme-field cb-gtme-field-grow";
    const nameLabel = document.createElement("span");
    nameLabel.className = "cb-gtme-field-label";
    nameLabel.textContent = "Customer / account name";
    const nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.className = "cb-gtme-input";
    nameInput.placeholder = "e.g. Acme Corp";
    nameInput.autocomplete = "off";
    nameInput.value = customerName;
    nameInput.addEventListener("input", () => { customerName = nameInput.value; updateSubmitState(); });
    nameField.appendChild(nameLabel);
    nameField.appendChild(nameInput);

    const channelField = document.createElement("label");
    channelField.className = "cb-gtme-field";
    const channelLabel = document.createElement("span");
    channelLabel.className = "cb-gtme-field-label";
    channelLabel.textContent = "Slack channel (optional)";
    const channelInput = document.createElement("input");
    channelInput.type = "text";
    channelInput.className = "cb-gtme-input";
    channelInput.placeholder = "default deal-desk";
    channelInput.autocomplete = "off";
    channelInput.addEventListener("input", () => { channel = channelInput.value; });
    channelField.appendChild(channelLabel);
    channelField.appendChild(channelInput);

    fieldsRow.appendChild(nameField);
    fieldsRow.appendChild(channelField);
    body.appendChild(fieldsRow);

    if (linkedOpp?.id) {
      const oppNote = document.createElement("div");
      oppNote.className = "cb-gtme-tabs-hint";
      oppNote.style.cssText = "margin:-4px 0 8px;";
      oppNote.textContent = `Linked opportunity: ${linkedOpp.name || linkedOpp.id} (sent with the submission)`;
      body.appendChild(oppNote);
    }

    // Tabs to submit.
    const tabsHeader = document.createElement("div");
    tabsHeader.className = "cb-gtme-tabs-header";
    const tabsTitle = document.createElement("div");
    tabsTitle.className = "cb-gtme-tabs-title";
    tabsTitle.textContent = "Configs to submit";
    const tabsHint = document.createElement("div");
    tabsHint.className = "cb-gtme-tabs-hint";
    tabsHint.textContent = "Each checked tab posts as one config with its approval level.";
    tabsHeader.appendChild(tabsTitle);
    tabsHeader.appendChild(tabsHint);
    body.appendChild(tabsHeader);

    const tabsContainer = document.createElement("div");
    tabsContainer.className = "cb-gtme-tabs";
    body.appendChild(tabsContainer);

    function renderTabs() {
      tabsContainer.innerHTML = "";
      if (visibleTabs.length === 0) {
        const empty = document.createElement("div");
        empty.className = "cb-export-empty";
        empty.textContent = "No scoping tabs to submit. Create one first.";
        tabsContainer.appendChild(empty);
        return;
      }
      for (const tab of visibleTabs) {
        const row = rowState.get(tab.id);
        const { config, approval, acv } = buildConfig(tab, row.volumes, justification);
        row._config = config;

        const item = document.createElement("label");
        item.className = "cb-gtme-tab-row" + (row.checked ? " cb-gtme-tab-row-checked" : "");

        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.checked = row.checked;
        cb.addEventListener("change", () => {
          row.checked = cb.checked;
          item.classList.toggle("cb-gtme-tab-row-checked", cb.checked);
          updateSubmitState();
        });

        const meta = document.createElement("div");
        meta.className = "cb-gtme-tab-meta";
        meta.style.cssText = "flex:1;min-width:0;";
        const nm = document.createElement("div");
        nm.className = "cb-gtme-tab-name";
        nm.textContent = tab.name || "Scoping";
        const stats = document.createElement("div");
        stats.className = "cb-gtme-tab-stats";
        const modeTag = row.volumes.mode === "actual" ? " · Actual" : " · Projected";
        stats.textContent =
          `${fmt(row.volumes.creditsPerYear)} credits / yr · ${fmt(row.volumes.actionsPerYear)} actions / yr · ${money(acv)} ACV${modeTag}`;
        meta.appendChild(nm);
        meta.appendChild(stats);
        if (approval.status && approval.reasons.length) {
          const why = document.createElement("div");
          why.className = "cb-gtme-tab-stats";
          why.style.cssText = "opacity:.75;";
          why.textContent = approval.reasons[0];
          why.title = approval.reasons.join("\n");
          meta.appendChild(why);
        }

        const badgeInfo = approvalBadge(approval.status);
        const badge = document.createElement("span");
        badge.textContent = badgeInfo.label;
        badge.style.cssText =
          `flex:0 0 auto;align-self:center;font-size:11px;font-weight:600;padding:2px 8px;border-radius:999px;background:${badgeInfo.bg};color:${badgeInfo.fg};`;

        item.appendChild(cb);
        item.appendChild(meta);
        item.appendChild(badge);
        tabsContainer.appendChild(item);
      }
    }

    // Rep justification (used for any config that needs approval).
    const justField = document.createElement("label");
    justField.className = "cb-gtme-field cb-gtme-field-grow";
    justField.style.cssText = "display:block;margin-top:10px;";
    const justLabel = document.createElement("span");
    justLabel.className = "cb-gtme-field-label";
    justLabel.textContent = "Justification (shown to approvers when approval is needed)";
    const justInput = document.createElement("textarea");
    justInput.className = "cb-gtme-input";
    justInput.rows = 3;
    justInput.style.cssText = "width:100%;resize:vertical;";
    justInput.placeholder = "Why this pricing? e.g. competitive deal, strategic logo…";
    justInput.addEventListener("input", () => { justification = justInput.value; });
    justField.appendChild(justLabel);
    justField.appendChild(justInput);
    body.appendChild(justField);

    // Recent submissions for this workbook.
    const recentWrap = document.createElement("div");
    recentWrap.style.cssText = "margin-top:14px;";
    const recentTitle = document.createElement("div");
    recentTitle.className = "cb-gtme-tabs-title";
    recentTitle.textContent = "Recent submissions";
    const recentList = document.createElement("div");
    recentList.style.cssText = "margin-top:6px;display:flex;flex-direction:column;gap:4px;";
    recentList.textContent = "Loading…";
    recentList.style.opacity = ".7";
    recentWrap.appendChild(recentTitle);
    recentWrap.appendChild(recentList);
    body.appendChild(recentWrap);

    async function refreshRecent() {
      const rows = await fetchRecentSubmissions(workbookId);
      recentList.innerHTML = "";
      recentList.style.opacity = "1";
      if (!rows.length) {
        recentList.textContent = "No submissions yet.";
        recentList.style.opacity = ".7";
        return;
      }
      for (const r of rows) {
        const line = document.createElement("div");
        line.style.cssText = "display:flex;align-items:center;gap:8px;font-size:12px;";
        const sb = statusBadge(r.status);
        const chip = document.createElement("span");
        chip.textContent = sb.label;
        chip.style.cssText =
          `font-size:11px;font-weight:600;padding:1px 7px;border-radius:999px;background:${sb.bg};color:${sb.fg};`;
        const label = document.createElement("span");
        label.style.cssText = "flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";
        label.textContent = `${r.config_name || "Config"} — ${r.account_name || ""}`
          + (r.approved_by ? ` · ${r.approved_by}` : "");
        line.appendChild(chip);
        line.appendChild(label);
        if (r.slack_permalink) {
          const a = document.createElement("a");
          a.href = r.slack_permalink;
          a.target = "_blank";
          a.rel = "noopener noreferrer";
          a.textContent = "Slack";
          a.style.cssText = "color:#2563eb;text-decoration:none;flex:0 0 auto;";
          line.appendChild(a);
        }
        recentList.appendChild(line);
      }
    }

    // ---- Footer ----
    const footer = document.createElement("div");
    footer.className = "cb-export-modal-footer";
    const errorEl = document.createElement("div");
    errorEl.className = "cb-gtme-error";
    errorEl.style.display = "none";
    body.appendChild(errorEl);

    const footerActions = document.createElement("div");
    footerActions.className = "cb-export-footer-actions";
    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.className = "cb-export-modal-done";
    cancelBtn.textContent = "Cancel";
    cancelBtn.addEventListener("click", close);
    const submitBtn = document.createElement("button");
    submitBtn.type = "button";
    submitBtn.className = "cb-export-submit";
    submitBtn.textContent = "Submit";
    submitBtn.addEventListener("click", onSubmit);
    footerActions.appendChild(cancelBtn);
    footerActions.appendChild(submitBtn);
    footer.appendChild(footerActions);

    function showError(msg) { errorEl.textContent = msg; errorEl.style.display = ""; }
    function clearError() { errorEl.textContent = ""; errorEl.style.display = "none"; }

    function selectedRows() {
      return visibleTabs.map((t) => rowState.get(t.id)).filter((r) => r.checked);
    }

    function updateSubmitState() {
      const ok = !submitting && customerName.trim() && selectedRows().length > 0;
      submitBtn.disabled = !ok;
      submitBtn.style.opacity = ok ? "1" : ".5";
    }

    async function onSubmit() {
      if (submitting) return;
      const rows = selectedRows();
      if (!customerName.trim() || rows.length === 0) return;
      submitting = true;
      updateSubmitState();
      submitBtn.textContent = "Submitting…";
      clearError();

      // Rebuild configs now so the latest justification is attached.
      const configs = rows.map((r) => buildConfig(r.tab, r.volumes, justification).config);
      const account = { name: customerName.trim() };
      if (linkedOpp?.id) {
        account.sfdc_opportunity_id = linkedOpp.id;
        if (linkedOpp.name) account.sfdc_opportunity_name = linkedOpp.name;
        if (linkedOpp.url) account.sfdc_opportunity_url = linkedOpp.url;
      }

      const resp = await sendMessage({
        type: "cb:dealdesk:submit",
        body: {
          account,
          configs,
          channel: channel.trim() || undefined,
          workbookId,
          workspaceId,
        },
      });

      submitting = false;
      submitBtn.textContent = "Submit";
      updateSubmitState();

      if (resp && resp.ok) {
        submitBtn.textContent = "Submitted ✓";
        refreshRecent();
        setTimeout(() => { submitBtn.textContent = "Submit"; }, 2500);
      } else {
        const detail = resp?.data?.error || resp?.error || `HTTP ${resp?.status || "?"}`;
        showError(`Submission failed: ${detail}`);
      }
    }

    modalEl.appendChild(header);
    modalEl.appendChild(body);
    modalEl.appendChild(footer);
    // The modal must be a CHILD of the backdrop: .cb-export-modal-backdrop is a
    // full-viewport flex container that centers its child, and .cb-export-modal
    // has no positioning of its own. Appending them as siblings leaves the
    // backdrop covering the page (swallowing clicks) with the modal lost in
    // normal flow. Stop propagation so clicks inside never reach the backdrop's
    // click-outside-to-close handler.
    modalEl.addEventListener("mousedown", (evt) => evt.stopPropagation());
    backdropEl.appendChild(modalEl);
    document.body.appendChild(backdropEl);
    document.addEventListener("keydown", onKeydown);

    renderTabs();
    updateSubmitState();
    nameInput.focus();
    // Warm pricing + load recent submissions.
    if (__cb.pricing && __cb.pricing.load) __cb.pricing.load().then(renderTabs).catch(() => {});
    refreshRecent();
  };
})();
