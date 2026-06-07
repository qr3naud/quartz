/**
 * Design Explorer (maintainer-only admin tool).
 *
 * An interactive gallery of the Quartz design tokens (styles/tokens.css) and the
 * shared CSS primitives (styles/primitives.css). Edit a token and the swatches +
 * primitive/component samples update live — but the edit is a CSS variable set on
 * the gallery's own scope element, so it NEVER touches :root or the real app.
 * "Copy CSS" emits a paste-ready :root block; "Reset" reverts. Nothing is saved.
 *
 * Opened from the More -> Admin submenu (gated on the signed is_admin claim in
 * src/overlay.js, like the other admin tools). Reuses the cb-export-modal shell
 * from styles/export.css; its own layout lives in styles/design-explorer.css.
 */
(function () {
  "use strict";

  const __cb = (window.__cb = window.__cb || {});

  // Fallback token registry — used only if the runtime fetch+parse of tokens.css
  // fails. The live registry (GROUPS) is normally auto-discovered from the file
  // (see ensureRegistry), so new tokens appear without touching this list. Each
  // token is [name, kind]; kind picks the control:
  //   color  -> <input type=color> + hex text     (e.g. #717989)
  //   alpha  -> text input                          (e.g. rgba(99,102,241,0.15))
  //   shadow -> text input                          (e.g. 0 12px 32px rgba(...))
  //   size   -> range slider in px                  (e.g. 22px)
  //   radius -> range slider in px                  (e.g. 6px)
  const FALLBACK_GROUPS = [
    {
      title: "Metric tones",
      tokens: [
        ["--cb-action", "color"],
        ["--cb-action-strong", "color"],
        ["--cb-action-deep", "color"],
        ["--cb-action-surface", "color"],
        ["--cb-credit", "color"],
        ["--cb-credit-strong", "color"],
        ["--cb-credit-deep", "color"],
        ["--cb-credit-surface", "color"],
      ],
    },
    {
      title: "Surfaces & borders",
      tokens: [
        ["--cb-surface", "color"],
        ["--cb-surface-subtle", "color"],
        ["--cb-surface-muted", "color"],
        ["--cb-surface-faint", "color"],
        ["--cb-border", "color"],
        ["--cb-border-strong", "color"],
        ["--cb-border-faint", "color"],
        ["--cb-border-pill", "color"],
      ],
    },
    {
      title: "Text",
      tokens: [
        ["--cb-text-primary", "color"],
        ["--cb-text-label", "color"],
        ["--cb-text-muted", "color"],
        ["--cb-text-faint", "color"],
        ["--cb-text-disabled", "color"],
      ],
    },
    {
      title: "Accent (indigo)",
      tokens: [
        ["--cb-accent", "color"],
        ["--cb-accent-strong", "color"],
        ["--cb-accent-deep", "color"],
        ["--cb-accent-surface", "color"],
        ["--cb-accent-border", "color"],
        ["--cb-accent-ring", "alpha"],
      ],
    },
    {
      title: "Status \u00b7 green",
      tokens: [
        ["--cb-green", "color"],
        ["--cb-green-surface", "color"],
        ["--cb-green-border", "color"],
        ["--cb-green-hover", "color"],
        ["--cb-green-deep", "color"],
        ["--cb-green-ring", "alpha"],
      ],
    },
    {
      title: "Status \u00b7 amber",
      tokens: [
        ["--cb-amber", "color"],
        ["--cb-amber-text", "color"],
        ["--cb-amber-surface", "color"],
        ["--cb-amber-ring", "alpha"],
      ],
    },
    {
      title: "Status \u00b7 red",
      tokens: [
        ["--cb-red-text", "color"],
        ["--cb-red-surface", "color"],
      ],
    },
    {
      title: "Overlays",
      tokens: [
        ["--cb-tooltip-bg", "color"],
        ["--cb-shadow-menu", "shadow"],
        ["--cb-shadow-tooltip", "shadow"],
      ],
    },
    {
      title: "Shape scale",
      tokens: [
        ["--cb-radius-sm", "radius"],
        ["--cb-radius-md", "radius"],
        ["--cb-radius-lg", "radius"],
        ["--cb-radius-pill", "radius"],
        ["--cb-pill-height", "size"],
        ["--cb-input-height", "size"],
      ],
    },
  ];

  // The live token registry, auto-discovered from styles/tokens.css at first
  // open (falls back to FALLBACK_GROUPS). Same shape: [{ title, tokens:[[name,
  // kind]] }].
  let GROUPS = null;
  let registryPromise = null;

  // Infer the control kind from a token's value (so new tokens wire themselves
  // up): hex -> color; rgb/hsl(a) -> alpha; Npx -> radius (if name has "radius")
  // else size; anything else (shadows etc.) -> a text input.
  function inferKind(name, value) {
    const v = (value || "").trim();
    if (/^#[0-9a-f]{3,8}$/i.test(v)) return "color";
    if (/^(rgba?|hsla?)\(/i.test(v)) return "alpha";
    if (/^-?\d+(\.\d+)?px$/.test(v)) return name.includes("radius") ? "radius" : "size";
    return "shadow";
  }

  // Parse the :root { … } block of tokens.css into groups. Group titles come
  // from /* … */ comment lines (decoration stripped, trimmed at " ("); tokens
  // from --cb-name: value; lines. The file's top doc comment sits outside :root,
  // so it's ignored.
  function parseTokens(cssText) {
    const m = cssText.match(/:root\s*\{([\s\S]*?)\}/);
    if (!m) return [];
    const groups = [];
    let current = null;
    for (const rawLine of m[1].split("\n")) {
      const line = rawLine.trim();
      if (!line) continue;
      const cm = line.match(/^\/\*\s*(.*?)\s*\*\/$/);
      if (cm) {
        let title = cm[1].replace(/=+/g, "").trim();
        const cut = title.indexOf(" (");
        if (cut > 0) title = title.slice(0, cut).trim();
        current = { title: title || "Tokens", tokens: [] };
        groups.push(current);
        continue;
      }
      const tm = line.match(/^(--cb-[a-z0-9-]+)\s*:\s*(.+?);/i);
      if (tm) {
        if (!current) {
          current = { title: "Tokens", tokens: [] };
          groups.push(current);
        }
        current.tokens.push([tm[1], inferKind(tm[1], tm[2])]);
      }
    }
    return groups.filter((g) => g.tokens.length);
  }

  // Resolve GROUPS once (cached). Fetches the extension's own tokens.css (must be
  // web-accessible) and parses it; falls back to the hardcoded list on failure.
  function ensureRegistry() {
    if (registryPromise) return registryPromise;
    registryPromise = (async () => {
      try {
        const url = chrome.runtime.getURL("styles/tokens.css");
        const text = await (await fetch(url)).text();
        const parsed = parseTokens(text);
        GROUPS = parsed.length ? parsed : FALLBACK_GROUPS;
      } catch (err) {
        console.warn("[Clay Scoping] design-explorer token fetch failed:", err);
        GROUPS = FALLBACK_GROUPS;
      }
      return GROUPS;
    })();
    return registryPromise;
  }

  let modalEl = null;
  let backdropEl = null;
  let scopeEl = null;
  // Index of the single expanded accordion group (-1 = all collapsed). Persists
  // across Reset; defaults to the first group when the tool opens.
  let openGroupIdx = 0;
  // View mode: "group" (token-group accordion -> affected components) or
  // "component" (pick a component -> only the tokens that affect it).
  let viewMode = "group";
  // Selected component key in component mode (resolved to SAMPLES[0] lazily, as
  // SAMPLES is declared further down).
  let selectedSampleKey = null;
  // Token name -> overridden value (preview only). Empty = pristine defaults.
  const overrides = new Map();
  // Token name -> shipped default, snapshotted from :root when the tool opens.
  const defaults = new Map();

  function close() {
    if (modalEl) { modalEl.remove(); modalEl = null; }
    if (backdropEl) { backdropEl.remove(); backdropEl = null; }
    scopeEl = null;
    overrides.clear();
    defaults.clear();
    document.removeEventListener("keydown", onKeydown);
  }
  __cb.closeDesignExplorer = close;

  function onKeydown(evt) {
    if (evt.key === "Escape") { evt.stopPropagation(); close(); }
  }

  // The shipped value of a token (snapshotted at open from :root). Falls back to
  // a live read if asked for one we didn't pre-load.
  function defaultValue(name) {
    if (defaults.has(name)) return defaults.get(name);
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    defaults.set(name, v);
    return v;
  }
  // The value currently in effect inside the gallery (override if set, else default).
  function currentValue(name) {
    return overrides.has(name) ? overrides.get(name) : defaultValue(name);
  }

  // Group mode: filter the live preview to the samples the open group affects
  // (all when none is open) and label the preview. A sample shows when it uses a
  // token that's in the open group (exact membership against the group's token
  // short-names, --cb-x -> "x").
  function updatePreview(idx) {
    if (!scopeEl) return;
    const group = idx >= 0 && GROUPS ? GROUPS[idx] : null;
    const shorts = group ? group.tokens.map(([n]) => n.slice(5)) : null;
    scopeEl.querySelectorAll("[data-dex-sample]").forEach((el) => {
      el.classList.remove("cb-dex-sample-selected", "cb-dex-sample-dim", "cb-dex-sample-click");
      let show = true;
      if (shorts) {
        const sample = SAMPLES.find((s) => s.key === el.dataset.dexSample);
        const uses = sample ? sample.uses : [];
        show = uses.some((u) => shorts.includes(u));
      }
      el.style.display = show ? "" : "none";
    });
    const heading = scopeEl.querySelector(".cb-dex-preview-heading");
    if (heading) {
      heading.textContent =
        group ? `Live preview \u00b7 ${group.title}` : "Live preview";
    }
  }

  // Single-open accordion: expand group `idx` (-1 = collapse all) and sync the
  // headers' open class / aria-expanded + the contextual preview.
  function setOpenGroup(idx) {
    openGroupIdx = idx;
    if (!scopeEl) return;
    const groups = scopeEl.querySelectorAll(".cb-dex-group");
    groups.forEach((g, i) => {
      const open = i === idx;
      g.classList.toggle("cb-dex-group-open", open);
      const head = g.querySelector(".cb-dex-group-head");
      if (head) head.setAttribute("aria-expanded", open ? "true" : "false");
    });
    updatePreview(idx);
  }

  // The selected component key in component mode, defaulting to the first sample.
  function selectedKey() {
    if (selectedSampleKey && SAMPLES.some((s) => s.key === selectedSampleKey)) {
      return selectedSampleKey;
    }
    return SAMPLES[0] ? SAMPLES[0].key : null;
  }

  // Top toolbar: the By group / By component mode toggle, plus (component mode)
  // a chip per component to pick which one to explore.
  function buildToolbar() {
    const bar = document.createElement("div");
    bar.className = "cb-dex-toolbar";

    const toggle = document.createElement("div");
    toggle.className = "cb-dex-mode-toggle";
    [["group", "By group"], ["component", "By component"]].forEach(([m, label]) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "cb-dex-mode-btn" + (viewMode === m ? " cb-dex-mode-btn-active" : "");
      b.textContent = label;
      b.addEventListener("click", () => {
        if (viewMode === m) return;
        viewMode = m;
        renderGallery();
      });
      toggle.appendChild(b);
    });
    bar.appendChild(toggle);

    if (viewMode === "component") {
      const chips = document.createElement("div");
      chips.className = "cb-dex-chips";
      const sel = selectedKey();
      for (const s of SAMPLES) {
        const chip = document.createElement("button");
        chip.type = "button";
        chip.className = "cb-dex-chip" + (s.key === sel ? " cb-dex-chip-active" : "");
        chip.textContent = s.label;
        chip.addEventListener("click", () => {
          selectedSampleKey = s.key;
          renderGallery();
        });
        chips.appendChild(chip);
      }
      bar.appendChild(chips);
    }
    return bar;
  }

  // Component mode: highlight the selected sample (ring) and dim the rest; every
  // sample stays visible + clickable so you can switch by clicking the preview.
  function applyComponentSelection() {
    if (!scopeEl) return;
    const sel = selectedKey();
    const sample = SAMPLES.find((s) => s.key === sel);
    scopeEl.querySelectorAll("[data-dex-sample]").forEach((el) => {
      el.style.display = "";
      const isSel = el.dataset.dexSample === sel;
      el.classList.toggle("cb-dex-sample-selected", isSel);
      el.classList.toggle("cb-dex-sample-dim", !isSel);
    });
    const heading = scopeEl.querySelector(".cb-dex-preview-heading");
    if (heading) {
      heading.textContent = sample ? `Live preview \u00b7 ${sample.label}` : "Live preview";
    }
  }

  // (Re)build the gallery into the scope element and apply the current mode.
  // Used on open, on mode/selection change, and after Reset.
  function renderGallery() {
    if (!scopeEl) return;
    scopeEl.innerHTML = "";
    scopeEl.appendChild(buildToolbar());
    const columns = document.createElement("div");
    columns.className = "cb-dex-columns";
    columns.appendChild(buildTokensColumn());
    columns.appendChild(buildSamples());
    scopeEl.appendChild(columns);
    if (viewMode === "component") applyComponentSelection();
    else setOpenGroup(openGroupIdx);
  }

  // Apply a preview edit: record it + set the variable on the gallery scope only.
  function setToken(name, value) {
    overrides.set(name, value);
    if (scopeEl) scopeEl.style.setProperty(name, value);
  }

  // #RGB / #RRGGBB (any case) -> lowercase #rrggbb; null if not a hex color.
  function normalizeHex(raw) {
    if (!raw) return null;
    let s = raw.trim().toLowerCase();
    if (!s.startsWith("#")) s = "#" + s;
    if (/^#[0-9a-f]{3}$/.test(s)) {
      s = "#" + s[1] + s[1] + s[2] + s[2] + s[3] + s[3];
    }
    return /^#[0-9a-f]{6}$/.test(s) ? s : null;
  }

  function svgFor(kind) {
    const h = __cb._tvHelpers;
    if (kind === "action") {
      return h && h.starFourSvg
        ? h.starFourSvg(12)
        : '<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l2.4 7.6L22 12l-7.6 2.4L12 22l-2.4-7.6L2 12l7.6-2.4z"/></svg>';
    }
    return h && h.coinsSvg
      ? h.coinsSvg(12)
      : '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="9" cy="9" r="6"/><path d="M14.5 4.2a6 6 0 0 1 0 11.6"/></svg>';
  }

  const REVERT_SVG =
    '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>';

  // ---- One token row: name (click to copy) + value + revert + control ------
  function buildTokenRow(name, kind) {
    const row = document.createElement("div");
    row.className = "cb-dex-row";
    if (overrides.has(name)) row.classList.add("cb-dex-row-overridden");

    const text = document.createElement("div");
    text.className = "cb-dex-rowtext";
    // The name is a button: click copies this token's CSS line.
    const nameEl = document.createElement("button");
    nameEl.type = "button";
    nameEl.className = "cb-dex-name";
    nameEl.textContent = name;
    nameEl.title = "Copy " + name;
    const valueEl = document.createElement("span");
    valueEl.className = "cb-dex-value";
    valueEl.textContent = currentValue(name);
    text.appendChild(nameEl);
    text.appendChild(valueEl);
    row.appendChild(text);

    // Per-row revert: shown only when this token is overridden. Resets just this
    // token by deleting its override + rebuilding the row from the default.
    const resetBtn = document.createElement("button");
    resetBtn.type = "button";
    resetBtn.className = "cb-dex-reset";
    resetBtn.title = "Reset to default";
    resetBtn.setAttribute("aria-label", "Reset to default");
    resetBtn.innerHTML = REVERT_SVG;
    if (!overrides.has(name)) resetBtn.style.display = "none";
    resetBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      overrides.delete(name);
      if (scopeEl) scopeEl.style.removeProperty(name);
      row.replaceWith(buildTokenRow(name, kind));
    });
    row.appendChild(resetBtn);

    const control = document.createElement("div");
    control.className = "cb-dex-control";
    const setAndShow = (value) => {
      setToken(name, value);
      valueEl.textContent = value;
      resetBtn.style.display = "";
      row.classList.add("cb-dex-row-overridden");
    };

    // Click the name to copy "--token: value;" with a brief flash.
    nameEl.addEventListener("click", () => {
      copyToClipboard(`${name}: ${currentValue(name)};`, () => {
        nameEl.classList.add("cb-dex-name-copied");
        setTimeout(() => nameEl.classList.remove("cb-dex-name-copied"), 900);
      });
    });

    if (kind === "color") {
      const initial = normalizeHex(currentValue(name)) || "#000000";
      const color = document.createElement("input");
      color.type = "color";
      color.className = "cb-dex-color";
      color.value = initial;
      const hex = document.createElement("input");
      hex.type = "text";
      hex.className = "cb-dex-hex cb-input-box";
      hex.value = currentValue(name);
      hex.spellcheck = false;
      color.addEventListener("input", () => {
        hex.value = color.value;
        setAndShow(color.value);
      });
      hex.addEventListener("change", () => {
        const v = normalizeHex(hex.value);
        if (v) { color.value = v; hex.value = v; setAndShow(v); }
        else { hex.value = currentValue(name); }
      });
      control.appendChild(color);
      control.appendChild(hex);
    } else if (kind === "alpha" || kind === "shadow") {
      const inp = document.createElement("input");
      inp.type = "text";
      inp.className = "cb-dex-text cb-input-box";
      inp.value = currentValue(name);
      inp.spellcheck = false;
      inp.addEventListener("change", () => setAndShow(inp.value.trim()));
      control.appendChild(inp);
    } else {
      // size / radius -> px range slider.
      const max = kind === "size" ? 48 : name === "--cb-radius-pill" ? 999 : 24;
      const range = document.createElement("input");
      range.type = "range";
      range.className = "cb-dex-range";
      range.min = "0";
      range.max = String(max);
      range.step = "1";
      range.value = String(parseInt(currentValue(name), 10) || 0);
      range.addEventListener("input", () => setAndShow(`${range.value}px`));
      control.appendChild(range);
    }
    row.appendChild(control);
    return row;
  }

  // ---- Live samples (inside the scope, so they inherit overrides) -----------
  function sampleLabel(textVal) {
    const l = document.createElement("div");
    l.className = "cb-dex-sample-label";
    l.textContent = textVal;
    return l;
  }

  // One preview block: a labelled sample tagged with a key so the active token
  // group can show only the samples that actually use its tokens.
  function sampleBlock(key, labelText, content) {
    const block = document.createElement("div");
    block.className = "cb-dex-sample-block";
    block.dataset.dexSample = key;
    block.appendChild(sampleLabel(labelText));
    block.appendChild(content);
    return block;
  }

  // Cost pill (.cb-pill + .cb-pill-seg, reusing the real ER cost-pill classes).
  function samplePill() {
    const pill = document.createElement("span");
    pill.className = "cb-pill cb-table-view-er-cost-pill";
    const aSeg = document.createElement("span");
    aSeg.className = "cb-pill-seg cb-table-view-er-cost-seg cb-table-view-er-cost-actions";
    aSeg.innerHTML = svgFor("action") + "<span>12,000</span>";
    const cSeg = document.createElement("span");
    cSeg.className = "cb-pill-seg cb-table-view-er-cost-seg cb-table-view-er-cost-credits";
    cSeg.innerHTML = svgFor("credit") + "<span>1.2M</span>";
    pill.appendChild(aSeg);
    pill.appendChild(cSeg);
    return pill;
  }

  // Boxed controls (.cb-input-box) — plain input + the volume-dropdown trigger.
  function sampleInputs() {
    const inputRow = document.createElement("div");
    inputRow.className = "cb-dex-sample-row";
    const inp = document.createElement("input");
    inp.className = "cb-input-box";
    inp.value = "120,000";
    inp.readOnly = true;
    const vol = document.createElement("div");
    vol.className = "cb-input-box cb-ptg-vol";
    const volVal = document.createElement("span");
    volVal.textContent = "250,000";
    const volChev = document.createElement("span");
    volChev.className = "cb-ptg-vol-chevron";
    volChev.innerHTML =
      '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>';
    vol.appendChild(volVal);
    vol.appendChild(volChev);
    inputRow.appendChild(inp);
    inputRow.appendChild(vol);
    return inputRow;
  }

  // Surface card (.cb-surface) with token-colored text samples inside.
  function sampleSurface() {
    const card = document.createElement("div");
    card.className = "cb-surface cb-dex-surface-sample";
    const t1 = document.createElement("div");
    t1.className = "cb-pricing-summary-value cb-pricing-summary-grand";
    t1.textContent = "$48,000";
    const t2 = document.createElement("div");
    t2.className = "cb-pricing-summary-value cb-pricing-summary-savings";
    t2.textContent = "$12,000 \u00b7 20%";
    card.appendChild(t1);
    card.appendChild(t2);
    return card;
  }

  // Approval badges (.cb-ptg-approval-badge).
  function sampleBadges() {
    const badges = document.createElement("div");
    badges.className = "cb-dex-sample-row";
    [
      ["cb-ptg-approval-green", "Auto-approved"],
      ["cb-ptg-approval-amber", "Manager"],
      ["cb-ptg-approval-red", "Deal desk"],
    ].forEach(([cls, label]) => {
      const b = document.createElement("span");
      b.className = "cb-ptg-approval-badge " + cls;
      b.textContent = label;
      badges.appendChild(b);
    });
    return badges;
  }

  // Band-matrix crosshair (.cb-pam-* highlights), one per metric tone.
  function sampleMatrices() {
    const matrices = document.createElement("div");
    matrices.className = "cb-dex-sample-row";
    matrices.appendChild(buildMiniMatrix("cb-pam-actions"));
    matrices.appendChild(buildMiniMatrix("cb-pam-credits"));
    return matrices;
  }

  // Dollar pill (.cb-uc-scope-dollar) — the cost pill with the $ glyph.
  function sampleDollar() {
    const pill = document.createElement("span");
    pill.className = "cb-uc-scope-dollar";
    const dollar = __cb.dollarSvg
      ? __cb.dollarSvg(12)
      : '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>';
    pill.innerHTML = dollar + "<span>48,000</span>";
    return pill;
  }

  // Star/coin metric cards (.cb-pricing-metric-card) — Actions + Credits tones.
  function metricCard(kind, iconSvg, tierLabel, vol, cost) {
    const card = document.createElement("div");
    card.className = "cb-surface cb-pricing-metric-card cb-pricing-metric-" + kind;
    const iconWrap = document.createElement("div");
    iconWrap.className = "cb-pricing-metric-iconwrap";
    const icon = document.createElement("span");
    icon.className = "cb-pricing-metric-icon";
    icon.innerHTML = iconSvg;
    iconWrap.appendChild(icon);
    if (tierLabel) {
      const t = document.createElement("span");
      t.className = "cb-pricing-metric-tier";
      t.textContent = tierLabel;
      iconWrap.appendChild(t);
    }
    card.appendChild(iconWrap);
    const d1 = document.createElement("div");
    d1.className = "cb-pricing-metric-divider";
    card.appendChild(d1);
    const v = document.createElement("div");
    v.className = "cb-pricing-metric-vol";
    v.textContent = vol;
    card.appendChild(v);
    const d2 = document.createElement("div");
    d2.className = "cb-pricing-metric-divider";
    card.appendChild(d2);
    const c = document.createElement("div");
    c.className = "cb-pricing-metric-cost";
    c.textContent = cost;
    card.appendChild(c);
    return card;
  }
  function sampleMetricCards() {
    const row = document.createElement("div");
    row.className = "cb-dex-sample-row cb-dex-metric-row";
    row.appendChild(metricCard("actions", svgFor("action"), "Tier C", "250,000", "$2,000"));
    row.appendChild(metricCard("credits", svgFor("credit"), null, "1.2M", "$60,000"));
    return row;
  }

  // Read-only price / floor boxes + the "% off" chip.
  function samplePrices() {
    const row = document.createElement("div");
    row.className = "cb-dex-sample-row";
    const rep = document.createElement("div");
    rep.className = "cb-ptg-repfloor";
    rep.textContent = "$0.0360";
    const list = document.createElement("div");
    list.className = "cb-ptg-repfloor cb-ptg-listbox";
    list.textContent = "$0.0500";
    const pct = document.createElement("span");
    pct.className = "cb-ptg-pct-box";
    pct.textContent = "28%";
    row.appendChild(rep);
    row.appendChild(list);
    row.appendChild(pct);
    return row;
  }

  // Tags + pills: summary term tag, authority pills, metric pills.
  function sampleTags() {
    const row = document.createElement("div");
    row.className = "cb-dex-sample-row";
    const term = document.createElement("span");
    term.className = "cb-pricing-summary-term";
    term.textContent = "2Y";
    row.appendChild(term);
    [
      ["cb-pam-authpill-rep", "Rep"],
      ["cb-pam-authpill-manager", "Manager"],
      ["cb-pam-authpill-dealdesk", "Deal desk"],
    ].forEach(([cls, label]) => {
      const p = document.createElement("span");
      p.className = "cb-pam-authpill " + cls;
      p.textContent = label;
      row.appendChild(p);
    });
    // Metric pills get their tone from a .cb-pam-actions / .cb-pam-credits parent.
    [
      ["cb-pam-actions", "Actions"],
      ["cb-pam-credits", "Credits"],
    ].forEach(([toneCls, label]) => {
      const tone = document.createElement("span");
      tone.className = toneCls;
      const pill = document.createElement("span");
      pill.className = "cb-pam-metricpill";
      pill.textContent = label;
      tone.appendChild(pill);
      row.appendChild(tone);
    });
    return row;
  }

  // An input wearing the amber "overridden" outline (.cb-pricing-overridden).
  function sampleOverridden() {
    const inp = document.createElement("input");
    inp.className = "cb-input-box cb-pricing-overridden";
    inp.value = "250,000";
    inp.readOnly = true;
    return inp;
  }

  // Declarative sample list. `uses` lists the token short-names (--cb-x -> "x")
  // each sample consumes; updatePreview matches these against the open group's
  // tokens (prefix-aware) to show only the relevant samples.
  // `uses` is the EXACT set of token short-names (--cb-x -> "x") each sample
  // consumes, compiled from the component classes' var(--cb-*) usages. Drives
  // both the group->sample filter (group mode) and the token list (component
  // mode), so both views are honest. Keep in sync if a component's CSS changes.
  const SAMPLES = [
    { key: "pill", label: "Cost pill", build: samplePill,
      uses: ["action", "credit", "border-pill", "surface", "pill-height", "radius-pill", "pill-text"] },
    { key: "dollar", label: "Dollar pill", build: sampleDollar,
      uses: ["action", "border-pill", "surface", "pill-height", "radius-pill", "pill-text"] },
    { key: "metric", label: "Metric cards", build: sampleMetricCards,
      uses: ["surface", "border", "radius-lg", "surface-muted", "text-muted", "text-faint", "text-primary", "text-label", "action", "credit"] },
    { key: "inputs", label: "Input + dropdown", build: sampleInputs,
      uses: ["border", "radius-sm", "surface", "text-primary", "input-height", "text-faint", "border-strong"] },
    { key: "prices", label: "Price + floor boxes", build: samplePrices,
      uses: ["surface-muted", "radius-sm", "surface-subtle", "text-label", "input-height", "text-muted"] },
    { key: "surface", label: "Surface + text", build: sampleSurface,
      uses: ["surface", "border", "text-primary", "accent-deep", "green", "radius-md"] },
    { key: "tags", label: "Tags + pills", build: sampleTags,
      uses: ["accent-surface", "accent-strong", "radius-pill", "amber-surface", "amber-text", "red-surface", "red-text", "action-surface", "action-deep", "credit-surface", "credit-deep"] },
    { key: "badges", label: "Approval badges", build: sampleBadges,
      uses: ["green-surface", "green", "amber-surface", "amber-text", "red-surface", "red-text"] },
    { key: "matrix", label: "Band matrix crosshair", build: sampleMatrices,
      uses: ["surface", "border", "radius-lg", "shadow-menu", "text-label", "action-surface", "action-deep", "action", "action-strong", "credit-surface", "credit-deep", "credit", "credit-strong"] },
    { key: "overridden", label: "Overridden outline", build: sampleOverridden,
      uses: ["border", "radius-sm", "surface", "text-primary", "input-height", "amber", "amber-ring"] },
  ];

  function buildSamples() {
    const wrap = document.createElement("div");
    wrap.className = "cb-dex-preview";

    const heading = document.createElement("div");
    heading.className = "cb-dex-preview-heading";
    heading.textContent = "Live preview";
    wrap.appendChild(heading);

    for (const s of SAMPLES) {
      const block = sampleBlock(s.key, s.label, s.build());
      // Component mode: clicking a sample focuses it (same as its chip).
      if (viewMode === "component") {
        block.classList.add("cb-dex-sample-click");
        block.title = "Explore " + s.label;
        block.addEventListener("click", () => {
          selectedSampleKey = s.key;
          renderGallery();
        });
      }
      wrap.appendChild(block);
    }
    return wrap;
  }

  // A 3x3 mini version of the avg band matrix: middle column = active year,
  // middle row = selected band, their intersection = the applied floor.
  function buildMiniMatrix(toneCls) {
    const panel = document.createElement("div");
    panel.className = "cb-pricing-avgmatrix " + toneCls;
    const table = document.createElement("table");
    const tbody = document.createElement("tbody");
    for (let r = 0; r < 3; r++) {
      const tr = document.createElement("tr");
      if (r === 1) tr.className = "cb-pam-row-sel";
      for (let c = 0; c < 3; c++) {
        const td = document.createElement("td");
        const cls = [];
        if (c === 1) cls.push("cb-pam-col-active");
        if (r === 1 && c === 1) cls.push("cb-pam-cell-active");
        if (cls.length) td.className = cls.join(" ");
        td.textContent = "0.03";
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    panel.appendChild(table);
    return panel;
  }

  const CHEVRON_SVG =
    '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>';

  // Builds the token-controls column (left): one collapsible accordion group per
  // token group. Headers toggle via setOpenGroup (single-open).
  // Component mode: a flat, fully-expanded list of only the tokens that affect
  // the selected component, grouped under their token-group titles.
  function buildComponentTokens(col) {
    const sel = selectedKey();
    const sample = SAMPLES.find((s) => s.key === sel);
    const uses = sample ? sample.uses : [];
    let count = 0;
    GROUPS.forEach((group) => {
      group.tokens.forEach(([n]) => {
        if (uses.includes(n.slice(5))) count++;
      });
    });

    const hdr = document.createElement("div");
    hdr.className = "cb-dex-affect-head";
    hdr.textContent =
      `${count} token${count === 1 ? "" : "s"} affect ${sample ? sample.label : "this"}`;
    col.appendChild(hdr);

    GROUPS.forEach((group) => {
      const rows = group.tokens.filter(([n]) => uses.includes(n.slice(5)));
      if (!rows.length) return;
      const sub = document.createElement("div");
      sub.className = "cb-dex-subgroup-title";
      sub.textContent = group.title;
      col.appendChild(sub);
      for (const [name, kind] of rows) col.appendChild(buildTokenRow(name, kind));
    });

    if (!count) {
      const empty = document.createElement("div");
      empty.className = "cb-dex-loading";
      empty.textContent = "No tokens found for this component.";
      col.appendChild(empty);
    }
  }

  function buildTokensColumn() {
    const col = document.createElement("div");
    col.className = "cb-dex-tokens";
    if (viewMode === "component") {
      buildComponentTokens(col);
      return col;
    }
    GROUPS.forEach((group, gi) => {
      const groupEl = document.createElement("div");
      groupEl.className = "cb-dex-group";

      const head = document.createElement("button");
      head.type = "button";
      head.className = "cb-dex-group-head";
      head.setAttribute("aria-expanded", "false");
      const chev = document.createElement("span");
      chev.className = "cb-dex-group-chevron";
      chev.innerHTML = CHEVRON_SVG;
      const nm = document.createElement("span");
      nm.className = "cb-dex-group-name";
      nm.textContent = group.title;
      const count = document.createElement("span");
      count.className = "cb-dex-group-count";
      count.textContent = String(group.tokens.length);
      head.appendChild(chev);
      head.appendChild(nm);
      head.appendChild(count);
      // Click the open group to collapse it (none open -> preview shows all).
      head.addEventListener("click", () => setOpenGroup(openGroupIdx === gi ? -1 : gi));

      const body = document.createElement("div");
      body.className = "cb-dex-group-body";
      const inner = document.createElement("div");
      inner.className = "cb-dex-group-body-inner";
      for (const [name, kind] of group.tokens) {
        inner.appendChild(buildTokenRow(name, kind));
      }
      body.appendChild(inner);

      groupEl.appendChild(head);
      groupEl.appendChild(body);
      col.appendChild(groupEl);
    });
    return col;
  }

  // The :root block reflecting current values (defaults + any preview edits),
  // grouped + commented to match styles/tokens.css. Paste-ready.
  function buildCss() {
    const lines = [":root {"];
    GROUPS.forEach((group, i) => {
      if (i > 0) lines.push("");
      lines.push(`  /* ${group.title} */`);
      for (const [name] of group.tokens) {
        lines.push(`  ${name}: ${currentValue(name)};`);
      }
    });
    lines.push("}");
    return lines.join("\n");
  }

  // Clipboard with the textarea/execCommand fallback (mirrors pricing-comparison).
  function copyToClipboard(text, onDone) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(onDone).catch((err) => {
        console.warn("[Clay Scoping] clipboard write failed:", err);
      });
      return;
    }
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.cssText = "position:fixed;left:-9999px;";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      onDone();
    } catch (err) {
      console.warn("[Clay Scoping] clipboard fallback failed:", err);
    }
  }

  function open() {
    close();

    backdropEl = document.createElement("div");
    backdropEl.className = "cb-export-modal-backdrop";
    backdropEl.addEventListener("mousedown", (evt) => {
      if (evt.target === backdropEl) close();
    });

    modalEl = document.createElement("div");
    modalEl.className = "cb-export-modal cb-gtme-modal cb-dex-modal";

    // ---- Header ----
    const header = document.createElement("div");
    header.className = "cb-export-modal-header";
    const titleWrap = document.createElement("div");
    titleWrap.className = "cb-export-modal-title-wrap";
    const title = document.createElement("h2");
    title.className = "cb-export-modal-title";
    title.textContent = "Design Explorer";
    const subtitle = document.createElement("div");
    subtitle.className = "cb-export-modal-subtitle";
    subtitle.textContent =
      "Live token + primitive gallery. Edits preview here only \u2014 nothing is saved. Maintainer-only.";
    titleWrap.appendChild(title);
    titleWrap.appendChild(subtitle);
    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "cb-export-modal-close";
    closeBtn.setAttribute("aria-label", "Close");
    closeBtn.innerHTML =
      '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
    closeBtn.addEventListener("click", close);
    header.appendChild(titleWrap);
    header.appendChild(closeBtn);

    // ---- Body (the scope: token edits cascade to the samples inside) ----
    const body = document.createElement("div");
    body.className = "cb-export-modal-body cb-dex-body";
    scopeEl = document.createElement("div");
    scopeEl.className = "cb-dex";
    // Re-apply any overrides (only matters if reopened within a session; close()
    // clears them, so normally a no-op).
    for (const [name, value] of overrides) scopeEl.style.setProperty(name, value);
    body.appendChild(scopeEl);
    // Tokens auto-discover from tokens.css; show a brief placeholder, then render
    // once the registry resolves (guarding against a close/reopen in between).
    const loading = document.createElement("div");
    loading.className = "cb-dex-loading";
    loading.textContent = "Loading tokens\u2026";
    scopeEl.appendChild(loading);
    const myScope = scopeEl;
    ensureRegistry().then(() => {
      if (scopeEl === myScope) renderGallery();
    });

    // ---- Footer ----
    const footer = document.createElement("div");
    footer.className = "cb-modal-footer";
    const footerHint = document.createElement("div");
    footerHint.className = "cb-export-modal-footer-hint";
    footerHint.textContent =
      "Preview only \u00b7 click a token name to copy it, or 'Copy all CSS' to paste into styles/tokens.css.";
    const footerActions = document.createElement("div");
    footerActions.className = "cb-modal-footer-actions";

    const resetBtn = document.createElement("button");
    resetBtn.type = "button";
    resetBtn.className = "cb-modal-btn cb-modal-btn-ghost";
    resetBtn.textContent = "Reset all";
    resetBtn.addEventListener("click", () => {
      for (const name of overrides.keys()) {
        if (scopeEl) scopeEl.style.removeProperty(name);
      }
      overrides.clear();
      // Rebuild the gallery so every control + value snaps back to default
      // (keeps the currently-open accordion group).
      renderGallery();
    });

    const copyBtn = document.createElement("button");
    copyBtn.type = "button";
    copyBtn.className = "cb-modal-btn cb-modal-btn-ghost";
    copyBtn.textContent = "Copy all CSS";
    copyBtn.addEventListener("click", () => {
      copyToClipboard(buildCss(), () => {
        const orig = copyBtn.textContent;
        copyBtn.textContent = "Copied \u2713";
        setTimeout(() => { copyBtn.textContent = orig; }, 1500);
      });
    });

    const doneBtn = document.createElement("button");
    doneBtn.type = "button";
    doneBtn.className = "cb-modal-btn cb-modal-btn-primary";
    doneBtn.textContent = "Done";
    doneBtn.addEventListener("click", close);

    footerActions.appendChild(resetBtn);
    footerActions.appendChild(copyBtn);
    footerActions.appendChild(doneBtn);
    footer.appendChild(footerHint);
    footer.appendChild(footerActions);

    modalEl.appendChild(header);
    modalEl.appendChild(body);
    modalEl.appendChild(footer);
    modalEl.addEventListener("mousedown", (evt) => evt.stopPropagation());
    backdropEl.appendChild(modalEl);
    document.body.appendChild(backdropEl);
    document.addEventListener("keydown", onKeydown);
  }

  __cb.openDesignExplorer = open;
})();
