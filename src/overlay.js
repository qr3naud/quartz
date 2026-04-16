(function () {
  "use strict";

  const __cb = window.__cb;

  __cb.updateGroupButtonVisibility = function () {};

  __cb.openCanvas = function (initialCards) {
    if (__cb.overlayEl) return;

    if (!__cb.tabStore) {
      const tabId = __cb.generateTabId();
      __cb.tabStore = {
        activeId: tabId,
        tabs: [{ id: tabId, name: "Brainstorm", hidden: false, state: null }],
      };
    }

    const ids = __cb.parseIdsFromUrl();
    if (ids) localStorage.setItem(`cb-open-${ids.workbookId}`, "1");

    __cb.overlayEl = document.createElement("div");
    __cb.overlayEl.className = "cb-overlay";

    const clayHeader =
      document.querySelector("#clay-app header") ??
      document.querySelector("#clay-app nav") ??
      document.querySelector("#clay-app > div > div:first-child");
    if (clayHeader) {
      __cb.overlayEl.style.top = clayHeader.getBoundingClientRect().bottom + "px";
    }

    const topBar = document.createElement("div");
    topBar.className = "cb-topbar";

    const leftGroup = document.createElement("div");
    leftGroup.className = "cb-topbar-left";

    __cb.buildTabBar(leftGroup);

    const rightGroup = document.createElement("div");
    rightGroup.className = "cb-topbar-right";

    const addMoreBtn = document.createElement("button");
    addMoreBtn.className = "cb-toolbar-btn cb-toolbar-btn-primary";
    addMoreBtn.textContent = "+ Add More";
    addMoreBtn.addEventListener("click", () => {
      __cb.startPickerMode();
    });

    const closeBtn = document.createElement("button");
    closeBtn.className = "cb-toolbar-btn cb-toolbar-close";
    closeBtn.textContent = "Close";
    closeBtn.addEventListener("click", __cb.closeCanvas);

    const importBtn = document.createElement("button");
    importBtn.className = "cb-toolbar-btn cb-toolbar-import";
    importBtn.innerHTML =
      '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>' +
      " Import from Table";
    importBtn.addEventListener("click", () => __cb.startImport(importBtn));

    rightGroup.appendChild(importBtn);
    rightGroup.appendChild(addMoreBtn);
    rightGroup.appendChild(closeBtn);
    topBar.appendChild(leftGroup);
    topBar.appendChild(rightGroup);

    // ---- Summary bar ----

    const summaryBar = document.createElement("div");
    summaryBar.className = "cb-summary-bar";

    const creditsBox = document.createElement("div");
    creditsBox.className = "cb-summary-box";
    const creditsLabel = document.createElement("span");
    creditsLabel.className = "cb-summary-label";
    creditsLabel.textContent = "Avg Credits / Row";
    const creditsValue = document.createElement("span");
    creditsValue.className = "cb-summary-value";
    creditsValue.id = "cb-credits-value";
    creditsValue.textContent = "0";
    creditsBox.appendChild(creditsLabel);
    creditsBox.appendChild(creditsValue);

    const recordsBox = document.createElement("div");
    recordsBox.className = "cb-summary-box";
    const recordsLabel = document.createElement("label");
    recordsLabel.className = "cb-summary-label";
    recordsLabel.textContent = "Records";
    recordsLabel.htmlFor = "cb-records-input";
    const recordsInput = document.createElement("input");
    recordsInput.type = "text";
    recordsInput.inputMode = "numeric";
    recordsInput.className = "cb-summary-input";
    recordsInput.id = "cb-records-input";
    recordsInput.placeholder = "0";
    recordsBox.appendChild(recordsLabel);
    recordsBox.appendChild(recordsInput);

    const actionsBox = document.createElement("div");
    actionsBox.className = "cb-summary-box";
    const actionsLabel = document.createElement("span");
    actionsLabel.className = "cb-summary-label";
    actionsLabel.textContent = "Actions / Row";
    const actionsValue = document.createElement("span");
    actionsValue.className = "cb-summary-value";
    actionsValue.id = "cb-actions-value";
    actionsValue.textContent = "0";
    actionsBox.appendChild(actionsLabel);
    actionsBox.appendChild(actionsValue);

    const totalBox = document.createElement("div");
    totalBox.className = "cb-summary-box cb-summary-total";
    const totalLabel = document.createElement("span");
    totalLabel.className = "cb-summary-label";
    totalLabel.textContent = "Total Credits";
    const totalValue = document.createElement("span");
    totalValue.className = "cb-summary-value";
    totalValue.id = "cb-total-value";
    totalValue.textContent = "0";
    totalBox.appendChild(totalLabel);
    totalBox.appendChild(totalValue);

    const totalActionsBox = document.createElement("div");
    totalActionsBox.className = "cb-summary-box cb-summary-total";
    const totalActionsLabel = document.createElement("span");
    totalActionsLabel.className = "cb-summary-label";
    totalActionsLabel.textContent = "Total Actions";
    const totalActionsValue = document.createElement("span");
    totalActionsValue.className = "cb-summary-value";
    totalActionsValue.id = "cb-total-actions-value";
    totalActionsValue.textContent = "0";
    totalActionsBox.appendChild(totalActionsLabel);
    totalActionsBox.appendChild(totalActionsValue);

    summaryBar.appendChild(creditsBox);
    summaryBar.appendChild(actionsBox);
    summaryBar.appendChild(recordsBox);
    summaryBar.appendChild(totalBox);
    summaryBar.appendChild(totalActionsBox);

    let currentCreditsPerRow = 0;
    let currentActionsPerRow = 0;

    function formatNumber(n) {
      return n % 1 === 0
        ? n.toLocaleString()
        : n.toLocaleString(undefined, { maximumFractionDigits: 1 });
    }

    function formatWithCommas(numStr) {
      const n = parseInt(numStr, 10);
      return isNaN(n) ? "" : n.toLocaleString();
    }

    function parseRecordsValue() {
      return parseInt(recordsInput.value.replace(/,/g, ""), 10) || 0;
    }

    function recalcTotal() {
      const records = parseRecordsValue();
      totalValue.textContent = formatNumber(currentCreditsPerRow * records);
      totalActionsValue.textContent = formatNumber(currentActionsPerRow * records);
    }

    __cb.updateCreditTotal = function (creditsPerRow, actionsPerRow) {
      currentCreditsPerRow = creditsPerRow;
      currentActionsPerRow = actionsPerRow;
      creditsValue.textContent = formatNumber(creditsPerRow);
      actionsValue.textContent = formatNumber(actionsPerRow);
      recalcTotal();
    };

    recordsInput.addEventListener("input", () => {
      const raw = recordsInput.value.replace(/[^\d]/g, "");
      const formatted = formatWithCommas(raw);
      const prevLen = recordsInput.value.length;
      const caretPos = recordsInput.selectionStart || 0;
      recordsInput.value = formatted;
      const diff = formatted.length - prevLen;
      recordsInput.setSelectionRange(caretPos + diff, caretPos + diff);
      recalcTotal();
    });

    // ---- Canvas area + toolbox ----

    const canvasArea = document.createElement("div");
    canvasArea.className = "cb-canvas-area";
    canvasArea.id = "cb-canvas-area";

    const mainArea = document.createElement("div");
    mainArea.className = "cb-main";
    mainArea.appendChild(canvasArea);

    const toolbox = document.createElement("div");
    toolbox.className = "cb-toolbox";

    const navHelper = document.createElement("div");
    navHelper.className = "cb-tool-helper";
    navHelper.innerHTML = "Select cards  <kbd>\u23CE</kbd> link or <kbd>\u21E7\u23CE</kbd> group";

    const helper = document.createElement("div");
    helper.className = "cb-tool-helper";
    helper.innerHTML = "<kbd>\u21E7</kbd> bulk \u00A0\u00A0 <kbd>\u2325</kbd> comment \u00A0\u00A0 <kbd>\u2318</kbd> input";

    const erHelper = document.createElement("div");
    erHelper.className = "cb-tool-helper";
    erHelper.innerHTML = "Double <kbd>Click</kbd> a data point to connect";

    const selector = document.createElement("div");
    selector.className = "cb-tool-selector";

    const navBtn = document.createElement("button");
    navBtn.className = "cb-tool-btn";
    navBtn.type = "button";
    navBtn.innerHTML =
      '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" ' +
      'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M11.146 15.854a1.207 1.207 0 0 1 1.708 0l1.56 1.56A2 2 0 0 1 15 18.828V21a1 1 0 0 1-1 1h-4a1 1 0 0 1-1-1v-2.172a2 2 0 0 1 .586-1.414z"/>' +
      '<path d="M18.828 15a2 2 0 0 1-1.414-.586l-1.56-1.56a1.207 1.207 0 0 1 0-1.708l1.56-1.56A2 2 0 0 1 18.828 9H21a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1z"/>' +
      '<path d="M6.586 14.414A2 2 0 0 1 5.172 15H3a1 1 0 0 1-1-1v-4a1 1 0 0 1 1-1h2.172a2 2 0 0 1 1.414.586l1.56 1.56a1.207 1.207 0 0 1 0 1.708z"/>' +
      '<path d="M9 3a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2.172a2 2 0 0 1-.586 1.414l-1.56 1.56a1.207 1.207 0 0 1-1.708 0l-1.56-1.56A2 2 0 0 1 9 5.172z"/></svg>' +
      "<span>Navigate</span>";

    const dpBtn = document.createElement("button");
    dpBtn.className = "cb-tool-btn";
    dpBtn.type = "button";
    dpBtn.innerHTML =
      '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" ' +
      'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M4 7V4h16v3"/><path d="M9 20h6"/><path d="M12 4v16"/></svg>' +
      "<span>Data Points</span>";

    const erBtn = document.createElement("button");
    erBtn.className = "cb-tool-btn";
    erBtn.type = "button";
    erBtn.innerHTML =
      '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" ' +
      'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>' +
      "<span>Enrichments</span>";

    function getModeFromTool(tool) {
      return tool === "dp" || tool === "er" ? tool : "navigate";
    }

    function setSelectedMode(mode) {
      const canvas = __cb.canvas;
      if (!canvas) return;
      canvas.setActiveTool(mode === "navigate" ? null : mode);
      updateToolButtons();
    }

    function updateToolButtons() {
      const canvas = __cb.canvas;
      const mode = getModeFromTool(canvas ? canvas.getActiveTool() : null);
      navBtn.classList.toggle("cb-tool-btn-active", mode === "navigate");
      dpBtn.classList.toggle("cb-tool-btn-active", mode === "dp");
      erBtn.classList.toggle("cb-tool-btn-active", mode === "er");
      navHelper.classList.toggle("cb-tool-helper-visible", mode === "navigate");
      helper.classList.toggle("cb-tool-helper-visible", mode === "dp");
      erHelper.classList.toggle("cb-tool-helper-visible", mode === "er");
      if (tipsTab.classList.contains("cb-help-tab-active")) {
        helpContent.innerHTML = buildTipsHtml(mode);
      }
    }

    navBtn.addEventListener("click", () => setSelectedMode("navigate"));
    dpBtn.addEventListener("click", () => setSelectedMode("dp"));
    erBtn.addEventListener("click", () => setSelectedMode("er"));

    selector.appendChild(navBtn);
    selector.appendChild(dpBtn);
    selector.appendChild(erBtn);
    toolbox.appendChild(navHelper);
    toolbox.appendChild(helper);
    toolbox.appendChild(erHelper);
    toolbox.appendChild(selector);
    mainArea.appendChild(toolbox);

    const zoomControls = document.createElement("div");
    zoomControls.className = "cb-zoom-controls";

    const zoomInBtn = document.createElement("button");
    zoomInBtn.className = "cb-zoom-btn";
    zoomInBtn.type = "button";
    zoomInBtn.innerHTML =
      '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" ' +
      'stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">' +
      '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>';
    zoomInBtn.addEventListener("click", () => { if (__cb.canvas) __cb.canvas.zoomIn(); });

    const zoomOutBtn = document.createElement("button");
    zoomOutBtn.className = "cb-zoom-btn";
    zoomOutBtn.type = "button";
    zoomOutBtn.innerHTML =
      '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" ' +
      'stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">' +
      '<line x1="5" y1="12" x2="19" y2="12"/></svg>';
    zoomOutBtn.addEventListener("click", () => { if (__cb.canvas) __cb.canvas.zoomOut(); });

    zoomControls.appendChild(zoomInBtn);
    zoomControls.appendChild(zoomOutBtn);
    mainArea.appendChild(zoomControls);

    // ---- Help button + popover ----

    const helpWrap = document.createElement("div");
    helpWrap.className = "cb-help-wrap";

    const helpBtn = document.createElement("button");
    helpBtn.className = "cb-help-btn";
    helpBtn.type = "button";
    helpBtn.textContent = "?";

    const helpPopover = document.createElement("div");
    helpPopover.className = "cb-help-popover";

    const helpToggle = document.createElement("div");
    helpToggle.className = "cb-help-toggle";

    const instructionsTab = document.createElement("button");
    instructionsTab.className = "cb-help-tab cb-help-tab-active";
    instructionsTab.type = "button";
    instructionsTab.textContent = "Instructions";

    const tipsTab = document.createElement("button");
    tipsTab.className = "cb-help-tab";
    tipsTab.type = "button";
    tipsTab.textContent = "Tips";

    helpToggle.appendChild(instructionsTab);
    helpToggle.appendChild(tipsTab);

    const helpActions = document.createElement("div");
    helpActions.className = "cb-help-actions";

    const maximizeSvg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" ' +
      'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
      '<polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/>' +
      '<line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>';
    const minimizeSvg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" ' +
      'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
      '<polyline points="4 14 10 14 10 20"/><polyline points="20 10 14 10 14 4"/>' +
      '<line x1="14" y1="10" x2="21" y2="3"/><line x1="3" y1="21" x2="10" y2="14"/></svg>';
    const pinSvg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" ' +
      'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M12 17v5"/>' +
      '<path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/></svg>';
    const pinOffSvg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" ' +
      'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M12 17v5"/><path d="M15 9.34V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H7.89"/>' +
      '<path d="m2 2 20 20"/><path d="M9 9v1.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16h11"/></svg>';

    const expandBtn = document.createElement("button");
    expandBtn.className = "cb-help-action-btn";
    expandBtn.type = "button";
    expandBtn.title = "Expand";
    expandBtn.innerHTML = maximizeSvg;

    const pinBtn = document.createElement("button");
    pinBtn.className = "cb-help-action-btn";
    pinBtn.type = "button";
    pinBtn.title = "Pin";
    pinBtn.innerHTML = pinSvg;

    expandBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const expanded = helpPopover.classList.toggle("cb-help-popover-expanded");
      expandBtn.innerHTML = expanded ? minimizeSvg : maximizeSvg;
      expandBtn.title = expanded ? "Collapse" : "Expand";
    });

    pinBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const pinned = helpPopover.classList.toggle("cb-help-popover-pinned");
      pinBtn.classList.toggle("cb-help-action-btn-active", pinned);
      pinBtn.innerHTML = pinned ? pinOffSvg : pinSvg;
      pinBtn.title = pinned ? "Unpin" : "Pin";
    });

    helpActions.appendChild(expandBtn);
    helpActions.appendChild(pinBtn);
    helpToggle.appendChild(helpActions);

    const helpContent = document.createElement("div");
    helpContent.className = "cb-help-content";

    const instructionsHtml =
      '<div class="cb-help-section">' +
        '<div class="cb-help-section-title">Getting started</div>' +
        '<p>Open the brainstorm canvas from the <strong>Brainstorm</strong> button on any Clay table. Use <strong>+ Add More</strong> to pick enrichments from the catalog, or <strong>Import from Table</strong> to pull in enrichments from an existing table.</p>' +
      '</div>' +
      '<div class="cb-help-section">' +
        '<div class="cb-help-section-title">Tools</div>' +
        '<p>The toolbar at the bottom has three modes: <strong>Navigate</strong> (select, drag, pan), <strong>Data Points</strong> (place data point cards), and <strong>Enrichments</strong> (place enrichment cards). Click the canvas to create cards when a tool is active.</p>' +
      '</div>' +
      '<div class="cb-help-section">' +
        '<div class="cb-help-section-title">Data Points</div>' +
        '<p>Data points represent the fields your customer wants. Click the canvas to add one. Hold modifier keys to create <strong>Input</strong> or <strong>Comment</strong> cards instead.</p>' +
      '</div>' +
      '<div class="cb-help-section">' +
        '<div class="cb-help-section-title">Enrichments</div>' +
        '<p>Enrichments are provider calls that return data points. Click the canvas to open the enrichment picker. You can also <strong>double-click a data point</strong> to add enrichments linked to it.</p>' +
      '</div>' +
      '<div class="cb-help-section">' +
        '<div class="cb-help-section-title">Linking &amp; Grouping</div>' +
        '<p>Select multiple cards, then press <strong>Enter</strong> to snap-link them into a chain, or <strong>Shift+Enter</strong> to group them. Groups display combined credit totals.</p>' +
      '</div>' +
      '<div class="cb-help-section">' +
        '<div class="cb-help-section-title">Cost estimation</div>' +
        '<p>Enter a record count in the <strong>summary bar</strong> at the top to see total estimated credits and actions for your brainstorm.</p>' +
      '</div>';

    const navTipsHtml =
      '<div class="cb-help-section">' +
        '<div class="cb-help-section-title">Navigate mode</div>' +
        '<div class="cb-help-shortcut-list">' +
          '<div class="cb-help-shortcut"><span class="cb-help-shortcut-keys"><kbd>Enter</kbd></span><span class="cb-help-shortcut-desc">Snap-link selected cards</span></div>' +
          '<div class="cb-help-shortcut"><span class="cb-help-shortcut-keys"><kbd>Shift</kbd>+<kbd>Enter</kbd></span><span class="cb-help-shortcut-desc">Group selected cards</span></div>' +
          '<div class="cb-help-shortcut"><span class="cb-help-shortcut-keys"><kbd>Delete</kbd>/<kbd>\u232B</kbd></span><span class="cb-help-shortcut-desc">Remove cards or disband group</span></div>' +
          '<div class="cb-help-shortcut"><span class="cb-help-shortcut-keys">Right <kbd>Click</kbd></span><span class="cb-help-shortcut-desc">Context menu when multiple cards are selected</span></div>' +
          '<div class="cb-help-shortcut"><span class="cb-help-shortcut-keys">Right <kbd>Click</kbd> canvas</span><span class="cb-help-shortcut-desc">Recenter view on all cards</span></div>' +
        '</div>' +
      '</div>';

    const dpTipsHtml =
      '<div class="cb-help-section">' +
        '<div class="cb-help-section-title">Data Points mode</div>' +
        '<div class="cb-help-shortcut-list">' +
          '<div class="cb-help-shortcut"><span class="cb-help-shortcut-keys"><kbd>Shift</kbd> + <kbd>Click</kbd></span><span class="cb-help-shortcut-desc">Bulk input (comma-separated)</span></div>' +
          '<div class="cb-help-shortcut"><span class="cb-help-shortcut-keys"><kbd>\u2325 Alt</kbd> + <kbd>Click</kbd></span><span class="cb-help-shortcut-desc">Create a comment card</span></div>' +
          '<div class="cb-help-shortcut"><span class="cb-help-shortcut-keys"><kbd>\u2318 Cmd</kbd> + <kbd>Click</kbd></span><span class="cb-help-shortcut-desc">Create an input card</span></div>' +
          '<div class="cb-help-shortcut"><span class="cb-help-shortcut-keys">Double <kbd>Click</kbd> enrichment</span><span class="cb-help-shortcut-desc">Open bulk input next to it</span></div>' +
        '</div>' +
      '</div>';

    const erTipsHtml =
      '<div class="cb-help-section">' +
        '<div class="cb-help-section-title">Enrichments mode</div>' +
        '<div class="cb-help-shortcut-list">' +
          '<div class="cb-help-shortcut"><span class="cb-help-shortcut-keys">Double <kbd>Click</kbd> data point</span><span class="cb-help-shortcut-desc">Add enrichments linked to it</span></div>' +
        '</div>' +
      '</div>';

    const generalTipsHtml =
      '<div class="cb-help-section">' +
        '<div class="cb-help-section-title">General</div>' +
        '<div class="cb-help-shortcut-list">' +
          '<div class="cb-help-shortcut cb-help-shortcut-full"><span class="cb-help-shortcut-keys"><kbd>Space</kbd></span><span class="cb-help-shortcut-desc">Toggle this help panel</span></div>' +
          '<div class="cb-help-shortcut"><span class="cb-help-shortcut-keys"><kbd>1</kbd> <kbd>2</kbd> <kbd>3</kbd></span><span class="cb-help-shortcut-desc">Switch tool</span></div>' +
          '<div class="cb-help-shortcut"><span class="cb-help-shortcut-keys"><kbd>Esc</kbd></span><span class="cb-help-shortcut-desc">Navigate mode</span></div>' +
          '<div class="cb-help-shortcut"><span class="cb-help-shortcut-keys"><kbd>\u2318</kbd>+<kbd>Z</kbd></span><span class="cb-help-shortcut-desc">Undo</span></div>' +
          '<div class="cb-help-shortcut"><span class="cb-help-shortcut-keys"><kbd>\u2318</kbd>+<kbd>Shift</kbd>+<kbd>Z</kbd></span><span class="cb-help-shortcut-desc">Redo</span></div>' +
        '</div>' +
      '</div>';

    function buildTipsHtml(mode) {
      let section = navTipsHtml;
      if (mode === "dp") section = dpTipsHtml;
      else if (mode === "er") section = erTipsHtml;
      return section + generalTipsHtml;
    }

    helpContent.innerHTML = instructionsHtml;

    function setHelpTab(tab) {
      instructionsTab.classList.toggle("cb-help-tab-active", tab === "instructions");
      tipsTab.classList.toggle("cb-help-tab-active", tab === "tips");
      if (tab === "tips") {
        const canvas = __cb.canvas;
        const mode = getModeFromTool(canvas ? canvas.getActiveTool() : null);
        helpContent.innerHTML = buildTipsHtml(mode);
      } else {
        helpContent.innerHTML = instructionsHtml;
      }
    }

    instructionsTab.addEventListener("click", () => setHelpTab("instructions"));
    tipsTab.addEventListener("click", () => setHelpTab("tips"));

    helpBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const isOpen = helpPopover.classList.toggle("cb-help-popover-open");
      helpBtn.classList.toggle("cb-help-btn-open", isOpen);
    });

    __cb._closeHelpPopover = function (e) {
      if (helpPopover.classList.contains("cb-help-popover-pinned")) return;
      if (!helpWrap.contains(e.target)) {
        helpPopover.classList.remove("cb-help-popover-open");
        helpBtn.classList.remove("cb-help-btn-open");
      }
    };
    document.addEventListener("mousedown", __cb._closeHelpPopover);

    helpPopover.appendChild(helpToggle);
    helpPopover.appendChild(helpContent);
    helpWrap.appendChild(helpBtn);
    helpWrap.appendChild(helpPopover);
    mainArea.appendChild(helpWrap);

    __cb.overlayEl.appendChild(topBar);
    __cb.overlayEl.appendChild(summaryBar);
    __cb.overlayEl.appendChild(mainArea);
    document.body.appendChild(__cb.overlayEl);

    document.addEventListener("keydown", handleEscape);
    document.addEventListener("keydown", handleHelpKey);

    if (__cb.initCanvas) {
      __cb.canvas = __cb.initCanvas(canvasArea);
      __cb.onCanvasStateChange = __cb.debouncedSave;
      __cb.setCanvasMode = setSelectedMode;
      setSelectedMode("navigate");
      updateToolButtons();
    }

    __cb.onEnrichmentToolClick = function (x, y) {
      __cb.enrichmentClickPos = { x, y };
      __cb.startPickerMode();
    };

    __cb.onDpBulkInputForCard = function (cardId) {
      const card = __cb.canvas.getCardById(cardId);
      if (!card) return;
      const w = card.el.offsetWidth || 220;
      __cb.canvas.showBulkInput(card.x + w + 10, card.y);
    };

    const activeTab = __cb.tabStore.tabs.find(t => t.id === __cb.tabStore.activeId);
    if (activeTab?.state && __cb.canvas) {
      __cb.canvas.restore(activeTab.state);
      if (activeTab.state.records) {
        recordsInput.value = activeTab.state.records;
        recordsInput.dispatchEvent(new Event("input"));
      }
    }

    if (initialCards && initialCards.length > 0) {
      for (const card of initialCards) {
        if (__cb.canvas) {
          __cb.canvas.addCard(card);
        }
      }
    }

    window.addEventListener("beforeunload", __cb.saveTabs);
  };

  __cb.closeCanvas = function () {
    if (!__cb.overlayEl) return;
    const ids = __cb.parseIdsFromUrl();
    if (ids) localStorage.removeItem(`cb-open-${ids.workbookId}`);
    __cb.saveTabs();
    __cb.cancelPendingSave();
    if (__cb.canvas) {
      __cb.canvas.destroy();
      __cb.canvas = null;
    }
    __cb.overlayEl.remove();
    __cb.overlayEl = null;
    __cb.resetTabBar();
    __cb.updateCreditTotal = null;
    __cb.onCanvasStateChange = null;
    __cb.onEnrichmentToolClick = null;
    __cb.onDpBulkInputForCard = null;
    __cb.setCanvasMode = null;
    __cb.enrichmentClickPos = null;
    window.removeEventListener("beforeunload", __cb.saveTabs);
    document.removeEventListener("keydown", handleEscape);
    document.removeEventListener("keydown", handleHelpKey);
    if (__cb._closeHelpPopover) {
      document.removeEventListener("mousedown", __cb._closeHelpPopover);
      __cb._closeHelpPopover = null;
    }
  };

  function handleEscape(e) {
    if (e.key !== "Escape") return;
    if (__cb.setCanvasMode) {
      __cb.setCanvasMode("navigate");
    } else if (__cb.canvas) {
      __cb.canvas.setActiveTool(null);
    }
  }

  function handleHelpKey(e) {
    if (e.key !== " " || e.repeat) return;
    const tag = e.target.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || e.target.isContentEditable) return;
    if (!__cb.overlayEl) return;
    const helpPopover = __cb.overlayEl.querySelector(".cb-help-popover");
    const helpBtn = __cb.overlayEl.querySelector(".cb-help-btn");
    if (!helpPopover || !helpBtn) return;
    const isOpen = helpPopover.classList.toggle("cb-help-popover-open");
    helpBtn.classList.toggle("cb-help-btn-open", isOpen);
  }
})();
