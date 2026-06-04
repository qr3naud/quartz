/**
 * Pricing datasets loader (internal-only).
 *
 * Reads the active rows of the `pricing` table (enterprise floors, self-serve
 * list bands, contract-year multipliers, approval-rule catalog) via the
 * authenticated Supabase client and exposes them on `__cb.pricing`, with
 * in-bundle fallbacks so the helpers keep working offline or before the fetch
 * resolves. The table is RLS-gated to Clay-internal callers, so non-internal
 * users simply get no rows and fall back to these constants.
 *
 * Vocabulary (see supabase/migrations/20260602000000_phase5_pricing.sql):
 *   - enterprise floors: negotiable; each band has floors {rep, manager, dealDesk}.
 *     Credit floors are progressive (highest tier where avg >= volume); action
 *     floors are closest-match. Multi-year via contract_year_multipliers.
 *   - self-serve bands: fixed list; each band has a `rate` (annual CPC, or for
 *     actions a {launch, growth} map). Monthly is derived via annualToMonthly;
 *     price = volume * rate (never stored).
 *
 * The approval math mirrors the calculator's calculateApprovalStatus:
 * below manager floor -> pending_exception (deal desk); below rep floor ->
 * pending_standard (manager); plus the volume special-cases.
 */
(function () {
  "use strict";

  const __cb = (window.__cb = window.__cb || {});

  // Reference list prices used when a rep hasn't set an adjusted price, and as
  // the "savings vs list" baseline in the pricing view. Matches the GTME
  // calculator's enterprise defaults: $0.05 / credit, $0.008 / action.
  const LIST_CPC = 0.05;
  const LIST_CPA = 0.008;

  // --------------------------------------------------------------------------
  // In-bundle fallback (kept in sync with the phase5 seed). Used when the DB
  // read fails or returns nothing (non-internal / offline).
  // --------------------------------------------------------------------------
  const FALLBACK = {
    enterprise_credit_floors: {
      model: "enterprise", metric: "credit", selection: "progressive", period: "annual",
      bands: [
        { tier: "XS", volume: 600000,    floors: { rep: 0.0383, manager: 0.0383, dealDesk: 0.0383 } },
        { tier: 6,    volume: 1200000,   floors: { rep: 0.0383, manager: 0.0371, dealDesk: 0.0371 } },
        { tier: 7,    volume: 2400000,   floors: { rep: 0.0379, manager: 0.0364, dealDesk: 0.0360 } },
        { tier: 8,    volume: 5000000,   floors: { rep: 0.0375, manager: 0.0357, dealDesk: 0.0349 } },
        { tier: 9,    volume: 7500000,   floors: { rep: 0.0371, manager: 0.0351, dealDesk: 0.0339 } },
        { tier: 10,   volume: 10000000,  floors: { rep: 0.0368, manager: 0.0344, dealDesk: 0.0329 } },
        { tier: 11,   volume: 15000000,  floors: { rep: 0.0364, manager: 0.0338, dealDesk: 0.0319 } },
        { tier: 12,   volume: 20000000,  floors: { rep: 0.0360, manager: 0.0331, dealDesk: 0.0309 } },
        { tier: 13,   volume: 30000000,  floors: { rep: 0.0357, manager: 0.0325, dealDesk: 0.0300 } },
        { tier: 14,   volume: 40000000,  floors: { rep: 0.0353, manager: 0.0319, dealDesk: 0.0291 } },
        { tier: 15,   volume: 50000000,  floors: { rep: 0.0349, manager: 0.0313, dealDesk: 0.0282 } },
        { tier: 16,   volume: 75000000,  floors: { rep: 0.0346, manager: 0.0307, dealDesk: 0.0274 } },
        { tier: 17,   volume: 100000000, floors: { rep: 0.0343, manager: 0.0302, dealDesk: 0.0266 } },
      ],
    },
    enterprise_action_floors: {
      model: "enterprise", metric: "action", selection: "closest", period: "annual",
      bands: [
        { tier: "XS", volume: 1500000,   floors: { rep: 0.0080, manager: 0.0080, dealDesk: 0.0080 } },
        { tier: "A",  volume: 2400000,   floors: { rep: 0.0072, manager: 0.0064, dealDesk: 0.0064 } },
        { tier: "B",  volume: 5000000,   floors: { rep: 0.0068, manager: 0.0056, dealDesk: 0.0056 } },
        { tier: "C",  volume: 7500000,   floors: { rep: 0.0063, manager: 0.0051, dealDesk: 0.0049 } },
        { tier: "D",  volume: 10000000,  floors: { rep: 0.0059, manager: 0.0047, dealDesk: 0.0043 } },
        { tier: "E",  volume: 15000000,  floors: { rep: 0.0056, manager: 0.0044, dealDesk: 0.0039 } },
        { tier: "F",  volume: 20000000,  floors: { rep: 0.0052, manager: 0.0041, dealDesk: 0.0035 } },
        { tier: "G",  volume: 40000000,  floors: { rep: 0.0049, manager: 0.0039, dealDesk: 0.0032 } },
        { tier: "H",  volume: 60000000,  floors: { rep: 0.0046, manager: 0.0036, dealDesk: 0.0029 } },
        { tier: "I",  volume: 80000000,  floors: { rep: 0.0045, manager: 0.0036, dealDesk: 0.0028 } },
        { tier: "J",  volume: 100000000, floors: { rep: 0.0044, manager: 0.0035, dealDesk: 0.0027 } },
        { tier: "K",  volume: 150000000, floors: { rep: 0.0043, manager: 0.0034, dealDesk: 0.0026 } },
        { tier: "L",  volume: 200000000, floors: { rep: 0.0042, manager: 0.0033, dealDesk: 0.0025 } },
      ],
    },
    self_serve_credit_bands: {
      model: "self_serve", metric: "credit", generation: "modern", period: "annual", annualToMonthly: 1.106,
      bands: [
        { tier: 1, plan: "Launch", volume: 30000, rate: 0.0452 },
        { tier: 2, plan: "Launch + Growth", volume: 72000, rate: 0.0435 },
        { tier: 3, plan: "Launch + Growth", volume: 120000, rate: 0.0414 },
        { tier: 4, plan: "Launch + Growth", volume: 240000, rate: 0.0396 },
        { tier: 5, plan: "Launch + Growth", volume: 600000, rate: 0.03826 },
        { tier: 6, plan: "Growth + Enterprise", volume: 1200000, rate: 0.03826 },
      ],
    },
    self_serve_credit_bands_legacy: {
      model: "self_serve", metric: "credit", generation: "legacy", period: "annual", annualToMonthly: 1.111,
      bands: [
        { tier: 1, plan: "Starter", volume: 24000, rate: 0.06704 },
        { tier: 2, plan: "Starter", volume: 36000, rate: 0.06869 },
        { tier: 3, plan: "Explorer", volume: 120000, rate: 0.03141 },
        { tier: 4, plan: "Explorer", volume: 168000, rate: 0.03208 },
        { tier: 5, plan: "Explorer", volume: 240000, rate: 0.03145 },
        { tier: 6, plan: "Pro", volume: 600000, rate: 0.0144 },
        { tier: 7, plan: "Pro", volume: 840000, rate: 0.01286 },
        { tier: 8, plan: "Pro", volume: 1200000, rate: 0.0135 },
        { tier: 9, plan: "Pro", volume: 1800000, rate: 0.012 },
      ],
    },
    self_serve_action_bands: {
      model: "self_serve", metric: "action", period: "annual", annualToMonthly: 1.111,
      bands: [
        { tier: 1, volume: 180000, rate: { launch: 0.0036, growth: null } },
        { tier: 2, volume: 480000, rate: { launch: 0.0034, growth: 0.0046 } },
        { tier: 3, volume: 720000, rate: { launch: 0.0030, growth: 0.0044 } },
        { tier: 4, volume: 1200000, rate: { launch: 0.0026, growth: 0.0041 } },
        { tier: 5, volume: 2400000, rate: { launch: 0.0024, growth: 0.0038 } },
        { tier: 6, volume: 5000000, rate: { launch: 0.00225, growth: 0.0036 } },
      ],
    },
    contract_year_multipliers: {
      twoYear: 0.97, threeYear: 0.95, roundDecimals: 4, clampOrder: ["rep", "manager", "dealDesk"],
    },
    approval_rules: {
      sections: ["pricing", "volume"],
      rules: [
        { section: "pricing", name: "CPC below manager floor", subject: "credit", escalatesTo: "dealDesk", trigger: "actual CPC < manager floor (per credit tier)", description: "Any quote where the adjusted CPC drops below the manager floor for its credit tier is escalated to Deal Desk." },
        { section: "pricing", name: "CPC below rep floor", subject: "credit", escalatesTo: "manager", trigger: "actual CPC < rep floor (per credit tier)", description: "When CPC sits between the rep and manager floors, the quote needs Manager approval." },
        { section: "pricing", name: "CPA below manager floor", subject: "action", escalatesTo: "dealDesk", trigger: "actual CPA < manager floor (per action tier)", description: "Any quote where the adjusted CPA drops below the manager floor for its action tier is escalated to Deal Desk." },
        { section: "pricing", name: "CPA below rep floor", subject: "action", escalatesTo: "manager", trigger: "actual CPA < rep floor (per action tier)", description: "When CPA sits between the rep and manager floors, the quote needs Manager approval." },
        { section: "pricing", name: "CPC list price set to $0.06", subject: "credit", escalatesTo: "manager", trigger: "$0.06", description: "Setting the CPC list price to $0.06 is allowed but not recommended; it requires Manager approval." },
        { section: "volume", name: "Per-year credits < 1,200,000", subject: "credit", escalatesTo: "manager", trigger: "1,200,000", description: "Any contract year below 1.2M credits picks up the XS tier, flagged as a legacy-to-enterprise transition." },
        { section: "volume", name: "XS action tier selected", subject: "action", escalatesTo: "manager", trigger: "tier is XS", description: "Selecting the XS action tier in any contract year always requires Manager approval." },
      ],
    },
  };

  // Loaded DB datasets, keyed by `key`. Starts empty; populated by load().
  let store = {};
  let loaded = false;
  let inflight = null;

  function get(key) {
    return (store && store[key]) || FALLBACK[key] || null;
  }

  /**
   * Fetches every active pricing row once and caches it. Safe to call
   * repeatedly — concurrent callers share the same in-flight promise, and a
   * resolved load is reused. Never throws; on failure the getters fall back to
   * the in-bundle constants.
   */
  async function load(force) {
    if (loaded && !force) return store;
    if (inflight && !force) return inflight;
    const supa = window.__cbSupabase;
    if (!supa) {
      loaded = true;
      return store;
    }
    inflight = (async () => {
      try {
        const rows = await supa.supabaseFetch("pricing", "GET", {
          query: { is_active: "eq.true", select: "key,value" },
        });
        const next = {};
        for (const r of rows || []) {
          if (r && r.key) next[r.key] = r.value;
        }
        store = next;
        loaded = true;
      } catch (err) {
        console.warn("[Clay Scoping] pricing load failed; using fallback:", err?.message || err);
        loaded = true;
      } finally {
        inflight = null;
      }
      return store;
    })();
    return inflight;
  }

  // --------------------------------------------------------------------------
  // Selection + derivation helpers
  // --------------------------------------------------------------------------

  /** Picks the band a volume falls into for a dataset, honoring its `selection`
   *  strategy: 'progressive' (highest band whose volume <= value, min band as
   *  floor) or 'closest' (smallest |value - band.volume|, ties round up). */
  function selectBand(dataset, volume) {
    const bands = dataset?.bands;
    if (!Array.isArray(bands) || bands.length === 0) return null;
    const v = Number(volume) || 0;
    if (dataset.selection === "closest") {
      let best = bands[0];
      let bestDiff = Math.abs(v - bands[0].volume);
      for (const b of bands) {
        const diff = Math.abs(v - b.volume);
        if (diff < bestDiff || diff === bestDiff) { bestDiff = diff; best = b; }
      }
      return best;
    }
    // progressive (default)
    for (let i = bands.length - 1; i >= 0; i--) {
      if (v >= bands[i].volume) return bands[i];
    }
    return bands[0];
  }

  /** Derives a floor for a contract length from its 1-year base, applying the
   *  2y/3y multipliers and an optional lower-bound clamp (rep >= manager >=
   *  dealDesk). Mirrors the calculator's deriveFloorForYears. */
  function deriveFloorForYears(base, contractYears, lowerBound) {
    const m = get("contract_year_multipliers") || FALLBACK.contract_year_multipliers;
    const round = Math.pow(10, m.roundDecimals ?? 4);
    let value = base;
    if (contractYears === 2) value = Math.round(base * m.twoYear * round) / round;
    else if (contractYears >= 3) value = Math.round(base * m.threeYear * round) / round;
    if (lowerBound !== undefined && lowerBound !== null) return Math.max(value, lowerBound);
    return value;
  }

  /** Returns {rep, manager, dealDesk} floors derived for the given contract
   *  length, clamped so rep >= manager >= dealDesk. */
  function resolveFloors(band, contractYears) {
    const f = band?.floors || {};
    const dealDesk = deriveFloorForYears(f.dealDesk, contractYears);
    const manager = deriveFloorForYears(f.manager, contractYears, dealDesk);
    const rep = deriveFloorForYears(f.rep, contractYears, manager);
    return { rep, manager, dealDesk };
  }

  // --------------------------------------------------------------------------
  // Approval evaluation (mirrors calculator calculateApprovalStatus)
  // --------------------------------------------------------------------------

  function pct(from, to) {
    if (!from) return "0.0";
    return (((from - to) / from) * 100).toFixed(1);
  }

  /**
   * Computes the approval status for a quote.
   *
   * @param {object} q
   * @param {number} q.creditsPerYear   avg annual credits (drives credit tier)
   * @param {number} q.actionsPerYear   avg annual actions (drives action tier)
   * @param {number} [q.contractYears=1]
   * @param {number} [q.creditPrice]    rep-adjusted CPC; falls back to list
   * @param {number} [q.actionPrice]    rep-adjusted CPA; falls back to list
   * @param {number} [q.creditListPrice] list CPC (for the $0.06 special-case)
   * @returns {{ status: 'pending_exception'|'pending_standard'|null, reasons: string[] }}
   */
  function approvalFor(q) {
    const reasons = [];
    const years = q.contractYears && q.contractYears >= 1 ? q.contractYears : 1;
    const credits = Number(q.creditsPerYear) || 0;
    const actions = Number(q.actionsPerYear) || 0;

    // ---- Credits / CPC ----
    const creditSet = get("enterprise_credit_floors");
    if (creditSet && credits > 0) {
      const tier = selectBand(creditSet, credits);
      const { rep, manager } = resolveFloors(tier, years);
      const actualCPC = q.creditPrice != null ? Number(q.creditPrice) : LIST_CPC;
      if (actualCPC < manager) {
        reasons.push(`CPC ${actualCPC.toFixed(4)} is below manager floor ${manager.toFixed(4)} (${pct(manager, actualCPC)}% below)`);
      } else if (actualCPC < rep) {
        reasons.push(`CPC ${actualCPC.toFixed(4)} is below rep floor ${rep.toFixed(4)} (${pct(rep, actualCPC)}% below)`);
      }
    }

    // Per-year credits below 1.2M (XS credit tier) — manager approval.
    if (credits > 0 && credits < 1200000) {
      reasons.push("XS credits tier selected (per-year credits < 1,200,000)");
    }
    // CPC list price of $0.06 — manager approval.
    if (q.creditListPrice === 0.06) {
      reasons.push("CPC list price set to $0.06 (not recommended)");
    }

    // ---- Actions / CPA ----
    const actionSet = get("enterprise_action_floors");
    if (actionSet && actions > 0) {
      const tier = selectBand(actionSet, actions);
      const { rep, manager } = resolveFloors(tier, years);
      const actualCPA = q.actionPrice != null ? Number(q.actionPrice) : LIST_CPA;
      if (actualCPA < manager) {
        reasons.push(`CPA ${actualCPA.toFixed(4)} is below manager floor ${manager.toFixed(4)} (${pct(manager, actualCPA)}% below)`);
      } else if (actualCPA < rep) {
        reasons.push(`CPA ${actualCPA.toFixed(4)} is below rep floor ${rep.toFixed(4)} (${pct(rep, actualCPA)}% below)`);
      }
      if (tier && String(tier.tier) === "XS") {
        reasons.push("XS action tier selected");
      }
    }

    if (reasons.length === 0) return { status: null, reasons: [] };
    const hasManagerFloorViolation = reasons.some((r) => r.includes("below manager floor"));
    return { status: hasManagerFloorViolation ? "pending_exception" : "pending_standard", reasons };
  }

  /**
   * Multi-year contract approval. Tier + floors are chosen from the AVERAGE
   * volume across the active years (matching the calculator), while the special
   * per-year rules (credits < 1.2M, XS action tier) are checked on each year.
   *
   * @param {object} q
   * @param {Array<{credits:number, actions:number}>} q.years per-year grand volumes
   * @param {number} q.contractYears 1..3
   * @param {number} q.cpc contract credit price
   * @param {number} q.cpa contract action price
   * @param {number} [q.creditListPrice] for the $0.06 rule
   * @returns {{ status, reasons, creditTier, actionTier, floors }}
   */
  function approvalForContract(q) {
    const reasons = [];
    const years = Array.isArray(q.years) ? q.years : [];
    const n = Math.min(3, Math.max(1, Number(q.contractYears) || years.length || 1));
    const active = years.slice(0, n);
    const avg = (arr) => (arr.length ? arr.reduce((s, x) => s + x, 0) / arr.length : 0);
    const avgCredits = avg(active.map((y) => Number(y.credits) || 0));
    const avgActions = avg(active.map((y) => Number(y.actions) || 0));

    const creditSet = get("enterprise_credit_floors");
    const actionSet = get("enterprise_action_floors");
    const creditTier = creditSet ? selectBand(creditSet, avgCredits) : null;
    const actionTier = actionSet ? selectBand(actionSet, avgActions) : null;
    const creditFloors = creditTier ? resolveFloors(creditTier, n) : null;
    const actionFloors = actionTier ? resolveFloors(actionTier, n) : null;

    const cpc = Number(q.cpc);
    const cpa = Number(q.cpa);

    if (creditFloors && Number.isFinite(cpc)) {
      if (cpc < creditFloors.manager) {
        reasons.push(`CPC ${cpc.toFixed(4)} is below manager floor ${creditFloors.manager.toFixed(4)} (${pct(creditFloors.manager, cpc)}% below)`);
      } else if (cpc < creditFloors.rep) {
        reasons.push(`CPC ${cpc.toFixed(4)} is below rep floor ${creditFloors.rep.toFixed(4)} (${pct(creditFloors.rep, cpc)}% below)`);
      }
    }
    if (actionFloors && Number.isFinite(cpa)) {
      if (cpa < actionFloors.manager) {
        reasons.push(`CPA ${cpa.toFixed(4)} is below manager floor ${actionFloors.manager.toFixed(4)} (${pct(actionFloors.manager, cpa)}% below)`);
      } else if (cpa < actionFloors.rep) {
        reasons.push(`CPA ${cpa.toFixed(4)} is below rep floor ${actionFloors.rep.toFixed(4)} (${pct(actionFloors.rep, cpa)}% below)`);
      }
    }

    // Per-year special-cases.
    active.forEach((y, i) => {
      const c = Number(y.credits) || 0;
      if (c > 0 && c < 1200000) reasons.push(`XS credits tier (Year ${i + 1} < 1,200,000)`);
      if (actionSet) {
        const a = Number(y.actions) || 0;
        if (a > 0 && String(selectBand(actionSet, a)?.tier) === "XS") {
          reasons.push(`XS action tier (Year ${i + 1})`);
        }
      }
    });
    if (q.creditListPrice === 0.06) reasons.push("CPC list price set to $0.06 (not recommended)");

    let status = null;
    if (reasons.length > 0) {
      status = reasons.some((r) => r.includes("below manager floor"))
        ? "pending_exception"
        : "pending_standard";
    }
    return {
      status,
      reasons,
      avgCredits,
      avgActions,
      creditTier,
      actionTier,
      creditFloors,
      actionFloors,
    };
  }

  __cb.pricing = {
    LIST_CPC,
    LIST_CPA,
    load,
    isLoaded: () => loaded,
    get,
    // dataset getters
    enterpriseCreditFloors: () => get("enterprise_credit_floors"),
    enterpriseActionFloors: () => get("enterprise_action_floors"),
    selfServeCreditBands: () => get("self_serve_credit_bands"),
    selfServeCreditBandsLegacy: () => get("self_serve_credit_bands_legacy"),
    selfServeActionBands: () => get("self_serve_action_bands"),
    contractYearMultipliers: () => get("contract_year_multipliers"),
    approvalRules: () => get("approval_rules"),
    // helpers
    selectBand,
    deriveFloorForYears,
    resolveFloors,
    approvalFor,
    approvalForContract,
  };

  // Warm the cache once the page is interactive. Fire-and-forget; getters work
  // off the fallback until it resolves.
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => load());
  } else {
    load();
  }
})();
