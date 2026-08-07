import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as repo from '../src/repo.js';

test('importItems creates new items and upserts by sku or id (fields merge)', () => {
  const r1 = repo.importItems([{ title: 'Imported A', sku: 'SKU-A', acquisition_cost: 100, listing_price: 200 }]);
  assert.equal(r1.created, 1);
  const a = repo.getItemBySku('SKU-A');
  assert.ok(a);
  assert.equal(a.listing_price, 200);

  // Re-import with the same sku updates only the supplied fields.
  const r2 = repo.importItems([{ sku: 'SKU-A', listing_price: 250, location: 'Bin 9' }]);
  assert.equal(r2.updated, 1);
  const a2 = repo.getItemBySku('SKU-A');
  assert.equal(a2.listing_price, 250);
  assert.equal(a2.location, 'Bin 9');
  assert.equal(a2.title, 'Imported A'); // untouched — details added later, nothing wiped

  // Matching by numeric id also updates in place.
  const r3 = repo.importItems([{ id: a2.id, brand: 'Dell' }]);
  assert.equal(r3.updated, 1);
  assert.equal(repo.getItem(a2.id).brand, 'Dell');
});

test('quickAddItems creates bare items from a list of titles', () => {
  const r = repo.quickAddItems(['Quick 1', '   ', 'Quick 2'], { category: 'component' });
  assert.equal(r.created, 2); // blank line skipped
  assert.equal(r.items[0].title, 'Quick 1');
  assert.equal(r.items[0].category, 'component');
  assert.equal(r.items[0].status, 'in_stock');
});

test('sample templates are well-formed and importable', () => {
  const csv = repo.sampleImportCsv();
  assert.match(csv, /^id,sku,title,/);
  assert.match(csv, /Dell Latitude 7420/);
  const json = repo.sampleImportJson();
  assert.ok(Array.isArray(json.items) && json.items.length >= 1);
  const r = repo.importItems(json.items);
  assert.ok(r.items >= 1);
});
