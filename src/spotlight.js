(function () {
  "use strict";

  // ---------------------------------------------------------------------------
  // Demo spotlight — save highlights from Clay table cells, then replay them
  // as a guided walkthrough: everything but the target (cell / right panel /
  // column settings) is dimmed, an optional note floats next to it, and a
  // bottom counter shows "X / N" with arrow-key navigation.
  //
  // SAVE: a capture-phase contextmenu listener notes the right-clicked cell
  // (cells carry stable `data-cell-id="{fieldId}.{recordId}"` — see
  // docs/architecture/clay-grid-dom.md). Clay's own context menu is left
  // alone; we inject a "Save in Quartz" item into it once it mounts (copying
  // a sibling item's classes so it blends in). If Clay's menu never shows,
  // a standalone mini-menu opens at the cursor instead. Hovering the item
  // opens a Results / Config flyout; picking one opens a note modal, and
  // saving writes through __cb.highlights (tab state, synced).
  //
  // REPLAY: __cb.spotlight.start(tableId) — entered from the floppy-disk
  // toolbar button (src/toolbar.js). Steps soft-navigate with
  // `?fieldId=&recordId=` (Clay scrolls + green-rings the cell), then:
  //   results + normal column  -> spotlight the cell rect
  //   results + action/source  -> click the cell to open the cell-details
  //                               panel (#table-sidebar) and spotlight it
  //   config                   -> dblclick the column header (opens the
  //                               FIELD_DETAIL sidebar) and spotlight it
  // The dim layer is a fixed div whose huge box-shadow paints everything
  // around it; it has pointer-events:none so the page stays interactive
  // (presenters can still scroll the highlighted panel). A rAF loop re-reads
  // the target's rect every frame, so virtualized remounts and scrolling
  // keep the hole glued to the target.
  // ---------------------------------------------------------------------------

  const __cb = window.__cb;

  function currentTableId() {
    try {
      const parts = window.location.pathname.split("/");
      const idx = parts.indexOf("tables");
      return idx !== -1 ? parts[idx + 1] || null : null;
    } catch {
      return null;
    }
  }

  function cssEscape(s) {
    return window.CSS?.escape ? CSS.escape(s) : String(s).replace(/(["\\.#:\[\]])/g, "\\$1");
  }

  // ---- Field metadata (name + action vs normal), cached per table ----------
  // /v3/workbooks/{id}/tables returns every table with its `fields` array —
  // the same payload the import picker uses. Fetched lazily on first
  // right-click and reused for the session.

  const fieldMetaCache = {}; // tableId -> Promise<{ [fieldId]: {name,type} } | null>

  function ensureFieldMeta(tableId) {
    if (!tableId) return Promise.resolve(null);
    if (fieldMetaCache[tableId]) return fieldMetaCache[tableId];
    const ids = __cb.parseIdsFromUrl?.();
    if (!ids?.workbookId || !__cb.fetchTableList) return Promise.resolve(null);
    fieldMetaCache[tableId] = __cb
      .fetchTableList(ids.workbookId)
      .then((list) => {
        const tables = list?.tables || list || [];
        const t = (Array.isArray(tables) ? tables : []).find((x) => x.id === tableId);
        if (!t) return null;
        const m = {};
        for (const f of t.fields || []) {
          m[f.id] = { name: f.name || f.id, type: f.type || null };
        }
        return m;
      })
      .catch(() => {
        delete fieldMetaCache[tableId];
        return null;
      });
    return fieldMetaCache[tableId];
  }

  // =====================================================================
  // SAVE FLOW
  // =====================================================================

  let pendingCell = null; // { tableId, fieldId, recordId, x, y, ts, hasClickable }
  let menuWatchTimer = null;
  let menuWatchObserver = null;
  let flyoutEl = null;
  let standaloneMenuEl = null;

  function isOwnUi(el) {
    return !!el.closest?.(
      ".cb-hl-flyout, .cb-hl-menu, .cb-hl-note-backdrop, .cb-spot-counter, .cb-spot-note, .cb-hl-pop",
    );
  }

  function onContextMenu(e) {
    // While replaying, right-click is reserved (avoid Clay menus over the dim).
    if (replay.active) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    const tid = currentTableId();
    if (!tid) return;
    const target = e.target instanceof Element ? e.target : null;
    if (!target || isOwnUi(target)) return;
    const cellEl = target.closest("[data-cell-id]");
    if (!cellEl) return;
    const raw = cellEl.getAttribute("data-cell-id") || "";
    const dot = raw.indexOf(".");
    if (dot <= 0) return;

    closeFlyout();
    closeStandaloneMenu();
    pendingCell = {
      tableId: tid,
      fieldId: raw.slice(0, dot),
      recordId: raw.slice(dot + 1),
      x: e.clientX,
      y: e.clientY,
      ts: Date.now(),
      // DOM fallback for action detection if the schema fetch fails: action /
      // source cells wrap their value in a clickable ("View full results")
      // container.
      hasClickable: !!cellEl.querySelector(".cursor-pointer"),
    };
    ensureFieldMeta(tid); // warm the cache while the user reads the menu
    watchForClayMenu();
  }

  // Clay opens its own context menu (floating-ui portal, role="menu"). Watch
  // for a menu that wasn't in the DOM at right-click time and inject our item;
  // if none shows up within the window, fall back to a standalone mini-menu.
  function watchForClayMenu() {
    stopMenuWatch();
    const before = new Set(document.querySelectorAll('[role="menu"]'));

    const tryInject = () => {
      for (const menu of document.querySelectorAll('[role="menu"]')) {
        if (before.has(menu)) continue;
        if (menu.querySelector(".cb-hl-menu-item")) return true;
        injectMenuItem(menu);
        return true;
      }
      return false;
    };

    if (tryInject()) return;
    menuWatchObserver = new MutationObserver(() => {
      if (tryInject()) stopMenuWatch();
    });
    menuWatchObserver.observe(document.body, { childList: true, subtree: true });
    menuWatchTimer = setTimeout(() => {
      const found = tryInject();
      stopMenuWatch();
      if (!found && pendingCell && Date.now() - pendingCell.ts < 2500) {
        openStandaloneMenu(pendingCell.x, pendingCell.y);
      }
    }, 900);
  }

  function stopMenuWatch() {
    if (menuWatchObserver) {
      menuWatchObserver.disconnect();
      menuWatchObserver = null;
    }
    if (menuWatchTimer) {
      clearTimeout(menuWatchTimer);
      menuWatchTimer = null;
    }
  }

  const FLOPPY_SVG_SMALL =
    '<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 256 256" fill="currentColor" aria-hidden="true"><path d="M219.31,72,184,36.69A15.86,15.86,0,0,0,172.69,32H48A16,16,0,0,0,32,48V208a16,16,0,0,0,16,16H208a16,16,0,0,0,16-16V83.31A15.86,15.86,0,0,0,219.31,72ZM168,208H88V152h80Zm40,0H184V152a16,16,0,0,0-16-16H88a16,16,0,0,0-16,16v56H48V48H172.69L208,83.31ZM160,72a8,8,0,0,1-8,8H96a8,8,0,0,1,0-16h56A8,8,0,0,1,160,72Z"/></svg>';

  function buildMenuItemContent(item) {
    const icon = document.createElement("span");
    icon.className = "cb-hl-menu-item-icon";
    icon.innerHTML = FLOPPY_SVG_SMALL;
    const label = document.createElement("span");
    label.className = "cb-hl-menu-item-label";
    label.textContent = "Save in Quartz";
    const chev = document.createElement("span");
    chev.className = "cb-hl-menu-item-chev";
    chev.textContent = "\u203a";
    item.appendChild(icon);
    item.appendChild(label);
    item.appendChild(chev);
  }

  function injectMenuItem(menuEl) {
    const sibling = menuEl.querySelector('[role="menuitem"]');
    const item = document.createElement("div");
    // Blend into Clay's menu by reusing a native item's classes; keep our own
    // class for identification and the flex bits the content needs.
    item.className = (sibling?.className || "") + " cb-hl-menu-item";
    item.setAttribute("role", "menuitem");
    buildMenuItemContent(item);

    item.addEventListener("mouseenter", () => openFlyout(item, menuEl));
    item.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      openFlyout(item, menuEl);
    });
    // React won't reconcile a foreign child appended to its menu; if the menu
    // re-renders the item may vanish, which is acceptable (re-right-click).
    menuEl.appendChild(item);
  }

  // Standalone fallback menu (Clay's menu never appeared).
  function openStandaloneMenu(x, y) {
    closeStandaloneMenu();
    const menu = document.createElement("div");
    menu.className = "cb-hl-menu";
    const item = document.createElement("div");
    item.className = "cb-hl-menu-item cb-hl-menu-item-own";
    buildMenuItemContent(item);
    item.addEventListener("mouseenter", () => openFlyout(item, null));
    item.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      openFlyout(item, null);
    });
    menu.appendChild(item);
    document.body.appendChild(menu);
    const mw = menu.offsetWidth || 180;
    const mh = menu.offsetHeight || 36;
    menu.style.left = `${Math.min(x, window.innerWidth - mw - 8)}px`;
    menu.style.top = `${Math.min(y, window.innerHeight - mh - 8)}px`;
    standaloneMenuEl = menu;
    setTimeout(() => document.addEventListener("mousedown", onSaveUiOutside, true), 0);
  }

  function closeStandaloneMenu() {
    if (standaloneMenuEl) {
      standaloneMenuEl.remove();
      standaloneMenuEl = null;
    }
    document.removeEventListener("mousedown", onSaveUiOutside, true);
  }

  function onSaveUiOutside(e) {
    const t = e.target instanceof Element ? e.target : null;
    if (t && (t.closest(".cb-hl-menu") || t.closest(".cb-hl-flyout"))) return;
    closeFlyout();
    closeStandaloneMenu();
  }

  // ---- Results / Config flyout ---------------------------------------------

  function openFlyout(anchorEl, clayMenuEl) {
    closeFlyout();
    const fly = document.createElement("div");
    fly.className = "cb-hl-flyout";
    fly.addEventListener("mousedown", (e) => e.stopPropagation());

    const mkOpt = (title, sub, kind) => {
      const opt = document.createElement("div");
      opt.className = "cb-hl-flyout-opt";
      const t = document.createElement("div");
      t.className = "cb-hl-flyout-opt-title";
      t.textContent = title;
      const s = document.createElement("div");
      s.className = "cb-hl-flyout-opt-sub";
      s.textContent = sub;
      opt.appendChild(t);
      opt.appendChild(s);
      opt.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const ctx = pendingCell;
        closeFlyout();
        closeStandaloneMenu();
        if (clayMenuEl) closeClayMenu(clayMenuEl);
        if (ctx) openNoteModal(kind, ctx);
      });
      return opt;
    };

    fly.appendChild(
      mkOpt("Results", "Spotlight this cell (or its results panel)", "results"),
    );
    fly.appendChild(
      mkOpt("Config", "Spotlight this column's settings", "config"),
    );

    document.body.appendChild(fly);
    const r = anchorEl.getBoundingClientRect();
    const fw = fly.offsetWidth || 240;
    const fh = fly.offsetHeight || 90;
    let left = r.right + 4;
    if (left + fw > window.innerWidth - 8) left = Math.max(8, r.left - fw - 4);
    let top = Math.min(r.top, window.innerHeight - fh - 8);
    fly.style.left = `${Math.round(left)}px`;
    fly.style.top = `${Math.round(top)}px`;
    flyoutEl = fly;

    // Close when the pointer leaves both the anchor and the flyout.
    const maybeClose = () => {
      setTimeout(() => {
        if (flyoutEl === fly && !fly.matches(":hover") && !anchorEl.matches(":hover")) {
          closeFlyout();
        }
      }, 180);
    };
    fly.addEventListener("mouseleave", maybeClose);
    anchorEl.addEventListener("mouseleave", maybeClose);
  }

  function closeFlyout() {
    if (flyoutEl) {
      flyoutEl.remove();
      flyoutEl = null;
    }
  }

  // Close Clay's floating-ui context menu: Escape on the menu (bubbles
  // through the React portal), with an outside-pointerdown fallback.
  function closeClayMenu(menuEl) {
    try {
      menuEl.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }),
      );
    } catch {}
    setTimeout(() => {
      if (!menuEl.isConnected) return;
      try {
        document.documentElement.dispatchEvent(
          new PointerEvent("pointerdown", { bubbles: true }),
        );
        document.documentElement.dispatchEvent(
          new MouseEvent("mousedown", { bubbles: true }),
        );
      } catch {}
    }, 60);
  }

  // ---- Note modal ------------------------------------------------------------

  let noteBackdropEl = null;

  function closeNoteModal() {
    if (noteBackdropEl) {
      noteBackdropEl.remove();
      noteBackdropEl = null;
    }
  }

  function openNoteModal(kind, ctx) {
    closeNoteModal();
    const backdrop = document.createElement("div");
    backdrop.className = "cb-hl-note-backdrop";
    backdrop.addEventListener("mousedown", (e) => {
      if (e.target === backdrop) closeNoteModal();
    });

    const modal = document.createElement("div");
    modal.className = "cb-hl-note-modal";

    const title = document.createElement("div");
    title.className = "cb-hl-note-title";
    title.textContent = "Save highlight";

    const sub = document.createElement("div");
    sub.className = "cb-hl-note-sub";
    sub.textContent = kind === "config" ? "Column settings" : "Cell results";
    // Swap in the column name once the schema lands.
    ensureFieldMeta(ctx.tableId).then((meta) => {
      const f = meta?.[ctx.fieldId];
      if (f && sub.isConnected) {
        sub.textContent = `${f.name} \u00b7 ${kind === "config" ? "Column settings" : "Cell results"}`;
      }
    });

    const text = document.createElement("textarea");
    text.className = "cb-hl-note-text";
    text.placeholder = "Add a note to show during the demo (optional)";

    const actions = document.createElement("div");
    actions.className = "cb-hl-note-actions";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "cb-hl-note-cancel";
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", closeNoteModal);
    const save = document.createElement("button");
    save.type = "button";
    save.className = "cb-hl-note-save";
    save.textContent = "Save highlight";

    async function doSave() {
      save.disabled = true;
      const meta = await Promise.race([
        ensureFieldMeta(ctx.tableId),
        new Promise((res) => setTimeout(() => res(null), 2500)),
      ]);
      const f = meta?.[ctx.fieldId];
      const isAction = f
        ? f.type === "action" || f.type === "source"
        : ctx.hasClickable;
      await __cb.highlights?.add?.(ctx.tableId, {
        kind,
        fieldId: ctx.fieldId,
        recordId: kind === "results" ? ctx.recordId : null,
        fieldName: f?.name || null,
        isAction,
        note: text.value.trim(),
      });
      closeNoteModal();
    }
    save.addEventListener("click", doSave);
    text.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") doSave();
      if (e.key === "Escape") closeNoteModal();
    });

    actions.appendChild(cancel);
    actions.appendChild(save);
    modal.appendChild(title);
    modal.appendChild(sub);
    modal.appendChild(text);
    modal.appendChild(actions);
    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);
    noteBackdropEl = backdrop;
    text.focus();
  }

  document.addEventListener("contextmenu", onContextMenu, true);

  // =====================================================================
  // REPLAY
  // =====================================================================

  const replay = {
    active: false,
    tid: null,
    items: [],
    idx: 0,
    getTarget: null, // () => Element | null, re-queried every frame
    raf: 0,
    waitToken: 0,
    savedUrl: null,
    animUntil: 0,
    holeEl: null,
    noteEl: null,
    counterEl: null,
    counterNumEl: null,
    lastRect: null,
  };

  function softNav(fieldId, recordId) {
    const params = new URLSearchParams({ fieldId });
    if (recordId) params.set("recordId", recordId);
    const url = `${window.location.pathname}?${params.toString()}`;
    try {
      window.history.pushState(window.history.state, "", url);
      window.dispatchEvent(new PopStateEvent("popstate"));
    } catch {}
  }

  // Poll for an element until it exists (and has a real box) or we time out.
  function waitFor(getEl, timeoutMs) {
    return new Promise((resolve) => {
      const t0 = Date.now();
      (function poll() {
        const el = getEl();
        if (el && el.isConnected) {
          const r = el.getBoundingClientRect();
          if (r.width > 1 && r.height > 1) return resolve(el);
        }
        if (Date.now() - t0 > timeoutMs) return resolve(null);
        setTimeout(poll, 80);
      })();
    });
  }

  function cellSelector(item) {
    return `[data-cell-id="${cssEscape(`${item.fieldId}.${item.recordId}`)}"]`;
  }

  function setTargetSelector(sel) {
    replay.getTarget = () => document.querySelector(sel);
  }

  async function showStep(i) {
    const items = replay.items;
    if (!items.length) return;
    const idx = Math.max(0, Math.min(i, items.length - 1));
    replay.idx = idx;
    const token = ++replay.waitToken;
    const item = items[idx];

    // Counter + note update immediately; the hole catches up when the target
    // is resolved.
    if (replay.counterNumEl) {
      replay.counterNumEl.textContent = `${idx + 1} / ${items.length}`;
    }
    updateNote(item);
    replay.holeEl?.classList.add("cb-spot-hole-waiting");
    replay.animUntil = performance.now() + 600;

    if (item.kind === "config") {
      // Bring the column into view, then open its settings via the header
      // double-click (Clay's TableHeaderCell onDoubleClick -> showSettings).
      softNav(item.fieldId, null);
      __cb.focusFieldInGrid?.(item.fieldId);
      const headerSel = `#${cssEscape(`table-header-cell-${item.fieldId}`)}`;
      const header = await waitFor(() => document.querySelector(headerSel), 5000);
      if (token !== replay.waitToken) return;
      if (header) {
        header.dispatchEvent(
          new MouseEvent("dblclick", { bubbles: true, cancelable: true, view: window }),
        );
        const sidebar = await waitFor(
          () => document.getElementById("table-sidebar"),
          3000,
        );
        if (token !== replay.waitToken) return;
        if (sidebar) setTargetSelector("#table-sidebar");
        else setTargetSelector(headerSel);
      } else {
        setTargetSelector(headerSel);
      }
    } else {
      // results
      softNav(item.fieldId, item.recordId || null);
      const sel = item.recordId ? cellSelector(item) : null;
      const headerSel = `#${cssEscape(`table-header-cell-${item.fieldId}`)}`;
      const cell = sel ? await waitFor(() => document.querySelector(sel), 5000) : null;
      if (token !== replay.waitToken) return;
      if (cell && item.isAction) {
        // Action/source cells open the cell-details panel on click; the
        // value sits in a clickable container inside the cell.
        const clickable = cell.querySelector(".cursor-pointer") || cell;
        try {
          clickable.click();
        } catch {}
        const sidebar = await waitFor(
          () => document.getElementById("table-sidebar"),
          3000,
        );
        if (token !== replay.waitToken) return;
        if (sidebar) setTargetSelector("#table-sidebar");
        else setTargetSelector(sel);
      } else if (cell) {
        setTargetSelector(sel);
      } else {
        // Cell never mounted (filtered out / deleted record) — fall back to
        // the column header so the step still lands somewhere meaningful.
        await waitFor(() => document.querySelector(headerSel), 3000);
        if (token !== replay.waitToken) return;
        setTargetSelector(headerSel);
      }
    }

    replay.holeEl?.classList.remove("cb-spot-hole-waiting");
    replay.animUntil = performance.now() + 600;
  }

  function updateNote(item) {
    const note = replay.noteEl;
    if (!note) return;
    const name = note.querySelector(".cb-spot-note-field");
    const text = note.querySelector(".cb-spot-note-text");
    name.textContent = `${item.fieldName || "Column"}${item.kind === "config" ? " \u00b7 settings" : ""}`;
    if (item.note) {
      text.textContent = item.note;
      text.style.display = "";
    } else {
      text.textContent = "";
      text.style.display = "none";
    }
  }

  function positionHole(r) {
    const pad = 5;
    const left = Math.max(0, r.left - pad);
    const top = Math.max(0, r.top - pad);
    const width = Math.min(window.innerWidth - left, r.width + pad * 2);
    const height = Math.min(window.innerHeight - top, r.height + pad * 2);
    const hole = replay.holeEl;
    hole.style.left = `${Math.round(left)}px`;
    hole.style.top = `${Math.round(top)}px`;
    hole.style.width = `${Math.round(width)}px`;
    hole.style.height = `${Math.round(height)}px`;
    replay.lastRect = { left, top, width, height };
    positionNote();
  }

  function positionNote() {
    const note = replay.noteEl;
    const r = replay.lastRect;
    if (!note || !r) return;
    const nw = note.offsetWidth;
    const nh = note.offsetHeight;
    let top = r.top + r.height + 14;
    if (top + nh > window.innerHeight - 60) top = Math.max(8, r.top - nh - 14);
    let left = r.left;
    left = Math.max(8, Math.min(left, window.innerWidth - nw - 8));
    note.style.left = `${Math.round(left)}px`;
    note.style.top = `${Math.round(top)}px`;
  }

  function tick() {
    if (!replay.active) return;
    const el = replay.getTarget?.();
    if (el && el.isConnected) {
      const r = el.getBoundingClientRect();
      if (r.width > 1 && r.height > 1) {
        // Animate on step changes; snap while tracking scroll so the hole
        // doesn't rubber-band behind the grid.
        const anim = performance.now() < replay.animUntil;
        replay.holeEl.classList.toggle("cb-spot-anim", anim);
        replay.noteEl.classList.toggle("cb-spot-anim", anim);
        positionHole(r);
      }
    }
    replay.raf = requestAnimationFrame(tick);
  }

  function onReplayKey(e) {
    if (!replay.active) return;
    const t = e.target;
    if (
      t instanceof Element &&
      (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)
    ) {
      return;
    }
    const next = ["ArrowRight", "ArrowDown", "PageDown", " ", "Enter"];
    const prev = ["ArrowLeft", "ArrowUp", "PageUp"];
    if (next.includes(e.key)) {
      e.preventDefault();
      e.stopImmediatePropagation();
      showStep(replay.idx + 1);
    } else if (prev.includes(e.key)) {
      e.preventDefault();
      e.stopImmediatePropagation();
      showStep(replay.idx - 1);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopImmediatePropagation();
      stop();
    }
  }

  function buildReplayUi() {
    const hole = document.createElement("div");
    hole.className = "cb-spot-hole";
    // Start as a dot in the center so the first step animates outward.
    hole.style.left = `${window.innerWidth / 2}px`;
    hole.style.top = `${window.innerHeight / 2}px`;
    hole.style.width = "0px";
    hole.style.height = "0px";

    const note = document.createElement("div");
    note.className = "cb-spot-note";
    const noteField = document.createElement("div");
    noteField.className = "cb-spot-note-field";
    const noteText = document.createElement("div");
    noteText.className = "cb-spot-note-text";
    note.appendChild(noteField);
    note.appendChild(noteText);

    const counter = document.createElement("div");
    counter.className = "cb-spot-counter";
    const prevBtn = document.createElement("button");
    prevBtn.type = "button";
    prevBtn.className = "cb-spot-counter-btn";
    prevBtn.textContent = "\u2190";
    prevBtn.setAttribute("aria-label", "Previous highlight");
    prevBtn.addEventListener("click", () => showStep(replay.idx - 1));
    const num = document.createElement("span");
    num.className = "cb-spot-counter-num";
    const nextBtn = document.createElement("button");
    nextBtn.type = "button";
    nextBtn.className = "cb-spot-counter-btn";
    nextBtn.textContent = "\u2192";
    nextBtn.setAttribute("aria-label", "Next highlight");
    nextBtn.addEventListener("click", () => showStep(replay.idx + 1));
    const hint = document.createElement("span");
    hint.className = "cb-spot-counter-hint";
    hint.textContent = "Esc to exit";
    const close = document.createElement("button");
    close.type = "button";
    close.className = "cb-spot-counter-btn cb-spot-counter-close";
    close.textContent = "\u00d7";
    close.setAttribute("aria-label", "Exit demo");
    close.addEventListener("click", () => stop());

    counter.appendChild(prevBtn);
    counter.appendChild(num);
    counter.appendChild(nextBtn);
    counter.appendChild(hint);
    counter.appendChild(close);

    document.body.appendChild(hole);
    document.body.appendChild(note);
    document.body.appendChild(counter);
    replay.holeEl = hole;
    replay.noteEl = note;
    replay.counterEl = counter;
    replay.counterNumEl = num;
  }

  async function start(tableId) {
    if (replay.active) stop();
    const tid = tableId || currentTableId();
    if (!tid || tid !== currentTableId()) return;
    await __cb.highlights?.ensureHydrated?.();
    const items = __cb.highlights?.get?.(tid) || [];
    if (!items.length) return;

    replay.active = true;
    replay.tid = tid;
    replay.items = items;
    replay.idx = 0;
    replay.savedUrl = window.location.href;
    replay.getTarget = null;
    replay.lastRect = null;
    document.body.setAttribute("data-cb-spotlight-active", "");
    buildReplayUi();
    window.addEventListener("keydown", onReplayKey, true);
    replay.raf = requestAnimationFrame(tick);
    showStep(0);
  }

  function stop() {
    if (!replay.active) return;
    replay.active = false;
    replay.waitToken++;
    cancelAnimationFrame(replay.raf);
    window.removeEventListener("keydown", onReplayKey, true);
    document.body.removeAttribute("data-cb-spotlight-active");
    replay.holeEl?.remove();
    replay.noteEl?.remove();
    replay.counterEl?.remove();
    replay.holeEl = replay.noteEl = replay.counterEl = replay.counterNumEl = null;
    replay.getTarget = null;
    // Drop the ?fieldId=&recordId= we pushed during the walkthrough.
    if (replay.savedUrl) {
      try {
        window.history.replaceState(window.history.state, "", replay.savedUrl);
      } catch {}
      replay.savedUrl = null;
    }
  }

  __cb.spotlight = {
    start,
    stop,
    isActive: () => replay.active,
  };
})();
