import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as repo from '../src/repo.js';
import {
  canTransition, nextOptions, shopperView, offerView, STATUS_KEYS, OPEN_STATUSES,
} from '../src/services/orders.js';
import { createUser } from '../src/auth.js';

// purchase_requests.customer_id has a real foreign key, so the tests use real
// customer rows rather than invented ids.
const ANN = createUser({ username: 'ann-shopper', password: 'pw12345678', role: 'customer', name: 'Ann', email: 'ann@example.com' });
const BOB = createUser({ username: 'bob-shopper', password: 'pw12345678', role: 'customer', name: 'Bob', email: 'bob@example.com' });

const mk = (over = {}) => repo.createItem({
  title: 'Item', category: 'laptop', status: 'listed', listing_price: 300, acquisition_cost: 100, ...over,
});

// ---------------------------------------------------------------------------
// Order lifecycle
// ---------------------------------------------------------------------------

test('the lifecycle only moves forward through sensible steps', () => {
  assert.equal(canTransition('new', 'reserved').ok, true);
  assert.equal(canTransition('reserved', 'paid').ok, true);
  assert.equal(canTransition('paid', 'shipped').ok, true);
  assert.equal(canTransition('shipped', 'completed').ok, true);

  // Going backwards would make the shopper's own history untrustworthy.
  assert.equal(canTransition('shipped', 'new').ok, false);
  assert.equal(canTransition('paid', 'reserved').ok, false);
  // Terminal states are final.
  assert.equal(canTransition('completed', 'shipped').ok, false);
  assert.equal(canTransition('declined', 'reserved').ok, false);
  // And nonsense is rejected with a reason, not silently accepted.
  const bad = canTransition('new', 'banana');
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /not a known status/);
});

test('legacy "handled" rows are not stranded', () => {
  // Requests created before the lifecycle existed must still be movable.
  assert.equal(canTransition('handled', 'reserved').ok, true);
  assert.equal(canTransition('handled', 'completed').ok, true);
  assert.ok(nextOptions('handled').length > 0);
});

test('every status has shopper-facing wording', () => {
  for (const k of STATUS_KEYS) {
    const v = shopperView(k);
    assert.ok(v.label && v.message, `${k} needs wording a buyer can read`);
    assert.equal(v.open, OPEN_STATUSES.includes(k));
  }
  // An unknown status degrades to 'new' rather than rendering blank.
  assert.equal(shopperView('nonsense').status, 'new');
});

test('an unanswered offer is an explicit state, not silence', () => {
  assert.equal(offerView({ offer_price: null }), null, 'no offer, nothing to show');
  const pending = offerView({ offer_price: 250 });
  assert.equal(pending.status, 'pending');
  assert.match(pending.label, /under review/i);

  const accepted = offerView({ offer_price: 250, offer_status: 'accepted', offer_note: 'Deal.' });
  assert.equal(accepted.tone, 'good');
  assert.equal(accepted.note, 'Deal.');
  assert.equal(offerView({ offer_price: 250, offer_status: 'declined' }).tone, 'bad');
});

test('status changes are recorded and rejected transitions change nothing', () => {
  const item = mk({ title: 'Lifecycle unit' });
  const req = repo.createPurchaseRequest({
    customer: ANN,
    items: [{ itemId: item.id }],
  });

  assert.equal(repo.setRequestStatus(req.id, 'reserved', { note: 'set aside' }).ok, true);
  assert.equal(repo.setRequestStatus(req.id, 'paid').ok, true);

  const bad = repo.setRequestStatus(req.id, 'new');
  assert.equal(bad.ok, false);
  assert.equal(repo.getPurchaseRequest(req.id).status, 'paid', 'a rejected move must not alter the row');

  const events = repo.requestEvents(req.id);
  assert.deepEqual(events.map((e) => e.status), ['reserved', 'paid']);
  assert.equal(events[0].note, 'set aside');
});

test('tracking is stored and surfaces on the request', () => {
  const item = mk();
  const req = repo.createPurchaseRequest({
    customer: ANN, items: [{ itemId: item.id }],
  });
  repo.setRequestStatus(req.id, 'reserved');
  repo.setRequestStatus(req.id, 'paid');
  repo.setRequestStatus(req.id, 'shipped', { tracking: 'ABC123' });
  assert.equal(repo.getPurchaseRequest(req.id).tracking, 'ABC123');
});

test('a shopper only ever sees their own requests', () => {
  const item = mk();
  repo.createPurchaseRequest({ customer: ANN, items: [{ itemId: item.id }] });
  repo.createPurchaseRequest({ customer: BOB, items: [{ itemId: item.id }] });

  const ann = repo.requestsForCustomer(ANN.id);
  assert.ok(ann.length >= 1);
  assert.ok(ann.every((r) => r.customer_id === ANN.id), 'another customer\'s order must never appear');
  assert.equal(repo.requestsForCustomer(999).length, 0);
});

test('an offer decision is recorded, and only on requests that have one', () => {
  const item = mk({ listing_price: 400 });
  const withOffer = repo.createPurchaseRequest({
    customer: ANN,
    items: [{ itemId: item.id }, { itemId: item.id }],
    offer: 600,
  });
  assert.equal(repo.setOfferStatus(withOffer.id, 'accepted', 'Sure.').ok, true);
  assert.equal(repo.getPurchaseRequest(withOffer.id).offer_status, 'accepted');
  assert.equal(repo.setOfferStatus(withOffer.id, 'nonsense').ok, false);

  const noOffer = repo.createPurchaseRequest({ customer: ANN, items: [{ itemId: item.id }] });
  const r = repo.setOfferStatus(noOffer.id, 'accepted');
  assert.equal(r.ok, false);
  assert.match(r.reason, /no offer/);
});

// ---------------------------------------------------------------------------
// Saved cart
// ---------------------------------------------------------------------------

test('a cart survives being saved and reloaded', () => {
  const item = mk({ title: 'Cart unit', listing_price: 200, quantity: 5 });
  const up = repo.addUpgrade(item.id, { label: '+RAM', price_delta: 50 });

  repo.saveCart(ANN.id, [{ itemId: item.id, upgradeIds: [up.id], qty: 2 }]);
  const { lines } = repo.getCart(ANN.id);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].qty, 2);
  assert.equal(lines[0].unit, 250, 'the upgrade is priced into the line');
  assert.equal(lines[0].max, 5);
});

test('a restored cart re-reads live prices instead of trusting what was saved', () => {
  const item = mk({ title: 'Repriced', listing_price: 200, quantity: 3 });
  repo.saveCart(ANN.id, [{ itemId: item.id, qty: 1 }]);
  assert.equal(repo.getCart(ANN.id).lines[0].unit, 200);

  // The shop drops the price while the cart sits there for a few days.
  repo.updateItem(item.id, { listing_price: 150 });
  repo.saveCart(ANN.id, repo.getCart(ANN.id).lines.map((l) => ({ itemId: l.itemId, qty: l.qty })));
  assert.equal(repo.getCart(ANN.id).lines[0].unit, 150, 'a stale price must never survive');
});

test('a cart cannot outlive the stock it points at', () => {
  const item = mk({ title: 'Will sell', listing_price: 100, quantity: 1 });
  repo.saveCart(ANN.id, [{ itemId: item.id, qty: 1 }]);
  assert.equal(repo.getCart(ANN.id).lines.length, 1);

  repo.markSold(item.id, { sold_price: 100, sold_date: '2026-08-01' });
  // Re-saving drops the line rather than letting someone check out a sold unit.
  repo.saveCart(ANN.id, [{ itemId: item.id, qty: 1 }]);
  assert.equal(repo.getCart(ANN.id).lines.length, 0);
});

test('cart quantities are clamped to available stock', () => {
  const item = mk({ title: 'Only two', listing_price: 50, quantity: 2 });
  repo.saveCart(ANN.id, [{ itemId: item.id, qty: 99 }]);
  assert.equal(repo.getCart(ANN.id).lines[0].qty, 2);
  repo.saveCart(ANN.id, [{ itemId: item.id, qty: -5 }]);
  assert.equal(repo.getCart(ANN.id).lines[0].qty, 1);
});

test('clearing a cart empties it, and an unknown user has an empty one', () => {
  repo.clearCart(ANN.id);
  assert.deepEqual(repo.getCart(ANN.id).lines, []);
  assert.deepEqual(repo.getCart(4242).lines, [], 'an unknown user has an empty cart');
});

// ---------------------------------------------------------------------------
// Market snapshot — the claim about other sellers' prices
// ---------------------------------------------------------------------------

const comps = (over = {}) => ({
  stats: { active: { count: 12, median: 520, min: 450, max: 610 }, sold: { count: 0, median: null } },
  marketEstimateBasis: 'live_active', isDemo: false, condition: 'refurbished', ...over,
});

test('a live snapshot is stored and read back', () => {
  const item = mk({ title: 'Comped' });
  repo.saveMarketSnapshot(item.id, comps());
  const snap = repo.marketSnapshot(item.id);
  assert.equal(snap.median, 520);
  assert.equal(snap.sample, 12);
  assert.equal(snap.basis, 'active');
});

test('sold comps are reported as a stronger claim than asking prices', () => {
  const item = mk({ title: 'Sold comps' });
  repo.saveMarketSnapshot(item.id, comps({
    stats: { active: { count: 3, median: 500 }, sold: { count: 8, median: 470, min: 400, max: 520 } },
    marketEstimateBasis: 'live_sold',
  }));
  const snap = repo.marketSnapshot(item.id);
  assert.equal(snap.basis, 'sold', 'the UI words these differently, so it must survive');
  assert.equal(snap.median, 470, 'sold data wins over asking prices');
});

test('demo comps never become a claim about the market', () => {
  // Telling a buyer "similar units sell for $520" on simulated data would be
  // inventing a fact about the world.
  const item = mk({ title: 'Demo comped' });
  repo.saveMarketSnapshot(item.id, comps({ isDemo: true }));
  assert.equal(repo.marketSnapshot(item.id), null);
  assert.equal(repo.shopItems().find((i) => i.id === item.id).market, null);
});

test('a stale snapshot is dropped rather than shown as current', () => {
  const item = mk({ title: 'Stale' });
  repo.saveMarketSnapshot(item.id, comps());
  assert.ok(repo.marketSnapshot(item.id));
  assert.equal(repo.marketSnapshot(item.id, { maxAgeDays: -1 }), null);
});

test('an item with no comps simply has no market note', () => {
  const item = mk({ title: 'Uncomped' });
  assert.equal(repo.marketSnapshot(item.id), null);
  assert.equal(repo.saveMarketSnapshot(item.id, { stats: { active: {}, sold: {} } }), null);
});

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

test('related items prefer a complementary category over more of the same', () => {
  const laptop = mk({ title: 'ThinkPad', category: 'laptop', listing_price: 400 });
  mk({ title: 'Another laptop', category: 'laptop', listing_price: 380 });
  mk({ title: 'RAM kit', category: 'ram', listing_price: 40 });
  mk({ title: 'NVMe drive', category: 'ssd', listing_price: 70 });

  const rel = repo.relatedItems(laptop.id, 3).map((r) => r.category);
  assert.ok(!rel.includes('laptop') || rel[0] !== 'laptop',
    'showing more laptops beside a laptop is a listing page, not a suggestion');
  assert.ok(rel.includes('ram') || rel.includes('ssd'));
  assert.ok(!repo.relatedItems(laptop.id).some((r) => r.id === laptop.id), 'never suggests itself');
  assert.deepEqual(repo.relatedItems(999999), []);
});

test('categories are counted for the filter chips', () => {
  const cats = repo.shopCategories();
  assert.ok(cats.length);
  for (const c of cats) assert.ok(c.count > 0);
  // Sorted most-stocked first, so the useful chip leads.
  assert.ok(cats[0].count >= cats[cats.length - 1].count);
});

test('recently viewed is per-shopper and only shows what is still buyable', () => {
  const item = mk({ title: 'Viewed unit' });
  const gone = mk({ title: 'Viewed then sold' });
  repo.logVisit({ kind: 'item', user: ANN, itemId: item.id, itemTitle: item.title });
  repo.logVisit({ kind: 'item', user: ANN, itemId: gone.id, itemTitle: gone.title });
  repo.markSold(gone.id, { sold_price: 300, sold_date: '2026-08-01' });

  const seen = repo.recentlyViewed(ANN.id);
  assert.ok(seen.some((i) => i.id === item.id));
  assert.ok(!seen.some((i) => i.id === gone.id), 'a sold item is not a useful shortcut');
  assert.deepEqual(repo.recentlyViewed(9999), [], 'another shopper sees nothing of theirs');
});
