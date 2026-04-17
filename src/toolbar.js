(function () {
  "use strict";

  const __cb = window.__cb;

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
    label.textContent = "GTME View";

    btn.appendChild(icon);
    btn.appendChild(label);
    btn.addEventListener("click", async () => {
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
    const toolbar = document.querySelector(__cb.TOOLBAR_SELECTOR);
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

  function injectFallbackFloat() {
    // The floating button is a fallback for when we can't find the native
    // workbook toolbar. Only a workbook URL has a toolbar to target in the
    // first place, so don't show the float on /home, /find-leads, /settings,
    // etc. — there's nothing to fall back to, and the button would be a
    // phantom "open canvas" with no canvas to open.
    if (!__cb.parseIdsFromUrl()) return;
    if (document.querySelector(".cb-float")) return;
    const wrapper = buildButton();
    wrapper.classList.add("cb-float");
    document.body.appendChild(wrapper);
  }

  function removeFloatIfOffWorkbook() {
    if (__cb.parseIdsFromUrl()) return;
    const floater = document.querySelector(".cb-float");
    if (floater) floater.remove();
  }

  function startObserver() {
    if (tryInjectIntoToolbar()) return;

    let attempts = 0;
    const MAX_ATTEMPTS = 60;

    const observer = new MutationObserver(() => {
      if (tryInjectIntoToolbar()) {
        observer.disconnect();
        const floater = document.querySelector(".cb-float");
        if (floater) floater.remove();
      }
    });

    observer.observe(document.body, { childList: true, subtree: true });

    const fallbackTimer = setInterval(() => {
      attempts++;
      if (document.querySelector(`[${__cb.INJECTED_ATTR}]`)) {
        clearInterval(fallbackTimer);
        return;
      }
      if (attempts >= MAX_ATTEMPTS) {
        clearInterval(fallbackTimer);
        observer.disconnect();
        injectFallbackFloat();
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
