// Zero-dependency HTTP/HTTPS server: JSON REST API + static frontend.
import http from 'node:http';
import https from 'node:https';
import { readFileSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { join, normalize, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { config } from './config.js';
import * as repo from './repo.js';
import { searchComparables } from './services/pricing/index.js';
import { conditionList, normalizeCondition } from './services/pricing/conditions.js';
import * as upgrade from './upgrade.js';
import * as edition from './edition.js';
import { shopperView, offerView, nextOptions, STATUSES } from './services/orders.js';
import { registerNode, publishListing, delistListing, fetchNearby, lookupNode } from './services/directoryClient.js';
import { rankRemoteListings, shortNodeId, buildListingRecord } from './services/directory.js';
import {
  buildInvite, parseInvite, buildProfile, sanitizeProfile,
  connectionState, suggestConnections, storefrontFriends,
} from './services/social.js';
import {
  fetchRegistry, selectPeers, fetchAllPeerListings, buildRegistryEntry, DEFAULT_REGISTRY_URL,
} from './services/registry.js';
import { fetchListing } from './services/ebayListing.js';
import { buildThemeCss, presetList } from './services/theme.js';
import { notifyPurchase, notifyText, notifySubscribers, notifyCustomerRequest, notifyCustomerStatus } from './services/notify.js';
import { sendMail } from './services/smtp.js';
import * as images from './services/images.js';
import { readFile as fsReadFile } from 'node:fs/promises';
import { db } from './db.js';
import * as auth from './auth.js';
import * as settings from './settings.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, '..', 'public');

// Bumped on each front-end/back-end release so /api/health reports what is
// actually running (update.sh checks this to confirm the restart took effect).
let PUBLIC_ORIGIN = '';
const BUILD = '20260805f';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
};

function send(res, status, body, headers = {}) {
  const payload = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': typeof body === 'object' && !Buffer.isBuffer(body) ? 'application/json; charset=utf-8' : headers['Content-Type'] || 'text/plain; charset=utf-8',
    ...headers,
  });
  res.end(payload);
}
const ok = (res, body) => send(res, 200, body);
const created = (res, body) => send(res, 201, body);
const bad = (res, msg) => send(res, 400, { error: msg });
const notFound = (res, msg = 'not found') => send(res, 404, { error: msg });
const unauthorized = (res, msg = 'authentication required') => send(res, 401, { error: msg });
const forbidden = (res, msg = 'admin access required') => send(res, 403, { error: msg });
function redirect(res, location) {
  res.writeHead(302, { Location: location });
  res.end();
}

function currentUser(req) {
  const cookies = auth.parseCookies(req.headers.cookie);
  return auth.getSessionUser(cookies[auth.COOKIE_NAME]);
}
function isSecure(req) {
  return req.headers['x-forwarded-proto'] === 'https' || Boolean(req.socket.encrypted);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 5_000_000) reject(new Error('payload too large'));
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch {
        reject(new Error('invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

// Raw binary body (for image uploads).
function readRawBody(req, limit = images.MAX_IMAGE_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('upload too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return String(fwd).split(',')[0].trim();
  return req.socket.remoteAddress || null;
}

const PAGE_ROUTES = {
  '/': 'landing.html',
  '/host': 'host.html',
  '/login': 'login.html',
  '/setup': 'setup.html',
  '/app': 'app.html',
  '/admin': 'admin.html',
  '/activity': 'activity.html',
  '/shop': 'shop.html',
  // Public: the shareable "add my shop" page a friend follows.
  '/connect': 'connect.html',
};

// Where a logged-in user's "home" is, by role.
const homeFor = (user) => (user && user.role === 'customer' ? '/shop' : '/app');

async function servePage(res, file) {
  try {
    const buf = await readFile(join(PUBLIC_DIR, file));
    // no-cache = the browser must revalidate before reusing. Prevents a stale
    // page/script surviving an update (e.g. new HTML paired with old JS).
    send(res, 200, buf, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-cache' });
  } catch {
    notFound(res);
  }
}

async function serveStatic(req, res, pathname) {
  // Public invite-acceptance page: /invite/<token>
  if (pathname === '/invite' || pathname.startsWith('/invite/')) {
    return servePage(res, 'invite.html');
  }
  // Public password pages
  if (pathname === '/forgot') return servePage(res, 'forgot.html');
  if (pathname === '/reset' || pathname.startsWith('/reset/')) return servePage(res, 'reset.html');

  // Public shared-item page: /s/<id> — minimal details + join-the-waitlist CTA.
  if (pathname === '/s' || pathname.startsWith('/s/')) return servePage(res, 'share.html');

  // Clean page routes with auth gating.
  if (Object.prototype.hasOwnProperty.call(PAGE_ROUTES, pathname)) {
    const user = currentUser(req);
    if (pathname === '/app' || pathname === '/admin' || pathname === '/activity') {
      if (auth.needsSetup()) return redirect(res, '/setup');
      if (!user) return redirect(res, '/login');
      if (user.role === 'customer') return redirect(res, '/shop'); // customers never see the internal app
      if ((pathname === '/admin' || pathname === '/activity') && user.role !== 'admin') return redirect(res, '/app');
    } else if (pathname === '/shop') {
      if (auth.needsSetup()) return redirect(res, '/setup');
      // Guest browsing, when the shop owner has turned it on. Requesting a
      // purchase still needs an account — this only opens the catalogue.
      if (!user && !settings.effective().shop.publicCatalog) return redirect(res, '/login');
    } else if (pathname === '/setup' && !auth.needsSetup()) {
      return redirect(res, '/login');
    } else if (pathname === '/login') {
      if (auth.needsSetup()) return redirect(res, '/setup');
      if (user) return redirect(res, homeFor(user));
    }
    return servePage(res, PAGE_ROUTES[pathname]);
  }

  // Static assets (css/js/images/favicon).
  const filePath = normalize(join(PUBLIC_DIR, pathname));
  if (!filePath.startsWith(PUBLIC_DIR)) return notFound(res); // path traversal guard
  try {
    const st = await stat(filePath);
    if (st.isDirectory()) return notFound(res);
    const buf = await readFile(filePath);
    // Revalidate HTML/CSS/JS every load so front-end updates take effect
    // immediately after `update.sh` (no stale scripts). Other assets can cache.
    const ext = extname(filePath);
    const revalidate = ext === '.html' || ext === '.css' || ext === '.js';
    send(res, 200, buf, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': revalidate ? 'no-cache' : 'public, max-age=86400',
    });
  } catch {
    notFound(res);
  }
}

/**
 * Read one shop's public profile. Remote input, so it is sanitized and checked
 * against the node id we expected before it is used for anything.
 */
async function fetchProfile(peer, { timeoutMs = 6000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${peer.url}/api/directory/profile`, {
      signal: ctrl.signal, headers: { Accept: 'application/json' },
    });
    if (!res.ok) return null;
    return sanitizeProfile(await res.json(), { expectNode: peer.node });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Resolve a shop's shareable link into its invite code.
 *
 * The link a shop hands out is just its /connect page, so the origin is the
 * only part that matters — anything after it is dropped rather than trusted.
 * Fetching /api/directory/invite from that origin is the same class of outbound
 * request this admin endpoint already makes to verify a peer; it is admin-only,
 * and the answer still has to survive the profile verification below before it
 * becomes a connection.
 */
async function inviteCodeFromLink(link, { timeoutMs = 6000 } = {}) {
  let origin;
  try {
    const u = new URL(String(link).trim());
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    origin = u.origin;
  } catch { return null; }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${origin}/api/directory/invite`, {
      signal: ctrl.signal, headers: { Accept: 'application/json' },
    });
    if (!res.ok) return null;
    const body = await res.json();
    return typeof body?.code === 'string' ? body.code : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Refresh what we know about the shops we connected to: are they still there,
 * have they listed us back, and who do they recommend that we don't know yet?
 *
 * Best-effort throughout — a friend being offline updates nothing rather than
 * failing the whole sync.
 */
async function syncConnections() {
  const eff = settings.effective();
  const d = eff.directory;
  if (!d.enabled || !d.nodePublicKey) return { friends: [], suggestions: [] };

  const friends = repo.listPeers().filter((p) => p.trusted && !p.blocked);
  const profiles = (await Promise.all(friends.map(async (f) => {
    const profile = await fetchProfile(f);
    const state = connectionState(d.nodePublicKey, profile);
    repo.markPeerChecked(f.node, {
      mutual: state === 'mutual',
      name: profile?.name, tagline: profile?.tagline, region: profile?.region,
    });
    return profile ? { ...profile, state } : null;
  }))).filter(Boolean);

  const known = repo.listPeers().map((p) => p.node);
  const suggestions = suggestConnections({
    myNode: d.nodePublicKey,
    myRegion: d.region,
    profiles,
    knownNodes: known,
    blockedNodes: [...repo.blockedNodes(), ...repo.dismissedNodes()],
  });

  return {
    friends: repo.listPeers().filter((p) => p.trusted && !p.blocked),
    suggestions,
    reachable: profiles.length,
    total: friends.length,
  };
}

/**
 * Repo mode: read the shop list from the registry file, pick the nearest few,
 * then ask each of those shops directly for its own stock.
 *
 * The registry is cached far longer than the listings — a shop list changes
 * when someone merges a pull request, not when something sells.
 */
let registryCache = { at: 0, entries: [] };
const REGISTRY_TTL_MS = 60 * 60_000;

async function nearbyFromRegistry(d) {
  if (Date.now() - registryCache.at > REGISTRY_TTL_MS) {
    const r = await fetchRegistry(d.registryUrl || DEFAULT_REGISTRY_URL);
    registryCache = { at: Date.now(), entries: r.entries };
    if (r.errors.length) console.warn(`[directory] registry has ${r.errors.length} invalid entr${r.errors.length === 1 ? 'y' : 'ies'}; they were skipped`);
  }
  const peers = selectPeers(registryCache.entries, {
    myNode: d.nodePublicKey,
    myRegion: d.region,
    trustedNodes: repo.trustedNodes(),
    blockedNodes: repo.blockedNodes(),
  });
  // Remember who we saw, so the admin can trust or block them by name later.
  for (const p of peers) repo.upsertPeer({ node: p.node, name: p.name, url: p.url, region: p.region });
  return fetchAllPeerListings(peers);
}

// Nearby listings, cached. Failure yields an empty list, never an error: a
// community strip is a nice-to-have and must not break a working storefront.
let nearbyCache = { at: 0, rows: [] };
const NEARBY_TTL_MS = 5 * 60_000;

async function nearbyListings() {
  const eff = settings.effective();
  const d = eff.directory;
  if (!d.enabled || !d.effectiveShowNearby || !d.region.country) return [];
  if (Date.now() - nearbyCache.at < NEARBY_TTL_MS) return nearbyCache.rows;

  try {
    const raw = d.mode === 'repo'
      ? await nearbyFromRegistry(d)
      : await fetchNearby(d, { region: d.region, categories: repo.stockedCategories() });
    const blocked = new Set(repo.blockedNodes());
    const trusted = repo.trustedNodes();
    const rows = rankRemoteListings(
      raw.filter((r) => !blocked.has(r.node))
         // Showing only shops you invited is part of the paid upgrade, so
         // `effectiveTrustedOnly` is always false here and this filter never
         // narrows anything. Kept as the single place that decision is made.
         .filter((r) => !d.effectiveTrustedOnly || trusted.includes(r.node)),
      { myRegion: d.region, myCategories: repo.stockedCategories(), trustedNodes: trusted },
    );
    // Remember who we have seen, so an admin can trust or block them later.
    for (const r of rows) repo.upsertPeer({ node: r.node, name: r.shopName, url: r.url, region: r.region });
    nearbyCache = { at: Date.now(), rows };
    return rows;
  } catch {
    nearbyCache = { at: Date.now(), rows: [] };
    return [];
  }
}

/**
 * Keep the directory in step with a local change.
 *
 * Fire-and-forget: a directory that is down, slow or misconfigured must never
 * block someone from editing or selling an item on their own shop.
 *
 * An item that sells, gets hidden, or has sharing switched off is DELISTED —
 * leaving a sold unit advertised across the community would send strangers to
 * a dead link and make the whole directory less trustworthy.
 */
function syncItemToDirectory(itemId) {
  const eff = settings.effective();
  const d = eff.directory;
  if (!d.enabled || !d.nodePublicKey) return;

  const shareable = repo.shareableItem(itemId);
  const existing = repo.getShare(itemId);

  if (!shareable) {
    if (existing && existing.status === 'published') {
      delistListing(d, existing.ref)
        .then(() => repo.recordShare(itemId, { status: 'delisted' }))
        .catch((e) => repo.recordShare(itemId, { status: 'error', detail: e.message }));
    }
    return;
  }

  const origin = eff.site.url || PUBLIC_ORIGIN;
  publishListing(d, shareable, { origin, region: d.region })
    .then((r) => repo.recordShare(itemId, { ref: r?.ref || null, status: 'published' }))
    .catch((e) => repo.recordShare(itemId, { status: 'error', detail: e.message }));
}

/**
 * Email the shopper that their request moved. Best-effort: the status change is
 * already committed, so a mail failure must not fail the request.
 */
async function notifyRequestUpdate(request) {
  const eff = settings.effective();
  return notifyCustomerStatus(request, shopperView(request.status), offerView(request), {
    brand: eff.brand.name, origin: PUBLIC_ORIGIN,
  });
}

// ---- API routing ---------------------------------------------------------

async function handleApi(req, res, url) {
  const { pathname, searchParams } = url;
  // Remember how this install is actually reached, so mail sent from an admin
  // action (where there is no shopper request to derive it from) can still link
  // back correctly.
  if (req.headers.host) PUBLIC_ORIGIN = `${isSecure(req) ? 'https' : 'http'}://${req.headers.host}`;
  const parts = pathname.replace(/^\/api\/?/, '').split('/').filter(Boolean);
  const method = req.method;

  // GET /api/health  (public). `build` lets update.sh confirm the running
  // process actually restarted onto the new code.
  if (parts[0] === 'health') {
    // `edition` is what a fleet dashboard actually wants: whether we run the
    // box. It is observed, so it can't be stale.
    return ok(res, {
      ok: true, build: BUILD, edition: edition.current(), upgrade: upgrade.status(),
      time: new Date().toISOString(),
    });
  }

  // GET /api/shop/public — read-only catalogue for signed-out visitors.
  // Reuses the same sanitized shape as the members' view, so a guest can never
  // be shown a field a customer isn't allowed to see.
  if (parts[0] === 'shop' && parts[1] === 'public' && method === 'GET') {
    const eff = settings.effective();
    if (!eff.shop.publicCatalog) return forbidden(res, 'public browsing is off');
    return ok(res, {
      guest: true,
      items: repo.shopItems(),
      categories: repo.shopCategories(),
      conditions: eff.conditionNotes,
      recentlyViewed: [],
      cart: { lines: [] },
      openRequests: 0,
    });
  }

  // GET /api/directory/verify (public)
  //
  // How a directory checks that whoever registered "https://myshop.example" can
  // actually control it: fetch this from the claimed URL and compare the node
  // id. Without it, anyone could register somebody else's domain.
  //
  // Returns only the public node id and coarse region — the same facts already
  // published in the directory entry, so this leaks nothing new.
  if (parts[0] === 'directory' && parts[1] === 'verify' && method === 'GET') {
    const d = settings.effective().directory;
    if (!d.enabled || !d.nodePublicKey) return notFound(res, 'this shop is not in the community directory');
    const brand = settings.effective().brand;
    return ok(res, {
      node: d.nodePublicKey,
      name: brand.name,
      region: d.region,
      build: BUILD,
    });
  }

  // GET /api/directory/profile (public)
  //
  // How one shop introduces itself to another: name, region, what it stocks,
  // and — only if this shop chose to publish them — who it has connected to.
  // That last list is what lets friends suggest shops to each other, and it is
  // absent rather than empty when private, so a reader can tell the difference.
  if (parts[0] === 'directory' && parts[1] === 'profile' && method === 'GET') {
    const eff = settings.effective();
    const d = eff.directory;
    if (!d.enabled || !d.nodePublicKey) return notFound(res, 'this shop is not in the community directory');
    const profile = buildProfile({
      node: d.nodePublicKey,
      brand: eff.brand,
      url: eff.site.url || PUBLIC_ORIGIN,
      region: d.region,
      categories: repo.stockedCategories(),
      itemCount: repo.shopItems({ includeSoldOut: false }).length,
      contact: d.contact,
      recommends: d.shareConnections
        ? repo.listPeers().filter((p) => p.trusted && !p.blocked).map((p) => ({ node: p.node, name: p.name, url: p.url }))
        : null,
    });
    return send(res, 200, JSON.stringify(profile), {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'public, max-age=300',
      'Access-Control-Allow-Origin': '*',
    });
  }

  // GET /api/directory/invite (public) — the code a shop hands out to connect.
  // Public because it contains nothing private: a node id and a URL that are
  // already visible to anyone who looks at the shop.
  if (parts[0] === 'directory' && parts[1] === 'invite' && method === 'GET') {
    const eff = settings.effective();
    const d = eff.directory;
    if (!d.enabled || !d.nodePublicKey) return notFound(res, 'this shop is not in the community directory');
    return ok(res, {
      code: buildInvite({ node: d.nodePublicKey, url: eff.site.url || PUBLIC_ORIGIN, name: eff.brand.name }),
      name: eff.brand.name,
      tagline: eff.brand.tagline,
      url: eff.site.url || PUBLIC_ORIGIN,
    });
  }

  // GET /api/directory/listings (public)
  //
  // Each shop serves its own shared stock. That is what makes the repo-backed
  // registry work: the repo lists WHO exists, and every shop answers for its
  // own inventory — so nobody's listings live on anyone else's server, and a
  // price change needs no commit anywhere.
  //
  // Same whitelist as the pushed payload; there is exactly one function that
  // decides what a listing looks like to a stranger.
  if (parts[0] === 'directory' && parts[1] === 'listings' && method === 'GET') {
    const eff = settings.effective();
    const d = eff.directory;
    if (!d.enabled || !d.nodePublicKey) return notFound(res, 'this shop is not in the community directory');
    const origin = eff.site.url || PUBLIC_ORIGIN;
    const listings = repo.shareableItems()
      .map((it) => buildListingRecord(it, { node: d.nodePublicKey, origin, region: d.region }))
      .filter(Boolean);
    return send(res, 200, JSON.stringify({ node: d.nodePublicKey, region: d.region, listings }), {
      'Content-Type': 'application/json; charset=utf-8',
      // Neighbours poll this; a few minutes of caching is plenty and keeps the
      // load off a small shop's server.
      'Cache-Control': 'public, max-age=300',
      'Access-Control-Allow-Origin': '*',
    });
  }

  // GET /api/theme.css  (public — colour palette for every page, incl. login)
  if (parts[0] === 'theme.css' && method === 'GET') {
    return send(res, 200, buildThemeCss(settings.effective().theme), {
      'Content-Type': 'text/css; charset=utf-8',
      'Cache-Control': 'no-cache', // so a theme change shows on the next load
    });
  }

  // GET /api/branding  (public — site name/tagline for the pre-login pages)
  if (parts[0] === 'branding' && method === 'GET') {
    const s = settings.effective();
    const deals = s.landing.deals.map(resolveLandingDeal).filter(Boolean);
    // `signedIn` lets the storefront choose the members' or the guest path
    // without first firing a request it expects to fail with a 401.
    return ok(res, {
      name: s.brand.name, tagline: s.brand.tagline,
      site: s.site, deals,
      signedIn: Boolean(currentUser(req)),
      publicCatalog: s.shop.publicCatalog,
    });
  }

  // GET /api/landing/media/:id  (public — landing sample-deal images)
  if (parts[0] === 'landing' && parts[1] === 'media' && method === 'GET') {
    const asset = images.getAsset(Number(parts[2]));
    if (!asset) return notFound(res, 'image not found');
    try {
      const buf = await fsReadFile(images.assetPath(asset));
      return send(res, 200, buf, { 'Content-Type': asset.mime || 'application/octet-stream', 'Cache-Control': 'public, max-age=86400' });
    } catch { return notFound(res, 'image file missing'); }
  }

  // ---- public item share (no auth): minimal teaser + reveal-to-join ----
  // GET /api/public/item/:id/image  -> primary photo of a shoppable item
  if (parts[0] === 'public' && parts[1] === 'item' && parts[3] === 'image' && method === 'GET') {
    const share = repo.publicShareItem(Number(parts[2]));
    if (!share || !share.image) return notFound(res, 'image not found');
    const img = images.getImage(share.image);
    if (!img) return notFound(res, 'image not found');
    try {
      const buf = await fsReadFile(images.imagePath(img));
      return send(res, 200, buf, { 'Content-Type': img.mime || 'application/octet-stream', 'Cache-Control': 'public, max-age=3600' });
    } catch { return notFound(res, 'image file missing'); }
  }
  // GET /api/public/media/:id -> any photo of a shoppable item, for guest
  // browsing. Gated on the same publicCatalog flag as the catalogue itself, and
  // the image must belong to an item that is genuinely for sale — so turning
  // guest browsing off closes this too.
  if (parts[0] === 'public' && parts[1] === 'media' && method === 'GET') {
    if (!settings.effective().shop.publicCatalog) return forbidden(res, 'public browsing is off');
    const img = images.getImage(Number(parts[2]));
    if (!img || !repo.shopItem(img.item_id)) return notFound(res, 'image not found');
    try {
      const buf = await fsReadFile(images.imagePath(img));
      return send(res, 200, buf, { 'Content-Type': img.mime || 'application/octet-stream', 'Cache-Control': 'public, max-age=3600' });
    } catch { return notFound(res, 'image file missing'); }
  }

  // GET /api/public/item/:id  -> minimal share details (title/photo, NO price)
  if (parts[0] === 'public' && parts[1] === 'item' && parts.length === 3 && method === 'GET') {
    const share = repo.publicShareItem(Number(parts[2]));
    if (!share) return notFound(res, 'item not available');
    const brand = settings.effective().brand;
    return ok(res, {
      item: { ...share, image: share.image ? `/api/public/item/${share.id}/image` : null },
      brand: { name: brand.name },
    });
  }

  // POST /api/waitlist  (public lead capture)
  if (parts[0] === 'waitlist' && method === 'POST') {
    const body = await readBody(req);
    if (!body.email && !body.name) return bad(res, 'Please provide your name or email.');
    const entry = repo.addWaitlist({
      name: body.name, email: body.email, phone: body.phone, message: body.message,
      userAgent: req.headers['user-agent'], ip: clientIp(req), device: body.device,
    });
    const summary = [entry.name, entry.email, entry.phone].filter(Boolean).join(' · ');
    notifyText(`📝 New waitlist signup: ${summary}${entry.message ? ' — “' + entry.message + '”' : ''}`).catch(() => {});
    return created(res, { ok: true, message: "You're on the waitlist — we'll be in touch!" });
  }

  // ---- auth + invites (public endpoints) ----
  if (parts[0] === 'auth') return handleAuth(req, res, parts, method);
  if (parts[0] === 'invite') return handleInvite(req, res, parts, method);

  // Everything past here requires a valid session.
  const user = currentUser(req);
  if (!user) return unauthorized(res);

  // Customers are confined to the storefront (+ item images) — never internals.
  if (user.role === 'customer' && parts[0] !== 'shop' && parts[0] !== 'media') return forbidden(res);
  if (parts[0] === 'shop') return handleShop(req, res, parts, method, user);

  // GET /api/media/:id  -> stream an item image (any authenticated user).
  if (parts[0] === 'media' && method === 'GET') {
    const img = images.getImage(Number(parts[1]));
    if (!img) return notFound(res, 'image not found');
    // Customers may only view images of items that are for sale.
    if (user.role === 'customer' && !repo.shopItem(img.item_id)) return forbidden(res);
    try {
      const buf = await fsReadFile(images.imagePath(img));
      return send(res, 200, buf, { 'Content-Type': img.mime || 'application/octet-stream', 'Cache-Control': 'private, max-age=86400' });
    } catch {
      return notFound(res, 'image file missing');
    }
  }

  // ---- admin (admin role only) ----
  if (parts[0] === 'admin') {
    if (user.role !== 'admin') return forbidden(res);
    return handleAdmin(req, res, parts, method, searchParams);
  }

  // GET /api/config  (effective provider status + pricing defaults, no secrets)
  if (parts[0] === 'config' && method === 'GET') {
    const s = settings.effective();
    return ok(res, {
      providers: {
        ebay: { enabled: s.ebay.enabled, marketplace: s.ebay.marketplace },
        amazon: { enabled: s.amazon.enabled },
      },
      defaults: s.defaults,
      brand: s.brand,
      conditions: conditionList(),
      user: { username: user.username, role: user.role },
    });
  }

  // ---- items ----
  if (parts[0] === 'items') {
    // /api/items
    if (parts.length === 1) {
      if (method === 'GET') {
        return ok(res, repo.listItems({
          status: searchParams.get('status') || undefined,
          category: searchParams.get('category') || undefined,
        }));
      }
      if (method === 'POST') {
        const body = await readBody(req);
        try {
          const item = repo.createItem(body);
          if (repo.itemIsShoppable(item.id)) fireStockNotify(req, item, 'new');
          return created(res, item);
        } catch (e) {
          return bad(res, e.message);
        }
      }
    }

    const id = Number(parts[1]);
    if (!Number.isInteger(id)) return bad(res, 'invalid item id');

    // /api/items/:id
    if (parts.length === 2) {
      if (method === 'GET') {
        const result = repo.itemWithFinancials(id);
        if (!result) return notFound(res, 'item not found');
        return ok(res, result);
      }
      if (method === 'PUT' || method === 'PATCH') {
        const body = await readBody(req);
        const wasShoppable = repo.itemIsShoppable(id);
        const updated = repo.updateItem(id, body);
        if (!updated) return notFound(res, 'item not found');
        const nowShoppable = repo.itemIsShoppable(id);
        if (!wasShoppable && nowShoppable) fireStockNotify(req, updated, 'available');
        else if (wasShoppable && !nowShoppable && updated.status === 'sold') fireStockNotify(req, updated, 'sold');
        syncItemToDirectory(id);
        return ok(res, repo.itemWithFinancials(id));
      }
      if (method === 'DELETE') {
        syncItemToDirectory(id); // delist before the row (and its share) disappears
        return repo.deleteItem(id) ? ok(res, { deleted: true }) : notFound(res, 'item not found');
      }
    }

    // POST /api/items/:id/duplicate  -> quick copy for re-listing
    if (parts.length === 3 && parts[2] === 'duplicate' && method === 'POST') {
      const copy = repo.duplicateItem(id);
      return copy ? created(res, copy) : notFound(res, 'item not found');
    }

    // /api/items/:id/costs
    if (parts.length === 3 && parts[2] === 'costs') {
      if (method === 'GET') return ok(res, repo.listCosts(id));
      if (method === 'POST') {
        const body = await readBody(req);
        try {
          return created(res, repo.addCost(id, body));
        } catch (e) {
          return bad(res, e.message);
        }
      }
    }

    // /api/items/:id/images  (GET list, POST upload raw binary)
    if (parts.length === 3 && parts[2] === 'images') {
      if (method === 'GET') return ok(res, images.listImages(id));
      if (method === 'POST') {
        if (!repo.getItem(id)) return notFound(res, 'item not found');
        const mime = (req.headers['content-type'] || '').split(';')[0].trim();
        if (!images.isAllowedMime(mime)) return bad(res, 'unsupported image type (JPEG, PNG, WebP, GIF)');
        try {
          const buffer = await readRawBody(req);
          const original = searchParams.get('name') || undefined;
          return created(res, images.saveImage(id, { buffer, mime, original }));
        } catch (e) {
          return bad(res, e.message);
        }
      }
    }

    // /api/items/:id/upgrades
    if (parts.length === 3 && parts[2] === 'upgrades') {
      if (method === 'GET') return ok(res, repo.listUpgrades(id));
      if (method === 'POST') {
        const body = await readBody(req);
        try {
          return created(res, repo.addUpgrade(id, body));
        } catch (e) {
          return bad(res, e.message);
        }
      }
    }

    // /api/items/:id/financials
    if (parts.length === 3 && parts[2] === 'financials' && method === 'GET') {
      const market = searchParams.get('market');
      const result = repo.itemWithFinancials(id, market ? { marketEstimate: Number(market) } : {});
      if (!result) return notFound(res, 'item not found');
      return ok(res, result.financials);
    }

    // /api/items/:id/sell  -> mark sold with price + date
    if (parts.length === 3 && parts[2] === 'sell' && method === 'POST') {
      const body = await readBody(req);
      const wasShoppable = repo.itemIsShoppable(id);
      const sold = repo.markSold(id, body);
      if (!sold) return notFound(res, 'item not found');
      if (wasShoppable) fireStockNotify(req, sold, 'sold');
      // A sold unit must come down from the directory, or strangers get sent
      // across the community to a dead listing.
      syncItemToDirectory(id);
      return ok(res, repo.itemWithFinancials(id));
    }

    // /api/items/:id/pricing  -> search comps for this item and attach estimate
    if (parts.length === 3 && parts[2] === 'pricing' && method === 'POST') {
      const item = repo.getItem(id);
      if (!item) return notFound(res, 'item not found');
      const body = await readBody(req);
      const query = body.query || buildQueryForItem(item);
      const sources = body.sources || undefined;
      // Default to the item's own condition — pricing a refurb against new
      // retail is the single easiest way to overstate projected profit.
      const condition = normalizeCondition(body.condition ?? item.condition);
      const comps = await searchComparables(query, {
        sources, condition, limit: body.limit, offset: body.offset,
      });
      persistComps(id, query, comps);
      // Cache the comparison for the storefront so a shopper-facing card never
      // triggers a live marketplace call.
      repo.saveMarketSnapshot(id, comps);
      const result = repo.itemWithFinancials(id, { marketEstimate: comps.marketEstimate });
      return ok(res, { query, condition, comps, financials: result.financials });
    }
  }

  // ---- costs (top-level delete) ----
  if (parts[0] === 'costs' && parts.length === 2 && req.method === 'DELETE') {
    const cid = Number(parts[1]);
    return repo.deleteCost(cid) ? ok(res, { deleted: true }) : notFound(res, 'cost not found');
  }

  // ---- upgrades (top-level delete) ----
  if (parts[0] === 'upgrades' && parts.length === 2 && method === 'DELETE') {
    const uid = Number(parts[1]);
    return repo.deleteUpgrade(uid) ? ok(res, { deleted: true }) : notFound(res, 'upgrade not found');
  }

  // ---- images (delete / set primary) ----
  if (parts[0] === 'images' && parts.length === 2 && method === 'DELETE') {
    return images.deleteImage(Number(parts[1])) ? ok(res, { deleted: true }) : notFound(res, 'image not found');
  }
  if (parts[0] === 'images' && parts.length === 3 && parts[2] === 'primary' && method === 'POST') {
    return images.setPrimary(Number(parts[1])) ? ok(res, { ok: true }) : notFound(res, 'image not found');
  }

  // ---- eBay listing import (auto-fill item from a listing URL / id) ----
  if (parts[0] === 'ebay' && parts[1] === 'listing' && method === 'POST') {
    const body = await readBody(req);
    try {
      const r = await fetchListing(body.url ?? body.itemId ?? body.input ?? '');
      return ok(res, r);
    } catch (e) {
      const clientErr = e.code === 'no_credentials' || e.code === 'bad_input';
      return send(res, clientErr ? 400 : 502, { error: e.message, code: e.code || null });
    }
  }

  // ---- pricing (ad hoc search) ----
  if (parts[0] === 'pricing' && parts[1] === 'search' && method === 'GET') {
    const q = searchParams.get('q');
    if (!q) return bad(res, 'q (query) is required');
    const sources = searchParams.get('sources')?.split(',').filter(Boolean);
    const condition = normalizeCondition(searchParams.get('condition'));
    const comps = await searchComparables(q, {
      sources, condition,
      limit: searchParams.get('limit') || undefined,
      offset: searchParams.get('offset') || undefined,
    });
    return ok(res, comps);
  }

  // ---- analytics ----
  if (parts[0] === 'analytics') {
    if (parts[1] === 'summary' && method === 'GET') return ok(res, repo.portfolioSummary());
    if (parts[1] === 'profit-series' && method === 'GET') {
      return ok(res, repo.profitTimeSeries({
        range: searchParams.get('range') || undefined,
        from: searchParams.get('from') || undefined,
        to: searchParams.get('to') || undefined,
        bucket: searchParams.get('bucket') || undefined,
      }));
    }
    if (parts[1] === 'report' && method === 'GET') {
      const staleDays = Number(searchParams.get('staleDays')) || undefined;
      return ok(res, repo.performanceReport(staleDays ? { staleDays } : {}));
    }
  }

  // ---- export / import ----
  if (parts[0] === 'export') {
    if (parts[1] === 'items.csv' && method === 'GET') {
      return send(res, 200, repo.exportItemsCsv(), {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': 'attachment; filename="inventory.csv"',
      });
    }
    if (parts[1] === 'backup.json' && method === 'GET') {
      return send(res, 200, repo.exportBackup(), {
        'Content-Disposition': 'attachment; filename="inventory-backup.json"',
      });
    }
    // Editable import templates.
    if (parts[1] === 'sample.csv' && method === 'GET') {
      return send(res, 200, repo.sampleImportCsv(), {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': 'attachment; filename="inventory-import-sample.csv"',
      });
    }
    if (parts[1] === 'sample.json' && method === 'GET') {
      return send(res, 200, repo.sampleImportJson(), {
        'Content-Disposition': 'attachment; filename="inventory-import-sample.json"',
      });
    }
  }

  if (parts[0] === 'import' && method === 'POST') {
    const body = await readBody(req);
    const items = Array.isArray(body) ? body : body.items;
    if (!Array.isArray(items)) return bad(res, 'expected { items: [...] } or a JSON array');
    try {
      return ok(res, repo.importItems(items));
    } catch (e) {
      return bad(res, e.message);
    }
  }

  // POST /api/quick-add { titles: [...] } — create several bare items fast
  if (parts[0] === 'quick-add' && method === 'POST') {
    const body = await readBody(req);
    const titles = Array.isArray(body.titles) ? body.titles : String(body.titles || '').split('\n');
    try {
      return created(res, repo.quickAddItems(titles, { category: body.category, status: body.status }));
    } catch (e) {
      return bad(res, e.message);
    }
  }

  // ---- seed sample data ----
  if (parts[0] === 'seed' && method === 'POST') {
    const count = seedSampleData();
    return ok(res, { seeded: count });
  }

  return notFound(res, 'unknown endpoint');
}

// ---- auth endpoints ------------------------------------------------------
async function handleAuth(req, res, parts, method) {
  const sub = parts[1];

  // GET /api/auth/status — public: tells the UI whether to show setup/login.
  if (sub === 'status' && method === 'GET') {
    const user = currentUser(req);
    return ok(res, {
      needsSetup: auth.needsSetup(),
      authenticated: Boolean(user),
      user: user ? { username: user.username, role: user.role } : null,
    });
  }

  // POST /api/auth/setup — create the first admin (only when no users exist).
  if (sub === 'setup' && method === 'POST') {
    if (!auth.needsSetup()) return bad(res, 'setup already completed');
    const body = await readBody(req);
    try {
      const u = auth.setupFirstAdmin({ username: body.username, password: body.password });
      const { token, expires } = auth.createSession(u.id);
      return send(res, 201, { user: { username: u.username, role: u.role } }, {
        'Set-Cookie': auth.sessionCookie(token, expires, { secure: isSecure(req) }),
      });
    } catch (e) {
      return bad(res, e.message);
    }
  }

  // POST /api/auth/login
  if (sub === 'login' && method === 'POST') {
    const body = await readBody(req);
    const sess = auth.login(body.username, body.password);
    if (!sess) return unauthorized(res, 'invalid username or password');
    const u = auth.getUserByUsername(body.username);
    return send(res, 200, { user: { username: u.username, role: u.role } }, {
      'Set-Cookie': auth.sessionCookie(sess.token, sess.expires, { secure: isSecure(req) }),
    });
  }

  // GET/PUT /api/auth/me — the signed-in user's own account
  if (sub === 'me') {
    const u = currentUser(req);
    if (!u) return unauthorized(res);
    if (method === 'GET') {
      const full = auth.getUserById(u.id);
      return ok(res, { username: full.username, role: full.role, name: full.name, email: full.email, phone: full.phone, tourDismissed: Boolean(full.tour_dismissed) });
    }
    // POST /api/auth/me/dismiss-tour — remember "don't show the tour again"
    if (parts[2] === 'dismiss-tour' && method === 'POST') {
      auth.setTourDismissed(u.id, true);
      return ok(res, { ok: true });
    }
    if (method === 'PUT' || method === 'PATCH') {
      const body = await readBody(req);
      try {
        if (body.password) {
          const full = auth.getUserById(u.id);
          if (!auth.verifyPassword(body.currentPassword || '', full.password_salt, full.password_hash)) {
            return bad(res, 'Current password is incorrect.');
          }
          auth.setPassword(u.id, body.password);
        }
        auth.updateProfile(u.id, { name: body.name, email: body.email, phone: body.phone });
        return ok(res, { ok: true });
      } catch (e) {
        return bad(res, e.message);
      }
    }
  }

  // POST /api/auth/logout
  if (sub === 'logout' && method === 'POST') {
    const cookies = auth.parseCookies(req.headers.cookie);
    auth.destroySession(cookies[auth.COOKIE_NAME]);
    return send(res, 200, { ok: true }, { 'Set-Cookie': auth.clearCookie() });
  }

  // POST /api/auth/forgot { identifier }  -> create a reset link (emailed if possible)
  if (sub === 'forgot' && method === 'POST') {
    const body = await readBody(req);
    const result = auth.requestPasswordReset(body.identifier);
    let emailed = false;
    if (result) {
      const base = `${isSecure(req) ? 'https' : 'http'}://${req.headers.host}`;
      const link = `${base}/reset/${result.token}`;
      const email = settings.effective().notify.email;
      const userEmail = auth.getUserById(result.user.id)?.email;
      if (email.enabled && userEmail) {
        const tpl = settings.effective().resetEmail;
        const vars = { name: result.user.name || result.user.username, username: result.user.username, link };
        try {
          await sendMail(email, {
            from: email.from, to: userEmail,
            subject: settings.renderTemplate(tpl.subject, vars),
            html: settings.renderTemplate(tpl.html, vars),
            text: `Reset your password (valid 1 hour): ${link}`,
          });
          emailed = true;
        } catch (e) { console.error('reset email failed:', e.message); }
      }
    }
    // Always the same response — don't reveal whether the account exists.
    return ok(res, { ok: true, emailed });
  }

  // GET /api/auth/reset/:token  -> validity
  if (sub === 'reset' && parts[2] && method === 'GET') {
    const u = auth.getResetUser(parts[2]);
    return ok(res, { valid: Boolean(u), username: u?.username || null });
  }
  // POST /api/auth/reset/:token  -> set a new password
  if (sub === 'reset' && parts[2] && method === 'POST') {
    const body = await readBody(req);
    try {
      auth.completePasswordReset(parts[2], body.password);
      return ok(res, { ok: true });
    } catch (e) {
      return bad(res, e.message);
    }
  }

  return notFound(res, 'unknown auth endpoint');
}

// ---- invite endpoints (public) -------------------------------------------
async function handleInvite(req, res, parts, method) {
  const token = parts[1];
  if (!token) return notFound(res, 'invite token required');

  // GET /api/invite/:token  -> validity + inviter-provided name
  if (parts.length === 2 && method === 'GET') {
    const inv = auth.getInvite(token);
    if (!inv) return ok(res, { valid: false, reason: 'not_found' });
    return ok(res, { valid: inv.valid, used: inv.used, expired: inv.expired, name: inv.name || null });
  }

  // POST /api/invite/:token/accept  -> create customer account + sign in
  if (parts[2] === 'accept' && method === 'POST') {
    const body = await readBody(req);
    try {
      const { user, session } = auth.acceptInvite(token, { username: body.username, password: body.password });
      return send(res, 201, { user: { username: user.username, role: user.role } }, {
        'Set-Cookie': auth.sessionCookie(session.token, session.expires, { secure: isSecure(req) }),
      });
    } catch (e) {
      return bad(res, e.message);
    }
  }
  return notFound(res, 'unknown invite endpoint');
}

// ---- storefront endpoints (customers + admins) ---------------------------
async function handleShop(req, res, parts, method, user) {
  // GET /api/shop/catalog -> everything the storefront needs in one round trip
  if (parts[1] === 'catalog' && method === 'GET') {
    return ok(res, {
      items: repo.shopItems(),
      categories: repo.shopCategories(),
      recentlyViewed: repo.recentlyViewed(user.id),
      cart: repo.getCart(user.id),
      conditions: settings.effective().conditionNotes,
      openRequests: repo.requestsForCustomer(user.id, 50)
        .filter((r) => shopperView(r.status).open).length,
    });
  }

  // GET /api/shop/friends -> the shops this one has connected to, as shops.
  // Distinct from /nearby, which suggests individual items: this is "who we
  // work with", and a customer reads the two very differently.
  if (parts[1] === 'friends' && method === 'GET') {
    const d = settings.effective().directory;
    if (!d.enabled || !d.showFriends) return ok(res, { friends: [] });
    return ok(res, { friends: storefrontFriends(repo.listPeers(), { myRegion: d.region }) });
  }

  // GET /api/shop/nearby -> listings from OTHER shops in the community.
  //
  // Cached in memory for a few minutes: a customer opening the shop must never
  // wait on somebody else's server, and hammering the directory on every page
  // load would be rude.
  if (parts[1] === 'nearby' && method === 'GET') {
    return ok(res, { listings: await nearbyListings() });
  }

  // GET /api/shop/item/:id -> one item, plus complementary stock
  if (parts[1] === 'item' && Number.isInteger(Number(parts[2])) && method === 'GET') {
    const id = Number(parts[2]);
    const item = repo.shopItem(id);
    if (!item) return notFound(res, 'item not available');
    return ok(res, { item, related: repo.relatedItems(id) });
  }

  // /api/shop/cart -> a cart that survives a refresh, and follows the account
  if (parts[1] === 'cart') {
    if (method === 'GET') return ok(res, repo.getCart(user.id));
    if (method === 'PUT' || method === 'POST') {
      const body = await readBody(req);
      // saveCart re-validates every line against live stock and prices, so a
      // cart restored days later can never quote a stale figure.
      return ok(res, repo.saveCart(user.id, body.lines || []));
    }
    if (method === 'DELETE') return ok(res, repo.clearCart(user.id));
  }

  // GET /api/shop/requests -> the shopper's own order history
  if (parts[1] === 'requests' && method === 'GET') {
    const rows = repo.requestsForCustomer(user.id);
    return ok(res, rows.map((r) => {
      let items = [];
      try { items = JSON.parse(r.items_json || 'null') || []; } catch { /* ignore */ }
      if (!items.length && r.item_title) items = [{ item_title: r.item_title, subtotal: r.total_price, qty: 1 }];
      // Deliberately narrow: the shopper sees their own order, never internal
      // fields such as the notification summary or admin notes.
      return {
        id: r.id,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        total: r.total_price,
        tracking: r.tracking || null,
        items: items.map((i) => ({ title: i.item_title || i.title, qty: i.qty || 1, subtotal: i.subtotal ?? i.total })),
        // The shopper's own note, named distinctly: shopperView also carries a
        // `message` (the status explanation) and one would clobber the other.
        note: r.message || null,
        ...shopperView(r.status),
        offer: offerView(r),
        history: (r.events || []).map((e) => ({ status: e.status, note: e.note, at: e.created_at })),
      };
    }));
  }

  // GET /api/shop/items  -> sanitized items for sale (price + specs only)
  if (parts[1] === 'items' && method === 'GET') {
    repo.logVisit({ kind: 'view', path: '/shop', userAgent: req.headers['user-agent'], ip: clientIp(req), referrer: req.headers.referer, user });
    return ok(res, repo.shopItems());
  }

  // GET /api/shop/me -> who am I + owner's site link (for the storefront header)
  if (parts[1] === 'me' && method === 'GET') {
    const s = settings.effective().site;
    const u = auth.getUserById(user.id);
    return ok(res, { username: user.username, name: u?.name || null, email: u?.email || null, phone: u?.phone || null, site: s });
  }

  // POST /api/shop/account -> the signed-in user edits their own name/email/phone
  if (parts[1] === 'account' && method === 'POST') {
    const body = await readBody(req);
    const u = auth.updateProfile(user.id, { name: body.name, email: body.email, phone: body.phone });
    return ok(res, { ok: true, name: u.name, email: u.email, phone: u.phone });
  }

  // POST /api/shop/password -> change own password (verifies the current one)
  if (parts[1] === 'password' && method === 'POST') {
    const body = await readBody(req);
    const u = auth.getUserById(user.id);
    if (!auth.verifyPassword(body.currentPassword || '', u.password_salt, u.password_hash)) {
      return bad(res, 'Your current password is incorrect.');
    }
    try { auth.setPassword(user.id, body.newPassword); } catch (e) { return bad(res, e.message); }
    return ok(res, { ok: true });
  }

  // POST /api/shop/track -> record a view/search/item-view with device details
  if (parts[1] === 'track' && method === 'POST') {
    const body = await readBody(req);
    const kind = body.kind === 'search' ? 'search' : body.kind === 'item' ? 'item' : 'view';
    // For item views, resolve the title server-side from a shoppable item only.
    let itemId = null, itemTitle = null;
    if (kind === 'item' && body.itemId != null) {
      const it = repo.shopItem(Number(body.itemId));
      if (it) { itemId = it.id; itemTitle = it.title; }
    }
    repo.logVisit({
      kind, path: '/shop', query: body.query, device: body.device,
      userAgent: req.headers['user-agent'], ip: clientIp(req), referrer: req.headers.referer,
      user, itemId, itemTitle,
    });
    return ok(res, { ok: true });
  }

  // /api/shop/subscriptions -> stock/availability alerts for the signed-in user
  if (parts[1] === 'subscriptions') {
    const full = auth.getUserById(user.id);
    if (method === 'GET') {
      return ok(res, { ...repo.listSubscriptions(user.id), email: full?.email || null, phone: full?.phone || null });
    }
    if (method === 'POST' || method === 'DELETE') {
      const body = await readBody(req);
      const itemId = body.itemId != null ? Number(body.itemId) : null;
      if (itemId != null && !repo.getItem(itemId)) return notFound(res, 'item not found');
      if (method === 'POST') {
        if (!full?.email && !full?.phone) return bad(res, 'Add an email or phone number to your account first so we can reach you.');
        repo.subscribe(user.id, itemId);
      } else {
        repo.unsubscribe(user.id, itemId);
      }
      return ok(res, repo.listSubscriptions(user.id));
    }
  }

  // POST /api/shop/requests  -> customer requests to purchase (cart)
  if (parts[1] === 'requests' && method === 'POST') {
    const body = await readBody(req);
    const full = auth.getUserById(user.id); // includes name/email/phone
    const items = Array.isArray(body.items) && body.items.length
      ? body.items
      : body.itemId != null ? [{ itemId: body.itemId, upgradeIds: body.upgradeIds }] : [];
    let request;
    try {
      request = repo.createPurchaseRequest({
        customer: full,
        items,
        offer: body.offer,
        message: body.message || '',
      });
    } catch (e) {
      return bad(res, e.message);
    }
    repo.logVisit({ kind: 'request', path: '/shop', userAgent: req.headers['user-agent'], ip: clientIp(req), user, itemTitle: request.item_title });
    // A submitted cart is spent — leaving it populated invites a duplicate order.
    repo.clearCart(user.id);
    const summary = await notifyPurchase(request);
    repo.setRequestNotified(request.id, summary);
    // Receipt for the shopper. Best-effort: the request is already saved.
    notifyCustomerRequest(request, {
      brand: settings.effective().brand.name,
      origin: `${isSecure(req) ? 'https' : 'http'}://${req.headers.host}`,
    }).catch(() => {});
    return created(res, {
      ok: true,
      message: 'Contacting admin — your request has been sent and they will reach out shortly.',
      total: request.total_price,
      offer: request.offer_price,
    });
  }
  return notFound(res, 'unknown shop endpoint');
}

// ---- admin endpoints (settings + users) ----------------------------------
async function handleAdmin(req, res, parts, method, searchParams) {
  const sub = parts[1];

  // /api/admin/settings — API credentials + pricing defaults
  if (sub === 'settings') {
    if (parts.length === 2 && method === 'GET') return ok(res, settings.adminView());
    if (parts.length === 2 && (method === 'PUT' || method === 'POST')) {
      const body = await readBody(req);
      return ok(res, settings.updateFromAdmin(body));
    }
    // POST /api/admin/settings/clear-secret { provider: 'ebay'|'amazon' }
    if (parts[2] === 'clear-secret' && method === 'POST') {
      const body = await readBody(req);
      settings.clearSecret(body.provider);
      return ok(res, settings.adminView());
    }
  }

  // /api/admin/users
  if (sub === 'users') {
    if (parts.length === 2 && method === 'GET') return ok(res, auth.listUsers());
    if (parts.length === 2 && method === 'POST') {
      const body = await readBody(req);
      try {
        const u = auth.createUser(body);
        return created(res, { id: u.id, username: u.username, role: u.role });
      } catch (e) {
        return bad(res, e.message);
      }
    }
    const id = Number(parts[2]);
    if (Number.isInteger(id)) {
      if (method === 'DELETE') {
        try {
          return auth.deleteUser(id) ? ok(res, { deleted: true }) : notFound(res, 'user not found');
        } catch (e) {
          return bad(res, e.message);
        }
      }
      if ((method === 'PUT' || method === 'PATCH') && parts.length === 3) {
        const body = await readBody(req);
        try {
          if (body.password) auth.setPassword(id, body.password);
          if (body.role) auth.setRole(id, body.role);
          if (body.name !== undefined || body.email !== undefined || body.phone !== undefined) {
            auth.updateProfile(id, { name: body.name, email: body.email, phone: body.phone });
          }
          return ok(res, { updated: true });
        } catch (e) {
          return bad(res, e.message);
        }
      }
    }
  }

  // /api/admin/invites — customer invitations
  if (sub === 'invites') {
    if (parts.length === 2 && method === 'GET') return ok(res, auth.listInvites());
    if (parts.length === 2 && method === 'POST') {
      const body = await readBody(req);
      const { token, expires } = auth.createInvite({ name: body.name, email: body.email, phone: body.phone });
      const base = `${isSecure(req) ? 'https' : 'http'}://${req.headers.host}`;
      return created(res, { link: `${base}/invite/${token}`, token, expires });
    }
    const id = Number(parts[2]);
    if (Number.isInteger(id) && method === 'DELETE') {
      return auth.deleteInvite(id) ? ok(res, { deleted: true }) : notFound(res, 'invite not found');
    }
  }

  // /api/admin/requests — purchase requests from customers
  if (sub === 'requests') {
    if (parts.length === 2 && method === 'GET') return ok(res, repo.listPurchaseRequests());
    const id = Number(parts[2]);
    if (Number.isInteger(id) && (method === 'PUT' || method === 'PATCH')) {
      const body = await readBody(req);
      const r = repo.setRequestStatus(id, body.status, {
        note: body.note, tracking: body.tracking, actor: 'admin',
      });
      if (!r.ok) return r.request ? bad(res, r.reason) : notFound(res, 'request not found');
      // Tell the shopper their order moved — that is the whole point of having
      // a lifecycle rather than an internal flag.
      notifyRequestUpdate(r.request).catch((e) => console.warn('[orders] shopper notify failed:', e.message));
      return ok(res, { request: r.request, events: repo.requestEvents(id), next: nextOptions(r.request.status) });
    }
    // POST /api/admin/requests/:id/offer { decision, note }
    if (Number.isInteger(id) && parts[3] === 'offer' && method === 'POST') {
      const body = await readBody(req);
      const r = repo.setOfferStatus(id, body.decision, body.note);
      if (!r.ok) return bad(res, r.reason);
      notifyRequestUpdate(r.request).catch((e) => console.warn('[orders] shopper notify failed:', e.message));
      return ok(res, { request: r.request, events: repo.requestEvents(id) });
    }
  }

  // /api/admin/visits — storefront visitor / device activity
  if (sub === 'visits' && method === 'GET') {
    const page = Math.max(Number(searchParams.get('page')) || 1, 1);
    const limit = Number(searchParams.get('limit')) || 25;
    const paged = repo.listVisitsPaged({ limit, offset: (page - 1) * limit });
    return ok(res, { stats: repo.visitStats(), page, ...paged });
  }
  // DELETE /api/admin/visits?days=30  (or no days = clear all)
  if (sub === 'visits' && method === 'DELETE') {
    const days = Number(searchParams.get('days')) || undefined;
    const removed = repo.clearVisits({ olderThanDays: days });
    return ok(res, { removed });
  }

  // /api/admin/reset-requests — who asked to reset a password
  if (sub === 'reset-requests' && method === 'GET') {
    return ok(res, auth.listResetRequests());
  }

  // /api/admin/subscriptions — who subscribed to stock alerts, and to what
  if (sub === 'subscriptions' && method === 'GET') {
    return ok(res, repo.listAllSubscriptions());
  }

  // /api/admin/directory — community directory settings, shares and peers
  if (sub === 'directory') {
    if (parts.length === 2 && method === 'GET') {
      return ok(res, {
        directory: settings.directoryView(),
        shares: repo.listShares(),
        peers: repo.listPeers(),
        shareable: repo.shareableItems().length,
        publicCatalog: settings.effective().shop.publicCatalog,
        siteUrl: settings.effective().site.url,
        origin: PUBLIC_ORIGIN,
      });
    }
    if (parts.length === 2 && (method === 'PUT' || method === 'POST')) {
      const body = await readBody(req);
      settings.updateDirectory(body);
      return ok(res, { directory: settings.directoryView() });
    }

    // GET /api/admin/directory/entry — the block to paste into a pull request.
    // Generated and pre-validated so joining is a copy-paste rather than a
    // schema-guessing exercise, and so broken entries never reach a reviewer.
    if (parts[2] === 'entry' && method === 'GET') {
      const eff = settings.effective();
      const d = eff.directory;
      const url = eff.site.url || PUBLIC_ORIGIN;
      const built = buildRegistryEntry({
        node: d.nodePublicKey,
        brand: eff.brand,
        url,
        region: d.region,
        categories: repo.stockedCategories(),
        contact: d.contact,
        today: new Date().toISOString().slice(0, 10),
      });
      return ok(res, {
        ...built,
        verifyUrl: `${url}/api/directory/verify`,
        // A shop that isn't publicly reachable can't be verified, so say so
        // here rather than letting them submit something that will be rejected.
        publiclyReachable: Boolean(eff.shop.publicCatalog || eff.site.url),
      });
    }

    // GET /api/admin/directory/registry — who is currently listed
    if (parts[2] === 'registry' && method === 'GET') {
      const d = settings.effective().directory;
      try {
        const r = await fetchRegistry(d.registryUrl || DEFAULT_REGISTRY_URL);
        return ok(res, {
          count: r.count, updated: r.updated, errors: r.errors,
          peers: selectPeers(r.entries, {
            myNode: d.nodePublicKey, myRegion: d.region,
            trustedNodes: repo.trustedNodes(), blockedNodes: repo.blockedNodes(), limit: 20,
          }),
        });
      } catch (e) {
        return bad(res, `Could not read the registry: ${e.message}`);
      }
    }

    // POST /api/admin/directory/register — announce this shop
    if (parts[2] === 'register' && method === 'POST') {
      const eff = settings.effective();
      const d = eff.directory;
      if (!d.enabled) return bad(res, 'Turn the community directory on first.');
      if (d.mode === 'repo') {
        return bad(res, 'In repository mode there is nothing to ping — your shop is listed by adding it to directory/nodes.json, and it serves its own listings. Use "Copy registry entry" and open a pull request.');
      }
      // A directory entry that leads to a login wall wastes everyone's time,
      // so the shop has to actually be publicly reachable before it registers.
      if (!eff.shop.publicCatalog && !eff.site.url) {
        return bad(res, 'Your shop has no public face yet. Turn on guest browsing, or set your website URL under Site & branding, so the listing leads somewhere a stranger can open.');
      }
      if (!d.region.country) return bad(res, 'Set at least a country so nearby shoppers can find you.');
      try {
        const r = await registerNode(d, {
          site: { url: eff.site.url || PUBLIC_ORIGIN },
          brand: eff.brand,
          region: d.region,
          categories: repo.stockedCategories(),
          itemCount: repo.shopItems({ includeSoldOut: false }).length,
          contact: d.contact,
        });
        settings.setRaw('directory_registered_at', new Date().toISOString());
        settings.setRaw('directory_last_ping', new Date().toISOString());
        settings.setRaw('directory_last_error', '');
        return ok(res, { ok: true, result: r, directory: settings.directoryView() });
      } catch (e) {
        settings.setRaw('directory_last_error', e.message);
        return bad(res, `Could not reach the directory: ${e.message}`);
      }
    }

    // POST /api/admin/directory/sync — publish every shared listing
    if (parts[2] === 'sync' && method === 'POST') {
      const eff = settings.effective();
      const d = eff.directory;
      if (!d.enabled) return bad(res, 'Turn the community directory on first.');
      if (d.mode === 'repo') {
        return bad(res, 'In repository mode listings are not pushed anywhere — neighbours read them straight from your shop. Anything ticked for sharing is already live at /api/directory/listings.');
      }
      const origin = eff.site.url || PUBLIC_ORIGIN;
      const results = { published: 0, failed: 0, errors: [] };
      for (const item of repo.shareableItems()) {
        try {
          const r = await publishListing(d, item, { origin, region: d.region });
          repo.recordShare(item.id, { ref: r?.ref || null, status: 'published' });
          results.published += 1;
        } catch (e) {
          repo.recordShare(item.id, { status: 'error', detail: e.message });
          results.failed += 1;
          if (results.errors.length < 3) results.errors.push(`${item.title}: ${e.message}`);
        }
      }
      settings.setRaw('directory_last_ping', new Date().toISOString());
      return ok(res, { ...results, shares: repo.listShares() });
    }

    // POST /api/admin/directory/connect { code } — add a shop from an invite.
    if (parts[2] === 'connect' && method === 'POST') {
      const body = await readBody(req);
      // A shop is identified by its LINK now, not by a copied code. The code
      // still exists — it is what the peer record is built from — but nobody
      // types it: we ask the shop at that address for its own, which is also a
      // better check than trusting a blob somebody pasted.
      let code = body.code;
      if (!code && body.link) {
        code = await inviteCodeFromLink(body.link);
        if (!code) {
          return bad(res, `Could not read an invite from ${String(body.link).slice(0, 120)}. Check the link is right and that they have the community directory switched on.`);
        }
      }
      const invite = parseInvite(code);
      if (!invite) return bad(res, "That doesn't look like a Tech Garage shop link.");
      const d = settings.effective().directory;
      if (invite.node === d.nodePublicKey) return bad(res, "That's a link to your own shop.");

      // Verify before trusting: fetch the profile and confirm the shop at that
      // URL really is the node in the code. A code can be copied by anyone, so
      // the URL answering for itself is what makes it meaningful.
      const profile = await fetchProfile({ node: invite.node, url: invite.url });
      if (!profile) {
        return bad(res, `Could not reach ${invite.url}, or it isn't the shop this code claims. Check they have the community directory switched on.`);
      }
      repo.upsertPeer({
        node: profile.node, name: profile.name, tagline: profile.tagline,
        url: profile.url, region: profile.region, trusted: true, blocked: false,
        mutual: connectionState(d.nodePublicKey, profile) === 'mutual',
      });
      return ok(res, { peer: repo.getPeer(profile.node), peers: repo.listPeers() });
    }

    // GET /api/admin/directory/connections — friends + friend-of-friend suggestions
    if (parts[2] === 'connections' && method === 'GET') {
      const eff = settings.effective();
      const r = await syncConnections();
      return ok(res, {
        ...r,
        peers: repo.listPeers(),
        invite: buildInvite({
          node: eff.directory.nodePublicKey,
          url: eff.site.url || PUBLIC_ORIGIN,
          name: eff.brand.name,
        }),
        connectUrl: `${eff.site.url || PUBLIC_ORIGIN}/connect`,
        shareConnections: eff.directory.shareConnections,
      });
    }

    // POST /api/admin/directory/dismiss { node } — stop suggesting this shop
    if (parts[2] === 'dismiss' && method === 'POST') {
      const body = await readBody(req);
      if (!body.node) return bad(res, 'A node id is required.');
      repo.dismissSuggestion(String(body.node));
      return ok(res, { dismissed: true });
    }

    // Peers: a friend's shop, added by node id from an invite.
    if (parts[2] === 'peers') {
      if (method === 'POST') {
        const body = await readBody(req);
        const node = String(body.node || '').trim();
        if (!node) return bad(res, 'A node id is required.');
        let looked = null;
        try { looked = await lookupNode(settings.effective().directory, node); } catch { /* offline is fine */ }
        const peer = repo.upsertPeer({
          node,
          name: body.name || looked?.name || null,
          url: body.url || looked?.url || null,
          region: looked?.region || null,
          trusted: body.trusted !== false,
          blocked: Boolean(body.blocked),
        });
        return ok(res, { peer, peers: repo.listPeers() });
      }
      if (method === 'DELETE' && parts[3]) {
        repo.removePeer(decodeURIComponent(parts[3]));
        return ok(res, { peers: repo.listPeers() });
      }
    }
  }

  // /api/admin/storefront — condition wording + shopper-facing options
  if (sub === 'storefront') {
    if (method === 'GET') {
      const e = settings.effective();
      return ok(res, { conditionNotes: e.conditionNotes, shop: e.shop });
    }
    if (method === 'PUT' || method === 'POST') {
      const body = await readBody(req);
      if (body.conditionNotes) settings.setConditionNotes(body.conditionNotes);
      if (body.shop) settings.updateShopOptions(body.shop);
      const e = settings.effective();
      return ok(res, { conditionNotes: e.conditionNotes, shop: e.shop });
    }
  }

  // /api/admin/theme — colour scheme. Six presets; per-colour overrides are
  // part of the paid upgrade and have no implementation here, so a `custom`
  // payload is refused outright rather than quietly dropped.
  if (sub === 'theme') {
    if (parts.length === 2 && method === 'GET') {
      const s = settings.effective();
      return ok(res, { theme: s.theme, edition: s.edition, upgrade: s.upgrade, presets: presetList() });
    }
    if (parts.length === 2 && (method === 'PUT' || method === 'POST')) {
      const body = await readBody(req);
      if (body.custom && Object.keys(body.custom).length) {
        return bad(res, 'Setting individual colours is part of the Pro upgrade and is not included in this build — pick one of the built-in schemes.');
      }
      return ok(res, { theme: settings.updateTheme(body) });
    }
  }

  // /api/admin/landing — edit the landing-page sample deals
  if (sub === 'landing') {
    if (parts.length === 2 && method === 'GET') return ok(res, { deals: settings.getLandingDeals() });
    // GET /api/admin/landing/items — for-sale inventory to pick from for a linked deal
    if (parts[2] === 'items' && method === 'GET') return ok(res, repo.shopItems());
    if (parts.length === 2 && (method === 'PUT' || method === 'POST')) {
      const body = await readBody(req);
      return ok(res, { deals: settings.setLandingDeals(body.deals || []) });
    }
    // POST /api/admin/landing/image  (raw image body) -> upload a deal picture
    if (parts[2] === 'image' && method === 'POST') {
      const mime = (req.headers['content-type'] || '').split(';')[0].trim();
      if (!images.isAllowedMime(mime)) return bad(res, 'unsupported image type (JPEG, PNG, WebP, GIF)');
      try {
        const buffer = await readRawBody(req);
        const asset = images.saveAsset({ buffer, mime });
        return created(res, { id: asset.id, url: `/api/landing/media/${asset.id}` });
      } catch (e) { return bad(res, e.message); }
    }
    // DELETE /api/admin/landing/image/:id
    if (parts[2] === 'image' && Number.isInteger(Number(parts[3])) && method === 'DELETE') {
      return images.deleteAsset(Number(parts[3])) ? ok(res, { deleted: true }) : notFound(res, 'image not found');
    }
  }

  // POST /api/admin/test-channel — send a test over the selected channel
  if (sub === 'test-channel' && method === 'POST') {
    const summary = await notifyText('✅ Test message from your inventory admin panel.');
    return ok(res, { summary });
  }

  // POST /api/admin/test-email — verify SMTP by emailing the admin address
  if (sub === 'test-email' && method === 'POST') {
    const email = settings.effective().notify.email;
    const to = auth.ownerAdminEmail();
    if (!email.enabled) return bad(res, 'SMTP is not configured yet (need at least Host and From, then Save).');
    if (!to) return bad(res, 'No admin email set. Add yours under the ⚙ Account menu first.');
    try {
      await sendMail(email, {
        from: email.from, to,
        subject: 'Test email from your inventory app',
        html: '<p>✅ Your SMTP settings are working — password‑reset and purchase emails will be delivered.</p>',
        text: 'Your SMTP settings are working.',
      });
      return ok(res, { ok: true, to });
    } catch (e) {
      return bad(res, `Send failed: ${e.message}`);
    }
  }

  // /api/admin/waitlist — public signups
  if (sub === 'waitlist') {
    if (parts.length === 2 && method === 'GET') return ok(res, repo.listWaitlist());
    const id = Number(parts[2]);
    // POST /api/admin/waitlist/:id/approve — invite them in + send a welcome email
    if (Number.isInteger(id) && parts[3] === 'approve' && method === 'POST') {
      const entry = repo.getWaitlist(id);
      if (!entry) return notFound(res, 'entry not found');
      const { token, expires } = auth.createInvite({ name: entry.name, email: entry.email, phone: entry.phone });
      const base = `${isSecure(req) ? 'https' : 'http'}://${req.headers.host}`;
      const link = `${base}/invite/${token}`;
      repo.setWaitlistStatus(id, 'approved');
      // Best-effort welcome email carrying the invite link.
      const eff = settings.effective();
      const email = eff.notify.email;
      let emailed = false, emailError = null;
      if (!entry.email) emailError = 'no email on file';
      else if (!email.enabled) emailError = 'SMTP not configured';
      else {
        const vars = { name: entry.name || 'there', link, brand: eff.brand.name };
        try {
          await sendMail(email, {
            from: email.from, to: entry.email,
            subject: settings.renderTemplate(eff.welcomeEmail.subject, vars),
            html: settings.renderTemplate(eff.welcomeEmail.html, vars),
            text: `You're invited to ${eff.brand.name}. Set up your account (valid 14 days): ${link}`,
          });
          emailed = true;
        } catch (e) { emailError = e.message; }
      }
      return ok(res, { link, expires, emailed, emailError });
    }
    // POST /api/admin/waitlist/:id/decline — mark declined but keep the record
    if (Number.isInteger(id) && parts[3] === 'decline' && method === 'POST') {
      const entry = repo.setWaitlistStatus(id, 'declined');
      return entry ? ok(res, { status: 'declined' }) : notFound(res, 'entry not found');
    }
    if (Number.isInteger(id) && method === 'DELETE') {
      return repo.deleteWaitlist(id) ? ok(res, { deleted: true }) : notFound(res, 'entry not found');
    }
  }

  return notFound(res, 'unknown admin endpoint');
}

// Notify stock subscribers about an availability change. Best-effort, async.
// event: 'new' | 'available' | 'sold'.
function fireStockNotify(req, item, event) {
  try {
    const recipients = event === 'new' ? repo.storeSubscribers() : repo.subscribersForItem(item.id);
    if (!recipients.length) return;
    const title = item.title || 'An item';
    const base = `${isSecure(req) ? 'https' : 'http'}://${req.headers.host}`;
    const link = `${base}/shop`;
    const copy = {
      new: { subject: `New stock: ${title}`, line: `${title} was just listed and is now available.` },
      available: { subject: `Back in stock: ${title}`, line: `${title} is available again.` },
      sold: { subject: `Sold: ${title}`, line: `${title} has just sold and is no longer available.` },
    }[event];
    if (!copy) return;
    const safe = String(copy.line).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
    const html = `<div style="font-family:system-ui,sans-serif"><p>${safe}</p><p><a href="${link}">View the store →</a></p></div>`;
    const plain = `${copy.line}\nView the store: ${link}`;
    notifySubscribers(recipients, { subject: copy.subject, html, text: plain }).catch(() => {});
  } catch (e) { console.error('stock notify failed:', e.message); }
}

// Resolve a stored landing "deal" into the card the landing page renders.
// Manual deals just get their uploaded image mapped to a URL. Inventory-linked
// deals (itemId set) pull live title/spec/price/photo from the current item and
// are dropped entirely once the item is no longer for sale — so the landing ad
// only ever shows real, available stock.
function resolveLandingDeal(d) {
  if (d.itemId) {
    const it = repo.shopItem(d.itemId);
    if (!it) return null; // sold / hidden / gone — don't advertise it any more
    const sp = it.specs && typeof it.specs === 'object' ? it.specs : {};
    const specLine = ['cpu', 'ram', 'storage', 'gpu', 'screen', 'os'].map((k) => sp[k]).filter(Boolean).join(' · ');
    return {
      itemId: it.id,
      live: true,
      title: it.title,
      spec: d.spec || specLine || [it.brand, it.model].filter(Boolean).join(' '),
      was: d.was ?? null,
      now: it.price,
      icon: d.icon || '💻',
      image: it.images && it.images.length ? `/api/public/item/${it.id}/image` : null,
    };
  }
  return { ...d, image: d.image ? `/api/landing/media/${d.image}` : null };
}

function buildQueryForItem(item) {
  const specs = item.specs && typeof item.specs === 'object' ? item.specs : {};
  return [item.brand, item.model, item.title, specs.cpu, specs.ram, specs.storage]
    .filter(Boolean)
    .join(' ')
    .slice(0, 120) || item.title;
}

function persistComps(itemId, query, comps) {
  const del = db.prepare('DELETE FROM price_comps WHERE item_id = ?');
  del.run(itemId);
  const ins = db.prepare(
    `INSERT INTO price_comps (item_id, source, query, title, price, currency, condition, sold, sold_date, url, image)
     VALUES ($item_id,$source,$query,$title,$price,$currency,$condition,$sold,$sold_date,$url,$image)`
  );
  for (const row of [...comps.active, ...comps.sold]) {
    ins.run({
      item_id: itemId,
      source: row.source,
      query,
      title: row.title,
      price: row.price,
      currency: row.currency || 'USD',
      condition: row.condition,
      sold: row.sold ? 1 : 0,
      sold_date: row.sold_date || null,
      url: row.url,
      image: row.image,
    });
  }
}

function seedSampleData() {
  const existing = db.prepare('SELECT COUNT(*) AS n FROM items').get();
  if (existing.n > 0) return 0;
  const samples = [
    {
      title: 'Dell Latitude 7420 i7 refurb', category: 'laptop', brand: 'Dell', model: 'Latitude 7420',
      specs: { cpu: 'Core i7-1185G7', ram: '16GB', storage: '512GB NVMe', screen: '14"' },
      condition: 'refurbished', status: 'listed', acquisition_cost: 180, acquired_date: '2026-05-02',
      listing_price: 430, shipping_cost: 18, target_margin: 0.3,
      costs: [
        { description: 'Replacement battery', amount: 42, category: 'part', cost_date: '2026-05-05' },
        { description: 'Windows reinstall + testing', amount: 15, category: 'labor', cost_date: '2026-05-06' },
      ],
    },
    {
      title: 'Custom Ryzen 5 gaming desktop', category: 'desktop', brand: 'Custom', model: 'Ryzen 5 5600 / RTX 3060',
      specs: { cpu: 'Ryzen 5 5600', ram: '32GB', storage: '1TB NVMe', gpu: 'RTX 3060' },
      condition: 'used', status: 'in_stock', acquisition_cost: 340, acquired_date: '2026-06-10',
      listing_price: 720, shipping_cost: 45, target_margin: 0.25,
      costs: [
        { description: 'New thermal paste + clean', amount: 8, category: 'part' },
        { description: 'PSU replacement', amount: 65, category: 'part' },
      ],
    },
    {
      title: 'Lenovo ThinkPad T480 i5', category: 'laptop', brand: 'Lenovo', model: 'ThinkPad T480',
      specs: { cpu: 'Core i5-8350U', ram: '16GB', storage: '256GB SSD', screen: '14"' },
      condition: 'used', status: 'sold', acquisition_cost: 120, acquired_date: '2026-03-15',
      sold_price: 315, sold_date: '2026-04-20', shipping_cost: 16, target_margin: 0.3,
      costs: [{ description: 'Keyboard replacement', amount: 22, category: 'part' }],
    },
    {
      title: 'HP EliteDesk 800 G4 SFF', category: 'desktop', brand: 'HP', model: 'EliteDesk 800 G4',
      specs: { cpu: 'Core i5-8500', ram: '16GB', storage: '512GB SSD' },
      condition: 'refurbished', status: 'sold', acquisition_cost: 95, acquired_date: '2026-04-01',
      sold_price: 240, sold_date: '2026-05-18', shipping_cost: 20, target_margin: 0.3,
      costs: [{ description: 'RAM upgrade to 16GB', amount: 28, category: 'part' }],
    },
    {
      title: 'NVIDIA RTX 3070 Founders', category: 'component', brand: 'NVIDIA', model: 'RTX 3070 FE',
      specs: { gpu: 'RTX 3070', vram: '8GB' },
      condition: 'used', status: 'sold', acquisition_cost: 210, acquired_date: '2026-05-20',
      sold_price: 330, sold_date: '2026-06-25', shipping_cost: 14, target_margin: 0.2,
      costs: [{ description: 'Fan bearing replacement', amount: 12, category: 'part' }],
    },
  ];
  let n = 0;
  for (const s of samples) {
    const { costs = [], ...itemData } = s;
    const item = repo.createItem(itemData);
    for (const c of costs) repo.addCost(item.id, c);
    n++;
  }
  return n;
}

async function requestHandler(req, res) {
  // A client that disconnects mid-response emits a socket error; swallowing it
  // here keeps a broken pipe from becoming an uncaught 'error' that exits Node.
  req.on('error', (e) => console.error('Request stream error:', e.message));
  res.on('error', (e) => console.error('Response stream error:', e.message));
  try {
    const proto = req.socket.encrypted ? 'https' : 'http';
    const url = new URL(req.url, `${proto}://${req.headers.host || 'localhost'}`);
    if (url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url);
    } else {
      await serveStatic(req, res, url.pathname);
    }
  } catch (err) {
    console.error('Request error:', err);
    try {
      if (!res.headersSent) send(res, 500, { error: err.message || 'internal error' });
    } catch { /* client already gone */ }
  }
}

const useTls = config.tls.enabled;
let server;
if (useTls) {
  const tlsOptions = { cert: readFileSync(config.tls.certFile), key: readFileSync(config.tls.keyFile) };
  server = https.createServer(tlsOptions, requestHandler);
} else {
  server = http.createServer(requestHandler);
}

// Malformed HTTP or a low-level socket problem must not take the server down.
server.on('clientError', (err, socket) => {
  try {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  } catch { /* ignore */ }
});
server.on('error', (err) => console.error('Server error:', err));

// Last-resort guards: log and keep serving rather than crash the whole process.
// systemd's Restart=on-failure would recover a crash, but staying up is better.
process.on('uncaughtException', (err) => console.error('Uncaught exception (continuing):', err));
process.on('unhandledRejection', (err) => console.error('Unhandled rejection (continuing):', err));

server.listen(config.port, () => {
  const proto = useTls ? 'https' : 'http';
  console.log(`\n  Inventory Management running at ${proto}://localhost:${config.port}`);
  console.log(`  TLS:             ${useTls ? 'on (HTTPS)' : 'off (HTTP — run ./gen-cert.sh then restart)'}`);
  console.log(`  eBay provider:   ${config.ebay.enabled ? 'live' : 'demo (no credentials)'}`);
  console.log(`  Amazon provider: ${config.amazon.enabled ? 'live' : 'demo (no credentials)'}`);
  console.log(`  Edition:         ${edition.describe()} — free build, no premium modules`);
  console.log(`  Upgrade:         ${upgrade.upgradeUrl() || 'get in touch (no self-service upgrade yet)'}\n`);
});

// Optional plain-HTTP listener that redirects everything to HTTPS.
if (useTls && config.httpRedirectPort) {
  http
    .createServer((req, res) => {
      const host = (req.headers.host || 'localhost').split(':')[0];
      const suffix = config.port === 443 ? '' : `:${config.port}`;
      res.writeHead(301, { Location: `https://${host}${suffix}${req.url}` });
      res.end();
    })
    .listen(config.httpRedirectPort, () => {
      console.log(`  HTTP→HTTPS redirect on port ${config.httpRedirectPort}\n`);
    });
}

export { server, seedSampleData };
