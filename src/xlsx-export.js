(function () {
  "use strict";

  const __cb = window.__cb;

  // ==========================================================================
  // EXPORT TO EXCEL (.xlsx)
  //
  // Styled, customer-facing scoping export built with the vendored ExcelJS
  // (vendor/exceljs.min.js -> window.ExcelJS). Consumes the section-grouped
  // model from __cb.tableView.getXlsxExportData() and renders one worksheet
  // per active tab with:
  //   - one merged use-case title row per top-level use case
  //   - a single column-header row under that title
  //   - optional darker inner-group divider rows (nested groups only)
  //   - data rows with DP split credits/actions and merged ER credits/actions
  //   - one Total row at the bottom of each use case (no per-group totals)
  //
  // Colors approximate the reference scoping doc (blue header, yellow metrics,
  // grey labels, darker group dividers, grey total). CSV export unchanged.
  // ==========================================================================

  const FILL_TITLE = "FFCFE2F3"; // light blue — use-case title + column headers
  const FILL_METRIC = "FFFFF2CC"; // pale yellow — numeric/metric columns
  const FILL_LABEL = "FFEFEFEF"; // light grey — text/label columns
  const FILL_GROUP = "FFBFBFBF"; // darker grey — inner-group divider row
  const FILL_TOTAL = "FFD9D9D9"; // medium grey — use-case total row
  const FILL_TABLE_HEADER = "FFD9EAD3"; // light green — Clay table column headers
  const TABLE_ROW_HEIGHT = 15;
  const TABLE_HEADER_HEIGHT = 18;

  const COLS = [
    { key: "dataPoint", label: "Data point", width: 34, kind: "label" },
    { key: "volume", label: "Volume", width: 12, kind: "metric" },
    { key: "fillRate", label: "Fill rate (%)", width: 12, kind: "metric" },
    { key: "dpCredits", label: "Credits / row", width: 13, kind: "metric" },
    { key: "dpActions", label: "Actions / row", width: 13, kind: "metric" },
    { key: "enrichments", label: "Enrichments", width: 40, kind: "label", merge: true },
    { key: "erCredits", label: "ER Credits", width: 12, kind: "metric", merge: true },
    { key: "erActions", label: "ER Actions", width: 12, kind: "metric", merge: true },
    { key: "comments", label: "Comments", width: 36, kind: "label" },
  ];
  const COL_COUNT = COLS.length;
  const NUM_FMT = "#,##0.0";

  // Mirror layout matches the manual customer scoping sheet exactly:
  //   (blank spacer) | {Section title / Data point} | Volume | Fill Rate |
  //   Data Credits | Actions | Methodology
  // Column 1 is an unstyled spacer; the section title lives in column 2 of the
  // header row, with the metric/Methodology labels in columns 3-7. Per-column
  // fillArgb reproduces the reference: grey data-point column, yellow metrics.
  const MIRROR_FILL_HEADER = "FFC9DAF8"; // blue — header row
  const MIRROR_FILL_DP = "FFF3F3F3"; // light grey — data-point / title column
  const MIRROR_FILL_BODY = "FFFFF2CC"; // pale yellow — metric + methodology cells
  const MIRROR_FILL_TOTAL = "FFD9D9D9"; // grey — total row

  const MIRROR_COLS = [
    { key: "spacer", label: "", width: 2.5, kind: "spacer", fillArgb: null },
    { key: "dataPoint", label: "", width: 46, kind: "label", fillArgb: MIRROR_FILL_DP },
    { key: "volume", label: "Volume", width: 10, kind: "metric", fillArgb: MIRROR_FILL_BODY },
    { key: "fillRate", label: "Fill Rate", width: 10, kind: "metric", fillArgb: MIRROR_FILL_BODY },
    { key: "dataCredits", label: "Data Credits", width: 13, kind: "metric", fillArgb: MIRROR_FILL_BODY },
    { key: "actions", label: "Actions", width: 9, kind: "metric", fillArgb: MIRROR_FILL_BODY },
    { key: "methodology", label: "Methodology", width: 60, kind: "label", fillArgb: MIRROR_FILL_BODY },
  ];
  const MIRROR_COL_COUNT = MIRROR_COLS.length;
  // First styled column (after the blank spacer).
  const MIRROR_FIRST_COL = 2;
  const FILL_PCT_FMT = "0%";
  const INT_FMT = "#,##0";

  // Outer box solid (thin black) with dotted (hair) inner row separators —
  // matches the reference: solid verticals/outer border, dashed horizontals.
  const MIRROR_THIN = { style: "thin", color: { argb: "FF000000" } };
  const MIRROR_HAIR = { style: "hair", color: { argb: "FF000000" } };
  const MIRROR_BORDER_HEADER = {
    left: MIRROR_THIN, right: MIRROR_THIN, top: MIRROR_THIN, bottom: MIRROR_HAIR,
  };
  const MIRROR_BORDER_BODY = {
    left: MIRROR_THIN, right: MIRROR_THIN, top: MIRROR_HAIR, bottom: MIRROR_HAIR,
  };
  const MIRROR_BORDER_TOTAL = {
    left: MIRROR_THIN, right: MIRROR_THIN, top: MIRROR_HAIR, bottom: MIRROR_THIN,
  };

  function solid(argb) {
    return { type: "pattern", pattern: "solid", fgColor: { argb } };
  }

  const THIN = { style: "thin", color: { argb: "FFBFBFBF" } };
  const BORDER_ALL = { top: THIN, left: THIN, bottom: THIN, right: THIN };

  function setNumberOrText(cell, num, text) {
    if (num != null && Number.isFinite(num)) {
      cell.value = num;
      cell.numFmt = NUM_FMT;
    } else {
      cell.value = text || "";
    }
  }

  function styleDataCell(cell, kind) {
    cell.fill = solid(kind === "metric" ? FILL_METRIC : FILL_LABEL);
    cell.border = BORDER_ALL;
    cell.alignment = { vertical: "top", wrapText: kind === "label" };
  }

  // Darker merged row labelling an inner group inside a use case.
  function renderGroupDivider(ws, label, colCount) {
    const n = colCount || COL_COUNT;
    const row = ws.addRow(new Array(n).fill(""));
    row.getCell(1).value = label;
    ws.mergeCells(row.number, 1, row.number, n);
    row.getCell(1).font = { bold: true };
    row.getCell(1).alignment = { vertical: "middle", horizontal: "left" };
    for (let c = 1; c <= n; c++) {
      const cell = row.getCell(c);
      cell.fill = solid(FILL_GROUP);
      cell.border = BORDER_ALL;
    }
    row.height = 18;
    return row.number;
  }

  function renderDataRow(ws, rec) {
    const row = ws.addRow(new Array(COL_COUNT).fill(""));
    row.getCell(1).value = rec.dataPoint || "";
    setNumberOrText(row.getCell(2), rec.volumeNum, rec.volume);
    setNumberOrText(row.getCell(3), rec.fillNum, rec.fillRate);
    setNumberOrText(row.getCell(4), rec.dpCreditsNum, rec.dpCredits);
    setNumberOrText(row.getCell(5), rec.dpActionsNum, rec.dpActions);
    if (rec.mergeMode !== "skip") {
      row.getCell(6).value = rec.enrichments || "";
      setNumberOrText(row.getCell(7), rec.erCreditsNum, rec.erCredits);
      setNumberOrText(row.getCell(8), rec.erActionsNum, rec.erActions);
    }
    row.getCell(9).value = rec.comments || "";
    for (let c = 1; c <= COL_COUNT; c++) {
      styleDataCell(row.getCell(c), COLS[c - 1].kind);
    }
    return row.number;
  }

  // Vertical merges for enrichment runs within one block of rows.
  function applyBlockMerges(ws, records, firstRowNum) {
    let idx = 0;
    while (idx < records.length) {
      const rec = records[idx];
      const span = rec.mergeSpan || 1;
      if (rec.mergeMode === "first" && span > 1) {
        const top = firstRowNum + idx;
        const bottom = top + span - 1;
        for (const col of COLS) {
          if (!col.merge) continue;
          const ci = COLS.indexOf(col) + 1;
          ws.mergeCells(top, ci, bottom, ci);
          ws.getCell(top, ci).alignment = {
            vertical: "middle",
            wrapText: col.kind === "label",
          };
        }
        idx += span;
      } else {
        idx += 1;
      }
    }
  }

  // One use-case section: title + headers + blocks (group dividers + data) + total.
  function renderSection(ws, section, fallbackTitle) {
    const blocks = section.blocks && section.blocks.length > 0
      ? section.blocks
      : section.rows
        ? [{ groupLabel: "", rows: section.rows }]
        : [];

    // --- Use-case title row ---
    const titleRow = ws.addRow(new Array(COL_COUNT).fill(""));
    titleRow.getCell(1).value = section.title || fallbackTitle || "Scope";
    ws.mergeCells(titleRow.number, 1, titleRow.number, COL_COUNT);
    titleRow.getCell(1).font = { bold: true, size: 12 };
    titleRow.getCell(1).alignment = { vertical: "middle", horizontal: "left" };
    for (let c = 1; c <= COL_COUNT; c++) {
      const cell = titleRow.getCell(c);
      cell.fill = solid(FILL_TITLE);
      cell.border = BORDER_ALL;
    }
    titleRow.height = 20;

    // --- Column header row (once per use case) ---
    const headerRow = ws.addRow(new Array(COL_COUNT).fill(""));
    for (let c = 1; c <= COL_COUNT; c++) {
      const cell = headerRow.getCell(c);
      cell.value = COLS[c - 1].label;
      cell.font = { bold: true };
      cell.fill = solid(FILL_TITLE);
      cell.border = BORDER_ALL;
      cell.alignment = { vertical: "middle", wrapText: true };
    }

    // --- Blocks: optional group divider, then data rows ---
    for (const block of blocks) {
      const records = block.rows || [];
      if (records.length === 0) continue;
      if (block.groupLabel) renderGroupDivider(ws, block.groupLabel);
      const firstDataRowNum = ws.lastRow.number + 1;
      for (const rec of records) renderDataRow(ws, rec);
      applyBlockMerges(ws, records, firstDataRowNum);
    }

    // --- Use-case total row (once, at the bottom) ---
    const t = section.totals || {};
    const totalRow = ws.addRow(new Array(COL_COUNT).fill(""));
    totalRow.getCell(1).value = "Total";
    setNumberOrText(totalRow.getCell(4), t.dpCreditsUnknown ? null : t.dpCredits, t.dpCreditsUnknown ? "?" : "");
    setNumberOrText(totalRow.getCell(5), t.dpActions, "");
    setNumberOrText(totalRow.getCell(7), t.erCreditsUnknown ? null : t.erCredits, t.erCreditsUnknown ? "?" : "");
    setNumberOrText(totalRow.getCell(8), t.erActions, "");
    for (let c = 1; c <= COL_COUNT; c++) {
      const cell = totalRow.getCell(c);
      cell.font = { bold: true };
      cell.fill = solid(FILL_TOTAL);
      cell.border = BORDER_ALL;
    }

    ws.addRow([]);
  }

  // Style the styled columns of a mirror row (spacer stays blank/white). Never
  // wraps. `fillArgb` lets the total/group rows override the per-column fill.
  function styleMirrorRow(row, { border, fillArgb, bold } = {}) {
    for (let c = MIRROR_FIRST_COL; c <= MIRROR_COL_COUNT; c++) {
      const cell = row.getCell(c);
      const fill = fillArgb !== undefined ? fillArgb : MIRROR_COLS[c - 1].fillArgb;
      if (fill) cell.fill = solid(fill);
      cell.border = border || MIRROR_BORDER_BODY;
      if (bold) cell.font = { bold: true };
      cell.alignment = { vertical: "top", wrapText: false };
    }
  }

  // Data point row. Volume + Fill render on every row; Data Credits / Actions
  // only when present (first row of a run); Methodology repeats. Numbers get
  // native formats so Excel right-aligns them like the manual sheet.
  function renderMirrorDataRow(ws, rec) {
    const row = ws.addRow(new Array(MIRROR_COL_COUNT).fill(""));
    row.getCell(2).value = rec.dataPoint ? `     ${rec.dataPoint}` : "";
    if (rec.volumeNum != null && Number.isFinite(rec.volumeNum)) {
      row.getCell(3).value = rec.volumeNum;
      row.getCell(3).numFmt = INT_FMT;
    }
    if (rec.fillPct != null && Number.isFinite(rec.fillPct)) {
      row.getCell(4).value = rec.fillPct / 100;
      row.getCell(4).numFmt = FILL_PCT_FMT;
    }
    row.getCell(5).value = rec.dataCredits || "";
    if (rec.actionsNum != null && Number.isFinite(rec.actionsNum)) {
      row.getCell(6).value = rec.actionsNum;
      row.getCell(6).numFmt = INT_FMT;
    }
    row.getCell(7).value = rec.methodology || "";
    styleMirrorRow(row);
    return row.number;
  }

  // Darker grey divider for a nested group inside a use case (spans the styled
  // columns; the spacer stays blank).
  function renderMirrorGroupDivider(ws, label) {
    const row = ws.addRow(new Array(MIRROR_COL_COUNT).fill(""));
    row.getCell(MIRROR_FIRST_COL).value = label;
    ws.mergeCells(row.number, MIRROR_FIRST_COL, row.number, MIRROR_COL_COUNT);
    row.getCell(MIRROR_FIRST_COL).alignment = { vertical: "middle", horizontal: "left", wrapText: false };
    styleMirrorRow(row, { fillArgb: FILL_GROUP, bold: true });
    row.height = 18;
    return row.number;
  }

  function renderMirrorSection(ws, section, fallbackTitle) {
    const blocks = section.blocks && section.blocks.length > 0
      ? section.blocks
      : section.rows
        ? [{ groupLabel: "", rows: section.rows }]
        : [];

    // Combined title + column-header row: title in column 2, labels in 3-7.
    const headerRow = ws.addRow(new Array(MIRROR_COL_COUNT).fill(""));
    headerRow.getCell(MIRROR_FIRST_COL).value = section.title || fallbackTitle || "Scope";
    for (let c = MIRROR_FIRST_COL; c <= MIRROR_COL_COUNT; c++) {
      if (c > MIRROR_FIRST_COL) headerRow.getCell(c).value = MIRROR_COLS[c - 1].label;
    }
    styleMirrorRow(headerRow, { border: MIRROR_BORDER_HEADER, fillArgb: MIRROR_FILL_HEADER, bold: true });
    for (let c = MIRROR_FIRST_COL; c <= MIRROR_COL_COUNT; c++) {
      headerRow.getCell(c).alignment = { vertical: "middle", wrapText: false };
    }
    headerRow.height = 20;

    for (const block of blocks) {
      const records = block.rows || [];
      if (records.length === 0) continue;
      if (block.groupLabel) renderMirrorGroupDivider(ws, block.groupLabel);
      for (const rec of records) renderMirrorDataRow(ws, rec);
    }

    // Use-case total row: blended credits per record (sum of per-row Data Credits).
    const totalRow = ws.addRow(new Array(MIRROR_COL_COUNT).fill(""));
    totalRow.getCell(MIRROR_FIRST_COL).value = "Total";
    if (section.totalCredits != null && Number.isFinite(section.totalCredits)) {
      totalRow.getCell(5).value = `${Number(section.totalCredits).toFixed(1)} credits`;
    }
    styleMirrorRow(totalRow, { border: MIRROR_BORDER_TOTAL, fillArgb: MIRROR_FILL_TOTAL, bold: true });

    ws.addRow([]);
  }

  function addMirrorScopingSheet(wb, data, tabName, usedNames) {
    const safeName = sanitizeSheetName(tabName || "Scope", usedNames);
    const ws = wb.addWorksheet(safeName, {
      views: [{ state: "frozen", ySplit: 0 }],
    });

    MIRROR_COLS.forEach((c, i) => {
      ws.getColumn(i + 1).width = c.width;
    });

    const sections = (data && data.sections) || [];
    if (sections.length === 0) {
      renderMirrorSection(ws, { title: tabName || "Scope", blocks: [] }, tabName);
    } else {
      for (const section of sections) renderMirrorSection(ws, section, tabName);
    }
    return ws;
  }

  // Excel sheet names: max 31 chars, no []:*?/\; dedupe within one workbook.
  function sanitizeSheetName(name, usedNames) {
    let base =
      String(name || "Sheet")
        .replace(/[\[\]:*?/\\]/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 31) || "Sheet";
    if (!usedNames || !usedNames.has(base)) {
      usedNames?.add(base);
      return base;
    }
    for (let n = 2; n < 100; n++) {
      const suffix = ` (${n})`;
      const candidate = base.slice(0, 31 - suffix.length) + suffix;
      if (!usedNames.has(candidate)) {
        usedNames.add(candidate);
        return candidate;
      }
    }
    const fallback = `Sheet ${usedNames.size + 1}`.slice(0, 31);
    usedNames.add(fallback);
    return fallback;
  }

  // RFC4180-ish CSV parser for Clay table export blobs (quoted fields, escapes).
  function parseCsvText(text) {
    const rows = [];
    let row = [];
    let field = "";
    let inQuotes = false;
    const s = String(text || "").replace(/^\uFEFF/, "");

    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (inQuotes) {
        if (ch === '"') {
          if (s[i + 1] === '"') {
            field += '"';
            i++;
          } else {
            inQuotes = false;
          }
        } else {
          field += ch;
        }
        continue;
      }
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ",") {
        row.push(field);
        field = "";
      } else if (ch === "\r") {
        if (s[i + 1] === "\n") i++;
        row.push(field);
        rows.push(row);
        row = [];
        field = "";
      } else if (ch === "\n") {
        row.push(field);
        rows.push(row);
        row = [];
        field = "";
      } else {
        field += ch;
      }
    }
    if (field.length > 0 || row.length > 0) {
      row.push(field);
      rows.push(row);
    }
    return rows;
  }

  function addScopingSheet(wb, data, tabName, usedNames) {
    const safeName = sanitizeSheetName(tabName || "Scope", usedNames);
    const ws = wb.addWorksheet(safeName, {
      views: [{ state: "frozen", ySplit: 0 }],
    });

    COLS.forEach((c, i) => {
      ws.getColumn(i + 1).width = c.width;
    });

    const sections = (data && data.sections) || [];
    if (sections.length === 0) {
      renderSection(ws, { title: tabName || "Scope", blocks: [], totals: {} }, tabName);
    } else {
      for (const section of sections) renderSection(ws, section, tabName);
    }
    return ws;
  }

  function filterCsvRows(rows, keepColumns) {
    if (!keepColumns || keepColumns.size === 0 || rows.length === 0) return rows;
    const header = rows[0] || [];
    const keepIdx = [];
    for (let i = 0; i < header.length; i++) {
      const name = String(header[i] ?? "").trim();
      if (keepColumns.has(name)) keepIdx.push(i);
    }
    if (keepIdx.length === 0) return [header];
    return rows.map((row) => keepIdx.map((i) => (row[i] != null ? row[i] : "")));
  }

  function addPlainCsvSheet(wb, sheetName, csvText, usedNames, opts) {
    const safeName = sanitizeSheetName(sheetName, usedNames);
    const ws = wb.addWorksheet(safeName);
    let rows = parseCsvText(csvText);
    if (opts?.keepColumns) {
      rows = filterCsvRows(rows, opts.keepColumns);
    }
    if (rows.length === 0) return ws;

    ws.addRows(rows);
    const colCount = rows.reduce((max, r) => Math.max(max, r.length), 0);

    const header = ws.getRow(1);
    header.height = TABLE_HEADER_HEIGHT;
    for (let c = 1; c <= colCount; c++) {
      const cell = header.getCell(c);
      const label = String(cell.value ?? "");
      cell.font = { bold: true };
      cell.fill = solid(FILL_TABLE_HEADER);
      cell.alignment = { vertical: "middle", horizontal: "left", wrapText: false };
      ws.getColumn(c).width = Math.min(48, Math.max(10, label.length + 2));
    }

    for (let r = 2; r <= rows.length; r++) {
      const row = ws.getRow(r);
      row.height = TABLE_ROW_HEIGHT;
      for (let c = 1; c <= colCount; c++) {
        row.getCell(c).alignment = {
          vertical: "middle",
          horizontal: "left",
          wrapText: false,
        };
      }
    }

    ws.views = [{ state: "frozen", ySplit: 1 }];
    return ws;
  }

  async function workbookToBlob(wb) {
    const buffer = await wb.xlsx.writeBuffer();
    return new Blob([buffer], {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
  }

  __cb.buildScopingXlsxBlob = async function buildScopingXlsxBlob(data, tabName) {
    if (typeof window.ExcelJS === "undefined") {
      throw new Error("ExcelJS not loaded");
    }
    const wb = new window.ExcelJS.Workbook();
    wb.creator = "Quartz";
    wb.created = new Date();
    addScopingSheet(wb, data, tabName, new Set());
    return workbookToBlob(wb);
  };

  // Multi-tab package: styled scoping sheet + plain Clay table CSV sheets.
  __cb.buildPackageXlsxBlob = async function buildPackageXlsxBlob({
    scopingData,
    tabName,
    tables,
  }) {
    if (typeof window.ExcelJS === "undefined") {
      throw new Error("ExcelJS not loaded");
    }
    const wb = new window.ExcelJS.Workbook();
    wb.creator = "Quartz";
    wb.created = new Date();

    const usedNames = new Set();
    addScopingSheet(wb, scopingData, tabName, usedNames);

    for (const table of tables || []) {
      if (!table?.csvText) continue;
      addPlainCsvSheet(wb, table.name || "Table", table.csvText, usedNames);
    }

    return workbookToBlob(wb);
  };

  // Mirror package: methodology scoping sheet + filtered Clay table data sheets.
  __cb.buildMirrorXlsxBlob = async function buildMirrorXlsxBlob({
    methodologyData,
    tabName,
    tables,
  }) {
    if (typeof window.ExcelJS === "undefined") {
      throw new Error("ExcelJS not loaded");
    }
    const wb = new window.ExcelJS.Workbook();
    wb.creator = "Quartz";
    wb.created = new Date();

    const usedNames = new Set();
    addMirrorScopingSheet(wb, methodologyData, tabName, usedNames);

    for (const table of tables || []) {
      if (!table?.csvText) continue;
      addPlainCsvSheet(wb, table.name || "Table", table.csvText, usedNames, {
        keepColumns: table.keepColumns,
      });
    }

    return workbookToBlob(wb);
  };
})();
