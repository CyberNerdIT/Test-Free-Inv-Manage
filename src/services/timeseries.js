// Bucketed profit-over-time.
//
// The dashboard chart used to plot one point per sale and then a dashed line
// to a projected total. With a handful of sales that reads as "a projection",
// not as a history: there is no time axis to speak of, gaps between sales are
// invisible, and there is no way to see what a given month actually earned.
//
// This builds a real series instead: fixed-width buckets across a chosen
// window, each carrying the revenue, cost, units and profit *realized in that
// period*, plus a running cumulative total. Pure functions over plain rows, so
// the maths is testable without a database or a clock.

const DAY = 86400000;

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
const parseDay = (d) => {
  if (!d) return null;
  const t = Date.parse(String(d).slice(0, 10) + 'T00:00:00Z');
  return Number.isNaN(t) ? null : t;
};

export const BUCKETS = ['day', 'week', 'month'];

/** Ranges offered in the UI. `days: null` means "everything". */
export const RANGES = [
  { key: '30d', label: 'Last 30 days', days: 30 },
  { key: '90d', label: 'Last 90 days', days: 90 },
  { key: '6m', label: 'Last 6 months', days: 182 },
  { key: '1y', label: 'Last 12 months', days: 365 },
  { key: 'ytd', label: 'Year to date', days: null, ytd: true },
  { key: 'all', label: 'All time', days: null },
];

export function rangeList() {
  return RANGES.map(({ key, label }) => ({ key, label }));
}

/**
 * Turn a range key (plus optional explicit dates) into a concrete window.
 * `earliest` is the first date there is any data for, so "all time" doesn't
 * render a decade of empty buckets.
 */
export function resolveRange({ range = '90d', from, to, now, earliest } = {}) {
  const today = parseDay(now) ?? parseDay(new Date().toISOString());
  const end = parseDay(to) ?? today;

  if (from) return { from: iso(parseDay(from)), to: iso(end), range: 'custom' };

  const spec = RANGES.find((r) => r.key === range) || RANGES.find((r) => r.key === '90d');
  if (spec.ytd) {
    const jan1 = Date.UTC(new Date(end).getUTCFullYear(), 0, 1);
    return { from: iso(jan1), to: iso(end), range: spec.key };
  }
  if (spec.days) return { from: iso(end - (spec.days - 1) * DAY), to: iso(end), range: spec.key };

  // All time: start at the earliest data point, or today if there is none.
  const start = parseDay(earliest) ?? end;
  return { from: iso(Math.min(start, end)), to: iso(end), range: spec.key };
}

/** Pick a granularity that yields a readable number of bars. */
export function autoBucket(fromISO, toISO) {
  const days = Math.max(1, Math.round((parseDay(toISO) - parseDay(fromISO)) / DAY) + 1);
  if (days <= 62) return 'day';
  if (days <= 400) return 'week';
  return 'month';
}

/** Start of the bucket a timestamp falls in. */
function bucketStart(ms, bucket) {
  const d = new Date(ms);
  if (bucket === 'month') return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  if (bucket === 'week') {
    // ISO weeks start Monday. getUTCDay() is 0=Sunday.
    const dow = (d.getUTCDay() + 6) % 7;
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - dow * DAY;
  }
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

function nextBucket(ms, bucket) {
  const d = new Date(ms);
  if (bucket === 'month') return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
  return ms + (bucket === 'week' ? 7 : 1) * DAY;
}

function bucketLabel(ms, bucket) {
  const d = new Date(ms);
  const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()];
  if (bucket === 'month') return `${mon} ${String(d.getUTCFullYear()).slice(2)}`;
  return `${d.getUTCDate()} ${mon}`;
}

/**
 * Build the series.
 *
 * @param {Array<{date:string, profit:number, revenue:number, cost:number, units:number, title:string}>} sales
 *        Every completed sale, at any date — including ones before the window.
 * @param {object} opts
 * @param {string} opts.from  inclusive YYYY-MM-DD
 * @param {string} opts.to    inclusive YYYY-MM-DD
 * @param {string} [opts.bucket] day|week|month (auto if omitted)
 */
export function buildProfitSeries(sales, { from, to, bucket } = {}) {
  const gran = BUCKETS.includes(bucket) ? bucket : autoBucket(from, to);
  const fromMs = parseDay(from);
  const toMs = parseDay(to);

  // Empty buckets across the whole window, so a month with no sales shows as a
  // gap in the history rather than vanishing from the axis.
  const buckets = [];
  const index = new Map();
  for (let s = bucketStart(fromMs, gran); s <= toMs; s = nextBucket(s, gran)) {
    const b = {
      key: iso(s), start: iso(s), end: iso(Math.min(nextBucket(s, gran) - DAY, toMs)),
      label: bucketLabel(s, gran),
      revenue: 0, cost: 0, profit: 0, units: 0, sales: 0,
    };
    index.set(b.key, b);
    buckets.push(b);
  }

  // Profit banked BEFORE the window still counts toward the running total —
  // otherwise a 30-day view would suggest the business restarted at zero.
  let openingBalance = 0;
  let allTime = 0;

  for (const s of sales) {
    const ms = parseDay(s.date);
    if (ms == null) continue;
    const profit = Number(s.profit) || 0;
    allTime += profit;
    if (ms < fromMs) { openingBalance += profit; continue; }
    if (ms > toMs) continue;

    const b = index.get(iso(bucketStart(ms, gran)));
    if (!b) continue;
    b.profit += profit;
    b.revenue += Number(s.revenue) || 0;
    b.cost += Number(s.cost) || 0;
    b.units += Number(s.units) || 1;
    b.sales += 1;
  }

  let running = openingBalance;
  const cumulative = buckets.map((b) => {
    running += b.profit;
    b.revenue = round2(b.revenue);
    b.cost = round2(b.cost);
    b.profit = round2(b.profit);
    b.cumulative = round2(running);
    return { date: b.end, label: b.label, value: round2(running) };
  });

  const inWindow = buckets.reduce((a, b) => a + b.profit, 0);
  const active = buckets.filter((b) => b.sales > 0);

  return {
    from, to, bucket: gran,
    buckets,
    cumulative,
    openingBalance: round2(openingBalance),
    // Profit actually banked inside the window — the number the chart is about.
    windowProfit: round2(inWindow),
    windowRevenue: round2(buckets.reduce((a, b) => a + b.revenue, 0)),
    windowCost: round2(buckets.reduce((a, b) => a + b.cost, 0)),
    windowUnits: buckets.reduce((a, b) => a + b.units, 0),
    windowSales: buckets.reduce((a, b) => a + b.sales, 0),
    realizedTotal: round2(allTime),
    best: active.length ? active.reduce((m, b) => (b.profit > m.profit ? b : m)) : null,
    worst: active.length ? active.reduce((m, b) => (b.profit < m.profit ? b : m)) : null,
    // Mean over periods that actually had a sale; averaging in empty buckets
    // would understate a seasonal business.
    averagePerActivePeriod: active.length ? round2(inWindow / active.length) : null,
  };
}
