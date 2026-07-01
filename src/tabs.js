(function () {
  "use strict";

  const __cb = window.__cb;

  let nextTabId = 1;
  let tabBarEl = null;
  let saveTimer = null;

  function tabsStorageKey() {
    const ids = __cb.parseIdsFromUrl();
    return ids ? `cb-tabs-${ids.workbookId}` : null;
  }

  // The localStorage tab mirror is per-workbook and is only an offline / 
  // Supabase-down fallback (Supabase is the source of truth — see loadTabs).
  // Every workbook ever opened leaves a `cb-tabs-{wb}` blob behind (hundreds of
  // KB each), so they accumulate and eat the ~5MB origin budget shared with
  // Clay. Keep only the current workbook's mirror + per-workbook prefs; drop
  // the rest. Best-effort: never throw (a prune failure must not block a load).
  __cb.pruneTabMirrors = function (currentWorkbookId) {
    if (!currentWorkbookId) return;
    const suffix = `-${currentWorkbookId}`;
    const PREFIXES = ["cb-tabs-", "cb-active-tab-", "cb-pro-mode-", "cb-open-", "cb-canvas-"];
    try {
      const doomed = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (!k) continue;
        if (PREFIXES.some((p) => k.startsWith(p)) && !k.endsWith(suffix)) doomed.push(k);
      }
      for (const k of doomed) localStorage.removeItem(k);
    } catch (err) {
      console.warn("[Clay Scoping] pruneTabMirrors failed:", err);
    }
  };

  // Writes a tab blob to localStorage, pruning other workbooks' mirrors and
  // retrying once on a quota error before giving up. The mirror is only an
  // offline fallback (Supabase is authoritative), so a final failure is
  // non-fatal. `context` labels the warning for the originating call site.
  function safeWriteTabMirror(key, value, context) {
    try {
      localStorage.setItem(key, value);
    } catch (e) {
      try {
        const wb = __cb.currentWorkbookId || __cb.parseIdsFromUrl()?.workbookId;
        __cb.pruneTabMirrors(wb);
        localStorage.setItem(key, value);
      } catch (retryErr) {
        console.warn(`[Clay Scoping] ${context || "tab mirror"} write failed:`, retryErr);
      }
    }
  }
  __cb.safeWriteTabMirror = safeWriteTabMirror;

  // Pro Mode is a UX preference, not workbook content: the user's last
  // toggle should survive close/reopen for a short window so they don't
  // have to re-enable it every time. Stored per-workbook because the saved
  // card positions are pitched at the mode they were last laid out for —
  // see state.proMode and the open-time reflow in overlay.js.
  const PRO_MODE_TTL_MS = 60 * 60 * 1000;
  function proModeKey(workbookId) {
    return `cb-pro-mode-${workbookId}`;
  }

  __cb.readProModePreference = function (workbookId) {
    if (!workbookId) return false;
    try {
      const raw = localStorage.getItem(proModeKey(workbookId));
      if (!raw) return false;
      const parsed = JSON.parse(raw);
      const expiresAt = parsed?.expiresAt;
      if (typeof expiresAt === "number" && expiresAt > Date.now()) return true;
      // Lazy-clean expired or malformed entries so localStorage doesn't
      // accumulate stale keys for workbooks the user no longer touches.
      localStorage.removeItem(proModeKey(workbookId));
    } catch {
      // Corrupt JSON or quota error — treat as "no preference".
    }
    return false;
  };

  __cb.writeProModePreference = function (workbookId, enabled) {
    if (!workbookId) return;
    try {
      if (enabled) {
        localStorage.setItem(
          proModeKey(workbookId),
          JSON.stringify({ expiresAt: Date.now() + PRO_MODE_TTL_MS }),
        );
      } else {
        localStorage.removeItem(proModeKey(workbookId));
      }
    } catch (e) {
      console.warn("[Clay Scoping] writeProModePreference failed:", e);
    }
  };

  let nextTemplateId = 1;

  __cb.generateTabId = function () {
    return `tab-${nextTabId++}`;
  };

  function loadSavedTemplates() {
    try {
      const raw = localStorage.getItem("cb-saved-templates");
      if (!raw) return [];
      const templates = JSON.parse(raw);
      for (const t of templates) {
        const num = parseInt(t.id.replace("tpl-", ""), 10);
        if (!isNaN(num) && num >= nextTemplateId) nextTemplateId = num + 1;
      }
      return templates;
    } catch (e) {
      console.warn("[Clay Scoping] loadSavedTemplates failed:", e);
      return [];
    }
  }

  function saveSavedTemplates(templates) {
    try {
      localStorage.setItem("cb-saved-templates", JSON.stringify(templates));
    } catch (e) {
      console.warn("[Clay Scoping] saveSavedTemplates failed:", e);
    }
  }

  // Tracks the highest tab number we've seen across loaded tab stores so
  // generateTabId() returns ids that don't collide with stored ones.
  function bumpNextTabIdFromStore(store) {
    if (!store?.tabs) return;
    for (const t of store.tabs) {
      const num = parseInt(t.id.replace("tab-", ""), 10);
      if (!isNaN(num) && num >= nextTabId) nextTabId = num + 1;
    }
  }

  // Loads from localStorage only. Used as a synchronous fallback and to seed
  // the canvas immediately while the Supabase fetch resolves.
  function loadTabsLocal() {
    const key = tabsStorageKey();
    if (!key) return null;
    try {
      const raw = localStorage.getItem(key);
      if (raw) {
        const store = JSON.parse(raw);
        bumpNextTabIdFromStore(store);
        return store;
      }
      return migrateOldStorage(key);
    } catch (e) {
      console.warn("[Clay Scoping] loadTabsLocal failed:", e);
      return null;
    }
  }

  // Picks an activeId from a list of tabs, preferring (in order):
  //   1. The previously-active tab id stored in localStorage for this workbook
  //   2. The first non-hidden tab
  //   3. The first tab regardless of hidden flag
  function pickActiveId(tabs, workbookId) {
    if (!tabs || tabs.length === 0) return null;
    let preferred = null;
    try {
      preferred = localStorage.getItem(`cb-active-tab-${workbookId}`);
    } catch {}
    if (preferred && tabs.some(t => t.id === preferred)) return preferred;
    const visible = tabs.find(t => !t.hidden);
    return visible ? visible.id : tabs[0].id;
  }

  // Builds a tabStore object from a list of canvas_tabs rows (DB shape).
  function tabStoreFromRows(rows, workbookId) {
    const tabs = (rows || []).map(r => ({
      id: r.tab_id,
      name: r.name || "Scoping",
      hidden: !!r.hidden,
      state: r.state || {},
    }));
    return {
      activeId: pickActiveId(tabs, workbookId),
      tabs,
    };
  }

  // Tries Supabase first (network) then falls back to localStorage. The
  // function is async because of the network call; callers must `await` it.
  // If Supabase is unreachable, behavior matches the pre-Supabase extension.
  __cb.loadTabs = async function () {
    const key = tabsStorageKey();
    if (!key) return null;

    const ids = __cb.parseIdsFromUrl();
    // Scope the localStorage tab mirrors to the current workbook before doing
    // anything else — this is the natural "we know the current workbook" point.
    if (ids?.workbookId) __cb.pruneTabMirrors(ids.workbookId);
    const supa = window.__cbSupabase;
    if (ids && supa) {
      try {
        // New per-tab path: read canvas_tabs rows ordered by sort_order.
        const rows = await supa.supabaseFetch("canvas_tabs", "GET", {
          query: {
            workbook_id: `eq.${ids.workbookId}`,
            select: "*",
            order: "sort_order.asc",
          },
        });
        if (Array.isArray(rows) && rows.length > 0) {
          const store = tabStoreFromRows(rows, ids.workbookId);
          // Cache to localStorage so we still work offline next time. We've
          // already ensured the canvases row exists since rows came back, so
          // mark it as ensured to skip a redundant POST on the next save.
          ensuredCanvasRows.add(ids.workbookId);
          safeWriteTabMirror(key, JSON.stringify(store), "loadTabs cache");
          bumpNextTabIdFromStore(store);
          return store;
        }

        // Legacy fallback: workbook predates the canvas_tabs split. Read the
        // full state out of canvases.state. Backfill should have caught most
        // of these but leave the path in for safety.
        const legacy = await supa.supabaseFetch("canvases", "GET", {
          query: {
            workbook_id: `eq.${ids.workbookId}`,
            select: "state",
            limit: "1",
          },
        });
        if (Array.isArray(legacy) && legacy.length > 0 && legacy[0].state?.tabs) {
          const store = legacy[0].state;
          safeWriteTabMirror(key, JSON.stringify(store), "loadTabs legacy cache");
          bumpNextTabIdFromStore(store);
          return store;
        }
      } catch (err) {
        console.warn("[Clay Scoping] Supabase loadTabs failed, using localStorage:", err);
      }
    }

    return loadTabsLocal();
  };

  function migrateOldStorage(newKey) {
    const ids = __cb.parseIdsFromUrl();
    const oldKey = ids ? `cb-canvas-${ids.workbookId}` : null;
    if (!oldKey) return null;
    try {
      const raw = localStorage.getItem(oldKey);
      if (!raw) return null;
      const state = JSON.parse(raw);
      const tabId = __cb.generateTabId();
      const store = {
        activeId: tabId,
        tabs: [{ id: tabId, name: "Scoping", hidden: false, state }],
      };
      localStorage.setItem(newKey, JSON.stringify(store));
      localStorage.removeItem(oldKey);
      return store;
    } catch (e) {
      console.warn("[Clay Scoping] migration failed:", e);
      return null;
    }
  }

  // Tracks which workbook ids we've already ensured a canvases row for in
  // this page lifetime. Avoids a redundant POST on every tab save when the
  // parent row clearly exists (we just inserted/updated it ourselves).
  const ensuredCanvasRows = new Set();

  // Upserts canvases metadata (workspace + workbook names from the current URL).
  // Unlike ensureCanvasRow, always runs — used on canvas open so the breadcrumb
  // workspace (customer) is persisted even when the workbook was first saved
  // from an internal workspace.
  async function upsertCanvasMeta(workbookId, workspaceId) {
    if (!workbookId || !workspaceId) return;
    const supa = window.__cbSupabase;
    if (!supa) return;
    const updatedBy = __cb.userId || "unknown";
    const now = new Date().toISOString();

    let workbookName = null;
    if (__cb.getWorkbookName && workspaceId) {
      try {
        workbookName = await __cb.getWorkbookName(workspaceId, workbookId);
      } catch {
        workbookName = null;
      }
    }
    let workspaceName = null;
    let workspaceIconUrl = null;
    if (__cb.getWorkspaceMeta && workspaceId) {
      try {
        const wsMeta = await __cb.getWorkspaceMeta(workspaceId);
        workspaceName = wsMeta?.name || null;
        workspaceIconUrl = wsMeta?.iconUrl || null;
      } catch {
        workspaceName = null;
        workspaceIconUrl = null;
      }
    }
    const body = {
      workbook_id: workbookId,
      workspace_id: workspaceId,
      updated_at: now,
      updated_by: updatedBy,
    };
    if (workbookName) body.workbook_name = workbookName;
    if (workspaceName) {
      body.workspace_name = workspaceName;
      body.workspace_icon_url = workspaceIconUrl || "";
    }

    await supa.supabaseFetch("canvases", "POST", {
      prefer: "resolution=merge-duplicates",
      body,
    });
  }

  // Upserts the parent canvases row so the canvas_tabs FK is satisfied. Cheap
  // metadata-only write -- no `state` column included now that per-tab state
  // lives in canvas_tabs.
  async function ensureCanvasRow(workbookId, workspaceId) {
    if (!workbookId || ensuredCanvasRows.has(workbookId)) return;
    const supa = window.__cbSupabase;
    if (!supa) return;
    try {
      await upsertCanvasMeta(workbookId, workspaceId);
      ensuredCanvasRows.add(workbookId);
    } catch (err) {
      console.warn("[Clay Scoping] ensureCanvasRow failed:", err);
    }
  }

  __cb.refreshCanvasContextMeta = async function (workbookId, workspaceId) {
    if (!workbookId || !workspaceId) return;
    try {
      await upsertCanvasMeta(workbookId, workspaceId);
      ensuredCanvasRows.add(workbookId);
    } catch {
      // Non-critical — analytics may fall back to workbook name.
    }
  };

  // Convenience: upsert a tab by id, looking up its sort_order from the
  // current tabStore order. Used by tab CRUD paths (rename, hide, restore,
  // create, duplicate) so they don't have to compute sort_order themselves.
  async function saveTabRow(tabId) {
    if (!__cb.tabStore) return;
    const tab = __cb.tabStore.tabs.find(t => t.id === tabId);
    if (!tab) return;
    const idx = __cb.tabStore.tabs.indexOf(tab);
    const workbookId = __cb.currentWorkbookId || __cb.parseIdsFromUrl()?.workbookId;
    const workspaceId = __cb.currentWorkspaceId || __cb.parseIdsFromUrl()?.workspaceId;
    if (!workbookId) return;
    await pushTabToSupabase(workbookId, workspaceId, tab, idx);
  }
  // Exposed for stamps.js: persisting a stamp from the Clay table page (no
  // canvas open) needs a direct row push — debouncedSave/saveTabs only
  // re-serializes when the canvas exists.
  __cb.saveTabRow = saveTabRow;

  // Stamps + demo-spotlight highlights are mirrored onto every tab in memory
  // before save, but hydrate merges every tab's blob on load. After a delete,
  // push ALL tab rows and refresh the localStorage cache — otherwise stale
  // canvas_tabs rows (or a stale cache when the canvas is closed) resurrect
  // removed stamps/highlights on refresh.
  __cb.persistSharedTabBlobs = async function () {
    const workbookId = __cb.currentWorkbookId || __cb.parseIdsFromUrl()?.workbookId;
    const workspaceId = __cb.currentWorkspaceId || __cb.parseIdsFromUrl()?.workspaceId;
    if (!workbookId || !__cb.tabStore?.tabs?.length) return;

    const key = `cb-tabs-${workbookId}`;
    safeWriteTabMirror(key, JSON.stringify(__cb.tabStore), "persistSharedTabBlobs");

    const tabs = __cb.tabStore.tabs;
    await Promise.all(
      tabs.map((tab, i) => pushTabToSupabase(workbookId, workspaceId, tab, i)),
    );
  };

  // DELETE a canvas_tabs row. Trigger fires tabState/tabInvalidate with
  // operation=DELETE so peers can drop the tab from their local tabStore too.
  async function deleteTabRow(tabId) {
    const supa = window.__cbSupabase;
    if (!supa || !tabId) return;
    const workbookId = __cb.currentWorkbookId || __cb.parseIdsFromUrl()?.workbookId;
    if (!workbookId) return;
    try {
      await supa.supabaseFetch("canvas_tabs", "DELETE", {
        query: {
          workbook_id: `eq.${workbookId}`,
          tab_id: `eq.${tabId}`,
        },
      });
    } catch (err) {
      console.warn("[Clay Scoping] deleteTabRow failed:", err);
    }
  }

  const ACTIVITY_HEARTBEAT_MS = 5 * 60 * 1000;
  const lastActivityEventAt = new Map();
  let activityHeartbeatTimer = null;

  async function pushActivityEvent(workbookId, now) {
    const supa = window.__cbSupabase;
    if (!supa || !__cb.userId || !workbookId) return;
    await supa.supabaseFetch("canvas_activity_events", "POST", {
      body: {
        workbook_id: workbookId,
        user_id: __cb.userId,
        seen_at: now,
      },
    });
    lastActivityEventAt.set(workbookId, Date.now());
  }

  // Upserts a single tab's row to canvas_tabs. The trigger broadcasts a
  // tabState event (full row) and a tabInvalidate fallback to peers in the
  // same workbook. Fire-and-forget: errors are logged, never thrown.
  async function pushTabToSupabase(workbookId, workspaceId, tab, sortOrder) {
    const supa = window.__cbSupabase;
    if (!supa || !workbookId || !tab?.id) return;
    const updatedBy = __cb.userId || "unknown";
    const now = new Date().toISOString();

    // FK parent must exist. Cheap and idempotent (cached via ensuredCanvasRows).
    await ensureCanvasRow(workbookId, workspaceId);

    try {
      await supa.supabaseFetch("canvas_tabs", "POST", {
        prefer: "resolution=merge-duplicates",
        body: {
          workbook_id: workbookId,
          tab_id: tab.id,
          name: tab.name || "Scoping",
          hidden: tab.hidden ?? false,
          sort_order: sortOrder ?? 0,
          state: tab.state || {},
          updated_at: now,
          updated_by: updatedBy,
        },
      });
      if (__cb.userId) {
        await supa.supabaseFetch("canvas_contributors", "POST", {
          prefer: "resolution=merge-duplicates",
          body: {
            workbook_id: workbookId,
            user_id: __cb.userId,
            last_accessed_at: now,
          },
        });
        try {
          await pushActivityEvent(workbookId, now);
        } catch {
          // Non-critical heartbeat log.
        }
      }
    } catch (err) {
      console.warn("[Clay Scoping] pushTabToSupabase failed:", err);
    }
  }

  /**
   * Upserts only the caller's canvas_contributors row. Unlike pushToSupabase,
   * this does NOT touch the canvases row, so it's safe to call purely on
   * view (no edit needed) and as a periodic heartbeat.
   *
   * Also appends to canvas_activity_events (throttled) so usage analytics can
   * reconstruct daily session spans from discrete heartbeats.
   *
   * Silently ignores errors: the most common failure is an FK violation when
   * the user opens a never-saved workbook (no canvases row exists yet). The
   * first real save will create the canvases row and subsequent heartbeats
   * will succeed.
   */
  __cb.markCanvasActivity = async function (workbookId, { force = false } = {}) {
    const supa = window.__cbSupabase;
    if (!supa || !__cb.userId || !workbookId) return;
    const now = new Date().toISOString();
    const lastPing = lastActivityEventAt.get(workbookId) || 0;
    const shouldLogEvent = force || Date.now() - lastPing >= ACTIVITY_HEARTBEAT_MS;
    try {
      await supa.supabaseFetch("canvas_contributors", "POST", {
        prefer: "resolution=merge-duplicates",
        body: {
          workbook_id: workbookId,
          user_id: __cb.userId,
          last_accessed_at: now,
        },
      });
      if (shouldLogEvent) await pushActivityEvent(workbookId, now);
    } catch {
      // Non-critical; collaborators widget will just lack this user until the
      // next successful upsert (usually after the first save).
    }
  };

  __cb.startCanvasActivityHeartbeat = function (workbookId) {
    if (activityHeartbeatTimer) {
      clearInterval(activityHeartbeatTimer);
      activityHeartbeatTimer = null;
    }
    if (!workbookId) return;
    activityHeartbeatTimer = setInterval(() => {
      __cb.markCanvasActivity(workbookId);
    }, ACTIVITY_HEARTBEAT_MS);
  };

  __cb.stopCanvasActivityHeartbeat = function () {
    if (activityHeartbeatTimer) {
      clearInterval(activityHeartbeatTimer);
      activityHeartbeatTimer = null;
    }
  };

  __cb.saveTabs = function () {
    // Prefer the workbook the overlay was opened for (captured at openCanvas
    // time) over the current URL: a save triggered right after the user
    // navigated to another workbook must still write to the ORIGINAL
    // workbook's key, otherwise we corrupt the new workbook with stale data.
    const workbookId = __cb.currentWorkbookId || __cb.parseIdsFromUrl()?.workbookId;
    const workspaceId = __cb.currentWorkspaceId || __cb.parseIdsFromUrl()?.workspaceId;
    if (!workbookId || !__cb.tabStore) return;
    const key = `cb-tabs-${workbookId}`;

    // Re-serialize the active tab from the live canvas so the in-memory
    // tabStore reflects what the user actually sees right now.
    let activeTab = null;
    let activeIndex = -1;
    if (__cb.canvas && __cb.tabStore.activeId) {
      activeIndex = __cb.tabStore.tabs.findIndex(t => t.id === __cb.tabStore.activeId);
      if (activeIndex !== -1) {
        activeTab = __cb.tabStore.tabs[activeIndex];
        const state = __cb.model.serialize();
        const recordsInput = document.getElementById("cb-records-input");
        if (recordsInput) state.records = recordsInput.value;
        // The imported "actual" (POC) record count, so the indigo/override
        // styling survives reloads and tab switches.
        state.recordsActual = __cb.recordsActual ?? null;
        // Per-use-case (per imported table) records/frequency overrides.
        state.useCaseScope = __cb.useCaseScope ?? {};
        const creditCostInput = document.getElementById("cb-credit-cost-input");
        const actionCostInput = document.getElementById("cb-action-cost-input");
        const pricingGroup = document.querySelector(".cb-pricing-group");
        if (creditCostInput) state.creditCost = creditCostInput.value;
        if (actionCostInput) state.actionCost = actionCostInput.value;
        if (pricingGroup) state.pricingExpanded = pricingGroup.classList.contains("is-expanded");
        // Persist the global frequency default alongside the other
        // summary-bar values. Per-ER overrides ride along inside each card's
        // `data.frequency` / `data.frequencyCustom`, so they come back for
        // free via canvas.serialize() above.
        state.frequency = __cb.getCurrentFrequencyId
          ? __cb.getCurrentFrequencyId()
          : __cb.DEFAULT_FREQUENCY_ID;
        // Record the pitch (70 vs 96 px card height) the cards were laid
        // out for. On reopen, overlay.js compares this to the user's
        // localStorage Pro Mode preference and runs applyClusterReflow if
        // they differ, so snap-clusters survive a saved-pro/normal-reopen
        // (or vice versa) transition.
        state.proMode = !!__cb.proMode;
        // Cards/Tables view choice: per-tab so reps can keep some tabs as
        // canvases (brainstorming) and others as tables (review/scoping).
        // Defaults to "canvas" anywhere the field is absent.
        state.brainstormView = __cb.brainstormView === "table" ? "table" : "canvas";
        // Projected/Actual is per-tab so a multi-tab export can mix modes — each
        // tab remembers the view it was last left in (restored in switchTab).
        state.viewMode = __cb.viewMode === "actual" ? "actual" : "projected";
        // Multi-year pricing view: whether the tab is in pricing mode, the
        // selected contract length, and the per-use-case per-year records, so a
        // saved quote restores exactly.
        state.pricingMode = !!__cb.pricingMode;
        state.contractYears = Math.min(3, Math.max(1, __cb.contractYears || 1));
        state.pricingYearRecords = __cb.pricingYearRecords ?? {};
        // Pricing options (1-3). Legacy single-override tabs migrate on restore.
        state.pricingOptions = __cb.pricingOptions ?? null;
        // Actual-spend session picker: the bucketed sessions + selection + gap,
        // so reloads/other devices restore instantly with no /run/recent fetch.
        // Preserve the previously-saved blob when the controller has no live
        // state yet (e.g. saved before Actual was ever opened) so we don't wipe
        // it on an unrelated save.
        const sc = __cb.sessionCutoff?.serialize?.();
        state.sessionCutoff = sc || activeTab.state?.sessionCutoff || null;
        // Per-table stamp markers (src/stamps.js) ride along the same way.
        // serialize() is null only before hydration ("don't know yet" — keep
        // the previous blob); an empty object is a real all-deleted state.
        const stamps = __cb.stamps?.serialize?.();
        state.stampsByTable = stamps ?? activeTab.state?.stampsByTable ?? null;
        // Demo-spotlight highlights (src/highlights.js): same null-vs-empty
        // semantics as stamps.
        const hl = __cb.highlights?.serialize?.();
        state.highlightsByTable = hl ?? activeTab.state?.highlightsByTable ?? null;
        activeTab.state = state;
      }
    }

    // Local-first: localStorage cache is always current. We still write the
    // full tabStore here because that's what loadTabsLocal reads, and it's
    // a useful offline backup.
    safeWriteTabMirror(key, JSON.stringify(__cb.tabStore), "saveTabs");

    // Persist only the active tab to Supabase. Other tabs aren't dirty and
    // don't need to be re-uploaded; their canvas_tabs rows still hold the
    // last-saved state.
    if (activeTab) {
      pushTabToSupabase(workbookId, workspaceId, activeTab, activeIndex);
    }
  };

  __cb.debouncedSave = function () {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(__cb.saveTabs, 500);
  };

  __cb.cancelPendingSave = function () {
    clearTimeout(saveTimer);
  };

  // ---- Live save propagation (Supabase Realtime postgres_changes) ----

  // "Actively typing" check: clicking a card auto-focuses its contenteditable
  // text, so gating on focus alone (as we did before) froze live sync until
  // the user happened to click the empty canvas. We now only block when a
  // keystroke happened within the last INTERACTING_KEYSTROKE_WINDOW_MS. Stale
  // focus is fine; mid-word typing is what we're protecting against.
  const INTERACTING_KEYSTROKE_WINDOW_MS = 1500;
  let lastKeystrokeAt = 0;
  // Capture phase so we see the keystroke even if Clay/our own handlers
  // stopPropagation before bubble. We never prevent default; this is purely
  // observational.
  document.addEventListener(
    "keydown",
    () => { lastKeystrokeAt = Date.now(); },
    true,
  );

  function isUserInteracting() {
    return Date.now() - lastKeystrokeAt < INTERACTING_KEYSTROKE_WINDOW_MS;
  }

  /**
   * Handles a remote `canvases` row arriving via the realtime
   * postgres_changes / canvasInvalidate subscription (installed in
   * installRealtimeCanvasSync below).
   *
   * IMPORTANT: this must NOT apply `newRow.state` to the tab store. Per-tab
   * state now lives in `canvas_tabs` and syncs through applyRemoteTab(); the
   * `canvases` row no longer carries authoritative tab state (ensureCanvasRow
   * stopped writing the `state` column after the canvas_tabs split, so any
   * `state` left on the row is a stale pre-split blob). The only live data on
   * the row now is metadata (sfdc_opportunity_*, updated_at, dust POC fields).
   *
   * Replacing __cb.tabStore from that stale `state` here was wiping the live
   * tabs whenever a metadata-only PATCH fired a postgres_changes UPDATE — most
   * visibly when linking/unlinking a Salesforce opportunity (sfdc.js PATCHes
   * the row without touching `state` or `updated_by`), after which the tab bar
   * vanished until the canvas was closed and reopened.
   *
   * We keep the subscription only to mirror the linked Salesforce opportunity
   * so a peer's link/unlink updates everyone's pill live.
   */
  function applyRemoteCanvas(newRow) {
    if (!newRow) return;

    // Keep the Salesforce linked-opp pill in sync across collaborators.
    // setLinkedOpportunityLocal is idempotent (no-ops when unchanged), so the
    // local user's own echo is free and peers see link/unlink immediately.
    // `__cb.sfdc` is only published for users who have the `sfdc` feature flag.
    if (__cb.sfdc?.setLinkedOpportunityLocal && "sfdc_opportunity_id" in newRow) {
      try {
        __cb.sfdc.setLinkedOpportunityLocal(
          newRow.sfdc_opportunity_id
            ? {
                id: newRow.sfdc_opportunity_id,
                name: newRow.sfdc_opportunity_name || "",
                url: newRow.sfdc_opportunity_url || "",
              }
            : null,
        );
      } catch (err) {
        console.debug("[Clay Scoping] applyRemoteCanvas sfdc sync failed", err);
      }
    }
  }

  // Registered from overlay.js once the realtime channel is joined. Idempotent.
  let unsubCanvasUpdate = null;
  __cb.installRealtimeCanvasSync = function () {
    if (unsubCanvasUpdate || !__cb.realtime?.onCanvasUpdate) return;
    unsubCanvasUpdate = __cb.realtime.onCanvasUpdate(applyRemoteCanvas);
  };
  __cb.uninstallRealtimeCanvasSync = function () {
    if (unsubCanvasUpdate) { unsubCanvasUpdate(); unsubCanvasUpdate = null; }
  };

  // ---- Per-tab remote apply (canvas_tabs broadcasts) ----

  // Applies a remote canvas_tabs row into the local tabStore. The active
  // tab's state is re-rendered via canvas.restore; other tabs are updated
  // in memory only and the user sees them next time they switch.
  function applyRemoteTab(row) {
    // Loud entry log so we always know when applyRemoteTab fires, regardless
    // of which skip path is hit below.
    console.log("[Clay Scoping] applyRemoteTab entered", {
      tabId: row?.tab_id,
      workbookId: row?.workbook_id,
      updatedBy: row?.updated_by,
      deleted: !!row?.__deleted,
    });

    if (!row?.tab_id || !row.workbook_id) {
      console.log("[Clay Scoping] applyRemoteTab skipped: missing ids");
      return;
    }
    if (!__cb.tabStore) {
      console.log("[Clay Scoping] applyRemoteTab skipped: no tabStore");
      return;
    }

    // Only apply to the workbook we're currently viewing -- other channels
    // shouldn't even deliver these events, but be defensive.
    const currentWorkbookId = __cb.currentWorkbookId || __cb.parseIdsFromUrl()?.workbookId;
    if (currentWorkbookId && row.workbook_id !== currentWorkbookId) {
      console.log("[Clay Scoping] applyRemoteTab skipped: different workbook", {
        rowWorkbookId: row.workbook_id,
        currentWorkbookId,
      });
      return;
    }

    if (row.updated_by && row.updated_by === __cb.userId) {
      console.log("[Clay Scoping] applyRemoteTab skipped: own echo", { userId: __cb.userId });
      return;
    }

    const tabs = __cb.tabStore.tabs;
    const existingIdx = tabs.findIndex(t => t.id === row.tab_id);

    // DELETE: drop the tab and switch away if we were viewing it.
    if (row.__deleted) {
      if (existingIdx === -1) {
        console.log("[Clay Scoping] applyRemoteTab DELETE: tab not in local store, no-op");
        return;
      }
      tabs.splice(existingIdx, 1);
      console.log("[Clay Scoping] applyRemoteTab applied DELETE", { tabId: row.tab_id });
      if (__cb.tabStore.activeId === row.tab_id) {
        const fallback = tabs.find(t => !t.hidden) || tabs[0];
        if (fallback) {
          // Defer switchTab so callers (refetchTab, broadcast handler) finish
          // their stack before we tear down/rebuild the canvas.
          setTimeout(() => __cb.switchTab(fallback.id), 0);
        }
      }
      const key = tabsStorageKey();
      if (key) safeWriteTabMirror(key, JSON.stringify(__cb.tabStore), "applyRemoteTab delete");
      try { renderTabBar(); } catch {}
      return;
    }

    // Block while the user is mid-keystroke to avoid clobbering typing on
    // the active tab. Background tabs are safe to update either way.
    const isActive = __cb.tabStore.activeId === row.tab_id;
    if (isActive && isUserInteracting()) {
      console.log("[Clay Scoping] applyRemoteTab skipped: user typing on active tab");
      return;
    }

    const newTab = {
      id: row.tab_id,
      name: row.name || "Scoping",
      hidden: !!row.hidden,
      state: row.state || {},
    };

    if (existingIdx === -1) {
      // Insert at sort_order position (or append if past end).
      const idx = Math.min(row.sort_order ?? tabs.length, tabs.length);
      tabs.splice(idx, 0, newTab);
    } else {
      tabs[existingIdx] = newTab;
    }

    // Cache to localStorage so a refresh shows the new state.
    const key = tabsStorageKey();
    if (key) safeWriteTabMirror(key, JSON.stringify(__cb.tabStore), "applyRemoteTab");

    // If this is the tab the user is currently viewing, repaint the canvas.
    // Strip view so user B keeps their own pan/zoom (same pattern undo/redo
    // already uses internally).
    if (__cb.tabStore.activeId === row.tab_id && __cb.canvas) {
      console.log("[Clay Scoping] applyRemoteTab applied (active)", {
        tabId: row.tab_id,
        cards: newTab.state?.cards?.length,
        groups: newTab.state?.groups?.length,
      });
      const { view: _ignoredView, ...stateForRestore } = newTab.state;
      __cb.model.restore(stateForRestore);
      __cb.recordsActual = stateForRestore.recordsActual ?? null;
      __cb.useCaseScope = stateForRestore.useCaseScope ?? {};
      __cb.contractYears = Math.min(3, Math.max(1, stateForRestore.contractYears || 1));
      __cb.pricingYearRecords = stateForRestore.pricingYearRecords ?? {};
      __cb.pricingOptions = stateForRestore.pricingOptions ?? null;
      __cb.pricingTotalOverride = stateForRestore.pricingTotalOverride ?? { credits: {}, actionTier: {} };
      const recordsInput = document.getElementById("cb-records-input");
      if (recordsInput && stateForRestore.records != null) {
        recordsInput.value = stateForRestore.records;
        recordsInput.dispatchEvent(new Event("input"));
      }
      if (__cb.applyRecordsState) __cb.applyRecordsState();
    } else {
      console.log("[Clay Scoping] applyRemoteTab applied (background)", {
        tabId: row.tab_id,
      });
    }

    // Stamps live inside tab state — re-read so a stamp added by a
    // collaborator (or another device) shows up without a reload.
    __cb.stamps?.rehydrate?.();
    __cb.highlights?.rehydrate?.();

    // Tab bar may need a redraw if name/hidden changed.
    try { renderTabBar(); } catch {}
  }

  let unsubTabUpdate = null;
  __cb.installRealtimeTabSync = function () {
    if (unsubTabUpdate || !__cb.realtime?.onTabUpdate) return;
    unsubTabUpdate = __cb.realtime.onTabUpdate(applyRemoteTab);
  };
  __cb.uninstallRealtimeTabSync = function () {
    if (unsubTabUpdate) { unsubTabUpdate(); unsubTabUpdate = null; }
  };

  __cb.resetTabBar = function () {
    tabBarEl = null;
  };

  // Exposed so overlay.js can repaint the tab bar when a tab's pricing state
  // changes (toggling pricing view, adding/deleting options) — the amber tab
  // styling + options-count badge below read from tab.state.
  __cb.refreshTabBar = function () {
    try { renderTabBar(); } catch {}
  };

  // ---- Tab bar UI ----

  __cb.buildTabBar = function (leftGroup) {
    tabBarEl = document.createElement("div");
    tabBarEl.className = "cb-tab-bar";
    leftGroup.appendChild(tabBarEl);
    renderTabBar();
  };

  function renderTabBar() {
    if (!tabBarEl || !__cb.tabStore) return;
    tabBarEl.innerHTML = "";

    const visibleTabs = __cb.tabStore.tabs.filter(t => !t.hidden);

    for (const tab of visibleTabs) {
      const inPricing = !!tab.state?.pricingMode;
      const tabEl = document.createElement("div");
      tabEl.className =
        "cb-tab" +
        (tab.id === __cb.tabStore.activeId ? " cb-tab-active" : "") +
        (inPricing ? " cb-tab-pricing" : "");
      tabEl.setAttribute("data-tab-id", tab.id);

      const nameSpan = document.createElement("span");
      nameSpan.className = "cb-tab-name";
      nameSpan.textContent = tab.name;

      nameSpan.addEventListener("dblclick", (e) => {
        e.stopPropagation();
        startRenameTab(tab, nameSpan);
      });

      tabEl.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        e.stopPropagation();
        showTabContextMenu(e, tab, nameSpan);
      });

      tabEl.addEventListener("click", () => {
        if (tab.id !== __cb.tabStore.activeId) __cb.switchTab(tab.id);
      });

      const closeBtn = document.createElement("button");
      closeBtn.className = "cb-tab-close";
      closeBtn.innerHTML = "&#x2715;";
      closeBtn.title = "Delete tab";
      closeBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        hideTab(tab.id);
      });

      tabEl.appendChild(nameSpan);
      // Pricing view: a small amber pill with the number of options on this tab
      // (defaults to 1 for the ever-present Option A). Styled like the Actual
      // session-count badge.
      if (inPricing) {
        const badge = document.createElement("span");
        badge.className = "cb-tab-pricing-badge";
        const optCount = Array.isArray(tab.state?.pricingOptions)
          ? tab.state.pricingOptions.length
          : 1;
        badge.textContent = String(Math.max(1, optCount));
        tabEl.appendChild(badge);
      }
      tabEl.appendChild(closeBtn);
      tabBarEl.appendChild(tabEl);
    }

    const addBtn = document.createElement("button");
    addBtn.className = "cb-tab-add";
    addBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><line x1="7" y1="2" x2="7" y2="12"/><line x1="2" y1="7" x2="12" y2="7"/></svg>';
    addBtn.title = "New tab";
    addBtn.addEventListener("click", addNewTab);
    tabBarEl.appendChild(addBtn);

    const hiddenTabs = __cb.tabStore.tabs.filter(t => t.hidden);
    if (hiddenTabs.length > 0) {
      const wrap = document.createElement("div");
      wrap.className = "cb-hidden-tabs-wrap";

      const triggerBtn = document.createElement("button");
      triggerBtn.className = "cb-hidden-tabs-btn";
      triggerBtn.title = `${hiddenTabs.length} deleted tab${hiddenTabs.length !== 1 ? "s" : ""}`;
      triggerBtn.textContent = `${hiddenTabs.length} deleted`;

      const menu = document.createElement("div");
      menu.className = "cb-hidden-tabs-menu";

      for (const ht of hiddenTabs) {
        const item = document.createElement("div");
        item.className = "cb-hidden-tab-item";

        const nameBtn = document.createElement("button");
        nameBtn.className = "cb-hidden-tab-name";
        nameBtn.type = "button";
        nameBtn.textContent = ht.name;
        nameBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          restoreTab(ht.id);
        });

        const deleteBtn = document.createElement("button");
        deleteBtn.className = "cb-hidden-tab-delete";
        deleteBtn.type = "button";
        deleteBtn.innerHTML = "&#x2715;";
        deleteBtn.title = "Delete permanently";
        deleteBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          // Keep the dropdown open so several can be deleted in a row — drop
          // just this row + refresh the count instead of tearing down the menu.
          permanentlyDeleteTab(ht.id, { rerender: false });
          item.remove();
          const n = menu.querySelectorAll(".cb-hidden-tab-item").length;
          if (n === 0) {
            closeDeletedMenu(menu);
            renderTabBar();
          } else {
            triggerBtn.textContent = `${n} deleted`;
            triggerBtn.title = `${n} deleted tab${n !== 1 ? "s" : ""}`;
          }
        });

        item.appendChild(nameBtn);
        item.appendChild(deleteBtn);
        menu.appendChild(item);
      }

      triggerBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        const existing = (__cb.overlayEl || document.body).querySelector(".cb-hidden-tabs-menu-open");
        if (existing) {
          existing.remove();
          return;
        }

        const rect = triggerBtn.getBoundingClientRect();
        menu.style.left = `${rect.left}px`;
        menu.style.top = `${rect.bottom + 4}px`;
        menu.classList.add("cb-hidden-tabs-menu-open");
        (__cb.overlayEl || document.body).appendChild(menu);

        const closeFn = () => {
          closeDeletedMenu(menu);
          document.removeEventListener("click", closeFn);
          document.removeEventListener("contextmenu", closeFn);
        };
        setTimeout(() => {
          document.addEventListener("click", closeFn);
          document.addEventListener("contextmenu", closeFn);
        }, 0);
      });

      wrap.appendChild(triggerBtn);
      tabBarEl.appendChild(wrap);
    }

    const savedTemplates = loadSavedTemplates();
    if (savedTemplates.length > 0) {
      const savedWrap = document.createElement("div");
      savedWrap.className = "cb-hidden-tabs-wrap";

      const savedBtn = document.createElement("button");
      savedBtn.className = "cb-saved-tabs-btn";
      savedBtn.title = `${savedTemplates.length} saved canvas${savedTemplates.length !== 1 ? "es" : ""}`;
      savedBtn.textContent = `${savedTemplates.length} saved`;

      const savedMenu = document.createElement("div");
      savedMenu.className = "cb-hidden-tabs-menu";

      for (const tpl of savedTemplates) {
        const item = document.createElement("div");
        item.className = "cb-hidden-tab-item";

        const nameBtn = document.createElement("button");
        nameBtn.className = "cb-hidden-tab-name";
        nameBtn.type = "button";
        nameBtn.textContent = tpl.name;
        nameBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          closeSavedMenu(savedMenu);
          spawnFromTemplate(tpl);
        });

        const deleteBtn = document.createElement("button");
        deleteBtn.className = "cb-hidden-tab-delete";
        deleteBtn.type = "button";
        deleteBtn.innerHTML = "&#x2715;";
        deleteBtn.title = "Remove saved canvas";
        deleteBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          // Keep the dropdown open so several can be removed in a row — drop
          // just this row + refresh the count instead of tearing down the menu.
          removeSavedTemplate(tpl.id, { rerender: false });
          item.remove();
          const n = savedMenu.querySelectorAll(".cb-hidden-tab-item").length;
          if (n === 0) {
            closeSavedMenu(savedMenu);
            renderTabBar();
          } else {
            savedBtn.textContent = `${n} saved`;
            savedBtn.title = `${n} saved canvas${n !== 1 ? "es" : ""}`;
          }
        });

        item.addEventListener("contextmenu", (e) => {
          e.preventDefault();
          e.stopPropagation();
          showSavedItemContextMenu(e, tpl, nameBtn, savedMenu);
        });

        item.appendChild(nameBtn);
        item.appendChild(deleteBtn);
        savedMenu.appendChild(item);
      }

      savedBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        const existing = (__cb.overlayEl || document.body).querySelector(".cb-saved-menu-open");
        if (existing) {
          existing.remove();
          return;
        }

        const rect = savedBtn.getBoundingClientRect();
        savedMenu.style.left = `${rect.left}px`;
        savedMenu.style.top = `${rect.bottom + 4}px`;
        savedMenu.classList.add("cb-hidden-tabs-menu-open", "cb-saved-menu-open");
        (__cb.overlayEl || document.body).appendChild(savedMenu);

        const closeFn = () => {
          closeSavedMenu(savedMenu);
          document.removeEventListener("click", closeFn);
          document.removeEventListener("contextmenu", closeFn);
        };
        setTimeout(() => {
          document.addEventListener("click", closeFn);
          document.addEventListener("contextmenu", closeFn);
        }, 0);
      });

      savedWrap.appendChild(savedBtn);
      tabBarEl.appendChild(savedWrap);
    }
  }

  function closeSavedMenu(menuEl) {
    menuEl.classList.remove("cb-hidden-tabs-menu-open", "cb-saved-menu-open");
    if (menuEl.parentNode) menuEl.parentNode.removeChild(menuEl);
  }

  function startRenameTab(tab, nameSpan) {
    const input = document.createElement("input");
    input.type = "text";
    input.className = "cb-tab-rename";
    input.value = tab.name;

    function finishRename() {
      tab.name = input.value.trim() || "Scoping";
      // saveTabs only writes the active tab; explicitly upsert this one so a
      // rename of a non-active tab still propagates to peers.
      saveTabRow(tab.id);
      __cb.saveTabs();
      renderTabBar();
    }

    input.addEventListener("blur", finishRename);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") input.blur();
      if (e.key === "Escape") { input.value = tab.name; input.blur(); }
    });
    input.addEventListener("mousedown", (e) => e.stopPropagation());

    nameSpan.replaceWith(input);
    input.focus();
    input.select();
  }

  // ---- Context menu ----

  function closeDeletedMenu(menuEl) {
    menuEl.classList.remove("cb-hidden-tabs-menu-open");
    if (menuEl.parentNode) menuEl.parentNode.removeChild(menuEl);
  }

  function showTabContextMenu(e, tab, nameSpan) {
    closeTabContextMenu();

    const menu = document.createElement("div");
    menu.className = "cb-tab-context-menu";
    menu.style.left = `${e.clientX}px`;
    menu.style.top = `${e.clientY}px`;

    const renameItem = document.createElement("button");
    renameItem.className = "cb-tab-context-item";
    renameItem.textContent = "Rename";
    renameItem.addEventListener("click", (ev) => {
      ev.stopPropagation();
      closeTabContextMenu();
      if (tab.hidden) {
        restoreTab(tab.id);
        setTimeout(() => {
          const freshSpan = tabBarEl?.querySelector(
            `.cb-tab[data-tab-id="${tab.id}"] .cb-tab-name`
          );
          if (freshSpan) startRenameTab(tab, freshSpan);
        }, 0);
      } else {
        const freshSpan = tabBarEl?.querySelector(
          `.cb-tab[data-tab-id="${tab.id}"] .cb-tab-name`
        );
        startRenameTab(tab, freshSpan || nameSpan);
      }
    });

    const dupItem = document.createElement("button");
    dupItem.className = "cb-tab-context-item";
    dupItem.textContent = "Duplicate";
    dupItem.addEventListener("click", (ev) => {
      ev.stopPropagation();
      closeTabContextMenu();
      duplicateTab(tab);
    });

    menu.appendChild(renameItem);
    menu.appendChild(dupItem);

    if (!tab.hidden) {
      const saveItem = document.createElement("button");
      saveItem.className = "cb-tab-context-item";
      saveItem.textContent = "Save";
      saveItem.addEventListener("click", (ev) => {
        ev.stopPropagation();
        closeTabContextMenu();
        saveTabAsTemplate(tab);
      });
      menu.appendChild(saveItem);
    }

    if (tab.hidden) {
      const restoreItem = document.createElement("button");
      restoreItem.className = "cb-tab-context-item";
      restoreItem.textContent = "Restore";
      restoreItem.addEventListener("click", (ev) => {
        ev.stopPropagation();
        closeTabContextMenu();
        restoreTab(tab.id);
      });
      menu.appendChild(restoreItem);
    } else {
      const deleteItem = document.createElement("button");
      deleteItem.className = "cb-tab-context-item cb-tab-context-item-danger";
      deleteItem.textContent = "Delete";
      deleteItem.addEventListener("click", (ev) => {
        ev.stopPropagation();
        closeTabContextMenu();
        permanentlyDeleteTab(tab.id);
      });
      menu.appendChild(deleteItem);
    }

    (__cb.overlayEl || document.body).appendChild(menu);

    const closeFn = () => {
      closeTabContextMenu();
      document.removeEventListener("click", closeFn);
      document.removeEventListener("contextmenu", closeFn);
    };
    setTimeout(() => {
      document.addEventListener("click", closeFn);
      document.addEventListener("contextmenu", closeFn);
    }, 0);
  }

  function closeTabContextMenu() {
    document.querySelectorAll(".cb-tab-context-menu").forEach(m => m.remove());
    if (__cb.overlayEl) {
      __cb.overlayEl.querySelectorAll(".cb-tab-context-menu").forEach(m => m.remove());
    }
  }

  function duplicateTab(sourceTab) {
    if (!__cb.tabStore) return;
    __cb.saveTabs();

    const newId = __cb.generateTabId();
    const clonedState = sourceTab.state
      ? JSON.parse(JSON.stringify(sourceTab.state))
      : {};

    __cb.tabStore.tabs.push({
      id: newId,
      name: `${sourceTab.name} (copy)`,
      hidden: false,
      state: clonedState,
    });

    saveTabRow(newId);
    __cb.switchTab(newId);
  }

  function permanentlyDeleteTab(tabId, { rerender = true } = {}) {
    if (!__cb.tabStore) return;
    __cb.saveTabs();

    const idx = __cb.tabStore.tabs.findIndex(t => t.id === tabId);
    if (idx === -1) return;
    __cb.tabStore.tabs.splice(idx, 1);

    // Drop the row from canvas_tabs. Trigger fires tabState DELETE so peers
    // remove the tab from their local tabStore too.
    deleteTabRow(tabId);

    if (__cb.tabStore.activeId === tabId) {
      const visibleTabs = __cb.tabStore.tabs.filter(t => !t.hidden);
      if (visibleTabs.length === 0) {
        const newId = __cb.generateTabId();
        // Match addNewTab: a freshly created blank tab opens in the spreadsheet.
        __cb.tabStore.tabs.push({ id: newId, name: "Scoping", hidden: false, state: { brainstormView: "table" } });
        saveTabRow(newId);
        __cb.switchTab(newId);
      } else {
        __cb.switchTab(visibleTabs[0].id);
      }
    } else {
      __cb.saveTabs();
      if (rerender) renderTabBar();
    }
  }

  function saveTabAsTemplate(tab) {
    __cb.saveTabs();
    const templates = loadSavedTemplates();
    const clonedState = tab.state
      ? JSON.parse(JSON.stringify(tab.state))
      : null;
    templates.push({
      id: `tpl-${nextTemplateId++}`,
      name: tab.name,
      state: clonedState,
    });
    saveSavedTemplates(templates);
    renderTabBar();
  }

  function spawnFromTemplate(template) {
    if (!__cb.tabStore) return;
    __cb.saveTabs();
    const newId = __cb.generateTabId();
    const clonedState = template.state
      ? JSON.parse(JSON.stringify(template.state))
      : {};
    __cb.tabStore.tabs.push({
      id: newId,
      name: template.name,
      hidden: false,
      state: clonedState,
    });
    saveTabRow(newId);
    __cb.switchTab(newId);
  }

  function removeSavedTemplate(templateId, { rerender = true } = {}) {
    const templates = loadSavedTemplates();
    const idx = templates.findIndex(t => t.id === templateId);
    if (idx !== -1) templates.splice(idx, 1);
    saveSavedTemplates(templates);
    if (rerender) renderTabBar();
  }

  function showSavedItemContextMenu(e, tpl, nameBtn, savedMenu) {
    closeTabContextMenu();

    const menu = document.createElement("div");
    menu.className = "cb-tab-context-menu";
    menu.style.left = `${e.clientX}px`;
    menu.style.top = `${e.clientY}px`;

    const renameItem = document.createElement("button");
    renameItem.className = "cb-tab-context-item";
    renameItem.textContent = "Rename";
    renameItem.addEventListener("click", (ev) => {
      ev.stopPropagation();
      closeTabContextMenu();
      renameTemplate(tpl, nameBtn, savedMenu);
    });

    menu.appendChild(renameItem);
    (__cb.overlayEl || document.body).appendChild(menu);

    const closeFn = () => {
      closeTabContextMenu();
      document.removeEventListener("click", closeFn);
      document.removeEventListener("contextmenu", closeFn);
    };
    setTimeout(() => {
      document.addEventListener("click", closeFn);
      document.addEventListener("contextmenu", closeFn);
    }, 0);
  }

  function renameTemplate(tpl, nameBtn, savedMenu) {
    const input = document.createElement("input");
    input.type = "text";
    input.className = "cb-tab-rename";
    input.value = tpl.name;

    let finished = false;
    function finishRename() {
      if (finished) return;
      finished = true;
      const newName = input.value.trim() || tpl.name;
      const templates = loadSavedTemplates();
      const target = templates.find(t => t.id === tpl.id);
      if (target) target.name = newName;
      saveSavedTemplates(templates);
      closeSavedMenu(savedMenu);
      renderTabBar();
    }

    input.addEventListener("blur", finishRename);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") input.blur();
      if (e.key === "Escape") { input.value = tpl.name; input.blur(); }
    });
    input.addEventListener("mousedown", (e) => e.stopPropagation());
    input.addEventListener("click", (e) => e.stopPropagation());

    nameBtn.replaceWith(input);
    input.focus();
    input.select();
  }

  // ---- Tab switching ----

  __cb.switchTab = function (tabId) {
    if (!__cb.tabStore || tabId === __cb.tabStore.activeId) return;

    __cb.saveTabs();

    // Per-user, per-workbook active tab. Keeps each user on the tab they
    // last looked at when re-opening the workbook; not synced across users.
    const switchWorkbookId = __cb.currentWorkbookId || __cb.parseIdsFromUrl()?.workbookId;
    if (switchWorkbookId) {
      try { localStorage.setItem(`cb-active-tab-${switchWorkbookId}`, tabId); } catch {}
    }

    if (__cb.canvas) {
      __cb.canvas.destroy();
      __cb.canvas = null;
    }

    const canvasArea = document.getElementById("cb-canvas-area");
    if (canvasArea) canvasArea.innerHTML = "";

    __cb.tabStore.activeId = tabId;

    if (__cb.initCanvas && canvasArea) {
      __cb.canvas = __cb.initCanvas(canvasArea);
      // Re-install the wrapped save-plus-collaborators-refresh callback.
      // overlay.js installs this initially; switchTab must preserve it.
      // Keep the table-view refresh hook in sync — without it, edits made
      // on a tab that opens directly into Tables view wouldn't propagate
      // to the spreadsheet rows after a tab switch.
      __cb.onCanvasStateChange = function () {
        __cb.debouncedSave();
        const ids = __cb.parseIdsFromUrl();
        if (ids && __cb.refreshCollaborators) {
          setTimeout(() => __cb.refreshCollaborators(ids.workbookId), 800);
        }
        if (__cb.tableView?.refresh) __cb.tableView.refresh();
      };
    }

    const tab = __cb.tabStore.tabs.find(t => t.id === tabId);
    if (tab?.state && __cb.canvas) {
      __cb.model.restore(tab.state);
    }

    __cb.recordsActual = tab?.state?.recordsActual ?? null;
    __cb.useCaseScope = tab?.state?.useCaseScope ?? {};
    // Per-tab Projected/Actual: restore the mode this tab was last left in.
    // Actual mode reads real spend, which only an imported tab has — so a
    // non-imported tab (no recordsActual) falls back to Projected, otherwise the
    // summary sits on Actual showing 0 with no toggle visible to escape. Set the
    // mode before the recordsInput recalc + setBrainstormView mount below so they
    // render in the right mode directly.
    let desiredMode = tab?.state?.viewMode === "actual" ? "actual" : "projected";
    if (!(Number(__cb.recordsActual) > 0)) desiredMode = "projected";
    __cb.viewMode = desiredMode;
    if (__cb.tabStore) __cb.tabStore.viewMode = desiredMode;
    if (__cb.overlayEl) __cb.overlayEl.setAttribute("data-cb-view-mode", desiredMode);
    // Refresh the Actual loading flag for the tab we just entered (its cards may
    // already carry spend, or none) BEFORE the recalc below, so the summary
    // doesn't blur known numbers using the previous tab's state.
    __cb.applyActualSummaryState?.();

    // Session cutoff is per tab and DB-persisted — rehydrate from THIS tab's
    // saved blob (no fetch; re-stamps from the saved selection). Cards were just
    // restored above, so stamping has targets. Any imported table missing from
    // the blob is filled (reuse/fetch) inside restore.
    __cb.sessionCutoff?.restore?.(tab?.state?.sessionCutoff);

    // Stamps are workbook-scoped but stored per tab — re-merge from the store
    // so the toolbar button / session dividers reflect this tab's blob too.
    __cb.stamps?.rehydrate?.();
    __cb.highlights?.rehydrate?.();

    const recordsInput = document.getElementById("cb-records-input");
    if (recordsInput) {
      recordsInput.value = tab?.state?.records || "";
      recordsInput.dispatchEvent(new Event("input"));
    }

    const creditCostInput = document.getElementById("cb-credit-cost-input");
    if (creditCostInput) {
      creditCostInput.value = tab?.state?.creditCost || "$0.05";
      creditCostInput.dispatchEvent(new Event("blur"));
    }
    const actionCostInput = document.getElementById("cb-action-cost-input");
    if (actionCostInput) {
      actionCostInput.value = tab?.state?.actionCost || "$0.008";
      actionCostInput.dispatchEvent(new Event("blur"));
    }
    const pricingGroup = document.querySelector(".cb-pricing-group");
    const chevronEl = pricingGroup?.querySelector(".cb-chevron");
    const pricingToggleText = pricingGroup?.querySelector(".cb-pricing-toggle .cb-summary-value");
    if (pricingGroup) {
      const expanded = !!tab?.state?.pricingExpanded;
      pricingGroup.classList.toggle("is-expanded", expanded);
      if (chevronEl) chevronEl.classList.toggle("cb-chevron-open", expanded);
      if (pricingToggleText) pricingToggleText.textContent = expanded ? "Hide" : "Show";
      if (expanded) __cb.overlayEl?.setAttribute("data-cb-pricing-shown", "");
      else __cb.overlayEl?.removeAttribute("data-cb-pricing-shown");
    }

    // Multi-year pricing view: restore contract length + per-year records first,
    // then apply the mode (setPricingMode reads both and re-renders the strip +
    // table). Falls back to plain assignment before the summary bar exists.
    __cb.contractYears = Math.min(3, Math.max(1, tab?.state?.contractYears || 1));
    __cb.pricingYearRecords = tab?.state?.pricingYearRecords ?? {};
    // Restore options; keep the legacy single override around so getPricingOptions
    // can migrate it when a tab predates the multi-option model.
    __cb.pricingOptions = tab?.state?.pricingOptions ?? null;
    __cb.pricingTotalOverride = tab?.state?.pricingTotalOverride ?? { credits: {}, actionTier: {} };
    if (__cb.setPricingMode) {
      __cb.setPricingMode(!!tab?.state?.pricingMode);
    } else {
      __cb.pricingMode = !!tab?.state?.pricingMode;
    }

    // Apply the tab's saved global frequency. setGlobalFrequency walks the
    // ER cards (updateDefaultFrequencies) and re-runs the credit math, so
    // the summary-bar trigger, the ER badges, and the totals all end up in
    // sync with the tab we just switched to.
    if (__cb.setGlobalFrequency) {
      __cb.setGlobalFrequency(
        tab?.state?.frequency || __cb.DEFAULT_FREQUENCY_ID,
        { skipSave: true }
      );
    }

    // Re-apply Cards/Tables choice for the tab we just switched into. Falls
    // back to "canvas" so legacy tabs (no brainstormView field) and freshly
    // created tabs (state = {}) land on the canvas as expected.
    if (__cb.setBrainstormView) {
      __cb.setBrainstormView(tab?.state?.brainstormView === "table" ? "table" : "canvas");
    }

    __cb.saveTabs();
    renderTabBar();

    // Refresh the collaborators widget; the widget itself is workbook-scoped
    // so the IDs don't change, but refreshing keeps data current.
    const ids = __cb.parseIdsFromUrl();
    if (ids && __cb.refreshCollaborators) {
      __cb.refreshCollaborators(ids.workbookId);
    }
  };

  function addNewTab() {
    if (!__cb.tabStore) return;
    __cb.saveTabs();
    const tabId = __cb.generateTabId();
    // Seed the per-tab Cards/Tables choice to "table" so new tabs open in the
    // spreadsheet — the canonical entry point for scoping. switchTab reads
    // state.brainstormView, so this guarantees the "+" lands on Tables.
    __cb.tabStore.tabs.push({ id: tabId, name: "Scoping", hidden: false, state: { brainstormView: "table" } });
    // Persist the new tab row immediately so peers see it appear in their
    // tab bar even before the user does anything inside it.
    saveTabRow(tabId);
    __cb.switchTab(tabId);
  }

  const MAX_DELETED = 3;

  function hideTab(tabId) {
    if (!__cb.tabStore) return;
    __cb.saveTabs();

    const tab = __cb.tabStore.tabs.find(t => t.id === tabId);
    if (!tab) return;
    tab.hidden = true;
    // Persist hidden=true (UPDATE) so peers see the tab move to the deleted
    // bin in their tab bar.
    saveTabRow(tabId);

    const hiddenTabs = __cb.tabStore.tabs.filter(t => t.hidden);
    while (hiddenTabs.length > MAX_DELETED) {
      const oldest = hiddenTabs.shift();
      const idx = __cb.tabStore.tabs.indexOf(oldest);
      if (idx !== -1) {
        __cb.tabStore.tabs.splice(idx, 1);
        // Capacity-driven hard delete: also drop the row from the DB.
        deleteTabRow(oldest.id);
      }
    }

    if (__cb.tabStore.activeId === tabId) {
      const visibleTabs = __cb.tabStore.tabs.filter(t => !t.hidden);
      if (visibleTabs.length === 0) {
        const newId = __cb.generateTabId();
        // Match addNewTab: a freshly created blank tab opens in the spreadsheet.
        __cb.tabStore.tabs.push({ id: newId, name: "Scoping", hidden: false, state: { brainstormView: "table" } });
        saveTabRow(newId);
        __cb.switchTab(newId);
      } else {
        __cb.switchTab(visibleTabs[0].id);
      }
    } else {
      __cb.saveTabs();
      renderTabBar();
    }
  }

  function restoreTab(tabId) {
    if (!__cb.tabStore) return;
    const tab = __cb.tabStore.tabs.find(t => t.id === tabId);
    if (!tab) return;
    tab.hidden = false;
    // Persist hidden=false so peers see the tab reappear in the visible row.
    saveTabRow(tabId);
    __cb.switchTab(tabId);
  }
})();
