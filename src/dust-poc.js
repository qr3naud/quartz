(function () {
  "use strict";

  const __cb = window.__cb;

  // ---------------------------------------------------------------------------
  // Generate POC (Dust integration)
  //
  // Kicks off a Dust agent that auto-generates a POC scoping doc for a
  // customer from their Gong calls, emails, etc. — a 5-10 minute job. Two
  // entry points:
  //   - Manual: the topbar "Generate POC" button opens a popover that
  //     explains the flow and takes a customer name.
  //   - Auto: linking a Salesforce opportunity fires generation with the
  //     opportunity name (see src/sfdc.js → linkCanvasToOpportunity). The
  //     toolbar button's icon spins while the job runs; no popover is forced
  //     open so it doesn't interrupt the linking flow.
  //
  // After creating the conversation we poll it (cb:dust:getConversation →
  // dust-proxy GET /conversations) until the agent finishes, then extract
  // the generated Google Doc link from its reply and surface it.
  //
  // Persistence: the conversation id/url + status + doc link live on the
  // canvases row (dust_* columns, Phase-3 migration). That lets an in-flight
  // POC resume its poller after a reload and lets a finished doc show up for
  // any collaborator who opens the same canvas.
  //
  // Pre-JWT history: every rep used to paste their own Dust API key into a
  // first-run prompt, cached in localStorage. We now hold a single shared key
  // server-side in the dust-proxy Edge Function (gated by the Phase-1 Clay
  // JWT + internal-workspace whitelist), so the popover skips straight to
  // the customer-name form.
  //
  // Gating: ships to every install (internal + public). The public entry
  // points are only registered for users whose JWT carries the `dust`
  // feature flag — see publishApi at the bottom. The toolbar button that
  // invokes them is also feature-gated in src/overlay.js.
  // ---------------------------------------------------------------------------

  const DUST_WORKSPACE_ID = "5b990f8923";
  const DUST_AGENT_ID = "4CEcga0fGM";
  // Canonical Dust conversation URL — verified empirically against the
  // create-conversation response payload, which returns
  //   "url": "https://app.dust.tt/w/{wId}/conversation/{sId}".
  // We use the response's url field when present and fall back to this
  // pattern only if the API ever stops including it.
  const DUST_APP_BASE_URL = "https://app.dust.tt";

  // Poll cadence + ceiling. The agent typically takes 5-10 minutes; we poll
  // every 15s and give up after 20 minutes so a stuck job doesn't poll
  // forever. Tunable in one place.
  const POLL_INTERVAL_MS = 15 * 1000;
  const POLL_MAX_MS = 20 * 60 * 1000;

  // One-shot cleanup: an earlier version of this file cached a per-rep Dust
  // API key in localStorage. The key has been moved server-side; remove the
  // stale entry on first load so old localStorage doesn't accumulate.
  try {
    localStorage.removeItem("cb-dust-api-key");
  } catch {
    // Storage may be disabled in some embedded contexts; non-critical.
  }

  let popoverEl = null;
  let backdropEl = null;
  let anchorRef = null;

  // Live POC state for the current canvas. Mirrors the dust_* columns on the
  // canvases row so the popover can render without a round-trip. `status` is
  // one of: null (never run) | "generating" | "done" | "error".
  let pocState = {
    status: null,
    conversationId: null,
    conversationUrl: null,
    docUrl: null,
    customerName: "",
    error: null,
  };

  // Active poller handle + the deadline it should stop at. Kept module-level
  // so a manual re-open doesn't spawn a second loop and closeCanvas can stop
  // it cleanly.
  let pollTimer = null;
  let pollDeadline = 0;

  // ---- Popover plumbing -----------------------------------------------------

  function closePopover() {
    if (popoverEl) {
      popoverEl.remove();
      popoverEl = null;
    }
    if (backdropEl) {
      backdropEl.remove();
      backdropEl = null;
    }
    anchorRef = null;
    document.removeEventListener("keydown", onKeydown);
  }

  function onKeydown(evt) {
    if (evt.key === "Escape") {
      evt.preventDefault();
      closePopover();
    }
  }

  function positionPopover() {
    if (!popoverEl || !anchorRef) return;
    const rect = anchorRef.getBoundingClientRect();
    popoverEl.style.top = rect.bottom + 4 + "px";
    // Right-align the popover with the button so it doesn't slide off the
    // right edge of the topbar (the button sits in the right action group).
    const width = popoverEl.offsetWidth || 320;
    const left = Math.max(8, rect.right - width);
    popoverEl.style.left = left + "px";
  }

  function openPopover(anchorEl) {
    closePopover();

    anchorRef = anchorEl;

    backdropEl = document.createElement("div");
    backdropEl.className = "cb-dust-poc-backdrop";
    backdropEl.addEventListener("click", closePopover);

    popoverEl = document.createElement("div");
    popoverEl.className = "cb-dust-poc-popover";
    popoverEl.addEventListener("click", (evt) => evt.stopPropagation());

    document.body.appendChild(backdropEl);
    document.body.appendChild(popoverEl);
    document.addEventListener("keydown", onKeydown);

    renderPopover();
    positionPopover();
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  // ---- Rendering ------------------------------------------------------------
  //
  // The popover is fully state-driven: whatever pocState says, renderPopover
  // paints. Manual generation, the auto path, and a hydrated reload all
  // funnel through the same states.

  function renderPopover() {
    if (!popoverEl) return;
    popoverEl.innerHTML = "";

    if (pocState.status === "generating") {
      renderGenerating();
    } else if (pocState.status === "done") {
      renderDone();
    } else if (pocState.status === "error") {
      renderError();
    } else {
      renderForm();
    }

    positionPopover();
  }

  function appendTitle(text) {
    const title = document.createElement("div");
    title.className = "cb-dust-poc-title";
    title.textContent = text;
    popoverEl.appendChild(title);
    return title;
  }

  function dustLinkHtml(label) {
    const url = pocState.conversationUrl;
    if (!url) return "";
    return `<a class="cb-dust-poc-link" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a>`;
  }

  // Idle / initial form — the informative copy + customer-name input.
  function renderForm() {
    appendTitle("Generate POC");

    const sub = document.createElement("div");
    sub.className = "cb-dust-poc-sub";
    sub.innerHTML =
      "Auto-generates a POC scoping doc from this customer\u2019s Gong calls, " +
      "emails, and other context in Dust. This usually takes " +
      "<strong>5\u201310 minutes</strong> \u2014 you can keep working while it runs.";
    popoverEl.appendChild(sub);

    const label = document.createElement("div");
    label.className = "cb-dust-poc-field-label";
    label.textContent = "Customer name";
    popoverEl.appendChild(label);

    const input = document.createElement("input");
    input.type = "text";
    input.className = "cb-dust-poc-input";
    input.placeholder = "e.g. Acme Inc";
    input.autocomplete = "off";
    if (pocState.customerName) input.value = pocState.customerName;
    popoverEl.appendChild(input);

    const status = document.createElement("div");
    status.className = "cb-dust-poc-status";
    popoverEl.appendChild(status);

    const footer = document.createElement("div");
    footer.className = "cb-dust-poc-footer";

    const sendBtn = document.createElement("button");
    sendBtn.type = "button";
    sendBtn.className = "cb-dust-poc-btn cb-dust-poc-btn-primary";
    sendBtn.textContent = "Generate";
    sendBtn.addEventListener("click", () => {
      const customerName = input.value.trim();
      if (!customerName) {
        setStatus(status, "error", "Enter a customer name to continue.");
        input.focus();
        return;
      }
      startPocGeneration({ customerName });
    });

    input.addEventListener("keydown", (evt) => {
      if (evt.key === "Enter") {
        evt.preventDefault();
        sendBtn.click();
      }
    });

    footer.appendChild(sendBtn);

    popoverEl.appendChild(footer);

    setTimeout(() => input.focus(), 0);
  }

  // Generating — spinner + reassurance + a link into the Dust conversation.
  function renderGenerating() {
    appendTitle("Generating POC\u2026");

    const body = document.createElement("div");
    body.className = "cb-dust-poc-progress";
    body.innerHTML =
      '<span class="cb-dust-poc-progress-spinner" aria-hidden="true"></span>' +
      "<span>Pulling Gong calls, emails, and context to draft the scoping " +
      "doc. This usually takes <strong>5\u201310 minutes</strong> \u2014 " +
      "leave this open or check back later.</span>";
    popoverEl.appendChild(body);

    if (pocState.customerName) {
      const who = document.createElement("div");
      who.className = "cb-dust-poc-sub";
      who.innerHTML = `Customer: <strong>${escapeHtml(pocState.customerName)}</strong>`;
      popoverEl.appendChild(who);
    }

    const link = dustLinkHtml("Follow along in Dust");
    if (link) {
      const linkRow = document.createElement("div");
      linkRow.className = "cb-dust-poc-status cb-dust-poc-status-info";
      linkRow.innerHTML = link;
      popoverEl.appendChild(linkRow);
    }
  }

  // Done — prominent Google Doc link (falls back to the Dust conversation if
  // we couldn't pull a doc URL out of the reply).
  function renderDone() {
    appendTitle("POC ready");

    if (pocState.docUrl) {
      const docRow = document.createElement("div");
      docRow.className = "cb-dust-poc-doc";
      docRow.innerHTML =
        '<svg class="cb-dust-poc-doc-icon" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="9" y1="13" x2="15" y2="13"/><line x1="9" y1="17" x2="15" y2="17"/></svg>' +
        `<a class="cb-dust-poc-doc-link" href="${escapeHtml(pocState.docUrl)}" target="_blank" rel="noopener noreferrer">Open POC scoping doc</a>`;
      popoverEl.appendChild(docRow);
    } else {
      const note = document.createElement("div");
      note.className = "cb-dust-poc-sub";
      note.innerHTML =
        "The agent finished but didn\u2019t return a Google Doc link. " +
        (dustLinkHtml("Open the conversation in Dust") || "Open it in Dust to review.");
      popoverEl.appendChild(note);
    }

    if (pocState.docUrl) {
      const dustRow = document.createElement("div");
      dustRow.className = "cb-dust-poc-status cb-dust-poc-status-info";
      dustRow.innerHTML = dustLinkHtml("View the Dust conversation");
      if (dustRow.innerHTML) popoverEl.appendChild(dustRow);
    }

    appendRegenerateFooter();
  }

  // Error — message + a retry button + the Dust link for manual inspection.
  function renderError() {
    appendTitle("POC generation failed");

    const msg = document.createElement("div");
    msg.className = "cb-dust-poc-status cb-dust-poc-status-error";
    msg.textContent = pocState.error || "Something went wrong while generating the POC.";
    popoverEl.appendChild(msg);

    const link = dustLinkHtml("Open the conversation in Dust");
    if (link) {
      const linkRow = document.createElement("div");
      linkRow.className = "cb-dust-poc-status cb-dust-poc-status-info";
      linkRow.innerHTML = link;
      popoverEl.appendChild(linkRow);
    }

    appendRegenerateFooter();
  }

  // Shared footer for the done/error states: a button that drops back to the
  // input form so the rep can regenerate (e.g. after fixing the customer
  // name or if the first run failed).
  function appendRegenerateFooter() {
    const footer = document.createElement("div");
    footer.className = "cb-dust-poc-footer";

    const againBtn = document.createElement("button");
    againBtn.type = "button";
    againBtn.className = "cb-dust-poc-btn cb-dust-poc-btn-primary";
    againBtn.textContent = "Generate again";
    againBtn.addEventListener("click", () => {
      // Reset to the form but keep the customer name as a convenience.
      pocState = {
        status: null,
        conversationId: null,
        conversationUrl: null,
        docUrl: null,
        customerName: pocState.customerName || "",
        error: null,
      };
      renderPopover();
    });

    footer.appendChild(againBtn);
    popoverEl.appendChild(footer);
  }

  function setStatus(statusEl, kind, html) {
    statusEl.className = `cb-dust-poc-status cb-dust-poc-status-${kind}`;
    statusEl.innerHTML = html;
  }

  // ---- Dust messaging -------------------------------------------------------

  function buildContext() {
    let timezone = "UTC";
    try {
      timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    } catch {
      // Defensive: very old browsers may not expose resolvedOptions(); fall
      // back to UTC so the API still accepts the request.
    }
    const user = __cb.user || {};
    const ctx = {
      username: user.email || "clay-scoping-extension",
      timezone,
    };
    if (user.name) ctx.fullName = user.name;
    if (user.email) ctx.email = user.email;
    return ctx;
  }

  // Route the HTTP call through the background service worker, which forwards
  // to the dust-proxy Edge Function (with the JWT). The Edge Function holds
  // the shared Dust API key and workspace ID server-side.
  function sendViaBackground(type, payload) {
    return new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage({ type, ...payload }, (response) => {
          const lastError = chrome.runtime.lastError;
          if (lastError) {
            reject(new Error(lastError.message || "Extension messaging failed."));
            return;
          }
          if (!response) {
            reject(new Error("No response from background worker."));
            return;
          }
          resolve(response);
        });
      } catch (err) {
        reject(err);
      }
    });
  }

  // Dust's API error envelopes vary: most non-2xx responses come back as
  // `{ error: { type, message } }` but some routes return a string or an
  // empty body. Squeeze whatever's there into a human-readable string so
  // the popover surfaces something useful instead of "null".
  function extractErrorDetail(response) {
    if (!response) return "";
    if (response.error) return String(response.error);
    if (response.data) {
      const e = response.data.error;
      if (e && typeof e === "object" && e.message) {
        return e.type ? `${e.type}: ${e.message}` : String(e.message);
      }
      if (typeof e === "string") return e;
      try {
        return JSON.stringify(response.data).slice(0, 240);
      } catch {
        return "";
      }
    }
    if (response.rawText) return response.rawText.slice(0, 240);
    return "";
  }

  // ---- Persistence ----------------------------------------------------------

  // PATCH the dust_* columns on the current canvas row. Best-effort: a failed
  // write logs a warning but never blocks the UI (the in-memory pocState is
  // the source of truth for the live session; persistence is for reloads and
  // collaborators).
  async function persistPocState(patch) {
    const workbookId = __cb.currentWorkbookId;
    const supa = window.__cbSupabase;
    if (!workbookId || !supa) return;
    try {
      await supa.supabaseFetch("canvases", "PATCH", {
        query: { workbook_id: `eq.${workbookId}` },
        body: { ...patch, updated_at: new Date().toISOString() },
      });
    } catch (err) {
      console.warn("[Clay Scoping] failed to persist POC state:", err);
    }
  }

  // ---- Reply parsing --------------------------------------------------------

  // Dust returns the conversation as { conversation: { content: Msg[][] } }
  // where each inner array is the version history of one message; the last
  // element is the latest version. We flatten to latest-per-message and,
  // defensively, also accept a flat `messages` array in case the shape ever
  // changes.
  function collectMessages(conversation) {
    if (!conversation || typeof conversation !== "object") return [];
    const content = conversation.content;
    if (Array.isArray(content)) {
      const out = [];
      for (const versions of content) {
        if (Array.isArray(versions) && versions.length) {
          out.push(versions[versions.length - 1]);
        } else if (versions && typeof versions === "object") {
          out.push(versions);
        }
      }
      if (out.length) return out;
    }
    if (Array.isArray(conversation.messages)) return conversation.messages;
    return [];
  }

  function latestAgentMessage(messages) {
    let found = null;
    for (const m of messages) {
      if (m && m.type === "agent_message") found = m;
    }
    return found;
  }

  // Pull the first Google Docs / Drive URL out of the agent's reply text.
  // The agent embeds the generated doc as a markdown link; we accept either
  // docs.google.com or drive.google.com and strip common trailing
  // punctuation/markdown delimiters.
  function extractDocUrl(text) {
    if (!text || typeof text !== "string") return null;
    const re = /https?:\/\/(?:docs|drive)\.google\.com\/[^\s)\]"'<>]+/i;
    const m = text.match(re);
    if (!m) return null;
    return m[0].replace(/[.,;]+$/, "");
  }

  // ---- Generation + polling -------------------------------------------------

  // Kicks off a POC generation: creates the Dust conversation, persists the
  // "generating" state, flips the toolbar button into its spinner, and starts
  // polling. Safe to call whether or not the popover is open (the auto path
  // from SFDC linking calls it without a popover).
  async function startPocGeneration({ customerName, auto = false }) {
    const name = (customerName || "").trim();
    if (!name) {
      // Manual path validates before calling; this guards the auto path.
      console.warn("[Clay Scoping] startPocGeneration called without a name");
      return;
    }

    // Don't launch a duplicate 5-10 min job if one is already running for
    // this canvas (e.g. re-linking the same opportunity).
    if (pocState.status === "generating") {
      if (!auto && popoverEl) renderPopover();
      return;
    }

    pocState = {
      status: "generating",
      conversationId: null,
      conversationUrl: null,
      docUrl: null,
      customerName: name,
      error: null,
    };
    setButtonLoading(true);
    if (popoverEl) renderPopover();

    let response;
    try {
      response = await sendViaBackground("cb:dust:createConversation", {
        body: {
          title: `POC: ${name}`,
          blocking: false,
          message: {
            content: name,
            mentions: [{ configurationId: DUST_AGENT_ID }],
            context: buildContext(),
          },
        },
      });
    } catch (err) {
      failPoc(err?.message || "Failed to create the Dust conversation.");
      return;
    }

    if (response.status === 401 || response.status === 403) {
      const detail = extractErrorDetail(response);
      failPoc(
        response.status === 401
          ? `Auth rejected (401): ${detail || "JWT invalid or expired — reload the page."}`
          : `Forbidden (403): ${detail || "your Clay workspace isn't on the internal allow-list."}`,
      );
      return;
    }

    if (!response.ok) {
      console.warn("[Clay Scoping] Dust non-OK response:", response);
      failPoc(
        `Dust returned ${response.status || "error"}${response.statusText ? ` ${response.statusText}` : ""}: ${extractErrorDetail(response) || "(empty body — see service worker console)"}`,
      );
      return;
    }

    const conversation = response.data?.conversation;
    const sId = conversation?.sId;
    if (!sId) {
      failPoc("Dust response missing conversation.sId.");
      return;
    }

    const url =
      typeof conversation.url === "string" && conversation.url
        ? conversation.url
        : `${DUST_APP_BASE_URL}/w/${DUST_WORKSPACE_ID}/conversation/${sId}`;

    pocState.conversationId = sId;
    pocState.conversationUrl = url;
    if (popoverEl) renderPopover();

    await persistPocState({
      dust_conversation_id: sId,
      dust_conversation_url: url,
      dust_poc_status: "generating",
      dust_poc_doc_url: null,
      dust_poc_started_at: new Date().toISOString(),
    });

    startPolling();
  }

  // Stops the active poller (if any). Idempotent — safe to call from
  // closeCanvas and from the success/failure paths.
  function stopPolling() {
    if (pollTimer) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
  }
  __cb.stopPocPolling = stopPolling;

  function startPolling() {
    stopPolling();
    pollDeadline = Date.now() + POLL_MAX_MS;
    // First poll after one interval — the agent has had no time to produce
    // anything at t=0.
    pollTimer = setTimeout(pollOnce, POLL_INTERVAL_MS);
  }

  async function pollOnce() {
    pollTimer = null;
    // Bail if state changed out from under us (e.g. canvas closed, manual
    // regenerate reset, or a different conversation took over).
    if (pocState.status !== "generating" || !pocState.conversationId) return;

    if (Date.now() > pollDeadline) {
      failPoc(
        "POC is taking longer than expected. " +
          "Check the conversation in Dust — it may still finish.",
      );
      return;
    }

    const conversationId = pocState.conversationId;
    let response;
    try {
      response = await sendViaBackground("cb:dust:getConversation", { conversationId });
    } catch (err) {
      // Transient (SW asleep, network blip) — keep polling.
      console.warn("[Clay Scoping] POC poll failed, will retry:", err);
      scheduleNextPoll();
      return;
    }

    // Conversation may have rolled over / state changed while awaiting.
    if (pocState.status !== "generating" || pocState.conversationId !== conversationId) {
      return;
    }

    if (!response.ok) {
      // Non-OK responses (502 from proxy, transient Dust errors) → retry
      // until the deadline rather than failing the whole run.
      console.warn("[Clay Scoping] POC poll non-OK:", response.status);
      scheduleNextPoll();
      return;
    }

    const conversation = response.data?.conversation;
    const messages = collectMessages(conversation);
    const agent = latestAgentMessage(messages);

    if (agent) {
      const status = agent.status;
      if (status === "succeeded") {
        const docUrl = extractDocUrl(agent.content);
        completePoc(docUrl);
        return;
      }
      if (status === "failed" || status === "cancelled") {
        const detail =
          (agent.error && (agent.error.message || agent.error.type)) ||
          "The Dust agent reported an error.";
        failPoc(String(detail));
        return;
      }
      // status is "created" / still streaming → keep polling.
    }

    scheduleNextPoll();
  }

  function scheduleNextPoll() {
    if (pocState.status !== "generating") return;
    pollTimer = setTimeout(pollOnce, POLL_INTERVAL_MS);
  }

  function completePoc(docUrl) {
    stopPolling();
    pocState.status = "done";
    pocState.docUrl = docUrl || null;
    pocState.error = null;
    setButtonLoading(false);
    if (popoverEl) renderPopover();
    persistPocState({
      dust_poc_status: "done",
      dust_poc_doc_url: docUrl || null,
    });
  }

  // Moves the run into the error state. We leave conversationId/url intact:
  // for poll/timeout failures the conversation exists and the error UI's
  // "Open in Dust" link stays useful; for creation failures it was never set.
  function failPoc(message) {
    stopPolling();
    pocState.status = "error";
    pocState.error = message;
    setButtonLoading(false);
    if (popoverEl) renderPopover();
    persistPocState({ dust_poc_status: "error" });
  }

  // Toolbar spinner toggle — overlay.js owns the button and exposes this.
  function setButtonLoading(on) {
    if (__cb.setDustPocButtonLoading) __cb.setDustPocButtonLoading(on);
  }

  // ---- Hydration ------------------------------------------------------------

  // Reads the dust_* columns for the current canvas on open. If a POC is
  // mid-flight, resumes the spinner + poller; if one finished, caches the
  // doc link so opening the popover shows it instantly.
  async function hydratePocState(workbookId) {
    if (!workbookId) return;
    const supa = window.__cbSupabase;
    if (!supa) return;
    try {
      const rows = await supa.supabaseFetch("canvases", "GET", {
        query: {
          workbook_id: `eq.${workbookId}`,
          select:
            "dust_conversation_id,dust_conversation_url,dust_poc_status,dust_poc_doc_url,dust_poc_started_at",
          limit: "1",
        },
      });
      const row = rows?.[0];
      if (!row || !row.dust_poc_status) return;

      pocState = {
        status: row.dust_poc_status,
        conversationId: row.dust_conversation_id || null,
        conversationUrl: row.dust_conversation_url || null,
        docUrl: row.dust_poc_doc_url || null,
        customerName: pocState.customerName || "",
        error: null,
      };

      if (row.dust_poc_status === "generating" && row.dust_conversation_id) {
        // Resume polling from where the previous session left off. Anchor the
        // deadline to the original start time so a long-dead job times out
        // promptly rather than getting a fresh 20-minute lease.
        setButtonLoading(true);
        const startedMs = row.dust_poc_started_at
          ? Date.parse(row.dust_poc_started_at)
          : Date.now();
        if (Number.isFinite(startedMs) && Date.now() - startedMs > POLL_MAX_MS) {
          failPoc(
            "POC is taking longer than expected. " +
              "Check the conversation in Dust — it may still finish.",
          );
        } else {
          stopPolling();
          pollDeadline = (Number.isFinite(startedMs) ? startedMs : Date.now()) + POLL_MAX_MS;
          pollTimer = setTimeout(pollOnce, POLL_INTERVAL_MS);
        }
      }
    } catch (err) {
      console.warn("[Clay Scoping] failed to hydrate POC state:", err);
    }
  }

  // Resets all POC state. Called by overlay.js's closeCanvas so a fresh
  // canvas doesn't inherit the previous one's spinner/poller.
  function resetPocState() {
    stopPolling();
    pocState = {
      status: null,
      conversationId: null,
      conversationUrl: null,
      docUrl: null,
      customerName: "",
      error: null,
    };
  }
  __cb.resetPocState = resetPocState;

  // ---- Public API -----------------------------------------------------------

  // Only exposed for users whose JWT carries the `dust` feature flag. On a
  // cold load (no cached JWT), hasFeature returns false synchronously, so we
  // also re-check after __cb.supabaseJwtReady resolves. The toolbar button in
  // src/overlay.js performs the same check before injecting the entry that
  // invokes startDustPoc.
  function publishApi() {
    // Manual entry: open the popover anchored under the toolbar button.
    __cb.startDustPoc = function (anchorEl) {
      openPopover(anchorEl);
    };

    // Auto entry: fired from SFDC linking. Kicks off generation in the
    // background (spinner on the toolbar button) without forcing the popover
    // open, so it doesn't interrupt the linking flow. The rep clicks the
    // button to watch progress.
    __cb.startDustPocForOpportunity = function (opportunityName) {
      startPocGeneration({ customerName: opportunityName, auto: true });
    };

    // Called by overlay.js on canvas open to resume an in-flight / finished
    // POC. No-op when the dust feature is off (the function isn't published).
    __cb.hydratePocState = hydratePocState;
  }

  if (__cb.hasFeature && __cb.hasFeature("dust")) {
    publishApi();
  } else if (__cb.supabaseJwtReady) {
    __cb.supabaseJwtReady.then(() => {
      if (__cb.hasFeature && __cb.hasFeature("dust")) publishApi();
    }).catch(() => { /* mint failed; leave the API unexposed */ });
  }
})();
