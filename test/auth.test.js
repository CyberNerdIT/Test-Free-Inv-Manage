import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, verifyPassword, parseCookies, sessionCookie, createUser, setRole, getUserById, setTourDismissed } from '../src/auth.js';

test('setTourDismissed persists the getting-started opt-out', () => {
  const u = createUser({ username: 'tourguy', password: 'password123', role: 'user' });
  assert.ok(!getUserById(u.id).tour_dismissed);
  setTourDismissed(u.id, true);
  assert.equal(getUserById(u.id).tour_dismissed, 1);
  setTourDismissed(u.id, false);
  assert.equal(getUserById(u.id).tour_dismissed, 0);
});

test('setRole promotes a user to admin and guards the last admin', () => {
  const admin = createUser({ username: 'rootadmin', password: 'password123', role: 'admin' });
  const staff = createUser({ username: 'promoteme', password: 'password123', role: 'user' });
  setRole(staff.id, 'admin');
  assert.equal(getUserById(staff.id).role, 'admin');
  // both are admins now; demoting one is fine
  setRole(staff.id, 'user');
  assert.equal(getUserById(staff.id).role, 'user');
  // demoting the last remaining admin is refused
  assert.throws(() => setRole(admin.id, 'user'), /last admin/);
});

test('password hash verifies correct password and rejects wrong one', () => {
  const { salt, hash } = hashPassword('correct horse battery');
  assert.equal(verifyPassword('correct horse battery', salt, hash), true);
  assert.equal(verifyPassword('wrong password', salt, hash), false);
});

test('each hash uses a unique salt', () => {
  const a = hashPassword('samepass1');
  const b = hashPassword('samepass1');
  assert.notEqual(a.salt, b.salt);
  assert.notEqual(a.hash, b.hash);
  // both still verify
  assert.equal(verifyPassword('samepass1', a.salt, a.hash), true);
  assert.equal(verifyPassword('samepass1', b.salt, b.hash), true);
});

test('verifyPassword tolerates malformed stored hash without throwing', () => {
  assert.equal(verifyPassword('x', 'salt', 'not-hex-!!'), false);
});

test('parseCookies parses a cookie header', () => {
  const c = parseCookies('inv_sid=abc123; other=1; flag');
  assert.equal(c.inv_sid, 'abc123');
  assert.equal(c.other, '1');
  assert.deepEqual(parseCookies(''), {});
  assert.deepEqual(parseCookies(undefined), {});
});

test('sessionCookie sets HttpOnly, SameSite and Path; Secure only when asked', () => {
  const c = sessionCookie('tok', new Date(Date.now() + 1000).toISOString());
  assert.match(c, /inv_sid=tok/);
  assert.match(c, /HttpOnly/);
  assert.match(c, /SameSite=Lax/);
  assert.match(c, /Path=\//);
  assert.doesNotMatch(c, /Secure/);
  assert.match(sessionCookie('t', new Date().toISOString(), { secure: true }), /Secure/);
});
