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
  //   - a merged use-case title row per section
  //   - column headers (Volume = coverage numerator; DP split credits/actions;
  //     full ER credits/actions merged across merge runs; enrichments folded
  //     with methodology; comments)
  //   - a per-section Total row (DP columns summed per row; ER columns deduped
  //     to one value per merge block)
  //
  // Colors approximate the reference scoping doc (blue header, yellow metrics,
  // grey labels, grey total). The flat CSV export (src/export.js) is unchanged.
  // ==========================================================================

  // ARGB fills (ExcelJS wants the leading FF alpha byte).
  const FILL_TITLE = "FFCFE2F3"; // light blue — title + header rows
  const FILL_METRIC = "FFFFF2CC"; // pale yellow — numeric/metric columns
  const FILL_LABEL = "FFEFEFEF"; // light grey — text/label columns
  const FILL_TOTAL = "FFD9D9D9"; // medium grey — total row

  // Column spec, left-to-right. `kind` drives the data-cell fill; `merge` marks
  // the three columns that collapse across an enrichment merge run.
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

  // Write a value into a cell as a real number when we have one, otherwise as
  // text (e.g. "?" for unresolved subroutine cost, "" for blanks). Keeps Excel
  // sums/formatting working on the cost columns.
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

  // Render one section (title + header + rows + total) starting at the worksheet's
  // current bottom. Returns nothing; mutates the worksheet.
  function renderSection(ws, section, fallbackTitle) {
    // --- Title row (merged across all columns) ---
    const titleRow = ws.addRow(new Array(COL_COUNT).fill(""));
    titleRow.getCell(1).value = section.title || fallbackTitle || "Scope";
    ws.mergeCells(titleRow.number, 1, titleRow.number, COL_COUNT);
    const titleCell = titleRow.getCell(1);
    titleCell.font = { bold: true, size: 12 };
    titleCell.alignment = { vertical: "middle", horizontal: "left" };
    for (let c = 1; c <= COL_COUNT; c++) {
      const cell = titleRow.getCell(c);
      cell.fill = solid(FILL_TITLE);
      cell.border = BORDER_ALL;
    }
    titleRow.height = 20;

    // --- Header row ---
    const headerRow = ws.addRow(new Array(COL_COUNT).fill(""));
    for (let c = 1; c <= COL_COUNT; c++) {
      const cell = headerRow.getCell(c);
      cell.value = COLS[c - 1].label;
      cell.font = { bold: true };
      cell.fill = solid(FILL_TITLE);
      cell.border = BORDER_ALL;
      cell.alignment = { vertical: "middle", wrapText: true };
    }

    // --- Data rows ---
    const firstDataRowNum = headerRow.number + 1;
    section.rows.forEach((rec) => {
      const row = ws.addRow(new Array(COL_COUNT).fill(""));
      // Per-column values.
      row.getCell(1).value = rec.dataPoint || "";
      setNumberOrText(row.getCell(2), rec.volumeNum, rec.volume);
      setNumberOrText(row.getCell(3), rec.fillNum, rec.fillRate);
      setNumberOrText(row.getCell(4), rec.dpCreditsNum, rec.dpCredits);
      setNumberOrText(row.getCell(5), rec.dpActionsNum, rec.dpActions);
      // Merge columns: only "first"/"single" hosts carry content; "skip"
      // followers stay blank and get covered by the vertical merge below.
      if (rec.mergeMode !== "skip") {
        row.getCell(6).value = rec.enrichments || "";
        setNumberOrText(row.getCell(7), rec.erCreditsNum, rec.erCredits);
        setNumberOrText(row.getCell(8), rec.erActionsNum, rec.erActions);
      }
      row.getCell(9).value = rec.comments || "";

      for (let c = 1; c <= COL_COUNT; c++) {
        styleDataCell(row.getCell(c), COLS[c - 1].kind);
      }
    });

    // --- Vertical merges for enrichment runs (Enrichments + ER cost cells) ---
    let idx = 0;
    while (idx < section.rows.length) {
      const rec = section.rows[idx];
      const span = rec.mergeSpan || 1;
      if (rec.mergeMode === "first" && span > 1) {
        const top = firstDataRowNum + idx;
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

    // --- Total row ---
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

    // --- Spacer row before the next section ---
    ws.addRow([]);
  }

  // Build the styled workbook from the structured export model. Returns a Blob.
  __cb.buildScopingXlsxBlob = async function buildScopingXlsxBlob(data, tabName) {
    if (typeof window.ExcelJS === "undefined") {
      throw new Error("ExcelJS not loaded");
    }
    const wb = new window.ExcelJS.Workbook();
    wb.creator = "Quartz";
    wb.created = new Date();

    // Worksheet name: sanitized tab name, Excel's 31-char limit, no []:*?/\.
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
      // Nothing scoped — still emit a header so the file isn't empty/confusing.
      renderSection(ws, { title: tabName || "Scope", rows: [], totals: {} }, tabName);
    } else {
      for (const section of sections) renderSection(ws, section, tabName);
    }

    const buffer = await wb.xlsx.writeBuffer();
    return new Blob([buffer], {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
  };
})();
