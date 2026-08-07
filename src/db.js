// SQLite persistence using Node's built-in node:sqlite (no native deps).
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { config } from './config.js';

if (config.dbPath !== ':memory:') mkdirSync(config.dataDir, { recursive: true });

export const db = new DatabaseSync(config.dbPath);

// Pragmas for reliability + performance on a local single-user tool.
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS items (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  title           TEXT    NOT NULL,
  category        TEXT    NOT NULL DEFAULT 'laptop',   -- laptop | desktop | component | device | other
  brand           TEXT,
  model           TEXT,
  specs           TEXT,                                 -- JSON string: {cpu, ram, storage, gpu, screen, os, ...}
  condition       TEXT    DEFAULT 'used',              -- new | used | for-parts | refurbished
  status          TEXT    NOT NULL DEFAULT 'in_stock', -- in_stock | listed | sold | scrapped
  acquisition_cost REAL   NOT NULL DEFAULT 0,          -- what you paid to acquire the unit
  acquired_date   TEXT,                                 -- ISO date
  listing_price   REAL,                                 -- current asking price
  sold_price      REAL,
  sold_date       TEXT,
  fee_rate        REAL,                                 -- override marketplace fee fraction (else default)
  flat_fee        REAL,                                 -- override flat per-sale fee (else default)
  shipping_cost   REAL    DEFAULT 0,                    -- expected/actual outbound shipping you eat
  target_margin   REAL,                                 -- desired profit as fraction of total cost
  notes           TEXT,
  created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS costs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id     INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  description TEXT    NOT NULL,
  amount      REAL    NOT NULL DEFAULT 0,
  category    TEXT    DEFAULT 'part',                  -- part | labor | shipping | fees | testing | other
  cost_date   TEXT,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_costs_item ON costs(item_id);

CREATE TABLE IF NOT EXISTS price_comps (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id     INTEGER REFERENCES items(id) ON DELETE CASCADE,
  source      TEXT    NOT NULL,                        -- ebay | amazon | demo
  query       TEXT,
  title       TEXT,
  price       REAL,
  currency    TEXT    DEFAULT 'USD',
  condition   TEXT,
  sold        INTEGER DEFAULT 0,                       -- 1 = recently sold comp, 0 = active listing
  sold_date   TEXT,
  url         TEXT,
  image       TEXT,
  fetched_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_comps_item ON price_comps(item_id);

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT    NOT NULL,
  password_salt TEXT    NOT NULL,
  role          TEXT    NOT NULL DEFAULT 'user',   -- admin | user
  created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  last_login    TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash  TEXT    PRIMARY KEY,                 -- sha256 of the cookie token
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  expires_at  TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

-- Invitations for customer accounts (shareable links).
CREATE TABLE IF NOT EXISTS invites (
  token_hash TEXT PRIMARY KEY,
  name       TEXT,
  email      TEXT,
  phone      TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  used_at    TEXT,
  used_by    INTEGER REFERENCES users(id) ON DELETE SET NULL
);

-- Optional spec-upgrade options a customer can add to a purchase.
CREATE TABLE IF NOT EXISTS upgrades (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id     INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  label       TEXT    NOT NULL,
  price_delta REAL    NOT NULL DEFAULT 0,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_upgrades_item ON upgrades(item_id);

-- Item photos (binary stored on disk under data/uploads; metadata here).
CREATE TABLE IF NOT EXISTS item_images (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id     INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  filename    TEXT    NOT NULL,   -- on-disk name under data/uploads
  original    TEXT,               -- original upload name
  mime        TEXT,
  is_primary  INTEGER DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_images_item ON item_images(item_id);

-- Password reset tokens (for invited users / customers).
CREATE TABLE IF NOT EXISTS password_resets (
  token_hash TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  used_at    TEXT
);

-- Storefront visitor / device activity log.
CREATE TABLE IF NOT EXISTS visits (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  kind        TEXT,               -- view | search | request
  path        TEXT,
  query       TEXT,
  user_agent  TEXT,
  ip          TEXT,
  referrer    TEXT,
  device_json TEXT,               -- client-reported {screen, platform, language, timezone}
  customer_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  username    TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_visits_created ON visits(created_at);

-- Public "join the waitlist" signups (lead capture).
CREATE TABLE IF NOT EXISTS waitlist (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT,
  email       TEXT,
  phone       TEXT,
  message     TEXT,
  user_agent  TEXT,
  ip          TEXT,
  device_json TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Standalone images not tied to an inventory item (e.g. landing-page sample
-- deals). Served publicly via /api/landing/media/:id.
CREATE TABLE IF NOT EXISTS landing_assets (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  filename   TEXT NOT NULL,
  mime       TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Stock/availability notification subscriptions. item_id NULL = store-wide
-- (notify on any new stock). Signed-in users opt in from the storefront.
CREATE TABLE IF NOT EXISTS subscriptions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_id    INTEGER REFERENCES items(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_sub_user_item ON subscriptions(user_id, IFNULL(item_id, 0));

-- Customer "request to purchase" submissions (the source of truth; also
-- pushed out via the configured notification channel).
CREATE TABLE IF NOT EXISTS purchase_requests (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id          INTEGER REFERENCES items(id) ON DELETE SET NULL,
  item_title       TEXT,
  customer_id      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  customer_username TEXT,
  customer_name    TEXT,
  customer_email   TEXT,
  customer_phone   TEXT,
  base_price       REAL,
  upgrades_json    TEXT,
  total_price      REAL,
  message          TEXT,
  status           TEXT NOT NULL DEFAULT 'new',   -- new | handled
  notified         TEXT,                           -- channel result summary
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

// --- lightweight migrations -------------------------------------------------
// Add columns to existing databases without destroying data. Each entry is
// only applied if the column is not already present.
function ensureColumns(table, columns) {
  const existing = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
  for (const [name, ddl] of columns) {
    if (!existing.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${ddl}`);
  }
}

ensureColumns('items', [
  ['serial_number', 'TEXT'], // manufacturer serial / service tag
  ['location', 'TEXT'],       // physical bin / shelf / storage location
  ['hidden', 'INTEGER DEFAULT 0'], // 1 = hide from the customer storefront
  ['local_sale', 'INTEGER DEFAULT 0'], // 1 = sold locally/to a friend, no marketplace fees
  ['quantity', 'INTEGER DEFAULT 1'], // units available for this listing
  ['description', 'TEXT'], // customer-facing description shown in the storefront detail view
  ['sku', 'TEXT'], // human-friendly listing ID for CSV round-trips / later updates
]);

ensureColumns('users', [
  ['name', 'TEXT'],   // display name (used for customers)
  ['email', 'TEXT'],
  ['phone', 'TEXT'],
  ['tour_dismissed', 'INTEGER DEFAULT 0'], // 1 = hide the getting-started tour
]);

ensureColumns('purchase_requests', [
  ['items_json', 'TEXT'],   // cart line items when a request has multiple items
  ['offer_price', 'REAL'],  // customer's proposed total (an offer), if any
]);

ensureColumns('waitlist', [
  ['status', "TEXT NOT NULL DEFAULT 'pending'"], // pending | approved | declined
  ['invited_at', 'TEXT'],                         // when an invite was sent
]);

ensureColumns('purchase_requests', [
  ['offer_status', 'TEXT'],      // accepted | declined | countered (null = no offer / undecided)
  ['offer_note', 'TEXT'],        // reply the shopper sees
  ['updated_at', 'TEXT'],
  ['tracking', 'TEXT'],          // shipment reference, shown to the shopper
]);

ensureColumns('items', [
  ['compare_at_price', 'REAL'],
  ['share_community', 'INTEGER DEFAULT 0'], // opt in, per item, to the directory  // "was" price for a savings badge on the storefront
]);

ensureColumns('visits', [
  ['item_id', 'INTEGER'],   // the specific item a customer looked at, if any
  ['item_title', 'TEXT'],   // its title, captured for the activity log
]);

// A shopper's saved cart. Previously the cart was a plain in-memory array in
// shop.js, so a refresh, a tab switch or an incoming phone call silently threw
// it away. Storing it server-side also lets a cart follow someone from phone to
// laptop, which localStorage alone cannot do.
db.exec(`
CREATE TABLE IF NOT EXISTS carts (
  user_id     INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  lines_json  TEXT NOT NULL DEFAULT '[]',
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Status history for a purchase request, so a shopper can see progress and an
-- admin can see who changed what. The request row carries the CURRENT status;
-- this is the audit trail behind it.
CREATE TABLE IF NOT EXISTS request_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id  INTEGER NOT NULL REFERENCES purchase_requests(id) ON DELETE CASCADE,
  status      TEXT NOT NULL,
  note        TEXT,
  actor       TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_request_events ON request_events(request_id);

-- Cached market comparison per item, so the storefront can show "similar units
-- sell for X" without an eBay call on every card render.
CREATE TABLE IF NOT EXISTS market_snapshots (
  item_id      INTEGER PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE,
  median       REAL,
  low          REAL,
  high         REAL,
  sample       INTEGER,
  basis        TEXT,      -- live_sold | live_active | demo_* (never shown when demo)
  is_live      INTEGER DEFAULT 0,
  condition    TEXT,
  currency     TEXT DEFAULT 'USD',
  fetched_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

// Community directory: which listings have been shared, and with what result.
// Kept per item so "is this published?" is answerable without asking a remote
// server, and so unsharing can tell the directory to delist.
db.exec(`
CREATE TABLE IF NOT EXISTS directory_shares (
  item_id     INTEGER PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE,
  ref         TEXT,
  status      TEXT NOT NULL DEFAULT 'pending',  -- pending | published | delisted | error
  detail      TEXT,
  shared_at   TEXT,
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Other people's shops. "trusted" marks a node added deliberately (a friend's
-- shop by invite) rather than one that merely appeared in a feed.
CREATE TABLE IF NOT EXISTS directory_peers (
  node        TEXT PRIMARY KEY,
  name        TEXT,
  url         TEXT,
  region_json TEXT,
  trusted     INTEGER DEFAULT 0,
  blocked     INTEGER DEFAULT 0,
  last_seen   TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
-- Shops suggested by a friend that this shop has not acted on yet. Kept so a
-- suggestion can be dismissed permanently rather than reappearing every sync.
CREATE TABLE IF NOT EXISTS directory_dismissed (
  node       TEXT PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

// There was a `payments` table here, backing Stripe/PayPal/Ko-fi/Patreon
// verification. Payment handling has been removed from the app, so nothing
// creates or reads it any more.
//
// It is deliberately NOT dropped: an install that used it holds a record of
// real transactions, and deleting someone's financial history as a side effect
// of an update would be indefensible. A fresh database simply never gets the
// table; an old one keeps it, unused.

// Migrations for tables created further up this file. These have to come after
// their CREATE TABLE, not alongside the older migrations near the top.
ensureColumns('directory_peers', [
  ['tagline', 'TEXT'],
  ['mutual', 'INTEGER DEFAULT 0'],   // 1 = they list us back
  ['checked_at', 'TEXT'],            // last time we read their profile
]);

// One-time cleanup: drop a lingering legacy brand name so the "Tech Garage"
// default applies. (Renaming to anything else still works and is preserved.)
db.exec("DELETE FROM settings WHERE key = 'brand_name' AND value = 'Inventory Manager'");

export default db;
