// Customer storefront: browse for-sale items (price + specs + photos only),
// add to a cart, optionally pick upgrades, and request to purchase — with an
// offer field when the cart holds more than one item.
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const money = (n) => (n == null ? '—' : '$' + Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }));

let ITEMS = [];        // everything the catalog returned, including sold-out
let ME = null;
let CATEGORIES = [];
let CONDITION_NOTES = {};
let RECENT = [];
let GUEST = false;
// Guests read the catalogue through a separate public route, and its images
// live on a different path — one helper so every <img> agrees.
const mediaUrl = (id) => (GUEST ? `/api/public/media/${id}` : `/api/media/${id}`);
const cart = []; // { itemId, title, unit, upgrades:[{id,label,price_delta}], qty, max }

// --- cart persistence -----------------------------------------------------
// The cart used to be this array and nothing else, so a refresh, a tab switch
// or an incoming phone call threw it away silently. It is now mirrored to
// localStorage (instant, survives a reload) and to the server (survives a
// device change). The server copy is authoritative because it re-validates
// prices and stock — a cart restored days later must not quote a stale figure.
const CART_KEY = 'tg_cart';

function persistCart() {
  const lines = cart.map((l) => ({ itemId: l.itemId, upgradeIds: l.upgrades.map((u) => u.id), qty: l.qty }));
  try { localStorage.setItem(CART_KEY, JSON.stringify(lines)); } catch { /* private mode */ }
  clearTimeout(persistCart._t);
  // Debounced: a quantity stepper can fire several times a second.
  persistCart._t = setTimeout(() => {
    req('PUT', '/shop/cart', { lines }).catch(() => { /* offline: localStorage still has it */ });
  }, 600);
}

function restoreCart(serverCart) {
  let lines = serverCart?.lines;
  if (!lines || !lines.length) {
    // Fall back to this device's copy — e.g. the save request never landed.
    try { lines = JSON.parse(localStorage.getItem(CART_KEY) || '[]'); } catch { lines = []; }
    // Local lines are only ids/quantities, so rebuild them against live items.
    lines = (lines || []).map((l) => {
      const it = ITEMS.find((x) => x.id === l.itemId && !x.soldOut);
      if (!it) return null;
      const ups = (it.upgrades || []).filter((u) => (l.upgradeIds || []).includes(u.id));
      const max = Number(it.quantity) > 0 ? Number(it.quantity) : 1;
      return {
        itemId: it.id, title: it.title,
        unit: it.price + ups.reduce((s, u) => s + Number(u.price_delta), 0),
        upgrades: ups, qty: clampQty(l.qty, max), max,
      };
    }).filter(Boolean);
  }
  cart.length = 0;
  cart.push(...lines);
  renderCart();
}
const cartUnits = () => cart.reduce((s, l) => s + l.qty, 0);
function setCartCount(nn) {
  $$('.cart-count').forEach((el) => {
    el.textContent = nn;
    if (el.id === 'cartCount') el.style.display = nn ? 'inline-block' : 'none';
  });
}
const clampQty = (n, max) => Math.max(1, Math.min(Math.floor(Number(n) || 1), max || 1));
// A stable key for merging identical cart lines (same item + same upgrade set).
const lineKey = (itemId, upIds) => itemId + ':' + [...upIds].map(Number).sort((a, b) => a - b).join(',');

// Central "add to cart": merges into an existing identical line, capped at the
// number of units actually available. Used by both the card and the detail view.
function addLine(id, upgrades, qty) {
  const it = ITEMS.find((x) => x.id === id);
  if (!it) return;
  trackItem(id);
  const max = Number(it.quantity) > 0 ? Number(it.quantity) : 1;
  const unit = it.price + upgrades.reduce((s, u) => s + Number(u.price_delta), 0);
  const key = lineKey(id, upgrades.map((u) => u.id));
  const existing = cart.find((l) => lineKey(l.itemId, l.upgrades.map((u) => u.id)) === key);
  if (existing) existing.qty = clampQty(existing.qty + qty, max);
  else cart.push({ itemId: id, title: it.title, unit, upgrades, qty: clampQty(qty, max), max });
  persistCart();
  renderCart();
  openCart();
  toast(qty > 1 ? `Added ${qty} to cart` : 'Added to cart');
}

async function req(method, path, body, { redirectOn401 = true } = {}) {
  const opts = { method, headers: {} };
  if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  const res = await fetch('/api' + path, opts);
  if (res.status === 401) {
    // A guest browsing the public catalogue hits 401 constantly (tracking,
    // subscriptions, related items). Bouncing them to the login page for that
    // would make guest browsing unusable, so only redirect when we believed we
    // had a session.
    if (redirectOn401 && !GUEST) { window.location = '/login'; }
    throw new Error('unauthorized');
  }
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(data?.error || res.statusText);
  return data;
}
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(t._t); t._t = setTimeout(() => t.classList.remove('show'), 2500); }

async function copyShare(url) {
  try { await navigator.clipboard.writeText(url); toast('Share link copied'); }
  catch { prompt('Copy this share link:', url); }
}
// Share a public teaser link (/s/:id) — native share sheet on mobile, else copy.
async function shareItem(id) {
  const it = ITEMS.find((x) => x.id === id);
  const url = `${location.origin}/s/${id}`;
  trackItem(id);
  const title = it ? it.title : 'Available stock';
  if (navigator.share) {
    try { await navigator.share({ title, text: `Check out this ${title}`, url }); }
    catch (e) { if (!e || e.name !== 'AbortError') await copyShare(url); }
    return;
  }
  await copyShare(url);
}

// The persuasive numbers, in one place. Two independent claims:
//   savings  — the shop's own "was" price (compare_at_price)
//   market   — what similar units actually sell for, from real eBay comps
// The second is only ever rendered from live data (the server drops demo
// snapshots), because "similar units sell for $520" is a claim about the world.
function priceBlockHTML(it) {
  const save = it.savings
    ? `<span class="was">${money(it.savings.was)}</span> <span class="save-badge">Save ${money(it.savings.save)} · ${it.savings.percent}% off</span>`
    : '';
  let market = '';
  if (it.market && it.price != null && it.market.median > it.price) {
    const diff = Math.round((it.market.median - it.price) * 100) / 100;
    const what = it.market.basis === 'sold' ? 'recently sold for' : 'are listed at';
    market = `<div class="market-note" title="Median of ${it.market.sample} eBay comparables, checked ${it.market.ageDays === 0 ? 'today' : it.market.ageDays + ' days ago'}">
      📊 Similar units ${what} <strong>${money(it.market.median)}</strong> on eBay — you save ${money(diff)}
      <span class="muted">(${it.market.sample} comps)</span></div>`;
  }
  return `<div class="price">${money(it.price)} ${save || '<span class="base">base price</span>'}</div>${market}`;
}

function conditionNoteHTML(condition) {
  const note = CONDITION_NOTES[String(condition || '').toLowerCase()];
  return note ? `<div class="cond-note">ℹ️ <strong>${esc(condition)}:</strong> ${esc(note)}</div>` : '';
}

function cardHTML(it) {
  const specs = it.specs && typeof it.specs === 'object' ? it.specs : {};
  const specRows = Object.entries(specs).map(([k, v]) => `<li><span>${esc(k)}</span><span>${esc(v)}</span></li>`).join('');
  const imgs = it.images || [];
  const photo = imgs.length
    ? `<img class="photo" data-detail="${it.id}" src="${mediaUrl(imgs[0])}" alt="${esc(it.title)}" title="Click for a closer look" />` +
      (imgs.length > 1 ? `<div class="thumbs">${imgs.slice(0, 4).map((id) => `<img data-detail="${it.id}" src="${mediaUrl(id)}" alt="" />`).join('')}${imgs.length > 4 ? `<span class="more-thumbs" data-detail="${it.id}">+${imgs.length - 4}</span>` : ''}</div>` : '')
    : `<div class="photo placeholder" data-detail="${it.id}">💻</div>`;

  // A sold item stays visible rather than vanishing: an empty-looking shop
  // hides the fact that stock moves, and "tell me if another arrives" is
  // exactly what the alert subscriptions are for.
  if (it.soldOut) {
    return `<div class="shop-card sold-out" data-id="${it.id}">
      <div class="sold-ribbon">Sold</div>
      ${photo}
      <h3 data-detail="${it.id}" class="clickable">${esc(it.title)}</h3>
      <div class="meta">${esc(it.category)} · ${esc(it.condition)}${it.brand ? ' · ' + esc(it.brand) : ''}</div>
      ${specRows ? `<ul class="specs">${specRows}</ul>` : ''}
      <div class="price muted">${money(it.price)} <span class="base">last sold at</span></div>
      <div class="foot">
        <button class="btn secondary" data-sub="${it.id}" style="width:100%">🔔 Tell me if another arrives</button>
      </div>
    </div>`;
  }

  const upgrades = (it.upgrades || []).map((u) =>
    `<label><input type="checkbox" data-up="${u.id}" data-delta="${u.price_delta}" /> ${esc(u.label)} <span class="delta">+${money(u.price_delta)}</span></label>`
  ).join('');
  const qtyStepper = Number(it.quantity) > 1
    ? `<div class="qty-row"><span class="lbl2">Quantity <span class="muted" style="font-weight:400">(${Number(it.quantity)} available)</span></span>
        <div class="qty-stepper" data-max="${Number(it.quantity)}">
          <button type="button" data-qminus aria-label="Decrease quantity">−</button>
          <span data-qval>1</span>
          <button type="button" data-qplus aria-label="Increase quantity">+</button>
        </div>
      </div>` : '';
  return `<div class="shop-card" data-id="${it.id}" data-base="${it.price}">
    ${photo}
    <h3 data-detail="${it.id}" class="clickable">${esc(it.title)}</h3>
    <div class="meta">${esc(it.category)} · ${esc(it.condition)}${it.brand ? ' · ' + esc(it.brand) : ''}${Number(it.quantity) > 1 ? ' · <strong>' + Number(it.quantity) + ' available</strong>' : ''}</div>
    ${specRows ? `<ul class="specs">${specRows}</ul>` : ''}
    <button class="link details-link" data-detail="${it.id}" type="button">🔍 View full details &amp; photos</button>
    ${priceBlockHTML(it)}
    ${upgrades ? `<div class="upgrades"><div class="u-title">Optional upgrades</div>${upgrades}</div>` : ''}
    <div class="foot">
      <div class="total"><span class="lbl2">With upgrades</span><span class="amt" data-total>${money(it.price)}</span></div>
      ${qtyStepper}
      <div style="display:flex;gap:8px">
        <button class="btn" data-add style="flex:1">Add to cart</button>
        <button class="btn secondary" data-share="${it.id}" title="Share this item">🔗</button>
        <button class="btn secondary" data-sub="${it.id}" title="Notify me if this item's availability changes">🔔</button>
      </div>
    </div>
  </div>`;
}

// Wire a −/+ quantity stepper (used on cards and in the detail view). Reads/writes
// the [data-qval] label, clamped to [1, data-max]. Returns the current value.
function stepperValue(stepper) { return clampQty($('[data-qval]', stepper).textContent, Number(stepper.dataset.max)); }
function wireStepper(stepper) {
  const max = Number(stepper.dataset.max) || 1;
  const val = $('[data-qval]', stepper);
  const set = (n) => { val.textContent = clampQty(n, max); };
  $('[data-qminus]', stepper).addEventListener('click', (e) => { e.stopPropagation(); set(clampQty(val.textContent, max) - 1); });
  $('[data-qplus]', stepper).addEventListener('click', (e) => { e.stopPropagation(); set(clampQty(val.textContent, max) + 1); });
}

let SUBS = { store: false, items: [], email: null };
const isSubbed = (id) => SUBS.items.includes(id);
function renderSubStates() {
  $$('[data-sub]').forEach((b) => {
    const on = isSubbed(Number(b.dataset.sub));
    // A sold-out card's button is full-width with words on it; a live card's
    // is a compact icon next to Add-to-cart.
    const wide = b.closest('.shop-card')?.classList.contains('sold-out');
    if (wide) b.textContent = on ? "🔔 You'll be told when one arrives" : '🔔 Tell me if another arrives';
    else b.textContent = on ? '🔔 On' : '🔔';
    b.classList.toggle('active', on);
    b.title = on ? "You'll be notified if this item changes — click to stop" : "Notify me if this item's availability changes";
  });
  const lbl = $('#storeSubLabel');
  if (lbl) lbl.textContent = SUBS.store ? 'New-stock alerts: on ✓' : 'Notify me of new stock';
  const sb = $('#mStoreSub');
  if (sb) sb.classList.toggle('active', SUBS.store);
}
async function toggleSub(itemId) {
  const subbed = itemId == null ? SUBS.store : isSubbed(itemId);
  try {
    const r = await req(subbed ? 'DELETE' : 'POST', '/shop/subscriptions', { itemId: itemId ?? undefined });
    SUBS = { ...r, email: SUBS.email };
    renderSubStates();
    toast(subbed ? 'Notifications off' : "You'll be notified about updates");
  } catch (e) { toast(e.message); }
}

function recalc(card) {
  const base = Number(card.dataset.base) || 0;
  let total = base;
  $$('[data-up]', card).forEach((cb) => { if (cb.checked) total += Number(cb.dataset.delta) || 0; });
  $('[data-total]', card).textContent = money(total);
  return total;
}

// Log which items a customer actually looked at — once per item per visit.
const viewedItems = new Set();
function trackItem(id) {
  if (!id || viewedItems.has(id)) return;
  viewedItems.add(id);
  req('POST', '/shop/track', { kind: 'item', itemId: id }).catch(() => {});
}

function chosenUpgrades(it, root) {
  return $$('[data-up]', root).filter((c) => c.checked).map((c) => {
    const u = it.upgrades.find((x) => x.id === Number(c.dataset.up));
    return { id: u.id, label: u.label, price_delta: u.price_delta };
  });
}

function addToCart(card) {
  const id = Number(card.dataset.id);
  const it = ITEMS.find((x) => x.id === id);
  const stepper = $('.qty-stepper', card);
  const qty = stepper ? stepperValue(stepper) : 1;
  addLine(id, chosenUpgrades(it, card), qty);
}

function renderCart() {
  setCartCount(cartUnits());
  const body = $('#cartBody');
  if (!cart.length) { body.innerHTML = '<p class="muted">Your cart is empty.</p>'; $('#cartFoot').innerHTML = ''; return; }
  body.innerHTML = cart.map((l, i) => `<div class="cart-line">
    <div class="cl-main"><strong>${esc(l.title)}</strong>
      ${l.upgrades.length ? '<div class="cl-sub">+ ' + l.upgrades.map((u) => esc(u.label)).join(', ') + '</div>' : ''}
      <div class="cl-qty">
        <div class="qty-stepper small" data-max="${l.max}" data-i="${i}">
          <button type="button" data-cqminus aria-label="Decrease quantity">−</button>
          <span data-qval>${l.qty}</span>
          <button type="button" data-cqplus aria-label="Increase quantity">+</button>
        </div>
        <span class="cl-unit muted">× ${money(l.unit)}</span>
      </div>
    </div>
    <span class="cl-amt">${money(l.unit * l.qty)}</span>
    <button class="link neg" data-rm="${i}">remove</button>
  </div>`).join('');
  const total = cart.reduce((s, l) => s + l.unit * l.qty, 0);
  const canOffer = cartUnits() > 1;
  $('#cartFoot').innerHTML = `
    <div class="cart-total"><span>Total (${cartUnits()} item${cartUnits() === 1 ? '' : 's'})</span><span>${money(total)}</span></div>
    ${canOffer ? `<div class="offer-box"><label><input type="checkbox" id="makeOffer" style="width:auto" /> Make an offer for the bundle</label>
      <input id="offerAmt" type="number" step="0.01" placeholder="Your offer ($)" style="margin-top:8px;display:none" /></div>` : ''}
    <textarea id="cartMsg" rows="2" placeholder="Optional note to the seller…" style="width:100%;margin-bottom:8px"></textarea>
    <button class="btn" id="submitOrder" style="width:100%">Request to purchase</button>`;
  $$('#cartBody [data-rm]').forEach((b) => b.addEventListener('click', () => { cart.splice(Number(b.dataset.rm), 1); persistCart(); renderCart(); }));
  // Per-line quantity steppers: − at 1 removes the line.
  $$('#cartBody .qty-stepper').forEach((st) => {
    const i = Number(st.dataset.i);
    $('[data-cqminus]', st).addEventListener('click', () => {
      if (cart[i].qty <= 1) cart.splice(i, 1); else cart[i].qty -= 1;
      persistCart(); renderCart();
    });
    $('[data-cqplus]', st).addEventListener('click', () => { cart[i].qty = clampQty(cart[i].qty + 1, cart[i].max); persistCart(); renderCart(); });
  });
  if (canOffer) $('#makeOffer').addEventListener('change', (e) => { $('#offerAmt').style.display = e.target.checked ? 'block' : 'none'; });
  $('#submitOrder').addEventListener('click', submitOrder);
}

async function submitOrder() {
  const offerOn = $('#makeOffer')?.checked;
  const offer = offerOn ? Number($('#offerAmt').value) : null;
  const message = $('#cartMsg').value.trim();
  const items = cart.map((l) => ({ itemId: l.itemId, upgradeIds: l.upgrades.map((u) => u.id), qty: l.qty }));
  const foot = $('#cartFoot');
  foot.innerHTML = '<div class="contacting">📨 Contacting admin…</div>';
  try {
    const r = await req('POST', '/shop/requests', { items, offer: offer || undefined, message });
    $('#cartBody').innerHTML = `<div class="confirm">✓ ${esc(r.message)}<br><strong>Total: ${money(r.total)}</strong>${r.offer ? '<br>Your offer: ' + money(r.offer) : ''}</div>`;
    foot.innerHTML = '<button class="btn secondary" id="cartCloseBtn" style="width:100%">Done</button>';
    $('#cartCloseBtn').addEventListener('click', () => { cart.length = 0; renderCart(); closeCart(); location.reload(); });
    cart.length = 0;
    try { localStorage.removeItem(CART_KEY); } catch { /* ignore */ }
    setCartCount(0);
  } catch (e) {
    foot.innerHTML = `<div class="confirm" style="background:rgba(220,38,38,.1);color:var(--neg)">Could not send: ${esc(e.message)}</div>`;
  }
}

const openCart = () => $('#cartDrawer').classList.add('open');
const closeCart = () => $('#cartDrawer').classList.remove('open');

/**
 * Pinch / double-tap zoom with panning.
 *
 * Buying used hardware means inspecting it — scuffs on a lid, wear on keycaps,
 * the label on a drive. A gallery you cannot zoom is not enough to judge
 * condition from. The browser's own pinch-zoom is unavailable here because the
 * page sets `width=device-width`, so the gesture is handled directly.
 */
function wireZoom(img) {
  if (!img) return;
  let scale = 1, tx = 0, ty = 0;
  let startDist = 0, startScale = 1;
  let panning = false, startX = 0, startY = 0;

  const apply = () => {
    // Clamp the pan so the image can never be dragged completely off screen.
    const limit = (scale - 1) * 160;
    tx = Math.max(-limit, Math.min(limit, tx));
    ty = Math.max(-limit, Math.min(limit, ty));
    img.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
    img.classList.toggle('zoomed', scale > 1);
  };
  const reset = () => { scale = 1; tx = 0; ty = 0; apply(); };
  const dist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);

  img.addEventListener('touchstart', (e) => {
    if (e.touches.length === 2) { startDist = dist(e.touches); startScale = scale; }
    else if (e.touches.length === 1 && scale > 1) {
      panning = true; startX = e.touches[0].clientX - tx; startY = e.touches[0].clientY - ty;
    }
  }, { passive: true });

  img.addEventListener('touchmove', (e) => {
    if (e.touches.length === 2 && startDist) {
      e.preventDefault();
      scale = Math.max(1, Math.min(4, startScale * (dist(e.touches) / startDist)));
      if (scale === 1) { tx = 0; ty = 0; }
      apply();
    } else if (panning && e.touches.length === 1) {
      e.preventDefault();
      tx = e.touches[0].clientX - startX; ty = e.touches[0].clientY - startY;
      apply();
    }
  }, { passive: false });

  img.addEventListener('touchend', (e) => {
    if (e.touches.length === 0) { panning = false; startDist = 0; }
  });

  // Double-tap (and double-click on desktop) toggles between fit and 2.5×.
  let lastTap = 0;
  img.addEventListener('click', (e) => {
    e.stopPropagation();
    const now = Date.now();
    if (now - lastTap < 320) { scale = scale > 1 ? 1 : 2.5; tx = 0; ty = 0; apply(); }
    lastTap = now;
  });
  // Desktop: wheel zooms rather than scrolling the page behind the lightbox.
  img.addEventListener('wheel', (e) => {
    e.preventDefault();
    scale = Math.max(1, Math.min(4, scale - e.deltaY * 0.002));
    if (scale === 1) { tx = 0; ty = 0; }
    apply();
  }, { passive: false });
  reset();
}

// Full-screen image viewer with prev/next + keyboard nav, for a closer look.
function openLightbox(imgs, start = 0) {
  if (!imgs || !imgs.length) return;
  let idx = Math.max(0, Math.min(start, imgs.length - 1));
  let lb = $('#lightbox');
  if (!lb) { lb = document.createElement('div'); lb.id = 'lightbox'; lb.className = 'lightbox'; document.body.appendChild(lb); }
  const close = () => { lb.classList.remove('open'); lb.onclick = null; document.removeEventListener('keydown', onKey); };
  const go = (d) => { idx = (idx + d + imgs.length) % imgs.length; render(); };
  const onKey = (e) => {
    if (e.key === 'Escape') close();
    else if (e.key === 'ArrowLeft') go(-1);
    else if (e.key === 'ArrowRight') go(1);
  };
  function render() {
    lb.innerHTML = `<button class="lb-close" aria-label="Close">&times;</button>
      ${imgs.length > 1 ? '<button class="lb-nav prev" aria-label="Previous">‹</button>' : ''}
      <img src="${mediaUrl(imgs[idx])}" alt="" />
      ${imgs.length > 1 ? '<button class="lb-nav next" aria-label="Next">›</button>' : ''}
      ${imgs.length > 1 ? `<div class="lb-count">${idx + 1} / ${imgs.length}</div>` : ''}
      <div class="lb-hint">Pinch or double-tap to zoom</div>`;
    $('.lb-close', lb).addEventListener('click', close);
    const p = $('.lb-nav.prev', lb), n = $('.lb-nav.next', lb);
    if (p) p.addEventListener('click', (e) => { e.stopPropagation(); go(-1); });
    if (n) n.addEventListener('click', (e) => { e.stopPropagation(); go(1); });
    wireZoom($('img', lb));
  }
  render();
  lb.onclick = (e) => { if (e.target === lb) close(); };
  lb.classList.add('open');
  document.addEventListener('keydown', onKey);
}

// Customer item detail view: bigger photos (with a zoomable gallery), full
// specs, the public description, and add-to-cart with upgrades + quantity.
async function openDetail(id, { push = true } = {}) {
  const it = ITEMS.find((x) => x.id === id);
  if (!it) return;
  trackItem(id);
  // Give the detail view a real address: it can now be bookmarked, sent to a
  // friend, and closed with the browser Back button. Previously it was a modal
  // with no URL, so Back exited the shop entirely.
  if (push && location.hash !== `#item-${id}`) history.pushState({ item: id }, '', `#item-${id}`);

  // Complementary stock is fetched per item rather than shipped with the whole
  // catalog — it is only needed once someone is actually looking at something.
  let related = [];
  try { related = (await req('GET', `/shop/item/${id}`)).related || []; } catch { /* non-fatal */ }
  const imgs = it.images || [];
  const specs = it.specs && typeof it.specs === 'object' ? it.specs : {};
  const specRows = Object.entries(specs).map(([k, v]) => `<li><span>${esc(k)}</span><span>${esc(v)}</span></li>`).join('');
  const upgrades = (it.upgrades || []).map((u) =>
    `<label><input type="checkbox" data-up="${u.id}" data-delta="${u.price_delta}" /> ${esc(u.label)} <span class="delta">+${money(u.price_delta)}</span></label>`
  ).join('');
  const gallery = imgs.length
    ? `<img class="detail-main" data-detail-main src="${mediaUrl(imgs[0])}" alt="${esc(it.title)}" title="Click to zoom" />
       ${imgs.length > 1 ? `<div class="detail-thumbs">${imgs.map((im, i) => `<img data-dthumb data-idx="${i}" class="${i === 0 ? 'active' : ''}" src="${mediaUrl(im)}" alt="" />`).join('')}</div>` : ''}`
    : '<div class="detail-main placeholder">💻</div>';
  const qtyStepper = `<div class="qty-stepper" data-max="${Number(it.quantity) || 1}"><button type="button" data-qminus aria-label="Decrease quantity">−</button><span data-qval>1</span><button type="button" data-qplus aria-label="Increase quantity">+</button></div>`;
  let modal = $('#detailModal');
  if (!modal) { modal = document.createElement('div'); modal.id = 'detailModal'; modal.className = 'overlay center'; document.body.appendChild(modal); }
  modal.innerHTML = `<div class="modal-card detail-card">
    <div class="cart-head"><h2>${esc(it.title)}</h2><button class="close-x" id="detailClose">&times;</button></div>
    <div class="detail-grid">
      <div class="detail-media">${gallery}</div>
      <div class="detail-info">
        <div class="meta">${esc(it.category)} · ${esc(it.condition)}${it.brand ? ' · ' + esc(it.brand) : ''}${it.model ? ' · ' + esc(it.model) : ''}</div>
        ${Number(it.quantity) > 1 ? `<div class="pill in_stock" style="margin:8px 0">${Number(it.quantity)} available</div>` : ''}
        ${priceBlockHTML(it)}
        ${conditionNoteHTML(it.condition)}
        ${it.description ? `<div class="detail-desc">${esc(it.description).replace(/\n/g, '<br>')}</div>` : ''}
        ${specRows ? `<div class="section-title" style="margin-top:14px">Specs</div><ul class="specs detail-specs">${specRows}</ul>` : ''}
        ${upgrades ? `<div class="upgrades"><div class="u-title">Optional upgrades</div>${upgrades}</div>` : ''}
        <div class="total" style="margin:12px 0"><span class="lbl2">With upgrades</span><span class="amt" data-total>${money(it.price)}</span></div>
        ${Number(it.quantity) > 1 ? `<div class="qty-row"><span class="lbl2">Quantity</span>${qtyStepper}</div>` : ''}
        <button class="btn" id="detailAdd" style="width:100%">Add to cart</button>
        <button class="link" id="detailShare" style="margin-top:10px">🔗 Share this item</button>
      </div>
    </div>
    ${related.length ? `<div class="related">
      <div class="strip-title">You might also need</div>
      <div class="strip-row">${related.map(miniCardHTML).join('')}</div>
    </div>` : ''}
  </div>`;
  modal.classList.add('open');
  const close = () => {
    modal.classList.remove('open');
    // Closing by button or backdrop should leave the URL clean too, so Back
    // doesn't reopen a view the shopper just dismissed.
    if (location.hash === `#item-${id}`) history.back();
  };
  $('#detailClose').addEventListener('click', close);
  modal.onclick = (e) => { if (e.target === modal) close(); };
  $('#detailShare')?.addEventListener('click', () => shareItem(id));
  $$('[data-mini]', modal).forEach((el) => el.addEventListener('click', () => {
    modal.classList.remove('open');
    openDetail(Number(el.dataset.mini));
  }));
  $$('[data-up]', modal).forEach((cb) => cb.addEventListener('change', () => {
    let total = it.price;
    $$('[data-up]', modal).forEach((c) => { if (c.checked) total += Number(c.dataset.delta) || 0; });
    $('[data-total]', modal).textContent = money(total);
  }));
  $$('[data-dthumb]', modal).forEach((t) => t.addEventListener('click', () => {
    $('[data-detail-main]', modal).src = t.src;
    $$('[data-dthumb]', modal).forEach((x) => x.classList.remove('active'));
    t.classList.add('active');
  }));
  const main = $('[data-detail-main]', modal);
  if (main && imgs.length) main.addEventListener('click', () => {
    const active = $('[data-dthumb].active', modal);
    openLightbox(imgs, active ? Number(active.dataset.idx) : 0);
  });
  const st = $('.qty-stepper', modal);
  if (st) wireStepper(st);
  $('#detailAdd').addEventListener('click', () => {
    addLine(id, chosenUpgrades(it, modal), st ? stepperValue(st) : 1);
    close();
  });
}

// Account details modal: edit name/email/phone and change password.
function openAccountModal() {
  const me = ME || {};
  let modal = $('#acctModal');
  if (!modal) { modal = document.createElement('div'); modal.id = 'acctModal'; modal.className = 'overlay center'; document.body.appendChild(modal); }
  modal.innerHTML = `<div class="modal-card">
    <div class="cart-head"><h2>Account details</h2><button class="close-x" id="acctClose">&times;</button></div>
    <div style="padding:18px">
      <div class="err" id="acctErr"></div>
      <div class="muted" style="font-size:12px;margin-bottom:12px">Signed in as <strong>${esc(me.username || '')}</strong></div>
      <label class="field"><span class="lbl">Name</span><input id="a-name" value="${esc(me.name || '')}" /></label>
      <label class="field"><span class="lbl">Email</span><input id="a-email" type="email" value="${esc(me.email || '')}" placeholder="you@example.com" /></label>
      <label class="field"><span class="lbl">Phone</span><input id="a-phone" value="${esc(me.phone || '')}" placeholder="+1 555 123 4567" /></label>
      <div class="muted" style="font-size:11.5px;margin:-6px 0 12px">Add your number in full international format to also get stock alerts on WhatsApp (when the store has it enabled).</div>
      <button class="btn" id="acctSave">Save details</button>
      <div class="section-title" style="margin-top:20px">Change password</div>
      <label class="field"><span class="lbl">Current password</span><input id="a-cur" type="password" autocomplete="current-password" /></label>
      <label class="field"><span class="lbl">New password (min 8)</span><input id="a-new" type="password" autocomplete="new-password" /></label>
      <button class="btn secondary" id="acctPw">Update password</button>
      <div id="acctMsg" style="font-size:12.5px;margin-top:10px"></div>
    </div>
  </div>`;
  modal.classList.add('open');
  const close = () => modal.classList.remove('open');
  const msg = (t, ok) => { const m = $('#acctMsg'); m.textContent = t; m.style.color = ok === true ? 'var(--pos)' : ok === false ? 'var(--neg)' : 'var(--muted)'; };
  $('#acctClose').addEventListener('click', close);
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
  $('#acctSave').addEventListener('click', async () => {
    try {
      const r = await req('POST', '/shop/account', { name: $('#a-name').value.trim(), email: $('#a-email').value.trim(), phone: $('#a-phone').value.trim() });
      ME = { ...ME, name: r.name, email: r.email, phone: r.phone };
      $('.popout-head') && ($('.popout-head').textContent = ME.name || ME.username);
      msg('✓ Details saved', true);
    } catch (e) { msg(e.message, false); }
  });
  $('#acctPw').addEventListener('click', async () => {
    const nw = $('#a-new').value;
    if (nw.length < 8) return msg('New password must be at least 8 characters.', false);
    if (!$('#a-cur').value) return msg('Enter your current password.', false);
    try {
      await req('POST', '/shop/password', { currentPassword: $('#a-cur').value, newPassword: nw });
      $('#a-cur').value = ''; $('#a-new').value = '';
      msg('✓ Password updated', true);
    } catch (e) { msg(e.message, false); }
  });
}

// --- filtering, sorting and rendering the grid ----------------------------
// Previously the only control was a search box that hid non-matching cards.
// Filters live in one place now so search, category, price cap and sort all
// compose instead of fighting each other.
const filters = { q: '', category: '', maxPrice: null, sort: 'newest', showSold: true };
let searchTimer = null;

const SORTS = {
  newest: { label: 'Newest first', cmp: (a, b) => b.id - a.id },
  'price-asc': { label: 'Price: low to high', cmp: (a, b) => (a.price ?? 0) - (b.price ?? 0) },
  'price-desc': { label: 'Price: high to low', cmp: (a, b) => (b.price ?? 0) - (a.price ?? 0) },
  savings: { label: 'Biggest saving', cmp: (a, b) => (b.savings?.save || 0) - (a.savings?.save || 0) },
  title: { label: 'Name (A–Z)', cmp: (a, b) => String(a.title).localeCompare(String(b.title)) },
};

function visibleItems() {
  const q = filters.q.toLowerCase().trim();
  return ITEMS
    .filter((it) => {
      if (it.soldOut && !filters.showSold) return false;
      if (filters.category && it.category !== filters.category) return false;
      // A price cap is about what you can spend, so sold-out history is
      // irrelevant to it — but a null price shouldn't silently pass either.
      if (filters.maxPrice != null && !(it.price != null && it.price <= filters.maxPrice)) return false;
      if (!q) return true;
      const hay = [it.title, it.brand, it.model, it.category, it.condition, Object.values(it.specs || {}).join(' ')]
        .join(' ').toLowerCase();
      return hay.includes(q);
    })
    // In-stock always outranks sold, whatever the sort — otherwise "price: low
    // to high" leads with things nobody can buy.
    .sort((a, b) => (a.soldOut ? 1 : 0) - (b.soldOut ? 1 : 0) || (SORTS[filters.sort] || SORTS.newest).cmp(a, b));
}

function renderGrid() {
  const list = visibleItems();
  const grid = $('#shopGrid');
  grid.innerHTML = list.map(cardHTML).join('');
  const forSale = list.filter((i) => !i.soldOut).length;
  $('#shopEmpty').style.display = list.length ? 'none' : 'block';
  $('#resultCount').textContent = ITEMS.length
    ? `${forSale} item${forSale === 1 ? '' : 's'} available${list.length - forSale ? ` · ${list.length - forSale} recently sold` : ''}`
    : '';

  $$('.shop-card', grid).forEach((card) => {
    const id = Number(card.dataset.id);
    $$('[data-up]', card).forEach((cb) => cb.addEventListener('change', () => { recalc(card); trackItem(id); }));
    const stepper = $('.qty-stepper', card);
    if (stepper) wireStepper(stepper);
    $('[data-add]', card)?.addEventListener('click', () => addToCart(card));
    $('[data-share]', card)?.addEventListener('click', () => shareItem(id));
    $('[data-sub]', card)?.addEventListener('click', () => toggleSub(id));
    $$('[data-detail]', card).forEach((el) => el.addEventListener('click', () => openDetail(id)));
  });
  renderSubStates();
}

function renderFilters() {
  const cats = CATEGORIES.filter((c) => c.count);
  $('#catChips').innerHTML = cats.length > 1
    ? [{ key: '', count: cats.reduce((s, c) => s + c.count, 0) }, ...cats].map((c) =>
        `<button type="button" class="cat-chip${filters.category === c.key ? ' active' : ''}" data-cat="${esc(c.key)}">${esc(c.key || 'All')} <span>${c.count}</span></button>`).join('')
    : '';
  $('#sortSelect').innerHTML = Object.entries(SORTS)
    .map(([k, v]) => `<option value="${k}"${filters.sort === k ? ' selected' : ''}>${esc(v.label)}</option>`).join('');

  // The price cap tops out at the dearest item, so the slider always spans
  // something meaningful rather than an arbitrary constant.
  const prices = ITEMS.filter((i) => !i.soldOut && i.price != null).map((i) => i.price);
  const top = prices.length ? Math.ceil(Math.max(...prices) / 50) * 50 : 0;
  const wrap = $('#priceFilter');
  if (top > 0 && prices.length > 3) {
    wrap.style.display = '';
    const cap = $('#maxPrice');
    cap.max = String(top);
    if (!cap.dataset.init) { cap.value = String(top); cap.dataset.init = '1'; }
    $('#maxPriceLabel').textContent = Number(cap.value) >= top ? 'Any price' : `Up to ${money(Number(cap.value))}`;
  } else {
    wrap.style.display = 'none';
  }

  $$('#catChips .cat-chip').forEach((b) => b.addEventListener('click', () => {
    filters.category = b.dataset.cat; renderFilters(); renderGrid();
  }));
}

function onSearch() {
  filters.q = $('#searchBox').value;
  renderGrid();
  clearTimeout(searchTimer);
  const q = filters.q.toLowerCase().trim();
  if (q) searchTimer = setTimeout(() => { req('POST', '/shop/track', { kind: 'search', query: q }).catch(() => {}); }, 800);
}

// --- recently viewed ------------------------------------------------------
// Built from the visit log the app already keeps for the admin activity feed;
// the data was being collected and only ever shown to the shop.
function renderRecent() {
  const box = $('#recentStrip');
  const rows = RECENT.filter((r) => !r.soldOut);
  if (!rows.length) { box.style.display = 'none'; return; }
  box.style.display = '';
  box.innerHTML = `<div class="strip-title">Recently viewed</div>
    <div class="strip-row">${rows.map((it) => miniCardHTML(it)).join('')}</div>`;
  $$('[data-mini]', box).forEach((el) => el.addEventListener('click', () => openDetail(Number(el.dataset.mini))));
}

// --- shops we work with ---------------------------------------------------
// Distinct from the item strip below: this is "who we work with", which a
// customer reads very differently from "here is a thing you could buy".
async function renderFriends() {
  const box = $('#friendsStrip');
  if (!box) return;
  let rows = [];
  try { rows = (await req('GET', '/shop/friends')).friends || []; } catch { return; }
  if (!rows.length) { box.style.display = 'none'; return; }
  box.style.display = '';
  box.innerHTML = `<div class="strip-title">Shops we work with</div>
    <div class="strip-row">${rows.map(friendCardHTML).join('')}</div>`;
}

function friendCardHTML(f) {
  const where = [f.region?.area, f.region?.state].filter(Boolean).join(', ');
  return `<a class="friend-card" href="${esc(f.url)}" target="_blank" rel="noopener nofollow external">
    <div class="friend-name">${esc(f.name)}</div>
    ${f.tagline ? `<div class="friend-tag">${esc(f.tagline)}</div>` : ''}
    <div class="friend-meta">${where ? esc(where) + ' · ' : ''}${f.mutual ? '<span class="friend-mutual">↔ partner</span>' : 'visit ↗'}</div>
  </a>`;
}

// --- community listings from other shops ----------------------------------
// The "do you need this?" strip: stock in categories this shop does NOT carry,
// from nearby Tech Garages. Everything here came off the network, so it is
// escaped on render and every link is marked as leaving the site.
async function renderNearby() {
  const box = $('#nearbyStrip');
  if (!box) return;
  let rows = [];
  try { rows = (await req('GET', '/shop/nearby')).listings || []; } catch { return; }
  if (!rows.length) { box.style.display = 'none'; return; }

  box.style.display = '';
  box.innerHTML = `<div class="strip-title">Not stocked here — available nearby</div>
    <div class="strip-row">${rows.map(nearbyCardHTML).join('')}</div>
    <div class="nearby-note">These are other Tech Garage shops in your area. Links open their store — you'll buy from them, not here.</div>`;
}

function nearbyCardHTML(r) {
  const where = [r.region?.area, r.region?.state].filter(Boolean).join(', ');
  return `<a class="mini-card nearby" href="${esc(r.url)}" target="_blank" rel="noopener nofollow external">
    ${r.image ? `<img src="${esc(r.image)}" alt="" loading="lazy" referrerpolicy="no-referrer" />` : '<div class="mini-ph">📦</div>'}
    <div class="mini-title">${esc(r.title)}</div>
    <div class="mini-price">${money(r.price)}</div>
    <div class="mini-shop">${esc(r.shopName)}${where ? ` · ${esc(where)}` : ''} ↗</div>
  </a>`;
}

function miniCardHTML(it) {
  const img = (it.images || [])[0];
  return `<button type="button" class="mini-card" data-mini="${it.id}">
    ${img ? `<img src="${mediaUrl(img)}" alt="" />` : '<div class="mini-ph">💻</div>'}
    <div class="mini-title">${esc(it.title)}</div>
    <div class="mini-price">${money(it.price)}</div>
  </button>`;
}

// --- order history --------------------------------------------------------
// The biggest hole on the shopper side: they submitted a request, saw a toast
// that faded after two seconds, and then had no record it ever existed. There
// was no GET for their own requests at all.
const STATUS_TONE = { good: 'ok', bad: 'off', info: 'in_stock', muted: 'scrapped' };

async function openOrders() {
  let modal = $('#ordersModal');
  if (!modal) { modal = document.createElement('div'); modal.id = 'ordersModal'; modal.className = 'overlay center'; document.body.appendChild(modal); }
  modal.innerHTML = `<div class="modal-card orders-card">
    <div class="cart-head"><h2>Your requests</h2><button class="close-x" id="ordersClose">&times;</button></div>
    <div class="orders-body"><p class="muted">Loading…</p></div>
  </div>`;
  modal.classList.add('open');
  const close = () => { modal.classList.remove('open'); if (location.hash === '#orders') history.back(); };
  $('#ordersClose').addEventListener('click', close);
  modal.onclick = (e) => { if (e.target === modal) close(); };

  try {
    const rows = await req('GET', '/shop/requests');
    $('.orders-body', modal).innerHTML = rows.length
      ? rows.map(orderHTML).join('')
      : '<p class="muted">You haven\'t requested anything yet. Add something to your cart to get started.</p>';
  } catch (e) {
    $('.orders-body', modal).innerHTML = `<p class="neg">Could not load your requests: ${esc(e.message)}</p>`;
  }
}

function orderHTML(o) {
  const lines = (o.items || []).map((i) =>
    `<div class="ol"><span>${esc(i.title)}${Number(i.qty) > 1 ? ` × ${i.qty}` : ''}</span><span>${money(i.subtotal)}</span></div>`).join('');
  const offer = o.offer
    ? `<div class="order-offer ${esc(o.offer.tone)}"><strong>${esc(o.offer.label)}</strong> — ${money(o.offer.amount)}${o.offer.note ? `<div class="muted">${esc(o.offer.note)}</div>` : ''}</div>`
    : '';
  // The history is what turns "sent" into something a shopper can trust: it
  // shows the shop actually did things, and when.
  const history = (o.history || []).length > 1
    ? `<details class="order-history"><summary>${o.history.length} updates</summary>${
        o.history.map((h) => `<div class="oh"><span>${esc(h.status.replace('offer_', 'offer: '))}</span><span class="muted">${esc(h.at)}</span>${h.note ? `<div class="muted">${esc(h.note)}</div>` : ''}</div>`).join('')
      }</details>` : '';
  return `<div class="order-card">
    <div class="order-head">
      <strong>Request #${o.id}</strong>
      <span class="pill ${STATUS_TONE[o.tone] || 'in_stock'}">${esc(o.label)}</span>
    </div>
    <div class="muted" style="font-size:12px">${esc(o.createdAt)}</div>
    <p style="margin:8px 0">${esc(o.message)}</p>
    ${o.note ? `<div class="order-note">Your note: “${esc(o.note)}”</div>` : ''}
    ${o.tracking ? `<div class="order-track">📦 Tracking: <strong>${esc(o.tracking)}</strong></div>` : ''}
    ${offer}
    <div class="order-lines">${lines}</div>
    <div class="order-total"><span>Total</span><span>${money(o.total)}</span></div>
    ${history}
  </div>`;
}

function deviceInfo() {
  return {
    platform: navigator.platform,
    language: navigator.language,
    screen: `${screen.width}x${screen.height}`,
    viewport: `${innerWidth}x${innerHeight}`,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
}

// Guest mode: the same grid and filters, but every action that would need an
// account routes to the login page instead of failing with a 401.
async function bootGuest(pub) {
  ITEMS = pub.items || [];
  CATEGORIES = pub.categories || [];
  CONDITION_NOTES = pub.conditions || {};
  RECENT = [];

  $('#userMenu').innerHTML = `<a class="btn" href="/login">Sign in / Sign up</a>`;
  $('.shop-intro .muted').innerHTML =
    'Browsing as a guest — <a href="/login">sign in</a> to add items to a cart and request a purchase.';

  renderFilters();
  renderGrid();
  $('#searchBox').addEventListener('input', onSearch);
  $('#sortSelect').addEventListener('change', (e) => { filters.sort = e.target.value; renderGrid(); });
  $('#showSold').addEventListener('change', (e) => { filters.showSold = e.target.checked; renderGrid(); });
  $('#maxPrice').addEventListener('input', (e) => {
    const top = Number(e.target.max);
    filters.maxPrice = Number(e.target.value) >= top ? null : Number(e.target.value);
    $('#maxPriceLabel').textContent = filters.maxPrice == null ? 'Any price' : `Up to ${money(filters.maxPrice)}`;
    renderGrid();
  });
  $('#clearFilters').addEventListener('click', () => {
    filters.q = ''; filters.category = ''; filters.maxPrice = null; filters.sort = 'newest'; filters.showSold = true;
    $('#searchBox').value = ''; $('#showSold').checked = true;
    const cap = $('#maxPrice'); if (cap) cap.value = cap.max;
    renderFilters(); renderGrid();
  });

  // Anything that needs an account sends them to sign in, with a reason.
  document.addEventListener('click', (e) => {
    if (e.target.closest('[data-add], [data-sub], #detailAdd')) {
      toast('Sign in to add items to your cart');
      setTimeout(() => { window.location = '/login'; }, 900);
    }
  }, true);
}

async function init() {
  // Branding for the storefront header/title (legacy default name ignored).
  // This public call also reports whether there is a session, so a guest never
  // triggers a 401 just to discover they are a guest.
  let brand = null;
  try {
    const b = await fetch('/api/branding', { cache: 'no-store' }).then((r) => r.json());
    brand = b;
    const name = b.name && b.name !== 'Inventory Manager' ? b.name : 'Tech Garage';
    const h1 = document.querySelector('.app-header h1');
    if (h1) h1.innerHTML = `<span class="logo">💻</span> ${esc(name)}`;
    document.title = `${name} — Shop`;
  } catch { /* ignore */ }

  // Not signed in? Fall back to the public catalogue when the shop allows it —
  // browsing without an account is the biggest drop-off point, but requesting a
  // purchase still requires signing in.
  if (brand && brand.signedIn === false) {
    if (!brand.publicCatalog) { window.location = '/login'; return; }
    GUEST = true;
    try { return bootGuest(await req('GET', '/shop/public')); }
    catch { window.location = '/login'; return; }
  }

  let me = null;
  try { me = await req('GET', '/shop/me', undefined, { redirectOn401: false }); }
  catch { window.location = '/login'; return; }
  const site = me.site || {};
  // Ensure the link has a scheme so it isn't treated as a relative path.
  const siteHref = site.url ? (/^https?:\/\//i.test(site.url) ? site.url : 'https://' + site.url) : '';
  // The store's own website link sits next to the branding, NOT inside the menu.
  const sl = $('#shopSiteLink');
  if (sl && siteHref) { sl.href = siteHref; sl.textContent = `${site.name || site.url.replace(/^https?:\/\//, '')} ↗`; sl.style.display = ''; }
  ME = me;
  // Everything else non-branding lives under a single menu in the top-right corner.
  $('#userMenu').innerHTML = `<div class="gear-wrap">
      <button class="gear-btn" id="menuBtn" title="Menu" aria-label="Menu">☰<span class="cart-count" id="cartCount" style="display:none">0</span></button>
      <div class="popout" id="menuPopout">
        <div class="popout-head">${esc(me.name || me.username)}</div>
        <button class="popout-item" id="mCart">🛒 Cart <span class="cart-count" style="position:static;display:inline-block">0</span></button>
        <button class="popout-item" id="mOrders">📦 My requests <span class="pill in_stock" id="openReqCount" style="display:none"></span></button>
        <button class="popout-item" id="mStoreSub">🔔 <span id="storeSubLabel">Notify me of new stock</span></button>
        <button class="popout-item" id="mAccount">👤 Account details</button>
        <button class="popout-item" id="mLogout">🚪 Log out</button>
      </div>
    </div>`;
  const pop = $('#menuPopout');
  $('#menuBtn').addEventListener('click', (e) => { e.stopPropagation(); pop.classList.toggle('open'); });
  pop.addEventListener('click', (e) => e.stopPropagation());
  document.addEventListener('click', () => pop.classList.remove('open'));
  try { SUBS = await req('GET', '/shop/subscriptions'); } catch { /* ignore */ }
  $('#mCart').addEventListener('click', () => { pop.classList.remove('open'); openCart(); });
  $('#mOrders').addEventListener('click', () => {
    pop.classList.remove('open');
    if (location.hash !== '#orders') history.pushState({ orders: 1 }, '', '#orders');
    openOrders();
  });
  $('#mStoreSub').addEventListener('click', () => toggleSub(null));
  $('#mAccount').addEventListener('click', () => { pop.classList.remove('open'); openAccountModal(); });
  $('#cartClose').addEventListener('click', closeCart);
  $('#mLogout').addEventListener('click', async () => { try { await req('POST', '/auth/logout'); } catch {} window.location = '/login'; });

  // record the visit with device details
  req('POST', '/shop/track', { kind: 'view', device: deviceInfo() }).catch(() => {});

  // One round trip for everything the storefront needs to draw itself.
  const cat = await req('GET', '/shop/catalog');
  ITEMS = cat.items || [];
  CATEGORIES = cat.categories || [];
  CONDITION_NOTES = cat.conditions || {};
  RECENT = cat.recentlyViewed || [];
  if (cat.openRequests) {
    const badge = $('#openReqCount');
    badge.textContent = cat.openRequests;
    badge.style.display = 'inline-block';
  }

  renderFilters();
  renderGrid();
  renderRecent();
  restoreCart(cat.cart);
  // Loaded after the shop itself has rendered: a community strip must never
  // delay the shop's own stock appearing.
  renderNearby();
  renderFriends();

  $('#searchBox').addEventListener('input', onSearch);
  $('#sortSelect').addEventListener('change', (e) => { filters.sort = e.target.value; renderGrid(); });
  $('#maxPrice').addEventListener('input', (e) => {
    const top = Number(e.target.max);
    filters.maxPrice = Number(e.target.value) >= top ? null : Number(e.target.value);
    $('#maxPriceLabel').textContent = filters.maxPrice == null ? 'Any price' : `Up to ${money(filters.maxPrice)}`;
    renderGrid();
  });
  $('#showSold').addEventListener('change', (e) => { filters.showSold = e.target.checked; renderGrid(); });
  $('#clearFilters').addEventListener('click', () => {
    filters.q = ''; filters.category = ''; filters.maxPrice = null; filters.sort = 'newest'; filters.showSold = true;
    $('#searchBox').value = '';
    const cap = $('#maxPrice'); if (cap) cap.value = cap.max;
    $('#showSold').checked = true;
    renderFilters(); renderGrid();
  });

  // Deep links: /shop#item-12 opens that item, /shop#orders opens the history.
  // Back and Forward now do what a shopper expects instead of leaving the shop.
  const applyHash = () => {
    const m = /^#item-(\d+)$/.exec(location.hash);
    const detail = $('#detailModal');
    const orders = $('#ordersModal');
    if (m) { orders?.classList.remove('open'); openDetail(Number(m[1]), { push: false }); }
    else if (location.hash === '#orders') { detail?.classList.remove('open'); openOrders(); }
    else { detail?.classList.remove('open'); orders?.classList.remove('open'); }
  };
  window.addEventListener('popstate', applyHash);
  applyHash();
}

init();
