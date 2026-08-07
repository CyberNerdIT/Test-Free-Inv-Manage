// Authentication: scrypt password hashing, opaque DB-backed session cookies,
// and user management. No external dependencies (node:crypto only).
import crypto from 'node:crypto';
import { db } from './db.js';

export const COOKIE_NAME = 'inv_sid';
const SESSION_TTL_DAYS = 30;
const SCRYPT_KEYLEN = 64;

// ---- password hashing ----------------------------------------------------
export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, SCRYPT_KEYLEN).toString('hex');
  return { salt, hash };
}

export function verifyPassword(password, salt, expectedHex) {
  let derived;
  try {
    derived = crypto.scryptSync(String(password), salt, SCRYPT_KEYLEN);
  } catch {
    return false;
  }
  const expected = Buffer.from(expectedHex, 'hex');
  return derived.length === expected.length && crypto.timingSafeEqual(derived, expected);
}

// ---- users ---------------------------------------------------------------
export function userCount() {
  return db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
}
export function needsSetup() {
  return userCount() === 0;
}

export function getUserByUsername(username) {
  return db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE').get(String(username || '').trim());
}
export function getUserByEmail(email) {
  if (!email) return null;
  return db.prepare('SELECT * FROM users WHERE email = ? COLLATE NOCASE').get(String(email).trim());
}
export function getUserById(id) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
}
export function listUsers() {
  return db.prepare('SELECT id, username, role, name, email, phone, created_at, last_login FROM users ORDER BY id').all();
}

const ROLES = ['admin', 'user', 'customer'];

export function createUser({ username, password, role = 'user', name = null, email = null, phone = null }) {
  username = String(username || '').trim();
  if (!username) throw new Error('username is required');
  if (!password || String(password).length < 8) throw new Error('password must be at least 8 characters');
  if (getUserByUsername(username)) throw new Error('username already exists');
  const { salt, hash } = hashPassword(password);
  const info = db
    .prepare('INSERT INTO users (username, password_hash, password_salt, role, name, email, phone) VALUES (?,?,?,?,?,?,?)')
    .run(username, hash, salt, ROLES.includes(role) ? role : 'user', name, email, phone);
  return getUserById(Number(info.lastInsertRowid));
}

export function setPassword(userId, password) {
  if (!password || String(password).length < 8) throw new Error('password must be at least 8 characters');
  const { salt, hash } = hashPassword(password);
  db.prepare('UPDATE users SET password_hash = ?, password_salt = ? WHERE id = ?').run(hash, salt, userId);
}

export function setRole(userId, role) {
  const target = getUserById(userId);
  if (!target) throw new Error('user not found');
  const newRole = ROLES.includes(role) ? role : 'user';
  if (target.role === 'admin' && newRole !== 'admin') {
    const admins = db.prepare("SELECT COUNT(*) AS n FROM users WHERE role='admin'").get().n;
    if (admins <= 1) throw new Error('cannot remove the last admin');
  }
  db.prepare('UPDATE users SET role = ? WHERE id = ?').run(newRole, userId);
}

// Update a user's own profile fields (name/email/phone).
export function updateProfile(userId, { name, email, phone } = {}) {
  const sets = [];
  const params = { id: userId };
  if (name !== undefined) { sets.push('name = $name'); params.name = name || null; }
  if (email !== undefined) { sets.push('email = $email'); params.email = email || null; }
  if (phone !== undefined) { sets.push('phone = $phone'); params.phone = phone || null; }
  if (sets.length) db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = $id`).run(params);
  return getUserById(userId);
}

// Persist the user's "don't show the getting-started tour again" choice.
export function setTourDismissed(userId, dismissed = true) {
  db.prepare('UPDATE users SET tour_dismissed = ? WHERE id = ?').run(dismissed ? 1 : 0, userId);
}

// The owning admin's email — where purchase notifications are sent.
export function ownerAdminEmail() {
  const row = db
    .prepare("SELECT email FROM users WHERE role = 'admin' AND email IS NOT NULL AND email <> '' ORDER BY id LIMIT 1")
    .get();
  return row?.email || null;
}

export function deleteUser(userId) {
  // Never allow removing the last admin.
  const admins = db.prepare("SELECT COUNT(*) AS n FROM users WHERE role='admin'").get().n;
  const target = getUserById(userId);
  if (!target) return false;
  if (target.role === 'admin' && admins <= 1) throw new Error('cannot delete the last admin');
  return db.prepare('DELETE FROM users WHERE id = ?').run(userId).changes > 0;
}

// First-run: create the initial admin. Only allowed while there are no users.
export function setupFirstAdmin({ username, password }) {
  if (!needsSetup()) throw new Error('setup already completed');
  return createUser({ username, password, role: 'admin' });
}

// ---- invites (customer onboarding) ---------------------------------------
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const INVITE_TTL_DAYS = 14;

export function createInvite({ name = null, email = null, phone = null } = {}) {
  const token = crypto.randomBytes(24).toString('hex');
  const expires = new Date(Date.now() + INVITE_TTL_DAYS * 86400000).toISOString();
  db.prepare('INSERT INTO invites (token_hash, name, email, phone, expires_at) VALUES (?,?,?,?,?)').run(
    sha256(token),
    name,
    email,
    phone,
    expires
  );
  return { token, expires };
}

export function getInvite(token) {
  if (!token) return null;
  const row = db.prepare('SELECT rowid AS id, * FROM invites WHERE token_hash = ?').get(sha256(token));
  if (!row) return null;
  const expired = new Date(row.expires_at).getTime() < Date.now();
  return { ...row, valid: !row.used_at && !expired, expired, used: Boolean(row.used_at) };
}

export function listInvites() {
  return db
    .prepare('SELECT rowid AS id, name, email, phone, created_at, expires_at, used_at FROM invites ORDER BY rowid DESC')
    .all()
    .map((r) => ({ ...r, status: r.used_at ? 'accepted' : new Date(r.expires_at) < new Date() ? 'expired' : 'pending' }));
}

export function deleteInvite(id) {
  return db.prepare('DELETE FROM invites WHERE rowid = ?').run(id).changes > 0;
}

// Accept an invite: create the customer account and consume the invite.
export function acceptInvite(token, { username, password }) {
  const inv = getInvite(token);
  if (!inv) throw new Error('invite not found');
  if (inv.used) throw new Error('this invite has already been used');
  if (inv.expired) throw new Error('this invite has expired');
  const user = createUser({
    username,
    password,
    role: 'customer',
    name: inv.name,
    email: inv.email,
    phone: inv.phone,
  });
  db.prepare("UPDATE invites SET used_at = datetime('now'), used_by = ? WHERE token_hash = ?").run(
    user.id,
    sha256(token)
  );
  return { user, session: createSession(user.id) };
}

// ---- password resets -----------------------------------------------------
const RESET_TTL_MINUTES = 60;

// Look up a user by username OR email and create a reset token. Returns
// { user, token } or null (caller must not reveal which case to the requester).
export function requestPasswordReset(identifier) {
  const id = String(identifier || '').trim();
  if (!id) return null;
  const user = getUserByUsername(id) || getUserByEmail(id);
  if (!user) return null;
  const token = crypto.randomBytes(24).toString('hex');
  const expires = new Date(Date.now() + RESET_TTL_MINUTES * 60000).toISOString();
  db.prepare('INSERT INTO password_resets (token_hash, user_id, expires_at) VALUES (?,?,?)').run(
    sha256(token),
    user.id,
    expires
  );
  return { user, token };
}

export function getResetUser(token) {
  if (!token) return null;
  const row = db
    .prepare(
      `SELECT r.token_hash, r.expires_at, r.used_at, u.id, u.username, u.role
         FROM password_resets r JOIN users u ON u.id = r.user_id
        WHERE r.token_hash = ?`
    )
    .get(sha256(token));
  if (!row || row.used_at) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) return null;
  return { id: row.id, username: row.username, role: row.role };
}

export function completePasswordReset(token, password) {
  const user = getResetUser(token);
  if (!user) throw new Error('this reset link is invalid or has expired');
  setPassword(user.id, password);
  db.prepare("UPDATE password_resets SET used_at = datetime('now') WHERE token_hash = ?").run(sha256(token));
  // Invalidate existing sessions for safety.
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
  return user;
}

export function listResetRequests(limit = 50) {
  return db
    .prepare(
      `SELECT r.rowid AS id, u.username, u.email, u.role, r.created_at, r.expires_at, r.used_at
         FROM password_resets r JOIN users u ON u.id = r.user_id
        ORDER BY r.rowid DESC LIMIT ?`
    )
    .all(limit)
    .map((r) => ({ ...r, status: r.used_at ? 'used' : new Date(r.expires_at) < new Date() ? 'expired' : 'pending' }));
}

// ---- sessions ------------------------------------------------------------

export function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + SESSION_TTL_DAYS * 86400000).toISOString();
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?,?,?)').run(
    sha256(token),
    userId,
    expires
  );
  db.prepare("UPDATE users SET last_login = datetime('now') WHERE id = ?").run(userId);
  return { token, expires };
}

export function getSessionUser(token) {
  if (!token) return null;
  const row = db
    .prepare(
      `SELECT s.token_hash, s.expires_at, u.id, u.username, u.role
         FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = ?`
    )
    .get(sha256(token));
  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(row.token_hash);
    return null;
  }
  return { id: row.id, username: row.username, role: row.role };
}

export function destroySession(token) {
  if (!token) return;
  db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
}

export function login(username, password) {
  const user = getUserByUsername(username);
  if (!user) {
    // Burn comparable time so a missing username isn't detectable by timing.
    hashPassword(password);
    return null;
  }
  if (!verifyPassword(password, user.password_salt, user.password_hash)) return null;
  return createSession(user.id);
}

// ---- cookie helpers ------------------------------------------------------
export function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (!k) continue;
    try {
      out[k] = decodeURIComponent(v);
    } catch {
      out[k] = v; // tolerate malformed percent-encoding
    }
  }
  return out;
}

export function sessionCookie(token, expires, { secure = false } = {}) {
  const attrs = [
    `${COOKIE_NAME}=${token}`,
    'HttpOnly',
    'Path=/',
    'SameSite=Lax',
    `Expires=${new Date(expires).toUTCString()}`,
  ];
  if (secure) attrs.push('Secure');
  return attrs.join('; ');
}

export function clearCookie() {
  return `${COOKIE_NAME}=; HttpOnly; Path=/; SameSite=Lax; Expires=Thu, 01 Jan 1970 00:00:00 GMT`;
}
