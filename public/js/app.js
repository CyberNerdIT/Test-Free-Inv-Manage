import { drawLineChart, drawBarChart, drawColumnChart, fmtMoney } from './charts.js';

// ---- tiny API helper -----------------------------------------------------
const api = {
  async req(method, path, body) {
    const opts = { method, headers: {} };
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    const res = await fetch('/api' + path, opts);
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; }
    catch {
      // Non-JSON body (e.g. a proxy/timeout HTML page, or a stale cached asset).
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

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const money = (n) => (n == null ? '—' : fmtMoney(Number(n)));
const moneyExact = (n) =>
  n == null ? '—' : (n < 0 ? '-$' : '$') + Math.abs(Number(n)).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pct = (n) => (n == null ? '—' : (Number(n) * 100).toFixed(1) + '%');
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

let appConfig = { defaults: {}, providers: {} };
let currentSeries = null;
let currentItemId = null;
let currentItem = null;

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._t);
  t._t = setTimeout(() => t.classList.remove('show'), 2200);
}

// ---- navigation ----------------------------------------------------------
function switchView(view) {
  $$('nav.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  $$('.view').forEach((v) => v.classList.remove('active'));
  const el = $('#view-' + view);
  if (el) el.classList.add('active');
  if (view === 'dashboard') redrawCharts();
}
$$('nav.tabs button').forEach((btn) => {
  btn.addEventListener('click', () => switchView(btn.dataset.view));
});

// ---- boot ----------------------------------------------------------------
async function boot() {
  try {
    appConfig = await api.get('/config');
  } catch (e) {
    // Not authenticated (or session expired) → back to login.
    window.location = '/login';
    return;
  }
  renderProviderBadges();
  fillConditionSelect($('#lookupCondition'));
  renderUserMenu();
  applyBrand();
  await refreshAll();
  maybeWelcome();
}

// Listing-condition dropdown, shared by the Price Lookup page and the item
// drawer. Options come from the server so the client can't drift from the
// eBay/Amazon mappings.
function fillConditionSelect(sel, selected = 'any') {
  if (!sel) return;
  const list = appConfig?.conditions || [{ key: 'any', label: 'Any condition', hint: '' }];
  sel.innerHTML = list
    .map((c) => `<option value="${esc(c.key)}" title="${esc(c.hint || '')}"${c.key === selected ? ' selected' : ''}>${esc(c.label)}</option>`)
    .join('');
}

function applyBrand() {
  // Ignore the retired default name so the header never shows the legacy label.
  const raw = appConfig.brand?.name;
  const name = raw && raw !== 'Inventory Manager' ? raw : 'Tech Garage';
  const h1 = document.querySelector('.app-header h1');
  if (h1) h1.innerHTML = `<span class="logo">💻</span> ${esc(name)}`;
  document.title = `${name} — Inventory`;
}

function renderUserMenu() {
  const u = appConfig.user;
  const el = $('#userMenu');
  if (!el) return;
  if (!u) { el.innerHTML = ''; return; }
  el.innerHTML = `<button class="btn secondary small" id="tourBtn" title="Getting started">🚀 Getting started</button>
    <div class="gear-wrap">
      <button class="gear-btn" id="gearBtn" title="Settings" aria-label="Settings">⚙️</button>
      <div class="popout" id="gearPopout">
        <div class="popout-head">${esc(u.username)}${u.role === 'admin' ? ' <span class="role-tag">admin</span>' : ''}</div>
        <button class="popout-item" id="acctBtn">👤 Account information</button>
        ${u.role === 'admin' ? '<a class="popout-item" href="/admin">🛠️ Admin portal</a>' : ''}
        <button class="popout-item" id="logoutBtn">🚪 Log out</button>
      </div>
    </div>`;
  const pop = $('#gearPopout');
  $('#gearBtn').addEventListener('click', (e) => { e.stopPropagation(); pop.classList.toggle('open'); });
  pop.addEventListener('click', (e) => e.stopPropagation());
  document.addEventListener('click', () => pop.classList.remove('open'));
  $('#acctBtn').addEventListener('click', () => { pop.classList.remove('open'); openAccountModal(); });
  $('#tourBtn')?.addEventListener('click', () => openTour());
  $('#logoutBtn').addEventListener('click', async () => {
    try { await api.post('/auth/logout'); } catch {}
    window.location = '/login';
  });
}

// ---- welcome / getting-started tour --------------------------------------
async function openTour(auto = false) {
  const me = await api.get('/auth/me').catch(() => ({}));
  if (auto) {
    let localDone = false;
    try { localDone = localStorage.getItem('inv_tour_done') === '1'; } catch { /* ignore */ }
    if (me.tourDismissed || localDone) return; // dismissed for good — don't auto-open
  }
  const isAdmin = (appConfig.user?.role || me.role) === 'admin';
  let smtpOk = false;
  if (isAdmin) { try { const s = await api.get('/admin/settings'); smtpOk = !!s.notify?.email?.enabled; } catch { /* ignore */ } }
  let itemCount = 0;
  try { itemCount = (await api.get('/items')).length; } catch { /* ignore */ }

  let modal = $('#tourModal');
  if (!modal) { modal = document.createElement('div'); modal.id = 'tourModal'; modal.className = 'overlay center'; document.body.appendChild(modal); }
  const emailDone = !!me.email;
  const ico = (done) => `<span class="tour-ico">${done ? '✅' : '⬜'}</span>`;
  const step = (done, title, body, action) => `<div class="tour-step ${done ? 'done' : ''}">${ico(done)}<div class="tour-body"><h4>${title}</h4><p>${body}</p>${action || ''}</div></div>`;

  const emailStep = emailDone
    ? step(true, 'Your contact email', `Alerts will be sent to <strong>${esc(me.email)}</strong>. Change it any time under ⚙ Account.`)
    : step(false, 'Add your email', 'Purchase alerts and admin notifications are sent here.',
        `<div style="display:flex;gap:8px;flex-wrap:wrap"><input id="tour-email" type="email" placeholder="you@example.com" style="flex:1;min-width:180px" value="${esc(me.email || '')}" /><button class="btn small" id="tour-email-save">Save email</button><span id="tour-email-msg" style="font-size:12px;align-self:center"></span></div>`);

  const itemStep = step(itemCount > 0, itemCount > 0 ? `You have ${itemCount} item${itemCount > 1 ? 's' : ''}` : 'Add your first item',
    itemCount > 0 ? 'Nice — your inventory is started. Add more any time.' : 'Log something you\'re selling — track its cost, break-even and profit.',
    `<button class="btn small" id="tour-additem">${itemCount > 0 ? 'Add another item' : 'Add your first item'}</button>`);

  const adminSteps = isAdmin ? (
    step(smtpOk, 'Set up email notifications', smtpOk ? 'SMTP is connected — you\'ll receive purchase alerts.' : 'Connect SMTP (and optionally WhatsApp/Discord/Telegram) so you get pinged on new requests.',
      `<a class="btn secondary small" href="/admin#apis">Open notification setup →</a>`) +
    step(false, 'Explore admin settings', 'Set your branding, pricing defaults, eBay/Amazon API keys, customer invites and more.',
      `<a class="btn secondary small" href="/admin#branding">Open Admin settings →</a>`)
  ) : '';

  modal.innerHTML = `<div class="modal-card">
    <div class="cart-head"><h2>👋 Welcome to ${esc(appConfig.brand?.name || 'Tech Garage')}</h2><button class="close-x" id="tourClose">&times;</button></div>
    <div style="padding:18px">
      <p class="muted" style="font-size:13px;margin:0 0 12px">A quick checklist to get you up and running:</p>
      ${emailStep}${itemStep}${adminSteps}
      <div style="margin-top:16px;display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap">
        <label style="display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer"><input type="checkbox" id="tour-dont" style="width:auto" checked /> Don't show this again</label>
        <button class="btn" id="tourDone">Got it</button>
      </div>
    </div>
  </div>`;
  modal.classList.add('open');
  const close = () => modal.classList.remove('open');
  $('#tourClose').addEventListener('click', close);
  $('#tourDone').addEventListener('click', () => {
    if ($('#tour-dont')?.checked) {
      try { localStorage.setItem('inv_tour_done', '1'); } catch { /* ignore */ }
      api.post('/auth/me/dismiss-tour').catch(() => {}); // remember across devices
    }
    close();
  });
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
  $('#tour-additem')?.addEventListener('click', () => { close(); switchView('inventory'); openItemForm(null); });
  $('#tour-email-save')?.addEventListener('click', async () => {
    const msg = $('#tour-email-msg');
    try {
      await api.put('/auth/me', { email: $('#tour-email').value.trim() });
      msg.textContent = '✓ Saved'; msg.style.color = 'var(--pos)';
    } catch (e) { msg.textContent = e.message; msg.style.color = 'var(--neg)'; }
  });
}

function maybeWelcome() {
  openTour(true); // openTour skips itself if the user dismissed it for good
}

async function openAccountModal() {
  let me;
  try { me = await api.get('/auth/me'); } catch { return; }
  let modal = $('#acctModal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'acctModal';
    modal.className = 'overlay center';
    document.body.appendChild(modal);
  }
  const adminHint = me.role === 'admin' ? ' — purchase alerts are emailed here' : '';
  modal.innerHTML = `<div class="modal-card">
    <div class="drawer-head"><h2>Account information</h2><button class="close-x" id="acctClose">&times;</button></div>
    <div class="drawer-body">
      <div class="err" id="acctErr"></div>
      <div class="muted" style="font-size:12px;margin-bottom:12px">Signed in as <strong>${esc(me.username)}</strong> · ${esc(me.role)}</div>
      <div class="grid-2">
        <label class="field"><span class="lbl">Display name</span><input id="a-name" value="${esc(me.name || '')}" /></label>
        <label class="field"><span class="lbl">Email${adminHint}</span><input id="a-email" type="email" value="${esc(me.email || '')}" /></label>
        <label class="field"><span class="lbl">Phone</span><input id="a-phone" value="${esc(me.phone || '')}" /></label>
      </div>
      <div class="section-title">Change password</div>
      <div class="grid-3">
        <label class="field"><span class="lbl">Current password</span><input id="a-cur" type="password" autocomplete="current-password" /></label>
        <label class="field"><span class="lbl">New (min 8)</span><input id="a-new" type="password" autocomplete="new-password" /></label>
        <label class="field"><span class="lbl">Confirm new</span><input id="a-conf" type="password" autocomplete="new-password" /></label>
      </div>
      <div style="display:flex;gap:10px;margin-top:8px">
        <button class="btn" id="acctSave">Save changes</button>
        <button class="btn secondary" id="acctCancel">Cancel</button>
      </div>
    </div>
  </div>`;
  modal.classList.add('open');
  const close = () => modal.classList.remove('open');
  $('#acctClose').addEventListener('click', close);
  $('#acctCancel').addEventListener('click', close);
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
  $('#acctSave').addEventListener('click', async () => {
    const err = $('#acctErr');
    err.classList.remove('show');
    const showErr = (m) => { err.textContent = m; err.classList.add('show'); };
    const payload = { name: $('#a-name').value.trim(), email: $('#a-email').value.trim(), phone: $('#a-phone').value.trim() };
    const nw = $('#a-new').value;
    if (nw) {
      if (nw.length < 8) return showErr('New password must be at least 8 characters.');
      if (nw !== $('#a-conf').value) return showErr('New passwords do not match.');
      if (!$('#a-cur').value) return showErr('Enter your current password to change it.');
      payload.password = nw;
      payload.currentPassword = $('#a-cur').value;
    }
    try {
      await api.put('/auth/me', payload);
      toast('Account updated');
      close();
    } catch (e) {
      showErr(e.message);
    }
  });
}

function renderProviderBadges() {
  const wrap = $('#providerBadges');
  const p = appConfig.providers || {};
  const badge = (name, on) =>
    `<span class="badge ${on ? 'live' : 'demo'}">${name}: ${on ? 'live' : 'demo'}</span>`;
  wrap.innerHTML = badge('eBay', p.ebay?.enabled) + badge('Amazon', p.amazon?.enabled);
}

async function refreshAll() {
  await Promise.all([loadDashboard(), loadInventory()]);
}

// ---- dashboard -----------------------------------------------------------
// Selected time frame for every dashboard chart. Persisted so the dashboard
// opens where you left it rather than resetting to a default each visit.
let chartRange = localStorage.getItem('tg_range') || '90d';
let chartBucket = localStorage.getItem('tg_bucket') || '';

async function loadDashboard() {
  const qs = new URLSearchParams({ range: chartRange });
  if (chartBucket) qs.set('bucket', chartBucket);
  const [summary, series, report] = await Promise.all([
    api.get('/analytics/summary'),
    api.get('/analytics/profit-series?' + qs),
    api.get('/analytics/report'),
  ]);
  currentSeries = series;
  renderReport(report);

  const kpis = [
    { label: 'Realized profit', value: money(summary.realizedProfit), cls: summary.realizedProfit >= 0 ? 'pos' : 'neg', sub: `${summary.sold} sold` },
    { label: 'Projected profit', value: money(summary.projectedProfit), cls: 'pos', sub: `from ${summary.inStock + summary.listed} in stock/listed` },
    { label: 'Capital invested', value: money(summary.totalInvested), sub: `${money(summary.investedInUnsold)} tied up in stock` },
    { label: 'Total potential', value: money(summary.realizedProfit + summary.projectedProfit), cls: 'pos', sub: 'realized + projected' },
    { label: 'Inventory', value: String(summary.totalItems), sub: `${summary.inStock} in stock · ${summary.listed} listed · ${summary.sold} sold` },
  ];
  $('#kpiGrid').innerHTML = kpis
    .map((k) => `<div class="kpi"><div class="label">${k.label}</div><div class="value ${k.cls || ''}">${k.value}</div><div class="sub">${k.sub}</div></div>`)
    .join('');

  redrawCharts();
}

function renderReport(r) {
  const kpis = [
    { label: 'Return on investment', value: r.roi == null ? '—' : pct(r.roi), cls: (r.roi ?? 0) >= 0 ? 'pos' : 'neg', sub: `${money(r.realizedProfit)} on ${money(r.investedInSold)} cost` },
    { label: 'Revenue (sold)', value: money(r.totalRevenue), sub: `${r.counts.sold} sales` },
    { label: 'Avg profit / sale', value: money(r.avgProfitPerSale), cls: (r.avgProfitPerSale ?? 0) >= 0 ? 'pos' : 'neg', sub: '' },
    { label: 'Avg days to sell', value: r.avgDaysToSell == null ? '—' : r.avgDaysToSell + ' days', sub: '' },
    { label: 'Sell-through rate', value: r.sellThroughRate == null ? '—' : pct(r.sellThroughRate), sub: `${r.counts.unsold} still in stock` },
    { label: 'Capital tied up', value: money(r.capitalTiedUp), cls: 'neg', sub: r.staleCount ? `${money(r.staleCapital)} in dead stock` : 'no dead stock' },
  ];
  $('#reportGrid').innerHTML = kpis
    .map((k) => `<div class="kpi"><div class="label">${k.label}</div><div class="value ${k.cls || ''}">${k.value}</div><div class="sub">${k.sub}</div></div>`)
    .join('');

  const badge = $('#staleBadge');
  badge.innerHTML = r.staleCount ? `<span class="chip">${r.staleCount} dead stock &gt;${r.staleDays}d</span>` : '';

  const list = $('#agingList');
  if (!r.aging.length) {
    list.innerHTML = '<p class="empty">No unsold inventory. 🎉</p>';
    return;
  }
  const maxDays = Math.max(...r.aging.map((a) => a.daysHeld || 0), 1);
  list.innerHTML = r.aging
    .map((a) => {
      const w = Math.round(((a.daysHeld || 0) / maxDays) * 100);
      return `<div class="aging-row ${a.stale ? 'stale' : ''}" data-id="${a.id}">
        <span class="title"><strong>${esc(a.title)}</strong> <span class="pill ${a.status}">${a.status.replace('_', ' ')}</span> ${a.stale ? '<span class="chip">dead stock</span>' : ''}</span>
        <span class="muted" style="font-size:12px">${money(a.investedCost)} invested</span>
        <span class="aging-bar"><span style="width:${w}%"></span></span>
        <span class="days ${a.stale ? 'stale' : ''}">${a.daysHeld == null ? '—' : a.daysHeld + 'd'}</span>
      </div>`;
    })
    .join('');
  $$('#agingList .aging-row').forEach((row) =>
    row.addEventListener('click', () => openItem(Number(row.dataset.id)))
  );
}

function redrawCharts() {
  if (!currentSeries) return;
  const s = currentSeries;

  // Range picker (options come from the server so client and server agree).
  const rangeSel = $('#rangeSelect');
  if (rangeSel && !rangeSel.dataset.filled && s.ranges) {
    rangeSel.innerHTML = s.ranges.map((r) => `<option value="${esc(r.key)}">${esc(r.label)}</option>`).join('');
    rangeSel.dataset.filled = '1';
  }
  if (rangeSel) rangeSel.value = chartRange;
  if ($('#bucketSelect')) $('#bucketSelect').value = chartBucket;

  // Headline numbers for the window — what was actually banked, not a forecast.
  const perLabel = { day: 'day', week: 'week', month: 'month' }[s.bucket] || 'period';
  $('#rangeSummary').innerHTML = [
    ['Profit this period', money(s.windowProfit), s.windowProfit >= 0 ? 'pos' : 'neg'],
    ['Revenue', money(s.windowRevenue), ''],
    ['Units sold', String(s.windowUnits), ''],
    ['Sales', String(s.windowSales), ''],
    [`Best ${perLabel}`, s.best ? `${money(s.best.profit)}` : '—', s.best ? 'pos' : ''],
    ['All-time realized', money(s.realizedTotal), s.realizedTotal >= 0 ? 'pos' : 'neg'],
  ].map(([label, value, cls]) =>
    `<div class="rs"><div class="rs-label">${label}</div><div class="rs-value ${cls}">${value}</div></div>`).join('');

  drawColumnChart($('#profitChart'), {
    columns: (s.buckets || []).map((b) => ({
      label: b.label,
      value: b.profit,
      color: b.profit >= 0 ? getVar('--pos', '#16a34a') : getVar('--neg', '#dc2626'),
    })),
    line: (s.cumulative || []).map((c) => ({ label: c.label, value: c.value })),
    lineColor: getVar('--accent', '#7c3aed'),
    barName: `Profit per ${perLabel}`,
    lineName: 'Cumulative realized',
    empty: 'No sales in this period — try a wider time frame.',
  });

  // The projection is a separate statement now, not a dashed line pretending
  // to be history. It was the only thing on the chart when sales were sparse.
  $('#projectionNote').innerHTML = s.projectedFromStock
    ? `Current stock projects a further <strong class="pos">${money(s.projectedFromStock)}</strong> if it sells at listing price — ${money(s.projectedTotal)} all-in. That is a forecast, not banked profit, so it is kept off the chart above.`
    : 'No unsold stock with a listing price, so there is nothing to project.';

  buildBarChart();
}

async function buildBarChart() {
  // Reuse inventory rows if loaded, else fetch
  const items = inventoryCache || (await api.get('/items'));
  const from = currentSeries?.from, to = currentSeries?.to;
  $('#barRangeNote').textContent = from ? `· sold ${from} → ${to}` : '';
  const bars = [];
  for (const it of items) {
    if (it.status === 'scrapped') continue;
    // A sale outside the selected window belongs to a different period's
    // profit; showing it here would contradict the chart above.
    if (it.status === 'sold' && from && !(it.sold_date >= from && it.sold_date <= to)) continue;
    // We need financials; fetch lazily via a lightweight computation using listing/sold.
    bars.push(it);
  }
  // Fetch financials in parallel (cached per item is fine for small inventories)
  const withFin = await Promise.all(
    bars.map(async (it) => {
      try {
        const fin = await api.get(`/items/${it.id}/financials`);
        const value = it.status === 'sold' ? fin.realizedProfit : fin.projectedProfit;
        return { label: it.title, value: value ?? 0, color: it.status === 'sold' ? getVar('--pos', '#16a34a') : getVar('--accent', '#7c3aed') };
      } catch {
        return null;
      }
    })
  );
  const clean = withFin.filter((b) => b && b.value).sort((a, b) => b.value - a.value).slice(0, 10);
  drawBarChart($('#barChart'), { bars: clean });
}

function getVar(name, fb) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fb;
}

// ---- inventory -----------------------------------------------------------
let inventoryCache = null;
let inventoryRows = [];
let sortKey = null;
let sortDir = 1;

function todayISO() { return new Date().toISOString().slice(0, 10); }
function daysHeldOf(it) {
  const start = it.acquired_date || (it.created_at ? String(it.created_at).slice(0, 10) : null);
  if (!start) return null;
  const end = it.status === 'sold' ? it.sold_date || todayISO() : todayISO();
  const ms = Date.parse(end + 'T00:00:00Z') - Date.parse(start + 'T00:00:00Z');
  return Number.isNaN(ms) ? null : Math.max(0, Math.round(ms / 86400000));
}

async function loadInventory() {
  const status = $('#filterStatus').value;
  const category = $('#filterCategory').value;
  const qs = new URLSearchParams();
  if (status) qs.set('status', status);
  if (category) qs.set('category', category);
  const items = await api.get('/items' + (qs.toString() ? '?' + qs : ''));
  inventoryCache = items;

  // Enrich each row with financials (small N; fine for a local tool).
  inventoryRows = await Promise.all(
    items.map(async (it) => {
      let fin = {};
      try { fin = await api.get(`/items/${it.id}/financials`); } catch {}
      const profit = it.status === 'sold' ? fin.realizedProfit : fin.projectedProfit;
      const price = it.status === 'sold' ? it.sold_price : it.listing_price;
      return { item: it, fin, profit, price, age: daysHeldOf(it) };
    })
  );
  renderInventory();
}

function renderInventory() {
  const q = ($('#searchBox').value || '').toLowerCase().trim();
  let rows = inventoryRows;
  if (q) {
    rows = rows.filter(({ item }) => {
      const specs = item.specs && typeof item.specs === 'object' ? Object.values(item.specs).join(' ') : '';
      return [item.title, item.brand, item.model, item.serial_number, item.location, item.category, specs]
        .filter(Boolean).join(' ').toLowerCase().includes(q);
    });
  }
  if (sortKey) {
    const get = {
      title: (r) => r.item.title?.toLowerCase() || '',
      category: (r) => r.item.category || '',
      status: (r) => r.item.status || '',
      age: (r) => r.age ?? -1,
      invested: (r) => r.fin.investedCost ?? 0,
      breakeven: (r) => r.fin.breakEvenPrice ?? 0,
      price: (r) => r.price ?? 0,
      profit: (r) => r.profit ?? -Infinity,
    }[sortKey];
    rows = [...rows].sort((a, b) => {
      const x = get(a), y = get(b);
      if (typeof x === 'string') return x.localeCompare(y) * sortDir;
      return (x - y) * sortDir;
    });
  }

  $('#itemsEmpty').style.display = rows.length ? 'none' : 'block';
  $('#itemCount').textContent = `${rows.length} item${rows.length === 1 ? '' : 's'}${q ? ' (filtered)' : ''}`;
  $('#itemsBody').innerHTML = rows
    .map(({ item: it, fin, profit, age }) => {
      const profitCls = profit == null ? 'muted' : profit >= 0 ? 'pos' : 'neg';
      const askSold = it.status === 'sold' ? money(it.sold_price) : money(it.listing_price);
      const stale = age != null && age > 60 && it.status !== 'sold' && it.status !== 'scrapped';
      const ageTxt = age == null ? '—' : age + 'd';
      // data-label powers the mobile card layout (CSS turns each row into a card
      // and renders these as the field names).
      return `<tr data-id="${it.id}">
        <td class="cell-main"><strong>${esc(it.title)}</strong>${Number(it.quantity) > 1 ? ` <span class="pill in_stock" title="Units available">×${Number(it.quantity)}</span>` : ''}${it.hidden ? ' <span class="pill scrapped" title="Hidden from storefront">🙈 hidden</span>' : ''}<br><span class="muted" style="font-size:12px">${esc(it.brand || '')} ${esc(it.model || '')}${it.location ? ' · 📍' + esc(it.location) : ''}</span></td>
        <td data-label="Category">${esc(it.category)}</td>
        <td data-label="Status"><span class="pill ${it.status}">${it.status.replace('_', ' ')}</span></td>
        <td class="num ${stale ? 'neg' : ''}" data-label="Age">${ageTxt}${stale ? ' ⚠' : ''}</td>
        <td class="num" data-label="Invested">${money(fin.investedCost)}</td>
        <td class="num" data-label="Break-even">${money(fin.breakEvenPrice)}</td>
        <td class="num" data-label="Ask / Sold">${askSold}</td>
        <td class="num ${profitCls}" data-label="Profit">${money(profit)}</td>
      </tr>`;
    })
    .join('');
  $$('#itemsBody tr').forEach((tr) => tr.addEventListener('click', () => openItem(Number(tr.dataset.id))));
}

$('#filterStatus').addEventListener('change', loadInventory);
$('#filterCategory').addEventListener('change', loadInventory);
$('#searchBox').addEventListener('input', renderInventory);
$$('#itemsTable th[data-sort]').forEach((th) =>
  th.addEventListener('click', () => {
    const key = th.dataset.sort;
    if (sortKey === key) sortDir *= -1;
    else { sortKey = key; sortDir = 1; }
    $$('#itemsTable th').forEach((h) => h.classList.remove('sorted', 'asc'));
    th.classList.add('sorted');
    if (sortDir === 1) th.classList.add('asc');
    renderInventory();
  })
);
$('#addItemBtn').addEventListener('click', () => openItemForm(null));
$('#seedBtn').addEventListener('click', async () => {
  const r = await api.post('/seed');
  toast(r.seeded ? `Loaded ${r.seeded} sample items` : 'Sample data only loads into an empty inventory');
  await refreshAll();
});
$('#exportCsvBtn').addEventListener('click', () => (window.location = '/api/export/items.csv'));
$('#backupBtn').addEventListener('click', () => (window.location = '/api/export/backup.json'));
$('#sampleCsvBtn')?.addEventListener('click', () => (window.location = '/api/export/sample.csv'));
$('#sampleJsonBtn')?.addEventListener('click', () => (window.location = '/api/export/sample.json'));
$('#quickAddBtn')?.addEventListener('click', openQuickAdd);
$('#importBtn').addEventListener('click', () => $('#importFile').click());
$('#importFile').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const text = await file.text();
  e.target.value = '';
  try {
    let items;
    if (file.name.endsWith('.csv')) items = parseCsvItems(text);
    else {
      const json = JSON.parse(text);
      items = Array.isArray(json) ? json : json.items;
    }
    if (!items || !items.length) return toast('No items found in file');
    const r = await api.post('/import', { items });
    toast(`Imported ${r.items} item(s), ${r.costs} cost(s)`);
    await refreshAll();
  } catch (err) {
    toast('Import failed: ' + err.message);
  }
});

// Quick-add several bare items (title only) — fill details later.
function openQuickAdd() {
  let modal = $('#quickAddModal');
  if (!modal) { modal = document.createElement('div'); modal.id = 'quickAddModal'; modal.className = 'overlay center'; document.body.appendChild(modal); }
  modal.innerHTML = `<div class="modal-card">
    <div class="cart-head"><h2>⚡ Quick add items</h2><button class="close-x" id="qaClose">&times;</button></div>
    <div style="padding:18px">
      <p class="muted" style="font-size:13px;margin:0 0 10px">One item per line — each becomes an in-stock item you can fill in later (open it to add cost, price, specs…).</p>
      <textarea id="qaTitles" rows="8" placeholder="Dell Latitude 7420&#10;DDR4 8GB RAM&#10;RTX 3060 GPU" style="width:100%;font-size:14px"></textarea>
      <div class="grid-2" style="margin-top:10px">
        <label class="field"><span class="lbl">Category</span><select id="qaCategory">${['laptop','desktop','component','device','other'].map((c) => `<option value="${c}">${c}</option>`).join('')}</select></label>
        <label class="field"><span class="lbl">Status</span><select id="qaStatus">${['in_stock','listed'].map((s) => `<option value="${s}">${s.replace('_',' ')}</option>`).join('')}</select></label>
      </div>
      <div id="qaMsg" style="font-size:12px;margin-top:8px"></div>
      <div style="margin-top:12px;display:flex;gap:10px;justify-content:flex-end">
        <button class="btn secondary" id="qaCancel">Cancel</button>
        <button class="btn" id="qaAdd">Add items</button>
      </div>
    </div>
  </div>`;
  modal.classList.add('open');
  const close = () => modal.classList.remove('open');
  $('#qaClose').addEventListener('click', close);
  $('#qaCancel').addEventListener('click', close);
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
  $('#qaAdd').addEventListener('click', async () => {
    const titles = $('#qaTitles').value.split('\n').map((t) => t.trim()).filter(Boolean);
    if (!titles.length) { $('#qaMsg').textContent = 'Enter at least one title.'; $('#qaMsg').style.color = 'var(--neg)'; return; }
    try {
      const r = await api.post('/quick-add', { titles, category: $('#qaCategory').value, status: $('#qaStatus').value });
      close();
      toast(`Added ${r.created} item(s) — open them to fill in details`);
      switchView('inventory');
      await refreshAll();
    } catch (e) { $('#qaMsg').textContent = e.message; $('#qaMsg').style.color = 'var(--neg)'; }
  });
}

// Minimal CSV parser (handles quoted fields) → item objects.
function parseCsvItems(text) {
  const rows = [];
  let field = '', row = [], inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') inQ = false;
      else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      if (field !== '' || row.length) { row.push(field); rows.push(row); row = []; field = ''; }
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  if (rows.length < 2) return [];
  const headers = rows[0].map((h) => h.trim());
  const numFields = new Set(['acquisition_cost', 'listing_price', 'sold_price', 'shipping_cost', 'quantity', 'compare_at_price']);
  return rows.slice(1).map((r) => {
    const o = {};
    headers.forEach((h, i) => {
      let v = r[i];
      if (v === '' || v == null) return;
      if (numFields.has(h)) v = Number(v);
      o[h] = v;
    });
    return o;
  }).filter((o) => o.title);
}

// ---- item drawer ---------------------------------------------------------
const overlay = $('#overlay');
$('#closeDrawer').addEventListener('click', closeDrawer);
overlay.addEventListener('click', (e) => { if (e.target === overlay) closeDrawer(); });
function closeDrawer() { overlay.classList.remove('open'); }
function openDrawer() { overlay.classList.add('open'); }

const CATEGORIES = ['laptop', 'desktop', 'component', 'device', 'other'];
const STATUSES = ['in_stock', 'listed', 'sold', 'scrapped'];
const CONDITIONS = ['new', 'used', 'refurbished', 'for-parts'];

function itemFormHTML(it = {}) {
  const specs = it.specs && typeof it.specs === 'object' ? it.specs : {};
  const opt = (arr, val) => arr.map((o) => `<option value="${o}" ${o === val ? 'selected' : ''}>${o.replace('_', ' ')}</option>`).join('');
  return `
    <div class="grid-2">
      <label class="field" style="grid-column:1/-1"><span class="lbl">Title *</span><input id="f-title" value="${esc(it.title || '')}" placeholder="e.g. Dell Latitude 7420 i7" /></label>
      <label class="field"><span class="lbl">Category</span><select id="f-category">${opt(CATEGORIES, it.category || 'laptop')}</select></label>
      <label class="field"><span class="lbl">Status</span><select id="f-status">${opt(STATUSES, it.status || 'in_stock')}</select></label>
      <label class="field"><span class="lbl">Brand</span><input id="f-brand" value="${esc(it.brand || '')}" /></label>
      <label class="field"><span class="lbl">Model</span><input id="f-model" value="${esc(it.model || '')}" /></label>
      <label class="field"><span class="lbl">Condition</span><select id="f-condition">${opt(CONDITIONS, it.condition || 'used')}</select></label>
      <label class="field"><span class="lbl">Acquired date</span><input id="f-acquired_date" type="date" value="${esc(it.acquired_date || '')}" /></label>
      <label class="field"><span class="lbl">Serial / service tag</span><input id="f-serial_number" value="${esc(it.serial_number || '')}" /></label>
      <label class="field"><span class="lbl">Location (bin / shelf)</span><input id="f-location" value="${esc(it.location || '')}" /></label>
      <label class="field"><span class="lbl">Quantity available</span><input id="f-quantity" type="number" min="1" step="1" value="${it.quantity ?? 1}" /></label>
      <label class="field"><span class="lbl">Listing ID / SKU <span class="muted" style="font-weight:400">— for CSV updates</span></span><input id="f-sku" value="${esc(it.sku || '')}" placeholder="e.g. LAT-7420-01" /></label>
    </div>

    <div class="section-title">Specs</div>
    <div class="grid-3">
      <label class="field"><span class="lbl">CPU</span><input id="f-cpu" value="${esc(specs.cpu || '')}" /></label>
      <label class="field"><span class="lbl">RAM</span><input id="f-ram" value="${esc(specs.ram || '')}" /></label>
      <label class="field"><span class="lbl">Storage</span><input id="f-storage" value="${esc(specs.storage || '')}" /></label>
      <label class="field"><span class="lbl">GPU</span><input id="f-gpu" value="${esc(specs.gpu || '')}" /></label>
      <label class="field"><span class="lbl">Screen</span><input id="f-screen" value="${esc(specs.screen || '')}" /></label>
      <label class="field"><span class="lbl">OS</span><input id="f-os" value="${esc(specs.os || '')}" /></label>
    </div>

    <div class="section-title">Money</div>
    <div class="grid-3">
      <label class="field"><span class="lbl">Acquisition cost ($)</span><input id="f-acquisition_cost" type="number" step="0.01" value="${it.acquisition_cost ?? 0}" /></label>
      <label class="field"><span class="lbl">Listing / asking ($)</span><input id="f-listing_price" type="number" step="0.01" value="${it.listing_price ?? ''}" /></label>
      <label class="field"><span class="lbl">Compare-at / "was" ($)</span><input id="f-compare_at_price" type="number" step="0.01" value="${it.compare_at_price ?? ''}" placeholder="e.g. retail price" title="Shown struck through on the storefront with a savings badge. Leave blank to hide it." /></label>
    </div>
    <div class="grid-2">
      <label class="field"><span class="lbl">Shipping you pay ($)</span><input id="f-shipping_cost" type="number" step="0.01" value="${it.shipping_cost ?? 0}" /></label>
      <label class="field"><span class="lbl">Sold price ($)</span><input id="f-sold_price" type="number" step="0.01" value="${it.sold_price ?? ''}" /></label>
      <label class="field"><span class="lbl">Sold date</span><input id="f-sold_date" type="date" value="${esc(it.sold_date || '')}" /></label>
      <label class="field"><span class="lbl">Target margin (%)</span><input id="f-target_margin" type="number" step="1" value="${it.target_margin != null ? Math.round(it.target_margin * 100) : Math.round((appConfig.defaults.targetMargin ?? 0.25) * 100)}" /></label>
      <label class="field"><span class="lbl">Fee rate (%)</span><input id="f-fee_rate" type="number" step="0.1" value="${it.fee_rate != null ? (it.fee_rate * 100).toFixed(1) : (appConfig.defaults.feeRate * 100).toFixed(1)}" /></label>
      <label class="field"><span class="lbl">Flat fee ($)</span><input id="f-flat_fee" type="number" step="0.01" value="${it.flat_fee ?? appConfig.defaults.flatFee ?? 0.3}" /></label>
    </div>
    <div style="display:flex;gap:20px;flex-wrap:wrap;margin:4px 0 14px">
      <label style="display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer"><input type="checkbox" id="f-visible" style="width:auto" ${it.hidden ? '' : 'checked'} /> Show in customer storefront</label>
      <label style="display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer"><input type="checkbox" id="f-local" style="width:auto" ${it.local_sale ? 'checked' : ''} /> Local sale — no marketplace fees</label>
    </div>
    <label class="share-toggle">
      <input type="checkbox" id="f-share_community" ${it.share_community ? 'checked' : ''} />
      <span>
        <strong>🌐 Share with the Tech Garage community</strong>
        <span class="share-note">Publishes the title, category, condition, brand, model, price, photo and a link back to your shop, plus your <strong>coarse region</strong> (country / state / town) so nearby shoppers can find it. Never your cost, margin, serial number or storage location. Delisted automatically when it sells.</span>
        <span class="share-state" id="shareState"></span>
      </span>
    </label>
    <label class="field"><span class="lbl">Public description <span class="muted" style="font-weight:400">— shown to customers in the storefront detail view</span></span><textarea id="f-description" rows="3" placeholder="Describe the condition, what's included, any quirks…">${esc(it.description || '')}</textarea></label>
    <label class="field"><span class="lbl">Notes <span class="muted" style="font-weight:400">— private, never shown to customers</span></span><textarea id="f-notes" rows="2">${esc(it.notes || '')}</textarea></label>
  `;
}

function collectForm() {
  const numOrNull = (id) => { const v = $('#f-' + id).value; return v === '' ? null : Number(v); };
  const specs = {};
  for (const k of ['cpu', 'ram', 'storage', 'gpu', 'screen', 'os']) {
    const v = $('#f-' + k).value.trim();
    if (v) specs[k] = v;
  }
  return {
    title: $('#f-title').value.trim(),
    category: $('#f-category').value,
    status: $('#f-status').value,
    brand: $('#f-brand').value.trim() || null,
    model: $('#f-model').value.trim() || null,
    condition: $('#f-condition').value,
    acquired_date: $('#f-acquired_date').value || null,
    serial_number: $('#f-serial_number').value.trim() || null,
    location: $('#f-location').value.trim() || null,
    quantity: Math.max(1, parseInt($('#f-quantity').value, 10) || 1),
    sku: $('#f-sku').value.trim() || null,
    specs,
    acquisition_cost: Number($('#f-acquisition_cost').value) || 0,
    listing_price: numOrNull('listing_price'),
    compare_at_price: numOrNull('compare_at_price'),
    share_community: $('#f-share_community')?.checked ? 1 : 0,
    shipping_cost: Number($('#f-shipping_cost').value) || 0,
    sold_price: numOrNull('sold_price'),
    sold_date: $('#f-sold_date').value || null,
    target_margin: numOrNull('target_margin') != null ? numOrNull('target_margin') / 100 : null,
    fee_rate: numOrNull('fee_rate') != null ? numOrNull('fee_rate') / 100 : null,
    flat_fee: numOrNull('flat_fee'),
    hidden: $('#f-visible').checked ? 0 : 1,
    local_sale: $('#f-local').checked ? 1 : 0,
    description: $('#f-description').value.trim() || null,
    notes: $('#f-notes').value.trim() || null,
  };
}

function fillFormFromItem(item) {
  const set = (id, val) => { const el = $('#f-' + id); if (el && val != null && val !== '') el.value = val; };
  set('title', item.title);
  set('brand', item.brand);
  set('model', item.model);
  if (item.category) $('#f-category').value = item.category;
  if (item.condition) $('#f-condition').value = item.condition;
  if (item.listing_price != null) $('#f-listing_price').value = item.listing_price;
  const specs = item.specs || {};
  for (const k of ['cpu', 'ram', 'storage', 'gpu', 'screen', 'os']) set(k, specs[k]);
  const notes = $('#f-notes');
  if (item.notes && notes && !notes.value.trim()) notes.value = item.notes;
}

const ebayImportPanel = `
  <div class="fin-box" style="margin-bottom:16px">
    <div class="lbl" style="margin-bottom:6px">🔎 Auto-fill from an eBay listing</div>
    <div style="display:flex;gap:8px;flex-wrap:wrap">
      <input id="ebayImport" placeholder="Paste eBay listing URL or item number" style="flex:1;min-width:200px" />
      <button class="btn small" id="ebayImportBtn" type="button">Fetch details</button>
    </div>
    <div id="ebayImportMsg" class="muted" style="font-size:12px;margin-top:6px">Pulls title, price, condition &amp; specs from a listing. Uses the eBay API if set (Admin → eBay API), otherwise a best-effort page read.</div>
  </div>`;

function openItemForm(it) {
  $('#drawerTitle').textContent = it ? 'Edit item' : 'Add item';
  $('#deleteItemBtn').style.display = it ? 'inline-block' : 'none';
  $('#drawerBody').innerHTML =
    ebayImportPanel +
    itemFormHTML(it || {}) +
    `<div style="display:flex;gap:10px;margin-top:16px;flex-wrap:wrap">
       <button class="btn" id="saveItemBtn">${it ? 'Save changes' : 'Create item'}</button>
       ${it ? '' : '<button class="btn secondary" id="saveAddAnotherBtn">Save &amp; add another</button>'}
       <button class="btn secondary" id="cancelItemBtn">Cancel</button>
     </div>`;

  const importBtn = $('#ebayImportBtn');
  const doImport = async () => {
    const input = $('#ebayImport').value.trim();
    const msg = $('#ebayImportMsg');
    if (!input) { msg.style.color = 'var(--neg)'; msg.textContent = 'Paste a listing URL or item number first.'; return; }
    msg.style.color = 'var(--muted)'; msg.textContent = 'Fetching from eBay…';
    importBtn.disabled = true;
    try {
      const r = await api.post('/ebay/listing', { url: input });
      fillFormFromItem(r.item);
      msg.style.color = 'var(--pos)';
      msg.textContent = `Filled from listing ${r.legacyId} — review the fields and save.`;
    } catch (e) {
      msg.style.color = 'var(--neg)';
      msg.innerHTML = /api key|credential/i.test(e.message)
        ? `${esc(e.message)} <a href="/admin">Add eBay API keys in Admin</a>.`
        : `${esc(e.message)}<br>eBay often blocks scraping from a server — <a href="/admin">add eBay API keys in Admin</a> (API integrations) for reliable lookups.`;
    } finally {
      importBtn.disabled = false;
    }
  };
  importBtn.addEventListener('click', doImport);
  $('#ebayImport').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); doImport(); } });

  $('#cancelItemBtn').addEventListener('click', () => (it ? openItem(it.id) : closeDrawer()));
  $('#saveItemBtn').addEventListener('click', async () => {
    const data = collectForm();
    if (!data.title) return toast('Title is required');
    try {
      if (it) { await api.put(`/items/${it.id}`, data); toast('Saved'); }
      else { const created = await api.post('/items', data); it = created; toast('Item created'); }
      await refreshAll();
      openItem(it.id);
    } catch (e) { toast('Error: ' + e.message); }
  });
  $('#saveAddAnotherBtn')?.addEventListener('click', async () => {
    const data = collectForm();
    if (!data.title) return toast('Title is required');
    try {
      await api.post('/items', data);
      toast('Item created — add the next one');
      await refreshAll();
      openItemForm(null); // fresh blank form, drawer stays open
    } catch (e) { toast('Error: ' + e.message); }
  });
  $('#deleteItemBtn').onclick = null;
  openDrawer();
}

async function openItem(id) {
  openDrawer();
  $('#drawerTitle').textContent = 'Loading…';
  $('#drawerBody').innerHTML = '';
  const { item, costs, financials, upgrades, images } = await api.get(`/items/${id}`);
  currentItemId = id;
  currentItem = item;
  $('#drawerTitle').textContent = item.title;
  const del = $('#deleteItemBtn');
  del.style.display = 'inline-block';
  del.onclick = async () => {
    if (!confirm('Delete this item and its costs?')) return;
    await api.del(`/items/${id}`);
    toast('Deleted');
    closeDrawer();
    refreshAll();
  };

  const canSell = item.status !== 'sold';
  $('#drawerBody').innerHTML = `
    <div style="display:flex;gap:10px;margin-bottom:14px;flex-wrap:wrap">
      <button class="btn secondary small" id="editBtn">Edit details</button>
      <button class="btn secondary small" id="marketBtn">Check market prices</button>
      <select id="marketCondition" class="cond-select" title="Which listings to compare against"></select>
      <button class="btn secondary small" id="dupBtn">⧉ Duplicate</button>
      <button class="btn secondary small" id="visToggle">${item.hidden ? '👁️ Show in shop' : '🙈 Hide from shop'}</button>
      ${canSell ? '<button class="btn small" id="sellBtn">Mark as sold</button>' : ''}
    </div>
    <div id="sellForm" style="display:none;margin-bottom:14px" class="fin-box">
      <div class="grid-2">
        <label class="field"><span class="lbl">Sold price ($)${Number(item.quantity) > 1 ? ' — per unit (×' + Number(item.quantity) + ')' : ''}</span><input id="sell-price" type="number" step="0.01" value="${item.listing_price ?? financials.suggestedPrice ?? ''}" /></label>
        <label class="field"><span class="lbl">Sold date</span><input id="sell-date" type="date" /></label>
      </div>
      <label style="display:flex;align-items:center;gap:8px;margin-bottom:10px;font-size:13px;cursor:pointer">
        <input type="checkbox" id="sell-local" style="width:auto" ${item.local_sale ? 'checked' : ''} /> Sold locally / to a friend — no marketplace fees
      </label>
      <button class="btn small" id="sellConfirm">Confirm sale</button>
      <button class="btn secondary small" id="sellCancel">Cancel</button>
    </div>
    ${financialsHTML(item, financials)}

    <div class="section-title">Photos</div>
    <div class="card-sub" style="margin:-4px 0 8px">The first photo is the storefront thumbnail. Customers see these.</div>
    <div id="imagesList" class="img-grid"></div>
    <label class="btn secondary small" style="display:inline-block;cursor:pointer;margin-top:8px">+ Upload photos
      <input type="file" id="imgFile" accept="image/*" multiple style="display:none" />
    </label>

    <div class="section-title">What was spent to get it working</div>
    <div id="costsList"></div>
    <div class="grid-3" style="margin-top:10px">
      <label class="field"><span class="lbl">Description</span><input id="c-desc" placeholder="e.g. New SSD" /></label>
      <label class="field"><span class="lbl">Amount ($)</span><input id="c-amt" type="number" step="0.01" /></label>
      <label class="field"><span class="lbl">Type</span><select id="c-cat">
        <option value="part">part</option><option value="labor">labor</option>
        <option value="shipping">shipping</option><option value="testing">testing</option>
        <option value="fees">fees</option><option value="other">other</option>
      </select></label>
    </div>
    <button class="btn small" id="addCostBtn">+ Add cost</button>

    <div class="section-title">Customer upgrade options</div>
    <div class="card-sub" style="margin:-4px 0 8px">Shown in the customer storefront; buyers can add these to bump the price.</div>
    <div id="upgradesList"></div>
    <div class="grid-3" style="margin-top:10px">
      <label class="field" style="grid-column:span 2"><span class="lbl">Upgrade label</span><input id="u-label" placeholder="e.g. Upgrade to 32GB RAM" /></label>
      <label class="field"><span class="lbl">Extra price ($)</span><input id="u-amt" type="number" step="0.01" /></label>
    </div>
    <button class="btn small" id="addUpgradeBtn">+ Add upgrade</button>

    <div class="section-title">Market comparison</div>
    <div id="marketArea"><p class="muted">Click “Check market prices” to pull eBay / Amazon comparables and recently-sold prices for this item.</p></div>
  `;

  renderCosts(costs);
  renderUpgrades(upgrades || []);
  renderImages(images || []);
  $('#imgFile').addEventListener('change', async (e) => {
    const files = [...e.target.files];
    e.target.value = '';
    for (const f of files) {
      if (!f.type.startsWith('image/')) continue;
      try {
        const res = await fetch(`/api/items/${id}/images?name=${encodeURIComponent(f.name)}`, {
          method: 'POST', headers: { 'Content-Type': f.type }, body: f,
        });
        if (!res.ok) { const d = await res.json().catch(() => ({})); toast('Upload failed: ' + (d.error || res.status)); }
      } catch (err) { toast('Upload failed: ' + err.message); }
    }
    toast('Photos uploaded');
    openItem(id);
    loadInventory();
  });
  $('#addUpgradeBtn').addEventListener('click', async () => {
    const label = $('#u-label').value.trim();
    const price_delta = Number($('#u-amt').value);
    if (!label) return toast('Enter an upgrade label');
    await api.post(`/items/${id}/upgrades`, { label, price_delta: price_delta || 0 });
    toast('Upgrade added');
    openItem(id);
  });
  $('#editBtn').addEventListener('click', () => openItemForm(item));
  $('#dupBtn').addEventListener('click', async () => {
    try {
      const copy = await api.post(`/items/${id}/duplicate`);
      toast('Duplicated — opening the copy');
      await refreshAll();
      openItem(copy.id);
    } catch (e) { toast('Error: ' + e.message); }
  });
  $('#visToggle').addEventListener('click', async () => {
    await api.put(`/items/${id}`, { hidden: item.hidden ? 0 : 1 });
    toast(item.hidden ? 'Now visible in the storefront' : 'Hidden from the storefront');
    await refreshAll();
    openItem(id);
  });
  if (canSell) {
    $('#sellBtn').addEventListener('click', () => {
      const f = $('#sellForm');
      f.style.display = f.style.display === 'none' ? 'block' : 'none';
      if (!$('#sell-date').value) $('#sell-date').value = new Date().toISOString().slice(0, 10);
    });
    $('#sellCancel').addEventListener('click', () => ($('#sellForm').style.display = 'none'));
    $('#sellConfirm').addEventListener('click', async () => {
      const sold_price = Number($('#sell-price').value);
      if (!sold_price) return toast('Enter a sold price');
      await api.post(`/items/${id}/sell`, { sold_price, sold_date: $('#sell-date').value || undefined, local_sale: $('#sell-local').checked ? 1 : 0 });
      toast('Marked as sold');
      await refreshAll();
      openItem(id);
    });
  }
  $('#addCostBtn').addEventListener('click', async () => {
    const description = $('#c-desc').value.trim();
    const amount = Number($('#c-amt').value);
    if (!description || !amount) return toast('Enter a description and amount');
    await api.post(`/items/${id}/costs`, { description, amount, category: $('#c-cat').value });
    toast('Cost added');
    openItem(id);
    loadDashboard();
  });
  // Default the comparison to the item's own condition — that is the honest
  // comparison, and it is what the server would pick anyway.
  fillConditionSelect($('#marketCondition'), conditionKeyFor(item.condition));
  $('#marketBtn').addEventListener('click', () => checkMarket(id));
  $('#marketCondition').addEventListener('change', () => {
    if ($('#marketArea').dataset.loaded) checkMarket(id);
  });
}

function financialsHTML(item, f) {
  const q = f.quantity || 1;
  const multi = q > 1;
  const per = multi ? ' <span class="muted" style="font-weight:400;font-size:11px">/ unit</span>' : '';
  const acrossN = multi ? ` <span class="muted" style="font-weight:400;font-size:11px">(× ${q})</span>` : '';
  const goodBad = f.profitableAtCurrentPlan;
  let callout = '';
  if (item.status === 'sold') {
    callout = `<div class="callout ${f.realizedProfit >= 0 ? 'good' : 'bad'}">Sold ${multi ? q + ' × ' : ''}${money(item.sold_price)}${multi ? ' each' : ''} → realized profit ${moneyExact(f.realizedProfit)} (${pct(f.realizedMargin)} margin)${multi ? ` on ${q} units` : ''}.</div>`;
  } else if (f.amountToBreakEven != null) {
    if (goodBad) {
      callout = `<div class="callout good">At your ${f.listingPrice != null ? 'asking price' : 'market estimate'} of ${money(f.listingPrice ?? f.marketEstimate)}${multi ? ' /unit' : ''} you clear break-even by ${money(-f.amountToBreakEven)} → profit ${moneyExact(f.profitAtListing ?? f.projectedProfit)}${multi ? ` across ${q} units` : ''}.</div>`;
    } else {
      callout = `<div class="callout bad">Not yet profitable: you need to raise the price by ${money(f.amountToBreakEven)} (to ≥ ${money(f.breakEvenPrice)}) or cut costs to turn a profit.</div>`;
    }
  } else {
    callout = `<div class="callout bad">Set a listing price (or check market prices) to see what you need to turn a profit. Break-even sale price is ${money(f.breakEvenPrice)}.</div>`;
  }

  return `<div id="finBox"><div class="fin-box">
    ${multi ? `<div class="fin-row"><span class="k">Quantity</span><span class="v">${q} units</span></div>` : ''}
    <div class="fin-row"><span class="k">Acquisition cost${per}</span><span class="v">${money(f.acquisitionCost)}</span></div>
    <div class="fin-row"><span class="k">Spent to get it working${per}</span><span class="v">${money(f.refurbCost)}</span></div>
    <div class="fin-row hi"><span class="k">Total invested${acrossN}</span><span class="v">${money(f.investedCost)}</span></div>
    <div class="fin-row"><span class="k">Selling fees${per}</span><span class="v">${f.localSale ? '<span class="pos">none (local sale)</span> + ' + money(f.shipping) + ' ship' : pct(f.feeRate) + ' + ' + money(f.flatFee) + ' + ' + money(f.shipping) + ' ship'}</span></div>
    <div class="fin-row hi"><span class="k">Break-even sale price${per}</span><span class="v">${money(f.breakEvenPrice)}</span></div>
    <div class="fin-row"><span class="k">Suggested price (${pct(f.targetMargin)} margin)${per}</span><span class="v">${money(f.suggestedPrice)}</span></div>
    ${f.marketEstimate != null ? `<div class="fin-row"><span class="k">Market estimate${per}</span><span class="v">${money(f.marketEstimate)}</span></div>` : ''}
    ${item.status === 'sold' && multi ? `<div class="fin-row"><span class="k">Total sale revenue${acrossN}</span><span class="v">${money(f.realizedRevenue)}</span></div>` : ''}
    ${item.status !== 'sold' && f.projectedProfit != null ? `<div class="fin-row"><span class="k">Projected profit${acrossN}</span><span class="v ${f.projectedProfit >= 0 ? 'pos' : 'neg'}">${moneyExact(f.projectedProfit)}</span></div>` : ''}
  </div>${callout}</div>`;
}

function renderCosts(costs) {
  const el = $('#costsList');
  if (!costs.length) { el.innerHTML = '<p class="muted" style="margin:6px 0">No refurbishment costs recorded yet.</p>'; return; }
  el.innerHTML = costs
    .map((c) => `<div class="cost-item">
      <span class="desc">${esc(c.description)} <span class="src-tag">${esc(c.category)}</span></span>
      <span class="amt">${money(c.amount)}</span>
      <button class="link" data-cost="${c.id}">remove</button>
    </div>`)
    .join('');
  $$('#costsList [data-cost]').forEach((b) =>
    b.addEventListener('click', async (e) => {
      e.stopPropagation();
      await api.del(`/costs/${b.dataset.cost}`);
      toast('Cost removed');
      openItem(currentItemId);
      loadDashboard();
    })
  );
}

function renderImages(imgs) {
  const el = $('#imagesList');
  if (!el) return;
  if (!imgs.length) { el.innerHTML = '<p class="muted" style="margin:6px 0;font-size:13px">No photos yet.</p>'; return; }
  el.innerHTML = imgs
    .map((im) => `<div class="img-thumb ${im.is_primary ? 'primary' : ''}">
      <img src="/api/media/${im.id}" alt="" />
      <div class="img-actions">
        ${im.is_primary ? '<span class="tag">cover</span>' : `<button class="link" data-primary="${im.id}">make cover</button>`}
        <button class="link neg" data-delimg="${im.id}">delete</button>
      </div>
    </div>`)
    .join('');
  $$('#imagesList [data-delimg]').forEach((b) => b.addEventListener('click', async () => {
    await api.del(`/images/${b.dataset.delimg}`); toast('Photo removed'); openItem(currentItemId); loadInventory();
  }));
  $$('#imagesList [data-primary]').forEach((b) => b.addEventListener('click', async () => {
    await api.post(`/images/${b.dataset.primary}/primary`); toast('Cover set'); openItem(currentItemId); loadInventory();
  }));
}

function renderUpgrades(upgrades) {
  const el = $('#upgradesList');
  if (!el) return;
  if (!upgrades.length) { el.innerHTML = '<p class="muted" style="margin:6px 0">No upgrade options yet.</p>'; return; }
  el.innerHTML = upgrades
    .map((u) => `<div class="cost-item">
      <span class="desc">${esc(u.label)}</span>
      <span class="amt">+${money(u.price_delta)}</span>
      <button class="link" data-up="${u.id}">remove</button>
    </div>`)
    .join('');
  $$('#upgradesList [data-up]').forEach((b) =>
    b.addEventListener('click', async (e) => {
      e.stopPropagation();
      await api.del(`/upgrades/${b.dataset.up}`);
      toast('Upgrade removed');
      openItem(currentItemId);
    })
  );
}

// Map an item's stored condition onto a search group (the server normalizes
// too; this is just so the dropdown opens on the right option).
function conditionKeyFor(itemCondition) {
  const v = String(itemCondition || '').toLowerCase();
  if (/refurb|renew|recondition/.test(v)) return 'refurbished';
  if (/part|not working|broken|spares/.test(v)) return 'parts';
  if (/new|sealed|open box/.test(v)) return 'new';
  if (/used|pre-?owned|good|fair/.test(v)) return 'used';
  return 'any';
}

async function checkMarket(id) {
  const area = $('#marketArea');
  const condition = $('#marketCondition')?.value || 'any';
  area.innerHTML = '<p class="muted">Searching eBay &amp; Amazon…</p>';
  try {
    const r = await api.post(`/items/${id}/pricing`, { condition });
    area.dataset.loaded = '1';
    renderComps(area, r.comps, r.financials);
    // Re-render the financials box above so it reflects the market estimate.
    const box = $('#finBox');
    if (box && currentItem) box.outerHTML = financialsHTML(currentItem, r.financials);
    loadDashboard();
  } catch (e) {
    area.innerHTML = `<p class="neg">Lookup failed: ${esc(e.message)}</p>`;
  }
}

const ESTIMATE_BASIS = {
  live_sold: 'median of real recently-sold prices',
  live_active: 'median of real active listings (no sold data available)',
  demo_sold: 'SIMULATED sold prices — not real',
  demo_active: 'SIMULATED listings — not real',
};

function renderComps(el, comps, financials) {
  const sa = comps.stats.active, ss = comps.stats.sold;
  const notes = (comps.notes || []).map((n) => `<li>${esc(n)}</li>`).join('');
  const rowHTML = (r) => `<div class="comp-row">
      <span class="src-tag ${r.demo ? 'demo' : esc(r.source)}">${r.demo ? 'demo' : esc(r.source)}</span>
      ${r.sold ? '<span class="src-tag sold">sold</span>' : ''}
      <span class="title">${r.url ? `<a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.title)}</a>` : esc(r.title)}</span>
      <span class="muted" style="font-size:11px">${esc(r.condition || '')}${r.sold_date ? ' · ' + esc(r.sold_date) : ''}</span>
      <span class="price">${money(r.price)}</span>
    </div>`;

  // Provenance banner — real data and simulated data must never look alike.
  const banner = comps.isDemo
    ? `<div class="callout bad" style="margin-bottom:10px">⚠️ <strong>Simulated demo data — not real sales.</strong> No live marketplace provider answered, so these figures are illustrative only. Add eBay API keys in <a href="/admin#apis">Admin → API integrations</a> for real comparables.</div>`
    : `<div class="callout good" style="margin-bottom:10px">✓ Live marketplace data.${comps.soldDataAvailable ? '' : ' Recently-sold history is not available on your eBay keys (needs Marketplace Insights approval), so the estimate uses active listings.'}</div>`;

  // Sold panel: show the honest reason instead of fabricated numbers.
  const soldPanel = ss.count
    ? `<div class="comp-stat"><h4>Recently sold (${ss.count})${comps.isDemo ? ' <span class="src-tag demo">demo</span>' : ''}</h4><div class="med">${money(ss.median)}</div><div class="muted">${money(ss.min)}–${money(ss.max)}</div></div>`
    : `<div class="comp-stat"><h4>Recently sold</h4><div class="med muted">n/a</div><div class="muted" style="font-size:11px">needs Marketplace Insights approval</div></div>`;

  const condLine = comps.condition && comps.condition !== 'any'
    ? `<p class="muted" style="font-size:12px;margin:0 0 8px">Comparing against <strong>${esc(comps.conditionLabel)}</strong> listings only.</p>`
    : '';

  el.innerHTML = `
    ${banner}
    ${condLine}
    <div class="comp-stats">
      <div class="comp-stat"><h4>Active listings (${sa.count})${comps.isDemo ? ' <span class="src-tag demo">demo</span>' : ''}</h4><div class="med">${money(sa.median)}</div><div class="muted">${money(sa.min)}–${money(sa.max)}</div></div>
      ${soldPanel}
    </div>
    <p class="muted" style="font-size:12px;margin:4px 0 10px">
      Market estimate used for projection: <strong class="${comps.marketEstimateIsLive ? 'pos' : 'neg'}">${money(comps.marketEstimate)}</strong>
      ${comps.marketEstimateBasis ? `<span style="font-size:11px"> — ${esc(ESTIMATE_BASIS[comps.marketEstimateBasis] || comps.marketEstimateBasis)}</span>` : ''}.
      Suggested list price for target margin: <strong>${money(financials.suggestedPrice)}</strong>.
    </p>
    <div class="comp-list">
      ${[...comps.sold, ...comps.active].map(rowHTML).join('')}
    </div>
    ${pagerHTML(comps)}
    ${notes ? `<ul class="notes-panel">${notes}</ul>` : ''}
  `;
}

// Paging footer. Demo data has no pages, so the button only appears when a live
// provider actually reported more results waiting.
function pagerHTML(comps) {
  const shown = (comps.sold?.length || 0) + (comps.active?.length || 0);
  const totals = Object.entries(comps.paging || {})
    .map(([name, p]) => `${name}: ${p.total.toLocaleString()} matches`).join(' · ');
  if (!comps.hasMore) {
    return shown
      ? `<p class="muted comp-pager">Showing ${shown} comparable${shown === 1 ? '' : 's'}${totals ? ` · ${totals}` : ''}.</p>`
      : '';
  }
  return `<div class="comp-pager">
    <button class="btn secondary small" id="compMoreBtn">Load 50 more</button>
    <span class="muted">Showing ${shown}${totals ? ` · ${totals}` : ''}</span>
  </div>`;
}

// Time-frame controls — every dashboard chart reads the same window.
$('#rangeSelect')?.addEventListener('change', (e) => {
  chartRange = e.target.value;
  localStorage.setItem('tg_range', chartRange);
  loadDashboard();
});
$('#bucketSelect')?.addEventListener('change', (e) => {
  chartBucket = e.target.value;
  localStorage.setItem('tg_bucket', chartBucket);
  loadDashboard();
});

// ---- ad hoc price lookup -------------------------------------------------
$('#lookupBtn').addEventListener('click', runLookup);
$('#lookupQuery').addEventListener('keydown', (e) => { if (e.key === 'Enter') runLookup(); });
let lookupState = null; // { q, sources, condition, offset, sold: [], active: [] }

async function runLookup(more = false) {
  const el = $('#lookupResults');
  if (!more) {
    const q = $('#lookupQuery').value.trim();
    if (!q) return toast('Enter a search query');
    const sources = [];
    if ($('#srcEbay').checked) sources.push('ebay');
    if ($('#srcAmazon').checked) sources.push('amazon');
    lookupState = { q, sources, condition: $('#lookupCondition').value || 'any', offset: 0, sold: [], active: [] };
    el.innerHTML = '<p class="muted">Searching…</p>';
  } else {
    const btn = $('#compMoreBtn');
    if (btn) { btn.disabled = true; btn.textContent = 'Loading…'; }
  }

  const st = lookupState;
  try {
    const qs = new URLSearchParams({ q: st.q, condition: st.condition, limit: '50', offset: String(st.offset) });
    if (st.sources.length) qs.set('sources', st.sources.join(','));
    const comps = await api.get('/pricing/search?' + qs);

    // Accumulate across pages, de-duped by URL — eBay can repeat an item near a
    // page boundary, and a duplicate would quietly bias the median.
    const seen = new Set([...st.sold, ...st.active].map((r) => r.url || r.title));
    for (const r of comps.sold || []) if (!seen.has(r.url || r.title)) { seen.add(r.url || r.title); st.sold.push(r); }
    for (const r of comps.active || []) if (!seen.has(r.url || r.title)) { seen.add(r.url || r.title); st.active.push(r); }
    st.offset += comps.limit || 50;

    // Re-derive the stats over everything loaded, so the median reflects the
    // full sample rather than only the last page.
    renderComps(el, { ...comps, sold: st.sold, active: st.active, stats: recomputeStats(st) }, { suggestedPrice: null });
  } catch (e) {
    el.innerHTML = `<p class="neg">Lookup failed: ${esc(e.message)}</p>`;
  }
}

function recomputeStats(st) {
  const calc = (rows) => {
    const xs = rows.map((r) => r.price).filter((p) => typeof p === 'number' && !Number.isNaN(p)).sort((a, b) => a - b);
    if (!xs.length) return { count: 0, min: null, max: null, median: null, avg: null };
    const mid = Math.floor(xs.length / 2);
    const r2 = (n) => Math.round(n * 100) / 100;
    return {
      count: xs.length, min: r2(xs[0]), max: r2(xs[xs.length - 1]),
      median: r2(xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2),
      avg: r2(xs.reduce((a, b) => a + b, 0) / xs.length),
    };
  };
  return { active: calc(st.active), sold: calc(st.sold) };
}

document.addEventListener('click', (e) => {
  if (e.target?.id === 'compMoreBtn') runLookup(true);
});

window.addEventListener('resize', () => { if ($('#view-dashboard').classList.contains('active')) redrawCharts(); });

boot();
