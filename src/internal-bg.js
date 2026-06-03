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
//   5. cb:dust:getConversation     — poll an in-flight POC conversation via
//                                    dust-proxy GET /conversations?id= so the
//                                    client can detect completion and read
//                                    the generated Google Doc link.
//
//   6. cb:dust:probeKey            — proxied to dust-proxy/agents for the
//                                    health-check button in the Dust
//                                    popover (kept for parity with the
//                                    old UI; the popover may stop using
//                                    it now that there's no per-rep key).
//
// All routes use the same JWT bearer auth (no shared `x-cb-proxy-key`
// secret in the bundle anymore). The Phase-1 lockdown means anything we
// proxy is gated by Clay workspace membership at the Edge Function layer.
//
// This is the extension's service worker (MV3 background). It bridges the
// content script to the Supabase Edge Function proxies (SFDC/Dust) and mints
// the per-user JWT — see src/auth.js for the content-script side.

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

  // cb:dust:getConversation — { conversationId }. Read-only poll of an
  // existing Dust conversation so the POC popover can detect when the
  // agent has finished and read the generated doc link.
  if (msg.type === "cb:dust:getConversation") {
    (async () => {
      try {
        const conversationId = msg.conversationId;
        if (!conversationId || typeof conversationId !== "string") {
          sendResponse({ ok: false, error: "missing conversationId" });
          return;
        }
        const res = await callProxy("dust-proxy/conversations", {
          method: "GET",
          query: { id: conversationId },
        });
        const text = await res.text();
        let envelope = null;
        try { envelope = text ? JSON.parse(text) : null; } catch {}
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

  // cb:dealdesk:submit — { account, configs, channel?, manager_emails?,
  // workbookId?, workspaceId? }. Forwards a scoped quote to the deal-desk
  // Slack app via the deal-desk-submit Edge Function. user_email + callback_url
  // are set server-side; the function records pending rows and returns the
  // Slack response (with the message permalink).
  if (msg.type === "cb:dealdesk:submit") {
    (async () => {
      try {
        if (!msg.body || typeof msg.body !== "object") {
          sendResponse({ ok: false, error: "missing submission body" });
          return;
        }
        const res = await callProxy("deal-desk-submit", {
          method: "POST",
          body: msg.body,
        });
        const text = await res.text();
        let envelope = null;
        try { envelope = text ? JSON.parse(text) : null; } catch {}
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

// ---------------------------------------------------------------------------
// Quartz one-click updater
//
// Content scripts can't use chrome.runtime.sendNativeMessage, so both update
// entry points — the popup "Update now" CTA and the overlay "More > Update"
// row — message the service worker, which owns everything: talking to the
// native host (scripts/updater/quartz-updater.py, registered by
// scripts/install-updater.sh), the toolbar "update available" cue (red badge +
// upside-down icon), reloading the extension to pick up the pulled files, and
// reloading open Clay tabs afterwards.
// ---------------------------------------------------------------------------

const QUARTZ_HOST = "com.quartz.updater";
const QUARTZ_ICON_SIZES = [16, 32, 48, 128];

// Toolbar icon as ImageData (per size). MV3 service workers can't decode an
// image from a file path via chrome.action.setIcon({path}) — there's no
// document — so we render the icon (optionally rotated 180deg for the
// "update available" cue) on an OffscreenCanvas and set it as imageData.
// Built lazily and cached.
let _quartzIconData = { normal: null, flipped: null };

async function buildQuartzIconData(flip) {
  const out = {};
  for (const size of QUARTZ_ICON_SIZES) {
    const resp = await fetch(chrome.runtime.getURL(`icons/icon-${size}.png`));
    const blob = await resp.blob();
    const bitmap = await createImageBitmap(blob);
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext("2d");
    if (flip) {
      ctx.translate(bitmap.width, bitmap.height);
      ctx.rotate(Math.PI);
    }
    ctx.drawImage(bitmap, 0, 0);
    out[size] = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
    if (bitmap.close) bitmap.close();
  }
  return out;
}

async function quartzIconData(flip) {
  const key = flip ? "flipped" : "normal";
  if (!_quartzIconData[key]) _quartzIconData[key] = await buildQuartzIconData(flip);
  return _quartzIconData[key];
}

/** Promisified sendNativeMessage. Resolves {ok:false, error:"host-missing"}
 *  when the helper isn't installed (so the UI can show the one-time setup
 *  hint) instead of rejecting. */
function quartzNative(cmd, extra) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendNativeMessage(QUARTZ_HOST, { cmd, ...(extra || {}) }, (res) => {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, error: "host-missing", detail: chrome.runtime.lastError.message });
        } else {
          resolve(res || { ok: false, error: "no-response" });
        }
      });
    } catch (err) {
      resolve({ ok: false, error: "host-missing", detail: String(err) });
    }
  });
}

/** Sets (or clears) the "update available" cue on the toolbar icon: the icon
 *  is flipped upside-down when an update is available, with a descriptive
 *  tooltip. No badge. Each chrome.action call is isolated so a failure in one
 *  (e.g. setIcon) can't suppress the others. */
async function quartzSetCue(behind, latestVersion) {
  try {
    await chrome.action.setTitle({
      title: behind ? `Quartz \u2014 update available (v${latestVersion || "?"})` : "Quartz",
    });
  } catch (err) {
    console.warn("[Quartz] setTitle failed:", err);
  }
  // No badge — clear any that a previous build may have set.
  try {
    await chrome.action.setBadgeText({ text: "" });
  } catch {}
  try {
    const imageData = await quartzIconData(!!behind);
    await chrome.action.setIcon({ imageData });
  } catch (err) {
    console.warn("[Quartz] setIcon failed:", err);
  }
}

/** Writes the status fields of a host result to the cache + toolbar cue, then
 *  returns the result untouched. Shared by the status check and the Update
 *  modal's log fetch — both return behind / currentVersion / latestVersion. */
async function quartzCacheStatus(res) {
  if (res && res.ok) {
    const behind = (res.behind || 0) > 0;
    await chrome.storage.local.set({
      quartzUpdateInfo: {
        behind,
        latestVersion: res.latestVersion,
        currentVersion: res.currentVersion,
        checkedAt: Date.now(),
      },
    });
    await quartzSetCue(behind, res.latestVersion);
  }
  return res;
}

/** Whether the current user is the Quartz maintainer. Cached in storage by the
 *  content script (overlay.js) from the JWT email; the SW reads it to scope
 *  update checks (admin -> origin/main HEAD; everyone else -> published). A
 *  pure-UI gate, defaulting to non-admin when unknown. */
async function isQuartzAdmin() {
  try {
    const r = await chrome.storage.local.get("quartzIsAdmin");
    return !!r.quartzIsAdmin;
  } catch {
    return false;
  }
}

/** Asks the helper whether the repo is behind origin, caches the result for
 *  the popup/overlay, and refreshes the toolbar cue. Non-admins are scoped to
 *  the published version. Callers gate the cadence (the view-open / More-menu
 *  checks skip when already behind). */
async function quartzCheckStatus() {
  const published = !(await isQuartzAdmin());
  return quartzCacheStatus(await quartzNative("status", { published }));
}

/** Runs pull/forcePull. If files changed, reloads the extension so Chrome
 *  loads the new code from disk; the onInstalled handler below then reloads
 *  open Clay tabs. Returns the helper's result (best-effort — the reload may
 *  tear down the message channel before the caller reads it). */
async function quartzRunPull(cmd) {
  const published = !(await isQuartzAdmin());
  let res = await quartzNative(cmd, { published });
  // ~/Quartz is a deploy clone the user never edits by hand, so a fast-forward
  // pull that's blocked by local drift (most often a file-mode change on
  // quartz-updater.py) should be discarded and forced rather than surfacing a
  // "local changes would be overwritten" error. "Update now" then never sticks.
  if (
    cmd === "pull" &&
    res &&
    !res.ok &&
    (res.error === "ff-only" ||
      /local change|overwritten|fast-forward/i.test(res.output || ""))
  ) {
    res = await quartzNative("forcePull", { published });
  }
  if (res && res.ok && res.updated) {
    // Clear the cached "behind" state too, so the SW-startup cache-restore
    // after chrome.runtime.reload() doesn't re-show a stale "update available"
    // cue until the next status check.
    await chrome.storage.local.set({
      quartzPendingReload: true,
      quartzUpdateInfo: {
        behind: false,
        latestVersion: res.toVersion,
        currentVersion: res.toVersion,
        checkedAt: Date.now(),
      },
    });
    await quartzSetCue(false);
    chrome.runtime.reload();
  } else if (res && res.ok) {
    await chrome.storage.local.set({
      quartzUpdateInfo: { behind: false, latestVersion: res.toVersion, checkedAt: Date.now() },
    });
    await quartzSetCue(false);
  }
  return res;
}

/** Installs a specific version by hard-resetting the clone to `ref` (the admin
 *  version picker). Unlike quartzRunPull this may land on an OLDER commit, so we
 *  don't assert behind:false — we just reload; the onInstalled("update") handler
 *  reloads tabs and reruns quartzCheckStatus(), which recomputes the real cue. */
async function quartzRunCheckout(ref) {
  const res = await quartzNative("checkout", { ref });
  if (res && res.ok && res.updated) {
    await chrome.storage.local.set({ quartzPendingReload: true });
    chrome.runtime.reload();
  }
  return res;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || typeof msg.type !== "string") return;
  if (msg.type === "cb:update:status") {
    quartzCheckStatus().then(sendResponse);
    return true;
  }
  if (msg.type === "cb:update:log") {
    // The Update modal is an explicit "check for exact details", so cache the
    // status + refresh the cue from the log result before returning commits.
    (async () => {
      const published = !(await isQuartzAdmin());
      return quartzCacheStatus(await quartzNative("log", { published }));
    })().then(sendResponse);
    return true;
  }
  if (msg.type === "cb:update:pull") {
    quartzRunPull("pull").then(sendResponse);
    return true;
  }
  if (msg.type === "cb:update:forcePull") {
    quartzRunPull("forcePull").then(sendResponse);
    return true;
  }
  if (msg.type === "cb:update:checkout") {
    quartzRunCheckout(msg.ref).then(sendResponse);
    return true;
  }
});

// Restore the cue from the last known status whenever the SW spins up (no
// network) — keeps the icon cue correct across browser/SW restarts until the
// next view-open / popup / modal check refreshes it.
chrome.storage.local
  .get("quartzUpdateInfo")
  .then(({ quartzUpdateInfo }) => {
    if (quartzUpdateInfo) quartzSetCue(!!quartzUpdateInfo.behind, quartzUpdateInfo.latestVersion);
  })
  .catch(() => {});

// One-time check right after a fresh install so the cue is correct before the
// user opens the view. There's no periodic background poll: status is rechecked
// when the extension view / More menu opens (unless already behind), and always
// when the popup or Update modal opens.
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === "install") quartzCheckStatus();
});

// chrome.runtime.reload() on an unpacked extension fires onInstalled with
// reason "update". When we set quartzPendingReload before reloading, reload
// open Clay tabs here so they pick up the freshly pulled content scripts.
chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  if (reason !== "update") return;
  let pending;
  try {
    ({ quartzPendingReload: pending } = await chrome.storage.local.get("quartzPendingReload"));
  } catch {
    return;
  }
  if (!pending) return;
  await chrome.storage.local.remove("quartzPendingReload");
  try {
    const tabs = await chrome.tabs.query({ url: "https://app.clay.com/*" });
    for (const t of tabs) {
      if (t.id != null) chrome.tabs.reload(t.id);
    }
  } catch (err) {
    console.warn("[Quartz] tab reload after update failed:", err);
  }
  // Re-verify against origin now that we just updated, so the cue is
  // authoritatively correct (clears any lingering "update available").
  quartzCheckStatus();
});
