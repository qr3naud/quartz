(function () {
  "use strict";

  window.__cbCanvasModules = window.__cbCanvasModules || {};

  window.__cbCanvasModules.createCreditHelpers = function createCreditHelpers(deps) {
    const { cardsRef, groupsRef, getCardById, getSnapClusters } = deps;

    function isNonErType(type) {
      return type === "dp" || type === "input" || type === "comment";
    }

    function notifyCreditTotal() {
      const cb = window.__cb;
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
      for (const c of cardsRef()) {
        if (isNonErType(c.data.type)) continue;
        const credits = c.data.credits ?? 0;
        const actions = c.data.actionExecutions ?? 0;
        const freqId = c.data.frequencyCustom
          ? c.data.frequency
          : (c.data.frequency || globalFreqId);
        const mult = cb.getFrequencyMultiplier
          ? cb.getFrequencyMultiplier(freqId)
          : 1;
        if (!c.data.usePrivateKey) {
          creditTotal += credits;
          weightedCreditTotal += credits * mult;
        }
        actionExecTotal += actions;
        weightedActionExecTotal += actions * mult;
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

    function updateDpCosts() {
      const clusters = getSnapClusters();
      const allCards = cardsRef();
      const dpCostMap = new Map();

      for (const cluster of clusters) {
        const clusterCards = cluster
          .map((id) => allCards.find((c) => c.id === id))
          .filter(Boolean);
        const erCards = clusterCards.filter((c) => !isNonErType(c.data.type));
        const dpCards = clusterCards.filter((c) => c.data.type === "dp");
        if (dpCards.length === 0) continue;

        let totalCredits = 0;
        let hasCredits = false;
        for (const er of erCards) {
          if (er.data.usePrivateKey) continue;
          if (er.data.credits != null && er.data.credits > 0) {
            totalCredits += er.data.credits;
            hasCredits = true;
          }
        }

        const perDpCost = totalCredits / dpCards.length;

        for (const dp of dpCards) {
          dpCostMap.set(dp.id, {
            perDpCost,
            hasCredits,
            enrichmentCount: erCards.length,
          });
        }
      }

      for (const card of allCards) {
        if (card.data.type !== "dp") continue;
        const costEl = card.el.querySelector(".cb-dp-cost");
        if (!costEl) continue;
        const textSpan = costEl.querySelector("span");
        if (!textSpan) continue;

        const info = dpCostMap.get(card.id);

        if (!info || info.enrichmentCount === 0) {
          textSpan.textContent = "Not connected";
          costEl.classList.remove("cb-dp-cost-linked");
          continue;
        }

        costEl.classList.add("cb-dp-cost-linked");
        if (info.hasCredits) {
          const display =
            info.perDpCost % 1 === 0
              ? info.perDpCost
              : info.perDpCost.toFixed(1);
          textSpan.textContent = `~${display} / row`;
        } else {
          textSpan.textContent = `${info.enrichmentCount} enrichment${info.enrichmentCount > 1 ? "s" : ""} linked`;
        }
      }
    }

    function updateGroupCredits() {
      const clusters = getSnapClusters();

      for (const g of groupsRef()) {
        const badge = g.el.querySelector(".cb-group-credits");
        if (!badge) continue;
        const members = cardsRef().filter((c) => g.cardIds.has(c.id));

        let sum = 0;
        let actionSum = 0;
        let hasCredits = false;
        const countedErIds = new Set();

        for (const c of members) {
          if (c.data.type !== "dp") continue;
          for (const cluster of clusters) {
            if (!cluster.includes(c.id)) continue;
            const clusterCards = cluster
              .map((id) => cardsRef().find((cc) => cc.id === id))
              .filter(Boolean);
            const erCards = clusterCards.filter((cc) => !isNonErType(cc.data.type));
            const dpCards = clusterCards.filter((cc) => cc.data.type === "dp");
            if (dpCards.length === 0) break;

            for (const er of erCards) {
              countedErIds.add(er.id);
              if (!er.data.usePrivateKey && er.data.credits != null && er.data.credits > 0) {
                sum += er.data.credits / dpCards.length;
                hasCredits = true;
              }
              if (er.data.actionExecutions != null && er.data.actionExecutions > 0) {
                actionSum += er.data.actionExecutions / dpCards.length;
              }
            }
            break;
          }
        }

        for (const c of members) {
          if (isNonErType(c.data.type)) continue;
          if (countedErIds.has(c.id)) continue;
          if (!c.data.usePrivateKey && c.data.credits != null && c.data.credits > 0) {
            sum += c.data.credits;
            hasCredits = true;
          }
          if (c.data.actionExecutions != null && c.data.actionExecutions > 0) {
            actionSum += c.data.actionExecutions;
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
        const records = cb.getRecordsCount ? cb.getRecordsCount() : 0;
        const creditCost = cb.getCreditCost ? cb.getCreditCost() : 0;
        const actionCost = cb.getActionCost ? cb.getActionCost() : 0;

        let badgeText = `~${display} / row`;
        if (records > 0) {
          const totalCredits = sum * records;
          const totalActions = actionSum * records;
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
