/* ============================================================================
   FlipBook · auth gate  (app/www/lib/auth-ui.js)
   ----------------------------------------------------------------------------
     requireAuth(apiBase) → Promise<user>  — resolves once signed in (shows a
                                              login/signup modal if needed).
     mountUserChip(navEl, apiBase)         — "email · Logout" in a page nav.

   Offline-tolerant: if the server is unreachable but a token exists, it lets
   the user through on the cached identity so the app still opens.
   ========================================================================== */

import { SAMPLE_ONLY } from './config.js';
import { configureAuth, login, signup, me, logout, currentUser, token } from './auth-client.js';

const CSS = `
.fb-auth-scrim{position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;background:rgba(7,9,11,.86);backdrop-filter:blur(3px);font-family:var(--sans,system-ui)}
.fb-auth-card{width:min(92%,380px);background:var(--panel,#0f1318);border:1px solid var(--panel-edge,#1a2027);border-radius:16px;padding:24px;box-shadow:0 24px 60px rgba(0,0,0,.5)}
.fb-auth-card .brand{font-family:var(--mono,monospace);font-size:18px;font-weight:700;color:var(--ink,#e8edf2);margin-bottom:3px}
.fb-auth-card .brand b{color:var(--amber,#e8b84b)}
.fb-auth-card .tag{font-size:12px;color:var(--ink-faint,#566270);margin-bottom:18px}
.fb-auth-tabs{display:flex;gap:6px;margin-bottom:16px}
.fb-auth-tabs button{flex:1;font-family:var(--mono,monospace);font-size:12px;font-weight:700;color:var(--ink-faint,#566270);background:var(--panel-2,#11161c);border:1px solid var(--line,#262e37);border-radius:8px;padding:8px;cursor:pointer}
.fb-auth-tabs button.on{color:var(--amber,#e8b84b);border-color:var(--amber,#e8b84b);background:var(--amber-soft,rgba(232,184,75,.1))}
.fb-auth-field{display:flex;flex-direction:column;gap:5px;margin-bottom:12px}
.fb-auth-field label{font-family:var(--mono,monospace);font-size:9px;letter-spacing:1px;text-transform:uppercase;color:var(--ink-faint,#566270)}
.fb-auth-field input{font-size:14px;color:var(--ink,#e8edf2);background:var(--panel-2,#11161c);border:1px solid var(--line,#262e37);border-radius:8px;padding:10px 12px}
.fb-auth-field input:focus{outline:none;border-color:var(--amber,#e8b84b)}
.fb-auth-submit{width:100%;font-family:var(--mono,monospace);font-size:13px;font-weight:700;color:#0b0d10;background:var(--amber,#e8b84b);border:none;border-radius:9px;padding:11px;cursor:pointer;margin-top:4px}
.fb-auth-submit:disabled{opacity:.6;cursor:default}
.fb-auth-err{color:var(--rose,#e8584b);font-family:var(--mono,monospace);font-size:11px;min-height:15px;margin-top:8px}
.fb-user-chip{display:flex;align-items:center;gap:8px;font-family:var(--mono,monospace);font-size:11px;color:var(--ink-dim,#8a96a3)}
.fb-user-chip button{font-family:var(--mono,monospace);font-size:11px;color:var(--ink-faint,#566270);background:transparent;border:1px solid var(--line,#262e37);border-radius:7px;padding:5px 9px;cursor:pointer}
.fb-user-chip button:hover{color:var(--rose,#e8584b);border-color:var(--rose,#e8584b)}
`;

function injectCss() {
  if (document.getElementById('fb-auth-css')) return;
  const s = document.createElement('style'); s.id = 'fb-auth-css'; s.textContent = CSS;
  document.head.appendChild(s);
}

/** Demo mode (no server): no accounts; everything stays on this device. */
const DEMO_USER = { id: 'demo', email: 'Demo mode', name: 'Guest' };

export async function requireAuth(apiBase) {
  if (apiBase === null) return DEMO_USER;
  configureAuth({ apiBase });
  injectCss();
  if (token()) {
    const u = await me();
    if (u) return u;
    if (currentUser()) return currentUser();   // offline: trust cached identity
    logout();
  }
  return showModal();
}

function showModal() {
  return new Promise(resolve => {
    const scrim = document.createElement('div');
    scrim.className = 'fb-auth-scrim';
    scrim.innerHTML = `
      <div class="fb-auth-card">
        <div class="brand">Flip<b>Book</b></div>
        <div class="tag">Sign in to sync your journal across devices.</div>
        <div class="fb-auth-tabs">
          <button data-tab="login" class="on">Log in</button>
          <button data-tab="signup">Sign up</button>
        </div>
        <div class="fb-auth-field" data-name-field style="display:none">
          <label>Name</label><input data-name type="text" autocomplete="name" placeholder="optional">
        </div>
        <div class="fb-auth-field"><label>Email</label>
          <input data-email type="email" autocomplete="email" placeholder="you@example.com"></div>
        <div class="fb-auth-field"><label>Password</label>
          <input data-password type="password" autocomplete="current-password" placeholder="••••••••"></div>
        <button class="fb-auth-submit" data-submit>Log in</button>
        <div class="fb-auth-err" data-err></div>
      </div>`;
    document.body.appendChild(scrim);

    let mode = 'login';
    const $ = s => scrim.querySelector(s);
    const err = $('[data-err]'), submit = $('[data-submit]');

    scrim.querySelectorAll('.fb-auth-tabs button').forEach(b => b.onclick = () => {
      mode = b.dataset.tab;
      scrim.querySelectorAll('.fb-auth-tabs button').forEach(x => x.classList.toggle('on', x === b));
      $('[data-name-field]').style.display = mode === 'signup' ? '' : 'none';
      submit.textContent = mode === 'signup' ? 'Create account' : 'Log in';
      err.textContent = '';
    });

    async function go() {
      err.textContent = '';
      const email = $('[data-email]').value.trim();
      const password = $('[data-password]').value;
      const name = $('[data-name]').value.trim();
      submit.disabled = true; submit.textContent = 'Please wait…';
      try {
        const r = mode === 'signup'
          ? await signup({ email, password, name })
          : await login({ email, password });
        scrim.remove();
        resolve(r.user);
      } catch (e) {
        err.textContent = e.message || 'Something went wrong';
        submit.disabled = false; submit.textContent = mode === 'signup' ? 'Create account' : 'Log in';
      }
    }
    submit.onclick = go;
    scrim.addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
    $('[data-email]').focus();
  });
}

/** Render "email · Logout" into a nav element. */
export function mountUserChip(navEl, apiBase) {
  if (apiBase === null) {
    if (!navEl) return;
    injectCss();
    const chip = document.createElement('span');
    chip.className = 'fb-user-chip';
    chip.title = SAMPLE_ONLY
      ? 'Showcase: no sign-in, generated sample prices. Your journal and tracks are saved in this browser.'
      : 'No sign-in. Market data comes straight from the exchange; your journal and tracks are saved in this browser.';
    chip.innerHTML = `<span>${SAMPLE_ONLY ? 'DEMO · sample data' : 'DEMO · saved on this device'}</span>`;
    navEl.appendChild(chip);
    return;
  }
  configureAuth({ apiBase });
  const u = currentUser(); if (!navEl || !u) return;
  injectCss();
  const chip = document.createElement('span');
  chip.className = 'fb-user-chip';
  chip.innerHTML = `<span>${u.email}</span><button data-logout>Logout</button>`;
  chip.querySelector('[data-logout]').onclick = () => { logout(); location.reload(); };
  navEl.appendChild(chip);
}
