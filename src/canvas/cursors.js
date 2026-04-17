/**
 * Remote cursor overlay. Shows other users' cursors on the brainstorm canvas
 * in real time. Cursors live inside `cardContainer` so the existing pan/zoom
 * transform automatically applies — they "stick" to the canvas, not the
 * viewport.
 *
 * Lifecycle (driven by overlay.js):
 *   mountCursorsLayer(cardContainer)  -> called on openCanvas
 *   unmountCursorsLayer()              -> called on closeCanvas
 *
 * Data in: __cb.realtime.onCursor((userId, x, y) => ...) and
 *          __cb.realtime.onPresenceSync((byUser) => ...) so the cursor label
 *          can show each user's name/avatar color.
 */
(function () {
  "use strict";

  const __cb = window.__cb;
  if (!__cb) return;

  // A cursor is "stale" if we haven't received an update in this long. We
  // hide (not remove) stale cursors so a returning user keeps the same DOM
  // node and doesn't flicker back in from a different position.
  const STALE_AFTER_MS = 3000;
  const REAPER_INTERVAL_MS = 500;

  let layerEl = null;
  let reaperTimer = null;
  let unsubCursor = null;
  let unsubPresence = null;
  // userId -> { el, lastSeen, x, y }
  const cursorsByUser = new Map();
  // userId -> { name, profile_picture } from presence payloads
  const userMetaByUser = new Map();

  function buildCursorEl(userId) {
    const el = document.createElement("div");
    el.className = "cb-cursor";
    el.setAttribute("data-user-id", userId);

    // SVG arrow pointer; stroke color set via --cb-cursor-color CSS var so we
    // can reuse the same palette helper used elsewhere in the extension.
    const color = __cb.stringToColor ? __cb.stringToColor(String(userId)) : "#6366f1";
    el.style.setProperty("--cb-cursor-color", color);

    const pointer = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    pointer.setAttribute("class", "cb-cursor-pointer");
    pointer.setAttribute("width", "18");
    pointer.setAttribute("height", "18");
    pointer.setAttribute("viewBox", "0 0 16 16");
    pointer.innerHTML =
      '<path d="M1 1 L1 14 L5 10 L8 15 L10 14 L7 9 L12 9 Z" ' +
      'fill="var(--cb-cursor-color)" stroke="white" stroke-width="1" ' +
      'stroke-linejoin="round" />';
    el.appendChild(pointer);

    const label = document.createElement("div");
    label.className = "cb-cursor-label";
    el.appendChild(label);

    return el;
  }

  function updateLabel(entry, userId) {
    const meta = userMetaByUser.get(String(userId));
    const label = entry.el.querySelector(".cb-cursor-label");
    if (!label) return;
    label.textContent = meta?.name || "Someone";
  }

  function upsertCursor(userId, x, y) {
    if (!layerEl) return;
    if (userId == null) return;
    if (String(userId) === String(__cb.userId)) return; // never show self

    let entry = cursorsByUser.get(String(userId));
    if (!entry) {
      entry = { el: buildCursorEl(userId), lastSeen: 0, x: 0, y: 0 };
      layerEl.appendChild(entry.el);
      cursorsByUser.set(String(userId), entry);
      updateLabel(entry, userId);
    }
    entry.x = x;
    entry.y = y;
    entry.lastSeen = Date.now();
    // Cursor coords are canvas-space. Because layerEl is a child of
    // cardContainer (which already has translate+scale applied), we just set
    // a canvas-space transform here and the browser composes the two.
    entry.el.style.transform = `translate(${x}px, ${y}px)`;
    entry.el.classList.remove("cb-cursor-stale");
  }

  function reap() {
    if (!layerEl) return;
    const cutoff = Date.now() - STALE_AFTER_MS;
    for (const [id, entry] of cursorsByUser) {
      if (entry.lastSeen < cutoff) {
        entry.el.classList.add("cb-cursor-stale");
      }
      // Hard-remove cursors we haven't seen in 30s so we don't leak DOM nodes.
      if (entry.lastSeen < Date.now() - 30_000) {
        entry.el.remove();
        cursorsByUser.delete(id);
      }
    }
  }

  __cb.mountCursorsLayer = function (cardContainer) {
    if (!cardContainer || !__cb.realtime) return;
    // Idempotent: if already mounted, leave the existing layer in place.
    if (layerEl && layerEl.parentNode === cardContainer) return;

    layerEl = document.createElement("div");
    layerEl.className = "cb-cursors-layer";
    cardContainer.appendChild(layerEl);

    unsubCursor = __cb.realtime.onCursor((userId, x, y) => {
      upsertCursor(userId, x, y);
    });

    unsubPresence = __cb.realtime.onPresenceSync((byUser) => {
      // Cache name/avatar metadata so the cursor label is accurate. Also
      // prune cursors for users who have left (presence will no longer
      // include them).
      userMetaByUser.clear();
      for (const [id, meta] of byUser) userMetaByUser.set(String(id), meta);
      for (const [id, entry] of cursorsByUser) {
        updateLabel(entry, id);
        if (!byUser.has(String(id))) {
          entry.el.remove();
          cursorsByUser.delete(id);
        }
      }
    });

    reaperTimer = setInterval(reap, REAPER_INTERVAL_MS);
  };

  __cb.unmountCursorsLayer = function () {
    if (reaperTimer) { clearInterval(reaperTimer); reaperTimer = null; }
    if (unsubCursor) { unsubCursor(); unsubCursor = null; }
    if (unsubPresence) { unsubPresence(); unsubPresence = null; }
    if (layerEl && layerEl.parentNode) layerEl.parentNode.removeChild(layerEl);
    layerEl = null;
    cursorsByUser.clear();
    userMetaByUser.clear();
  };
})();
