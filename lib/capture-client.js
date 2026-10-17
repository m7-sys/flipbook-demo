/* ============================================================================
   FlipBook · capture client  (app/www/lib/capture-client.js)
   ----------------------------------------------------------------------------
   Forward tracks (T → T+5). With a server, a thin bridge to its capture engine;
   requests carry the auth header so tracks are scoped to the signed-in user.

   In demo mode (apiBase === null) tracks live in this browser instead. Each
   snapshot is a planned time range, so once it falls due it can be fetched
   from history at any later visit — nothing has to run in the background.
   ========================================================================== */

import { authHeader } from './auth-client.js';
import { fetchKlines } from './data-adapter.js';

const jsonHeaders = () => ({ 'content-type': 'application/json', ...authHeader() });

export async function createCapture({ apiBase, symbol, interval = '3m', source = 'okx', track, plan, cadenceMs = 7_200_000, snaps = 6 }) {
  if (apiBase === null) return local.create({ symbol, interval, source, track, plan });
  const res = await fetch(`${apiBase}/api/capture`, {
    method: 'POST', headers: jsonHeaders(),
    body: JSON.stringify({ symbol, interval, source, track, plan, cadenceMs, snaps }),
  });
  if (!res.ok) throw new Error(`capture create ${res.status}`);
  return res.json();
}

export async function getCapture({ apiBase, id }) {
  if (apiBase === null) return local.get(id);
  const res = await fetch(`${apiBase}/api/capture/${id}`, { headers: authHeader() });
  if (!res.ok) throw new Error(`capture get ${res.status}`);
  return res.json();
}

export async function listCaptures({ apiBase, symbol }) {
  if (apiBase === null) return local.list(symbol);
  const q = symbol ? `?symbol=${encodeURIComponent(symbol)}` : '';
  const res = await fetch(`${apiBase}/api/capture${q}`, { headers: authHeader() });
  if (!res.ok) throw new Error(`capture list ${res.status}`);
  return (await res.json()).captures;
}

export async function deleteCapture({ apiBase, id }) {
  if (apiBase === null) return local.remove(id);
  const res = await fetch(`${apiBase}/api/capture/${id}`, { method: 'DELETE', headers: authHeader() });
  if (!res.ok) throw new Error(`capture delete ${res.status}`);
  return res.json();
}

/* ---- demo mode: tracks saved in this browser ---- */

const KEY = 'flipbook.localTracks.v1';

const local = {
  read() { try { return JSON.parse(localStorage.getItem(KEY)) || []; } catch { return []; } },
  write(all) {
    try { localStorage.setItem(KEY, JSON.stringify(all)); }
    catch { throw new Error('this browser is out of storage — delete an old track first'); }
  },
  summary: c => ({ ...c, captured: c.snapshots.filter(s => s.capturedAt).length, snapshots: c.snapshots.map(({ candles, ...s }) => s) }),

  /** Fetch every snapshot that is due and still empty; returns whether anything changed. */
  async fill(cap) {
    let changed = false;
    for (const s of cap.snapshots) {
      if (s.capturedAt || s.due > Date.now()) continue;
      try {
        s.candles = await fetchKlines({ apiBase: null, symbol: cap.symbol, interval: cap.interval, source: cap.source, start: s.start, end: s.end });
        s.capturedAt = Date.now();
        changed = true;
      } catch { /* try again on the next visit or poll */ }
    }
    return changed;
  },

  async create({ symbol, interval, source, track, plan }) {
    if (!Array.isArray(plan) || plan.length < 2) throw new Error('plan needs at least 2 snapshots');
    const cap = {
      id: `local-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      symbol, interval, source, track, snaps: plan.length, createdAt: Date.now(),
      snapshots: plan.map((p, i) => ({ offset: i, start: p.start, end: p.end, due: p.due, capturedAt: null, candles: null })),
    };
    await local.fill(cap);
    local.write([...local.read(), cap]);
    return cap;
  },

  async get(id) {
    const all = local.read();
    const cap = all.find(c => c.id === id);
    if (!cap) throw new Error('capture get 404');
    if (await local.fill(cap)) local.write(all);
    return cap;
  },

  list(symbol) {
    return local.read()
      .filter(c => !symbol || c.symbol === symbol)
      .sort((a, b) => b.createdAt - a.createdAt)
      .map(local.summary);
  },

  remove(id) {
    const all = local.read(), next = all.filter(c => c.id !== id);
    local.write(next);
    return { id, deleted: next.length !== all.length };
  },
};
