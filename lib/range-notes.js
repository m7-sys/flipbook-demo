/* ============================================================================
   FlipBook · range notes  (app/www/lib/range-notes.js)
   ----------------------------------------------------------------------------
   A two-handle slider under a week chart (snaps to the hour, lined up with the
   chart's plot area) to pick a stretch of the week, and a note box per picked
   range. The boxes share the chart's width equally (4 ranges → 4 boxes of ¼
   each), in time order, numbered and coloured like their bands on the chart.

     mountRangeNotes(el, { start, editable, notes, onChange, onDraft, onFocus, emptyText })
   ========================================================================== */

import { WEEK, HOUR, fmtDayTime } from './trading-week.js';
import { PAD, NOTE_COLORS } from './week-chart.js';

const HOURS = WEEK / HOUR;
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const rangeText = (a, b) => `${fmtDayTime(a)} → ${fmtDayTime(b)}`;

export function mountRangeNotes(el, {
  start, editable = false, notes = [], emptyText = '',
  onChange = () => {}, onDraft = () => {}, onFocus = () => {},
} = {}) {
  injectCss();
  let list = notes.map(n => ({ ...n }));
  const sel = { a: 0, b: 24 };   // hours from the week start

  el.classList.add('rn');
  el.innerHTML = (editable ? `
    <div class="rn-slider" style="margin:0 ${PAD.r}px 0 ${PAD.l}px">
      <div class="rn-track"><div class="rn-fill"></div>
        <button class="rn-h" data-h="a" aria-label="Range start"></button>
        <button class="rn-h" data-h="b" aria-label="Range end"></button></div>
    </div>
    <div class="rn-bar"><span class="rn-sel"></span><button class="rn-add">＋ Add note for this range</button></div>` : '') +
    `<div class="rn-boxes"></div>`;
  const $ = s => el.querySelector(s);
  const boxes = $('.rn-boxes');

  /* ---- slider ---- */
  if (editable) {
    const track = $('.rn-track'), fill = $('.rn-fill'), hA = $('[data-h="a"]'), hB = $('[data-h="b"]');
    const paint = () => {
      hA.style.left = `${(sel.a / HOURS) * 100}%`;
      hB.style.left = `${(sel.b / HOURS) * 100}%`;
      fill.style.left = hA.style.left;
      fill.style.width = `${((sel.b - sel.a) / HOURS) * 100}%`;
      $('.rn-sel').textContent = rangeText(start + sel.a * HOUR, start + sel.b * HOUR);
      onDraft({ start: start + sel.a * HOUR, end: start + sel.b * HOUR });
    };
    const hourAt = x => {
      const r = track.getBoundingClientRect();
      return Math.round(Math.max(0, Math.min(1, (x - r.left) / r.width)) * HOURS);
    };
    // drag a handle, or the shaded range to move both ends together
    let drag = null;
    track.addEventListener('pointerdown', e => {
      if (e.button > 0) return;
      e.preventDefault();
      const h = hourAt(e.clientX);
      const which = e.target.dataset.h
        || (e.target === fill ? 'both' : Math.abs(h - sel.a) <= Math.abs(h - sel.b) ? 'a' : 'b');
      drag = { which, from: h, a: sel.a, b: sel.b };
      track.setPointerCapture?.(e.pointerId);
      if (which !== 'both') move(e);
    });
    const move = e => {
      if (!drag) return;
      const h = hourAt(e.clientX);
      if (drag.which === 'a') sel.a = Math.min(h, sel.b - 1);
      else if (drag.which === 'b') sel.b = Math.max(h, sel.a + 1);
      else {
        const span = drag.b - drag.a;
        sel.a = Math.max(0, Math.min(HOURS - span, drag.a + h - drag.from)); sel.b = sel.a + span;
      }
      paint();
    };
    track.addEventListener('pointermove', move);
    track.addEventListener('pointerup', () => { drag = null; });
    track.addEventListener('pointercancel', () => { drag = null; });

    $('.rn-add').onclick = () => {
      const color = list.length ? Math.max(...list.map(n => n.color)) + 1 : 0;
      const note = { id: `n${Date.now().toString(36)}`, start: start + sel.a * HOUR, end: start + sel.b * HOUR, text: '', color };
      list = [...list, note];
      onChange(list);
      render();
      boxes.querySelector(`[data-id="${note.id}"] textarea`)?.focus();
    };
    paint();
  }

  /* ---- note boxes: equal widths, time order ---- */
  function render() {
    const sorted = list.slice().sort((a, b) => a.start - b.start);
    boxes.style.setProperty('--n', Math.max(1, sorted.length));
    if (!sorted.length) {
      boxes.innerHTML = `<p class="rn-empty">${esc(emptyText || (editable
        ? 'No notes yet. Drag the slider under the chart to pick a range, then press ＋ Add note.'
        : 'No notes for this week.'))}</p>`;
      return;
    }
    boxes.innerHTML = sorted.map((n, k) => `
      <div class="rn-box" data-id="${n.id}" style="--c:${NOTE_COLORS[n.color % NOTE_COLORS.length]}">
        <div class="rn-head"><b>${k + 1}</b><span>${rangeText(n.start, n.end)}</span>${editable ? '<button class="rn-x" title="Remove this note">×</button>' : ''}</div>
        <textarea ${editable ? '' : 'readonly'} placeholder="${editable ? 'What happens in this range…' : ''}">${esc(n.text)}</textarea>
      </div>`).join('');
  }
  boxes.addEventListener('input', e => {
    const id = e.target.closest('.rn-box')?.dataset.id, n = list.find(x => x.id === id);
    if (n) { n.text = e.target.value; onChange(list); }
  });
  boxes.addEventListener('click', e => {
    if (!e.target.classList.contains('rn-x')) return;
    const id = e.target.closest('.rn-box').dataset.id;
    list = list.filter(n => n.id !== id);
    onChange(list); onFocus(null); render();
  });
  for (const [type, on] of [['focusin', true], ['mouseover', true], ['focusout', false], ['mouseleave', false]]) {
    boxes.addEventListener(type, e => onFocus(on ? e.target.closest?.('.rn-box')?.dataset.id ?? null : null), type === 'mouseleave');
  }
  render();
}

const CSS = `
.rn{display:flex;flex-direction:column;gap:8px}
.rn-slider{padding:8px 0 4px}
.rn-track{position:relative;height:6px;border-radius:3px;background:var(--panel-2);border:1px solid var(--line);cursor:pointer;touch-action:none}
.rn-fill{position:absolute;top:-1px;bottom:-1px;background:var(--teal-soft);border:1px solid var(--teal);border-radius:3px;cursor:grab}
.rn-h{position:absolute;top:50%;width:18px;height:18px;margin:-9px 0 0 -9px;border-radius:50%;background:var(--bg);border:2px solid var(--teal);cursor:ew-resize;padding:0;touch-action:none}
.rn-bar{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.rn-sel{font-family:var(--mono);font-size:11.5px;color:var(--ink-dim)}
.rn-add{margin-left:auto;font-size:11.5px;font-weight:700;color:var(--teal);background:var(--teal-soft);border:1px solid var(--teal);border-radius:8px;padding:6px 11px;cursor:pointer}
.rn-boxes{display:grid;grid-template-columns:repeat(var(--n),minmax(0,1fr));gap:8px}
.rn-empty{font-size:12px;color:var(--ink-faint);padding:4px 0}
.rn-box{display:flex;flex-direction:column;background:var(--panel);border:1px solid var(--panel-edge);border-top:2px solid var(--c);border-radius:9px;min-width:0}
.rn-head{display:flex;align-items:center;gap:7px;padding:7px 9px 4px;font-size:10.5px;color:var(--ink-dim);min-width:0}
.rn-head b{color:var(--c);font-size:11px}
.rn-head span{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
.rn-x{margin-left:auto;background:none;border:none;color:var(--ink-faint);font-size:16px;line-height:1;cursor:pointer;padding:0 2px}
.rn-x:hover{color:var(--rose)}
.rn-box textarea{flex:1;min-height:64px;resize:vertical;background:transparent;border:none;color:var(--ink);font-size:12.5px;line-height:1.45;padding:4px 9px 9px;outline:none}
.rn-box textarea[readonly]{resize:none;color:var(--ink-dim)}
@media (max-width:720px){.rn-boxes{grid-template-columns:repeat(var(--n),minmax(170px,1fr));overflow-x:auto}}
`;
function injectCss() {
  if (document.getElementById('rn-css')) return;
  const s = document.createElement('style'); s.id = 'rn-css'; s.textContent = CSS;
  document.head.appendChild(s);
}
