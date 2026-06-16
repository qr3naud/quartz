(function () {
  "use strict";

  const __cb = window.__cb;

  let menuEl = null;
  let menuBackdrop = null;
  // Left-flyout submenus (Admin, Archived) — torn down in closeExportMenu.
  let exportSubmenuEls = [];

  const CHEVRON_LEFT_ICON_SVG =
    '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" ' +
    'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" ' +
    'stroke-linejoin="round" aria-hidden="true"><polyline points="15 18 9 12 15 6"/></svg>';

  const GTME_ICON_SVG =
    '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" ' +
    'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" ' +
    'stroke-linejoin="round" aria-hidden="true">' +
    '<rect x="4" y="2" width="16" height="20" rx="2"/>' +
    '<line x1="8" y1="6" x2="16" y2="6"/><line x1="8" y1="10" x2="10" y2="10"/>' +
    '<line x1="14" y1="10" x2="16" y2="10"/><line x1="8" y1="14" x2="10" y2="14"/>' +
    '<line x1="14" y1="14" x2="16" y2="14"/><line x1="8" y1="18" x2="16" y2="18"/></svg>';

  const CSV_ICON_SVG =
    '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" ' +
    'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" ' +
    'stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>' +
    '<polyline points="14 2 14 8 20 8"/></svg>';

  const DEAL_DESK_ICON_SVG =
    '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" ' +
    'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" ' +
    'stroke-linejoin="round" aria-hidden="true">' +
    '<rect x="2" y="7" width="20" height="14" rx="2" ry="2"/>' +
    '<path d="M16 7V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2"/></svg>';

  const LINK_ICON_SVG =
    '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" ' +
    'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" ' +
    'stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>' +
    '<path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>';

  const PACKAGE_ICON_SVG =
    '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" ' +
    'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" ' +
    'stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/>' +
    '<polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>';

  // ---- Menu ----
  //
  // Layout (top → bottom):
  //   • Internal (@clay.com): Export to GTME Calculator (gtme_export flag),
  //     Export to Excel (scoping sheet; auto-includes imported Clay tables).
  //   • Maintainer (__cb.isAdmin): Admin ▶ (Deal Desk, Generate Link) and
  //     Archived ▶ (Export CSV, Package CSVs) — same left-flyout pattern as
  //     the More menu in src/overlay.js.
  // "Import Inspector" lives in the More menu — see __cb.openMoreMenu.

  function closeExportMenu() {
    if (menuEl) { menuEl.remove(); menuEl = null; }
    if (menuBackdrop) { menuBackdrop.remove(); menuBackdrop = null; }
    for (const el of exportSubmenuEls) el.remove();
    exportSubmenuEls = [];
  }

  __cb.closeExportMenu = closeExportMenu;

  function appendExportMenuDivider() {
    const div = document.createElement("div");
    div.className = "cb-export-menu-divider";
    div.setAttribute("role", "separator");
    menuEl.appendChild(div);
  }

  function appendExportAction(opts) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "cb-export-menu-option cb-more-menu-option";
    if (opts.title) item.title = opts.title;
    item.innerHTML =
      `<span class="cb-more-menu-icon">${opts.icon || ""}</span>` +
      `<span class="cb-more-menu-label">${opts.label}</span>`;
    item.addEventListener("click", (evt) => {
      evt.stopPropagation();
      closeExportMenu();
      opts.onClick();
    });
    menuEl.appendChild(item);
    return item;
  }

  // Left-opening flyout submenu — mirrors buildMoreSubmenu in src/overlay.js.
  function buildExportSubmenu(opts) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "cb-export-menu-option cb-more-menu-option cb-more-menu-has-submenu";
    if (opts.title) row.title = opts.title;
    row.innerHTML =
      `<span class="cb-more-menu-icon">${CHEVRON_LEFT_ICON_SVG}</span>` +
      `<span class="cb-more-menu-label">${opts.label}</span>`;

    const submenu = document.createElement("div");
    submenu.className = "cb-export-menu cb-more-menu cb-more-submenu";
    submenu.style.display = "none";
    submenu.addEventListener("mousedown", (evt) => evt.stopPropagation());

    for (const item of opts.items || []) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "cb-export-menu-option cb-more-menu-option";
      if (item.title) b.title = item.title;
      b.innerHTML =
        `<span class="cb-more-menu-icon">${item.icon || ""}</span>` +
        `<span class="cb-more-menu-label">${item.label}</span>`;
      b.addEventListener("click", (evt) => {
        evt.stopPropagation();
        closeExportMenu();
        item.onClick();
      });
      submenu.appendChild(b);
    }

    let hideTimer = null;
    const position = () => {
      const r = row.getBoundingClientRect();
      submenu.style.position = "fixed";
      submenu.style.top = r.top + "px";
      submenu.style.right = Math.max(8, window.innerWidth - r.left + 6) + "px";
      submenu.style.zIndex = "9999999";
    };
    const show = () => {
      clearTimeout(hideTimer);
      for (const other of exportSubmenuEls) {
        if (other !== submenu && other._cbForceHide) other._cbForceHide();
      }
      position();
      submenu.style.display = "block";
      row.classList.add("cb-more-menu-option-active");
    };
    const hide = () => {
      hideTimer = setTimeout(() => {
        submenu.style.display = "none";
        row.classList.remove("cb-more-menu-option-active");
      }, 160);
    };
    submenu._cbForceHide = () => {
      clearTimeout(hideTimer);
      submenu.style.display = "none";
      row.classList.remove("cb-more-menu-option-active");
    };
    row.addEventListener("mouseenter", show);
    row.addEventListener("mouseleave", hide);
    row.addEventListener("click", (evt) => {
      evt.stopPropagation();
      if (submenu.style.display === "none") show();
      else hide();
    });
    submenu.addEventListener("mouseenter", () => clearTimeout(hideTimer));
    submenu.addEventListener("mouseleave", hide);

    exportSubmenuEls.push(submenu);
    document.body.appendChild(submenu);
    return row;
  }

  __cb.openExportMenu = function openExportMenu(anchorEl) {
    closeExportMenu();

    menuBackdrop = document.createElement("div");
    menuBackdrop.style.cssText = "position:fixed;inset:0;z-index:9999998;";
    menuBackdrop.addEventListener("mousedown", (evt) => {
      evt.stopPropagation();
      closeExportMenu();
    });

    menuEl = document.createElement("div");
    menuEl.className = "cb-export-menu cb-more-menu";
    menuEl.addEventListener("mousedown", (evt) => evt.stopPropagation());

    let hasItems = false;
    const isInternal = !!__cb.isInternal;
    const isMaintainer = !!__cb.isAdmin;

    if (isInternal) {
      if (__cb.hasFeature && __cb.hasFeature("gtme_export")) {
        appendExportAction({
          label: "Export to GTME Calculator",
          icon: GTME_ICON_SVG,
          title: "Open the GTME Calculator with this scope pre-filled",
          onClick: () => __cb.openGtmeExportModal(),
        });
        hasItems = true;
      }

      const importedCount = collectUnderlyingTables().length;
      appendExportAction({
        label: "Export to Excel",
        icon: PACKAGE_ICON_SVG,
        title: importedCount
          ? `Scoping sheet plus ${importedCount} imported Clay table${
              importedCount === 1 ? "" : "s"
            }`
          : "Scoping sheet for the active tab",
        onClick: () => __cb.exportScopeExcel(),
      });
      hasItems = true;
    }

    if (isMaintainer) {
      const adminItems = [];
      if (__cb.hasFeature && __cb.hasFeature("gtme_export") && __cb.openDealDeskModal) {
        adminItems.push({
          label: "Export to Deal Desk",
          icon: DEAL_DESK_ICON_SVG,
          title: "Submit pricing to the deal-desk Slack app",
          onClick: () => __cb.openDealDeskModal(),
        });
      }
      if (__cb.hasFeature && __cb.hasFeature("share_links") && __cb.openShareDialog) {
        adminItems.push({
          label: "Generate Link",
          icon: LINK_ICON_SVG,
          title: "Publish a live, shareable scope link",
          onClick: () => __cb.openShareDialog(),
        });
      }

      const archivedItems = [
        {
          label: "Export CSV",
          icon: CSV_ICON_SVG,
          title: "Download the scoping table as CSV",
          onClick: () => __cb.exportCurrentTableCsv(),
        },
        {
          label: "Package CSVs",
          icon: PACKAGE_ICON_SVG,
          title: "Zip the scoping CSV with raw Clay table exports",
          onClick: () => __cb.packageScopeCsvs(),
        },
      ];

      if (adminItems.length || archivedItems.length) {
        if (hasItems) appendExportMenuDivider();
        if (adminItems.length) {
          menuEl.appendChild(
            buildExportSubmenu({
              label: "Admin",
              title: "Maintainer export tools",
              items: adminItems,
            }),
          );
        }
        if (archivedItems.length) {
          menuEl.appendChild(
            buildExportSubmenu({
              label: "Archived",
              title: "Legacy CSV export paths",
              items: archivedItems,
            }),
          );
        }
        hasItems = true;
      }
    }

    if (!hasItems) {
      const empty = document.createElement("button");
      empty.type = "button";
      empty.className = "cb-export-menu-option cb-export-menu-option-disabled";
      empty.textContent = "No export options available";
      empty.disabled = true;
      empty.setAttribute("aria-disabled", "true");
      menuEl.appendChild(empty);
    }

    document.body.appendChild(menuBackdrop);
    document.body.appendChild(menuEl);

    const rect = anchorEl.getBoundingClientRect();
    menuEl.style.position = "fixed";
    menuEl.style.top = (rect.bottom + 6) + "px";
    menuEl.style.right = Math.max(8, window.innerWidth - rect.right) + "px";
    menuEl.style.zIndex = "9999999";
  };

  // ==========================================================================
  // EXPORT TO CSV
  //
  // Downloads the current main table view (src/table-view.js) for the active
  // scoping tab as a CSV, honoring the live Projected/Actual mode. The row
  // matrix comes from __cb.tableView.getExportData(), which reuses the table's
  // own buildRows()/annotateMergeRuns() so the file mirrors exactly what's on
  // screen — including merged-enrichment runs (the Enrichments cell is blank on
  // a run's follower rows, the canonical CSV "merge").
  //
  // Available to internal users via the Export menu; CSV path is under
  // Maintainer → Archived.
  // ==========================================================================

  // Wrap a value for CSV: quote + double inner quotes when it contains a comma,
  // quote, or newline. Mirrors the escaper in src/pricing-comparison.js.
  function csvEscape(value) {
    const s = String(value == null ? "" : value);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }

  // Force-name a text download via a synthetic <a download> click (same pattern
  // as downloadJson below). Revoke the object URL after the click so the Blob
  // doesn't leak until the page closes.
  function downloadTextFile(filename, text, mime) {
    downloadBlob(filename, new Blob([text], { type: mime }));
  }

  function downloadBlob(filename, blob) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  // Filename-safe slug from the active tab name: lowercase, non-alphanumeric ->
  // hyphen, collapse repeats, trim. Falls back to "scoping". Used by package
  // zip naming; scoping CSV/XLSX use resolveScopingExportFilename instead.
  function slugifyTabName(s) {
    const base = String(s || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
    return base || "scoping";
  }

  function activeTabName() {
    const store = __cb.tabStore;
    if (!store || !Array.isArray(store.tabs)) return "";
    const active = store.tabs.find((t) => t.id === store.activeId);
    return active ? active.name || "" : "";
  }

  // Strip characters illegal in download filenames; collapse whitespace.
  function sanitizeFilenamePart(s) {
    return String(s || "")
      .replace(/[\\/:*?"<>|]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function exportDateYmd() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }

  // Customer-facing scoping export name:
  //   YYYY-MM-DD Quartz - Workbook Name - Tab Name.xlsx
  // Workbook name comes from __cb.getWorkbookName (memoized API fetch); when
  // unavailable we omit it: YYYY-MM-DD Quartz - Tab Name.xlsx
  async function resolveScopingExportFilename(tabName, extension, nameSuffix) {
    const ext = String(extension || "xlsx").replace(/^\./, "");
    const suffix = nameSuffix ? ` ${String(nameSuffix).trim()}` : "";
    const tab = (sanitizeFilenamePart(tabName) || "Scoping") + suffix;
    const ids = typeof __cb.parseIdsFromUrl === "function" ? __cb.parseIdsFromUrl() : null;
    const workbookId = __cb.currentWorkbookId ?? ids?.workbookId;
    const workspaceId = ids?.workspaceId;
    let workbookName = "";
    if (__cb.getWorkbookName && workspaceId && workbookId) {
      try {
        workbookName = sanitizeFilenamePart(await __cb.getWorkbookName(workspaceId, workbookId));
      } catch {
        workbookName = "";
      }
    }
    const date = exportDateYmd();
    const parts = workbookName
      ? [`${date} Quartz`, workbookName, tab]
      : [`${date} Quartz`, tab];
    return `${parts.join(" - ")}.${ext}`;
  }

  // Package Excel download: Clay <> [Workspace Name] Quartz Scoping Sheet.xlsx
  async function resolvePackageExportFilename() {
    const ids = typeof __cb.parseIdsFromUrl === "function" ? __cb.parseIdsFromUrl() : null;
    const workspaceId = ids?.workspaceId;
    let workspaceName = "";
    if (__cb.getWorkspaceMeta && workspaceId) {
      try {
        const meta = await __cb.getWorkspaceMeta(workspaceId);
        workspaceName = sanitizeFilenamePart(meta?.name);
      } catch {
        workspaceName = "";
      }
    }
    const namePart = workspaceName ? `${workspaceName} ` : "";
    return `Clay <> ${namePart}Quartz Scoping Sheet.xlsx`;
  }

  async function buildScopingCsvPayload() {
    const data =
      __cb.tableView && __cb.tableView.getExportData
        ? __cb.tableView.getExportData()
        : null;
    if (!data || !data.rows || data.rows.length === 0) return null;

    const columns = data.columns;
    const headerLine = columns.map(csvEscape).join(",");
    const bodyLines = data.rows.map((row) =>
      columns.map((col) => csvEscape(row[col])).join(","),
    );
    const csv = [headerLine, ...bodyLines].join("\n");
    const filename = await resolveScopingExportFilename(activeTabName(), "csv");
    return {
      text: csv,
      filename,
      viewMode: data.viewMode,
      rowCount: data.rows.length,
    };
  }

  __cb.exportCurrentTableCsv = async function exportCurrentTableCsv() {
    // Flush the live canvas into the active tab so getExportData() reads current
    // state (mirrors the GTME export flow).
    if (__cb.saveTabs) __cb.saveTabs();

    const payload = await buildScopingCsvPayload();
    if (!payload) {
      __cb.showOverlayToast?.(
        "Nothing to export \u2014 add data points to this tab first.",
      );
      return;
    }

    downloadTextFile(payload.filename, payload.text, "text/csv;charset=utf-8");

    __cb.showOverlayToast?.(
      `CSV downloaded \u2014 ${payload.viewMode} view, ${payload.rowCount} ${
        payload.rowCount === 1 ? "row" : "rows"
      }.`,
    );
  };

  // ==========================================================================
  // EXPORT TO EXCEL (.xlsx)
  //
  // Styled, section-grouped workbook for the active tab. Reuses the table's
  // section model (__cb.tableView.getXlsxExportData()) and hands it to the
  // ExcelJS writer in src/xlsx-export.js. Invoked directly by exportScopeExcel
  // when no imported tables exist; otherwise packageScopeXlsx builds a multi-
  // sheet workbook.
  // ==========================================================================

  __cb.exportCurrentTableXlsx = async function exportCurrentTableXlsx() {
    if (__cb.saveTabs) __cb.saveTabs();

    if (typeof __cb.buildScopingXlsxBlob !== "function") {
      __cb.showOverlayToast?.("Excel export unavailable \u2014 ExcelJS not loaded.");
      return;
    }

    const data =
      __cb.tableView && __cb.tableView.getXlsxExportData
        ? __cb.tableView.getXlsxExportData()
        : null;
    const sectionRowCount = data
      ? (data.sections || []).reduce(
          (n, s) =>
            n +
            (s.blocks || []).reduce((bn, b) => bn + (b.rows ? b.rows.length : 0), 0),
          0,
        )
      : 0;
    if (!data || sectionRowCount === 0) {
      __cb.showOverlayToast?.(
        "Nothing to export \u2014 add data points to this tab first.",
      );
      return;
    }

    const tabName = activeTabName();
    let blob;
    try {
      blob = await __cb.buildScopingXlsxBlob(data, tabName);
    } catch (err) {
      console.warn("[Clay Scoping] Excel export failed:", err);
      __cb.showOverlayToast?.("Excel export failed \u2014 see console for details.");
      return;
    }

    const filename = await resolveScopingExportFilename(tabName, "xlsx");
    downloadBlob(filename, blob);

    __cb.showOverlayToast?.(
      `Excel downloaded \u2014 ${data.viewMode} view, ${sectionRowCount} ${
        sectionRowCount === 1 ? "row" : "rows"
      }.`,
    );
  };

  // ==========================================================================
  // PACKAGE CSVs
  //
  // Bundles the scoping-summary CSV (same as Export to CSV) with raw Clay table
  // CSVs for every imported underlying table. Clay table exports use the same
  // async export-job API as the Clay UI's "Download CSV" button — no DOM
  // automation. Maintainer → Archived in the Export menu.
  // ==========================================================================

  function sanitizeFilename(name) {
    const base = String(name || "file")
      .replace(/[\\/:*?"<>|]/g, "-")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 120);
    return base || "file";
  }

  // Distinct imported Clay tables in the active scope: { tableId, viewId, name }.
  function collectUnderlyingTables() {
    const imported = __cb.model?.getImportedTables?.() || {};
    const byId = new Map();

    const tops = (__cb.model?.getGroups?.() || []).filter(
      (g) => (g.parentId ?? null) === null && g.tableId,
    );
    for (const g of tops) {
      const meta = imported[g.tableId] || {};
      byId.set(g.tableId, {
        tableId: g.tableId,
        viewId: g.viewId ?? null,
        name: g.label || meta.name || `table-${g.tableId}`,
      });
    }

    for (const n of __cb.model?.getNodes?.() || []) {
      const d = n?.data;
      if (!d?.tableId) continue;
      if (byId.has(d.tableId)) {
        const existing = byId.get(d.tableId);
        if (!existing.viewId && d.viewId) existing.viewId = d.viewId;
        continue;
      }
      const meta = imported[d.tableId] || {};
      byId.set(d.tableId, {
        tableId: d.tableId,
        viewId: d.viewId ?? null,
        name: meta.name || d.tableName || `table-${d.tableId}`,
      });
    }

    for (const [tableId, meta] of Object.entries(imported)) {
      if (byId.has(tableId)) continue;
      byId.set(tableId, {
        tableId,
        viewId: null,
        name: meta.name || `table-${tableId}`,
      });
    }

    return [...byId.values()];
  }

  async function resolveViewIds(entries, workbookId) {
    if (!workbookId || !entries.some((e) => !e.viewId) || !__cb.fetchTableList) {
      return entries;
    }
    try {
      const list = await __cb.fetchTableList(workbookId);
      const tables = list?.tables || list || [];
      const byTableId = new Map(
        (Array.isArray(tables) ? tables : []).map((t) => [t.id, t]),
      );
      for (const entry of entries) {
        if (!entry.viewId) {
          const t = byTableId.get(entry.tableId);
          entry.viewId = t?.firstViewId ?? null;
        }
      }
    } catch (err) {
      console.warn("[Clay Scoping] resolveViewIds failed:", err);
    }
    return entries;
  }

  function sendBgMessage(payload) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(payload, (resp) => {
          if (chrome.runtime.lastError) {
            resolve({ ok: false, error: chrome.runtime.lastError.message });
            return;
          }
          resolve(resp || { ok: false, error: "no response" });
        });
      } catch (err) {
        resolve({ ok: false, error: err?.message || String(err) });
      }
    });
  }

  function base64ToBlob(base64, mime) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new Blob([bytes], { type: mime || "application/octet-stream" });
  }

  // Clay's export job returns a signed S3 URL. Content-script fetch() fails
  // CORS on the export bucket; the Clay UI uses <a download> instead. Route
  // through the service worker (host_permissions on *.s3.us-east-1.amazonaws.com).
  async function fetchExportDownloadBlob(url) {
    if (typeof chrome !== "undefined" && chrome.runtime?.sendMessage) {
      const resp = await sendBgMessage({ type: "cb:export:fetchUrl", url });
      if (resp?.ok && resp.base64) {
        return base64ToBlob(resp.base64, resp.mime);
      }
      throw new Error(resp?.error || `Download failed (${resp?.status ?? "unknown"})`);
    }
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Download failed (${res.status})`);
    return res.blob();
  }

  async function fetchClayTableCsv(entry) {
    let job;
    if (entry.viewId) {
      job = await __cb.startTableViewExport(entry.tableId, entry.viewId);
    } else {
      job = await __cb.startTableExport(entry.tableId);
    }
    const exportId = job?.id;
    if (!exportId) throw new Error("No export job id");

    const finished = await __cb.waitForExportJob(exportId);
    if (!finished.downloadUrl) throw new Error("No download URL");

    const blob = await fetchExportDownloadBlob(finished.downloadUrl);
    const baseName = finished.fileName
      ? String(finished.fileName).replace(/\.csv$/i, "")
      : sanitizeFilename(entry.name);
    return { blob, filename: `${sanitizeFilename(baseName)}.csv` };
  }

  __cb.packageScopeCsvs = async function packageScopeCsvs() {
    if (typeof JSZip === "undefined") {
      __cb.showOverlayToast?.("Package CSVs unavailable \u2014 JSZip not loaded.");
      return;
    }

    if (__cb.saveTabs) __cb.saveTabs();

    const scoping = await buildScopingCsvPayload();
    if (!scoping) {
      __cb.showOverlayToast?.(
        "Nothing to export \u2014 add data points to this tab first.",
      );
      return;
    }

    const ids = __cb.parseIdsFromUrl?.();
    const workbookId = __cb.currentWorkbookId ?? ids?.workbookId;
    const underlying = collectUnderlyingTables();
    if (underlying.length && workbookId) {
      await resolveViewIds(underlying, workbookId);
    }

    const total = 1 + underlying.length;
    __cb.showOverlayToast?.(
      underlying.length
        ? `Packaging ${total} CSVs\u2026`
        : "Packaging scoping CSV (no imported tables in this scope)\u2026",
    );

    const zip = new JSZip();
    zip.file(scoping.filename, scoping.text);

    let tableSuccess = 0;
    let tableFailed = 0;

    for (let i = 0; i < underlying.length; i++) {
      const entry = underlying[i];
      __cb.showOverlayToast?.(
        `Exporting table ${i + 1}/${underlying.length}: ${entry.name}\u2026`,
      );
      try {
        const { blob, filename } = await fetchClayTableCsv(entry);
        zip.file(`tables/${filename}`, blob);
        tableSuccess++;
      } catch (err) {
        console.warn(
          "[Clay Scoping] Package CSVs table export failed:",
          entry.tableId,
          err,
        );
        tableFailed++;
      }
    }

    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const zipName = `clay-scoping-package-${slugifyTabName(activeTabName())}-${stamp}.zip`;

    try {
      const zipBlob = await zip.generateAsync({ type: "blob" });
      downloadBlob(zipName, zipBlob);
    } catch (err) {
      console.warn("[Clay Scoping] Package CSVs zip failed:", err);
      __cb.showOverlayToast?.("Package failed \u2014 could not build zip file.");
      return;
    }

    const parts = ["scoping CSV"];
    if (tableSuccess) {
      parts.push(
        `${tableSuccess} table CSV${tableSuccess === 1 ? "" : "s"}`,
      );
    }
    if (tableFailed) {
      parts.push(`${tableFailed} table export${tableFailed === 1 ? "" : "s"} failed`);
    }
    __cb.showOverlayToast?.(`Downloaded package \u2014 ${parts.join(", ")}.`);
  };

  // ==========================================================================
  // PACKAGE EXCEL (.xlsx)
  //
  // One workbook: styled scoping tab (same as Export to Excel) plus one plain
  // sheet per imported Clay table (CSV → rows). Sibling to Package CSVs while
  // testing; may replace the zip flow after approval.
  // ==========================================================================

  __cb.packageScopeXlsx = async function packageScopeXlsx() {
    if (typeof __cb.buildPackageXlsxBlob !== "function") {
      __cb.showOverlayToast?.("Package Excel unavailable \u2014 ExcelJS not loaded.");
      return;
    }

    if (__cb.saveTabs) __cb.saveTabs();

    const scopingData =
      __cb.tableView && __cb.tableView.getXlsxExportData
        ? __cb.tableView.getXlsxExportData()
        : null;
    const sectionRowCount = scopingData
      ? (scopingData.sections || []).reduce(
          (n, s) =>
            n +
            (s.blocks || []).reduce((bn, b) => bn + (b.rows ? b.rows.length : 0), 0),
          0,
        )
      : 0;
    if (!scopingData || sectionRowCount === 0) {
      __cb.showOverlayToast?.(
        "Nothing to export \u2014 add data points to this tab first.",
      );
      return;
    }

    const tabName = activeTabName();
    const ids = __cb.parseIdsFromUrl?.();
    const workbookId = __cb.currentWorkbookId ?? ids?.workbookId;
    const underlying = collectUnderlyingTables();
    if (underlying.length && workbookId) {
      await resolveViewIds(underlying, workbookId);
    }

    const totalSheets = 1 + underlying.length;
    __cb.showOverlayToast?.(
      underlying.length
        ? `Building Excel package (${totalSheets} sheets)\u2026`
        : "Building Excel package (scoping sheet only)\u2026",
    );

    const tableSheets = [];
    let tableSuccess = 0;
    let tableFailed = 0;

    for (let i = 0; i < underlying.length; i++) {
      const entry = underlying[i];
      __cb.showOverlayToast?.(
        `Exporting table ${i + 1}/${underlying.length}: ${entry.name}\u2026`,
      );
      try {
        const { blob } = await fetchClayTableCsv(entry);
        const csvText = await blob.text();
        tableSheets.push({ name: entry.name, csvText });
        tableSuccess++;
      } catch (err) {
        console.warn(
          "[Clay Scoping] Package Excel table export failed:",
          entry.tableId,
          err,
        );
        tableFailed++;
      }
    }

    let packageBlob;
    try {
      packageBlob = await __cb.buildPackageXlsxBlob({
        scopingData,
        tabName,
        tables: tableSheets,
      });
    } catch (err) {
      console.warn("[Clay Scoping] Package Excel build failed:", err);
      __cb.showOverlayToast?.("Package Excel failed \u2014 see console for details.");
      return;
    }

    const filename = await resolvePackageExportFilename();
    downloadBlob(filename, packageBlob);

    const parts = ["scoping sheet"];
    if (tableSuccess) {
      parts.push(
        `${tableSuccess} table sheet${tableSuccess === 1 ? "" : "s"}`,
      );
    }
    if (tableFailed) {
      parts.push(`${tableFailed} table export${tableFailed === 1 ? "" : "s"} failed`);
    }
    __cb.showOverlayToast?.(`Downloaded Excel package \u2014 ${parts.join(", ")}.`);
  };

  // Smart Excel export for internal users: one menu row that packages imported
  // Clay tables when any exist in the scope, otherwise downloads the scoping
  // sheet alone (same as exportCurrentTableXlsx).
  __cb.exportScopeExcel = async function exportScopeExcel() {
    if (collectUnderlyingTables().length > 0) {
      return __cb.packageScopeXlsx();
    }
    return __cb.exportCurrentTableXlsx();
  };

  // ==========================================================================
  // EXPORT TO GTME CALCULATOR
  //
  // Gated by the `gtme_export` feature flag — the menu row that triggers
  // this modal only renders for internal users in openExportMenu above.
  //
  // Flow:
  //   1. saveTabs() — flushes the live canvas into __cb.tabStore.tabs[i].state
  //      so the active tab's volumes are current.
  //   2. Modal: customer name + contract length (default 12 months) + tab
  //      checklist with per-tab volume preview.
  //   3. On submit: encode payload (base64url), open
  //      `${GTME_CALCULATOR_BASE_URL}/import?payload=...` in a new tab. The
  //      calculator handles auth, account creation, and config insertion
  //      (see apps/gtme-calculator/apps/mono-calculator/src/components/import).
  // ==========================================================================

  let gtmeModalEl = null;
  let gtmeModalBackdrop = null;

  function closeGtmeExportModal() {
    if (gtmeModalEl) { gtmeModalEl.remove(); gtmeModalEl = null; }
    if (gtmeModalBackdrop) { gtmeModalBackdrop.remove(); gtmeModalBackdrop = null; }
    document.removeEventListener("keydown", onGtmeModalKeydown);
  }

  __cb.closeGtmeExportModal = closeGtmeExportModal;

  function onGtmeModalKeydown(evt) {
    if (evt.key === "Escape") {
      evt.stopPropagation();
      closeGtmeExportModal();
    }
  }

  // ---- Compute per-tab year-1 volumes ----

  // Strips currency formatting ("$0.05" → 0.05) and returns a positive
  // number, or null if parsing failed. Mirrors parseDollar() in overlay.js
  // so prices read from a saved tab match what overlay.js renders.
  function parseDollarValue(raw) {
    if (raw == null) return null;
    const n = parseFloat(String(raw).replace(/[^\d.]/g, ""));
    return Number.isFinite(n) && n > 0 ? n : null;
  }

  // Per-tab year-1 volumes for export / deal-desk, computed off a serialized
  // tab.state (so it works for tabs the user isn't currently viewing) via the
  // shared cost-model.computeTabTotals — identical to what the table shows for
  // that tab. Also returns the per-tab credit/action prices the rep set in the
  // summary bar (null when the tab predates the price inputs or has no value),
  // and the tab's `mode` (projected/actual). Prices are adjusted (negotiated)
  // prices, not list: the calculator slots them into adjustedCPC /
  // adjustedYear1CPA so the discount band reflects what the rep is pitching,
  // while list prices keep their canonical policy values.
  function computeTabVolumes(tabState) {
    if (!tabState || !Array.isArray(tabState.cards)) {
      return {
        creditsPerYear: 0,
        actionsPerYear: 0,
        creditPrice: null,
        actionPrice: null,
        mode: "projected",
      };
    }
    // Single source of truth: cost-model.computeTabTotals reproduces exactly what
    // the table/summary shows for this tab — coverage, per-use-case records +
    // frequency (multi-table), "other" excluded — in the tab's own saved view
    // mode (Projected catalog, or Actual measured spend scaled to Records). This
    // is what both the GTME calculator export and the Deal Desk submission send.
    const mode = tabState.viewMode === "actual" ? "actual" : "projected";
    const totals = window.__cb.cost.computeTabTotals(tabState, { viewMode: mode });

    return {
      creditsPerYear: totals.creditsPerYear,
      actionsPerYear: totals.actionsPerYear,
      creditPrice: parseDollarValue(tabState.creditCost),
      actionPrice: parseDollarValue(tabState.actionCost),
      mode,
    };
  }

  // Exposed so src/deal-desk.js can build the same per-tab volumes/prices
  // without duplicating the cost-model walk.
  __cb.computeTabVolumes = computeTabVolumes;

  // ---- base64url encode a UTF-8 string ----

  function encodePayload(obj) {
    const json = JSON.stringify(obj);
    const utf8 = new TextEncoder().encode(json);
    let bin = "";
    for (let i = 0; i < utf8.length; i++) bin += String.fromCharCode(utf8[i]);
    return btoa(bin)
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  }

  // ---- Modal ----

  __cb.openGtmeExportModal = function openGtmeExportModal() {
    closeGtmeExportModal();

    // Flush the active tab so its in-memory state matches what the user
    // sees. Other tabs are already in sync with their last-active save.
    if (__cb.saveTabs) __cb.saveTabs();

    const visibleTabs = (__cb.tabStore?.tabs || []).filter((t) => !t.hidden);
    const activeTabId = __cb.tabStore?.activeId;

    // Per-tab state: { id -> { tab, checked, volumes } }. We build it once
    // upfront so re-rendering the table after a checkbox toggle is cheap.
    const rowState = new Map();
    for (const tab of visibleTabs) {
      rowState.set(tab.id, {
        tab,
        checked: tab.id === activeTabId,
        volumes: computeTabVolumes(tab.state),
      });
    }

    let customerName = "";
    // Contract length is fixed at 12 months for now. The calculator's
    // contractYears comes from this; year2/year3 stay zeroed. If we ever
    // want multi-year exports we'd reintroduce the editable input.
    const contractLengthMonths = 12;
    let submitting = false;

    gtmeModalBackdrop = document.createElement("div");
    gtmeModalBackdrop.className = "cb-export-modal-backdrop";
    gtmeModalBackdrop.addEventListener("mousedown", (evt) => {
      if (evt.target === gtmeModalBackdrop) closeGtmeExportModal();
    });

    gtmeModalEl = document.createElement("div");
    gtmeModalEl.className = "cb-export-modal cb-gtme-modal";

    // ---- Header ----
    const header = document.createElement("div");
    header.className = "cb-export-modal-header";
    const titleWrap = document.createElement("div");
    titleWrap.className = "cb-export-modal-title-wrap";
    const title = document.createElement("h2");
    title.className = "cb-export-modal-title";
    title.textContent = "Export to GTME Calculator";
    const subtitle = document.createElement("div");
    subtitle.className = "cb-export-modal-subtitle";
    subtitle.textContent = "Creates a customer account and one pricing config per scoping tab.";
    titleWrap.appendChild(title);
    titleWrap.appendChild(subtitle);

    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "cb-export-modal-close";
    closeBtn.setAttribute("aria-label", "Close");
    closeBtn.innerHTML =
      '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
    closeBtn.addEventListener("click", closeGtmeExportModal);

    header.appendChild(titleWrap);
    header.appendChild(closeBtn);

    // ---- Body ----
    const body = document.createElement("div");
    body.className = "cb-export-modal-body cb-gtme-body";

    // Form fields (customer name + contract length).
    const fieldsRow = document.createElement("div");
    fieldsRow.className = "cb-gtme-fields";

    const nameField = document.createElement("label");
    nameField.className = "cb-gtme-field cb-gtme-field-grow";
    const nameLabel = document.createElement("span");
    nameLabel.className = "cb-gtme-field-label";
    nameLabel.textContent = "Customer name";
    const nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.className = "cb-gtme-input";
    nameInput.placeholder = "e.g. Acme Corp";
    nameInput.autocomplete = "off";
    nameInput.addEventListener("input", () => {
      customerName = nameInput.value;
      updateSubmitState();
    });
    nameField.appendChild(nameLabel);
    nameField.appendChild(nameInput);

    // Contract length is read-only — show it as a static chip so the user
    // sees what will be sent to the calculator without being able to edit
    // it. Title attribute explains the rationale on hover.
    const contractField = document.createElement("div");
    contractField.className = "cb-gtme-field";
    const contractLabel = document.createElement("span");
    contractLabel.className = "cb-gtme-field-label";
    contractLabel.textContent = "Contract length";
    const contractValue = document.createElement("span");
    contractValue.className = "cb-gtme-static-value";
    contractValue.textContent = "1 year";
    contractValue.title = "Contract length is fixed at 1 year for Clay exports.";
    contractField.appendChild(contractLabel);
    contractField.appendChild(contractValue);

    fieldsRow.appendChild(nameField);
    fieldsRow.appendChild(contractField);
    body.appendChild(fieldsRow);

    // Tab picker.
    const tabsHeader = document.createElement("div");
    tabsHeader.className = "cb-gtme-tabs-header";
    const tabsTitle = document.createElement("div");
    tabsTitle.className = "cb-gtme-tabs-title";
    tabsTitle.textContent = "Tabs to export";
    const tabsHint = document.createElement("div");
    tabsHint.className = "cb-gtme-tabs-hint";
    tabsHint.textContent = "Each checked tab becomes one pricing config.";
    tabsHeader.appendChild(tabsTitle);
    tabsHeader.appendChild(tabsHint);
    body.appendChild(tabsHeader);

    const tabsContainer = document.createElement("div");
    tabsContainer.className = "cb-gtme-tabs";
    body.appendChild(tabsContainer);

    function renderTabs() {
      tabsContainer.innerHTML = "";
      if (visibleTabs.length === 0) {
        const empty = document.createElement("div");
        empty.className = "cb-export-empty";
        empty.textContent = "No scoping tabs to export. Create one first.";
        tabsContainer.appendChild(empty);
        return;
      }

      for (const tab of visibleTabs) {
        const row = rowState.get(tab.id);
        const item = document.createElement("label");
        item.className = "cb-gtme-tab-row" + (row.checked ? " cb-gtme-tab-row-checked" : "");

        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.checked = row.checked;
        cb.addEventListener("change", () => {
          row.checked = cb.checked;
          item.classList.toggle("cb-gtme-tab-row-checked", cb.checked);
          updateSubmitState();
        });

        const meta = document.createElement("div");
        meta.className = "cb-gtme-tab-meta";

        const hasVolume =
          row.volumes.creditsPerYear !== 0 || row.volumes.actionsPerYear !== 0;

        // Title row: tab name + an inline mode pill (white, indigo for Projected
        // / green for Actual) so the rep sees at a glance how each tab exports.
        const titleRow = document.createElement("div");
        titleRow.className = "cb-gtme-tab-title";
        const nm = document.createElement("div");
        nm.className = "cb-gtme-tab-name";
        nm.textContent = tab.name || "Scoping";
        titleRow.appendChild(nm);
        if (hasVolume) {
          const isActual = row.volumes.mode === "actual";
          const modePill = document.createElement("span");
          modePill.className =
            "cb-gtme-mode-pill " +
            (isActual ? "cb-gtme-mode-pill-actual" : "cb-gtme-mode-pill-projected");
          modePill.textContent = isActual ? "Actual" : "Projected";
          titleRow.appendChild(modePill);
        }
        meta.appendChild(titleRow);

        if (!hasVolume) {
          const stats = document.createElement("div");
          stats.className = "cb-gtme-tab-stats cb-gtme-tab-stats-empty";
          stats.textContent = "No volume yet — add records and enrichments to this tab.";
          meta.appendChild(stats);
        } else {
          // Reuse the canvas/table cost pill (actions | credits) plus a $ total
          // pill, so the modal reads the same as the table. Total uses the tab's
          // negotiated credit/action prices (defaults match the summary bar).
          const pills = document.createElement("div");
          pills.className = "cb-gtme-tab-pills";
          if (__cb.buildCostBadges) {
            pills.appendChild(
              __cb.buildCostBadges(row.volumes.creditsPerYear, row.volumes.actionsPerYear),
            );
          }
          const creditPrice = row.volumes.creditPrice != null ? row.volumes.creditPrice : 0.05;
          const actionPrice = row.volumes.actionPrice != null ? row.volumes.actionPrice : 0.008;
          const dollars =
            row.volumes.creditsPerYear * creditPrice +
            row.volumes.actionsPerYear * actionPrice;
          const dol = document.createElement("span");
          dol.className = "cb-gtme-tab-dollar";
          dol.title = "Total cost / yr at the tab's credit & action prices";
          dol.innerHTML =
            (__cb.dollarSvg ? __cb.dollarSvg(12) : "$") +
            `<span>${Math.round(dollars).toLocaleString()}</span>`;
          pills.appendChild(dol);
          meta.appendChild(pills);
        }

        // Surface the per-tab credit/action prices we'll inject into the
        // calculator's adjusted (year-1) price fields. Only render when at
        // least one is set so blank tabs stay visually quiet.
        if (row.volumes.creditPrice != null || row.volumes.actionPrice != null) {
          const prices = document.createElement("div");
          prices.className = "cb-gtme-tab-prices";
          const parts = [];
          if (row.volumes.creditPrice != null) {
            parts.push(`$${row.volumes.creditPrice} / credit`);
          }
          if (row.volumes.actionPrice != null) {
            parts.push(`$${row.volumes.actionPrice} / action`);
          }
          prices.textContent = parts.join(" · ");
          meta.appendChild(prices);
        }

        item.appendChild(cb);
        item.appendChild(meta);
        tabsContainer.appendChild(item);
      }
    }

    // Optional inline error surface. Shown when window.open is blocked or
    // the payload is too long.
    const errorEl = document.createElement("div");
    errorEl.className = "cb-gtme-error";
    errorEl.style.display = "none";
    body.appendChild(errorEl);

    function showError(msg) {
      errorEl.textContent = msg;
      errorEl.style.display = "";
    }

    function clearError() {
      errorEl.textContent = "";
      errorEl.style.display = "none";
    }

    // ---- Footer ----
    const footer = document.createElement("div");
    footer.className = "cb-export-modal-footer";
    const footerHint = document.createElement("div");
    footerHint.className = "cb-export-modal-footer-hint";
    footerHint.textContent = "Opens the GTME Calculator in a new tab with everything pre-filled.";

    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.className = "cb-export-modal-done";
    cancelBtn.textContent = "Cancel";
    cancelBtn.addEventListener("click", closeGtmeExportModal);

    const submitBtn = document.createElement("button");
    submitBtn.type = "button";
    submitBtn.className = "cb-export-submit";
    submitBtn.textContent = "Export";
    submitBtn.addEventListener("click", () => {
      if (submitting) return;
      const selected = visibleTabs.filter((t) => rowState.get(t.id).checked);
      if (selected.length === 0 || !customerName.trim()) return;

      submitting = true;
      submitBtn.disabled = true;
      clearError();

      const payload = {
        v: 1,
        customerName: customerName.trim(),
        contractLengthMonths,
        source: {
          kind: "quartz",
          workbookId: __cb.currentWorkbookId || undefined,
          exportedAt: new Date().toISOString(),
        },
        configs: selected.map((tab) => {
          const volumes = rowState.get(tab.id).volumes;
          const config = {
            name: tab.name || "Scoping",
            creditsPerYear: volumes.creditsPerYear,
            actionsPerYear: volumes.actionsPerYear,
            // Whether these volumes are the Projected estimate or Actual measured
            // spend (per-tab), so the calculator can label/trace the basis.
            basis: volumes.mode || "projected",
          };
          // Only attach prices when the user explicitly set them in this
          // tab. Sending undefined would still serialize as missing keys,
          // but explicit omission keeps the URL payload smaller.
          if (volumes.creditPrice != null) {
            config.creditPrice = volumes.creditPrice;
          }
          if (volumes.actionPrice != null) {
            config.actionPrice = volumes.actionPrice;
          }
          return config;
        }),
      };

      let encoded;
      try {
        encoded = encodePayload(payload);
      } catch (err) {
        submitting = false;
        submitBtn.disabled = false;
        showError("Could not serialize the export payload. Please try again.");
        console.error("[Clay Scoping] GTME export encode failed", err);
        return;
      }

      // Defensive: if the constant was wiped (e.g. local edit reverted),
      // refuse to open a URL that would be relative to the current page —
      // that would silently land the user back on app.clay.com instead of
      // the calculator. We require a real http(s) origin or we abort.
      const rawBase = (__cb.GTME_CALCULATOR_BASE_URL || "").trim();
      if (!/^https?:\/\//i.test(rawBase)) {
        submitting = false;
        submitBtn.disabled = false;
        showError("GTME calculator URL is not configured. Set GTME_CALCULATOR_BASE_URL in src/config.js.");
        console.error("[Clay Scoping] GTME export aborted: invalid GTME_CALCULATOR_BASE_URL =", rawBase);
        return;
      }
      const base = rawBase.replace(/\/+$/, "");
      const url = `${base}/import?payload=${encoded}`;
      // Intentionally NOT passing "noopener,noreferrer" in the third arg:
      // when noopener is set, window.open returns null even on success
      // (per the WHATWG spec — the whole point of noopener is severing the
      // opener<->openee reference). We need a meaningful return value to
      // distinguish "popup blocked" from "popup opened", so we accept the
      // small tradeoff that the calculator can read window.opener — that's
      // safe because the calculator is our own code, not an arbitrary site.
      const opened = window.open(url, "_blank");
      if (!opened) {
        submitting = false;
        submitBtn.disabled = false;
        showError("Browser blocked the popup. Allow popups for app.clay.com and try again.");
        return;
      }

      closeGtmeExportModal();
    });

    const footerActions = document.createElement("div");
    footerActions.className = "cb-export-footer-actions";
    footerActions.appendChild(cancelBtn);
    footerActions.appendChild(submitBtn);

    footer.appendChild(footerHint);
    footer.appendChild(footerActions);

    // Disabled until a name and at least one tab are present.
    function updateSubmitState() {
      const hasName = customerName.trim().length > 0;
      const hasTab = visibleTabs.some((t) => rowState.get(t.id).checked);
      submitBtn.disabled = !hasName || !hasTab || submitting;
    }

    gtmeModalEl.appendChild(header);
    gtmeModalEl.appendChild(body);
    gtmeModalEl.appendChild(footer);
    gtmeModalBackdrop.appendChild(gtmeModalEl);
    document.body.appendChild(gtmeModalBackdrop);

    document.addEventListener("keydown", onGtmeModalKeydown);

    renderTabs();
    updateSubmitState();
    requestAnimationFrame(() => nameInput.focus());
  };

  // ==========================================================================
  // EXPORT AS JSON
  //
  // Three-way endpoint picker for getting a Clay table's structure + stats
  // out as JSON. The same data the table-import flow consumes — surfaced
  // here so reps can grab it without going through the canvas.
  //
  //   1. Sculptor in-table — one cheap call. Schema-only on big tables.
  //   2. Full preset       — one richer (slower) call. Adds status counts,
  //                          example values, error analysis, policy credit
  //                          costs. No view filter, no actual spend.
  //   3. Combined join     — four parallel calls joined per fieldId, exact
  //                          shape the import flow uses. Adds view-filtered
  //                          record count and Redshift-backed real spend.
  //
  // Right column shows either a hand-written schema sample (so users can
  // download/inspect the shape without touching the network) or the live
  // payload for the active table. Live mode reports wall-clock latency in
  // the header chip — for the combined option it also flags the slowest
  // leg, since the four legs run in parallel.
  // ==========================================================================

  let jsonModalEl = null;
  let jsonModalBackdrop = null;

  // Per-endpoint metadata that drives the left-column explanation block.
  // Kept as a plain array so the renderer can iterate it once and so adding
  // a fourth option in the future is a one-row diff.
  // The import flow's API calls, in execution order, grouped into the
  // Projected phase (everything needed to show rows immediately) and the
  // Actual phase (ground-truth spend, fetched in the background). The leading
  // "breakdown" entry isn't a call — it's the readable "what's being imported"
  // view the right pane shows by default. Field names (summary / whatYouGet /
  // tradeoffs / whenToUse / calls) match what renderExplain consumes.
  const IMPORT_FLOW_STEPS = [
    {
      id: "breakdown",
      phase: "summary",
      label: "What's being imported",
      tag: "readable",
      fetchable: false,
      summary:
        "The decision set the import stamps onto the table view — per field: projected credits/row, coverage, fill rate, then real billed spend once the Actual leg lands.",
      whatYouGet: [
        "Resolved billing plan (legacy vs modern) used for projected credits",
        "Counts: standalone enrichments, waterfalls, basic groups, inputs",
        "Per-field projected credits/row, coverage (ran/total), fill rate",
        "Actual spend per field once the background leg returns",
      ],
      tradeoffs: [
        "Projected uses the model-aware catalog cost; Actual is 30-day Redshift spend",
        "Coverage/fill come from run-status counts (exact); basic-field fill is sampled",
      ],
      whenToUse: "Default view — see exactly what the table-view import produces.",
      calls: ["(computed from the steps below — no call of its own)"],
    },
    {
      id: "catalog",
      phase: "projected",
      label: "Action catalog",
      tag: "cached · 24h",
      fetchable: true,
      summary:
        "Enrichment catalog: base credits per action (both pricing tiers), AI detection, and action-execution flags. Cached in localStorage for 24h.",
      whatYouGet: [
        "Per-action base credits (modern + legacy tiers)",
        "AI detection + model options",
        "actionExecution + private-key credit flags",
      ],
      tradeoffs: ["Cached up to 24h — a brand-new action can be a day stale"],
      whenToUse: "Inspect the catalog entry behind any imported enrichment.",
      calls: ["GET /v3/actions?workspaceId=:ws"],
    },
    {
      id: "modelpricing",
      phase: "projected",
      label: "AI model pricing",
      tag: "cached · 24h",
      fetchable: true,
      summary:
        "Per-model AI credit costs, workspace-scaled. Drives the projected cost of Use AI / Claygent columns. Cached 24h.",
      whatYouGet: ["modelName → base credit cost for the workspace"],
      tradeoffs: ["Cached up to 24h"],
      whenToUse: "Check the per-row cost the canvas uses for a given AI model.",
      calls: ["GET /v3/model-pricing/:ws/base-costs"],
    },
    {
      id: "plan",
      phase: "projected",
      label: "Billing plan",
      tag: "cached · 24h",
      fetchable: true,
      summary:
        "The workspace's active billing plan, classified legacy (pre-2026) vs modern (post-2026). Determines which catalog pricing tier projected credits use.",
      whatYouGet: ["planType", "isLegacy / isModern", "per-credit rate when available"],
      tradeoffs: ["Cached up to 24h"],
      whenToUse: "Confirm which pricing tier the projected credits are computed against.",
      calls: ["GET /v3/billingplans/:ws?source=frontend"],
    },
    {
      id: "tables",
      phase: "projected",
      label: "Table list",
      tag: "1 call",
      fetchable: true,
      summary:
        "The workbook's tables with fields, field groups, and views. Drives the import classification (inputs / waterfalls / basic groups / standalone) and cluster cost-sharing.",
      whatYouGet: ["fields[]", "fieldGroupMap (waterfalls + basic groups)", "views[]"],
      tradeoffs: ["Whole-workbook payload — but the import only reads the open table"],
      whenToUse: "Inspect the raw field + group structure the classifier consumes.",
      calls: ["GET /v3/workbooks/:wb/tables"],
    },
    {
      id: "context",
      phase: "projected",
      label: "Field context (fast)",
      tag: "1 call · small sample",
      fetchable: true,
      summary:
        "The fast /context call: per-field credit cost + run-status coverage/fill, with a small sample size so it skips the all-rows value scan the old `full` preset did.",
      whatYouGet: [
        "Per-field creditCost (ActionCostMetadata)",
        "Coverage + fill from run-status counts (exact, all rows)",
        "Whole-table record count",
      ],
      tradeoffs: [
        "Basic-field value fill is sampled (small sampleSize), not all rows",
        "creditCost is computed legacy-side; modern plans get the catalog tier swapped in",
      ],
      whenToUse: "See the projected per-field cost + coverage the import reads.",
      calls: [
        "POST /v3/workspaces/:ws/tables/:id/context  customOptions { includeCreditCosts, includeStatusCounts, sampleSize: " +
          (__cb.IMPORT_CONTEXT_SAMPLE_SIZE ?? 50) +
          " }",
      ],
    },
    {
      id: "spend",
      phase: "actual",
      label: "Realtime spend",
      tag: "background · ground truth",
      fetchable: true,
      summary:
        "The Actual leg: real billed credits + action executions per column over the last 30 days. Fetched in the background after projected rows render, so toggling Actual is instant.",
      whatYouGet: ["Per-field creditsSpent", "actionExecutionCreditsSpent", "cellCount"],
      tradeoffs: [
        "Only complete since 2025-11-05; older tables under-count",
        "Lags real time by a few minutes (Redshift via Kinesis)",
      ],
      whenToUse: "Compare projected estimates against what Clay actually billed.",
      calls: ["GET /v3/realtime-credit-usage/:ws/table/:id/column/recent?days=30"],
    },
  ];

  // Static sample model shown when no Clay table is open, so the import flow
  // stays explorable offline. Mirrors the live model shape buildInspectorModel
  // returns: { plan, recordCount, counts, fieldRows }.
  const SAMPLE_MODEL = {
    sample: true,
    plan: { planType: "growth", isModern: true, planIsModern: true },
    recordCount: 12480,
    counts: { standalone: 1, waterfalls: 1, basicGroups: 1, inputs: 2 },
    fieldRows: [
      { name: "Full Name", type: "—", group: "Input", projected: null, coverage: null, fill: null, spend: null },
      { name: "Company Domain", type: "—", group: "Input", projected: null, coverage: null, fill: null, spend: null },
      {
        name: "Score Lead (AI)", type: "Enrichment", group: "Standalone",
        projected: 6.8,
        coverage: { ran: 12480, total: 12480 },
        fill: { success: 11900, ran: 12480 },
        spend: { credits: 84864, actionExecutions: 12480, cellCount: 12480 },
      },
      {
        name: "Find Work Email · find_email_apollo", type: "Enrichment", group: "Waterfall",
        projected: 1,
        coverage: { ran: 12480, total: 12480 },
        fill: { success: 7201, ran: 12480 },
        spend: { credits: 7843, actionExecutions: 7901, cellCount: 7931 },
      },
      {
        name: "Find Job Title", type: "Enrichment", group: "Person Enrichment",
        projected: 2,
        coverage: { ran: 12480, total: 12480 },
        fill: { success: 9800, ran: 12480 },
        spend: { credits: 19600, actionExecutions: 9800, cellCount: 9800 },
      },
    ],
  };

  // ---- Inspector model helpers (shared by live + sample rendering) ----

  function inspectorCatalogInfo(field) {
    if (!field?.actionKey) return null;
    const pkg = field.actionPackageId || "clay";
    return (
      __cb.actionByIdLookup?.[`${pkg}-${field.actionKey}`] ||
      __cb.actionByIdLookup?.[`${pkg}/${field.actionKey}`] ||
      null
    );
  }

  // Projected per-row credits for a field, mirroring the import's Layer A:
  // plan-aware catalog base + the server's resolution flags (per-result /
  // private-key / unlimited). Returns null for non-action fields.
  function projectedCreditsForField(field, stats) {
    if (field.type !== "action") return null;
    const info = inspectorCatalogInfo(field);
    const base = info
      ? (__cb.planAwareBaseCredits ? __cb.planAwareBaseCredits(info) : (info.credits ?? null))
      : null;
    if (!stats?.cost) return base;
    if (stats.cost.unlimited || stats.cost.isPrivateKey) return 0;
    const override = __cb.importPlanIsModern && __cb.importPlanIsModern() ? base : null;
    return __cb.resolveEffectiveCredits
      ? __cb.resolveEffectiveCredits(stats.cost, base, override)
      : base;
  }

  function inspectorCounts(decision) {
    return {
      standalone: (decision.standaloneFields || []).length,
      waterfalls: (decision.waterfalls || []).length,
      basicGroups: (decision.basicGroups || []).length,
      inputs: (decision.inputs?.leafInputFields || []).length,
    };
  }

  function contextRecordCount(context) {
    const fromRunInfo = context?.tableRunInfo?.tableRowCount;
    if (typeof fromRunInfo === "number" && fromRunInfo > 0) return fromRunInfo;
    const fc = context?.fieldConfigurationsData?.fieldConfigs?.find(
      (f) => f?.dataProfile?.totalRecords != null
    );
    return fc?.dataProfile?.totalRecords ?? null;
  }

  // Flattens the decision set into readable per-field rows: one row per field,
  // grouped by its role (Input / Standalone / Waterfall / basic group name).
  function buildInspectorFieldRows(decision) {
    if (!decision) return [];
    const joined = decision.joined || {};
    const rows = [];

    // Enrichment display name by lineage key (action field id, or
    // "wf:<groupId>"), so each data point row can show its source enrichment.
    const enrichmentNameByKey = new Map();
    for (const f of decision.standaloneFields || []) enrichmentNameByKey.set(f.id, f.name || f.id);
    for (const bg of decision.basicGroups || []) {
      for (const f of bg.erFields || []) enrichmentNameByKey.set(f.id, f.name || f.id);
    }
    for (const wf of decision.waterfalls || []) {
      enrichmentNameByKey.set(`wf:${wf.groupId}`, wf.name || "Waterfall");
    }

    const push = (field, group, source) => {
      const stats = joined[field.id] || null;
      rows.push({
        name: field.name || field.id,
        type: field.type === "action" ? "Enrichment" : (field.type || "—"),
        group,
        source: source ?? "\u2014",
        projected: projectedCreditsForField(field, stats),
        coverage: stats?.coverage || null,
        fill: stats?.fillRate || null,
        spend: stats?.spend || null,
      });
    };
    for (const f of decision.inputs?.leafInputFields || []) push(f, "Input", "\u2014");
    for (const f of decision.standaloneFields || []) push(f, "Standalone", "\u2014");
    for (const wf of decision.waterfalls || []) {
      for (const s of wf.steps || []) {
        push(
          {
            id: s.fieldId,
            name: `${wf.name || "Waterfall"} \u00b7 ${s.actionKey}`,
            type: "action",
            actionKey: s.actionKey,
            actionPackageId: s.actionPackageId,
          },
          "Waterfall",
          "\u2014"
        );
      }
    }
    for (const bg of decision.basicGroups || []) {
      for (const f of bg.erFields || []) push(f, bg.name || "Group", "\u2014");
    }
    // Data points (lineage) — each shows the enrichment(s) it derives from. A
    // DP can resolve to multiple ancestors (chain/fallback); join their names.
    for (const dp of decision.dataPoints || []) {
      const keys = Array.isArray(dp.sourceEnrichmentFieldIds) && dp.sourceEnrichmentFieldIds.length
        ? dp.sourceEnrichmentFieldIds
        : (dp.sourceEnrichmentFieldId != null ? [dp.sourceEnrichmentFieldId] : []);
      const sourceName =
        keys.map((k) => enrichmentNameByKey.get(k) || k).join(" + ") || "\u2014";
      push({ id: dp.id, name: dp.name, type: "data point" }, "Data point", sourceName);
    }
    return rows;
  }

  // Builds the readable inspector model from the live legs. Spend is optional
  // — pass null for the projected-first pass, then rebuild with spend once the
  // Actual leg lands.
  function buildInspectorModel({ table, context, spend, viewId }) {
    const decision = __cb.buildImportDecisionSet({ table, viewId, context, spend });
    return {
      plan: __cb.currentPlanPricing || null,
      recordCount: contextRecordCount(context),
      counts: inspectorCounts(decision),
      fieldRows: buildInspectorFieldRows(decision),
      decision,
    };
  }

  // Pulls workspace / workbook / table / view IDs out of the current Clay URL
  // path. parseIdsFromUrl in config.js stops at workbook — it's wired into
  // the canvas which doesn't care about the table. The export modal does, so
  // we extend it locally rather than retrofit config.js.
  function parseTableIdsFromUrl() {
    const parts = window.location.pathname.split("/");
    const wsIdx = parts.indexOf("workspaces");
    const wbIdx = parts.indexOf("workbooks");
    const tIdx = parts.indexOf("tables");
    const vIdx = parts.indexOf("views");
    if (wsIdx === -1 || wbIdx === -1) return null;
    return {
      workspaceId: parts[wsIdx + 1] || null,
      workbookId: parts[wbIdx + 1] || null,
      tableId: tIdx !== -1 ? parts[tIdx + 1] || null : null,
      viewId: vIdx !== -1 ? parts[vIdx + 1] || null : null,
    };
  }

  // Resolves the full table object (with fields, fieldGroupMap, views) for
  // the Import option. The decision-set helper needs all three to build the
  // group/input classification, so we fetch the same /v3/workbooks/.../tables
  // payload the picker uses. Returns null on failure so the calling fetch
  // branch can surface a graceful error in the preview.
  async function resolveTable(workbookId, tableId) {
    if (!workbookId || !tableId || !__cb.fetchTableList) return null;
    try {
      const list = await __cb.fetchTableList(workbookId);
      const tables = list?.tables || list || [];
      return (Array.isArray(tables) ? tables : []).find((t) => t.id === tableId) || null;
    } catch (err) {
      console.warn("[Clay Scoping] resolveTable failed:", err);
      return null;
    }
  }

  function formatDuration(ms) {
    if (ms == null || !Number.isFinite(ms)) return "—";
    if (ms < 1000) return `${Math.round(ms)} ms`;
    return `${(ms / 1000).toFixed(2)} s`;
  }

  // Tiny HTML-escape pass for safe innerHTML injection. Live JSON payloads
  // can contain user-typed strings with `<` / `&` / quotes (think of a
  // Claygent prompt or a scraped page snippet living in a cell value), so
  // we always escape before wrapping matches in <mark> tags.
  const HTML_ENTITIES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => HTML_ENTITIES[c]);
  }

  function escapeRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  // Builds an HTML string with case-insensitive matches of `query` wrapped
  // in <mark class="cb-export-json-match"> tags, escaping non-match text
  // as we go. Returns the count alongside so the caller can render
  // "N / M" without re-querying the DOM. Empty / no-match queries fall
  // through to a plain escaped string with count = 0.
  function buildHighlightedHtml(text, query) {
    if (!query) return { html: escapeHtml(text), count: 0 };
    const re = new RegExp(escapeRegex(query), "gi");
    let out = "";
    let lastIdx = 0;
    let count = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      // Zero-width matches (shouldn't happen with our literal-escape, but
      // belt + braces) would otherwise spin forever — bump lastIndex.
      if (m[0].length === 0) { re.lastIndex++; continue; }
      out += escapeHtml(text.slice(lastIdx, m.index));
      out += `<mark class="cb-export-json-match">${escapeHtml(m[0])}</mark>`;
      lastIdx = m.index + m[0].length;
      count++;
    }
    out += escapeHtml(text.slice(lastIdx));
    return { html: out, count };
  }

  // Wraps a Promise<T> with performance.now() bookends and returns the
  // measured duration alongside the resolved value (or the rejection,
  // re-thrown). Single helper so every leg is timed identically.
  async function timed(label, promise) {
    const started = performance.now();
    try {
      const value = await promise;
      return { label, value, durationMs: performance.now() - started, error: null };
    } catch (error) {
      return { label, value: null, durationMs: performance.now() - started, error };
    }
  }

  // Per-endpoint live fetch. Returns { payload, durationMs, legDurations? }.
  // Throws when prerequisite IDs are missing so the caller can render an
  // empty-state hint instead of a JSON blob.
  // Fetches the raw payload for one import-flow step (for the per-step JSON
  // view). Cached static steps resolve via ensureStaticData and return the
  // in-memory lookups; the rest hit their endpoint. Returns { payload,
  // durationMs }; throws with code "missing_table" when a table is required
  // but none is open.
  async function fetchStepPayload(stepId) {
    const ids = parseTableIdsFromUrl();
    const workspaceId = ids?.workspaceId;
    const tableId = ids?.tableId;
    if (!workspaceId) {
      const err = new Error("Open a Clay workspace to inspect the import flow.");
      err.code = "missing_table";
      throw err;
    }

    if (stepId === "catalog") {
      const t = await timed("catalog", __cb.ensureStaticData(workspaceId));
      if (t.error) throw t.error;
      return { payload: { actions: Object.values(__cb.enrichmentLookup || {}) }, durationMs: t.durationMs };
    }
    if (stepId === "modelpricing") {
      const t = await timed("modelpricing", __cb.ensureStaticData(workspaceId));
      if (t.error) throw t.error;
      return { payload: __cb.livePricingByModel || {}, durationMs: t.durationMs };
    }
    if (stepId === "plan") {
      const t = await timed("plan", __cb.ensureStaticData(workspaceId));
      if (t.error) throw t.error;
      return { payload: __cb.currentPlanPricing || null, durationMs: t.durationMs };
    }
    if (stepId === "tables") {
      const t = await timed("tables", __cb.fetchTableList(ids.workbookId));
      if (t.error) throw t.error;
      return { payload: t.value, durationMs: t.durationMs };
    }

    if (!tableId) {
      const err = new Error("Open a Clay table to inspect this step.");
      err.code = "missing_table";
      throw err;
    }

    if (stepId === "context") {
      const t = await timed("context", __cb.fetchTableContextForImport(workspaceId, tableId));
      if (t.error) throw t.error;
      return { payload: t.value, durationMs: t.durationMs };
    }
    if (stepId === "spend") {
      const t = await timed("spend", __cb.fetchColumnSpend(workspaceId, tableId, 30));
      if (t.error) throw t.error;
      return { payload: t.value, durationMs: t.durationMs };
    }

    throw new Error(`Unknown step: ${stepId}`);
  }

  // Browsers force-name downloads via a synthetic <a download> click. The
  // URL needs to be revoked or it leaks the Blob until the page closes.
  function downloadJson(filename, text) {
    const blob = new Blob([text], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  function closeExportJsonModal() {
    if (jsonModalEl) { jsonModalEl.remove(); jsonModalEl = null; }
    if (jsonModalBackdrop) { jsonModalBackdrop.remove(); jsonModalBackdrop = null; }
    document.removeEventListener("keydown", onJsonModalKeydown);
  }

  __cb.closeExportJsonModal = closeExportJsonModal;

  function onJsonModalKeydown(evt) {
    if (evt.key === "Escape") {
      evt.stopPropagation();
      closeExportJsonModal();
    }
  }

  __cb.openExportJsonModal = function openExportJsonModal() {
    closeExportJsonModal();

    // Per-step JSON cache (the raw payload behind each call), fetched lazily
    // when a step is selected.
    const stepCache = {};
    for (const s of IMPORT_FLOW_STEPS) {
      if (s.fetchable) stepCache[s.id] = { state: "idle", payload: null, durationMs: null, error: null };
    }
    // The readable "what's being imported" model. Projected first; the Actual
    // (spend) leg fills in afterwards.
    let model = null;
    let modelState = "idle"; // idle | loading | ready | error | sample
    let modelError = null;
    let spendState = "idle"; // idle | loading | ready | error
    let selected = "breakdown";

    jsonModalBackdrop = document.createElement("div");
    jsonModalBackdrop.className = "cb-export-modal-backdrop";
    jsonModalBackdrop.addEventListener("mousedown", (evt) => {
      if (evt.target === jsonModalBackdrop) closeExportJsonModal();
    });

    jsonModalEl = document.createElement("div");
    jsonModalEl.className = "cb-export-modal cb-export-json-modal";

    // ---- Header ----
    const header = document.createElement("div");
    header.className = "cb-export-modal-header";
    const titleWrap = document.createElement("div");
    titleWrap.className = "cb-export-modal-title-wrap";
    const title = document.createElement("h2");
    title.className = "cb-export-modal-title";
    title.textContent = "Import flow inspector";
    const subtitle = document.createElement("div");
    subtitle.className = "cb-export-modal-subtitle";
    subtitle.textContent =
      "Every API call the table import makes, in order — Projected first, then Actual. " +
      "See what gets imported and inspect any call's raw JSON.";
    titleWrap.appendChild(title);
    titleWrap.appendChild(subtitle);

    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "cb-export-modal-close";
    closeBtn.setAttribute("aria-label", "Close");
    closeBtn.innerHTML =
      '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
    closeBtn.addEventListener("click", closeExportJsonModal);

    header.appendChild(titleWrap);
    header.appendChild(closeBtn);

    // ---- Body (two columns) ----
    const body = document.createElement("div");
    body.className = "cb-export-modal-body cb-export-json-body";

    // Left column: ordered API-call breakdown grouped by phase ------------
    const left = document.createElement("div");
    left.className = "cb-export-json-left";

    const picker = document.createElement("div");
    picker.className = "cb-export-json-picker";
    picker.setAttribute("role", "tablist");
    const pickerButtons = new Map();

    const phaseLabel = (text) => {
      const el = document.createElement("div");
      el.className = "cb-export-json-phase-label";
      el.textContent = text;
      return el;
    };

    let lastPhase = null;
    for (const def of IMPORT_FLOW_STEPS) {
      if (def.phase !== lastPhase) {
        lastPhase = def.phase;
        if (def.phase === "projected") picker.appendChild(phaseLabel("Projected \u2014 on import"));
        else if (def.phase === "actual") picker.appendChild(phaseLabel("Actual \u2014 background"));
      }
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "cb-export-json-endpoint";
      btn.setAttribute("role", "tab");
      btn.dataset.endpointId = def.id;
      const label = document.createElement("span");
      label.className = "cb-export-json-endpoint-label";
      label.textContent = def.label;
      const tag = document.createElement("span");
      tag.className = "cb-export-json-endpoint-tag";
      tag.textContent = def.tag;
      btn.appendChild(label);
      btn.appendChild(tag);
      btn.addEventListener("click", () => {
        if (selected === def.id) return;
        selected = def.id;
        renderAll();
        if (def.fetchable) loadStep(def.id);
      });
      picker.appendChild(btn);
      pickerButtons.set(def.id, btn);
    }
    left.appendChild(picker);

    const explain = document.createElement("div");
    explain.className = "cb-export-json-explain";
    left.appendChild(explain);

    // Right column --------------------------------------------------------
    const right = document.createElement("div");
    right.className = "cb-export-json-right";

    const rightHeader = document.createElement("div");
    rightHeader.className = "cb-export-json-right-header";

    // Projected -> Actual progress indicator.
    const phaseStatus = document.createElement("div");
    phaseStatus.className = "cb-export-json-phase-status";
    rightHeader.appendChild(phaseStatus);

    const timing = document.createElement("div");
    timing.className = "cb-export-json-timing";
    rightHeader.appendChild(timing);

    right.appendChild(rightHeader);

    // Search bar (JSON view only).
    const searchBar = document.createElement("div");
    searchBar.className = "cb-export-json-search-bar";
    const searchInput = document.createElement("input");
    searchInput.type = "search";
    searchInput.className = "cb-export-json-search-input";
    searchInput.placeholder = "Search JSON\u2026  (Enter \u2014 next, Shift+Enter \u2014 prev)";
    searchInput.autocomplete = "off";
    searchInput.spellcheck = false;
    const searchCounter = document.createElement("span");
    searchCounter.className = "cb-export-json-search-counter";
    searchBar.appendChild(searchInput);
    searchBar.appendChild(searchCounter);
    right.appendChild(searchBar);

    // Readable breakdown container (shown for the "breakdown" selection).
    const breakdownWrap = document.createElement("div");
    breakdownWrap.className = "cb-export-json-breakdown-wrap";
    right.appendChild(breakdownWrap);

    // Raw JSON preview (shown for any individual call).
    const previewWrap = document.createElement("div");
    previewWrap.className = "cb-export-json-preview-wrap";
    const preview = document.createElement("pre");
    preview.className = "cb-export-json-preview";
    previewWrap.appendChild(preview);
    right.appendChild(previewWrap);

    let searchQuery = "";
    let searchText = "";
    let currentMatchIdx = -1;
    let currentMatchCount = 0;

    searchInput.addEventListener("input", () => {
      searchQuery = searchInput.value;
      currentMatchIdx = searchQuery ? 0 : -1;
      applySearchHighlight({ scroll: !!searchQuery });
    });
    searchInput.addEventListener("keydown", (evt) => {
      if (evt.key === "Enter") {
        evt.preventDefault();
        if (currentMatchCount === 0) return;
        currentMatchIdx = evt.shiftKey
          ? (currentMatchIdx - 1 + currentMatchCount) % currentMatchCount
          : (currentMatchIdx + 1) % currentMatchCount;
        focusActiveMatch();
        renderSearchCounter();
      } else if (evt.key === "Escape") {
        if (searchQuery) {
          evt.stopPropagation();
          searchQuery = "";
          searchInput.value = "";
          currentMatchIdx = -1;
          applySearchHighlight({ scroll: false });
        }
      }
    });

    body.appendChild(left);
    body.appendChild(right);

    // ---- Footer ----
    const footer = document.createElement("div");
    footer.className = "cb-export-modal-footer";
    const footerHint = document.createElement("div");
    footerHint.className = "cb-export-modal-footer-hint";
    footerHint.textContent =
      "Read-only — hits Clay's APIs with your session cookies. Nothing is uploaded anywhere.";

    const downloadBtn = document.createElement("button");
    downloadBtn.type = "button";
    downloadBtn.className = "cb-export-submit cb-export-json-download";
    downloadBtn.textContent = "Download JSON";
    downloadBtn.addEventListener("click", () => {
      const dl = currentDownload();
      if (dl) downloadJson(dl.filename, dl.text);
    });

    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.className = "cb-export-modal-done";
    cancelBtn.textContent = "Done";
    cancelBtn.addEventListener("click", closeExportJsonModal);

    const footerActions = document.createElement("div");
    footerActions.className = "cb-export-footer-actions";
    footerActions.appendChild(cancelBtn);
    footerActions.appendChild(downloadBtn);

    footer.appendChild(footerHint);
    footer.appendChild(footerActions);

    jsonModalEl.appendChild(header);
    jsonModalEl.appendChild(body);
    jsonModalEl.appendChild(footer);
    jsonModalBackdrop.appendChild(jsonModalEl);
    document.body.appendChild(jsonModalBackdrop);
    document.addEventListener("keydown", onJsonModalKeydown);

    // ---- Formatters ----
    const creditText = (n) =>
      n == null || !Number.isFinite(n) ? "\u2014" : (n % 1 === 0 ? String(n) : n.toFixed(1));
    const coverageText = (cov) =>
      cov && Number(cov.total)
        ? `${Number(cov.ran).toLocaleString()} / ${Number(cov.total).toLocaleString()}`
        : "\u2014";
    const fillText = (fr) =>
      fr && Number(fr.ran) ? `${Math.round((Number(fr.success) / Number(fr.ran)) * 100)}%` : "\u2014";
    const actualText = (sp) => {
      if (sp) return `${Number(sp.credits).toLocaleString()} cr`;
      if (spendState === "loading") return "computing\u2026";
      return "\u2014";
    };

    // ---- Render helpers ----
    function renderPicker() {
      for (const [id, btn] of pickerButtons.entries()) {
        btn.classList.toggle("cb-export-json-endpoint-active", id === selected);
        btn.setAttribute("aria-selected", id === selected ? "true" : "false");
        const def = IMPORT_FLOW_STEPS.find((d) => d.id === id);
        let dot = "";
        if (def?.fetchable) {
          const st = stepCache[id]?.state;
          dot =
            st === "ready" ? " \u2713" : st === "loading" ? " \u2026" : st === "error" ? " !" : "";
        }
        const labelEl = btn.querySelector(".cb-export-json-endpoint-label");
        if (labelEl) labelEl.textContent = def.label + dot;
      }
    }

    function renderPhaseStatus() {
      const proj =
        modelState === "ready" ? "\u2713" : modelState === "loading" ? "\u2026" : modelState === "error" ? "!" : "";
      const act =
        spendState === "ready" ? "\u2713" : spendState === "loading" ? "\u2026" : "";
      phaseStatus.innerHTML =
        `<span class="cb-export-json-phase-pill cb-export-json-phase-pill-${modelState}">Projected ${proj}</span>` +
        `<span class="cb-export-json-phase-arrow">\u2192</span>` +
        `<span class="cb-export-json-phase-pill cb-export-json-phase-pill-${spendState}">Actual ${act}</span>`;
    }

    function renderExplain() {
      const def = IMPORT_FLOW_STEPS.find((d) => d.id === selected);
      explain.innerHTML = "";
      if (!def) return;
      const h = (text) => {
        const el = document.createElement("div");
        el.className = "cb-export-json-explain-h";
        el.textContent = text;
        return el;
      };
      const p = (text, cls) => {
        const el = document.createElement("p");
        el.className = "cb-export-json-explain-p" + (cls ? " " + cls : "");
        el.textContent = text;
        return el;
      };
      const list = (items, cls) => {
        const ul = document.createElement("ul");
        ul.className = "cb-export-json-explain-list" + (cls ? " " + cls : "");
        for (const item of items) {
          const li = document.createElement("li");
          li.textContent = item;
          ul.appendChild(li);
        }
        return ul;
      };
      explain.appendChild(p(def.summary, "cb-export-json-explain-summary"));
      explain.appendChild(h("What you get"));
      explain.appendChild(list(def.whatYouGet));
      explain.appendChild(h("Trade-offs"));
      explain.appendChild(list(def.tradeoffs, "cb-export-json-explain-cons"));
      explain.appendChild(h("When to use"));
      explain.appendChild(p(def.whenToUse));
      explain.appendChild(h("Calls"));
      const callsList = document.createElement("ul");
      callsList.className = "cb-export-json-explain-calls";
      for (const c of def.calls) {
        const li = document.createElement("li");
        li.textContent = c;
        callsList.appendChild(li);
      }
      explain.appendChild(callsList);
    }

    function renderTimingChip() {
      timing.className = "cb-export-json-timing";
      if (selected === "breakdown") {
        timing.style.visibility = "hidden";
        timing.textContent = "";
        return;
      }
      timing.style.visibility = "visible";
      const entry = stepCache[selected];
      if (!entry || entry.state === "idle") { timing.textContent = ""; return; }
      if (entry.state === "loading") {
        timing.classList.add("cb-export-json-timing-loading");
        timing.textContent = "Fetching\u2026";
        return;
      }
      if (entry.state === "error") {
        timing.classList.add("cb-export-json-timing-error");
        timing.textContent = `Error \u00b7 ${formatDuration(entry.durationMs)}`;
        timing.title = entry.error?.message || "";
        return;
      }
      timing.classList.add("cb-export-json-timing-ready");
      timing.textContent = formatDuration(entry.durationMs);
      timing.title = "Wall-clock latency of this call.";
    }

    // Renders the readable "what's being imported" table.
    function renderBreakdown() {
      breakdownWrap.innerHTML = "";
      if (modelState === "loading") {
        breakdownWrap.innerHTML = `<div class="cb-export-json-breakdown-empty">Running the projected import legs\u2026</div>`;
        return;
      }
      if (modelState === "error") {
        breakdownWrap.innerHTML = `<div class="cb-export-json-breakdown-empty">${escapeHtml(modelError?.message || "Could not load the import flow.")}<br><br>Open a Clay table and reopen this dialog.</div>`;
        return;
      }
      if (!model) {
        breakdownWrap.innerHTML = `<div class="cb-export-json-breakdown-empty">Open a Clay table to inspect the import.</div>`;
        return;
      }
      const plan = model.plan;
      const planText = plan
        ? `${plan.displayName || plan.planType || "plan"} (${plan.planIsModern || plan.isModern ? "modern" : "legacy"} pricing)`
        : "unknown plan";
      const c = model.counts || {};
      const rec = Number.isFinite(model.recordCount) ? model.recordCount.toLocaleString() : "\u2014";
      const sampleNote = model.sample
        ? `<div class="cb-export-json-breakdown-sample">Sample data — open a Clay table for live values.</div>`
        : "";

      let rowsHtml = "";
      for (const r of model.fieldRows || []) {
        rowsHtml +=
          "<tr>" +
          `<td class="cb-bd-name" title="${escapeHtml(r.name)}">${escapeHtml(r.name)}</td>` +
          `<td>${escapeHtml(r.group)}</td>` +
          `<td class="cb-bd-name" title="${escapeHtml(r.source || "\u2014")}">${escapeHtml(r.source || "\u2014")}</td>` +
          `<td class="cb-bd-num">${r.type === "Enrichment" ? creditText(r.projected) : "\u2014"}</td>` +
          `<td class="cb-bd-num">${coverageText(r.coverage)}</td>` +
          `<td class="cb-bd-num">${fillText(r.fill)}</td>` +
          `<td class="cb-bd-num cb-bd-actual">${actualText(r.spend)}</td>` +
          "</tr>";
      }

      breakdownWrap.innerHTML =
        sampleNote +
        `<div class="cb-export-json-breakdown-summary">` +
          `<span class="cb-bd-chip">Plan: ${escapeHtml(planText)}</span>` +
          `<span class="cb-bd-chip">${rec} rows</span>` +
          `<span class="cb-bd-chip">${c.standalone || 0} standalone</span>` +
          `<span class="cb-bd-chip">${c.waterfalls || 0} waterfalls</span>` +
          `<span class="cb-bd-chip">${c.basicGroups || 0} groups</span>` +
          `<span class="cb-bd-chip">${c.inputs || 0} inputs</span>` +
        `</div>` +
        `<table class="cb-export-json-breakdown-table"><thead><tr>` +
          `<th>Field</th><th>Group</th><th>Source enrichment</th><th class="cb-bd-num">Projected cr/row</th>` +
          `<th class="cb-bd-num">Coverage</th><th class="cb-bd-num">Fill</th>` +
          `<th class="cb-bd-num">Actual</th>` +
        `</tr></thead><tbody>${rowsHtml}</tbody></table>`;
    }

    function renderStepJson() {
      preview.classList.remove("cb-export-json-preview-error", "cb-export-json-preview-empty");
      searchText = "";
      const entry = stepCache[selected];
      if (!entry || entry.state === "idle" || entry.state === "loading") {
        preview.classList.add("cb-export-json-preview-empty");
        preview.textContent = "Fetching from Clay\u2026";
        applySearchHighlight({ scroll: false });
        return;
      }
      if (entry.state === "error") {
        preview.classList.add("cb-export-json-preview-error");
        preview.textContent =
          (entry.error?.message || "Request failed.") +
          "\n\nOpen a Clay table and reopen this dialog, or check the console.";
        applySearchHighlight({ scroll: false });
        return;
      }
      try {
        searchText = JSON.stringify(entry.payload, null, 2);
      } catch (err) {
        preview.classList.add("cb-export-json-preview-error");
        preview.textContent = `Could not stringify payload: ${err.message}`;
        applySearchHighlight({ scroll: false });
        return;
      }
      applySearchHighlight({ scroll: false });
    }

    function renderRight() {
      const isBreakdown = selected === "breakdown";
      breakdownWrap.style.display = isBreakdown ? "" : "none";
      previewWrap.style.display = isBreakdown ? "none" : "";
      if (isBreakdown) {
        searchBar.classList.remove("cb-export-json-search-bar-visible");
        renderBreakdown();
      } else {
        renderStepJson();
      }
    }

    function applySearchHighlight({ scroll }) {
      const canSearch = selected !== "breakdown" && searchText !== "";
      searchBar.classList.toggle("cb-export-json-search-bar-visible", canSearch);
      if (!canSearch) {
        currentMatchCount = 0; currentMatchIdx = -1; renderSearchCounter(); return;
      }
      if (!searchQuery) {
        preview.textContent = searchText;
        currentMatchCount = 0; currentMatchIdx = -1; renderSearchCounter(); return;
      }
      const { html, count } = buildHighlightedHtml(searchText, searchQuery);
      preview.innerHTML = html;
      currentMatchCount = count;
      if (count === 0) {
        currentMatchIdx = -1;
      } else {
        if (currentMatchIdx < 0 || currentMatchIdx >= count) currentMatchIdx = 0;
        markActiveMatch();
        if (scroll) focusActiveMatch();
      }
      renderSearchCounter();
    }

    function markActiveMatch() {
      const marks = preview.querySelectorAll(".cb-export-json-match");
      for (const el of marks) el.classList.remove("cb-export-json-match-active");
      if (currentMatchIdx >= 0 && marks[currentMatchIdx]) {
        marks[currentMatchIdx].classList.add("cb-export-json-match-active");
      }
    }
    function focusActiveMatch() {
      markActiveMatch();
      const marks = preview.querySelectorAll(".cb-export-json-match");
      const target = marks[currentMatchIdx];
      if (target && typeof target.scrollIntoView === "function") {
        target.scrollIntoView({ block: "center", inline: "nearest" });
      }
    }
    function renderSearchCounter() {
      if (!searchQuery) {
        searchCounter.textContent = "";
        searchCounter.classList.remove("cb-export-json-search-counter-empty");
        return;
      }
      if (currentMatchCount === 0) {
        searchCounter.textContent = "0 matches";
        searchCounter.classList.add("cb-export-json-search-counter-empty");
        return;
      }
      searchCounter.classList.remove("cb-export-json-search-counter-empty");
      searchCounter.textContent = `${currentMatchIdx + 1} / ${currentMatchCount}`;
    }

    function currentDownload() {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      if (selected === "breakdown") {
        if (!model) return null;
        const payload = model.decision || model;
        return { filename: `clay-import-breakdown-${stamp}.json`, text: JSON.stringify(payload, null, 2) };
      }
      const entry = stepCache[selected];
      if (!entry || entry.state !== "ready" || entry.payload == null) return null;
      return { filename: `clay-import-${selected}-${stamp}.json`, text: JSON.stringify(entry.payload, null, 2) };
    }

    function renderDownloadButton() {
      const enabled = !!currentDownload();
      downloadBtn.disabled = !enabled;
      downloadBtn.classList.toggle("cb-export-json-download-disabled", !enabled);
    }

    function renderAll() {
      renderPicker();
      renderPhaseStatus();
      renderExplain();
      renderTimingChip();
      renderRight();
      renderDownloadButton();
    }

    // Lazily fetch a single step's raw payload for the JSON view.
    async function loadStep(stepId) {
      const entry = stepCache[stepId];
      if (!entry || entry.state === "ready" || entry.state === "loading") {
        renderAll();
        return;
      }
      entry.state = "loading";
      entry.error = null;
      renderAll();
      try {
        const result = await fetchStepPayload(stepId);
        entry.state = "ready";
        entry.payload = result.payload;
        entry.durationMs = result.durationMs;
      } catch (err) {
        entry.state = "error";
        entry.error = err;
      }
      if (selected === stepId || selected === "breakdown") renderAll();
    }

    // Runs the projected legs, renders the breakdown, then fills in actuals.
    async function loadModel() {
      const ids = parseTableIdsFromUrl();
      if (!ids?.tableId) {
        model = SAMPLE_MODEL;
        modelState = "sample";
        spendState = "idle";
        renderAll();
        return;
      }
      if (!__cb.buildImportDecisionSet) {
        modelState = "error";
        modelError = new Error("buildImportDecisionSet not loaded — reload the extension.");
        renderAll();
        return;
      }
      modelState = "loading";
      renderAll();
      try {
        await __cb.ensureStaticData(ids.workspaceId);
        const [table, context] = await Promise.all([
          resolveTable(ids.workbookId, ids.tableId),
          __cb.fetchTableContextForImport(ids.workspaceId, ids.tableId),
        ]);
        if (!table) throw new Error("Table not found in this workbook's listing.");
        model = buildInspectorModel({ table, context, spend: null, viewId: ids.viewId });
        modelState = "ready";
        renderAll();

        // Actual leg in the background — rebuild with spend when it lands.
        spendState = "loading";
        renderAll();
        try {
          const spend = await __cb.fetchColumnSpend(ids.workspaceId, ids.tableId, 30);
          model = buildInspectorModel({ table, context, spend, viewId: ids.viewId });
          spendState = "ready";
        } catch {
          spendState = "error";
        }
        renderAll();
      } catch (err) {
        modelState = "error";
        modelError = err;
        renderAll();
      }
    }

    renderAll();
    loadModel();
  };
})();
