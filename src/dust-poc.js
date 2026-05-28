(function () {
  "use strict";

  const __cb = window.__cb;

  // ---------------------------------------------------------------------------
  // Generate POC (Dust integration)
  //
  // Topbar button opens a small popover anchored under itself. The popover
  // captures a customer name and asks the background service worker to
  // POST to Dust's create-conversation API mentioning the configured agent.
  // The reply renders a click-through link to the conversation in the Dust UI.
  //
  // Pre-JWT history: every rep used to paste their own Dust API key into a
  // first-run prompt, which was cached in localStorage. We now hold a single
  // shared key server-side in the dust-proxy Edge Function (gated by the
  // Phase-1 Clay JWT + internal-workspace whitelist), so the popover skips
  // straight to the customer-name form.
  //
  // Gating: ships to every install (internal + public). The public entry
  // point `__cb.startDustPoc` is only registered for users whose JWT carries
  // the `dust` feature flag — see publishApi at the bottom. The toolbar
  // button that invokes it is also feature-gated in src/overlay.js, so this
  // is belt-and-suspenders.
  // ---------------------------------------------------------------------------

  const DUST_WORKSPACE_ID = "5b990f8923";
  const DUST_AGENT_ID = "4CEcga0fGM";
  // Canonical Dust conversation URL — verified empirically against the
  // create-conversation response payload, which returns
  //   "url": "https://app.dust.tt/w/{wId}/conversation/{sId}".
  // We use the response's url field when present and fall back to this
  // pattern only if the API ever stops including it.
  const DUST_APP_BASE_URL = "https://app.dust.tt";

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
    const width = popoverEl.offsetWidth || 300;
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

    renderForm();
    positionPopover();
  }

  // ---- Form state -----------------------------------------------------------

  function renderForm() {
    if (!popoverEl) return;
    popoverEl.innerHTML = "";

    const title = document.createElement("div");
    title.className = "cb-dust-poc-title";
    title.textContent = "Generate POC";

    const sub = document.createElement("div");
    sub.className = "cb-dust-poc-sub";
    sub.textContent = "Customer name";

    const input = document.createElement("input");
    input.type = "text";
    input.className = "cb-dust-poc-input";
    input.placeholder = "e.g. Acme Inc";
    input.autocomplete = "off";

    const status = document.createElement("div");
    status.className = "cb-dust-poc-status";

    const footer = document.createElement("div");
    footer.className = "cb-dust-poc-footer";

    const sendBtn = document.createElement("button");
    sendBtn.type = "button";
    sendBtn.className = "cb-dust-poc-btn cb-dust-poc-btn-primary";
    sendBtn.textContent = "Send";
    sendBtn.addEventListener("click", () => doSend(input, status, sendBtn));

    input.addEventListener("keydown", (evt) => {
      if (evt.key === "Enter") {
        evt.preventDefault();
        sendBtn.click();
      }
    });

    footer.appendChild(sendBtn);

    popoverEl.appendChild(title);
    popoverEl.appendChild(sub);
    popoverEl.appendChild(input);
    popoverEl.appendChild(status);
    popoverEl.appendChild(footer);

    setTimeout(() => input.focus(), 0);
    positionPopover();
  }

  function setStatus(statusEl, kind, html) {
    statusEl.className = `cb-dust-poc-status cb-dust-poc-status-${kind}`;
    statusEl.innerHTML = html;
  }

  // ---- POST to Dust ---------------------------------------------------------

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

  // Route the HTTP call through the background service worker, which now
  // forwards to the dust-proxy Edge Function (with the JWT). The Edge
  // Function holds the shared Dust API key and the workspace ID server-
  // side; the SW payload is just `{ body }`.
  function sendViaBackground(body) {
    return new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage(
          {
            type: "cb:dust:createConversation",
            body,
          },
          (response) => {
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
          },
        );
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

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  async function doSend(inputEl, statusEl, sendBtn) {
    const customerName = inputEl.value.trim();
    if (!customerName) {
      setStatus(statusEl, "error", "Enter a customer name to continue.");
      inputEl.focus();
      return;
    }

    sendBtn.disabled = true;
    sendBtn.classList.add("cb-dust-poc-btn-loading");
    setStatus(statusEl, "info", "Creating conversation\u2026");

    try {
      const response = await sendViaBackground({
        title: `POC: ${customerName}`,
        blocking: false,
        message: {
          content: customerName,
          mentions: [{ configurationId: DUST_AGENT_ID }],
          context: buildContext(),
        },
      });

      if (response.status === 401 || response.status === 403) {
        // 401: the JWT minted by clay-auth-mint is invalid or expired.
        // 403: the JWT is valid but the user isn't in an internal workspace
        //      (e.g. a public-extension user hitting the proxy).
        const detail = extractErrorDetail(response);
        throw new Error(
          response.status === 401
            ? `Auth rejected (401): ${detail || "JWT invalid or expired — reload the page."}`
            : `Forbidden (403): ${detail || "your Clay workspace isn't on the internal allow-list."}`,
        );
      }

      if (!response.ok) {
        console.warn("[Clay Scoping] Dust non-OK response:", response);
        throw new Error(
          `Dust returned ${response.status || "error"}${response.statusText ? ` ${response.statusText}` : ""}: ${extractErrorDetail(response) || "(empty body — see service worker console)"}`,
        );
      }

      const conversation = response.data?.conversation;
      const sId = conversation?.sId;
      if (!sId) {
        throw new Error("Dust response missing conversation.sId.");
      }

      // Prefer the URL Dust ships back to us — it's the canonical one
      // (`https://app.dust.tt/w/{wId}/conversation/{sId}`) and survives
      // any future routing changes Dust makes on their side.
      const url =
        typeof conversation.url === "string" && conversation.url
          ? conversation.url
          : `${DUST_APP_BASE_URL}/w/${DUST_WORKSPACE_ID}/conversation/${sId}`;
      setStatus(
        statusEl,
        "success",
        `Conversation created. <a class="cb-dust-poc-link" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">Open in Dust</a>`,
      );
    } catch (err) {
      console.error("[Clay Scoping] Dust POC generation failed:", err);
      setStatus(
        statusEl,
        "error",
        escapeHtml(err?.message || "Failed to create conversation. Try again."),
      );
    } finally {
      sendBtn.disabled = false;
      sendBtn.classList.remove("cb-dust-poc-btn-loading");
    }
  }

  // ---- Public API -----------------------------------------------------------

  // Only exposed for users whose JWT carries the `dust` feature flag. On
  // a cold load (no cached JWT), hasFeature returns false synchronously,
  // so we also re-check after __cb.supabaseJwtReady resolves. The toolbar
  // button in src/overlay.js performs the same check before injecting the
  // entry that invokes startDustPoc.
  function publishApi() {
    __cb.startDustPoc = function (anchorEl) {
      openPopover(anchorEl);
    };
  }

  if (__cb.hasFeature && __cb.hasFeature("dust")) {
    publishApi();
  } else if (__cb.supabaseJwtReady) {
    __cb.supabaseJwtReady.then(() => {
      if (__cb.hasFeature && __cb.hasFeature("dust")) publishApi();
    }).catch(() => { /* mint failed; leave the API unexposed */ });
  }
})();
