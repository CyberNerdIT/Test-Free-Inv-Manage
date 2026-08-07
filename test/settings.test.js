import { test } from 'node:test';
import assert from 'node:assert/strict';
import { effective, adminView, updateFromAdmin, clearSecret, setRaw, renderTemplate, DEFAULT_RESET_HTML, setLandingDeals, getLandingDeals } from '../src/settings.js';

test('landing deals: default provided, editable and sanitized', () => {
  assert.ok(effective().landing.deals.length >= 1); // defaults until customised
  const saved = setLandingDeals([
    { title: 'Test Laptop', spec: 'i5', was: 1000, now: 400, icon: '💻', image: '5' },
    { title: '' }, // blank title dropped
  ]);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].was, 1000);
  assert.equal(saved[0].image, 5); // coerced to a number id
  assert.equal(effective().landing.deals[0].title, 'Test Laptop');
  assert.equal(adminView().landing.deals[0].now, 400);
});

test('landing deals: an inventory-linked card keeps its itemId even without a title', () => {
  const saved = setLandingDeals([
    { itemId: 42, was: 999, icon: '💻' },          // linked, no title -> kept because of itemId
    { title: 'Manual card', now: 300 },            // manual -> kept because of title
    { spec: 'orphan with neither' },               // dropped (no title, no itemId)
  ]);
  assert.equal(saved.length, 2);
  const linked = getLandingDeals().find((d) => d.itemId === 42);
  assert.ok(linked, 'linked deal is persisted');
  assert.equal(linked.was, 999);
  assert.equal(linked.itemId, 42);
});

test('renderTemplate substitutes {{name}} {{username}} {{link}}', () => {
  const out = renderTemplate('Hi {{name}} ({{username}}): {{link}}', { name: 'Al', username: 'al', link: 'https://x/r/t' });
  assert.equal(out, 'Hi Al (al): https://x/r/t');
  // unknown placeholders become empty
  assert.equal(renderTemplate('a {{nope}} b', {}), 'a  b');
  // the default reset template carries the reset link placeholder
  assert.match(DEFAULT_RESET_HTML, /\{\{\s*link\s*\}\}/);
});

test('reset email subject/html are editable and shown in adminView', () => {
  updateFromAdmin({ resetEmailSubject: 'Reset {{username}}', resetEmailHtml: '<p>{{link}}</p>' });
  const v = adminView();
  assert.equal(v.resetEmail.subject, 'Reset {{username}}');
  assert.equal(v.resetEmail.html, '<p>{{link}}</p>');
});

test('welcome email template is editable, defaults to Tech Garage brand, and shows in adminView', () => {
  const v0 = adminView();
  assert.equal(v0.brand.name, 'Tech Garage'); // renamed default
  assert.match(v0.welcomeEmail.html, /\{\{\s*link\s*\}\}/); // carries the invite link placeholder
  updateFromAdmin({ welcomeEmailSubject: 'Welcome {{name}}', welcomeEmailHtml: '<p>{{link}}</p>' });
  const v = adminView();
  assert.equal(v.welcomeEmail.subject, 'Welcome {{name}}');
  assert.equal(v.welcomeEmail.html, '<p>{{link}}</p>');
});

test('the host-your-own link is not a setting any more', () => {
  // It is always on in this build, so there is nothing to store and nothing an
  // admin can switch off. A stale `host_promo` row from an older install must
  // not resurrect a toggle that no longer exists.
  setRaw('host_promo', 'false');
  const v = adminView();
  assert.equal('hostPromo' in v.brand, false);
  assert.deepEqual(Object.keys(v.brand).sort(), ['name', 'tagline']);
});

test('whatsapp defaults to template mode with the hello_world template', () => {
  const v = adminView();
  assert.equal(v.whatsapp.msgType, 'template'); // template is the safe default
  assert.equal(v.whatsapp.template, 'hello_world');
  assert.equal(v.whatsapp.lang, 'en_US');
  assert.equal(v.whatsapp.bodyParam, false);
  assert.equal(v.whatsapp.updatesOn, false);
});

test('whatsapp template/updates settings round-trip through updateFromAdmin', () => {
  updateFromAdmin({
    waMsgType: 'text', waTemplate: 'purchase_alert', waLang: 'en', waBodyParam: 'true', waUpdatesOn: 'true',
  });
  const e = effective().notify.whatsapp;
  assert.equal(e.msgType, 'text');
  assert.equal(e.template, 'purchase_alert');
  assert.equal(e.lang, 'en');
  assert.equal(e.bodyParam, true);
  assert.equal(e.updatesOn, true);
  // clearing the checkboxes falls back to the safe defaults
  updateFromAdmin({ waMsgType: 'template', waBodyParam: '', waUpdatesOn: '' });
  const e2 = effective().notify.whatsapp;
  assert.equal(e2.msgType, 'template');
  assert.equal(e2.bodyParam, false);
  assert.equal(e2.updatesOn, false);
});

test('effective() starts from env/defaults with providers disabled', () => {
  const e = effective();
  assert.equal(e.ebay.enabled, false);
  assert.equal(e.amazon.enabled, false);
  assert.equal(typeof e.defaults.feeRate, 'number');
});

test('updateFromAdmin stores values and enables provider once complete', () => {
  updateFromAdmin({ ebayClientId: 'cid', ebayClientSecret: 'secret', ebayMarketplace: 'EBAY_GB' });
  const e = effective();
  assert.equal(e.ebay.clientId, 'cid');
  assert.equal(e.ebay.clientSecret, 'secret');
  assert.equal(e.ebay.marketplace, 'EBAY_GB');
  // `configured` = credentials present. `enabled` also needs an implementation
  // to use them, which this build does not have — hence never true here.
  assert.equal(e.ebay.configured, true);
  assert.equal(e.ebay.enabled, false);
  assert.equal(e.ebay.locked, true, 'saved keys this build cannot use are flagged, not silently ignored');
});

test('adminView never exposes secret values, only whether they are set', () => {
  updateFromAdmin({ amazonAccessKey: 'AK', amazonSecretKey: 'SK', amazonPartnerTag: 'tag-20' });
  const v = adminView();
  assert.equal(v.amazon.accessKey, 'AK'); // access key/partner tag are shown
  assert.equal(v.amazon.partnerTag, 'tag-20');
  assert.equal(v.amazon.secretKeySet, true); // secret is masked to a boolean
  assert.equal('secretKey' in v.amazon, false);
  assert.equal('clientSecret' in v.ebay, false);
});

test('blank secret in updateFromAdmin keeps the existing secret', () => {
  updateFromAdmin({ ebayClientId: 'cid', ebayClientSecret: 'keepme' });
  updateFromAdmin({ ebayClientId: 'cid2', ebayClientSecret: '' }); // blank -> keep
  const e = effective();
  assert.equal(e.ebay.clientId, 'cid2');
  assert.equal(e.ebay.clientSecret, 'keepme');
});

test('numeric defaults are coerced and percentages stored as fractions', () => {
  updateFromAdmin({ defaultFeeRate: 0.1, defaultTargetMargin: 0.4 });
  const e = effective();
  assert.equal(e.defaults.feeRate, 0.1);
  assert.equal(e.defaults.targetMargin, 0.4);
});

test('clearSecret removes a stored secret', () => {
  updateFromAdmin({ ebayClientId: 'c', ebayClientSecret: 's' });
  assert.equal(effective().ebay.configured, true);
  clearSecret('ebay');
  assert.equal(effective().ebay.clientSecret, '');
  assert.equal(effective().ebay.configured, false);
  assert.equal(effective().ebay.enabled, false);
});

test('setRaw with empty value deletes the key (falls back to env/default)', () => {
  setRaw('default_fee_rate', '0.2');
  assert.equal(effective().defaults.feeRate, 0.2);
  setRaw('default_fee_rate', '');
  assert.equal(effective().defaults.feeRate, 0.132); // back to env default
});
