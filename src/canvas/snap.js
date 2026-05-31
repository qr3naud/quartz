(function () {
  "use strict";

  window.__cbCanvasModules = window.__cbCanvasModules || {};

  window.__cbCanvasModules.createSnapHelpers = function createSnapHelpers(deps) {
    const { cardsRef, getCardRect } = deps;

    const SNAP_THRESHOLD = 20;
    const ADJACENCY_TOLERANCE = 1;

    function hasFullSideMatch(r1, r2, axis, tolerance) {
      if (axis === "horizontal") {
        return (
          Math.abs(r1.y - r2.y) <= tolerance &&
          Math.abs(r1.y + r1.h - (r2.y + r2.h)) <= tolerance
        );
      }
      return (
        Math.abs(r1.x - r2.x) <= tolerance &&
        Math.abs(r1.x + r1.w - (r2.x + r2.w)) <= tolerance
      );
    }

    function findSnapTarget(draggedCardIds, primaryCardId) {
      const cards = cardsRef();
      const primary = cards.find((c) => c.id === primaryCardId);
      if (!primary) return { dx: 0, dy: 0 };

      const d = getCardRect(primary);
      let snapDx = 0,
        snapDy = 0;
      let bestDistX = SNAP_THRESHOLD + 1;
      let bestDistY = SNAP_THRESHOLD + 1;

      for (const other of cards) {
        if (draggedCardIds.has(other.id)) continue;
        const r = getCardRect(other);

        const vNear =
          Math.abs(d.h - r.h) <= SNAP_THRESHOLD &&
          Math.abs(d.y - r.y) <= SNAP_THRESHOLD + Math.max(d.h, r.h);
        const hNear =
          Math.abs(d.w - r.w) <= SNAP_THRESHOLD &&
          Math.abs(d.x - r.x) <= SNAP_THRESHOLD + Math.max(d.w, r.w);

        if (vNear) {
          const d1 = Math.abs(d.x + d.w - r.x);
          if (d1 < bestDistX) {
            bestDistX = d1;
            snapDx = r.x - (d.x + d.w);
          }
          const d2 = Math.abs(d.x - (r.x + r.w));
          if (d2 < bestDistX) {
            bestDistX = d2;
            snapDx = r.x + r.w - d.x;
          }
        }

        if (hNear) {
          const d3 = Math.abs(d.y + d.h - r.y);
          if (d3 < bestDistY) {
            bestDistY = d3;
            snapDy = r.y - (d.y + d.h);
          }
          const d4 = Math.abs(d.y - (r.y + r.h));
          if (d4 < bestDistY) {
            bestDistY = d4;
            snapDy = r.y + r.h - d.y;
          }
        }
      }

      if (bestDistX <= SNAP_THRESHOLD) {
        for (const other of cards) {
          if (draggedCardIds.has(other.id)) continue;
          const r = getCardRect(other);
          const topGap = Math.abs(d.y - r.y);
          if (topGap < bestDistY) {
            bestDistY = topGap;
            snapDy = r.y - d.y;
          }
          const botGap = Math.abs(d.y + d.h - (r.y + r.h));
          if (botGap < bestDistY) {
            bestDistY = botGap;
            snapDy = r.y + r.h - (d.y + d.h);
          }
        }
      }

      if (bestDistY <= SNAP_THRESHOLD) {
        for (const other of cards) {
          if (draggedCardIds.has(other.id)) continue;
          const r = getCardRect(other);
          const leftGap = Math.abs(d.x - r.x);
          if (leftGap < bestDistX) {
            bestDistX = leftGap;
            snapDx = r.x - d.x;
          }
          const rightGap = Math.abs(d.x + d.w - (r.x + r.w));
          if (rightGap < bestDistX) {
            bestDistX = rightGap;
            snapDx = r.x + r.w - (d.x + d.w);
          }
        }
      }

      return {
        dx: bestDistX <= SNAP_THRESHOLD ? snapDx : 0,
        dy: bestDistY <= SNAP_THRESHOLD ? snapDy : 0,
      };
    }

    function areAdjacent(r1, r2) {
      if (
        Math.abs(r1.x + r1.w - r2.x) <= ADJACENCY_TOLERANCE &&
        hasFullSideMatch(r1, r2, "horizontal", ADJACENCY_TOLERANCE)
      )
        return "right";
      if (
        Math.abs(r1.x - (r2.x + r2.w)) <= ADJACENCY_TOLERANCE &&
        hasFullSideMatch(r1, r2, "horizontal", ADJACENCY_TOLERANCE)
      )
        return "left";
      if (
        Math.abs(r1.y + r1.h - r2.y) <= ADJACENCY_TOLERANCE &&
        hasFullSideMatch(r1, r2, "vertical", ADJACENCY_TOLERANCE)
      )
        return "bottom";
      if (
        Math.abs(r1.y - (r2.y + r2.h)) <= ADJACENCY_TOLERANCE &&
        hasFullSideMatch(r1, r2, "vertical", ADJACENCY_TOLERANCE)
      )
        return "top";
      return null;
    }

    function getAdjacentPairs() {
      const cards = cardsRef();
      const pairs = [];
      for (let i = 0; i < cards.length; i++) {
        const r1 = getCardRect(cards[i]);
        for (let j = i + 1; j < cards.length; j++) {
          const r2 = getCardRect(cards[j]);
          const side = areAdjacent(r1, r2);
          if (side) pairs.push({ id1: cards[i].id, id2: cards[j].id, side });
        }
      }
      return pairs;
    }

    function renderClusterOutlines() {
      for (const c of cardsRef()) {
        c.el.classList.remove(
          "cb-card-snapped",
          "cb-snap-top",
          "cb-snap-bottom",
          "cb-snap-left",
          "cb-snap-right"
        );
      }

      const allCards = cardsRef();

      // The "this card belongs to a cluster" halo (`cb-card-snapped`)
      // is now derived from the relational model — `card.clusterId` —
      // rather than snap-adjacency. This keeps the halo on cards
      // whose cluster-mates exist but aren't currently touching them
      // geometrically (eg. a DP that lost its bridge ER via the table
      // view). Side classes below still come from geometry because
      // they style the BORDERS that physically touch.
      //
      // Mirrors the size>=2 filter in canvas.getClusters: a singleton
      // (the only card carrying its clusterId) gets no halo.
      const clusterCounts = new Map();
      for (const c of allCards) {
        if (c.clusterId == null) continue;
        clusterCounts.set(c.clusterId, (clusterCounts.get(c.clusterId) || 0) + 1);
      }
      for (const c of allCards) {
        if (c.clusterId == null) continue;
        if ((clusterCounts.get(c.clusterId) || 0) < 2) continue;
        c.el.classList.add("cb-card-snapped");
      }

      const pairs = getAdjacentPairs();

      for (const pair of pairs) {
        const c1 = allCards.find((c) => c.id === pair.id1);
        const c2 = allCards.find((c) => c.id === pair.id2);
        if (!c1 || !c2) continue;

        if (pair.side === "right") {
          c1.el.classList.add("cb-snap-right");
          c2.el.classList.add("cb-snap-left");
        } else if (pair.side === "left") {
          c1.el.classList.add("cb-snap-left");
          c2.el.classList.add("cb-snap-right");
        } else if (pair.side === "bottom") {
          c1.el.classList.add("cb-snap-bottom");
          c2.el.classList.add("cb-snap-top");
        } else if (pair.side === "top") {
          c1.el.classList.add("cb-snap-top");
          c2.el.classList.add("cb-snap-bottom");
        }
      }
    }

    return {
      findSnapTarget,
      getAdjacentPairs,
      areAdjacent,
      renderClusterOutlines,
    };
  };
})();
