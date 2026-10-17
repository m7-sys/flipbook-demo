/* ============================================================================
   FlipBook · candle theme  (app/www/lib/chart-theme.js)
   ----------------------------------------------------------------------------
   The four user-customizable candle colors, persisted per browser. The chart
   engine reads these at draw time; the settings panel writes them. Subscribers
   are notified so charts can refresh on change.
   ========================================================================== */

const KEY = 'flipbook.candleColors.v1';

export const CANDLE_DEFAULTS = {
  baseUp: '#e8b84b',      // base candle · up
  baseDown: '#e7e9ec',    // base candle · down
  overlayUp: '#39d3c3',   // higher-TF overlay · up
  overlayDown: '#f0d882', // higher-TF overlay · down
};

export const CANDLE_LABELS = {
  baseUp: 'Base · up',
  baseDown: 'Base · down',
  overlayUp: 'Overlay · up',
  overlayDown: 'Overlay · down',
};

let colors = load();
const subs = new Set();

function load() {
  try { return { ...CANDLE_DEFAULTS, ...JSON.parse(localStorage.getItem(KEY)) }; }
  catch { return { ...CANDLE_DEFAULTS }; }
}

export function getCandleColors() { return { ...colors }; }

export function setCandleColors(patch) {
  colors = { ...colors, ...patch };
  try { localStorage.setItem(KEY, JSON.stringify(colors)); } catch { /* ignore */ }
  subs.forEach(fn => fn(colors));
}

export function resetCandleColors() { setCandleColors({ ...CANDLE_DEFAULTS }); }

/** Subscribe to changes; returns an unsubscribe fn. */
export function onCandleColorsChange(fn) { subs.add(fn); return () => subs.delete(fn); }
