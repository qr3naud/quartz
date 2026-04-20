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
    //   Local dev: "http://localhost:5173" (default Vite port)
    //   Production: the deployed Railway URL once provisioned
    GTME_CALCULATOR_BASE_URL: "http://localhost:5173",

    enrichmentLookup: {},
    actionByIdLookup: {},
    livePricingByModel: {},
    waterfallExecByName: {},
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
  };
})();
