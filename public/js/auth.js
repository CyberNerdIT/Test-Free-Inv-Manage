// Login + first-run setup page logic (shared).
const $ = (s) => document.querySelector(s);

async function postJSON(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; }
  catch {
    throw new Error(
      res.ok ? 'Unexpected server response — try refreshing the page (Ctrl+Shift+R).'
             : `Request failed (${res.status}). Try refreshing the page.`
    );
  }
  if (!res.ok) throw new Error(data?.error || 'Request failed');
  return data;
}

function showError(msg) {
  const el = $('#err');
  el.textContent = msg;
  el.classList.add('show');
}

// Redirect if the auth state doesn't match this page.
(async function guard() {
  try {
    const s = await fetch('/api/auth/status').then((r) => r.json());
    const isSetupPage = Boolean($('#setupForm'));
    if (s.needsSetup && !isSetupPage) { window.location = '/setup'; return; }
    if (!s.needsSetup && isSetupPage) { window.location = '/login'; return; }
    if (s.authenticated) { window.location = s.user?.role === 'customer' ? '/shop' : '/app'; return; }
  } catch { /* offline — let the form try */ }
})();

const loginForm = $('#loginForm');
if (loginForm) {
  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('#submitBtn');
    btn.disabled = true;
    try {
      const data = await postJSON('/api/auth/login', {
        username: $('#username').value.trim(),
        password: $('#password').value,
      });
      window.location = data.user?.role === 'customer' ? '/shop' : '/app';
    } catch (err) {
      showError(err.message);
      btn.disabled = false;
    }
  });
}

// ---- sign in / sign up tabs (login page) ----
const tabSignin = $('#tabSignin');
const tabSignup = $('#tabSignup');
if (tabSignin && tabSignup) {
  const panes = { signin: document.querySelector('[data-pane="signin"]'), signup: $('#signupPane') };
  function selectTab(which) {
    tabSignin.classList.toggle('active', which === 'signin');
    tabSignup.classList.toggle('active', which === 'signup');
    panes.signin.style.display = which === 'signin' ? '' : 'none';
    panes.signup.style.display = which === 'signup' ? '' : 'none';
  }
  tabSignin.addEventListener('click', () => selectTab('signin'));
  tabSignup.addEventListener('click', () => selectTab('signup'));
  // Deep link: /login#signup opens the sign-up tab.
  if (location.hash === '#signup') selectTab('signup');
}

const signupForm = $('#signupForm');
if (signupForm) {
  signupForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('#suErr');
    err.classList.remove('show');
    const email = $('#su-email').value.trim();
    const name = $('#su-name').value.trim();
    if (!email) { err.textContent = 'Please enter your email.'; err.classList.add('show'); return; }
    const btn = $('#suBtn');
    btn.disabled = true;
    const device = { platform: navigator.platform, language: navigator.language, screen: screen.width + 'x' + screen.height, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone };
    try {
      const r = await postJSON('/api/waitlist', { name, email, device });
      $('#signupPane').innerHTML = `<div class="ok-msg">✓ ${r.message || "You're on the list — we'll email you when a slot opens."}</div><div class="hint"><a href="/">Home</a></div>`;
    } catch (e2) {
      err.textContent = e2.message || 'Something went wrong.'; err.classList.add('show');
      btn.disabled = false;
    }
  });
}

const setupForm = $('#setupForm');
if (setupForm) {
  setupForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('#submitBtn');
    const password = $('#password').value;
    if (password.length < 8) return showError('Password must be at least 8 characters.');
    if (password !== $('#confirm').value) return showError('Passwords do not match.');
    btn.disabled = true;
    try {
      await postJSON('/api/auth/setup', { username: $('#username').value.trim(), password });
      window.location = '/app';
    } catch (err) {
      showError(err.message);
      btn.disabled = false;
    }
  });
}
