// Background service worker (MV3) — proxies privileged work that content
// scripts can't do themselves:
//
//   1. cb:auth:mint            — read the user's Clay session cookie and
//                                 exchange it at clay-auth-mint for a JWT.
//                                 Content scripts can't read HttpOnly
//                                 cookies; chrome.cookies.getAll requires
//                                 the "cookies" permission, which lives
//                                 only on the extension (not the page).
//
//   2. cb:sfdc:searchOpportunities — forward typed search payloads to the
//                                    sfdc-search-opportunities Edge
//                                    Function with the JWT.
//
//   3. cb:sfdc:getOpportunity      — single-record fetch via the
//                                    sfdc-get-opportunity Edge Function.
//
//   4. cb:dust:createConversation  — forward Dust conversation payloads to
//                                    the dust-proxy Edge Function. The
//                                    API key no longer lives on the
//                                    client; the proxy holds it.
//
//   5. cb:dust:probeKey            — proxied to dust-proxy/agents for the
//                                    health-check button in the Dust
//                                    popover (kept for parity with the
//                                    old UI; the popover may stop using
//                                    it now that there's no per-rep key).
//
// All routes use the same JWT bearer auth (no shared `x-cb-proxy-key`
// secret in the bundle anymore). The Phase-1 lockdown means anything we
// proxy is gated by Clay workspace membership at the Edge Function layer.
//
// This file is internal-only; build.js strips it (and the SFDC/Dust client
// code) from the public spin-off. See build.config.js → exclude.

"use strict";

const SUPABASE_PROJECT_URL = "https://hqlrnipieyeyikdyzeqt.supabase.co";
const FUNCTIONS_BASE = `${SUPABASE_PROJECT_URL}/functions/v1`;
const CLAY_API_URL = "https://api.clay.com";

// In-memory JWT cache. The content script also maintains its own cache
// (src/auth.js → __cb.supabaseJwt), but the SW lives in a separate JS
// context so it has to maintain its own. We mint a fresh JWT lazily on
// the first proxy call after a SW wake-up and refresh ~5min before exp.
let cachedJwt = null;
let cachedJwtExpiresAt = 0;
const JWT_REFRESH_WINDOW_MS = 5 * 60 * 1000;

/**
 * Reads the cookies that would normally be sent on a same-origin fetch to
 * api.clay.com (HttpOnly + Secure session cookies included). Returns the
 * value as a single Cookie-header-formatted string, or null if the user
 * isn't logged in / has no cookies for that origin.
 */
function readClayCookieHeader() {
  return new Promise((resolve) => {
    chrome.cookies.getAll({ url: CLAY_API_URL }, (cookies) => {
      const err = chrome.runtime?.lastError;
      if (err) {
        console.warn("[Clay Scoping] chrome.cookies.getAll failed:", err.message);
        resolve(null);
        return;
      }
      if (!cookies || cookies.length === 0) {
        resolve(null);
        return;
      }
      // Cookie header format: name1=value1; name2=value2; ...
      const header = cookies
        .map((c) => `${c.name}=${c.value}`)
        .join("; ");
      resolve(header);
    });
  });
}

/** Posts the Clay cookie to clay-auth-mint and returns the minted JWT payload. */
async function mintJwt() {
  const cookieHeader = await readClayCookieHeader();
  if (!cookieHeader) {
    return { ok: false, error: "no Clay session cookies (are you logged into app.clay.com?)" };
  }
  let res;
  try {
    res = await fetch(`${FUNCTIONS_BASE}/clay-auth-mint`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // Custom header so Supabase's edge layer doesn't interpret it as
        // a regular Cookie. clay-auth-mint forwards it back to api.clay.com
        // as `Cookie:` server-side.
        "x-clay-cookie": cookieHeader,
      },
      credentials: "omit",
    });
  } catch (err) {
    return { ok: false, error: `network error: ${err?.message || String(err)}` };
  }
  const text = await res.text();
  if (!res.ok) {
    return { ok: false, status: res.status, error: text || `mint HTTP ${res.status}` };
  }
  let payload;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    return { ok: false, error: "mint returned non-JSON" };
  }
  if (!payload?.jwt || typeof payload.expiresAt !== "number") {
    return { ok: false, error: "mint returned malformed payload" };
  }
  cachedJwt = payload.jwt;
  cachedJwtExpiresAt = payload.expiresAt;
  return { ok: true, payload };
}

/** Returns a fresh JWT, refreshing if the cached one is missing or near expiry. */
async function ensureJwt() {
  if (cachedJwt && cachedJwtExpiresAt - Date.now() > JWT_REFRESH_WINDOW_MS) {
    return cachedJwt;
  }
  const mint = await mintJwt();
  if (!mint.ok) throw new Error(mint.error || "JWT mint failed");
  return cachedJwt;
}

/**
 * Generic Edge Function caller with JWT injection and 401-aware retry.
 * On 401 we drop the cached JWT and try once more — the cached token may
 * have been minted before a server-side secret rotation.
 */
async function callProxy(path, { method = "POST", body, query } = {}) {
  let url = `${FUNCTIONS_BASE}/${path}`;
  if (query) {
    const qs = new URLSearchParams(query).toString();
    if (qs) url += `?${qs}`;
  }
  const doFetch = async () => {
    const jwt = await ensureJwt();
    return fetch(url, {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${jwt}`,
      },
      credentials: "omit",
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  };
  let res = await doFetch();
  if (res.status === 401) {
    cachedJwt = null;
    cachedJwtExpiresAt = 0;
    res = await doFetch();
  }
  return res;
}

// --- message dispatch ------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || typeof msg.type !== "string") return;

  // cb:auth:mint — content script asks the SW to read the cookie + mint a JWT.
  if (msg.type === "cb:auth:mint") {
    (async () => {
      try {
        // Force a refresh — the content script calls us because its own
        // cache is stale or absent, so a hot SW cache isn't useful.
        cachedJwt = null;
        cachedJwtExpiresAt = 0;
        const result = await mintJwt();
        sendResponse(result);
      } catch (err) {
        sendResponse({ ok: false, error: err?.message || String(err) });
      }
    })();
    return true; // keep channel open for async sendResponse
  }

  // cb:sfdc:searchOpportunities — { q }
  if (msg.type === "cb:sfdc:searchOpportunities") {
    (async () => {
      try {
        const res = await callProxy("sfdc-search-opportunities", {
          method: "POST",
          body: { q: msg.q ?? "" },
        });
        const text = await res.text();
        let data = null;
        try { data = text ? JSON.parse(text) : null; } catch {}
        sendResponse({ ok: res.ok, status: res.status, data, rawText: text || undefined });
      } catch (err) {
        sendResponse({ ok: false, error: err?.message || String(err) });
      }
    })();
    return true;
  }

  // cb:sfdc:getOpportunity — { id }
  if (msg.type === "cb:sfdc:getOpportunity") {
    (async () => {
      try {
        const res = await callProxy("sfdc-get-opportunity", {
          method: "GET",
          query: { id: msg.id ?? "" },
        });
        const text = await res.text();
        let data = null;
        try { data = text ? JSON.parse(text) : null; } catch {}
        sendResponse({ ok: res.ok, status: res.status, data, rawText: text || undefined });
      } catch (err) {
        sendResponse({ ok: false, error: err?.message || String(err) });
      }
    })();
    return true;
  }

  // cb:dust:probeKey — health check (no API key payload anymore; SW asks
  // dust-proxy which hits Dust on our behalf).
  if (msg.type === "cb:dust:probeKey") {
    (async () => {
      try {
        const res = await callProxy("dust-proxy/agents", { method: "GET" });
        const text = await res.text();
        let data = null;
        try { data = text ? JSON.parse(text) : null; } catch {}
        sendResponse({ ok: res.ok, status: res.status, statusText: res.statusText, data, rawText: text || undefined });
      } catch (err) {
        sendResponse({ ok: false, error: err?.message || String(err) });
      }
    })();
    return true;
  }

  // cb:dust:createConversation — { body } (apiKey/workspaceId no longer
  // accepted; the proxy holds both server-side).
  if (msg.type === "cb:dust:createConversation") {
    (async () => {
      try {
        if (!msg.body || typeof msg.body !== "object") {
          sendResponse({ ok: false, error: "missing conversation body" });
          return;
        }
        const res = await callProxy("dust-proxy/conversations", {
          method: "POST",
          body: { body: msg.body },
        });
        const text = await res.text();
        let envelope = null;
        try { envelope = text ? JSON.parse(text) : null; } catch {}
        // The proxy wraps Dust's response in { ok, status, statusText, data, rawText }.
        // Pass it through so the caller sees the same shape it always has.
        if (envelope && typeof envelope === "object" && "ok" in envelope) {
          sendResponse(envelope);
        } else {
          sendResponse({ ok: res.ok, status: res.status, data: envelope, rawText: text || undefined });
        }
      } catch (err) {
        sendResponse({ ok: false, error: err?.message || String(err) });
      }
    })();
    return true;
  }
});
