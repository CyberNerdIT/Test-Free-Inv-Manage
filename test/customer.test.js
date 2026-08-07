import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMessage } from '../src/services/notify.js';
import * as repo from '../src/repo.js';
import { createItem } from '../src/repo.js';

test('buildMessage includes item, upgrades, total and customer details', () => {
  const msg = buildMessage({
    item_title: 'Custom Ryzen 5 desktop',
    total_price: 760,
    upgrades: [{ label: 'Upgrade to 32GB RAM', price_delta: 40 }],
    customer_name: 'Jane Buyer',
    customer_username: 'jane',
    customer_email: 'jane@example.com',
    customer_phone: '+15551234567',
    message: 'Ship to NYC?',
  });
  assert.match(msg, /New purchase request/);
  assert.match(msg, /Custom Ryzen 5 desktop/);
  assert.match(msg, /Upgrade to 32GB RAM/);
  assert.match(msg, /\$760\.00/);
  assert.match(msg, /Jane Buyer/);
  assert.match(msg, /jane@example\.com/);
  assert.match(msg, /\+15551234567/);
  assert.match(msg, /Ship to NYC\?/);
});

test('shopItems exposes only safe fields (no cost/profit leak)', () => {
  createItem({
    title: 'Leaky Laptop', category: 'laptop', status: 'listed',
    acquisition_cost: 100, listing_price: 300, fee_rate: 0.1,
    specs: { cpu: 'i5', ram: '8GB' },
  });
  const items = repo.shopItems();
  assert.ok(items.length >= 1);
  const it = items.find((x) => x.title === 'Leaky Laptop');
  assert.ok(it, 'listed item should appear in shop');
  // A strict whitelist: any new field on a shop item has to be added here on
  // purpose, which is what stops a cost or margin leaking in by accident.
  const allowed = new Set([
    'id', 'title', 'category', 'condition', 'brand', 'model', 'specs', 'description',
    'price', 'quantity', 'upgrades', 'images',
    'soldOut',   // shown greyed out rather than silently vanishing
    'savings',   // derived from compare_at_price — a "was" price, never a cost
    'market',    // cached eBay comps; median/low/high of OTHER sellers' prices
  ]);
  for (const k of Object.keys(it)) assert.ok(allowed.has(k), `unexpected field exposed to customer: ${k}`);
  // explicitly ensure the dangerous fields are gone
  for (const bad of ['acquisition_cost', 'fee_rate', 'invested_cost', 'break_even', 'profit', 'sold_price', 'compare_at_price']) {
    assert.equal(bad in it, false, `${bad} must not be exposed`);
  }
});

test('the savings badge is derived, and never exposes what the item cost', () => {
  const item = createItem({
    title: 'Was Cheaper', category: 'laptop', status: 'listed',
    acquisition_cost: 100, listing_price: 300, compare_at_price: 500,
  });
  const it = repo.shopItems().find((x) => x.id === item.id);
  assert.deepEqual(it.savings, { was: 500, save: 200, percent: 40 });
  assert.equal(it.price, 300);
  // The acquisition cost is 100 — it must appear nowhere in the payload.
  assert.ok(!JSON.stringify(it).includes('100'), 'the cost must not leak, even inside a derived number');
});

test('a compare-at price below the asking price shows no badge', () => {
  // A "saving" that is not a saving is worse than no badge at all.
  const item = createItem({
    title: 'Bad Compare', category: 'laptop', status: 'listed',
    listing_price: 300, compare_at_price: 250,
  });
  assert.equal(repo.shopItems().find((x) => x.id === item.id).savings, null);
});

test('in_stock/listed items with a price are for sale; drafts without price are hidden', () => {
  createItem({ title: 'NoPrice', category: 'laptop', status: 'in_stock', acquisition_cost: 50 }); // no listing_price
  createItem({ title: 'Sold Unit', category: 'laptop', status: 'sold', listing_price: 200, sold_price: 250 });
  const items = repo.shopItems();
  const titles = items.map((i) => i.title);
  assert.ok(!titles.includes('NoPrice'), 'items without a listing price are not shown');

  // Sold items now appear, but flagged and unbuyable — a shop that deletes
  // what it sold looks emptier than it is, and "tell me if another arrives"
  // is what feeds the stock alerts.
  const sold = items.find((i) => i.title === 'Sold Unit');
  assert.ok(sold, 'recently sold items stay visible');
  assert.equal(sold.soldOut, true);
  assert.deepEqual(sold.upgrades, [], 'a sold item offers nothing to add');

  // …and they can be excluded entirely.
  assert.ok(!repo.shopItems({ includeSoldOut: false }).some((i) => i.title === 'Sold Unit'));
});

test('createPurchaseRequest computes total from base + selected upgrades', () => {
  const item = createItem({ title: 'Deck', category: 'desktop', status: 'listed', listing_price: 500 });
  const u1 = repo.addUpgrade(item.id, { label: '+RAM', price_delta: 40 });
  const u2 = repo.addUpgrade(item.id, { label: '+SSD', price_delta: 60 });
  const req = repo.createPurchaseRequest({
    itemId: item.id,
    // no id -> customer_id stored as null (avoids needing a real user row in the test)
    customer: { username: 'bob', name: 'Bob', email: 'b@x.com', phone: null },
    upgradeIds: [u1.id, u2.id],
    message: 'hi',
  });
  assert.equal(req.base_price, 500);
  assert.equal(req.total_price, 600);
  assert.equal(req.customer_username, 'bob');
  assert.equal(req.upgrades.length, 2);
});

test('createPurchaseRequest rejects an item that is not for sale', () => {
  const item = createItem({ title: 'Scrap', category: 'laptop', status: 'scrapped', listing_price: 10 });
  assert.throws(() => repo.createPurchaseRequest({ itemId: item.id, customer: { id: 1 } }), /not available/);
});

test('createPurchaseRequest multiplies the line by quantity and caps at available units', () => {
  const item = createItem({ title: 'Bulk RAM', category: 'component', status: 'listed', listing_price: 50, quantity: 3 });
  const u = repo.addUpgrade(item.id, { label: '+heatsink', price_delta: 10 });
  const req = repo.createPurchaseRequest({
    customer: { username: 'bulk' },
    items: [{ itemId: item.id, upgradeIds: [u.id], qty: 2 }],
  });
  const line = req.items[0];
  assert.equal(line.qty, 2);
  assert.equal(line.unit_price, 60);       // 50 base + 10 upgrade
  assert.equal(line.subtotal, 120);        // 60 × 2
  assert.equal(req.total_price, 120);
  // asking for more than are available is capped to the quantity in stock
  const capped = repo.createPurchaseRequest({ customer: { username: 'greedy' }, items: [{ itemId: item.id, qty: 99 }] });
  assert.equal(capped.items[0].qty, 3);
  assert.equal(capped.items[0].subtotal, 150); // 50 × 3
});

test('createPurchaseRequest defaults quantity to 1 when omitted', () => {
  const item = createItem({ title: 'Single', category: 'laptop', status: 'listed', listing_price: 200, quantity: 5 });
  const req = repo.createPurchaseRequest({ customer: { username: 'x' }, itemId: item.id });
  assert.equal(req.items[0].qty, 1);
  assert.equal(req.total_price, 200);
});

test('description is a customer-safe field exposed in the shop view', () => {
  const item = createItem({
    title: 'Described Laptop', category: 'laptop', status: 'listed', listing_price: 300,
    description: 'Clean unit, new battery, tiny scuff on lid.', notes: 'PRIVATE cost note',
  });
  const shop = repo.shopItem(item.id);
  assert.equal(shop.description, 'Clean unit, new battery, tiny scuff on lid.');
  assert.equal('notes' in shop, false); // internal notes never leak
});
