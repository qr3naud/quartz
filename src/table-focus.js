// ---------------------------------------------------------------------------
// Post-navigation column focus.
//
// Receiving end of the "Open in table" hand-off started by __cb.openCardInTable
// in src/overlay.js. That helper stamps a `cb-focus-field` entry into
// sessionStorage right before navigating to the source view URL with a
// `?fieldId=...` query param. Clay's VirtualizedGrid consumes the param via
// useQuerySchemaActions and scrolls — but its scrollToField (apps/frontend/
// src/components/GridView/useGridScrollToPosition.ts lines 218–223) right-
// aligns columns that come in from off-screen-right, which is the common case
// when navigating from far away.
//
// This module:
//   1. Reads the sentinel on every page load (10s TTL — anything older is
//      stale and silently dropped).
//   2. Observes the DOM until Clay mounts the column header
//      (#table-header-cell-{fieldId}).
//   3. One rAF after the header appears (so Clay's own scroll has fired),
//      re-scrolls the grid container so the column's left edge sits just to
//      the right of the pinned strip — left-aligned visually.
//   4. Adds .cb-focus-flash to the header for a 5s indigo border pulse
//      (rendered as a ::after pseudo-element so it sits above the column
//      header's child <button>; see styles/overlay.css for the implementation
//      note explaining why outline didn't work).
//   5. Clears the sentinel either on success or after a 10s safety timeout
//      so it never lingers between sessions.
// ---------------------------------------------------------------------------

(function () {
  "use strict";

  let raw = null;
  try { raw = sessionStorage.getItem("cb-focus-field"); } catch (_e) { return; }
  if (!raw) return;

  let parsed;
  try { parsed = JSON.parse(raw); } catch (_e) {
    try { sessionStorage.removeItem("cb-focus-field"); } catch (_ignore) {}
    return;
  }
  if (!parsed?.fieldId || !parsed?.ts || Date.now() - parsed.ts > 10000) {
    try { sessionStorage.removeItem("cb-focus-field"); } catch (_ignore) {}
    return;
  }

  const fieldId = parsed.fieldId;
  const HEADER_ID = `table-header-cell-${fieldId}`;
  const CONTAINER_ID = "grid-view-scroll-container";
  const PINNED_CONTAINER_ID = "table-header-pinned-fields-container";
  const FLASH_CLASS = "cb-focus-flash";
  const FLASH_DURATION_MS = 5000;
  const POST_MOUNT_DELAY_MS = 200;
  const SAFETY_TIMEOUT_MS = 10000;

  function leftAlignAndFlash() {
    const container = document.getElementById(CONTAINER_ID);
    const header = document.getElementById(HEADER_ID);
    if (!container || !header) return false;

    // Pinned (sticky) headers are always visible inside the pinned strip;
    // scrolling won't move them. Mirror Clay's own scrollTableHeaderCellIntoView
    // behavior (apps/frontend/src/components/TableHeaderCell/scrollTableHeaderCellIntoView.ts
    // lines 23–27): if pinned, skip the scroll but still flash so the user
    // knows which column was selected.
    const isPinned = getComputedStyle(header).position === "sticky";
    if (!isPinned) {
      // Use Clay's canonical pinned-strip-width hook — the right edge of
      // #table-header-pinned-fields-container is exactly where the unpinned
      // columns start. This is the same anchor Clay uses internally; see
      // apps/frontend/src/components/TableHeaderCell/scrollTableHeaderCellIntoView.ts
      // (lines 29–30) and apps/frontend/src/components/TableHeader/index.tsx (line 203).
      const pinned = document.getElementById(PINNED_CONTAINER_ID);
      const pinnedRight = pinned?.getBoundingClientRect().right ?? 0;
      const headerLeft = header.getBoundingClientRect().left;
      // Positive amount → header is to the right of the pinned strip → scroll
      // right to bring it flush against the pinned strip. Negative amount →
      // header is to the left → scroll left. Either way we land header.left
      // at pinnedRight (the leftmost spot a non-pinned column can occupy).
      const amount = headerLeft - pinnedRight;
      if (Math.abs(amount) > 1) {
        const target = Math.max(0, container.scrollLeft + amount);
        container.scrollTo({ left: target, behavior: "auto" });
      }
    }

    header.classList.add(FLASH_CLASS);
    setTimeout(() => header.classList.remove(FLASH_CLASS), FLASH_DURATION_MS);
    return true;
  }

  let done = false;
  let observer = null;
  let safetyTimer = null;

  function finish() {
    if (done) return;
    done = true;
    if (observer) observer.disconnect();
    if (safetyTimer) clearTimeout(safetyTimer);
    try { sessionStorage.removeItem("cb-focus-field"); } catch (_e) {}
  }

  function attempt() {
    if (done) return;
    if (!document.getElementById(HEADER_ID)) return;
    // Defer past Clay's own ?fieldId= scroll cycle. Clay's useQuerySchemaActions
    // fires scrollToField in a useEffect that runs synchronously after the
    // header mounts; a single rAF isn't always enough because React's commit
    // → effect → scroll chain may straddle multiple frames depending on the
    // scheduler. 200ms is comfortably past it on every machine we've tested
    // and still feels instant to the user.
    setTimeout(() => {
      if (done) return;
      if (leftAlignAndFlash()) finish();
    }, POST_MOUNT_DELAY_MS);
  }

  observer = new MutationObserver(attempt);
  observer.observe(document.body, { childList: true, subtree: true });
  safetyTimer = setTimeout(finish, SAFETY_TIMEOUT_MS);
  attempt();
})();
