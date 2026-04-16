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

  window.__cb = {
    TOOLBAR_SELECTOR:
      "#clay-app > div > main > div > div > div > div > div > " +
      "div.flex.min-h-0.flex-1.flex-col > div > div > div > " +
      "div.relative.flex.size-full.shrink.grow.flex-col.overflow-hidden > " +
      "div.flex.flex-none.flex-row.items-center.justify-between.px-3.py-2 > " +
      "div.flex.flex-row.items-center.gap-x-2",

    INJECTED_ATTR: "data-clay-brainstorm-injected",

    enrichmentLookup: {},
    actionByIdLookup: {},
    livePricingByModel: {},
    waterfallExecByName: {},
    overlayEl: null,
    enrichmentClickPos: null,
    linkTargetCardId: null,
    tabStore: null,
    canvas: null,

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
  };
})();
