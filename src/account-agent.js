(function () {
  "use strict";

  const __cb = window.__cb;

  // ---------------------------------------------------------------------------
  // Account agent — a floating, draggable chat window that queries Clay's
  // Audiences "account agent" about the account behind the canvas's linked
  // Salesforce opportunity.
  //
  // Flow:
  //   1. Read the linked SFDC opportunity (src/sfdc.js, canvas-scoped).
  //   2. Fetch the full opp record to get its Account name, then reconcile it
  //      to a Clay Audiences account by matching `org_name` (the user opted for
  //      name-matching over a domain lookup, so no SFDC Edge Function change is
  //      needed — the opp record already carries `accountName`).
  //   3. If the name resolves to exactly one account, we're ready to chat.
  //      Otherwise we drop into an inline picker (search Clay accounts by
  //      name/domain) so the rep can pick the right one.
  //   4. Each question hits POST /v3/workspaces/:ws/agents/account/run with the
  //      resolved numeric accountId. The endpoint is STATELESS — it takes one
  //      message and returns one answer (see the architecture notes), so we
  //      keep NO chat history: every send is independent and the in-window
  //      transcript is wiped when the panel closes.
  //
  // Auth: all calls piggyback the Clay session cookie (`credentials: include`),
  // exactly like src/api.js. The run endpoint needs the AudienceAbility
  // .ManageActions ability in the current workspace; a 403 surfaces as an
  // inline error.
  //
  // Gating: reuses the internal `sfdc` feature flag (this feature depends on a
  // linked SFDC opp), so __cb.openAccountAgent is only published when that flag
  // is on — mirroring the publishApi pattern in src/sfdc.js. The More-menu row
  // in src/overlay.js checks `__cb.openAccountAgent` and short-circuits when
  // absent.
  // ---------------------------------------------------------------------------

  const API_BASE = "https://api.clay.com";
  // Default account fields use stable slug ids in Clay Audiences (verified
  // against libs/api-contract/src/audiences/lib/default-fields.ts):
  const FIELD_ORG_NAME = "org_name";
  const FIELD_DOMAIN = "domain";
  const ENTITY_FIELD_TABLE = "account_entity_field_values";
  const POS_KEY = "cb-aa-pos";
  // app_settings key (edited in Secret Configuration) holding the audience
  // segment id to scope account search to. Empty = search the whole workspace.
  const SEG_SETTING_KEY = "audience_segment_id";

  // The /agents/account/run endpoint sits behind a ~60s gateway idle timeout. A
  // run that exceeds it gets a CORS-less error page from the proxy, which the
  // browser surfaces as an opaque "Failed to fetch". Run time scales with
  // `maxSteps` — measured live (ws 4515): maxSteps 3 ≈ 19s, 6 ≈ 46s, 50 → times
  // out. We cap steps to stay comfortably under the wall and abort client-side
  // just before it so we can show a clear message instead of "Failed to fetch".
  const RUN_MAX_STEPS = 5;
  const RUN_TIMEOUT_MS = 58000;

  // Resolved configured segment, cached per workspace for the session. Reset on
  // panel close so a Secret-Configuration change takes effect on reopen.
  // Shape: { id, name, filterAst, segmentType, signalDaysLookback, missing }.
  let cachedSegment = null;
  let cachedSegmentWs = null;
  let cachedSegmentLoaded = false;

  // --- Small helpers ---------------------------------------------------------

  function workspaceId() {
    return __cb.currentWorkspaceId || __cb.parseIdsFromUrl()?.workspaceId || null;
  }

  function normalizeDomain(s) {
    return String(s || "")
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, "")
      .replace(/^www\./, "")
      .split("/")[0];
  }

  async function httpError(res) {
    let detail = "";
    try {
      detail = await res.text();
    } catch {}
    const err = new Error(detail || `Request failed (${res.status})`);
    err.status = res.status;
    return err;
  }

  function errText(e) {
    if (e?.code === "AA_TIMEOUT" || e?.code === "AA_NETWORK" || /failed to fetch/i.test(e?.message || "")) {
      return "The agent ran past the ~60s server limit and the request was cut off. Ask a narrower question (broad asks need more reasoning steps than the limit allows).";
    }
    if (e?.status === 403) {
      return "Your Clay account doesn't have permission to run the account agent in this workspace (needs Audiences \u2192 Manage actions).";
    }
    if (e?.status === 401) {
      return "Your Clay session expired. Reload the Clay tab and try again.";
    }
    const raw = e?.message || "Something went wrong.";
    // The API error body is often JSON; show a short readable slice.
    return raw.length > 400 ? raw.slice(0, 400) + "\u2026" : raw;
  }

  // --- Clay API: account resolution + agent run ------------------------------

  // A single "field <op> value" filter, wrapped in the AND group the accounts
  // endpoint expects (ConditionalExpressionGroup -> GroupOp/BinOp). The field
  // is referenced via dataPath[2], not a numeric column id (verified against
  // the filter-builder rule definitions).
  function buildFieldFilter(fieldId, operator, value) {
    return {
      type: "GroupOp",
      combinationMode: "And",
      items: [
        {
          type: "BinOp",
          key: fieldId,
          dataPath: [ENTITY_FIELD_TABLE, "field", fieldId],
          operator,
          value,
          entityType: "ACCOUNT",
        },
      ],
    };
  }

  function toAccountLite(a) {
    const entity = a?.entity || {};
    const fields = entity.fields || [];
    const get = (id) => {
      const f = fields.find((x) => x.field_id === id);
      return f && typeof f.value === "string" ? f.value : f ? f.value : "";
    };
    return {
      id: entity.id,
      name: get(FIELD_ORG_NAME) || "",
      domain: get(FIELD_DOMAIN) || "",
    };
  }

  // Segment membership on POST .../accounts comes from the segment's saved
  // `filterAst` (NOT `segmentId` alone — verified against the query service), so
  // we AND the segment's AST into our own filter and also pass segmentId /
  // segmentType for CPJ-exclusion + draft-source resolution. `baseFilters` is
  // our own GroupOp (e.g. org_name Equal) or undefined to just list the segment.
  function applySegmentToBody(body, segment, baseFilters) {
    if (segment && segment.id && !segment.missing) {
      body.segmentId = segment.id;
      body.segmentType = segment.segmentType ?? null;
      if (segment.signalDaysLookback != null) body.signalDaysLookback = segment.signalDaysLookback;
      const segAst = segment.filterAst || null;
      const baseItems = baseFilters && Array.isArray(baseFilters.items) ? baseFilters.items : [];
      if (!baseItems.length) {
        // List-the-segment case: pass the segment's filterAst verbatim (this is
        // the shape verified live to return the segment's full membership).
        body.filters = segAst || baseFilters || undefined;
      } else if (segAst && Array.isArray(segAst.items) && segAst.items.length) {
        // Intersect: nest the whole segment AST as one child so its internal
        // And/Or is preserved, then AND our own conditions alongside.
        body.filters = { type: "GroupOp", combinationMode: "And", items: [segAst, ...baseItems] };
      } else {
        body.filters = baseFilters;
      }
    } else if (baseFilters) {
      body.filters = baseFilters;
    }
    return body;
  }

  async function fetchAccounts(ws, baseFilters, limit, segment) {
    const body = {
      limit,
      offset: 0,
      includeDeleted: false,
      // Match the Audiences UI: exclude in-progress CPJ drafts.
      shouldInjectDraftFilter: true,
      segmentType: null,
    };
    applySegmentToBody(body, segment, baseFilters);
    const res = await fetch(`${API_BASE}/v3/workspaces/${ws}/audiences/accounts`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw await httpError(res);
    const data = await res.json();
    return (data?.accounts || []).map(toAccountLite).filter((a) => a.id != null);
  }

  // Free-text search for the inline picker. A token with a dot and no spaces is
  // treated as a domain; otherwise we match the org name. `Contain` keeps it
  // forgiving. With a segment configured, an empty query lists the segment's
  // first accounts so the picker is useful before typing.
  async function searchAccounts(ws, query, segment) {
    const q = (query || "").trim();
    const scoped = !!(segment && segment.id && !segment.missing);
    if (q.length < 2) {
      return scoped ? fetchAccounts(ws, undefined, 25, segment) : [];
    }
    const looksLikeDomain = /\./.test(q) && !/\s/.test(q);
    const base = looksLikeDomain
      ? buildFieldFilter(FIELD_DOMAIN, "Contain", normalizeDomain(q))
      : buildFieldFilter(FIELD_ORG_NAME, "Contain", q);
    return fetchAccounts(ws, base, 10, segment);
  }

  // Reads the configured segment id from app_settings (Supabase) and fetches its
  // filterAst from Clay. Cached per workspace for the session. Returns null when
  // nothing is configured; returns a `{ missing: true }` stub when an id is set
  // but the segment can't be loaded in this workspace (so the UI can warn rather
  // than silently fall back to the whole workspace).
  async function getConfiguredSegment(ws) {
    if (cachedSegmentLoaded && cachedSegmentWs === ws) return cachedSegment;
    cachedSegmentLoaded = true;
    cachedSegmentWs = ws;
    cachedSegment = null;
    try {
      const supa = window.__cbSupabase;
      if (!supa || !ws) return null;
      const rows = await supa.supabaseFetch("app_settings", "GET", {
        query: { key: "eq." + SEG_SETTING_KEY, select: "value", limit: "1" },
      });
      const segId = ((rows && rows[0] && rows[0].value) || "").trim();
      if (!segId) return null;
      const seg = __cb.fetchAudienceSegment ? await __cb.fetchAudienceSegment(ws, segId) : null;
      if (seg && seg.id) {
        cachedSegment = {
          id: seg.id,
          name: seg.name || seg.id,
          filterAst: seg.filterAst || null,
          segmentType: seg.segmentType ?? null,
          signalDaysLookback: seg.signalDaysLookback ?? null,
          missing: false,
        };
      } else {
        cachedSegment = {
          id: segId,
          name: segId,
          filterAst: null,
          segmentType: null,
          signalDaysLookback: null,
          missing: true,
        };
      }
    } catch (err) {
      console.warn("[Clay Scoping] getConfiguredSegment failed:", err);
      cachedSegment = null;
    }
    return cachedSegment;
  }

  async function runAccountAgent(ws, accountId, message) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), RUN_TIMEOUT_MS);
    let res;
    try {
      res = await fetch(`${API_BASE}/v3/workspaces/${ws}/agents/account/run`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId, message, options: { maxSteps: RUN_MAX_STEPS } }),
        signal: controller.signal,
      });
    } catch (e) {
      // AbortError = we hit RUN_TIMEOUT_MS first; "Failed to fetch" = the gateway
      // killed a >60s run (CORS-less error page) or a real network drop. Both
      // map to a clear timeout message rather than the browser's opaque text.
      if (e?.name === "AbortError") {
        const err = new Error("timeout");
        err.code = "AA_TIMEOUT";
        throw err;
      }
      const err = new Error(e?.message || "Network error");
      err.code = "AA_NETWORK";
      throw err;
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) throw await httpError(res);
    return res.json();
  }

  // --- Icons -----------------------------------------------------------------

  const SEND_ICON_SVG =
    '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4 20-7Z"/></svg>';
  const CLOSE_ICON_SVG =
    '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
  const BOT_ICON_SVG =
    '<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="10" rx="2"/><circle cx="12" cy="5" r="2"/><path d="M12 7v4"/><line x1="8" y1="16" x2="8" y2="16"/><line x1="16" y1="16" x2="16" y2="16"/></svg>';
  const CLOUD_ICON_SVG =
    '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.5 19a4.5 4.5 0 1 0-1.4-8.8 6 6 0 0 0-11.6 1.6A4 4 0 0 0 6 19h11.5z"/></svg>';

  // --- Window state ----------------------------------------------------------

  let panelEl = null;
  let headerEl = null;
  let contextEl = null;
  let scopeEl = null;
  let bodyEl = null;
  let footerEl = null;
  let inputEl = null;
  let sendBtn = null;
  let unsubscribeOpp = null;

  const state = {
    ws: null,
    opp: null, // { id, name, url, accountName? }
    account: null, // { id, name, domain }
    segment: null, // configured scope segment (see getConfiguredSegment)
    resolving: false,
    resolveError: null,
    pickerMode: false,
    pickerPrefill: "",
    busy: false, // a question is in flight
    transcript: [], // [{ role: 'user'|'agent'|'error', text, meta? }]
    resolveToken: 0,
  };

  // --- Position persistence + dragging --------------------------------------

  function loadPos() {
    try {
      const r = JSON.parse(localStorage.getItem(POS_KEY));
      if (r && Number.isFinite(r.left) && Number.isFinite(r.top)) return r;
    } catch {}
    return null;
  }

  function savePos(p) {
    try {
      localStorage.setItem(POS_KEY, JSON.stringify(p));
    } catch {}
  }

  function clampPos(left, top) {
    const w = panelEl?.offsetWidth || 380;
    const maxL = window.innerWidth - Math.min(w, window.innerWidth) - 8;
    const maxT = window.innerHeight - 48;
    return {
      left: Math.max(8, Math.min(left, Math.max(8, maxL))),
      top: Math.max(8, Math.min(top, Math.max(8, maxT))),
    };
  }

  function applyPos(p) {
    if (!panelEl) return;
    const c = clampPos(p.left, p.top);
    panelEl.style.left = c.left + "px";
    panelEl.style.top = c.top + "px";
    panelEl.style.right = "auto";
    panelEl.style.bottom = "auto";
  }

  function attachDrag(handle) {
    let dragging = false;
    let startX = 0;
    let startY = 0;
    let startLeft = 0;
    let startTop = 0;

    function onMove(evt) {
      if (!dragging) return;
      const dx = evt.clientX - startX;
      const dy = evt.clientY - startY;
      applyPos({ left: startLeft + dx, top: startTop + dy });
    }
    function onUp() {
      if (!dragging) return;
      dragging = false;
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      handle.classList.remove("cb-aa-dragging");
      const rect = panelEl.getBoundingClientRect();
      savePos({ left: rect.left, top: rect.top });
    }
    handle.addEventListener("pointerdown", (evt) => {
      // Ignore drags that start on an interactive control in the header.
      if (evt.target.closest("button")) return;
      if (evt.button !== 0) return;
      dragging = true;
      startX = evt.clientX;
      startY = evt.clientY;
      const rect = panelEl.getBoundingClientRect();
      startLeft = rect.left;
      startTop = rect.top;
      handle.classList.add("cb-aa-dragging");
      document.addEventListener("pointermove", onMove);
      document.addEventListener("pointerup", onUp);
      evt.preventDefault();
    });
  }

  // --- Build the window ------------------------------------------------------

  function buildPanel() {
    panelEl = document.createElement("div");
    panelEl.className = "cb-aa-panel";

    headerEl = document.createElement("div");
    headerEl.className = "cb-aa-header";

    const titleWrap = document.createElement("div");
    titleWrap.className = "cb-aa-title-wrap";
    const icon = document.createElement("span");
    icon.className = "cb-aa-title-icon";
    icon.innerHTML = BOT_ICON_SVG;
    const title = document.createElement("div");
    title.className = "cb-aa-title";
    title.textContent = "Account agent";
    titleWrap.appendChild(icon);
    titleWrap.appendChild(title);

    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "cb-aa-icon-btn";
    closeBtn.title = "Close";
    closeBtn.setAttribute("aria-label", "Close");
    closeBtn.innerHTML = CLOSE_ICON_SVG;
    closeBtn.addEventListener("click", closePanel);

    headerEl.appendChild(titleWrap);
    headerEl.appendChild(closeBtn);

    contextEl = document.createElement("div");
    contextEl.className = "cb-aa-context";

    scopeEl = document.createElement("div");
    scopeEl.className = "cb-aa-scope";
    scopeEl.style.display = "none";

    bodyEl = document.createElement("div");
    bodyEl.className = "cb-aa-body";

    footerEl = document.createElement("div");
    footerEl.className = "cb-aa-footer";
    inputEl = document.createElement("textarea");
    inputEl.className = "cb-aa-input";
    inputEl.rows = 1;
    inputEl.placeholder = "Ask about this account\u2026";
    inputEl.addEventListener("input", autosize);
    inputEl.addEventListener("keydown", (evt) => {
      if (evt.key === "Enter" && !evt.shiftKey) {
        evt.preventDefault();
        send();
      }
    });
    sendBtn = document.createElement("button");
    sendBtn.type = "button";
    sendBtn.className = "cb-aa-send";
    sendBtn.title = "Send";
    sendBtn.setAttribute("aria-label", "Send");
    sendBtn.innerHTML = SEND_ICON_SVG;
    sendBtn.addEventListener("click", send);
    footerEl.appendChild(inputEl);
    footerEl.appendChild(sendBtn);

    panelEl.appendChild(headerEl);
    panelEl.appendChild(contextEl);
    panelEl.appendChild(scopeEl);
    panelEl.appendChild(bodyEl);
    panelEl.appendChild(footerEl);

    document.body.appendChild(panelEl);
    attachDrag(headerEl);

    const saved = loadPos();
    if (saved) applyPos(saved);
    // else: CSS default (top-right) applies.
  }

  function autosize() {
    if (!inputEl) return;
    inputEl.style.height = "auto";
    inputEl.style.height = Math.min(inputEl.scrollHeight, 120) + "px";
  }

  // --- Rendering -------------------------------------------------------------

  function renderAll() {
    renderContext();
    renderScope();
    renderBody();
    renderFooter();
  }

  // Thin strip under the context bar communicating the account-search scope:
  // the configured segment when active, or a warning when one is configured but
  // couldn't be loaded in this workspace.
  function renderScope() {
    if (!scopeEl) return;
    const seg = state.segment;
    if (seg && seg.id && !seg.missing) {
      scopeEl.className = "cb-aa-scope";
      scopeEl.style.display = "";
      scopeEl.innerHTML = "";
      const label = document.createElement("span");
      label.className = "cb-aa-scope-label";
      label.textContent = "Scoped to";
      const name = document.createElement("span");
      name.className = "cb-aa-scope-name";
      name.textContent = seg.name;
      name.title = `${seg.name} (${seg.id})`;
      scopeEl.appendChild(label);
      scopeEl.appendChild(name);
    } else if (seg && seg.missing) {
      scopeEl.className = "cb-aa-scope cb-aa-scope-warn";
      scopeEl.style.display = "";
      scopeEl.textContent =
        "Configured segment isn't in this workspace \u2014 searching all accounts.";
      scopeEl.title = seg.id;
    } else {
      scopeEl.style.display = "none";
      scopeEl.innerHTML = "";
    }
  }

  function renderContext() {
    if (!contextEl) return;
    contextEl.innerHTML = "";
    if (state.account) {
      const chip = document.createElement("div");
      chip.className = "cb-aa-account-chip";
      const dot = document.createElement("span");
      dot.className = "cb-aa-account-dot";
      const name = document.createElement("span");
      name.className = "cb-aa-account-name";
      name.textContent = state.account.name || `Account ${state.account.id}`;
      name.title = name.textContent;
      chip.appendChild(dot);
      chip.appendChild(name);
      if (state.account.domain) {
        const dom = document.createElement("span");
        dom.className = "cb-aa-account-domain";
        dom.textContent = state.account.domain;
        chip.appendChild(dom);
      }
      const change = document.createElement("button");
      change.type = "button";
      change.className = "cb-aa-change-btn";
      change.textContent = "Change";
      change.title = "Pick a different account";
      change.addEventListener("click", () => enterPickerMode(""));
      contextEl.appendChild(chip);
      contextEl.appendChild(change);
    } else {
      const sub = document.createElement("div");
      sub.className = "cb-aa-context-sub";
      if (!state.ws) sub.textContent = "Open a Clay workbook to begin.";
      else if (state.resolving) sub.textContent = "Loading accounts\u2026";
      else sub.textContent = "Pick an account to ask about.";
      contextEl.appendChild(sub);
    }
  }

  function statusBlock(kind, html) {
    const wrap = document.createElement("div");
    wrap.className = `cb-aa-status cb-aa-status-${kind}`;
    wrap.innerHTML = html;
    return wrap;
  }

  function renderBody() {
    if (!bodyEl) return;
    bodyEl.innerHTML = "";

    if (!state.ws) {
      bodyEl.appendChild(
        statusBlock("info", "This tool runs against the Audiences accounts in your current Clay workspace. Open a workbook first."),
      );
      return;
    }

    if (state.resolving) {
      const s = document.createElement("div");
      s.className = "cb-aa-resolving";
      s.innerHTML = '<span class="cb-aa-spinner" aria-hidden="true"></span>';
      const label = document.createElement("span");
      label.textContent = "Loading accounts\u2026";
      s.appendChild(label);
      bodyEl.appendChild(s);
      return;
    }

    if (state.resolveError) {
      bodyEl.appendChild(statusBlock("error", escapeHtml(state.resolveError)));
      const retry = document.createElement("button");
      retry.type = "button";
      retry.className = "cb-aa-secondary-btn";
      retry.textContent = "Try again";
      retry.addEventListener("click", startAccountSelection);
      bodyEl.appendChild(retry);
      return;
    }

    // LONG-TERM (commented with the SFDC flow): when no opp is linked, prompt to
    // link one. The temporary flow picks the account from the segment instead.
    // if (!state.opp) {
    //   renderLinkCta();
    //   return;
    // }

    if (state.pickerMode) {
      renderPicker();
      return;
    }

    if (state.account) {
      renderTranscript();
      return;
    }

    // Fallback (shouldn't normally hit): offer the picker.
    renderPicker();
  }

  function renderLinkCta() {
    const wrap = document.createElement("div");
    wrap.className = "cb-aa-cta";
    const msg = document.createElement("div");
    msg.className = "cb-aa-cta-msg";
    msg.textContent =
      "Link a Salesforce opportunity to this canvas, and we'll match it to a Clay account.";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "cb-aa-primary-btn";
    btn.innerHTML = CLOUD_ICON_SVG + "<span>Link opportunity</span>";
    btn.addEventListener("click", () => {
      if (!__cb.sfdc?.showPicker) return;
      __cb.sfdc.showPicker(btn, async (opp) => {
        try {
          if (__cb.sfdc.linkCanvasToOpportunity && __cb.currentWorkbookId) {
            await __cb.sfdc.linkCanvasToOpportunity(__cb.currentWorkbookId, opp);
          } else if (__cb.sfdc.setLinkedOpportunityLocal) {
            __cb.sfdc.setLinkedOpportunityLocal(opp);
          }
          // onLinkedOppChange (subscribed in open()) re-runs resolution.
        } catch (err) {
          state.resolveError = errText(err);
          renderBody();
        }
      });
    });
    wrap.appendChild(msg);
    wrap.appendChild(btn);
    bodyEl.appendChild(wrap);
  }

  // --- Inline account picker -------------------------------------------------

  let pickerReqId = 0;
  let pickerDebounce = null;

  function renderPicker() {
    const wrap = document.createElement("div");
    wrap.className = "cb-aa-picker";

    const search = document.createElement("input");
    search.type = "text";
    search.className = "cb-aa-picker-input";
    search.placeholder = "Search Clay accounts by name or domain\u2026";
    search.autocomplete = "off";
    search.spellcheck = false;
    search.value = state.pickerPrefill || "";

    const hint = document.createElement("div");
    hint.className = "cb-aa-picker-hint";
    const segActive = !!(state.segment && state.segment.id && !state.segment.missing);
    hint.textContent = segActive
      ? `Pick an account from \u201c${state.segment.name}\u201d:`
      : "Search accounts and pick one to ask about:";

    const results = document.createElement("div");
    results.className = "cb-aa-picker-results";

    const status = document.createElement("div");
    status.className = "cb-aa-picker-status";

    wrap.appendChild(hint);
    wrap.appendChild(search);
    wrap.appendChild(status);
    wrap.appendChild(results);
    bodyEl.appendChild(wrap);

    function renderRows(accounts) {
      results.innerHTML = "";
      if (!accounts.length) {
        status.textContent = "No accounts match.";
        return;
      }
      status.textContent = "";
      for (const acc of accounts) {
        const row = document.createElement("button");
        row.type = "button";
        row.className = "cb-aa-picker-row";
        const nm = document.createElement("span");
        nm.className = "cb-aa-picker-row-name";
        nm.textContent = acc.name || `Account ${acc.id}`;
        row.appendChild(nm);
        if (acc.domain) {
          const dm = document.createElement("span");
          dm.className = "cb-aa-picker-row-domain";
          dm.textContent = acc.domain;
          row.appendChild(dm);
        }
        row.addEventListener("click", () => setAccount(acc));
        results.appendChild(row);
      }
    }

    const scoped = !!(state.segment && state.segment.id && !state.segment.missing);
    if (scoped) {
      search.placeholder = "Search this segment by name or domain\u2026";
    }

    async function run(q) {
      const reqId = ++pickerReqId;
      status.textContent = q ? "Searching\u2026" : "Loading segment accounts\u2026";
      try {
        const accounts = await searchAccounts(state.ws, q, state.segment);
        if (reqId !== pickerReqId) return;
        renderRows(accounts);
      } catch (err) {
        if (reqId !== pickerReqId) return;
        status.textContent = errText(err);
      }
    }

    search.addEventListener("input", () => {
      state.pickerPrefill = search.value;
      const q = search.value.trim();
      clearTimeout(pickerDebounce);
      if (q.length < 2) {
        // Scoped: an empty box lists the segment's accounts; unscoped: clear.
        if (scoped) {
          pickerDebounce = setTimeout(() => run(""), 200);
        } else {
          results.innerHTML = "";
          status.textContent = "";
        }
        return;
      }
      pickerDebounce = setTimeout(() => run(q), 250);
    });

    // Auto-run when prefilled (the name-match fallback) or, when scoped, to
    // list the segment's accounts immediately.
    search.focus();
    const prefill = (state.pickerPrefill || "").trim();
    if (prefill.length >= 2) run(prefill);
    else if (scoped) run("");
  }

  // --- Transcript ------------------------------------------------------------

  function renderTranscript() {
    const list = document.createElement("div");
    list.className = "cb-aa-messages";

    if (!state.transcript.length) {
      const empty = document.createElement("div");
      empty.className = "cb-aa-empty";
      empty.textContent =
        "Ask the agent about this account \u2014 recent signals, open opportunities, contacts, Gong calls, and more.";
      list.appendChild(empty);
    }

    for (const m of state.transcript) {
      list.appendChild(renderMessage(m));
    }
    bodyEl.appendChild(list);
    scrollToBottom();
  }

  function renderMessage(m) {
    const row = document.createElement("div");
    row.className = `cb-aa-msg cb-aa-msg-${m.role}`;
    const bubble = document.createElement("div");
    bubble.className = "cb-aa-bubble";
    bubble.textContent = m.text;
    row.appendChild(bubble);
    if (m.role === "agent" && m.meta) {
      const chips = renderMetaChips(m.meta);
      if (chips) row.appendChild(chips);
    }
    return row;
  }

  function renderMetaChips(meta) {
    const defs = [
      ["contactCount", "contacts"],
      ["opportunityCount", "opps"],
      ["gongCallCount", "Gong calls"],
      ["taskCount", "tasks"],
    ];
    const present = defs.filter(([k]) => Number.isFinite(meta?.[k]));
    if (!present.length) return null;
    const wrap = document.createElement("div");
    wrap.className = "cb-aa-meta-chips";
    for (const [k, label] of present) {
      const chip = document.createElement("span");
      chip.className = "cb-aa-meta-chip";
      chip.textContent = `${meta[k]} ${label}`;
      wrap.appendChild(chip);
    }
    return wrap;
  }

  function scrollToBottom() {
    const list = bodyEl?.querySelector(".cb-aa-messages");
    if (list) list.scrollTop = list.scrollHeight;
  }

  function renderFooter() {
    if (!footerEl) return;
    const ready = !!state.account && !state.busy;
    inputEl.disabled = !state.account || state.busy;
    sendBtn.disabled = !ready;
    footerEl.classList.toggle("cb-aa-footer-disabled", !state.account);
    if (state.busy) inputEl.placeholder = "Waiting for the agent\u2026";
    else if (state.account) inputEl.placeholder = "Ask about this account\u2026";
    else inputEl.placeholder = "Pick an account first\u2026";
  }

  // --- Actions ---------------------------------------------------------------

  function setAccount(acc) {
    state.account = acc;
    state.pickerMode = false;
    state.resolveError = null;
    state.transcript = [];
    renderAll();
    if (inputEl && !inputEl.disabled) inputEl.focus();
  }

  function enterPickerMode(prefill) {
    state.pickerMode = true;
    state.account = null;
    state.pickerPrefill = prefill || "";
    renderAll();
  }

  // TEMPORARY FLOW (current default): pick an account directly from the
  // configured segment via the search bar — no SFDC opportunity involved. The
  // SFDC-opp reconciliation (startResolution + renderLinkCta) is the better
  // long-term design and is kept below, just no longer wired into open().
  async function startAccountSelection() {
    const token = ++state.resolveToken;
    state.account = null;
    state.pickerMode = false;
    state.resolveError = null;
    state.opp = null;
    state.ws = workspaceId();

    if (!state.ws) {
      state.resolving = false;
      renderAll();
      return;
    }

    state.resolving = true;
    renderAll();

    // Load the configured scope segment so the picker lists/searches within it.
    state.segment = await getConfiguredSegment(state.ws);
    if (token !== state.resolveToken) return;

    state.resolving = false;
    // Empty prefill → the picker default-lists the segment's accounts.
    enterPickerMode("");
  }

  // LONG-TERM FLOW (currently unused — kept for when we switch back to
  // resolving the account from the canvas's linked SFDC opportunity).
  async function startResolution() {
    const token = ++state.resolveToken;
    state.account = null;
    state.pickerMode = false;
    state.resolveError = null;
    state.ws = workspaceId();
    state.opp = __cb.sfdc?.getLinkedOpportunity?.() || null;

    if (!state.ws || !state.opp) {
      state.resolving = false;
      renderAll();
      return;
    }

    state.resolving = true;
    renderAll();

    // Load the configured scope segment (if any) before matching so both the
    // exact match and the picker stay within it.
    state.segment = await getConfiguredSegment(state.ws);
    if (token !== state.resolveToken) return;
    renderScope();

    // The linked-opp record in memory only has { id, name, url } — `name` is the
    // OPPORTUNITY name, not the account. Fetch the full record for accountName.
    let accountName = "";
    try {
      const full = await __cb.sfdc.getOpportunity(state.opp.id);
      if (token !== state.resolveToken) return;
      accountName = (full?.accountName || "").trim();
      state.opp = { ...state.opp, accountName };
    } catch {
      // Non-fatal: fall through to the picker with no prefill.
    }

    if (accountName) {
      try {
        const matches = await fetchAccounts(
          state.ws,
          buildFieldFilter(FIELD_ORG_NAME, "Equal", accountName),
          2,
          state.segment,
        );
        if (token !== state.resolveToken) return;
        if (matches.length === 1) {
          state.resolving = false;
          setAccount(matches[0]);
          return;
        }
      } catch (err) {
        if (token !== state.resolveToken) return;
        state.resolving = false;
        state.resolveError = errText(err);
        renderAll();
        return;
      }
    }

    // 0 or >1 exact matches → inline picker, prefilled with the SFDC name.
    state.resolving = false;
    enterPickerMode(accountName);
  }

  function addMessage(role, text, meta) {
    state.transcript.push({ role, text, meta });
    const list = bodyEl?.querySelector(".cb-aa-messages");
    if (list) {
      const empty = list.querySelector(".cb-aa-empty");
      if (empty) empty.remove();
      list.appendChild(renderMessage({ role, text, meta }));
      scrollToBottom();
    } else {
      renderBody();
    }
  }

  function addThinking() {
    const list = bodyEl?.querySelector(".cb-aa-messages");
    const row = document.createElement("div");
    row.className = "cb-aa-msg cb-aa-msg-agent cb-aa-thinking";
    const bubble = document.createElement("div");
    bubble.className = "cb-aa-bubble";
    bubble.innerHTML = '<span class="cb-aa-spinner" aria-hidden="true"></span>';
    const label = document.createElement("span");
    label.className = "cb-aa-thinking-label";
    label.textContent = "Thinking\u2026";
    bubble.appendChild(label);
    row.appendChild(bubble);
    if (list) {
      list.appendChild(row);
      scrollToBottom();
    }
    return {
      updateElapsed(ms) {
        label.textContent = `Thinking\u2026 ${Math.round(ms / 1000)}s`;
      },
      remove() {
        row.remove();
      },
    };
  }

  async function send() {
    if (state.busy || !state.account) return;
    const text = (inputEl.value || "").trim();
    if (!text) return;
    inputEl.value = "";
    autosize();
    addMessage("user", text);

    state.busy = true;
    renderFooter();
    const thinking = addThinking();
    const t0 = Date.now();
    const timer = setInterval(() => thinking.updateElapsed(Date.now() - t0), 1000);

    try {
      const res = await runAccountAgent(state.ws, state.account.id, text);
      clearInterval(timer);
      thinking.remove();
      addMessage("agent", res?.answer || "(The agent returned an empty answer.)", res?.metadata);
    } catch (err) {
      clearInterval(timer);
      thinking.remove();
      addMessage("error", errText(err));
    } finally {
      state.busy = false;
      renderFooter();
      if (inputEl && !inputEl.disabled) inputEl.focus();
    }
  }

  // --- Open / close ----------------------------------------------------------

  function openAccountAgent() {
    if (panelEl) {
      // Already open — bring to attention; re-open the segment picker if idle.
      panelEl.classList.remove("cb-aa-flash");
      void panelEl.offsetWidth;
      panelEl.classList.add("cb-aa-flash");
      if (!state.account && !state.busy) startAccountSelection();
      return;
    }
    buildPanel();
    // TEMPORARY: pick the account directly from the configured segment.
    startAccountSelection();
    // LONG-TERM (kept for later) — resolve the account from the canvas's linked
    // SFDC opportunity, re-resolving whenever that link changes:
    // if (__cb.sfdc?.onLinkedOppChange) {
    //   unsubscribeOpp = __cb.sfdc.onLinkedOppChange(() => {
    //     if (state.busy) return; // don't yank an active chat mid-question
    //     startResolution();
    //   });
    // } else {
    //   startResolution();
    // }
  }

  function closePanel() {
    if (unsubscribeOpp) {
      try {
        unsubscribeOpp();
      } catch {}
      unsubscribeOpp = null;
    }
    if (panelEl) {
      panelEl.remove();
      panelEl = null;
    }
    headerEl = contextEl = scopeEl = bodyEl = footerEl = inputEl = sendBtn = null;
    // Reset session state — no history is kept across opens.
    state.opp = null;
    state.account = null;
    state.segment = null;
    state.resolving = false;
    state.resolveError = null;
    state.pickerMode = false;
    state.pickerPrefill = "";
    state.busy = false;
    state.transcript = [];
    state.resolveToken++;
    // Re-read the configured segment on next open (picks up Secret-Config edits).
    cachedSegmentLoaded = false;
    cachedSegmentWs = null;
    cachedSegment = null;
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  // --- Public surface (gated on the `sfdc` feature flag) ---------------------

  function publishApi() {
    __cb.openAccountAgent = openAccountAgent;
    __cb.accountAgent = {
      open: openAccountAgent,
      close: closePanel,
      searchAccounts,
      runAccountAgent,
    };
  }

  if (__cb.hasFeature && __cb.hasFeature("sfdc")) {
    publishApi();
  } else {
    if (__cb.supabaseJwtReady) {
      __cb.supabaseJwtReady
        .then(() => {
          if (__cb.hasFeature && __cb.hasFeature("sfdc")) publishApi();
        })
        .catch(() => {});
    }
    if (__cb.onSupabaseJwtChange) {
      const unsub = __cb.onSupabaseJwtChange(() => {
        if (__cb.hasFeature && __cb.hasFeature("sfdc")) {
          publishApi();
          unsub();
        }
      });
    }
  }
})();
