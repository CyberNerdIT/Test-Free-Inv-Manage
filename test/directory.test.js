import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  generateNodeKeypair, signPayload, verifyPayload, shortNodeId,
  normalizeRegion, regionUsable, regionDistance,
  buildNodeRecord, buildListingRecord, sanitizeRemoteListing, rankRemoteListings,
} from '../src/services/directory.js';

// The directory is the one feature that sends shop data to a server the owner
// does not control, and brings other people's text back onto a customer's
// screen. Both directions are pinned here.

const NODE = generateNodeKeypair();
const ORIGIN = 'https://myshop.example';
const REGION = { country: 'US', state: 'NY', area: 'Brooklyn' };

const item = (over = {}) => ({
  id: 42, title: 'Dell Latitude 7420', category: 'laptop', condition: 'refurbished',
  brand: 'Dell', model: '7420', status: 'listed', listing_price: 549, quantity: 2,
  hidden: 0, shareCommunity: true, image: 7,
  // Everything below must never leave this machine.
  acquisition_cost: 180, fee_rate: 0.13, flat_fee: 0.3, shipping_cost: 12,
  serial_number: 'SVC-TAG-9931', location: 'Shelf B3', notes: 'Bought from Dave, haggled down',
  sold_price: null, target_margin: 0.3, compare_at_price: 1499,
  ...over,
});

// ---------------------------------------------------------------------------
// What leaves
// ---------------------------------------------------------------------------

test('a shared listing carries what a stranger needs and nothing else', () => {
  const rec = buildListingRecord(item(), { node: NODE.publicKey, origin: ORIGIN, region: REGION });
  assert.deepEqual(Object.keys(rec).sort(), [
    'brand', 'category', 'condition', 'currency', 'image', 'model',
    'node', 'price', 'quantity', 'ref', 'region', 'title', 'url',
  ]);
  assert.equal(rec.price, 549);
  assert.equal(rec.url, `${ORIGIN}/shop#item-42`);
  assert.equal(rec.image, `${ORIGIN}/api/public/media/7`);
});

test('no cost, margin, serial, location or private note can reach the directory', () => {
  const rec = buildListingRecord(item(), { node: NODE.publicKey, origin: ORIGIN, region: REGION });
  const json = JSON.stringify(rec);
  for (const secret of ['180', 'SVC-TAG-9931', 'Shelf B3', 'haggled', '0.13', '0.3']) {
    assert.ok(!json.includes(secret), `"${secret}" leaked into the shared payload`);
  }
  for (const field of ['acquisition_cost', 'fee_rate', 'flat_fee', 'shipping_cost',
    'serial_number', 'location', 'notes', 'target_margin', 'sold_price', 'compare_at_price']) {
    assert.equal(field in rec, false, `${field} must not be published`);
  }
});

test('nothing is published without an explicit per-item opt-in', () => {
  const opts = { node: NODE.publicKey, origin: ORIGIN, region: REGION };
  assert.equal(buildListingRecord(item({ shareCommunity: false }), opts), null);
  assert.equal(buildListingRecord(item({ shareCommunity: undefined }), opts), null);
});

test('a listing nobody could buy is never advertised', () => {
  const opts = { node: NODE.publicKey, origin: ORIGIN, region: REGION };
  // Sending strangers across the community to a dead link would poison the
  // whole directory.
  assert.equal(buildListingRecord(item({ status: 'sold' }), opts), null);
  assert.equal(buildListingRecord(item({ status: 'scrapped' }), opts), null);
  assert.equal(buildListingRecord(item({ hidden: 1 }), opts), null);
  assert.equal(buildListingRecord(item({ listing_price: null }), opts), null);
  // Without an origin the link would be relative and useless off-site.
  assert.equal(buildListingRecord(item(), { node: NODE.publicKey, region: REGION }), null);
});

test('the listing ref is stable, so re-publishing updates rather than duplicates', () => {
  const opts = { node: NODE.publicKey, origin: ORIGIN, region: REGION };
  const a = buildListingRecord(item(), opts);
  const b = buildListingRecord(item({ title: 'Renamed', listing_price: 499 }), opts);
  assert.equal(a.ref, b.ref);
  assert.notEqual(a.ref, buildListingRecord(item({ id: 43 }), opts).ref);
});

test('the node record publishes only what the admin typed', () => {
  const rec = buildNodeRecord({
    node: NODE.publicKey,
    site: { url: ORIGIN }, brand: { name: 'Tech Garage', tagline: 'Good kit, fair prices' },
    region: REGION, categories: ['laptop', 'LAPTOP', 'ram'], itemCount: 12, contact: 'hi@myshop.example',
  });
  assert.deepEqual(rec.categories, ['laptop', 'ram'], 'categories are de-duplicated and lower-cased');
  assert.equal(rec.region.country, 'US');
  assert.equal(rec.itemCount, 12);
});

// ---------------------------------------------------------------------------
// Region — coarse on purpose
// ---------------------------------------------------------------------------

test('region is clamped to a coarse, self-declared location', () => {
  const r = normalizeRegion({
    country: 'usa', state: 'New York', area: 'Brooklyn', postalPrefix: '11215-1234',
  });
  assert.equal(r.country, '', 'a 3-letter country code is not ISO-2 and is dropped');
  assert.equal(r.postalPrefix, '1121', 'a full postcode is truncated to a district');

  const ok = normalizeRegion(REGION);
  assert.equal(ok.country, 'US');
  assert.equal(regionUsable(ok), true);
  assert.equal(regionUsable({ state: 'NY' }), false, 'a region with no country cannot be matched');
});

test('region normalization has no field for a precise address', () => {
  const r = normalizeRegion({
    country: 'US', street: '12 Example Road', lat: 40.67, lng: -73.98, postcode: '11215',
  });
  assert.deepEqual(Object.keys(r).sort(), ['area', 'country', 'postalPrefix', 'state']);
  assert.ok(!JSON.stringify(r).includes('40.67'), 'coordinates must never survive');
  assert.ok(!JSON.stringify(r).includes('Example Road'));
});

test('proximity ranks same-town above same-state above same-country', () => {
  assert.equal(regionDistance(REGION, REGION), 3);
  assert.equal(regionDistance(REGION, { country: 'US', state: 'NY', area: 'Queens' }), 2);
  assert.equal(regionDistance(REGION, { country: 'US', state: 'CA', area: 'Oakland' }), 1);
  assert.equal(regionDistance(REGION, { country: 'GB', state: 'London' }), 0);
  assert.equal(regionDistance(REGION, {}), 0);
});

// ---------------------------------------------------------------------------
// Signing — nobody can post as your shop
// ---------------------------------------------------------------------------

test('a signed payload verifies, and a tampered one does not', () => {
  const { message, signature } = signPayload(NODE.privateKey, { node: NODE.publicKey, ref: 'x:1' });
  assert.equal(verifyPayload(NODE.publicKey, message, signature).ok, true);

  const forged = message.replace('x:1', 'x:2');
  assert.equal(verifyPayload(NODE.publicKey, forged, signature).ok, false);
  // Another shop's key must not validate this message.
  assert.equal(verifyPayload(generateNodeKeypair().publicKey, message, signature).ok, false);
});

test('a captured request cannot be replayed later', () => {
  const now = Date.parse('2026-08-04T12:00:00Z');
  const { message, signature } = signPayload(NODE.privateKey, { node: NODE.publicKey }, { now });
  assert.equal(verifyPayload(NODE.publicKey, message, signature, { now }).ok, true);

  const late = verifyPayload(NODE.publicKey, message, signature, { now: now + 3600_000 });
  assert.equal(late.ok, false);
  assert.match(late.reason, /replay|tolerance/i);
});

test('verification fails closed on junk', () => {
  assert.equal(verifyPayload('', 'x', 'y').ok, false);
  assert.equal(verifyPayload(NODE.publicKey, 'not json', 'nope').ok, false);
  assert.equal(verifyPayload(NODE.publicKey, '{}', '').ok, false);
  assert.ok(shortNodeId(NODE.publicKey).length === 12);
});

// ---------------------------------------------------------------------------
// What comes back — untrusted input on a customer's screen
// ---------------------------------------------------------------------------

const remote = (over = {}) => ({
  ref: 'abc:1', node: 'OTHERNODE', shopName: 'Bob\'s Bits', title: 'Samsung 1TB NVMe',
  category: 'ssd', condition: 'new', brand: 'Samsung', price: 79,
  currency: 'USD', url: 'https://bobsbits.example/shop#item-3',
  image: 'https://bobsbits.example/api/public/media/9',
  region: { country: 'US', state: 'NY', area: 'Queens' }, ...over,
});

test('a hostile remote listing cannot inject a script or a bad URL', () => {
  assert.equal(sanitizeRemoteListing(remote({ url: 'javascript:alert(1)' })), null);
  assert.equal(sanitizeRemoteListing(remote({ url: 'data:text/html,<script>x</script>' })), null);
  assert.equal(sanitizeRemoteListing(remote({ url: 'file:///etc/passwd' })), null);

  // A dangerous image URL is dropped, but the listing survives — one bad field
  // should not silently hide an otherwise fine result.
  const r = sanitizeRemoteListing(remote({ image: 'javascript:alert(1)' }));
  assert.equal(r.image, null);
  assert.equal(r.title, 'Samsung 1TB NVMe');
});

test('malformed remote listings are rejected rather than half-rendered', () => {
  assert.equal(sanitizeRemoteListing(null), null);
  assert.equal(sanitizeRemoteListing('a string'), null);
  assert.equal(sanitizeRemoteListing(remote({ title: '' })), null);
  assert.equal(sanitizeRemoteListing(remote({ price: 'free' })), null);
  assert.equal(sanitizeRemoteListing(remote({ price: -5 })), null);
  assert.equal(sanitizeRemoteListing(remote({ url: undefined })), null);
});

test('remote fields are clamped, and a bogus currency falls back', () => {
  const r = sanitizeRemoteListing(remote({ title: 'x'.repeat(500), currency: 'NOT-A-CURRENCY' }));
  assert.equal(r.title.length, 140);
  assert.equal(r.currency, 'USD');
});

// ---------------------------------------------------------------------------
// Ranking — what actually appears at the bottom of the shop
// ---------------------------------------------------------------------------

test('the strip never advertises something this shop already sells', () => {
  // Sending a customer to a competitor for an item on your own shelf is the
  // opposite of useful.
  const rows = [remote({ category: 'ssd' }), remote({ ref: 'b:2', category: 'laptop' })];
  const out = rankRemoteListings(rows, { myRegion: REGION, myCategories: ['laptop'] });
  assert.equal(out.length, 1);
  assert.equal(out[0].category, 'ssd');
});

test('invited shops outrank strangers, however far away', () => {
  const friend = remote({ ref: 'f:1', node: 'FRIEND', region: { country: 'US', state: 'CA' }, price: 200 });
  const stranger = remote({ ref: 's:1', node: 'STRANGER', region: REGION, price: 50 });
  const out = rankRemoteListings([stranger, friend], {
    myRegion: REGION, myCategories: [], trustedNodes: ['FRIEND'],
  });
  assert.equal(out[0].node, 'FRIEND');
});

test('among strangers, nearer wins, then cheaper', () => {
  const near = remote({ ref: 'n:1', node: 'A', region: REGION, price: 90 });
  const far = remote({ ref: 'f:1', node: 'B', region: { country: 'US', state: 'CA' }, price: 40 });
  const out = rankRemoteListings([far, near], { myRegion: REGION, myCategories: [] });
  assert.equal(out[0].node, 'A');
});

test('ranking survives a feed full of rubbish', () => {
  const out = rankRemoteListings(
    [null, 'nonsense', {}, remote(), remote({ url: 'javascript:x' })],
    { myRegion: REGION, myCategories: [] },
  );
  assert.equal(out.length, 1);
  assert.equal(rankRemoteListings(null, {}).length, 0);
});

test('the strip is capped so it stays a suggestion, not a second catalogue', () => {
  const many = Array.from({ length: 30 }, (_, i) => remote({ ref: `r:${i}`, price: i + 1 }));
  assert.equal(rankRemoteListings(many, { myRegion: REGION, myCategories: [] }).length, 4);
});
