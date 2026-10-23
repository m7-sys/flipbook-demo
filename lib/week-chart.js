/* ============================================================================
   FlipBook · week chart  (app/www/lib/week-chart.js)
   ----------------------------------------------------------------------------
   One trading week on a fixed frame: Monday 06:00 → next Monday 06:00 (UTC+8)
   across, a given price range down. Draws the candles that exist so far, the
   noted ranges as coloured bands, a reference price, a "now" marker, and
   drawings:
     box    a price/time zone          up / down   a trend line with an arrow
     set    a sharp spike out and back (drag to the tip; it returns to the start price)
     trend  a plain trend line         hline       a horizontal level (click a price)

     const wc = createWeekChart(canvas, { start, editable: true, onShapes, onSelect });
     // onShapes(shapes, added): added is true when a new drawing was just made
     // After drawing, the tool returns to select (onTool('select')). Select a drawing
     // to move it (drag its body) or resize it (drag its round handles).
     wc.set({ candles, frame: { lo, hi }, notes, shapes, refPrice, ghost });
     wc.setTool('box'); wc.deleteSelected(); wc.undo();
   ========================================================================== */

import * as Charts from './chart-engine.js';
import { THEME, hexA, formatPrice, FONT } from './chart-engine.js';
import { getCandleColors } from './chart-theme.js';
import { WEEK, HOUR, DAY, parts8, fmtDayTime } from './trading-week.js';

/** Plot padding; the range slider lines up with the plot using the same values. */
export const PAD = { l: 8, r: 54, t: 12, b: 22 };
export const NOTE_COLORS = ['#39d3c3', '#e8b84b', '#7aa2ff', '#e8584b', '#b48cff', '#5fd38d'];
/** Drawing tools: id → [button label, tooltip]. Views pick a set. */
export const TOOLS = {
  select: ['↖', 'Select (then Delete to remove)'],
  box: ['▭ Box', 'Box: a price zone over a stretch of time'],
  up: ['↗ Up', 'Trend line up'],
  down: ['↘ Down', 'Trend line down'],
  set: ['⋀ Set', 'Set: a sharp spike out and back. Drag from the start to the tip'],
  trend: ['╱ Trend', 'Trend line: drag from one point to another'],
  hline: ['― Level', 'Horizontal line: click a price'],
};
export const PREDICT_TOOLS = ['select', 'box', 'up', 'down', 'set'];
export const MARK_TOOLS = ['select', 'trend', 'hline'];
const STROKE = { box: '#9aa6b2', up: THEME.teal, down: THEME.rose, set: THEME.amber, trend: '#d6dde4', hline: '#b48cff' };
const HIT_PX = 7;
/** Weekend starts Sat 05:00 UTC+8: 4 days 23 hours after the Mon 06:00 week start. */
export const WEEKEND_OFFSET = 4 * DAY + 23 * HOUR;

/**
 * Resize handles per drawing type, as [point for time, point for price]:
 * a box has four corners, lines and sets their two defining points, a level none.
 */
const HANDLES = {
  box: [['a', 'a'], ['b', 'b'], ['a', 'b'], ['b', 'a']],
  hline: [],
};
const handlesOf = s => HANDLES[s.type] || [['a', 'a'], ['b', 'b']];

/** The three corners of a set: start, tip, and back to the start price as far past the tip. */
const setPoints = s => [s.a, s.b, { t: s.b.t + (s.b.t - s.a.t), price: s.a.price }];

function segDist(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y, len2 = dx * dx + dy * dy;
  const k = len2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2)) : 0;
  return Math.hypot(p.x - (a.x + k * dx), p.y - (a.y + k * dy));
}

export function createWeekChart(canvas, { start, editable = false, idleHint = '', onShapes = () => {}, onSelect = () => {}, onTool = () => {} } = {}) {
  const st = {
    start, candles: [], tfMs: HOUR, frame: null, dp: 4,
    notes: [], focusNote: null, draft: null,       // bands
    shapes: [], ghost: [], refPrice: null, message: '', flash: '',
    tool: 'select', selected: null, preview: null,
  };
  let L = null;   // last layout, for pointer → time/price

  /** The price range on screen: the given frame, else fitted to the candles. */
  function frame() {
    if (st.frame) return st.frame;
    if (!st.candles.length) return null;
    let lo = Infinity, hi = -Infinity;
    for (const c of st.candles) { if (c.l < lo) lo = c.l; if (c.h > hi) hi = c.h; }
    const pad = (hi - lo || hi * 0.02) * 0.08;
    return { lo: lo - pad, hi: hi + pad };
  }

  function draw(ctx, w, h) {
    const cw = w - PAD.l - PAD.r, ch = h - PAD.t - PAD.b, fr = frame();
    const X = t => PAD.l + ((t - st.start) / WEEK) * cw;
    const Y = p => PAD.t + ch - ((p - fr.lo) / (fr.hi - fr.lo)) * ch;
    L = { cw, ch, fr, X, Y };
    ctx.font = `9px ${FONT}`; ctx.textBaseline = 'middle'; ctx.lineWidth = 1;

    // days: a line at each UTC+8 midnight, the day's name in its stretch
    const p0 = parts8(st.start);
    const firstMidnight = st.start - p0.h * HOUR - p0.min * 60_000 + DAY;
    ctx.textAlign = 'center';
    for (let t = firstMidnight - DAY; t < st.start + WEEK; t += DAY) {
      const a = Math.max(t, st.start), b = Math.min(t + DAY, st.start + WEEK);
      if (t >= st.start) {
        ctx.strokeStyle = THEME.line;
        ctx.beginPath(); ctx.moveTo(X(t), PAD.t); ctx.lineTo(X(t), PAD.t + ch + 4); ctx.stroke();
      }
      if (X(b) - X(a) > 28) {
        ctx.fillStyle = THEME.dim;
        ctx.fillText(fmtDayTime(a, { time: false }), (X(a) + X(b)) / 2, PAD.t + ch + 12);
      }
    }
    ctx.textAlign = 'start';

    // weekend start, Sat 05:00 (UTC+8)
    const xw = X(st.start + WEEKEND_OFFSET);
    ctx.strokeStyle = hexA('#7aa2ff', 0.75); ctx.setLineDash([5, 4]);
    ctx.beginPath(); ctx.moveTo(xw, PAD.t); ctx.lineTo(xw, PAD.t + ch); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = '#7aa2ff'; ctx.font = `700 8.5px ${FONT}`;
    ctx.fillText('WEEKEND · SAT 05:00', xw + 5, PAD.t + 8);
    ctx.font = `9px ${FONT}`;

    if (fr) {
      ctx.strokeStyle = THEME.grid; ctx.fillStyle = THEME.faint;
      for (let i = 0; i <= 4; i++) {
        const v = fr.lo + ((fr.hi - fr.lo) * i) / 4, y = Y(v);
        ctx.beginPath(); ctx.moveTo(PAD.l, y); ctx.lineTo(PAD.l + cw, y); ctx.stroke();
        ctx.fillText(formatPrice(v, { dp: st.dp }), PAD.l + cw + 6, y);
      }
    }

    ctx.save();
    ctx.beginPath(); ctx.rect(PAD.l, 0, cw, PAD.t + ch); ctx.clip();

    // noted ranges (numbered in time order, like the boxes under the chart)
    st.notes.slice().sort((a, b) => a.start - b.start).forEach((n, k) => {
      const col = NOTE_COLORS[n.color % NOTE_COLORS.length], x0 = X(n.start), x1 = X(n.end);
      ctx.fillStyle = hexA(col, n.id === st.focusNote ? 0.24 : 0.1);
      ctx.fillRect(x0, PAD.t, x1 - x0, ch);
      ctx.fillStyle = col; ctx.fillRect(x0, PAD.t, x1 - x0, 2);
      ctx.font = `700 10px ${FONT}`; ctx.fillText(String(k + 1), x0 + 4, PAD.t + 10);
      ctx.font = `9px ${FONT}`;
    });
    if (st.draft) {
      const x0 = X(st.draft.start), x1 = X(st.draft.end);
      ctx.fillStyle = hexA(THEME.ink, 0.05); ctx.fillRect(x0, PAD.t, x1 - x0, ch);
      ctx.strokeStyle = hexA(THEME.ink, 0.5); ctx.setLineDash([4, 3]);
      ctx.strokeRect(x0 + 0.5, PAD.t + 0.5, x1 - x0 - 1, ch - 1); ctx.setLineDash([]);
    }

    if (fr) {
      // candles
      const cc = getCandleColors(), bw = Math.max(1, (cw * st.tfMs / WEEK) * 0.62);
      for (const c of st.candles) {
        const x = X(c.t + st.tfMs / 2), col = c.c >= c.o ? cc.baseUp : cc.baseDown;
        ctx.strokeStyle = col; ctx.fillStyle = col;
        ctx.beginPath(); ctx.moveTo(x, Y(c.h)); ctx.lineTo(x, Y(c.l)); ctx.stroke();
        const top = Math.min(Y(c.o), Y(c.c));
        ctx.fillRect(x - bw / 2, top, bw, Math.max(1, Math.abs(Y(c.c) - Y(c.o))));
      }
      if (st.refPrice != null) {
        const y = Y(st.refPrice);
        ctx.strokeStyle = hexA(THEME.amber, 0.55); ctx.setLineDash([3, 3]);
        ctx.beginPath(); ctx.moveTo(PAD.l, y); ctx.lineTo(PAD.l + cw, y); ctx.stroke(); ctx.setLineDash([]);
      }
      for (const s of st.ghost) drawShape(ctx, s, 0.4);
      for (const s of st.shapes) drawShape(ctx, s, 1, s.id === st.selected);
      if (st.preview) drawShape(ctx, st.preview, 0.8);
    }

    const now = Date.now();
    if (now > st.start && now < st.start + WEEK) {
      ctx.strokeStyle = hexA(THEME.amber, 0.7); ctx.setLineDash([2, 3]);
      ctx.beginPath(); ctx.moveTo(X(now), PAD.t); ctx.lineTo(X(now), PAD.t + ch); ctx.stroke(); ctx.setLineDash([]);
    }
    ctx.restore();

    if (fr) for (const s of st.shapes) {    // level tags on the axis
      if (s.type !== 'hline') continue;
      const y = Y(s.a.price);
      if (y < PAD.t || y > PAD.t + ch) continue;
      ctx.fillStyle = STROKE.hline; ctx.fillRect(PAD.l + cw + 2, y - 7, PAD.r - 4, 14);
      ctx.fillStyle = THEME.bg; ctx.font = `700 9px ${FONT}`;
      ctx.fillText(formatPrice(s.a.price, { dp: st.dp }), PAD.l + cw + 5, y);
    }
    if (fr && st.refPrice != null) {        // reference price tag on the axis
      const y = Math.max(PAD.t + 8, Math.min(PAD.t + ch - 8, Y(st.refPrice)));
      ctx.fillStyle = THEME.amber; ctx.fillRect(PAD.l + cw + 2, y - 8, PAD.r - 4, 16);
      ctx.fillStyle = THEME.bg; ctx.font = `700 9px ${FONT}`;
      ctx.fillText(formatPrice(st.refPrice, { dp: st.dp }), PAD.l + cw + 5, y);
    }
    if (st.message) {
      ctx.fillStyle = THEME.faint; ctx.font = `12px ${FONT}`; ctx.textAlign = 'center';
      ctx.fillText(st.message, PAD.l + cw / 2, PAD.t + ch / 2);
      ctx.textAlign = 'start';
    }
    if (st.flash) {                          // a short hint, e.g. "pick a tool first"
      ctx.font = `600 11.5px ${FONT}`;
      const tw = ctx.measureText(st.flash).width + 24, x = PAD.l + (cw - tw) / 2, y = PAD.t + 10;
      ctx.fillStyle = hexA(THEME.bg, 0.92); ctx.strokeStyle = THEME.teal; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.roundRect?.(x, y, tw, 26, 8); ctx.fill(); ctx.stroke();
      ctx.fillStyle = THEME.ink; ctx.textAlign = 'center'; ctx.fillText(st.flash, x + tw / 2, y + 13);
      ctx.textAlign = 'start';
    }
  }

  function drawShape(ctx, s, alpha, selected = false) {
    const P = q => ({ x: L.X(q.t), y: L.Y(q.price) });
    const col = STROKE[s.type];
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = col; ctx.lineWidth = selected ? 2.2 : 1.6;
    const a = P(s.a), b = P(s.b);
    if (s.type === 'box') {
      ctx.fillStyle = hexA(col, 0.1);
      ctx.fillRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
      ctx.strokeRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
    } else if (s.type === 'set') {
      const pts = setPoints(s).map(P);
      ctx.beginPath(); pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y))); ctx.stroke();
    } else if (s.type === 'hline') {
      ctx.beginPath(); ctx.moveTo(PAD.l, a.y); ctx.lineTo(PAD.l + L.cw, a.y); ctx.stroke();
    } else {
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    }
    if (s.type === 'up' || s.type === 'down') {
      const ang = Math.atan2(b.y - a.y, b.x - a.x), len = 9;
      ctx.fillStyle = col; ctx.beginPath(); ctx.moveTo(b.x, b.y);
      ctx.lineTo(b.x - len * Math.cos(ang - 0.4), b.y - len * Math.sin(ang - 0.4));
      ctx.lineTo(b.x - len * Math.cos(ang + 0.4), b.y - len * Math.sin(ang + 0.4));
      ctx.closePath(); ctx.fill();
    }
    if (selected) for (const [kt, kp] of handlesOf(s)) {
      const x = L.X(s[kt].t), y = L.Y(s[kp].price);
      ctx.fillStyle = THEME.bg; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(x, y, 4.5, 0, 7); ctx.fill(); ctx.stroke();
    }
    ctx.globalAlpha = 1; ctx.lineWidth = 1;
  }

  const redraw = () => Charts.redraw(canvas);
  Charts.register(canvas, draw);

  /* ---- drawing interaction ---- */
  function at(e) {
    if (!L?.fr) return null;
    const r = canvas.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
    const t = st.start + ((x - PAD.l) / L.cw) * WEEK;
    return {
      x, y,
      t: Math.round(Math.max(st.start, Math.min(st.start + WEEK, t))),
      price: L.fr.hi - ((y - PAD.t) / L.ch) * (L.fr.hi - L.fr.lo),
    };
  }
  function hit(p) {
    const P = q => ({ x: L.X(q.t), y: L.Y(q.price) });
    for (const s of st.shapes.slice().reverse()) {
      const a = P(s.a), b = P(s.b);
      let d;
      if (s.type === 'box') {
        const inside = p.x >= Math.min(a.x, b.x) && p.x <= Math.max(a.x, b.x) && p.y >= Math.min(a.y, b.y) && p.y <= Math.max(a.y, b.y);
        d = inside ? 0 : Infinity;
      } else if (s.type === 'set') {
        const [q0, q1, q2] = setPoints(s).map(P);
        d = Math.min(segDist(p, q0, q1), segDist(p, q1, q2));
      } else if (s.type === 'hline') d = Math.abs(p.y - a.y);
      else d = segDist(p, a, b);
      if (d <= HIT_PX) return s;
    }
    return null;
  }

  /** The handle of the selected drawing under p, if any. */
  function handleAt(p) {
    const s = st.shapes.find(x => x.id === st.selected); if (!s) return null;
    const h = handlesOf(s).find(([kt, kp]) => Math.hypot(p.x - L.X(s[kt].t), p.y - L.Y(s[kp].price)) <= HIT_PX + 3);
    return h ? { shape: s, h } : null;
  }
  const clampT = t => Math.max(st.start, Math.min(st.start + WEEK, t));

  if (editable) {
    // gesture: { kind: 'draw' | 'resize' | 'move', shape, h?, from, orig?, changed }
    let g = null;
    canvas.addEventListener('pointerdown', e => {
      if (e.button > 0) return;
      const p = at(e);
      if (!p) return flashHint(st.message || 'Prices are still loading');
      const grab = handleAt(p);
      const body = !grab && st.tool === 'select' ? hit(p) : null;
      if (grab || body) {                                   // resize by a handle, or move the whole drawing
        const shape = grab?.shape || body;
        st.selected = shape.id; onSelect();
        g = grab ? { kind: 'resize', shape, h: grab.h, from: p }
          : { kind: 'move', shape, from: p, orig: { a: { ...shape.a }, b: { ...shape.b } } };
      } else if (st.tool === 'select') {
        const had = st.selected; st.selected = null;
        setTouch();
        if (had) redraw(); else if (idleHint) flashHint(idleHint);
        return;
      } else {
        onSelect();
        g = { kind: 'draw', from: p, shape: { type: st.tool, a: { t: p.t, price: p.price }, b: { t: p.t, price: p.price } } };
        st.preview = g.shape;
      }
      e.preventDefault();
      canvas.setPointerCapture?.(e.pointerId);
      setTouch();
      redraw();
    });

    canvas.addEventListener('pointermove', e => {
      const p = at(e);
      if (!g) {                                             // hover: show what a press would do
        if (!p) return;
        canvas.style.cursor = handleAt(p) ? 'grab' : st.tool !== 'select' ? 'crosshair' : hit(p) ? 'move' : 'default';
        return;
      }
      if (!p) return;
      const s = g.shape;
      if (g.kind === 'draw') {
        s.b = { t: p.t, price: p.price };
        if (s.type === 'hline') s.a = { ...s.b };            // a level follows the pointer
      } else if (g.kind === 'resize') {
        const [kt, kp] = g.h;
        s[kt].t = p.t; s[kp].price = p.price;
      } else {
        // move: shift both points, keeping the drawing inside the week
        let dt = p.t - g.from.t;
        const ts = [g.orig.a.t, g.orig.b.t];
        dt = Math.max(st.start - Math.min(...ts), Math.min(st.start + WEEK - Math.max(...ts), dt));
        const dp = p.price - g.from.price;
        for (const k of ['a', 'b']) s[k] = { t: s.type === 'hline' ? g.orig[k].t : clampT(g.orig[k].t + dt), price: g.orig[k].price + dp };
      }
      g.changed = true;
      redraw();
    });

    const finish = e => {
      if (!g) return;
      const done = g; g = null;
      if (done.kind === 'draw') {
        st.preview = null;
        const p = at(e) || done.from, s = done.shape;
        if (s.type === 'hline' || Math.hypot(p.x - L.X(s.a.t), p.y - L.Y(s.a.price)) >= 6) {
          const id = `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
          st.shapes = [...st.shapes, { id, ...s }];
          st.selected = id;
          onShapes(st.shapes, true);
          setTool('select'); onTool('select');                // ready to move or resize what was just drawn
        }
      } else if (done.changed) onShapes(st.shapes, false);
      setTouch();
      redraw();
    };
    canvas.addEventListener('pointerup', finish);
    canvas.addEventListener('pointercancel', () => { if (g?.kind === 'draw') st.preview = null; g = null; redraw(); });
  }

  let flashTimer = null;
  function flashHint(text) {
    st.flash = text; redraw();
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => { st.flash = ''; redraw(); }, 2200);
  }

  /** Touch: the page can scroll over the chart unless a tool is armed or a drawing is selected. */
  function setTouch() { canvas.style.touchAction = st.tool === 'select' && !st.selected ? 'pan-y' : 'none'; }
  function setTool(tool) {
    st.tool = tool;
    setTouch();
    canvas.style.cursor = tool === 'select' ? 'default' : 'crosshair';
  }
  setTool('select');

  return {
    set(patch) { Object.assign(st, patch); redraw(); },
    setTool,
    frame,
    deleteSelected() {
      if (!st.selected) return false;
      st.shapes = st.shapes.filter(s => s.id !== st.selected); st.selected = null;
      onShapes(st.shapes); redraw(); return true;
    },
    undo() { if (!st.shapes.length) return; st.shapes = st.shapes.slice(0, -1); st.selected = null; onShapes(st.shapes); redraw(); },
    clearShapes() { st.shapes = []; st.selected = null; onShapes(st.shapes); redraw(); },
    deselect() { if (st.selected) { st.selected = null; setTouch(); redraw(); } },
    count: () => st.shapes.length,
  };
}
