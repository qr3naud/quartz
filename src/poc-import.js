(function () {
  "use strict";

  const __cb = window.__cb;

  // ---------------------------------------------------------------------------
  // POC Doc importer
  //
  // Reps starting fresh on a POC have a "POC Overview" doc with one or more
  // Use Cases, each declaring a "Required data points:" list. Instead of
  // hand-typing every data point into the table view, this module accepts
  // either a Google Doc URL (publicly shared via "Anyone with the link") or
  // a paste of the doc contents, parses out the Use Cases + their bullets,
  // and stamps them on the canvas as one cluster per Use Case using the
  // same comment-card + groupCluster primitives src/table-import.js uses
  // for "basic groups". The table view then renders these clusters as
  // group-header rows with the data points listed underneath.
  // ---------------------------------------------------------------------------

  let modalEl = null;
  let backdropEl = null;

  // ---- Google Doc fetching --------------------------------------------------

  // Accepts the canonical /document/d/<id>/... shape (and its ?usp=sharing
  // flavor in the example link the user provided). Returns null when the
  // input doesn't look like a Google Doc URL — the caller treats that as
  // "user wants the paste path".
  function extractGoogleDocId(url) {
    if (typeof url !== "string") return null;
    const m = url.match(/\/document\/d\/([a-zA-Z0-9_-]+)/);
    return m ? m[1] : null;
  }

  // Google Docs serves a plain-text export of any "Anyone with the link" doc
  // at /export?format=txt, no auth needed. credentials: "omit" makes sure we
  // don't accidentally send the user's Google session cookies (which would
  // change the response in subtle ways and isn't necessary for public docs).
  // On non-200 we surface a friendly message — the most common cause is the
  // doc being private, which we can't fix from a content script.
  async function fetchGoogleDoc(docId) {
    const url = `https://docs.google.com/document/d/${docId}/export?format=txt`;
    const res = await fetch(url, { credentials: "omit" });
    if (!res.ok) {
      throw new Error(
        `Google Docs returned ${res.status}. Make sure the doc is shared as "Anyone with the link" or paste its contents below.`,
      );
    }
    return await res.text();
  }

  // ---- Parser ---------------------------------------------------------------
  //
  // The doc structure we care about looks like:
  //
  //   Use Case 1 Account Enrichment & Signal Layer
  //   <prose paragraph...>
  //   Required data points:
  //   - Parent company / ultimate HQ mapping
  //   - Industry classification
  //   - Account signal: competitor TMC usage (e.g., Navan)
  //   Use Case 2 Inbound Lead Enrichment
  //   <prose...>
  //   Required data points:
  //   - Work email (sourced from name + company + domain)
  //   - ...
  //
  // The parser is intentionally forgiving: bullets can wrap onto a continuation
  // line (e.g. "(business services / construction = high; education /
  // healthcare = low)" lives on a second line in the AmexGBT example), and
  // tabs / extra whitespace from Google Doc table cells get normalized away.
  // When no Use Cases are detected, every "Required data points:" block is
  // dumped into a single `untitled` bucket so unstructured docs still work.

  // Markers that terminate a "Required data points:" bullet list. We stop
  // collecting bullets once we hit any of these (case-insensitive match
  // against a non-bullet line), in addition to the next "Use Case N"
  // header. Without this, the volume / stakeholders / timeline sections
  // would get sucked into the previous use case's data points.
  //
  // The Use Case terminator is intentionally NOT anchored to start-of-line:
  // Google Docs exports table cells as tab-separated text, so a doc that
  // structures its Use Case sections as a 2-column table emits lines like
  // "Inbound Lead Enrichment \tUse Case 2 Inbound Lead Enrichment". The
  // tab-to-space normalization above flattens those tabs, leaving a line
  // where "Use Case 2" appears mid-string. We need the substring match
  // there so the previous use case's bullet list still terminates.
  const SECTION_TERMINATORS = [
    /\buse\s*case\s*\d+\b/i,
    /^\s*required\s+data\s+points\s*:?/i,
    /^\s*systems?\s+involved/i,
    /^\s*api\s+keys/i,
    /^\s*success\s+criteria/i,
    /^\s*volume\s*$/i,
    /^\s*key\s+stakeholders/i,
    /^\s*timeline\s*$/i,
    /^\s*scope\s*$/i,
    /^\s*poc\s+build/i,
  ];

  function isTerminator(line) {
    return SECTION_TERMINATORS.some((re) => re.test(line));
  }

  // Bullet detector — tolerates "- ", "• ", "* ", "– " (en-dash sometimes
  // shows up when docs round-trip through pasted Markdown). Returns the
  // text after the marker, or null when the line isn't a bullet.
  function bulletText(line) {
    const m = line.match(/^\s*[-•*–]\s+(.+?)\s*$/);
    return m ? m[1] : null;
  }

  // Use Case header detector. Three layouts in the wild:
  //   1. "Use Case 1 Account Enrichment & Signal Layer" — start of line
  //      (this is how POC docs render the header outside a table).
  //   2. "Account Enrichment & Signal Layer Use Case 1 Account Enrichment..."
  //      — POC templates wrap the header in a 2-column Google Docs table
  //      (left cell = section name, right cell = the actual title). When
  //      exported as txt, both cells flatten onto one line separated by
  //      tabs (which the parser already normalized to spaces). The right
  //      cell is the canonical title.
  //   3. "Use Case 1: ..." / "Use Case 1 - ..." — explicit separators.
  //
  // Matching anywhere in the line covers all three. We capture the trailing
  // name so the cluster's comment card carries a human-readable label.
  // Prose references to "Use Case N" are rare in POC docs (they'd usually
  // be phrased as "this use case" or similar), so the false-positive risk
  // is low; if this becomes a problem we can require the match to start
  // either at line start or after a run of whitespace (post-tab-normalize).
  function useCaseHeader(line) {
    const m = line.match(/\buse\s*case\s*(\d+)[\s:.\-—]*(.*)$/i);
    if (!m) return null;
    const num = parseInt(m[1], 10);
    const name = (m[2] || "").trim();
    return { num, name };
  }

  function parsePocDoc(text) {
    if (typeof text !== "string" || !text.trim()) {
      return { useCases: [], untitled: [] };
    }

    // Split, normalize tabs to single spaces (Google Docs tables export with
    // a leading tab on every cell), and strip CRs.
    const lines = text
      .replace(/\r/g, "")
      .split("\n")
      .map((l) => l.replace(/\t+/g, " "));

    // First pass: locate Use Case headers. The header regex matches anywhere
    // in the line so tabbed Google Docs tables work (see useCaseHeader above).
    // We dedupe by Use Case number — first occurrence wins — so prose
    // references like "as discussed in Use Case 1" don't create a phantom
    // second section once the bulleted list has already been parsed.
    const headerIdx = [];
    const seenNums = new Set();
    for (let i = 0; i < lines.length; i++) {
      const h = useCaseHeader(lines[i]);
      if (!h) continue;
      if (seenNums.has(h.num)) continue;
      seenNums.add(h.num);
      headerIdx.push({ i, ...h });
    }

    const useCases = [];
    const untitled = [];

    if (headerIdx.length === 0) {
      const all = collectAllBullets(lines, 0, lines.length);
      return { useCases: [], untitled: all };
    }

    // Pre-amble bullets (anything before the first Use Case) get tossed into
    // the untitled bucket so a doc with a "Required data points:" preface
    // section doesn't lose those points.
    const preamble = collectAllBullets(lines, 0, headerIdx[0].i);
    if (preamble.length > 0) untitled.push(...preamble);

    for (let s = 0; s < headerIdx.length; s++) {
      const start = headerIdx[s].i;
      const end = s + 1 < headerIdx.length ? headerIdx[s + 1].i : lines.length;
      const bullets = collectBulletsAfterMarker(lines, start, end);
      const titleLine = lines[start].trim();
      const { num, name } = headerIdx[s];
      const displayName = name
        ? `Use Case ${num}: ${name}`
        : `Use Case ${num}`;
      useCases.push({
        num,
        name,
        displayName,
        rawHeader: titleLine,
        dataPoints: dedupeBullets(bullets),
      });
    }

    return { useCases, untitled: dedupeBullets(untitled) };
  }

  // Within a slice of lines, find every "Required data points:" marker and
  // collect bullets until a terminator — supports docs where a single Use
  // Case has multiple "Required data points:" callouts (rare but legal).
  function collectAllBullets(lines, from, to) {
    const out = [];
    let i = from;
    while (i < to) {
      if (/^\s*required\s+data\s+points\s*:?/i.test(lines[i])) {
        const block = collectBulletsAfterMarker(lines, i, to);
        out.push(...block);
        i += 1;
        continue;
      }
      i++;
    }
    return out;
  }

  function collectBulletsAfterMarker(lines, from, to) {
    const out = [];
    let i = from;
    let started = false;
    let currentBullet = null;
    while (i < to) {
      const line = lines[i];
      if (!started) {
        if (/^\s*required\s+data\s+points\s*:?/i.test(line)) {
          started = true;
        }
        i++;
        continue;
      }

      const trimmed = line.trim();
      const bullet = bulletText(line);

      if (bullet != null) {
        if (currentBullet) out.push(currentBullet);
        currentBullet = bullet;
      } else if (!trimmed) {
        // Blank line: flush the current bullet and treat it as a soft break.
        // Don't terminate yet — some docs have a blank line between bullets.
        if (currentBullet) {
          out.push(currentBullet);
          currentBullet = null;
        }
      } else if (isTerminator(trimmed)) {
        break;
      } else if (currentBullet) {
        // Continuation line (e.g. wrapped parenthetical). Append with a
        // single space; collapse runs of whitespace so the result stays
        // tidy regardless of how the source was formatted.
        currentBullet = `${currentBullet} ${trimmed}`.replace(/\s+/g, " ");
      }
      i++;
    }
    if (currentBullet) out.push(currentBullet);
    return out;
  }

  function dedupeBullets(bullets) {
    const seen = new Set();
    const out = [];
    for (const b of bullets) {
      const key = b.toLowerCase().replace(/\s+/g, " ").trim();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(b.trim());
    }
    return out;
  }

  // ---- Canvas application --------------------------------------------------
  //
  // Each Use Case becomes a real cb-group (the labeled, bordered container
  // Shift+Enter creates from a multi-card selection). The Use Case title
  // becomes the group's editable label; the DPs are independent cards
  // wrapped by the group container — they keep their own positions,
  // selection, and credit math instead of being magnetically snapped via
  // a `groupCluster`. Implementation: stamp DPs first, collect their ids,
  // then call `canvas.groupCardsByIds(ids, label)` which drives the same
  // path the Shift+Enter shortcut uses.

  // Card dimensions — must match the values in src/table-import.js (CARD_W,
  // CARD_H) so a future mixed canvas (POC import + table import) lays out
  // consistently.
  const CARD_W = 220;
  const CARD_H = 96;
  // Per-card stride: card size + gap. The gap MUST exceed
  // ADJACENCY_TOLERANCE (1px in canvas/snap.js) on both axes — otherwise
  // touching-edge cards end up bucketed into the same snap-cluster, which
  // visually fuses them into one bordered block. Without this gap the
  // cards inside a cb-group would still snap-cluster despite being
  // "independent" (the group container only governs the bordered shell;
  // individual snap-cluster behavior still fires off card-to-card
  // adjacency). 20px horizontal / 24px vertical mirror the existing
  // table-import strides (CARD_H_GAP=230, CARD_V_GAP=120).
  const CARD_X_STRIDE = CARD_W + 20;
  const CARD_Y_STRIDE = CARD_H + 24;
  // Vertical reserve above the first card row of each group so the group's
  // dashed border + title header has room to draw without overlapping the
  // previous group below it. Mirrors the topPad+hdrH math in
  // canvas/groups.js updateGroupBounds (level 0: pad=20, hdrH=48 → ~68px),
  // rounded up for safety.
  const GROUP_HEADER_RESERVE = 80;
  const GROUP_V_GAP = 40;
  const COLS = 4;

  // Find the lowest currently-used Y so new groups drop beneath anything
  // already on the canvas (mirrors startAddDataPoint in src/table-view.js).
  // Returns the next free Y; 100 when the canvas is empty.
  function findStartingY() {
    const canvas = __cb.canvas;
    if (!canvas) return 100;
    const cards = canvas.getCards();
    if (cards.length === 0) return 100;
    let maxBottom = -Infinity;
    for (const c of cards) {
      const bottom = c.y + CARD_H;
      if (bottom > maxBottom) maxBottom = bottom;
    }
    return maxBottom + GROUP_V_GAP;
  }

  function applyImport(parsed) {
    const canvas = __cb.canvas;
    if (!canvas) {
      throw new Error("Canvas isn't ready yet — open a brainstorm first.");
    }

    const startX = 80;
    let currentY = findStartingY() + GROUP_HEADER_RESERVE;
    let totalDpAdded = 0;
    let totalGroupsAdded = 0;

    const buckets = [];
    for (const uc of parsed.useCases) {
      if (uc.dataPoints.length === 0) continue;
      buckets.push({
        title: uc.displayName,
        dataPoints: uc.dataPoints,
      });
    }
    if (parsed.untitled.length > 0) {
      buckets.push({
        title: "POC data points",
        dataPoints: parsed.untitled,
      });
    }

    if (buckets.length === 0) {
      throw new Error(
        "Couldn't find any \"Required data points:\" bullets in the document.",
      );
    }

    for (const bucket of buckets) {
      const stampedIds = [];
      for (let i = 0; i < bucket.dataPoints.length; i++) {
        const r = Math.floor(i / COLS);
        const c = i % COLS;
        // No `groupCluster` here on purpose — we want the cards to be
        // independent (free to move, no snap-magnet). The cb-group we
        // create below is what binds them together visually with a title.
        const card = canvas.addDataPointCard(bucket.dataPoints[i], {
          x: startX + c * CARD_X_STRIDE,
          y: currentY + r * CARD_Y_STRIDE,
        });
        if (card?.id != null) stampedIds.push(card.id);
      }

      // Wrap them in a labeled group container. groupCardsByIds requires
      // ≥2 cards — single-DP buckets fall through ungrouped (they show up
      // as flat rows in the table view, which is the right call when
      // there's only one DP to title anyway).
      if (stampedIds.length >= 2 && typeof canvas.groupCardsByIds === "function") {
        canvas.groupCardsByIds(stampedIds, bucket.title);
      }

      const rowCount = Math.max(1, Math.ceil(bucket.dataPoints.length / COLS));
      currentY += rowCount * CARD_Y_STRIDE + GROUP_V_GAP + GROUP_HEADER_RESERVE;
      totalDpAdded += bucket.dataPoints.length;
      totalGroupsAdded += 1;
    }

    // POC import drops fresh DP + comment cards in a grid and lets snap-
    // derive cluster them by adjacency. Empty dragCardIds keeps any
    // pre-existing cards on the canvas from being re-bucketed.
    if (canvas.refreshClusters) canvas.refreshClusters({ dragCardIds: new Set() });
    if (canvas.notifyChange) canvas.notifyChange();
    if (canvas.refreshCreditTotal) canvas.refreshCreditTotal();

    return { groups: totalGroupsAdded, dataPoints: totalDpAdded };
  }

  // ---- Modal UI -------------------------------------------------------------

  function closeModal() {
    if (modalEl) {
      modalEl.remove();
      modalEl = null;
    }
    if (backdropEl) {
      backdropEl.remove();
      backdropEl = null;
    }
    document.removeEventListener("keydown", onKeydown);
  }

  function onKeydown(evt) {
    if (evt.key === "Escape") {
      evt.preventDefault();
      closeModal();
    }
  }

  function showModal() {
    closeModal();

    backdropEl = document.createElement("div");
    backdropEl.className = "cb-poc-import-backdrop";
    backdropEl.addEventListener("click", closeModal);

    modalEl = document.createElement("div");
    modalEl.className = "cb-poc-import-modal";
    modalEl.addEventListener("click", (evt) => evt.stopPropagation());

    const header = document.createElement("div");
    header.className = "cb-poc-import-header";
    const title = document.createElement("div");
    title.className = "cb-poc-import-title";
    title.textContent = "Upload POC document";
    const sub = document.createElement("div");
    sub.className = "cb-poc-import-sub";
    sub.textContent =
      "Drop in a Google Doc link or paste the contents. Each \u201cUse Case\u201d with a \u201cRequired data points\u201d list becomes a group on your canvas.";
    header.appendChild(title);
    header.appendChild(sub);
    modalEl.appendChild(header);

    const body = document.createElement("div");
    body.className = "cb-poc-import-body";

    const urlField = document.createElement("div");
    urlField.className = "cb-poc-import-field";
    const urlLabel = document.createElement("label");
    urlLabel.className = "cb-poc-import-label";
    urlLabel.textContent = "Google Doc link";
    const urlHint = document.createElement("span");
    urlHint.className = "cb-poc-import-hint";
    urlHint.textContent = "Must be shared as \u201cAnyone with the link\u201d";
    urlLabel.appendChild(urlHint);
    const urlInput = document.createElement("input");
    urlInput.type = "url";
    urlInput.className = "cb-poc-import-input";
    urlInput.placeholder = "https://docs.google.com/document/d/\u2026";
    urlInput.autocomplete = "off";
    urlField.appendChild(urlLabel);
    urlField.appendChild(urlInput);
    body.appendChild(urlField);

    const orRow = document.createElement("div");
    orRow.className = "cb-poc-import-or";
    orRow.textContent = "or";
    body.appendChild(orRow);

    const pasteField = document.createElement("div");
    pasteField.className = "cb-poc-import-field";
    const pasteLabel = document.createElement("label");
    pasteLabel.className = "cb-poc-import-label";
    pasteLabel.textContent = "Paste doc contents";
    const pasteArea = document.createElement("textarea");
    pasteArea.className = "cb-poc-import-textarea";
    pasteArea.placeholder =
      "Paste the POC overview here. The importer will extract every \u201cRequired data points\u201d list it finds.";
    pasteArea.rows = 10;
    pasteField.appendChild(pasteLabel);
    pasteField.appendChild(pasteArea);
    body.appendChild(pasteField);

    const status = document.createElement("div");
    status.className = "cb-poc-import-status";
    body.appendChild(status);

    modalEl.appendChild(body);

    const footer = document.createElement("div");
    footer.className = "cb-poc-import-footer";
    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.className = "cb-poc-import-btn cb-poc-import-btn-secondary";
    cancelBtn.textContent = "Cancel";
    cancelBtn.addEventListener("click", closeModal);
    const importBtn = document.createElement("button");
    importBtn.type = "button";
    importBtn.className = "cb-poc-import-btn cb-poc-import-btn-primary";
    importBtn.textContent = "Import";
    importBtn.addEventListener("click", () => doImport(urlInput, pasteArea, status, importBtn));
    footer.appendChild(cancelBtn);
    footer.appendChild(importBtn);
    modalEl.appendChild(footer);

    document.body.appendChild(backdropEl);
    document.body.appendChild(modalEl);
    document.addEventListener("keydown", onKeydown);

    // Default focus follows the rep's likely first action: paste contents.
    setTimeout(() => pasteArea.focus(), 0);
  }

  function setStatus(statusEl, kind, text) {
    statusEl.className = `cb-poc-import-status cb-poc-import-status-${kind}`;
    statusEl.textContent = text;
  }

  function clearStatus(statusEl) {
    statusEl.className = "cb-poc-import-status";
    statusEl.textContent = "";
  }

  async function doImport(urlInput, pasteArea, statusEl, importBtn) {
    const url = urlInput.value.trim();
    const pasted = pasteArea.value;

    if (!url && !pasted.trim()) {
      setStatus(statusEl, "error", "Add a Google Doc link or paste contents to continue.");
      return;
    }

    importBtn.disabled = true;
    importBtn.classList.add("cb-poc-import-btn-loading");

    try {
      let text = pasted;
      if (url) {
        const docId = extractGoogleDocId(url);
        if (!docId) {
          throw new Error("That doesn't look like a Google Doc link. Expected /document/d/<id>/...");
        }
        setStatus(statusEl, "info", "Fetching doc\u2026");
        text = await fetchGoogleDoc(docId);
      }

      const parsed = parsePocDoc(text);
      const result = applyImport(parsed);

      const groupsLabel = result.groups === 1 ? "group" : "groups";
      const dpsLabel = result.dataPoints === 1 ? "data point" : "data points";
      setStatus(
        statusEl,
        "success",
        `Imported ${result.groups} ${groupsLabel} (${result.dataPoints} ${dpsLabel}).`,
      );
      // Brief delay so the rep sees the success message before the modal
      // closes — same UX pattern other Clay modals use after a save.
      setTimeout(closeModal, 700);
    } catch (err) {
      console.error("[Clay Scoping] POC import failed:", err);
      setStatus(statusEl, "error", err?.message || "Import failed. Try pasting the doc contents directly.");
    } finally {
      importBtn.disabled = false;
      importBtn.classList.remove("cb-poc-import-btn-loading");
    }
  }

  // ---- Public API -----------------------------------------------------------

  __cb.startPocImport = function () {
    showModal();
  };

  // Exposed for test/inspection — not used elsewhere in production.
  __cb.parsePocDoc = parsePocDoc;
  __cb.extractGoogleDocId = extractGoogleDocId;
})();
