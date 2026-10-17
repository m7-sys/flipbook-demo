/* ============================================================================
   FlipBook · stats engine
   ----------------------------------------------------------------------------
   Pure derivation of every dashboard metric from a list of GRADED entries:

     { id, symbol, session, setup, conviction(0..100),
       verdict: 'hit'|'partial'|'miss', R, gradedAt }

   Real graded entries come from the journal store once the AI grading slice
   lands (entries whose `outcome` is set). Until then `sampleGradedEntries()`
   produces deterministic data so the board is alive — the view blends real
   graded entries on top, so the sample recedes as real calls accrue.
   ========================================================================== */

import { SETUPS, SESSIONS } from './journal-store.js';

const SYMBOLS = ['BERA', 'SOL', 'HYPE', 'WIF', 'SUI', 'ARB'];

/** Outcome value of a verdict (hit = full, partial = half, miss = none). */
const outcomeVal = v => (v === 'hit' ? 1 : v === 'partial' ? 0.5 : 0);

const rng = s => () => { s = (s * 1664525 + 1013904223) & 0xffffffff; return (s >>> 0) / 0xffffffff; };
const pick = (r, arr) => arr[Math.floor(r() * arr.length) % arr.length];
const round = (n, d = 1) => +n.toFixed(d);

/** Deterministic graded history, slightly overconfident so calibration is interesting. */
export function sampleGradedEntries(n = 64, seed = 4242) {
  const r = rng(seed >>> 0 || 1);
  const now = Date.now(), DAY = 86_400_000;
  const out = [];
  for (let i = 0; i < n; i++) {
    const conviction = 45 + Math.round(r() * 50);           // 45..95
    // true hit-prob trails conviction by ~16pts → realistic overconfidence
    const p = Math.max(0.05, Math.min(0.95, conviction / 100 - 0.16));
    const roll = r();
    const verdict = roll < p ? 'hit' : roll < p + 0.14 ? 'partial' : 'miss';
    const R = verdict === 'hit' ? round(0.8 + r() * 1.6)
      : verdict === 'partial' ? round(-0.2 + r() * 0.8)
        : round(-1.3 + r() * 0.7);
    out.push({
      id: `s${i}`, symbol: pick(r, SYMBOLS), session: pick(r, SESSIONS),
      setup: pick(r, SETUPS), conviction, verdict, R,
      gradedAt: now - Math.floor(r() * 30) * DAY - Math.floor(r() * DAY),
    });
  }
  return out.sort((a, b) => a.gradedAt - b.gradedAt);
}

/** Map journal-store entries that have an outcome into graded-stat rows. */
export function gradedFromJournal(entries) {
  return entries
    .filter(e => e.outcome && e.outcome.verdict)
    .map(e => ({
      id: e.id, symbol: e.symbol, session: (e.session || '').split(' ·')[0] || 'Off-hours',
      setup: e.setup, conviction: e.conviction ?? 50,
      verdict: e.outcome.verdict, R: e.outcome.R ?? 0, gradedAt: e.outcome.gradedAt || e.updatedAt,
    }));
}

const mean = a => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);

function groupRate(entries, key) {
  const m = new Map();
  for (const e of entries) {
    const k = e[key]; if (!m.has(k)) m.set(k, []);
    m.get(k).push(e);
  }
  return [...m.entries()].map(([label, rows]) => ({
    label, n: rows.length,
    hitRate: round(mean(rows.map(r => outcomeVal(r.verdict))) * 100, 0),
    avgR: round(mean(rows.map(r => r.R)), 2),
  })).sort((a, b) => b.hitRate - a.hitRate);
}

/** Rolling hit-rate over a sliding window → curve points [{v}]. */
function rollingAccuracy(entries, win = 9) {
  const vals = entries.map(e => outcomeVal(e.verdict));
  const pts = [];
  for (let i = 0; i < vals.length; i++) {
    const slice = vals.slice(Math.max(0, i - win + 1), i + 1);
    pts.push({ v: round(mean(slice) * 100, 0) });
  }
  return pts.length >= 2 ? pts : [{ v: 50 }, { v: 50 }];
}

/** Calibration scatter points + binned actual-outcome line. */
function calibration(entries) {
  const pts = entries.map(e => ({ x: e.conviction, y: outcomeVal(e.verdict) * 100, verdict: e.verdict }));
  const edges = [40, 55, 70, 85, 95];
  const bins = [];
  for (let i = 0; i < edges.length - 1; i++) {
    const lo = edges[i], hi = edges[i + 1];
    const rows = entries.filter(e => e.conviction >= lo && e.conviction < hi);
    if (rows.length) bins.push({ x: (lo + hi) / 2, y: round(mean(rows.map(r => outcomeVal(r.verdict))) * 100, 0) });
  }
  return { pts, bins };
}

/** Consecutive days up to today with at least one graded entry. */
function streakDays(entries) {
  const days = new Set(entries.map(e => Math.floor(e.gradedAt / 86_400_000)));
  let streak = 0, d = Math.floor(Date.now() / 86_400_000);
  while (days.has(d)) { streak++; d--; }
  return streak;
}

/** Roll a graded list into the full dashboard metric set. */
export function computeStats(entries) {
  const sorted = [...entries].sort((a, b) => a.gradedAt - b.gradedAt);
  const accuracy = round(mean(sorted.map(e => outcomeVal(e.verdict))) * 100, 0);
  const avgConviction = round(mean(sorted.map(e => e.conviction)), 0);
  const expectancy = round(mean(sorted.map(e => e.R)), 2);
  const { pts, bins } = calibration(sorted);

  return {
    count: sorted.length,
    accuracy,
    avgConviction,
    calibrationGap: round(avgConviction - accuracy, 0),     // +ve = overconfident
    expectancy,
    streak: streakDays(sorted),
    accuracyOverTime: rollingAccuracy(sorted, 9),
    calibration: { pts, bins },
    bySession: groupRate(sorted, 'session'),
    bySetup: groupRate(sorted, 'setup'),
    recent: [...sorted].reverse().slice(0, 12),
  };
}

/** One-line insight derived from calibration gap. */
export function insightFor(stats) {
  const g = stats.calibrationGap;
  if (g >= 6) return { spark: '✦', text: `Your edge is real but over-stated — conviction runs ${g} pts ahead of outcomes.` };
  if (g <= -6) return { spark: '✦', text: `You're under-confident — outcomes beat your conviction by ${-g} pts.` };
  return { spark: '✦', text: `Well calibrated — conviction tracks outcomes within ${Math.abs(g)} pts.` };
}
