// Dedicated, paginated storefront activity log with old-entry trimming.
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const api = {
  async req(method, path) {
    const res = await fetch('/api' + path, { method });
    if (res.status === 401) { window.location = '/login'; throw new Error('unauthorized'); }
    if (res.status === 403) { window.location = '/app'; throw new Error('forbidden'); }
    const t = await res.text();
    const d = t ? JSON.parse(t) : null;
    if (!res.ok) throw new Error(d?.error || res.statusText);
    return d;
  },
};
function toast(m) { const t = $('#toast'); t.textContent = m; t.classList.add('show'); clearTimeout(t._t); t._t = setTimeout(() => t.classList.remove('show'), 2200); }

function parseUA(ua) {
  ua = ua || '';
  let br = 'Unknown', os = 'Unknown';
  if (/Edg\//.test(ua)) br = 'Edge'; else if (/Chrome\//.test(ua)) br = 'Chrome';
  else if (/Firefox\//.test(ua)) br = 'Firefox'; else if (/Safari\//.test(ua)) br = 'Safari';
  if (/Windows/.test(ua)) os = 'Windows'; else if (/Android/.test(ua)) os = 'Android';
  else if (/iPhone|iPad|iOS/.test(ua)) os = 'iOS'; else if (/Mac OS X/.test(ua)) os = 'macOS';
  else if (/Linux/.test(ua)) os = 'Linux';
  return `${br} · ${os}`;
}

const LIMIT = 25;
let page = 1;
let total = 0;

async function load() {
  const d = await api.req('GET', `/admin/visits?page=${page}&limit=${LIMIT}`);
  total = d.total;
  $('#stats').innerHTML = `<span class="pill off">${d.stats.total} events · ${d.stats.uniqueVisitors} visitors · ${d.stats.searches} searches</span>`;
  const pages = Math.max(1, Math.ceil(total / LIMIT));
  $('#pageNum').textContent = `Page ${page} of ${pages}`;
  $('#pageInfo').textContent = `${total} total events`;
  $('#prevBtn').disabled = page <= 1;
  $('#nextBtn').disabled = page >= pages;

  $('#log').innerHTML = d.visits.length
    ? d.visits.map((v) => {
        const dev = v.device || {};
        const label = v.kind === 'search' ? 'Searched: “' + esc(v.query || '') + '”'
          : v.kind === 'item' ? '👁️ Looked at: “' + esc(v.item_title || 'an item') + '”'
          : v.kind === 'request' ? 'Made a purchase request' + (v.item_title ? ': “' + esc(v.item_title) + '”' : '')
          : 'Opened the shop';
        return `<div class="user-row" style="align-items:flex-start">
          <div style="flex:1">
            <strong>${label}</strong>
            <div class="muted" style="font-size:12px">
              ${esc(v.username || 'anonymous')} · ${esc(parseUA(v.user_agent))}
              ${dev.screen ? ' · ' + esc(dev.screen) : ''}${dev.timezone ? ' · ' + esc(dev.timezone) : ''} · IP ${esc(v.ip || '—')}
              <br><span style="font-size:11px">${esc(v.created_at)}</span>
            </div>
          </div>
        </div>`;
      }).join('')
    : '<p class="muted" style="margin:8px 0">No activity on this page.</p>';
}

$('#prevBtn').addEventListener('click', () => { if (page > 1) { page--; load(); } });
$('#nextBtn').addEventListener('click', () => { page++; load(); });
$$('[data-clear]').forEach((b) => b.addEventListener('click', async () => {
  const which = b.dataset.clear;
  const msg = which === 'all' ? 'Delete ALL activity log entries?' : `Delete activity older than ${which} days?`;
  if (!confirm(msg)) return;
  const q = which === 'all' ? '' : `?days=${which}`;
  const r = await api.req('DELETE', '/admin/visits' + q);
  toast(`Removed ${r.removed} entr${r.removed === 1 ? 'y' : 'ies'}`);
  page = 1;
  load();
}));

// apply branding to the title
fetch('/api/branding', { cache: 'no-store' }).then((r) => r.json()).then((b) => { const n = b.name && b.name !== 'Inventory Manager' ? b.name : null; if (n) document.title = document.title.replace(/Tech Garage/g, n); }).catch(() => {});

load();
