import { test } from 'node:test';
import assert from 'node:assert/strict';
import { daysBetween, computeAging, buildReport } from '../src/services/analytics.js';
import { computeItemFinancials } from '../src/services/profit.js';

test('daysBetween counts whole days', () => {
  assert.equal(daysBetween('2026-01-01', '2026-01-31'), 30);
  assert.equal(daysBetween('2026-01-01', '2026-01-01'), 0);
  assert.equal(daysBetween(null, '2026-01-01'), null);
});

test('computeAging flags unsold stock past the stale threshold', () => {
  const a = computeAging({ status: 'listed', acquired_date: '2026-01-01' }, '2026-04-01', 60);
  assert.ok(a.daysHeld > 60);
  assert.equal(a.stale, true);

  const b = computeAging({ status: 'in_stock', acquired_date: '2026-03-15' }, '2026-04-01', 60);
  assert.equal(b.stale, false);
});

test('sold items age from acquired to sold date, never stale', () => {
  const a = computeAging(
    { status: 'sold', acquired_date: '2026-01-01', sold_date: '2026-02-01' },
    '2026-12-01',
    60
  );
  assert.equal(a.daysHeld, 31);
  assert.equal(a.stale, false);
});

function row(item, costs = []) {
  return { item, fin: computeItemFinancials(item, costs) };
}

test('buildReport computes ROI, revenue, avg days to sell and sell-through', () => {
  const rows = [
    row({ id: 1, title: 'A', status: 'sold', acquisition_cost: 100, sold_price: 200, sold_date: '2026-02-10', acquired_date: '2026-01-01', fee_rate: 0, flat_fee: 0, shipping_cost: 0 }),
    row({ id: 2, title: 'B', status: 'sold', acquisition_cost: 100, sold_price: 150, sold_date: '2026-03-01', acquired_date: '2026-02-01', fee_rate: 0, flat_fee: 0, shipping_cost: 0 }),
    row({ id: 3, title: 'C', status: 'in_stock', acquisition_cost: 100, acquired_date: '2026-01-01', fee_rate: 0, flat_fee: 0, shipping_cost: 0 }),
  ];
  const r = buildReport(rows, { now: '2026-04-01', staleDays: 60 });

  assert.equal(r.counts.sold, 2);
  assert.equal(r.counts.unsold, 1);
  assert.equal(r.totalRevenue, 350);
  assert.equal(r.realizedProfit, 150); // (200-100)+(150-100)
  assert.equal(r.investedInSold, 200);
  assert.equal(r.roi, 0.75); // 150/200
  assert.equal(r.avgProfitPerSale, 75);
  // days to sell: A=40, B=28 -> avg 34
  assert.equal(r.avgDaysToSell, 34);
  // sell-through: 2 sold of 3 total (excl. scrapped)
  assert.ok(Math.abs(r.sellThroughRate - 0.67) < 0.01);
});

test('buildReport surfaces dead stock and tied-up capital', () => {
  const rows = [
    row({ id: 1, title: 'Old', status: 'listed', acquisition_cost: 300, acquired_date: '2026-01-01', fee_rate: 0, flat_fee: 0, shipping_cost: 0 }),
    row({ id: 2, title: 'Fresh', status: 'in_stock', acquisition_cost: 200, acquired_date: '2026-03-20', fee_rate: 0, flat_fee: 0, shipping_cost: 0 }),
  ];
  const r = buildReport(rows, { now: '2026-04-01', staleDays: 60 });
  assert.equal(r.staleCount, 1);
  assert.equal(r.staleCapital, 300);
  assert.equal(r.capitalTiedUp, 500);
  // aging list sorted oldest first
  assert.equal(r.aging[0].title, 'Old');
  assert.ok(r.aging[0].stale);
});

test('empty portfolio produces null rates without throwing', () => {
  const r = buildReport([], { now: '2026-04-01' });
  assert.equal(r.roi, null);
  assert.equal(r.sellThroughRate, null);
  assert.equal(r.staleCount, 0);
  assert.deepEqual(r.aging, []);
});
