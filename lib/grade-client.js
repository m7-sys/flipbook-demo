/* ============================================================================
   FlipBook · grade client  (app/www/lib/grade-client.js)
   ----------------------------------------------------------------------------
   Bridges the Flipbook review card to the server grader. POSTs the prediction +
   price context to /api/grade and returns { verdict, R, rationale, by }. If the
   server is unreachable, a lean local heuristic still returns a real verdict so
   the card never dead-ends offline.

     import { gradeEntry, priceContext } from './grade-client.js';
   ========================================================================== */

/** Build the price context the grader needs from the filmstrip series. */
export function priceContext(series, offset, from = 0) {
  const t = series[from] || [];
  const tgt = series[from + offset] || series[series.length - 1] || [];
  const priceStart = t.length ? t[t.length - 1].c : 0;
  const priceEnd = tgt.length ? tgt[tgt.length - 1].c : priceStart;
  // Candles after T's last bar. Panels are sliding windows, so match by time.
  const t0 = t.length ? t[t.length - 1].t : null;
  const future = t0 != null ? tgt.filter(c => c.t > t0) : tgt.slice(t.length);
  const span = future.length ? future : tgt.slice(-1);
  const windowHigh = span.reduce((m, c) => Math.max(m, c.h), priceEnd);
  const windowLow = span.reduce((m, c) => Math.min(m, c.l), priceEnd);
  return { priceStart, priceEnd, windowHigh, windowLow };
}

const BULL = ['up', 'higher', 'long', 'break', 'breakout', 'rally', 'bounce', 'reclaim', 'above', 'continuation'];
const BEAR = ['down', 'lower', 'short', 'fade', 'reject', 'dump', 'drop', 'breakdown', 'below', 'flush'];

function localGrade(p) {
  const t = (p.prediction || '').toLowerCase();
  const b = BULL.reduce((n, w) => n + (t.includes(w) ? 1 : 0), 0);
  const s = BEAR.reduce((n, w) => n + (t.includes(w) ? 1 : 0), 0);
  const dir = b > s ? 1 : s > b ? -1 : 0;
  const move = p.priceStart ? (p.priceEnd - p.priceStart) / p.priceStart * 100 : 0;
  const mag = Math.abs(move), aligned = dir !== 0 && Math.sign(move) === dir;

  let verdict, R;
  if (dir === 0) { verdict = mag < 0.5 ? 'hit' : 'partial'; R = mag < 0.5 ? 0.5 : -0.3; }
  else if (aligned) { verdict = mag >= 0.8 ? 'hit' : 'partial'; R = mag / 0.5; }
  else { verdict = mag >= 0.5 ? 'miss' : 'partial'; R = -mag / 0.5; }

  return {
    verdict, R: Math.max(-3, Math.min(3, +R.toFixed(2))),
    rationale: `Price ${move >= 0 ? 'rose' : 'fell'} ${mag.toFixed(2)}% over ${p.window || `${p.windowHours}h`} — graded ${verdict}.`,
    by: 'rules-local',
  };
}

/** Grade an entry. `ctx` from priceContext(); returns the grader verdict. */
/** '3h', or '2 Asia sessions' for session tracks. */
const windowLabel = e => (e.windowSessions
  ? `${e.windowSessions} ${e.trackLabel || ''} session${e.windowSessions > 1 ? 's' : ''}`.replace('  ', ' ')
  : `${e.windowHours}h`);

export async function gradeEntry(entry, ctx, { apiBase = 'http://localhost:3001' } = {}) {
  const payload = {
    symbol: entry.symbol, setup: entry.setup, conviction: entry.conviction,
    windowHours: entry.windowHours, targetOffset: entry.targetOffset, window: windowLabel(entry),
    prediction: entry.prediction, ...ctx,
  };
  if (apiBase === null) return localGrade(payload);   // demo mode: no server
  try {
    const res = await fetch(`${apiBase}/api/grade`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(res.status);
    const r = await res.json();
    if (!r.verdict) throw new Error('no verdict');
    return r;
  } catch {
    return localGrade(payload);
  }
}
