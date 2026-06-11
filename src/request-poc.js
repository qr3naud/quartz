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
 * Lifecycle: once a request exists for the workbook the modal opens in SUBMIT
 * mode — the request folds into a summary and the SE completes the POC
 * (comments + Loom), which posts in the request's Slack thread and appends a
 * "POC submitted" line to the original message (poc-request-complete edge
 * function via cb:pocrequest:complete). The Slack message's Claim button is
 * handled server-side by poc-slack-interact. "Re-request" in the header
 * reopens the blank request form.
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
    if (window.__cb.closeSfdcPickerPanel) window.__cb.closeSfdcPickerPanel();
    if (modalEl) { modalEl.remove(); modalEl = null; }
    if (backdropEl) { backdropEl.remove(); backdropEl = null; }
    document.removeEventListener("keydown", onKeydown);
  }
  __cb.closeRequestPocModal = close;

  function onKeydown(evt) {
    if (evt.key !== "Escape") return;
    evt.stopPropagation();
    // The captain picker's results panel traps Escape first; only then does
    // Escape close the modal.
    if (window.__cb.sfdcPickerPanelOpen && window.__cb.sfdcPickerPanelOpen()) {
      window.__cb.closeSfdcPickerPanel();
      return;
    }
    close();
  }

  function money(n) {
    const num = Number(n);
    if (!isFinite(num) || num <= 0) return "";
    return "$" + Math.round(num).toLocaleString();
  }

  // Lifecycle: open (requested) -> claimed (SE clicked Claim in Slack) ->
  // submitted (SE completed the POC from this modal's submit mode).
  function statusBadge(status) {
    if (status === "submitted") return { label: "Submitted", bg: "#dcfce7", fg: "#15803d" };
    if (status === "claimed") return { label: "Claimed", bg: "#dbeafe", fg: "#1d4ed8" };
    return { label: "Open", bg: "#f1f5f9", fg: "#475569" };
  }

  function fmtWhen(iso) {
    if (!iso) return "";
    try { return new Date(iso).toLocaleString(); } catch { return iso; }
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

  // opts.forceRequest skips the existing-request probe so the "Re-request"
  // header action can reopen the blank request form even when a request for
  // this workbook already exists.
  __cb.startRequestPoc = function startRequestPoc(opts) {
    const forceRequest = !!(opts && opts.forceRequest);
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

    // SE Captains — a list of { name, email }. Seeded by auto-resolving the
    // requester's SFDC manager via the poc-captain edge function
    // (cb:poccaptain:get); the rep can remove chips, search-tag a captain when
    // none resolved, or add more via the rounded "+" (SFDC user typeahead from
    // captain-map.js's shared picker). The full list is sent on submit
    // (se_captains); an empty list means "tag nobody".
    let seCaptains = [];          // [{ name, email }]
    let seCaptainLoading = true;  // true until the auto-resolve call settles
    let seCaptainAutoFound = false; // auto-resolve produced a captain
    let seCaptainAdding = false;  // the "+" inline search is open

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
    modalEl.className = "cb-export-modal cb-gtme-modal cb-poc-modal";

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
    // No inner max-height/scroll: the expanded group always shows all rows.
    // The outer modal body (.cb-export-modal-body, overflow:auto) scrolls when
    // the whole modal outgrows 88vh, with the header/footer staying pinned.
    prefillBody.style.cssText =
      "display:flex;flex-direction:column;gap:14px;padding:14px 12px 18px;border-top:1px solid #e5e7eb;background:#ffffff;";

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

    // SE Captain — auto-derived from the requester's manager in Salesforce,
    // shown as removable chips. When none resolves the slot is a search bar;
    // once populated a rounded "+" adds more via the same typeahead. (Custom
    // field wrapper, not buildField, so the buttons aren't inside a <label>.)
    const captainSlot = document.createElement("div");
    captainSlot.className = "cb-poc-captain-slot";
    const captainField = document.createElement("div");
    captainField.className = "cb-gtme-field cb-gtme-field-grow";
    const captainLabel = document.createElement("span");
    captainLabel.className = "cb-gtme-field-label";
    captainLabel.textContent = "SE Captain";
    captainField.appendChild(captainLabel);
    captainField.appendChild(captainSlot);
    body.appendChild(captainField);

    function captainInitials(nm) {
      const parts = String(nm || "").trim().split(/\s+/).filter(Boolean);
      if (!parts.length) return "?";
      if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
      return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
    }

    function captainKey(c) {
      return (c.email || c.name || "").trim().toLowerCase();
    }

    function addCaptain(rec) {
      const captain = { name: rec.name, email: rec.email || null };
      if (!captain.name) return;
      const key = captainKey(captain);
      if (!seCaptains.some((c) => captainKey(c) === key)) seCaptains.push(captain);
      seCaptainAdding = false;
      renderCaptainSlot();
    }

    // The shared SFDC user typeahead (captain-map.js). `inline` is the small
    // picker that the "+" button swaps into; it collapses back to "+" when it
    // loses focus without a pick.
    function buildCaptainPicker({ inline } = {}) {
      if (!__cb.buildSfdcUserPicker) return null;
      const picker = __cb.buildSfdcUserPicker({
        placeholder: "Search SE Captain\u2026",
        onPick: addCaptain,
      });
      picker.el.classList.add(inline ? "cb-poc-captain-picker-inline" : "cb-poc-captain-picker");
      if (inline) {
        const input = picker.el.querySelector("input");
        if (input) {
          input.addEventListener("blur", () => {
            // Delay so a result's mousedown pick can land first.
            setTimeout(() => {
              if (seCaptainAdding) { seCaptainAdding = false; renderCaptainSlot(); }
            }, 150);
          });
        }
      }
      return picker;
    }

    function buildCaptainChip(captain, idx) {
      // Avatar initials + name + remove. Avatars become real once captains are
      // Quartz users; initials stand in until then.
      const chip = document.createElement("span");
      chip.className = "cb-poc-captain-chip";
      const avatar = document.createElement("span");
      avatar.className = "cb-poc-captain-avatar";
      avatar.textContent = captainInitials(captain.name);
      const nameEl = document.createElement("span");
      nameEl.className = "cb-poc-captain-name";
      nameEl.textContent = captain.name;
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "cb-poc-captain-remove";
      remove.setAttribute("aria-label", "Remove SE Captain");
      remove.innerHTML =
        '<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
      remove.addEventListener("click", () => {
        seCaptains.splice(idx, 1);
        renderCaptainSlot();
      });
      chip.appendChild(avatar);
      chip.appendChild(nameEl);
      chip.appendChild(remove);
      return chip;
    }

    function renderCaptainSlot() {
      if (__cb.closeSfdcPickerPanel) __cb.closeSfdcPickerPanel();
      captainSlot.innerHTML = "";
      if (seCaptainLoading) {
        const hint = document.createElement("span");
        hint.className = "cb-poc-captain-empty";
        hint.textContent = "Resolving from Salesforce\u2026";
        captainSlot.appendChild(hint);
        return;
      }
      if (!seCaptains.length) {
        // Empty: a full-width search bar to tag a captain directly.
        if (!seCaptainAutoFound) {
          const hint = document.createElement("span");
          hint.className = "cb-poc-captain-empty";
          hint.textContent = "No SE Captain mapped for your manager \u2014 search to tag one.";
          captainSlot.appendChild(hint);
        }
        const picker = buildCaptainPicker({ inline: false });
        if (picker) captainSlot.appendChild(picker.el);
        return;
      }
      // Populated: wrapping chip row + a rounded "+" that swaps into an inline
      // search (no permanent search bar under the chips).
      const row = document.createElement("div");
      row.className = "cb-poc-captain-row";
      seCaptains.forEach((c, idx) => row.appendChild(buildCaptainChip(c, idx)));
      if (seCaptainAdding) {
        const picker = buildCaptainPicker({ inline: true });
        if (picker) {
          row.appendChild(picker.el);
          setTimeout(() => picker.focus(), 0);
        }
      } else if (__cb.buildSfdcUserPicker) {
        const add = document.createElement("button");
        add.type = "button";
        add.className = "cb-poc-captain-add";
        add.setAttribute("aria-label", "Add another SE Captain");
        add.title = "Add another SE Captain";
        add.innerHTML =
          '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>';
        add.addEventListener("click", () => { seCaptainAdding = true; renderCaptainSlot(); });
        row.appendChild(add);
      }
      captainSlot.appendChild(row);
    }
    renderCaptainSlot();

    // Resolve the captain in the background; the modal opens immediately.
    sendMessage({ type: "cb:poccaptain:get" }).then((resp) => {
      seCaptainLoading = false;
      const c = resp && resp.ok && resp.data && resp.data.ok ? resp.data.captain : null;
      if (c && c.name) {
        seCaptainAutoFound = true;
        seCaptains = [{ name: c.name, email: c.email || null }];
      }
      renderCaptainSlot();
    }).catch(() => { seCaptainLoading = false; renderCaptainSlot(); });

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
      if (!workbookId) {
        recentList.innerHTML = "";
        recentList.textContent = "No requests yet.";
        recentList.style.opacity = ".7";
        return;
      }
      try {
        const rows = await supa.supabaseFetch("poc_requests", "GET", {
          query: {
            workbook_id: `eq.${workbookId}`,
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
          // The picked captains travel with the request; an empty list means
          // "tag nobody" (se_captain_optout keeps older servers working).
          se_captains: seCaptains.map((c) => ({ name: c.name, email: c.email || null })),
          se_captain_optout: seCaptains.length === 0,
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

    // ---- Submit mode -------------------------------------------------------
    // Once a request exists for this workbook the modal flips into completion
    // mode: the request folds into a collapsed summary, and the SE gets a
    // comments + Loom form whose Submit posts the completion in the request's
    // Slack thread and appends a "POC submitted" line to the original message.
    // The header keeps a "Re-request" action that reopens the blank form.

    function summaryRow(label, value) {
      const row = document.createElement("div");
      row.style.cssText = "display:flex;gap:10px;font-size:12.5px;line-height:1.5;";
      const l = document.createElement("span");
      l.style.cssText = "flex:0 0 110px;font-weight:600;color:#374151;";
      l.textContent = label;
      const v = document.createElement("span");
      v.style.cssText = "flex:1;min-width:0;color:#1f2937;overflow-wrap:anywhere;";
      if (value instanceof Node) v.appendChild(value); else v.textContent = value || "—";
      row.appendChild(l);
      row.appendChild(v);
      return row;
    }

    function buildSubmitMode(reqRow) {
      if (!modalEl) return;
      modalEl.innerHTML = "";

      let sComments = "";
      let sLoom = "";
      let sSubmitting = false;

      // Header — title + status, with Re-request next to close.
      const sHeader = document.createElement("div");
      sHeader.className = "cb-export-modal-header";
      const sTitleWrap = document.createElement("div");
      sTitleWrap.className = "cb-export-modal-title-wrap";
      const sTitle = document.createElement("h2");
      sTitle.className = "cb-export-modal-title";
      sTitle.textContent = "POC request";
      const sSubtitle = document.createElement("div");
      sSubtitle.className = "cb-export-modal-subtitle";
      sSubtitle.textContent =
        "A POC was already requested for this workbook. Submit the completed POC below.";
      sTitleWrap.appendChild(sTitle);
      sTitleWrap.appendChild(sSubtitle);
      const reRequestBtn = document.createElement("button");
      reRequestBtn.type = "button";
      reRequestBtn.className = "cb-modal-btn cb-modal-btn-ghost";
      reRequestBtn.style.cssText = "height:30px;padding:0 12px;font-size:12.5px;flex:0 0 auto;";
      reRequestBtn.textContent = "Re-request";
      reRequestBtn.title = "Send a new POC request for this workbook";
      reRequestBtn.addEventListener("click", () => {
        __cb.startRequestPoc({ forceRequest: true });
      });
      const sCloseBtn = document.createElement("button");
      sCloseBtn.type = "button";
      sCloseBtn.className = "cb-export-modal-close";
      sCloseBtn.setAttribute("aria-label", "Close");
      sCloseBtn.innerHTML =
        '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
      sCloseBtn.addEventListener("click", close);
      sHeader.appendChild(sTitleWrap);
      sHeader.appendChild(reRequestBtn);
      sHeader.appendChild(sCloseBtn);

      // Body
      const sBody = document.createElement("div");
      sBody.className = "cb-export-modal-body cb-gtme-body";

      // Folded request summary.
      const fold = document.createElement("details");
      fold.style.cssText =
        "border:1px solid #e5e7eb;border-radius:8px;background:#f9fafb;overflow:hidden;";
      const foldSummary = document.createElement("summary");
      foldSummary.style.cssText =
        "cursor:pointer;padding:10px 12px;font-size:12px;font-weight:600;color:#374151;user-select:none;display:flex;align-items:center;gap:8px;";
      const sb = statusBadge(reqRow.status);
      const foldBadge = document.createElement("span");
      foldBadge.textContent = sb.label;
      foldBadge.style.cssText =
        `font-size:11px;font-weight:600;padding:1px 7px;border-radius:999px;background:${sb.bg};color:${sb.fg};flex:0 0 auto;`;
      const foldText = document.createElement("span");
      foldText.style.cssText = "flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";
      foldText.textContent =
        `POC request — ${reqRow.account_name || "—"}` +
        (reqRow.needed_by ? ` · by ${reqRow.needed_by}` : "") +
        " (tap for details)";
      foldSummary.appendChild(foldBadge);
      foldSummary.appendChild(foldText);
      fold.appendChild(foldSummary);

      const foldBody = document.createElement("div");
      foldBody.style.cssText =
        "display:flex;flex-direction:column;gap:8px;padding:12px;border-top:1px solid #e5e7eb;background:#ffffff;";
      foldBody.appendChild(summaryRow("Requested by", reqRow.requester_name));
      foldBody.appendChild(summaryRow("Requested at", fmtWhen(reqRow.created_at)));
      foldBody.appendChild(summaryRow("Needed by", reqRow.needed_by));
      if (reqRow.claimed_at) {
        foldBody.appendChild(summaryRow(
          "Claimed",
          `${reqRow.claimed_by_name || "—"} · ${fmtWhen(reqRow.claimed_at)}`,
        ));
      }
      if (reqRow.submitted_at) {
        foldBody.appendChild(summaryRow(
          "Submitted",
          `${reqRow.submitted_by_name || "—"} · ${fmtWhen(reqRow.submitted_at)}`,
        ));
      }
      if (reqRow.slack_permalink) {
        const a = document.createElement("a");
        a.href = reqRow.slack_permalink;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        a.textContent = "Open the Slack thread";
        a.style.cssText = "color:#4338ca;font-weight:600;text-decoration:none;";
        foldBody.appendChild(summaryRow("Slack", a));
      }
      fold.appendChild(foldBody);
      sBody.appendChild(fold);

      if (reqRow.status === "submitted") {
        const note = document.createElement("div");
        note.style.cssText =
          "font-size:12.5px;color:#15803d;background:#dcfce7;border-radius:8px;padding:8px 12px;";
        note.textContent =
          "This POC was already submitted — submitting again posts another update in the thread.";
        sBody.appendChild(note);
      }

      // Completion fields.
      const sCommentsInput = document.createElement("textarea");
      sCommentsInput.className = "cb-gtme-input";
      sCommentsInput.rows = 3;
      sCommentsInput.style.cssText =
        "width:100%;height:auto;min-height:76px;padding:8px 10px;resize:vertical;line-height:1.45;";
      sCommentsInput.placeholder = "What was built, where to look, anything the requester should know…";
      sCommentsInput.addEventListener("input", () => { sComments = sCommentsInput.value; });
      sBody.appendChild(buildField("Completion notes", sCommentsInput, { grow: true }));

      const sLoomInput = buildInput("", "https://www.loom.com/share/…");
      sLoomInput.addEventListener("input", () => { sLoom = sLoomInput.value; });
      sBody.appendChild(buildField("Loom (optional)", sLoomInput, { grow: true }));

      const sErrorEl = document.createElement("div");
      sErrorEl.className = "cb-gtme-error";
      sErrorEl.style.display = "none";
      sBody.appendChild(sErrorEl);

      // Footer
      const sFooter = document.createElement("div");
      sFooter.className = "cb-modal-footer";
      const sHint = document.createElement("div");
      sHint.className = "cb-export-modal-footer-hint";
      sHint.textContent = "Posts in the request's Slack thread and updates the original message.";
      const sActions = document.createElement("div");
      sActions.className = "cb-modal-footer-actions";
      const sCancel = document.createElement("button");
      sCancel.type = "button";
      sCancel.className = "cb-modal-btn cb-modal-btn-ghost";
      sCancel.textContent = "Cancel";
      sCancel.addEventListener("click", close);
      const sSubmit = document.createElement("button");
      sSubmit.type = "button";
      sSubmit.className = "cb-modal-btn cb-modal-btn-primary";
      sSubmit.textContent = "Submit POC";
      sSubmit.addEventListener("click", async () => {
        if (sSubmitting) return;
        sSubmitting = true;
        sSubmit.disabled = true;
        sSubmit.style.opacity = ".5";
        sSubmit.textContent = "Submitting…";
        sErrorEl.style.display = "none";
        const resp = await sendMessage({
          type: "cb:pocrequest:complete",
          body: {
            request_id: reqRow.id,
            comments: sComments.trim(),
            loom_url: sLoom.trim(),
          },
        });
        if (resp && resp.ok && resp.data && resp.data.ok) {
          sSubmit.textContent = "Submitted ✓";
          setTimeout(() => { close(); }, 1200);
        } else {
          sSubmitting = false;
          sSubmit.disabled = false;
          sSubmit.style.opacity = "1";
          sSubmit.textContent = "Submit POC";
          const detail = resp?.data?.error || resp?.error || `HTTP ${resp?.status || "?"}`;
          sErrorEl.textContent = `Could not submit: ${detail}`;
          sErrorEl.style.display = "";
        }
      });
      sActions.appendChild(sCancel);
      sActions.appendChild(sSubmit);
      sFooter.appendChild(sHint);
      sFooter.appendChild(sActions);

      modalEl.appendChild(sHeader);
      modalEl.appendChild(sBody);
      modalEl.appendChild(sFooter);
      sCommentsInput.focus();
    }

    // Probe for an existing request for this workbook; a hit flips the modal
    // into submit mode (unless this open was an explicit re-request).
    if (!forceRequest && workbookId) {
      (async () => {
        const supa = window.__cbSupabase;
        if (!supa) return;
        try {
          const rows = await supa.supabaseFetch("poc_requests", "GET", {
            query: {
              workbook_id: `eq.${workbookId}`,
              select:
                "id,account_name,requester_name,needed_by,status,created_at," +
                "claimed_at,claimed_by_name,submitted_at,submitted_by_name,slack_permalink",
              order: "created_at.desc",
              limit: "1",
            },
          });
          if (rows && rows.length && modalEl) buildSubmitMode(rows[0]);
        } catch (err) {
          console.warn("[Clay Scoping] existing POC request probe failed:", err);
        }
      })();
    }
  };
})();
