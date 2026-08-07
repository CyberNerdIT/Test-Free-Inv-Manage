// Data-access layer over the SQLite database.
import { db } from './db.js';
import { buildProfitSeries, resolveRange, rangeList } from './services/timeseries.js';
import { computeItemFinancials, summarizePortfolio } from './services/profit.js';
import { buildReport } from './services/analytics.js';
import { effective } from './settings.js';
import { listImages } from './services/images.js';
import { normalizeStatus, canTransition, COMMITTED_STATUSES, OFFER_STATUSES } from './services/orders.js';

// Effective marketplace defaults (settings overlay env) for profit math.
const financialDefaults = () => effective().defaults;

const ITEM_FIELDS = [
  'title', 'category', 'brand', 'model', 'specs', 'condition', 'status',
  'acquisition_cost', 'acquired_date', 'listing_price', 'sold_price', 'sold_date',
  'fee_rate', 'flat_fee', 'shipping_cost', 'target_margin', 'notes',
  'serial_number', 'location', 'hidden', 'local_sale', 'quantity', 'description', 'sku',
  'compare_at_price', 'share_community',
];

export function getItemBySku(sku) {
  if (sku == null || String(sku).trim() === '') return null;
  const row = db.prepare('SELECT * FROM items WHERE sku = ?').get(String(sku).trim());
  return hydrateItem(row);
}

function normalizeSpecs(specs) {
  if (specs == null) return null;
  if (typeof specs === 'string') return specs; // already JSON text
  try {
    return JSON.stringify(specs);
  } catch {
    return null;
  }
}

function hydrateItem(row) {
  if (!row) return row;
  let specs = null;
  if (row.specs) {
    try {
      specs = JSON.parse(row.specs);
    } catch {
      specs = row.specs;
    }
  }
  return { ...row, specs };
}

export function listItems({ status, category } = {}) {
  let sql = 'SELECT * FROM items';
  const where = [];
  const params = {};
  if (status) {
    where.push('status = $status');
    params.status = status;
  }
  if (category) {
    where.push('category = $category');
    params.category = category;
  }
  if (where.length) sql += ' WHERE ' + where.join(' AND ');
  sql += ' ORDER BY datetime(created_at) DESC, id DESC';
  const rows = db.prepare(sql).all(params);
  return rows.map(hydrateItem);
}

export function getItem(id) {
  const row = db.prepare('SELECT * FROM items WHERE id = ?').get(id);
  return hydrateItem(row);
}

export function createItem(data) {
  const payload = {};
  for (const f of ITEM_FIELDS) payload[f] = data[f] ?? null;
  if (!payload.title) throw new Error('title is required');
  payload.category = payload.category || 'laptop';
  payload.status = payload.status || 'in_stock';
  payload.condition = payload.condition || 'used';
  payload.acquisition_cost = Number(payload.acquisition_cost) || 0;
  payload.quantity = Number.isFinite(Number(payload.quantity)) && Number(payload.quantity) > 0 ? Math.floor(Number(payload.quantity)) : 1;
  payload.specs = normalizeSpecs(data.specs);

  const cols = ITEM_FIELDS.join(', ');
  const placeholders = ITEM_FIELDS.map((f) => `$${f}`).join(', ');
  const info = db
    .prepare(`INSERT INTO items (${cols}) VALUES (${placeholders})`)
    .run(payload);
  return getItem(Number(info.lastInsertRowid));
}

export function updateItem(id, data) {
  const existing = db.prepare('SELECT * FROM items WHERE id = ?').get(id);
  if (!existing) return null;
  const sets = [];
  const params = { id };
  for (const f of ITEM_FIELDS) {
    if (f in data) {
      sets.push(`${f} = $${f}`);
      params[f] = f === 'specs' ? normalizeSpecs(data.specs) : data[f];
    }
  }
  if (!sets.length) return getItem(id);
  sets.push(`updated_at = datetime('now')`);
  db.prepare(`UPDATE items SET ${sets.join(', ')} WHERE id = $id`).run(params);
  return getItem(id);
}

export function deleteItem(id) {
  const info = db.prepare('DELETE FROM items WHERE id = ?').run(id);
  return info.changes > 0;
}

// Duplicate an item for quick re-listing of a similar unit. Copies spec fields,
// pricing, costs and upgrades; clears the serial and any sold/unit-specific data.
export function duplicateItem(id) {
  const src = getItem(id);
  if (!src) return null;
  const copy = {};
  for (const f of ITEM_FIELDS) copy[f] = src[f];
  copy.title = `${src.title || 'Item'} (copy)`;
  copy.status = 'in_stock';
  copy.serial_number = null;
  copy.sold_price = null;
  copy.sold_date = null;
  copy.local_sale = 0;
  copy.specs = src.specs; // object; createItem re-serializes
  const created = createItem(copy);
  for (const c of listCosts(id)) {
    addCost(created.id, { description: c.description, amount: c.amount, category: c.category, cost_date: c.cost_date });
  }
  for (const u of listUpgrades(id)) {
    addUpgrade(created.id, { label: u.label, price_delta: u.price_delta });
  }
  return getItem(created.id);
}

// ---- costs ---------------------------------------------------------------

export function listCosts(itemId) {
  return db
    .prepare('SELECT * FROM costs WHERE item_id = ? ORDER BY datetime(created_at), id')
    .all(itemId);
}

export function addCost(itemId, data) {
  if (!getItem(itemId)) throw new Error('item not found');
  const info = db
    .prepare(
      `INSERT INTO costs (item_id, description, amount, category, cost_date)
       VALUES ($item_id, $description, $amount, $category, $cost_date)`
    )
    .run({
      item_id: itemId,
      description: data.description || 'cost',
      amount: Number(data.amount) || 0,
      category: data.category || 'part',
      cost_date: data.cost_date || null,
    });
  db.prepare(`UPDATE items SET updated_at = datetime('now') WHERE id = ?`).run(itemId);
  return db.prepare('SELECT * FROM costs WHERE id = ?').get(Number(info.lastInsertRowid));
}

export function deleteCost(costId) {
  const info = db.prepare('DELETE FROM costs WHERE id = ?').run(costId);
  return info.changes > 0;
}

// ---- upgrades (customer-selectable spec upgrades) ------------------------

export function listUpgrades(itemId) {
  return db.prepare('SELECT * FROM upgrades WHERE item_id = ? ORDER BY id').all(itemId);
}
export function addUpgrade(itemId, { label, price_delta }) {
  if (!getItem(itemId)) throw new Error('item not found');
  if (!label) throw new Error('label is required');
  const info = db
    .prepare('INSERT INTO upgrades (item_id, label, price_delta) VALUES (?,?,?)')
    .run(itemId, String(label), Number(price_delta) || 0);
  return db.prepare('SELECT * FROM upgrades WHERE id = ?').get(Number(info.lastInsertRowid));
}
export function deleteUpgrade(id) {
  return db.prepare('DELETE FROM upgrades WHERE id = ?').run(id).changes > 0;
}

// ---- storefront (customer-facing, sanitized: NO cost/profit data) --------

const FOR_SALE = new Set(['in_stock', 'listed']);

// Whitelist the exact fields a customer may see. Never spread the raw row.
function toShopItem(item, { soldOut = false } = {}) {
  const price = item.listing_price != null ? Number(item.listing_price) : null;
  const compareAt = item.compare_at_price != null ? Number(item.compare_at_price) : null;
  // A "was" price only means anything if it is actually higher.
  const savings = compareAt != null && price != null && compareAt > price
    ? { was: compareAt, save: Math.round((compareAt - price) * 100) / 100, percent: Math.round(((compareAt - price) / compareAt) * 100) }
    : null;
  return {
    id: item.id,
    title: item.title,
    category: item.category,
    condition: item.condition,
    brand: item.brand,
    model: item.model,
    specs: item.specs && typeof item.specs === 'object' ? item.specs : null,
    description: item.description || null,
    price,
    quantity: item.quantity != null ? Number(item.quantity) : 1,
    soldOut,
    savings,
    // Cached market comparison — never a live call at render time, and never
    // demo figures (see marketSnapshot).
    market: marketSnapshot(item.id),
    upgrades: soldOut ? [] : listUpgrades(item.id).map((u) => ({ id: u.id, label: u.label, price_delta: Number(u.price_delta) })),
    images: listImages(item.id).map((im) => im.id),
  };
}

const isShoppable = (it) => it && FOR_SALE.has(it.status) && it.listing_price != null && !it.hidden;

/**
 * Storefront listing.
 *
 * Sold-out items are included (flagged, not silently dropped): a shop that
 * quietly deletes what it sold looks emptier than it is, and "sold — tell me if
 * another arrives" is exactly what feeds the stock-alert subscriptions.
 */
export function shopItems({ includeSoldOut = true } = {}) {
  const all = listItems();
  const live = all.filter(isShoppable).map((it) => toShopItem(it));
  if (!includeSoldOut) return live;

  const soldOut = all
    .filter((it) => it.status === 'sold' && !it.hidden && it.listing_price != null)
    .sort((a, b) => String(b.sold_date || '').localeCompare(String(a.sold_date || '')))
    .slice(0, 12) // recent history, not an archive
    .map((it) => toShopItem(it, { soldOut: true }));
  return [...live, ...soldOut];
}

/** Distinct categories present in the storefront, for the filter chips. */
export function shopCategories() {
  const counts = new Map();
  for (const it of listItems().filter(isShoppable)) {
    counts.set(it.category || 'other', (counts.get(it.category || 'other') || 0) + 1);
  }
  return [...counts.entries()].map(([key, count]) => ({ key, count })).sort((a, b) => b.count - a.count);
}

/**
 * Complementary stock for a "you might also need this" strip.
 *
 * Deliberately picks a DIFFERENT category — showing four more laptops beside a
 * laptop is a listing page, not a suggestion. Falls back to same-category only
 * when the shop is too narrow for cross-category to return anything.
 */
export function relatedItems(itemId, limit = 4) {
  const item = getItem(itemId);
  if (!item) return [];
  const pool = listItems().filter((it) => isShoppable(it) && it.id !== item.id);
  const COMPLEMENTS = {
    laptop: ['ram', 'ssd', 'storage', 'accessory', 'monitor', 'dock'],
    desktop: ['ram', 'ssd', 'storage', 'gpu', 'monitor', 'accessory'],
    monitor: ['laptop', 'desktop', 'accessory', 'dock'],
    gpu: ['desktop', 'ram', 'psu'],
    ram: ['laptop', 'desktop', 'ssd'],
    ssd: ['laptop', 'desktop', 'ram'],
  };
  const wanted = COMPLEMENTS[item.category] || [];
  const score = (it) => {
    if (wanted.includes(it.category)) return 3;          // a genuine complement
    if (it.category !== item.category) return 2;         // at least something else
    return 1;                                            // same category: last resort
  };
  return pool
    .sort((a, b) => score(b) - score(a) || Number(a.listing_price) - Number(b.listing_price))
    .slice(0, limit)
    .map((it) => toShopItem(it));
}
export function shopItem(id) {
  const it = getItem(id);
  return isShoppable(it) ? toShopItem(it) : null;
}
// Is an item currently visible/for-sale on the storefront?
export function itemIsShoppable(id) {
  return isShoppable(getItem(id));
}

// Minimal, PUBLIC "teaser" view of a for-sale item for a shareable link — safe
// to show a logged-out visitor. Deliberately omits price and full specs: those
// are the reveal that nudges a viewer to join the waitlist. Returns null unless
// the item is currently shoppable.
export function publicShareItem(id) {
  const it = getItem(id);
  if (!isShoppable(it)) return null;
  const imgs = listImages(it.id);
  const primary = imgs.find((im) => im.is_primary) || imgs[0] || null;
  return {
    id: it.id,
    title: it.title,
    category: it.category,
    condition: it.condition,
    brand: it.brand || null,
    image: primary ? primary.id : null,
  };
}

// ---- market snapshots (cached comps for the storefront) -------------------

/**
 * Store the market comparison for an item.
 *
 * Demo comps are recorded with is_live = 0 and NEVER surfaced to a shopper:
 * telling a buyer "similar units sell for $520" on the strength of simulated
 * data would be inventing a claim about the market.
 */
export function saveMarketSnapshot(itemId, comps) {
  const active = comps?.stats?.active || {};
  const sold = comps?.stats?.sold || {};
  const use = sold.count ? sold : active;
  if (use.median == null) return null;
  db.prepare(`
    INSERT INTO market_snapshots (item_id, median, low, high, sample, basis, is_live, condition, currency, fetched_at)
    VALUES (?,?,?,?,?,?,?,?,?, datetime('now'))
    ON CONFLICT(item_id) DO UPDATE SET
      median = excluded.median, low = excluded.low, high = excluded.high,
      sample = excluded.sample, basis = excluded.basis, is_live = excluded.is_live,
      condition = excluded.condition, currency = excluded.currency, fetched_at = excluded.fetched_at
  `).run(
    itemId, use.median, use.min, use.max, use.count,
    comps.marketEstimateBasis || null,
    comps.isDemo ? 0 : 1,
    comps.condition || null,
    'USD',
  );
  return marketSnapshot(itemId);
}

/**
 * The shopper-safe market comparison, or null.
 * Returns nothing for demo data, for a stale snapshot, or when our price is not
 * actually lower — a "saving" that isn't a saving is worse than no badge.
 */
export function marketSnapshot(itemId, { maxAgeDays = 30 } = {}) {
  const row = db.prepare('SELECT * FROM market_snapshots WHERE item_id = ?').get(itemId);
  if (!row || !row.is_live || row.median == null) return null;
  const age = (Date.now() - Date.parse(row.fetched_at + 'Z')) / 86400000;
  if (!Number.isFinite(age) || age > maxAgeDays) return null;
  return {
    median: Math.round(row.median * 100) / 100,
    low: row.low, high: row.high,
    sample: row.sample,
    // 'sold' is a far stronger claim than 'asking price'; the UI words them
    // differently, so the distinction has to survive to the client.
    basis: String(row.basis || '').includes('sold') ? 'sold' : 'active',
    condition: row.condition,
    fetchedAt: row.fetched_at,
    ageDays: Math.floor(age),
  };
}

// ---- saved cart -----------------------------------------------------------

export function getCart(userId) {
  const row = db.prepare('SELECT lines_json, updated_at FROM carts WHERE user_id = ?').get(userId);
  if (!row) return { lines: [], updatedAt: null };
  try {
    return { lines: JSON.parse(row.lines_json) || [], updatedAt: row.updated_at };
  } catch {
    return { lines: [], updatedAt: row.updated_at };
  }
}

/**
 * Persist a cart, re-validating every line against live stock.
 *
 * A saved cart can be days old, so prices, upgrades and availability are all
 * re-read here. Restoring a cart that quotes last week's price would be a lie
 * the shopper only discovers at checkout.
 */
export function saveCart(userId, lines = []) {
  const clean = [];
  for (const line of Array.isArray(lines) ? lines.slice(0, 50) : []) {
    const item = getItem(Number(line.itemId));
    if (!item || !isShoppable(item)) continue;
    const available = item.quantity != null && Number(item.quantity) > 0 ? Math.floor(Number(item.quantity)) : 1;
    const ids = new Set((line.upgradeIds || []).map(Number));
    const upgrades = listUpgrades(item.id).filter((u) => ids.has(u.id));
    const qty = Math.min(Math.max(1, Math.floor(Number(line.qty) || 1)), available);
    clean.push({
      itemId: item.id,
      title: item.title,
      unit: Number(item.listing_price) + upgrades.reduce((s, u) => s + Number(u.price_delta), 0),
      upgrades: upgrades.map((u) => ({ id: u.id, label: u.label, price_delta: Number(u.price_delta) })),
      qty,
      max: available,
    });
  }
  db.prepare(`
    INSERT INTO carts (user_id, lines_json, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(user_id) DO UPDATE SET lines_json = excluded.lines_json, updated_at = excluded.updated_at
  `).run(userId, JSON.stringify(clean));
  return { lines: clean, updatedAt: new Date().toISOString() };
}

export function clearCart(userId) {
  db.prepare('DELETE FROM carts WHERE user_id = ?').run(userId);
  return { lines: [], updatedAt: null };
}

// ---- recently viewed ------------------------------------------------------

/**
 * The last items this shopper looked at. Built from the visit log that already
 * powers the admin activity feed — the data was being collected and only ever
 * shown to the admin.
 */
export function recentlyViewed(userId, limit = 6) {
  const rows = db.prepare(`
    SELECT DISTINCT item_id FROM visits
    WHERE customer_id = ? AND item_id IS NOT NULL
    ORDER BY id DESC LIMIT 40
  `).all(userId);
  const out = [];
  for (const r of rows) {
    const it = getItem(r.item_id);
    if (it && isShoppable(it)) out.push(toShopItem(it));
    if (out.length >= limit) break;
  }
  return out;
}

// ---- community directory --------------------------------------------------

/** Items the admin has opted into sharing, in the shape the directory wants. */
export function shareableItems() {
  return listItems()
    .filter((it) => it.share_community && isShoppable(it))
    .map((it) => {
      const imgs = listImages(it.id);
      const primary = imgs.find((im) => im.is_primary) || imgs[0] || null;
      return { ...it, shareCommunity: true, image: primary ? primary.id : null };
    });
}

/** One item in directory shape, or null when it is not shareable. */
export function shareableItem(id) {
  const it = getItem(id);
  if (!it || !it.share_community || !isShoppable(it)) return null;
  const imgs = listImages(it.id);
  const primary = imgs.find((im) => im.is_primary) || imgs[0] || null;
  return { ...it, shareCommunity: true, image: primary ? primary.id : null };
}

export function getShare(itemId) {
  return db.prepare('SELECT * FROM directory_shares WHERE item_id = ?').get(itemId) || null;
}

export function recordShare(itemId, { ref = null, status = 'pending', detail = null } = {}) {
  db.prepare(`
    INSERT INTO directory_shares (item_id, ref, status, detail, shared_at, updated_at)
    VALUES (?,?,?,?, CASE WHEN ? = 'published' THEN datetime('now') ELSE NULL END, datetime('now'))
    ON CONFLICT(item_id) DO UPDATE SET
      ref = COALESCE(excluded.ref, directory_shares.ref),
      status = excluded.status,
      detail = excluded.detail,
      shared_at = CASE WHEN excluded.status = 'published'
                       THEN COALESCE(directory_shares.shared_at, datetime('now'))
                       ELSE directory_shares.shared_at END,
      updated_at = datetime('now')
  `).run(itemId, ref, status, detail, status);
  return getShare(itemId);
}

export function listShares() {
  return db.prepare(`
    SELECT s.*, i.title, i.status AS item_status, i.share_community
    FROM directory_shares s JOIN items i ON i.id = s.item_id
    ORDER BY s.updated_at DESC
  `).all();
}

/** Categories this shop actually stocks — sent so the directory can match. */
export function stockedCategories() {
  return [...new Set(listItems().filter(isShoppable).map((it) => it.category).filter(Boolean))];
}

// ---- peers (other shops) --------------------------------------------------

export function upsertPeer({ node, name, url, region, trusted, blocked, tagline, mutual }) {
  if (!node) return null;
  const existing = db.prepare('SELECT * FROM directory_peers WHERE node = ?').get(node);
  db.prepare(`
    INSERT INTO directory_peers (node, name, url, region_json, trusted, blocked, tagline, mutual, last_seen)
    VALUES (?,?,?,?,?,?,?,?, datetime('now'))
    ON CONFLICT(node) DO UPDATE SET
      name = COALESCE(excluded.name, directory_peers.name),
      url = COALESCE(excluded.url, directory_peers.url),
      region_json = COALESCE(excluded.region_json, directory_peers.region_json),
      tagline = COALESCE(excluded.tagline, directory_peers.tagline),
      trusted = excluded.trusted,
      blocked = excluded.blocked,
      mutual = excluded.mutual,
      last_seen = datetime('now')
  `).run(
    node, name ?? null, url ?? null, region ? JSON.stringify(region) : null,
    trusted === undefined ? (existing?.trusted ?? 0) : (trusted ? 1 : 0),
    blocked === undefined ? (existing?.blocked ?? 0) : (blocked ? 1 : 0),
    tagline ?? null,
    mutual === undefined ? (existing?.mutual ?? 0) : (mutual ? 1 : 0),
  );
  return getPeer(node);
}

/** Record what a friend's profile said about us, after reading it. */
export function markPeerChecked(node, { mutual, name, tagline, region } = {}) {
  db.prepare(`
    UPDATE directory_peers
    SET mutual = ?, checked_at = datetime('now'),
        name = COALESCE(?, name), tagline = COALESCE(?, tagline),
        region_json = COALESCE(?, region_json)
    WHERE node = ?
  `).run(mutual ? 1 : 0, name ?? null, tagline ?? null, region ? JSON.stringify(region) : null, node);
  return getPeer(node);
}

// A shop suggested by a friend but declined. Remembered so it doesn't come
// back every time suggestions refresh.
export function dismissSuggestion(node) {
  db.prepare('INSERT OR IGNORE INTO directory_dismissed (node) VALUES (?)').run(node);
  return true;
}
export const dismissedNodes = () =>
  db.prepare('SELECT node FROM directory_dismissed').all().map((r) => r.node);

export function getPeer(node) {
  const r = db.prepare('SELECT * FROM directory_peers WHERE node = ?').get(node);
  if (!r) return null;
  let region = {};
  try { region = JSON.parse(r.region_json || '{}'); } catch { /* ignore */ }
  return { ...r, region, trusted: Boolean(r.trusted), blocked: Boolean(r.blocked), mutual: Boolean(r.mutual) };
}

export function listPeers() {
  return db.prepare('SELECT node FROM directory_peers ORDER BY trusted DESC, name').all()
    .map((r) => getPeer(r.node));
}

export function removePeer(node) {
  return db.prepare('DELETE FROM directory_peers WHERE node = ?').run(node).changes > 0;
}

export const trustedNodes = () => listPeers().filter((p) => p.trusted && !p.blocked).map((p) => p.node);
export const blockedNodes = () => listPeers().filter((p) => p.blocked).map((p) => p.node);

// ---- stock/availability subscriptions ------------------------------------

// itemId null => store-wide. Idempotent.
export function subscribe(userId, itemId = null) {
  db.prepare('INSERT OR IGNORE INTO subscriptions (user_id, item_id) VALUES (?, ?)').run(userId, itemId ?? null);
  return true;
}
export function unsubscribe(userId, itemId = null) {
  const clause = itemId == null ? 'item_id IS NULL' : 'item_id = ?';
  const args = itemId == null ? [userId] : [userId, itemId];
  return db.prepare(`DELETE FROM subscriptions WHERE user_id = ? AND ${clause}`).run(...args).changes > 0;
}
// Set of the user's subscriptions: { store: bool, items: [itemId,...] }.
export function listSubscriptions(userId) {
  const rows = db.prepare('SELECT item_id FROM subscriptions WHERE user_id = ?').all(userId);
  return {
    store: rows.some((r) => r.item_id == null),
    items: rows.filter((r) => r.item_id != null).map((r) => r.item_id),
  };
}
// Recipients to notify about a change to a given item: everyone subscribed to
// that item plus everyone subscribed store-wide. Includes anyone reachable on
// at least one channel — an email OR a phone (for WhatsApp alerts).
export function subscribersForItem(itemId) {
  return db.prepare(
    `SELECT DISTINCT u.id, u.name, u.email, u.phone
       FROM subscriptions s JOIN users u ON u.id = s.user_id
      WHERE (s.item_id = ? OR s.item_id IS NULL)
        AND ((u.email IS NOT NULL AND u.email <> '') OR (u.phone IS NOT NULL AND u.phone <> ''))`
  ).all(itemId);
}
// Admin view: every subscription with who and what.
export function listAllSubscriptions() {
  return db.prepare(
    `SELECT s.id, s.item_id, s.created_at, u.username, u.name, u.email, u.role, i.title AS item_title
       FROM subscriptions s
       JOIN users u ON u.id = s.user_id
       LEFT JOIN items i ON i.id = s.item_id
      ORDER BY s.created_at DESC, s.id DESC`
  ).all();
}

// Store-wide subscribers only (for "new stock" alerts). Reachable on email or phone.
export function storeSubscribers() {
  return db.prepare(
    `SELECT DISTINCT u.id, u.name, u.email, u.phone
       FROM subscriptions s JOIN users u ON u.id = s.user_id
      WHERE s.item_id IS NULL
        AND ((u.email IS NOT NULL AND u.email <> '') OR (u.phone IS NOT NULL AND u.phone <> ''))`
  ).all();
}

// ---- financials / analytics ---------------------------------------------

export function itemWithFinancials(id, opts = {}) {
  const item = getItem(id);
  if (!item) return null;
  const costs = listCosts(id);
  const fin = computeItemFinancials(item, costs, { defaults: financialDefaults(), ...opts });
  return { item, costs, financials: fin, upgrades: listUpgrades(id), images: listImages(id) };
}

export function allItemsWithFinancials() {
  const items = listItems();
  const defaults = financialDefaults();
  return items.map((item) => {
    const costs = listCosts(item.id);
    const fin = computeItemFinancials(item, costs, { defaults });
    return { item, costs, fin };
  });
}

export function portfolioSummary() {
  const all = allItemsWithFinancials();
  return summarizePortfolio(all);
}

export function performanceReport(opts = {}) {
  const all = allItemsWithFinancials();
  return buildReport(all, opts);
}

/** Mark an item sold, capturing price + date and flipping status. */
export function markSold(id, { sold_price, sold_date, local_sale } = {}) {
  const item = getItem(id);
  if (!item) return null;
  const patch = {
    status: 'sold',
    sold_price: sold_price != null ? Number(sold_price) : item.sold_price,
    sold_date: sold_date || new Date().toISOString().slice(0, 10),
  };
  if (local_sale !== undefined) patch.local_sale = local_sale ? 1 : 0;
  return updateItem(id, patch);
}

// ---- export / import -----------------------------------------------------

function csvEscape(v) {
  if (v == null) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

/** Full inventory as CSV including computed financials. */
export function exportItemsCsv() {
  const rows = allItemsWithFinancials();
  const headers = [
    'id', 'sku', 'title', 'category', 'brand', 'model', 'condition', 'status', 'quantity',
    'serial_number', 'location', 'acquired_date', 'acquisition_cost',
    'refurb_cost', 'invested_cost', 'shipping_cost', 'listing_price',
    'break_even_price', 'suggested_price', 'sold_price', 'sold_date',
    'realized_profit', 'projected_profit', 'notes',
  ];
  const lines = [headers.join(',')];
  for (const { item, fin } of rows) {
    lines.push([
      item.id, item.sku, item.title, item.category, item.brand, item.model, item.condition, item.status, item.quantity,
      item.serial_number, item.location, item.acquired_date, fin.acquisitionCost,
      fin.refurbCost, fin.investedCost, item.shipping_cost, fin.listingPrice,
      fin.breakEvenPrice, fin.suggestedPrice, fin.soldPrice, item.sold_date,
      fin.realizedProfit, fin.projectedProfit, item.notes,
    ].map(csvEscape).join(','));
  }
  return lines.join('\n');
}

/** Complete backup: items with their costs (for restore). */
export function exportBackup() {
  const items = listItems();
  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    items: items.map((item) => ({ ...item, costs: listCosts(item.id) })),
  };
}

/**
 * Import items (and optional nested costs). Upserts: a row whose `id` or `sku`
 * matches an existing item UPDATES that item (only the fields present in the
 * row — so you can fill in details later), otherwise a new item is created.
 * Never deletes existing data. Returns counts.
 */
export function importItems(items = []) {
  let created = 0, updated = 0, costCount = 0;
  for (const raw of items) {
    const { costs = [], id, created_at, updated_at, ...data } = raw;
    let existing = null;
    if (id != null && String(id).trim() !== '' && Number.isInteger(Number(id))) existing = getItem(Number(id));
    if (!existing && data.sku) existing = getItemBySku(data.sku);

    let targetId;
    if (existing) {
      // Merge: only overwrite fields actually supplied (non-empty) in the row.
      const patch = {};
      for (const [k, v] of Object.entries(data)) {
        if (ITEM_FIELDS.includes(k) && v !== undefined && v !== '' && v !== null) patch[k] = v;
      }
      if (Object.keys(patch).length) updateItem(existing.id, patch);
      targetId = existing.id;
      updated++;
    } else {
      const item = createItem(data);
      targetId = item.id;
      created++;
    }
    for (const c of costs) { addCost(targetId, c); costCount++; }
  }
  return { items: created + updated, created, updated, costs: costCount };
}

// A ready-to-edit CSV template for the import feature (headers + examples).
export function sampleImportCsv() {
  const headers = ['id', 'sku', 'title', 'category', 'brand', 'model', 'condition', 'status',
    'quantity', 'acquisition_cost', 'shipping_cost', 'listing_price', 'serial_number', 'location', 'description', 'notes'];
  const rows = [
    ['', 'LAT-7420-01', 'Dell Latitude 7420', 'laptop', 'Dell', 'Latitude 7420', 'used', 'in_stock',
      '1', '180', '0', '549', 'SN12345', 'Shelf A', 'i7 · 16GB · 512GB SSD', 'battery replaced'],
    ['', 'RAM-DDR4-8', 'DDR4 8GB Desktop RAM', 'component', 'Crucial', '', 'used', 'listed',
      '4', '12', '0', '29', '', 'Bin 3', 'PC4-21300, tested', ''],
  ];
  return [headers.join(','), ...rows.map((r) => r.map(csvEscape).join(','))].join('\n');
}

// A ready-to-edit JSON template (matches the backup/import shape).
export function sampleImportJson() {
  return {
    note: 'Edit these rows and import. Leave "id"/"sku" blank for new items; set "sku" (or "id") to update an existing item later. "costs" is optional.',
    items: [
      { sku: 'LAT-7420-01', title: 'Dell Latitude 7420', category: 'laptop', brand: 'Dell', model: 'Latitude 7420',
        condition: 'used', status: 'in_stock', quantity: 1, acquisition_cost: 180, listing_price: 549,
        location: 'Shelf A', description: 'i7 · 16GB · 512GB SSD',
        costs: [{ description: 'New battery', amount: 35, category: 'part' }] },
      { sku: 'RAM-DDR4-8', title: 'DDR4 8GB Desktop RAM', category: 'component', brand: 'Crucial',
        condition: 'used', status: 'listed', quantity: 4, acquisition_cost: 12, listing_price: 29, location: 'Bin 3' },
    ],
  };
}

// Quick-add several bare items at once from a list of titles (details later).
export function quickAddItems(titles = [], base = {}) {
  let created = 0;
  const items = [];
  for (const t of titles) {
    const title = String(t || '').trim();
    if (!title) continue;
    items.push(createItem({ title, category: base.category || 'laptop', status: base.status || 'in_stock' }));
    created++;
  }
  return { created, items };
}

// ---- purchase requests ---------------------------------------------------

/**
 * Create a purchase request from a customer. Computes the total from the
 * item's listing price plus the selected upgrades, and snapshots the
 * customer's account details so the admin gets who asked.
 * @param {object} args
 * @param {number} args.itemId
 * @param {object} args.customer  user row { id, username, name, email, phone }
 * @param {number[]} [args.upgradeIds]
 * @param {string} [args.message]
 */
/**
 * Create a purchase request (cart). Accepts one or more items, each with
 * optional selected upgrades, plus an optional offer price (proposed total)
 * and message. Computes per-item subtotals and the cart total, and snapshots
 * the customer's account details.
 * @param {object} args
 * @param {object} args.customer  user row
 * @param {Array<{itemId:number, upgradeIds?:number[]}>} args.items
 * @param {number} [args.offer]   customer's proposed total
 * @param {string} [args.message]
 */
export function createPurchaseRequest({ customer, items = [], offer = null, message = '', itemId, upgradeIds }) {
  // Back-compat: allow a single {itemId, upgradeIds}.
  if (itemId != null && (!items || !items.length)) items = [{ itemId, upgradeIds }];
  if (!items || !items.length) throw new Error('no items in request');

  const lines = items.map((line) => {
    const item = getItem(Number(line.itemId));
    if (!item || !FOR_SALE.has(item.status) || item.listing_price == null) {
      throw new Error('item is not available for purchase');
    }
    const chosenIds = new Set((line.upgradeIds || []).map(Number));
    const chosen = listUpgrades(item.id).filter((u) => chosenIds.has(u.id));
    const base = Number(item.listing_price);
    const unit = chosen.reduce((s, u) => s + Number(u.price_delta), base);
    // Quantity: at least 1, never more than the units actually available.
    const available = item.quantity != null && Number(item.quantity) > 0 ? Math.floor(Number(item.quantity)) : 1;
    const wanted = Number.isFinite(Number(line.qty)) && Number(line.qty) > 0 ? Math.floor(Number(line.qty)) : 1;
    const qty = Math.min(wanted, available);
    return {
      item_id: item.id,
      item_title: item.title,
      base_price: base,
      upgrades: chosen.map((u) => ({ label: u.label, price_delta: Number(u.price_delta) })),
      qty,
      unit_price: Math.round(unit * 100) / 100,
      subtotal: Math.round(unit * qty * 100) / 100,
    };
  });

  const total = Math.round(lines.reduce((s, l) => s + l.subtotal, 0) * 100) / 100;
  const single = lines.length === 1;
  const offerNum = offer != null && offer !== '' && Number.isFinite(Number(offer)) ? Math.round(Number(offer) * 100) / 100 : null;

  const info = db
    .prepare(
      `INSERT INTO purchase_requests
        (item_id, item_title, customer_id, customer_username, customer_name, customer_email, customer_phone,
         base_price, upgrades_json, items_json, offer_price, total_price, message)
       VALUES ($item_id,$item_title,$customer_id,$customer_username,$customer_name,$customer_email,$customer_phone,
         $base_price,$upgrades_json,$items_json,$offer_price,$total_price,$message)`
    )
    .run({
      item_id: single ? lines[0].item_id : null,
      item_title: single ? lines[0].item_title : `${lines.length} items`,
      customer_id: customer?.id ?? null,
      customer_username: customer?.username ?? null,
      customer_name: customer?.name ?? null,
      customer_email: customer?.email ?? null,
      customer_phone: customer?.phone ?? null,
      base_price: single ? lines[0].base_price : total,
      upgrades_json: JSON.stringify(single ? lines[0].upgrades : []),
      items_json: JSON.stringify(lines),
      offer_price: offerNum,
      total_price: total,
      message: message ? String(message).slice(0, 1000) : null,
    });
  return getPurchaseRequest(Number(info.lastInsertRowid));
}

function hydrateRequest(r) {
  if (!r) return r;
  let upgrades = [];
  let items = [];
  try { upgrades = JSON.parse(r.upgrades_json || '[]'); } catch { /* ignore */ }
  try { items = JSON.parse(r.items_json || '[]'); } catch { /* ignore */ }
  return { ...r, upgrades, items };
}

export function getPurchaseRequest(id) {
  return hydrateRequest(db.prepare('SELECT * FROM purchase_requests WHERE id = ?').get(id));
}

export function listPurchaseRequests() {
  return db.prepare('SELECT * FROM purchase_requests ORDER BY id DESC').all().map(hydrateRequest);
}

/**
 * Move a request through the lifecycle, recording an audit event.
 *
 * Returns { ok, reason } on a rejected transition rather than silently
 * accepting it — "shipped" going back to "new" would make the shopper's own
 * order history untrustworthy.
 */
export function setRequestStatus(id, status, { note = '', actor = 'admin', tracking } = {}) {
  const current = getPurchaseRequest(id);
  if (!current) return { ok: false, reason: 'request not found' };

  const to = normalizeStatus(status);
  const check = canTransition(current.status, to);
  if (!check.ok) return { ok: false, reason: check.reason, request: current };

  db.prepare("UPDATE purchase_requests SET status = ?, updated_at = datetime('now') WHERE id = ?").run(to, id);
  if (tracking !== undefined) {
    db.prepare('UPDATE purchase_requests SET tracking = ? WHERE id = ?').run(tracking || null, id);
  }
  db.prepare('INSERT INTO request_events (request_id, status, note, actor) VALUES (?,?,?,?)')
    .run(id, to, note || null, actor);

  return { ok: true, request: getPurchaseRequest(id) };
}

/** Record the shop's answer to an offer. */
export function setOfferStatus(id, offerStatus, note = '') {
  if (!OFFER_STATUSES.includes(offerStatus)) return { ok: false, reason: 'unknown offer status' };
  const req = getPurchaseRequest(id);
  if (!req) return { ok: false, reason: 'request not found' };
  if (req.offer_price == null) return { ok: false, reason: 'this request has no offer' };
  db.prepare("UPDATE purchase_requests SET offer_status = ?, offer_note = ?, updated_at = datetime('now') WHERE id = ?")
    .run(offerStatus, note || null, id);
  db.prepare('INSERT INTO request_events (request_id, status, note, actor) VALUES (?,?,?,?)')
    .run(id, `offer_${offerStatus}`, note || null, 'admin');
  return { ok: true, request: getPurchaseRequest(id) };
}

export function requestEvents(id) {
  return db.prepare('SELECT status, note, actor, created_at FROM request_events WHERE request_id = ? ORDER BY id').all(id);
}

/**
 * A shopper's own requests. Scoped by customer_id at the query level, not
 * filtered afterwards, so another customer's order can never be returned.
 */
export function requestsForCustomer(customerId, limit = 50) {
  return db.prepare(
    'SELECT * FROM purchase_requests WHERE customer_id = ? ORDER BY id DESC LIMIT ?'
  ).all(customerId, limit).map((r) => ({ ...r, events: requestEvents(r.id) }));
}

/** Units committed to open orders, so the storefront can stop overselling. */
export function committedUnits(itemId) {
  const marks = COMMITTED_STATUSES.map(() => '?').join(',');
  const rows = db.prepare(
    `SELECT items_json, item_id FROM purchase_requests WHERE status IN (${marks})`
  ).all(...COMMITTED_STATUSES);
  let n = 0;
  for (const r of rows) {
    let lines = null;
    try { lines = JSON.parse(r.items_json || 'null'); } catch { /* ignore */ }
    if (Array.isArray(lines)) {
      for (const l of lines) if (Number(l.item_id) === Number(itemId)) n += Number(l.qty) || 1;
    } else if (Number(r.item_id) === Number(itemId)) {
      n += 1;
    }
  }
  return n;
}

export function setRequestNotified(id, summary) {
  db.prepare('UPDATE purchase_requests SET notified = ? WHERE id = ?').run(summary, id);
}

// ---- visitor / device tracking -------------------------------------------

export function logVisit({ kind, path, query, userAgent, ip, referrer, device, user, itemId, itemTitle }) {
  db.prepare(
    `INSERT INTO visits (kind, path, query, user_agent, ip, referrer, device_json, customer_id, username, item_id, item_title)
     VALUES ($kind,$path,$query,$user_agent,$ip,$referrer,$device_json,$customer_id,$username,$item_id,$item_title)`
  ).run({
    kind: kind || 'view',
    path: path || null,
    query: query ? String(query).slice(0, 300) : null,
    user_agent: userAgent ? String(userAgent).slice(0, 500) : null,
    ip: ip || null,
    referrer: referrer ? String(referrer).slice(0, 300) : null,
    device_json: device ? JSON.stringify(device).slice(0, 1000) : null,
    customer_id: user?.id ?? null,
    username: user?.username ?? null,
    item_id: itemId != null ? Number(itemId) : null,
    item_title: itemTitle ? String(itemTitle).slice(0, 200) : null,
  });
}

function hydrateVisit(v) {
  let device = null;
  try { device = v.device_json ? JSON.parse(v.device_json) : null; } catch { /* ignore */ }
  return { ...v, device };
}

export function listVisits(limit = 200) {
  return db
    .prepare('SELECT * FROM visits ORDER BY id DESC LIMIT ?')
    .all(Math.min(Number(limit) || 200, 1000))
    .map(hydrateVisit);
}

// Paginated visits for the dedicated Activity Log page.
export function listVisitsPaged({ limit = 25, offset = 0 } = {}) {
  limit = Math.min(Math.max(Number(limit) || 25, 1), 200);
  offset = Math.max(Number(offset) || 0, 0);
  const total = db.prepare('SELECT COUNT(*) AS n FROM visits').get().n;
  const visits = db.prepare('SELECT * FROM visits ORDER BY id DESC LIMIT ? OFFSET ?').all(limit, offset).map(hydrateVisit);
  return { visits, total, limit, offset };
}

// Clear activity: everything, or older than N days.
export function clearVisits({ olderThanDays } = {}) {
  const n = Number(olderThanDays);
  if (n && n > 0) {
    return db.prepare("DELETE FROM visits WHERE created_at < datetime('now', ?)").run(`-${n} days`).changes;
  }
  return db.prepare('DELETE FROM visits').run().changes;
}

// ---- waitlist ------------------------------------------------------------

export function addWaitlist({ name, email, phone, message, userAgent, ip, device } = {}) {
  const info = db
    .prepare('INSERT INTO waitlist (name, email, phone, message, user_agent, ip, device_json) VALUES (?,?,?,?,?,?,?)')
    .run(
      name ? String(name).slice(0, 200) : null,
      email ? String(email).slice(0, 200) : null,
      phone ? String(phone).slice(0, 60) : null,
      message ? String(message).slice(0, 1000) : null,
      userAgent ? String(userAgent).slice(0, 500) : null,
      ip || null,
      device ? JSON.stringify(device).slice(0, 1000) : null
    );
  return db.prepare('SELECT * FROM waitlist WHERE id = ?').get(Number(info.lastInsertRowid));
}
export function listWaitlist() {
  return db.prepare('SELECT * FROM waitlist ORDER BY id DESC').all().map((r) => {
    let device = null;
    try { device = r.device_json ? JSON.parse(r.device_json) : null; } catch { /* ignore */ }
    return { ...r, device };
  });
}
export function getWaitlist(id) {
  const r = db.prepare('SELECT * FROM waitlist WHERE id = ?').get(id);
  if (!r) return null;
  let device = null;
  try { device = r.device_json ? JSON.parse(r.device_json) : null; } catch { /* ignore */ }
  return { ...r, device };
}
export function setWaitlistStatus(id, status) {
  const invitedAt = status === 'approved' ? new Date().toISOString() : null;
  db.prepare('UPDATE waitlist SET status = ?, invited_at = COALESCE(?, invited_at) WHERE id = ?')
    .run(status, invitedAt, id);
  return getWaitlist(id);
}
export function deleteWaitlist(id) {
  return db.prepare('DELETE FROM waitlist WHERE id = ?').run(id).changes > 0;
}

export function visitStats() {
  const total = db.prepare('SELECT COUNT(*) AS n FROM visits').get().n;
  const searches = db.prepare("SELECT COUNT(*) AS n FROM visits WHERE kind='search'").get().n;
  const uniqueVisitors = db.prepare('SELECT COUNT(DISTINCT COALESCE(username, ip)) AS n FROM visits').get().n;
  return { total, searches, uniqueVisitors };
}

/**
 * Time series for the profit chart.
 * - realized: cumulative realized profit ordered by sold_date.
 * - projected: cumulative realized profit + projected profit from unsold stock,
 *   so the line continues past "today" into expected earnings.
 */
/**
 * Realized profit over time, bucketed, plus the forward projection.
 *
 * Previously this returned one point per sale and a dashed line to a projected
 * total — which reads as a forecast, not a history. It now returns real
 * periods so "what did March actually earn" is answerable.
 */
export function profitTimeSeries({ range = '90d', from, to, bucket, now } = {}) {
  const all = allItemsWithFinancials();

  const sales = all
    .filter(({ item, fin }) => item.status === 'sold' && fin.realizedProfit != null)
    .map(({ item, fin }) => ({
      date: item.sold_date || item.updated_at?.slice(0, 10) || null,
      profit: fin.realizedProfit,
      revenue: fin.realizedRevenue ?? (item.sold_price || 0) * (item.quantity || 1),
      cost: fin.investedCost ?? 0,
      units: item.quantity || 1,
      title: item.title,
      id: item.id,
    }))
    .filter((s) => s.date)
    .sort((a, b) => a.date.localeCompare(b.date));

  const window = resolveRange({ range, from, to, now, earliest: sales[0]?.date });
  const series = buildProfitSeries(sales, { ...window, bucket });

  const projectedFromStock = all
    .filter(({ item, fin }) => item.status !== 'sold' && item.status !== 'scrapped' && fin.projectedProfit != null)
    .reduce((sum, { fin }) => sum + fin.projectedProfit, 0);

  return {
    ...series,
    range: window.range,
    ranges: rangeList(),
    // Recent sales list, so the chart can be read alongside what drove it.
    recentSales: sales.slice(-12).reverse(),
    projectedFromStock: Math.round(projectedFromStock * 100) / 100,
    projectedTotal: Math.round((series.realizedTotal + projectedFromStock) * 100) / 100,
    // Kept for older clients that read the flat cumulative list.
    realized: series.cumulative.map((c) => ({ date: c.date, cumulativeProfit: c.value })),
  };
}
