// Background service worker — exists solely to proxy Dust API requests around
// CORS. Content scripts inherit app.clay.com's origin and Dust's API doesn't
// emit Access-Control-Allow-Origin for that domain, so a direct fetch from
// the page fails preflight. Service workers, by contrast, run in the
// extension's own context and Chrome bypasses CORS for any host listed in
// `host_permissions` (we whitelist https://dust.tt/*). That makes this file
// a thin postMessage trampoline rather than a real backend.
//
// The whole file is internal-only — stripped for the public build via
// build.config.js (`exclude` + `excludeManifestKeys`).

"use strict";

const DUST_BASE_URL = "https://dust.tt";

// Pasting an API key from any source (1Password, an email, a Notion page)
// can drag along surrounding whitespace, smart quotes from rich-text
// editors, a stray "Bearer " prefix, or invisible Unicode codepoints (BOM,
// zero-width space). String.prototype.trim() handles plain whitespace but
// NOT zero-width chars — those are a real-world cause of "key looks right
// in the input but the server keeps returning 401/403". Strip everything
// we know about.
function sanitizeApiKey(raw) {
  if (typeof raw !== "string") return "";
  return raw
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .trim()
    .replace(/^["'\u2018\u2019\u201C\u201D]+|["'\u2018\u2019\u201C\u201D]+$/g, "")
    .replace(/^Bearer\s+/i, "")
    .trim();
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.type !== "cb:dust:createConversation") return;

  // sendResponse must be invoked asynchronously, so we return `true` to keep
  // the message channel open. Errors are surfaced through the response
  // envelope so the caller never has to look at chrome.runtime.lastError.
  (async () => {
    try {
      const { apiKey, workspaceId, body } = msg;
      if (!apiKey || !workspaceId || !body) {
        sendResponse({ ok: false, error: "Missing apiKey, workspaceId, or body." });
        return;
      }

      const cleanKey = sanitizeApiKey(apiKey);
      const endpoint = `${DUST_BASE_URL}/api/v1/w/${workspaceId}/assistant/conversations`;

      // Fingerprint logging — only the first 4 + last 4 chars plus length,
      // so a rep can confirm in DevTools that the right key is hitting Dust
      // without leaking the full secret. Helpful for diagnosing "I pasted
      // a new key but still get 403" reports.
      const fp =
        cleanKey.length > 10
          ? `${cleanKey.slice(0, 4)}\u2026${cleanKey.slice(-4)}`
          : "(too short)";
      console.log(
        "[Clay Scoping] Dust request",
        endpoint,
        `key=${fp}`,
        `len=${cleanKey.length}`,
      );

      const res = await fetch(endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${cleanKey}`,
          "Content-Type": "application/json",
        },
        // credentials: "omit" prevents Chrome from attaching any dust.tt
        // session cookies the user might have from being logged in to Dust
        // in another tab. A cookie session can resolve auth to a different
        // user than the Bearer token and silently produce a 403.
        credentials: "omit",
        body: JSON.stringify(body),
      });

      const text = await res.text();
      let data = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        // Non-JSON body — pass the raw text through so the content script
        // can surface it in the error message.
      }

      sendResponse({
        ok: res.ok,
        status: res.status,
        statusText: res.statusText,
        data,
        // Always preserve rawText so the content script can surface
        // SOMETHING when the response body isn't JSON (or is the literal
        // `null`).
        rawText: text || undefined,
        endpoint,
      });
    } catch (err) {
      sendResponse({
        ok: false,
        error: err?.message || String(err),
      });
    }
  })();

  return true;
});
