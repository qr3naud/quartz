/**
 * Shared Supabase client. Loaded by both the content script (via window.__cbSupabase)
 * and the popup (via the popup HTML).
 *
 * Why a shared file: the popup runs in the extension's own context (not the page),
 * while the content script runs in the page's context. They cannot share a
 * JavaScript module/object directly, but both can load this script and pick up
 * the SUPABASE_URL / SUPABASE_ANON_KEY constants.
 */
(function () {
  "use strict";

  const SUPABASE_URL = "https://hqlrnipieyeyikdyzeqt.supabase.co";
  const SUPABASE_ANON_KEY =
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhxbHJuaXBpZXlleWlrZHl6ZXF0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzYzNzI4MDksImV4cCI6MjA5MTk0ODgwOX0.3WzSRSe9hZZhOsSWkJMLGAlzpWDVtSLFzDlVcIcwpLk";

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
  // Retry schedule for transient network errors on write operations. The
  // "TypeError: Failed to fetch" we see in the wild is almost always a
  // short-lived CORS preflight / network flake; retrying a handful of times
  // clears it. We don't retry 4xx/5xx responses because those are
  // application-level errors that a retry won't fix.
  const WRITE_RETRY_DELAYS_MS = [400, 1200, 3600];

  async function supabaseFetch(table, method, options = {}) {
    const url = new URL(`${SUPABASE_URL}/rest/v1/${table}`);
    if (options.query) {
      for (const [key, value] of Object.entries(options.query)) {
        url.searchParams.set(key, value);
      }
    }

    const headers = {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      "Content-Type": "application/json",
    };
    if (options.prefer) headers.Prefer = options.prefer;

    const isWrite = method !== "GET" && method !== "HEAD";
    const delays = isWrite ? WRITE_RETRY_DELAYS_MS : [];

    let lastErr = null;
    for (let attempt = 0; attempt <= delays.length; attempt++) {
      const started = Date.now();
      try {
        const res = await fetch(url.toString(), {
          method,
          headers,
          body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
        });
        if (!res.ok) {
          const text = await res.text().catch(() => "");
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
  };

  // Expose to whichever context loads us. The content script uses window.__cbSupabase;
  // the popup uses window.cbSupabase (no __cb namespace there).
  if (typeof window !== "undefined") {
    window.__cbSupabase = api;
    window.cbSupabase = api;
  }
})();
