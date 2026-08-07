// Purchase-request lifecycle.
//
// A request used to carry a single flag: `new` or `handled`. That is enough for
// an admin inbox and useless for the shopper — after sending a request they saw
// a toast that faded in two seconds and then had no way to ask "did that go
// through?" other than emailing the shop.
//
// So the status is a real state machine now. Pure functions here (no database)
// so the allowed transitions are one testable thing rather than scattered
// through route handlers.

/**
 * Each status carries the shopper-facing wording alongside the internal key,
 * because "reserved" means nothing to a buyer without a sentence explaining it.
 * `terminal` states accept no further transitions.
 */
export const STATUSES = {
  new: {
    label: 'Sent', shopper: 'Your request has been sent. The shop will get back to you shortly.',
    tone: 'info', next: ['reserved', 'declined', 'cancelled'],
  },
  reserved: {
    label: 'Reserved', shopper: 'The shop has set this aside for you and will be in touch to arrange payment.',
    tone: 'info', next: ['paid', 'declined', 'cancelled'],
  },
  paid: {
    label: 'Paid', shopper: 'Payment received — thank you. Your order is being prepared.',
    tone: 'good', next: ['shipped', 'completed', 'cancelled'],
  },
  shipped: {
    label: 'Shipped', shopper: 'On its way.',
    tone: 'good', next: ['completed'],
  },
  completed: {
    label: 'Completed', shopper: 'Completed. Thanks for your business!',
    tone: 'good', next: [], terminal: true,
  },
  declined: {
    label: 'Declined', shopper: 'The shop could not fulfil this request.',
    tone: 'bad', next: [], terminal: true,
  },
  cancelled: {
    label: 'Cancelled', shopper: 'This request was cancelled.',
    tone: 'muted', next: [], terminal: true,
  },
  // Legacy: rows created before the lifecycle existed. Treated as 'new' so an
  // upgrade doesn't strand old requests in a status nothing can move.
  handled: {
    label: 'Handled', shopper: 'The shop has picked this up.',
    tone: 'info', next: ['reserved', 'paid', 'completed', 'declined', 'cancelled'],
  },
};

export const STATUS_KEYS = Object.keys(STATUSES);

/** Statuses where the shop still owes the shopper an action. */
export const OPEN_STATUSES = ['new', 'handled', 'reserved', 'paid', 'shipped'];

/** Statuses in which the units are committed and should leave available stock. */
export const COMMITTED_STATUSES = ['reserved', 'paid', 'shipped', 'completed'];

export const normalizeStatus = (s) => (STATUS_KEYS.includes(s) ? s : 'new');

/**
 * May a request move from `from` to `to`?
 * Returns { ok, reason } rather than throwing so callers can report it.
 */
export function canTransition(from, to) {
  const cur = STATUSES[normalizeStatus(from)];
  if (!STATUS_KEYS.includes(to)) return { ok: false, reason: `"${to}" is not a known status.` };
  if (from === to) return { ok: false, reason: `Already ${STATUSES[normalizeStatus(from)].label.toLowerCase()}.` };
  if (cur.terminal) return { ok: false, reason: `${cur.label} is final — this request can't change again.` };
  if (!cur.next.includes(to)) {
    return { ok: false, reason: `Can't go from ${cur.label.toLowerCase()} to ${STATUSES[to].label.toLowerCase()}.` };
  }
  return { ok: true };
}

/** Options an admin can pick for a request currently in `status`. */
export function nextOptions(status) {
  return (STATUSES[normalizeStatus(status)].next || [])
    .map((k) => ({ key: k, label: STATUSES[k].label }));
}

/** Everything the shopper should see about a status. */
export function shopperView(status) {
  const s = STATUSES[normalizeStatus(status)];
  return { status: normalizeStatus(status), label: s.label, message: s.shopper, tone: s.tone, open: OPEN_STATUSES.includes(normalizeStatus(status)) };
}

export const OFFER_STATUSES = ['accepted', 'declined', 'countered'];

/**
 * An offer that is never answered is worse than one that is declined — the
 * shopper is left guessing. This makes "no decision yet" an explicit state.
 */
export function offerView(request) {
  if (request?.offer_price == null) return null;
  const status = OFFER_STATUSES.includes(request.offer_status) ? request.offer_status : 'pending';
  const label = {
    pending: 'Offer under review',
    accepted: 'Offer accepted',
    declined: 'Offer declined',
    countered: 'Counter-offer',
  }[status];
  return {
    status, label,
    amount: request.offer_price,
    note: request.offer_note || null,
    tone: status === 'accepted' ? 'good' : status === 'declined' ? 'bad' : 'info',
  };
}
