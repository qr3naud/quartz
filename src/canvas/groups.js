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

    function applyGroupTheme(group) {
      const theme = getGroupTheme(group);
      if (!group?.el || !theme) return;
      group.el.style.setProperty("--cb-group-border", theme.border);
      group.el.style.setProperty("--cb-group-bg", theme.bg);
      group.el.style.setProperty("--cb-group-header-border", theme.headerBorder);
      group.el.style.setProperty("--cb-group-label-color", theme.labelColor);
      group.el.style.setProperty("--cb-group-label-placeholder", theme.placeholder);
      group.el.style.setProperty("--cb-group-delete-color", theme.deleteColor);
      group.el.style.setProperty("--cb-group-delete-hover-bg", theme.deleteHoverBg);
      group.el.style.setProperty("--cb-group-delete-hover-color", theme.deleteHoverColor);
    }

    return { GROUP_COLOR_OPTIONS, getGroupTheme, applyGroupTheme };
  };

  window.__cbCanvasModules.createGroupLifecycleHelpers = function createGroupLifecycleHelpers(deps) {
    const {
      cardsRef,
      groupsRef,
      setGroups,
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

    function closeGroupColorMenu() {
      if (getGroupColorMenuEl()) {
        getGroupColorMenuEl().remove();
        setGroupColorMenuEl(null);
        setGroupColorMenuGroupId(null);
      }
    }

    function createGroupLabel(initialValue) {
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

    function disbandGroup(id) {
      if (getGroupColorMenuGroupId() === id) closeGroupColorMenu();
      const g = groupsRef().find((gg) => gg.id === id);
      if (!g) return;
      for (const cid of g.cardIds) {
        const c = cardsRef().find((cc) => cc.id === cid);
        if (!c) continue;
        const inner = groupsRef().find((gg) => gg.id !== id && gg.cardIds.has(cid));
        c.groupId = inner ? inner.id : null;
      }
      g.el.remove();
      setGroups(groupsRef().filter((gg) => gg.id !== id));
      notifyChange();
    }

    function updateGroupBounds() {
      const innerHdrH = 48;
      const innerPad = 20;
      for (const g of groupsRef()) {
        const members = cardsRef().filter((c) => g.cardIds.has(c.id));
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
        const header = g.el.querySelector(".cb-group-header");
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
        g.el.style.transform = `translate(${minX - pad}px, ${minY - topPad - hdrH}px)`;
        g.el.style.width = contentWidth + "px";
        g.el.style.height = maxY - minY + pad + topPad + hdrH + "px";
      }
    }

    function startGroupDrag(group, e) {
      const members = cardsRef().filter((c) => group.cardIds.has(c.id));
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
          applyGroupTheme(group);
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
      if (selectedCards.size < 2) return;

      const allInGroups = [...selectedCards].every((cid) => {
        const c = cardsRef().find((cc) => cc.id === cid);
        return c && c.groupId != null;
      });
      const touchedGroupIds = new Set();
      for (const cid of selectedCards) {
        const c = cardsRef().find((cc) => cc.id === cid);
        if (c?.groupId != null) touchedGroupIds.add(c.groupId);
      }
      const isSuper = allInGroups && touchedGroupIds.size >= 2;

      if (!isSuper) {
        for (const cid of selectedCards) {
          const card = cardsRef().find((c) => c.id === cid);
          if (card?.groupId !== null && card?.groupId !== undefined) {
            const old = groupsRef().find((g) => g.id === card.groupId);
            if (old) {
              old.cardIds.delete(cid);
              if (old.cardIds.size < 2) {
                old.el.remove();
                setGroups(groupsRef().filter((g) => g.id !== old.id));
              }
            }
          }
        }
      }

      const allCardIds = new Set(selectedCards);
      if (isSuper) {
        for (const gid of touchedGroupIds) {
          const g = groupsRef().find((gg) => gg.id === gid);
          if (g) {
            for (const cid of g.cardIds) allCardIds.add(cid);
          }
        }
      }

      const el = document.createElement("div");
      el.className = "cb-group";
      if (isSuper) el.classList.add("cb-group-super");
      const header = document.createElement("div");
      header.className = "cb-group-header";
      const { wrap: labelWrap, label } = createGroupLabel(initialLabel || "");
      const creditsBadge = document.createElement("span");
      creditsBadge.className = "cb-group-credits";
      const delBtn = document.createElement("button");
      delBtn.className = "cb-group-delete";
      delBtn.innerHTML = "&#x2715;";
      header.appendChild(labelWrap);
      header.appendChild(creditsBadge);
      header.appendChild(delBtn);
      el.appendChild(header);
      const group = { id: getNextGroupId(), cardIds: allCardIds, el, level: isSuper ? 1 : 0, color: null };
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
      for (const cid of group.cardIds) {
        const c = cardsRef().find((cc) => cc.id === cid);
        if (c) c.groupId = group.id;
      }
      groupsRef().push(group);
      cardContainerRef().insertBefore(el, cardContainerRef().firstChild);
      applyGroupTheme(group);
      updateGroupBounds();
      updateGroupCredits();
      clearSelection();
      notifyChange();
      if (!initialLabel && !skipFocus) requestAnimationFrame(() => label.focus());
    }

    function restoreGroup(gs) {
      const isSuper = gs.level === 1;
      const el = document.createElement("div");
      el.className = "cb-group";
      if (isSuper) el.classList.add("cb-group-super");
      const header = document.createElement("div");
      header.className = "cb-group-header";
      const { wrap: labelWrap, label } = createGroupLabel(gs.label || "");
      const creditsBadge = document.createElement("span");
      creditsBadge.className = "cb-group-credits";
      const delBtn = document.createElement("button");
      delBtn.className = "cb-group-delete";
      delBtn.innerHTML = "&#x2715;";
      header.appendChild(labelWrap);
      header.appendChild(creditsBadge);
      header.appendChild(delBtn);
      el.appendChild(header);
      const group = { id: gs.id, cardIds: new Set(gs.cardIds), el, level: gs.level || 0, color: gs.color || null };
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
      for (const cid of group.cardIds) {
        const c = cardsRef().find((cc) => cc.id === cid);
        if (c) c.groupId = group.id;
      }
      groupsRef().push(group);
      cardContainerRef().insertBefore(el, cardContainerRef().firstChild);
      applyGroupTheme(group);
      ensureNextGroupId(group.id);
      updateGroupBounds();
      updateGroupCredits();
    }

    return {
      createGroupLabel,
      groupSelectedCards,
      disbandGroup,
      updateGroupBounds,
      startGroupDrag,
      openGroupColorMenu,
      closeGroupColorMenu,
      restoreGroup,
    };
  };
})();
