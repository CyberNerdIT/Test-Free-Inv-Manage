import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildProfitSeries, resolveRange, autoBucket, rangeList, RANGES,
} from '../src/services/timeseries.js';

// The dashboard used to plot one point per sale plus a dashed projection line.
// With sparse sales that reads as a forecast, not a history — there was no way
// to answer "what did March actually earn". These tests pin the real series.

const sales = [
  { date: '2025-12-20', profit: 100, revenue: 300, cost: 200, units: 1, title: 'Old sale' },
  { date: '2026-01-05', profit: 50, revenue: 150, cost: 100, units: 1, title: 'A' },
  { date: '2026-01-25', profit: 30, revenue: 90, cost: 60, units: 2, title: 'B' },
  { date: '2026-02-14', profit: -20, revenue: 40, cost: 60, units: 1, title: 'Loss' },
  { date: '2026-03-30', profit: 200, revenue: 500, cost: 300, units: 3, title: 'C' },
];

const q1 = { from: '2026-01-01', to: '2026-03-31', bucket: 'month' };

test('buckets carry what each period actually earned', () => {
  const s = buildProfitSeries(sales, q1);
  assert.equal(s.buckets.length, 3);
  assert.deepEqual(s.buckets.map((b) => b.profit), [80, -20, 200]);
  assert.deepEqual(s.buckets.map((b) => b.revenue), [240, 40, 500]);
  assert.deepEqual(s.buckets.map((b) => b.units), [3, 1, 3]);
  assert.deepEqual(s.buckets.map((b) => b.sales), [2, 1, 1]);
});

test('a losing period shows as negative rather than flattening the line', () => {
  // The old cumulative-only chart could only ever go flat; a bad month was
  // invisible. February must be visibly -20.
  const s = buildProfitSeries(sales, q1);
  assert.equal(s.buckets[1].profit, -20);
  assert.equal(s.worst.profit, -20);
  assert.equal(s.best.profit, 200);
});

test('profit banked before the window carries into the running total', () => {
  // Otherwise a 90-day view would imply the business started from zero.
  const s = buildProfitSeries(sales, q1);
  assert.equal(s.openingBalance, 100, 'the December sale is before the window');
  assert.deepEqual(s.cumulative.map((c) => c.value), [180, 160, 360]);
  assert.equal(s.windowProfit, 260, 'window profit excludes the opening balance');
  assert.equal(s.realizedTotal, 360, 'all-time includes it');
});

test('periods with no sales are kept as gaps, not dropped from the axis', () => {
  const s = buildProfitSeries(sales, { from: '2026-01-01', to: '2026-06-30', bucket: 'month' });
  assert.equal(s.buckets.length, 6);
  assert.deepEqual(s.buckets.slice(3).map((b) => b.profit), [0, 0, 0]);
  // The running total holds flat across the quiet months rather than resetting.
  assert.deepEqual(s.cumulative.slice(3).map((c) => c.value), [360, 360, 360]);
});

test('sales outside the window never leak into it', () => {
  const s = buildProfitSeries(sales, { from: '2026-02-01', to: '2026-02-28', bucket: 'month' });
  assert.equal(s.buckets.length, 1);
  assert.equal(s.windowProfit, -20);
  assert.equal(s.windowSales, 1);
  assert.equal(s.openingBalance, 180, 'December + January');
});

test('weekly buckets start on Monday', () => {
  // 2026-03-30 is a Monday; 2026-04-05 is the Sunday that closes that week.
  const s = buildProfitSeries(sales, { from: '2026-03-28', to: '2026-04-10', bucket: 'week' });
  const hit = s.buckets.find((b) => b.profit !== 0);
  assert.equal(hit.start, '2026-03-30');
});

test('the average ignores empty periods', () => {
  // Averaging in quiet months would understate a seasonal business.
  const s = buildProfitSeries(sales, { from: '2026-01-01', to: '2026-06-30', bucket: 'month' });
  assert.equal(s.averagePerActivePeriod, Math.round((260 / 3) * 100) / 100);
});

test('no sales at all produces an empty-but-valid series', () => {
  const s = buildProfitSeries([], q1);
  assert.equal(s.buckets.length, 3);
  assert.equal(s.windowProfit, 0);
  assert.equal(s.realizedTotal, 0);
  assert.equal(s.best, null);
  assert.equal(s.averagePerActivePeriod, null);
});

test('undated or malformed sales are skipped, not counted as today', () => {
  const s = buildProfitSeries([...sales, { date: null, profit: 9999 }, { date: 'nonsense', profit: 5555 }], q1);
  assert.equal(s.realizedTotal, 360);
});

test('ranges resolve to concrete windows', () => {
  const now = '2026-08-04';
  assert.deepEqual(resolveRange({ range: '30d', now }), { from: '2026-07-06', to: '2026-08-04', range: '30d' });
  assert.deepEqual(resolveRange({ range: 'ytd', now }), { from: '2026-01-01', to: '2026-08-04', range: 'ytd' });

  // "All time" starts at the first sale, not an arbitrary epoch — otherwise a
  // new install renders years of empty buckets.
  assert.deepEqual(resolveRange({ range: 'all', now, earliest: '2026-03-01' }),
    { from: '2026-03-01', to: '2026-08-04', range: 'all' });
  // With no data at all it collapses to today rather than exploding.
  assert.equal(resolveRange({ range: 'all', now }).from, now);

  // An unknown range falls back rather than throwing.
  assert.equal(resolveRange({ range: 'wat', now }).range, '90d');
  // Explicit dates win.
  assert.deepEqual(resolveRange({ from: '2026-01-01', to: '2026-02-01', now }),
    { from: '2026-01-01', to: '2026-02-01', range: 'custom' });
});

test('granularity is chosen to keep the bar count readable', () => {
  assert.equal(autoBucket('2026-01-01', '2026-01-31'), 'day');
  assert.equal(autoBucket('2026-01-01', '2026-04-01'), 'week');
  assert.equal(autoBucket('2024-01-01', '2026-01-01'), 'month');
  // An explicit bucket overrides the guess.
  assert.equal(buildProfitSeries(sales, { from: '2026-01-01', to: '2026-01-31', bucket: 'month' }).bucket, 'month');
});

test('rangeList is safe to send to the browser', () => {
  const list = rangeList();
  assert.equal(list.length, RANGES.length);
  for (const r of list) assert.deepEqual(Object.keys(r).sort(), ['key', 'label']);
});
