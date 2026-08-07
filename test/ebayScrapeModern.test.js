import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseListingHtml, parseMoney, isChallengePage } from '../src/services/ebayListing.js';

// A modern eBay item page: NO Product JSON-LD (eBay stopped emitting it on most
// item pages), price rendered in .x-price-primary, item specifics in
// <dl class="ux-labels-values">. This is the shape the old parser could not read.
const MODERN_GPU = `<!DOCTYPE html><html><head>
<title>Dell NVIDIA Quadro P4000 8GB GDDR5 Graphics Card | eBay</title>
<meta property="og:title" content="Dell NVIDIA Quadro P4000 8GB GDDR5 Graphics Card" />
<meta property="og:image" content="https://i.ebayimg.com/images/g/abcAAOSw/s-l1600.jpg" />
<script type="application/ld+json">{"@context":"https://schema.org","@type":"BreadcrumbList","itemListElement":[]}</script>
</head><body>
<h1 class="x-item-title__mainTitle"><span class="ux-textspans ux-textspans--BOLD">Dell NVIDIA Quadro P4000 8GB GDDR5 Graphics Card</span></h1>
<div class="x-price-primary"><span class="ux-textspans">US $189.99</span></div>
<div class="x-item-condition-value"><span class="ux-textspans">Seller refurbished</span></div>
<div class="ux-layout-section__row">
  <dl class="ux-labels-values ux-labels-values--brand">
    <dt class="ux-labels-values__labels"><div class="ux-labels-values__labels-content"><div><span class="ux-textspans">Brand</span></div></div></dt>
    <dd class="ux-labels-values__values"><div class="ux-labels-values__values-content"><div><span class="ux-textspans">Dell</span></div></div></dd>
  </dl>
  <dl class="ux-labels-values ux-labels-values--chipset">
    <dt class="ux-labels-values__labels"><div><span class="ux-textspans">Chipset/GPU Model</span></div></dt>
    <dd class="ux-labels-values__values"><div><span class="ux-textspans">NVIDIA Quadro P4000</span></div></dd>
  </dl>
  <dl class="ux-labels-values ux-labels-values--memory">
    <dt class="ux-labels-values__labels"><div><span class="ux-textspans">Memory Size</span></div></dt>
    <dd class="ux-labels-values__values"><div><span class="ux-textspans">8 GB</span></div></dd>
  </dl>
  <dl class="ux-labels-values ux-labels-values--memtype">
    <dt class="ux-labels-values__labels"><div><span class="ux-textspans">Memory Type</span></div></dt>
    <dd class="ux-labels-values__values"><div><span class="ux-textspans">GDDR5</span></div></dd>
  </dl>
  <dl class="ux-labels-values ux-labels-values--mpn">
    <dt class="ux-labels-values__labels"><div><span class="ux-textspans">MPN</span></div></dt>
    <dd class="ux-labels-values__values"><div><span class="ux-textspans">P4000</span></div></dd>
  </dl>
</div>
</body></html>`;

test('parses a modern eBay page with no JSON-LD (title, price, condition, specs)', () => {
  const it = parseListingHtml(MODERN_GPU, '406771571576', 'https://www.ebay.com/itm/406771571576');
  assert.equal(it.title, 'Dell NVIDIA Quadro P4000 8GB GDDR5 Graphics Card');
  assert.equal(it.listing_price, 189.99);          // was null before — rendered price
  assert.equal(it.condition, 'refurbished');        // "Seller refurbished"
  assert.equal(it.brand, 'Dell');                   // from <dl> item specifics
  assert.equal(it.specs.gpu, 'NVIDIA Quadro P4000');
  assert.equal(it.specs.ram, '8 GB');
  assert.equal(it.specs.memoryType, 'GDDR5');
  assert.equal(it.category, 'component');           // GPU listing, not "other"
  assert.equal(it.image, 'https://i.ebayimg.com/images/g/abcAAOSw/s-l1600.jpg');
});

test('title falls back through h1 -> og:title -> <title> minus the eBay suffix', () => {
  const h1Only = '<h1 class="x-item-title__mainTitle"><span>Only H1 Title</span></h1>';
  assert.equal(parseListingHtml(h1Only, '1', null).title, 'Only H1 Title');

  const titleOnly = '<html><head><title>Some Laptop 16GB | eBay</title></head><body></body></html>';
  assert.equal(parseListingHtml(titleOnly, '1', null).title, 'Some Laptop 16GB');
});

test('price is read from microdata and embedded state when not rendered', () => {
  const micro = '<h1 class="x-item-title__mainTitle">X</h1><meta itemprop="price" content="1499.00">';
  assert.equal(parseListingHtml(micro, '1', null).listing_price, 1499);

  const embedded = '<h1 class="x-item-title__mainTitle">X</h1><script>var s={"price":{"value":"249.50","currency":"USD"}}</script>';
  assert.equal(parseListingHtml(embedded, '1', null).listing_price, 249.5);
});

test('parseMoney handles currency prefixes, thousands and European decimals', () => {
  assert.equal(parseMoney('US $1,499.00'), 1499);
  assert.equal(parseMoney('$189.99'), 189.99);
  assert.equal(parseMoney('EUR 99,50'), 99.5);
  assert.equal(parseMoney('1.234,56'), 1234.56);
  assert.equal(parseMoney('12'), 12);
  assert.equal(parseMoney('no digits here'), null);
  assert.equal(parseMoney(null), null);
});

test('HTML entities in specifics and titles are decoded', () => {
  const html = `<h1 class="x-item-title__mainTitle">Dell 24&quot; Monitor &amp; Stand</h1>
    <dl class="ux-labels-values"><dt class="ux-labels-values__labels"><span>Screen Size</span></dt>
    <dd class="ux-labels-values__values"><span>23.8&quot;</span></dd></dl>`;
  const it = parseListingHtml(html, '1', null);
  assert.equal(it.title, 'Dell 24" Monitor & Stand');
  assert.equal(it.specs.screen, '23.8"');
});

test('legacy table-layout item specifics are still read', () => {
  const html = `<h1 id="itemTitle">Legacy Laptop</h1>
    <table><tr><td class="attrLabels">Processor</td><td>Intel Core i7-8650U</td></tr>
    <tr><td class="attrLabels">RAM Size</td><td>16 GB</td></tr></table>`;
  const it = parseListingHtml(html, '1', null);
  assert.equal(it.specs.cpu, 'Intel Core i7-8650U');
  assert.equal(it.specs.ram, '16 GB');
});

test('bot-check interstitial is detected as a block, not a listing', () => {
  assert.equal(isChallengePage('<html><head><title>Pardon Our Interruption</title></head></html>'), true);
  assert.equal(isChallengePage('<html><body>Checking your browser before accessing</body></html>'), true);
  assert.equal(isChallengePage(MODERN_GPU), false);
});

test('condition maps eBay wording correctly', () => {
  const withCond = (text) => parseListingHtml(
    `<h1 class="x-item-title__mainTitle">X</h1><div class="x-item-condition-value"><span>${text}</span></div>`, '1', null).condition;
  assert.equal(withCond('New'), 'new');
  assert.equal(withCond('Open box'), 'used');
  assert.equal(withCond('New (other)'), 'used');
  assert.equal(withCond('Seller refurbished'), 'refurbished');
  assert.equal(withCond('For parts or not working'), 'for-parts');
  assert.equal(withCond('Used'), 'used');
});
