/**
 * Subscribes to peer-originated card actions (moves and text edits) and
 * applies them to the local canvas. Complements the whole-state sync in
 * tabs.js so peers see each other's drags and typing within ~100ms instead
 * of waiting for the 500ms debounced save.
 *
 * Conflict rules:
 *   - Local-drag-wins: if we're currently dragging a card, incoming moves
 *     for that same card are ignored. When our drag ends, eventual save
 *     propagation will resync anyway.
 *   - Local-edit-wins: if our caret is inside a card's text element, we
 *     ignore incoming text updates for it. Prevents overwriting in-progress
 *     typing mid-stroke.
 *
 * Lifecycle (driven by overlay.js):
 *   __cb.mountLiveActions()     -> called on openCanvas, after the channel
 *                                   is joined
 *   __cb.unmountLiveActions()   -> called on closeCanvas
 */
(function () {
  "use strict";

  const __cb = window.__cb;
  if (!__cb) return;

  let unsubMove = null;
  let unsubText = null;

  function applyRemoteCardMove(userId, cardId, x, y) {
    if (!userId || String(userId) === String(__cb.userId)) return;
    const canvas = __cb.canvas;
    if (!canvas?.getCardById) return;
    const card = canvas.getCardById(cardId);
    if (!card) return;

    // Local drag wins: if we're currently dragging this card, don't let the
    // peer's stream yank it out from under our mouse.
    if (canvas.isDraggingCard?.(cardId)) return;

    card.x = x;
    card.y = y;
    card.el.style.transform = `translate(${x}px, ${y}px)`;
    // Keep any surrounding group's bounding box in sync so the group rect
    // follows the card as it moves. Safe to call frequently.
    canvas.updateGroupBounds?.();
    // Snap clusters (connections/waterfall groupings) depend on card rects
    // too. refreshClusters recomputes them + redraws connections.
    canvas.refreshClusters?.();
  }

  function applyRemoteCardText(userId, cardId, text) {
    if (!userId || String(userId) === String(__cb.userId)) return;
    const canvas = __cb.canvas;
    if (!canvas?.getCardById) return;
    const card = canvas.getCardById(cardId);
    if (!card) return;

    // DP, input, and comment cards each have a different contenteditable.
    // Grab whichever exists; there's at most one per card.
    const textEl = card.el.querySelector(
      ".cb-dp-text,.cb-input-text,.cb-comment-text",
    );
    if (!textEl) return;

    // Local edit wins: if our caret is currently inside this very element,
    // skip the update so the peer's keystroke stream doesn't clobber the
    // text we're typing.
    if (textEl === document.activeElement) return;

    // Avoid no-op writes that would still reset the caret / scroll position.
    if (textEl.textContent === text) return;

    textEl.textContent = text;
    card.data.text = text;
    card.data.displayName = text;
  }

  __cb.mountLiveActions = function () {
    if (!__cb.realtime) return;
    // Idempotent: if already mounted (double-mount due to re-entry), bail.
    if (unsubMove || unsubText) return;
    if (__cb.realtime.onCardMove) {
      unsubMove = __cb.realtime.onCardMove(applyRemoteCardMove);
    }
    if (__cb.realtime.onCardText) {
      unsubText = __cb.realtime.onCardText(applyRemoteCardText);
    }
  };

  __cb.unmountLiveActions = function () {
    if (unsubMove) { unsubMove(); unsubMove = null; }
    if (unsubText) { unsubText(); unsubText = null; }
  };
})();
