// Runtime settings stored in the DB, overlaying the .env defaults. This is what
// backs the Admin page so API credentials and pricing defaults can be changed
// from the UI without editing files. Secrets are never sent to the client.
import { db } from './db.js';
import { config as envcfg } from './config.js';
import { resolveTheme, PRESET_KEYS, DEFAULT_PRESET } from './services/theme.js';
import { normalizeRegion, generateNodeKeypair } from './services/directory.js';
import { DEFAULT_REGISTRY_URL } from './services/registry.js';
import * as upgrade from './upgrade.js';
import * as edition from './edition.js';

export function getRaw(key) {
  const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return r ? r.value : null;
}

export function setRaw(key, value) {
  if (value == null || value === '') {
    db.prepare('DELETE FROM settings WHERE key = ?').run(key);
  } else {
    db.prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
    ).run(key, String(value));
  }
}

const val = (key, fallback) => {
  const v = getRaw(key);
  return v !== null && v !== '' ? v : fallback;
};
const numVal = (key, fallback) => {
  const v = getRaw(key);
  const n = v !== null && v !== '' ? Number(v) : fallback;
  return Number.isFinite(n) ? n : fallback;
};

// Effective config used server-side (includes real secret values).
/**
 * Marketplace and messaging integrations that belong to the paid upgrade.
 * Email (SMTP) is deliberately NOT in this list: password resets and welcome
 * emails are core to running the app at all, so leaving them out would break
 * this build rather than merely limiting it.
 */
export const PREMIUM_INTEGRATIONS = ['ebay', 'amazon', 'whatsapp', 'discord', 'telegram'];

export function effective() {
  // A premium integration is `configured` when its credentials are present, and
  // never `enabled`, because this build contains no code that could use them.
  //
  // This is not a licence check — there is nothing to check. `premium` means
  // "the implementation is not in this build"; `locked` means "you have entered
  // credentials it cannot use yet". Credentials are still stored, so a later
  // upgrade needs no re-entry.
  const premium = (obj, configured, feature) => {
    obj.configured = Boolean(configured);
    obj.enabled = false;
    obj.premium = true;
    obj.locked = Boolean(configured);
    obj.feature = feature;
    return obj;
  };

  const ebay = {
    clientId: val('ebay_client_id', envcfg.ebay.clientId),
    clientSecret: val('ebay_client_secret', envcfg.ebay.clientSecret),
    env: (val('ebay_env', envcfg.ebay.env) || 'PRODUCTION').toUpperCase(),
    marketplace: val('ebay_marketplace', envcfg.ebay.marketplace),
  };
  premium(ebay, ebay.clientId && ebay.clientSecret, 'ebay');

  const amazon = {
    accessKey: val('amazon_access_key', envcfg.amazon.accessKey),
    secretKey: val('amazon_secret_key', envcfg.amazon.secretKey),
    partnerTag: val('amazon_partner_tag', envcfg.amazon.partnerTag),
    region: val('amazon_region', envcfg.amazon.region),
    host: val('amazon_host', envcfg.amazon.host),
  };
  premium(amazon, amazon.accessKey && amazon.secretKey && amazon.partnerTag, 'amazon');

  const defaults = {
    feeRate: numVal('default_fee_rate', envcfg.defaultFeeRate),
    flatFee: numVal('default_flat_fee', envcfg.defaultFlatFee),
    targetMargin: numVal('default_target_margin', envcfg.defaultTargetMargin),
  };

  // Purchase-request notification channels. `channel` selects the active one.
  const whatsapp = {
    token: val('wa_token', ''),
    phoneId: val('wa_phone_id', ''),
    to: val('wa_to', ''),
    apiVersion: val('wa_api_version', 'v20.0'),
    // Business-initiated WhatsApp messages MUST use a pre-approved *template*:
    // free-form 'text' only delivers inside the 24-hour customer-service window
    // (i.e. after the recipient messages you), which almost never applies to an
    // outbound alert. So template mode is the default. 'hello_world' ships
    // pre-approved on every WhatsApp Business account, so the channel works out
    // of the box; switch to your own template (with a {{1}} body variable) to
    // carry the actual request details.
    msgType: val('wa_msg_type', 'template') === 'text' ? 'text' : 'template',
    template: val('wa_template', 'hello_world'),
    lang: val('wa_lang', 'en_US'),
    bodyParam: val('wa_body_param', 'false') === 'true',
    // Also push stock/availability alerts to customers (who added a phone number
    // to their profile) over WhatsApp, using the same template. Off by default.
    updatesOn: val('wa_updates_on', 'false') === 'true',
  };
  premium(whatsapp, whatsapp.token && whatsapp.phoneId && whatsapp.to, 'whatsapp');

  const discord = { webhookUrl: val('discord_webhook_url', '') };
  premium(discord, discord.webhookUrl, 'discord');

  const telegram = { botToken: val('tg_bot_token', ''), chatId: val('tg_chat_id', '') };
  premium(telegram, telegram.botToken && telegram.chatId, 'telegram');

  const email = {
    host: val('smtp_host', ''),
    port: numVal('smtp_port', 587),
    secure: val('smtp_secure', 'false') === 'true',
    user: val('smtp_user', ''),
    pass: val('smtp_pass', ''),
    from: val('smtp_from', ''),
  };
  // Recipient is resolved at send time (admin email); enabled just needs a
  // working sender. Email is core, never premium — see PREMIUM_INTEGRATIONS.
  email.configured = Boolean(email.host && email.from);
  email.enabled = email.configured;
  email.premium = false;
  email.locked = false;

  // Per-channel enable toggles. A channel fires a notification when it is both
  // configured (`enabled`) and switched on (`on`). Legacy single-channel setups
  // (notify_channel = 'x') are honoured as that channel being on.
  const legacy = val('notify_channel', 'none');
  const onFlag = (key, name) => getRaw(key) === 'true' || legacy === name;
  whatsapp.on = onFlag('notify_wa_on', 'whatsapp');
  discord.on = onFlag('notify_discord_on', 'discord');
  telegram.on = onFlag('notify_tg_on', 'telegram');
  email.on = onFlag('notify_email_on', 'email');

  const notify = {
    channel: legacy,
    whatsapp,
    discord,
    telegram,
    email,
    // Names of channels that will actually receive notifications.
    activeChannels: [
      whatsapp.enabled && whatsapp.on && 'whatsapp',
      discord.enabled && discord.on && 'discord',
      telegram.enabled && telegram.on && 'telegram',
      email.enabled && email.on && 'email',
    ].filter(Boolean),
    // Switched on and fully configured, but with no implementation in this
    // build. Tracked separately so a user who turned Discord on and hears
    // nothing is told why, instead of the channel silently vanishing.
    lockedChannels: [
      whatsapp.locked && whatsapp.on && 'whatsapp',
      discord.locked && discord.on && 'discord',
      telegram.locked && telegram.on && 'telegram',
    ].filter(Boolean),
  };

  // Owner's website (monhe.it) — shown as a link on the storefront.
  const site = {
    url: val('site_url', ''),
    name: val('site_name', ''),
  };

  // Site branding (name/tagline shown across the app — handy when sharing the
  // project publicly).
  // The retired default name is coerced to "Tech Garage" so no endpoint ever
  // emits the legacy label, even if an old value lingers in the DB.
  const storedBrand = val('brand_name', 'Tech Garage');
  const brand = {
    name: storedBrand === 'Inventory Manager' ? 'Tech Garage' : storedBrand,
    tagline: val('brand_tagline', 'Track your tech stock. Know your profit.'),
  };

  // Editable password-reset email (HTML). Placeholders: {{name}} {{username}} {{link}}
  const resetEmail = {
    subject: val('reset_email_subject', 'Reset your password'),
    html: val('reset_email_html', DEFAULT_RESET_HTML),
  };

  // Editable welcome email sent when a waitlist signup is approved. It carries
  // the invite link. Placeholders: {{name}} {{link}} {{brand}}
  const welcomeEmail = {
    subject: val('welcome_email_subject', "You're in — set up your {{brand}} account"),
    html: val('welcome_email_html', DEFAULT_WELCOME_HTML),
  };

  // Editable "sample savings" deals shown on the public landing page.
  const landing = { deals: getLandingDeals() };

  // Six built-in schemes, each with a matching light and dark palette. Setting
  // individual colours is part of the paid upgrade and has no implementation
  // here, so there is nothing to resolve beyond the preset and the mode.
  const theme = resolveTheme({
    preset: val('theme_preset', DEFAULT_PRESET),
    mode: val('theme_mode', 'auto'),
  });

  const premiumLocked = PREMIUM_INTEGRATIONS.filter((k) => ({ ebay, amazon, whatsapp, discord, telegram })[k].locked);

  // Shop-owner's own words for what each condition grade means. "Refurbished"
  // means different things to different sellers, and one honest sentence buys
  // more trust than a badge does.
  let conditionNotes = {};
  try { conditionNotes = JSON.parse(getRaw('condition_notes') || 'null') || DEFAULT_CONDITION_NOTES; }
  catch { conditionNotes = DEFAULT_CONDITION_NOTES; }

  // Community directory. Everything here is off until switched on: this is the
  // only feature that sends shop data to a server the owner does not control.
  let region = {};
  try { region = JSON.parse(getRaw('directory_region') || '{}'); } catch { /* ignore */ }
  const directory = {
    // Registering the shop in the public directory.
    enabled: val('directory_enabled', 'false') === 'true',
    // 'repo'   — the shop list is directory/nodes.json in the GitHub repo, and
    //            each shop serves its own listings. No server to host, and the
    //            list is publicly auditable. This is the default.
    // 'server' — a hosted directory (tools/directory-server.js). Faster to join
    //            and one fetch instead of several, at the cost of running it.
    mode: val('directory_mode', 'repo') === 'server' ? 'server' : 'repo',
    registryUrl: val('directory_registry_url', DEFAULT_REGISTRY_URL),
    url: val('directory_url', 'https://directory.techgarage.community'),
    region: normalizeRegion(region),
    contact: val('directory_contact', ''),
    nodePublicKey: val('directory_node_public', ''),
    nodePrivateKey: val('directory_node_private', ''),
    registeredAt: val('directory_registered_at', ''),
    lastPing: val('directory_last_ping', ''),
    lastError: val('directory_last_error', ''),
    // Showing OTHER shops' listings on this storefront. Always on in this
    // build — the point of a community is that it works without every shop
    // opting in. Switching the strangers off while keeping invited friends is
    // part of the paid upgrade.
    showNearby: val('directory_show_nearby', 'true') === 'true',
    trustedOnly: val('directory_trusted_only', 'false') === 'true',
    // Publishing WHO you connected to is what lets your friends suggest shops
    // to each other. Who you do business with is your information, so it is
    // opt-in — a shop that keeps it private still takes part fully, it just
    // doesn't contribute suggestions.
    shareConnections: val('directory_share_connections', 'false') === 'true',
    // Show the shops you connected to on your own storefront.
    showFriends: val('directory_show_friends', 'true') === 'true',
  };
  // This build cannot suppress community listings: the controls that do it are
  // part of the paid upgrade, so the stored preferences are kept but never
  // take effect. Constants, not a lookup — there is no state that could make
  // them true.
  directory.canHideNearby = false;
  directory.effectiveShowNearby = true;
  directory.effectiveTrustedOnly = false;

  const shop = {
    // Public browsing lets people see stock before signing up. Off by default:
    // this is a business decision, not a default anyone should inherit.
    publicCatalog: val('shop_public_catalog', 'false') === 'true',
    orderEmails: val('shop_order_emails', 'true') === 'true',
  };

  return { ebay, amazon, defaults, whatsapp, notify, site, brand, resetEmail, welcomeEmail, landing, theme, edition: edition.current(), premiumLocked, conditionNotes, shop, directory, upgrade: upgrade.status() };
}

/**
 * Persist theme choices. Returns the resolved theme.
 *
 * A `custom` payload is ignored rather than stored: validating a colour is the
 * job of code this build does not have, and storing something it cannot check
 * is how a colour field becomes a script tag.
 */
export function updateTheme({ preset, mode } = {}) {
  if (preset !== undefined) setRaw('theme_preset', PRESET_KEYS.includes(preset) ? preset : DEFAULT_PRESET);
  if (mode !== undefined) setRaw('theme_mode', ['auto', 'light', 'dark'].includes(mode) ? mode : 'auto');
  return effective().theme;
}

export const DEFAULT_CONDITION_NOTES = {
  new: 'Unused and sealed, or opened only to verify contents.',
  refurbished: 'Fully tested, cleaned, and repaired where needed. May show light cosmetic wear.',
  used: 'Pre-owned and working. Cosmetic condition varies — see the photos.',
  'for parts': 'Sold as-is for repair or salvage. Not tested as working.',
};

export function setConditionNotes(notes) {
  const clean = {};
  for (const [k, v] of Object.entries(notes || {})) {
    if (typeof v === 'string' && v.trim()) clean[String(k).slice(0, 40).toLowerCase()] = v.trim().slice(0, 400);
  }
  setRaw('condition_notes', JSON.stringify(clean));
  return clean;
}

/**
 * Persist directory settings.
 *
 * A node keypair is minted the first time the directory is switched on, and
 * never regenerated afterwards — the public half IS the shop's identity in the
 * directory, so replacing it would orphan every listing already published.
 */
export function updateDirectory(payload = {}) {
  if (payload.enabled !== undefined) {
    setRaw('directory_enabled', payload.enabled ? 'true' : 'false');
    if (payload.enabled && !getRaw('directory_node_public')) {
      const kp = generateNodeKeypair();
      setRaw('directory_node_public', kp.publicKey);
      setRaw('directory_node_private', kp.privateKey);
    }
  }
  if (payload.mode !== undefined) setRaw('directory_mode', payload.mode === 'server' ? 'server' : 'repo');
  if (payload.registryUrl !== undefined) setRaw('directory_registry_url', String(payload.registryUrl || '').trim());
  if (payload.url !== undefined) setRaw('directory_url', String(payload.url || '').trim());
  if (payload.contact !== undefined) setRaw('directory_contact', String(payload.contact || '').slice(0, 200));
  if (payload.region !== undefined) setRaw('directory_region', JSON.stringify(normalizeRegion(payload.region)));
  if (payload.showNearby !== undefined) setRaw('directory_show_nearby', payload.showNearby ? 'true' : 'false');
  if (payload.trustedOnly !== undefined) setRaw('directory_trusted_only', payload.trustedOnly ? 'true' : 'false');
  if (payload.shareConnections !== undefined) setRaw('directory_share_connections', payload.shareConnections ? 'true' : 'false');
  if (payload.showFriends !== undefined) setRaw('directory_show_friends', payload.showFriends ? 'true' : 'false');
  return effective().directory;
}

/** Admin-safe view — the node's PRIVATE key must never reach a browser. */
export function directoryView() {
  const d = effective().directory;
  const { nodePrivateKey, ...safe } = d;
  return safe;
}

export function updateShopOptions({ publicCatalog, orderEmails } = {}) {
  if (publicCatalog !== undefined) setRaw('shop_public_catalog', publicCatalog ? 'true' : 'false');
  if (orderEmails !== undefined) setRaw('shop_order_emails', orderEmails ? 'true' : 'false');
  return effective().shop;
}

// Default sample deals (used until the admin customises them).
export const DEFAULT_DEALS = [
  { title: 'Dell Latitude 7420', spec: '14" · Core i7 · 16GB · 512GB SSD', was: 1499, now: 549, icon: '💻', image: null },
  { title: 'Custom Ryzen 5 Desktop', spec: 'Ryzen 5 5600 · 16GB · 1TB NVMe', was: 899, now: 469, icon: '🖥️', image: null },
  { title: 'NVIDIA RTX 3060 12GB', spec: 'Tested graphics card', was: 329, now: 209, icon: '🎮', image: null },
  { title: 'Lenovo ThinkPad T14', spec: '14" · Core i5 · 16GB · 256GB SSD', was: 1199, now: 429, icon: '💼', image: null },
  { title: 'Dell OptiPlex SFF', spec: 'Core i5 · 8GB · 256GB SSD · Win 11', was: 649, now: 229, icon: '🗄️', image: null },
  { title: '27" 1440p Monitor', spec: 'IPS · 75Hz · refurbished', was: 279, now: 129, icon: '🖲️', image: null },
];

function sanitizeDeal(d) {
  const num = (v) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? Math.round(n) : null; };
  // itemId set => the deal is LINKED to a live inventory item: its title, spec,
  // price and photo are pulled live at render time (see the /api/branding route),
  // and it disappears from the landing page once the item sells. `was` stays an
  // admin-entered "compare at" price so a savings badge can still be shown.
  const itemId = d.itemId != null && d.itemId !== '' ? Number(d.itemId) || null : null;
  return {
    itemId,
    title: String(d.title || '').slice(0, 120),
    spec: String(d.spec || '').slice(0, 160),
    was: num(d.was),
    now: num(d.now),
    icon: String(d.icon || '💻').slice(0, 8),
    image: d.image != null && d.image !== '' ? Number(d.image) || null : null,
  };
}
export function getLandingDeals() {
  const raw = getRaw('landing_deals');
  if (!raw) return DEFAULT_DEALS;
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.map(sanitizeDeal) : DEFAULT_DEALS;
  } catch { return DEFAULT_DEALS; }
}
export function setLandingDeals(deals) {
  // Keep a card if it has a title (manual) or is linked to an inventory item.
  const clean = (Array.isArray(deals) ? deals : []).map(sanitizeDeal).filter((d) => d.title || d.itemId).slice(0, 24);
  setRaw('landing_deals', JSON.stringify(clean));
  return clean;
}

export const DEFAULT_RESET_HTML =
  `<div style="font-family:system-ui,sans-serif;max-width:480px;margin:auto">
  <h2>Reset your password</h2>
  <p>Hi {{name}},</p>
  <p>We got a request to reset the password for <strong>{{username}}</strong>. Click below to choose a new one (the link is valid for 1 hour):</p>
  <p><a href="{{link}}" style="display:inline-block;background:#2563eb;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none">Reset password</a></p>
  <p style="color:#6b7280;font-size:13px">If you didn't request this, you can safely ignore this email.</p>
</div>`;

export const DEFAULT_WELCOME_HTML =
  `<div style="font-family:system-ui,sans-serif;max-width:480px;margin:auto">
  <h2>Welcome to {{brand}} 👋</h2>
  <p>Hi {{name}},</p>
  <p>A slot just opened up and you're invited to create your account. Click below to pick a username and password (the link is valid for 14 days):</p>
  <p><a href="{{link}}" style="display:inline-block;background:#2563eb;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none">Set up my account</a></p>
  <p style="color:#6b7280;font-size:13px">If you weren't expecting this, you can safely ignore this email.</p>
</div>`;

// Render a template with {{name}} {{username}} {{link}} substitutions.
export function renderTemplate(tpl, vars) {
  return String(tpl || '').replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => (vars[k] != null ? String(vars[k]) : ''));
}

// Client-safe view for the Admin page: secrets replaced by a "set" boolean.
export function adminView() {
  const e = effective();
  return {
    ebay: {
      clientId: e.ebay.clientId,
      clientSecretSet: Boolean(e.ebay.clientSecret),
      env: e.ebay.env,
      marketplace: e.ebay.marketplace,
      enabled: e.ebay.enabled,
      configured: e.ebay.configured,
      locked: e.ebay.locked,
      premium: true,
    },
    amazon: {
      accessKey: e.amazon.accessKey,
      secretKeySet: Boolean(e.amazon.secretKey),
      partnerTag: e.amazon.partnerTag,
      region: e.amazon.region,
      host: e.amazon.host,
      enabled: e.amazon.enabled,
      configured: e.amazon.configured,
      locked: e.amazon.locked,
      premium: true,
    },
    defaults: e.defaults,
    whatsapp: {
      tokenSet: Boolean(e.whatsapp.token),
      phoneId: e.whatsapp.phoneId,
      to: e.whatsapp.to,
      apiVersion: e.whatsapp.apiVersion,
      msgType: e.whatsapp.msgType,
      template: e.whatsapp.template,
      lang: e.whatsapp.lang,
      bodyParam: e.whatsapp.bodyParam,
      updatesOn: e.whatsapp.updatesOn,
      enabled: e.whatsapp.enabled,
      configured: e.whatsapp.configured,
      locked: e.whatsapp.locked,
      premium: true,
    },
    notify: {
      channel: e.notify.channel,
      activeChannels: e.notify.activeChannels,
      lockedChannels: e.notify.lockedChannels,
      whatsapp: { enabled: e.notify.whatsapp.enabled, on: e.notify.whatsapp.on, configured: e.notify.whatsapp.configured, locked: e.notify.whatsapp.locked, premium: true },
      discord: { webhookSet: Boolean(e.notify.discord.webhookUrl), enabled: e.notify.discord.enabled, on: e.notify.discord.on, configured: e.notify.discord.configured, locked: e.notify.discord.locked, premium: true },
      telegram: { botTokenSet: Boolean(e.notify.telegram.botToken), chatId: e.notify.telegram.chatId, enabled: e.notify.telegram.enabled, on: e.notify.telegram.on, configured: e.notify.telegram.configured, locked: e.notify.telegram.locked, premium: true },
      email: {
        host: e.notify.email.host, port: e.notify.email.port, secure: e.notify.email.secure,
        user: e.notify.email.user, from: e.notify.email.from,
        passSet: Boolean(e.notify.email.pass), enabled: e.notify.email.enabled, on: e.notify.email.on,
        configured: e.notify.email.configured, locked: false, premium: false,
      },
    },
    // What to DO about a missing feature is different for someone with a shell
    // and someone without one, so the page gets the edition as well as the
    // upgrade catalogue.
    edition: e.edition,
    upgrade: e.upgrade,
    premiumLocked: e.premiumLocked,
    site: e.site,
    brand: e.brand,
    resetEmail: e.resetEmail,
    welcomeEmail: e.welcomeEmail,
    landing: e.landing,
    // Which values came from the environment (read-only origin hint for the UI).
    envDefaults: {
      feeRate: envcfg.defaultFeeRate,
      flatFee: envcfg.defaultFlatFee,
      targetMargin: envcfg.defaultTargetMargin,
    },
  };
}

// Map of admin form fields -> setting keys. Secret fields are only written when
// a non-empty value is supplied (blank means "leave unchanged").
const FIELD_MAP = {
  ebayClientId: { key: 'ebay_client_id' },
  ebayClientSecret: { key: 'ebay_client_secret', secret: true },
  ebayEnv: { key: 'ebay_env' },
  ebayMarketplace: { key: 'ebay_marketplace' },
  amazonAccessKey: { key: 'amazon_access_key' },
  amazonSecretKey: { key: 'amazon_secret_key', secret: true },
  amazonPartnerTag: { key: 'amazon_partner_tag' },
  amazonRegion: { key: 'amazon_region' },
  amazonHost: { key: 'amazon_host' },
  defaultFeeRate: { key: 'default_fee_rate', num: true },
  defaultFlatFee: { key: 'default_flat_fee', num: true },
  defaultTargetMargin: { key: 'default_target_margin', num: true },
  waToken: { key: 'wa_token', secret: true },
  waPhoneId: { key: 'wa_phone_id' },
  waTo: { key: 'wa_to' },
  waApiVersion: { key: 'wa_api_version' },
  waMsgType: { key: 'wa_msg_type' },
  waTemplate: { key: 'wa_template' },
  waLang: { key: 'wa_lang' },
  waBodyParam: { key: 'wa_body_param' },
  waUpdatesOn: { key: 'wa_updates_on' },
  notifyChannel: { key: 'notify_channel' },
  notifyWaOn: { key: 'notify_wa_on' },
  notifyDiscordOn: { key: 'notify_discord_on' },
  notifyTgOn: { key: 'notify_tg_on' },
  notifyEmailOn: { key: 'notify_email_on' },
  discordWebhook: { key: 'discord_webhook_url', secret: true },
  tgBotToken: { key: 'tg_bot_token', secret: true },
  tgChatId: { key: 'tg_chat_id' },
  smtpHost: { key: 'smtp_host' },
  smtpPort: { key: 'smtp_port', num: true },
  smtpSecure: { key: 'smtp_secure' },
  smtpUser: { key: 'smtp_user' },
  smtpPass: { key: 'smtp_pass', secret: true },
  smtpFrom: { key: 'smtp_from' },
  siteUrl: { key: 'site_url' },
  siteName: { key: 'site_name' },
  brandName: { key: 'brand_name' },
  brandTagline: { key: 'brand_tagline' },
  resetEmailSubject: { key: 'reset_email_subject' },
  resetEmailHtml: { key: 'reset_email_html' },
  welcomeEmailSubject: { key: 'welcome_email_subject' },
  welcomeEmailHtml: { key: 'welcome_email_html' },
};

export function updateFromAdmin(payload = {}) {
  for (const [field, meta] of Object.entries(FIELD_MAP)) {
    if (!(field in payload)) continue;
    let v = payload[field];
    if (meta.secret) {
      // Blank secret = keep existing; explicit clearing handled below.
      if (v === '' || v == null) continue;
    }
    if (meta.num && v !== '' && v != null) {
      const n = Number(v);
      if (!Number.isFinite(n)) continue;
      v = n;
    }
    setRaw(meta.key, v);
  }
  return adminView();
}

// Explicitly clear a stored secret (so the admin can remove a key).
export function clearSecret(which) {
  if (which === 'ebay') setRaw('ebay_client_secret', '');
  if (which === 'amazon') setRaw('amazon_secret_key', '');
  if (which === 'whatsapp') setRaw('wa_token', '');
  if (which === 'discord') setRaw('discord_webhook_url', '');
  if (which === 'telegram') setRaw('tg_bot_token', '');
  if (which === 'email') setRaw('smtp_pass', '');
}
