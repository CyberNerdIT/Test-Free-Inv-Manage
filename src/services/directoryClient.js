// Talking to the community directory.
//
// Every call here is best-effort and non-blocking: the directory is somebody
// else's server, and it going down must never stop this shop from selling. A
// failure is recorded and surfaced in the admin page, not thrown at a user.
import { signPayload, buildNodeRecord, buildListingRecord, sanitizeRemoteListing } from './directory.js';

const TIMEOUT_MS = 8000;

/**
 * POST a signed payload. The signature covers a timestamped envelope, so the
 * directory can authenticate the node and reject replays.
 */
async function post(dir, path, body) {
  if (!dir.url) throw new Error('no directory URL configured');
  if (!dir.nodePrivateKey) throw new Error('this node has no signing key yet');

  const { message, signature } = signPayload(dir.nodePrivateKey, body);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(new URL(path, dir.url).href, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-TG-Node': dir.nodePublicKey,
        'X-TG-Signature': signature,
      },
      // The signed message IS the body — re-serialising would change the bytes
      // and break verification, exactly as with a payment webhook.
      body: message,
      signal: ctrl.signal,
    });
    const json = await res.json().catch(() => null);
    if (!res.ok) throw new Error(json?.error || `directory responded ${res.status}`);
    return json || {};
  } finally {
    clearTimeout(timer);
  }
}

async function get(dir, path, params = {}) {
  if (!dir.url) throw new Error('no directory URL configured');
  const url = new URL(path, dir.url);
  for (const [k, v] of Object.entries(params)) if (v != null && v !== '') url.searchParams.set(k, String(v));
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url.href, { signal: ctrl.signal, headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`directory responded ${res.status}`);
    return (await res.json()) || {};
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Announce this shop to the directory.
 *
 * Sent only when the shop genuinely has a public face — a directory entry
 * pointing at a login wall helps nobody, so the caller checks that first.
 */
export async function registerNode(dir, { site, brand, region, categories, itemCount, contact }) {
  const record = buildNodeRecord({
    node: dir.nodePublicKey, site, brand, region, categories, itemCount, contact,
  });
  return post(dir, '/api/nodes/register', record);
}

/** Publish (or update) one listing. Returns null if the item is not shareable. */
export async function publishListing(dir, item, { origin, region }) {
  const record = buildListingRecord(item, { node: dir.nodePublicKey, origin, region });
  if (!record) return null;
  return post(dir, '/api/listings/publish', record);
}

/** Remove a listing — because it sold, was hidden, or sharing was turned off. */
export async function delistListing(dir, ref) {
  if (!ref) return null;
  return post(dir, '/api/listings/delist', { node: dir.nodePublicKey, ref });
}

/**
 * Fetch nearby listings from other shops.
 *
 * Everything returned is sanitized before it reaches a caller: this is
 * arbitrary text from a server we do not control, and it ends up on a customer's
 * screen.
 */
export async function fetchNearby(dir, { region, categories = [], limit = 12 } = {}) {
  const json = await get(dir, '/api/listings/nearby', {
    country: region?.country, state: region?.state, area: region?.area,
    categories: categories.join(','),
    exclude: dir.nodePublicKey,
    limit,
  });
  return (json.listings || []).map(sanitizeRemoteListing).filter(Boolean);
}

/** Look one shop up by node id — used when adding a friend's shop by invite. */
export async function lookupNode(dir, node) {
  const json = await get(dir, '/api/nodes/lookup', { node });
  return json.node || null;
}
