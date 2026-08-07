import { test } from 'node:test';
import assert from 'node:assert/strict';
import { searchComparables, resolveComps, stats, median } from '../src/services/pricing/index.js';
import { setRaw } from '../src/settings.js';

// The pricing orchestrator must never let simulated demo prices influence a
// real pricing decision. These tests pin that boundary.

const liveActive = [
  { source: 'ebay', title: 'A', price: 100, sold: false },
  { source: 'ebay', title: 'B', price: 200, sold: false },
  { source: 'ebay', title: 'C', price: 300, sold: false },
];
// Demo sold comps sit far away from the live prices so a leak is unmistakable.
const demoBundle = {
  active: [{ source: 'demo', title: 'D1', price: 999, sold: false }],
  sold: [{ source: 'demo', title: 'D2', price: 999, sold: true }],
};

test('eBay live but Marketplace Insights unapproved: no fake sold comps, estimate from live actives', () => {
  const r = resolveComps({ liveActive, liveSold: [], anyLive: true, anySoldLive: false, demo: demoBundle });

  assert.equal(r.isDemo, false);
  assert.equal(r.soldDataAvailable, false);
  assert.equal(r.sold.length, 0, 'sold must be empty, not filled with simulated rows');
  assert.equal(r.stats.sold.count, 0);

  // The critical regression: the estimate must come from the live actives (200),
  // never the demo sold median (999).
  assert.equal(r.marketEstimate, 200);
  assert.equal(r.marketEstimateBasis, 'live_active');
  assert.equal(r.marketEstimateIsLive, true);
  assert.ok(r.active.every((x) => x.demo === false));
  assert.match(r.notes.join(' '), /omitted rather than simulated/);
});

test('real sold data, when available, wins over active listings', () => {
  const liveSold = [{ source: 'ebay', title: 'S', price: 150, sold: true }];
  const r = resolveComps({ liveActive, liveSold, anyLive: true, anySoldLive: true });
  assert.equal(r.marketEstimate, 150);
  assert.equal(r.marketEstimateBasis, 'live_sold');
  assert.equal(r.marketEstimateIsLive, true);
  assert.equal(r.soldDataAvailable, true);
});

test('no live provider: demo is used but flagged, and never claims to be live', () => {
  const r = resolveComps({ anyLive: false, anySoldLive: false, demo: demoBundle });
  assert.equal(r.isDemo, true);
  assert.equal(r.marketEstimateIsLive, false, 'a demo estimate must not claim to be live');
  assert.match(r.marketEstimateBasis, /^demo_/);
  assert.ok(r.active.every((x) => x.demo === true));
  assert.ok(r.sold.every((x) => x.demo === true));
  assert.match(r.notes.join(' '), /DEMO DATA/);
});

test('live results never contain demo rows even when a demo bundle is present', () => {
  const r = resolveComps({ liveActive, liveSold: [], anyLive: true, anySoldLive: false, demo: demoBundle });
  const all = [...r.active, ...r.sold];
  assert.equal(all.some((x) => x.demo === true), false);
  assert.equal(all.some((x) => x.price === 999), false, 'demo prices must not leak into live output');
});

test('end-to-end with no credentials falls back to demo and labels it', async () => {
  for (const k of ['ebay_client_id', 'ebay_client_secret', 'amazon_access_key', 'amazon_secret_key', 'amazon_partner_tag']) {
    setRaw(k, '');
  }
  const r = await searchComparables('ThinkPad T480 i5 16GB');
  assert.equal(r.isDemo, true);
  assert.equal(r.marketEstimateIsLive, false);
  assert.ok(r.active.length > 0);
  assert.ok(r.active.every((x) => x.demo === true));
});

test('stats/median helpers ignore non-numeric prices', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([]), null);
  const s = stats([{ price: 10 }, { price: 20 }, { price: null }, { price: 'x' }]);
  assert.equal(s.count, 2);
  assert.equal(s.median, 15);
});
