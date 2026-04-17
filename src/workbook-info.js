/**
 * Resolves workbook metadata (just the display name for now) from Clay's
 * workbook endpoint. Results are memoized per `workbookId` for the lifetime
 * of the page so we only hit the API once per workbook.
 *
 * Why the API and not the DOM: the breadcrumb element's class names are
 * Clay's (which we don't control and change frequently), so parsing them
 * is brittle. `GET /v3/{workspaceId}/workbooks/{workbookId}` returns the
 * canonical name and is a lightweight request.
 */
(function () {
  "use strict";

  const __cb = window.__cb;

  // Keyed by workbookId → Promise<string | null>. We only cache successful
  // results so a transient failure (e.g. session cookie not ready yet, aborted
  // fetch during navigation) doesn't permanently poison the cache.
  const cache = new Map();

  async function fetchWorkbookName(workspaceId, workbookId) {
    // Failure here is non-critical: we just won't have a friendly name saved
    // alongside this particular canvas upsert; a later save will try again.
    // So we swallow errors silently — no console output — to avoid polluting
    // the host page's error tracker.
    try {
      const res = await fetch(
        `https://api.clay.com/v3/${workspaceId}/workbooks/${workbookId}`,
        { credentials: "include" },
      );
      if (!res.ok) return null;
      const data = await res.json();
      return data?.name || null;
    } catch {
      return null;
    }
  }

  /**
   * Returns the workbook name, or null if the fetch fails. Safe to call
   * repeatedly. Successful results are cached for the page lifetime;
   * failures are not cached, so a subsequent save can retry.
   */
  __cb.getWorkbookName = async function (workspaceId, workbookId) {
    if (!workspaceId || !workbookId) return null;
    const cached = cache.get(workbookId);
    if (cached) return cached;
    const promise = fetchWorkbookName(workspaceId, workbookId);
    const name = await promise;
    if (name) cache.set(workbookId, Promise.resolve(name));
    return name;
  };
})();
