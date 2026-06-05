(function () {
  "use strict";

  const __cb = window.__cb;

  // ---------------------------------------------------------------------------
  // SFDC (Salesforce) integration
  //
  // Anchors each brainstorm canvas to an SFDC Opportunity. The toolbar shows
  // a "Link opportunity" button when no opp is linked, and a linked-opp pill
  // ("Acme Inc — Q3 Expansion") when one is. Clicking the pill opens the
  // record in SFDC; the "..." menu offers "Change opportunity" / "Unlink".
  //
  // Network: every call is proxied through the background service worker
  // (src/internal-bg.js) to the sfdc-* Edge Functions. The SW injects the
  // Phase-1 Clay JWT for auth, so no SFDC credentials live client-side.
  //
  // Caching:
  //   - getOpportunity has a 5min in-memory cache, matching the calculator's
  //     `getOpportunityCached` (apps/mono-calculator/src/lib/sfdc/).
  //   - searchOpportunities is uncached on the client; the Edge Function
  //     has a 30s LRU.
  //
  // Gating: ships to every install (internal + public). The public surface
  // `__cb.sfdc.*` is only registered for users whose JWT carries the `sfdc`
  // feature flag — see publishApi at the bottom. Consumer code uses
  // `__cb.sfdc?.buildToolbarElement` which short-circuits to no-op when
  // the API isn't exposed. The sfdc-* Edge Functions independently enforce
  // INTERNAL_WORKSPACES server-side, so even a user who tampers with
  // __cb.userFeatures can't reach SFDC.
  // ---------------------------------------------------------------------------

  // --- Caching ---------------------------------------------------------------
  const OPP_CACHE_TTL_MS = 5 * 60 * 1000;
  const oppCache = new Map(); // id -> { opp, expiresAt }

  function cachedGet(id) {
    const hit = oppCache.get(id);
    if (!hit) return null;
    if (hit.expiresAt <= Date.now()) {
      oppCache.delete(id);
      return null;
    }
    return hit.opp;
  }

  function cachedSet(id, opp) {
    oppCache.set(id, { opp, expiresAt: Date.now() + OPP_CACHE_TTL_MS });
  }

  // --- SW messaging helpers --------------------------------------------------
  function sendMessage(payload) {
    return new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage(payload, (resp) => {
          const lastErr = chrome.runtime.lastError;
          if (lastErr) {
            reject(new Error(lastErr.message || "extension messaging failed"));
            return;
          }
          if (!resp) {
            reject(new Error("no response from background"));
            return;
          }
          resolve(resp);
        });
      } catch (err) {
        reject(err);
      }
    });
  }

  function unwrapProxyResponse(resp) {
    if (!resp || resp.ok !== true) {
      const detail = resp?.data?.error || resp?.error || resp?.rawText || `proxy returned ${resp?.status || "no status"}`;
      const err = new Error(typeof detail === "string" ? detail : JSON.stringify(detail));
      err.status = resp?.status;
      throw err;
    }
    return resp.data;
  }

  // --- Public API: queries ---------------------------------------------------

  /**
   * Searches Opportunities by name. Returns up to 10 records.
   * @param {string} q  Search term, min 2 chars (the picker enforces this).
   * @returns {Promise<{ records: Array<object>, instanceUrl: string }>}
   */
  async function searchOpportunities(q) {
    const resp = await sendMessage({ type: "cb:sfdc:searchOpportunities", q });
    return unwrapProxyResponse(resp);
  }

  /**
   * Fetches a single Opportunity by ID with a 5min in-memory cache.
   * @param {string} id
   * @returns {Promise<object>}
   */
  async function getOpportunity(id) {
    const cached = cachedGet(id);
    if (cached) return cached;
    const resp = await sendMessage({ type: "cb:sfdc:getOpportunity", id });
    const data = unwrapProxyResponse(resp);
    cachedSet(id, data);
    return data;
  }

  // --- Public API: canvas linkage --------------------------------------------

  /** Currently-linked opportunity for the canvas the topbar is mounted in. */
  let linkedOpp = null;
  const linkedOppListeners = new Set();

  function notifyLinkedOppChange() {
    for (const fn of linkedOppListeners) {
      try {
        fn(linkedOpp);
      } catch (e) {
        console.error("[Clay Scoping] sfdc linked-opp listener threw:", e);
      }
    }
  }

  /**
   * Subscribes to changes in the linked opportunity. Fires immediately with
   * the current value. Returns an unsubscribe function.
   */
  function onLinkedOppChange(handler) {
    linkedOppListeners.add(handler);
    try { handler(linkedOpp); } catch (e) { console.error(e); }
    return () => linkedOppListeners.delete(handler);
  }

  /** Returns the current linked opportunity (or null). */
  function getLinkedOpportunity() {
    return linkedOpp;
  }

  /** Sets the in-memory linked opportunity without persisting (for hydrate). */
  function setLinkedOpportunityLocal(opp) {
    const norm = opp && opp.id
      ? { id: opp.id, name: opp.name || opp.sfdc_opportunity_name || "", url: opp.url || opp.sfdc_opportunity_url || "" }
      : null;
    // Avoid spurious notifications if nothing changed.
    const prev = linkedOpp;
    const same = (!prev && !norm) || (prev && norm && prev.id === norm.id && prev.name === norm.name && prev.url === norm.url);
    if (same) return;
    linkedOpp = norm;
    notifyLinkedOppChange();
  }

  /**
   * Hydrates the linked opportunity by reading the canvases row for the
   * current workbook. Called on canvas open.
   */
  async function hydrateLinkedOpportunity(workbookId) {
    if (!workbookId) {
      setLinkedOpportunityLocal(null);
      return;
    }
    const supa = window.__cbSupabase;
    if (!supa) return;
    try {
      const rows = await supa.supabaseFetch("canvases", "GET", {
        query: {
          workbook_id: `eq.${workbookId}`,
          select: "sfdc_opportunity_id,sfdc_opportunity_name,sfdc_opportunity_url",
          limit: "1",
        },
      });
      const row = rows?.[0];
      if (row && row.sfdc_opportunity_id) {
        setLinkedOpportunityLocal({
          id: row.sfdc_opportunity_id,
          name: row.sfdc_opportunity_name || "",
          url: row.sfdc_opportunity_url || "",
        });
      } else {
        setLinkedOpportunityLocal(null);
      }
    } catch (err) {
      console.warn("[Clay Scoping] failed to hydrate linked opportunity:", err);
    }
  }

  /**
   * Persists the linked opportunity onto the canvases row.
   */
  async function linkCanvasToOpportunity(workbookId, opp) {
    if (!workbookId) throw new Error("missing workbookId");
    if (!opp?.id) throw new Error("missing opportunity id");
    const supa = window.__cbSupabase;
    if (!supa) throw new Error("supabase client not initialized");
    await supa.supabaseFetch("canvases", "PATCH", {
      query: { workbook_id: `eq.${workbookId}` },
      body: {
        sfdc_opportunity_id: opp.id,
        sfdc_opportunity_name: opp.name || null,
        sfdc_opportunity_url: opp.url || null,
        updated_at: new Date().toISOString(),
      },
    });
    setLinkedOpportunityLocal({
      id: opp.id,
      name: opp.name || "",
      url: opp.url || "",
    });

    // Auto-fire POC generation on link. The Dust POC agent drafts a scoping
    // doc from the customer's Gong calls/emails (a 5-10 min job) — kicking it
    // off the moment the opportunity is linked saves the rep a step. Runs in
    // the background with a spinner on the Generate POC toolbar button; it
    // does NOT pop a dialog so it won't interrupt the linking flow.
    // __cb.startDustPocForOpportunity is only published when the `dust`
    // feature flag is on (see src/dust-poc.js publishApi), so the optional
    // call no-ops for users without it. startPocGeneration internally guards
    // against launching a duplicate when one is already generating, so
    // re-linking the same opp won't stack jobs.
    if (__cb.startDustPocForOpportunity && opp.name) {
      try {
        __cb.startDustPocForOpportunity(opp.name);
      } catch (err) {
        console.warn("[Clay Scoping] auto POC generation failed to start:", err);
      }
    }
  }

  /** Clears the linked opportunity from the canvases row. */
  async function unlinkCanvasFromOpportunity(workbookId) {
    if (!workbookId) throw new Error("missing workbookId");
    const supa = window.__cbSupabase;
    if (!supa) throw new Error("supabase client not initialized");
    await supa.supabaseFetch("canvases", "PATCH", {
      query: { workbook_id: `eq.${workbookId}` },
      body: {
        sfdc_opportunity_id: null,
        sfdc_opportunity_name: null,
        sfdc_opportunity_url: null,
        updated_at: new Date().toISOString(),
      },
    });
    setLinkedOpportunityLocal(null);
  }

  // --- Popover UI ------------------------------------------------------------

  let popoverEl = null;
  let backdropEl = null;
  let anchorRef = null;

  function closePopover() {
    if (popoverEl) { popoverEl.remove(); popoverEl = null; }
    if (backdropEl) { backdropEl.remove(); backdropEl = null; }
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
    const width = popoverEl.offsetWidth || 360;
    const left = Math.max(8, rect.right - width);
    popoverEl.style.left = left + "px";
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function formatAmount(n) {
    if (n == null) return "";
    const num = Number(n);
    if (!Number.isFinite(num)) return "";
    if (num >= 1_000_000) return `$${(num / 1_000_000).toFixed(num >= 10_000_000 ? 0 : 1)}M`;
    if (num >= 1_000) return `$${(num / 1_000).toFixed(0)}K`;
    return `$${num.toFixed(0)}`;
  }

  /**
   * Opens the typeahead picker. Reuses the cb-dust-poc-* class names for
   * the popover frame so we don't ship duplicate styles for what's
   * essentially the same affordance.
   *
   * Always re-mints the JWT before showing search results, so a stale
   * cache from a previous Clay impersonation switch (or workspace
   * change) doesn't silently scope the picker to the wrong workspaces.
   * The cost is one round trip on open (~500ms); subsequent searches
   * reuse the fresh cache.
   */
  function showPicker(anchorEl, onPick) {
    closePopover();
    anchorRef = anchorEl;

    backdropEl = document.createElement("div");
    backdropEl.className = "cb-dust-poc-backdrop";
    backdropEl.addEventListener("click", closePopover);

    popoverEl = document.createElement("div");
    popoverEl.className = "cb-dust-poc-popover cb-sfdc-picker-popover";
    popoverEl.addEventListener("click", (evt) => evt.stopPropagation());

    const title = document.createElement("div");
    title.className = "cb-dust-poc-title";
    title.textContent = "Link Salesforce opportunity";

    const sub = document.createElement("div");
    sub.className = "cb-dust-poc-sub";
    sub.textContent = "Search by opportunity name";

    const input = document.createElement("input");
    input.type = "text";
    input.className = "cb-dust-poc-input cb-sfdc-picker-input";
    // The input is disabled until the identity re-check below resolves.
    input.disabled = true;
    input.placeholder = "Checking your Clay identity\u2026";
    input.autocomplete = "off";
    input.spellcheck = false;

    const results = document.createElement("div");
    results.className = "cb-sfdc-picker-results";

    const status = document.createElement("div");
    status.className = "cb-dust-poc-status";

    popoverEl.appendChild(title);
    popoverEl.appendChild(sub);
    popoverEl.appendChild(input);
    popoverEl.appendChild(results);
    popoverEl.appendChild(status);

    document.body.appendChild(backdropEl);
    document.body.appendChild(popoverEl);
    document.addEventListener("keydown", onKeydown);
    positionPopover();

    // Force a JWT refresh before the user starts typing. Catches the
    // "I just stopped impersonating someone" case where the cached JWT
    // belongs to the wrong Clay user.
    (async () => {
      let refreshed = null;
      try {
        if (__cb.refreshSupabaseJwt) {
          refreshed = await __cb.refreshSupabaseJwt();
        }
      } catch (err) {
        // refreshSupabaseJwt swallows its own errors and returns null,
        // but defensively guard so a thrown error doesn't leave the
        // popover stuck in the disabled state.
        console.warn("[Clay Scoping] SFDC picker JWT refresh threw:", err);
      }
      // If the popover was closed while we were refreshing, bail out.
      if (popoverEl !== anchorRef?.ownerDocument?.querySelector(".cb-sfdc-picker-popover")) {
        if (!popoverEl) return;
      }
      if (!refreshed) {
        // Mint failed (no Clay session, or clay-auth-mint returned an
        // error). Tell the user; leave the input disabled.
        input.placeholder = "Couldn't verify your Clay session";
        status.className = "cb-dust-poc-status cb-dust-poc-status-error";
        status.textContent = "Reload the Clay tab and try again. If that doesn't help, sign out + back in to app.clay.com.";
        return;
      }
      // JWT is fresh. Enable the input so the user can type.
      input.disabled = false;
      input.placeholder = "Type at least 2 characters\u2026";
      input.focus();
    })();

    // Debounce typing. Each keystroke schedules a search 250ms later;
    // if another keystroke arrives first, the timer resets. Bursts of
    // typing collapse to a single SOSL query.
    let debounceTimer = null;
    let lastReqId = 0;
    let resizeAnimEnd = null;

    function setStatus(kind, html) {
      status.className = `cb-dust-poc-status cb-dust-poc-status-${kind}`;
      status.innerHTML = html;
    }

    function clearStatus() {
      status.className = "cb-dust-poc-status";
      status.innerHTML = "";
    }

    // Smoothly grow/shrink the popover as the status line and results come and
    // go, so the picker feels like it settles onto its content instead of
    // jumping. Measures the natural height before and after `mutate`, then
    // transitions between the two. The popover is box-sizing:border-box (see
    // sfdc.css) so offsetHeight maps directly to the height we assign. No-ops
    // the animation (but still mutates) when the popover is gone, the height
    // is unchanged, or the user prefers reduced motion.
    function animateResize(mutate) {
      if (!popoverEl) { mutate(); return; }
      const reduce = window.matchMedia
        && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

      // Cancel any in-flight resize so listeners don't stack and fight.
      if (resizeAnimEnd) {
        popoverEl.removeEventListener("transitionend", resizeAnimEnd);
        resizeAnimEnd = null;
      }
      popoverEl.style.transition = "none";

      const startH = popoverEl.offsetHeight;
      popoverEl.style.height = "auto";
      mutate();
      const endH = popoverEl.offsetHeight;

      if (reduce || Math.abs(startH - endH) < 1) {
        popoverEl.style.height = "";
        popoverEl.style.transition = "";
        popoverEl.style.overflow = "";
        return;
      }

      // overflow:hidden so taller content is clipped to the animating height
      // rather than spilling out of the rounded frame mid-transition.
      popoverEl.style.overflow = "hidden";
      popoverEl.style.height = startH + "px";
      void popoverEl.offsetHeight; // commit the start height before animating
      popoverEl.style.transition = "height 0.18s ease";
      popoverEl.style.height = endH + "px";

      resizeAnimEnd = (evt) => {
        if (evt.target !== popoverEl || evt.propertyName !== "height") return;
        popoverEl.style.transition = "";
        popoverEl.style.height = "";
        popoverEl.style.overflow = "";
        popoverEl.removeEventListener("transitionend", resizeAnimEnd);
        resizeAnimEnd = null;
      };
      popoverEl.addEventListener("transitionend", resizeAnimEnd);
    }

    function renderResults(records) {
      results.innerHTML = "";
      if (!records || records.length === 0) {
        const empty = document.createElement("div");
        empty.className = "cb-sfdc-picker-empty";
        empty.textContent = "No open opportunities match that name.";
        results.appendChild(empty);
        return;
      }
      for (const r of records) {
        const row = document.createElement("button");
        row.type = "button";
        row.className = "cb-sfdc-picker-row";
        row.addEventListener("click", (evt) => {
          evt.stopPropagation();
          closePopover();
          if (typeof onPick === "function") onPick(r);
        });

        const main = document.createElement("div");
        main.className = "cb-sfdc-picker-row-main";
        const nameEl = document.createElement("div");
        nameEl.className = "cb-sfdc-picker-row-name";
        nameEl.textContent = r.name || "(no name)";
        const metaEl = document.createElement("div");
        metaEl.className = "cb-sfdc-picker-row-meta";
        const metaParts = [];
        if (r.accountName) metaParts.push(r.accountName);
        if (r.stageName) metaParts.push(r.stageName);
        if (r.closeDate) metaParts.push(r.closeDate);
        metaEl.textContent = metaParts.join(" \u00b7 ");
        main.appendChild(nameEl);
        main.appendChild(metaEl);

        const amount = document.createElement("div");
        amount.className = "cb-sfdc-picker-row-amount";
        amount.textContent = formatAmount(r.amount);

        row.appendChild(main);
        row.appendChild(amount);
        results.appendChild(row);
      }
    }

    async function runSearch(q) {
      const reqId = ++lastReqId;
      animateResize(() => setStatus("info", "Searching\u2026"));
      try {
        const data = await searchOpportunities(q);
        if (reqId !== lastReqId) return; // a newer search has superseded us
        animateResize(() => {
          clearStatus();
          renderResults(data?.records || []);
        });
      } catch (err) {
        if (reqId !== lastReqId) return;
        console.warn("[Clay Scoping] SFDC search failed:", err);
        // 403 specifically means "your Clay workspaces don't include an
        // internal one" — surface a more helpful message than the raw
        // server text, since reps may be confused why their access was
        // denied. We forced a JWT refresh on picker open so this is the
        // authoritative answer, not stale-cache noise.
        animateResize(() => {
          if (err?.status === 403) {
            setStatus(
              "error",
              "You're not signed in to a Clay workspace that's allowed to use the SFDC integration. If you were impersonating someone, stop impersonating in app.clay.com and reopen this picker.",
            );
          } else if (err?.status === 401) {
            setStatus(
              "error",
              "Your Clay session expired. Reload the Clay tab and try again.",
            );
          } else {
            setStatus("error", escapeHtml(err?.message || "Search failed."));
          }
        });
      }
    }

    input.addEventListener("input", () => {
      const q = input.value.trim();
      if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
      if (q.length < 2) {
        animateResize(() => {
          results.innerHTML = "";
          clearStatus();
        });
        return;
      }
      debounceTimer = setTimeout(() => runSearch(q), 250);
    });

    input.addEventListener("keydown", (evt) => {
      if (evt.key === "Enter") {
        evt.preventDefault();
        // Enter picks the first result, if any.
        const firstRow = results.querySelector(".cb-sfdc-picker-row");
        if (firstRow) firstRow.click();
      }
    });
  }

  // --- Linked-opp details popover --------------------------------------------
  //
  // Mirrors the gtme-calculator's linked-opportunity card (see
  // monorepo/apps/mono-calculator ConfigTabs.tsx): a header caption + opp
  // name + a detail grid (Account / Stage / Amount / Close / Owner) fetched
  // lazily via getOpportunity, then the action rows. Replaces the old
  // chevron-dropdown + label-link affordance — the whole pill is now a
  // button that opens this popover.

  const DETAILS_EXTERNAL_SVG =
    '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></svg>';
  const DETAILS_PENCIL_SVG =
    '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>';
  const DETAILS_UNLINK_SVG =
    '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m18.84 12.25 1.72-1.71a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="m5.17 11.75-1.71 1.71a5 5 0 0 0 7.07 7.07l1.71-1.71"/><line x1="8" y1="2" x2="8" y2="5"/><line x1="2" y1="8" x2="5" y2="8"/><line x1="16" y1="19" x2="16" y2="22"/><line x1="19" y1="16" x2="22" y2="16"/></svg>';

  let menuEl = null;
  let menuBackdropEl = null;
  function closeMenu() {
    if (menuEl) { menuEl.remove(); menuEl = null; }
    if (menuBackdropEl) { menuBackdropEl.remove(); menuBackdropEl = null; }
  }

  // Fills `wrap` with the opportunity detail rows. Only present fields are
  // rendered (matches the calculator); empty when nothing's available.
  function renderDetailRows(wrap, d) {
    wrap.innerHTML = "";
    if (!d) return;
    const rows = [];
    if (d.accountName) rows.push(["Account", d.accountName]);
    if (d.stageName) rows.push(["Stage", d.stageName]);
    const amt = formatAmount(d.amount);
    if (amt) rows.push(["Amount", amt]);
    if (d.closeDate) rows.push(["Close", d.closeDate]);
    if (d.ownerEmail) rows.push(["Owner", d.ownerEmail]);
    if (rows.length === 0) return;
    const dl = document.createElement("dl");
    dl.className = "cb-sfdc-details-dl";
    for (const [k, v] of rows) {
      const dt = document.createElement("dt");
      dt.textContent = k;
      const dd = document.createElement("dd");
      dd.textContent = v;
      dd.title = v;
      dl.appendChild(dt);
      dl.appendChild(dd);
    }
    wrap.appendChild(dl);
  }

  function showLinkedOppDetails(anchorEl) {
    closeMenu();
    menuBackdropEl = document.createElement("div");
    menuBackdropEl.style.cssText = "position:fixed;inset:0;z-index:9999998;";
    menuBackdropEl.addEventListener("click", closeMenu);

    menuEl = document.createElement("div");
    menuEl.className = "cb-sfdc-details";
    menuEl.addEventListener("click", (evt) => evt.stopPropagation());

    // Header: caption + name + detail grid.
    const head = document.createElement("div");
    head.className = "cb-sfdc-details-head";

    const caption = document.createElement("div");
    caption.className = "cb-sfdc-details-caption";
    caption.textContent = "Linked Salesforce opportunity";
    head.appendChild(caption);

    const name = document.createElement("div");
    name.className = "cb-sfdc-details-name";
    name.textContent = linkedOpp?.name || linkedOpp?.id || "";
    name.title = name.textContent;
    head.appendChild(name);

    const body = document.createElement("div");
    body.className = "cb-sfdc-details-body";
    body.innerHTML =
      '<div class="cb-sfdc-details-loading"><span class="cb-sfdc-details-spinner" aria-hidden="true"></span>Loading details\u2026</div>';
    head.appendChild(body);

    menuEl.appendChild(head);

    // Actions.
    const openBtn = document.createElement("button");
    openBtn.type = "button";
    openBtn.className = "cb-sfdc-details-action";
    openBtn.innerHTML = DETAILS_EXTERNAL_SVG + "<span>Open in Salesforce</span>";
    openBtn.addEventListener("click", () => {
      closeMenu();
      if (linkedOpp?.url) window.open(linkedOpp.url, "_blank", "noopener,noreferrer");
    });

    const changeBtn = document.createElement("button");
    changeBtn.type = "button";
    changeBtn.className = "cb-sfdc-details-action";
    changeBtn.innerHTML = DETAILS_PENCIL_SVG + "<span>Change opportunity</span>";
    changeBtn.addEventListener("click", () => {
      closeMenu();
      showPicker(anchorEl, async (opp) => {
        try {
          await linkCanvasToOpportunity(__cb.currentWorkbookId, opp);
        } catch (err) {
          console.error("[Clay Scoping] linkCanvasToOpportunity failed:", err);
          alert(`Failed to link opportunity: ${err?.message || err}`);
        }
      });
    });

    const unlinkBtn = document.createElement("button");
    unlinkBtn.type = "button";
    unlinkBtn.className = "cb-sfdc-details-action cb-sfdc-details-action-danger";
    unlinkBtn.innerHTML = DETAILS_UNLINK_SVG + "<span>Unlink</span>";
    unlinkBtn.addEventListener("click", async () => {
      closeMenu();
      try {
        await unlinkCanvasFromOpportunity(__cb.currentWorkbookId);
      } catch (err) {
        console.error("[Clay Scoping] unlinkCanvasFromOpportunity failed:", err);
        alert(`Failed to unlink opportunity: ${err?.message || err}`);
      }
    });

    menuEl.appendChild(openBtn);
    menuEl.appendChild(changeBtn);
    menuEl.appendChild(unlinkBtn);

    document.body.appendChild(menuBackdropEl);
    document.body.appendChild(menuEl);

    // Right-aligned under the pill. Grows downward as details load, so the
    // top/left anchor stays put.
    const rect = anchorEl.getBoundingClientRect();
    menuEl.style.position = "fixed";
    menuEl.style.zIndex = "9999999";
    menuEl.style.top = rect.bottom + 4 + "px";
    const width = menuEl.offsetWidth || 300;
    menuEl.style.left = Math.max(8, rect.right - width) + "px";

    // Lazily fetch the full record for the detail grid (5min in-memory
    // cache, so reopening is instant). Guard against the popover closing
    // mid-flight.
    const oppId = linkedOpp?.id;
    if (oppId) {
      getOpportunity(oppId)
        .then((d) => {
          if (menuEl) renderDetailRows(body, d);
        })
        .catch((err) => {
          console.warn("[Clay Scoping] getOpportunity failed:", err);
          if (menuEl) {
            body.innerHTML =
              '<div class="cb-sfdc-details-loading">Couldn\u2019t load details.</div>';
          }
        });
    } else {
      body.innerHTML = "";
    }
  }

  // Caps the linked-opp pill's width at the "Generate POC" button's rendered
  // width. Deferred to a frame so the measurement is reliable: when a canvas
  // is re-opened with an already-linked opp, render() fires synchronously
  // while the toolbar is still being constructed — the Generate POC button
  // isn't in the DOM yet, so an inline measurement would read 0 and the pill
  // would fall back to its wider CSS max-width. requestAnimationFrame runs
  // after the topbar is laid out, so offsetWidth is always valid by then.
  function sizePillToGenPoc(pillEl) {
    const apply = () => {
      if (!pillEl.isConnected) return;
      const genPocBtn = document.querySelector(".cb-toolbar-dust-poc");
      const w = genPocBtn ? genPocBtn.offsetWidth : 0;
      if (w > 0) pillEl.style.maxWidth = w + "px";
    };
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(apply);
    } else {
      apply();
    }
  }

  // --- Topbar element factory ------------------------------------------------

  /**
   * Builds a single DOM element to insert into the canvas topbar. The
   * element internally swaps between the "Link opportunity" button state
   * and the "linked-opp pill" state based on the current linked opp.
   *
   * Returns the wrapper element. Subscribes to onLinkedOppChange so the
   * caller doesn't have to manage re-renders.
   */
  function buildToolbarElement() {
    const wrap = document.createElement("div");
    wrap.className = "cb-sfdc-toolbar";

    function render() {
      wrap.innerHTML = "";
      if (linkedOpp) {
        // Linked state: a single button (no inline link, no chevron) that
        // opens the linked-opp details popover. Matches the gtme-calculator.
        const pill = document.createElement("button");
        pill.type = "button";
        pill.className = "cb-sfdc-pill";
        pill.title = "View linked opportunity";

        const cloud = document.createElement("span");
        cloud.className = "cb-sfdc-pill-icon";
        cloud.innerHTML =
          '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.5 19a4.5 4.5 0 1 0-1.4-8.8 6 6 0 0 0-11.6 1.6A4 4 0 0 0 6 19h11.5z"/></svg>';
        pill.appendChild(cloud);

        const label = document.createElement("span");
        label.className = "cb-sfdc-pill-label";
        label.textContent = linkedOpp.name || linkedOpp.id;
        pill.appendChild(label);

        pill.addEventListener("click", (evt) => {
          evt.stopPropagation();
          showLinkedOppDetails(pill);
        });

        wrap.appendChild(pill);

        // Cap the pill at the "Generate POC" button's rendered width so a
        // long opportunity name truncates rather than letting the linked-opp
        // state dominate the toolbar (falls back to the CSS max-width when
        // that button isn't present, e.g. the `dust` feature is off).
        sizePillToGenPoc(pill);
      } else {
        // Unlinked: a single button.
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "cb-toolbar-btn cb-toolbar-sfdc-link";
        btn.title = "Link this canvas to a Salesforce opportunity";
        // Label wrapped in <span> (rather than a leading-space text
        // node) so the .cb-toolbar-sfdc-link `gap` rule has two real
        // flex children to space out — matches the Export / Cards
        // button construction. Without this, the cloud glyph renders
        // tight against the text the same way Import used to.
        btn.innerHTML =
          '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.5 19a4.5 4.5 0 1 0-1.4-8.8 6 6 0 0 0-11.6 1.6A4 4 0 0 0 6 19h11.5z"/></svg>' +
          "<span>Link opportunity</span>";
        btn.addEventListener("click", (evt) => {
          evt.stopPropagation();
          showPicker(btn, async (opp) => {
            try {
              await linkCanvasToOpportunity(__cb.currentWorkbookId, opp);
            } catch (err) {
              console.error("[Clay Scoping] linkCanvasToOpportunity failed:", err);
              alert(`Failed to link opportunity: ${err?.message || err}`);
            }
          });
        });
        wrap.appendChild(btn);
      }
    }

    onLinkedOppChange(render);
    return wrap;
  }

  // --- Public surface --------------------------------------------------------

  // Only exposed for users whose JWT carries the `sfdc` feature flag. On
  // a cold load (no cached JWT), hasFeature returns false synchronously,
  // so we also re-check after __cb.supabaseJwtReady resolves. The toolbar
  // injection in src/overlay.js uses `__cb.sfdc?.buildToolbarElement`,
  // which natively short-circuits when this assignment hasn't happened.
  function publishApi() {
    __cb.sfdc = {
      searchOpportunities,
      getOpportunity,
      hydrateLinkedOpportunity,
      linkCanvasToOpportunity,
      unlinkCanvasFromOpportunity,
      getLinkedOpportunity,
      setLinkedOpportunityLocal,
      onLinkedOppChange,
      showPicker,
      buildToolbarElement,
    };
  }

  if (__cb.hasFeature && __cb.hasFeature("sfdc")) {
    publishApi();
  } else if (__cb.supabaseJwtReady) {
    __cb.supabaseJwtReady.then(() => {
      if (__cb.hasFeature && __cb.hasFeature("sfdc")) publishApi();
    }).catch(() => { /* mint failed; leave the API unexposed */ });
  }
})();
