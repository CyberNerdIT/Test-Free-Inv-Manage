import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildInvite, parseInvite, buildProfile, sanitizeProfile,
  connectionState, suggestConnections, storefrontFriends,
} from '../src/services/social.js';
import { generateNodeKeypair } from '../src/services/directory.js';

// Shop-to-shop connections: friends, whether they connected back, and the
// friend-of-friend hop that turns a list of shops into a network.

const ME = generateNodeKeypair().publicKey;
const ANN = generateNodeKeypair().publicKey;
const BOB = generateNodeKeypair().publicKey;
const CAROL = generateNodeKeypair().publicKey;

// ---------------------------------------------------------------------------
// Invites
// ---------------------------------------------------------------------------

test('an invite round-trips through a single pasteable code', () => {
  const code = buildInvite({ node: ANN, url: 'https://ann.example/', name: "Ann's Tech Garage" });
  assert.ok(code.startsWith('TG1.'));
  assert.deepEqual(parseInvite(code), {
    node: ANN, url: 'https://ann.example', name: "Ann's Tech Garage",
  });
});

test('a mistyped or hostile invite is rejected, not half-accepted', () => {
  assert.equal(parseInvite(''), null);
  assert.equal(parseInvite('TG1.not-base64!!'), null);
  assert.equal(parseInvite('TG1.' + Buffer.from('{"n":"x"}').toString('base64url')), null, 'no URL');
  assert.equal(parseInvite('TG1.' + Buffer.from(JSON.stringify({ n: ANN, u: 'javascript:alert(1)' })).toString('base64url')), null);
  assert.equal(parseInvite('TG1.' + Buffer.from(JSON.stringify({ n: 'short', u: 'https://x.example' })).toString('base64url')), null);
  assert.equal(buildInvite({ node: ANN }), null, 'a URL is required');
});

test('a bare code without the prefix still parses', () => {
  // People paste from chat apps that mangle things; be forgiving on input.
  const code = buildInvite({ node: ANN, url: 'https://ann.example', name: 'Ann' });
  assert.deepEqual(parseInvite(code.slice(4)), parseInvite(code));
  assert.deepEqual(parseInvite(`  ${code}  `), parseInvite(code));
});

// ---------------------------------------------------------------------------
// Profiles
// ---------------------------------------------------------------------------

const profileOpts = {
  node: ANN, brand: { name: "Ann's Tech Garage", tagline: 'Fair prices' },
  url: 'https://ann.example/', region: { country: 'US', state: 'NY', area: 'Brooklyn' },
  categories: ['laptop', 'LAPTOP'], itemCount: 12,
};

test('a private shop omits its connections rather than reporting none', () => {
  // "Keeps it private" and "has no friends" are different facts, and a reader
  // that cannot tell them apart would draw the wrong conclusion.
  const priv = buildProfile({ ...profileOpts, recommends: null });
  assert.equal('recommends' in priv, false);

  const pub = buildProfile({ ...profileOpts, recommends: [] });
  assert.deepEqual(pub.recommends, []);
});

test('a published profile carries pointers, not opinions', () => {
  const p = buildProfile({
    ...profileOpts,
    recommends: [{ node: BOB, name: "Bob's Bits", url: 'https://bob.example/', rating: 5, note: 'great guy' }],
  });
  assert.deepEqual(Object.keys(p.recommends[0]).sort(), ['name', 'node', 'url']);
  assert.equal(p.recommends[0].url, 'https://bob.example');
  assert.deepEqual(p.categories, ['laptop'], 'categories are de-duplicated');
  assert.equal(p.url, 'https://ann.example');
});

test('a remote profile claiming the wrong node id is discarded', () => {
  const raw = buildProfile(profileOpts);
  assert.ok(sanitizeProfile(raw, { expectNode: ANN }));
  assert.equal(sanitizeProfile(raw, { expectNode: BOB }), null, 'impersonation or misconfiguration — unusable either way');
});

test('a hostile profile cannot smuggle a bad URL through', () => {
  assert.equal(sanitizeProfile({ node: ANN, name: 'x', url: 'javascript:alert(1)' }), null);
  assert.equal(sanitizeProfile({ node: ANN, name: 'x', url: 'data:text/html,x' }), null);
  assert.equal(sanitizeProfile(null), null);
  assert.equal(sanitizeProfile('a string'), null);

  // A recommendation with a bad URL is dropped; the rest of the profile stands.
  const p = sanitizeProfile({
    node: ANN, name: 'Ann', url: 'https://ann.example',
    recommends: [
      { node: BOB, name: 'Bob', url: 'https://bob.example' },
      { node: CAROL, name: 'Evil', url: 'javascript:alert(1)' },
    ],
  });
  assert.equal(p.recommends.length, 1);
  assert.equal(p.recommends[0].node, BOB);
});

test('remote profile fields are clamped', () => {
  const p = sanitizeProfile({
    node: ANN, name: 'x'.repeat(200), tagline: 'y'.repeat(400),
    url: 'https://ann.example', itemCount: -5, categories: 'not an array',
  });
  assert.equal(p.name.length, 80);
  assert.equal(p.tagline.length, 160);
  assert.equal(p.itemCount, 0);
  assert.deepEqual(p.categories, []);
});

// ---------------------------------------------------------------------------
// Mutuality
// ---------------------------------------------------------------------------

test('connection state distinguishes mutual, one-way, private and offline', () => {
  const listsMe = { node: ANN, recommends: [{ node: ME, name: 'Me', url: 'https://me.example' }] };
  const doesNot = { node: ANN, recommends: [{ node: BOB, name: 'Bob', url: 'https://bob.example' }] };
  const private_ = { node: ANN };

  assert.equal(connectionState(ME, listsMe), 'mutual');
  assert.equal(connectionState(ME, doesNot), 'following');
  // A private shop might well list us — we simply cannot tell, and saying
  // "following" would assert something we don't know.
  assert.equal(connectionState(ME, private_), 'unknown');
  assert.equal(connectionState(ME, null), 'unreachable');
});

// ---------------------------------------------------------------------------
// Friend-of-friend suggestions
// ---------------------------------------------------------------------------

const profileOf = (node, name, recommends) => ({ node, name, recommends });

test('shops your connections vouch for are suggested', () => {
  const suggestions = suggestConnections({
    myNode: ME,
    profiles: [profileOf(ANN, 'Ann', [{ node: CAROL, name: 'Carol', url: 'https://carol.example' }])],
    knownNodes: [ANN],
  });
  assert.equal(suggestions.length, 1);
  assert.equal(suggestions[0].node, CAROL);
  assert.deepEqual(suggestions[0].vouchedBy.map((v) => v.name), ['Ann']);
});

test('two connections vouching for the same shop ranks it higher', () => {
  const dave = generateNodeKeypair().publicKey;
  const suggestions = suggestConnections({
    myNode: ME,
    profiles: [
      profileOf(ANN, 'Ann', [
        { node: CAROL, name: 'Carol', url: 'https://carol.example' },
        { node: dave, name: 'Dave', url: 'https://dave.example' },
      ]),
      profileOf(BOB, 'Bob', [{ node: CAROL, name: 'Carol', url: 'https://carol.example' }]),
    ],
    knownNodes: [ANN, BOB],
  });
  assert.equal(suggestions[0].node, CAROL);
  assert.equal(suggestions[0].vouches, 2);
  assert.equal(suggestions[1].vouches, 1);
});

test('one connection listing a shop twice is still one vouch', () => {
  const suggestions = suggestConnections({
    myNode: ME,
    profiles: [
      profileOf(ANN, 'Ann', [
        { node: CAROL, name: 'Carol', url: 'https://carol.example' },
        { node: CAROL, name: 'Carol again', url: 'https://carol.example' },
      ]),
    ],
    knownNodes: [ANN],
  });
  assert.equal(suggestions[0].vouches, 1, 'vouches count shops, not mentions');
});

test('you are never suggested to yourself, nor shops you already know', () => {
  const suggestions = suggestConnections({
    myNode: ME,
    profiles: [profileOf(ANN, 'Ann', [
      { node: ME, name: 'Me', url: 'https://me.example' },
      { node: BOB, name: 'Bob', url: 'https://bob.example' },
      { node: CAROL, name: 'Carol', url: 'https://carol.example' },
    ])],
    knownNodes: [ANN, BOB],
  });
  assert.deepEqual(suggestions.map((s) => s.node), [CAROL]);
});

test('blocked and dismissed shops never come back as suggestions', () => {
  const opts = {
    myNode: ME,
    profiles: [profileOf(ANN, 'Ann', [{ node: CAROL, name: 'Carol', url: 'https://carol.example' }])],
    knownNodes: [ANN],
  };
  assert.equal(suggestConnections(opts).length, 1);
  assert.equal(suggestConnections({ ...opts, blockedNodes: [CAROL] }).length, 0);
});

test('a connection that keeps its list private contributes nothing, harmlessly', () => {
  const suggestions = suggestConnections({
    myNode: ME,
    profiles: [profileOf(ANN, 'Ann', undefined), null, profileOf(BOB, 'Bob', [])],
    knownNodes: [ANN, BOB],
  });
  assert.deepEqual(suggestions, []);
});

test('suggestions are capped', () => {
  const many = Array.from({ length: 30 }, (_, i) => ({
    node: generateNodeKeypair().publicKey, name: `Shop ${i}`, url: `https://s${i}.example`,
  }));
  const out = suggestConnections({ myNode: ME, profiles: [profileOf(ANN, 'Ann', many)], knownNodes: [ANN] });
  assert.equal(out.length, 8);
});

// ---------------------------------------------------------------------------
// The storefront row
// ---------------------------------------------------------------------------

const peer = (over = {}) => ({
  node: generateNodeKeypair().publicKey, name: 'Shop', url: 'https://s.example',
  region: { country: 'US', state: 'NY' }, trusted: true, blocked: false, mutual: false, ...over,
});

test('mutual partners lead the storefront row', () => {
  const oneWay = peer({ name: 'One Way', region: { country: 'US', state: 'NY', area: 'Brooklyn' } });
  const partner = peer({ name: 'Partner', mutual: true, region: { country: 'US', state: 'CA' } });
  const out = storefrontFriends([oneWay, partner], { myRegion: { country: 'US', state: 'NY', area: 'Brooklyn' } });
  assert.equal(out[0].name, 'Partner', 'a shop that connected back is a relationship, not a bookmark');
  assert.equal(out[0].mutual, true);
});

test('only trusted, unblocked, complete shops are shown to customers', () => {
  const out = storefrontFriends([
    peer({ name: 'Good' }),
    peer({ name: 'Blocked', blocked: true }),
    peer({ name: 'Just seen nearby', trusted: false }),
    peer({ name: '', url: 'https://x.example' }),
    peer({ name: 'No URL', url: '' }),
  ], { myRegion: { country: 'US' } });
  assert.deepEqual(out.map((f) => f.name), ['Good']);
});

test('the storefront row is capped and tolerates an empty list', () => {
  const many = Array.from({ length: 20 }, (_, i) => peer({ name: `Shop ${i}` }));
  assert.equal(storefrontFriends(many, { myRegion: { country: 'US' } }).length, 6);
  assert.deepEqual(storefrontFriends([], {}), []);
  assert.deepEqual(storefrontFriends(null, {}), []);
});
