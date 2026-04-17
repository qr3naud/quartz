/**
 * Thin wrapper around Supabase Realtime. Responsible for:
 *   - Maintaining one supabase-js client for the page.
 *   - Joining/leaving a per-workbook channel (`cb:wb:{workbookId}`).
 *   - Multiplexing three features over that single channel:
 *       1. Live cursors (Broadcast)
 *       2. Presence (who's currently viewing)
 *       3. Postgres changes on `canvases` (live save propagation)
 *
 * Depends on:
 *   - `window.supabase` from `vendor/supabase-realtime.js` (UMD bundle)
 *   - `window.__cbSupabase` from `src/supabase.js` for SUPABASE_URL / anon key
 *
 * Consumers (content script only):
 *   __cb.realtime.joinWorkbook(workbookId, presence)
 *   __cb.realtime.leaveWorkbook()
 *   __cb.realtime.broadcastCursor(x, y)        // throttled internally
 *   __cb.realtime.onCursor(handler)            // (userId, x, y) => void
 *   __cb.realtime.onPresenceSync(handler)      // (activeUsers: Map) => void
 *   __cb.realtime.onCanvasUpdate(handler)      // (newRow) => void
 */
(function () {
  "use strict";

  const __cb = window.__cb;
  if (!__cb) return;

  // Cursor broadcast throttle. 50ms = 20fps, well within the free plan's
  // 100 msgs/sec project-wide budget for a handful of simultaneous movers.
  const CURSOR_THROTTLE_MS = 50;
  const CURSOR_MIN_DELTA = 1; // skip broadcasts smaller than 1px canvas-space
  // Card drag throttle. 33ms = 30fps. Per-card: if you drag 3 cards at once
  // we still emit 30 msgs/s per card (90/s total for that user). Trailing
  // send ensures the final resting position always gets through.
  const CARD_MOVE_THROTTLE_MS = 33;
  const CARD_MOVE_MIN_DELTA = 0.5;
  // Text broadcasts are debounced (leading-off, trailing-on) since seeing
  // every keystroke adds little value once you're typing a word.
  const CARD_TEXT_DEBOUNCE_MS = 100;

  let client = null;
  let channel = null;
  let currentWorkbookId = null;

  const cursorHandlers = new Set();
  const presenceHandlers = new Set();
  const canvasUpdateHandlers = new Set();
  const cardMoveHandlers = new Set();
  const cardTextHandlers = new Set();

  // Throttle state for broadcastCursor. We keep both the last sent position
  // (to skip tiny movements) and a trailing timer so the final position is
  // always transmitted even if the user stops moving.
  let lastCursorSent = { x: null, y: null, t: 0 };
  let pendingCursor = null;
  let cursorTimer = null;

  // Per-card state for cardMove throttling and cardText debouncing. Each map
  // is keyed by cardId so parallel drags/edits don't interfere with each other.
  // cardMoveState: cardId -> { lastSentT, lastSentX, lastSentY, pending, timer }
  // cardTextState: cardId -> { pendingText, timer }
  const cardMoveState = new Map();
  const cardTextState = new Map();

  function getClient() {
    if (client) return client;
    const supa = window.__cbSupabase;
    const sb = window.supabase;
    if (!supa || !sb?.createClient) {
      console.warn("[Clay Scoping] Supabase realtime unavailable");
      return null;
    }
    client = sb.createClient(supa.SUPABASE_URL, supa.SUPABASE_ANON_KEY, {
      // Cap realtime-internal events per second to avoid runaway broadcasts
      // if a bug ever sends in a loop. Set high enough to accommodate:
      // cursor (20/s) + card drags (30/s each, rarely more than 3 parallel)
      // + text debounced (10/s). 120 is a comfortable client-side ceiling
      // below the 200/s realtime-js default.
      realtime: { params: { eventsPerSecond: 120 } },
    });
    return client;
  }

  function dispatchPresenceSync() {
    if (!channel) return;
    // presenceState() returns { presenceKey: [trackedPayload, ...], ... }.
    // We flatten into a Map keyed by user_id for easy lookup in the widget.
    const raw = channel.presenceState() || {};
    const byUser = new Map();
    for (const arr of Object.values(raw)) {
      for (const entry of arr) {
        if (entry?.user_id) byUser.set(String(entry.user_id), entry);
      }
    }
    for (const handler of presenceHandlers) {
      try { handler(byUser); } catch (err) { console.error(err); }
    }
  }

  /**
   * Joins the channel for this workbook. Safe to call multiple times: if we're
   * already on the requested channel, it's a no-op; if on a different one, we
   * leave first.
   */
  __cb.realtime = __cb.realtime || {};

  __cb.realtime.joinWorkbook = async function (workbookId, presence) {
    if (!workbookId) return;
    if (channel && currentWorkbookId === workbookId) return; // already joined
    if (channel) await __cb.realtime.leaveWorkbook();

    const c = getClient();
    if (!c) return;

    currentWorkbookId = workbookId;
    // Presence key defaults to the user_id we track so a single user opening
    // the canvas in two tabs appears as one entry.
    channel = c.channel(`cb:wb:${workbookId}`, {
      config: {
        presence: { key: String(presence?.user_id || "anon") },
        broadcast: { self: false }, // we never want to receive our own cursor echo
      },
    });

    channel
      .on("broadcast", { event: "cursor" }, ({ payload }) => {
        if (!payload) return;
        for (const handler of cursorHandlers) {
          try { handler(payload.userId, payload.x, payload.y); }
          catch (err) { console.error(err); }
        }
      })
      .on("broadcast", { event: "cardMove" }, ({ payload }) => {
        if (!payload) return;
        for (const handler of cardMoveHandlers) {
          try { handler(payload.userId, payload.cardId, payload.x, payload.y); }
          catch (err) { console.error(err); }
        }
      })
      .on("broadcast", { event: "cardText" }, ({ payload }) => {
        if (!payload) return;
        for (const handler of cardTextHandlers) {
          try { handler(payload.userId, payload.cardId, payload.text); }
          catch (err) { console.error(err); }
        }
      })
      .on("presence", { event: "sync" }, dispatchPresenceSync)
      .on("presence", { event: "join" }, dispatchPresenceSync)
      .on("presence", { event: "leave" }, dispatchPresenceSync)
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "canvases",
          filter: `workbook_id=eq.${workbookId}`,
        },
        (payload) => {
          if (!payload?.new) return;
          for (const handler of canvasUpdateHandlers) {
            try { handler(payload.new); } catch (err) { console.error(err); }
          }
        },
      )
      .subscribe(async (status) => {
        // Once the channel is joined, advertise our presence. Doing this in
        // the callback (rather than eagerly) avoids a race where `track()`
        // silently fails before the subscription is ready.
        if (status === "SUBSCRIBED" && presence) {
          try {
            await channel.track({
              ...presence,
              online_at: new Date().toISOString(),
            });
          } catch (err) {
            console.warn("[Clay Scoping] presence track failed:", err);
          }
        }
      });
  };

  __cb.realtime.leaveWorkbook = async function () {
    // Clear any pending cursor broadcast so we don't send to a dead channel.
    if (cursorTimer) { clearTimeout(cursorTimer); cursorTimer = null; }
    pendingCursor = null;
    lastCursorSent = { x: null, y: null, t: 0 };

    // Clear per-card timers too. Iterating over Map values because we want
    // to cancel every pending throttle/debounce before tearing the channel.
    for (const s of cardMoveState.values()) {
      if (s.timer) clearTimeout(s.timer);
    }
    for (const s of cardTextState.values()) {
      if (s.timer) clearTimeout(s.timer);
    }
    cardMoveState.clear();
    cardTextState.clear();

    if (!channel) { currentWorkbookId = null; return; }
    try {
      await channel.untrack();
      await channel.unsubscribe();
    } catch {
      // Ignore teardown errors; the channel is going away anyway.
    }
    channel = null;
    currentWorkbookId = null;
  };

  // Cursor broadcast: coalesce to CURSOR_THROTTLE_MS, always send the final
  // position via a trailing timer so other users see our cursor come to rest.
  __cb.realtime.broadcastCursor = function (x, y) {
    if (!channel) return;

    const now = Date.now();
    pendingCursor = { x, y };

    const dx = lastCursorSent.x == null ? Infinity : Math.abs(x - lastCursorSent.x);
    const dy = lastCursorSent.y == null ? Infinity : Math.abs(y - lastCursorSent.y);
    if (dx < CURSOR_MIN_DELTA && dy < CURSOR_MIN_DELTA) return;

    const elapsed = now - lastCursorSent.t;
    if (elapsed >= CURSOR_THROTTLE_MS) {
      sendCursorNow();
      return;
    }
    // Haven't reached the throttle window; schedule a trailing send.
    if (!cursorTimer) {
      cursorTimer = setTimeout(sendCursorNow, CURSOR_THROTTLE_MS - elapsed);
    }
  };

  function sendCursorNow() {
    cursorTimer = null;
    if (!channel || !pendingCursor) return;
    const { x, y } = pendingCursor;
    pendingCursor = null;
    lastCursorSent = { x, y, t: Date.now() };
    channel.send({
      type: "broadcast",
      event: "cursor",
      payload: { userId: __cb.userId, x, y },
    }).catch(() => {/* non-critical */});
  }

  __cb.realtime.onCursor = function (handler) {
    cursorHandlers.add(handler);
    return () => cursorHandlers.delete(handler);
  };

  __cb.realtime.onPresenceSync = function (handler) {
    presenceHandlers.add(handler);
    // Fire immediately with current state so late subscribers aren't empty.
    if (channel) queueMicrotask(dispatchPresenceSync);
    return () => presenceHandlers.delete(handler);
  };

  __cb.realtime.onCanvasUpdate = function (handler) {
    canvasUpdateHandlers.add(handler);
    return () => canvasUpdateHandlers.delete(handler);
  };

  // --------------------------------------------------------------------------
  // Tier D: card-level live actions (moves + text)
  // --------------------------------------------------------------------------

  /**
   * Broadcasts a card position during a drag. Per-card throttled at 30fps
   * with a trailing send, so the drop-at-rest position always propagates.
   */
  __cb.realtime.broadcastCardMove = function (cardId, x, y) {
    if (!channel || cardId == null) return;
    const key = String(cardId);
    let s = cardMoveState.get(key);
    if (!s) {
      s = { lastSentT: 0, lastSentX: null, lastSentY: null, pending: null, timer: null };
      cardMoveState.set(key, s);
    }
    s.pending = { x, y };

    const dx = s.lastSentX == null ? Infinity : Math.abs(x - s.lastSentX);
    const dy = s.lastSentY == null ? Infinity : Math.abs(y - s.lastSentY);
    if (dx < CARD_MOVE_MIN_DELTA && dy < CARD_MOVE_MIN_DELTA) return;

    const elapsed = Date.now() - s.lastSentT;
    if (elapsed >= CARD_MOVE_THROTTLE_MS) {
      sendCardMoveNow(key);
      return;
    }
    if (!s.timer) {
      s.timer = setTimeout(() => sendCardMoveNow(key), CARD_MOVE_THROTTLE_MS - elapsed);
    }
  };

  function sendCardMoveNow(key) {
    const s = cardMoveState.get(key);
    if (!s) return;
    s.timer = null;
    if (!channel || !s.pending) return;
    const { x, y } = s.pending;
    s.pending = null;
    s.lastSentT = Date.now();
    s.lastSentX = x;
    s.lastSentY = y;
    channel.send({
      type: "broadcast",
      event: "cardMove",
      payload: { userId: __cb.userId, cardId: key, x, y },
    }).catch(() => {/* non-critical */});
  }

  /**
   * Broadcasts a card's text content. Per-card debounced at 100ms so rapid
   * typing coalesces into one send per quiet moment, rather than one per
   * keystroke.
   */
  __cb.realtime.broadcastCardText = function (cardId, text) {
    if (!channel || cardId == null) return;
    const key = String(cardId);
    let s = cardTextState.get(key);
    if (!s) {
      s = { pendingText: null, timer: null };
      cardTextState.set(key, s);
    }
    s.pendingText = text;
    if (s.timer) clearTimeout(s.timer);
    s.timer = setTimeout(() => sendCardTextNow(key), CARD_TEXT_DEBOUNCE_MS);
  };

  function sendCardTextNow(key) {
    const s = cardTextState.get(key);
    if (!s) return;
    s.timer = null;
    if (!channel || s.pendingText == null) return;
    const text = s.pendingText;
    s.pendingText = null;
    channel.send({
      type: "broadcast",
      event: "cardText",
      payload: { userId: __cb.userId, cardId: key, text },
    }).catch(() => {/* non-critical */});
  }

  __cb.realtime.onCardMove = function (handler) {
    cardMoveHandlers.add(handler);
    return () => cardMoveHandlers.delete(handler);
  };

  __cb.realtime.onCardText = function (handler) {
    cardTextHandlers.add(handler);
    return () => cardTextHandlers.delete(handler);
  };
})();
