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

  let client = null;
  let channel = null;
  let currentWorkbookId = null;

  const cursorHandlers = new Set();
  const presenceHandlers = new Set();
  const canvasUpdateHandlers = new Set();

  // Throttle state for broadcastCursor. We keep both the last sent position
  // (to skip tiny movements) and a trailing timer so the final position is
  // always transmitted even if the user stops moving.
  let lastCursorSent = { x: null, y: null, t: 0 };
  let pendingCursor = null;
  let cursorTimer = null;

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
      // if a bug ever sends in a loop. This is a client-side safety net.
      realtime: { params: { eventsPerSecond: 30 } },
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
})();
