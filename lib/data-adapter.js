/* ============================================================================
   FlipBook · data adapter
   ----------------------------------------------------------------------------
   The chart engine speaks one candle shape: { t, o, h, l, c, v }.
   This module is the single place that turns a real feed (your Express
   /api/klines backend, which proxies Bybit v5) — or a synthetic fallback —
   into that shape, so no view ever touches a raw API response.

     fetchKlines()    → normalized candles from your backend
     normalizeKlines()→ tolerant mapper (handles Bybit raw arrays + object rows)
     createPoller()   → refresh on an interval, abort-safe
     syntheticSeries()→ deterministic candles for offline/dev (matches mockup)

   ES module:  import { fetchKlines, createPoller } from './data-adapter.js';
   ========================================================================== */

/* ---- timeframe codes ----------------------------------------------------
   Your backend already translates these to Bybit's scheme; this client-side
   map mirrors it so the UI can label/aggregate without a round-trip, and so
   a direct-to-Bybit call (no backend) still works in a pinch. ------------- */
import { directKlines, directInstruments } from './direct-feed.js';
import { sampleKlines } from './sample-feed.js';
import { SAMPLE_ONLY } from './config.js';

export const BYBIT_INTERVAL = {
  '1m': '1', '3m': '3', '5m': '5', '15m': '15', '30m': '30',
  '1h': '60', '2h': '120', '4h': '240', '6h': '360', '12h': '720',
  '1D': 'D', '1W': 'W', '1M': 'M',
};

/* OKX v5 `bar` codes: hours/days are capitalised (1H, 4H, 1D), and instIds are
   dashed (BERA-USDT). Use these if the FRONTEND ever talks to OKX directly, or
   inside your server when forwarding `bar`. If your server already maps the UI
   codes itself, the frontend keeps sending UI codes and you don't need these. */
export const OKX_INTERVAL = {
  '1m': '1m', '3m': '3m', '5m': '5m', '15m': '15m', '30m': '30m',
  '1h': '1H', '2h': '2H', '4h': '4H', '6h': '6H', '12h': '12H',
  '1d': '1D', '1w': '1W', '1D': '1D', '1W': '1W', '1M': '1M',
};

/** 'BERAUSDT' → 'BERA-USDT' (OKX instId). Passes dashed input through. */
export const okxInstId = sym =>
  sym.includes('-') ? sym.toUpperCase() : sym.toUpperCase().replace(/(USDT|USDC|USD)$/, '-$1');

/** Length of one candle, in ms, per UI interval code. */
export const INTERVAL_MS = {
  '1m': 60_000, '3m': 180_000, '5m': 300_000, '15m': 900_000, '30m': 1_800_000,
  '1h': 3_600_000, '2h': 7_200_000, '4h': 14_400_000, '1d': 86_400_000,
};

/** Base-candle multiplier of one timeframe relative to 3m (for TF overlays). */
export const TF_FACTOR_FROM_3M = { '3m': 1, '15m': 5, '1h': 20, '4h': 80, '1D': 480 };

/* ---- normalization ------------------------------------------------------ */

/** Map one feed row → { t, o, h, l, c, v }. Tolerant of array + object rows. */
function normalizeCandle(row) {
  if (Array.isArray(row)) {
    // Same positions for both feeds we use, so one branch covers both:
    //   Bybit v5: [start, open, high, low, close, volume, turnover]
    //   OKX  v5:  [ts,    open, high, low, close, vol,    volCcy, volCcyQuote, confirm]
    return { t: +row[0], o: +row[1], h: +row[2], l: +row[3], c: +row[4], v: +(row[5] || 0) };
  }
  const t = row.t ?? row.time ?? row.start ?? row.openTime ?? row.ts;
  return {
    t: t != null ? +t : undefined,
    o: +(row.o ?? row.open),
    h: +(row.h ?? row.high),
    l: +(row.l ?? row.low),
    c: +(row.c ?? row.close),
    v: +(row.v ?? row.volume ?? 0),
  };
}

/**
 * Normalize any backend payload to an ascending-by-time candle array.
 * Accepts a bare array, or common envelopes ({ result:{list} }, { data }, …).
 * Bybit returns newest-first, so we reverse when timestamps are descending.
 */
export function normalizeKlines(raw) {
  const arr = Array.isArray(raw)
    ? raw
    : (raw?.result?.list ?? raw?.list ?? raw?.data ?? raw?.klines ?? raw?.candles ?? []);
  const out = arr.map(normalizeCandle)
    .filter(d => Number.isFinite(d.o) && Number.isFinite(d.c) && Number.isFinite(d.h) && Number.isFinite(d.l));
  if (out.length > 1 && out[0].t != null && out[0].t > out[out.length - 1].t) out.reverse();
  return out;
}

/* ---- fetch -------------------------------------------------------------- */

/**
 * Fetch klines from the FlipBook backend.
 * @param {object}  o
 * @param {?string} o.apiBase   e.g. '' (same origin) or 'http://192.168.1.20:3001'; null = demo mode (straight from the exchange)
 * @param {string}  o.symbol    e.g. 'BERAUSDT'
 * @param {string}  o.interval  UI code, e.g. '3m' (the backend maps to Bybit)
 * @param {number}  o.limit     number of candles
 * @param {string}  [o.source] 'okx' (default, perpetuals) or 'binance' (spot mirror)
 * @param {number}  [o.start]  with `end`: every candle opening in [start, end] (ms) instead of the latest `limit`
 * @param {number}  [o.end]
 * @param {AbortSignal} [o.signal]
 * @returns {Promise<Array<{t,o,h,l,c,v}>>}
 */
export async function fetchKlines({ apiBase = '', symbol, interval = '3m', limit = 240, source = 'okx', start, end, signal } = {}) {
  if (!symbol) throw new Error('fetchKlines: symbol is required');
  if (apiBase === null) {   // demo mode: generated sample data, or straight from the exchange
    if (SAMPLE_ONLY) return sampleKlines({ interval, limit, start, end }, bySym[String(symbol).replace(/USDT$/, '')] || { seed: seedOf(symbol) });
    return directKlines({ symbol, interval, limit, source, start, end, signal });
  }
  const qs = new URLSearchParams({ symbol, interval, source });
  if (start != null && end != null) { qs.set('start', String(start)); qs.set('end', String(end)); }
  else qs.set('limit', String(limit));
  const res = await fetch(`${apiBase}/api/klines?${qs}`, { signal });
  if (!res.ok) throw new Error(`klines request failed (${res.status})`);
  return normalizeKlines(await res.json());
}

/**
 * Optional: fetch straight from OKX's public endpoint (no backend).
 * Useful for quick tests. NOTE: works from a Capacitor native shell, but a
 * plain browser may be blocked by CORS — keep production traffic going through
 * your server (which also gives you caching + geo control). Returns the same
 * normalized `{t,o,h,l,c,v}` ascending array.
 */
export async function fetchKlinesDirectOKX({ base = 'https://www.okx.com', symbol, interval = '3m', limit = 240, signal } = {}) {
  if (!symbol) throw new Error('fetchKlinesDirectOKX: symbol is required');
  const qs = new URLSearchParams({
    instId: okxInstId(symbol),
    bar: OKX_INTERVAL[interval] || interval,
    limit: String(limit),
  });
  const res = await fetch(`${base}/api/v5/market/candles?${qs}`, { signal });
  if (!res.ok) throw new Error(`OKX request failed (${res.status})`);
  return normalizeKlines(await res.json());   // OKX wraps rows in { code, msg, data }
}

/* ---- polling ------------------------------------------------------------ */

/**
 * Repeatedly run `task(signal)` every `intervalMs`. Each tick aborts the
 * previous in-flight request, so a slow fetch never stacks. Returns { stop }.
 */
export function createPoller(task, { intervalMs = 20000, immediate = true } = {}) {
  let timer = null, stopped = false, ctrl = null;

  async function tick() {
    if (stopped) return;
    if (typeof document !== 'undefined' && document.hidden) {   // background tab: wait for focus
      document.addEventListener('visibilitychange', tick, { once: true });
      return;
    }
    ctrl?.abort();
    ctrl = new AbortController();
    try {
      await task(ctrl.signal);
    } catch (e) {
      if (e.name !== 'AbortError') console.warn('[poller]', e.message);
    }
    if (!stopped) timer = setTimeout(tick, intervalMs);
  }

  if (immediate) tick(); else timer = setTimeout(tick, intervalMs);
  return {
    stop() {
      stopped = true; clearTimeout(timer); ctrl?.abort();
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', tick);
    },
  };
}

/** How often charts pull fresh candles. */
export const LIVE_POLL_MS = 5000;

/* ---- synthetic fallback (offline / dev) --------------------------------
   Deterministic series matching the mockup's data layer, so the UI renders
   identically with no backend. Same LCG + drift/vol model, now returning the
   engine's { t, o, h, l, c } shape with synthetic timestamps. ------------- */

const seededRng = s => () => { s = (s * 1664525 + 1013904223) & 0xffffffff; return (s >>> 0) / 0xffffffff; };

/**
 * @param {object} o
 * @param {number} o.n     candle count
 * @param {number} o.base  base price
 * @param {number} o.seed  deterministic seed
 * @param {number} o.vol   per-candle volatility fraction of base
 * @param {number} o.ramp  optional late directional ramp (0 = none)
 * @param {number} o.stepMs spacing between synthetic timestamps
 */
export function syntheticSeries({ n = 240, base = 0.2683, seed = 12345, vol = 0.013, ramp = 0, stepMs = 180000 } = {}) {
  const r = seededRng((seed >>> 0) || 1);
  const now = Date.now();
  const out = [];
  let p = base;
  for (let i = 0; i < n; i++) {
    const o = p;
    const drift = Math.sin(i / 22 + (seed % 7)) * base * 0.0009;
    const volStep = base * vol * (0.5 + r());
    let c = o + drift + (r() - 0.5) * volStep;
    c = Math.max(base * 0.82, Math.min(base * 1.18, c));
    out.push({
      t: now - (n - 1 - i) * stepMs,
      o, c,
      h: Math.max(o, c) + r() * volStep * 0.55,
      l: Math.min(o, c) - r() * volStep * 0.55,
      v: 0,
    });
    p = c;
  }
  if (ramp) {
    for (let i = n - 30; i < n - 10; i++) {
      if (out[i]) { const k = (i - (n - 30)) * 0.0009 * base * ramp; out[i].c += k; out[i].h += k * 1.2; }
    }
  }
  return out;
}

/* ---- instrument reference (ported from the mockup data layer) ----------- */
export const INSTRUMENTS = [
  { sym: 'BERA', name: 'Berachain',    pair: 'BERAUSDT', base: 0.2683,     seed: 12345, dp: 4, vol: 0.013 },
  { sym: 'SOL',  name: 'Solana',       pair: 'SOLUSDT',  base: 172.40,     seed: 2207,  dp: 2, vol: 0.010 },
  { sym: 'HYPE', name: 'Hyperliquid',  pair: 'HYPEUSDT', base: 28.64,      seed: 1409,  dp: 3, vol: 0.014 },
  { sym: 'WIF',  name: 'dogwifhat',    pair: 'WIFUSDT',  base: 1.842,      seed: 3110,  dp: 4, vol: 0.020 },
  { sym: 'SUI',  name: 'Sui',          pair: 'SUIUSDT',  base: 3.421,      seed: 5806,  dp: 4, vol: 0.012 },
  { sym: 'ARB',  name: 'Arbitrum',     pair: 'ARBUSDT',  base: 0.6212,     seed: 7702,  dp: 4, vol: 0.013 },
  { sym: 'TIA',  name: 'Celestia',     pair: 'TIAUSDT',  base: 5.913,      seed: 6301,  dp: 4, vol: 0.015 },
  { sym: 'JUP',  name: 'Jupiter',      pair: 'JUPUSDT',  base: 0.7841,     seed: 9104,  dp: 4, vol: 0.016 },
  { sym: 'ETH',  name: 'Ethereum',     pair: 'ETHUSDT',  base: 3121.4,     seed: 808,   dp: 1, vol: 0.008 },
  { sym: 'PEPE', name: 'Pepe',         pair: 'PEPEUSDT', base: 0.00001183, seed: 4242,  dp: 8, vol: 0.019 },
];

export const bySym = Object.fromEntries(INSTRUMENTS.map(i => [i.sym, i]));

/* ---- full coin catalog ---------------------------------------------------
   Every USDT coin the server can chart: OKX perpetuals (default) plus Binance
   spot coins OKX lacks. Curated INSTRUMENTS above keep their names/metadata;
   anything else resolves from the catalog. Cached locally for offline use. */

const CATALOG_KEY = 'flipbook.instruments.v1';
let catalog = readCatalog();
let catalogLoad = null;

function readCatalog() {
  try { return JSON.parse(localStorage.getItem(CATALOG_KEY)) || []; } catch { return []; }
}
const catalogBySym = () => new Map(catalog.map(i => [i.sym, i]));
let catalogIndex = catalogBySym();

/** Fetch the catalog once per page (falls back to the cached copy). */
export function loadInstruments(apiBase = '') {
  const source = SAMPLE_ONLY
    ? Promise.resolve(INSTRUMENTS.map(i => ({ sym: i.sym, pair: i.pair, source: 'sample' })))
    : apiBase === null
    ? directInstruments()
    : fetch(`${apiBase}/api/instruments`)
      .then(r => (r.ok ? r.json() : Promise.reject(new Error(`instruments ${r.status}`))))
      .then(j => j.instruments);
  catalogLoad ??= source
    .then(list => {
      catalog = list || [];
      catalogIndex = catalogBySym();
      try { localStorage.setItem(CATALOG_KEY, JSON.stringify(catalog)); } catch { /* quota */ }
      return catalog;
    })
    .catch(() => catalog);
  return catalogLoad;
}

/** Case-insensitive prefix-then-substring search over the catalog. */
export function searchInstruments(query, max = 60) {
  const q = query.trim().toUpperCase();
  if (!q) return catalog.slice(0, max);
  const starts = [], contains = [];
  for (const i of catalog) {
    if (i.sym.startsWith(q)) starts.push(i);
    else if (i.sym.includes(q)) contains.push(i);
    if (starts.length >= max) break;
  }
  return starts.concat(contains).slice(0, max);
}

export const SOURCE_LABEL = { okx: 'OKX PERP', binance: 'BINANCE SPOT', sample: 'SAMPLE DATA' };

/** Sensible decimals for a coin we have no curated metadata for. */
export const dpForPrice = p => (p > 0 ? Math.max(1, Math.min(8, 4 - Math.floor(Math.log10(p)))) : 4);

/** Stable seed from a symbol, for sample data of coins without curated metadata. */
function seedOf(sym) {
  let seed = 0;
  for (const ch of String(sym).replace(/USDT$/, '')) seed = (seed * 31 + ch.charCodeAt(0)) >>> 0;
  return seed || 1;
}

/** Everything a view needs to chart `sym`: pair, source, dp, name, synthetic seed. */
export function resolveInstrument(sym) {
  const key = String(sym).toUpperCase().replace(/USDT$/, '');
  const curated = bySym[key];
  const listed = catalogIndex.get(key);
  const seed = seedOf(key);
  return {
    sym: key,
    pair: `${key}USDT`,
    name: curated?.name || '',
    source: SAMPLE_ONLY ? 'sample' : listed?.source || 'okx',
    dp: curated?.dp ?? null,                 // null → derive from price via dpForPrice
    base: curated?.base ?? 1,
    seed: curated?.seed ?? seed,
    vol: curated?.vol ?? 0.012,
  };
}
