/**
 * "Request POC" modal (internal-only, gated by the gtme_export feature flag in
 * src/overlay.js's More menu).
 *
 * Collects a short POC request — requester, customer/account, ARR estimate,
 * the POC scoping doc (the workbook deep-link with #cb-open so it opens Quartz),
 * the SFDC opportunity link, comments, an optional Loom, and a due date — and
 * sends it to the poc-request-submit Edge Function (through the service worker,
 * message type "cb:pocrequest:submit"). The function posts a one-way message to
 * the Slack channel configured in app_settings.poc_request_channel and records
 * the request (plus the Slack message handle) in public.poc_requests.
 *
 * Prefill sources (all already available to the extension):
 *   - requester name  -> __cb.user.name
 *   - customer + ARR  -> linked SFDC opportunity (accountName / amount), async
 *   - workspace id    -> __cb.currentWorkspaceId (from the URL)
 *   - scoping doc     -> workbook URL + #cb-open
 *   - SFDC opp link   -> __cb.sfdc.getLinkedOpportunity().url
 *
 * Reuses the cb-export-modal / cb-gtme-* styles from styles/export.css.
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
  __cb.closeRequestPocModal = close;

  function onKeydown(evt) {
    if (evt.key === "Escape") { evt.stopPropagation(); close(); }
  }

  function money(n) {
    const num = Number(n);
    if (!isFinite(num) || num <= 0) return "";
    return "$" + Math.round(num).toLocaleString();
  }

  function statusBadge(status) {
    if (status === "scheduled") return { label: "Scheduled", bg: "#dcfce7", fg: "#15803d" };
    if (status === "claimed") return { label: "Claimed", bg: "#dbeafe", fg: "#1d4ed8" };
    return { label: "Open", bg: "#f1f5f9", fg: "#475569" };
  }

  // Builds a labelled field (label + control) using the shared gtme classes.
  function buildField(labelText, control, { grow = false } = {}) {
    const field = document.createElement("label");
    field.className = "cb-gtme-field" + (grow ? " cb-gtme-field-grow" : "");
    const label = document.createElement("span");
    label.className = "cb-gtme-field-label";
    label.textContent = labelText;
    field.appendChild(label);
    field.appendChild(control);
    return field;
  }

  function buildInput(value, placeholder, type = "text") {
    const input = document.createElement("input");
    input.type = type;
    input.className = "cb-gtme-input";
    input.autocomplete = "off";
    if (placeholder) input.placeholder = placeholder;
    if (value) input.value = value;
    return input;
  }

  // Resume the Request POC "done" state on canvas open: a prior request for
  // this workbook lives in public.poc_requests (workbook_id is stamped on every
  // submit, see onSubmit below). A matching row flips the guided rail's Request
  // POC step to done via __cb.setRequestPocDone. RLS scopes the read to the
  // user's workspaces.
  __cb.hydrateRequestPocState = async function (workbookId) {
    if (!workbookId) return;
    const supa = window.__cbSupabase;
    if (!supa) return;
    try {
      const rows = await supa.supabaseFetch("poc_requests", "GET", {
        query: { workbook_id: `eq.${workbookId}`, select: "id", limit: "1" },
      });
      if (rows && rows.length) __cb.setRequestPocDone?.(true);
    } catch (err) {
      console.warn("[Clay Scoping] failed to hydrate request POC state:", err);
    }
  };

  __cb.startRequestPoc = function startRequestPoc() {
    close();
    if (__cb.saveTabs) { try { __cb.saveTabs(); } catch {} }

    const ids = __cb.parseIdsFromUrl ? __cb.parseIdsFromUrl() : null;
    const workspaceId = __cb.currentWorkspaceId || ids?.workspaceId || "";
    const workbookId = __cb.currentWorkbookId || ids?.workbookId || "";
    const workbookUrl =
      workspaceId && workbookId
        ? `https://app.clay.com/workspaces/${workspaceId}/workbooks/${workbookId}/#cb-open`
        : (location.href.split("#")[0] + "#cb-open");
    const linkedOpp =
      (__cb.sfdc && __cb.sfdc.getLinkedOpportunity && __cb.sfdc.getLinkedOpportunity()) || null;

    // Working state (mutated by input listeners; sent on submit).
    let name = __cb.user?.name || "";
    let account = linkedOpp?.name || "";
    let arr = "";
    let sfdcUrl = linkedOpp?.url || "";
    let comments = "";
    let loom = "";
    let neededBy = "";
    let submitting = false;

    // Track whether the rep edited a prefillable field, so the async SFDC
    // hydrate below never clobbers something they typed.
    let accountTouched = false;
    let arrTouched = false;
    let sfdcTouched = false;

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
    title.textContent = "Request a POC";
    const subtitle = document.createElement("div");
    subtitle.className = "cb-export-modal-subtitle";
    subtitle.textContent = "Sends a request to the POC team in Slack with the scoping context.";
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

    // Inputs are created up front so the async SFDC hydrate (below) can target
    // them regardless of where they sit in the layout.
    const nameInput = buildInput(name, "Your name");
    nameInput.addEventListener("input", () => { name = nameInput.value; });

    const accountInput = buildInput(account, "e.g. Acme Corp");
    accountInput.addEventListener("input", () => {
      account = accountInput.value; accountTouched = true; updateSubmitState();
    });

    const arrInput = buildInput(arr, "best estimate, e.g. $250,000");
    arrInput.addEventListener("input", () => { arr = arrInput.value; arrTouched = true; });

    const wsInput = buildInput(workspaceId, "");
    wsInput.readOnly = true;
    wsInput.style.opacity = "0.7";

    const docInput = buildInput(workbookUrl, "link to the workbook");
    docInput.style.textOverflow = "ellipsis";

    const sfdcInput = buildInput(sfdcUrl, "link to the SFDC opportunity");
    sfdcInput.style.textOverflow = "ellipsis";
    sfdcInput.addEventListener("input", () => { sfdcUrl = sfdcInput.value; sfdcTouched = true; });

    // Prefilled group — collapsed by default. Everything we could derive from
    // the workbook + linked SFDC opp lives here, so the rep's eye lands on the
    // fields that actually need input (due date, comments, Loom). Laid out as
    // two equal columns per row; the body scrolls internally so the expanded
    // group never blows out the modal height.
    const prefill = document.createElement("details");
    prefill.style.cssText =
      "border:1px solid #e5e7eb;border-radius:8px;background:#f9fafb;overflow:hidden;";
    const prefillSummary = document.createElement("summary");
    prefillSummary.style.cssText =
      "cursor:pointer;padding:10px 12px;font-size:12px;font-weight:600;color:#374151;user-select:none;";
    prefillSummary.textContent = "Prefilled details — name, customer, ARR, links (tap to edit)";
    prefill.appendChild(prefillSummary);

    const prefillBody = document.createElement("div");
    prefillBody.style.cssText =
      "display:flex;flex-direction:column;gap:14px;padding:12px;max-height:200px;overflow-y:auto;border-top:1px solid #e5e7eb;background:#ffffff;";

    // Each row is two equal-weight columns (both fields grow from a 0 basis).
    const row1 = document.createElement("div");
    row1.className = "cb-gtme-fields";
    row1.appendChild(buildField("Your name", nameInput, { grow: true }));
    row1.appendChild(buildField("Customer name", accountInput, { grow: true }));

    const row2 = document.createElement("div");
    row2.className = "cb-gtme-fields";
    row2.appendChild(buildField("ARR (best estimate)", arrInput, { grow: true }));
    row2.appendChild(buildField("Workspace ID", wsInput, { grow: true }));

    const row3 = document.createElement("div");
    row3.className = "cb-gtme-fields";
    row3.appendChild(buildField("Quartz Link", docInput, { grow: true }));
    row3.appendChild(buildField("SFDC opportunity", sfdcInput, { grow: true }));

    prefillBody.appendChild(row1);
    prefillBody.appendChild(row2);
    prefillBody.appendChild(row3);
    prefill.appendChild(prefillBody);
    body.appendChild(prefill);

    // Always-visible: the fields that need the rep's input.
    const dateInput = buildInput("", "", "date");
    dateInput.addEventListener("input", () => { neededBy = dateInput.value; updateSubmitState(); });
    body.appendChild(buildField("When do you need this by?", dateInput, { grow: true }));

    const commentsInput = document.createElement("textarea");
    commentsInput.className = "cb-gtme-input";
    commentsInput.rows = 3;
    // cb-gtme-input sets height:36px / padding:0 10px (tuned for one-line
    // inputs); override both so the textarea reads as a roomy multi-line box
    // with comfortable text padding.
    commentsInput.style.cssText =
      "width:100%;height:auto;min-height:76px;padding:8px 10px;resize:vertical;line-height:1.45;";
    commentsInput.placeholder = "Anything the POC team should know…";
    commentsInput.addEventListener("input", () => { comments = commentsInput.value; });
    body.appendChild(buildField("Comments", commentsInput, { grow: true }));

    const loomInput = buildInput("", "https://www.loom.com/share/…");
    loomInput.addEventListener("input", () => { loom = loomInput.value; });
    body.appendChild(buildField("Loom (optional)", loomInput, { grow: true }));

    // Async SFDC hydrate: fill customer + ARR (+ SFDC link) from the linked
    // opportunity unless the rep already edited those fields.
    if (linkedOpp?.id && __cb.sfdc && __cb.sfdc.getOpportunity) {
      __cb.sfdc.getOpportunity(linkedOpp.id).then((opp) => {
        if (!opp) return;
        if (!accountTouched && opp.accountName) {
          account = opp.accountName; accountInput.value = account;
        }
        if (!arrTouched && opp.amount != null) {
          const m = money(opp.amount);
          if (m) { arr = m; arrInput.value = m; }
        }
        if (!sfdcTouched && opp.url && !sfdcInput.value) {
          sfdcUrl = opp.url; sfdcInput.value = opp.url;
        }
        updateSubmitState();
      }).catch(() => {});
    }

    // Recent requests for this workbook (internal read of poc_requests).
    const recentWrap = document.createElement("div");
    recentWrap.style.cssText = "margin-top:14px;";
    const recentTitle = document.createElement("div");
    recentTitle.className = "cb-gtme-tabs-title";
    recentTitle.textContent = "Recent requests";
    const recentList = document.createElement("div");
    recentList.style.cssText = "margin-top:6px;display:flex;flex-direction:column;gap:4px;opacity:.7;";
    recentList.textContent = "Loading…";
    recentWrap.appendChild(recentTitle);
    recentWrap.appendChild(recentList);
    body.appendChild(recentWrap);

    async function refreshRecent() {
      const supa = window.__cbSupabase;
      if (!supa) { recentList.textContent = ""; return; }
      try {
        const rows = await supa.supabaseFetch("poc_requests", "GET", {
          query: {
            select: "account_name,requester_name,needed_by,status,slack_permalink,created_at",
            order: "created_at.desc",
            limit: "8",
          },
        });
        recentList.innerHTML = "";
        recentList.style.opacity = "1";
        if (!rows || !rows.length) {
          recentList.textContent = "No requests yet.";
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
          label.textContent =
            `${r.account_name || "—"}` +
            (r.needed_by ? ` · by ${r.needed_by}` : "") +
            (r.requester_name ? ` · ${r.requester_name}` : "");
          line.appendChild(chip);
          line.appendChild(label);
          if (r.slack_permalink) {
            const a = document.createElement("a");
            a.href = r.slack_permalink;
            a.target = "_blank";
            a.rel = "noopener noreferrer";
            a.textContent = "Slack";
            a.style.cssText =
              "flex:0 0 auto;display:inline-flex;align-items:center;height:20px;padding:0 8px;border:1px solid #e0e7ff;border-radius:999px;background:#eef2ff;color:#4338ca;font-size:11px;font-weight:600;text-decoration:none;";
            line.appendChild(a);
          }
          recentList.appendChild(line);
        }
      } catch (err) {
        recentList.textContent = "";
      }
    }

    // ---- Footer ----
    const errorEl = document.createElement("div");
    errorEl.className = "cb-gtme-error";
    errorEl.style.display = "none";
    body.appendChild(errorEl);

    const footer = document.createElement("div");
    footer.className = "cb-modal-footer";
    const footerHint = document.createElement("div");
    footerHint.className = "cb-export-modal-footer-hint";
    footerHint.textContent = "Posts to the POC team's Slack channel.";
    const footerActions = document.createElement("div");
    footerActions.className = "cb-modal-footer-actions";
    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.className = "cb-modal-btn cb-modal-btn-ghost";
    cancelBtn.textContent = "Cancel";
    cancelBtn.addEventListener("click", close);
    const submitBtn = document.createElement("button");
    submitBtn.type = "button";
    submitBtn.className = "cb-modal-btn cb-modal-btn-primary";
    submitBtn.textContent = "Send request";
    submitBtn.addEventListener("click", onSubmit);
    footerActions.appendChild(cancelBtn);
    footerActions.appendChild(submitBtn);
    footer.appendChild(footerHint);
    footer.appendChild(footerActions);

    function showError(msg) { errorEl.textContent = msg; errorEl.style.display = ""; }
    function clearError() { errorEl.textContent = ""; errorEl.style.display = "none"; }

    function updateSubmitState() {
      const ok = !submitting && account.trim() && neededBy;
      submitBtn.disabled = !ok;
      submitBtn.style.opacity = ok ? "1" : ".5";
    }

    async function onSubmit() {
      if (submitting) return;
      if (!account.trim() || !neededBy) return;
      submitting = true;
      updateSubmitState();
      submitBtn.textContent = "Sending…";
      clearError();

      const resp = await sendMessage({
        type: "cb:pocrequest:submit",
        body: {
          requester_name: name.trim(),
          account_name: account.trim(),
          arr_estimate: arr.trim(),
          workspace_id: workspaceId,
          workbook_id: workbookId,
          workbook_url: docInput.value.trim(),
          sfdc_opportunity_url: sfdcUrl.trim(),
          comments: comments.trim(),
          loom_url: loom.trim(),
          needed_by: neededBy || null,
        },
      });

      submitting = false;
      updateSubmitState();

      if (resp && resp.ok && resp.data && resp.data.ok) {
        submitBtn.textContent = "Sent ✓";
        // Flip the guided rail's Request POC step to done now that the Slack
        // message is sent (hydrateRequestPocState restores this on reopen).
        __cb.setRequestPocDone?.(true);
        refreshRecent();
        setTimeout(() => { close(); }, 1200);
      } else {
        submitBtn.textContent = "Send request";
        const detail =
          resp?.data?.error || resp?.error || `HTTP ${resp?.status || "?"}`;
        showError(`Could not send: ${detail}`);
      }
    }

    modalEl.appendChild(header);
    modalEl.appendChild(body);
    modalEl.appendChild(footer);
    // The modal must be a CHILD of the backdrop (see deal-desk.js for the why).
    modalEl.addEventListener("mousedown", (evt) => evt.stopPropagation());
    backdropEl.appendChild(modalEl);
    document.body.appendChild(backdropEl);
    document.addEventListener("keydown", onKeydown);

    updateSubmitState();
    accountInput.focus();
    refreshRecent();
  };
})();
