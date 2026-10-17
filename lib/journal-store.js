/* ============================================================================
   FlipBook · journal store  (offline-first, server-synced)
   ----------------------------------------------------------------------------
   The entry schema + persistence for prediction journaling. Offline-first:
   a localStorage cache is the source of instant reads/writes; entries sync to
   the server (/api/journal) in the background and merge by `updatedAt`
   (last-write-wins), so journaling on one device shows up on another.

     configure({ apiBase })   → point at the backend (enables sync)
     syncFromServer(symbol?)  → pull latest, merge, return entries
     listEntries / getEntry   → synchronous reads from cache
     saveEntry / deleteEntry  → write cache now, push to server in background

   With no apiBase (or the server down) everything still works locally and
   syncs the next time the server is reachable.
   ========================================================================== */

export const SETUPS = [
  'Failed breakout', 'Range fade', 'Trend pullback',
  'Liquidity sweep', 'Breakout retest', 'HTF reversal',
];

export const SESSIONS = ['Asia', 'London', 'New York', 'Off-hours'];

/** Snapshot cadence is +2h per step, so a coming-N-hours window maps to T+offset. */
/** Gap between consecutive Flipbook snapshots when previewing (T → T+1 …). */
export const SNAP_STEP_MS = 2 * 3_600_000;

/** Which snapshot (T+1 … T+5) a prediction window of `hours` is graded against. */
export const offsetForWindow = (hours, stepMs = SNAP_STEP_MS) =>
  Math.min(5, Math.max(1, Math.ceil((hours * 3_600_000) / stepMs)));

/** Current trading session from the local hour. */
export function currentSession(d = new Date()) {
  const h = d.getHours();
  if (h >= 0 && h < 7) return 'Asia';
  if (h >= 7 && h < 13) return 'London';
  if (h >= 13 && h < 21) return 'New York';
  return 'Off-hours';
}

const KEY = 'flipbook.journal.v1';
let apiBase = '';
let cache = readLocal();

let authHeaderFn = () => ({});
import('./auth-client.js').then(m => { authHeaderFn = m.authHeader; }).catch(() => {});

const uuid = () =>
  (globalThis.crypto?.randomUUID?.()) ||
  'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });

function readLocal() {
  try { return JSON.parse(localStorage.getItem(KEY)) || []; }
  catch { return []; }
}
function writeLocal() {
  try { localStorage.setItem(KEY, JSON.stringify(cache)); }
  catch (e) { console.warn('[journal] persist failed:', e.message); }
}

/** Point the store at the backend; pass '' to stay local-only. */
export function configure({ apiBase: base } = {}) {
  if (base != null) apiBase = base;
}

/* ---- synchronous reads (from cache) ------------------------------------- */

export function listEntries(symbol) {
  const all = [...cache].sort((a, b) => b.createdAt - a.createdAt);
  return symbol ? all.filter(e => e.symbol === symbol) : all;
}

export function getEntry(id) {
  return cache.find(e => e.id === id) || null;
}

/* ---- writes (cache now, server in background) --------------------------- */

export function saveEntry(entry) {
  const now = Date.now();
  const i = cache.findIndex(e => e.id === entry.id);
  let rec;
  if (i >= 0) {
    rec = cache[i] = { ...cache[i], ...entry, updatedAt: now };
  } else {
    rec = { outcome: null, ...entry, id: entry.id || uuid(), createdAt: now, updatedAt: now };
    cache.push(rec);
  }
  writeLocal();
  pushRemote(rec);
  return rec;
}

export function deleteEntry(id) {
  cache = cache.filter(e => e.id !== id);
  writeLocal();
  if (apiBase) fetch(`${apiBase}/api/journal/${id}`, { method: 'DELETE', headers: authHeaderFn() }).catch(() => {});
}

async function pushRemote(rec) {
  if (!apiBase) return;
  try {
    await fetch(`${apiBase}/api/journal`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...authHeaderFn() }, body: JSON.stringify(rec),
    });
  } catch { /* stays local; next sync reconciles */ }
}

/* ---- sync --------------------------------------------------------------- */

function mergeServer(serverList) {
  const byId = new Map(cache.map(e => [e.id, e]));
  for (const s of serverList) {
    const local = byId.get(s.id);
    if (!local || (s.updatedAt || 0) >= (local.updatedAt || 0)) byId.set(s.id, { ...local, ...s });
  }
  cache = [...byId.values()];
}

/** Pull latest from the server, merge into the cache, return entries. */
export async function syncFromServer(symbol) {
  if (!apiBase) return listEntries(symbol);
  try {
    const url = `${apiBase}/api/journal${symbol ? `?symbol=${encodeURIComponent(symbol)}` : ''}`;
    const res = await fetch(url, { headers: authHeaderFn() });
    if (!res.ok) throw new Error(res.status);
    const { entries = [] } = await res.json();
    mergeServer(entries);
    writeLocal();
  } catch { /* offline — cache stands */ }
  return listEntries(symbol);
}
