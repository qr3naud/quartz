/**
 * Shared Supabase client. Loaded by both the content script (via window.__cbSupabase)
 * and the popup (via the popup HTML).
 *
 * Why a shared file: the popup runs in the extension's own context (not the page),
 * while the content script runs in the page's context. They cannot share a
 * JavaScript module/object directly, but both can load this script and pick up
 * the SUPABASE_URL constant + the supabaseFetch helper.
 *
 * Auth: every request carries the Clay-user JWT minted by `src/auth.js`
 * (which calls clay-auth-mint). The `apikey` header is still the project's
 * anon publishable key — Supabase requires it to identify the project, but
 * it grants no real privileges now that RLS is enforced and the `anon`
 * role has been revoked from every table the extension touches.
 *
 * If the JWT isn't ready yet (e.g. on initial page load, before clay-auth-mint
 * has resolved), supabaseFetch awaits __cb.getSupabaseJwt() so callers don't
 * need to coordinate.
 */
(function () {
  "use strict";

  const SUPABASE_URL = "https://hqlrnipieyeyikdyzeqt.supabase.co";

  // The anon publishable key. Public by design — Supabase requires `apikey`
  // on every request just to route it to the right project. The real auth
  // boundary is the JWT in `Authorization`, which RLS reads via auth.jwt().
  const SUPABASE_ANON_KEY =
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhxbHJuaXBpZXlleWlrZHl6ZXF0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzYzNzI4MDksImV4cCI6MjA5MTk0ODgwOX0.3WzSRSe9hZZhOsSWkJMLGAlzpWDVtSLFzDlVcIcwpLk";

  // Retry schedule for transient network errors on write operations. The
  // "TypeError: Failed to fetch" we see in the wild is almost always a
  // short-lived CORS preflight / network flake; retrying a handful of times
  // clears it. We don't retry 4xx/5xx responses because those are
  // application-level errors that a retry won't fix.
  const WRITE_RETRY_DELAYS_MS = [400, 1200, 3600];

  // Popup / extension-page JWT cache. The popup loads this file without the
  // rest of the __cb namespace, so it can't use __cb.getSupabaseJwt(). Instead
  // it asks the service worker to mint a JWT (cb:auth:mint) — the same path
  // src/auth.js uses — and caches it for the (short) life of the popup.
  let popupJwt = null;
  let popupJwtExpiresAt = 0;
  const POPUP_JWT_REFRESH_WINDOW_MS = 5 * 60 * 1000;

  /** Asks the service worker to read the Clay cookie and exchange it for a
   *  per-user, workspace-scoped JWT. Resolves the mint payload or null. */
  function mintViaServiceWorker() {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type: "cb:auth:mint" }, (resp) => {
          if (chrome.runtime.lastError || !resp || resp.ok !== true) {
            resolve(null);
            return;
          }
          resolve(resp.payload || null);
        });
      } catch {
        resolve(null);
      }
    });
  }

  /** Resets the popup JWT cache so the next request re-mints (used on 401). */
  function clearPopupJwt() {
    popupJwt = null;
    popupJwtExpiresAt = 0;
  }

  // Resolves a Bearer token for the Authorization header.
  // - Content-script context: __cb.getSupabaseJwt() fetches/refreshes the JWT.
  // - Popup/extension context: mint via the service worker (cb:auth:mint).
  // Falls back to the anon publishable key only when neither path yields a JWT
  // (the anon role is RLS-revoked, so it simply returns no rows).
  async function resolveBearer() {
    if (typeof window !== "undefined" && window.__cb && typeof window.__cb.getSupabaseJwt === "function") {
      try {
        const jwt = await window.__cb.getSupabaseJwt();
        if (jwt) return jwt;
      } catch (err) {
        console.warn("[Clay Scoping] failed to resolve Supabase JWT, falling back to anon:", err?.message || err);
      }
      return SUPABASE_ANON_KEY;
    }
    if (typeof chrome !== "undefined" && chrome.runtime && typeof chrome.runtime.sendMessage === "function") {
      if (popupJwt && popupJwtExpiresAt - Date.now() > POPUP_JWT_REFRESH_WINDOW_MS) {
        return popupJwt;
      }
      const payload = await mintViaServiceWorker();
      if (payload && payload.jwt) {
        popupJwt = payload.jwt;
        popupJwtExpiresAt = typeof payload.expiresAt === "number" ? payload.expiresAt : 0;
        return popupJwt;
      }
    }
    return SUPABASE_ANON_KEY;
  }

  /**
   * Thin wrapper around Supabase's PostgREST API.
   *
   * @param {string} table - table name (e.g. "canvases")
   * @param {string} method - HTTP method ("GET", "POST", "PATCH", "DELETE")
   * @param {object} options
   * @param {object} [options.query] - PostgREST query params (e.g. { workbook_id: "eq.123", select: "state" })
   * @param {*} [options.body] - JSON body (object or array)
   * @param {string} [options.prefer] - PostgREST Prefer header (e.g. "resolution=merge-duplicates" for upsert)
   * @returns {Promise<any>} parsed JSON response (or null if response is empty)
   */
  async function supabaseFetch(table, method, options = {}) {
    const url = new URL(`${SUPABASE_URL}/rest/v1/${table}`);
    if (options.query) {
      for (const [key, value] of Object.entries(options.query)) {
        url.searchParams.set(key, value);
      }
    }

    const bearer = await resolveBearer();
    const headers = {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${bearer}`,
      "Content-Type": "application/json",
    };
    if (options.prefer) headers.Prefer = options.prefer;

    const isWrite = method !== "GET" && method !== "HEAD";
    const delays = isWrite ? WRITE_RETRY_DELAYS_MS : [];

    let lastErr = null;
    let remintAttempted = false;
    for (let attempt = 0; attempt <= delays.length; attempt++) {
      const started = Date.now();
      try {
        const res = await fetch(url.toString(), {
          method,
          headers,
          body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
        });
        if (!res.ok) {
          // 401 means the JWT is stale or invalid — drop the cached copy so
          // the next call mints a fresh one. We don't retry inline because
          // the caller should decide whether to surface the error.
          if (res.status === 401) {
            if (typeof window !== "undefined" && window.__cb?.clearSupabaseJwt) {
              window.__cb.clearSupabaseJwt();
            }
            clearPopupJwt();
          }
          const text = await res.text().catch(() => "");
          // 42501 = Postgres RLS rejection. Almost always means the cached JWT
          // is scoped to a different Clay identity than the row we're writing —
          // e.g. just after starting/stopping impersonation, or a pre-Phase-4
          // token minted without the `is_internal` claim. Re-mint once and
          // retry with the fresh token before surfacing the error.
          if (
            res.status === 403 &&
            !remintAttempted &&
            text.includes("42501") &&
            typeof window !== "undefined" &&
            window.__cb?.refreshSupabaseJwt
          ) {
            remintAttempted = true;
            try {
              await window.__cb.refreshSupabaseJwt();
            } catch {
              /* refreshSupabaseJwt logs its own failures */
            }
            const freshBearer = await resolveBearer();
            const retryRes = await fetch(url.toString(), {
              method,
              headers: { ...headers, Authorization: `Bearer ${freshBearer}` },
              body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
            });
            if (retryRes.ok) {
              const retryText = await retryRes.text();
              return retryText ? JSON.parse(retryText) : null;
            }
            const retryText = await retryRes.text().catch(() => "");
            throw new Error(
              `Supabase ${method} ${table} failed: ${retryRes.status} ${retryRes.statusText} ${retryText}`,
            );
          }
          throw new Error(`Supabase ${method} ${table} failed: ${res.status} ${res.statusText} ${text}`);
        }
        const text = await res.text();
        return text ? JSON.parse(text) : null;
      } catch (err) {
        lastErr = err;
        // Only TypeError means the fetch itself failed (network/CORS). HTTP
        // errors come through as our own Error above and should surface as-is.
        const isNetworkError = err instanceof TypeError;
        if (!isNetworkError || attempt >= delays.length) {
          // Structured log so production failures leave us a breadcrumb trail
          // (URL, method, attempt number, elapsed, error details).
          console.warn("[Clay Scoping] supabase fetch error", {
            table,
            method,
            attempt,
            elapsedMs: Date.now() - started,
            errorName: err?.name,
            errorMessage: err?.message,
          });
          throw err;
        }
        await new Promise(resolve => setTimeout(resolve, delays[attempt]));
      }
    }
    // Unreachable: the loop either returns on success or throws on final
    // failure. Kept for TypeScript-style exhaustiveness.
    throw lastErr;
  }

  const api = {
    SUPABASE_URL,
    SUPABASE_ANON_KEY,
    supabaseFetch,
    resolveBearer,
  };

  // Expose to whichever context loads us. The content script uses window.__cbSupabase;
  // the popup uses window.cbSupabase (no __cb namespace there).
  if (typeof window !== "undefined") {
    window.__cbSupabase = api;
    window.cbSupabase = api;
  }
})();
