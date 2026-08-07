import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseListingHtml } from '../src/services/ebayListing.js';

const HTML = `
<html><head>
<meta property="og:title" content="Fallback Title" />
<meta property="og:image" content="https://i.ebayimg.com/og.jpg" />
<script type="application/ld+json">
{"@context":"https://schema.org","@type":"Product",
 "name":"Lenovo ThinkPad T480 i5 16GB 256GB SSD",
 "image":["https://i.ebayimg.com/images/a.jpg","https://i.ebayimg.com/images/b.jpg"],
 "brand":{"@type":"Brand","name":"Lenovo"},
 "mpn":"ThinkPad T480",
 "offers":{"@type":"Offer","price":"315.00","priceCurrency":"USD","itemCondition":"https://schema.org/UsedCondition"}}
</script>
<script>var meta = {"name":"Processor","value":["Intel Core i5-8350U"]};
  x={"name":"RAM Size","value":["16 GB"]}; y={"name":"SSD Capacity","value":["256 GB"]};
  z={"name":"Type","value":["Notebook/Laptop"]};</script>
</head><body>...</body></html>`;

test('parseListingHtml extracts title, price, condition, image, brand from JSON-LD', () => {
  const it = parseListingHtml(HTML, '123456789012', 'https://www.ebay.com/itm/123456789012');
  assert.equal(it.title, 'Lenovo ThinkPad T480 i5 16GB 256GB SSD');
  assert.equal(it.listing_price, 315);
  assert.equal(it.condition, 'used');
  assert.equal(it.brand, 'Lenovo');
  assert.equal(it.model, 'ThinkPad T480');
  assert.equal(it.image, 'https://i.ebayimg.com/images/a.jpg');
  assert.equal(it.category, 'laptop');
  assert.match(it.notes, /scraped, no API/);
  assert.equal(it.sourceUrl, 'https://www.ebay.com/itm/123456789012');
});

test('parseListingHtml scrapes item specifics into specs', () => {
  const it = parseListingHtml(HTML, '1', null);
  assert.match(it.specs.cpu, /i5-8350U/);
  assert.equal(it.specs.ram, '16 GB');
  assert.equal(it.specs.storage, '256 GB');
});

test('parseListingHtml falls back to og:title when no JSON-LD product', () => {
  const it = parseListingHtml('<meta property="og:title" content="Just OG Title" />', '9', null);
  assert.equal(it.title, 'Just OG Title');
});

test('parseListingHtml returns null when the page is unreadable', () => {
  assert.equal(parseListingHtml('<html><body>blocked</body></html>', '9', null), null);
});
