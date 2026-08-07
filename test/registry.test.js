import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  validateEntry, validateRegistry, normalizeEntry, selectPeers, buildRegistryEntry,
} from '../src/services/registry.js';
import { generateNodeKeypair } from '../src/services/directory.js';

// The repo IS the directory: directory/nodes.json is the shop list, and each
// shop serves its own stock. That makes this file untrusted input read by every
// install, so its rules are pinned here — and the shipped file is checked too.

const NODE = generateNodeKeypair().publicKey;
const entry = (over = {}) => ({
  node: NODE, name: "Ann's Tech Garage", url: 'https://shop.example',
  region: { country: 'US', state: 'NY', area: 'Brooklyn' },
  categories: ['laptop', 'ram'], ...over,
});

// ---------------------------------------------------------------------------
// Entry validation
// ---------------------------------------------------------------------------

test('a well-formed entry passes', () => {
  assert.deepEqual(validateEntry(entry()), { ok: true, errors: [] });
});

test('a shop must have a real node key, name, URL and country', () => {
  assert.equal(validateEntry(entry({ node: 'not-a-key' })).ok, false);
  assert.equal(validateEntry(entry({ node: '' })).ok, false);
  assert.equal(validateEntry(entry({ name: '' })).ok, false);
  assert.equal(validateEntry(entry({ url: 'shop.example' })).ok, false, 'a bare host is not a URL');
  assert.equal(validateEntry(entry({ region: { state: 'NY' } })).ok, false, 'no country means it cannot be matched');
  assert.equal(validateEntry(entry({ region: { country: 'USA' } })).ok, false, 'ISO-2 only');
  assert.equal(validateEntry(null).ok, false);
});

test('a URL carrying a query string or fragment is rejected', () => {
  // A registry that carries credentials or tracking in a URL is a registry that
  // leaks them to everyone who reads the file.
  assert.equal(validateEntry(entry({ url: 'https://shop.example?token=secret' })).ok, false);
  assert.equal(validateEntry(entry({ url: 'https://shop.example#anchor' })).ok, false);
});

test('a hostile URL scheme cannot be registered', () => {
  for (const url of ['javascript:alert(1)', 'data:text/html,<script>x</script>', 'file:///etc/passwd']) {
    assert.equal(validateEntry(entry({ url })).ok, false, `${url} must be rejected`);
  }
});

test('oversized fields are rejected, not silently truncated', () => {
  // Truncating on the way in would mean the file no longer says what the
  // submitter wrote, which a reviewer reading the diff would not expect.
  assert.equal(validateEntry(entry({ name: 'x'.repeat(200) })).ok, false);
  assert.equal(validateEntry(entry({ tagline: 'x'.repeat(200) })).ok, false);
  assert.equal(validateEntry(entry({ contact: 'x'.repeat(400) })).ok, false);
  assert.equal(validateEntry(entry({ categories: 'laptop' })).ok, false, 'categories must be an array');
});

test('normalizing tidies an entry without changing what it means', () => {
  const e = normalizeEntry(entry({ url: 'https://shop.example///', categories: ['Laptop', 'LAPTOP', 'ram'] }));
  assert.equal(e.url, 'https://shop.example', 'trailing slashes are dropped so URLs compare equal');
  assert.deepEqual(e.categories, ['laptop', 'ram']);
  assert.equal(e.region.country, 'US');
});

// ---------------------------------------------------------------------------
// Whole-file validation
// ---------------------------------------------------------------------------

test('the registry rejects duplicate shops', () => {
  // Two entries claiming the same node or URL is what an impersonation attempt
  // would look like in a diff.
  const dupNode = validateRegistry({ nodes: [entry(), entry({ url: 'https://other.example' })] });
  assert.equal(dupNode.ok, false);
  assert.ok(dupNode.errors.some((e) => /duplicate node/.test(e)));

  const other = generateNodeKeypair().publicKey;
  const dupUrl = validateRegistry({ nodes: [entry(), entry({ node: other })] });
  assert.equal(dupUrl.ok, false);
  assert.ok(dupUrl.errors.some((e) => /duplicate url/.test(e)));
});

test('one bad entry degrades the list rather than emptying it', () => {
  const good = entry({ node: generateNodeKeypair().publicKey, url: 'https://good.example' });
  const r = validateRegistry({ nodes: [entry({ url: 'nonsense' }), good] });
  assert.equal(r.ok, false, 'the file is reported as invalid');
  assert.equal(r.entries.length, 1, 'but the valid shop still loads');
  assert.equal(r.entries[0].url, 'https://good.example');
});

test('a malformed registry file does not throw', () => {
  assert.equal(validateRegistry(null).ok, false);
  assert.equal(validateRegistry({}).ok, false);
  assert.equal(validateRegistry({ nodes: 'not an array' }).ok, false);
  assert.deepEqual(validateRegistry({ nodes: [] }), { ok: true, errors: [], entries: [] });
});

test('the registry file shipped in this repo is valid', () => {
  // CI runs the same check, but a broken file merged here would be read by every
  // install, so it is worth failing the unit suite too.
  const doc = JSON.parse(readFileSync('directory/nodes.json', 'utf8'));
  const r = validateRegistry(doc);
  assert.equal(r.ok, true, `directory/nodes.json is invalid:\n${r.errors.join('\n')}`);
  assert.equal(doc.version, 1);
});

// ---------------------------------------------------------------------------
// Choosing who to ask
// ---------------------------------------------------------------------------

const peer = (over = {}) => normalizeEntry(entry({
  node: generateNodeKeypair().publicKey, url: `https://s${Math.random().toString(36).slice(2, 8)}.example`, ...over,
}));

test('a shop never asks itself for listings', () => {
  const me = peer();
  assert.equal(selectPeers([me], { myNode: me.node, myRegion: me.region }).length, 0);
});

test('only shops in the same country are "nearby"', () => {
  const local = peer({ region: { country: 'US', state: 'NY', area: 'Queens' } });
  const abroad = peer({ region: { country: 'GB', state: 'London' } });
  const out = selectPeers([local, abroad], { myRegion: { country: 'US', state: 'NY', area: 'Brooklyn' } });
  assert.equal(out.length, 1);
  assert.equal(out[0].node, local.node);
});

test('an invited shop is asked even from the other side of the world', () => {
  // Distance is a heuristic; an explicit invite is a decision, and beats it.
  const friend = peer({ region: { country: 'JP', state: 'Tokyo' } });
  const out = selectPeers([friend], {
    myRegion: { country: 'US', state: 'NY' }, trustedNodes: [friend.node],
  });
  assert.equal(out.length, 1);
});

test('blocked shops are never asked', () => {
  const bad = peer({ region: { country: 'US', state: 'NY' } });
  assert.equal(selectPeers([bad], { myRegion: { country: 'US', state: 'NY' }, blockedNodes: [bad.node] }).length, 0);
  // Blocking beats trusting — if both are set, the shop stays out.
  assert.equal(selectPeers([bad], {
    myRegion: { country: 'US', state: 'NY' }, trustedNodes: [bad.node], blockedNodes: [bad.node],
  }).length, 0);
});

test('nearer shops are asked first, and invited ones before all', () => {
  const sameTown = peer({ region: { country: 'US', state: 'NY', area: 'Brooklyn' } });
  const sameState = peer({ region: { country: 'US', state: 'NY', area: 'Buffalo' } });
  const sameCountry = peer({ region: { country: 'US', state: 'CA' } });
  const friendFar = peer({ region: { country: 'US', state: 'TX' } });

  const out = selectPeers([sameCountry, sameState, sameTown, friendFar], {
    myRegion: { country: 'US', state: 'NY', area: 'Brooklyn' },
    trustedNodes: [friendFar.node],
  });
  assert.deepEqual(out.map((p) => p.node), [friendFar.node, sameTown.node, sameState.node, sameCountry.node]);
});

test('the peer list is capped, so a big registry cannot stall a storefront', () => {
  const many = Array.from({ length: 50 }, () => peer({ region: { country: 'US', state: 'NY' } }));
  assert.equal(selectPeers(many, { myRegion: { country: 'US', state: 'NY' } }).length, 8);
  assert.equal(selectPeers(many, { myRegion: { country: 'US', state: 'NY' }, limit: 3 }).length, 3);
});

// ---------------------------------------------------------------------------
// The block a shop owner submits
// ---------------------------------------------------------------------------

test('the generated entry validates and carries no secrets', () => {
  const r = buildRegistryEntry({
    node: NODE,
    brand: { name: "Ann's Tech Garage", tagline: 'Fair prices' },
    url: 'https://shop.example/',
    region: { country: 'US', state: 'NY', area: 'Brooklyn' },
    categories: ['laptop'],
    contact: 'hi@shop.example',
    today: '2026-08-04',
  });
  assert.equal(r.ok, true);
  assert.equal(r.entry.url, 'https://shop.example', 'the trailing slash is normalised away');
  assert.deepEqual(Object.keys(r.entry).sort(),
    ['added', 'categories', 'contact', 'name', 'node', 'region', 'tagline', 'url']);
  // The entry is public forever, so it must never carry anything private.
  assert.ok(!('privateKey' in r.entry));
  assert.ok(!JSON.stringify(r.entry).toLowerCase().includes('secret'));
  // It round-trips through the same validator CI uses.
  assert.equal(validateEntry(JSON.parse(r.json)).ok, true);
});

test('a shop that is not ready gets told why, before submitting', () => {
  const r = buildRegistryEntry({
    node: NODE, brand: { name: 'Nameless' }, url: '', region: {}, today: '2026-08-04',
  });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /url/.test(e)));
  assert.ok(r.errors.some((e) => /country/.test(e)));
});
