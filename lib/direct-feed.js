/* ============================================================================
   FlipBook · direct feed  (app/www/lib/direct-feed.js)
   ----------------------------------------------------------------------------
   Demo mode's market data: the same requests the FlipBook server makes, sent
   straight from the browser. OKX perpetuals first; if the browser can't reach
   OKX (network or cross-origin rules), the Binance market-data mirror (spot)
   for the same coin. Results carry `.source` saying which one answered.

     directKlines({ symbol, interval, limit, source, start, end, signal })
     directInstruments()
   ========================================================================== */

const OKX = 'https://www.okx.com';
const BINANCE = 'https://data-api.binance.vision';

const INTERVAL_MS = {
  '1m': 60_000, '3m': 180_000, '5m': 300_000, '15m': 900_000, '30m': 1_800_000,
  '1h': 3_600_000, '2h': 7_200_000, '4h': 14_400_000, '1d': 86_400_000,
};
const OKX_BAR = { '1m': '1m', '3m': '3m', '5m': '5m', '15m': '15m', '30m': '30m', '1h': '1H', '2h': '2H', '4h': '4H', '1d': '1D' };
const OKX_PAGE = { candles: 300, 'history-candles': 100 };
const LIVE_TTL = 4000, CLOSED_TTL = 30 * 60_000;
const SKIP_MS = 5 * 60_000;   // after OKX fails to connect, go straight to Binance for a while
let okxDownUntil = 0;

const toCandle = k => ({ t: +k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] });

async function getJson(url, signal) {
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`upstream ${res.status}`);
  return res.json();
}

/* ---- OKX: recent candles, then the history endpoint (spaced out) ---- */

let historyQueue = Promise.resolve();
function okxGet(path, qs, signal) {
  const run = () => getJson(`${OKX}/api/v5/market/${path}?${qs}`, signal).then(j => {
    if (j.code !== '0') throw new Error(`okx ${j.code}: ${j.msg}`);
    return j.data || [];
  });
  if (path === 'candles') return run();
  const p = historyQueue.then(run);
  historyQueue = p.catch(() => {}).then(() => new Promise(r => setTimeout(r, 110)));
  return p;
}

/** Newest-first rows, paging back until `want` rows or the oldest reaches `start`. */
async function okxBack(symbol, interval, { before = null, want = null, start = null }, signal) {
  const id = `instId=${symbol.replace(/USDT$/, '-USDT-SWAP')}&bar=${OKX_BAR[interval]}`;
  const rows = [];
  let path = 'candles', cursor = before;
  for (let guard = 0; guard < 60; guard++) {
    const n = want ? Math.min(OKX_PAGE[path], want - rows.length) : OKX_PAGE[path];
    let page;
    try { page = await okxGet(path, `${id}&limit=${n}${cursor != null ? `&after=${cursor}` : ''}`, signal); }
    catch (e) { if (rows.length && e.name !== 'AbortError') break; throw e; }
    rows.push(...page);
    const oldest = page.length ? +page.at(-1)[0] : null;
    if ((want && rows.length >= want) || (start != null && oldest != null && oldest <= start)) break;
    if (page.length < n) { if (path === 'history-candles') break; path = 'history-candles'; }
    if (oldest != null) cursor = oldest;
  }
  return rows;
}

/* ---- each source returns oldest-first candles ---- */

const SOURCES = {
  okx: {
    latest: async (s, i, limit, sig) => (await okxBack(s, i, { want: limit }, sig)).map(toCandle).reverse(),
    range: async (s, i, start, end, sig) =>
      (await okxBack(s, i, { before: end + 1, start }, sig)).map(toCandle).filter(c => c.t >= start).reverse(),
  },
  binance: {
    async latest(s, i, limit, sig) {
      const rows = [];
      let endTime = '';
      while (rows.length < limit) {
        const n = Math.min(1000, limit - rows.length);
        const page = await getJson(`${BINANCE}/api/v3/klines?symbol=${s}&interval=${i}&limit=${n}${endTime}`, sig);
        rows.unshift(...page);
        if (page.length < n) break;
        endTime = `&endTime=${page[0][0] - 1}`;
      }
      return rows.map(toCandle);
    },
    async range(s, i, start, end, sig) {
      const rows = [];
      for (let from = start, guard = 0; guard < 10; guard++) {
        const page = await getJson(`${BINANCE}/api/v3/klines?symbol=${s}&interval=${i}&startTime=${from}&endTime=${end}&limit=1000`, sig);
        rows.push(...page);
        if (page.length < 1000) break;
        from = page.at(-1)[0] + 1;
      }
      return rows.map(toCandle);
    },
  },
};

/* ---- cache: forming data briefly, finished ranges for longer ---- */

const cache = new Map();   // key → { data, ts, ttl }
function remember(key, data, ttl) {
  if (cache.size > 200) cache.delete(cache.keys().next().value);
  cache.set(key, { data, ts: Date.now(), ttl });
  return data;
}

/** Candles from the browser: the latest `limit`, or every candle opening in [start, end]. */
export async function directKlines({ symbol, interval = '3m', limit = 240, source = 'okx', start, end, signal } = {}) {
  const ranged = start != null && end != null;
  const key = `${source}:${symbol}:${interval}:${ranged ? `${start}-${end}` : `n${limit}`}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.ts < hit.ttl) return hit.data;
  const ttl = ranged && end < Date.now() - INTERVAL_MS[interval] ? CLOSED_TTL : LIVE_TTL;

  // OKX-listed coins fall back to Binance's spot data if OKX can't be reached from the browser.
  const order = source === 'okx' && Date.now() >= okxDownUntil ? ['okx', 'binance'] : ['binance'];
  let lastErr;
  for (const src of order) {
    try {
      const rows = ranged
        ? await SOURCES[src].range(symbol, interval, start, end, signal)
        : await SOURCES[src].latest(symbol, interval, limit, signal);
      if (!rows.length && src !== order.at(-1)) continue;
      rows.source = src;
      return remember(key, rows, ttl);
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      if (src === 'okx' && e instanceof TypeError) okxDownUntil = Date.now() + SKIP_MS;   // couldn't connect at all
      lastErr = e;
    }
  }
  throw lastErr || new Error('no data');
}

/** Every USDT coin the browser can chart: OKX perpetuals, then Binance spot coins OKX lacks. */
export async function directInstruments() {
  const [okx, bin] = await Promise.allSettled([
    getJson(`${OKX}/api/v5/public/instruments?instType=SWAP`),
    getJson(`${BINANCE}/api/v3/ticker/price`),
  ]);
  const bySym = new Map();
  const ok = s => /^[A-Z0-9]{1,15}$/.test(s);
  if (okx.status === 'fulfilled') {
    for (const i of okx.value.data || []) {
      const base = i.instId.split('-')[0];
      if (i.state === 'live' && i.settleCcy === 'USDT' && ok(base)) bySym.set(base, 'okx');
    }
  }
  if (bin.status === 'fulfilled') {
    for (const { symbol } of bin.value || []) {
      const base = symbol.endsWith('USDT') ? symbol.slice(0, -4) : null;
      if (base && ok(base) && !bySym.has(base)) bySym.set(base, 'binance');
    }
  }
  if (!bySym.size) throw new Error('no instrument source reachable');
  return [...bySym].map(([sym, source]) => ({ sym, pair: `${sym}USDT`, source })).sort((a, b) => a.sym.localeCompare(b.sym));
}
