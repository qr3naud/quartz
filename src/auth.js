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

  // v4: bumped from v3 so every client re-mints once. The mint has returned
  // `isInternal` since v3.41, but adoptStored only started reading + storing it
  // in v7.20 — so a cached v3 blob (written under v7.19) has no isInternal
  // field, leaving __cb.isInternal false and hiding the internal-only surfaces
  // (the Request POC bar button + Import Inspector) until it expired (~1h).
  // Bumping forces a fresh mint that stores isInternal.
  // (v3 was the maintainer-gate/is_admin rollout; v2 the Phase-4 is_internal
  // claim rollout.)
  const STORAGE_KEY = "cb-supabase-jwt-v4";
  // Stale JWTs are useless if they're already expired or about to be —
  // refresh proactively when this much time is left on the clock.
  const REFRESH_WINDOW_MS = 5 * 60 * 1000;

  /**
   * @typedef {{ jwt: string, expiresAt: number, userId: string, email: string | null, workspaces: string[], features: string[], isInternal: boolean, isAdmin: boolean }} StoredJwt
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
    // The Clay identity (`sub`) the current JWT is scoped to. Kept distinct
    // from __cb.userId (which user.js overwrites with the acting identity from
    // /v3/me) so ensureUserId can detect when the JWT belongs to a different
    // user and re-mint. null when there's no JWT yet.
    __cb.supabaseJwtUserId = stored?.userId ?? null;
    __cb.userId = stored?.userId ?? __cb.userId ?? null;
    __cb.userEmail = stored?.email ?? __cb.userEmail ?? null;
    __cb.userWorkspaces = stored?.workspaces ?? [];
    __cb.userFeatures = stored?.features ?? [];
    // Internal (Clay team) flag from the signed `is_internal` claim. Gates
    // team-only surfaces (Request POC, Import Inspector). Equivalent to holding
    // any internal feature, but clearer at call sites than a hasFeature check.
    __cb.isInternal = stored?.isInternal === true;
    // Maintainer flag from the signed `is_admin` claim (set by clay-auth-mint
    // from the ADMIN_EMAILS secret). Replaces the old hardcoded email checks —
    // gates the Admin modal, owner-only export rows, canvas view, version picker,
    // and the Old vs New Pricing modal.
    __cb.isAdmin = stored?.isAdmin === true;
    // Reflect the feature set onto document.body as a space-separated
    // attribute so CSS can scope rules with `body[data-cb-features~="dust"]
    // .cb-foo`. document.body may not exist yet at content-script start;
    // guard and retry on DOMContentLoaded if so.
    syncFeaturesToBody(__cb.userFeatures);
  }

  function syncFeaturesToBody(features) {
    const apply = () => {
      if (!document.body) return;
      document.body.dataset.cbFeatures = (features ?? []).join(" ");
    };
    if (document.body) {
      apply();
    } else if (typeof document !== "undefined") {
      document.addEventListener("DOMContentLoaded", apply, { once: true });
    }
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Marker used so callers can distinguish "the extension was reloaded out from
  // under us" (unrecoverable until the page reloads) from a normal mint failure.
  const EXT_CONTEXT_DEAD = "EXTENSION_CONTEXT_INVALIDATED";

  /** True while the extension context is still live (delegates to supabase.js). */
  function contextAlive() {
    try {
      if (window.__cbSupabase?.isExtensionContextAlive) {
        return window.__cbSupabase.isExtensionContextAlive();
      }
      return !!(typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.id);
    } catch {
      return false;
    }
  }

  /** Surface the (grace-delayed) "Reload to reconnect" banner. */
  function notifyContextDead() {
    window.__cbSupabase?.notifyContextInvalidated?.();
  }

  function isContextInvalidatedError(err) {
    return (
      err?.code === EXT_CONTEXT_DEAD ||
      /extension context invalidated|context invalidated/i.test(err?.message || "")
    );
  }

  function isNoSessionError(err) {
    return /no clay session|are you logged into|logged into app\.clay/i.test(err?.message || "");
  }

  function contextDeadError() {
    const e = new Error("extension context invalidated");
    e.code = EXT_CONTEXT_DEAD;
    return e;
  }

  /**
   * Asks the service worker to read the Clay session cookies and exchange
   * them for a JWT at clay-auth-mint. The SW responds with the parsed
   * { jwt, expiresAt, userId, email, workspaces } payload — or { error }.
   *
   * Fails fast with an EXT_CONTEXT_DEAD-coded error if the extension context is
   * already gone, so we don't sit on the 15s timeout (and don't throw the bare
   * "Extension context invalidated" that chrome.runtime.sendMessage would).
   */
  function fetchFreshJwt() {
    return new Promise((resolve, reject) => {
      if (!contextAlive()) {
        reject(contextDeadError());
        return;
      }
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error("clay-auth-mint timed out"));
      }, 15000);
      try {
        chrome.runtime.sendMessage({ type: "cb:auth:mint" }, (resp) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          const lastErr = chrome.runtime?.lastError;
          if (lastErr) {
            const e = new Error(lastErr.message || "runtime error");
            if (/context invalidated/i.test(lastErr.message || "")) e.code = EXT_CONTEXT_DEAD;
            reject(e);
            return;
          }
          if (!resp || resp.ok !== true) {
            reject(new Error(resp?.error || "mint failed"));
            return;
          }
          resolve(resp.payload);
        });
      } catch (err) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        // sendMessage throws synchronously on an orphaned content script.
        if (!contextAlive()) err.code = EXT_CONTEXT_DEAD;
        reject(err);
      }
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
          features: Array.isArray(payload.features) ? payload.features.map(String) : [],
          isInternal: payload.isInternal === true,
          isAdmin: payload.isAdmin === true,
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
        // If the extension was reloaded, this timer can't recover until the
        // page reloads — surface the banner and stop (don't reschedule, don't
        // spam). Anything else is a transient we just note.
        if (isContextInvalidatedError(err)) {
          notifyContextDead();
          return;
        }
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
   * Public: returns the feature flag list embedded in the current JWT.
   * Internal Clay workspace members get the full INTERNAL_FEATURES set
   * (`["sfdc","dust","pricing_comparison","gtme_export","internal_branding"]`);
   * everyone else gets `[]`. Empty array until the first mint resolves.
   *
   * The features claim is purely a UX filter — the Edge Function proxies
   * re-check INTERNAL_WORKSPACES server-side via requireClayAuth, so a
   * user who tampers with __cb.userFeatures still can't reach SFDC/Dust.
   */
  __cb.getFeatures = function getFeatures() {
    return __cb.userFeatures ?? [];
  };

  /**
   * Public: returns true iff `name` is in the current JWT's features
   * claim. Synchronous; safe to call before the JWT is ready (returns
   * false until the first mint). Code that must run after the feature
   * list is populated should await `__cb.supabaseJwtReady` first.
   */
  __cb.hasFeature = function hasFeature(name) {
    return (__cb.userFeatures ?? []).includes(name);
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
   * Public: drops the cached JWT and re-mints from scratch. Use when the
   * caller has reason to believe the cached identity is stale — e.g. the
   * user just switched workspaces, toggled impersonation in Clay, or the
   * SFDC picker is about to open and we want the freshest possible
   * workspace-membership snapshot.
   *
   * Returns the new JWT on success, or null if the mint failed.
   */
  __cb.refreshSupabaseJwt = async function refreshSupabaseJwt() {
    // Drop the in-memory + localStorage cache so a concurrent caller
    // doesn't read the stale token. Doesn't fire notifyJwtChange(null)
    // because we'd immediately fire notifyJwtChange(<new>) right after,
    // and a transient null would cause realtime to re-auth twice.
    __cb.supabaseJwt = null;
    __cb.supabaseJwtExpiresAt = 0;
    writeStored(null);
    if (refreshTimer) {
      clearTimeout(refreshTimer);
      refreshTimer = null;
    }
    try {
      return await refresh();
    } catch (err) {
      // refresh() throws on failure; surface null so callers can branch
      // on "got fresh JWT" vs "couldn't mint, fall back to whatever they had".
      if (isContextInvalidatedError(err)) {
        notifyContextDead();
        return null;
      }
      console.warn("[Clay Scoping] refreshSupabaseJwt failed:", err?.message || err);
      return null;
    }
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
    if (isFresh(cached)) {
      scheduleBackgroundRefresh(cached.expiresAt);
      return cached.jwt;
    }
    // Bounded retry so a slow/flaky first mint still lands without a reload.
    // The launcher stays dimmed and openCanvas awaits this promise, so retrying
    // here keeps the cold-start gating intact instead of opening feature-less.
    // Resolves the JWT on success, or null once we give up.
    const delays = [0, 800, 2500];
    let lastErr = null;
    for (let i = 0; i < delays.length; i++) {
      if (delays[i]) await sleep(delays[i]);
      if (!contextAlive()) {
        notifyContextDead();
        return null;
      }
      try {
        return await refresh();
      } catch (err) {
        lastErr = err;
        // Orphaned context: unrecoverable until reload — banner + stop.
        if (isContextInvalidatedError(err)) {
          notifyContextDead();
          return null;
        }
        // Not logged into Clay: retrying won't help — prompt sign-in + stop.
        if (isNoSessionError(err)) {
          window.__cbSupabase?.showSignInBanner?.();
          return null;
        }
        // Otherwise transient (timeout / network / SW cold start): retry.
      }
    }
    console.warn("[Clay Scoping] initial JWT mint failed after retries:", lastErr?.message || lastErr);
    return null;
  })();
})();
