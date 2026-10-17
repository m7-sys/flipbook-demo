/* ============================================================================
   FlipBook · prefs client  (app/www/lib/prefs-client.js)
   ----------------------------------------------------------------------------
   Pull/push per-user preferences. Pushes are debounced so rapid edits (dragging
   a color, retyping a session) collapse into one request.
   ========================================================================== */

import { authHeader } from './auth-client.js';

let apiBase = '';
export function configurePrefs({ apiBase: b } = {}) { if (b != null) apiBase = b; }

export async function pullPrefs() {
  try {
    const r = await fetch(`${apiBase}/api/prefs`, { headers: authHeader() });
    if (!r.ok) return null;
    return (await r.json()).prefs || {};
  } catch { return null; }
}

let timer = null, pending = {};
export function pushPrefs(patch) {
  pending = { ...pending, ...patch };
  clearTimeout(timer);
  timer = setTimeout(async () => {
    const body = pending; pending = {};
    try {
      await fetch(`${apiBase}/api/prefs`, {
        method: 'PUT', headers: { 'content-type': 'application/json', ...authHeader() },
        body: JSON.stringify(body),
      });
    } catch { /* stays local; re-syncs on next change */ }
  }, 600);
}
