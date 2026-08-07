// Invite-acceptance page: validate the token, let the customer set a password.
const $ = (s) => document.querySelector(s);
const token = decodeURIComponent(location.pathname.replace(/^\/invite\/?/, '').split('/')[0] || '');

function showError(msg) { const e = $('#err'); e.textContent = msg; e.classList.add('show'); }

async function postJSON(path, body) {
  const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(data?.error || 'Request failed');
  return data;
}

(async function init() {
  if (!token) { $('#sub').textContent = 'This invitation link is invalid.'; return; }
  let info;
  try { info = await fetch('/api/invite/' + encodeURIComponent(token)).then((r) => r.json()); }
  catch { $('#sub').textContent = 'Could not check this invitation.'; return; }

  if (!info.valid) {
    $('#sub').textContent = info.used
      ? 'This invitation has already been used. If that was you, just sign in.'
      : info.expired ? 'This invitation has expired. Ask for a new link.' : 'This invitation is not valid.';
    return;
  }
  $('#sub').innerHTML = (info.name ? `Hi <span class="invite-name">${info.name.replace(/[<>&]/g, '')}</span>! ` : '') +
    'Create your account to browse the available stock and request purchases.';
  $('#acceptForm').style.display = 'block';
})();

$('#acceptForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const password = $('#password').value;
  if (password.length < 8) return showError('Password must be at least 8 characters.');
  $('#submitBtn').disabled = true;
  try {
    await postJSON('/api/invite/' + encodeURIComponent(token) + '/accept', {
      username: $('#username').value.trim(),
      password,
    });
    window.location = '/shop';
  } catch (err) {
    showError(err.message);
    $('#submitBtn').disabled = false;
  }
});
