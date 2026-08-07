#!/usr/bin/env node
// Validate directory/nodes.json — run in CI on every pull request that touches it.
//
//   node tools/validate-registry.js                 # schema + duplicate checks
//   node tools/validate-registry.js --live          # also verify each shop's URL
//
// The schema pass is cheap and always runs. `--live` fetches every listed shop's
// /api/directory/verify and checks it returns the node id claimed in the entry,
// which is what stops someone registering a URL they do not control — or a
// phishing page under a trusted-looking name.
//
// Live checks are advisory in CI: a small shop being briefly offline should not
// block an unrelated pull request. It reports, and a human decides.
import { readFileSync } from 'node:fs';
import { validateRegistry } from '../src/services/registry.js';

const FILE = process.env.REGISTRY_FILE || 'directory/nodes.json';
const LIVE = process.argv.includes('--live');

let doc;
try {
  doc = JSON.parse(readFileSync(FILE, 'utf8'));
} catch (e) {
  console.error(`✗ ${FILE} is not valid JSON: ${e.message}`);
  process.exit(1);
}

const { ok, errors, entries } = validateRegistry(doc);

console.log(`Registry: ${entries.length} shop${entries.length === 1 ? '' : 's'} in ${FILE}`);
if (!ok) {
  console.error('\n✗ Validation failed:');
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}
console.log('✓ Schema, duplicate and region checks passed.');

if (!LIVE) process.exit(0);

// ---------------------------------------------------------------------------
// Live ownership check
// ---------------------------------------------------------------------------

async function verify(entry) {
  const target = `${entry.url}/api/directory/verify`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10_000);
  try {
    const res = await fetch(target, { signal: ctrl.signal, headers: { Accept: 'application/json' } });
    if (!res.ok) return { entry, ok: false, note: `responded ${res.status}` };
    const json = await res.json();
    if (json?.node !== entry.node) {
      // The important failure: the site exists but is not the shop it claims.
      return { entry, ok: false, note: 'the site did NOT return this node id', hard: true };
    }
    return { entry, ok: true, note: 'ownership confirmed' };
  } catch (e) {
    return { entry, ok: false, note: `unreachable (${e.message})` };
  } finally {
    clearTimeout(timer);
  }
}

console.log('\nChecking that each shop controls the URL it registered…');
const results = await Promise.all(entries.map(verify));

let hard = 0;
for (const r of results) {
  const mark = r.ok ? '✓' : r.hard ? '✗' : '⚠';
  console.log(`  ${mark} ${r.entry.name} — ${r.entry.url}: ${r.note}`);
  if (r.hard) hard += 1;
}

if (hard) {
  console.error(`\n✗ ${hard} shop${hard === 1 ? '' : 's'} failed ownership verification. Do not merge.`);
  process.exit(1);
}
const soft = results.filter((r) => !r.ok).length;
console.log(soft
  ? `\n⚠ ${soft} shop${soft === 1 ? '' : 's'} could not be reached. That may just be downtime — check before merging.`
  : '\n✓ Every shop verified.');
