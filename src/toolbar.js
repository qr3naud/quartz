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

  function tryInjectIntoToolbar() {
    const toolbar = __cb.findToolbar();
    if (toolbar && !toolbar.hasAttribute(__cb.INJECTED_ATTR)) {
      toolbar.setAttribute(__cb.INJECTED_ATTR, "true");
      toolbar.prepend(buildButton());

      const ids = __cb.parseIdsFromUrl();
      const openFlagSet = ids && localStorage.getItem(`cb-open-${ids.workbookId}`);
      const openFromHash = consumeOpenHash();
      if (ids && (openFlagSet || openFromHash)) {
        // We don't await here because tryInjectIntoToolbar is called from a
        // MutationObserver and shouldn't block. loadTabs caches to localStorage
        // anyway so subsequent loads are instant.
        __cb.loadTabs().then(store => {
          __cb.tabStore = store;
          __cb.openCanvas([]);
        });
      }

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
