(function () {
  "use strict";

  const __cb = window.__cb;

  // Toolbar button label is part of the `internal_branding` feature flag —
  // internal GTMEs see "Quartz" (the new product name; the flag name itself
  // stays `internal_branding` until the rename lands in the JWT mint), and
  // non-internal users see "Scoping". hasFeature may return false
  // synchronously on first install (no cached JWT yet); we re-evaluate when
  // the JWT lands via onSupabaseJwtChange below.
  function currentLabel() {
    return __cb.hasFeature && __cb.hasFeature("internal_branding")
      ? "Quartz"
      : "Scoping";
  }

  // ---- "Stamp the time" button --------------------------------------------
  // Icon-only Phosphor Play button next to the Quartz launcher, shown only on
  // /tables/:id pages. A stamp is a per-table timestamp stored in tab state
  // (src/stamps.js); the first stamp anchors the default Actual-spend window.

  const PLAY_SVG =
    '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 256 256" fill="currentColor" aria-hidden="true"><path d="M240,128a15.74,15.74,0,0,1-7.6,13.51L88.32,229.65a16,16,0,0,1-16.2.3A15.86,15.86,0,0,1,64,216.13V39.87a15.86,15.86,0,0,1,8.12-13.82,16,16,0,0,1,16.2.3L232.4,114.49A15.74,15.74,0,0,1,240,128Z"/></svg>';

  function currentTableId() {
    try {
      const parts = window.location.pathname.split("/");
      const tIdx = parts.indexOf("tables");
      return tIdx !== -1 ? parts[tIdx + 1] || null : null;
    } catch {
      return null;
    }
  }

  function fmtStamp(iso) {
    try {
      return new Date(iso).toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      });
    } catch {
      return iso;
    }
  }

  // Every live launcher (toolbar + float) registers a refresh callback so the
  // navObserver / stamp-store subscription can re-sync them on URL or data
  // changes.
  const stampBtnRefreshers = new Set();
  function refreshStampButtons() {
    for (const fn of stampBtnRefreshers) {
      try { fn(); } catch {}
    }
  }
  if (__cb.stamps?.subscribe) __cb.stamps.subscribe(refreshStampButtons);

  let stampPopEl = null;
  function closeStampPop() {
    if (stampPopEl) { stampPopEl.remove(); stampPopEl = null; }
    document.removeEventListener("mousedown", onStampPopOutside, true);
  }
  function onStampPopOutside(e) {
    if (stampPopEl && !stampPopEl.contains(e.target)) closeStampPop();
  }

  function openStampPop(anchorEl, tid) {
    closeStampPop();
    const stamps = __cb.stamps?.get?.(tid) || [];
    const pop = document.createElement("div");
    pop.className = "cb-stamp-pop";
    pop.addEventListener("mousedown", (e) => e.stopPropagation());

    stamps.forEach((iso, i) => {
      const row = document.createElement("div");
      row.className = "cb-stamp-pop-row";
      const label = document.createElement("span");
      label.className = "cb-stamp-pop-label";
      label.textContent = `${i === 0 ? "Stamp" : "Marker"} \u00b7 ${fmtStamp(iso)}`;
      label.title = new Date(iso).toLocaleString();
      const del = document.createElement("button");
      del.type = "button";
      del.className = "cb-stamp-pop-del";
      del.textContent = "\u00d7";
      del.setAttribute("aria-label", "Delete stamp");
      del.addEventListener("click", (e) => {
        e.stopPropagation();
        __cb.stamps?.remove?.(tid, iso);
        closeStampPop();
      });
      row.appendChild(label);
      row.appendChild(del);
      pop.appendChild(row);
    });

    if (stamps.length === 1) {
      const add = document.createElement("button");
      add.type = "button";
      add.className = "cb-stamp-pop-add";
      add.textContent = "Add second stamp";
      add.addEventListener("click", (e) => {
        e.stopPropagation();
        __cb.stamps?.add?.(tid);
        closeStampPop();
      });
      pop.appendChild(add);
    }

    document.body.appendChild(pop);
    stampPopEl = pop;
    __cb.placePopover?.(pop, anchorEl, { align: "right", gap: 6 });
    pop.style.zIndex = "10000000";
    document.addEventListener("mousedown", onStampPopOutside, true);
  }

  function buildStampButton() {
    const btn = document.createElement("button");
    btn.className = "cb-btn cb-btn-stamp";
    btn.type = "button";
    btn.innerHTML = PLAY_SVG;

    // Custom hover tooltip (no native title — matches the extension's other
    // pills; the native one is unreliable inside Clay's toolbar too).
    let tip = null;
    const hideTip = () => { if (tip) { tip.remove(); tip = null; } };
    btn.addEventListener("mouseenter", () => {
      hideTip();
      const tid = currentTableId();
      if (!tid) return;
      const stamps = __cb.stamps?.get?.(tid) || [];
      tip = document.createElement("div");
      tip.className = "cb-stamp-tip";
      tip.textContent = stamps.length
        ? `Stamp: ${fmtStamp(stamps[0])}`
        : "No stamp \u2014 click to stamp now";
      document.body.appendChild(tip);
      const r = btn.getBoundingClientRect();
      const w = tip.offsetWidth;
      let left = r.left + r.width / 2 - w / 2;
      left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
      tip.style.left = `${Math.round(left)}px`;
      tip.style.top = `${Math.round(r.bottom + 6)}px`;
    });
    btn.addEventListener("mouseleave", hideTip);
    btn.addEventListener("mousedown", hideTip);

    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const tid = currentTableId();
      if (!tid) return;
      const stamps = __cb.stamps?.get?.(tid) || [];
      if (!stamps.length) __cb.stamps?.add?.(tid);
      else openStampPop(btn, tid);
    });

    // Self-cleanup only after the button has actually been in the DOM —
    // refresh() first runs before buildButton() mounts the wrapper, and
    // deregistering on that early call would orphan the button forever.
    let wasConnected = false;
    function refresh() {
      if (btn.isConnected) {
        wasConnected = true;
      } else if (wasConnected) {
        stampBtnRefreshers.delete(refresh);
        return;
      }
      const tid = currentTableId();
      btn.style.display = tid ? "" : "none";
      const has = tid && (__cb.stamps?.get?.(tid) || []).length > 0;
      btn.classList.toggle("cb-btn-stamp-active", !!has);
    }
    stampBtnRefreshers.add(refresh);
    refresh();
    // Stamps hydrate async from tab state (Supabase) — re-sync once loaded.
    __cb.stamps?.ensureHydrated?.()?.then?.(refresh);

    return btn;
  }

  function buildButton() {
    const wrapper = document.createElement("div");
    wrapper.className = "cb-btn-wrapper";

    const btn = document.createElement("button");
    btn.className = "cb-btn";
    btn.type = "button";
    const icon = document.createElement("img");
    icon.className = "cb-btn-icon";
    icon.alt = "";
    icon.setAttribute("aria-hidden", "true");
    if (typeof chrome !== "undefined" && chrome.runtime?.getURL) {
      icon.src = chrome.runtime.getURL("icons/key-icon.png");
    }

    const label = document.createElement("span");
    label.textContent = currentLabel();

    // Update the label when the JWT lands or rotates so first-install users
    // (no cached JWT at build time) see "Quartz" once the mint resolves
    // and the `internal_branding` feature lights up, instead of "Scoping"
    // until the next page load.
    if (__cb.onSupabaseJwtChange) {
      __cb.onSupabaseJwtChange(() => {
        const next = currentLabel();
        if (label.textContent !== next) label.textContent = next;
      });
    }

    btn.appendChild(icon);
    btn.appendChild(label);

    // Render the box right away (so it shows the instant Clay's canvas does),
    // but keep it un-clickable until auth is ready — openCanvas needs the JWT,
    // so clicking before `supabaseJwtReady` resolves would otherwise be a dead
    // click. While loading we dim it and ignore clicks; it lights up on its own
    // when the JWT lands.
    let ready = false;
    function setReady(value) {
      ready = value;
      btn.classList.toggle("cb-btn-loading", !value);
      btn.setAttribute("aria-busy", value ? "false" : "true");
    }
    if (__cb.supabaseJwtReady && typeof __cb.supabaseJwtReady.then === "function") {
      setReady(false);
      __cb.supabaseJwtReady.finally(() => setReady(true));
    } else {
      setReady(true);
    }

    btn.addEventListener("click", async () => {
      if (!ready) return;
      if (__cb.overlayEl) {
        __cb.overlayEl.style.display = "flex";
      } else {
        __cb.tabStore = await __cb.loadTabs();
        __cb.openCanvas([]);
      }
    });

    wrapper.appendChild(btn);
    wrapper.appendChild(buildStampButton());
    return wrapper;
  }

  // Triggered by the popup: a "#cb-open" hash on the URL means "open the
  // canvas as soon as you can". We strip the hash so it doesn't linger.
  function consumeOpenHash() {
    if (window.location.hash !== "#cb-open") return false;
    history.replaceState(
      null,
      "",
      window.location.pathname + window.location.search,
    );
    return true;
  }

  // Auto-open the canvas when we arrive on a workbook with the "sticky open"
  // flag set (clicking a Quartz from the home tab sets it, see src/home.js) or
  // the "#cb-open" hash. Decoupled from toolbar discovery so it also fires on
  // the Overview/flow view, which has no native toolbar. openCanvas waits for
  // the JWT itself, so this opens as soon as auth is ready. Guarded against a
  // double-open while the (async) open is still in flight.
  let autoOpenInFlight = false;
  function maybeAutoOpen() {
    if (autoOpenInFlight || __cb.overlayEl) return;
    const ids = __cb.parseIdsFromUrl();
    if (!ids) return;
    const openFlagSet = localStorage.getItem(`cb-open-${ids.workbookId}`);
    // Always consume the hash (side effect: strips it) so it doesn't linger.
    const openFromHash = consumeOpenHash();
    if (!openFlagSet && !openFromHash) return;
    autoOpenInFlight = true;
    __cb.loadTabs()
      .then(store => {
        __cb.tabStore = store;
        return __cb.openCanvas([]);
      })
      .finally(() => {
        autoOpenInFlight = false;
      });
  }

  function tryInjectIntoToolbar() {
    const toolbar = __cb.findToolbar();
    if (toolbar && !toolbar.hasAttribute(__cb.INJECTED_ATTR)) {
      toolbar.setAttribute(__cb.INJECTED_ATTR, "true");
      toolbar.prepend(buildButton());
      return true;
    }
    return false;
  }

  // Anchor the launcher to the top-right CORNER OF THE FLOW CANVAS (the
  // dotted-grid area) rather than the viewport edge — otherwise it sits over
  // Clay's right-hand workbook panel. The canvas is react-flow's container; we
  // fall back to "just below the top nav, viewport right" if it isn't found.
  function positionFloatToCanvas(wrapper) {
    const flow = document.querySelector(".react-flow");
    if (flow) {
      const r = flow.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) {
        wrapper.style.top = Math.round(r.top + 12) + "px";
        wrapper.style.right = Math.round(window.innerWidth - r.right + 12) + "px";
        return;
      }
    }
    // Fallback: clear Clay's top nav (which sits lower when the impersonation
    // banner is shown, common for the GTME/SE users). `right` keeps the CSS
    // default.
    const clayHeader =
      document.querySelector("#clay-app header") ??
      document.querySelector("#clay-app nav") ??
      document.querySelector("#clay-app > div > div:first-child");
    if (clayHeader) {
      const headerBottom = clayHeader.getBoundingClientRect().bottom;
      if (headerBottom > 0) wrapper.style.top = Math.round(headerBottom + 12) + "px";
    }
  }

  function injectFallbackFloat() {
    // The floating launcher is shown when there's no native table toolbar to
    // inject into (e.g. the workbook Overview/flow view). Only a workbook URL
    // has a canvas to open, so skip it on /home, /settings, etc.
    if (!__cb.parseIdsFromUrl()) return;
    if (document.querySelector(".cb-float")) return;
    const wrapper = buildButton();
    wrapper.classList.add("cb-float");
    positionFloatToCanvas(wrapper);
    document.body.appendChild(wrapper);

    // Keep it pinned to the canvas corner as the canvas resizes — a window
    // resize or the right-hand workbook panel toggling both change its width.
    const flow = document.querySelector(".react-flow");
    if (flow && typeof ResizeObserver !== "undefined") {
      const ro = new ResizeObserver(() => {
        const f = document.querySelector(".cb-float");
        if (f) positionFloatToCanvas(f);
        else ro.disconnect();
      });
      ro.observe(flow);
    }
  }

  function removeFloatIfOffWorkbook() {
    if (__cb.parseIdsFromUrl()) return;
    const floater = document.querySelector(".cb-float");
    if (floater) floater.remove();
  }

  function startObserver() {
    // Auto-open the canvas if we arrived with the sticky-open flag set (e.g.
    // by clicking a Quartz from the home tab) — independent of whether this
    // page exposes a native toolbar.
    maybeAutoOpen();

    if (tryInjectIntoToolbar()) return;

    // The flow/overview view never gets a native toolbar, so surface the Quartz
    // box as soon as its canvas exists — no waiting out the toolbar hunt.
    if (document.querySelector(".react-flow")) injectFallbackFloat();

    let attempts = 0;
    const FLOAT_AFTER = 5; // ~2.5s: fallback for toolbar-less pages without a flow canvas
    const MAX_ATTEMPTS = 60; // ~30s: stop hunting for the native toolbar

    const observer = new MutationObserver(() => {
      if (tryInjectIntoToolbar()) {
        observer.disconnect();
        const floater = document.querySelector(".cb-float");
        if (floater) floater.remove();
        return;
      }
      // Show the box the moment the flow canvas mounts (idempotent thereafter).
      if (document.querySelector(".react-flow")) injectFallbackFloat();
    });

    observer.observe(document.body, { childList: true, subtree: true });

    const fallbackTimer = setInterval(() => {
      attempts++;
      if (document.querySelector(`[${__cb.INJECTED_ATTR}]`)) {
        clearInterval(fallbackTimer);
        return;
      }
      // Fallback for any other toolbar-less page that has no flow canvas.
      if (attempts >= FLOAT_AFTER) {
        injectFallbackFloat();
      }
      if (attempts >= MAX_ATTEMPTS) {
        clearInterval(fallbackTimer);
        observer.disconnect();
      }
    }, 500);
  }

  // Reopen the canvas for the workbook the URL now points at. Clay is an
  // SPA so breadcrumb navigation only mutates the URL; without this the
  // overlay keeps showing the previous workbook's tabs and any save would
  // be written against the wrong workbook id.
  async function reloadCanvasForCurrentWorkbook() {
    if (!__cb.overlayEl) return;
    __cb.closeCanvas();
    const ids = __cb.parseIdsFromUrl();
    if (!ids) return;
    __cb.tabStore = await __cb.loadTabs();
    __cb.openCanvas([]);
  }

  let lastUrl = window.location.href;
  const navObserver = new MutationObserver(() => {
    if (window.location.href === lastUrl) return;
    lastUrl = window.location.href;

    // Navigating from a workbook to /home (or anywhere without a workbook
    // id) should clear any float we previously injected; otherwise it
    // lingers on pages where no canvas exists.
    removeFloatIfOffWorkbook();

    // Table switches within a workbook keep the injected toolbar button —
    // re-sync the stamp button's visibility/amber state for the new table.
    closeStampPop();
    refreshStampButtons();

    const newWorkbookId = __cb.parseIdsFromUrl()?.workbookId ?? null;
    if (__cb.overlayEl && newWorkbookId !== __cb.currentWorkbookId) {
      reloadCanvasForCurrentWorkbook();
    }

    setTimeout(startObserver, 500);
  });
  navObserver.observe(document.body, { childList: true, subtree: true });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", startObserver);
  } else {
    startObserver();
  }
})();
