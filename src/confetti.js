(function () {
  "use strict";

  const cb = (window.__cb = window.__cb || {});

  const FALLBACK_COLORS = ["#f59e0b", "#fbbf24", "#b45309", "#fde68a", "#ffffff", "#fcd34d"];

  function stampColors() {
    const root = getComputedStyle(document.documentElement);
    const pick = (name, fallback) => root.getPropertyValue(name).trim() || fallback;
    return [
      pick("--cb-amber", "#f59e0b"),
      "#fbbf24",
      pick("--cb-amber-text", "#b45309"),
      "#fde68a",
      "#ffffff",
      "#fcd34d",
    ];
  }

  function originFromAnchor(anchorEl) {
    const r = anchorEl.getBoundingClientRect();
    return {
      x: (r.left + r.width / 2) / window.innerWidth,
      y: (r.top + r.height / 2) / window.innerHeight,
    };
  }

  cb.fireStampConfetti = function fireStampConfetti(anchorEl) {
    if (!anchorEl || typeof confetti !== "function") return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    const origin = originFromAnchor(anchorEl);
    const colors = stampColors();
    const base = { origin, colors, zIndex: 10000002, disableForReducedMotion: true };

    confetti({
      ...base,
      particleCount: 100,
      spread: 70,
      startVelocity: 45,
      ticks: 200,
    });

    setTimeout(() => {
      confetti({
        ...base,
        particleCount: 70,
        spread: 120,
        startVelocity: 35,
        ticks: 180,
      });
    }, 100);
  };
})();
