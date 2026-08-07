import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMessage } from '../src/services/notify.js';
import { isAllowedMime, MAX_IMAGE_BYTES } from '../src/services/images.js';

test('buildMessage: single item', () => {
  const m = buildMessage({
    item_title: 'ThinkPad T480',
    total_price: 315,
    upgrades_json: JSON.stringify([{ label: '+RAM', price_delta: 40 }]),
    customer_name: 'Bob', customer_username: 'bob',
  });
  assert.match(m, /ThinkPad T480/);
  assert.match(m, /\+RAM/);
  assert.match(m, /\$315\.00/);
  assert.match(m, /Bob/);
});

test('buildMessage: shows quantity for a single line and per item', () => {
  const single = buildMessage({
    item_title: 'ThinkPad T480', total_price: 630,
    items: [{ item_title: 'ThinkPad T480', qty: 2, unit_price: 315, subtotal: 630, upgrades: [] }],
    customer_name: 'Bo', customer_username: 'bo',
  });
  assert.match(single, /2× ThinkPad T480/);
  assert.match(single, /Qty: 2/);

  const multi = buildMessage({
    item_title: '2 items', total_price: 950,
    items: [
      { item_title: 'GPU', qty: 3, unit_price: 150, subtotal: 450, upgrades: [] },
      { item_title: 'Laptop', qty: 1, unit_price: 500, subtotal: 500, upgrades: [] },
    ],
    customer_username: 'z',
  });
  assert.match(multi, /3× GPU/);
  assert.match(multi, /\bLaptop\b/);
  assert.doesNotMatch(multi, /1× Laptop/); // qty 1 shows no prefix
});

test('buildMessage: multi-item cart with an offer', () => {
  const m = buildMessage({
    item_title: '2 items',
    total_price: 1150,
    offer_price: 1000,
    items: [
      { item_title: 'Dell Latitude', subtotal: 430, upgrades: [] },
      { item_title: 'Ryzen desktop', subtotal: 720, upgrades: [{ label: '+SSD', price_delta: 60 }] },
    ],
    customer_name: 'Jane', customer_username: 'jane', customer_email: 'jane@x.com',
  });
  assert.match(m, /2 items/);
  assert.match(m, /Dell Latitude/);
  assert.match(m, /Ryzen desktop/);
  assert.match(m, /\+SSD/);
  assert.match(m, /Total: \$1,150\.00/);
  assert.match(m, /OFFER: \$1,000\.00/);
  assert.match(m, /jane@x\.com/);
});


test('image mime whitelist', () => {
  assert.equal(isAllowedMime('image/jpeg'), true);
  assert.equal(isAllowedMime('image/png'), true);
  assert.equal(isAllowedMime('image/webp'), true);
  assert.equal(isAllowedMime('application/pdf'), false);
  assert.equal(isAllowedMime('text/html'), false);
  assert.ok(MAX_IMAGE_BYTES > 0);
});
