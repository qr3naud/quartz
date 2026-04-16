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
    btn.addEventListener("click", () => {
      if (__cb.overlayEl) {
        __cb.overlayEl.style.display = "flex";
      } else {
        __cb.tabStore = __cb.loadTabs();
        __cb.openCanvas([]);
      }
    });

    wrapper.appendChild(btn);
    return wrapper;
  }

  function tryInjectIntoToolbar() {
    const toolbar = document.querySelector(__cb.TOOLBAR_SELECTOR);
    if (toolbar && !toolbar.hasAttribute(__cb.INJECTED_ATTR)) {
      toolbar.setAttribute(__cb.INJECTED_ATTR, "true");
      toolbar.prepend(buildButton());

      const ids = __cb.parseIdsFromUrl();
      if (ids && localStorage.getItem(`cb-open-${ids.workbookId}`)) {
        __cb.tabStore = __cb.loadTabs();
        __cb.openCanvas([]);
      }

      return true;
    }
    return false;
  }

  function injectFallbackFloat() {
    if (document.querySelector(".cb-float")) return;
    const wrapper = buildButton();
    wrapper.classList.add("cb-float");
    document.body.appendChild(wrapper);
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

  let lastUrl = window.location.href;
  const navObserver = new MutationObserver(() => {
    if (window.location.href !== lastUrl) {
      lastUrl = window.location.href;
      setTimeout(startObserver, 500);
    }
  });
  navObserver.observe(document.body, { childList: true, subtree: true });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", startObserver);
  } else {
    startObserver();
  }
})();
