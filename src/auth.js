/**
 * Per-Clay-user Supabase JWT client.
 *
 * Every Supabase request from the extension is authenticated by a short-lived
 * JWT minted by the `clay-auth-mint` Edge Function. That function reads the
 * caller's Clay session cookie, asks Clay's API who the user is and which
 * workspaces they belong to, and signs a JWT scoped to those workspaces.
 * Supabase RLS policies then gate every row by `workspace_id ∈ jwt.workspaces`.
 *
 * The HttpOnly Clay session cookie is not readable from this content script.
 * We route through the service worker (src/internal-bg.js), which uses
 * `chrome.cookies.getAll({ url: "https://api.clay.com" })` to harvest the
 * cookies that would normally be sent on a fetch with `credentials: "include"`,
 * stitches them into a Cookie header, and posts to clay-auth-mint.
 *
 * Caching strategy:
 *   - In-memory __cb.supabaseJwt for hot reads (synchronous after first mint).
 *   - localStorage for cross-tab + cross-page-load reuse (saves a network
 *     round trip on every navigation, important for SPA route changes).
 *   - Background refresh REFRESH_WINDOW_MS before exp so the JWT is never
 *     served when it's < ~5 minutes from expiring.
 */
(function () {
  "use strict";

  const __cb = window.__cb;

  const STORAGE_KEY = "cb-supabase-jwt-v1";
  // Stale JWTs are useless if they're already expired or about to be —
  // refresh proactively when this much time is left on the clock.
  const REFRESH_WINDOW_MS = 5 * 60 * 1000;

  /**
   * @typedef {{ jwt: string, expiresAt: number, userId: string, email: string | null, workspaces: string[] }} StoredJwt
   */

  let inflightRefresh = null;

  /** Listeners that fire whenever the cached JWT changes (mint, refresh, clear). */
  const jwtChangeListeners = new Set();
  function notifyJwtChange(jwt) {
    for (const fn of jwtChangeListeners) {
      try { fn(jwt); } catch (err) { console.error("[Clay Scoping] JWT listener threw:", err); }
    }
  }

  function readStored() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed.jwt !== "string" || typeof parsed.expiresAt !== "number") {
        return null;
      }
      return parsed;
    } catch {
      return null;
    }
  }

  function writeStored(stored) {
    try {
      if (stored) localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
      else localStorage.removeItem(STORAGE_KEY);
    } catch (err) {
      console.warn("[Clay Scoping] failed to persist Supabase JWT:", err);
    }
  }

  function isFresh(stored) {
    return !!stored && stored.expiresAt - Date.now() > REFRESH_WINDOW_MS;
  }

  function adoptStored(stored) {
    __cb.supabaseJwt = stored?.jwt ?? null;
    __cb.supabaseJwtExpiresAt = stored?.expiresAt ?? 0;
    __cb.userId = stored?.userId ?? __cb.userId ?? null;
    __cb.userEmail = stored?.email ?? __cb.userEmail ?? null;
    __cb.userWorkspaces = stored?.workspaces ?? [];
  }

  /**
   * Asks the service worker to read the Clay session cookies and exchange
   * them for a JWT at clay-auth-mint. The SW responds with the parsed
   * { jwt, expiresAt, userId, email, workspaces } payload — or { error }.
   */
  function fetchFreshJwt() {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error("clay-auth-mint timed out"));
      }, 15000);
      chrome.runtime.sendMessage({ type: "cb:auth:mint" }, (resp) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const lastErr = chrome.runtime?.lastError;
        if (lastErr) {
          reject(new Error(lastErr.message || "runtime error"));
          return;
        }
        if (!resp || resp.ok !== true) {
          reject(new Error(resp?.error || "mint failed"));
          return;
        }
        resolve(resp.payload);
      });
    });
  }

  async function refresh() {
    if (inflightRefresh) return inflightRefresh;
    inflightRefresh = (async () => {
      try {
        const payload = await fetchFreshJwt();
        if (!payload?.jwt || typeof payload.expiresAt !== "number") {
          throw new Error("malformed mint response");
        }
        const stored = {
          jwt: payload.jwt,
          expiresAt: payload.expiresAt,
          userId: String(payload.userId ?? ""),
          email: payload.email ?? null,
          workspaces: Array.isArray(payload.workspaces) ? payload.workspaces.map(String) : [],
        };
        writeStored(stored);
        adoptStored(stored);
        scheduleBackgroundRefresh(stored.expiresAt);
        notifyJwtChange(stored.jwt);
        return stored.jwt;
      } finally {
        inflightRefresh = null;
      }
    })();
    return inflightRefresh;
  }

  let refreshTimer = null;
  function scheduleBackgroundRefresh(expiresAt) {
    if (refreshTimer) {
      clearTimeout(refreshTimer);
      refreshTimer = null;
    }
    const ms = Math.max(1000, expiresAt - Date.now() - REFRESH_WINDOW_MS);
    refreshTimer = setTimeout(() => {
      // Fire and forget — failures here just mean the next getSupabaseJwt()
      // call will refresh inline. We don't want this to crash the page.
      refresh().catch((err) => {
        console.warn("[Clay Scoping] background JWT refresh failed:", err?.message || err);
      });
    }, ms);
  }

  /**
   * Public: returns a valid JWT, refreshing if necessary. Safe to call
   * repeatedly; concurrent callers share the same inflight refresh.
   */
  __cb.getSupabaseJwt = async function getSupabaseJwt() {
    if (isFresh({ jwt: __cb.supabaseJwt, expiresAt: __cb.supabaseJwtExpiresAt })) {
      return __cb.supabaseJwt;
    }
    return refresh();
  };

  /**
   * Public: returns the JWT only if it's already fresh in memory, without
   * triggering a refresh. Used by serializers that need to know whether
   * a request will succeed without waiting on network.
   */
  __cb.peekSupabaseJwt = function peekSupabaseJwt() {
    if (isFresh({ jwt: __cb.supabaseJwt, expiresAt: __cb.supabaseJwtExpiresAt })) {
      return __cb.supabaseJwt;
    }
    return null;
  };

  /**
   * Public: returns the workspace IDs (as strings) that the current JWT
   * is scoped to. Empty array until the first mint resolves.
   */
  __cb.getSupabaseWorkspaces = function getSupabaseWorkspaces() {
    return __cb.userWorkspaces ?? [];
  };

  /**
   * Public: clears the cached JWT. Used after sign-out scenarios or when
   * the page detects a 401 on a Supabase request.
   */
  __cb.clearSupabaseJwt = function clearSupabaseJwt() {
    writeStored(null);
    adoptStored(null);
    if (refreshTimer) {
      clearTimeout(refreshTimer);
      refreshTimer = null;
    }
    notifyJwtChange(null);
  };

  /**
   * Public: subscribe to JWT changes (mint, refresh, clear). The handler
   * is invoked synchronously after the cache is updated. Returns an
   * unsubscribe function. Used by realtime.js to re-auth the WebSocket
   * connection when the JWT rotates.
   */
  __cb.onSupabaseJwtChange = function onSupabaseJwtChange(handler) {
    jwtChangeListeners.add(handler);
    return () => jwtChangeListeners.delete(handler);
  };

  // Initialize. Adopt anything cached so synchronous early reads work,
  // then refresh in the background to (a) catch expired cached JWTs and
  // (b) prime the workspaces list for code that runs immediately.
  const cached = readStored();
  if (cached) adoptStored(cached);

  __cb.supabaseJwtReady = (async () => {
    try {
      if (isFresh(cached)) {
        scheduleBackgroundRefresh(cached.expiresAt);
        return cached.jwt;
      }
      return await refresh();
    } catch (err) {
      console.warn("[Clay Scoping] initial JWT mint failed:", err?.message || err);
      return null;
    }
  })();
})();
