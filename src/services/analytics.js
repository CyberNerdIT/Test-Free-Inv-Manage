// Inventory aging + performance reporting. Pure functions so they can be unit
// tested with a fixed "now" reference (no hidden Date.now dependency in logic).

const DAY = 86400000;

function parseDate(d) {
  if (!d) return null;
  // Accept 'YYYY-MM-DD' or full ISO; treat as UTC midnight for stability.
  const s = String(d).slice(0, 10);
  const t = Date.parse(s + 'T00:00:00Z');
  return Number.isNaN(t) ? null : t;
}

export function daysBetween(startISO, endISO) {
  const a = parseDate(startISO);
  const b = parseDate(endISO);
  if (a == null || b == null) return null;
  return Math.max(0, Math.round((b - a) / DAY));
}

/**
 * Age of an item.
 * @param {object} item
 * @param {string} nowISO reference date (YYYY-MM-DD)
 * @param {number} staleDays threshold for dead-stock warning
 */
export function computeAging(item, nowISO, staleDays = 60) {
  const start = item.acquired_date || (item.created_at ? String(item.created_at).slice(0, 10) : null);
  const unsold = item.status !== 'sold' && item.status !== 'scrapped';
  const end = item.status === 'sold' ? item.sold_date || nowISO : nowISO;
  const daysHeld = start ? daysBetween(start, end) : null;
  return {
    daysHeld,
    stale: Boolean(unsold && daysHeld != null && daysHeld > staleDays),
  };
}

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

/**
 * Build a performance + aging report.
 * @param {Array<{item:object, fin:object}>} rows items with computed financials
 * @param {object} [opts]
 * @param {string} [opts.now] reference date (defaults to today)
 * @param {number} [opts.staleDays]
 */
export function buildReport(rows, opts = {}) {
  const now = opts.now || new Date().toISOString().slice(0, 10);
  const staleDays = opts.staleDays ?? 60;

  const sold = rows.filter(({ item }) => item.status === 'sold');
  const unsold = rows.filter(({ item }) => item.status !== 'sold' && item.status !== 'scrapped');

  const realizedProfit = sold.reduce((s, { fin }) => s + (fin.realizedProfit || 0), 0);
  const investedInSold = sold.reduce((s, { fin }) => s + (fin.investedCost || 0), 0);
  const totalRevenue = sold.reduce((s, { item }) => s + (Number(item.sold_price) || 0), 0);

  const daysToSell = sold
    .map(({ item }) => daysBetween(item.acquired_date, item.sold_date))
    .filter((d) => d != null);

  const aging = unsold
    .map(({ item, fin }) => {
      const a = computeAging(item, now, staleDays);
      return {
        id: item.id,
        title: item.title,
        status: item.status,
        daysHeld: a.daysHeld,
        stale: a.stale,
        investedCost: fin.investedCost,
        listingPrice: fin.listingPrice,
      };
    })
    .sort((x, y) => (y.daysHeld ?? -1) - (x.daysHeld ?? -1));

  const staleItems = aging.filter((a) => a.stale);
  const denom = sold.length + unsold.length;

  return {
    now,
    staleDays,
    counts: { sold: sold.length, unsold: unsold.length },
    realizedProfit: round2(realizedProfit),
    totalRevenue: round2(totalRevenue),
    investedInSold: round2(investedInSold),
    roi: investedInSold ? round2(realizedProfit / investedInSold) : null,
    avgProfitPerSale: sold.length ? round2(realizedProfit / sold.length) : null,
    avgDaysToSell: daysToSell.length ? Math.round(mean(daysToSell)) : null,
    sellThroughRate: denom ? round2(sold.length / denom) : null,
    capitalTiedUp: round2(unsold.reduce((s, { fin }) => s + (fin.investedCost || 0), 0)),
    staleCount: staleItems.length,
    staleCapital: round2(staleItems.reduce((s, a) => s + (a.investedCost || 0), 0)),
    aging,
  };
}

export { round2 as _round2 };
