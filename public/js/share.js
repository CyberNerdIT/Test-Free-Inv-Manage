// Public shared-item page (/s/:id): shows a minimal teaser of a for-sale item
// to a logged-out visitor, then reveals a "join the waitlist" form as the call
// to action to unlock pricing and full details. No auth required.
(function () {
  const $ = (s, r = document) => r.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const LEGACY_NAME = 'Inventory Manager';

  function toast(msg) {
    const t = $('#toast'); if (!t) return;
    t.textContent = msg; t.classList.add('show');
    clearTimeout(t._t); t._t = setTimeout(() => t.classList.remove('show'), 2500);
  }

  function applyBrand(name) {
    if (!name || name === LEGACY_NAME) return;
    document.querySelectorAll('[data-brand-name]').forEach((el) => (el.textContent = name));
    document.title = document.title.replace(/Tech Garage/g, name);
  }

  function deviceInfo() {
    return {
      platform: navigator.platform, language: navigator.language,
      screen: screen.width + 'x' + screen.height,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    };
  }

  const match = location.pathname.match(/\/s\/(\d+)/);
  const id = match ? Number(match[1]) : null;
  const wrap = $('#shareWrap');

  function renderMissing() {
    wrap.innerHTML = `<div class="share-missing">
      <div style="font-size:40px">🔍</div>
      <p>This item isn't available right now.</p>
      <p><a href="/login">Browse current stock →</a></p>
    </div>`;
  }

  function render(item) {
    const photo = item.image
      ? `<img class="share-photo" src="${esc(item.image)}" alt="${esc(item.title)}" />`
      : '<div class="share-photo placeholder">💻</div>';
    const meta = [item.category, item.condition, item.brand].filter(Boolean).map(esc).join(' · ');
    wrap.innerHTML = `<div class="share-card">
      ${photo}
      <div class="share-body">
        <h1>${esc(item.title)}</h1>
        <div class="share-meta">${meta}</div>
        <div class="locked" id="locked">
          <div class="lk-title">🔒 Full details are members-only</div>
          <div class="lk-sub">Pricing, full specs and the option to request a purchase unlock when you join the waitlist.</div>
          <button class="btn big" id="revealBtn">🔓 Reveal full details</button>
        </div>
        <div class="share-foot"><a href="/login">Browse all available stock →</a></div>
      </div>
    </div>`;
    $('#revealBtn').addEventListener('click', () => showForm(item));
  }

  function showForm(item) {
    const locked = $('#locked');
    locked.innerHTML = `
      <div class="lk-title" style="margin-bottom:10px">Join the waitlist to unlock this listing</div>
      <div class="share-err" id="suErr"></div>
      <form class="share-form" id="suForm">
        <label class="field"><span class="lbl">Name (optional)</span><input id="su-name" autocomplete="name" /></label>
        <label class="field"><span class="lbl">Email</span><input id="su-email" type="email" autocomplete="email" placeholder="you@example.com" /></label>
        <label class="field"><span class="lbl">Phone (optional)</span><input id="su-phone" autocomplete="tel" placeholder="+1 555 123 4567" /></label>
        <button class="btn" type="submit" id="suBtn" style="width:100%">Join the waitlist</button>
      </form>
      <div class="share-note">We'll reach out the moment a slot opens — then you can see pricing and request to buy.</div>`;
    $('#suForm').addEventListener('submit', (e) => submitForm(e, item));
  }

  async function submitForm(e, item) {
    e.preventDefault();
    const err = $('#suErr'); err.classList.remove('show');
    const email = $('#su-email').value.trim();
    const name = $('#su-name').value.trim();
    const phone = $('#su-phone').value.trim();
    if (!email && !phone) { err.textContent = 'Please add an email or phone so we can reach you.'; err.classList.add('show'); return; }
    const btn = $('#suBtn'); btn.disabled = true;
    try {
      const res = await fetch('/api/waitlist', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, email, phone, message: `Interested in shared listing: ${item.title} (#${item.id})`, device: deviceInfo() }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Something went wrong.');
      $('#locked').innerHTML = `<div class="share-ok">✓ ${esc(data.message || "You're on the waitlist — we'll be in touch!")}</div>`;
      toast('Added to the waitlist');
    } catch (e2) {
      err.textContent = e2.message || 'Something went wrong.'; err.classList.add('show');
      btn.disabled = false;
    }
  }

  // Brand name for the header (best-effort), then load the item.
  fetch('/api/branding', { cache: 'no-store' }).then((r) => r.json()).then((b) => applyBrand(b && b.name)).catch(() => {});

  if (!id) { renderMissing(); return; }
  fetch(`/api/public/item/${id}`)
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error('not found'))))
    .then((data) => { applyBrand(data.brand && data.brand.name); render(data.item); })
    .catch(() => renderMissing());
})();
