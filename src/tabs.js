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

  // Tries Supabase first (network) then falls back to localStorage. The
  // function is async because of the network call; callers must `await` it.
  // If Supabase is unreachable, behavior matches the pre-Supabase extension.
  __cb.loadTabs = async function () {
    const key = tabsStorageKey();
    if (!key) return null;

    const ids = __cb.parseIdsFromUrl();
    const supa = window.__cbSupabase;
    if (ids && supa) {
      try {
        const rows = await supa.supabaseFetch("canvases", "GET", {
          query: {
            workbook_id: `eq.${ids.workbookId}`,
            select: "state",
            limit: "1",
          },
        });
        if (Array.isArray(rows) && rows.length > 0 && rows[0].state) {
          const store = rows[0].state;
          // Cache to localStorage so we still work offline next time.
          try {
            localStorage.setItem(key, JSON.stringify(store));
          } catch (e) {
            console.warn("[Clay Scoping] localStorage cache write failed:", e);
          }
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

  // Pushes the current tab store to Supabase (canvases + canvas_contributors).
  // Fire-and-forget: errors are logged, never thrown. This runs after the
  // localStorage write so even if Supabase is down, the user's work is safe.
  async function pushToSupabase(workbookId, workspaceId, tabStore) {
    const supa = window.__cbSupabase;
    if (!supa) return;

    const updatedBy = __cb.userId || "unknown";
    const now = new Date().toISOString();

    // Resolve the workbook name in parallel with the save. If it's not ready
    // yet (first save after opening) we just upsert without it; a later save
    // will fill it in. Avoids blocking the save on an extra network call.
    let workbookName = null;
    if (__cb.getWorkbookName) {
      try {
        workbookName = await __cb.getWorkbookName(workspaceId, workbookId);
      } catch {
        workbookName = null;
      }
    }

    const canvasBody = {
      workbook_id: workbookId,
      workspace_id: workspaceId,
      state: tabStore,
      updated_at: now,
      updated_by: updatedBy,
    };
    if (workbookName) canvasBody.workbook_name = workbookName;

    supa.supabaseFetch("canvases", "POST", {
      prefer: "resolution=merge-duplicates",
      body: canvasBody,
    }).then(() => {
      // Only record contributorship if we have a real user id. The contributor
      // upsert depends on the canvas row existing, so we chain it after.
      if (!__cb.userId) return null;
      return supa.supabaseFetch("canvas_contributors", "POST", {
        prefer: "resolution=merge-duplicates",
        body: {
          workbook_id: workbookId,
          user_id: __cb.userId,
          last_accessed_at: now,
        },
      });
    }).catch(err => {
      console.warn("[Clay Scoping] Supabase save failed:", err);
    });
  }

  __cb.saveTabs = function () {
    // Prefer the workbook the overlay was opened for (captured at openCanvas
    // time) over the current URL: a save triggered right after the user
    // navigated to another workbook must still write to the ORIGINAL
    // workbook's key, otherwise we corrupt the new workbook with stale data.
    const workbookId = __cb.currentWorkbookId || __cb.parseIdsFromUrl()?.workbookId;
    const workspaceId = __cb.currentWorkspaceId || __cb.parseIdsFromUrl()?.workspaceId;
    if (!workbookId || !__cb.tabStore) return;
    const key = `cb-tabs-${workbookId}`;
    if (__cb.canvas && __cb.tabStore.activeId) {
      const activeTab = __cb.tabStore.tabs.find(t => t.id === __cb.tabStore.activeId);
      if (activeTab) {
        const state = __cb.canvas.serialize();
        const recordsInput = document.getElementById("cb-records-input");
        if (recordsInput) state.records = recordsInput.value;
        const creditCostInput = document.getElementById("cb-credit-cost-input");
        const actionCostInput = document.getElementById("cb-action-cost-input");
        const pricingGroup = document.querySelector(".cb-pricing-group");
        if (creditCostInput) state.creditCost = creditCostInput.value;
        if (actionCostInput) state.actionCost = actionCostInput.value;
        if (pricingGroup) state.pricingExpanded = pricingGroup.classList.contains("is-expanded");
        activeTab.state = state;
      }
    }
    try {
      localStorage.setItem(key, JSON.stringify(__cb.tabStore));
    } catch (e) {
      console.warn("[Clay Scoping] saveTabs failed:", e);
    }

    if (workspaceId) pushToSupabase(workbookId, workspaceId, __cb.tabStore);
  };

  __cb.debouncedSave = function () {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(__cb.saveTabs, 500);
  };

  __cb.cancelPendingSave = function () {
    clearTimeout(saveTimer);
  };

  __cb.resetTabBar = function () {
    tabBarEl = null;
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
      const tabEl = document.createElement("div");
      tabEl.className = "cb-tab" + (tab.id === __cb.tabStore.activeId ? " cb-tab-active" : "");
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
      tabEl.appendChild(closeBtn);
      tabBarEl.appendChild(tabEl);
    }

    const addBtn = document.createElement("button");
    addBtn.className = "cb-tab-add";
    addBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><line x1="7" y1="2" x2="7" y2="12"/><line x1="2" y1="7" x2="12" y2="7"/></svg>';
    addBtn.title = "New canvas";
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
          closeDeletedMenu(menu);
          permanentlyDeleteTab(ht.id);
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
          closeSavedMenu(savedMenu);
          removeSavedTemplate(tpl.id);
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
      : null;

    __cb.tabStore.tabs.push({
      id: newId,
      name: `${sourceTab.name} (copy)`,
      hidden: false,
      state: clonedState,
    });

    __cb.switchTab(newId);
  }

  function permanentlyDeleteTab(tabId) {
    if (!__cb.tabStore) return;
    __cb.saveTabs();

    const idx = __cb.tabStore.tabs.findIndex(t => t.id === tabId);
    if (idx === -1) return;
    __cb.tabStore.tabs.splice(idx, 1);

    if (__cb.tabStore.activeId === tabId) {
      const visibleTabs = __cb.tabStore.tabs.filter(t => !t.hidden);
      if (visibleTabs.length === 0) {
        const newId = __cb.generateTabId();
        __cb.tabStore.tabs.push({ id: newId, name: "Scoping", hidden: false, state: null });
        __cb.switchTab(newId);
      } else {
        __cb.switchTab(visibleTabs[0].id);
      }
    } else {
      __cb.saveTabs();
      renderTabBar();
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
      : null;
    __cb.tabStore.tabs.push({
      id: newId,
      name: template.name,
      hidden: false,
      state: clonedState,
    });
    __cb.switchTab(newId);
  }

  function removeSavedTemplate(templateId) {
    const templates = loadSavedTemplates();
    const idx = templates.findIndex(t => t.id === templateId);
    if (idx !== -1) templates.splice(idx, 1);
    saveSavedTemplates(templates);
    renderTabBar();
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
      __cb.onCanvasStateChange = function () {
        __cb.debouncedSave();
        const ids = __cb.parseIdsFromUrl();
        if (ids && __cb.refreshCollaborators) {
          setTimeout(() => __cb.refreshCollaborators(ids.workbookId), 800);
        }
      };
    }

    const tab = __cb.tabStore.tabs.find(t => t.id === tabId);
    if (tab?.state && __cb.canvas) {
      __cb.canvas.restore(tab.state);
    }

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
    __cb.tabStore.tabs.push({ id: tabId, name: "Scoping", hidden: false, state: null });
    __cb.switchTab(tabId);
  }

  const MAX_DELETED = 3;

  function hideTab(tabId) {
    if (!__cb.tabStore) return;
    __cb.saveTabs();

    const tab = __cb.tabStore.tabs.find(t => t.id === tabId);
    if (!tab) return;
    tab.hidden = true;

    const hiddenTabs = __cb.tabStore.tabs.filter(t => t.hidden);
    while (hiddenTabs.length > MAX_DELETED) {
      const oldest = hiddenTabs.shift();
      const idx = __cb.tabStore.tabs.indexOf(oldest);
      if (idx !== -1) __cb.tabStore.tabs.splice(idx, 1);
    }

    if (__cb.tabStore.activeId === tabId) {
      const visibleTabs = __cb.tabStore.tabs.filter(t => !t.hidden);
      if (visibleTabs.length === 0) {
        const newId = __cb.generateTabId();
        __cb.tabStore.tabs.push({ id: newId, name: "Scoping", hidden: false, state: null });
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
    __cb.switchTab(tabId);
  }
})();
