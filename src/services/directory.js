// Tech Garage community directory: node registration and item sharing.
//
// This is the one feature in the app that sends your data to somebody else's
// server, so it is built to a stricter standard than the rest:
//
//   1. Nothing leaves without an explicit opt-in — the directory is off until
//      switched on, and each item is shared individually.
//   2. What leaves is a WHITELIST, built here, in one place. The storefront
//      already proved the value of that discipline; the stakes are higher when
//      the payload crosses a network boundary you don't control.
//   3. Region is COARSE by design. "Which town" is enough to find a nearby
//      seller; a street address is not something a shop should broadcast.
//   4. Every request is signed with the node's own Ed25519 key, so a directory
//      can tell nodes apart and nobody can post as your shop.
//   5. Anything coming BACK is untrusted. Remote listings are other people's
//      text and must be treated as hostile input.
//
// Pure functions: payload building and signature verification take their config
// as arguments, so the rules are testable without a network or a database.
import crypto from 'node:crypto';

// ---------------------------------------------------------------------------
// Node identity
// ---------------------------------------------------------------------------

/** A node's long-lived identity. The public half is its name in the directory. */
export function generateNodeKeypair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return {
    publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    privateKey: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'),
  };
}

/** Short, human-comparable form of a node id — for logs and admin screens. */
export const shortNodeId = (pub) => (pub ? String(pub).replace(/[^A-Za-z0-9]/g, '').slice(-12).toUpperCase() : '');

/**
 * Sign a request body.
 *
 * The timestamp is inside the signed payload, not merely alongside it, so a
 * captured request cannot be replayed later with a fresh timestamp bolted on.
 */
export function signPayload(privateKeyB64, body, { now = Date.now() } = {}) {
  const key = crypto.createPrivateKey({ key: Buffer.from(privateKeyB64, 'base64'), format: 'der', type: 'pkcs8' });
  const envelope = { ...body, ts: new Date(now).toISOString() };
  const message = JSON.stringify(envelope);
  return { envelope, message, signature: crypto.sign(null, Buffer.from(message, 'utf8'), key).toString('base64') };
}

/**
 * Verify a signed request. Never throws — a malformed payload is just invalid.
 * `toleranceSec` bounds replay the same way the Stripe webhook check does.
 */
export function verifyPayload(publicKeyB64, message, signatureB64, { now = Date.now(), toleranceSec = 300 } = {}) {
  const bad = (reason) => ({ ok: false, reason });
  if (!publicKeyB64) return bad('no node public key');
  try {
    const key = crypto.createPublicKey({ key: Buffer.from(publicKeyB64, 'base64'), format: 'der', type: 'spki' });
    if (!crypto.verify(null, Buffer.from(message, 'utf8'), key, Buffer.from(signatureB64, 'base64'))) {
      return bad('signature mismatch');
    }
    const body = JSON.parse(message);
    const ts = Date.parse(body.ts);
    if (!Number.isFinite(ts)) return bad('missing timestamp');
    if (Math.abs(now - ts) > toleranceSec * 1000) return bad('timestamp outside tolerance (possible replay)');
    return { ok: true, body };
  } catch {
    return bad('malformed payload');
  }
}

// ---------------------------------------------------------------------------
// Region
// ---------------------------------------------------------------------------

/**
 * Coarse location. Deliberately no street, no postcode beyond a prefix, and no
 * coordinates: the question a directory needs to answer is "roughly near me?",
 * which does not require knowing where the seller's garage is.
 *
 * Never inferred from an IP address. A shop states its own region or shares
 * nothing — guessing someone's location and then broadcasting the guess is not
 * a decision this app gets to make for them.
 */
export function normalizeRegion(region = {}) {
  const clean = (v, n) => String(v ?? '').trim().slice(0, n);
  // Validated, NOT truncated. Chopping a 3-letter code down to two silently
  // relocates the shop — "AND" (Andorra) would become "AN", and the owner
  // would never see that their listings were filed under the wrong country.
  // An invalid code is dropped so the admin is told to fix it instead.
  const country = String(region.country ?? '').trim().toUpperCase();
  const out = {
    country: /^[A-Z]{2}$/.test(country) ? country : '',
    state: clean(region.state, 40),
    area: clean(region.area, 60),      // town / city / borough
    // A postcode prefix ("SW1", "112") is a district, not a doorstep.
    postalPrefix: clean(region.postalPrefix, 4).toUpperCase(),
  };
  return out;
}

/** A region is usable for matching only once it says at least which country. */
export const regionUsable = (region) => Boolean(normalizeRegion(region).country);

/** How closely two regions match: 3 = same area, 2 = same state, 1 = same country. */
export function regionDistance(a, b) {
  const x = normalizeRegion(a), y = normalizeRegion(b);
  if (!x.country || !y.country || x.country !== y.country) return 0;
  if (x.state && y.state && x.state.toLowerCase() === y.state.toLowerCase()) {
    if (x.area && y.area && x.area.toLowerCase() === y.area.toLowerCase()) return 3;
    return 2;
  }
  return 1;
}

// ---------------------------------------------------------------------------
// What actually leaves the building
// ---------------------------------------------------------------------------

/**
 * The node's own registration record.
 *
 * `contact` is optional and free-text on purpose — a shop that wants to publish
 * an email can, and one that doesn't, doesn't. Nothing here is derived from
 * anything the admin didn't type.
 */
export function buildNodeRecord({ node, site, brand, region, categories = [], itemCount = 0, contact = '' }) {
  return {
    node,
    name: String(brand?.name || 'Tech Garage').slice(0, 80),
    tagline: String(brand?.tagline || '').slice(0, 160),
    url: String(site?.url || '').slice(0, 300),
    region: normalizeRegion(region),
    // Categories tell the directory what this shop deals in, so a request for
    // "who near me sells SSDs" doesn't have to fan out over every listing.
    categories: [...new Set(categories.map((c) => String(c).toLowerCase().slice(0, 30)))].slice(0, 20),
    itemCount: Math.max(0, Math.floor(Number(itemCount) || 0)),
    contact: String(contact || '').slice(0, 200),
  };
}

/**
 * The shared form of a single listing.
 *
 * Everything a stranger needs to decide whether to click through, and nothing
 * else. Explicitly absent: acquisition cost, refurb costs, fees, margins,
 * break-even, serial number, storage location, supplier notes, internal notes,
 * and anything at all about customers.
 *
 * Returns null when the item is not shareable, so a caller cannot accidentally
 * publish a draft or a sold unit by forgetting to check.
 */
export function buildListingRecord(item, { node, origin, region }) {
  if (!item || !item.shareCommunity) return null;
  if (item.hidden) return null;
  if (!['in_stock', 'listed'].includes(item.status)) return null;
  if (item.listing_price == null) return null;
  if (!origin) return null;

  const s = (v, n) => (v == null ? null : String(v).slice(0, n));
  return {
    node,
    // Stable across edits so the directory updates rather than duplicating.
    ref: `${node.slice(-16)}:${item.id}`,
    title: s(item.title, 140),
    category: s(item.category, 30),
    condition: s(item.condition, 30),
    brand: s(item.brand, 40),
    model: s(item.model, 60),
    price: Number(item.listing_price),
    currency: 'USD',
    quantity: Math.max(1, Math.floor(Number(item.quantity) || 1)),
    // Absolute links back to the seller's own shop — the directory never hosts
    // the image or the listing, it only points at them.
    url: `${origin}/shop#item-${item.id}`,
    image: item.image ? `${origin}/api/public/media/${item.image}` : null,
    region: normalizeRegion(region),
  };
}

// A shared listing is a stranger's text arriving over the network. It gets
// clamped to the shape we expect before anything renders it, and the UI escapes
// it on top of that.
const HTTP_URL = /^https?:\/\/[^\s<>"']+$/i;

export function sanitizeRemoteListing(row) {
  if (!row || typeof row !== 'object') return null;
  const s = (v, n) => (typeof v === 'string' ? v.slice(0, n) : null);
  const url = s(row.url, 300);
  const image = s(row.image, 300);
  const price = Number(row.price);
  if (!s(row.title, 140) || !url || !HTTP_URL.test(url)) return null;
  if (!Number.isFinite(price) || price < 0) return null;
  return {
    ref: s(row.ref, 80),
    node: s(row.node, 200),
    shopName: s(row.shopName || row.name, 80) || 'Another Tech Garage',
    title: s(row.title, 140),
    category: s(row.category, 30),
    condition: s(row.condition, 30),
    brand: s(row.brand, 40),
    price: Math.round(price * 100) / 100,
    currency: /^[A-Z]{3}$/.test(String(row.currency)) ? row.currency : 'USD',
    url,
    // A javascript: or data: image URL would be an injection; only http(s).
    image: image && HTTP_URL.test(image) ? image : null,
    region: normalizeRegion(row.region),
    distance: Number.isFinite(Number(row.distance)) ? Number(row.distance) : null,
  };
}

/**
 * Rank remote listings for the "do you need this?" strip.
 *
 * Nearer first, then complementary categories, then price. Listings from a
 * node the shop explicitly trusts (a friend's shop, added by invite) always
 * outrank strangers — that is the whole point of having a trusted list.
 */
export function rankRemoteListings(rows, { myRegion, myCategories = [], trustedNodes = [], limit = 4 } = {}) {
  const trusted = new Set(trustedNodes);
  const mine = new Set(myCategories.map((c) => String(c).toLowerCase()));
  return (rows || [])
    .map(sanitizeRemoteListing)
    .filter(Boolean)
    // Never advertise something the shop already sells — sending a customer to
    // a competitor for an item on your own shelf is the opposite of useful.
    .filter((r) => !mine.has(String(r.category || '').toLowerCase()))
    .map((r) => ({
      ...r,
      _score: (trusted.has(r.node) ? 100 : 0) + regionDistance(myRegion, r.region) * 10,
    }))
    .sort((a, b) => b._score - a._score || a.price - b.price)
    .slice(0, limit)
    .map(({ _score, ...r }) => r);
}
