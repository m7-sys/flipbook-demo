/* ============================================================================
   FlipBook · sample feed  (app/www/lib/sample-feed.js)
   ----------------------------------------------------------------------------
   Realistic-looking candles with no network at all, for showcasing the app.
   Price is a pure function of (coin, time) — layered noise at scales from a
   week down to a minute, the way real prices wander — so any range, any
   timeframe and any later request agree with each other, past sessions never
   change, and the latest candle keeps moving as the clock runs. Coins share a
   "market" component, so they're partly correlated like real crypto.

     sampleKlines({ symbol, interval, limit, start, end }, { base, seed, vol })
   ========================================================================== */

const MIN = 60_000, H = 60 * MIN, D = 24 * H;
const INTERVAL_MS = {
  '1m': MIN, '3m': 3 * MIN, '5m': 5 * MIN, '15m': 15 * MIN, '30m': 30 * MIN,
  '1h': H, '2h': 2 * H, '4h': 4 * H, '1d': D,
};
const SCALES = [7 * D, 2 * D, 12 * H, 4 * H, H, 15 * MIN, 3 * MIN, MIN];
const MARKET_SEED = 7;

/** Deterministic pseudo-random value in [-1, 1) for (seed, i). */
function hash(seed, i) {
  let h = (Math.imul(seed, 0x27d4eb2d) ^ Math.imul(i | 0, 0x9e3779b1)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 2147483648 - 1;
}

/** Smooth noise at one scale. */
function noise(seed, t, scale) {
  const x = t / scale, i = Math.floor(x), f = x - i, u = f * f * (3 - 2 * f);
  const a = hash(seed, i), b = hash(seed, i + 1);
  return a + (b - a) * u;
}

/** Layered noise: bigger scales move further, like a random walk (∝ √scale). */
function walk(seed, t) {
  let v = 0;
  for (let k = 0; k < SCALES.length; k++) v += Math.sqrt(SCALES[k] / D) * noise(seed * 31 + k, t, SCALES[k]);
  return v;
}

function priceFn({ base = 1, seed = 1, vol = 0.013 }) {
  const daily = Math.min(0.06, Math.max(0.02, vol * 2.6));   // a day's typical move
  return t => base * Math.exp(daily * (0.55 * walk(MARKET_SEED, t) + 0.7 * walk(seed, t)));
}

/** Candles at interval boundaries; the newest one is still forming, closing at "now". */
export function sampleKlines({ interval = '3m', limit = 240, start, end }, coin = {}) {
  const ms = INTERVAL_MS[interval] || 3 * MIN, now = Date.now(), last = Math.floor(now / ms) * ms;
  const P = priceFn(coin);
  let from, to = last;
  if (start != null && end != null) { from = Math.ceil(start / ms) * ms; to = Math.min(last, Math.floor(end / ms) * ms); }
  else from = last - (limit - 1) * ms;

  const out = [];
  for (let t = from; t <= to; t += ms) {
    const close = t === last ? now : t + ms;
    const o = P(t), c = P(close);
    let h = Math.max(o, c), l = Math.min(o, c);
    for (let k = 1; k <= 3; k++) { const p = P(t + ((close - t) * k) / 4); if (p > h) h = p; if (p < l) l = p; }
    const wick = (h - l) * 0.35 + o * 0.0004;
    h += wick * Math.abs(hash(coin.seed ?? 1, t / ms)); l -= wick * Math.abs(hash((coin.seed ?? 1) + 1, t / ms));
    out.push({ t, o, h, l, c, v: Math.round(500 + 500 * Math.abs(hash(3, t / ms))) });
  }
  out.source = 'sample';
  return out;
}
