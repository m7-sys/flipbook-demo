/* ============================================================================
   FlipBook · trendlines  (app/www/lib/trendlines.js)
   ----------------------------------------------------------------------------
   Lines anchored to time and price, saved per coin on this device. Because
   they're anchored in time, a line drawn on one chart also shows on every
   other chart whose window covers it, with a faint projection to the right.

     Draw   turn the tool on, then drag across the chart (or click two points)
     Edit   click a line to select it; drag either end to adjust it
     Delete select a line and press Delete / Backspace

     const tl = createTrendlines({ getSymbol, canEdit, onChange, onModeChange });
     tl.attach(canvas, panelIndex);   // after Charts.enableZoom on that canvas
     Charts.candles(ctx, w, h, data, { lines: tl.lines() });
   ========================================================================== */

import { valueAt, toScreen } from './chart-engine.js';

const KEY = 'flipbook.trendlines.v1';
const HIT_PX = 7;         // how close a click must be to grab a line or an end
const DRAG_PX = 5;        // movement that turns a press into a drag-to-draw

function readAll() { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch { return {}; } }
const newId = () => `l${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;

/** Distance from p to segment ab, in pixels. */
function segDist(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y, len2 = dx * dx + dy * dy;
  const k = len2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2)) : 0;
  return Math.hypot(p.x - (a.x + k * dx), p.y - (a.y + k * dy));
}

export function createTrendlines({ getSymbol, canEdit = () => true, onChange = () => {}, onModeChange = () => {} }) {
  const all = readAll();
  let drawing = false, selected = null;
  let gesture = null;       // { kind: 'draw'|'end', line, key, x0, y0, moved, cv }
  let suppressClick = false;

  const list = () => all[getSymbol()] || [];
  const save = () => {
    const sym = getSymbol();
    if (all[sym] && !all[sym].length) delete all[sym];
    try { localStorage.setItem(KEY, JSON.stringify(all)); } catch { /* quota */ }
  };
  const changed = () => onChange();

  function setDrawing(on) {
    if (!on && gesture?.kind === 'draw') gesture = null;
    if (drawing === on) return changed();
    drawing = on;
    if (on) selected = null;
    onModeChange(on);
    changed();
  }

  /** Line + end under a client point on this canvas. */
  function hit(cv, e) {
    const r = cv.getBoundingClientRect(), p = { x: e.clientX - r.left, y: e.clientY - r.top };
    let best = null;
    for (const ln of list()) {
      const a = toScreen(cv, ln.a.t, ln.a.price), b = toScreen(cv, ln.b.t, ln.b.price);
      if (!a || !b) continue;
      for (const [key, q] of [['a', a], ['b', b]]) {
        const d = Math.hypot(p.x - q.x, p.y - q.y);
        if (d <= HIT_PX && (!best || d < best.d)) best = { line: ln, key, d };
      }
      const d = segDist(p, a, b);
      if (!best && d <= HIT_PX) best = { line: ln, key: null, d };
    }
    return best;
  }

  function commit() {
    const { line } = gesture;
    gesture = null;
    const a = toScreen(line.cv, line.a.t, line.a.price), b = toScreen(line.cv, line.b.t, line.b.price);
    if (a && b && Math.hypot(a.x - b.x, a.y - b.y) >= HIT_PX) {
      const sym = getSymbol();
      (all[sym] ||= []).push({ id: line.id, a: line.a, b: line.b });
      selected = line.id;
      save();
    }
    setDrawing(false);
  }

  function onMove(e) {
    if (!gesture) return;
    const pt = valueAt(gesture.cv, e.clientX, e.clientY); if (!pt) return;
    if (Math.abs(e.clientX - gesture.x0) + Math.abs(e.clientY - gesture.y0) > DRAG_PX) gesture.moved = true;
    gesture.line[gesture.key] = pt;
    changed();
  }
  function onUp() {
    if (!gesture) return;
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onUp);
    if (gesture.kind === 'end') { gesture = null; save(); changed(); return; }
    if (gesture.moved) commit();
    else gesture.clicked = true;      // click-click: the next press sets the second point
  }
  function track() {
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  }

  /** Wire a chart canvas; `i` is its panel index, checked against canEdit(i). */
  function attach(cv, i) {
    const wrap = cv.parentElement;
    // capture phase on the wrapper runs before the canvas's own pan/zoom handlers
    wrap.addEventListener('pointerdown', e => {
      if (e.button > 0 || e.target !== cv || !canEdit(i)) return;
      const pt = valueAt(cv, e.clientX, e.clientY); if (!pt) return;
      if (drawing) {
        e.stopPropagation(); e.preventDefault(); suppressClick = true;
        if (gesture?.clicked && gesture.cv === cv) { gesture.line.b = pt; commit(); return; }
        gesture = { kind: 'draw', key: 'b', cv, x0: e.clientX, y0: e.clientY, moved: false,
          line: { id: newId(), a: pt, b: { ...pt }, cv } };
        return track();
      }
      const h = hit(cv, e);
      if (h) {
        e.stopPropagation(); e.preventDefault(); suppressClick = true;
        selected = h.line.id;
        if (h.key) { gesture = { kind: 'end', key: h.key, cv, x0: e.clientX, y0: e.clientY, line: h.line }; track(); }
        return changed();
      }
      if (selected) { selected = null; changed(); }
    }, true);
    wrap.addEventListener('pointermove', e => {
      if (gesture?.clicked && gesture.cv === cv) onMove(e);       // preview follows the pointer between clicks
      else if (!drawing && !gesture && !e.buttons && canEdit(i)) {
        const h = hit(cv, e);
        cv.style.cursor = h?.key ? 'move' : h ? 'pointer' : 'grab';
      }
    });
    for (const type of ['click', 'dblclick']) {
      wrap.addEventListener(type, e => {
        if (suppressClick || drawing) { e.stopPropagation(); e.preventDefault(); }
        if (type === 'click') suppressClick = false;
      }, true);
    }
  }

  return {
    attach,
    isDrawing: () => drawing,
    setDrawing,
    /** Lines to draw for the coin on screen, plus the one being drawn. */
    lines() {
      const out = list().map(ln => (ln.id === selected ? { ...ln, selected: true } : ln));
      if (gesture?.kind === 'draw') out.push({ a: gesture.line.a, b: gesture.line.b, preview: true });
      return out;
    },
    /** Esc: stop drawing or drop the selection. Returns whether anything changed. */
    cancel() {
      if (drawing) { setDrawing(false); return true; }
      if (selected) { selected = null; changed(); return true; }
      return false;
    },
    /** Delete / Backspace on a selected line. */
    removeSelected() {
      const ls = list(), k = ls.findIndex(l => l.id === selected);
      if (k < 0) return false;
      ls.splice(k, 1); selected = null; save(); changed();
      return true;
    },
    /** Remove every line on the coin on screen. */
    clear() {
      if (!list().length) return false;
      all[getSymbol()] = []; selected = null; save(); changed();
      return true;
    },
    count: () => list().length,
  };
}
