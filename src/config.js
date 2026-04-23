(function () {
  "use strict";

  const AI_PACKAGE_IDS = new Set([
    "67ba01e9-1898-4e7d-afe7-7ebe24819a57",
    "3b5e83c7-be09-4127-b508-44e4f0f220bc",
    "f3d610ac-1b2b-4492-8770-4a46c75e90cb",
    "3504dfb7-1b28-456c-9c99-2efdbd52594c",
  ]);

  const AI_ACTION_KEYS = new Set([
    "use-ai", "claygent", "chat-gpt-schema-mapper",
    "chat-gpt-vision", "claude-ai", "google-gemini",
  ]);

  // Claygent-eligible models mirrored from libs/shared/src/ai/models.ts.
  // Credits use creditCostMetadata.claygent values. Excludes deprecated,
  // feature-flagged, and ClaygentPlayground-only models.
  // Sync with models.ts when models are added or removed.
  const DEFAULT_AI_MODELS = [
    // Clay
    { id: "clay-helium",       name: "Helium",           credits: 1,    provider: "Clay" },
    { id: "clay-neon",         name: "Neon",             credits: 2,    provider: "Clay" },
    { id: "clay-argon",        name: "Argon",            credits: 3,    provider: "Clay" },
    { id: "operator-clay",     name: "Clay Navigator",   credits: 6,    provider: "Clay" },

    // OpenAI (latest → oldest)
    { id: "gpt-5.4",          name: "GPT 5.4",          credits: 15,   provider: "OpenAI" },
    { id: "gpt-5.4-mini",     name: "GPT 5.4 Mini",     credits: 2.5,  provider: "OpenAI" },
    { id: "gpt-5.4-nano",     name: "GPT 5.4 Nano",     credits: 1,    provider: "OpenAI" },
    { id: "gpt-5.1",          name: "GPT 5.1",          credits: 8,    provider: "OpenAI" },
    { id: "gpt-5",            name: "GPT 5",            credits: 4,    provider: "OpenAI" },
    { id: "gpt-5-mini",       name: "GPT 5 Mini",       credits: 1,    provider: "OpenAI" },
    { id: "gpt-5-nano",       name: "GPT 5 Nano",       credits: 0.5,  provider: "OpenAI" },
    { id: "o4-mini",          name: "o4 Mini",           credits: 15,   provider: "OpenAI" },
    { id: "o3",               name: "o3",                credits: 15,   provider: "OpenAI" },
    { id: "gpt-4.1",          name: "GPT 4.1",          credits: 12,   provider: "OpenAI" },
    { id: "gpt-4.1-mini",     name: "GPT 4.1 Mini",     credits: 1,    provider: "OpenAI" },
    { id: "gpt-4.1-nano",     name: "GPT 4.1 Nano",     credits: 0.5,  provider: "OpenAI" },
    { id: "gpt-4o",           name: "GPT 4o",            credits: 3,    provider: "OpenAI" },
    { id: "gpt-4o-mini",      name: "GPT 4o Mini",       credits: 1,    provider: "OpenAI" },

    // Anthropic (latest → oldest)
    { id: "claude-opus-4-6",   name: "Claude 4.6 Opus",   credits: 20,  provider: "Anthropic" },
    { id: "claude-opus-4-5",   name: "Claude 4.5 Opus",   credits: 20,  provider: "Anthropic" },
    { id: "claude-opus-4",     name: "Claude 4 Opus",     credits: 40,  provider: "Anthropic" },
    { id: "claude-sonnet-4-6", name: "Claude 4.6 Sonnet", credits: 15,  provider: "Anthropic" },
    { id: "claude-sonnet-4-5", name: "Claude 4.5 Sonnet", credits: 15,  provider: "Anthropic" },
    { id: "claude-sonnet-4",   name: "Claude 4 Sonnet",   credits: 15,  provider: "Anthropic" },
    { id: "claude-haiku-4-5",  name: "Claude 4.5 Haiku",  credits: 3,   provider: "Anthropic" },

    // Gemini (latest → oldest)
    { id: "gemini-3.1-pro",       name: "Gemini 3.1 Pro",       credits: 10,  provider: "Gemini" },
    { id: "gemini-2.5-pro",       name: "Gemini 2.5 Pro",       credits: 5,   provider: "Gemini" },
    { id: "gemini-2.5-flash",     name: "Gemini 2.5 Flash",     credits: 1,   provider: "Gemini" },
    { id: "gemini-2.5-flash-lite", name: "Gemini 2.5 Flash Lite", credits: 1, provider: "Gemini" },
  ];

  // Scoping frequency options used by the summary-bar picker + per-ER badge.
  // `multiplier` is the annualized number of runs: e.g. "monthly" means the
  // enrichment runs 12 times per year, so 1-year credit cost = credits * 12.
  // Order is coarsest → finest (annually at the top, weekly at the bottom) so
  // the picker reads like a "how often" slider.
  const FREQUENCY_OPTIONS = [
    { id: "annually",    label: "Annually",    multiplier: 1  },
    { id: "bi-annually", label: "Bi-annually", multiplier: 2  },
    { id: "quarterly",   label: "Quarterly",   multiplier: 4  },
    { id: "monthly",     label: "Monthly",     multiplier: 12 },
    { id: "weekly",      label: "Weekly",      multiplier: 52 },
  ];
  const DEFAULT_FREQUENCY_ID = "annually";

  window.__cb = {
    TOOLBAR_SELECTOR:
      "#clay-app > div > main > div > div > div > div > div > " +
      "div.flex.min-h-0.flex-1.flex-col > div > div > div > " +
      "div.relative.flex.size-full.shrink.grow.flex-col.overflow-hidden > " +
      "div.flex.flex-none.flex-row.items-center.justify-between.px-3.py-2 > " +
      "div.flex.flex-row.items-center.gap-x-2",

    INJECTED_ATTR: "data-clay-brainstorm-injected",

    // Base URL for the GTME pricing calculator. The "Export to GTME Calculator"
    // flow opens `${GTME_CALCULATOR_BASE_URL}/import?payload=<base64url>` in a
    // new tab. No fetch happens from the extension, so host_permissions isn't
    // strictly required for the flow itself — window.open is plain navigation.
    // For local calculator dev, swap to: "http://localhost:5173"
    GTME_CALCULATOR_BASE_URL: "https://mono-calculator-production.up.railway.app",
    // GTME_CALCULATOR_BASE_URL: "http://localhost:5173",

    enrichmentLookup: {},
    actionByIdLookup: {},
    livePricingByModel: {},
    waterfallExecByName: {},
    // Built-in Clay waterfall attributes (the WaterfallRow rows in the
    // picker). Indexed by lowercased displayName. See fetchWaterfallExecCosts
    // in api.js for the shape of each entry.
    waterfallByName: {},
    // Workspace-saved waterfall presets (PresetRow rows of type WATERFALL /
    // PARENT_WATERFALL). Indexed by lowercased preset name. See
    // fetchWaterfallPresets in api.js.
    waterfallPresetByName: {},
    waterfallParentPresetById: {},
    overlayEl: null,
    enrichmentClickPos: null,
    linkTargetCardId: null,
    tabStore: null,
    canvas: null,

    // Workbook the currently-mounted overlay is bound to. Captured at open
    // time so saves and the cb-open flag cleanup keep writing to the right
    // storage key even after the user navigates to a different workbook
    // via Clay's breadcrumb (SPA route change — URL changes but the page
    // does not reload).
    currentWorkbookId: null,
    currentWorkspaceId: null,

    // User identity (set during init by ensureUserId in user.js).
    // Used as the `updated_by` and `user_id` columns in Supabase.
    userId: null,

    // Workbook-scoped feature flag. Toggled by the "Pro Mode" topbar button
    // in overlay.js, persisted alongside tabStore. Drives visibility of
    // per-DP-card fill rate badges (CSS attribute selector on overlayEl).
    proMode: false,
    setProMode: null,

    // "projected" (default — catalog credits × records) vs "actual" (real
    // spend pulled from Clay's realtime credit usage warehouse, attached to
    // ER cards via data.stats.spend at import time). Toggled by the
    // Projected/Actual segmented control in the overlay topbar; persisted on
    // tabStore.viewMode. The toggle itself is gated behind Pro Mode in CSS,
    // so non-Pro users never see it.
    viewMode: "projected",
    setViewMode: null,

    onCanvasStateChange: null,
    updateCreditTotal: null,
    updateGroupButtonVisibility: null,
    onEnrichmentToolClick: null,

    parseIdsFromUrl() {
      const parts = window.location.pathname.split("/");
      const wsIdx = parts.indexOf("workspaces");
      const wbIdx = parts.indexOf("workbooks");
      if (wsIdx === -1 || wbIdx === -1) return null;
      return {
        workspaceId: parts[wsIdx + 1],
        workbookId: parts[wbIdx + 1],
      };
    },

    stringToColor(str) {
      const palette = [
        "#6366f1", "#ec4899", "#f59e0b", "#10b981", "#3b82f6",
        "#8b5cf6", "#ef4444", "#14b8a6", "#f97316", "#06b6d4",
      ];
      let hash = 0;
      for (let i = 0; i < str.length; i++) {
        hash = str.charCodeAt(i) + ((hash << 5) - hash);
      }
      return palette[Math.abs(hash) % palette.length];
    },

    isAiAction(actionKey, displayName, packageId) {
      if (packageId && AI_PACKAGE_IDS.has(packageId)) return true;
      if (actionKey && AI_ACTION_KEYS.has(actionKey)) return true;
      const name = (displayName || "").toLowerCase();
      return name.includes("use ai") || name.includes("claygent");
    },

    getModelOptions() {
      const cb = window.__cb;
      return DEFAULT_AI_MODELS.map(m => ({
        ...m,
        credits: cb.livePricingByModel[m.id] ?? m.credits,
      }));
    },

    DEFAULT_AI_MODEL: "clay-argon",

    AI_PROVIDER_ICONS: {
      Clay: "https://clay-base-prod-static.s3.amazonaws.com/icons/svg/claygent.svg",
      OpenAI: "https://clay-base-prod-static.s3.amazonaws.com/icons/svg/chat-gpt.svg",
      Anthropic: "https://clay-base-prod-static.s3.amazonaws.com/icons/svg/anthropic.svg",
      Gemini: "https://clay-base-prod-static.s3.amazonaws.com/icons/svg/google-gemini.svg",
    },

    // ---- Frequency (scoping) ----
    //
    // Frequency lives in two places:
    //   1. A global default on the summary bar (drives every ER that hasn't
    //      been individually customized).
    //   2. A per-ER override, shared across every ER in the same snap-cluster.
    //
    // The summary bar owns the global default; we read it back from the
    // credits module via getCurrentFrequencyId so credits.js doesn't have
    // to poke at DOM elements.
    FREQUENCY_OPTIONS,
    DEFAULT_FREQUENCY_ID,
    currentFrequencyId: DEFAULT_FREQUENCY_ID,
    getCurrentFrequencyId() {
      return window.__cb.currentFrequencyId || DEFAULT_FREQUENCY_ID;
    },
    getFrequencyMultiplier(id) {
      const opt = FREQUENCY_OPTIONS.find((o) => o.id === id);
      return opt ? opt.multiplier : 1;
    },
    getFrequencyLabel(id) {
      const opt = FREQUENCY_OPTIONS.find((o) => o.id === id);
      return opt ? opt.label : "Annually";
    },

    // Shared dropdown used by both the summary-bar frequency card and every
    // ER card's ×N badge. Mirrors the structure of the existing `cb-key-toggle`
    // popover in cards.js: a full-viewport backdrop catches outside clicks,
    // the popover stops propagation so clicks inside don't dismiss it, and
    // positioning is fixed relative to the anchor's bounding rect.
    showFrequencyPicker(anchorEl, currentId, onPick) {
      window.__cb.closeFrequencyPicker();

      const backdrop = document.createElement("div");
      backdrop.style.cssText = "position:fixed;inset:0;z-index:9999998;";
      backdrop.addEventListener("mousedown", (evt) => {
        evt.stopPropagation();
        window.__cb.closeFrequencyPicker();
      });

      const menu = document.createElement("div");
      menu.className = "cb-freq-picker";
      menu.addEventListener("mousedown", (evt) => evt.stopPropagation());

      for (const opt of FREQUENCY_OPTIONS) {
        const item = document.createElement("button");
        item.type = "button";
        item.className = "cb-freq-picker-option" + (opt.id === currentId ? " cb-freq-picker-option-active" : "");
        item.innerHTML =
          `<span class="cb-freq-picker-label">${opt.label}</span>` +
          `<span class="cb-freq-picker-mult">\u00d7${opt.multiplier}</span>`;
        item.addEventListener("click", (evt) => {
          evt.stopPropagation();
          window.__cb.closeFrequencyPicker();
          if (typeof onPick === "function") onPick(opt.id);
        });
        menu.appendChild(item);
      }

      document.body.appendChild(backdrop);
      document.body.appendChild(menu);

      const rect = anchorEl.getBoundingClientRect();
      menu.style.position = "fixed";
      menu.style.top = (rect.bottom + 4) + "px";
      menu.style.left = rect.left + "px";
      menu.style.zIndex = "9999999";

      window.__cb._freqPickerEl = menu;
      window.__cb._freqPickerBackdrop = backdrop;
    },
    closeFrequencyPicker() {
      const cb = window.__cb;
      if (cb._freqPickerEl) { cb._freqPickerEl.remove(); cb._freqPickerEl = null; }
      if (cb._freqPickerBackdrop) { cb._freqPickerBackdrop.remove(); cb._freqPickerBackdrop = null; }
    },

    // ---- Provider chain popover (waterfall cards) ----
    //
    // Pops up below the +N provider badge on a waterfall card. Lists each
    // provider in the chain (icon + name + per-row credit pill) and shows
    // the avg/max cost in a footer. Read-only at this stage; future
    // iterations may add drag-to-reorder.
    //
    // Mirrors the showFrequencyPicker structure: full-viewport invisible
    // backdrop catches outside clicks, the popover stops propagation, and
    // positioning is fixed under the anchor.
    showProviderChain(card, anchorEl) {
      window.__cb.closeProviderChain();

      const data = card?.data;
      if (!data || !Array.isArray(data.providers) || data.providers.length === 0) return;

      const backdrop = document.createElement("div");
      backdrop.style.cssText = "position:fixed;inset:0;z-index:9999998;";
      backdrop.addEventListener("mousedown", (evt) => {
        evt.stopPropagation();
        window.__cb.closeProviderChain();
      });

      const panel = document.createElement("div");
      panel.className = "cb-provider-chain";
      panel.addEventListener("mousedown", (evt) => evt.stopPropagation());

      const header = document.createElement("div");
      header.className = "cb-provider-chain-header";
      const headerTitle = document.createElement("span");
      headerTitle.className = "cb-provider-chain-header-title";
      headerTitle.textContent = "Waterfall providers";
      const headerCount = document.createElement("span");
      headerCount.className = "cb-provider-chain-header-count";
      headerCount.textContent = `${data.providers.length} step${data.providers.length === 1 ? "" : "s"}`;
      header.appendChild(headerTitle);
      header.appendChild(headerCount);
      panel.appendChild(header);

      const list = document.createElement("div");
      list.className = "cb-provider-chain-list";

      for (let i = 0; i < data.providers.length; i++) {
        const p = data.providers[i];
        const row = document.createElement("div");
        row.className = "cb-provider-chain-row";

        const ord = document.createElement("span");
        ord.className = "cb-provider-chain-ord";
        ord.textContent = String(i + 1);
        row.appendChild(ord);

        const icon = document.createElement("span");
        icon.className = "cb-provider-chain-icon";
        if (p.iconUrl) {
          const img = document.createElement("img");
          img.src = p.iconUrl;
          img.alt = "";
          icon.appendChild(img);
        } else if (p.iconSvgHtml) {
          icon.innerHTML = p.iconSvgHtml;
        } else {
          icon.textContent = (p.packageName || p.displayName || "?").charAt(0).toUpperCase();
        }
        row.appendChild(icon);

        const meta = document.createElement("div");
        meta.className = "cb-provider-chain-meta";
        const nm = document.createElement("div");
        nm.className = "cb-provider-chain-name";
        nm.textContent = p.displayName || "Provider";
        meta.appendChild(nm);
        if (p.packageName && p.packageName !== p.displayName) {
          const sub = document.createElement("div");
          sub.className = "cb-provider-chain-sub";
          sub.textContent = p.packageName;
          meta.appendChild(sub);
        }
        row.appendChild(meta);

        const cost = document.createElement("span");
        cost.className = "cb-provider-chain-cost";
        if (p.requiresApiKey && (p.credits == null)) {
          cost.classList.add("cb-provider-chain-cost-key");
          cost.textContent = "API key";
        } else if (p.credits == null) {
          cost.textContent = "—";
        } else {
          cost.textContent = `~${p.credits} / row`;
        }
        row.appendChild(cost);

        list.appendChild(row);
      }
      panel.appendChild(list);

      const footer = document.createElement("div");
      footer.className = "cb-provider-chain-footer";
      const avg = document.createElement("span");
      avg.className = "cb-provider-chain-avg";
      avg.innerHTML = `<span class="cb-provider-chain-foot-label">Average</span><span class="cb-provider-chain-foot-val">~${data.averageCost ?? data.credits ?? 0} / row</span>`;
      const sep = document.createElement("span");
      sep.className = "cb-provider-chain-foot-sep";
      const max = document.createElement("span");
      max.className = "cb-provider-chain-max";
      max.innerHTML = `<span class="cb-provider-chain-foot-label">Max</span><span class="cb-provider-chain-foot-val">~${data.maxCost ?? 0} / row</span>`;
      footer.appendChild(avg);
      footer.appendChild(sep);
      footer.appendChild(max);
      panel.appendChild(footer);

      document.body.appendChild(backdrop);
      document.body.appendChild(panel);

      // Position under the anchor; clamp to viewport so a card near the
      // right edge doesn't push the panel off-screen. Default panel width
      // is set in CSS but we also fall back to the panel's actual measured
      // width for the clamp below.
      const rect = anchorEl.getBoundingClientRect();
      panel.style.position = "fixed";
      panel.style.zIndex = "9999999";
      panel.style.top = (rect.bottom + 6) + "px";
      const panelW = panel.offsetWidth || 280;
      const left = Math.min(rect.left, window.innerWidth - panelW - 12);
      panel.style.left = Math.max(8, left) + "px";

      window.__cb._providerChainEl = panel;
      window.__cb._providerChainBackdrop = backdrop;
    },
    closeProviderChain() {
      const cb = window.__cb;
      if (cb._providerChainEl) { cb._providerChainEl.remove(); cb._providerChainEl = null; }
      if (cb._providerChainBackdrop) { cb._providerChainBackdrop.remove(); cb._providerChainBackdrop = null; }
    },
  };
})();
