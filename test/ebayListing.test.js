import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseItemId } from '../src/services/ebayListing.js';

test('parseItemId extracts the item number from URLs and raw ids', () => {
  assert.equal(parseItemId('123456789012'), '123456789012');
  assert.equal(parseItemId('https://www.ebay.com/itm/123456789012'), '123456789012');
  assert.equal(parseItemId('https://www.ebay.com/itm/Dell-Latitude-7420-i7/123456789012?hash=abc'), '123456789012');
  assert.equal(parseItemId('https://www.ebay.com/itm/123456789012?var=1&x=2'), '123456789012');
  assert.equal(parseItemId('  https://ebay.us/abc?item=123456789012  '), '123456789012');
  assert.equal(parseItemId('not a listing'), null);
  assert.equal(parseItemId(''), null);
  assert.equal(parseItemId(null), null);
});
