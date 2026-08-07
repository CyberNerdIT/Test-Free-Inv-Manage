// Listing-condition filtering, shared by every price provider.
//
// Comparing a refurbished machine against brand-new retail listings inflates
// the market estimate and, through it, the projected profit. So the condition
// you are pricing for is a first-class search input, not a display detail.
//
// This module owns the shared vocabulary — the group names, what they mean to
// a reseller, and how to recognise one in free text.
//
// It does NOT own how any marketplace spells them. eBay's numeric condition IDs
// and Amazon's PA-API enum are part of those integrations, so they live in
// pro/pricing/{ebay,amazon}.js. Translating a group into a marketplace query is
// the paid work; agreeing on what "refurbished" means is not.

/**
 * Conditions grouped the way a reseller actually thinks about stock.
 */
export const CONDITION_GROUPS = {
  any: {
    label: 'Any condition',
    hint: 'Every listing, regardless of condition.',
    match: () => true,
  },
  new: {
    label: 'New',
    hint: 'Sealed / new-other. Usually the ceiling — not a fair comp for used stock.',
    match: (c) => /\bnew\b/i.test(c) && !/refurb|renew/i.test(c),
  },
  refurbished: {
    label: 'Refurbished',
    hint: 'Certified, seller-refurbished and graded "- Refurbished" listings.',
    match: (c) => /refurb|renew|reconditioned/i.test(c),
  },
  used: {
    label: 'Used',
    hint: 'Pre-owned in working order, from very good down to acceptable.',
    match: (c) => /\bused\b|pre-?owned|very good|acceptable|\bgood\b/i.test(c) && !/refurb|renew/i.test(c),
  },
  parts: {
    label: 'For parts / not working',
    hint: 'Salvage prices — the floor. Useful when deciding whether to part something out.',
    match: (c) => /part|not working|spares|broken|faulty/i.test(c),
  },
};

export const CONDITION_KEYS = Object.keys(CONDITION_GROUPS);
export const DEFAULT_CONDITION = 'any';

/** Coerce anything the client sends into a known group key. */
export function normalizeCondition(value) {
  const v = String(value || '').trim().toLowerCase();
  if (CONDITION_GROUPS[v]) return v;
  // Tolerate the aliases people actually type, and the values already stored on
  // items (an item's own condition seeds the drawer's lookup).
  if (/^refurb/.test(v) || v === 'renewed' || v === 'reconditioned') return 'refurbished';
  if (v === 'for parts' || v === 'parts' || v === 'salvage' || v === 'broken') return 'parts';
  if (v === 'open box' || v === 'new other' || v === 'sealed') return 'new';
  if (v === 'pre-owned' || v === 'preowned' || v === 'second hand') return 'used';
  return DEFAULT_CONDITION;
}

/**
 * Does a free-text condition string belong to this group?
 * Used to filter providers that cannot filter server-side, and to drop rows a
 * provider returned anyway (eBay occasionally does on broad queries).
 */
export function matchesCondition(condition, text) {
  const key = normalizeCondition(condition);
  if (key === 'any') return true;
  // An unlabelled row is kept rather than silently dropped — throwing away real
  // comps because a marketplace omitted a field would skew the median worse
  // than including them.
  if (!text) return true;
  return CONDITION_GROUPS[key].match(String(text));
}

/** Client-safe list for the condition dropdown. */
export function conditionList() {
  return CONDITION_KEYS.map((k) => ({
    key: k,
    label: CONDITION_GROUPS[k].label,
    hint: CONDITION_GROUPS[k].hint,
  }));
}
