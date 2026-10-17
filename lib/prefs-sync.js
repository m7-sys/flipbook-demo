/* ============================================================================
   FlipBook · prefs sync  (app/www/lib/prefs-sync.js)
   ----------------------------------------------------------------------------
   Bridges the local candle-color and session stores to the account. On login:
   if the server has saved prefs, apply them (server wins); otherwise seed the
   server from whatever is local. Thereafter, any change pushes up (debounced).
   localStorage stays as the offline cache, so the app works signed-out too.

     await initPrefsSync(apiBase);   // call after requireAuth, before mounting
   ========================================================================== */

import { getCandleColors, setCandleColors, onCandleColorsChange } from './chart-theme.js';
import { getSessions, setSessions, getHomeTz, setHomeTz, onSessionsChange } from './sessions-store.js';
import { configurePrefs, pullPrefs, pushPrefs } from './prefs-client.js';

let started = false;

export async function initPrefsSync(apiBase) {
  if (started || apiBase === null) return; started = true;   // demo mode: preferences stay on this device
  configurePrefs({ apiBase });

  const p = await pullPrefs();
  let hydrating = true;
  if (p && (p.candleColors || p.sessions || p.homeTz)) {
    if (p.candleColors) setCandleColors(p.candleColors);
    if (p.homeTz) setHomeTz(p.homeTz);
    if (p.sessions) setSessions(p.sessions);
  } else {
    // server empty → seed it from local state
    pushPrefs({ candleColors: getCandleColors(), sessions: getSessions(), homeTz: getHomeTz() });
  }
  hydrating = false;

  onCandleColorsChange(() => { if (!hydrating) pushPrefs({ candleColors: getCandleColors() }); });
  onSessionsChange(() => { if (!hydrating) pushPrefs({ sessions: getSessions(), homeTz: getHomeTz() }); });
}
