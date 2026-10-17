/* ============================================================================
   FlipBook · auth client  (app/www/lib/auth-client.js)
   ----------------------------------------------------------------------------
   Token storage + the auth API calls. `authHeader()` is imported by the
   journal store and capture client so every request is scoped to the user.
   ========================================================================== */

const TKEY = 'flipbook.token';
const UKEY = 'flipbook.user';
let apiBase = '';

export function configureAuth({ apiBase: base } = {}) { if (base != null) apiBase = base; }

export const token = () => localStorage.getItem(TKEY) || '';
export const currentUser = () => { try { return JSON.parse(localStorage.getItem(UKEY)); } catch { return null; } };
export const authHeader = () => { const t = token(); return t ? { Authorization: `Bearer ${t}` } : {}; };

function persist(r) {
  if (r?.token) localStorage.setItem(TKEY, r.token);
  if (r?.user) localStorage.setItem(UKEY, JSON.stringify(r.user));
}

async function post(path, body) {
  const res = await fetch(`${apiBase}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `request failed (${res.status})`);
  return data;
}

export async function signup(body) { const r = await post('/api/auth/signup', body); persist(r); return r; }
export async function login(body) { const r = await post('/api/auth/login', body); persist(r); return r; }

export function logout() { localStorage.removeItem(TKEY); localStorage.removeItem(UKEY); }

/** Validate the stored token against the server → user | null. */
export async function me() {
  if (!token()) return null;
  try {
    const res = await fetch(`${apiBase}/api/auth/me`, { headers: authHeader() });
    if (!res.ok) return null;
    const { user } = await res.json();
    if (user) localStorage.setItem(UKEY, JSON.stringify(user));
    return user;
  } catch { return null; }
}
