/* ============================================================================
   FlipBook · Divergent Checker
   ----------------------------------------------------------------------------
   A 2×2 grid: the primary asset is locked top-left; the other three cells are
   pickable comparisons. All four share one session window and timeframe. Each
   comparison cell shows a badge derived from the Pearson correlation of its
   per-candle returns against the primary — ALIGNED / LOOSE / DIVERGENT — plus
   its % move over the window. Renders with the shared chart engine.

     import { mountDivergent } from './lib/divergent-view.js';
     mountDivergent(document.getElementById('view-divergent'), { apiBase });
   ========================================================================== */

import * as Charts from './chart-engine.js';
import {
  fetchKlines, syntheticSeries, INSTRUMENTS, TF_FACTOR_FROM_3M, createPoller, LIVE_POLL_MS,
  loadInstruments, resolveInstrument, dpForPrice, SOURCE_LABEL,
} from './data-adapter.js';
import { openInstrumentPicker } from './instrument-picker.js';

const SEARCH = '__search__';
/** Display name for a coin: curated name, else its data source. */
const nameOf = sym => { const i = resolveInstrument(sym); return i.name || SOURCE_LABEL[i.source]; };

const WIN = 120;                                  // candles in the comparison window
const TFS = ['3m', '15m', '1h', '4h', '1d'];

const css = `
#__ROOT__{display:flex;flex-direction:column;height:100%;min-height:0;background:var(--bg);color:var(--ink);font-family:var(--sans)}
#__ROOT__ .dv-bar{display:flex;align-items:center;gap:14px;padding:11px 22px;border-bottom:1px solid var(--panel-edge);background:var(--panel);flex:0 0 auto}
#__ROOT__ .dv-lbl{font-family:var(--mono);font-size:9px;letter-spacing:1.2px;text-transform:uppercase;color:var(--ink-faint)}
#__ROOT__ .dv-primary{display:flex;align-items:center;gap:8px;font-family:var(--mono);font-size:12px;font-weight:700;color:var(--amber);border:1px solid var(--amber);background:var(--amber-soft);border-radius:8px;padding:6px 12px}
#__ROOT__ .dv-primary .lock{font-size:10px;opacity:.8}
#__ROOT__ .dv-tf{margin-left:auto;display:inline-flex;background:var(--panel-2);border:1px solid var(--line);border-radius:9px;padding:3px;gap:2px}
#__ROOT__ .dv-tf button{font-family:var(--mono);font-size:11px;font-weight:700;color:var(--ink-faint);background:transparent;border:none;border-radius:6px;padding:6px 11px;cursor:pointer;transition:.14s}
#__ROOT__ .dv-tf button:hover{color:var(--ink-dim)} #__ROOT__ .dv-tf button.on{color:var(--teal);background:var(--teal-soft)}

#__ROOT__ .dv-grid{flex:1;min-height:0;display:grid;grid-template-columns:1fr 1fr;grid-template-rows:1fr 1fr;gap:12px;padding:14px 22px 20px}
#__ROOT__ .dv-cell{position:relative;display:flex;flex-direction:column;background:var(--panel);border:1px solid var(--panel-edge);border-radius:13px;overflow:hidden;min-width:0;min-height:0}
#__ROOT__ .dv-cell.primary{border-color:var(--amber)}
#__ROOT__ .dv-head{display:flex;align-items:center;gap:9px;padding:10px 13px;border-bottom:1px solid var(--panel-edge);flex:0 0 auto}
#__ROOT__ .dv-sym{font-family:var(--mono);font-size:13px;font-weight:700;color:var(--ink)}
#__ROOT__ .dv-name{font-size:11px;color:var(--ink-faint);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#__ROOT__ .dv-pick{font-family:var(--mono);font-size:12px;font-weight:600;color:var(--ink);background:var(--panel-2);border:1px solid var(--line);border-radius:7px;padding:5px 8px;cursor:pointer}
#__ROOT__ .dv-pick:focus{outline:none;border-color:var(--teal)}
#__ROOT__ .dv-canvas{flex:1;min-height:0;position:relative}
#__ROOT__ canvas{display:block;width:100%;height:100%}
#__ROOT__ .dv-foot{display:flex;align-items:center;gap:10px;padding:9px 13px;border-top:1px solid var(--panel-edge);flex:0 0 auto}
#__ROOT__ .dv-badge{font-family:var(--mono);font-size:9.5px;font-weight:700;letter-spacing:.6px;border-radius:6px;padding:3px 8px;border:1px solid currentColor}
#__ROOT__ .dv-badge.aligned{color:var(--teal);background:var(--teal-soft)}
#__ROOT__ .dv-badge.loose{color:var(--amber);background:var(--amber-soft)}
#__ROOT__ .dv-badge.divergent{color:var(--rose);background:var(--rose-soft)}
#__ROOT__ .dv-badge.primary{color:var(--amber);background:var(--amber-soft)}
#__ROOT__ .dv-corr{font-family:var(--mono);font-size:10.5px;color:var(--ink-dim)}
#__ROOT__ .dv-move{margin-left:auto;font-family:var(--mono);font-size:12px;font-weight:700}
#__ROOT__ .dv-move.up{color:var(--teal)} #__ROOT__ .dv-move.down{color:var(--rose)}
`;

export function mountDivergent(root, { apiBase = 'http://localhost:3001' } = {}) {
  if (!root.id) root.id = 'view-divergent';
  injectStyle(root.id);

  const state = {
    interval: '3m',
    primary: 'BERA',
    cells: ['BERA', 'SOL', 'HYPE', 'WIF'],   // index 0 = primary (locked)
    series: {},                               // sym → candle[]
    dp: {},                                   // sym → decimals
    live: null,                               // 5s refresh poller
  };
  loadInstruments(apiBase);

  root.innerHTML = barHTML(state) + `<div class="dv-grid"></div>`;
  const grid = root.querySelector('.dv-grid');
  const cellEls = [];

  state.cells.forEach((sym, i) => {
    const primary = i === 0;
    const el = document.createElement('div');
    el.className = 'dv-cell' + (primary ? ' primary' : '');
    el.innerHTML =
      `<div class="dv-head">` +
      (primary
        ? `<span class="dv-sym">${sym}</span><span class="dv-name">${nameOf(sym)}</span>`
        : `<select class="dv-pick">${optionsFor(sym, state)}</select><span class="dv-name" data-name>${nameOf(sym)}</span>`) +
      `</div>` +
      `<div class="dv-canvas"><canvas></canvas></div>` +
      `<div class="dv-foot">` +
      (primary
        ? `<span class="dv-badge primary">PRIMARY</span>`
        : `<span class="dv-badge loose" data-badge>—</span><span class="dv-corr" data-corr></span>`) +
      `<span class="dv-move" data-move>—</span></div>`;

    const canvas = el.querySelector('canvas');
    Charts.register(canvas, (ctx, w, h) => {
      const data = state.series[state.cells[i]];
      if (data) Charts.candles(ctx, w, h, data, { axis: false, timeAxis: true, dp: state.dp[state.cells[i]] ?? 4 });
    });
    Charts.enableZoom(canvas);

    if (!primary) {
      const sel = el.querySelector('.dv-pick');
      sel.value = sym;
      sel.addEventListener('change', () => {
        if (sel.value !== SEARCH) return onPick(i, sel.value);
        sel.value = state.cells[i];   // revert until a coin is chosen
        openInstrumentPicker({
          anchor: sel, apiBase, exclude: state.cells,
          onPick: picked => onPick(i, picked),
        });
      });
    }
    cellEls.push(el);
    grid.appendChild(el);
  });

  root.querySelector('.dv-tf').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    root.querySelector('.dv-tf .on')?.classList.remove('on');
    b.classList.add('on');
    state.interval = b.dataset.tf;
    loadAll();
  });

  // On a live refresh a failed fetch keeps the last good candles instead of
  // swapping in sample data.
  async function loadOne(sym, signal, refresh = false) {
    const ins = resolveInstrument(sym);
    try {
      const data = await fetchKlines({ apiBase, symbol: ins.pair, interval: state.interval, source: ins.source, limit: WIN, signal });
      if (data.length < 8) throw new Error('short');
      state.series[sym] = data.slice(-WIN);
    } catch (e) {
      if (e.name === 'AbortError' || (refresh && state.series[sym])) return;
      const f = TF_FACTOR_FROM_3M[state.interval] || 1;
      const s = syntheticSeries({ n: WIN * f, base: ins.base, seed: ins.seed, vol: ins.vol, ramp: 0.6 });
      state.series[sym] = (f > 1 ? Charts.aggregate(s, f) : s).slice(-WIN);
    }
    state.dp[sym] = ins.dp ?? dpForPrice(state.series[sym].at(-1)?.c);
  }

  async function loadAll() {
    state.live?.stop();
    await Promise.all([...new Set(state.cells)].map(sym => loadOne(sym)));
    renderBadges();
    Charts.refreshAll();
    state.live = createPoller(async signal => {
      await Promise.all([...new Set(state.cells)].map(sym => loadOne(sym, signal, true)));
      renderBadges();
      Charts.refreshAll();
    }, { intervalMs: LIVE_POLL_MS, immediate: false });
  }

  async function onPick(i, sym) {
    state.cells[i] = sym;
    cellEls[i].querySelector('[data-name]').textContent = nameOf(sym);
    // rebuild every picker: others exclude the new set, this one gains a searched coin
    cellEls.forEach((el, k) => {
      const sel = el.querySelector('.dv-pick'); if (!sel) return;
      sel.innerHTML = optionsFor(state.cells[k], state); sel.value = state.cells[k];
    });
    await loadOne(sym);
    renderBadges();
    Charts.refreshAll();
  }

  function renderBadges() {
    const primarySeries = state.series[state.primary] || [];
    cellEls.forEach((el, i) => {
      const sym = state.cells[i];
      const series = state.series[sym] || [];
      const move = pctMove(series);
      const moveEl = el.querySelector('[data-move]');
      moveEl.textContent = `${move >= 0 ? '+' : ''}${move.toFixed(2)}%`;
      moveEl.className = 'dv-move ' + (move >= 0 ? 'up' : 'down');
      if (i === 0) return;

      const c = correlation(primarySeries, series);
      const badge = el.querySelector('[data-badge]');
      const tier = c >= 0.5 ? ['aligned', 'ALIGNED'] : c <= -0.2 ? ['divergent', 'DIVERGENT'] : ['loose', 'LOOSE'];
      badge.className = 'dv-badge ' + tier[0];
      badge.textContent = tier[1];
      el.querySelector('[data-corr]').textContent = `ρ ${c >= 0 ? '+' : ''}${c.toFixed(2)} vs ${state.primary}`;
    });
  }

  loadAll();
  return { refresh: () => Charts.refreshAll() };
}

/* ---- math --------------------------------------------------------------- */

const mean = a => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);

function returns(series) {
  const r = [];
  for (let i = 1; i < series.length; i++) r.push((series[i].c - series[i - 1].c) / series[i - 1].c);
  return r;
}

/** Pearson correlation of returns; index-aligned on the shorter series. */
function correlation(a, b) {
  const n = Math.min(a.length, b.length);
  if (n < 3) return 0;
  const ra = returns(a.slice(-n)), rb = returns(b.slice(-n));
  const ma = mean(ra), mb = mean(rb);
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < ra.length; i++) { const x = ra[i] - ma, y = rb[i] - mb; num += x * y; da += x * x; db += y * y; }
  return da && db ? num / Math.sqrt(da * db) : 0;
}

function pctMove(series) {
  if (series.length < 2) return 0;
  return (series[series.length - 1].c - series[0].o) / series[0].o * 100;
}

/* ---- markup ------------------------------------------------------------- */

function optionsFor(current, state) {
  const taken = new Set([state.primary, ...state.cells.filter((s, i) => i > 0)]);
  taken.delete(current);
  const syms = INSTRUMENTS.map(ins => ins.sym);
  if (!syms.includes(current)) syms.unshift(current);   // a coin picked via search
  return syms
    .filter(sym => sym === current || !taken.has(sym))
    .map(sym => `<option value="${sym}"${sym === current ? ' selected' : ''}>${sym} · ${nameOf(sym)}</option>`)
    .join('') + `<option value="${SEARCH}">Search all coins…</option>`;
}

function barHTML(state) {
  const tf = TFS.map(t => `<button data-tf="${t}" class="${t === state.interval ? 'on' : ''}">${t === '1d' ? '1D' : t}</button>`).join('');
  return `<div class="dv-bar">
    <span class="dv-lbl">Primary</span>
    <span class="dv-primary"><span class="lock">🔒</span>${state.primary} · ${nameOf(state.primary)}</span>
    <span class="dv-lbl">Same window · correlation of returns</span>
    <div class="dv-tf">${tf}</div>
  </div>`;
}

function injectStyle(rootId) {
  if (document.getElementById('dv-view-css')) return;
  const tag = document.createElement('style');
  tag.id = 'dv-view-css';
  tag.textContent = css.replaceAll('__ROOT__', rootId);
  document.head.appendChild(tag);
}
