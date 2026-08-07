// The repository as the directory.
//
// Instead of everyone depending on one hosted directory server, the shop list
// lives in this repo as `directory/nodes.json`, and each shop serves its own
// listings from its own server. That splits the problem the right way:
//
//   * The SHOP LIST is small and changes rarely — perfect for a git file.
//     Free to host, publicly auditable, and every change is a reviewable diff
//     with a name attached. Spam control is a human merging a pull request,
//     which beats any heuristic.
//   * LISTINGS are volatile — prices change, things sell. Committing those to
//     git would mean a commit per sale, so they stay on each shop and are
//     fetched directly. Nobody's inventory sits on anyone else's server.
//
// The trade-offs are real and worth stating: joining takes a PR review rather
// than seconds, showing nearby stock means talking to several shops instead of
// one, and a registry entry is public and permanent in git history. Those are
// documented in directory/README.md so nobody is surprised.
import { normalizeRegion, regionDistance, sanitizeRemoteListing } from './directory.js';

/** Where the shop list lives. Overridable so forks and tests can point elsewhere. */
export const DEFAULT_REGISTRY_URL =
  'https://raw.githubusercontent.com/CyberNerdIT/Test-Free-Inv-Manage/main/directory/nodes.json';

const HTTPS_URL = /^https?:\/\/[^\s<>"']+$/i;

/**
 * Validate one registry entry.
 *
 * Used in three places, deliberately: by CI when a pull request adds a shop, by
 * every node when it reads the registry, and by the admin page before offering
 * to submit. A file in a public repo is still untrusted input — a merged typo
 * must not break every shop that reads it.
 */
export function validateEntry(entry, { index = 0 } = {}) {
  const errors = [];
  const at = (msg) => errors.push(`entry ${index}: ${msg}`);

  if (!entry || typeof entry !== 'object') return { ok: false, errors: [`entry ${index}: not an object`] };

  const node = String(entry.node || '').trim();
  // An Ed25519 SPKI key is 44 base64 characters; anything else is not a node id.
  if (!/^[A-Za-z0-9+/]{40,120}={0,2}$/.test(node)) at('node must be a base64 Ed25519 public key');

  const name = String(entry.name || '').trim();
  if (!name) at('name is required');
  if (name.length > 80) at('name is too long (80 max)');

  const url = String(entry.url || '').trim();
  if (!HTTPS_URL.test(url)) at('url must be an http(s) URL');
  // A registry that carries credentials in a URL is a registry that leaks them.
  if (/[?#]/.test(url)) at('url must not contain a query string or fragment');

  const region = normalizeRegion(entry.region);
  if (!region.country) at('region.country must be a 2-letter ISO code');

  if (entry.categories && !Array.isArray(entry.categories)) at('categories must be an array');
  if (entry.tagline && String(entry.tagline).length > 160) at('tagline is too long (160 max)');
  if (entry.contact && String(entry.contact).length > 200) at('contact is too long (200 max)');

  return { ok: errors.length === 0, errors };
}

/** Coerce a validated entry into the shape the app uses. */
export function normalizeEntry(entry) {
  return {
    node: String(entry.node).trim(),
    name: String(entry.name).trim().slice(0, 80),
    tagline: String(entry.tagline || '').slice(0, 160),
    url: String(entry.url).trim().replace(/\/+$/, ''),
    region: normalizeRegion(entry.region),
    categories: Array.isArray(entry.categories)
      ? [...new Set(entry.categories.map((c) => String(c).toLowerCase().slice(0, 30)))].slice(0, 20)
      : [],
    contact: String(entry.contact || '').slice(0, 200),
    added: String(entry.added || '').slice(0, 10),
  };
}

/**
 * Validate a whole registry file.
 *
 * Duplicate node ids and duplicate URLs are errors, not warnings: two entries
 * claiming the same shop is how an impersonation attempt would look.
 */
export function validateRegistry(doc) {
  const errors = [];
  if (!doc || typeof doc !== 'object') return { ok: false, errors: ['registry is not an object'], entries: [] };
  if (!Array.isArray(doc.nodes)) return { ok: false, errors: ['registry.nodes must be an array'], entries: [] };

  const seenNodes = new Set();
  const seenUrls = new Set();
  const entries = [];

  doc.nodes.forEach((raw, index) => {
    const v = validateEntry(raw, { index });
    if (!v.ok) { errors.push(...v.errors); return; }
    const e = normalizeEntry(raw);
    if (seenNodes.has(e.node)) errors.push(`entry ${index}: duplicate node id`);
    if (seenUrls.has(e.url)) errors.push(`entry ${index}: duplicate url (${e.url})`);
    seenNodes.add(e.node);
    seenUrls.add(e.url);
    entries.push(e);
  });

  return { ok: errors.length === 0, errors, entries };
}

/**
 * Which shops are worth asking for listings.
 *
 * The registry could eventually hold thousands of shops, and a storefront
 * cannot fan out to all of them. Region filters first (that is the whole point
 * of a *nearby* strip), then a hard cap — better to show four listings from six
 * close shops than to hang waiting on sixty.
 */
export function selectPeers(entries, { myNode, myRegion, trustedNodes = [], blockedNodes = [], limit = 8 } = {}) {
  const trusted = new Set(trustedNodes);
  const blocked = new Set(blockedNodes);
  return (entries || [])
    .filter((e) => e.node !== myNode && !blocked.has(e.node))
    .map((e) => ({ ...e, distance: regionDistance(myRegion, e.region) }))
    // Distance 0 means a different country — not "nearby" by any reading.
    .filter((e) => e.distance > 0 || trusted.has(e.node))
    .sort((a, b) =>
      (trusted.has(b.node) ? 1 : 0) - (trusted.has(a.node) ? 1 : 0)
      || b.distance - a.distance
      || a.name.localeCompare(b.name))
    .slice(0, limit);
}

/**
 * Fetch one shop's public listings.
 *
 * Everything is sanitized here rather than at the caller: this is a response
 * from somebody else's server, and the shop name is taken from the REGISTRY
 * entry, not from the response — otherwise a shop could label itself anything
 * it liked in a neighbour's storefront.
 */
export async function fetchPeerListings(peer, { timeoutMs = 6000, limit = 12 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${peer.url}/api/directory/listings`, {
      signal: ctrl.signal,
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) return [];
    const json = await res.json();
    // A node claiming a different id than the registry says is either
    // misconfigured or impersonating; either way its listings are not shown.
    if (json?.node && json.node !== peer.node) return [];
    return (json?.listings || [])
      .slice(0, limit)
      .map((row) => sanitizeRemoteListing({
        ...row,
        node: peer.node,
        shopName: peer.name,
        region: peer.region,
        distance: peer.distance,
      }))
      .filter(Boolean);
  } catch {
    // A shop being down, slow or misconfigured is normal and not an error
    // worth surfacing — the strip just has fewer entries.
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/** Fetch several peers at once, bounded so a slow shop can't stall the rest. */
export async function fetchAllPeerListings(peers, opts = {}) {
  const results = await Promise.all(peers.map((p) => fetchPeerListings(p, opts)));
  return results.flat();
}

/**
 * Download and validate the registry.
 * Invalid entries are dropped individually — one bad merge should degrade the
 * list, not empty it.
 */
export async function fetchRegistry(url = DEFAULT_REGISTRY_URL, { timeoutMs = 8000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`registry responded ${res.status}`);
    const doc = await res.json();
    const { entries, errors } = validateRegistry(doc);
    return { entries, errors, updated: doc?.updated || null, count: entries.length };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The block a shop owner pastes into a pull request.
 *
 * Emitted pre-formatted and pre-validated so a submission is a copy-paste
 * rather than a schema-guessing exercise, and so obviously broken entries never
 * reach a reviewer.
 */
export function buildRegistryEntry({ node, brand, url, region, categories = [], contact = '', today = '' }) {
  const entry = normalizeEntry({
    node,
    name: brand?.name || 'Tech Garage',
    tagline: brand?.tagline || '',
    url: String(url || '').replace(/\/+$/, ''),
    region,
    categories,
    contact,
    added: today,
  });
  const check = validateEntry(entry);
  return { entry, json: JSON.stringify(entry, null, 2), ok: check.ok, errors: check.errors };
}
