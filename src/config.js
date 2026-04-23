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
    // When set, the next picker run routes its picked enrichments as
    // providers into the named waterfall card (instead of creating new
    // canvas cards). Read + cleared inside picker.js's finishPicker.
    // Toggled by the "+" button inside showProviderChain.
    addToWaterfallCardId: null,
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
    // Pops up below the +N provider badge on a waterfall card. Editable:
    //   - Header "+" appends a blank provider row (in-line typing).
    //   - Each row supports vertical drag-to-reorder and per-cell editing
    //     of name + per-row credit cost.
    //   - Footer slider lets the user pin the card's effective credit
    //     cost (overrides the avg-of-providers default).
    //
    // After every mutation we run __cb.recomputeWaterfallCardData on
    // card.data and __cb.refreshWaterfallCardDom on the canvas card so
    // badge text / +N / cluster credit total all stay in sync. The
    // popover itself re-renders in place (rebuildPanel) so positions
    // and focused inputs settle without flicker.
    showProviderChain(card, anchorEl) {
      window.__cb.closeProviderChain();

      const data = card?.data;
      if (!data || !Array.isArray(data.providers)) return;

      const backdrop = document.createElement("div");
      backdrop.style.cssText = "position:fixed;inset:0;z-index:9999998;";
      backdrop.addEventListener("mousedown", (evt) => {
        evt.stopPropagation();
        window.__cb.closeProviderChain();
      });

      const panel = document.createElement("div");
      panel.className = "cb-provider-chain";
      panel.addEventListener("mousedown", (evt) => evt.stopPropagation());

      // ---- Hidden right-click context menu ----
      //
      // Right-clicking anywhere inside the popover surfaces a tiny menu
      // with one option: "Remove validation" when the validation row is
      // currently shown, "Add validation" when hidden. Lets users force
      // the row on (e.g. for ad-hoc waterfalls without a curated list)
      // or off (e.g. for waterfalls where they don't care about the
      // validation cost).
      let panelCtxMenuEl = null;
      let panelCtxMenuBackdrop = null;

      function closePanelCtxMenu() {
        if (panelCtxMenuEl) { panelCtxMenuEl.remove(); panelCtxMenuEl = null; }
        if (panelCtxMenuBackdrop) { panelCtxMenuBackdrop.remove(); panelCtxMenuBackdrop = null; }
      }

      panel.addEventListener("contextmenu", (evt) => {
        evt.preventDefault();
        evt.stopPropagation();
        closePanelCtxMenu();

        const hasOpts = Array.isArray(data.validationOptions) && data.validationOptions.length > 0;
        const isShown = typeof data.validationVisible === "boolean"
          ? data.validationVisible
          : hasOpts;

        panelCtxMenuBackdrop = document.createElement("div");
        panelCtxMenuBackdrop.style.cssText = "position:fixed;inset:0;z-index:10000003;";
        panelCtxMenuBackdrop.addEventListener("mousedown", (e) => {
          e.stopPropagation();
          closePanelCtxMenu();
        });
        panelCtxMenuBackdrop.addEventListener("contextmenu", (e) => {
          e.preventDefault();
          e.stopPropagation();
          closePanelCtxMenu();
        });

        const menu = document.createElement("div");
        menu.className = "cb-card-context-menu";
        menu.addEventListener("mousedown", (e) => e.stopPropagation());

        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "cb-card-context-menu-btn";
        btn.textContent = isShown ? "Remove validation" : "Add validation";
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          data.validationVisible = !isShown;
          closePanelCtxMenu();
          window.__cb.recomputeWaterfallCardData(data);
          window.__cb.refreshWaterfallCardDom(card);
          rebuildPanel();
        });
        menu.appendChild(btn);

        document.body.appendChild(panelCtxMenuBackdrop);
        document.body.appendChild(menu);
        panelCtxMenuEl = menu;

        menu.style.position = "fixed";
        menu.style.zIndex = "10000004";
        menu.style.left = evt.clientX + "px";
        menu.style.top = evt.clientY + "px";
      });

      const fmt = window.__cb.formatWaterfallCost
        || ((n) => (Number.isFinite(n) ? n.toFixed(1) : "0.0"));

      // ---- Drag-to-reorder state ----
      // Mouse-based (not HTML5 drag) so we can constrain to vertical
      // movement and re-render the popover in place. While dragging,
      // dragState.fromIndex tracks the row currently being dragged;
      // pointermove computes the over-row by hit-testing list children
      // and swaps providers[] when the cursor crosses a midpoint.
      let dragState = null;

      function persist() {
        window.__cb.recomputeWaterfallCardData(data);
        window.__cb.refreshWaterfallCardDom(card);
      }

      function rebuildPanel() {
        panel.innerHTML = "";
        renderInto(panel);
      }

      function renderInto(root) {
        // ---- Header ----
        const header = document.createElement("div");
        header.className = "cb-provider-chain-header";

        const headerTitle = document.createElement("span");
        headerTitle.className = "cb-provider-chain-header-title";
        headerTitle.textContent = "Waterfall providers";
        header.appendChild(headerTitle);

        const headerSpacer = document.createElement("span");
        headerSpacer.className = "cb-provider-chain-header-spacer";
        header.appendChild(headerSpacer);

        const headerCount = document.createElement("span");
        headerCount.className = "cb-provider-chain-header-count";
        headerCount.textContent = `${data.providers.length} step${data.providers.length === 1 ? "" : "s"}`;
        header.appendChild(headerCount);

        const addBtn = document.createElement("button");
        addBtn.type = "button";
        addBtn.className = "cb-provider-chain-add";
        addBtn.title = "Add provider from the enrichment picker";
        addBtn.innerHTML =
          '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>';
        addBtn.addEventListener("click", (evt) => {
          evt.stopPropagation();
          // Hand off to the standard ER picker flow. picker.js's
          // finishPicker reads `addToWaterfallCardId` and pushes the
          // picked enrichments into our providers[] (recomputing avg/max
          // along the way) instead of creating new canvas cards. Then it
          // re-opens this popover anchored to the same badge.
          window.__cb.addToWaterfallCardId = card.id;
          window.__cb.closeProviderChain();
          if (typeof window.__cb.startPickerMode === "function") {
            window.__cb.startPickerMode();
          }
        });
        header.appendChild(addBtn);

        root.appendChild(header);

        // ---- Provider list ----
        const list = document.createElement("div");
        list.className = "cb-provider-chain-list";

        for (let i = 0; i < data.providers.length; i++) {
          list.appendChild(buildRow(i, list));
        }
        root.appendChild(list);

        // ---- Footer (validation + avg/max + override tile) ----
        const footer = document.createElement("div");
        footer.className = "cb-provider-chain-footer";

        // Validation visibility:
        //   - explicit data.validationVisible wins (user overrode via the
        //     right-click context menu — Add or Remove Validation),
        //   - otherwise default to "show iff the attribute has validators".
        // Ad-hoc / Cmd+Enter waterfalls have no validators, so the row
        // stays hidden until the user explicitly adds one.
        const hasOptions = Array.isArray(data.validationOptions) && data.validationOptions.length > 0;
        const validationShown = typeof data.validationVisible === "boolean"
          ? data.validationVisible
          : hasOptions;
        if (validationShown) {
          footer.appendChild(buildValidationRow());
        }

        const stats = document.createElement("div");
        stats.className = "cb-provider-chain-stats";
        const avg = document.createElement("span");
        avg.className = "cb-provider-chain-avg";
        avg.innerHTML = `<span class="cb-provider-chain-foot-label">Average</span><span class="cb-provider-chain-foot-val">~${fmt(data.averageCost ?? 0)} / row</span>`;
        const max = document.createElement("span");
        max.className = "cb-provider-chain-max";
        max.innerHTML = `<span class="cb-provider-chain-foot-label">Max</span><span class="cb-provider-chain-foot-val">~${fmt(data.maxCost ?? 0)} / row</span>`;
        stats.appendChild(avg);
        stats.appendChild(max);
        footer.appendChild(stats);

        footer.appendChild(buildOverrideRow());
        root.appendChild(footer);
      }

      function buildRow(index, listEl) {
        const p = data.providers[index];
        const row = document.createElement("div");
        row.className = "cb-provider-chain-row";
        row.setAttribute("data-index", String(index));

        // Drag handle — hidden until row hover via CSS so the layout
        // doesn't shift. Doubles as the ord number.
        const handle = document.createElement("span");
        handle.className = "cb-provider-chain-handle";
        handle.title = "Drag to reorder";
        handle.innerHTML =
          '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="14" viewBox="0 0 10 14" fill="currentColor" aria-hidden="true">' +
          '<circle cx="2" cy="3" r="1"/><circle cx="2" cy="7" r="1"/><circle cx="2" cy="11" r="1"/>' +
          '<circle cx="8" cy="3" r="1"/><circle cx="8" cy="7" r="1"/><circle cx="8" cy="11" r="1"/></svg>';
        handle.addEventListener("mousedown", (evt) => onDragStart(evt, row, listEl, index));
        row.appendChild(handle);

        const ord = document.createElement("span");
        ord.className = "cb-provider-chain-ord";
        ord.textContent = String(index + 1);
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
          icon.textContent = (p.packageName || p.displayName || "?").charAt(0).toUpperCase() || "?";
        }
        row.appendChild(icon);

        const meta = document.createElement("div");
        meta.className = "cb-provider-chain-meta";

        // Top line — provider/package name (Apollo, ZeroBounce, …),
        // bigger and bolder. Editable for ad-hoc rows; static for
        // catalog-resolved providers (where the package is canonical).
        const top = document.createElement("span");
        top.className = "cb-provider-chain-package";
        const topText = p.packageName || p.displayName || "";
        if (p.actionKey) {
          top.textContent = topText || "Provider";
        } else {
          top.contentEditable = "true";
          top.spellcheck = false;
          top.textContent = topText;
          if (!topText) top.setAttribute("data-placeholder", "Provider name\u2026");
          top.addEventListener("mousedown", (evt) => evt.stopPropagation());
          top.addEventListener("input", () => {
            const v = top.textContent || "";
            p.packageName = v;
            // Mirror to displayName so the badges row + any external code
            // that reads `displayName` keeps working for ad-hoc rows.
            p.displayName = v;
            if (v) top.removeAttribute("data-placeholder");
            else top.setAttribute("data-placeholder", "Provider name\u2026");
            persist();
          });
          top.addEventListener("keydown", (evt) => {
            if (evt.key === "Enter") {
              evt.preventDefault();
              top.blur();
            }
          });
        }
        meta.appendChild(top);

        // Bottom line — action name (smaller). Only shown for catalog
        // providers where the action and package are distinct (e.g.
        // package "Apollo" + action "Find Email"). Ad-hoc rows skip it.
        if (p.actionKey && p.displayName && p.displayName !== topText) {
          const sub = document.createElement("div");
          sub.className = "cb-provider-chain-action";
          sub.textContent = p.displayName;
          meta.appendChild(sub);
        }
        row.appendChild(meta);

        // Cost cell — credit/key badge styled like the card's own pill.
        // Clicking the badge toggles between credit mode and private-key
        // mode (only meaningful when there's a credit value to fall back
        // from). For ad-hoc rows the credit value is editable inline.
        row.appendChild(buildCreditBadge({
          getCredits: () => p.credits,
          setCredits: (n) => {
            p.credits = n;
            p.creditText = n != null ? `~${n} / row` : null;
          },
          editable: !p.actionKey,
          isKeyMode: () => !!p.usePrivateKey,
          setKeyMode: (v) => { p.usePrivateKey = !!v; },
          onChange: () => {
            persist();
            refreshFooterStats();
          },
        }));

        // Per-row remove button.
        const rm = document.createElement("button");
        rm.type = "button";
        rm.className = "cb-provider-chain-rm";
        rm.title = "Remove";
        rm.innerHTML =
          '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
        rm.addEventListener("mousedown", (evt) => evt.stopPropagation());
        rm.addEventListener("click", (evt) => {
          evt.stopPropagation();
          data.providers.splice(index, 1);
          persist();
          rebuildPanel();
        });
        row.appendChild(rm);

        return row;
      }

      // ---- Credit / key badge factory ----
      //
      // Mirrors the credit pill on regular cards (cb-card-badge-credit /
      // cb-card-badge-key). Two visual states: green credit + value, or
      // blue key + "Private key". The whole badge is clickable to toggle
      // when allowed; for ad-hoc providers the credit value is an inline
      // editable number input.
      //
      // Toggling key mode never destroys the credit value: when flipping
      // back to credit mode the previous credits resurface. Only meaningful
      // when a credit value exists OR the provider was originally
      // requiresApiKey (matches the on-card showKeyToggle behavior).
      const CREDIT_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" fill="currentColor" viewBox="0 0 256 256"><path d="M207.58,63.84C186.85,53.48,159.33,48,128,48S69.15,53.48,48.42,63.84,16,88.78,16,104v48c0,15.22,11.82,29.85,32.42,40.16S96.67,208,128,208s58.85-5.48,79.58-15.84S240,167.22,240,152V104C240,88.78,228.18,74.15,207.58,63.84Z" opacity="0.2"/><path d="M128,64c62.64,0,96,23.23,96,40s-33.36,40-96,40-96-23.23-96-40S65.36,64,128,64Z"/></svg>';
      // Duotone Phosphor key — matches the on-card private-key pill in
      // canvas/cards.js (darker outline #3b82f6, lighter inside #93c5fd).
      // Used in two places: the validation dropdown's right-side keyOnly
      // indicator AND the credit/key badge when in private-key mode.
      const KEY_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 256 256"><path fill="#3b82f6" d="M216.57,39.43A80,80,0,0,0,83.91,120.78L28.69,176A15.86,15.86,0,0,0,24,187.31V216a16,16,0,0,0,16,16H72a8,8,0,0,0,8-8V208H96a8,8,0,0,0,8-8V184h16a8,8,0,0,0,5.66-2.34l9.56-9.57A79.73,79.73,0,0,0,160,176h.1A80,80,0,0,0,216.57,39.43Z"/><path fill="#93c5fd" d="M224,98.1c-1.09,34.09-29.75,61.86-63.89,61.9H160a63.7,63.7,0,0,1-23.65-4.51,8,8,0,0,0-8.84,1.68L116.69,168H96a8,8,0,0,0-8,8v16H72a8,8,0,0,0-8,8v16H40V187.31l58.83-58.82a8,8,0,0,0,1.68-8.84A63.72,63.72,0,0,1,96,95.92c0-34.14,27.81-62.8,61.9-63.89A64,64,0,0,1,224,98.1ZM192,76a12,12,0,1,1-12-12A12,12,0,0,1,192,76Z"/></svg>';

      function buildCreditBadge({ getCredits, setCredits, editable, isKeyMode, setKeyMode, onChange }) {
        const badge = document.createElement("button");
        badge.type = "button";
        badge.className = "cb-provider-chain-credit-badge";
        // Click toggles mode. For ad-hoc rows in credit mode the input
        // catches its own clicks via stopPropagation (so clicking the
        // input focuses it), and only clicks on the badge body fall
        // through to the toggle below.
        badge.addEventListener("mousedown", (evt) => evt.stopPropagation());
        badge.addEventListener("click", (evt) => {
          if (evt.target.tagName === "INPUT") return;
          evt.stopPropagation();
          setKeyMode(!isKeyMode());
          renderMode();
          onChange();
        });

        function renderMode() {
          badge.innerHTML = "";
          if (isKeyMode()) {
            badge.classList.add("cb-provider-chain-credit-badge-key");
            badge.classList.remove("cb-provider-chain-credit-badge-credit");
            const ic = document.createElement("span");
            ic.className = "cb-provider-chain-credit-badge-icon";
            ic.innerHTML = KEY_SVG;
            badge.appendChild(ic);
            const t = document.createElement("span");
            t.className = "cb-provider-chain-credit-badge-text";
            t.textContent = "Private key";
            badge.appendChild(t);
          } else {
            badge.classList.add("cb-provider-chain-credit-badge-credit");
            badge.classList.remove("cb-provider-chain-credit-badge-key");
            const ic = document.createElement("span");
            ic.className = "cb-provider-chain-credit-badge-icon";
            ic.innerHTML = CREDIT_SVG;
            badge.appendChild(ic);
            if (editable) {
              const input = document.createElement("input");
              input.type = "number";
              input.min = "0";
              input.step = "0.5";
              input.className = "cb-provider-chain-credit-badge-input";
              input.value = String(getCredits() ?? 0);
              input.addEventListener("mousedown", (evt) => evt.stopPropagation());
              input.addEventListener("click", (evt) => evt.stopPropagation());
              input.addEventListener("input", () => {
                const n = parseFloat(input.value);
                setCredits(Number.isFinite(n) && n >= 0 ? n : 0);
                onChange();
              });
              input.addEventListener("keydown", (evt) => {
                if (evt.key === "Enter") {
                  evt.preventDefault();
                  input.blur();
                }
              });
              badge.appendChild(input);
              const sfx = document.createElement("span");
              sfx.className = "cb-provider-chain-credit-badge-suffix";
              sfx.textContent = "/ row";
              badge.appendChild(sfx);
            } else {
              const t = document.createElement("span");
              t.className = "cb-provider-chain-credit-badge-text";
              const c = getCredits();
              t.textContent = c != null ? `${c} / row` : "\u2014";
              badge.appendChild(t);
            }
          }
        }

        renderMode();
        return badge;
      }

      function refreshFooterStats() {
        const avgEl = panel.querySelector(".cb-provider-chain-avg .cb-provider-chain-foot-val");
        const maxEl = panel.querySelector(".cb-provider-chain-max .cb-provider-chain-foot-val");
        if (avgEl) avgEl.textContent = `~${fmt(data.averageCost ?? 0)} / row`;
        if (maxEl) maxEl.textContent = `~${fmt(data.maxCost ?? 0)} / row`;
        // Tile follows averageCost until the user pins their own value.
        if (!data.creditsCustom) {
          const input = panel.querySelector(".cb-provider-chain-tile-input");
          if (input && document.activeElement !== input) {
            input.value = fmt(data.averageCost ?? 0);
          }
        }
      }

      // ---- Branded validation picker (replaces native <select>) ----
      //
      // Mirrors the cb-model-picker visual: a trigger button shows the
      // current provider; clicking opens a portaled menu with a
      // backdrop-on-document. Each option lists provider name + per-row
      // credit cost, matching the model picker's name/cost layout. Used
      // here so the validation control reads as a Clay-branded affordance
      // instead of a browser-native dropdown.
      let validationMenuEl = null;
      let validationMenuBackdrop = null;

      function closeValidationMenu() {
        if (validationMenuEl) { validationMenuEl.remove(); validationMenuEl = null; }
        if (validationMenuBackdrop) { validationMenuBackdrop.remove(); validationMenuBackdrop = null; }
      }

      function openValidationMenu(triggerEl) {
        closeValidationMenu();

        // Backdrop sits ABOVE the parent popover backdrop so an outside
        // click dismisses just this menu first, leaving the parent
        // popover open. Z indices: parent popover backdrop 9999998,
        // parent popover 9999999, this backdrop 10000003, this menu 10000004.
        validationMenuBackdrop = document.createElement("div");
        validationMenuBackdrop.style.cssText = "position:fixed;inset:0;z-index:10000003;";
        validationMenuBackdrop.addEventListener("mousedown", (evt) => {
          evt.stopPropagation();
          closeValidationMenu();
        });

        const menu = document.createElement("div");
        menu.className = "cb-validation-menu";
        menu.addEventListener("mousedown", (evt) => evt.stopPropagation());

        const noneBtn = document.createElement("button");
        noneBtn.type = "button";
        noneBtn.className =
          "cb-validation-menu-option" +
          (data.validationProvider == null ? " cb-validation-menu-option-active" : "");
        const noneName = document.createElement("span");
        noneName.className = "cb-validation-menu-option-name";
        noneName.textContent = "No validation";
        noneBtn.appendChild(noneName);
        noneBtn.addEventListener("click", (evt) => {
          evt.stopPropagation();
          data.validationProvider = null;
          data.validationName = null;
          data.validationPrice = 0;
          data.validationRequiresApiKey = false;
          data.validationUsePrivateKey = false;
          window.__cb.recomputeWaterfallCardData(data);
          window.__cb.refreshWaterfallCardDom(card);
          closeValidationMenu();
          rebuildPanel();
        });
        menu.appendChild(noneBtn);

        for (const opt of data.validationOptions) {
          const item = document.createElement("button");
          item.type = "button";
          item.className =
            "cb-validation-menu-option" +
            (data.validationProvider === opt.actionId ? " cb-validation-menu-option-active" : "");

          const nm = document.createElement("span");
          nm.className = "cb-validation-menu-option-name";
          nm.textContent = opt.name || opt.actionName || opt.actionId;
          item.appendChild(nm);

          // Right-side cost cell:
          //   - Key-only providers (Debounce / Lead Magic / Enrow / …):
          //     show a blue key icon in place of the credit number.
          //     Provider name stays on the left, the icon alone signals
          //     "bring your own key, costs 0 Clay credits".
          //   - Everyone else: green per-row credit cost.
          if (opt.keyOnly) {
            const keyIcon = document.createElement("span");
            keyIcon.className = "cb-validation-menu-option-key";
            keyIcon.innerHTML = KEY_SVG;
            item.appendChild(keyIcon);
          } else if (typeof opt.credits === "number") {
            const cost = document.createElement("span");
            cost.className = "cb-validation-menu-option-cost";
            cost.textContent = `${opt.credits} / row`;
            item.appendChild(cost);
          }

          item.addEventListener("click", (evt) => {
            evt.stopPropagation();
            data.validationProvider = opt.actionId;
            data.validationName = opt.name || null;
            data.validationPrice = opt.credits ?? 0;
            data.validationRequiresApiKey = !!opt.requiresApiKey;
            // Auto-flip key mode for key-only validators so the
            // validation cost contributes 0 to averageCost / maxCost
            // (the user can always click the cost badge to flip back
            // if Clay starts offering shared-key support for that
            // provider). Non-key-only options reset the flag.
            data.validationUsePrivateKey = !!opt.keyOnly;
            window.__cb.recomputeWaterfallCardData(data);
            window.__cb.refreshWaterfallCardDom(card);
            closeValidationMenu();
            rebuildPanel();
          });
          menu.appendChild(item);
        }

        document.body.appendChild(validationMenuBackdrop);
        document.body.appendChild(menu);
        validationMenuEl = menu;

        const rect = triggerEl.getBoundingClientRect();
        menu.style.position = "fixed";
        menu.style.zIndex = "10000004";
        menu.style.top = (rect.bottom + 4) + "px";
        const menuW = menu.offsetWidth || 220;
        const left = Math.min(rect.left, window.innerWidth - menuW - 12);
        menu.style.left = Math.max(8, left) + "px";
      }

      // ---- Validation row ----
      //
      // Pre-Average row that surfaces the per-step validation provider.
      // Mounted when:
      //   1. The attribute has validators AND data.validationVisible !== false, OR
      //   2. data.validationVisible === true (user added it via right-click)
      //
      // The trigger button shows the current provider (or "No validation");
      // clicking opens the branded dropdown above. For waterfalls without
      // a curated options list, an editable text input lets the user type
      // a custom validator name.
      function buildValidationRow() {
        const wrap = document.createElement("div");
        wrap.className = "cb-provider-chain-validation";

        const tag = document.createElement("span");
        tag.className = "cb-provider-chain-validation-tag";
        tag.textContent = "Validation";
        wrap.appendChild(tag);

        const hasOptions = Array.isArray(data.validationOptions) && data.validationOptions.length > 0;
        if (hasOptions) {
          const trigger = document.createElement("button");
          trigger.type = "button";
          trigger.className = "cb-provider-chain-validation-trigger";
          trigger.addEventListener("mousedown", (evt) => evt.stopPropagation());
          trigger.addEventListener("click", (evt) => {
            evt.stopPropagation();
            openValidationMenu(trigger);
          });

          const labelEl = document.createElement("span");
          labelEl.className = "cb-provider-chain-validation-trigger-label";
          labelEl.textContent = data.validationName || "No validation";
          trigger.appendChild(labelEl);

          const chev = document.createElement("span");
          chev.className = "cb-provider-chain-validation-trigger-chev";
          chev.innerHTML =
            '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>';
          trigger.appendChild(chev);

          wrap.appendChild(trigger);
        } else {
          // No curated list — fall back to a free-text input so the user
          // can label the validator on ad-hoc waterfalls. Shown only when
          // the user explicitly opted in via the right-click "Add validation"
          // affordance (the row is hidden by default in that case).
          const nameEl = document.createElement("span");
          nameEl.className = "cb-provider-chain-validation-name";
          nameEl.contentEditable = "true";
          nameEl.spellcheck = false;
          nameEl.textContent = data.validationName || "";
          if (!data.validationName) nameEl.setAttribute("data-placeholder", "Provider name\u2026");
          nameEl.addEventListener("mousedown", (evt) => evt.stopPropagation());
          nameEl.addEventListener("input", () => {
            const v = nameEl.textContent || "";
            data.validationName = v || null;
            if (v) nameEl.removeAttribute("data-placeholder");
            else nameEl.setAttribute("data-placeholder", "Provider name\u2026");
            window.__cb.refreshWaterfallCardDom(card);
          });
          nameEl.addEventListener("keydown", (evt) => {
            if (evt.key === "Enter") {
              evt.preventDefault();
              nameEl.blur();
            }
          });
          wrap.appendChild(nameEl);
        }

        wrap.appendChild(buildCreditBadge({
          getCredits: () => data.validationPrice ?? 0,
          setCredits: (n) => { data.validationPrice = n; },
          editable: true,
          isKeyMode: () => !!data.validationUsePrivateKey,
          setKeyMode: (v) => { data.validationUsePrivateKey = !!v; },
          onChange: () => {
            window.__cb.recomputeWaterfallCardData(data);
            window.__cb.refreshWaterfallCardDom(card);
            refreshFooterStats();
          },
        }));

        return wrap;
      }

      function buildOverrideRow() {
        const wrap = document.createElement("div");
        wrap.className = "cb-provider-chain-override";

        const label = document.createElement("div");
        label.className = "cb-provider-chain-override-label";

        const labelText = document.createElement("span");
        labelText.className = "cb-provider-chain-override-label-text";
        labelText.textContent = "Card credit override";
        label.appendChild(labelText);

        const resetBtn = document.createElement("button");
        resetBtn.type = "button";
        resetBtn.className = "cb-provider-chain-reset";
        if (data.creditsCustom) resetBtn.classList.add("cb-provider-chain-reset-visible");
        resetBtn.title = "Reset to provider average";
        resetBtn.textContent = "Reset";
        resetBtn.addEventListener("mousedown", (evt) => evt.stopPropagation());
        resetBtn.addEventListener("click", (evt) => {
          evt.stopPropagation();
          data.creditsCustom = false;
          // recompute restores credits/creditText to averageCost when
          // creditsCustom is false.
          window.__cb.recomputeWaterfallCardData(data);
          window.__cb.refreshWaterfallCardDom(card);
          input.value = fmt(data.credits ?? 0);
          resetBtn.classList.remove("cb-provider-chain-reset-visible");
        });
        label.appendChild(resetBtn);

        wrap.appendChild(label);

        // Editable rectangle tile: the credit number is the focal point;
        // clicking it focuses the input and the user can either type a new
        // value or hold ↑/↓ to step. Step buttons sit on the right for
        // mouse-only adjustment. The tile commits live (input event) so
        // the card pill and totals update as the user adjusts.
        const tile = document.createElement("div");
        tile.className = "cb-provider-chain-tile";
        tile.addEventListener("mousedown", (evt) => {
          // Clicking anywhere on the tile (not just the input) focuses
          // the number — the whole rectangle is the affordance.
          if (evt.target === tile) {
            evt.preventDefault();
            input.focus();
            input.select();
          }
        });

        const input = document.createElement("input");
        input.type = "number";
        input.className = "cb-provider-chain-tile-input";
        input.min = "0";
        input.step = "0.5";
        input.value = fmt(data.credits ?? data.averageCost ?? 0);
        input.addEventListener("mousedown", (evt) => evt.stopPropagation());
        input.addEventListener("focus", () => {
          input.select();
        });
        input.addEventListener("input", () => {
          const n = parseFloat(input.value);
          if (!Number.isFinite(n) || n < 0) return;
          data.credits = n;
          data.creditText = `~${fmt(n)} / row`;
          data.creditsCustom = true;
          window.__cb.refreshWaterfallCardDom(card);
          resetBtn.classList.add("cb-provider-chain-reset-visible");
        });
        input.addEventListener("blur", () => {
          // Re-format the value on blur so "12" → "12.0" stays consistent
          // with the rest of the popover. Skipping if the user blanked
          // the field (treat as no override removal — they can hit Reset).
          if (input.value !== "") input.value = fmt(parseFloat(input.value));
        });
        input.addEventListener("keydown", (evt) => {
          if (evt.key === "Enter") {
            evt.preventDefault();
            input.blur();
          }
        });
        tile.appendChild(input);

        const suffix = document.createElement("span");
        suffix.className = "cb-provider-chain-tile-suffix";
        suffix.textContent = "/ row";
        tile.appendChild(suffix);

        const stepper = document.createElement("div");
        stepper.className = "cb-provider-chain-tile-stepper";

        const upBtn = document.createElement("button");
        upBtn.type = "button";
        upBtn.className = "cb-provider-chain-tile-step";
        upBtn.title = "Increase";
        upBtn.innerHTML =
          '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 15 12 9 18 15"/></svg>';
        upBtn.addEventListener("mousedown", (evt) => evt.stopPropagation());
        upBtn.addEventListener("click", (evt) => {
          evt.stopPropagation();
          const cur = parseFloat(input.value) || 0;
          input.value = fmt(cur + 0.5);
          input.dispatchEvent(new Event("input"));
        });

        const downBtn = document.createElement("button");
        downBtn.type = "button";
        downBtn.className = "cb-provider-chain-tile-step";
        downBtn.title = "Decrease";
        downBtn.innerHTML =
          '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>';
        downBtn.addEventListener("mousedown", (evt) => evt.stopPropagation());
        downBtn.addEventListener("click", (evt) => {
          evt.stopPropagation();
          const cur = parseFloat(input.value) || 0;
          input.value = fmt(Math.max(0, cur - 0.5));
          input.dispatchEvent(new Event("input"));
        });

        stepper.appendChild(upBtn);
        stepper.appendChild(downBtn);
        tile.appendChild(stepper);

        wrap.appendChild(tile);
        return wrap;
      }

      // ---- Drag handlers ----

      function onDragStart(evt, rowEl, listEl, fromIndex) {
        evt.preventDefault();
        evt.stopPropagation();
        const rowRect = rowEl.getBoundingClientRect();
        dragState = {
          fromIndex,
          startY: evt.clientY,
          rowEl,
          listEl,
          rowH: rowRect.height,
          // Snapshot every row's center-y so swap detection doesn't have
          // to query the DOM on every mousemove.
          centers: Array.from(listEl.children).map((c) => {
            const r = c.getBoundingClientRect();
            return r.top + r.height / 2;
          }),
        };
        rowEl.classList.add("cb-provider-chain-row-dragging");
        document.addEventListener("mousemove", onDragMove);
        document.addEventListener("mouseup", onDragEnd);
      }

      function onDragMove(evt) {
        if (!dragState) return;
        const dy = evt.clientY - dragState.startY;
        dragState.rowEl.style.transform = `translateY(${dy}px)`;

        // Find the index whose center is closest to the cursor's current y.
        let target = dragState.fromIndex;
        let best = Infinity;
        for (let i = 0; i < dragState.centers.length; i++) {
          const dist = Math.abs(evt.clientY - dragState.centers[i]);
          if (dist < best) {
            best = dist;
            target = i;
          }
        }

        if (target !== dragState.fromIndex) {
          // Mutate providers[] then rebuild the row order — re-rendering
          // is cheap (a few DOM nodes) and avoids the bookkeeping of
          // tracking transforms across multiple rows during drag.
          const moved = data.providers.splice(dragState.fromIndex, 1)[0];
          data.providers.splice(target, 0, moved);
          dragState.fromIndex = target;
          dragState.rowEl.style.transform = "";
          // Rebuild the list section in place so the remaining drag
          // mousemoves continue working against the new layout.
          rebuildPanel();
          // Re-acquire the dragged row in the freshly-rendered list.
          const newList = panel.querySelector(".cb-provider-chain-list");
          const newRow = newList?.children[target];
          if (newRow) {
            newRow.classList.add("cb-provider-chain-row-dragging");
            const newRect = newRow.getBoundingClientRect();
            dragState.rowEl = newRow;
            dragState.listEl = newList;
            dragState.startY = evt.clientY;
            dragState.centers = Array.from(newList.children).map((c) => {
              const r = c.getBoundingClientRect();
              return r.top + r.height / 2;
            });
          }
        }
      }

      function onDragEnd() {
        if (!dragState) return;
        dragState.rowEl?.classList.remove("cb-provider-chain-row-dragging");
        if (dragState.rowEl) dragState.rowEl.style.transform = "";
        document.removeEventListener("mousemove", onDragMove);
        document.removeEventListener("mouseup", onDragEnd);
        dragState = null;
        // Final persist (the in-flight swaps already called persist via
        // rebuildPanel's children, but the data was mutated directly).
        persist();
      }

      renderInto(panel);

      document.body.appendChild(backdrop);
      document.body.appendChild(panel);

      // Position under the anchor; clamp to viewport so a card near the
      // right edge doesn't push the panel off-screen.
      const rect = anchorEl.getBoundingClientRect();
      panel.style.position = "fixed";
      panel.style.zIndex = "9999999";
      panel.style.top = (rect.bottom + 6) + "px";
      const panelW = panel.offsetWidth || 320;
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
