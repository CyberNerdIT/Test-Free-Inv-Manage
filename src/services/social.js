// Shop-to-shop connections: friends, and the shops they recommend.
//
// The community directory answers "who else exists near me". This is the layer
// on top of it: shops you deliberately connect to, whether they connected back,
// and — the part that makes it a network rather than a list — the shops your
// friends vouch for.
//
// Two principles run through it:
//
//   * An invite is a code you can send, not a 44-character key someone has to
//     retype. If connecting is fiddly, nobody connects.
//   * Who you do business with is your information. Publishing your friend list
//     is opt-in, and a shop that keeps it private still participates fully —
//     it just doesn't contribute suggestions.
import { normalizeRegion, regionDistance } from './directory.js';

const b64u = (s) => Buffer.from(s, 'utf8').toString('base64url');
const unb64u = (s) => Buffer.from(String(s), 'base64url').toString('utf8');

/**
 * Pack a shop into a short, pasteable invite code.
 *
 * Carries the node id, URL and name — enough for the recipient to add the shop
 * and immediately fetch its profile. Deliberately NOT signed: everything in it
 * is public anyway, and the recipient verifies it by fetching the URL and
 * checking the node id matches. A signature would imply an authenticity this
 * code cannot have, since anyone can copy one.
 */
export function buildInvite({ node, url, name }) {
  if (!node || !url) return null;
  return `TG1.${b64u(JSON.stringify({ n: node, u: String(url).replace(/\/+$/, ''), m: String(name || '').slice(0, 80) }))}`;
}

/** Unpack an invite code. Never throws — a mistyped code is just invalid. */
export function parseInvite(code) {
  const raw = String(code || '').trim();
  const body = raw.startsWith('TG1.') ? raw.slice(4) : raw;
  try {
    const p = JSON.parse(unb64u(body));
    if (!p?.n || !p?.u) return null;
    if (!/^https?:\/\/[^\s<>"']+$/i.test(p.u)) return null;
    if (!/^[A-Za-z0-9+/]{40,120}={0,2}$/.test(p.n)) return null;
    return { node: p.n, url: String(p.u).replace(/\/+$/, ''), name: String(p.m || '').slice(0, 80) };
  } catch {
    return null;
  }
}

/**
 * A shop's public profile, as other shops see it.
 *
 * `recommends` is only populated when the shop chose to publish its
 * connections; otherwise the field is absent entirely rather than empty, so a
 * reader can tell "keeps it private" apart from "has no friends".
 */
export function buildProfile({ node, brand, url, region, categories = [], itemCount = 0, contact = '', recommends = null }) {
  const profile = {
    node,
    name: String(brand?.name || 'Tech Garage').slice(0, 80),
    tagline: String(brand?.tagline || '').slice(0, 160),
    url: String(url || '').replace(/\/+$/, ''),
    region: normalizeRegion(region),
    categories: [...new Set(categories.map((c) => String(c).toLowerCase()))].slice(0, 20),
    itemCount: Math.max(0, Math.floor(Number(itemCount) || 0)),
    contact: String(contact || '').slice(0, 200),
  };
  if (Array.isArray(recommends)) {
    // Only the pointer, never a judgement: a recommendation says "I connected
    // to this shop", not "here is what I think of them".
    profile.recommends = recommends
      .filter((p) => p.node && p.url)
      .slice(0, 50)
      .map((p) => ({ node: p.node, name: String(p.name || '').slice(0, 80), url: String(p.url).replace(/\/+$/, '') }));
  }
  return profile;
}

/** Another shop's profile is remote input; clamp it before it is used or shown. */
export function sanitizeProfile(raw, { expectNode } = {}) {
  if (!raw || typeof raw !== 'object') return null;
  // A profile claiming a different node than the one we asked is either
  // misconfigured or impersonating; either way it is not usable.
  if (expectNode && raw.node !== expectNode) return null;
  const s = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '');
  const url = s(raw.url, 300);
  if (!/^https?:\/\/[^\s<>"']+$/i.test(url)) return null;

  const out = {
    node: s(raw.node, 200),
    name: s(raw.name, 80) || 'Another Tech Garage',
    tagline: s(raw.tagline, 160),
    url: url.replace(/\/+$/, ''),
    region: normalizeRegion(raw.region),
    categories: Array.isArray(raw.categories) ? raw.categories.map((c) => s(c, 30)).filter(Boolean).slice(0, 20) : [],
    itemCount: Number.isFinite(Number(raw.itemCount)) ? Math.max(0, Math.floor(raw.itemCount)) : 0,
  };
  if (Array.isArray(raw.recommends)) {
    out.recommends = raw.recommends
      .slice(0, 50)
      .map((p) => ({ node: s(p?.node, 200), name: s(p?.name, 80), url: s(p?.url, 300) }))
      .filter((p) => p.node && /^https?:\/\/[^\s<>"']+$/i.test(p.url));
  }
  return out;
}

/**
 * Is a connection mutual?
 *
 * Worth distinguishing: adding a shop is a one-way act, and a storefront saying
 * "shops we work with" reads very differently when the feeling is returned.
 * A shop that keeps its connections private is reported as `unknown` rather
 * than `following`, because we genuinely cannot tell.
 */
export function connectionState(myNode, theirProfile) {
  if (!theirProfile) return 'unreachable';
  if (!Array.isArray(theirProfile.recommends)) return 'unknown';
  return theirProfile.recommends.some((p) => p.node === myNode) ? 'mutual' : 'following';
}

/**
 * Shops your friends recommend that you haven't connected to.
 *
 * The friend-of-friend hop is the whole point: a shop you trust vouching for
 * another is a far better signal than proximity alone. Suggestions are ranked
 * by how many of your friends recommend them, then by how near they are.
 */
export function suggestConnections({
  myNode, myRegion, profiles = [], knownNodes = [], blockedNodes = [], limit = 8,
} = {}) {
  const known = new Set([myNode, ...knownNodes]);
  const blocked = new Set(blockedNodes);
  const byNode = new Map();

  for (const p of profiles) {
    if (!p || !Array.isArray(p.recommends)) continue;
    for (const rec of p.recommends) {
      if (!rec.node || known.has(rec.node) || blocked.has(rec.node)) continue;
      const entry = byNode.get(rec.node) || {
        node: rec.node,
        name: rec.name || 'Another Tech Garage',
        url: rec.url,
        vouchedBy: [],
      };
      // De-duplicated: two friends recommending the same shop is a stronger
      // signal, but only if they are actually two different friends.
      if (!entry.vouchedBy.some((v) => v.node === p.node)) {
        entry.vouchedBy.push({ node: p.node, name: p.name });
      }
      byNode.set(rec.node, entry);
    }
  }

  return [...byNode.values()]
    .map((e) => ({ ...e, vouches: e.vouchedBy.length }))
    .sort((a, b) => b.vouches - a.vouches || a.name.localeCompare(b.name))
    .slice(0, limit);
}

/**
 * Friends to show on the storefront, as shops rather than as items.
 *
 * Mutual connections lead — a shop that has connected back is a relationship,
 * not just a bookmark — then nearer shops.
 */
export function storefrontFriends(peers, { myRegion, limit = 6 } = {}) {
  return (peers || [])
    .filter((p) => p.trusted && !p.blocked && p.url && p.name)
    .map((p) => ({
      node: p.node,
      name: p.name,
      tagline: p.tagline || '',
      url: p.url,
      region: p.region || {},
      mutual: p.mutual === true || p.mutual === 1,
      distance: regionDistance(myRegion, p.region),
    }))
    .sort((a, b) => (b.mutual ? 1 : 0) - (a.mutual ? 1 : 0) || b.distance - a.distance || a.name.localeCompare(b.name))
    .slice(0, limit);
}
