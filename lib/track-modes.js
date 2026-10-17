/* ============================================================================
   FlipBook · track modes  (app/www/lib/track-modes.js)
   ----------------------------------------------------------------------------
   What separates one Flipbook panel from the next:
     gap      a fixed step in time, 1H … 1W
     session  one occurrence of a trading session — Asia, London or NY on
              weekdays, or the whole weekend as a session of its own

   Session hours are defined in UTC+8. London and NY move an hour earlier while
   their market is on summer time; Asia and Weekend never move. Each mode also
   limits the candle sizes it allows, so long gaps don't cram thousands of
   small candles onto one screen.
   ========================================================================== */

import { isMarketDST } from './sessions-store.js';
import { INTERVAL_MS } from './data-adapter.js';

const MIN = 60_000, H = 60 * MIN, D = 24 * H, W = 7 * D, UTC8 = 8 * H;
const WEEKDAYS = [1, 2, 3, 4, 5];
const SHORT_TFS = ['3m', '15m', '1h'];

export const TRACKS = [
  { id: '1h', label: '1H', kind: 'gap', stepMs: H, tfs: SHORT_TFS },
  { id: '2h', label: '2H', kind: 'gap', stepMs: 2 * H, tfs: SHORT_TFS },
  { id: '4h', label: '4H', kind: 'gap', stepMs: 4 * H, tfs: SHORT_TFS },
  { id: '8h', label: '8H', kind: 'gap', stepMs: 8 * H, tfs: ['15m', '1h'] },
  { id: '12h', label: '12H', kind: 'gap', stepMs: 12 * H, tfs: ['15m', '1h'] },
  { id: '1d', label: '1D', kind: 'gap', stepMs: D, tfs: ['15m', '1h'] },
  { id: '1w', label: '1W', kind: 'gap', stepMs: W, tfs: ['1h'] },
  // start/end: minutes after midnight (UTC+8) on the session's first day; end may run past midnight
  { id: 'asia', label: 'Asia', kind: 'session', days: WEEKDAYS, start: 7 * 60, end: 18 * 60, dst: null, tfs: SHORT_TFS },
  { id: 'london', label: 'London', kind: 'session', days: WEEKDAYS, start: 15 * 60, end: 24 * 60, dst: 'london', tfs: SHORT_TFS },
  { id: 'ny', label: 'NY', kind: 'session', days: WEEKDAYS, start: 20 * 60 + 30, end: 29 * 60, dst: 'us', tfs: SHORT_TFS },
  { id: 'weekend', label: 'Weekend', kind: 'session', days: [6], start: 5 * 60, end: 54 * 60, dst: null, tfs: ['15m', '1h'] },
];

/** Tracking tab only: 1-minute steps, to try tracking without waiting hours. */
export const DEMO_TRACK = { id: 'demo', label: 'Demo · 1-min steps', kind: 'gap', stepMs: MIN, tfs: ['3m'] };

export const DEFAULT_TRACK = '2h';
export const trackById = id => TRACKS.find(t => t.id === id) || (id === DEMO_TRACK.id ? DEMO_TRACK : null);

/** Candles per panel for gap tracks (session panels hold the whole session). */
export const PANEL_CANDLES = 240;

/** Candles between consecutive gap panels. */
export const stepCandles = (track, tf) => Math.max(1, Math.round(track.stepMs / INTERVAL_MS[tf]));

/** 7_200_000 → '2H', 86_400_000 → '1D', 604_800_000 → '1W', 60_000 → '1M'. */
export function fmtGap(ms) {
  if (ms % W === 0) return `${ms / W}W`;
  if (ms % D === 0) return `${ms / D}D`;
  if (ms % H === 0) return `${ms / H}H`;
  return `${Math.round(ms / MIN)}M`;
}

/* ---- sessions ------------------------------------------------------------ */

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const inUtc8 = t => new Date(t + UTC8);   // read with getUTC* for UTC+8 wall time

/** Midnight UTC+8 of the day containing `t`. */
function dayStart(t) {
  const d = inUtc8(t);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - UTC8;
}

/** The session starting on UTC+8 day `day0`, or null if it doesn't run that day. End is exclusive. */
function occurrence(track, day0) {
  if (!track.days.includes(inUtc8(day0).getUTCDay())) return null;
  let start = day0 + track.start * MIN, end = day0 + track.end * MIN;
  if (track.dst && isMarketDST(track.dst, new Date(start))) { start -= H; end -= H; }
  return { start, end };
}

/** The `count` most recent sessions that have started by `now`, oldest first (the last may still be running). */
export function recentSessions(track, count, now = Date.now()) {
  const out = [];
  for (let day = dayStart(now), guard = 0; out.length < count && guard < 400; day -= D, guard++) {
    const s = occurrence(track, day);
    if (s && s.start <= now) out.unshift(s);
  }
  return out;
}

/** The `count` sessions starting after `after`, oldest first. */
export function nextSessions(track, count, after) {
  const out = [];
  for (let day = dayStart(after), guard = 0; out.length < count && guard < 400; day += D, guard++) {
    const s = occurrence(track, day);
    if (s && s.start > after) out.push(s);
  }
  return out;
}

/** 'Mon 12 Oct' (UTC+8 date the session starts); weekends read '10–12 Oct'. */
export function sessionDate(track, s) {
  const a = inUtc8(s.start);
  if (track.id !== 'weekend') return `${DOW[a.getUTCDay()]} ${a.getUTCDate()} ${MON[a.getUTCMonth()]}`;
  const b = inUtc8(s.end - 1);
  return a.getUTCMonth() === b.getUTCMonth()
    ? `${a.getUTCDate()}–${b.getUTCDate()} ${MON[b.getUTCMonth()]}`
    : `${a.getUTCDate()} ${MON[a.getUTCMonth()]}–${b.getUTCDate()} ${MON[b.getUTCMonth()]}`;
}

/* ---- forward tracking ----------------------------------------------------- */

/**
 * What the server should capture for a new track, snapshot by snapshot:
 * { start, end, due } — candles opening between start and end, fetched once
 * `due` has passed.
 *   gap      T is the latest window now; T+k the same-width window k steps later.
 *   session  T is the latest session that has started, as it stands now;
 *            T+k is each following session in full, fetched once it closes.
 */
export function forwardPlan(track, tf, snaps, now = Date.now()) {
  if (track.kind === 'gap') {
    const width = PANEL_CANDLES * INTERVAL_MS[tf];
    return Array.from({ length: snaps }, (_, k) => {
      const due = now + k * track.stepMs;
      return { start: due - width, end: due, due };
    });
  }
  const [t0] = recentSessions(track, 1, now);
  return [
    { start: t0.start, end: Math.min(t0.end - 1, now), due: now },
    ...nextSessions(track, snaps - 1, t0.start).map(s => ({ start: s.start, end: s.end - 1, due: s.end + MIN })),
  ];
}
