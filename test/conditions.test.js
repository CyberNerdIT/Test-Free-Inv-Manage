import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CONDITION_GROUPS, CONDITION_KEYS, normalizeCondition,
  matchesCondition, conditionList,
} from '../src/services/pricing/conditions.js';
import { searchDemo } from '../src/services/pricing/demo.js';
import { searchComparables } from '../src/services/pricing/index.js';

// Condition matters to the money: comparing a refurbished machine against new
// retail listings raises the market estimate, which feeds the projected profit.
// These tests pin the shared vocabulary and prove the filter actually moves the
// number. How eBay and Amazon each SPELL a condition belongs to those
// integrations, which are part of the paid upgrade and not in this build.

test('every group has a label, a hint and a matcher', () => {
  for (const key of CONDITION_KEYS) {
    const g = CONDITION_GROUPS[key];
    assert.ok(g.label, `${key} needs a label`);
    assert.ok(g.hint, `${key} needs a hint`);
    assert.equal(typeof g.match, 'function', `${key} needs a matcher`);
  }
});

test('normalizeCondition accepts what users and items actually say', () => {
  assert.equal(normalizeCondition('Refurbished'), 'refurbished');
  assert.equal(normalizeCondition('refurb'), 'refurbished');
  assert.equal(normalizeCondition('Renewed'), 'refurbished');
  assert.equal(normalizeCondition('pre-owned'), 'used');
  assert.equal(normalizeCondition('open box'), 'new');
  assert.equal(normalizeCondition('for parts'), 'parts');
  // Anything unrecognised widens the search rather than returning nothing.
  assert.equal(normalizeCondition('banana'), 'any');
  assert.equal(normalizeCondition(null), 'any');
  assert.equal(normalizeCondition(undefined), 'any');
});

test('matchesCondition separates refurbished from new and used', () => {
  assert.equal(matchesCondition('refurbished', 'Certified - Refurbished'), true);
  assert.equal(matchesCondition('refurbished', 'Seller refurbished'), true);
  assert.equal(matchesCondition('refurbished', 'Brand New'), false);
  assert.equal(matchesCondition('refurbished', 'Used'), false);

  // "Manufacturer refurbished" contains the word "new" nowhere, but "Renewed"
  // must not be read as New — this is the trap the regex has to survive.
  assert.equal(matchesCondition('new', 'Renewed'), false);
  assert.equal(matchesCondition('new', 'New (other)'), true);
  assert.equal(matchesCondition('used', 'Used - Very Good'), true);
  assert.equal(matchesCondition('used', 'Seller refurbished'), false);
  assert.equal(matchesCondition('parts', 'For parts or not working'), true);

  assert.equal(matchesCondition('any', 'anything at all'), true);
});

test('an unlabelled comp is kept, not silently dropped', () => {
  // Discarding real listings because a marketplace omitted the field would skew
  // the median more than including them does.
  assert.equal(matchesCondition('refurbished', null), true);
  assert.equal(matchesCondition('refurbished', ''), true);
});

test('demo comps are coherent with the requested condition', async () => {
  for (const key of CONDITION_KEYS) {
    if (key === 'any') continue;
    const r = await searchDemo('ThinkPad T480', { condition: key });
    for (const row of [...r.active, ...r.sold]) {
      assert.ok(matchesCondition(key, row.condition),
        `demo returned "${row.condition}" for the ${key} filter`);
    }
  }
});

test('condition changes the price level, not just the label', async () => {
  const price = async (c) => (await searchComparables('Dell Latitude 7420 i7', { condition: c })).stats.active.median;
  const [nw, refurb, used, parts] = await Promise.all(
    ['new', 'refurbished', 'used', 'parts'].map(price));

  // A refurb comparison must not inherit new-retail prices — that is exactly
  // how a projected profit gets overstated.
  assert.ok(nw > refurb, `new (${nw}) should exceed refurbished (${refurb})`);
  assert.ok(refurb > used, `refurbished (${refurb}) should exceed used (${used})`);
  assert.ok(used > parts, `used (${used}) should exceed for-parts (${parts})`);
});

test('searchComparables reports the condition it actually used', async () => {
  const r = await searchComparables('ThinkPad', { condition: 'refurb' });
  assert.equal(r.condition, 'refurbished', 'aliases are normalised before searching');
  assert.equal(r.conditionLabel, 'Refurbished');

  const wide = await searchComparables('ThinkPad', { condition: 'nonsense' });
  assert.equal(wide.condition, 'any');
});

test('conditionList is safe to send to the browser', () => {
  const list = conditionList();
  assert.equal(list.length, CONDITION_KEYS.length);
  assert.equal(list[0].key, 'any', 'the widest option leads the dropdown');
  for (const c of list) assert.deepEqual(Object.keys(c).sort(), ['hint', 'key', 'label']);
});
