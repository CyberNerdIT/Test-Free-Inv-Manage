const _esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const _money = (n) => '$' + Number(n || 0).toLocaleString();
function dealHTML(d) {
  const media = d.image
    ? `<img class="deal-img" src="${_esc(d.image)}" alt="${_esc(d.title)}" />`
    : `<div class="deal-ico">${_esc(d.icon || '💻')}</div>`;
  const hasPrices = d.was != null && d.now != null;
  const save = hasPrices && d.was > d.now
    ? `<div class="deal-save">Save ${_money(d.was - d.now)} · ${Math.round((1 - d.now / d.was) * 100)}% off</div>` : '';
  const prices = hasPrices
    ? `<div class="deal-prices"><span class="was">${_money(d.was)} new</span><span class="now">${_money(d.now)}</span></div>`
    : (d.now != null ? `<div class="deal-prices"><span class="now">${_money(d.now)}</span></div>` : '');
  const live = d.live ? '<div class="deal-live">● In stock now</div>' : '';
  return `<div class="deal">${media}<h3>${_esc(d.title)}</h3>
    ${d.spec ? `<div class="deal-spec">${_esc(d.spec)}</div>` : ''}${prices}${save}${live}</div>`;
}

// Applies the configured site name/tagline to the pre-login pages.
// no-store so a renamed site shows immediately (never a cached old name).
// The retired default name is ignored, so the page always shows "Tech Garage"
// (or a real custom name) — never the legacy label.
const LEGACY_NAME = 'Inventory Manager';
fetch('/api/branding', { cache: 'no-store' })
  .then((r) => r.json())
  .then((b) => {
    const name = b.name && b.name !== LEGACY_NAME ? b.name : null;
    if (name) {
      document.querySelectorAll('[data-brand-name]').forEach((el) => (el.textContent = name));
      document.title = document.title.replace(/Tech Garage/g, name);
    }
    if (b.tagline) document.querySelectorAll('[data-brand-tagline]').forEach((el) => (el.textContent = b.tagline));
    // Render editable sample deals on the landing page.
    const grid = document.getElementById('dealsGrid');
    if (grid && Array.isArray(b.deals)) {
      grid.innerHTML = b.deals.map(dealHTML).join('');
      // If any card is a live inventory item, the "illustration only" note no
      // longer applies — these are real, buyable listings.
      const note = document.querySelector('.deals-note');
      if (note && b.deals.some((d) => d.live)) {
        note.innerHTML = 'Real stock, available right now. <a href="/login">Sign in</a> to see full details and buy.';
      }
    }
    // Owner's website link (shown before Sign in / Sign up on the landing page).
    const site = b.site || {};
    if (site.url) {
      const href = /^https?:\/\//i.test(site.url) ? site.url : 'https://' + site.url;
      const label = site.name || site.url.replace(/^https?:\/\//, '');
      document.querySelectorAll('[data-site-link]').forEach((el) => {
        el.href = href;
        el.textContent = `${label} ↗`;
        el.style.display = '';
      });
    }
  })
  .catch(() => {});
