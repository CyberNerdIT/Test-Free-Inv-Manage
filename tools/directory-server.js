#!/usr/bin/env node
// Reference Tech Garage community directory.
//
//   node tools/directory-server.js            # port 4000, data in ./data/directory.db
//   PORT=4000 DIR_DB=/var/lib/tg/dir.db node tools/directory-server.js
//
// This is the other half of the community feature: somewhere for shops to
// register and publish listings, and for their storefronts to ask "who near me
// sells SSDs?". It is a small, single-file, zero-dependency service using the
// same node:http + node:sqlite stack as the app, so anyone can run their own.
//
// Design notes, because a directory is a trust boundary:
//
//   * Every write is SIGNED by the publishing node and verified here. Nobody
//     can publish as, or delist for, a shop they do not hold the key to.
//   * Domain ownership is CHECKED, not claimed: the directory fetches
//     /api/directory/verify from the URL a node registers and confirms it
//     returns that node's own id. Otherwise anyone could register a rival's
//     domain, or a phishing page under a trusted-looking name.
//   * Everything a node sends is treated as untrusted and clamped before it is
//     stored — this server hands that data straight to other people's shops.
import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { verifyPayload, normalizeRegion, regionDistance, sanitizeRemoteListing } from '../src/services/directory.js';

const PORT = Number(process.env.PORT) || 4000;
const DB_PATH = process.env.DIR_DB || './data/directory.db';
// Off by default in local testing; ON in anything resembling production.
const VERIFY_DOMAIN = process.env.DIR_VERIFY_DOMAIN !== 'false';

if (DB_PATH !== ':memory:') mkdirSync(dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL;');
db.exec(`
CREATE TABLE IF NOT EXISTS nodes (
  node        TEXT PRIMARY KEY,
  name        TEXT, tagline TEXT, url TEXT, contact TEXT,
  country     TEXT, state TEXT, area TEXT, postal_prefix TEXT,
  categories  TEXT, item_count INTEGER DEFAULT 0,
  verified    INTEGER DEFAULT 0,
  verify_note TEXT,
  blocked     INTEGER DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS listings (
  ref         TEXT PRIMARY KEY,
  node        TEXT NOT NULL REFERENCES nodes(node) ON DELETE CASCADE,
  title       TEXT, category TEXT, condition TEXT, brand TEXT, model TEXT,
  price       REAL, currency TEXT DEFAULT 'USD', quantity INTEGER DEFAULT 1,
  url         TEXT, image TEXT,
  country     TEXT, state TEXT, area TEXT,
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_listings_region ON listings(country, state, area);
CREATE INDEX IF NOT EXISTS idx_listings_cat ON listings(category);
`);

const send = (res, code, body) => {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
  res.end(text);
};
const bad = (res, msg, code = 400) => send(res, code, { error: msg });

const readRaw = (req) => new Promise((resolve, reject) => {
  let d = '';
  req.on('data', (c) => { d += c; if (d.length > 200_000) reject(new Error('payload too large')); });
  req.on('end', () => resolve(d));
  req.on('error', reject);
});

/**
 * Authenticate a write. The signature covers the exact bytes received, so the
 * raw body is verified before it is parsed — the same discipline the app uses
 * for payment webhooks.
 */
function authed(req, raw) {
  const node = req.headers['x-tg-node'];
  const sig = req.headers['x-tg-signature'];
  if (!node || !sig) return { ok: false, reason: 'missing node id or signature' };
  const v = verifyPayload(node, raw, sig);
  if (!v.ok) return v;
  // The body must claim the same node that signed it, or a valid signature
  // could be used to publish under someone else's name.
  if (v.body.node && v.body.node !== node) return { ok: false, reason: 'node mismatch between header and body' };
  const row = db.prepare('SELECT blocked FROM nodes WHERE node = ?').get(node);
  if (row?.blocked) return { ok: false, reason: 'this node is blocked' };
  return { ok: true, node, body: v.body };
}

/**
 * Confirm the registering shop actually controls the URL it claims, by asking
 * that URL who it is. A directory that skips this is a phishing vector.
 */
async function verifyDomain(node, url) {
  if (!VERIFY_DOMAIN) return { verified: 1, note: 'domain verification disabled' };
  if (!url) return { verified: 0, note: 'no URL supplied' };
  try {
    const target = new URL('/api/directory/verify', url);
    if (!/^https?:$/.test(target.protocol)) return { verified: 0, note: 'unsupported URL scheme' };
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    const res = await fetch(target.href, { signal: ctrl.signal, headers: { Accept: 'application/json' } });
    clearTimeout(t);
    if (!res.ok) return { verified: 0, note: `site responded ${res.status}` };
    const json = await res.json();
    return json?.node === node
      ? { verified: 1, note: 'ownership confirmed' }
      : { verified: 0, note: 'the site did not return this node id' };
  } catch (e) {
    return { verified: 0, note: `could not reach the site: ${e.message}` };
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const path = url.pathname;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, X-TG-Node, X-TG-Signature',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    });
    return res.end();
  }

  try {
    if (path === '/api/health') {
      const n = db.prepare('SELECT COUNT(*) c FROM nodes').get().c;
      const l = db.prepare('SELECT COUNT(*) c FROM listings').get().c;
      return send(res, 200, { ok: true, nodes: n, listings: l, verifyDomain: VERIFY_DOMAIN });
    }

    // ---- register / update a shop ----
    if (path === '/api/nodes/register' && req.method === 'POST') {
      const raw = await readRaw(req);
      const a = authed(req, raw);
      if (!a.ok) return bad(res, a.reason, 401);
      const b = a.body;
      const region = normalizeRegion(b.region);
      if (!region.country) return bad(res, 'a country is required');

      const { verified, note } = await verifyDomain(a.node, b.url);
      db.prepare(`
        INSERT INTO nodes (node, name, tagline, url, contact, country, state, area, postal_prefix, categories, item_count, verified, verify_note, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?, datetime('now'))
        ON CONFLICT(node) DO UPDATE SET
          name=excluded.name, tagline=excluded.tagline, url=excluded.url, contact=excluded.contact,
          country=excluded.country, state=excluded.state, area=excluded.area, postal_prefix=excluded.postal_prefix,
          categories=excluded.categories, item_count=excluded.item_count,
          verified=excluded.verified, verify_note=excluded.verify_note, updated_at=datetime('now')
      `).run(
        a.node, String(b.name || '').slice(0, 80), String(b.tagline || '').slice(0, 160),
        String(b.url || '').slice(0, 300), String(b.contact || '').slice(0, 200),
        region.country, region.state, region.area, region.postalPrefix,
        JSON.stringify((b.categories || []).slice(0, 20)),
        Math.max(0, Math.floor(Number(b.itemCount) || 0)),
        verified, note,
      );
      return send(res, 200, { ok: true, node: a.node, verified: Boolean(verified), note });
    }

    // ---- publish a listing ----
    if (path === '/api/listings/publish' && req.method === 'POST') {
      const raw = await readRaw(req);
      const a = authed(req, raw);
      if (!a.ok) return bad(res, a.reason, 401);
      const node = db.prepare('SELECT * FROM nodes WHERE node = ?').get(a.node);
      if (!node) return bad(res, 'register the shop before publishing listings');
      // Unverified shops may register but not publish: an unchecked listing
      // pointing anywhere is exactly the abuse this directory must not carry.
      if (!node.verified) return bad(res, `shop not verified: ${node.verify_note || 'ownership unconfirmed'}`, 403);

      const clean = sanitizeRemoteListing({ ...a.body, node: a.node });
      if (!clean) return bad(res, 'listing failed validation (needs a title, a positive price and an http(s) URL)');
      const region = normalizeRegion(a.body.region);
      const ref = String(a.body.ref || '').slice(0, 80);
      if (!ref) return bad(res, 'a listing ref is required');
      // A ref must belong to the node publishing it, so one shop cannot
      // overwrite another's listing by guessing its ref.
      const owner = db.prepare('SELECT node FROM listings WHERE ref = ?').get(ref);
      if (owner && owner.node !== a.node) return bad(res, 'that ref belongs to another shop', 403);

      db.prepare(`
        INSERT INTO listings (ref, node, title, category, condition, brand, model, price, currency, quantity, url, image, country, state, area, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, datetime('now'))
        ON CONFLICT(ref) DO UPDATE SET
          title=excluded.title, category=excluded.category, condition=excluded.condition,
          brand=excluded.brand, model=excluded.model, price=excluded.price, currency=excluded.currency,
          quantity=excluded.quantity, url=excluded.url, image=excluded.image,
          country=excluded.country, state=excluded.state, area=excluded.area, updated_at=datetime('now')
      `).run(
        ref, a.node, clean.title, clean.category, clean.condition, clean.brand,
        String(a.body.model || '').slice(0, 60) || null,
        clean.price, clean.currency, Math.max(1, Math.floor(Number(a.body.quantity) || 1)),
        clean.url, clean.image, region.country, region.state, region.area,
      );
      return send(res, 200, { ok: true, ref });
    }

    // ---- delist ----
    if (path === '/api/listings/delist' && req.method === 'POST') {
      const raw = await readRaw(req);
      const a = authed(req, raw);
      if (!a.ok) return bad(res, a.reason, 401);
      const ref = String(a.body.ref || '');
      // Scoped by node: you can only remove your own listings.
      const r = db.prepare('DELETE FROM listings WHERE ref = ? AND node = ?').run(ref, a.node);
      return send(res, 200, { ok: true, removed: r.changes });
    }

    // ---- nearby feed (public read) ----
    if (path === '/api/listings/nearby' && req.method === 'GET') {
      const country = (url.searchParams.get('country') || '').toUpperCase();
      if (!country) return bad(res, 'country is required');
      const exclude = url.searchParams.get('exclude') || '';
      const limit = Math.min(Number(url.searchParams.get('limit')) || 12, 50);
      const me = normalizeRegion({
        country, state: url.searchParams.get('state'), area: url.searchParams.get('area'),
      });

      const rows = db.prepare(`
        SELECT l.*, n.name AS shop_name FROM listings l
        JOIN nodes n ON n.node = l.node
        WHERE l.country = ? AND l.node != ? AND n.verified = 1 AND n.blocked = 0
        ORDER BY l.updated_at DESC LIMIT 400
      `).all(country, exclude);

      const listings = rows
        .map((r) => ({
          ref: r.ref, node: r.node, shopName: r.shop_name,
          title: r.title, category: r.category, condition: r.condition, brand: r.brand,
          price: r.price, currency: r.currency, url: r.url, image: r.image,
          region: { country: r.country, state: r.state, area: r.area },
          distance: regionDistance(me, { country: r.country, state: r.state, area: r.area }),
        }))
        .sort((a, b) => b.distance - a.distance)
        .slice(0, limit);
      return send(res, 200, { listings });
    }

    // ---- look one shop up (public read) ----
    if (path === '/api/nodes/lookup' && req.method === 'GET') {
      const r = db.prepare('SELECT node, name, url, country, state, area, verified FROM nodes WHERE node = ?')
        .get(url.searchParams.get('node') || '');
      if (!r) return bad(res, 'unknown node', 404);
      return send(res, 200, {
        node: { node: r.node, name: r.name, url: r.url, verified: Boolean(r.verified),
                region: { country: r.country, state: r.state, area: r.area } },
      });
    }

    // ---- directory of shops (public read) ----
    if (path === '/api/nodes' && req.method === 'GET') {
      const country = (url.searchParams.get('country') || '').toUpperCase();
      const rows = country
        ? db.prepare('SELECT * FROM nodes WHERE verified = 1 AND blocked = 0 AND country = ? ORDER BY updated_at DESC LIMIT 200').all(country)
        : db.prepare('SELECT * FROM nodes WHERE verified = 1 AND blocked = 0 ORDER BY updated_at DESC LIMIT 200').all();
      return send(res, 200, {
        nodes: rows.map((r) => ({
          node: r.node, name: r.name, tagline: r.tagline, url: r.url,
          region: { country: r.country, state: r.state, area: r.area },
          categories: JSON.parse(r.categories || '[]'), itemCount: r.item_count,
        })),
      });
    }

    return bad(res, 'not found', 404);
  } catch (e) {
    console.error('[directory]', e);
    return bad(res, 'internal error', 500);
  }
});

server.listen(PORT, () => {
  console.log(`Tech Garage directory listening on :${PORT}  (db ${DB_PATH}, domain verification ${VERIFY_DOMAIN ? 'ON' : 'OFF'})`);
});
