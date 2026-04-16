(function () {
  "use strict";

  window.__cbCanvasModules = window.__cbCanvasModules || {};

  window.__cbCanvasModules.createGraphQueries = function createGraphQueries(deps) {
    const { cardsRef, getCardById } = deps;

    function getCardType(card) {
      if (card?.data.type === "dp") return "dp";
      if (card?.data.type === "input") return "input";
      if (card?.data.type === "comment") return "comment";
      return "er";
    }

    function isOppositeType(sourceCard, targetCard) {
      if (!sourceCard || !targetCard) return false;
      return getCardType(sourceCard) !== getCardType(targetCard);
    }

    function getLinkedCardIds() { return []; }
    function getLinkedEnrichmentIdsForDp() { return []; }
    function getLinkedDpIdsForEnrichment() { return []; }
    function getOppositeLinkedIds() { return []; }

    return {
      getCardType,
      isOppositeType,
      getLinkedCardIds,
      getLinkedEnrichmentIdsForDp,
      getLinkedDpIdsForEnrichment,
      getOppositeLinkedIds,
    };
  };
})();
