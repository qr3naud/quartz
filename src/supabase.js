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

  // --- Extension-context liveness + reconnect banner -------------------------
  //
  // When the extension reloads/updates, an already-injected content script is
  // "orphaned": chrome.runtime.id flips to undefined and any chrome.runtime.*
  // call throws "Extension context invalidated". Reading chrome.runtime.id
  // itself never throws, so it's a safe pre-check before any chrome.* call.
  //
  // The normal Quartz update flow reloads every open Clay tab a beat after it
  // reloads the extension (see internal-bg.js onInstalled "update"), so an
  // orphaned page is usually about to be replaced. We therefore wait out a
  // short grace period before showing the "Reload to reconnect" banner — the
  // happy path reloads on its own and never flashes one. Requests still
  // short-circuit immediately regardless (see resolveBearer / supabaseFetch).
  const RECONNECT_BANNER_GRACE_MS = 4000;

  /** True while this script is still attached to a live extension context. */
  function isExtensionContextAlive() {
    try {
      return !!(typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.id);
    } catch {
      return false;
    }
  }

  // We only ever surface one banner; track so repeated detections are no-ops.
  let authBannerShown = false;
  let reconnectBannerTimer = null;

  // The popup runs at chrome-extension://…/popup.html and is short-lived
  // (reopening it re-mints), so it never needs an in-page banner.
  function inPageContext() {
    return (
      typeof document !== "undefined" &&
      typeof location !== "undefined" &&
      location.protocol !== "chrome-extension:"
    );
  }

  // kind: "reload" (orphaned context) | "signin" (no Clay session).
  function showAuthBanner(kind) {
    if (authBannerShown || !inPageContext()) return;
    const mount = () => {
      if (authBannerShown) return;
      if (!document.body || document.getElementById("cb-reconnect-banner")) return;
      authBannerShown = true;

      // Keyframes injected inline: the orphaned tab may still be running the
      // previous build's CSS bundle, so we can't rely on a shipped stylesheet.
      if (!document.getElementById("cb-reconnect-banner-style")) {
        const style = document.createElement("style");
        style.id = "cb-reconnect-banner-style";
        style.textContent =
          "@keyframes cbReconnectIn{from{opacity:0;transform:translate(-50%,-12px)}" +
          "to{opacity:1;transform:translate(-50%,0)}}";
        (document.head || document.documentElement).appendChild(style);
      }

      const isSignin = kind === "signin";
      const banner = document.createElement("div");
      banner.id = "cb-reconnect-banner";
      banner.setAttribute("role", "status");
      Object.assign(banner.style, {
        position: "fixed",
        top: "12px",
        left: "50%",
        transform: "translate(-50%,0)",
        zIndex: "2147483647",
        display: "flex",
        alignItems: "center",
        gap: "10px",
        padding: "8px 14px",
        background: "#111827",
        color: "#ffffff",
        borderRadius: "9999px",
        font: "500 13px/1.2 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif",
        boxShadow: "0 6px 24px rgba(0,0,0,.28)",
        animation: "cbReconnectIn .22s ease-out",
        cursor: isSignin ? "default" : "pointer",
      });

      const label = document.createElement("span");
      label.textContent = isSignin ? "Sign in to Clay to use Quartz" : "Reload to reconnect";
      banner.appendChild(label);

      if (!isSignin) {
        banner.title = "Reload this page to reconnect Quartz";
        banner.addEventListener("click", () => location.reload());
      }

      const dismiss = document.createElement("span");
      dismiss.textContent = "×";
      Object.assign(dismiss.style, {
        cursor: "pointer",
        opacity: "0.7",
        fontSize: "16px",
        lineHeight: "1",
        padding: "0 2px",
      });
      dismiss.addEventListener("click", (e) => {
        e.stopPropagation();
        banner.remove();
      });
      banner.appendChild(dismiss);

      document.body.appendChild(banner);
    };
    if (document.body) mount();
    else document.addEventListener("DOMContentLoaded", mount, { once: true });
  }

  /**
   * Called when we detect the extension context is gone. Idempotent. Schedules
   * the "Reload to reconnect" banner after a grace period so the normal
   * update-driven auto-reload pre-empts it. Callers short-circuit their request
   * immediately regardless.
   */
  function notifyContextInvalidated() {
    if (authBannerShown || reconnectBannerTimer) return;
    reconnectBannerTimer = setTimeout(() => {
      reconnectBannerTimer = null;
      showAuthBanner("reload");
    }, RECONNECT_BANNER_GRACE_MS);
  }

  /** Called when the mint fails because there's no Clay session (not logged in). */
  function showSignInBanner() {
    showAuthBanner("signin");
  }

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

  // Resolves a Bearer token for the Authorization header, or null when none is
  // available. There is deliberately NO anon fallback: the anon role is
  // RLS-revoked on every table the extension touches, so a request carrying the
  // anon key can only 401 with a misleading "permission denied". When we can't
  // get a JWT we return null and the caller skips the request entirely.
  // - Content-script context: __cb.getSupabaseJwt() fetches/refreshes the JWT.
  // - Popup/extension context: mint via the service worker (cb:auth:mint).
  async function resolveBearer() {
    if (typeof window !== "undefined" && window.__cb && typeof window.__cb.getSupabaseJwt === "function") {
      try {
        const jwt = await window.__cb.getSupabaseJwt();
        if (jwt) return jwt;
      } catch (err) {
        // A dead extension context can't mint until the page reloads — route to
        // the (grace-delayed) reconnect banner instead of logging a cascade.
        // Anything else is a transient "not ready yet" we note quietly.
        if (!isExtensionContextAlive()) notifyContextInvalidated();
        else console.info("[Clay Scoping] Supabase JWT not ready yet:", err?.message || err);
      }
      return null;
    }
    if (typeof chrome !== "undefined" && chrome.runtime && typeof chrome.runtime.sendMessage === "function") {
      if (!isExtensionContextAlive()) return null;
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
    return null;
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
    // No JWT and no anon fallback (anon is RLS-revoked on every table). Skip the
    // request rather than fire one that can only 401 — reads degrade to null
    // (callers treat as []), fire-and-forget writes no-op. localStorage stays
    // the local source of truth and re-syncs once auth returns / the page
    // reloads. resolveBearer has already surfaced the banner if the context is
    // dead, so this is silent.
    if (!bearer) return null;
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
            if (!freshBearer) {
              // Context died or the re-mint failed during the retry — don't send
              // a null-bearer request; surface the original RLS error.
              throw new Error(`Supabase ${method} ${table} failed: ${res.status} ${res.statusText} ${text}`);
            }
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
          // Lead with a readable message string (the error viewer otherwise
          // renders the bare object as "[object Object]"); keep the structured
          // detail as a second arg for devtools.
          console.warn(
            `[Clay Scoping] supabase fetch error: ${err?.message || err} (${method} ${table}, attempt ${attempt})`,
            { errorName: err?.name, elapsedMs: Date.now() - started },
          );
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
    isExtensionContextAlive,
    notifyContextInvalidated,
    showSignInBanner,
  };

  // Expose to whichever context loads us. The content script uses window.__cbSupabase;
  // the popup uses window.cbSupabase (no __cb namespace there).
  if (typeof window !== "undefined") {
    window.__cbSupabase = api;
    window.cbSupabase = api;
  }
})();
