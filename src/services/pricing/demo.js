// Deterministic demo price provider. Produces realistic-looking active and
// recently-sold comparables derived from the query text, so the whole price
// comparison UI works with zero API credentials configured. Results are stable
// for a given query (no randomness) and clearly labelled source: 'demo'.

import { normalizeCondition } from './conditions.js';

function hashString(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

// A tiny seeded PRNG so a query always yields the same comps.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Rough base price from keywords so laptops don't look like RAM sticks.
function guessBasePrice(query) {
  const q = query.toLowerCase();
  let base = 120;
  if (/\b(laptop|notebook|macbook|thinkpad|xps|elitebook)\b/.test(q)) base = 420;
  if (/\b(desktop|tower|workstation|pc)\b/.test(q)) base = 380;
  if (/\b(gpu|rtx|radeon|graphics|video card)\b/.test(q)) base = 300;
  if (/\b(cpu|ryzen|core i[3579]|processor)\b/.test(q)) base = 160;
  if (/\b(ram|memory|ddr[345])\b/.test(q)) base = 45;
  if (/\b(ssd|nvme|hdd|storage|drive)\b/.test(q)) base = 60;
  if (/\b(i9|rtx 40|ryzen 9|threadripper)\b/.test(q)) base *= 1.8;
  if (/\b(i7|rtx 30|ryzen 7)\b/.test(q)) base *= 1.35;
  return base;
}

const CONDITIONS = ['New', 'Used', 'Refurbished', 'For parts'];

// Which labels a condition filter may produce, and roughly what each is worth
// relative to a used unit — so a "New" demo search reads higher than a
// "For parts" one instead of returning the same numbers with a different word.
const DEMO_CONDITIONS = {
  any: { labels: CONDITIONS, factor: 1 },
  new: { labels: ['New', 'New (open box)'], factor: 1.45 },
  refurbished: { labels: ['Refurbished', 'Certified refurbished'], factor: 1.15 },
  used: { labels: ['Used', 'Used - very good', 'Used - good'], factor: 1 },
  parts: { labels: ['For parts or not working'], factor: 0.35 },
};

function daysAgoISO(days) {
  // Deterministic date math relative to an epoch offset baked from the query
  // is unnecessary; callers only display these. Use a fixed reference so output
  // stays stable across runs and does not depend on Date.now().
  const ref = Date.UTC(2026, 6, 26); // 2026-07-26, matches project seed era
  return new Date(ref - days * 86400000).toISOString().slice(0, 10);
}

export async function searchDemo(query, { limit = 8, condition = 'any' } = {}) {
  const cond = normalizeCondition(condition);
  const { labels, factor } = DEMO_CONDITIONS[cond] || DEMO_CONDITIONS.any;
  // Seeded from the condition too, so switching the dropdown visibly changes
  // the comps rather than relabelling identical rows.
  const seed = hashString(`${query || 'generic'}|${cond}`);
  const rand = mulberry32(seed);
  const base = guessBasePrice(query || '') * factor;

  const active = [];
  const sold = [];

  for (let i = 0; i < limit; i++) {
    const spread = 0.7 + rand() * 0.6; // 0.7x - 1.3x
    const price = Math.round(base * spread * 100) / 100;
    const condition = labels[Math.floor(rand() * labels.length)];
    active.push({
      source: 'demo',
      title: `${query} — listing ${i + 1} (${condition})`,
      price,
      currency: 'USD',
      condition,
      sold: 0,
      sold_date: null,
      url: `https://example.com/demo/active/${seed}-${i}`,
      image: null,
    });
  }

  for (let i = 0; i < Math.max(5, Math.floor(limit * 0.7)); i++) {
    const spread = 0.65 + rand() * 0.5; // sold tends slightly below asking
    const price = Math.round(base * spread * 100) / 100;
    const condition = labels[Math.floor(rand() * labels.length)];
    const days = 1 + Math.floor(rand() * 30);
    sold.push({
      source: 'demo',
      title: `${query} — sold ${i + 1} (${condition})`,
      price,
      currency: 'USD',
      condition,
      sold: 1,
      sold_date: daysAgoISO(days),
      url: `https://example.com/demo/sold/${seed}-${i}`,
      image: null,
    });
  }

  return { active, sold, demo: true, condition: cond };
}
