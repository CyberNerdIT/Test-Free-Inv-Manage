import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as repo from '../src/repo.js';

test('waitlist entries start pending and can be approved / declined', () => {
  const entry = repo.addWaitlist({ name: 'Ada', email: 'ada@example.com' });
  assert.equal(entry.status, 'pending');
  assert.equal(entry.invited_at, null);

  const approved = repo.setWaitlistStatus(entry.id, 'approved');
  assert.equal(approved.status, 'approved');
  assert.ok(approved.invited_at, 'invited_at is stamped on approval');

  // getWaitlist round-trips the row (with parsed device)
  const fetched = repo.getWaitlist(entry.id);
  assert.equal(fetched.email, 'ada@example.com');
  assert.equal(fetched.status, 'approved');

  const declined = repo.setWaitlistStatus(entry.id, 'declined');
  assert.equal(declined.status, 'declined');
});

test('listWaitlist reflects status and getWaitlist returns null for missing ids', () => {
  const e = repo.addWaitlist({ name: 'Grace', email: 'grace@example.com' });
  const found = repo.listWaitlist().find((w) => w.id === e.id);
  assert.equal(found.status, 'pending');
  assert.equal(repo.getWaitlist(999999), null);
});
