(function () {
  "use strict";

  window.__cbCanvasModules = window.__cbCanvasModules || {};

  window.__cbCanvasModules.createPersistenceHelpers = function createPersistenceHelpers(deps) {
    const {
      cardsRef,
      groupsRef,
      panRef,
      nextIdsRef,
      setPanScale,
      setNextIds,
      applyTransform,
      addCard,
      addDataPointCard,
      addInputCard,
      addCommentCard,
      restoreGroup,
      updateDpCosts,
      setRestoring,
    } = deps;

    function serialize() {
      for (const c of cardsRef()) {
        if (c.data.type === "dp") {
          const textEl = c.el.querySelector(".cb-dp-text");
          if (textEl) {
            c.data.text = textEl.textContent;
            c.data.displayName = textEl.textContent;
          }
        } else if (c.data.type === "input") {
          const textEl = c.el.querySelector(".cb-input-text");
          if (textEl) {
            c.data.text = textEl.textContent;
            c.data.displayName = textEl.textContent;
          }
        } else if (c.data.type === "comment") {
          const textEl = c.el.querySelector(".cb-comment-text");
          if (textEl) {
            c.data.text = textEl.textContent;
            c.data.displayName = textEl.textContent;
          }
        } else if (c.data.isAi) {
          const nameEl = c.el.querySelector(".cb-card-name");
          if (nameEl) c.data.displayName = nameEl.textContent;
        }
      }
      const nextIds = nextIdsRef();
      const pan = panRef();
      return {
        cards: cardsRef().map((c) => ({ id: c.id, x: c.x, y: c.y, data: c.data, groupId: c.groupId })),
        groups: groupsRef().map((g) => ({
          id: g.id,
          cardIds: [...g.cardIds],
          label: g.el.querySelector(".cb-group-label")?.value || "",
          level: g.level || 0,
          color: g.color || null,
        })),
        view: { panX: pan.panX, panY: pan.panY, scale: pan.scale },
        nextCardId: nextIds.nextCardId,
        nextGroupId: nextIds.nextGroupId,
      };
    }

    function restore(state) {
      if (!state) return;
      setRestoring(true);
      if (state.view) {
        setPanScale({
          panX: state.view.panX ?? 0,
          panY: state.view.panY ?? 0,
          scale: state.view.scale ?? 1,
        });
        applyTransform();
      }
      for (const cs of state.cards || []) {
        if (cs.data.type === "dp") {
          // Pass `fillRate` and `fillRateCustom` through so the user's edit
          // state survives reload. Missing values (legacy cards, or freshly
          // imported DP cards in Phase 2) fall back to defaults inside
          // addDataPointCard; missing `fillRateCustom` defaults to false so
          // legacy cards keep tracking the records input live.
          addDataPointCard(cs.data.text || "", {
            x: cs.x,
            y: cs.y,
            id: cs.id,
            fillRate: cs.data.fillRate,
            fillRateCustom: cs.data.fillRateCustom,
          });
        }
        else if (cs.data.type === "input") addInputCard(cs.data.text || "", { x: cs.x, y: cs.y, id: cs.id });
        else if (cs.data.type === "comment") addCommentCard(cs.data.text || "", { x: cs.x, y: cs.y, id: cs.id });
        else addCard(cs.data, { x: cs.x, y: cs.y, id: cs.id });
      }
      for (const gs of state.groups || []) {
        restoreGroup(gs);
      }
      setNextIds({
        nextCardId: state.nextCardId,
        nextGroupId: state.nextGroupId,
      });
      setRestoring(false);
      updateDpCosts();
    }

    return { serialize, restore };
  };
})();
