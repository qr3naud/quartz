(function () {
  "use strict";

  window.__cbCanvasModules = window.__cbCanvasModules || {};

  const GROUP_COLOR_OPTIONS = [
    { id: "violet", label: "Violet", border: "#a78bfa", bg: "rgba(139, 92, 246, 0.04)", headerBorder: "rgba(139, 92, 246, 0.2)", labelColor: "#7c3aed", placeholder: "#c4b5fd", deleteColor: "#a78bfa", deleteHoverBg: "rgba(139, 92, 246, 0.1)", deleteHoverColor: "#7c3aed" },
    { id: "teal", label: "Teal", border: "#5eead4", bg: "rgba(20, 184, 166, 0.04)", headerBorder: "rgba(20, 184, 166, 0.2)", labelColor: "#0d9488", placeholder: "#99f6e4", deleteColor: "#5eead4", deleteHoverBg: "rgba(20, 184, 166, 0.1)", deleteHoverColor: "#0d9488" },
    { id: "blue", label: "Blue", border: "#60a5fa", bg: "rgba(59, 130, 246, 0.06)", headerBorder: "rgba(59, 130, 246, 0.2)", labelColor: "#2563eb", placeholder: "#93c5fd", deleteColor: "#60a5fa", deleteHoverBg: "rgba(59, 130, 246, 0.12)", deleteHoverColor: "#2563eb" },
    { id: "amber", label: "Amber", border: "#fbbf24", bg: "rgba(245, 158, 11, 0.06)", headerBorder: "rgba(245, 158, 11, 0.22)", labelColor: "#b45309", placeholder: "#fcd34d", deleteColor: "#fbbf24", deleteHoverBg: "rgba(245, 158, 11, 0.14)", deleteHoverColor: "#b45309" },
    { id: "rose", label: "Rose", border: "#fb7185", bg: "rgba(244, 63, 94, 0.06)", headerBorder: "rgba(244, 63, 94, 0.22)", labelColor: "#e11d48", placeholder: "#fda4af", deleteColor: "#fb7185", deleteHoverBg: "rgba(244, 63, 94, 0.14)", deleteHoverColor: "#e11d48" },
  ];

  window.__cbCanvasModules.createGroupThemeHelpers = function createGroupThemeHelpers() {
    function getGroupTheme(group) {
      const custom = GROUP_COLOR_OPTIONS.find((opt) => opt.id === group.color);
      if (custom) return custom;
      return group.level === 1 ? GROUP_COLOR_OPTIONS[1] : GROUP_COLOR_OPTIONS[0];
    }

    // el is passed explicitly now that group DOM elements live in a
    // canvas-owned map (the store group object is pure data, no `.el`).
    function applyGroupTheme(group, el) {
      const theme = getGroupTheme(group);
      if (!el || !theme) return;
      el.style.setProperty("--cb-group-border", theme.border);
      el.style.setProperty("--cb-group-bg", theme.bg);
      el.style.setProperty("--cb-group-header-border", theme.headerBorder);
      el.style.setProperty("--cb-group-label-color", theme.labelColor);
      el.style.setProperty("--cb-group-label-placeholder", theme.placeholder);
      el.style.setProperty("--cb-group-delete-color", theme.deleteColor);
      el.style.setProperty("--cb-group-delete-hover-bg", theme.deleteHoverBg);
      el.style.setProperty("--cb-group-delete-hover-color", theme.deleteHoverColor);
    }

    return { GROUP_COLOR_OPTIONS, getGroupTheme, applyGroupTheme };
  };

  window.__cbCanvasModules.createGroupLifecycleHelpers = function createGroupLifecycleHelpers(deps) {
    const {
      cardsRef,
      groupsRef,
      setGroups,
      cardsInGroup,
      isGroupEmpty,
      selectedCardsRef,
      clearSelection,
      cardContainerRef,
      getCardRect,
      applyGroupTheme,
      getGroupTheme,
      notifyChange,
      updateGroupCredits,
      getNextGroupId,
      ensureNextGroupId,
      setGroupDragState,
      getGroupColorMenuEl,
      setGroupColorMenuEl,
      getGroupColorMenuGroupId,
      setGroupColorMenuGroupId,
    } = deps;

    // Group DOM elements live here, keyed by group id — NOT on the store group
    // objects (which are pure data). renderGroups() is the single reconciler
    // that syncs this map to the store's groups array.
    const groupEls = new Map();

    function getGroupEl(id) {
      return groupEls.get(id) || null;
    }

    function clearGroupEls() {
      for (const [, el] of groupEls) el.remove();
      groupEls.clear();
    }

    function closeGroupColorMenu() {
      if (getGroupColorMenuEl()) {
        getGroupColorMenuEl().remove();
        setGroupColorMenuEl(null);
        setGroupColorMenuGroupId(null);
      }
    }

    // Build the .cb-group element for a (data-only) group. Listeners close over
    // the group object's id; live data is read from the store on each event.
    function buildGroupEl(group) {
      const el = document.createElement("div");
      el.className = "cb-group";
      if (group.level === 1) el.classList.add("cb-group-super");
      el.setAttribute("data-group-id", String(group.id));
      const header = document.createElement("div");
      header.className = "cb-group-header";
      const { wrap: labelWrap, label } = createGroupLabel(group, group.label || "");
      const creditsBadge = document.createElement("span");
      creditsBadge.className = "cb-group-credits";
      const delBtn = document.createElement("button");
      delBtn.className = "cb-group-delete";
      delBtn.innerHTML = "&#x2715;";
      header.appendChild(labelWrap);
      header.appendChild(creditsBadge);
      header.appendChild(delBtn);
      el.appendChild(header);
      delBtn.addEventListener("click", (evt) => {
        evt.stopPropagation();
        disbandGroup(group.id);
      });
      el.addEventListener("mousedown", (evt) => {
        if (evt.button !== 0) return;
        if (evt.target === label) return;
        closeGroupColorMenu();
        evt.stopPropagation();
        startGroupDrag(group, evt);
      });
      el.addEventListener("contextmenu", (evt) => {
        evt.preventDefault();
        evt.stopPropagation();
        openGroupColorMenu(group, evt);
      });
      return el;
    }

    // Reconcile the el map to the store's groups: create missing els, drop
    // orphaned ones, and sync label / super-class / theme. Bounds are applied
    // by updateGroupBounds (callers run it right after).
    function renderGroups() {
      const groups = groupsRef();
      const seen = new Set();
      for (const g of groups) {
        seen.add(g.id);
        let el = groupEls.get(g.id);
        if (!el) {
          el = buildGroupEl(g);
          groupEls.set(g.id, el);
          cardContainerRef().insertBefore(el, cardContainerRef().firstChild);
        }
        el.classList.toggle("cb-group-super", g.level === 1);
        const input = el.querySelector(".cb-group-label");
        if (input && document.activeElement !== input && input.value !== (g.label || "")) {
          input.value = g.label || "";
          const mirror = el.querySelector(".cb-group-label-mirror");
          if (mirror) mirror.textContent = input.value || input.placeholder;
        }
        applyGroupTheme(g, el);
      }
      for (const [id, el] of groupEls) {
        if (!seen.has(id)) {
          el.remove();
          groupEls.delete(id);
        }
      }
    }

    function createGroupLabel(group, initialValue) {
      const wrap = document.createElement("span");
      wrap.className = "cb-group-label-wrap";
      const mirror = document.createElement("span");
      mirror.className = "cb-group-label-mirror";
      const label = document.createElement("input");
      label.className = "cb-group-label";
      label.type = "text";
      label.size = 1;
      label.value = initialValue;
      label.placeholder = "Group name";
      mirror.textContent = initialValue || label.placeholder;

      function sync() {
        mirror.textContent = label.value || label.placeholder;
      }

      label.addEventListener("input", () => {
        sync();
        // The label is data now — write it back to the store group object.
        if (group) group.label = label.value;
        updateGroupBounds();
        notifyChange();
      });
      label.addEventListener("mousedown", (e) => e.stopPropagation());
      label.addEventListener("keydown", (e) => {
        if (e.key === "Enter") label.blur();
      });

      wrap.appendChild(mirror);
      wrap.appendChild(label);
      requestAnimationFrame(sync);
      return { wrap, label };
    }

    // Remove groups that have no direct member cards AND no child groups.
    // Iterates so a chain (inner emptied -> its super becomes childless) fully
    // collapses. Replaces the old "disband when membership drops below 2".
    function pruneEmptyGroups() {
      let removed = true;
      while (removed) {
        removed = false;
        const groups = groupsRef();
        const dead = groups.find((g) => isGroupEmpty(g.id));
        if (dead) {
          if (getGroupColorMenuGroupId() === dead.id) closeGroupColorMenu();
          setGroups(groups.filter((g) => g.id !== dead.id));
          const el = groupEls.get(dead.id);
          if (el) { el.remove(); groupEls.delete(dead.id); }
          removed = true;
        }
      }
    }

    function disbandGroup(id) {
      if (getGroupColorMenuGroupId() === id) closeGroupColorMenu();
      const groups = groupsRef();
      const g = groups.find((gg) => gg.id === id);
      if (!g) return;
      const newParent = g.parentId ?? null;
      // Direct member cards move up to this group's parent (or ungroup).
      for (const c of cardsRef()) {
        if (c.groupId === id) c.groupId = newParent;
      }
      // Child groups re-point to this group's parent.
      for (const child of groups) {
        if (child.parentId === id) child.parentId = newParent;
      }
      setGroups(groups.filter((gg) => gg.id !== id));
      const el = groupEls.get(id);
      if (el) { el.remove(); groupEls.delete(id); }
      renderGroups();
      updateGroupBounds();
      updateGroupCredits();
      notifyChange();
    }

    function updateGroupBounds() {
      const innerHdrH = 48;
      const innerPad = 20;
      for (const g of groupsRef()) {
        const el = groupEls.get(g.id);
        if (!el) continue;
        // Members = direct cards + every nested inner group's cards (supers).
        const members = cardsInGroup(g.id, { deep: true });
        if (!members.length) continue;
        const pad = g.level === 1 ? 40 : innerPad;
        const hdrH = g.level === 1 ? 56 : innerHdrH;
        const topPad = g.level === 1 ? pad + innerPad + innerHdrH + 12 : pad;
        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;
        for (const c of members) {
          const r = getCardRect(c);
          minX = Math.min(minX, r.x);
          minY = Math.min(minY, r.y);
          maxX = Math.max(maxX, r.x + r.w);
          maxY = Math.max(maxY, r.y + r.h);
        }
        let contentWidth = maxX - minX + pad * 2;
        const header = el.querySelector(".cb-group-header");
        if (header) {
          const mirror = header.querySelector(".cb-group-label-mirror");
          const creditsBadge = header.querySelector(".cb-group-credits");
          const delBtn = header.querySelector(".cb-group-delete");
          let headerContentWidth = (mirror ? mirror.offsetWidth : 0)
            + (creditsBadge ? creditsBadge.offsetWidth : 0)
            + (delBtn ? delBtn.offsetWidth : 0);
          const numItems = (mirror ? 1 : 0) + (creditsBadge ? 1 : 0) + (delBtn ? 1 : 0);
          const gaps = Math.max(0, numItems - 1) * 8;
          const headerPad = 24;
          headerContentWidth += gaps + headerPad;
          contentWidth = Math.max(contentWidth, headerContentWidth);
        }
        el.style.transform = `translate(${minX - pad}px, ${minY - topPad - hdrH}px)`;
        el.style.width = contentWidth + "px";
        el.style.height = maxY - minY + pad + topPad + hdrH + "px";
      }
    }

    function startGroupDrag(group, e) {
      const members = cardsInGroup(group.id, { deep: true });
      const state = { groupId: group.id, startMouseX: e.clientX, startMouseY: e.clientY, startPositions: new Map() };
      for (const c of members) state.startPositions.set(c.id, { x: c.x, y: c.y });
      setGroupDragState(state);
    }

    function openGroupColorMenu(group, e) {
      closeGroupColorMenu();
      const menu = document.createElement("div");
      menu.className = "cb-group-color-menu";
      menu.addEventListener("mousedown", (evt) => evt.stopPropagation());

      for (const opt of GROUP_COLOR_OPTIONS) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "cb-group-color-option";
        if (group.color === opt.id || (!group.color && getGroupTheme(group).id === opt.id)) {
          btn.classList.add("cb-group-color-option-active");
        }
        const swatch = document.createElement("span");
        swatch.className = "cb-group-color-swatch";
        swatch.style.background = opt.border;
        const label = document.createElement("span");
        label.textContent = opt.label;
        btn.appendChild(swatch);
        btn.appendChild(label);
        btn.addEventListener("click", (evt) => {
          evt.stopPropagation();
          group.color = opt.id;
          applyGroupTheme(group, groupEls.get(group.id));
          closeGroupColorMenu();
          notifyChange();
        });
        menu.appendChild(btn);
      }

      document.body.appendChild(menu);
      setGroupColorMenuEl(menu);
      setGroupColorMenuGroupId(group.id);
      menu.style.left = e.clientX + "px";
      menu.style.top = e.clientY + "px";
    }

    function groupSelectedCards(initialLabel, opts) {
      const skipFocus = !!opts?.skipFocus;
      const selectedCards = selectedCardsRef();
      const minCards = opts?.allowSingle ? 1 : 2;
      if (selectedCards.size < minCards) return;

      const cardObjs = [...selectedCards]
        .map((cid) => cardsRef().find((c) => c.id === cid))
        .filter(Boolean);
      const allInGroups = cardObjs.length > 0 && cardObjs.every((c) => c.groupId != null);
      const touchedGroupIds = new Set();
      for (const c of cardObjs) if (c.groupId != null) touchedGroupIds.add(c.groupId);
      // forceSuper lets callers (POC import) create a top-level super-group
      // directly from loose cards. A "group of groups" (super with children) is
      // only the auto-detected case: every selection already grouped, spanning
      // 2+ groups. forceDirect (table-native v7.23+) opts out of that entirely —
      // the table view is a 2-level tree and parents new groups explicitly.
      const forceDirect = !!opts?.forceDirect;
      const isSuper =
        !forceDirect && (!!opts?.forceSuper || (allInGroups && touchedGroupIds.size >= 2));
      const groupOfGroups = !forceDirect && allInGroups && touchedGroupIds.size >= 2;

      const group = {
        id: getNextGroupId(),
        label: initialLabel || "",
        level: isSuper ? 1 : 0,
        color: null,
        // Table-native (v7.23+): callers can parent the new group at creation
        // (e.g. an L2 sub-group under its use case). Setting it now — before the
        // pruneEmptyGroups() below — keeps the parent use case from being pruned
        // as "empty" when every one of its cards moves into the new sub-group.
        parentId: opts?.parentId ?? null,
      };
      groupsRef().push(group);

      if (groupOfGroups) {
        // Nest the touched inner groups under the new super (parentId); their
        // member cards keep pointing at their inner group via card.groupId.
        for (const gid of touchedGroupIds) {
          const inner = groupsRef().find((g) => g.id === gid);
          if (inner) inner.parentId = group.id;
        }
      } else {
        // Direct ownership: each selected card points at the new group. Setting
        // groupId pulls them out of any prior group automatically.
        for (const c of cardObjs) c.groupId = group.id;
      }

      pruneEmptyGroups();
      renderGroups();
      updateGroupBounds();
      updateGroupCredits();
      clearSelection();
      notifyChange();
      if (!initialLabel && !skipFocus) {
        requestAnimationFrame(() => {
          groupEls.get(group.id)?.querySelector(".cb-group-label")?.focus();
        });
      }
    }

    // Move a set of cards into an existing group (or out of all groups when
    // targetGroupId is null). Re-parents via card.groupId, repositions them so
    // the group's derived bounds enclose them, and prunes any emptied group.
    function moveCardsToGroup(cardIds, targetGroupId) {
      const ids = (cardIds || []).map(Number).filter((n) => Number.isFinite(n));
      if (ids.length === 0) return;
      const idSet = new Set(ids);
      const target = targetGroupId == null
        ? null
        : groupsRef().find((g) => g.id === targetGroupId);
      if (targetGroupId != null && !target) return;

      for (const id of ids) {
        const card = cardsRef().find((c) => c.id === id);
        if (card) card.groupId = targetGroupId; // null = ungroup
      }

      // Stack moved cards just below the target group's existing members so the
      // derived bounds enclose them (a far-away member would balloon the box).
      if (target) {
        const members = cardsInGroup(target.id, { deep: true }).filter(
          (c) => !idSet.has(c.id),
        );
        let baseX = 0;
        let baseY = 0;
        if (members.length) {
          baseX = Math.min(...members.map((c) => getCardRect(c).x));
          baseY = Math.max(...members.map((c) => getCardRect(c).y + getCardRect(c).h)) + 16;
        }
        let i = 0;
        for (const id of ids) {
          const card = cardsRef().find((c) => c.id === id);
          if (!card) continue;
          card.x = baseX;
          card.y = baseY + i * (getCardRect(card).h + 16);
          if (card.el) card.el.style.transform = `translate(${card.x}px, ${card.y}px)`;
          i++;
        }
      }

      pruneEmptyGroups();
      renderGroups();
      updateGroupBounds();
      updateGroupCredits();
      notifyChange();
    }

    // Restore a persisted group as pure data; the el is built by a subsequent
    // renderGroups() pass. Membership comes from cards' restored groupId.
    function restoreGroup(gs) {
      groupsRef().push({
        id: gs.id,
        label: gs.label || "",
        parentId: gs.parentId ?? null,
        // Table-native fields (v7.23+); default so legacy blobs round-trip.
        kind: gs.kind || "group",
        order: gs.order ?? null,
        source: gs.source || null,
        tableId: gs.tableId ?? null,
        viewId: gs.viewId ?? null,
        records: gs.records ?? null,
        frequency: gs.frequency ?? null,
        clusterKey: gs.clusterKey ?? null,
        // Legacy canvas fields.
        level: gs.level || 0,
        color: gs.color || null,
      });
      ensureNextGroupId(gs.id);
    }

    return {
      createGroupLabel,
      groupSelectedCards,
      moveCardsToGroup,
      disbandGroup,
      pruneEmptyGroups,
      updateGroupBounds,
      startGroupDrag,
      openGroupColorMenu,
      closeGroupColorMenu,
      restoreGroup,
      renderGroups,
      clearGroupEls,
      getGroupEl,
    };
  };
})();
