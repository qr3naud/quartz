// __CB_INTERNAL_ONLY_BEGIN: dustPoc
(function () {
  "use strict";

  const __cb = window.__cb;

  // ---------------------------------------------------------------------------
  // Generate POC (Dust integration)
  //
  // Topbar button opens a small popover anchored under itself. The popover
  // captures a customer name, POSTs to Dust's create-conversation API
  // mentioning agent 4CEcga0fGM (via src/dust-bg.js because the request
  // would otherwise fail CORS preflight from app.clay.com), and renders a
  // link back to the conversation in the Dust UI. The API key is asked
  // for in the popover the first time and cached in localStorage so
  // subsequent uses skip straight to the customer-name form.
  //
  // Hardcoded values (workspace, agent) live here because this is an
  // internal Clay tool; the whole file is wrapped in the build-strip
  // sentinels above/below so the public spin-off never ships any of it.
  // ---------------------------------------------------------------------------

  const DUST_WORKSPACE_ID = "5b990f8923";
  const DUST_AGENT_ID = "4CEcga0fGM";
  const API_KEY_STORAGE_KEY = "cb-dust-api-key";
  // Canonical Dust conversation URL — verified empirically against the
  // create-conversation response payload, which returns
  //   "url": "https://app.dust.tt/w/{wId}/conversation/{sId}".
  // We use the response's url field when present and fall back to this
  // pattern only if the API ever stops including it.
  const DUST_APP_BASE_URL = "https://app.dust.tt";

  let popoverEl = null;
  let backdropEl = null;
  let anchorRef = null;

  // ---- API key cache --------------------------------------------------------

  function readApiKey() {
    try {
      const v = localStorage.getItem(API_KEY_STORAGE_KEY);
      return typeof v === "string" && v.trim() ? v.trim() : null;
    } catch {
      return null;
    }
  }

  function writeApiKey(value) {
    try {
      if (value) localStorage.setItem(API_KEY_STORAGE_KEY, value);
      else localStorage.removeItem(API_KEY_STORAGE_KEY);
    } catch (e) {
      console.warn("[Clay Scoping] failed to cache Dust API key:", e);
    }
  }

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

    renderCurrentState();
    positionPopover();
  }

  function renderCurrentState() {
    if (!popoverEl) return;
    popoverEl.innerHTML = "";
    if (readApiKey()) renderForm();
    else renderKeyPrompt();
    positionPopover();
  }

  // ---- Key-prompt state -----------------------------------------------------

  function renderKeyPrompt(prefill) {
    const title = document.createElement("div");
    title.className = "cb-dust-poc-title";
    title.textContent = "Connect to Dust";

    const sub = document.createElement("div");
    sub.className = "cb-dust-poc-sub";
    sub.textContent =
      "Paste a Dust API key with access to the Clay workspace. Saved locally on this browser.";

    const input = document.createElement("input");
    input.type = "password";
    input.className = "cb-dust-poc-input";
    input.placeholder = "sk-...";
    input.autocomplete = "off";
    if (prefill) input.value = prefill;

    const footer = document.createElement("div");
    footer.className = "cb-dust-poc-footer";

    const saveBtn = document.createElement("button");
    saveBtn.type = "button";
    saveBtn.className = "cb-dust-poc-btn cb-dust-poc-btn-primary";
    saveBtn.textContent = "Save";
    saveBtn.addEventListener("click", () => {
      const v = input.value.trim();
      if (!v) {
        input.focus();
        return;
      }
      writeApiKey(v);
      renderCurrentState();
    });

    input.addEventListener("keydown", (evt) => {
      if (evt.key === "Enter") {
        evt.preventDefault();
        saveBtn.click();
      }
    });

    footer.appendChild(saveBtn);

    popoverEl.appendChild(title);
    popoverEl.appendChild(sub);
    popoverEl.appendChild(input);
    popoverEl.appendChild(footer);

    setTimeout(() => input.focus(), 0);
  }

  // ---- Form state -----------------------------------------------------------

  function renderForm() {
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

    const resetLink = document.createElement("button");
    resetLink.type = "button";
    resetLink.className = "cb-dust-poc-link-btn";
    resetLink.textContent = "Reset key";
    resetLink.addEventListener("click", () => {
      writeApiKey(null);
      renderCurrentState();
    });

    const testLink = document.createElement("button");
    testLink.type = "button";
    testLink.className = "cb-dust-poc-link-btn";
    testLink.textContent = "Test key";
    testLink.addEventListener("click", () => doTestKey(status, testLink));

    const sendBtn = document.createElement("button");
    sendBtn.type = "button";
    sendBtn.className = "cb-dust-poc-btn cb-dust-poc-btn-primary";
    sendBtn.textContent = "Send";
    sendBtn.addEventListener("click", () =>
      doSend(input, status, sendBtn),
    );

    input.addEventListener("keydown", (evt) => {
      if (evt.key === "Enter") {
        evt.preventDefault();
        sendBtn.click();
      }
    });

    footer.appendChild(resetLink);
    footer.appendChild(testLink);
    footer.appendChild(sendBtn);

    popoverEl.appendChild(title);
    popoverEl.appendChild(sub);
    popoverEl.appendChild(input);
    popoverEl.appendChild(status);
    popoverEl.appendChild(footer);

    setTimeout(() => input.focus(), 0);
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

  // Route the actual HTTP call through the background service worker.
  // Content scripts inherit app.clay.com's origin, and Dust doesn't emit
  // a permissive Access-Control-Allow-Origin, so a direct fetch hits CORS
  // preflight failure. The background script runs in the extension's own
  // context and Chrome bypasses CORS for any host in `host_permissions`.
  function sendViaBackground(body) {
    return new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage(
          {
            type: "cb:dust:createConversation",
            apiKey: readApiKey(),
            workspaceId: DUST_WORKSPACE_ID,
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

  // Read-only probe — hits GET /assistant/agent_configurations. Tells the
  // rep whether the cached key can even read the workspace, separating
  // auth problems from payload problems in the create-conversation POST.
  async function doTestKey(statusEl, testBtn) {
    const apiKey = readApiKey();
    if (!apiKey) {
      renderCurrentState();
      return;
    }
    testBtn.disabled = true;
    setStatus(statusEl, "info", "Probing Dust\u2026");
    try {
      const response = await new Promise((resolve, reject) => {
        chrome.runtime.sendMessage(
          {
            type: "cb:dust:probeKey",
            apiKey,
            workspaceId: DUST_WORKSPACE_ID,
          },
          (r) => {
            const e = chrome.runtime.lastError;
            if (e) reject(new Error(e.message || "Messaging failed."));
            else if (!r) reject(new Error("No response from background."));
            else resolve(r);
          },
        );
      });
      console.log("[Clay Scoping] Dust probe response:", response);
      if (response.ok) {
        const count = Array.isArray(response.data?.agentConfigurations)
          ? response.data.agentConfigurations.length
          : "?";
        setStatus(
          statusEl,
          "success",
          `Key works. Read ${escapeHtml(String(count))} agents in workspace ${escapeHtml(DUST_WORKSPACE_ID)}.`,
        );
      } else {
        const detail = extractErrorDetail(response);
        setStatus(
          statusEl,
          "error",
          `Probe failed (${escapeHtml(String(response.status || "?"))}): ${escapeHtml(detail || "see service worker console")}`,
        );
      }
    } catch (err) {
      setStatus(
        statusEl,
        "error",
        escapeHtml(err?.message || "Probe failed."),
      );
    } finally {
      testBtn.disabled = false;
    }
  }

  async function doSend(inputEl, statusEl, sendBtn) {
    const customerName = inputEl.value.trim();
    if (!customerName) {
      setStatus(statusEl, "error", "Enter a customer name to continue.");
      inputEl.focus();
      return;
    }

    const apiKey = readApiKey();
    if (!apiKey) {
      renderCurrentState();
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

      if (response.status === 401) {
        // 401 = bad/expired token. Drop the cached key and bounce back to
        // the prompt so the rep can paste a fresh one without leaving the
        // flow.
        writeApiKey(null);
        console.warn(
          "[Clay Scoping] Dust auth rejected (401):",
          extractErrorDetail(response),
        );
        renderCurrentState();
        return;
      }

      if (response.status === 403) {
        // 403 = the key is valid but lacks access. Most common causes:
        //   - Key was created in a different Dust workspace
        //   - Key role is too restrictive (need a Builder/Admin key)
        //   - The hardcoded agent isn't shared with this key's user
        // Keep the cached key (so the rep can retry after fixing it) and
        // surface what Dust actually said. Full response is dumped to the
        // SW console for deeper inspection.
        const detail = extractErrorDetail(response);
        console.warn("[Clay Scoping] Dust forbidden (403):", response);
        throw new Error(
          `Dust 403 at ${response.endpoint || "?"}: ${
            detail ||
            `(empty body — see service worker console for full response). Most likely a wrong-workspace or insufficient-role key for workspace ${DUST_WORKSPACE_ID}.`
          }`,
        );
      }

      if (!response.ok) {
        console.warn("[Clay Scoping] Dust non-OK response:", response);
        throw new Error(
          `Dust returned ${response.status || "error"}${response.statusText ? ` ${response.statusText}` : ""} at ${response.endpoint || "?"}: ${extractErrorDetail(response) || "(empty body — see service worker console)"}`,
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

  __cb.startDustPoc = function (anchorEl) {
    openPopover(anchorEl);
  };
})();
// __CB_INTERNAL_ONLY_END
