// Admin page: API credentials, pricing defaults, and user management.
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const api = {
  async req(method, path, body) {
    const opts = { method, headers: {} };
    if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    const res = await fetch('/api' + path, opts);
    // 401 means the session is genuinely gone, so signing in again is the fix.
    if (res.status === 401) { window.location = '/login'; throw new Error('unauthorized'); }
    // 403 used to navigate to /app. That made ANY forbidden sub-resource eject
    // the admin from the whole admin page — one endpoint the account can't see
    // and the page you use to fix things vanishes out from under you. Report it
    // instead; only the section that asked for it goes dark.
    if (res.status === 403) throw new Error('not allowed for this account');
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; }
    catch {
      throw new Error(
        res.ok ? 'The server returned an unexpected response — try refreshing the page (Ctrl+Shift+R).'
               : `Request failed (${res.status}). Try refreshing the page.`
      );
    }
    if (!res.ok) throw new Error(data?.error || res.statusText);
    return data;
  },
  get: (p) => api.req('GET', p),
  post: (p, b) => api.req('POST', p, b),
  put: (p, b) => api.req('PUT', p, b),
  del: (p) => api.req('DELETE', p),
};

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(t._t); t._t = setTimeout(() => t.classList.remove('show'), 2200);
}

// ---- the paid upgrade ----
//
// This build ships none of the premium code, so everything below is DESCRIPTIVE:
// what Pro adds, and how to get it. There is no key field and no "unlock"
// button, because installing Pro is not self-service yet — the server says so
// in `upgrade.notice` and the page repeats exactly that rather than inventing a
// button that would 404.
let UPGRADE = null, EDITION = null;

/** One sentence on how an upgrade actually happens, tailored to who runs the box. */
function upgradeSentence() {
  const notice = UPGRADE?.notice || 'Upgrading is arranged by getting in touch.';
  // A hosted customer has no shell, so their route is support either way — and
  // if we published a support desk, link that rather than a sales page.
  if (EDITION?.managed && EDITION.supportUrl) {
    return `${esc(notice)} <a href="${esc(EDITION.supportUrl)}" target="_blank" rel="noopener">Contact support</a>.`;
  }
  if (UPGRADE?.url) {
    return `${esc(notice)} <a href="${esc(UPGRADE.url)}" target="_blank" rel="noopener">More about ${esc(UPGRADE.product || 'Pro')}</a>.`;
  }
  return esc(notice);
}

function renderUpgrade() {
  const list = $('#upgradeFeatures');
  const how = $('#upgradeHow');
  if (!list || !how) return;
  const features = UPGRADE?.features || [];
  list.innerHTML = features.length
    ? features.map((f) => `<div class="user-row">
        <span class="uname">${esc(f.name)}</span>
        <span class="pill">Pro</span>
        <span class="muted" style="font-size:12px">${esc(f.blurb)}</span>
      </div>`).join('')
    : '<p class="muted" style="margin:6px 0">Nothing to list.</p>';
  how.innerHTML = `<strong>How to upgrade.</strong> ${upgradeSentence()}`;
}

// Three distinct states, because "off" for three different reasons is three
// different fixes: connect it, upgrade, or nothing.
function badge(cfg) {
  if (cfg && typeof cfg === 'object') {
    if (cfg.enabled) return '<span class="pill ok">connected</span>';
    if (cfg.locked) return '<span class="pill premium-locked" title="Credentials saved — this build has no code that can use them">needs the Pro upgrade</span>';
    if (cfg.premium) return '<span class="pill off">not set · Pro</span>';
    return '<span class="pill off">demo / not set</span>';
  }
  return cfg ? '<span class="pill ok">connected</span>' : '<span class="pill off">demo / not set</span>';
}

async function loadSettings() {
  const s = await api.get('/admin/settings');
  $('#ebayBadge').innerHTML = badge(s.ebay);
  $('#amazonBadge').innerHTML = badge(s.amazon);

  $('#ebayClientId').value = s.ebay.clientId || '';
  $('#ebayClientSecret').placeholder = s.ebay.clientSecretSet ? '•••••••• (saved — leave blank to keep)' : 'not set';
  $('#ebayClientSecret').value = '';
  $('#ebayEnv').value = s.ebay.env || 'PRODUCTION';
  $('#ebayMarketplace').value = s.ebay.marketplace || 'EBAY_US';

  $('#amazonAccessKey').value = s.amazon.accessKey || '';
  $('#amazonSecretKey').placeholder = s.amazon.secretKeySet ? '•••••••• (saved — leave blank to keep)' : 'not set';
  $('#amazonSecretKey').value = '';
  $('#amazonPartnerTag').value = s.amazon.partnerTag || '';
  $('#amazonRegion').value = s.amazon.region || '';
  $('#amazonHost').value = s.amazon.host || '';

  // Percentages shown to the user, stored as fractions.
  $('#defaultFeeRate').value = (s.defaults.feeRate * 100).toFixed(1);
  $('#defaultFlatFee').value = s.defaults.flatFee;
  $('#defaultTargetMargin').value = Math.round(s.defaults.targetMargin * 100);

  // Notification integrations (credentials live under API integrations)
  const n = s.notify;
  const savedPh = '•••••••• (saved — leave blank to keep)';
  // WhatsApp
  $('#waToken').placeholder = n.whatsapp.configured ? savedPh : 'not set'; $('#waToken').value = '';
  $('#waPhoneId').value = s.whatsapp.phoneId || '';
  $('#waTo').value = s.whatsapp.to || '';
  $('#waApiVersion').value = s.whatsapp.apiVersion || 'v20.0';
  $('#waMsgType').value = s.whatsapp.msgType || 'template';
  $('#waTemplate').value = s.whatsapp.template || '';
  $('#waLang').value = s.whatsapp.lang || '';
  $('#waBodyParam').checked = !!s.whatsapp.bodyParam;
  $('#waUpdatesOn').checked = !!s.whatsapp.updatesOn;
  $('#waBadge').innerHTML = badge(n.whatsapp);
  // Discord
  $('#discordWebhook').placeholder = n.discord.webhookSet ? savedPh : 'not set'; $('#discordWebhook').value = '';
  $('#discordBadge').innerHTML = badge(n.discord);
  // Telegram
  $('#tgBotToken').placeholder = n.telegram.botTokenSet ? savedPh : 'not set'; $('#tgBotToken').value = '';
  $('#tgChatId').value = n.telegram.chatId || '';
  $('#tgBadge').innerHTML = badge(n.telegram);
  // Email
  $('#smtpHost').value = n.email.host || '';
  $('#smtpPort').value = n.email.port || 587;
  $('#smtpSecure').value = String(Boolean(n.email.secure));
  $('#smtpUser').value = n.email.user || '';
  $('#smtpPass').placeholder = n.email.passSet ? savedPh : 'not set'; $('#smtpPass').value = '';
  $('#smtpFrom').value = n.email.from || '';
  $('#smtpBadge').innerHTML = badge(n.email);
  // Per-channel notification toggles (only connected channels are actionable).
  renderChannelToggles(n);
  const activeCount = (n.activeChannels || []).length;
  $('#notifyBadge').innerHTML = activeCount
    ? `<span class="pill ok">${activeCount} on</span>` : '<span class="pill off">off</span>';

  // Explain the locked integrations once, at the top of the section, rather
  // than leaving the user to infer it from five padlocks.
  UPGRADE = s.upgrade || UPGRADE;
  EDITION = s.edition || EDITION;
  const locked = s.premiumLocked || [];
  renderUpgrade();
  const banner = $('#apiPlanNote');
  if (banner) {
    banner.className = locked.length ? 'callout bad' : 'card-sub';
    banner.innerHTML = (locked.length
      ? `<strong>${locked.join(', ')}</strong> ${locked.length === 1 ? 'has' : 'have'} credentials saved, but this build contains no code that can use ${locked.length === 1 ? 'it' : 'them'}. Your keys stay put and start working the moment you upgrade — nothing to re-enter. `
      : 'eBay, Amazon, WhatsApp, Discord and Telegram are part of the <strong>Pro upgrade</strong>, which this build does not include. Email (SMTP) is part of the core app, so password resets and welcome emails always send. ')
      + upgradeSentence();
  }

  // Site link
  $('#siteUrl').value = s.site.url || '';
  $('#siteName').value = s.site.name || '';

  // Branding
  $('#brandName').value = s.brand.name || '';
  $('#brandTagline').value = s.brand.tagline || '';

  // Reset email template
  $('#resetEmailSubject').value = s.resetEmail.subject || '';
  $('#resetEmailHtml').value = s.resetEmail.html || '';
  updateResetPreview();

  // Welcome email template
  if (s.welcomeEmail) {
    $('#welcomeEmailSubject').value = s.welcomeEmail.subject || '';
    $('#welcomeEmailHtml').value = s.welcomeEmail.html || '';
    updateWelcomePreview();
  }
}

// ---- reset email live preview ----
function renderTpl(tpl, vars) {
  return String(tpl || '').replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => (vars[k] != null ? vars[k] : ''));
}
function updateResetPreview() {
  const frame = $('#resetPreview');
  if (!frame) return;
  const sample = { name: 'Jordan', username: 'jordan', link: `${location.origin}/reset/EXAMPLE-TOKEN` };
  frame.srcdoc = renderTpl($('#resetEmailHtml').value, sample);
}
function updateWelcomePreview() {
  const frame = $('#welcomePreview');
  if (!frame) return;
  const brand = ($('#brandName').value || 'Tech Garage');
  const sample = { name: 'Jordan', brand, link: `${location.origin}/invite/EXAMPLE-TOKEN` };
  frame.srcdoc = renderTpl($('#welcomeEmailHtml').value, sample);
}
document.addEventListener('input', (e) => {
  if (!e.target) return;
  if (e.target.id === 'resetEmailHtml') updateResetPreview();
  if (e.target.id === 'welcomeEmailHtml') updateWelcomePreview();
});

// ---- test buttons ----
function testMsg(el, text, ok) {
  el.textContent = text;
  el.style.color = ok === true ? 'var(--pos)' : ok === false ? 'var(--neg)' : 'var(--muted)';
}
$('#testChannelBtn')?.addEventListener('click', async () => {
  const el = $('#testChannelMsg');
  testMsg(el, 'Sending…');
  try {
    const r = await api.post('/admin/test-channel');
    const sent = /: sent/.test(r.summary) && !/FAILED|not sent/.test(r.summary);
    testMsg(el, r.summary, sent ? true : false);
  } catch (e) { testMsg(el, e.message, false); }
});
$('#testEmailBtn')?.addEventListener('click', async () => {
  const el = $('#testEmailMsg');
  testMsg(el, 'Sending…');
  try {
    const r = await api.post('/admin/test-email');
    testMsg(el, `✓ Sent to ${r.to}`, true);
  } catch (e) { testMsg(el, e.message, false); }
});

// Render an enable toggle per notification channel. Connected channels can be
// switched on; unconnected ones are disabled with a hint.
const NOTIFY_CHANNELS = [
  { key: 'whatsapp', id: 'notifyWaOn', label: 'WhatsApp' },
  { key: 'discord', id: 'notifyDiscordOn', label: 'Discord' },
  { key: 'telegram', id: 'notifyTgOn', label: 'Telegram' },
  { key: 'email', id: 'notifyEmailOn', label: 'Email (SMTP)' },
];
function renderChannelToggles(n) {
  const box = $('#channelToggles');
  if (!box) return;
  box.innerHTML = NOTIFY_CHANNELS.map((c) => {
    const ch = n[c.key] || {};
    const disabled = ch.enabled ? '' : 'disabled';
    const checked = ch.on && ch.enabled ? 'checked' : '';
    const status = ch.enabled
      ? '<span class="pill ok">connected</span>'
      : '<span class="pill off">not connected</span>';
    const hint = ch.enabled ? '' : '<a href="#apis" style="font-size:12px">connect under API integrations</a>';
    return `<label class="chan-toggle">
      <input type="checkbox" id="${c.id}" ${checked} ${disabled} />
      <span class="chan-name">${c.label}</span>
      <span class="chan-status">${status}</span>
      <span class="chan-hint">${hint}</span>
    </label>`;
  }).join('');
}

function collectSettings() {
  const numOrEmpty = (id) => { const v = $('#' + id).value; return v === '' ? '' : Number(v); };
  const payload = {
    ebayClientId: $('#ebayClientId').value.trim(),
    ebayEnv: $('#ebayEnv').value,
    ebayMarketplace: $('#ebayMarketplace').value.trim(),
    amazonAccessKey: $('#amazonAccessKey').value.trim(),
    amazonPartnerTag: $('#amazonPartnerTag').value.trim(),
    amazonRegion: $('#amazonRegion').value.trim(),
    amazonHost: $('#amazonHost').value.trim(),
    waPhoneId: $('#waPhoneId').value.trim(),
    waTo: $('#waTo').value.trim(),
    waApiVersion: $('#waApiVersion').value.trim() || 'v20.0',
    waMsgType: $('#waMsgType').value,
    waTemplate: $('#waTemplate').value.trim(),
    waLang: $('#waLang').value.trim() || 'en_US',
    waBodyParam: $('#waBodyParam').checked ? 'true' : '',
    waUpdatesOn: $('#waUpdatesOn').checked ? 'true' : '',
    notifyChannel: '', // retire the legacy single-channel setting; toggles rule now
    notifyWaOn: $('#notifyWaOn')?.checked ? 'true' : '',
    notifyDiscordOn: $('#notifyDiscordOn')?.checked ? 'true' : '',
    notifyTgOn: $('#notifyTgOn')?.checked ? 'true' : '',
    notifyEmailOn: $('#notifyEmailOn')?.checked ? 'true' : '',
    tgChatId: $('#tgChatId').value.trim(),
    smtpHost: $('#smtpHost').value.trim(),
    smtpPort: $('#smtpPort').value.trim(),
    smtpSecure: $('#smtpSecure').value,
    smtpUser: $('#smtpUser').value.trim(),
    smtpFrom: $('#smtpFrom').value.trim(),
    siteUrl: $('#siteUrl').value.trim(),
    siteName: $('#siteName').value.trim(),
    brandName: $('#brandName').value.trim(),
    brandTagline: $('#brandTagline').value.trim(),
    resetEmailSubject: $('#resetEmailSubject').value.trim(),
    resetEmailHtml: $('#resetEmailHtml').value,
    welcomeEmailSubject: $('#welcomeEmailSubject').value.trim(),
    welcomeEmailHtml: $('#welcomeEmailHtml').value,
  };
  // Secrets: only send when the admin typed something (blank = keep existing).
  const es = $('#ebayClientSecret').value; if (es) payload.ebayClientSecret = es;
  const as = $('#amazonSecretKey').value; if (as) payload.amazonSecretKey = as;
  const wt = $('#waToken').value; if (wt) payload.waToken = wt;
  const dw = $('#discordWebhook').value; if (dw) payload.discordWebhook = dw;
  const tg = $('#tgBotToken').value; if (tg) payload.tgBotToken = tg;
  const sp = $('#smtpPass').value; if (sp) payload.smtpPass = sp;
  // Percentages -> fractions.
  const fee = numOrEmpty('defaultFeeRate'); if (fee !== '') payload.defaultFeeRate = fee / 100;
  const flat = numOrEmpty('defaultFlatFee'); if (flat !== '') payload.defaultFlatFee = flat;
  const margin = numOrEmpty('defaultTargetMargin'); if (margin !== '') payload.defaultTargetMargin = margin / 100;
  return payload;
}

$$('[data-save]').forEach((btn) =>
  btn.addEventListener('click', async () => {
    try { await api.put('/admin/settings', collectSettings()); toast('Saved'); await loadSettings(); }
    catch (e) { toast('Error: ' + e.message); }
  })
);

$$('[data-clear-secret]').forEach((btn) =>
  btn.addEventListener('click', async () => {
    if (!confirm('Clear the saved secret for ' + btn.dataset.clearSecret + '?')) return;
    try { await api.post('/admin/settings/clear-secret', { provider: btn.dataset.clearSecret }); toast('Secret cleared'); await loadSettings(); }
    catch (e) { toast('Error: ' + e.message); }
  })
);

// ---- landing sample deals ----
let DEALS = [];
async function loadDeals() {
  try { const r = await api.get('/admin/landing'); DEALS = r.deals || []; renderDeals(); } catch { /* ignore */ }
}
// A deal linked to a live inventory item: its title/spec/price/photo come from
// the item at render time, so only "Was" (compare-at) and emoji are editable.
function linkedDealHTML(d, i) {
  const img = d.itemId ? `/api/public/item/${d.itemId}/image` : null;
  return `<div class="deal-linked">
    ${img ? `<img src="${img}" alt="" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'deal-linked-ph',textContent:'💻'}))" />` : '<div class="deal-linked-ph">💻</div>'}
    <div class="dl-body">
      <div class="dl-title">🔗 ${esc(d.title || 'Inventory item #' + d.itemId)}</div>
      <div class="dl-sub">Live listing · uses the item's current price &amp; photo · hidden once it sells</div>
    </div>
    <input placeholder="Was ($)" title="Optional 'compare at' price to show savings" type="number" data-df="was" data-i="${i}" value="${d.was ?? ''}" />
    <input placeholder="Emoji" data-df="icon" data-i="${i}" value="${esc(d.icon || '')}" maxlength="4" style="width:64px" />
    <button class="btn danger small" data-deldeal="${i}" type="button">Remove</button>
  </div>`;
}
function manualDealHTML(d, i) {
  return `<div class="deal-edit">
      <div class="deal-edit-media">
        ${d.image ? `<img src="/api/landing/media/${d.image}" alt="" />` : '<div class="deal-edit-ph">' + esc(d.icon || '💻') + '</div>'}
        <label class="btn secondary small" style="cursor:pointer;text-align:center">${d.image ? 'Change photo' : 'Add photo'}<input type="file" accept="image/*" data-dealimg="${i}" style="display:none" /></label>
        ${d.image ? `<button class="btn secondary small" data-delimg="${i}" type="button">Remove photo</button>` : ''}
      </div>
      <div class="deal-edit-fields">
        <input placeholder="Title" data-df="title" data-i="${i}" value="${esc(d.title || '')}" />
        <input placeholder="Spec line — e.g. 14&quot; · i7 · 16GB · 512GB" data-df="spec" data-i="${i}" value="${esc(d.spec || '')}" />
        <div class="grid-3">
          <input placeholder="Was ($)" type="number" data-df="was" data-i="${i}" value="${d.was ?? ''}" />
          <input placeholder="Now ($)" type="number" data-df="now" data-i="${i}" value="${d.now ?? ''}" />
          <input placeholder="Emoji" data-df="icon" data-i="${i}" value="${esc(d.icon || '')}" maxlength="4" />
        </div>
      </div>
      <button class="btn danger small" data-deldeal="${i}" type="button">Delete</button>
    </div>`;
}
function renderDeals() {
  const box = $('#dealsEditor');
  if (!box) return;
  box.innerHTML = DEALS.length
    ? DEALS.map((d, i) => (d.itemId ? linkedDealHTML(d, i) : manualDealHTML(d, i))).join('')
    : '<p class="muted" style="margin:6px 0">No deals yet — add one, or pick from your inventory.</p>';
  $$('#dealsEditor [data-df]').forEach((inp) => inp.addEventListener('input', () => {
    const i = Number(inp.dataset.i), f = inp.dataset.df;
    DEALS[i][f] = (f === 'was' || f === 'now') ? (inp.value === '' ? null : Number(inp.value)) : inp.value;
  }));
  $$('#dealsEditor [data-deldeal]').forEach((b) => b.addEventListener('click', () => { DEALS.splice(Number(b.dataset.deldeal), 1); renderDeals(); }));
  $$('#dealsEditor [data-dealimg]').forEach((inp) => inp.addEventListener('change', async () => {
    const file = inp.files[0]; if (!file) return;
    try {
      const res = await fetch('/api/admin/landing/image', { method: 'POST', headers: { 'Content-Type': file.type }, body: file });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'upload failed');
      DEALS[Number(inp.dataset.dealimg)].image = data.id; renderDeals();
    } catch (e) { toast('Error: ' + e.message); }
  }));
  $$('#dealsEditor [data-delimg]').forEach((b) => b.addEventListener('click', () => {
    const i = Number(b.dataset.delimg), id = DEALS[i].image;
    DEALS[i].image = null; renderDeals();
    if (id) api.del('/admin/landing/image/' + id).catch(() => {});
  }));
}
$('#addDealBtn')?.addEventListener('click', () => { DEALS.push({ title: '', spec: '', was: null, now: null, icon: '💻', image: null }); renderDeals(); });

// Pick a real inventory item to advertise on the landing page (a linked deal).
$('#addFromInvBtn')?.addEventListener('click', openInventoryPicker);
async function openInventoryPicker() {
  let items;
  try { items = await api.get('/admin/landing/items'); }
  catch (e) { return toast('Error: ' + e.message); }
  let modal = $('#invPicker');
  if (!modal) { modal = document.createElement('div'); modal.id = 'invPicker'; modal.className = 'overlay center'; document.body.appendChild(modal); }
  const linked = new Set(DEALS.filter((d) => d.itemId).map((d) => d.itemId));
  const rows = items.length ? items.map((it) => {
    const already = linked.has(it.id);
    const thumb = it.images && it.images.length ? `<img src="/api/public/item/${it.id}/image" alt="" />` : '<div class="deal-linked-ph">💻</div>';
    return `<button class="inv-pick-row" data-pick="${it.id}" ${already ? 'disabled' : ''} type="button">
      ${thumb}
      <span class="ipr-title">${esc(it.title)}</span>
      <span class="ipr-price">${money(it.price)}</span>
      ${already ? '<span class="pill off">added</span>' : ''}
    </button>`;
  }).join('') : '<p class="muted" style="padding:16px">No for-sale items yet. List an item (in stock or listed, with a price) first.</p>';
  modal.innerHTML = `<div class="modal-card">
    <div class="cart-head"><h2>Advertise an inventory item</h2><button class="close-x" id="invPickClose">&times;</button></div>
    <div class="inv-pick-list">${rows}</div>
  </div>`;
  modal.classList.add('open');
  const close = () => modal.classList.remove('open');
  $('#invPickClose').addEventListener('click', close);
  modal.onclick = (e) => { if (e.target === modal) close(); };
  $$('#invPicker [data-pick]').forEach((b) => b.addEventListener('click', () => {
    const it = items.find((x) => x.id === Number(b.dataset.pick));
    DEALS.push({ itemId: it.id, title: it.title, was: null, now: null, icon: '💻', image: null });
    close(); renderDeals();
    toast('Added — click “Save landing deals” to publish');
  }));
}
$('#saveDealsBtn')?.addEventListener('click', async () => {
  const m = $('#dealsMsg');
  try { const r = await api.put('/admin/landing', { deals: DEALS }); DEALS = r.deals; renderDeals(); m.textContent = '✓ Saved — live on the landing page'; m.style.color = 'var(--pos)'; }
  catch (e) { m.textContent = e.message; m.style.color = 'var(--neg)'; }
});

// ---- users ----
let me = null;
async function loadMe() {
  try {
    const c = await api.get('/config');
    me = c.user;
    if (c.brand?.name) document.title = `${c.brand.name} · Admin`;
    renderUserMenu();
  } catch {}
}
function renderUserMenu() {
  const el = $('#userMenu');
  if (!me) return;
  el.innerHTML =
    `<span class="user-name">${esc(me.username)} <span class="role-tag">admin</span></span>` +
    '<button class="btn secondary small" id="logoutBtn">Log out</button>';
  $('#logoutBtn').addEventListener('click', async () => { try { await api.post('/auth/logout'); } catch {} window.location = '/login'; });
}

async function loadUsers() {
  const users = await api.get('/admin/users');
  $('#usersList').innerHTML = users.map((u) => `
    <div class="user-row">
      <span class="uname">${esc(u.username)} ${u.role === 'admin' ? '<span class="role-tag">admin</span>' : ''}
        <span class="muted" style="font-weight:400;font-size:12px">${u.email ? '· ' + esc(u.email) : '· no email'}${u.phone ? ' · ' + esc(u.phone) : ''}</span>
      </span>
      <select class="role-select" data-role="${u.id}" data-name="${esc(u.username)}" data-cur="${u.role}" ${me && u.username === me.username ? 'disabled title="You can\'t change your own role"' : ''}>
        <option value="customer" ${u.role === 'customer' ? 'selected' : ''}>Customer</option>
        <option value="user" ${u.role === 'user' ? 'selected' : ''}>Staff</option>
        <option value="admin" ${u.role === 'admin' ? 'selected' : ''}>Admin</option>
      </select>
      <button class="btn secondary small" data-email="${u.id}" data-name="${esc(u.username)}" data-cur="${esc(u.email || '')}">Edit email</button>
      <button class="btn secondary small" data-reset="${u.id}" data-name="${esc(u.username)}">Reset password</button>
      ${me && u.username === me.username ? '' : `<button class="btn danger small" data-del="${u.id}" data-name="${esc(u.username)}">Delete</button>`}
    </div>`).join('');
  const ROLE_LABEL = { customer: 'Customer', user: 'Staff', admin: 'Admin' };
  $$('#usersList select.role-select').forEach((sel) => sel.addEventListener('change', async () => {
    const to = sel.value;
    if (!confirm(`Change "${sel.dataset.name}" to ${ROLE_LABEL[to]}?`)) { sel.value = sel.dataset.cur; return; }
    try { await api.put('/admin/users/' + sel.dataset.role, { role: to }); toast(`Now ${ROLE_LABEL[to]}`); await loadUsers(); }
    catch (e) { toast('Error: ' + e.message); sel.value = sel.dataset.cur; }
  }));
  $$('#usersList [data-email]').forEach((b) => b.addEventListener('click', async () => {
    const email = prompt(`Contact email for "${b.dataset.name}":`, b.dataset.cur || '');
    if (email === null) return;
    try { await api.put('/admin/users/' + b.dataset.email, { email: email.trim() }); toast('Email updated'); await loadUsers(); }
    catch (e) { toast('Error: ' + e.message); }
  }));
  $$('#usersList [data-del]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm(`Delete user "${b.dataset.name}"?`)) return;
    try { await api.del('/admin/users/' + b.dataset.del); toast('User deleted'); await loadUsers(); }
    catch (e) { toast('Error: ' + e.message); }
  }));
  $$('#usersList [data-reset]').forEach((b) => b.addEventListener('click', async () => {
    const pw = prompt(`New password for "${b.dataset.name}" (min 8 chars):`);
    if (!pw) return;
    try { await api.put('/admin/users/' + b.dataset.reset, { password: pw }); toast('Password reset'); }
    catch (e) { toast('Error: ' + e.message); }
  }));
}

// ---- adding people ----
//
// One form, two ways in. They used to be two separate blocks — "add a user"
// (username + password + role) and "invite a customer" (name + email + phone) —
// which made the same act look like two unrelated features, and quietly threw
// away the name, email and phone of anyone added the first way.
//
// The two ways in are not interchangeable, and the form says so rather than
// letting you pick an impossible combination: redeeming an invite always
// creates a CUSTOMER (auth.acceptInvite hard-codes the role, because the link
// travels by email and whoever opens it decides their own username). So staff
// and admins are created directly, with a password you set.
function personMethod() {
  return $('#newRole').value === 'customer' ? $('#newMethod').value : 'password';
}

function syncPersonForm() {
  const role = $('#newRole').value;
  const inviteOpt = $('#newMethod').querySelector('option[value="invite"]');
  const canInvite = role === 'customer';

  inviteOpt.disabled = !canInvite;
  if (!canInvite && $('#newMethod').value === 'invite') $('#newMethod').value = 'password';

  const method = personMethod();
  $('#credFields').hidden = method !== 'password';
  $('#addPersonBtn').textContent = method === 'invite' ? 'Create invite link' : 'Add user';
  $('#addPersonNote').textContent = canInvite
    ? (method === 'invite'
        ? 'They get a link, choose their own username and password, and land in the storefront. The link is valid for 14 days.'
        : 'You set their credentials, so pass them on yourself — nothing is emailed.')
    : 'Staff and admin accounts are created directly: an invite link always makes a customer, so it cannot carry this role.';
}

$('#addPersonBtn').addEventListener('click', async () => {
  const name = $('#newName').value.trim();
  const email = $('#newEmail').value.trim();
  const phone = $('#newPhone').value.trim();
  const clearPerson = () => {
    $('#newName').value = ''; $('#newEmail').value = ''; $('#newPhone').value = '';
    $('#newUsername').value = ''; $('#newPassword').value = '';
  };

  if (personMethod() === 'invite') {
    try {
      const r = await api.post('/admin/invites', { name, email, phone });
      $('#inviteLink').value = r.link;
      $('#inviteLinkBox').style.display = 'block';
      clearPerson();
      toast('Invite created — copy the link');
      await loadInvites();
    } catch (e) { toast('Error: ' + e.message); }
    return;
  }

  const username = $('#newUsername').value.trim();
  const password = $('#newPassword').value;
  if (!username || !password) return toast('Enter a username and password');
  try {
    // name/email/phone go with the account now. The old direct-add form
    // collected none of them, so a staff member had no email to reset against.
    await api.post('/admin/users', { username, password, role: $('#newRole').value, name, email, phone });
    clearPerson();
    toast('User added'); await loadUsers();
  } catch (e) { toast('Error: ' + e.message); }
});

$('#newRole').addEventListener('change', syncPersonForm);
$('#newMethod').addEventListener('change', syncPersonForm);
syncPersonForm();
$('#copyInviteBtn').addEventListener('click', async () => {
  const el = $('#inviteLink');
  el.select();
  try { await navigator.clipboard.writeText(el.value); toast('Link copied'); }
  catch { document.execCommand('copy'); toast('Link copied'); }
});

let invitesExpanded = false;
const INVITES_PREVIEW = 5;
async function loadInvites() {
  const invites = await api.get('/admin/invites');
  renderInvites(invites);
}
function renderInvites(invites) {
  const box = $('#invitesList');
  if (!invites.length) { box.innerHTML = '<p class="muted" style="margin:6px 0">No invites yet.</p>'; return; }
  const shown = invitesExpanded ? invites : invites.slice(0, INVITES_PREVIEW);
  const rows = shown.map((i) => `<div class="user-row">
      <span class="uname">${esc(i.name || '(no name)')} <span class="muted" style="font-weight:400;font-size:12px">${esc(i.email || '')} ${esc(i.phone || '')}</span></span>
      <span class="pill ${i.status === 'accepted' ? 'ok' : i.status === 'expired' ? 'off' : 'in_stock'}">${i.status}</span>
      <button class="btn danger small" data-delinv="${i.id}">Delete</button>
    </div>`).join('');
  const toggle = invites.length > INVITES_PREVIEW
    ? `<button class="btn secondary small" id="invToggle" type="button" style="margin-top:8px">${invitesExpanded ? 'Show fewer' : `Show all ${invites.length} invites`}</button>`
    : '';
  box.innerHTML = rows + toggle;
  $$('#invitesList [data-delinv]').forEach((b) => b.addEventListener('click', async () => {
    await api.del('/admin/invites/' + b.dataset.delinv); toast('Invite deleted'); await loadInvites();
  }));
  const t = $('#invToggle');
  if (t) t.addEventListener('click', () => { invitesExpanded = !invitesExpanded; renderInvites(invites); });
}

// ---- purchase requests ----
const money = (n) => (n == null ? '—' : '$' + Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
// Purchase requests now move through a real lifecycle rather than flipping a
// single handled flag. The shopper sees every one of these transitions in their
// own order history, and gets an email — so the wording matters.
const REQ_STATUS = {
  new: ['in_stock', 'New'], handled: ['in_stock', 'Handled'],
  reserved: ['listed', 'Reserved'], paid: ['sold', 'Paid'],
  shipped: ['sold', 'Shipped'], completed: ['sold', 'Completed'],
  declined: ['scrapped', 'Declined'], cancelled: ['scrapped', 'Cancelled'],
};
const NEXT_BY_STATUS = {
  new: ['reserved', 'declined', 'cancelled'],
  handled: ['reserved', 'paid', 'completed', 'declined', 'cancelled'],
  reserved: ['paid', 'declined', 'cancelled'],
  paid: ['shipped', 'completed', 'cancelled'],
  shipped: ['completed'],
  completed: [], declined: [], cancelled: [],
};

async function loadRequests() {
  const reqs = await api.get('/admin/requests');
  const open = reqs.filter((r) => ['new', 'handled', 'reserved', 'paid', 'shipped'].includes(r.status)).length;
  $('#reqBadge').innerHTML = open ? `<span class="pill in_stock">${open} open</span>` : '';
  $('#requestsList').innerHTML = reqs.length
    ? reqs.map(requestRowHTML).join('')
    : '<p class="muted" style="margin:6px 0">No purchase requests yet.</p>';
  wireRequestRows();
}

function requestRowHTML(r) {
  const lines = (r.items && r.items.length ? r.items : []).map((it) => {
    const us = (it.upgrades || []).map((u) => esc(u.label)).join(', ');
    const q = Number(it.qty) > 1 ? `${it.qty}× ` : '';
    return `${q}${esc(it.item_title)} — ${money(it.subtotal)}${us ? ' (+ ' + us + ')' : ''}`;
  });
  const ups = (r.upgrades || []).map((u) => `${esc(u.label)} (+${money(u.price_delta)})`).join(', ');
  const [tone, label] = REQ_STATUS[r.status] || ['in_stock', r.status];
  const next = NEXT_BY_STATUS[r.status] || [];

  // An unanswered offer leaves the shopper guessing, so it gets its own
  // prompt rather than being buried in the status dropdown.
  const offerBlock = r.offer_price == null ? '' : (() => {
    const decided = ['accepted', 'declined', 'countered'].includes(r.offer_status);
    if (decided) return `<div class="req-offer"><span class="pill ${r.offer_status === 'accepted' ? 'sold' : 'scrapped'}">offer ${esc(r.offer_status)}</span> ${money(r.offer_price)}${r.offer_note ? ` — ${esc(r.offer_note)}` : ''}</div>`;
    return `<div class="req-offer needs-answer">
      <strong>Offer of ${money(r.offer_price)} awaiting your answer</strong>
      <input class="offer-note" data-offer-note="${r.id}" placeholder="Optional reply to the customer…" />
      <div style="display:flex;gap:6px;flex-wrap:wrap">
        <button class="btn small" data-offer="${r.id}" data-decision="accepted">Accept</button>
        <button class="btn secondary small" data-offer="${r.id}" data-decision="countered">Counter</button>
        <button class="btn secondary small" data-offer="${r.id}" data-decision="declined">Decline</button>
      </div>
    </div>`;
  })();

  return `<div class="user-row req-row" style="align-items:flex-start">
    <div style="flex:1;min-width:0">
      <strong>#${r.id} ${esc(r.item_title || 'item')}</strong> — ${money(r.total_price)}
      <span class="pill ${tone}">${esc(label)}</span>
      <div class="muted" style="font-size:12px">
        ${esc(r.customer_name || r.customer_username || 'customer')}
        ${r.customer_email ? '· ' + esc(r.customer_email) : ''} ${r.customer_phone ? '· ' + esc(r.customer_phone) : ''}
        ${lines.length > 1 ? '<br>' + lines.join('<br>') : ups ? '<br>Upgrades: ' + ups : ''}
        ${r.message ? '<br>“' + esc(r.message) + '”' : ''}
        <br><span style="font-size:11px">${esc(r.created_at)} · ${esc(r.notified || '')}</span>
      </div>
      ${offerBlock}
    </div>
    ${next.length ? `<div class="req-actions">
      <select class="role-select" data-status="${r.id}">
        <option value="">Move to…</option>
        ${next.map((k) => `<option value="${k}">${esc((REQ_STATUS[k] || [, k])[1])}</option>`).join('')}
      </select>
      <input class="track-input" data-track="${r.id}" placeholder="Tracking (optional)" value="${esc(r.tracking || '')}" />
    </div>` : '<span class="muted" style="font-size:12px">closed</span>'}
  </div>`;
}

function wireRequestRows() {
  $$('#requestsList [data-status]').forEach((sel) => sel.addEventListener('change', async () => {
    const id = sel.dataset.status;
    const status = sel.value;
    if (!status) return;
    const tracking = $(`[data-track="${id}"]`)?.value.trim();
    try {
      await api.put('/admin/requests/' + id, { status, tracking: tracking || undefined });
      toast(`Request #${id} → ${status}. The customer has been told.`);
      await loadRequests();
    } catch (e) { toast(e.message); sel.value = ''; }
  }));
  $$('#requestsList [data-offer]').forEach((b) => b.addEventListener('click', async () => {
    const id = b.dataset.offer;
    const note = $(`[data-offer-note="${id}"]`)?.value.trim();
    try {
      await api.post(`/admin/requests/${id}/offer`, { decision: b.dataset.decision, note });
      toast('Customer notified of your answer');
      await loadRequests();
    } catch (e) { toast(e.message); }
  }));
}

// ---- visitor activity ----
function visitLabel(v) {
  if (v.kind === 'search') return 'Searched: “' + esc(v.query || '') + '”';
  if (v.kind === 'item') return '👁️ Looked at: “' + esc(v.item_title || 'an item') + '”';
  if (v.kind === 'request') return 'Requested to buy' + (v.item_title ? ': “' + esc(v.item_title) + '”' : '');
  return 'Opened the shop';
}
function parseUA(ua) {
  ua = ua || '';
  let browser = 'Unknown', os = 'Unknown';
  if (/Edg\//.test(ua)) browser = 'Edge'; else if (/Chrome\//.test(ua)) browser = 'Chrome';
  else if (/Firefox\//.test(ua)) browser = 'Firefox'; else if (/Safari\//.test(ua)) browser = 'Safari';
  if (/Windows/.test(ua)) os = 'Windows'; else if (/Android/.test(ua)) os = 'Android';
  else if (/iPhone|iPad|iOS/.test(ua)) os = 'iOS'; else if (/Mac OS X/.test(ua)) os = 'macOS';
  else if (/Linux/.test(ua)) os = 'Linux';
  return `${browser} · ${os}`;
}
async function loadVisits() {
  const { stats, visits } = await api.get('/admin/visits?limit=8');
  $('#visitStats').innerHTML = `<span class="pill off">${stats.total} events · ${stats.uniqueVisitors} visitors · ${stats.searches} searches</span> <a href="/activity" style="font-size:13px;margin-left:8px">Open full log →</a>`;
  $('#visitsList').innerHTML = visits.length
    ? visits.map((v) => {
        const dev = v.device || {};
        return `<div class="user-row" style="align-items:flex-start">
          <div style="flex:1">
            <strong>${visitLabel(v)}</strong>
            <div class="muted" style="font-size:12px">
              ${esc(v.username || 'anonymous')} · ${esc(parseUA(v.user_agent))}
              ${dev.screen ? ' · ' + esc(dev.screen) : ''} ${dev.timezone ? ' · ' + esc(dev.timezone) : ''}
              · IP ${esc(v.ip || '—')}
              <br><span style="font-size:11px">${esc(v.created_at)}</span>
            </div>
          </div>
        </div>`;
      }).join('')
    : '<p class="muted" style="margin:6px 0">No activity yet.</p>';
}

async function loadResets() {
  const resets = await api.get('/admin/reset-requests');
  $('#resetsList').innerHTML = resets.length
    ? resets.map((r) => `<div class="user-row">
        <span class="uname">${esc(r.username)} <span class="muted" style="font-weight:400;font-size:12px">${esc(r.email || '')}</span></span>
        <span class="pill ${r.status === 'used' ? 'ok' : r.status === 'expired' ? 'off' : 'in_stock'}">${r.status}</span>
        <span class="muted" style="font-size:12px">${esc(r.created_at)}</span>
      </div>`).join('')
    : '<p class="muted" style="margin:6px 0">No reset requests.</p>';
}

async function loadWaitlist() {
  const list = await api.get('/admin/waitlist');
  const pending = list.filter((w) => (w.status || 'pending') === 'pending').length;
  $('#wlCount').innerHTML = pending ? `<span class="pill in_stock">${pending} pending</span>` : '';
  $('#waitlistList').innerHTML = list.length
    ? list.map((w) => {
        const status = w.status || 'pending';
        const pill = status === 'approved' ? '<span class="pill ok">approved</span>'
          : status === 'declined' ? '<span class="pill off">declined</span>'
          : '<span class="pill in_stock">pending</span>';
        const actions = status === 'approved'
          ? `<button class="btn secondary small" data-delwl="${w.id}">Remove</button>`
          : `<button class="btn small" data-approve="${w.id}" data-name="${esc(w.name || w.email || 'this person')}" ${w.email ? '' : 'title="No email on file — an invite link will be generated to copy"'}>✓ Approve</button>
             <button class="btn secondary small" data-decline="${w.id}">✕ Decline</button>
             <button class="btn danger small" data-delwl="${w.id}">Delete</button>`;
        return `<div class="user-row" style="align-items:flex-start">
        <div style="flex:1">
          <strong>${esc(w.name || '(no name)')}</strong> ${pill}
          <div class="muted" style="font-size:12px">
            ${w.email ? esc(w.email) : 'no email'}${w.phone ? ' · ' + esc(w.phone) : ''}
            ${w.message ? '<br>“' + esc(w.message) + '”' : ''}
            <br><span style="font-size:11px">${esc(w.created_at)}${w.device?.timezone ? ' · ' + esc(w.device.timezone) : ''}${w.ip ? ' · IP ' + esc(w.ip) : ''}</span>
          </div>
        </div>
        <div style="display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end">${actions}</div>
      </div>`;
      }).join('')
    : '<p class="muted" style="margin:6px 0">No signups yet.</p>';
  $$('#waitlistList [data-approve]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm(`Approve ${b.dataset.name} and send them a welcome/invite email?`)) return;
    try {
      const r = await api.post('/admin/waitlist/' + b.dataset.approve + '/approve');
      if (r.emailed) toast('Approved — welcome email sent ✓');
      else { toast('Approved — email not sent (' + (r.emailError || 'unknown') + ')'); prompt('Copy this invite link to send them manually:', r.link); }
      await loadWaitlist(); await loadInvites();
    } catch (e) { toast('Error: ' + e.message); }
  }));
  $$('#waitlistList [data-decline]').forEach((b) => b.addEventListener('click', async () => {
    try { await api.post('/admin/waitlist/' + b.dataset.decline + '/decline'); toast('Declined'); await loadWaitlist(); }
    catch (e) { toast('Error: ' + e.message); }
  }));
  $$('#waitlistList [data-delwl]').forEach((b) => b.addEventListener('click', async () => {
    await api.del('/admin/waitlist/' + b.dataset.delwl); toast('Removed'); await loadWaitlist();
  }));
}

// ---- side panel: highlight the section in view, expand Advanced on jump ----
(function sidePanel() {
  const links = $$('#adminNav a');
  if (!links.length) return;
  const sections = $$('.admin-section');
  const setActive = (id) => links.forEach((a) => a.classList.toggle('active', a.getAttribute('href') === '#' + id));

  if ('IntersectionObserver' in window) {
    const obs = new IntersectionObserver((entries) => {
      const visible = entries.filter((e) => e.isIntersecting)
        .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
      if (visible[0]) setActive(visible[0].target.id);
    }, { rootMargin: '-72px 0px -55% 0px', threshold: 0 });
    sections.forEach((s) => obs.observe(s));
  }

  links.forEach((a) => a.addEventListener('click', () => {
    const id = a.getAttribute('href').slice(1);
    setActive(id);
    const target = document.getElementById(id);
    if (target && target.tagName === 'DETAILS') target.open = true;
  }));

  // Any in-page "#section" link (e.g. "connect under API integrations") should
  // expand and reveal that collapsed section, not just scroll to a closed one.
  document.addEventListener('click', (e) => {
    const a = e.target.closest && e.target.closest('a[href^="#"]');
    if (!a) return;
    const id = a.getAttribute('href').slice(1);
    const target = document.getElementById(id);
    if (target && target.tagName === 'DETAILS') { target.open = true; setActive(id); }
  });

  // Arriving via /admin#section (e.g. from the welcome tour) opens that section.
  if (location.hash) {
    const target = document.querySelector(location.hash);
    if (target && target.tagName === 'DETAILS') { target.open = true; setActive(location.hash.slice(1)); }
  }

  // Expand / collapse all sections.
  const expandBtn = $('#expandAllBtn');
  if (expandBtn) {
    expandBtn.addEventListener('click', () => {
      const anyClosed = sections.some((s) => !s.open);
      sections.forEach((s) => (s.open = anyClosed));
      expandBtn.textContent = anyClosed ? 'Collapse all' : 'Expand all';
    });
  }
})();

async function loadSubscriptions() {
  const subs = await api.get('/admin/subscriptions');
  $('#subCount').innerHTML = subs.length ? `<span class="pill in_stock">${subs.length}</span>` : '';
  $('#subsList').innerHTML = subs.length
    ? subs.map((s) => `<div class="user-row">
        <span class="uname">${esc(s.name || s.username)} <span class="muted" style="font-weight:400;font-size:12px">${esc(s.email || 'no email')}</span></span>
        <span>${s.item_id ? '🔔 ' + esc(s.item_title || ('item #' + s.item_id)) : '<span class="pill in_stock">Store-wide · new stock</span>'}</span>
        <span class="muted" style="font-size:12px">${esc(s.created_at)}</span>
      </div>`).join('')
    : '<p class="muted" style="margin:6px 0">No stock subscriptions yet.</p>';
}

// ---- colour scheme ----
// Every colour in the UI is a CSS custom property, so theming is just an
// override stylesheet served from /api/theme.css. Six presets, each with a
// matching light and dark palette. Setting colours individually is part of the
// Pro upgrade and has no implementation here, so there is no editor to draw —
// twelve disabled swatches would only ever have been a tease.
let THEME = null, THEME_PRESETS = [];

// Re-fetch the generated stylesheet so a change is visible immediately.
function refreshThemeCss() {
  const link = document.querySelector('link[href^="/api/theme.css"]');
  if (link) link.href = `/api/theme.css?t=${Date.now()}`;
}

async function loadTheme() {
  const r = await api.get('/admin/theme');
  THEME = r.theme; THEME_PRESETS = r.presets || [];
  UPGRADE = r.upgrade || UPGRADE;
  EDITION = r.edition || EDITION;
  renderTheme();
}

function renderTheme() {
  if (!THEME) return;
  $('#themePresets').innerHTML = THEME_PRESETS.map((p) => `
    <button type="button" class="theme-card${p.key === THEME.preset ? ' active' : ''}" data-preset="${esc(p.key)}">
      <span class="tc-swatch">${p.swatch.map((c) => `<span style="background:${esc(c)}"></span>`).join('')}</span>
      <span class="tc-name">${esc(p.name)}</span>
      ${p.key === THEME.preset ? '<span class="tc-on">In use</span>' : ''}
    </button>`).join('');
  $('#themeMode').value = THEME.mode;

  const note = $('#themeUpgradeNote');
  if (note) {
    note.innerHTML = 'Fine-tune every colour to match your own brand, instead of picking one of the six schemes above. '
      + upgradeSentence();
  }
}

async function saveTheme(patch, msg) {
  try {
    const r = await api.put('/admin/theme', patch);
    THEME = r.theme;
    renderTheme(); refreshThemeCss(); toast(msg);
  } catch (e) { toast(e.message); }
}

function wireTheme() {
  $('#themePresets').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-preset]');
    if (btn) saveTheme({ preset: btn.dataset.preset }, 'Colour scheme updated');
  });
  $('#themeMode').addEventListener('change', (e) => saveTheme({ mode: e.target.value }, 'Appearance updated'));
}


// ---- storefront options -------------------------------------------------
const CONDITION_ROWS = ['new', 'refurbished', 'used', 'for parts'];
let SHOP_OPTS = {};

async function loadStorefront() {
  const s = await api.get('/admin/storefront');
  SHOP_OPTS = s.shop || {};
  $('#condNotes').innerHTML = CONDITION_ROWS.map((k) => `
    <label class="field"><span class="lbl">${esc(k)}</span>
      <input data-cond="${esc(k)}" value="${esc(s.conditionNotes?.[k] || '')}" placeholder="What this grade means in your shop…" />
    </label>`).join('');
  $('#shopOrderEmails').checked = !!SHOP_OPTS.orderEmails;
  $('#shopPublicCatalog').checked = !!SHOP_OPTS.publicCatalog;
}

function wireStorefront() {
  $('#condSave').addEventListener('click', async () => {
    const notes = {};
    $$('#condNotes [data-cond]').forEach((i) => { notes[i.dataset.cond] = i.value.trim(); });
    try { await api.put('/admin/storefront', { conditionNotes: notes }); toast('Condition definitions saved'); }
    catch (e) { toast(e.message); }
  });
  $('#shopOptsSave').addEventListener('click', async () => {
    try {
      await api.put('/admin/storefront', {
        shop: { orderEmails: $('#shopOrderEmails').checked, publicCatalog: $('#shopPublicCatalog').checked },
      });
      toast('Shopper options saved');
    } catch (e) { toast(e.message); }
  });
}

// ---- community directory --------------------------------------------------
// The only place the app sends shop data somewhere the owner does not control,
// so the UI states plainly what leaves and what never does.
let DIR = null;

async function loadDirectory() {
  const r = await api.get('/admin/directory');
  DIR = r.directory || {};
  renderDirectory(r);
}

function renderDirectory(r) {
  const d = DIR;
  $('#dirBadge').className = d.enabled ? 'pill ok' : 'pill off';
  $('#dirBadge').textContent = d.enabled ? (d.registeredAt ? 'listed' : 'on') : 'off';

  // Being in a directory is pointless if the link leads to a login wall, so
  // say so before they try to register rather than after it fails.
  const publicFace = r.publicCatalog || r.siteUrl;
  $('#dirIntro').className = `callout ${publicFace ? 'good' : 'bad'}`;
  $('#dirIntro').innerHTML = publicFace
    ? `Shoppers who find you in the directory will land on <strong>${esc(r.siteUrl || r.origin || 'your shop')}</strong>.`
    : `⚠️ <strong>Your shop has no public face yet.</strong> A directory entry that leads to a login page helps nobody. Turn on guest browsing under <a href="#storefront">Storefront</a>, or set your website URL under <a href="#branding">Site &amp; branding</a>, before registering.`;

  $('#dirEnabled').checked = !!d.enabled;
  $('#dirCountry').value = d.region?.country || '';
  $('#dirState').value = d.region?.state || '';
  $('#dirArea').value = d.region?.area || '';
  $('#dirPostal').value = d.region?.postalPrefix || '';
  $('#dirMode').value = d.mode || 'repo';
  $('#dirUrl').value = d.url || '';
  $('#dirRegistryUrl').value = d.registryUrl || '';
  applyDirMode(d.mode || 'repo');
  $('#dirContact').value = d.contact || '';
  $('#dirShowNearby').checked = !!d.showNearby;
  $('#dirShowFriends').checked = !!d.showFriends;
  $('#dirShareConnections').checked = !!d.shareConnections;
  $('#dirTrustedOnly').checked = !!d.trustedOnly;

  // Turning the strangers off is part of the Pro upgrade. The controls stay
  // visible, disabled, so it is obvious what upgrading buys rather than the
  // option simply not existing.
  $('#dirTrustedOnly').disabled = !d.canHideNearby;
  $('#dirShowNearby').disabled = !d.canHideNearby;
  $('#trustedOnlyPill').className = 'pill';
  $('#trustedOnlyPill').textContent = 'Pro';

  $('#dirNodeId').innerHTML = d.nodePublicKey
    ? `Your node id — share this with a friend so they can add your shop:<br><code class="mono" style="font-size:11px;word-break:break-all">${esc(d.nodePublicKey)}</code>
       ${d.lastPing ? `<br><span class="muted">Last ping ${esc(d.lastPing)}</span>` : ''}
       ${d.lastError ? `<br><span class="neg">Last error: ${esc(d.lastError)}</span>` : ''}`
    : '<span class="muted">A signing key is created the first time you turn the directory on. It is what proves listings came from your shop — nobody else can publish or delist as you.</span>';

  const shares = r.shares || [];
  $('#shareCount').innerHTML = shares.length ? `<span class="pill in_stock">${shares.length}</span>` : '';
  $('#sharesList').innerHTML = shares.length
    ? shares.map((sh) => `<div class="user-row">
        <span class="uname">${esc(sh.title)}</span>
        <span class="pill ${sh.status === 'published' ? 'ok' : sh.status === 'error' ? 'off' : 'in_stock'}">${esc(sh.status)}</span>
        <span class="muted" style="font-size:12px">${esc(sh.detail || sh.shared_at || '')}</span>
      </div>`).join('')
    : `<p class="muted" style="margin:6px 0">Nothing shared yet${r.shareable ? ` — ${r.shareable} item${r.shareable === 1 ? '' : 's'} ticked and waiting to publish.` : '.'}</p>`;

  renderPeers(r.peers || []);
}

// The two modes are genuinely different workflows, so the controls for the one
// you are not using are hidden rather than left to confuse.
function applyDirMode(mode) {
  const repo = mode !== 'server';
  $('#registryUrlField').style.display = repo ? '' : 'none';
  $('#serverUrlField').style.display = repo ? 'none' : '';
  $('#dirEntry').style.display = repo ? '' : 'none';
  $('#dirRegistry').style.display = repo ? '' : 'none';
  $('#dirRegister').style.display = repo ? 'none' : '';
  $('#dirSync').style.display = repo ? 'none' : '';
  $('#dirModeNote').innerHTML = repo
    ? 'The shop list is a file in the Tech Garage repository, and every shop serves its own listings from its own server. <strong>Nothing to host, and no one holds your stock but you.</strong> Joining means opening a pull request, so it takes a review rather than seconds — and your entry becomes part of a public git history.'
    : 'A directory server you or someone else runs (<code>tools/directory-server.js</code>). Joining is instant and neighbours are one fetch away, but somebody has to keep the server up.';
}

// Connected shops. "mutual" matters: a shop that listed you back is a
// relationship, one that hasn't is a bookmark, and a shop keeping its
// connections private genuinely can't be told apart from either.
function renderPeers(peers) {
  const friends = peers.filter((p) => p.trusted && !p.blocked);
  $('#friendCount').innerHTML = friends.length ? `<span class="pill in_stock">${friends.length}</span>` : '';
  $('#peersList').innerHTML = peers.length
    ? peers.map((p) => `<div class="user-row">
        <span class="uname">${esc(p.name || 'Unnamed shop')}
          ${p.trusted && !p.blocked ? (p.mutual
            ? '<span class="pill ok" title="They list you too">↔ connected</span>'
            : '<span class="pill in_stock" title="You list them; they have not listed you back (or keep it private)">→ following</span>') : ''}
          ${p.blocked ? '<span class="pill off">blocked</span>' : ''}
          ${!p.trusted && !p.blocked ? '<span class="pill scrapped">seen nearby</span>' : ''}</span>
        <span class="muted" style="font-size:12px">${esc(p.tagline || [p.region?.area, p.region?.state, p.region?.country].filter(Boolean).join(', '))}</span>
        ${p.url ? `<a href="${esc(p.url)}" target="_blank" rel="noopener" style="font-size:12px">visit ↗</a>` : ''}
        <button class="btn secondary small" data-peer-block="${esc(p.node)}">${p.blocked ? 'Unblock' : 'Block'}</button>
        <button class="btn secondary small" data-peer-del="${esc(p.node)}">Remove</button>
      </div>`).join('')
    : '<p class="muted" style="margin:6px 0">Nobody yet. Send a friend your invite link, or paste theirs above.</p>';
}

function renderSuggestions(suggestions) {
  $('#suggCount').innerHTML = suggestions.length ? `<span class="pill in_stock">${suggestions.length}</span>` : '';
  $('#suggList').innerHTML = suggestions.length
    ? suggestions.map((sg) => `<div class="sugg-row">
        <span class="sugg-main"><strong>${esc(sg.name)}</strong>
          <div class="vouch">vouched for by ${esc(sg.vouchedBy.map((v) => v.name || 'a connection').join(', '))}</div></span>
        <a href="${esc(sg.url)}" target="_blank" rel="noopener" style="font-size:12px">visit ↗</a>
        <button class="btn small" data-sugg-add="${esc(sg.url)}" data-sugg-node="${esc(sg.node)}">Connect</button>
        <button class="btn secondary small" data-sugg-no="${esc(sg.node)}">Not interested</button>
      </div>`).join('')
    : `<p class="muted" style="margin:6px 0">Nothing suggested yet. Suggestions come from shops you've connected to that publish their own connections.</p>`;
}

function collectDirectory() {
  return {
    enabled: $('#dirEnabled').checked,
    mode: $('#dirMode').value,
    url: $('#dirUrl').value.trim(),
    registryUrl: $('#dirRegistryUrl').value.trim(),
    contact: $('#dirContact').value.trim(),
    region: {
      country: $('#dirCountry').value.trim(),
      state: $('#dirState').value.trim(),
      area: $('#dirArea').value.trim(),
      postalPrefix: $('#dirPostal').value.trim(),
    },
  };
}

async function copyField(sel, msg) {
  const el = $(sel);
  try { await navigator.clipboard.writeText(el.value); toast(msg); }
  catch { el.select(); toast('Press Ctrl+C to copy'); }
}

// Reads every connection's public profile: are they still there, did they list
// us back, and who do they recommend that we don't know yet?
async function loadConnections() {
  const el = $('#syncMsg');
  testMsg(el, 'Checking your connections…');
  try {
    const r = await api.get('/admin/directory/connections');
    // The raw TG1.… code is no longer surfaced. It is the same payload the link
    // carries, and offering both made the page look like two ways of doing one
    // thing — one of which meant copying an opaque blob between browsers.
    $('#myConnectUrl').value = r.connectUrl || '';
    $('#openConnect').href = r.connectUrl || '#';
    renderPeers(r.peers || []);
    renderSuggestions(r.suggestions || []);
    testMsg(el, r.total
      ? `${r.reachable}/${r.total} reachable${r.suggestions.length ? ` · ${r.suggestions.length} suggested` : ''}`
      : 'No connections yet.', r.total ? r.reachable === r.total : undefined);
  } catch (e) { testMsg(el, e.message, false); }
}

function wireDirectory() {
  $('#dirSave').addEventListener('click', async () => {
    try { await api.put('/admin/directory', collectDirectory()); await loadDirectory(); toast('Directory settings saved'); }
    catch (e) { toast(e.message); }
  });
  $('#dirNearbySave').addEventListener('click', async () => {
    try {
      await api.put('/admin/directory', {
        showNearby: $('#dirShowNearby').checked, trustedOnly: $('#dirTrustedOnly').checked,
        showFriends: $('#dirShowFriends').checked,
      });
      await loadDirectory(); toast('Display options saved');
    } catch (e) { toast(e.message); }
  });
  $('#dirMode').addEventListener('change', (e) => applyDirMode(e.target.value));

  $('#dirEntry').addEventListener('click', async () => {
    const box = $('#dirEntryBox');
    try {
      await api.put('/admin/directory', collectDirectory());
      const r = await api.get('/admin/directory/entry');
      const issue = 'https://github.com/CyberNerdIT/Test-Free-Inv-Manage/issues/new'
        + '?template=add-shop.yml&title=' + encodeURIComponent(`Add shop: ${r.entry.name}`);
      box.innerHTML = `<div class="callout ${r.ok && r.publiclyReachable ? 'good' : 'bad'}" style="margin-top:12px">
        ${r.ok && r.publiclyReachable
          ? 'Ready to submit. Check the verify link opens first — a reviewer (and CI) will check exactly that.'
          : `<strong>Not ready yet.</strong> ${esc([...(r.errors || []), r.publiclyReachable ? null : 'your shop is not publicly reachable — turn on guest browsing or set a website URL'].filter(Boolean).join('; '))}`}
        <label class="field" style="margin-top:10px"><span class="lbl">Your registry entry</span>
          <textarea id="entryJson" rows="12" readonly class="mono" style="font-size:11px">${esc(r.json)}</textarea></label>
        <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center">
          <button class="btn secondary small" id="copyEntry" type="button">Copy JSON</button>
          <a class="btn secondary small" href="${esc(issue)}" target="_blank" rel="noopener">Open a submission issue ↗</a>
          <a class="btn secondary small" href="${esc(r.verifyUrl)}" target="_blank" rel="noopener">Test my verify link ↗</a>
        </div>
      </div>`;
      $('#copyEntry').addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(r.json); toast('Entry copied'); }
        catch { $('#entryJson').select(); toast('Press Ctrl+C to copy'); }
      });
    } catch (e) { box.innerHTML = `<p class="neg">${esc(e.message)}</p>`; }
  });

  $('#dirRegistry').addEventListener('click', async () => {
    const el = $('#dirMsg');
    testMsg(el, 'Reading the registry…');
    try {
      const r = await api.get('/admin/directory/registry');
      testMsg(el, `${r.count} shop${r.count === 1 ? '' : 's'} listed${r.updated ? ` (updated ${r.updated})` : ''} · ${r.peers.length} near you${r.errors.length ? ` · ${r.errors.length} invalid entries skipped` : ''}`, true);
      $('#dirEntryBox').innerHTML = r.peers.length
        ? `<div class="callout" style="margin-top:12px"><strong>Shops near you</strong>${r.peers.map((p) =>
            `<div class="user-row"><span class="uname">${esc(p.name)}</span>
             <span class="muted" style="font-size:12px">${esc([p.region.area, p.region.state, p.region.country].filter(Boolean).join(', '))}</span>
             <a href="${esc(p.url)}" target="_blank" rel="noopener" style="font-size:12px">${esc(p.url)} ↗</a></div>`).join('')}</div>`
        : '<p class="muted" style="margin-top:10px">Nobody else is listed in your area yet — you could be the first.</p>';
    } catch (e) { testMsg(el, e.message, false); }
  });

  $('#dirRegister').addEventListener('click', async () => {
    const el = $('#dirMsg');
    testMsg(el, 'Contacting the directory…');
    try {
      await api.put('/admin/directory', collectDirectory());
      const r = await api.post('/admin/directory/register', {});
      testMsg(el, r.result?.verified ? '✓ Registered and verified' : `Registered — ${r.result?.note || 'awaiting verification'}`, r.result?.verified);
      await loadDirectory();
    } catch (e) { testMsg(el, e.message, false); }
  });
  $('#dirSync').addEventListener('click', async () => {
    const el = $('#dirMsg');
    testMsg(el, 'Publishing…');
    try {
      const r = await api.post('/admin/directory/sync', {});
      testMsg(el, `${r.published} published${r.failed ? `, ${r.failed} failed — ${r.errors.join('; ')}` : ''}`, !r.failed);
      await loadDirectory();
    } catch (e) { testMsg(el, e.message, false); }
  });
  // Connecting takes the link they sent you; the server asks that shop for its
  // own invite code rather than making anyone copy one between browsers.
  $('#peerAdd').addEventListener('click', async () => {
    const link = $('#peerLink').value.trim();
    const el = $('#connectMsg');
    if (!link) return testMsg(el, 'Paste the link they sent you first.', false);
    testMsg(el, 'Checking their shop…');
    try {
      const r = await api.post('/admin/directory/connect', { link });
      $('#peerLink').value = '';
      testMsg(el, `✓ Connected to ${r.peer.name}${r.peer.mutual ? ' — and they list you too' : '. Send them your link so it goes both ways.'}`, true);
      await loadDirectory();
      await loadConnections();
    } catch (e) { testMsg(el, e.message, false); }
  });

  $('#dirShareConnections').addEventListener('change', async (e) => {
    try { await api.put('/admin/directory', { shareConnections: e.target.checked }); toast(e.target.checked ? 'Your connections are now visible to them' : 'Your connections are private again'); }
    catch (err) { toast(err.message); }
  });

  $('#syncConnections').addEventListener('click', loadConnections);
  $('#copyInviteUrl').addEventListener('click', () => copyField('#myConnectUrl', 'Invite link copied'));

  $('#suggList').addEventListener('click', async (e) => {
    const add = e.target.closest('[data-sugg-add]');
    const no = e.target.closest('[data-sugg-no]');
    try {
      if (add) {
        // Hand the server the address and let IT ask that shop for its invite.
        // Doing the lookup from the browser meant a cross-origin request to
        // somebody else's shop, which their server has no reason to allow.
        await api.post('/admin/directory/connect', { link: add.dataset.suggAdd });
        toast('Connected');
      } else if (no) {
        await api.post('/admin/directory/dismiss', { node: no.dataset.suggNo });
      } else { return; }
      await loadDirectory();
      await loadConnections();
    } catch (err) { toast(err.message); }
  });
  $('#peersList').addEventListener('click', async (e) => {
    const block = e.target.closest('[data-peer-block]');
    const del = e.target.closest('[data-peer-del]');
    try {
      if (block) {
        const node = block.dataset.peerBlock;
        const peer = (await api.get('/admin/directory')).peers.find((p) => p.node === node);
        await api.post('/admin/directory/peers', { node, blocked: !peer?.blocked, trusted: peer?.trusted });
        await loadDirectory();
      } else if (del) {
        await api.del(`/admin/directory/peers/${encodeURIComponent(del.dataset.peerDel)}`);
        await loadDirectory();
      }
    } catch (err) { toast(err.message); }
  });
}

/**
 * Boot the admin page.
 *
 * Every section is wired and loaded INDEPENDENTLY. This used to be a straight
 * sequence of wireX() calls followed by Promise.all(...), which meant a single
 * missing element or one failing endpoint threw before anything rendered and
 * left the whole page blank — the worst possible failure for the screen you
 * use to fix things.
 *
 * Now a broken section disables itself, says so, and the other twelve still
 * work.
 */
function wireSafely(name, fn) {
  try { fn(); return null; }
  catch (e) { console.error(`[admin] could not wire ${name}:`, e); return `${name} (${e.message})`; }
}

async function loadSafely(name, fn) {
  try { await fn(); return null; }
  catch (e) { console.error(`[admin] could not load ${name}:`, e); return `${name} (${e.message})`; }
}

function reportBroken(failures) {
  if (!failures.length) return;
  // A visible banner beats a blank page: the admin can see which part is
  // broken, and everything else remains usable.
  const el = document.createElement('div');
  el.className = 'callout bad admin-boot-error';
  el.innerHTML = `<strong>Some sections could not load.</strong> The rest of this page still works.
    <div style="font-size:12px;margin-top:6px">${failures.map((f) => esc(f)).join(' · ')}</div>
    <div style="font-size:12px;margin-top:6px">If this followed an update, do one hard refresh (Ctrl+Shift+R). If it persists, the browser console has the details.</div>`;
  document.querySelector('.admin-content')?.prepend(el);
}

(async function init() {
  const failures = [];

  // loadMe drives the header and the role checks, so it is the one thing worth
  // waiting for — but even it must not blank the page if it fails.
  failures.push(await loadSafely('account', loadMe));

  for (const [name, fn] of [
    ['theme', wireTheme], ['storefront', wireStorefront], ['community', wireDirectory],
  ]) failures.push(wireSafely(name, fn));

  const loaders = [
    ['settings', loadSettings], ['users', loadUsers], ['invites', loadInvites],
    ['requests', loadRequests], ['visitors', loadVisits], ['password resets', loadResets],
    ['waitlist', loadWaitlist], ['subscriptions', loadSubscriptions], ['landing deals', loadDeals],
    ['theme', loadTheme], ['storefront', loadStorefront],
    ['community', loadDirectory], ['connections', loadConnections],
  ];
  const results = await Promise.all(loaders.map(([name, fn]) => loadSafely(name, fn)));
  failures.push(...results);

  reportBroken(failures.filter(Boolean));
})();
