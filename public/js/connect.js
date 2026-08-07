// Public "connect with this shop" page.
//
// The shareable half of a friend invite: a shop owner sends this link, and the
// other owner pastes THE LINK into their own admin — their server then asks
// this shop for its own invite code. It used to display that code for a human
// to copy between browsers, which was an opaque blob doing a job a URL already
// does, and one more thing to get wrong in the paste.
//
// Nothing here is private — a node id and a URL are both visible to anyone who
// looks at the shop — so the page needs no login, which is the point. A link
// you have to be signed in to read is a link nobody follows.
const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

async function init() {
  const card = $('#connectCard');
  let info;
  try {
    const res = await fetch('/api/directory/invite', { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error('not listed');
    info = await res.json();
  } catch {
    card.innerHTML = `<h1>Not in the community</h1>
      <p class="muted">This shop hasn't joined the Tech Garage community directory, so there's nothing to connect to yet.</p>
      <a class="btn" href="/shop">Browse the shop instead</a>`;
    return;
  }

  document.title = `Connect with ${info.name} — Tech Garage`;
  // The address of this very page is what the other shop pastes. Read from the
  // browser rather than built from `info.url`, so a shop reachable on more than
  // one hostname hands out the one the visitor actually got here on.
  const pageLink = `${window.location.origin}/connect`;
  card.innerHTML = `
    <h1>Connect with ${esc(info.name)}</h1>
    ${info.tagline ? `<p class="lead">${esc(info.tagline)}</p>` : ''}
    <p class="muted">Run your own Tech Garage? Add this shop and you'll each be able to point customers
      at the other's stock for things you don't carry.</p>

    <label class="field" style="margin-top:18px"><span class="lbl">This shop's link</span>
      <input id="code" readonly value="${esc(pageLink)}" /></label>
    <div style="display:flex;gap:10px;flex-wrap:wrap">
      <button class="btn" id="copy" type="button">Copy link</button>
      <a class="btn secondary" href="/shop">Browse the shop</a>
    </div>

    <ol class="connect-steps">
      <li>Open <strong>Admin → Community directory</strong> on your own shop.</li>
      <li>Paste this link into <strong>Connect with another shop</strong>.</li>
      <li>Send them yours, from the same page, so the connection goes both ways.</li>
    </ol>

    <p class="muted" style="font-size:12px">
      Adding a shop only means your storefront may link to theirs. It shares no
      customer data, no stock levels and no prices you haven't already published.
    </p>`;

  $('#copy').addEventListener('click', async () => {
    const btn = $('#copy');
    try { await navigator.clipboard.writeText(pageLink); btn.textContent = 'Copied ✓'; }
    catch { $('#code').select(); btn.textContent = 'Press Ctrl+C'; }
    setTimeout(() => { btn.textContent = 'Copy link'; }, 2000);
  });
}

init();
