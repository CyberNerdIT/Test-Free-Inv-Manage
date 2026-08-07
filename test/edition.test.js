import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as edition from '../src/edition.js';
import * as upgrade from '../src/upgrade.js';

// What an install IS, and — more importantly — what it can never be talked into
// believing about itself. This repository is the free build, so there is no
// plan to derive: the premium code is not here, which leaves exactly one fact
// worth reporting (who runs the box) and no lever to pull.

function withEnv(vars, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try { return fn(); }
  finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test('an ordinary install is free and self-hosted', () => {
  withEnv({ INV_HOSTED: undefined }, () => {
    const e = edition.current();
    assert.equal(e.key, 'free');
    assert.equal(e.managed, false);
    assert.equal(e.selfServiceable, true);
  });
});

test('INV_HOSTED marks the deployment, and only the deployment', () => {
  withEnv({ INV_HOSTED: '1' }, () => {
    const e = edition.current();
    assert.equal(e.key, 'hosted');
    assert.equal(e.managed, true);
    assert.equal(e.selfServiceable, false, 'a hosted customer has no shell to run commands in');
  });
});

test('no environment variable can unlock a premium feature', () => {
  // This is the security claim the design rests on, and in this build it is
  // trivially true: there is no premium code to unlock, so `available` is a
  // constant rather than a lookup that some input could steer.
  for (const v of ['1', 'true', 'yes', 'PRO', 'hosted']) {
    withEnv({ INV_HOSTED: v }, () => {
      assert.equal(upgrade.status().available, false, `INV_HOSTED=${v} must not grant Pro`);
    });
  }
});

test('the off switch is genuinely off', () => {
  // A variable that is present-but-empty, or explicitly false, must not read as
  // "managed" — otherwise an unset-looking unit file silently hides the update
  // instructions a self-hoster needs.
  for (const v of [undefined, '', '0', 'false', 'FALSE']) {
    withEnv({ INV_HOSTED: v }, () => {
      assert.equal(edition.current().managed, false, `INV_HOSTED=${JSON.stringify(v)} must not be managed`);
    });
  }
});

test('support contact is only offered where it is the actual remedy', () => {
  withEnv({ INV_HOSTED: '1', INV_SUPPORT_URL: 'https://example.com/help' }, () => {
    assert.equal(edition.current().supportUrl, 'https://example.com/help');
  });
  // Self-hosted: pointing at our support desk would be wrong, they fix it
  // themselves with one command.
  withEnv({ INV_HOSTED: undefined, INV_SUPPORT_URL: 'https://example.com/help' }, () => {
    assert.equal(edition.current().supportUrl, '');
  });
  // Managed but no desk configured — an empty string, never a broken link.
  withEnv({ INV_HOSTED: '1', INV_SUPPORT_URL: undefined }, () => {
    assert.equal(edition.current().supportUrl, '');
  });
});

test('the upgrade link is optional and never fabricated', () => {
  // An empty string is a valid answer the UI knows how to render. A guessed URL
  // is a broken link on somebody's admin page.
  withEnv({ INV_UPGRADE_URL: undefined }, () => {
    assert.equal(upgrade.upgradeUrl(), '');
    assert.equal(edition.current().upgradeUrl, '');
  });
  withEnv({ INV_UPGRADE_URL: 'https://example.com/pro' }, () => {
    assert.equal(edition.current().upgradeUrl, 'https://example.com/pro');
  });
});

test('describe() says which of the two deployments this is', () => {
  withEnv({ INV_HOSTED: '1' }, () => assert.equal(edition.describe(), 'Hosted (managed)'));
  withEnv({ INV_HOSTED: undefined }, () => assert.equal(edition.describe(), 'Free (self-hosted)'));
});

test('the edition is re-derived, never cached', () => {
  // A restart with a different environment has to be immediately correct;
  // caching this at import time would make a fleet report yesterday's truth.
  withEnv({ INV_HOSTED: undefined }, () => assert.equal(edition.current().managed, false));
  withEnv({ INV_HOSTED: '1' }, () => assert.equal(edition.current().managed, true));
  withEnv({ INV_HOSTED: undefined }, () => assert.equal(edition.current().managed, false));
});

test('nothing in the app asks the user what edition they are', () => {
  // Guard against the thing we deliberately removed coming back. If a future
  // change adds a licence field, a plan setting or a key check, this fails.
  const e = edition.current();
  assert.deepEqual(
    Object.keys(e).sort(),
    ['key', 'label', 'managed', 'selfServiceable', 'supportUrl', 'upgradeUrl'],
    'the edition is derived from the environment only — no stored plan, no key, no expiry',
  );
});

test('the upgrade catalogue describes, and only describes', () => {
  const s = upgrade.status();
  assert.equal(s.available, false);
  assert.ok(s.features.length >= 5);
  for (const f of s.features) {
    assert.deepEqual(Object.keys(f).sort(), ['blurb', 'key', 'name'],
      'a catalogue entry is text — no module path, no loader hint, nothing to import');
  }
  assert.ok(s.notice.length > 20, 'the page needs a real sentence about how to upgrade');
});
