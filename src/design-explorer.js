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

  // Token registry — mirrors the comment groups in styles/tokens.css. Each token
  // is [name, kind]; kind picks the control + swatch:
  //   color  -> <input type=color> + hex text     (e.g. #717989)
  //   alpha  -> text input                          (e.g. rgba(99,102,241,0.15))
  //   shadow -> text input                          (e.g. 0 12px 32px rgba(...))
  //   size   -> range slider in px                  (e.g. 22px)
  //   radius -> range slider in px                  (e.g. 6px)
  const GROUPS = [
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

  // Which preview samples each token group actually affects (by GROUPS index),
  // so expanding a group shows only the primitives that use its tokens. Keys
  // match the data-dex-sample blocks in buildSamples().
  const ALL_SAMPLE_KEYS = ["pill", "inputs", "surface", "badges", "matrix"];
  const GROUP_SAMPLES = [
    ["pill", "matrix"], // 0 Metric tones
    ["surface", "inputs", "pill", "matrix"], // 1 Surfaces & borders
    ["surface", "inputs"], // 2 Text
    ["inputs", "surface"], // 3 Accent (indigo)
    ["badges", "surface"], // 4 Status · green
    ["badges"], // 5 Status · amber
    ["badges"], // 6 Status · red
    ["matrix"], // 7 Overlays
    ["pill", "inputs", "surface", "matrix"], // 8 Shape scale
  ];

  let modalEl = null;
  let backdropEl = null;
  let scopeEl = null;
  // Index of the single expanded accordion group (-1 = all collapsed). Persists
  // across Reset; defaults to the first group when the tool opens.
  let openGroupIdx = 0;
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

  // Filter the live preview to the samples the active group affects (all when
  // none is open), and label the preview with the active group's name.
  function updatePreview(idx) {
    if (!scopeEl) return;
    const keys = idx >= 0 && GROUP_SAMPLES[idx] ? GROUP_SAMPLES[idx] : ALL_SAMPLE_KEYS;
    scopeEl.querySelectorAll("[data-dex-sample]").forEach((el) => {
      el.style.display = keys.includes(el.dataset.dexSample) ? "" : "none";
    });
    const heading = scopeEl.querySelector(".cb-dex-preview-heading");
    if (heading) {
      heading.textContent =
        idx >= 0 && GROUPS[idx] ? `Live preview \u00b7 ${GROUPS[idx].title}` : "Live preview";
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

  // (Re)build the gallery into the scope element and apply the current open group.
  // Used on open and after Reset.
  function renderGallery() {
    if (!scopeEl) return;
    scopeEl.innerHTML = "";
    scopeEl.appendChild(buildTokensColumn());
    scopeEl.appendChild(buildSamples());
    setOpenGroup(openGroupIdx);
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

  // ---- One token row: swatch + name + value + control ----------------------
  function buildTokenRow(name, kind) {
    const row = document.createElement("div");
    row.className = "cb-dex-row";

    const swatch = document.createElement("span");
    swatch.className = "cb-dex-swatch cb-dex-swatch-" + kind;
    if (kind === "color" || kind === "alpha") {
      swatch.style.background = `var(${name})`;
    } else if (kind === "shadow") {
      swatch.style.boxShadow = `var(${name})`;
    } else if (kind === "radius") {
      swatch.style.borderRadius = `var(${name})`;
    } else if (kind === "size") {
      swatch.style.height = `var(${name})`;
    }
    row.appendChild(swatch);

    const text = document.createElement("div");
    text.className = "cb-dex-rowtext";
    const nameEl = document.createElement("code");
    nameEl.className = "cb-dex-name";
    nameEl.textContent = name;
    const valueEl = document.createElement("span");
    valueEl.className = "cb-dex-value";
    valueEl.textContent = currentValue(name);
    text.appendChild(nameEl);
    text.appendChild(valueEl);
    row.appendChild(text);

    const control = document.createElement("div");
    control.className = "cb-dex-control";
    const setAndShow = (value) => {
      setToken(name, value);
      valueEl.textContent = value;
    };

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

  function buildSamples() {
    const wrap = document.createElement("div");
    wrap.className = "cb-dex-preview";

    const heading = document.createElement("div");
    heading.className = "cb-dex-preview-heading";
    heading.textContent = "Live preview";
    wrap.appendChild(heading);

    wrap.appendChild(sampleBlock("pill", "Cost pill", samplePill()));
    wrap.appendChild(sampleBlock("inputs", "Input + dropdown", sampleInputs()));
    wrap.appendChild(sampleBlock("surface", "Surface + text", sampleSurface()));
    wrap.appendChild(sampleBlock("badges", "Approval badges", sampleBadges()));
    wrap.appendChild(sampleBlock("matrix", "Band matrix crosshair", sampleMatrices()));

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
  function buildTokensColumn() {
    const col = document.createElement("div");
    col.className = "cb-dex-tokens";
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
    renderGallery();

    // ---- Footer ----
    const footer = document.createElement("div");
    footer.className = "cb-modal-footer";
    const footerHint = document.createElement("div");
    footerHint.className = "cb-export-modal-footer-hint";
    footerHint.textContent = "Preview only \u00b7 paste Copy CSS into styles/tokens.css to keep.";
    const footerActions = document.createElement("div");
    footerActions.className = "cb-modal-footer-actions";

    const resetBtn = document.createElement("button");
    resetBtn.type = "button";
    resetBtn.className = "cb-modal-btn cb-modal-btn-ghost";
    resetBtn.textContent = "Reset";
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
    copyBtn.textContent = "Copy CSS";
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
