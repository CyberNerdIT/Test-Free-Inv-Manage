import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// The claim this repository makes about itself, enforced instead of intended.
//
// The claim is: the premium features are ABSENT here, not disabled. That is
// worth a test because the intention failed once already. "Keep the pure,
// unit-tested helpers in core — describing what a message would look like is
// not the paid part" sounded reasonable and left the entire WhatsApp Graph API
// payload format, the whole Meta error-code table, and every overridable theme
// colour sitting in the public repository, with only a fetch() missing. A
// principle that gets re-argued on each commit is not a boundary; a failing
// test is.
//
// The patterns below therefore appear in this repo, and that is fine: they are
// public API vocabulary (a hostname, a header name, an error number, a field
// name), all documented by eBay, Amazon and Meta. Knowing that WhatsApp calls a
// field `messaging_product` is not the paid part; having the working
// integration is. Obfuscating them would cost readability and buy nothing.

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(js|mjs|html|css)$/.test(name)) out.push(p);
  }
  return out;
}

// Each entry: a thing only a paid feature has any business knowing, and why.
// Matched against everything that ships here — src/ and public/.
const FORBIDDEN = [
  // WhatsApp Business Cloud
  [/graph\.facebook\.com/, 'the WhatsApp Graph API host'],
  [/messaging_product/, 'the WhatsApp message payload format'],
  [/\b131030\b|\b132001\b|\b131047\b/, 'the WhatsApp error-code table'],
  // Discord / Telegram senders
  [/discord\.com\/api\/webhooks/, 'the Discord webhook endpoint'],
  [/api\.telegram\.org/, 'the Telegram bot API host'],
  // eBay + Amazon marketplace APIs. NOT plain "ebay.com": the free build
  // legitimately fetches public listing PAGES, which is the whole free path.
  [/api\.ebay\.com|api\.sandbox\.ebay\.com/, 'the eBay API host'],
  [/buy\/browse\/v1|item_summary\/search|item_sales\/search/, 'eBay API endpoints'],
  // NOT the PA-API hostname: that is the default value of a credential field,
  // and credential FIELDS stay on purpose so an install that later upgrades has
  // nothing to re-enter. Storing a setting is not implementing a feature. What
  // must not be here is the code that signs and sends a request.
  // Prose naming the API is fine — the admin page has to say what a credential
  // is for. What must not be here is the wire detail: the request path, the
  // X-Amz-Target operation string, or the signing algorithm.
  [/paapi5\/|paapi5\.v1|X-Amz-Target/i, 'the Amazon PA-API request format'],
  [/AWS4-HMAC-SHA256/, 'the AWS SigV4 signing scheme (Amazon PA-API)'],
  // Custom colours — the overridable-key list, the hex validator, the merge.
  [/(?<![.\w])(CUSTOM_KEYS|sanitizeCustom|applyCustom|pickerBase)\s*[=({]/, 'the custom-colour implementation'],
  [/const\s+CUSTOM_KEYS|function\s+(sanitizeCustom|applyCustom|pickerBase)/, 'the custom-colour implementation'],
];

const SCANNED = [...walk('src'), ...walk('public')];

test('the tree scans clean', () => {
  assert.ok(SCANNED.length > 20, `expected to scan the app, found ${SCANNED.length} files`);
  const hits = [];
  for (const file of SCANNED) {
    const body = readFileSync(file, 'utf8');
    for (const [re, what] of FORBIDDEN) {
      const m = body.match(re);
      if (m) {
        const line = body.slice(0, m.index).split('\n').length;
        hits.push(`${file}:${line} contains ${what} (matched ${JSON.stringify(m[0])})`);
      }
    }
  }
  assert.deepEqual(hits, [],
    'paid-feature code has leaked into this repository:\n  ' + hits.join('\n  '));
});

test('there is no pro/ directory and nothing tries to load one', () => {
  // The premium modules used to arrive as a `pro/` directory that a loader in
  // src/ discovered and imported at boot. Both halves of that are gone: no
  // directory, and no code that would go looking for one. A dynamic import of a
  // path built at runtime is exactly the shape that quietly comes back, so it
  // fails here rather than in review.
  assert.equal(existsSync('pro'), false, 'this repository must not contain pro/');

  const bad = [];
  for (const file of walk('src')) {
    const body = readFileSync(file, 'utf8');
    for (const m of body.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
      if (/(^|\/)pro\//.test(m[1])) bad.push(`${file} imports ${m[1]}`);
    }
    if (/(?<![\w.])import\(/.test(body)) bad.push(`${file} uses a dynamic import — the module loader is meant to be gone`);
    if (/PRO_DIR|manifest\.json/.test(body)) bad.push(`${file} still looks for a Pro bundle`);
  }
  assert.deepEqual(bad, []);
});

test('nothing in the app checks a licence, a key or a plan', () => {
  // The design's whole claim is that an install can only be what it is. A key
  // field, an expiry check or a stored plan would each reintroduce something a
  // user can get wrong — or forge.
  const bad = [];
  for (const file of [...walk('src'), ...walk('public')]) {
    const body = readFileSync(file, 'utf8');
    for (const [re, what] of [
      // No space in the pattern on purpose: an identifier or a form field is
      // the thing to catch. Prose saying "nothing here asks you for a licence
      // key" is the claim being made, not a breach of it.
      [/licen[cs]e[_-]?key|activation[_-]?key|serial[_-]?key/i, 'a licence key'],
      [/\bexpiresAt\b|\bsubscriptionStatus\b/, 'a subscription expiry check'],
    ]) {
      if (re.test(body)) bad.push(`${file} contains ${what}`);
    }
  }
  assert.deepEqual(bad, []);
});
