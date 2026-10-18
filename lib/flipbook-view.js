/* ============================================================================
   FlipBook · Flipbook view
   ----------------------------------------------------------------------------
   Six panels of the same coin, each a step later in time. The step is a fixed
   gap (1H … 1W) or one trading session (Asia / London / NY / Weekend). The
   active panel renders full candles (+ optional higher-TF overlay); the rest
   are thumbnails.

   Two modes:
     backtest  (Flipbook page)  T−5 … T, oldest → newest, T = latest. Double-click
               an earlier panel to journal a prediction; it's graded against
               the later panel the prediction window lands on.
     track     (Tracking page)  T … T+5 captured forward by the server as time
               passes. Several tracks can run at once. Journal on T; grade when
               the target panel has been captured.

     import { mountFlipbook } from './lib/flipbook-view.js';
     mountFlipbook(document.getElementById('view-flipbook'), { apiBase, mode: 'backtest' });
   ========================================================================== */

import * as Charts from './chart-engine.js';
import {
  fetchKlines, syntheticSeries, INSTRUMENTS, INTERVAL_MS, createPoller, LIVE_POLL_MS,
  loadInstruments, resolveInstrument, dpForPrice, SOURCE_LABEL,
} from './data-adapter.js';
import { openInstrumentPicker } from './instrument-picker.js';
import { gradeEntry, priceContext } from './grade-client.js';
import { createCapture, getCapture, listCaptures, deleteCapture } from './capture-client.js';
import { buildSessionOptions, openSessionEditor } from './sessions-ui.js';
import { getSessions, formatRange } from './sessions-store.js';
import { enableWindowSelect } from './window-select.js';
import { setReaderAsset } from './audio-reader.js';
import {
  SETUPS, listEntries, saveEntry, offsetForWindow, currentSession, configure, syncFromServer,
} from './journal-store.js';
import {
  TRACKS, DEMO_TRACK, DEFAULT_TRACK, trackById, PANEL_CANDLES, stepCandles, fmtGap,
  recentSessions, sessionDate, forwardPlan,
} from './track-modes.js';

const SNAPS = 6;                       // panels
const LAST = SNAPS - 1;
const PILLS = 6;                       // instruments shown as quick-pick pills
const OVERLAYS = ['15m', '1h', '4h', '1d'];
const TRACK_POLL_MS = 15_000;

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad2 = n => String(n).padStart(2, '0');
const fmtHM = t => { const d = new Date(t); return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`; };
/** '13 Oct 14:21' in local time. */
const fmtWhen = t => { const d = new Date(t); return `${d.getDate()} ${MON[d.getMonth()]} ${fmtHM(t)}`; };
/** Panel timestamp: the date matters once steps are 8h or longer. */
const fmtStamp = (t, stepMs) => (stepMs >= 8 * 3_600_000 ? fmtWhen(t) : fmtHM(t));
const fmtEta = ms => {
  const m = Math.round(ms / 60000), h = Math.floor(m / 60);
  return h >= 48 ? `${Math.floor(h / 24)}d ${h % 24}h` : h ? `${h}h ${m % 60}m` : `${Math.max(1, m)}m`;
};

function readPref(key) { try { return JSON.parse(localStorage.getItem(key)) || {}; } catch { return {}; } }
function writePref(key, v) { try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* quota */ } }

/** The track a capture follows; captures from before tracks existed fall back to their fixed cadence. */
const captureTrack = cap => trackById(cap.track)
  || { id: 'legacy', label: fmtGap(cap.cadenceMs), kind: 'gap', stepMs: cap.cadenceMs, tfs: [cap.interval] };

const css = `
#__ROOT__{display:flex;flex-direction:column;height:100%;min-height:0;background:var(--bg);color:var(--ink);font-family:var(--sans)}
#__ROOT__ .fb-bar{display:flex;align-items:center;gap:14px;padding:11px 20px;border-bottom:1px solid var(--panel-edge);background:var(--panel);flex:0 0 auto;overflow-x:auto}
#__ROOT__ .fb-lbl{font-family:var(--mono);font-size:9px;letter-spacing:1.2px;text-transform:uppercase;color:var(--ink-faint);flex:0 0 auto}
#__ROOT__ .fb-pills{display:flex;gap:6px;flex:0 0 auto}
#__ROOT__ .fb-pill{font-family:var(--mono);font-size:11.5px;font-weight:600;color:var(--ink-faint);background:transparent;border:1px solid var(--line);border-radius:8px;padding:7px 12px;cursor:pointer;transition:.14s;display:flex;align-items:center;gap:8px}
#__ROOT__ .fb-pill:hover{color:var(--ink-dim);border-color:var(--ink-faint)}
#__ROOT__ .fb-pill.on{color:var(--amber);border-color:var(--amber);background:var(--amber-soft)}
#__ROOT__ .fb-pill .ic{font-size:9px;font-weight:700}
#__ROOT__ .fb-pill .ic.up{color:var(--teal)} #__ROOT__ .fb-pill .ic.down{color:var(--rose)}
#__ROOT__ .fb-pill-search{padding:7px 11px;font-size:13px}
#__ROOT__ .fb-src{color:var(--teal)} #__ROOT__ .fb-src.off{color:var(--rose)}
#__ROOT__ .fb-tf{display:inline-flex;background:var(--panel-2);border:1px solid var(--line);border-radius:9px;padding:3px;gap:2px;flex:0 0 auto}
#__ROOT__ .fb-tf button{font-family:var(--mono);font-size:11px;font-weight:700;color:var(--ink-faint);background:transparent;border:none;border-radius:6px;padding:6px 10px;cursor:pointer;transition:.14s}
#__ROOT__ .fb-tf button:hover{color:var(--ink-dim)} #__ROOT__ .fb-tf button.on{color:var(--teal);background:var(--teal-soft)}
#__ROOT__ .fb-tf button.locked{color:var(--amber);cursor:default}
#__ROOT__ .fb-meta{margin-left:auto;font-family:var(--mono);font-size:10.5px;color:var(--ink-faint);letter-spacing:.3px;display:flex;align-items:center;gap:8px;flex:0 0 auto;white-space:nowrap}
#__ROOT__ .fb-meta b{color:var(--ink-dim)}
#__ROOT__ .fb-sel{font-family:var(--mono);font-size:11px;color:var(--ink-dim);background:var(--panel-2);border:1px solid var(--line);border-radius:8px;padding:6px 8px;cursor:pointer;flex:0 0 auto}
#__ROOT__ .fb-sel:focus{outline:none;border-color:var(--teal)}
#__ROOT__ .fb-capture{font-family:var(--mono);font-size:11px;font-weight:700;color:var(--teal);background:var(--teal-soft);border:1px solid var(--teal);border-radius:8px;padding:7px 12px;cursor:pointer;flex:0 0 auto;transition:.14s}
#__ROOT__ .fb-capture:hover{filter:brightness(1.08)}
#__ROOT__ .fb-capture.live{color:var(--rose);background:var(--rose-soft);border-color:var(--rose)}
#__ROOT__ .fb-pending{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;background:repeating-linear-gradient(135deg,var(--panel) 0 10px,var(--panel-2) 10px 20px);color:var(--ink-faint);font-family:var(--mono);font-size:11px;text-align:center;padding:10px}
#__ROOT__ .fb-pending .po-tag{font-size:13px;font-weight:700;color:var(--ink-dim)}
#__ROOT__ .fb-pending.capturing{color:var(--teal)}
#__ROOT__ .fb-sel:disabled{opacity:.7;cursor:default}
#__ROOT__ .fb-panel.no-journal .fb-journal-hint{display:none}
#__ROOT__ .fb-toast{position:absolute;left:50%;bottom:22px;transform:translate(-50%,8px);z-index:60;max-width:min(92%,460px);font-family:var(--mono);font-size:11px;line-height:1.45;color:var(--ink);background:var(--panel-2);border:1px solid var(--line);border-radius:9px;padding:9px 14px;box-shadow:0 10px 26px rgba(0,0,0,.45);opacity:0;pointer-events:none;transition:.2s}
#__ROOT__ .fb-toast.show{opacity:1;transform:translate(-50%,0)}

#__ROOT__ .fb-strip{flex:1;min-height:0;display:flex;gap:10px;padding:16px 20px 20px}
#__ROOT__ .fb-panel{position:relative;flex:1 1 0;min-width:0;display:flex;flex-direction:column;background:var(--panel);border:1px solid var(--panel-edge);border-radius:12px;overflow:hidden;cursor:pointer;transition:flex-grow .32s cubic-bezier(.4,0,.2,1),border-color .2s}
#__ROOT__ .fb-panel.active{flex-grow:5;cursor:default;border-color:var(--line)}
#__ROOT__ .fb-panel:not(.active):hover{border-color:var(--ink-faint)}
#__ROOT__ .fb-head{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:9px 11px;border-bottom:1px solid var(--panel-edge);flex:0 0 auto;min-width:0}
#__ROOT__ .fb-tag{font-family:var(--mono);font-size:11px;font-weight:700;color:var(--amber);flex:0 0 auto}
#__ROOT__ .fb-snap{font-family:var(--mono);font-size:9.5px;color:var(--ink-faint);letter-spacing:.3px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#__ROOT__ .fb-canvas-wrap{position:relative;flex:1;min-height:0}
#__ROOT__ canvas{display:block;width:100%;height:100%}
#__ROOT__ .fb-journal-hint{position:absolute;left:50%;bottom:12px;transform:translateX(-50%);font-family:var(--mono);font-size:10px;letter-spacing:.4px;color:var(--ink-dim);background:rgba(11,13,16,.72);border:1px solid var(--line);border-radius:20px;padding:5px 12px;pointer-events:none;opacity:0;transition:.18s}
#__ROOT__ .fb-panel.active:hover .fb-journal-hint{opacity:1}
#__ROOT__ .fb-panel.journaled .fb-tag::after{content:" ●";color:var(--teal);font-size:9px}

#__ROOT__ .fb-panel.is-outcome{border-color:var(--teal)}
#__ROOT__ .fb-panel.is-outcome::after{content:"";position:absolute;inset:0;border-radius:12px;border:1.5px solid var(--teal);pointer-events:none;animation:fb-pulse 1.8s ease-in-out infinite}
@keyframes fb-pulse{0%,100%{opacity:.25}50%{opacity:.9}}
#__ROOT__ .fb-outcome-tag{position:absolute;top:9px;left:11px;z-index:2;font-family:var(--mono);font-size:9.5px;font-weight:700;color:var(--teal);background:var(--teal-soft);border:1px solid var(--teal);border-radius:6px;padding:3px 7px;pointer-events:none}

/* overlays */
#__ROOT__ .fb-scrim{position:absolute;inset:0;background:rgba(7,9,11,.55);backdrop-filter:blur(2px);opacity:0;pointer-events:none;transition:.18s;z-index:40}
#__ROOT__ .fb-scrim.show{opacity:1;pointer-events:auto}
#__ROOT__ .fb-sheet{position:absolute;top:0;right:0;height:100%;width:min(75%,520px);transform:translateX(102%);transition:transform .26s cubic-bezier(.4,0,.2,1);background:var(--panel);border-left:1px solid var(--line);z-index:50;display:flex;flex-direction:column;box-shadow:-18px 0 40px rgba(0,0,0,.4)}
#__ROOT__ .fb-sheet.open{transform:none}
#__ROOT__ .fb-sheet-head{display:flex;align-items:center;gap:10px;padding:15px 18px;border-bottom:1px solid var(--panel-edge);flex:0 0 auto}
#__ROOT__ .fb-sheet-head h3{font-size:14px;font-weight:700;margin:0}
#__ROOT__ .fb-sheet-head .dot{width:7px;height:7px;border-radius:50%;background:var(--amber)}
#__ROOT__ .fb-badge{font-family:var(--mono);font-size:8.5px;font-weight:700;letter-spacing:1px;color:var(--teal);background:var(--teal-soft);border:1px solid var(--teal);border-radius:5px;padding:2px 6px}
#__ROOT__ .fb-x{margin-left:auto;background:transparent;border:none;color:var(--ink-faint);font-size:20px;line-height:1;cursor:pointer;padding:0 4px}
#__ROOT__ .fb-x:hover{color:var(--ink)}
#__ROOT__ .fb-sheet-body{flex:1;min-height:0;overflow-y:auto;padding:16px 18px;display:flex;flex-direction:column;gap:15px}
#__ROOT__ .fb-field{display:flex;flex-direction:column;gap:6px}
#__ROOT__ .fb-field > label{font-family:var(--mono);font-size:9px;letter-spacing:1px;text-transform:uppercase;color:var(--ink-faint)}
#__ROOT__ .fb-field select,#__ROOT__ .fb-field input,#__ROOT__ .fb-field textarea{font-family:var(--sans);font-size:13px;color:var(--ink);background:var(--panel-2);border:1px solid var(--line);border-radius:8px;padding:9px 11px;width:100%;resize:none}
#__ROOT__ .fb-window-row{display:flex;gap:8px;align-items:stretch}
#__ROOT__ .fb-window-row select{flex:1}
#__ROOT__ .fb-window-manage{flex:0 0 auto;font-size:14px;color:var(--ink-dim);background:var(--panel-2);border:1px solid var(--line);border-radius:8px;padding:0 11px;cursor:pointer}
#__ROOT__ .fb-window-manage:hover{color:var(--ink);border-color:var(--ink-faint)}
#__ROOT__ .fb-window-manage.on{color:var(--amber);border-color:var(--amber);background:var(--amber-soft)}
#__ROOT__ .fb-field textarea{min-height:64px;line-height:1.45}
#__ROOT__ .fb-field input:focus,#__ROOT__ .fb-field select:focus,#__ROOT__ .fb-field textarea:focus{outline:none;border-color:var(--amber)}
#__ROOT__ .fb-conv{display:flex;align-items:center;gap:12px}
#__ROOT__ .fb-conv input[type=range]{flex:1;accent-color:var(--amber)}
#__ROOT__ .fb-conv .val{font-family:var(--mono);font-size:13px;font-weight:700;color:var(--amber);min-width:42px;text-align:right}
#__ROOT__ .fb-pred-row{display:flex;align-items:center;gap:8px;font-family:var(--mono);font-size:11px;color:var(--ink-dim)}
#__ROOT__ .fb-pred-row input{width:56px;text-align:center;font-weight:700;color:var(--amber)}
#__ROOT__ .fb-pred-row b{color:var(--teal)}
#__ROOT__ .fb-sheet-foot{display:flex;align-items:center;gap:12px;padding:13px 18px;border-top:1px solid var(--panel-edge);flex:0 0 auto}
#__ROOT__ .fb-sheet-foot .hint{font-family:var(--mono);font-size:10px;color:var(--ink-faint)}
#__ROOT__ .fb-save{margin-left:auto;font-family:var(--mono);font-size:12px;font-weight:700;color:var(--bg);background:var(--amber);border:none;border-radius:8px;padding:9px 18px;cursor:pointer}
#__ROOT__ .fb-save:hover{filter:brightness(1.06)}

#__ROOT__ .fb-verdict{font-family:var(--mono);font-size:14px;font-weight:700;letter-spacing:.4px;display:flex;align-items:center;gap:8px}
#__ROOT__ .fb-verdict.partial{color:var(--amber)} #__ROOT__ .fb-verdict.hit{color:var(--teal)} #__ROOT__ .fb-verdict.miss{color:var(--rose)}
#__ROOT__ .fb-ai-text{font-size:13px;line-height:1.5;color:var(--ink-dim)}
#__ROOT__ .fb-ai-sample{font-size:12.5px;line-height:1.5;color:var(--ink-faint);border-left:2px solid var(--line);padding-left:11px}
#__ROOT__ .fb-ai-sample em{color:var(--ink-dim);font-style:normal;display:block;font-family:var(--mono);font-size:9px;letter-spacing:1px;text-transform:uppercase;margin-bottom:4px}

/* ---- mobile: Instagram-style vertical feed (scroll T → T+5) ---- */
@media (max-width:720px){
  #__ROOT__ .fb-strip{flex-direction:column;overflow-y:auto;overflow-x:hidden;gap:14px;padding:14px;scroll-snap-type:y proximity}
  #__ROOT__ .fb-panel{flex:0 0 auto;height:64vh;min-height:300px;cursor:pointer;scroll-snap-align:start}
  #__ROOT__ .fb-panel.active{flex-grow:0}
  #__ROOT__ .fb-panel:not(.active):hover{border-color:var(--panel-edge)}
  #__ROOT__ .fb-head{padding:11px 13px}
  #__ROOT__ .fb-tag{font-size:13px}
  #__ROOT__ .fb-journal-hint{opacity:1;bottom:14px;font-size:11px;padding:6px 14px}
  #__ROOT__ .fb-sheet{width:100%}
  #__ROOT__ .fb-bar{gap:10px;padding:11px 14px}
  #__ROOT__ .fb-meta{font-size:9.5px}
}
`;


export function mountFlipbook(root, { apiBase = 'http://localhost:3001', mode = 'backtest' } = {}) {
  if (!root.id) root.id = 'view-flipbook';
  injectStyle(root.id);
  configure({ apiBase });

  const isTrack = mode === 'track';
  const mq = window.matchMedia('(max-width: 720px)');
  const prefKey = `flipbook.track.${mode}`;
  const pref = readPref(prefKey);

  const state = {
    mode, apiBase, symbol: 'BERA', dp: 4, overlay: 0,
    track: trackById(pref.track) || trackById(DEFAULT_TRACK),
    interval: pref.tf,
    active: 0, series: [], sessions: null, entries: [], feed: mq.matches,
    outcome: null,            // { from, idx, entryId } — the journaled panel and its target
    lastEntry: null,          // backtest: the entry saved on this screen
    journalFrom: 0, journalPoint: null,
    capture: null, captures: [], pollTimer: null,   // track mode
    live: null,               // backtest: 5s candle poller
  };
  if (!state.track.tfs.includes(state.interval)) state.interval = state.track.tfs[0];
  loadInstruments(apiBase);   // full coin list for search + source lookup

  /* ---- labels & rules that depend on the mode ---- */
  const tagFor = i => (isTrack ? (i ? `T+${i}` : 'T') : (i === LAST ? 'T' : `T−${LAST - i}`));
  /** The track the panels on screen follow (a capture's own, when viewing one). */
  const viewTrack = () => (isTrack && state.capture ? captureTrack(state.capture) : state.track);
  const maxSteps = from => (isTrack ? LAST : LAST - from);
  const hasData = i => !!state.series[i]?.length;
  const canJournal = i => (isTrack ? i === 0 : i < LAST) && hasData(i);
  /** Panels between the journaled one and its target, for a window of `n` hours (gap) or sessions. */
  const offsetFor = (n, from) => {
    const tr = viewTrack();
    const off = tr.kind === 'session' ? Math.max(1, Math.round(n)) : offsetForWindow(n, tr.stepMs);
    return Math.min(off, maxSteps(from));
  };
  state.offsetFor = offsetFor;
  state.tagFor = tagFor;
  state.viewTrack = viewTrack;
  state.maxSteps = maxSteps;

  /* ---- scaffold ---- */
  root.innerHTML = barHTML(isTrack) + `<div class="fb-strip"></div>` + overlaysHTML() + `<div class="fb-toast"></div>`;
  const strip = root.querySelector('.fb-strip');
  const $ = sel => root.querySelector(sel);
  const els = {
    pills: $('.fb-pills'), session: $('[data-session]'), basis: $('[data-basis]'),
    metaCount: $('[data-count]'), source: $('[data-source]'), tf: $('.fb-tf'),
    trackSel: $('[data-track]'), tfSel: $('[data-tf]'), tracks: $('[data-tracks]'),
    captureBtn: $('[data-capture]'), toast: $('.fb-toast'),
    scrim: $('.fb-scrim'), journal: $('.fb-sheet.journal'), review: $('.fb-sheet.review'),
  };
  els.session.textContent = `${currentSession()} · ${new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })}`;
  els.trackSel.innerHTML = trackOptions(isTrack);
  els.trackSel.value = state.track.id;

  /* ---- instrument pills ---- */
  const searchBtn = document.createElement('button');
  searchBtn.className = 'fb-pill fb-pill-search'; searchBtn.title = 'Search all coins';
  searchBtn.textContent = '＋';
  function addPill(sym, chg = 0) {
    const b = document.createElement('button');
    b.className = 'fb-pill'; b.dataset.sym = sym;
    b.innerHTML = `${sym}<span class="ic ${chg >= 0 ? 'up' : 'down'}">${chg >= 0 ? '▲' : '▼'}</span>`;
    b.onclick = () => selectInstrument(sym);
    els.pills.insertBefore(b, searchBtn);
  }
  els.pills.appendChild(searchBtn);
  INSTRUMENTS.slice(0, PILLS).forEach(ins => addPill(ins.sym, ins.chg ?? 0));
  searchBtn.onclick = () => openInstrumentPicker({
    anchor: searchBtn, apiBase,
    onPick: sym => {
      if (!els.pills.querySelector(`.fb-pill[data-sym="${sym}"]`)) addPill(sym);
      selectInstrument(sym);
    },
  });

  /* ---- panels (built once; draw fn reads state.active) ---- */
  const panels = [];
  for (let i = 0; i < SNAPS; i++) {
    const el = document.createElement('div');
    el.className = 'fb-panel' + (i === state.active ? ' active' : '');
    el.innerHTML =
      `<div class="fb-head"><span class="fb-tag"></span><span class="fb-snap"></span></div>` +
      `<div class="fb-canvas-wrap"><canvas></canvas><div class="fb-journal-hint">double-click to journal</div></div>`;
    const canvas = el.querySelector('canvas');
    el.onclick = () => onPanelClick(i);
    el.ondblclick = e => onPanelDblClick(i, e);
    Charts.register(canvas, (ctx, w, h) => {
      const data = state.series[i]; if (!data?.length) return;
      if (state.feed || i === state.active) Charts.candles(ctx, w, h, data, { overlay: state.overlay, dp: state.dp });
      else Charts.miniCandles(ctx, w, h, data, { timeAxis: true });
    });
    Charts.enableZoom(canvas, { touchAction: 'pan-y', dblclickReset: false });   // drag/wheel/pinch; feed still scrolls; dblclick = journal
    panels.push({
      el, canvas, wrap: el.querySelector('.fb-canvas-wrap'),
      tag: el.querySelector('.fb-tag'), snap: el.querySelector('.fb-snap'), hint: el.querySelector('.fb-journal-hint'),
    });
    strip.appendChild(el);
  }

  /* ---- toolbar: track, candle size, overlay ---- */
  function fillTfSelect(tr, tf) {
    els.tfSel.innerHTML = tr.tfs.map(t => `<option value="${t}">${t}</option>`).join('');
    els.tfSel.value = tf;
  }
  /** Overlay buttons: only timeframes larger than the candles. */
  function buildOverlayRail() {
    const base = INTERVAL_MS[state.interval];
    state.overlay = 0;
    els.tf.innerHTML = `<button class="locked" title="Candle size">${state.interval}</button>` +
      OVERLAYS.filter(o => INTERVAL_MS[o] > base)
        .map(o => `<button data-f="${INTERVAL_MS[o] / base}">${o}</button>`).join('');
    els.basis.textContent = `BASIS ${state.interval}`;
  }
  fillTfSelect(state.track, state.interval);
  buildOverlayRail();

  els.tf.addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b || b.classList.contains('locked')) return;
    const wasOn = b.classList.contains('on');
    els.tf.querySelectorAll('button:not(.locked)').forEach(x => x.classList.remove('on'));
    state.overlay = wasOn ? 0 : +b.dataset.f;
    if (!wasOn) b.classList.add('on');
    Charts.refreshAll();
  });

  els.trackSel.addEventListener('change', () => {
    state.track = trackById(els.trackSel.value);
    if (!state.track.tfs.includes(state.interval)) state.interval = state.track.tfs[0];
    onSettingsChange();
  });
  els.tfSel.addEventListener('change', () => { state.interval = els.tfSel.value; onSettingsChange(); });

  function onSettingsChange() {
    writePref(prefKey, { track: state.track.id, tf: state.interval });
    fillTfSelect(state.track, state.interval);
    if (isTrack) { if (!state.capture) showNewTrack(); return; }   // settings for the next track
    buildOverlayRail();
    clearOutcome(); state.lastEntry = null;
    loadBacktest();
  }

  /* ---- journal + review wiring ---- */
  wireJournalOverlay(root, els, state, () => panels);
  wireReviewOverlay(root, els);

  // Keyboard: ← → (and ↑ ↓) step between panels; Esc closes overlays.
  function activePanelNav(dir) {
    const next = Math.max(0, Math.min(LAST, state.active + dir));
    if (next === state.active) return;
    setActive(next);
    if (state.feed) panels[next].el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
  function onKey(e) {
    if (e.key === 'Escape') { closeOverlays(els); return; }
    const tag = (document.activeElement?.tagName || '').toLowerCase();
    if (sheetOpen() || tag === 'input' || tag === 'textarea' || tag === 'select') return;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); activePanelNav(1); }
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); activePanelNav(-1); }
  }
  document.addEventListener('keydown', onKey);

  /* ---- behaviour ---- */
  // Click selects a panel (or opens the review on the outcome panel). Double-click
  // journals at the clicked point; on the mobile feed a tap on a journalable panel does.
  function onPanelClick(i) {
    if (state.outcome?.idx === i) return openReview(i);
    if (state.feed) { if (canJournal(i)) openJournal(i); return; }
    if (i !== state.active) setActive(i);
  }
  function onPanelDblClick(i, e) {
    if (state.feed || state.outcome?.idx === i) return;
    if (!canJournal(i)) return toast(journalBlockedReason(i));
    const point = Charts.pointAt(panels[i].canvas, e.clientX, e.clientY);
    if (i !== state.active) setActive(i);
    openJournal(i, point);
  }
  function journalBlockedReason(i) {
    if (!hasData(i)) return 'No candles on this chart yet.';
    return isTrack
      ? 'Journal on T. The later charts are the outcome being tracked.'
      : 'T is the latest chart, so nothing after it exists yet. To predict what comes next, start a track in the Tracking tab.';
  }

  let toastTimer = null;
  function toast(msg) {
    els.toast.textContent = msg;
    els.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => els.toast.classList.remove('show'), 4000);
  }

  mq.addEventListener?.('change', e => { state.feed = e.matches; labelPanels(); redrawSoon(); });

  function setActive(i) {
    state.active = i;
    panels.forEach((p, k) => p.el.classList.toggle('active', k === i));
    redrawSoon();
  }
  root.__fbSetActive = setActive;

  function selectInstrument(sym) {
    state.symbol = sym;
    setReaderAsset(sym);
    state.dp = resolveInstrument(sym).dp ?? 4;
    els.pills.querySelectorAll('.fb-pill').forEach(p => p.classList.toggle('on', p.dataset.sym === sym));
    stopPolling(); stopLive();
    clearOutcome(); state.lastEntry = null;
    state.entries = listEntries(sym);
    refreshMeta();
    const load = isTrack ? loadTracking() : loadBacktest();
    load.then(() => syncFromServer(sym)).then(() => {
      if (sym !== state.symbol) return;
      state.entries = listEntries(sym);
      reflectSavedEntry();
      refreshMeta();
    });
  }

  /** Panel headers: tag (T−3 / T+2) and what the panel covers. */
  function labelPanels() {
    const tr = viewTrack(), now = Date.now();
    panels.forEach((p, i) => {
      p.tag.textContent = tagFor(i);
      p.el.classList.toggle('no-journal', !canJournal(i));
      p.hint.textContent = state.feed ? 'tap to journal' : 'double-click to journal';
      p.snap.textContent = isTrack ? captureHeader(i) : backtestHeader(i, tr, now);
    });
  }
  function backtestHeader(i, tr, now) {
    if (tr.kind === 'session') {
      const s = state.sessions?.[i];
      return s ? `${tr.label} · ${sessionDate(tr, s)}${s.end > now ? ' · live' : ''}` : '—';
    }
    const t = state.series[i]?.at(-1)?.t;
    const when = t ? fmtStamp(t, tr.stepMs) : '—';
    return i === LAST ? when : `−${fmtGap((LAST - i) * tr.stepMs)} · ${when}`;
  }
  function captureHeader(i) {
    const cap = state.capture;
    if (!cap) return i ? `+${i} ${viewTrack().kind === 'session' ? 'session' : 'step'}` : 'not started';
    const tr = captureTrack(cap), snap = cap.snapshots[i];
    if (!snap) return '—';
    if (tr.kind === 'session' && snap.start != null) return `${tr.label} · ${sessionDate(tr, { start: snap.start, end: snap.end + 1 })}`;
    const when = fmtStamp(snap.due, tr.stepMs);
    return i ? `+${fmtGap(i * tr.stepMs)} · ${when}` : when;
  }

  /* ---- backtest: T−5 … T from history, refreshed live ---- */

  /** Candles for all six panels, oldest first. Gap tracks slice one long fetch; sessions fetch each session. */
  async function fetchPanels(ins, tr, tf, signal) {
    if (tr.kind === 'gap') {
      const step = stepCandles(tr, tf);
      const full = await fetchKlines({
        apiBase, symbol: ins.pair, interval: tf, source: ins.source, limit: PANEL_CANDLES + LAST * step, signal,
      });
      if (full.length < PANEL_CANDLES / 2) throw new Error('short');
      return { series: slicePanels(full, step), sessions: null, source: full.source };
    }
    const sessions = recentSessions(tr, SNAPS);
    const series = await Promise.all(sessions.map(s => fetchSession(ins, tf, s, signal)));
    return { series, sessions, source: series.find(s => s?.source)?.source };
  }
  const fetchSession = (ins, tf, s, signal) => fetchKlines({
    apiBase, symbol: ins.pair, interval: tf, source: ins.source, start: s.start, end: s.end - 1, signal,
  });
  /** Six same-width windows, `step` candles apart; the last ends at the latest candle. */
  function slicePanels(full, step) {
    return Array.from({ length: SNAPS }, (_, i) => {
      const end = full.length - (LAST - i) * step;
      return end > 0 ? full.slice(Math.max(0, end - PANEL_CANDLES), end) : null;
    });
  }
  /** Offline stand-in with the same shape, so the page still renders without the server. */
  function syntheticPanels(ins, tr, tf) {
    const tfMs = INTERVAL_MS[tf];
    const gen = (n, endT) => syntheticSeries({ n, base: ins.base, seed: ins.seed, vol: ins.vol, ramp: 1.2, stepMs: tfMs })
      .map((c, k, a) => ({ ...c, t: endT - (a.length - 1 - k) * tfMs }));
    if (tr.kind === 'gap') {
      const step = stepCandles(tr, tf);
      return { series: slicePanels(gen(PANEL_CANDLES + LAST * step, Date.now()), step), sessions: null };
    }
    const sessions = recentSessions(tr, SNAPS);
    return {
      sessions,
      series: sessions.map(s => {
        const end = Math.min(s.end - 1, Date.now());
        return gen(Math.max(1, Math.floor((end - s.start) / tfMs) + 1), s.start + Math.floor((end - s.start) / tfMs) * tfMs);
      }),
    };
  }

  function applyPanels({ series, sessions, source }, ins, live) {
    state.series = series;
    state.sessions = sessions;
    const lastClose = series.findLast(s => s?.length)?.at(-1)?.c;
    if (ins.dp == null && lastClose) state.dp = dpForPrice(lastClose);
    labelPanels();
    const src = source || ins.source;
    els.source.textContent = src === 'sample' ? SOURCE_LABEL.sample
      : live ? `${SOURCE_LABEL[src]} · LIVE ${LIVE_POLL_MS / 1000}s` : 'OFFLINE · SAMPLE DATA';
    els.source.classList.toggle('off', !live);
    redrawSoon();
  }

  async function loadBacktest() {
    stopLive();
    const sym = state.symbol, tr = state.track, tf = state.interval, ins = resolveInstrument(sym);
    let result, live = true;
    try { result = await fetchPanels(ins, tr, tf); }
    catch { live = false; result = syntheticPanels(ins, tr, tf); }
    if (sym !== state.symbol || tr !== state.track || tf !== state.interval) return;   // settings changed mid-fetch
    applyPanels(result, ins, live);
    startLive();
  }

  // Refresh every 5s. Gap tracks refetch the window; session tracks refetch only
  // the latest session (or everything once a new session starts). Paused while a
  // sheet is open so nothing shifts under the user; errors keep the last good data.
  function startLive() {
    stopLive();
    const sym = state.symbol, tr = state.track, tf = state.interval, ins = resolveInstrument(sym);
    const current = () => sym === state.symbol && tr === state.track && tf === state.interval;
    state.live = createPoller(async signal => {
      if (!current() || sheetOpen()) return;
      if (tr.kind === 'gap') {
        const next = await fetchPanels(ins, tr, tf, signal);
        if (current()) applyPanels(next, ins, true);
        return;
      }
      const latest = recentSessions(tr, 1)[0];
      if (latest.start !== state.sessions?.[LAST]?.start) {
        const next = await fetchPanels(ins, tr, tf, signal);
        if (current()) applyPanels(next, ins, true);
        return;
      }
      const candles = await fetchSession(ins, tf, latest, signal);
      if (!current()) return;
      const series = state.series.slice(); series[LAST] = candles;
      applyPanels({ series, sessions: state.sessions, source: candles.source }, ins, true);
    }, { intervalMs: LIVE_POLL_MS, immediate: false });
  }
  function stopLive() { state.live?.stop(); state.live = null; }
  const sheetOpen = () => els.journal.classList.contains('open') || els.review.classList.contains('open');

  /* ---- tracking: forward captures, T … T+5 ---- */
  const capKey = sym => `flipbook.track.${sym}`;

  async function loadTracking() {
    const sym = state.symbol;
    let caps = [];
    try { caps = await listCaptures({ apiBase, symbol: resolveInstrument(sym).pair }); } catch { /* offline */ }
    if (sym !== state.symbol) return;
    state.captures = caps;
    const pick = caps.find(c => c.id === localStorage.getItem(capKey(sym))) || caps[0];
    if (pick) await openCapture(pick.id); else showNewTrack();
  }

  function fillTracksSelect() {
    els.tracks.innerHTML = `<option value="">＋ New track</option>` + state.captures.map(c => {
      const tr = captureTrack(c);
      return `<option value="${c.id}">${tr.label} · ${c.interval} · from ${fmtWhen(c.createdAt)} · ${c.captured}/${c.snaps}</option>`;
    }).join('');
    els.tracks.value = state.capture?.id || '';
  }
  els.tracks?.addEventListener('change', () => (els.tracks.value ? openCapture(els.tracks.value) : showNewTrack()));

  async function openCapture(id) {
    stopPolling();
    try {
      const cap = await getCapture({ apiBase, id });
      state.capture = cap;
      localStorage.setItem(capKey(state.symbol), id);
      state.interval = cap.interval;
      buildOverlayRail();
      clearOutcome();
      renderFromCapture(cap);
      reflectSavedEntry();
      if (!cap.snapshots.every(s => s.capturedAt)) startPolling();
    } catch {
      showNewTrack();
      return;
    }
    setTrackControls();
  }

  function showNewTrack() {
    stopPolling();
    state.capture = null;
    const tf = readPref(prefKey).tf;   // the settings chosen for the next track
    state.interval = state.track.tfs.includes(tf) ? tf : state.track.tfs[0];
    clearOutcome();
    buildOverlayRail();
    state.series = [];
    panels.forEach((p, i) => setPending(p, null, i));
    labelPanels();
    els.source.textContent = 'NO TRACK SELECTED';
    els.source.classList.remove('off');
    setTrackControls();
    redrawSoon();
  }

  /** New track: settings editable, Start button. Existing track: its settings shown read-only, Delete button. */
  function setTrackControls() {
    const viewing = !!state.capture;
    if (viewing) {
      const tr = captureTrack(state.capture);
      if (trackById(tr.id)) els.trackSel.value = tr.id;
      fillTfSelect({ tfs: [state.capture.interval] }, state.capture.interval);
    } else {
      els.trackSel.value = state.track.id;
      fillTfSelect(state.track, state.interval);
    }
    els.trackSel.disabled = els.tfSel.disabled = viewing;
    els.captureBtn.classList.toggle('live', viewing);
    els.captureBtn.textContent = viewing ? '✕ Delete track' : '● Start tracking';
    fillTracksSelect();
  }

  function renderFromCapture(cap) {
    els.source.textContent = `${SOURCE_LABEL[cap.source || 'okx']} · TRACKING`;
    els.source.classList.remove('off');
    state.series = cap.snapshots.map(s => s.candles || null);
    const lastClose = state.series.findLast(s => s?.length)?.at(-1)?.c;
    if (resolveInstrument(state.symbol).dp == null && lastClose) state.dp = dpForPrice(lastClose);
    labelPanels();
    panels.forEach((p, i) => setPending(p, cap.snapshots[i], i));
    redrawSoon();
  }

  /** Striped placeholder over a panel that has nothing to show yet. */
  function setPending(panel, snap, i) {
    panel.wrap.querySelector('.fb-pending')?.remove();
    if (snap?.capturedAt) return;
    const el = document.createElement('div');
    let when;
    if (!snap) when = i === 0 ? 'Choose a track and candle size,<br>then press Start tracking' : 'waiting for T';
    else {
      const now = Date.now();
      when = snap.due <= now ? 'capturing…' : `due in ${fmtEta(snap.due - now)}`;
      el.classList.toggle('capturing', snap.due <= now);
    }
    el.classList.add('fb-pending');
    el.innerHTML = `<span class="po-tag">${tagFor(i)}</span><span>${when}</span>`;
    panel.wrap.appendChild(el);
  }

  function startPolling() {
    stopPolling();
    state.pollTimer = setInterval(async () => {
      const id = state.capture?.id; if (!id) return stopPolling();
      try {
        const cap = await getCapture({ apiBase, id });
        if (state.capture?.id !== id) return;
        const filled = cap.snapshots.filter(s => s.capturedAt).length;
        state.capture = cap;
        if (sheetOpen()) return;   // don't redraw under an open sheet; next poll catches up
        renderFromCapture(cap);
        reflectSavedEntry();
        if (filled !== state.captures.find(c => c.id === id)?.captured) {
          const c = state.captures.find(x => x.id === id); if (c) c.captured = filled;
          fillTracksSelect();
        }
        if (cap.snapshots.every(s => s.capturedAt)) stopPolling();
      } catch { /* keep trying */ }
    }, TRACK_POLL_MS);
  }
  function stopPolling() { clearInterval(state.pollTimer); state.pollTimer = null; }

  async function startTrack() {
    const ins = resolveInstrument(state.symbol), tr = state.track, tf = state.interval;
    els.captureBtn.disabled = true; els.captureBtn.textContent = 'Starting…';
    try {
      const cap = await createCapture({
        apiBase, symbol: ins.pair, interval: tf, source: ins.source,
        track: tr.id, plan: forwardPlan(tr, tf, SNAPS),
      });
      state.captures = await listCaptures({ apiBase, symbol: ins.pair }).catch(() => [cap]);
      await openCapture(cap.id);
    } catch (e) {
      toast(`Couldn't start the track: ${e.message}`);
      setTrackControls();
    } finally {
      els.captureBtn.disabled = false;
    }
  }

  async function deleteTrack() {
    const cap = state.capture; if (!cap) return;
    if (!window.confirm('Delete this track and the charts it has captured?')) return;
    try { await deleteCapture({ apiBase, id: cap.id }); }
    catch (e) { return toast(`Couldn't delete the track: ${e.message}`); }
    localStorage.removeItem(capKey(state.symbol));
    state.capture = null;
    await loadTracking();
  }
  els.captureBtn?.addEventListener('click', () => (state.capture ? deleteTrack() : startTrack()));

  /* ---- journal → outcome ---- */

  function clearOutcome() {
    state.outcome = null;
    panels.forEach(p => {
      p.el.classList.remove('is-outcome', 'journaled');
      p.wrap.querySelectorAll('.fb-outcome-tag').forEach(n => n.remove());
    });
  }

  /** Mark the journaled panel and pulse the panel its prediction is graded against. */
  function markOutcome(entry) {
    clearOutcome();
    const from = entry.fromIdx ?? 0, idx = from + entry.targetOffset;
    const p = panels[idx]; if (!p) return;
    state.outcome = { from, idx, entryId: entry.id };
    panels[from]?.el.classList.add('journaled');
    p.el.classList.add('is-outcome');
    const tag = document.createElement('div');
    tag.className = 'fb-outcome-tag';
    tag.textContent = `↳ OUTCOME · grades ${tagFor(idx)}`;
    p.wrap.appendChild(tag);
  }

  /** Tracking: the latest entry on this track. Backtest: the entry just saved, if the view still matches it. */
  function reflectSavedEntry() {
    let entry = null;
    if (isTrack) entry = state.capture && state.entries.find(e => e.captureId === state.capture.id && e.targetOffset != null);
    else {
      const e = state.lastEntry;
      if (e && e.symbol === state.symbol && e.track === state.track.id && e.interval === state.interval) entry = e;
    }
    if (entry) markOutcome(entry); else clearOutcome();
  }

  function openJournal(i, point = null) {
    state.journalFrom = i;
    state.journalPoint = point;
    fillJournal(root, state);
    els.journal.querySelector('.fb-sheet-head h3').textContent = point
      ? `Journal · ${tagFor(i)} · ${fmtWhen(point.t)} · ${Charts.formatPrice(point.price, { dp: state.dp })}`
      : `Journal · ${tagFor(i)}`;
    els.scrim.classList.add('show'); els.journal.classList.add('open');
    root.querySelector('.fb-sheet.journal textarea')?.focus();
  }

  function openReview(i) {
    const entry = state.entries.find(e => e.id === state.outcome?.entryId) || state.lastEntry;
    root.__fbReview = { idx: i, entryId: entry?.id };
    fillReview(root, entry, tagFor(i), reviewWaiting(i));
    els.scrim.classList.add('show'); els.review.classList.add('open');
  }
  /** Tracking: why a target panel can't be graded yet, or null. */
  function reviewWaiting(i) {
    if (hasData(i)) return null;
    const snap = state.capture?.snapshots[i];
    return snap ? `${tagFor(i)} hasn't been captured yet (due in ${fmtEta(Math.max(0, snap.due - Date.now()))}). Grade it once it arrives.` : 'Nothing to grade against yet.';
  }

  // persist a grade onto its entry so the dashboard picks it up
  root.__fbGraded = (id, result) => {
    const saved = saveEntry({
      id, symbol: state.symbol,
      outcome: { verdict: result.verdict, R: result.R, rationale: result.rationale, gradedAt: Date.now(), by: result.by },
    });
    if (state.lastEntry?.id === id) state.lastEntry = saved;
    state.entries = listEntries(state.symbol);
  };

  function refreshMeta() { els.metaCount.textContent = state.entries.length; }

  // Each save is a new entry, so a backtest builds up one call per prediction.
  root.__fbSave = form => {
    const from = state.journalFrom, tr = viewTrack();
    const sess = getSessions().find(x => x.id === form.windowSessionId);
    const entry = saveEntry({
      symbol: state.symbol,
      session: sess?.name || els.session.textContent,
      setup: form.setup,
      conviction: form.conviction,
      windowSessionId: form.windowSessionId,
      windowText: form.windowText,
      ...(tr.kind === 'session' ? { windowSessions: form.windowN, trackLabel: tr.label } : { windowHours: form.windowN }),
      mode, track: tr.id, interval: state.interval,
      fromIdx: from,
      fromT: state.series[from]?.at(-1)?.t ?? null,
      targetOffset: offsetFor(form.windowN, from),
      ...(isTrack && state.capture && { captureId: state.capture.id }),
      note: form.note,
      prediction: form.prediction,
      ...(state.journalPoint && { point: { t: state.journalPoint.t, price: state.journalPoint.price } }),
    });
    state.lastEntry = entry;
    state.entries = listEntries(state.symbol);
    markOutcome(entry);
    refreshMeta();
    closeOverlays(els);
  };
  root.__fbState = state;

  function redrawSoon() {
    requestAnimationFrame(() => requestAnimationFrame(() => Charts.refreshAll()));
    setTimeout(() => Charts.refreshAll(), 120);
  }

  /* ---- boot ---- */
  selectInstrument(state.symbol);

  return { refresh: () => Charts.refreshAll() };
}

/* ---- overlay wiring (kept out of mount for readability) ----------------- */

function wireJournalOverlay(root, els, state, getPanels) {
  const sheet = els.journal;
  sheet.querySelector('.fb-x').onclick = () => closeOverlays(els);
  els.scrim.onclick = () => closeOverlays(els);
  sheet.onclick = e => e.stopPropagation();

  const conv = sheet.querySelector('input[type=range]');
  const convVal = sheet.querySelector('.fb-conv .val');
  conv.oninput = () => { convVal.textContent = conv.value + '%'; };

  const hours = sheet.querySelector('[data-hours]');
  hours.oninput = () => syncTarget(root, state);

  // Draggable window selector, on whichever panel is being journaled (independent of the dropdown).
  const selectors = new Map();
  const onChange = sel => {
    state.customWindow = sel;
    const wsel = sheet.querySelector('[data-window-select]');
    let opt = wsel.querySelector('option[value="__custom__"]');
    if (!opt) { opt = document.createElement('option'); opt.value = '__custom__'; wsel.insertBefore(opt, wsel.firstChild); }
    opt.textContent = `Custom · ${sel.label}`;
    wsel.value = '__custom__';
  };
  const selectorFor = i => {
    if (!selectors.has(i)) selectors.set(i, enableWindowSelect(getPanels()[i].canvas, { getData: () => state.series[i], onChange }));
    return selectors.get(i);
  };
  const drawBtn = sheet.querySelector('[data-draw-window]');
  els.__drawBtn = drawBtn;
  drawBtn.onclick = () => {
    if (els.__wsel?.isVisible()) { els.__wsel.hide(); drawBtn.classList.remove('on'); return; }
    const i = state.journalFrom;
    root.__fbSetActive?.(i);              // make the journaled panel the large chart first
    els.__wsel = selectorFor(i);
    requestAnimationFrame(() => { els.__wsel.show(); drawBtn.classList.add('on'); });
  };

  sheet.querySelector('.fb-save').onclick = () => {
    const wsel = sheet.querySelector('[data-window-select]');
    const custom = wsel.value === '__custom__' && state.customWindow;
    const sess = custom ? null : getSessions().find(x => x.id === wsel.value);
    root.__fbSave({
      setup: sheet.querySelector('[data-setup]').value,
      windowSessionId: sess?.id || null,
      windowText: custom ? `Custom · ${state.customWindow.label}` : sess ? `${sess.name} · ${formatRange(sess)}` : '',
      windowN: Math.max(1, +hours.value || 1),
      conviction: +conv.value,
      note: sheet.querySelector('[data-note]').value.trim(),
      prediction: sheet.querySelector('[data-pred]').value.trim(),
    });
  };

  // Manage sessions → opens the editor, then rebuilds the dropdown.
  sheet.querySelector('[data-manage-sessions]').onclick = () => {
    const wsel = sheet.querySelector('[data-window-select]');
    const keep = wsel.value;
    openSessionEditor(() => { wsel.innerHTML = buildSessionOptions(keep); });
  };
}

/** "for the coming N hours/sessions → grades T−2": unit, limits and target follow the track. */
function syncTarget(root, state) {
  const s = root.querySelector('.fb-sheet.journal');
  const hours = s.querySelector('[data-hours]');
  const from = state.journalFrom, n = Math.max(1, +hours.value || 1);
  s.querySelector('[data-target]').textContent = state.tagFor(from + state.offsetFor(n, from));
}

function wireReviewOverlay(root, els) {
  const sheet = els.review;
  sheet.querySelector('.fb-x').onclick = () => closeOverlays(els);
  sheet.onclick = e => e.stopPropagation();

  sheet.querySelector('[data-grade]').onclick = async () => {
    const state = root.__fbState;
    const { idx, entryId } = root.__fbReview || {};
    const entry = state.entries.find(e => e.id === entryId) || state.lastEntry;
    if (!entry) {
      sheet.querySelector('[data-verdict]').textContent = 'Double-click a chart to journal a prediction first.';
      return;
    }
    const from = entry.fromIdx ?? 0;
    if (!state.series[idx]?.length) return;   // tracking: target not captured yet (explained in the sheet)
    const btn = sheet.querySelector('[data-grade]');
    btn.disabled = true; btn.textContent = 'Grading…';
    try {
      const ctx = priceContext(state.series, idx - from, from);
      const result = await gradeEntry(entry, ctx, { apiBase: state.apiBase });
      root.__fbGraded(entry.id, result);
      renderGraded(root, { ...entry, outcome: result });
    } finally {
      btn.disabled = false; btn.textContent = 'Re-grade';
    }
  };
}

const VERDICT_LABEL = { hit: '✦ HIT', partial: '✦ PARTIALLY HIT', miss: '✦ MISS' };

function renderGraded(root, entry) {
  const s = root.querySelector('.fb-sheet.review');
  const o = entry.outcome;
  const v = s.querySelector('[data-verdict]');
  v.className = 'fb-verdict ' + o.verdict;
  v.textContent = VERDICT_LABEL[o.verdict] || o.verdict;
  s.querySelector('[data-aitext]').textContent = o.rationale || '';
  const by = o.by === 'llm' ? 'Graded by Claude'
    : o.by === 'rules-local' ? 'Graded by rules, in your browser' : 'Graded by rules';
  s.querySelector('[data-by]').textContent = `${by} · ${o.R >= 0 ? '+' : ''}${o.R}R`;
  s.querySelector('[data-badge]').textContent = 'GRADED';
}

/** A blank journal form for the panel being journaled; the window unit follows the track. */
function fillJournal(root, state) {
  const s = root.querySelector('.fb-sheet.journal');
  s.querySelector('[data-setup]').value = SETUPS[0];
  s.querySelector('[data-window-select]').innerHTML = buildSessionOptions(null);
  s.querySelector('[data-note]').value = '';
  s.querySelector('[data-pred]').value = '';
  const conv = s.querySelector('input[type=range]');
  conv.value = 65;
  s.querySelector('.fb-conv .val').textContent = '65%';
  const tr = state.viewTrack(), steps = state.maxSteps(state.journalFrom);
  const hours = s.querySelector('[data-hours]');
  if (tr.kind === 'session') {
    s.querySelector('[data-unit]').textContent = `${tr.label} session${steps > 1 ? 's' : ''}`;
    hours.max = steps; hours.value = 1;
  } else {
    const stepH = tr.stepMs / 3_600_000;
    s.querySelector('[data-unit]').textContent = 'hours';
    hours.max = Math.max(1, Math.round(steps * stepH));
    hours.value = Math.max(1, Math.round(stepH));   // one step ahead
  }
  syncTarget(root, state);
}

function fillReview(root, entry, tag, waiting) {
  const s = root.querySelector('.fb-sheet.review');
  const q = s.querySelector('[data-pred-quote]');
  q.innerHTML = entry?.prediction
    ? `<em>Your prediction</em>“${escapeHtml(entry.prediction)}”`
    : `<em>No saved prediction</em>Double-click a chart to journal a call, then grade it here.`;
  const btn = s.querySelector('[data-grade]');
  btn.disabled = !!waiting;
  if (entry?.outcome) {
    renderGraded(root, entry);
    btn.textContent = 'Re-grade';
    return;
  }
  const v = s.querySelector('[data-verdict]');
  v.className = 'fb-verdict'; v.textContent = waiting ? 'Waiting for the outcome' : 'Not graded yet';
  s.querySelector('[data-aitext]').textContent = waiting
    || `Grades ${entry?.prediction ? 'your prediction' : 'a saved prediction'} against what price actually did by ${tag}.`;
  s.querySelector('[data-by]').textContent = '';
  s.querySelector('[data-badge]').textContent = 'PREVIEW';
  btn.textContent = 'Grade this call';
}

const escapeHtml = t => String(t).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function closeOverlays(els) {
  els.scrim.classList.remove('show');
  els.journal.classList.remove('open');
  els.review.classList.remove('open');
  els.__wsel?.hide();
  els.__drawBtn?.classList.remove('on');
}

/* ---- static markup ------------------------------------------------------ */

function trackOptions(isTrack) {
  const opt = t => `<option value="${t.id}">${t.label}</option>`;
  return `<optgroup label="Gap between charts">${TRACKS.filter(t => t.kind === 'gap').map(opt).join('')}</optgroup>` +
    `<optgroup label="One session per chart">${TRACKS.filter(t => t.kind === 'session').map(opt).join('')}</optgroup>` +
    (isTrack ? `<optgroup label="Testing">${opt(DEMO_TRACK)}</optgroup>` : '');
}

function barHTML(isTrack) {
  return `
  <div class="fb-bar">
    <span class="fb-lbl">Instrument</span>
    <div class="fb-pills"></div>
    <span class="fb-lbl">Track</span>
    <select class="fb-sel" data-track title="What separates one chart from the next"></select>
    <span class="fb-lbl">Candles</span>
    <select class="fb-sel" data-tf title="Candle size"></select>
    <span class="fb-lbl">Overlay</span>
    <div class="fb-tf"></div>
    ${isTrack ? `<select class="fb-sel" data-tracks title="Your tracks for this coin"></select>
    <button class="fb-capture" data-capture>● Start tracking</button>` : ''}
    <div class="fb-meta">
      <span data-session></span><span>·</span><span data-basis></span>
      <span>·</span><span class="fb-src" data-source>…</span>
      <span>·</span><b data-count>0</b><span>entries</span>
    </div>
  </div>`;
}

function overlaysHTML() {
  const setupOpts = SETUPS.map(s => `<option>${s}</option>`).join('');
  return `
  <div class="fb-scrim"></div>

  <div class="fb-sheet journal">
    <div class="fb-sheet-head"><span class="dot"></span><h3>Journal · this chart</h3>
      <button class="fb-x" aria-label="Close">×</button></div>
    <div class="fb-sheet-body">
      <div class="fb-field"><label>Setup</label>
        <select data-setup>${setupOpts}</select></div>
      <div class="fb-field"><label>Window</label>
        <div class="fb-window-row">
          <select data-window-select></select>
          <button type="button" class="fb-window-manage" data-draw-window title="Mark window on chart">📐</button>
          <button type="button" class="fb-window-manage" data-manage-sessions title="Edit sessions">⚙</button>
        </div></div>
      <div class="fb-field"><label>What happened in this chart</label>
        <textarea data-note placeholder="What you see, where price is, why it matters…"></textarea></div>
      <div class="fb-field"><label>Conviction</label>
        <div class="fb-conv"><input type="range" min="0" max="100" step="5"><span class="val">65%</span></div></div>
      <div class="fb-field"><label>Prediction</label>
        <textarea data-pred placeholder="What you expect price to do…"></textarea>
        <div class="fb-pred-row">for the coming <input data-hours type="number" min="1" max="10" value="3"> <span data-unit>hours</span> → grades <b data-target>T+2</b></div></div>
    </div>
    <div class="fb-sheet-foot"><span class="hint">Click the chart or press Esc to close</span>
      <button class="fb-save">Save entry</button></div>
  </div>

  <div class="fb-sheet review">
    <div class="fb-sheet-head"><span class="dot"></span><h3>AI outcome review</h3>
      <span class="fb-badge" data-badge>PREVIEW</span><button class="fb-x" aria-label="Close">×</button></div>
    <div class="fb-sheet-body">
      <div class="fb-verdict" data-verdict>Not graded yet</div>
      <p class="fb-ai-text" data-aitext></p>
      <div class="fb-ai-sample" data-pred-quote></div>
      <p class="fb-ai-text" data-by style="color:var(--ink-faint);font-size:11.5px"></p>
    </div>
    <div class="fb-sheet-foot"><span class="hint">Grades your prediction against the actual move</span>
      <button class="fb-save" data-grade>Grade this call</button></div>
  </div>`;
}

function injectStyle(rootId) {
  if (document.getElementById('fb-view-css')) return;
  const tag = document.createElement('style');
  tag.id = 'fb-view-css';
  tag.textContent = css.replaceAll('__ROOT__', rootId);
  document.head.appendChild(tag);
}
