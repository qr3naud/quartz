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
  function renderGroupDivider(ws, label) {
    const row = ws.addRow(new Array(COL_COUNT).fill(""));
    row.getCell(1).value = label;
    ws.mergeCells(row.number, 1, row.number, COL_COUNT);
    row.getCell(1).font = { bold: true };
    row.getCell(1).alignment = { vertical: "middle", horizontal: "left" };
    for (let c = 1; c <= COL_COUNT; c++) {
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

  __cb.buildScopingXlsxBlob = async function buildScopingXlsxBlob(data, tabName) {
    if (typeof window.ExcelJS === "undefined") {
      throw new Error("ExcelJS not loaded");
    }
    const wb = new window.ExcelJS.Workbook();
    wb.creator = "Quartz";
    wb.created = new Date();

    const safeName =
      String(tabName || "Scope")
        .replace(/[\[\]:*?/\\]/g, " ")
        .trim()
        .slice(0, 31) || "Scope";
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

    const buffer = await wb.xlsx.writeBuffer();
    return new Blob([buffer], {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
  };
})();
