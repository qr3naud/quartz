// ---------------------------------------------------------------------------
// Post-navigation column focus (cross-table reload path).
//
// Receiving end of the "Find in table" hand-off started by __cb.openCardInTable
// in src/overlay.js. When the source column lives in a DIFFERENT table than the
// one currently overlaid, that helper does a full navigation and stamps a
// `cb-focus-field` entry into sessionStorage right before the reload. On the
// destination page this module reads the sentinel and delegates the actual
// scroll-into-view + header flash to the shared __cb.focusFieldInGrid (defined
// in overlay.js, which loads first). The same-table path never reaches here —
// it soft-navigates and calls focusFieldInGrid directly without a reload.
//
// The sentinel carries a 10s TTL so a stale entry (e.g. the user navigated
// manually before the destination loaded) is silently dropped.
// ---------------------------------------------------------------------------

(function () {
  "use strict";

  let raw = null;
  try { raw = sessionStorage.getItem("cb-focus-field"); } catch (_e) { return; }
  if (!raw) return;

  // Consume the sentinel immediately — the focus work happens in-memory from
  // here, so there's no reason to leave it lingering in sessionStorage.
  try { sessionStorage.removeItem("cb-focus-field"); } catch (_ignore) {}

  let parsed;
  try { parsed = JSON.parse(raw); } catch (_e) { return; }
  if (!parsed?.fieldId || !parsed?.ts || Date.now() - parsed.ts > 10000) return;

  const cb = window.__cb;
  if (cb && typeof cb.focusFieldInGrid === "function") {
    cb.focusFieldInGrid(parsed.fieldId);
  }
})();
