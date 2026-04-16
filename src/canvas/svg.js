(function () {
  "use strict";

  window.__cbCanvasModules = window.__cbCanvasModules || {};

  window.__cbCanvasModules.createSvgEl = function createSvgEl(tag) {
    return document.createElementNS("http://www.w3.org/2000/svg", tag);
  };
})();
