// Item photo storage: binaries on disk under data/uploads, metadata in SQLite.
import { mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import crypto from 'node:crypto';
import { db } from '../db.js';
import { config } from '../config.js';

const UPLOADS = join(config.dataDir, 'uploads');
if (config.dbPath !== ':memory:') mkdirSync(UPLOADS, { recursive: true });

const EXT = { 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024; // 8 MB

export function isAllowedMime(mime) {
  return Object.prototype.hasOwnProperty.call(EXT, mime);
}

export function listImages(itemId) {
  return db.prepare('SELECT id, item_id, original, mime, is_primary, created_at FROM item_images WHERE item_id = ? ORDER BY is_primary DESC, id').all(itemId);
}
export function getImage(id) {
  return db.prepare('SELECT * FROM item_images WHERE id = ?').get(id);
}
export function imagePath(row) {
  return join(UPLOADS, row.filename);
}

export function saveImage(itemId, { buffer, mime, original }) {
  if (!isAllowedMime(mime)) throw new Error('unsupported image type (use JPEG, PNG, WebP or GIF)');
  if (!buffer || !buffer.length) throw new Error('empty upload');
  if (buffer.length > MAX_IMAGE_BYTES) throw new Error('image too large (max 8 MB)');
  const ext = EXT[mime] || 'bin';
  const filename = `${itemId}-${crypto.randomBytes(8).toString('hex')}.${ext}`;
  mkdirSync(UPLOADS, { recursive: true });
  writeFileSync(join(UPLOADS, filename), buffer);
  const isPrimary = listImages(itemId).length === 0 ? 1 : 0;
  const info = db
    .prepare('INSERT INTO item_images (item_id, filename, original, mime, is_primary) VALUES (?,?,?,?,?)')
    .run(itemId, filename, original || null, mime, isPrimary);
  return getImage(Number(info.lastInsertRowid));
}

export function deleteImage(id) {
  const row = getImage(id);
  if (!row) return false;
  try { if (existsSync(imagePath(row))) rmSync(imagePath(row)); } catch { /* ignore */ }
  db.prepare('DELETE FROM item_images WHERE id = ?').run(id);
  // Promote another image to primary if we removed the primary one.
  if (row.is_primary) {
    const next = db.prepare('SELECT id FROM item_images WHERE item_id = ? ORDER BY id LIMIT 1').get(row.item_id);
    if (next) db.prepare('UPDATE item_images SET is_primary = 1 WHERE id = ?').run(next.id);
  }
  return true;
}

// ---- standalone assets (landing-page images, not tied to an item) ----------
export function saveAsset({ buffer, mime }) {
  if (!isAllowedMime(mime)) throw new Error('unsupported image type (use JPEG, PNG, WebP or GIF)');
  if (!buffer || !buffer.length) throw new Error('empty upload');
  if (buffer.length > MAX_IMAGE_BYTES) throw new Error('image too large (max 8 MB)');
  const ext = EXT[mime] || 'bin';
  const filename = `landing-${crypto.randomBytes(8).toString('hex')}.${ext}`;
  mkdirSync(UPLOADS, { recursive: true });
  writeFileSync(join(UPLOADS, filename), buffer);
  const info = db.prepare('INSERT INTO landing_assets (filename, mime) VALUES (?,?)').run(filename, mime);
  return db.prepare('SELECT * FROM landing_assets WHERE id = ?').get(Number(info.lastInsertRowid));
}
export function getAsset(id) {
  return db.prepare('SELECT * FROM landing_assets WHERE id = ?').get(id);
}
export function assetPath(row) {
  return join(UPLOADS, row.filename);
}
export function deleteAsset(id) {
  const row = getAsset(id);
  if (!row) return false;
  try { if (existsSync(assetPath(row))) rmSync(assetPath(row)); } catch { /* ignore */ }
  db.prepare('DELETE FROM landing_assets WHERE id = ?').run(id);
  return true;
}

export function setPrimary(id) {
  const row = getImage(id);
  if (!row) return false;
  db.prepare('UPDATE item_images SET is_primary = 0 WHERE item_id = ?').run(row.item_id);
  db.prepare('UPDATE item_images SET is_primary = 1 WHERE id = ?').run(id);
  return true;
}
