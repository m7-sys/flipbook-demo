/* ============================================================================
   FlipBook · chart engine
   ----------------------------------------------------------------------------
   Canvas-rendered charts in the FlipBook visual language. One ResizeObserver
   re-renders every registered canvas, so charts stay crisp through view- and
   layout-switches without per-view resize wiring.

   Refined from the Claude Design mockup:
     · standalone — no dependency on a global `FB` namespace; the price
       formatter is injected (with a sensible default), so the engine is
       reusable in any view or in isolation.
     · safe extents — min/max via a single pass, so large feeds don't blow the
       call stack (Math.min(...arr) does) and empty input degrades gracefully.
     · one candle primitive shared by full + mini renderers (no duplicated loop).

   Usage (ES module):
     import * as Charts from './chart-engine.js';
     Charts.register(canvas, (ctx, w, h) => Charts.candles(ctx, w, h, data));

   Also attaches to `window.Charts` when loaded as a classic script, so it
   drops into the existing app either way.
   ========================================================================== */

import { getCandleColors } from './chart-theme.js';

/* ---- palette (single source of truth; mirrors the CSS tokens) ----------- */
export const THEME = {
  bg: '#0b0d10', grid: '#161b21', line: '#262e37',
  ink: '#e8edf2', dim: '#8a96a3', faint: '#566270',
  amber: '#e8b84b', teal: '#39d3c3', rose: '#e8584b',
  up: '#e8b84b', down: '#e7e9ec', downMini: '#9aa3ad',
};
/** Typeface for canvas labels (mirrors --sans). */
export const FONT = "'Plus Jakarta Sans', system-ui, sans-serif";

export const verdictColor = {
  hit: THEME.teal, partial: THEME.amber, miss: THEME.rose, open: THEME.dim,
};

/* ---- shared helpers ----------------------------------------------------- */

/** Hex (#rrggbb) → rgba() string at alpha `a`. */
export function hexA(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

/** Hex (#rrggbb) → "rgba(r,g,b," prefix for building translucent strings. */
function rgbPrefix(hex) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},`;
}

/** Price → string. Inject `opt.fmt(v)` to override; else pick dp by magnitude. */
export function formatPrice(v, opt = {}) {
  if (typeof opt.fmt === 'function') return opt.fmt(v);
  let dp = opt.dp;
  if (dp == null) {
    const a = Math.abs(v);
    dp = a >= 1000 ? 1 : a >= 100 ? 2 : a >= 1 ? 3 : a >= 0.01 ? 4 : a >= 0.0001 ? 6 : 8;
  }
  return v.toFixed(dp);
}

/** Low/high extent of candle data in one pass (stack-safe for long feeds). */
function priceExtent(data) {
  let lo = Infinity, hi = -Infinity;
  for (const d of data) { if (d.l < lo) lo = d.l; if (d.h > hi) hi = d.h; }
  return [lo, hi];
}

/** Aggregate `factor` base candles into one higher-timeframe candle. */
export function aggregate(data, factor) {
  if (factor <= 1) return data;
  const out = [];
  for (let i = 0; i < data.length; i += factor) {
    const s = data.slice(i, i + factor);
    if (!s.length) break;
    let h = -Infinity, l = Infinity;
    for (const x of s) { if (x.h > h) h = x.h; if (x.l < l) l = x.l; }
    out.push({ o: s[0].o, c: s[s.length - 1].c, h, l, span: s.length, start: i });
  }
  return out;
}

/**
 * Draw a single candle. `yfn` maps price→pixel. `hollow` renders a down/neutral
 * candle as an outlined body (full chart) vs. a filled body (mini thumbnail).
 */
function drawCandle(ctx, x, bw, yfn, d, { up, down, bg, hollow }) {
  const rising = d.c >= d.o, col = rising ? up : down;
  ctx.strokeStyle = col; ctx.fillStyle = col; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(x, yfn(d.h)); ctx.lineTo(x, yfn(d.l)); ctx.stroke();
  const yo = yfn(d.o), yc = yfn(d.c);
  const top = Math.min(yo, yc), hg = Math.max(1, Math.abs(yc - yo));
  if (rising || !hollow) {
    ctx.fillRect(x - bw / 2, top, bw, hg);
  } else {
    ctx.fillStyle = bg; ctx.fillRect(x - bw / 2, top, bw, hg);
    ctx.strokeStyle = col; ctx.strokeRect(x - bw / 2, top, bw, hg);
  }
}

/* ---- registry: DPR-correct render + auto-resize -------------------------- */

const registry = new Set();

function renderOne(cv) {
  const dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth, h = cv.clientHeight;
  if (!w || !h) return;
  cv.width = w * dpr; cv.height = h * dpr;
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  if (cv.__draw) cv.__draw(ctx, w, h);
  if (cv.__onRedraw) cv.__onRedraw();
}

/* ---- geometry helpers for chart overlays (window selector) -------------- */

/** Global candle index → x pixel (center of the candle), or null if no layout. */
export function indexToX(cv, g) {
  const L = cv.__layout; if (!L) return null;
  return L.padL + (g - L.start + 0.5) * L.slot;
}
/** x pixel → nearest global candle index. */
export function xToIndex(cv, px) {
  const L = cv.__layout; if (!L) return 0;
  return Math.round(L.start + (px - L.padL) / L.slot - 0.5);
}
/** Current visible range { start, count, total }. */
export function visibleRange(cv) {
  const L = cv.__layout; return L ? { start: L.start, count: L.count, total: L.total } : null;
}

const RO = typeof ResizeObserver !== 'undefined'
  ? new ResizeObserver(es => es.forEach(e => renderOne(e.target)))
  : null;

/** Register a canvas with its draw fn; (re)renders now and on every resize. */
export function register(cv, drawFn) {
  cv.__draw = drawFn;
  if (!registry.has(cv)) { registry.add(cv); RO && RO.observe(cv); }
  renderOne(cv);
}

/** Drop a canvas from the registry (call on teardown to avoid leaks). */
export function unregister(cv) {
  if (registry.delete(cv)) RO && RO.unobserve(cv);
}

/** Force a re-render of every live canvas (e.g. after a display:none→block). */
export function refreshAll() {
  registry.forEach(cv => { if (cv.isConnected && cv.clientWidth) renderOne(cv); });
}

/** Re-render a single canvas now. */
export function redraw(cv) { renderOne(cv); }

// Canvas text doesn't re-render when a web font arrives, so redraw once it has.
if (typeof document !== 'undefined' && document.fonts) {
  Promise.all(['400', '700'].map(w => document.fonts.load(`${w} 10px ${FONT}`))).then(refreshAll, () => {});
}

/* ---- view window (zoom & pan) --------------------------------------------
   A chart's view is { zoom, endT, margin, yShift } stored on the canvas:
     zoom    data.length / visible candles (≥ 1)
     endT    timestamp at the right edge, or null to follow the latest candle
     margin  empty candles right of the latest when following (≥ 0)
     yShift  vertical pan, as a fraction of the auto-fitted price range
   Anchoring to time (not index) keeps a panned view still while live updates
   append candles or slide the window. */

const clampN = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const freshView = () => ({ zoom: 1, endT: null, margin: 0, yShift: 0 });
const isDefaultView = v => v.zoom === 1 && v.endT == null && !v.margin && !v.yShift;

/** Milliseconds per candle (0 when the data carries no timestamps). */
function candleMs(data) {
  const n = data.length;
  return n > 1 && data[0].t > 0 ? (data[n - 1].t - data[0].t) / (n - 1) : 0;
}

/** Visible window as a float start index and a candle count. */
function viewWindow(cv, data) {
  const total = data.length, v = cv?.__zoom;
  if (!v) return { start: 0, count: total };
  const count = Math.max(Math.min(8, total), total / v.zoom);
  const ms = candleMs(data);
  let end = total - 1 + v.margin;
  if (v.endT != null && ms) end = total - 1 + (v.endT - data[total - 1].t) / ms;
  end = clampN(end, count * 0.25 - 1, total - 1 + count * 0.5);
  return { start: end - count + 1, count };
}

/** Store a new right edge; snaps back to "follow latest" when at/after it. */
function setViewEnd(v, data, end) {
  const total = data.length, ms = candleMs(data);
  if (end >= total - 1 || !ms) { v.endT = null; v.margin = Math.max(0, end - (total - 1)); }
  else { v.endT = data[total - 1].t + (end - (total - 1)) * ms; v.margin = 0; }
}

/** The candle and price under a client point, or null before first draw. */
export function pointAt(cv, clientX, clientY) {
  const L = cv.__layout; if (!L?.data?.length) return null;
  const r = cv.getBoundingClientRect();
  const index = clampN(Math.round(L.start + (clientX - r.left - L.padL) / L.slot - 0.5), 0, L.data.length - 1);
  const price = L.hi - ((clientY - r.top - L.padT) / L.ch) * (L.hi - L.lo);
  return { index, t: L.data[index].t, price };
}

/**
 * Make a candle canvas explorable: drag to pan in time and price, wheel or
 * pinch to zoom (anchored on the cursor). A ⟲ button resets the view once it
 * has moved; double-clicking the price scale also resets.
 *   opt.dblclickReset  (default true) double-click anywhere resets — pass false
 *                      when the page uses double-click for something else
 *   opt.touchAction    CSS touch-action (default 'none'; 'pan-y' lets a feed scroll)
 *   opt.maxZoom        cap on zoom (default 40)
 */
export function enableZoom(cv, opt = {}) {
  if (cv.__zoomBound) return; cv.__zoomBound = true;
  const maxZoom = opt.maxZoom || 40;
  const v = cv.__zoom = freshView();
  cv.style.touchAction = opt.touchAction || 'none';
  cv.style.cursor = 'grab';

  const wrap = cv.parentElement;
  if (wrap && getComputedStyle(wrap).position === 'static') wrap.style.position = 'relative';
  const resetBtn = document.createElement('button');
  resetBtn.type = 'button'; resetBtn.title = 'Reset view'; resetBtn.textContent = '⟲';
  resetBtn.style.cssText = 'position:absolute;left:10px;top:8px;z-index:6;display:none;font:600 13px ' + FONT + ';' +
    `color:${THEME.ink};background:${THEME.bg};border:1px solid ${THEME.line};border-radius:7px;padding:2px 8px;cursor:pointer;opacity:.85`;
  wrap?.appendChild(resetBtn);

  const redraw = () => { renderOne(cv); resetBtn.style.display = isDefaultView(v) ? 'none' : 'block'; };
  const reset = () => { Object.assign(v, freshView()); redraw(); };
  resetBtn.addEventListener('click', e => { e.stopPropagation(); reset(); });
  resetBtn.addEventListener('dblclick', e => e.stopPropagation());
  resetBtn.addEventListener('pointerdown', e => e.stopPropagation());

  const plotFx = clientX => {             // cursor position across the plot, 0..1
    const L = cv.__layout, r = cv.getBoundingClientRect();
    if (!L) return (clientX - r.left) / (r.width || 1);
    return clampN((clientX - r.left - L.padL) / (L.slot * L.count), 0, 1);
  };
  function zoomAt(fx, factor) {
    const data = cv.__layout?.data; if (!data) return;
    const { start, count } = viewWindow(cv, data);
    const anchor = start + fx * count;
    v.zoom = clampN(v.zoom * factor, 1, maxZoom);
    const n = viewWindow(cv, data).count;
    setViewEnd(v, data, anchor - fx * n + n - 1);
    redraw();
  }

  cv.addEventListener('wheel', e => { e.preventDefault(); zoomAt(plotFx(e.clientX), e.deltaY < 0 ? 1.18 : 1 / 1.18); }, { passive: false });

  cv.addEventListener('dblclick', e => {
    const L = cv.__layout, onAxis = L && e.clientX - cv.getBoundingClientRect().left > L.padL + L.slot * L.count;
    if (opt.dblclickReset !== false || onAxis) { e.stopPropagation(); reset(); }
  });

  // drag = pan in time and price; a small threshold keeps clicks working
  const pts = new Map();
  let dragging = false, moved = false, travel = 0, lastX = 0, lastY = 0, pinchDist = 0;

  cv.addEventListener('pointerdown', e => {
    if (e.button > 0) return;               // left button / touch / pen only
    pts.set(e.pointerId, e);
    if (pts.size === 1) { dragging = true; moved = false; travel = 0; lastX = e.clientX; lastY = e.clientY; }
    if (pts.size === 2) pinchDist = dist(pts);
    cv.setPointerCapture?.(e.pointerId);
  });
  cv.addEventListener('pointermove', e => {
    if (!pts.has(e.pointerId)) return;
    pts.set(e.pointerId, e);
    if (pts.size === 2) {                       // pinch zoom
      const d = dist(pts); if (!pinchDist) { pinchDist = d; return; }
      zoomAt(0.5, d / pinchDist); pinchDist = d; return;
    }
    if (!dragging) return;
    const dx = e.clientX - lastX, dy = e.clientY - lastY;
    lastX = e.clientX; lastY = e.clientY;
    travel += Math.abs(dx) + Math.abs(dy);
    if (travel <= 3) return;
    if (!moved) { moved = true; cv.style.cursor = 'grabbing'; }
    const L = cv.__layout; if (!L?.data) return;
    const { start, count } = viewWindow(cv, L.data);
    setViewEnd(v, L.data, start + count - 1 - dx / L.slot);
    v.yShift += dy / L.ch;
    redraw();
  });
  const release = e => {
    pts.delete(e.pointerId);
    if (pts.size < 2) pinchDist = 0;
    if (pts.size === 0) { dragging = false; cv.style.cursor = 'grab'; }
  };
  cv.addEventListener('pointerup', release);
  cv.addEventListener('pointercancel', release);
  // swallow the click that ends a drag, so it doesn't trigger page handlers
  cv.addEventListener('click', e => { if (moved) { e.stopPropagation(); e.preventDefault(); moved = false; } }, true);
}

function dist(pts) {
  const [a, b] = [...pts.values()];
  return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
}

/* ---- time axis ----------------------------------------------------------- */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const TICK_MIN = [1, 2, 3, 5, 10, 15, 30, 60, 120, 180, 240, 360, 720, 1440, 2880, 10080];
const pad2 = n => String(n).padStart(2, '0');

/**
 * Grid lines + labels at round local times (e.g. every 30m), spaced at least
 * `minPx` apart. Midnight is labelled with the date.
 */
function drawTimeAxis(ctx, data, i0, i1, X, { padL, cw, padT, ch, slot, minPx = 70 }) {
  const ms = candleMs(data);
  if (!ms || i1 < i0) return;
  const tick = (TICK_MIN.find(m => m * 60000 >= (minPx / slot) * ms) ?? TICK_MIN.at(-1)) * 60000;
  const key = t => Math.floor((t - new Date(t).getTimezoneOffset() * 60000) / tick);   // local-time buckets
  ctx.font = `9px ${FONT}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.lineWidth = 1;
  let prev = key(data[Math.max(0, i0 - 1)].t), lastX = -Infinity;
  for (let i = Math.max(1, i0); i <= i1; i++) {
    const k = key(data[i].t);
    if (k === prev) continue;
    prev = k;
    const x = X(i) - slot / 2;
    if (x < padL || x > padL + cw || x - lastX < minPx * 0.8) continue;
    lastX = x;
    const d = new Date(data[i].t);
    const midnight = d.getHours() === 0 && d.getMinutes() === 0;
    ctx.strokeStyle = THEME.grid;
    ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, padT + ch + 3); ctx.stroke();
    ctx.fillStyle = midnight ? THEME.ink : THEME.faint;
    ctx.fillText(midnight ? `${d.getDate()} ${MONTHS[d.getMonth()]}` : `${pad2(d.getHours())}:${pad2(d.getMinutes())}`, x, padT + ch + 11);
  }
  ctx.textAlign = 'start';
}

/** Higher-TF candles bucketed by time (so they match exchange candles), else by index. */
function overlayBuckets(data, factor) {
  const ms = candleMs(data);
  if (!ms) return aggregate(data, factor);
  const size = Math.round(ms * factor), out = [];
  let cur = null;
  data.forEach((d, i) => {
    const k = Math.floor(d.t / size);
    if (!cur || cur.k !== k) { cur = { k, o: d.o, h: d.h, l: d.l, c: d.c, start: i, span: 0 }; out.push(cur); }
    if (d.h > cur.h) cur.h = d.h;
    if (d.l < cur.l) cur.l = d.l;
    cur.c = d.c; cur.span++;
  });
  return out;
}

/* ---- candlesticks (full, with axes · TF overlay · last-price line) ------- */

export function candles(ctx, w, h, data, opt = {}) {
  if (!data || !data.length) return;
  const cv = ctx.canvas;
  const axis = opt.axis !== false, timeAxis = opt.timeAxis ?? axis;
  const padR = axis ? 46 : 6, padT = 10, padB = timeAxis ? 22 : 14, padL = 8;
  const cw = w - padL - padR, ch = h - padT - padB;
  const total = data.length;

  const { start, count } = viewWindow(cv, data);
  const slot = cw / count, bw = Math.max(1, slot * 0.6);
  const X = i => padL + (i - start + 0.5) * slot;
  const i0 = Math.max(0, Math.floor(start)), i1 = Math.min(total - 1, Math.ceil(start + count - 1));
  const visible = i1 >= i0 ? data.slice(i0, i1 + 1) : data.slice(i1 < 0 ? 0 : -1);

  let [lo, hi] = priceExtent(visible);
  const span = (hi - lo) || hi || 1;
  lo -= span * 0.08; hi += span * 0.08;
  const shift = (cv?.__zoom?.yShift || 0) * (hi - lo);
  lo += shift; hi += shift;
  const y = v => padT + ch - ((v - lo) / (hi - lo)) * ch;
  if (cv) { cv.__total = total; cv.__layout = { padL, slot, start, count, total, padT, ch, lo, hi, data }; }

  ctx.font = `9px ${FONT}`; ctx.textBaseline = 'middle';
  if (axis) {
    ctx.strokeStyle = THEME.grid; ctx.lineWidth = 1; ctx.fillStyle = THEME.faint;
    for (let i = 0; i <= 5; i++) {
      const yy = y(lo + (hi - lo) * i / 5);
      ctx.beginPath(); ctx.moveTo(padL, yy); ctx.lineTo(padL + cw, yy); ctx.stroke();
      ctx.fillText(formatPrice(lo + (hi - lo) * i / 5, opt), padL + cw + 6, yy);
    }
  }
  if (timeAxis) drawTimeAxis(ctx, data, i0, i1, X, { padL, cw, padT, ch, slot });

  // candles + overlay stay inside the plot while panning
  ctx.save();
  ctx.beginPath(); ctx.rect(padL, 0, cw, padT + ch); ctx.clip();
  const cc = getCandleColors();
  const style = { up: cc.baseUp, down: cc.baseDown, bg: THEME.bg, hollow: true };
  for (let i = i0; i <= i1; i++) drawCandle(ctx, X(i), bw, y, data[i], style);

  // higher-timeframe overlay (translucent, colors from the theme)
  if (opt.overlay > 1) {
    for (const d of overlayBuckets(data, opt.overlay)) {
      if (d.start + d.span - 1 < i0 || d.start > i1) continue;
      const x0 = X(d.start) - slot / 2, x1 = X(d.start + d.span - 1) + slot / 2, cx = (x0 + x1) / 2;
      const owb = Math.min((x1 - x0) * 0.7, (x1 - x0) - 2);
      const base = d.c >= d.o ? rgbPrefix(cc.overlayUp) : rgbPrefix(cc.overlayDown);
      ctx.strokeStyle = base + '.85)'; ctx.lineWidth = 1.4;
      ctx.beginPath(); ctx.moveTo(cx, y(d.h)); ctx.lineTo(cx, y(d.l)); ctx.stroke();
      const top = Math.min(y(d.o), y(d.c)), hg = Math.max(2, Math.abs(y(d.c) - y(d.o)));
      ctx.fillStyle = base + '.18)'; ctx.fillRect(cx - owb / 2, top, owb, hg);
      ctx.strokeStyle = base + '.9)'; ctx.strokeRect(cx - owb / 2, top, owb, hg);
    }
  }
  ctx.restore();

  // last-price guide + axis tag (latest candle, even when panned away from it)
  if (opt.last !== false) {
    const last = data[total - 1].c, ly = y(last);
    if (ly >= padT && ly <= padT + ch) {
      ctx.strokeStyle = hexA(THEME.amber, 0.5); ctx.setLineDash([3, 3]); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(padL, ly); ctx.lineTo(padL + cw, ly); ctx.stroke();
      ctx.setLineDash([]);
    }
    if (axis) {
      const ty = clampN(ly, padT + 8, padT + ch - 8);
      ctx.fillStyle = THEME.amber; ctx.fillRect(padL + cw + 2, ty - 8, 42, 16);
      ctx.fillStyle = THEME.bg; ctx.font = `700 9px ${FONT}`;
      ctx.fillText(formatPrice(last, opt), padL + cw + 5, ty);
    }
  }
}

export function miniCandles(ctx, w, h, data, opt = {}) {
  if (!data || !data.length) return;
  const padT = 4, padB = opt.timeAxis ? 18 : 4, ch = h - padT - padB;
  let [lo, hi] = priceExtent(data);
  const span = (hi - lo) || hi || 1;
  lo -= span * 0.06; hi += span * 0.06;
  const y = v => padT + ch - ((v - lo) / (hi - lo)) * ch;
  const slot = w / data.length, bw = Math.max(1, slot * 0.62);
  if (ctx.canvas) ctx.canvas.__layout = { padL: 0, slot, start: 0, count: data.length, total: data.length, padT, ch, lo, hi, data };
  if (opt.timeAxis) drawTimeAxis(ctx, data, 0, data.length - 1, i => (i + 0.5) * slot, { padL: 0, cw: w, padT, ch, slot, minPx: 48 });
  const cc = getCandleColors();
  const style = { up: cc.baseUp, down: cc.baseDown, bg: THEME.bg, hollow: false };
  data.forEach((d, i) => drawCandle(ctx, slot * i + slot / 2, bw, y, d, style));
}

/* ---- accuracy curve (area + line, 0–100%) ------------------------------- */

export function curve(ctx, w, h, pts, opt = {}) {
  if (!pts || pts.length < 2) return;
  const padL = 34, padR = 12, padT = 14, padB = 20;
  const cw = w - padL - padR, ch = h - padT - padB;
  const lo = opt.min != null ? opt.min : 0, hi = opt.max != null ? opt.max : 100;
  const x = i => padL + cw * (i / (pts.length - 1));
  const y = v => padT + ch - ((v - lo) / (hi - lo)) * ch;
  const col = opt.color || THEME.teal;

  ctx.font = `9px ${FONT}`; ctx.textBaseline = 'middle';
  [0, 25, 50, 75, 100].forEach(v => {
    const yy = y(v);
    ctx.strokeStyle = v === 50 ? hexA(THEME.dim, 0.18) : THEME.grid;
    ctx.setLineDash(v === 50 ? [3, 3] : []); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(padL, yy); ctx.lineTo(padL + cw, yy); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = THEME.faint; ctx.textAlign = 'right'; ctx.fillText(v + '%', padL - 6, yy);
  });
  ctx.textAlign = 'left';

  const trace = () => {
    ctx.beginPath(); ctx.moveTo(x(0), y(pts[0].v));
    for (let i = 1; i < pts.length; i++) ctx.lineTo(x(i), y(pts[i].v));
  };
  const g = ctx.createLinearGradient(0, padT, 0, padT + ch);
  g.addColorStop(0, hexA(col, 0.28)); g.addColorStop(1, hexA(col, 0));
  trace();
  ctx.lineTo(x(pts.length - 1), padT + ch); ctx.lineTo(x(0), padT + ch); ctx.closePath();
  ctx.fillStyle = g; ctx.fill();

  trace();
  ctx.strokeStyle = col; ctx.lineWidth = 2; ctx.lineJoin = 'round'; ctx.stroke();

  const lx = x(pts.length - 1), ly = y(pts[pts.length - 1].v);
  ctx.fillStyle = col; ctx.beginPath(); ctx.arc(lx, ly, 3.2, 0, 7); ctx.fill();
  ctx.strokeStyle = THEME.bg; ctx.lineWidth = 1.4; ctx.stroke();
}

/* ---- calibration scatter (confidence vs. outcome) ----------------------- */

export function scatter(ctx, w, h, pts, opt = {}) {
  const padL = 38, padR = 14, padT = 14, padB = 30;
  const cw = w - padL - padR, ch = h - padT - padB;
  const X = v => padL + cw * (v - 40) / 55;   // x-axis: 40..95 confidence
  const Y = v => padT + ch - (v / 100) * ch;  // y-axis: 0..100 outcome

  ctx.strokeStyle = THEME.grid; ctx.lineWidth = 1; ctx.strokeRect(padL, padT, cw, ch);
  ctx.font = `9px ${FONT}`; ctx.fillStyle = THEME.faint;
  ctx.textBaseline = 'middle'; ctx.textAlign = 'right';
  [0, 50, 100].forEach(v => {
    const yy = Y(v); ctx.fillText(v + '%', padL - 6, yy);
    ctx.strokeStyle = THEME.grid;
    ctx.beginPath(); ctx.moveTo(padL, yy); ctx.lineTo(padL + cw, yy); ctx.stroke();
  });
  ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  [40, 55, 70, 85, 95].forEach(v => ctx.fillText(v + '%', X(v), padT + ch + 8));

  // perfect-calibration diagonal (outcome === confidence)
  ctx.strokeStyle = hexA(THEME.dim, 0.4); ctx.setLineDash([4, 4]); ctx.lineWidth = 1.2;
  ctx.beginPath(); ctx.moveTo(X(40), Y(40)); ctx.lineTo(X(95), Y(95)); ctx.stroke();
  ctx.setLineDash([]);

  // points — jitter so binary outcomes don't perfectly stack
  let js = 1;
  const jit = () => { js = (js * 1664525 + 1013904223) & 0xffffffff; return ((js >>> 0) / 0xffffffff - 0.5) * 7; };
  (pts || []).forEach(p => {
    ctx.fillStyle = hexA(verdictColor[p.verdict] || THEME.dim, 0.85);
    ctx.beginPath(); ctx.arc(X(p.x) + jit(), Y(p.y) + jit(), 3.1, 0, 7); ctx.fill();
  });

  // binned actual-outcome line
  if (opt.bins && opt.bins.length) {
    ctx.beginPath();
    opt.bins.forEach((b, i) => (i ? ctx.lineTo(X(b.x), Y(b.y)) : ctx.moveTo(X(b.x), Y(b.y))));
    ctx.strokeStyle = THEME.ink; ctx.lineWidth = 2; ctx.stroke();
    opt.bins.forEach(b => {
      ctx.fillStyle = THEME.ink; ctx.beginPath(); ctx.arc(X(b.x), Y(b.y), 3, 0, 7); ctx.fill();
      ctx.strokeStyle = THEME.bg; ctx.lineWidth = 1.3; ctx.stroke();
    });
  }
}

/* ---- horizontal-bar color ramp (sessions / setups) ---------------------- */

export function barColor(v) {
  return v >= 66 ? THEME.teal : v >= 50 ? THEME.amber : THEME.rose;
}

/* ---- classic-script fallback ------------------------------------------- */

if (typeof window !== 'undefined') {
  window.Charts = {
    THEME, verdictColor, hexA, formatPrice, aggregate,
    register, unregister, refreshAll, redraw, enableZoom,
    indexToX, xToIndex, visibleRange, pointAt,
    candles, miniCandles, curve, scatter, barColor,
  };
}
