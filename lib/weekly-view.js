/* ============================================================================
   FlipBook · Tracking Test & Error Log  (app/www/lib/weekly-view.js)
   ----------------------------------------------------------------------------
   Two pages built from the same parts, each a pair of trading-week charts
   (Mon 06:00 → Mon 06:00, UTC+8):

   test  Tracking Test   top: this week, live.  bottom: next week, blank — pick
                         the week's state, draw the expected path (box, trend
                         up/down, set) and note ranges. Locks when that week starts.
   log   Error Log       top: what you predicted for a week (read-only).
                         bottom: what actually happened (live while the week runs)
                         with the real state and correction notes. A calendar
                         sidebar opens any past week.

     mountWeekly(document.getElementById('view-weekly'), { apiBase, mode: 'test' | 'log' });
   ========================================================================== */

import * as Charts from './chart-engine.js';
import {
  fetchKlines, INSTRUMENTS, loadInstruments, resolveInstrument, dpForPrice, SOURCE_LABEL, createPoller,
} from './data-adapter.js';
import { openInstrumentPicker } from './instrument-picker.js';
import { setReaderAsset } from './audio-reader.js';
import { createWeekChart, TOOLS } from './week-chart.js';
import { mountRangeNotes } from './range-notes.js';
import { STATES, getWeek, savePrediction, saveLog, weeksWithData } from './weekly-store.js';
import {
  WEEK, HOUR, DAY, weekStartOf, weekKey, weekFromKey, weekLabel, fmtDayTime, parts8, dateAt8, MONTHS,
} from './trading-week.js';

const PILLS = 6;
const POLL_MS = 30_000;
const SYM_KEY = 'flipbook.weekly.sym';
const GHOST_KEY = 'flipbook.weekly.ghost';
const pref = (k, v) => { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch { return null; } };

const stateSelect = (value, label, disabled = false) =>
  `<select class="wk-state" ${disabled ? 'disabled' : ''}><option value="">${label}</option>${
    STATES.map(s => `<option ${s === value ? 'selected' : ''}>${s}</option>`).join('')}</select>`;

const fmtIn = ms => {
  const m = Math.max(1, Math.round(ms / 60000)), h = Math.floor(m / 60), d = Math.floor(h / 24);
  return d ? `${d}d ${h % 24}h` : h ? `${h}h ${m % 60}m` : `${m}m`;
};

/** A blank week's price range: centred on the last price, about this week's range either side. */
function frameAround(candles) {
  if (!candles?.length) return null;
  let lo = Infinity, hi = -Infinity;
  for (const c of candles) { if (c.l < lo) lo = c.l; if (c.h > hi) hi = c.h; }
  const last = candles.at(-1).c, half = Math.max(hi - lo, last * 0.04) * 0.9;
  return { lo: last - half, hi: last + half };
}
/** Union of a saved frame and the candles' extent, padded a little. */
function frameUnion(frame, candles) {
  let lo = frame?.lo ?? Infinity, hi = frame?.hi ?? -Infinity;
  for (const c of candles || []) { if (c.l < lo) lo = c.l; if (c.h > hi) hi = c.h; }
  if (!isFinite(lo)) return null;
  if (frame) return { lo, hi };
  const pad = (hi - lo || hi * 0.02) * 0.08;
  return { lo: lo - pad, hi: hi + pad };
}

export function mountWeekly(root, { apiBase = '', mode = 'test' } = {}) {
  injectCss();
  loadInstruments(apiBase);
  const isLog = mode === 'log';
  const st = {
    sym: pref(SYM_KEY) || 'BERA',
    week: weekStartOf(Date.now()),        // log: the week being reviewed
    canvases: [], poller: null, cleanup: null,
  };

  root.classList.add('wk');
  root.innerHTML = `
    <div class="wk-bar">
      <span class="wk-lbl">Instrument</span><div class="wk-pills"></div>
      <div class="wk-meta"><span data-src></span></div>
    </div>
    <div class="wk-body">
      ${isLog ? `<button class="wk-side" title="Pick a week"><span>📅</span><span class="wk-side-txt">Weeks</span></button>
      <aside class="wk-cal" aria-label="Weeks"></aside>` : ''}
      <div class="wk-rows"></div>
    </div>`;
  const $ = s => root.querySelector(s);
  const rows = $('.wk-rows'), src = $('[data-src]');

  /* ---- coin pills ---- */
  const pills = $('.wk-pills');
  const search = document.createElement('button');
  search.className = 'wk-pill'; search.textContent = '＋'; search.title = 'Search all coins';
  pills.appendChild(search);
  const addPill = sym => {
    if (pills.querySelector(`[data-sym="${sym}"]`)) return;
    const b = document.createElement('button');
    b.className = 'wk-pill'; b.dataset.sym = sym; b.textContent = sym;
    b.onclick = () => selectCoin(sym);
    pills.insertBefore(b, search);
  };
  INSTRUMENTS.slice(0, PILLS).forEach(i => addPill(i.sym));
  addPill(st.sym);
  search.onclick = () => openInstrumentPicker({ anchor: search, apiBase, onPick: sym => { addPill(sym); selectCoin(sym); } });

  function selectCoin(sym) {
    st.sym = sym; pref(SYM_KEY, sym); setReaderAsset(sym);
    pills.querySelectorAll('[data-sym]').forEach(p => p.classList.toggle('on', p.dataset.sym === sym));
    render();
  }

  /* ---- shared pieces ---- */
  async function loadWeek(start) {
    const ins = resolveInstrument(st.sym), end = Math.min(start + WEEK, Date.now()) - 1;
    if (end <= start) return [];
    const rows = await fetchKlines({ apiBase, symbol: ins.pair, interval: '1h', source: ins.source, start, end });
    src.textContent = SOURCE_LABEL[rows.source || ins.source] || '';
    src.classList.remove('off');
    return rows;
  }
  const dpOf = candles => resolveInstrument(st.sym).dp ?? (candles?.length ? dpForPrice(candles.at(-1).c) : 4);
  const failed = () => { src.textContent = "Couldn't load prices"; src.classList.add('off'); };

  function rowHTML(id, title, week, controls = '') {
    return `<section class="wk-row" data-row="${id}">
      <div class="wk-head"><div class="wk-ctrl">${controls}</div>
        <div class="wk-title"><b>${title}</b><span>${weekLabel(week)}</span></div></div>
      <div class="wk-chart"><canvas></canvas></div>
      <div class="wk-notes"></div>
    </section>`;
  }

  /** Tear down the previous render (charts, polling, listeners). */
  function reset() {
    st.poller?.stop(); st.poller = null;
    st.cleanup?.(); st.cleanup = null;
    st.canvases.forEach(cv => Charts.unregister(cv)); st.canvases = [];
  }
  const chartIn = (row, opts) => {
    const cv = rows.querySelector(`[data-row="${row}"] canvas`);
    st.canvases.push(cv);
    return createWeekChart(cv, opts);
  };

  /* ---- Tracking Test ---- */
  function renderTest() {
    const cur = weekStartOf(Date.now()), next = cur + WEEK, key = weekKey(next);
    const pred = getWeek(st.sym, key).prediction || { state: '', shapes: [], notes: [], frame: null };
    const tools = TOOLS.map(([id, label, tip]) => `<button data-tool="${id}" title="${tip}" class="${id === 'select' ? 'on' : ''}">${label}</button>`).join('');
    rows.innerHTML =
      rowHTML('now', 'This week', cur, '<span class="wk-tag live">● live</span>') +
      rowHTML('pred', 'Your prediction', next, `${stateSelect(pred.state, 'State of the week…')}
        <div class="wk-tools">${tools}<button data-undo title="Undo the last drawing">↶</button><button data-clear title="Remove all drawings">Clear</button></div>
        <span class="wk-lock" data-lock></span>`);

    const top = chartIn('now', { start: cur });
    let frameNow = null, lastPrice = null;
    const persist = () => {
      pred.frame ||= frameNow;
      if (lastPrice != null) pred.refPrice = lastPrice;
      if (!savePrediction(st.sym, key, pred)) render();    // the week started: locked, move on
    };
    const bottom = chartIn('pred', { start: next, editable: true, onShapes: s => { pred.shapes = s; persist(); } });
    bottom.set({ shapes: pred.shapes, notes: pred.notes, message: '' });

    const head = rows.querySelector('[data-row="pred"] .wk-head');
    head.querySelector('.wk-state').onchange = e => { pred.state = e.target.value; persist(); };
    const toolBtns = head.querySelectorAll('[data-tool]');
    toolBtns.forEach(b => b.onclick = () => {
      bottom.setTool(b.dataset.tool);
      toolBtns.forEach(x => x.classList.toggle('on', x === b));
    });
    head.querySelector('[data-undo]').onclick = () => bottom.undo();
    head.querySelector('[data-clear]').onclick = () => { if (pred.shapes.length && confirm('Remove all drawings on this prediction?')) bottom.clearShapes(); };

    mountRangeNotes(rows.querySelector('[data-row="pred"] .wk-notes'), {
      start: next, editable: true, notes: pred.notes,
      onChange: n => { pred.notes = n; bottom.set({ notes: n }); persist(); },
      onDraft: d => bottom.set({ draft: d }),
      onFocus: id => bottom.set({ focusNote: id }),
    });
    rows.querySelector('[data-row="now"] .wk-notes').remove();

    const lock = head.querySelector('[data-lock]');
    const tick = () => {
      if (weekStartOf(Date.now()) !== cur) return render();            // a new week began
      lock.textContent = `🔒 Locks ${fmtDayTime(next)} · in ${fmtIn(next - Date.now())}`;
    };
    tick();
    const timer = setInterval(tick, 30_000);

    const onKey = e => {
      if (/^(input|textarea|select)$/i.test(document.activeElement?.tagName || '')) return;
      if ((e.key === 'Delete' || e.key === 'Backspace') && bottom.deleteSelected()) e.preventDefault();
      if (e.key === 'Escape') toolBtns[0].click();
    };
    document.addEventListener('keydown', onKey);
    st.cleanup = () => { clearInterval(timer); document.removeEventListener('keydown', onKey); };

    const sym = st.sym;
    st.poller = createPoller(async () => {
      try {
        const candles = await loadWeek(cur);
        if (sym !== st.sym) return;
        const dp = dpOf(candles);
        frameNow = frameAround(candles);
        lastPrice = candles.at(-1)?.c ?? null;
        top.set({ candles, dp });
        bottom.set({ frame: pred.frame || frameNow, refPrice: lastPrice, dp, message: '' });
      } catch { failed(); }
    }, { intervalMs: POLL_MS });
  }

  /* ---- Error Log ---- */
  function renderLog() {
    const start = st.week, key = weekKey(start), w = getWeek(st.sym, key);
    const pred = w.prediction, log = w.log;
    const live = Date.now() < start + WEEK;
    const ghostOn = pref(GHOST_KEY) === '1';
    rows.innerHTML =
      rowHTML('pred', 'Predicted', start, pred?.state
        ? `<span class="wk-tag">State: <b>${pred.state}</b></span>`
        : `<span class="wk-tag dim">${pred ? 'No state picked' : 'No prediction'}</span>`) +
      rowHTML('act', live ? 'What’s happening' : 'What happened', start, `${stateSelect(log.state, 'Actual state…')}
        <span class="wk-match" data-match></span>
        <label class="wk-ghost"><input type="checkbox" data-ghost ${ghostOn ? 'checked' : ''}> Show prediction</label>
        ${live ? '<span class="wk-tag live">● live</span>' : ''}`);

    const top = chartIn('pred', { start });
    const bottom = chartIn('act', { start });
    top.set({ shapes: pred?.shapes || [], notes: pred?.notes || [], refPrice: pred?.refPrice ?? null,
      message: pred ? '' : 'No prediction was made for this week. Make one in Tracking Test.' });
    bottom.set({ notes: log.notes, ghost: ghostOn ? pred?.shapes || [] : [] });

    mountRangeNotes(rows.querySelector('[data-row="pred"] .wk-notes'), { start, notes: pred?.notes || [], emptyText: pred ? 'No range notes in this prediction.' : ' ' });
    mountRangeNotes(rows.querySelector('[data-row="act"] .wk-notes'), {
      start, editable: true, notes: log.notes,
      onChange: n => { log.notes = n; bottom.set({ notes: n }); saveLog(st.sym, key, log); refreshCalendar(); },
      onDraft: d => bottom.set({ draft: d }),
      onFocus: id => bottom.set({ focusNote: id }),
    });

    const head = rows.querySelector('[data-row="act"] .wk-head'), match = head.querySelector('[data-match]');
    const showMatch = () => {
      const ok = pred?.state && log.state ? pred.state === log.state : null;
      match.className = `wk-match ${ok === null ? '' : ok ? 'ok' : 'bad'}`;
      match.textContent = ok === null ? '' : ok ? '✓ matches your prediction' : `✕ you predicted ${pred.state}`;
    };
    showMatch();
    head.querySelector('.wk-state').onchange = e => { log.state = e.target.value; saveLog(st.sym, key, log); showMatch(); refreshCalendar(); };
    head.querySelector('[data-ghost]').onchange = e => {
      pref(GHOST_KEY, e.target.checked ? '1' : '0');
      bottom.set({ ghost: e.target.checked ? pred?.shapes || [] : [] });
    };

    const sym = st.sym, apply = candles => {
      const frame = frameUnion(pred?.frame, candles), dp = dpOf(candles);
      top.set({ frame, dp }); bottom.set({ frame, dp, candles });
    };
    if (pred?.frame) apply([]);
    if (start > Date.now()) return;
    const load = async () => {
      try { const c = await loadWeek(start); if (sym === st.sym && start === st.week) apply(c); }
      catch { failed(); }
    };
    if (live) st.poller = createPoller(load, { intervalMs: POLL_MS }); else load();
  }

  /* ---- calendar sidebar (Error Log) ---- */
  let calMonth = null;
  function refreshCalendar() {
    const cal = $('.wk-cal'); if (!cal) return;
    const now = Date.now(), cur = weekStartOf(now), marks = weeksWithData(st.sym);
    const sel = parts8(st.week + 3 * DAY);
    calMonth ||= { y: sel.y, m: sel.m };
    const { y, m } = calMonth;
    const first = dateAt8(y, m, 1), nextMonth = dateAt8(m === 11 ? y + 1 : y, (m + 1) % 12, 1);
    let html = `<div class="wk-cal-head"><button data-cal="-1" aria-label="Previous month">‹</button><b>${MONTHS[m]} ${y}</b>
      <button data-cal="1" aria-label="Next month">›</button><button class="wk-cal-x" aria-label="Close">×</button></div>
      <div class="wk-cal-dow">${['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(d => `<span>${d}</span>`).join('')}</div>`;
    for (let ws = weekStartOf(first + 12 * HOUR); ws < nextMonth; ws += WEEK) {
      const k = weekKey(ws), mk = marks[k], future = ws > cur;
      const days = Array.from({ length: 7 }, (_, i) => {
        const p = parts8(ws + i * DAY);
        return `<span class="${p.m !== m ? 'out' : ''}">${p.d}</span>`;
      }).join('');
      html += `<button class="wk-cal-row ${ws === st.week ? 'sel' : ''} ${ws === cur ? 'cur' : ''}" data-week="${k}" ${future ? 'disabled' : ''}
        title="${weekLabel(ws)}${mk?.predicted ? ' · predicted' : ''}${mk?.logged ? ' · logged' : ''}">${days}
        <i class="${mk?.predicted ? 'p' : ''}"></i><i class="${mk?.logged ? 'l' : ''}"></i></button>`;
    }
    html += `<div class="wk-cal-legend"><span><i class="p"></i>predicted</span><span><i class="l"></i>logged</span><span class="now">this week</span></div>`;
    cal.innerHTML = html;
  }
  if (isLog) {
    const cal = $('.wk-cal');
    const toggle = open => { cal.classList.toggle('open', open); if (open) refreshCalendar(); };
    $('.wk-side').onclick = () => toggle(!cal.classList.contains('open'));
    cal.addEventListener('click', e => {
      const b = e.target.closest('button'); if (!b) return;
      if (b.classList.contains('wk-cal-x')) return toggle(false);
      if (b.dataset.cal) {
        const d = new Date(Date.UTC(calMonth.y, calMonth.m + +b.dataset.cal, 1));
        calMonth = { y: d.getUTCFullYear(), m: d.getUTCMonth() };
        return refreshCalendar();
      }
      if (b.dataset.week) { st.week = weekFromKey(b.dataset.week); toggle(false); render(); }
    });
  }

  function render() {
    reset();
    if (isLog) { renderLog(); refreshCalendar(); } else renderTest();
  }

  selectCoin(st.sym);
  return { refresh: render };
}

const CSS = `
.wk{display:flex;flex-direction:column;min-height:0;background:var(--bg);color:var(--ink)}
.wk-bar{display:flex;align-items:center;flex-wrap:wrap;gap:10px 14px;padding:11px 20px;border-bottom:1px solid var(--panel-edge);background:var(--panel)}
.wk-lbl{font-size:9px;letter-spacing:1.2px;text-transform:uppercase;color:var(--ink-faint)}
.wk-pills{display:flex;flex-wrap:wrap;gap:6px}
.wk-pill{font-size:11.5px;font-weight:600;color:var(--ink-faint);background:transparent;border:1px solid var(--line);border-radius:8px;padding:7px 12px;cursor:pointer}
.wk-pill:hover{color:var(--ink-dim);border-color:var(--ink-faint)}
.wk-pill.on{color:var(--amber);border-color:var(--amber);background:var(--amber-soft)}
.wk-meta{margin-left:auto;font-size:10.5px;letter-spacing:.3px;color:var(--teal)}
.wk-meta .off{color:var(--rose)}
.wk-body{position:relative;flex:1;min-height:0;display:flex}
.wk-rows{flex:1;min-width:0;overflow-y:auto;padding:16px 20px 28px;display:flex;flex-direction:column;gap:18px}
.wk-row{background:var(--panel);border:1px solid var(--panel-edge);border-radius:12px;padding:12px 14px 14px;display:flex;flex-direction:column;gap:10px}
.wk-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.wk-ctrl{display:flex;align-items:center;gap:10px;flex-wrap:wrap;min-width:0}
.wk-title{margin-left:auto;display:flex;align-items:baseline;gap:8px}
.wk-title b{font-size:13px;color:var(--ink)}
.wk-title span{font-size:11px;color:var(--ink-faint)}
.wk-chart{position:relative;height:clamp(220px,34vh,380px)}
.wk-chart canvas{display:block;width:100%;height:100%}
.wk-state{font-size:12px;font-weight:600;color:var(--amber);background:var(--panel-2);border:1px solid var(--amber);border-radius:8px;padding:6px 8px;cursor:pointer}
.wk-state:focus{outline:none;box-shadow:0 0 0 2px var(--amber-soft)}
.wk-tools{display:inline-flex;flex-wrap:wrap;background:var(--panel-2);border:1px solid var(--line);border-radius:9px;padding:3px;gap:2px}
.wk-tools button{font-size:11px;font-weight:700;color:var(--ink-faint);background:transparent;border:none;border-radius:6px;padding:6px 9px;cursor:pointer}
.wk-tools button:hover{color:var(--ink-dim)}
.wk-tools button.on{color:var(--teal);background:var(--teal-soft)}
.wk-lock{font-size:11px;color:var(--ink-faint)}
.wk-tag{font-size:11px;color:var(--ink-dim);border:1px solid var(--line);border-radius:7px;padding:5px 9px}
.wk-tag b{color:var(--amber)}
.wk-tag.dim{color:var(--ink-faint)}
.wk-tag.live{color:var(--teal);border-color:var(--teal);background:var(--teal-soft)}
.wk-match{font-size:11.5px;font-weight:600}
.wk-match.ok{color:var(--teal)} .wk-match.bad{color:var(--rose)}
.wk-ghost{font-size:11px;color:var(--ink-dim);display:flex;align-items:center;gap:6px;cursor:pointer}
.wk-ghost input{accent-color:var(--teal)}

.wk-side{flex:0 0 34px;display:flex;flex-direction:column;align-items:center;gap:10px;padding:14px 0;background:var(--panel);border:none;border-right:1px solid var(--panel-edge);color:var(--ink-dim);cursor:pointer;font-size:15px}
.wk-side:hover{color:var(--amber)}
.wk-side-txt{writing-mode:vertical-rl;transform:rotate(180deg);font-size:10.5px;letter-spacing:1.4px;text-transform:uppercase}
.wk-cal{position:absolute;left:34px;top:0;bottom:0;z-index:30;width:300px;max-width:calc(100% - 34px);background:var(--panel);border-right:1px solid var(--line);box-shadow:18px 0 40px rgba(0,0,0,.45);padding:14px;overflow-y:auto;transform:translateX(-110%);visibility:hidden;transition:transform .22s cubic-bezier(.4,0,.2,1),visibility .22s}
.wk-cal.open{transform:none;visibility:visible}
.wk-cal-head{display:flex;align-items:center;gap:8px;margin-bottom:12px}
.wk-cal-head b{flex:1;text-align:center;font-size:13px}
.wk-cal-head button{background:var(--panel-2);border:1px solid var(--line);border-radius:7px;color:var(--ink-dim);font-size:14px;width:28px;height:28px;cursor:pointer}
.wk-cal-head .wk-cal-x{border:none;background:none;font-size:18px}
.wk-cal-dow,.wk-cal-row{display:grid;grid-template-columns:repeat(7,1fr) 8px 8px;align-items:center;gap:2px}
.wk-cal-dow{font-size:9px;letter-spacing:.8px;text-transform:uppercase;color:var(--ink-faint);margin-bottom:4px;padding:0 6px}
.wk-cal-dow span{text-align:center}
.wk-cal-row{width:100%;padding:7px 6px;margin-bottom:3px;background:transparent;border:1px solid transparent;border-radius:8px;color:var(--ink);font-size:12px;cursor:pointer}
.wk-cal-row span{text-align:center}
.wk-cal-row span.out{color:var(--ink-faint)}
.wk-cal-row:hover:not(:disabled){border-color:var(--ink-faint)}
.wk-cal-row.cur{border-color:var(--line)}
.wk-cal-row.sel{border-color:var(--amber);background:var(--amber-soft)}
.wk-cal-row:disabled{opacity:.35;cursor:default}
.wk-cal-row i,.wk-cal-legend i{width:6px;height:6px;border-radius:50%;display:inline-block}
.wk-cal-row i.p,.wk-cal-legend i.p{background:var(--amber)}
.wk-cal-row i.l,.wk-cal-legend i.l{background:var(--teal)}
.wk-cal-legend{display:flex;gap:12px;margin-top:12px;font-size:10.5px;color:var(--ink-faint)}
.wk-cal-legend span{display:flex;align-items:center;gap:5px}
.wk-cal-legend .now::before{content:"";width:10px;height:8px;border:1px solid var(--line);border-radius:3px}

@media (max-width:720px){
  .wk-bar{padding:10px 14px}
  .wk-rows{padding:12px 12px 24px}
  .wk-row{padding:10px}
  .wk-title{margin-left:0;width:100%;order:-1}
  .wk-chart{height:260px}
}
`;
function injectCss() {
  if (document.getElementById('wk-css')) return;
  const s = document.createElement('style'); s.id = 'wk-css'; s.textContent = CSS;
  document.head.appendChild(s);
}
