// Pricing orchestrator. In this build there are no live marketplace providers —
// the eBay and Amazon clients are part of the paid upgrade — so every lookup is
// served by the demo provider, clearly labelled as simulated. The statistics
// layer (median active / median sold, and the provenance rules that keep demo
// numbers out of real pricing decisions) is core and stays here, ready for the
// day a live provider is plugged in.

// eBay's Browse API caps a page at 200; 50 is the practical sweet spot. Kept
// here rather than in the provider so this build still knows the shape of a
// request it cannot make.
export const MAX_LIMIT = 50;
export const DEFAULT_LIMIT = 50;
import { searchDemo } from './demo.js';
import { normalizeCondition, CONDITION_GROUPS } from './conditions.js';

function median(nums) {
  const xs = nums.filter((n) => typeof n === 'number' && !Number.isNaN(n)).sort((a, b) => a - b);
  if (!xs.length) return null;
  const mid = Math.floor(xs.length / 2);
  return xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
}
const round2 = (n) => (n == null ? null : Math.round((n + Number.EPSILON) * 100) / 100);

function stats(rows) {
  const prices = rows.map((r) => r.price).filter((p) => typeof p === 'number' && !Number.isNaN(p));
  if (!prices.length) return { count: 0, min: null, max: null, median: null, avg: null };
  return {
    count: prices.length,
    min: round2(Math.min(...prices)),
    max: round2(Math.max(...prices)),
    median: round2(median(prices)),
    avg: round2(prices.reduce((a, b) => a + b, 0) / prices.length),
  };
}

/**
 * Search marketplaces for comparables.
 * @param {string} query
 * @param {object} [opts]
 * @param {string[]} [opts.sources] subset of ['ebay','amazon'] (demo always used as fallback)
 * @param {number} [opts.limit]
 * @param {string} [opts.condition] one of CONDITION_KEYS — restricts comps to
 *        that listing condition so a refurb isn't priced against new retail.
 */
export async function searchComparables(query, opts = {}) {
  const sources = opts.sources || ['ebay', 'amazon'];
  const limit = Math.max(1, Math.min(Number(opts.limit) || DEFAULT_LIMIT, MAX_LIMIT));
  const offset = Math.max(0, Number(opts.offset) || 0);
  const condition = normalizeCondition(opts.condition);
  const notes = [];

  // No live provider exists in this build, so say so once per marketplace the
  // caller asked for rather than failing or pretending.
  for (const name of ['ebay', 'amazon']) {
    if (!sources.includes(name)) continue;
    notes.push(`${name}: live price lookups are part of the Tech Garage Pro upgrade — not included in this build.`);
  }

  const demo = await searchDemo(query, { limit, condition });

  return {
    query,
    condition,
    conditionLabel: CONDITION_GROUPS[condition].label,
    limit,
    offset,
    // Paging belongs to a live provider walking real result pages. There isn't
    // one, so there is never another page to fetch.
    paging: {},
    hasMore: false,
    ...resolveComps({ demo, notes, condition }),
  };
}

/**
 * Pure decision layer: given what the providers returned, decide what to show
 * and which number may drive profit projections.
 *
 * The invariant: simulated demo prices are NEVER mixed into live results and
 * never influence a real pricing decision. (They previously did — a demo sold
 * median silently became the market estimate whenever eBay's Marketplace
 * Insights was unapproved, which is the default for most API keys.)
 */
export function resolveComps({ liveActive = [], liveSold = [], anyLive = false, anySoldLive = false, demo = null, notes = [], condition = 'any' }) {
  const tag = (rows, isDemo) => (rows || []).map((r) => ({ ...r, demo: isDemo }));
  const usingDemo = !anyLive;
  const cond = normalizeCondition(condition);

  if (usingDemo) {
    notes = ['DEMO DATA — no live marketplace provider is configured, so these comparables are simulated, not real sales.', ...notes];
  } else if (!anySoldLive) {
    notes = [...notes, 'Sold comparables are omitted rather than simulated; the market estimate falls back to live active listings.'];
  }

  const active = usingDemo ? tag(demo?.active, true) : tag(liveActive, false);
  const sold = usingDemo ? tag(demo?.sold, true) : tag(liveSold, false);

  const activeStats = stats(active);
  const soldStats = stats(sold);

  // Prefer real data, and always report where the number came from.
  let marketEstimate = null;
  let marketEstimateBasis = null;
  const prefix = usingDemo ? 'demo' : 'live';
  if (soldStats.median != null) { marketEstimate = soldStats.median; marketEstimateBasis = `${prefix}_sold`; }
  else if (activeStats.median != null) { marketEstimate = activeStats.median; marketEstimateBasis = `${prefix}_active`; }

  return {
    active,
    sold,
    stats: { active: activeStats, sold: soldStats },
    marketEstimate,
    marketEstimateBasis,
    // True only when the estimate came from real marketplace data.
    marketEstimateIsLive: Boolean(marketEstimate != null && !usingDemo),
    // Explicit provenance so the UI never has to guess.
    isDemo: usingDemo,
    soldDataAvailable: anySoldLive,
    condition: cond,
    conditionLabel: CONDITION_GROUPS[cond].label,
    notes,
  };
}

export { stats, median };
