/* ============================================================================
   FlipBook · week chart  (app/www/lib/week-chart.js)
   ----------------------------------------------------------------------------
   One trading week on a fixed frame: Monday 06:00 → next Monday 06:00 (UTC+8)
   across, a given price range down. Draws the candles that exist so far, the
   noted ranges as coloured bands, a reference price, a "now" marker, and
   prediction shapes:
     box    a price/time zone          up / down   a trend line with an arrow
     set    a sharp spike out and back (drag to the tip; it returns to the start price)

     const wc = createWeekChart(canvas, { start, editable: true, onShapes });
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
export const TOOLS = [
  ['select', '↖', 'Select (then Delete to remove)'],
  ['box', '▭ Box', 'Box: a price zone over a stretch of time'],
  ['up', '↗ Up', 'Trend line up'],
  ['down', '↘ Down', 'Trend line down'],
  ['set', '⋀ Set', 'Set: a sharp spike out and back. Drag from the start to the tip'],
];
const STROKE = { box: '#9aa6b2', up: THEME.teal, down: THEME.rose, set: THEME.amber };
const HIT_PX = 7;

/** The three corners of a set: start, tip, and back to the start price as far past the tip. */
const setPoints = s => [s.a, s.b, { t: s.b.t + (s.b.t - s.a.t), price: s.a.price }];

function segDist(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y, len2 = dx * dx + dy * dy;
  const k = len2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2)) : 0;
  return Math.hypot(p.x - (a.x + k * dx), p.y - (a.y + k * dy));
}

export function createWeekChart(canvas, { start, editable = false, onShapes = () => {} } = {}) {
  const st = {
    start, candles: [], tfMs: HOUR, frame: null, dp: 4,
    notes: [], focusNote: null, draft: null,       // bands
    shapes: [], ghost: [], refPrice: null, message: '',
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
    } else {
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      const ang = Math.atan2(b.y - a.y, b.x - a.x), len = 9;
      ctx.fillStyle = col; ctx.beginPath(); ctx.moveTo(b.x, b.y);
      ctx.lineTo(b.x - len * Math.cos(ang - 0.4), b.y - len * Math.sin(ang - 0.4));
      ctx.lineTo(b.x - len * Math.cos(ang + 0.4), b.y - len * Math.sin(ang + 0.4));
      ctx.closePath(); ctx.fill();
    }
    if (selected) for (const p of [a, b]) {
      ctx.fillStyle = THEME.bg; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(p.x, p.y, 4, 0, 7); ctx.fill(); ctx.stroke();
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
      } else d = segDist(p, a, b);
      if (d <= HIT_PX) return s;
    }
    return null;
  }

  if (editable) {
    let down = null;
    canvas.addEventListener('pointerdown', e => {
      if (e.button > 0) return;
      const p = at(e); if (!p) return;
      if (st.tool === 'select') { st.selected = hit(p)?.id ?? null; return redraw(); }
      e.preventDefault();
      canvas.setPointerCapture?.(e.pointerId);
      down = p;
      st.preview = { type: st.tool, a: { t: p.t, price: p.price }, b: { t: p.t, price: p.price } };
      redraw();
    });
    canvas.addEventListener('pointermove', e => {
      if (!st.preview || !down) {
        if (st.tool === 'select' && L?.fr) { const p = at(e); canvas.style.cursor = p && hit(p) ? 'pointer' : 'default'; }
        return;
      }
      const p = at(e); if (!p) return;
      st.preview.b = { t: p.t, price: p.price };
      redraw();
    });
    const finish = e => {
      if (!st.preview || !down) return;
      const p = at(e) || down, shape = st.preview;
      st.preview = null; down = null;
      if (Math.hypot(p.x - L.X(shape.a.t), p.y - L.Y(shape.a.price)) >= 6) {
        const id = `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
        st.shapes = [...st.shapes, { id, ...shape }];
        st.selected = id;
        onShapes(st.shapes);
      }
      redraw();
    };
    canvas.addEventListener('pointerup', finish);
    canvas.addEventListener('pointercancel', () => { st.preview = null; down = null; redraw(); });
  }

  function setTool(tool) {
    st.tool = tool;
    canvas.style.touchAction = tool === 'select' ? 'pan-y' : 'none';
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
  };
}
