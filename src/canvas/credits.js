(function () {
  "use strict";

  window.__cbCanvasModules = window.__cbCanvasModules || {};

  window.__cbCanvasModules.createCreditHelpers = function createCreditHelpers(deps) {
    // Credits are derived from the semantic model only: DP↔ER association comes
    // from lineage (`sourceEnrichmentFieldId`), never canvas geometry/clusters.
    // This keeps the canvas per-DP cost pill AND the per-group credit badge in
    // agreement with the lineage-driven table regardless of card positions.
    const { cardsRef, groupsRef, getCardById, getGroupEl, cardsInGroup } = deps;

    // Cost primitives now live in the shared model (src/cost-model.js) so the
    // canvas summary, table view, and export calc can't drift. Thin local
    // aliases keep the call sites below readable.
    const isNonErType = (type) => window.__cb.cost.isNonErType(type);
    const coverageRatio = (card, records) =>
      window.__cb.cost.coverageRatio(card, records);

    function notifyCreditTotal() {
      const cb = window.__cb;
      const isActual = cb.viewMode === "actual";

      // Multi-use-case (2+ imported tables): compute the grand total + per-use-
      // case breakdown here (each ER x ITS table's records/frequency, "other"
      // excluded). recalcTotal consumes cb._multiTotals when set; at <= 1 use
      // case it's null and the single-scope path below is unchanged. First sync
      // each table's records into its ERs' coverageRows so cost + the Coverage
      // column agree (import seeds coverage from the global records, not per
      // table).
      if (cb.cost.useCaseCount() >= 2) {
        cb.cost.syncUseCaseCoverage();
        cb._multiTotals = cb.cost.computeUseCaseTotals(cardsRef(), { viewMode: cb.viewMode });
      } else {
        cb._multiTotals = null;
      }

      if (isActual) {
        // Actual mode: per-row cost comes from measured spend
        // (data.stats.spend = credits/actions/cellCount from Clay's realtime
        // credit usage). Each column's real per-row cost = spend / cells that
        // ran. We sum those across columns for the per-row "Avg" boxes, and a
        // SECOND frequency-weighted sum (each column × its own frequency) for
        // the "Total" boxes — which recalcTotal multiplies by Records.
        //
        // Frequency is a GTME scoping lever, decorrelated from the run stats:
        // run stats fix the measured per-row cost; frequency dials how many
        // times per year that cost recurs. So it must weight Actual exactly
        // like Projected (per ER, honoring per-card overrides), not as a
        // single global multiplier.
        let perRowCredits = 0;
        let perRowActions = 0;
        let weightedCreditTotal = 0;
        let weightedActionExecTotal = 0;
        const globalFreqId = cb.getCurrentFrequencyId
          ? cb.getCurrentFrequencyId()
          : cb.DEFAULT_FREQUENCY_ID;
        for (const c of cardsRef()) {
          if (isNonErType(c.data.type)) continue;
          // fallbackToProjected:false → no-spend cards contribute 0 (the
          // summary's long-standing behavior; the table view falls back to
          // projected instead, which is intentional there).
          const { credits: rowCredits, actions: rowActions, noSpend } =
            cb.cost.perRowCost(c, { viewMode: "actual", fallbackToProjected: false });
          if (noSpend) continue;
          const freqId = c.data.frequencyCustom
            ? c.data.frequency
            : (c.data.frequency || globalFreqId);
          const mult = cb.getFrequencyMultiplier ? cb.getFrequencyMultiplier(freqId) : 1;
          perRowCredits += rowCredits;
          perRowActions += rowActions;
          weightedCreditTotal += rowCredits * mult;
          weightedActionExecTotal += rowActions * mult;
        }
        if (cb.updateCreditTotal) {
          cb.updateCreditTotal(
            perRowCredits,
            perRowActions,
            weightedCreditTotal,
            weightedActionExecTotal
          );
        }
        return;
      }

      // Projected mode (existing behavior).
      // Unweighted per-row sums drive the "Avg Credits / Row" and
      // "Actions / Row" boxes — those numbers should stay honest about a
      // single execution regardless of how often the ER is scheduled.
      let creditTotal = 0;
      let actionExecTotal = 0;
      // Frequency-weighted per-row sums drive the "Total Credits" and
      // "Total Actions" boxes (which get multiplied by Records downstream).
      // Each ER contributes its credits * its own frequency multiplier — so
      // a cluster of 3 ERs all set to "monthly" weighs 3 * 12x, same as if
      // every ER were marked individually.
      let weightedCreditTotal = 0;
      let weightedActionExecTotal = 0;
      const globalFreqId = cb.getCurrentFrequencyId
        ? cb.getCurrentFrequencyId()
        : cb.DEFAULT_FREQUENCY_ID;
      const records = cb.getRecordsCount ? cb.getRecordsCount() : 0;
      // Projected cost bills on fill (filled cells), not coverage (attempts) —
      // built once so billableFraction is O(1) per ER.
      const erFillMap = cb.cost.buildErFillMap(cardsRef());
      for (const c of cardsRef()) {
        if (isNonErType(c.data.type)) continue;
        // perRowCost returns 0 credits for private-key ERs, so the
        // unconditional adds below match the prior `if (!usePrivateKey)` guard.
        const { credits, actions } = cb.cost.perRowCost(c, { viewMode: "projected" });
        const freqId = c.data.frequencyCustom
          ? c.data.frequency
          : (c.data.frequency || globalFreqId);
        const mult = cb.getFrequencyMultiplier
          ? cb.getFrequencyMultiplier(freqId)
          : 1;
        // Coverage × fill scales the weighted (total) slots only — the per-row
        // "Avg" boxes stay honest about a single execution.
        const billMult = mult * cb.cost.billableFraction(c, records, erFillMap);
        creditTotal += credits;
        weightedCreditTotal += credits * billMult;
        actionExecTotal += actions;
        weightedActionExecTotal += actions * billMult;
      }
      if (cb.updateCreditTotal) {
        cb.updateCreditTotal(
          creditTotal,
          actionExecTotal,
          weightedCreditTotal,
          weightedActionExecTotal
        );
      }
    }

    // ER lineage key, identical to the table view's: action field id for
    // standalone / basic-group ERs, "wf:<groupCluster>" for waterfalls.
    function erLineageKey(c) {
      if (!c || !c.data || isNonErType(c.data.type)) return null;
      return c.data.type === "waterfall"
        ? (c.data.groupCluster != null ? `wf:${c.data.groupCluster}` : null)
        : (c.data.fieldId ?? null);
    }

    // Shared lineage index for the per-DP cost pill and the per-group credit
    // badge. `erByKey` maps each enrichment's lineage key (action field id, or
    // `wf:<groupCluster>` for waterfalls) to its ER card; `dpCountByKey` counts
    // how many data points each enrichment feeds, so a DP's cost is the ER's
    // credits split across all its DPs (matching the table).
    function buildLineageIndex() {
      const allCards = cardsRef();
      const erByKey = new Map();
      for (const c of allCards) {
        const key = erLineageKey(c);
        if (key != null && !erByKey.has(key)) erByKey.set(key, c);
      }
      const cb = window.__cb;
      const dpCountByKey = new Map();
      for (const c of allCards) {
        if (c.data.type !== "dp") continue;
        // A DP can feed off multiple ERs — count it under each linked key so
        // every ER's cost still splits across all the DPs it feeds.
        for (const key of cb.dpErKeys(c)) {
          if (!erByKey.has(key)) continue;
          dpCountByKey.set(key, (dpCountByKey.get(key) || 0) + 1);
        }
      }
      return { erByKey, dpCountByKey };
    }

    // Projected run-share for a DP's linked ER (mirrors table-view): stored
    // override, else the primary-weighted default split (1.0 for a lone ER).
    function dpShareFor(card, key, idx, n) {
      const cb = window.__cb;
      if (n <= 1) return 1;
      const stored = cb.dpErShare ? cb.dpErShare(card, key) : null;
      return stored != null ? stored : (cb.defaultErShare ? cb.defaultErShare(idx, n) : 1 / n);
    }

    function updateDpCosts() {
      const allCards = cardsRef();

      // Match data points to their enrichment by LINEAGE
      // (data.sourceEnrichmentFieldId), not canvas geometry — so the canvas
      // "~N / row" / "Not connected" pill agrees with the lineage-driven table.
      const { erByKey, dpCountByKey } = buildLineageIndex();

      for (const card of allCards) {
        if (card.data.type !== "dp") continue;
        const costEl = card.el?.querySelector(".cb-dp-cost");
        if (!costEl) continue;
        const textSpan = costEl.querySelector("span");
        if (!textSpan) continue;

        const cb = window.__cb;
        const keys = cb.dpErKeys(card).filter((k) => erByKey.has(k));
        if (keys.length === 0) {
          textSpan.textContent = "Not connected";
          costEl.classList.remove("cb-dp-cost-linked");
          continue;
        }

        costEl.classList.add("cb-dp-cost-linked");
        // DP cost = Σ share_i × (ER credits / # DPs that ER feeds).
        let perDpCost = 0;
        for (let i = 0; i < keys.length; i++) {
          const er = erByKey.get(keys[i]);
          const count = dpCountByKey.get(keys[i]) || 1;
          const credits = er.data.usePrivateKey
            ? 0
            : (er.data.credits != null ? Number(er.data.credits) : 0);
          perDpCost += dpShareFor(card, keys[i], i, keys.length) * (credits / count);
        }
        if (perDpCost > 0) {
          const display = perDpCost % 1 === 0 ? perDpCost : perDpCost.toFixed(1);
          textSpan.textContent = `~${display} / row`;
        } else {
          textSpan.textContent = keys.length > 1 ? `${keys.length} enrichments linked` : "1 enrichment linked";
        }
      }
    }

    function updateGroupCredits() {
      // Lineage-based (not cluster-based): a group's cost is attributed the
      // same way the canvas DP pill and the table are — each data point in the
      // group carries its share (ER credits ÷ all DPs that ER feeds), and any
      // ER in the group whose output DPs aren't represented anywhere counts its
      // full cost directly. So the badge agrees with the table regardless of
      // canvas geometry.
      const { erByKey, dpCountByKey } = buildLineageIndex();
      // Projected billable fraction (coverage × fill) per ER — built once.
      const erFillMap = window.__cb.cost.buildErFillMap(cardsRef());

      for (const g of groupsRef()) {
        const el = getGroupEl ? getGroupEl(g.id) : null;
        const badge = el ? el.querySelector(".cb-group-credits") : null;
        if (!badge) continue;
        const members = cardsInGroup
          ? cardsInGroup(g.id, { deep: true })
          : cardsRef().filter((c) => c.groupId === g.id);
        const records = window.__cb.getRecordsCount ? window.__cb.getRecordsCount() : 0;

        // `sum` stays the honest per-row figure (drives the "/ row" badge).
        // `weightedSum` folds in each ER's billable fraction (coverage × fill)
        // so the group total (× records) reflects coverage + fill overrides.
        let sum = 0;
        let actionSum = 0;
        let weightedSum = 0;
        let weightedActionSum = 0;
        let hasCredits = false;

        // Data point members contribute their per-DP share of each source ER's
        // cost — the exact figure updateDpCosts renders on the canvas pill.
        for (const c of members) {
          if (c.data.type !== "dp") continue;
          const keys = window.__cb.dpErKeys(c).filter((k) => erByKey.has(k));
          for (let i = 0; i < keys.length; i++) {
            const er = erByKey.get(keys[i]);
            const count = dpCountByKey.get(keys[i]) || 1;
            const cov = window.__cb.cost.billableFraction(er, records, erFillMap);
            const share = dpShareFor(c, keys[i], i, keys.length);
            if (!er.data.usePrivateKey && er.data.credits != null && er.data.credits > 0) {
              sum += share * (er.data.credits / count);
              weightedSum += share * (er.data.credits / count) * cov;
              hasCredits = true;
            }
            if (er.data.actionExecutions != null && er.data.actionExecutions > 0) {
              actionSum += share * (er.data.actionExecutions / count);
              weightedActionSum += share * (er.data.actionExecutions / count) * cov;
            }
          }
        }

        // ER members whose extracted DPs aren't represented anywhere (standalone
        // enrichments with no data point cards) count their full cost. ERs that
        // DO feed DPs are already attributed via those DPs' shares above, so we
        // skip them here to avoid double counting.
        for (const c of members) {
          if (isNonErType(c.data.type)) continue;
          const key = erLineageKey(c);
          if ((dpCountByKey.get(key) || 0) > 0) continue;
          const cov = window.__cb.cost.billableFraction(c, records, erFillMap);
          if (!c.data.usePrivateKey && c.data.credits != null && c.data.credits > 0) {
            sum += c.data.credits;
            weightedSum += c.data.credits * cov;
            hasCredits = true;
          }
          if (c.data.actionExecutions != null && c.data.actionExecutions > 0) {
            actionSum += c.data.actionExecutions;
            weightedActionSum += c.data.actionExecutions * cov;
          }
        }

        if (!hasCredits) {
          badge.textContent = "";
          badge.style.display = "none";
          continue;
        }
        badge.style.display = "";
        const display = sum % 1 === 0 ? sum.toString() : sum.toFixed(1);

        const cb = window.__cb;
        const creditCost = cb.getCreditCost ? cb.getCreditCost() : 0;
        const actionCost = cb.getActionCost ? cb.getActionCost() : 0;

        let badgeText = `~${display} / row`;
        if (records > 0) {
          const totalCredits = weightedSum * records;
          const totalActions = weightedActionSum * records;
          const totalDisplay = totalCredits % 1 === 0
            ? totalCredits.toLocaleString()
            : totalCredits.toLocaleString(undefined, { maximumFractionDigits: 1 });
          badgeText += ` · ${totalDisplay}`;
          const totalDollars = totalCredits * creditCost + totalActions * actionCost;
          if (totalDollars > 0) {
            badgeText += ` · $${totalDollars.toLocaleString(undefined, {
              minimumFractionDigits: 2,
              maximumFractionDigits: 2,
            })}`;
          }
        }

        badge.innerHTML =
          '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" fill="currentColor" viewBox="0 0 256 256"><path d="M207.58,63.84C186.85,53.48,159.33,48,128,48S69.15,53.48,48.42,63.84,16,88.78,16,104v48c0,15.22,11.82,29.85,32.42,40.16S96.67,208,128,208s58.85-5.48,79.58-15.84S240,167.22,240,152V104C240,88.78,228.18,74.15,207.58,63.84Z" opacity="0.2"/><path d="M128,64c62.64,0,96,23.23,96,40s-33.36,40-96,40-96-23.23-96-40S65.36,64,128,64Z"/></svg>' +
          `<span>${badgeText}</span>`;
      }
    }

    return { notifyCreditTotal, updateDpCosts, updateGroupCredits };
  };
})();
