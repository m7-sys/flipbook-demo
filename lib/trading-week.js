/* ============================================================================
   FlipBook · trading weeks  (app/www/lib/trading-week.js)
   ----------------------------------------------------------------------------
   A trading week runs Monday 06:00 → the next Monday 06:00, UTC+8 (when the
   weekend session ends). Weeks are keyed by their Monday's date, '2026-10-26'.
   Labels are always in UTC+8, whatever the device's time zone.
   ========================================================================== */

export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;
export const WEEK = 7 * DAY;
const UTC8 = 8 * HOUR;
const ANCHOR = Date.UTC(2026, 0, 4, 22);   // Mon 5 Jan 2026 06:00 UTC+8

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad2 = n => String(n).padStart(2, '0');

/** Start (ms) of the trading week containing `t`. */
export const weekStartOf = t => ANCHOR + Math.floor((t - ANCHOR) / WEEK) * WEEK;
/** '2026-10-26' for the week starting at `start`. */
export const weekKey = start => new Date(start + UTC8).toISOString().slice(0, 10);
/** Start (ms) of the week with this key. */
export const weekFromKey = key => Date.parse(`${key}T06:00:00+08:00`);

/** UTC+8 calendar parts of `t`. */
export function parts8(t) {
  const d = new Date(t + UTC8);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth(), d: d.getUTCDate(), dow: d.getUTCDay(), h: d.getUTCHours(), min: d.getUTCMinutes() };
}

/** 'Mon 26 06:00' (time optional). */
export function fmtDayTime(t, { time = true } = {}) {
  const p = parts8(t);
  return `${DOW[p.dow]} ${p.d}${time ? ` ${pad2(p.h)}:${pad2(p.min)}` : ''}`;
}

/** '19 Oct – 26 Oct' for the week starting at `start`. */
export function weekLabel(start) {
  const a = parts8(start), b = parts8(start + WEEK);
  return `${a.d} ${MON[a.m]} – ${b.d} ${MON[b.m]}`;
}

/** Midnight (UTC+8) of a calendar date, for the calendar grid. */
export const dateAt8 = (y, m, d) => Date.UTC(y, m, d) - UTC8;
export const MONTHS = MON;
