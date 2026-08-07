// Purchase-request notifications across channels: WhatsApp, Discord, Telegram
// or Email. The active channel is chosen on the Admin page. The request is
// always stored in the DB first (source of truth); this is a best-effort push.
import { effective } from '../settings.js';
import { sendMail } from './smtp.js';
import { ownerAdminEmail } from '../auth.js';

const money = (n) => (n == null ? 'n/a' : '$' + Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }));

const qtyPrefix = (it) => (Number(it.qty) > 1 ? `${it.qty}× ` : '');

// Build the human-readable message an admin receives. Pure + tested.
export function buildMessage(req) {
  const lines = [];
  lines.push('🛒 New purchase request');
  const items = itemsOf(req);
  if (items.length > 1) {
    lines.push(`${items.length} items:`);
    for (const it of items) {
      lines.push(`  • ${qtyPrefix(it)}${it.item_title || it.title} — ${money(it.subtotal ?? it.total)}`);
      for (const u of it.upgrades || []) lines.push(`      + ${u.label} (+${money(u.price_delta)})`);
    }
  } else {
    const it = items[0] || {};
    lines.push(`Item: ${qtyPrefix(it)}${it.item_title || it.title || req.item_title || '—'}`);
    for (const u of it.upgrades || []) lines.push(`  + ${u.label} (+${money(u.price_delta)})`);
    if (Number(it.qty) > 1) lines.push(`  Qty: ${it.qty} (${money(it.unit_price)} each)`);
  }
  lines.push(`Total: ${money(req.total_price)}`);
  if (req.offer_price != null) lines.push(`👉 Customer's OFFER: ${money(req.offer_price)}`);
  lines.push('');
  lines.push('From:');
  lines.push(`  Name: ${req.customer_name || '—'}`);
  lines.push(`  Account: ${req.customer_username || '—'}`);
  if (req.customer_email) lines.push(`  Email: ${req.customer_email}`);
  if (req.customer_phone) lines.push(`  Phone: ${req.customer_phone}`);
  if (req.message) lines.push(`  Message: ${req.message}`);
  return lines.join('\n');
}

function itemsOf(req) {
  if (Array.isArray(req.items) && req.items.length) return req.items;
  try {
    const parsed = JSON.parse(req.items_json || 'null');
    if (Array.isArray(parsed) && parsed.length) return parsed;
  } catch { /* ignore */ }
  // single-item fallback
  let upgrades = Array.isArray(req.upgrades) ? req.upgrades : [];
  if (!upgrades.length) { try { upgrades = JSON.parse(req.upgrades_json || '[]'); } catch { /* ignore */ } }
  return [{ item_title: req.item_title, subtotal: req.total_price, upgrades }];
}

// The WhatsApp payload format and the Meta error-code table used to live here,
// on the reasoning that shaping a message is not the paid part. That left the
// whole of the feature in this repository with only a fetch() missing, so it
// went with the rest of the paid code and none of it is here now.

async function sendEmail(cfg, text) {
  // Notifications always go to the owning admin's account email.
  const to = ownerAdminEmail();
  if (!to) throw new Error('no admin email set — add one under the ⚙ Account menu');
  await sendMail(cfg, { from: cfg.from, to, subject: 'New purchase request', text });
}

// Email is the only channel in this build, and that is deliberate: password
// resets and welcome mail are how the app works at all, so mail is core. The
// chat channels are part of the paid upgrade — there is no code here that talks
// to WhatsApp, Discord or Telegram, so there is nothing to list.
const CHANNELS = {
  email: (n) => ({ enabled: n.email.enabled, send: (t) => sendEmail(n.email, t) }),
};

// Send arbitrary text over every enabled+switched-on channel. Never throws;
// returns a per-channel summary like "email: sent · discord: FAILED — 401".
export async function notifyText(text) {
  const n = effective().notify;
  const names = n.activeChannels || [];
  // Channels the admin switched on that this build cannot send over. Reported
  // alongside the sends so "I enabled Discord and nothing happened" has a
  // visible answer.
  const locked = (n.lockedChannels || []).map((name) => `${name}: needs the Pro upgrade`);
  if (!names.length) {
    return locked.length ? `not sent — ${locked.join(' · ')}` : 'not sent: no channel enabled';
  }
  const results = [...locked];
  for (const name of names) {
    const ch = CHANNELS[name] ? CHANNELS[name](n) : null;
    if (!ch || !ch.enabled) { results.push(`${name}: not configured`); continue; }
    try {
      await ch.send(text);
      results.push(`${name}: sent`);
    } catch (e) {
      console.error(`${name} notify failed:`, e.message);
      results.push(`${name}: FAILED — ${e.message}`);
    }
  }
  return results.join(' · ');
}

// Dispatch a notification for a stored purchase request.
export async function notifyPurchase(req) {
  return notifyText(buildMessage(req));
}

// Send a stock/availability update to a list of {name,email} subscribers.
// Email is the only route this build has: pushing the same update to customers
// over WhatsApp is part of the paid upgrade. Best-effort; never throws.
export async function notifySubscribers(recipients, { subject, html, text } = {}) {
  const n = effective().notify;
  const email = n.email;
  if (!email.enabled || !recipients || !recipients.length) return 0;
  let sent = 0;
  for (const r of recipients) {
    if (!r.email) continue;
    try {
      await sendMail(email, { from: email.from, to: r.email, subject, html, text });
      sent++;
    } catch (e) {
      console.error('subscriber email failed:', e.message);
    }
  }
  return sent;
}

// ---------------------------------------------------------------------------
// Shopper-facing mail
// ---------------------------------------------------------------------------
//
// Everything above notifies the SHOP. These notify the CUSTOMER — previously
// they got a toast that faded after two seconds and no durable record that
// their request existed at all.
//
// Best-effort by design: the request is already saved, so a mail failure must
// never fail the checkout. Errors are logged, not thrown.

const esc = (v) => String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const cash = (n) => (n == null ? '—' : '$' + Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }));

function orderLines(req) {
  let items = [];
  try { items = JSON.parse(req.items_json || 'null') || []; } catch { /* ignore */ }
  if (!items.length) items = [{ item_title: req.item_title, subtotal: req.total_price, qty: 1 }];
  return items.map((i) =>
    `<tr><td style="padding:6px 0">${esc(i.item_title || i.title)}${Number(i.qty) > 1 ? ` × ${i.qty}` : ''}</td>` +
    `<td style="padding:6px 0;text-align:right">${cash(i.subtotal ?? i.total)}</td></tr>`).join('');
}

function shell(brand, heading, body) {
  return `<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:520px;margin:0 auto;color:#111827">
    <h2 style="margin:0 0 4px">${esc(brand)}</h2>
    <h3 style="margin:0 0 14px;font-weight:600">${esc(heading)}</h3>
    ${body}
    <p style="color:#6b7280;font-size:12px;margin-top:22px">You are receiving this because you requested an item from ${esc(brand)}.</p>
  </div>`;
}

/** Receipt for a newly placed request. */
export async function notifyCustomerRequest(req, { brand = 'Tech Garage', origin = '' } = {}) {
  const eff = effective();
  if (!eff.shop.orderEmails || !eff.notify.email.enabled || !req.customer_email) return false;
  const offer = req.offer_price != null
    ? `<p style="margin:12px 0;padding:10px;background:#f9fafb;border-radius:8px">Your offer of <strong>${cash(req.offer_price)}</strong> has been passed on. The shop will reply with a decision.</p>`
    : '';
  const html = shell(brand, 'We got your request', `
    <p>Thanks — your request is with the shop and they will be in touch shortly.</p>
    <table style="width:100%;border-collapse:collapse;font-size:14px">${orderLines(req)}
      <tr><td style="padding:8px 0;border-top:1px solid #e5e7eb"><strong>Total</strong></td>
          <td style="padding:8px 0;border-top:1px solid #e5e7eb;text-align:right"><strong>${cash(req.total_price)}</strong></td></tr>
    </table>
    ${offer}
    <p style="font-size:13px;color:#6b7280">Reference: #${req.id}</p>
    ${origin ? `<p><a href="${esc(origin)}/shop#orders" style="background:#2563eb;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none;display:inline-block">Track this request</a></p>` : ''}`);

  try {
    await sendMail(eff.notify.email, {
      from: eff.notify.email.from, to: req.customer_email,
      subject: `${brand} — we got your request (#${req.id})`,
      html, text: `Thanks — your request (#${req.id}) totalling ${cash(req.total_price)} is with the shop.`,
    });
    return true;
  } catch (e) {
    console.warn('[orders] customer receipt failed:', e.message);
    return false;
  }
}

/** Tell the customer their order moved, or their offer was answered. */
export async function notifyCustomerStatus(req, view, offer, { brand = 'Tech Garage', origin = '' } = {}) {
  const eff = effective();
  if (!eff.shop.orderEmails || !eff.notify.email.enabled || !req.customer_email) return false;
  const track = req.tracking
    ? `<p style="margin:12px 0;padding:10px;background:#f9fafb;border-radius:8px">Tracking: <strong>${esc(req.tracking)}</strong></p>` : '';
  const offerBlock = offer && offer.status !== 'pending'
    ? `<p style="margin:12px 0;padding:10px;background:#f9fafb;border-radius:8px"><strong>${esc(offer.label)}</strong>${offer.note ? `<br>${esc(offer.note)}` : ''}</p>` : '';
  const html = shell(brand, `Request #${req.id}: ${view.label}`, `
    <p>${esc(view.message)}</p>${offerBlock}${track}
    <table style="width:100%;border-collapse:collapse;font-size:14px">${orderLines(req)}</table>
    ${origin ? `<p><a href="${esc(origin)}/shop#orders" style="background:#2563eb;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none;display:inline-block">View your requests</a></p>` : ''}`);

  try {
    await sendMail(eff.notify.email, {
      from: eff.notify.email.from, to: req.customer_email,
      subject: `${brand} — request #${req.id} is now ${view.label.toLowerCase()}`,
      html, text: `${view.label}: ${view.message}`,
    });
    return true;
  } catch (e) {
    console.warn('[orders] customer status mail failed:', e.message);
    return false;
  }
}
