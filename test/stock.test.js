import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as repo from '../src/repo.js';
import { createUser } from '../src/auth.js';

test('duplicateItem copies fields/costs/upgrades and clears unit data', () => {
  const src = repo.createItem({
    title: 'Dell 7490', category: 'laptop', status: 'listed', listing_price: 500,
    acquisition_cost: 200, serial_number: 'SN-123', specs: { cpu: 'i7' },
  });
  repo.addCost(src.id, { description: 'SSD', amount: 40, category: 'part' });
  repo.addUpgrade(src.id, { label: '32GB RAM', price_delta: 60 });
  repo.markSold(src.id, { sold_price: 480 });

  const copy = repo.duplicateItem(src.id);
  assert.equal(copy.title, 'Dell 7490 (copy)');
  assert.equal(copy.status, 'in_stock');       // reset for re-listing
  assert.equal(copy.serial_number, null);        // unit-specific cleared
  assert.equal(copy.sold_price, null);
  assert.equal(copy.listing_price, 500);         // pricing carried over
  assert.equal(copy.specs.cpu, 'i7');
  assert.equal(repo.listCosts(copy.id).length, 1);
  assert.equal(repo.listUpgrades(copy.id).length, 1);
  assert.notEqual(copy.id, src.id);
});

test('item quantity defaults to 1, is stored, and carries through duplicate + shop view', () => {
  const a = repo.createItem({ title: 'No qty', category: 'laptop', status: 'listed', listing_price: 100 });
  assert.equal(a.quantity, 1);
  const b = repo.createItem({ title: 'Three units', category: 'component', status: 'listed', listing_price: 50, quantity: 3 });
  assert.equal(b.quantity, 3);
  assert.equal(repo.shopItem(b.id).quantity, 3);
  const copy = repo.duplicateItem(b.id);
  assert.equal(copy.quantity, 3);
  // invalid quantity coerces to 1
  const c = repo.createItem({ title: 'Bad qty', category: 'other', quantity: 0 });
  assert.equal(c.quantity, 1);
});

test('subscriptions: subscribe/unsubscribe per-item and store-wide', () => {
  const u = createUser({ username: 'subby', password: 'password123', role: 'customer', email: 'subby@example.com' });
  const item = repo.createItem({ title: 'GPU', category: 'component', status: 'listed', listing_price: 300 });

  repo.subscribe(u.id, item.id);
  repo.subscribe(u.id, null); // store-wide
  repo.subscribe(u.id, item.id); // idempotent

  const subs = repo.listSubscriptions(u.id);
  assert.equal(subs.store, true);
  assert.deepEqual(subs.items, [item.id]);

  // item subscribers include store-wide subscribers, deduped, with email
  const recips = repo.subscribersForItem(item.id);
  assert.equal(recips.length, 1);
  assert.equal(recips[0].email, 'subby@example.com');

  repo.unsubscribe(u.id, item.id);
  assert.deepEqual(repo.listSubscriptions(u.id).items, []);
  assert.equal(repo.listSubscriptions(u.id).store, true);
});

test('listAllSubscriptions reports who subscribed to what (item + store-wide)', () => {
  const u = createUser({ username: 'watcher', password: 'password123', role: 'customer', email: 'w@example.com' });
  const item = repo.createItem({ title: 'Monitor', category: 'device', status: 'listed', listing_price: 120 });
  repo.subscribe(u.id, item.id);
  repo.subscribe(u.id, null);
  const all = repo.listAllSubscriptions();
  const mine = all.filter((r) => r.username === 'watcher');
  assert.equal(mine.length, 2);
  assert.ok(mine.some((r) => r.item_id === item.id && r.item_title === 'Monitor'));
  assert.ok(mine.some((r) => r.item_id == null)); // store-wide row
});

test('logVisit records which item a customer looked at', () => {
  const item = repo.createItem({ title: 'Watched GPU', category: 'component', status: 'listed', listing_price: 200 });
  repo.logVisit({ kind: 'item', path: '/shop', itemId: item.id, itemTitle: item.title, user: { username: 'guest' } });
  const v = repo.listVisits(10).find((x) => x.kind === 'item');
  assert.ok(v, 'an item view should be logged');
  assert.equal(v.item_id, item.id);
  assert.equal(v.item_title, 'Watched GPU');
});

test('subscribersForItem excludes users with neither an email nor a phone', () => {
  const u = createUser({ username: 'noemail', password: 'password123', role: 'customer' });
  const item = repo.createItem({ title: 'RAM', category: 'component', status: 'listed', listing_price: 50 });
  repo.subscribe(u.id, item.id);
  assert.equal(repo.subscribersForItem(item.id).some((r) => r.id === u.id), false);
});

test('subscribersForItem includes phone-only users (for WhatsApp alerts) with their phone', () => {
  const u = createUser({ username: 'phoneonly', password: 'password123', role: 'customer', phone: '+15551230000' });
  const item = repo.createItem({ title: 'Phone GPU', category: 'component', status: 'listed', listing_price: 150 });
  repo.subscribe(u.id, item.id);
  const mine = repo.subscribersForItem(item.id).find((r) => r.id === u.id);
  assert.ok(mine, 'phone-only subscriber should be reachable');
  assert.equal(mine.phone, '+15551230000');
  assert.equal(mine.email, null);
});

test('publicShareItem exposes only minimal teaser fields and hides price/specs', () => {
  const it = repo.createItem({
    title: 'Public Laptop', category: 'laptop', status: 'listed',
    acquisition_cost: 100, listing_price: 400, brand: 'Dell', specs: { cpu: 'i7' },
  });
  const share = repo.publicShareItem(it.id);
  assert.ok(share);
  const allowed = new Set(['id', 'title', 'category', 'condition', 'brand', 'image']);
  for (const k of Object.keys(share)) assert.ok(allowed.has(k), `unexpected public field: ${k}`);
  // the reveal-worthy fields must NOT leak into a public teaser
  for (const bad of ['price', 'listing_price', 'specs', 'acquisition_cost']) {
    assert.equal(bad in share, false, `${bad} must not be exposed publicly`);
  }
});

test('publicShareItem returns null for items that are not for sale', () => {
  const draft = repo.createItem({ title: 'Draft', category: 'laptop', status: 'in_stock' }); // no price
  assert.equal(repo.publicShareItem(draft.id), null);
  const sold = repo.createItem({ title: 'Gone', category: 'laptop', status: 'sold', listing_price: 200, sold_price: 250 });
  assert.equal(repo.publicShareItem(sold.id), null);
  const hidden = repo.createItem({ title: 'Hidden', category: 'laptop', status: 'listed', listing_price: 200, hidden: 1 });
  assert.equal(repo.publicShareItem(hidden.id), null);
});
