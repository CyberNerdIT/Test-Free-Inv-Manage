import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeItemFinancials, summarizePortfolio } from '../src/services/profit.js';

const approx = (a, b, eps = 0.01) => assert.ok(Math.abs(a - b) <= eps, `${a} ≈ ${b}`);

test('invested cost = acquisition + all refurbishment costs', () => {
  const item = { acquisition_cost: 100, fee_rate: 0, flat_fee: 0, shipping_cost: 0 };
  const costs = [{ amount: 30 }, { amount: 20 }];
  const f = computeItemFinancials(item, costs);
  assert.equal(f.investedCost, 150);
  assert.equal(f.acquisitionCost, 100);
  assert.equal(f.refurbCost, 50);
});

test('quantity scales invested cost, realized profit and revenue by the number of units', () => {
  // per unit: cost 50, sold 90, no fees/shipping -> per-unit profit 40
  const single = computeItemFinancials({ acquisition_cost: 50, fee_rate: 0, flat_fee: 0, shipping_cost: 0, status: 'sold', sold_price: 90 }, []);
  assert.equal(single.realizedProfit, 40);
  const four = computeItemFinancials({ acquisition_cost: 50, fee_rate: 0, flat_fee: 0, shipping_cost: 0, quantity: 4, status: 'sold', sold_price: 90 }, []);
  assert.equal(four.quantity, 4);
  assert.equal(four.investedCost, 200);      // 50 × 4
  assert.equal(four.realizedProfit, 160);     // 40 × 4
  assert.equal(four.realizedRevenue, 360);    // 90 × 4
  assert.equal(four.realizedMargin, 0.8);     // 160/200 == per-unit 40/50
  // break-even remains a per-unit price
  assert.equal(four.breakEvenPrice, 50);
  // projected profit also scales
  const listed = computeItemFinancials({ acquisition_cost: 50, fee_rate: 0, flat_fee: 0, shipping_cost: 0, quantity: 3, status: 'listed', listing_price: 90 }, []);
  assert.equal(listed.projectedProfit, 120);  // (90-50) × 3
});

test('break-even price accounts for fees, flat fee and shipping', () => {
  // invested 150, 10% fee, $0.30 flat, $10 shipping
  // break-even = (150 + 10 + 0.30) / (1 - 0.10) = 160.30 / 0.9 = 178.11
  const item = { acquisition_cost: 150, fee_rate: 0.1, flat_fee: 0.3, shipping_cost: 10 };
  const f = computeItemFinancials(item, []);
  approx(f.breakEvenPrice, 178.11);
  // Selling exactly at break-even yields ~0 profit
  const item2 = { ...item, listing_price: f.breakEvenPrice };
  const f2 = computeItemFinancials(item2, []);
  approx(f2.profitAtListing, 0, 0.02);
});

test('suggested price yields the target margin profit', () => {
  const item = { acquisition_cost: 200, fee_rate: 0.13, flat_fee: 0, shipping_cost: 0, target_margin: 0.25 };
  const f = computeItemFinancials(item, []);
  // profit at suggested price should equal 25% of invested (50)
  approx(f.projectedProfitAtSuggested, 50, 0.05);
});

test('realized profit computed for sold items', () => {
  // invested 120, sold 315, 13.2% fee, $0.30 flat, $16 ship
  // net = 315*(1-0.132) - 0.30 - 16 = 273.42 - 16.30 = 257.12; profit = 137.12
  const item = {
    acquisition_cost: 120, status: 'sold', sold_price: 315,
    fee_rate: 0.132, flat_fee: 0.3, shipping_cost: 16,
  };
  const f = computeItemFinancials(item, []);
  approx(f.realizedProfit, 137.12, 0.05);
  assert.ok(f.projectedProfit === null, 'sold items have no projected profit');
});

test('projected profit uses listing price for unsold stock', () => {
  const item = {
    acquisition_cost: 100, status: 'listed', listing_price: 200,
    fee_rate: 0.1, flat_fee: 0, shipping_cost: 0,
  };
  const f = computeItemFinancials(item, []);
  // 200*0.9 - 100 = 80
  approx(f.projectedProfit, 80);
  assert.equal(f.projectionBasis, 'listing_price');
});

test('projected profit falls back to market estimate when no listing price', () => {
  const item = { acquisition_cost: 100, status: 'in_stock', fee_rate: 0.1, flat_fee: 0, shipping_cost: 0 };
  const f = computeItemFinancials(item, [], { marketEstimate: 200 });
  approx(f.projectedProfit, 80);
  assert.equal(f.projectionBasis, 'market_estimate');
});

test('amountToBreakEven signals how far from profit', () => {
  // invested 100, no fees; break-even = 100. Listed at 80 -> need +20.
  const item = { acquisition_cost: 100, status: 'listed', listing_price: 80, fee_rate: 0, flat_fee: 0, shipping_cost: 0 };
  const f = computeItemFinancials(item, []);
  approx(f.breakEvenPrice, 100);
  approx(f.amountToBreakEven, 20);
  assert.equal(f.profitableAtCurrentPlan, false);
});

test('profitable when listing above break-even', () => {
  const item = { acquisition_cost: 100, status: 'listed', listing_price: 150, fee_rate: 0, flat_fee: 0, shipping_cost: 0 };
  const f = computeItemFinancials(item, []);
  assert.equal(f.profitableAtCurrentPlan, true);
  approx(f.amountToBreakEven, -50); // 50 above break-even
});

test('portfolio summary aggregates realized and projected', () => {
  const build = (item, costs = []) => ({ item, fin: computeItemFinancials(item, costs) });
  const items = [
    build({ acquisition_cost: 100, status: 'sold', sold_price: 200, fee_rate: 0, flat_fee: 0, shipping_cost: 0 }),
    build({ acquisition_cost: 100, status: 'listed', listing_price: 180, fee_rate: 0, flat_fee: 0, shipping_cost: 0 }),
    build({ acquisition_cost: 50, status: 'in_stock', fee_rate: 0, flat_fee: 0, shipping_cost: 0 }),
  ];
  const s = summarizePortfolio(items);
  assert.equal(s.totalItems, 3);
  assert.equal(s.sold, 1);
  assert.equal(s.listed, 1);
  assert.equal(s.inStock, 1);
  approx(s.realizedProfit, 100); // 200 - 100
  approx(s.projectedProfit, 80); // 180 - 100 (in_stock item has no listing/market => 0)
  approx(s.totalInvested, 250);
});

test('local sale waives marketplace fees (fee rate + flat fee)', () => {
  // invested 100, sold 200, normally 13.2% fee + $0.30; local sale => no fees.
  const base = { acquisition_cost: 100, status: 'sold', sold_price: 200, fee_rate: 0.132, flat_fee: 0.3, shipping_cost: 0 };
  const normal = computeItemFinancials(base, []);
  const local = computeItemFinancials({ ...base, local_sale: 1 }, []);
  assert.equal(local.feeRate, 0);
  assert.equal(local.flatFee, 0);
  assert.equal(local.localSale, true);
  // local realized profit is exactly sold - invested = 100
  approx(local.realizedProfit, 100);
  // and it's higher than the fee-charged version
  assert.ok(local.realizedProfit > normal.realizedProfit);
});

test('zero fee edge case does not divide by zero incorrectly', () => {
  const item = { acquisition_cost: 0, fee_rate: 0, flat_fee: 0, shipping_cost: 0 };
  const f = computeItemFinancials(item, []);
  assert.equal(f.breakEvenPrice, 0);
  assert.equal(f.investedCost, 0);
});
