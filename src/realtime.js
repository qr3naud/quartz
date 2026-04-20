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
  // Flip to true once the channel emits status "SUBSCRIBED" (WebSocket fully
  // open and joined). Broadcasts issued before this would get transparently
  // routed through a REST fallback inside supabase-js, emitting a deprecation
  // warning on every call. Gating on this flag drops those early sends
  // silently -- they'd only be cursor/drag positions anyway, and we emit the
  // latest position on the next frame so nothing user-visible is lost.
  let channelReady = false;

  const cursorHandlers = new Set();
  const presenceHandlers = new Set();
  const canvasUpdateHandlers = new Set();
  const tabUpdateHandlers = new Set();
  const cardMoveHandlers = new Set();
  const cardTextHandlers = new Set();
  // Dedupe key for tabState/tabInvalidate. After we apply a row identified
  // by `${workbook_id}:${tab_id}@${updated_at}`, ignore later events with the
  // same key. Specifically prevents the tabInvalidate fallback from firing a
  // redundant refetch when tabState already delivered the row successfully.
  const lastAppliedTabKey = new Map(); // `${workbookId}:${tabId}` -> updated_at

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

  // Per-workbook coalescing: rapid invalidations (e.g. user A fires saves
  // every 500ms while editing) collapse into at most one in-flight fetch
  // plus one queued follow-up. The follow-up runs once the current fetch
  // resolves, so we always end up with the latest state without piling up
  // requests.
  const refetchInFlight = new Map(); // workbookId -> { pending: boolean }

  async function refetchCanvas(workbookId) {
    if (!workbookId) return;
    const existing = refetchInFlight.get(workbookId);
    if (existing) {
      existing.pending = true;
      return;
    }
    const entry = { pending: false };
    refetchInFlight.set(workbookId, entry);

    const supa = window.__cbSupabase;
    if (!supa) {
      refetchInFlight.delete(workbookId);
      return;
    }

    try {
      const rows = await supa.supabaseFetch("canvases", "GET", {
        query: {
          workbook_id: `eq.${workbookId}`,
          select: "*",
          limit: "1",
        },
      });
      if (rows && rows[0]) {
        for (const handler of canvasUpdateHandlers) {
          try { handler(rows[0]); } catch (err) { console.error(err); }
        }
      }
    } catch (err) {
      console.warn("[Clay Scoping] refetchCanvas failed", err);
    } finally {
      const wasPending = entry.pending;
      refetchInFlight.delete(workbookId);
      // If another invalidation arrived while we were fetching, run one more
      // pass with the latest data. Bounded recursion: each pass clears the
      // pending flag before kicking off the next.
      if (wasPending) refetchCanvas(workbookId);
    }
  }

  // Per-tab equivalent of refetchCanvas. Used when tabState BfD payload was
  // dropped (>256KB) -- tabInvalidate fires as a fallback signal and we
  // refetch the row over REST. Same one-in-flight-plus-queued semantics.
  const refetchTabInFlight = new Map(); // `${workbookId}:${tabId}` -> { pending }

  async function refetchTab(workbookId, tabId) {
    if (!workbookId || !tabId) return;
    const key = `${workbookId}:${tabId}`;
    const existing = refetchTabInFlight.get(key);
    if (existing) {
      existing.pending = true;
      return;
    }
    const entry = { pending: false };
    refetchTabInFlight.set(key, entry);

    const supa = window.__cbSupabase;
    if (!supa) {
      refetchTabInFlight.delete(key);
      return;
    }

    try {
      const rows = await supa.supabaseFetch("canvas_tabs", "GET", {
        query: {
          workbook_id: `eq.${workbookId}`,
          tab_id: `eq.${tabId}`,
          select: "*",
          limit: "1",
        },
      });
      if (rows && rows[0]) {
        // Mark as applied so subsequent dupe events for the same updated_at
        // are no-ops.
        lastAppliedTabKey.set(key, rows[0].updated_at);
        for (const handler of tabUpdateHandlers) {
          try { handler(rows[0]); } catch (err) { console.error(err); }
        }
      } else {
        // Row is gone -> propagate as a deletion so peers drop the tab.
        lastAppliedTabKey.delete(key);
        const deletedRow = { workbook_id: workbookId, tab_id: tabId, __deleted: true };
        for (const handler of tabUpdateHandlers) {
          try { handler(deletedRow); } catch (err) { console.error(err); }
        }
      }
    } catch (err) {
      console.warn("[Clay Scoping] refetchTab failed", err);
    } finally {
      const wasPending = entry.pending;
      refetchTabInFlight.delete(key);
      if (wasPending) refetchTab(workbookId, tabId);
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
        // Required for `realtime.send` and `realtime.broadcast_changes`
        // delivery: those server-side helpers always publish into the
        // private topic namespace. Without this flag, clients silently
        // receive nothing even though the trigger fires successfully.
        // The matching RLS policy on `realtime.messages` lets anon and
        // authenticated roles SELECT/INSERT for topics like 'cb:wb:%'.
        private: true,
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
      // Invalidation broadcast: a Postgres trigger on `canvases` calls
      // realtime.send with a tiny {workbook_id, updated_by, ...} payload
      // any time the row changes. We use this as a cheap "go refetch"
      // signal instead of trying to ship the full state through realtime
      // (which fails for canvases that exceed the 256KB BfD payload cap).
      .on("broadcast", { event: "canvasInvalidate" }, ({ payload }) => {
        if (!payload?.workbook_id) return;
        // Suppress own echo: our own save will already have updated local
        // state, no need to refetch.
        if (payload.updated_by && payload.updated_by === __cb.userId) return;

        console.debug("[Clay Scoping] canvasInvalidate received", {
          workbookId: payload.workbook_id,
          updatedBy: payload.updated_by,
          updatedAt: payload.updated_at,
          operation: payload.operation,
        });

        refetchCanvas(payload.workbook_id);
      })
      // Per-tab live state. The canvas_tabs trigger fires this with the full
      // row via realtime.broadcast_changes. Apply directly when the payload
      // makes it through (most common case now that tabs are small).
      // For DELETE events the row lives in old_record; we tag it __deleted
      // so the receiver knows to drop the tab.
      //
      // Logs are deliberately loud (console.log, not console.debug) on the
      // first entry and at every skip path so we can pinpoint where sync
      // breaks without needing to enable Verbose in DevTools.
      .on("broadcast", { event: "tabState" }, ({ payload }) => {
        console.log("[Clay Scoping] tabState broadcast arrived", {
          operation: payload?.operation,
          hasRecord: !!payload?.record,
          hasOldRecord: !!payload?.old_record,
        });

        const operation = payload?.operation;
        let row;
        if (operation === "DELETE") {
          row = payload?.old_record;
          if (row) row = { ...row, __deleted: true };
        } else {
          row = payload?.record ?? payload?.new_record;
        }
        if (!row) {
          console.log("[Clay Scoping] tabState skipped: no row");
          return;
        }
        // jsonb may arrive as a string in some Supabase versions; normalize
        // so downstream handlers always see an object.
        if (typeof row.state === "string") {
          try {
            row = { ...row, state: JSON.parse(row.state) };
          } catch {
            console.log("[Clay Scoping] tabState skipped: state JSON.parse failed");
            return;
          }
        }
        if (row.updated_by && row.updated_by === __cb.userId) {
          console.log("[Clay Scoping] tabState skipped: own echo", { userId: __cb.userId });
          return;
        }

        const dedupeKey = `${row.workbook_id}:${row.tab_id}`;
        // Skip duplicates only for non-DELETE events. A DELETE always wins.
        if (!row.__deleted) {
          const lastSeen = lastAppliedTabKey.get(dedupeKey);
          if (lastSeen && lastSeen === row.updated_at) {
            console.log("[Clay Scoping] tabState skipped: dedupe", { dedupeKey, lastSeen });
            return;
          }
          lastAppliedTabKey.set(dedupeKey, row.updated_at);
        } else {
          lastAppliedTabKey.delete(dedupeKey);
        }

        console.log("[Clay Scoping] tabState dispatching", {
          operation,
          workbookId: row.workbook_id,
          tabId: row.tab_id,
          updatedBy: row.updated_by,
          updatedAt: row.updated_at,
          deleted: !!row.__deleted,
          stateBytes: row.state ? JSON.stringify(row.state).length : 0,
        });

        for (const handler of tabUpdateHandlers) {
          try { handler(row); } catch (err) { console.error(err); }
        }
      })
      // Fallback: fires alongside tabState. If tabState was dropped (oversized
      // payload) we still get this signal and refetch the row over REST. The
      // dedupe in tabState ensures the no-op case doesn't double-apply.
      .on("broadcast", { event: "tabInvalidate" }, ({ payload }) => {
        console.log("[Clay Scoping] tabInvalidate broadcast arrived", {
          workbookId: payload?.workbook_id,
          tabId: payload?.tab_id,
          operation: payload?.operation,
        });

        if (!payload?.workbook_id || !payload?.tab_id) {
          console.log("[Clay Scoping] tabInvalidate skipped: missing ids");
          return;
        }
        if (payload.updated_by && payload.updated_by === __cb.userId) {
          console.log("[Clay Scoping] tabInvalidate skipped: own echo");
          return;
        }

        const dedupeKey = `${payload.workbook_id}:${payload.tab_id}`;
        const lastSeen = lastAppliedTabKey.get(dedupeKey);
        if (lastSeen && lastSeen === payload.updated_at) {
          console.log("[Clay Scoping] tabInvalidate skipped: dedupe (tabState already applied)");
          return;
        }

        console.log("[Clay Scoping] tabInvalidate dispatching refetch (fallback)", {
          workbookId: payload.workbook_id,
          tabId: payload.tab_id,
          updatedBy: payload.updated_by,
          updatedAt: payload.updated_at,
        });

        refetchTab(payload.workbook_id, payload.tab_id);
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
          // Verbose-only: shows up under "Verbose" filter in DevTools so it
          // doesn't pollute the default console output. Lets future-us
          // confirm whether the event is reaching the client at all.
          console.debug("[Clay Scoping] postgres_changes received", {
            workbookId: payload?.new?.workbook_id,
            updatedBy: payload?.new?.updated_by,
            hasState: !!payload?.new?.state,
          });
          if (!payload?.new) return;
          for (const handler of canvasUpdateHandlers) {
            try { handler(payload.new); } catch (err) { console.error(err); }
          }
        },
      )
      .subscribe(async (status) => {
        // Only SUBSCRIBED means the WebSocket is ready to carry broadcasts.
        // Any other status (TIMED_OUT, CHANNEL_ERROR, CLOSED) means we should
        // hold off on sends until Supabase reconnects us. Loud-log every
        // transition so it's obvious when the channel is/isn't healthy.
        console.log("[Clay Scoping] realtime channel status:", status, "workbook:", workbookId);
        channelReady = (status === "SUBSCRIBED");

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

    if (!channel) {
      channelReady = false;
      currentWorkbookId = null;
      return;
    }
    try {
      await channel.untrack();
      await channel.unsubscribe();
    } catch {
      // Ignore teardown errors; the channel is going away anyway.
    }
    channel = null;
    channelReady = false;
    currentWorkbookId = null;
  };

  // Cursor broadcast: coalesce to CURSOR_THROTTLE_MS, always send the final
  // position via a trailing timer so other users see our cursor come to rest.
  __cb.realtime.broadcastCursor = function (x, y) {
    // Channel must exist AND be SUBSCRIBED; skip throttle bookkeeping for
    // messages we'd drop anyway.
    if (!channel || !channelReady) return;

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
    if (!channel || !channelReady || !pendingCursor) return;
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

  // Subscribe to per-tab updates. Handler receives the canvas_tabs row
  // ({ workbook_id, tab_id, name, hidden, sort_order, state, updated_at,
  // updated_by }) regardless of whether it arrived via tabState (direct
  // broadcast) or tabInvalidate -> refetch (fallback).
  __cb.realtime.onTabUpdate = function (handler) {
    tabUpdateHandlers.add(handler);
    return () => tabUpdateHandlers.delete(handler);
  };

  // --------------------------------------------------------------------------
  // Tier D: card-level live actions (moves + text)
  // --------------------------------------------------------------------------

  /**
   * Broadcasts a card position during a drag. Per-card throttled at 30fps
   * with a trailing send, so the drop-at-rest position always propagates.
   */
  __cb.realtime.broadcastCardMove = function (cardId, x, y) {
    if (!channel || !channelReady || cardId == null) return;
    // `key` is for our throttle Map; `cardId` is kept raw (typically a
    // number) so the payload matches what the receiver's canvas.getCardById
    // compares against with ===. Stringifying here silently broke Tier D.
    const key = String(cardId);
    let s = cardMoveState.get(key);
    if (!s) {
      s = { cardId, lastSentT: 0, lastSentX: null, lastSentY: null, pending: null, timer: null };
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
    if (!channel || !channelReady || !s.pending) return;
    const { x, y } = s.pending;
    s.pending = null;
    s.lastSentT = Date.now();
    s.lastSentX = x;
    s.lastSentY = y;
    channel.send({
      type: "broadcast",
      event: "cardMove",
      // Use the raw cardId (not the stringified Map key) so the receiver's
      // getCardById lookup works: card ids are numeric, and === would fail
      // against a string.
      payload: { userId: __cb.userId, cardId: s.cardId, x, y },
    }).catch(() => {/* non-critical */});
  }

  /**
   * Broadcasts a card's text content. Per-card debounced at 100ms so rapid
   * typing coalesces into one send per quiet moment, rather than one per
   * keystroke.
   */
  __cb.realtime.broadcastCardText = function (cardId, text) {
    if (!channel || !channelReady || cardId == null) return;
    const key = String(cardId);
    let s = cardTextState.get(key);
    if (!s) {
      s = { cardId, pendingText: null, timer: null };
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
    if (!channel || !channelReady || s.pendingText == null) return;
    const text = s.pendingText;
    s.pendingText = null;
    channel.send({
      type: "broadcast",
      event: "cardText",
      // Raw cardId (not stringified Map key) for getCardById === comparison.
      payload: { userId: __cb.userId, cardId: s.cardId, text },
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
