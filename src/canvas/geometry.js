(function () {
  "use strict";

  window.__cbCanvasModules = window.__cbCanvasModules || {};

  window.__cbCanvasModules.createGeometryHelpers = function createGeometryHelpers() {
    function bezier(x1, y1, x2, y2) {
      const dx = Math.abs(x2 - x1) * 0.5;
      return `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`;
    }

    function linePath(x1, y1, x2, y2) {
      return `M${x1},${y1} L${x2},${y2}`;
    }

    function getCardRect(c) {
      return { x: c.x, y: c.y, w: c.el.offsetWidth || 220, h: c.el.offsetHeight || 70 };
    }

    function edgePoint(c, side) {
      const r = getCardRect(c);
      if (side === "top") return { x: r.x + r.w / 2, y: r.y };
      if (side === "bottom") return { x: r.x + r.w / 2, y: r.y + r.h };
      if (side === "left") return { x: r.x, y: r.y + r.h / 2 };
      return { x: r.x + r.w, y: r.y + r.h / 2 };
    }

    function closestEdge(c, cx, cy) {
      let best = "right";
      let bestDist = Infinity;
      for (const s of ["top", "bottom", "left", "right"]) {
        const p = edgePoint(c, s);
        const d = Math.hypot(p.x - cx, p.y - cy);
        if (d < bestDist) {
          bestDist = d;
          best = s;
        }
      }
      return best;
    }

    return { bezier, linePath, getCardRect, edgePoint, closestEdge };
  };
})();
