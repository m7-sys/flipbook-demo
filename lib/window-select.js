/* ============================================================================
   FlipBook · window selector  (app/www/lib/window-select.js)
   ----------------------------------------------------------------------------
   Two draggable vertical handles over a candle chart that mark a time span
   (start candle → end candle). Handles are anchored to candle indices, so they
   stay put through zoom/pan. Independent of the session dropdown — whichever the
   user touches last defines the journal Window.

     const sel = enableWindowSelect(canvas, { getData, onChange });
     sel.show() / sel.hide() / sel.isVisible() / sel.getSelection()
   ========================================================================== */

import * as Charts from './chart-engine.js';

const CSS = `
.fb-wsel{position:absolute;inset:0;pointer-events:none;z-index:5}
.fb-wsel-region{position:absolute;top:0;bottom:0;background:rgba(232,184,75,.10);border-left:1px solid var(--amber,#e8b84b);border-right:1px solid var(--amber,#e8b84b)}
.fb-wsel-handle{position:absolute;top:0;bottom:0;width:14px;transform:translateX(-7px);cursor:ew-resize;pointer-events:auto;touch-action:none}
.fb-wsel-handle::before{content:'';position:absolute;left:6px;top:0;bottom:0;width:2px;background:var(--amber,#e8b84b)}
.fb-wsel-handle::after{content:'';position:absolute;left:3px;top:50%;width:8px;height:26px;transform:translateY(-50%);background:var(--amber,#e8b84b);border-radius:3px;opacity:.9}
.fb-wsel-label{position:absolute;top:6px;transform:translateX(-50%);font-family:var(--mono,monospace);font-size:10px;font-weight:700;color:#0b0d10;background:var(--amber,#e8b84b);border-radius:4px;padding:2px 6px;white-space:nowrap;pointer-events:none}
`;

function injectCss() {
  if (document.getElementById('fb-wsel-css')) return;
  const s = document.createElement('style'); s.id = 'fb-wsel-css'; s.textContent = CSS;
  document.head.appendChild(s);
}

export function enableWindowSelect(cv, { getData, onChange } = {}) {
  injectCss();
  const wrap = cv.parentElement;
  if (getComputedStyle(wrap).position === 'static') wrap.style.position = 'relative';

  const layer = document.createElement('div');
  layer.className = 'fb-wsel';
  layer.style.display = 'none';
  layer.innerHTML = `<div class="fb-wsel-region"></div>
    <div class="fb-wsel-handle" data-h="a"></div>
    <div class="fb-wsel-handle" data-h="b"></div>
    <div class="fb-wsel-label"></div>`;
  wrap.appendChild(layer);

  const region = layer.querySelector('.fb-wsel-region');
  const ha = layer.querySelector('[data-h="a"]');
  const hb = layer.querySelector('[data-h="b"]');
  const label = layer.querySelector('.fb-wsel-label');

  let a = 0, b = 0, visible = false;

  const data = () => getData?.() || [];
  const clampIdx = g => Math.max(0, Math.min((data().length || 1) - 1, g));
  const fmt = idx => {
    const c = data()[idx];
    if (!c || c.t == null) return '—';
    return new Date(c.t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  function position() {
    if (!visible) return;
    const xa = Charts.indexToX(cv, a), xb = Charts.indexToX(cv, b);
    if (xa == null || xb == null) return;
    const lo = Math.min(xa, xb), hi = Math.max(xa, xb);
    ha.style.left = `${xa}px`; hb.style.left = `${xb}px`;
    region.style.left = `${lo}px`; region.style.width = `${Math.max(0, hi - lo)}px`;
    label.style.left = `${(lo + hi) / 2}px`;
    label.textContent = `${fmt(Math.min(a, b))}–${fmt(Math.max(a, b))}`;
  }
  cv.__onRedraw = position;   // reposition on zoom / pan / resize

  function emit() {
    const d = data(), lo = Math.min(a, b), hi = Math.max(a, b);
    onChange?.({ aIdx: lo, bIdx: hi, aTime: d[lo]?.t ?? null, bTime: d[hi]?.t ?? null, label: `${fmt(lo)}–${fmt(hi)}` });
  }

  function startDrag(which, e) {
    e.stopPropagation(); e.preventDefault();
    const move = ev => {
      const px = (ev.touches ? ev.touches[0].clientX : ev.clientX) - cv.getBoundingClientRect().left;
      const g = clampIdx(Charts.xToIndex(cv, px));
      if (which === 'a') a = g; else b = g;
      position(); emit();
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }
  ha.addEventListener('pointerdown', e => startDrag('a', e));
  hb.addEventListener('pointerdown', e => startDrag('b', e));

  return {
    show() {
      const n = data().length;
      if (n) { a = clampIdx(Math.round(n * 0.25)); b = clampIdx(Math.round(n * 0.75)); }
      visible = true; layer.style.display = 'block';
      position(); emit();
    },
    hide() { visible = false; layer.style.display = 'none'; },
    isVisible: () => visible,
    getSelection() {
      const d = data(), lo = Math.min(a, b), hi = Math.max(a, b);
      return { label: `${fmt(lo)}–${fmt(hi)}`, aTime: d[lo]?.t ?? null, bTime: d[hi]?.t ?? null };
    },
    reposition: position,
  };
}
