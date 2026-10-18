/* ============================================================================
   FlipBook · price reader  (app/www/lib/audio-reader.js)
   ----------------------------------------------------------------------------
   Reads the price of the coin you're viewing aloud every 1, 3 or 5 minutes,
   on the clock (as each candle closes), with the move over that time:
     "BERA, 0.2441. Up 0.32 percent over 5 minutes."

   Uses the browser's built-in speech; settings are kept on this device. A 🔊
   button sits in the top bar of every page. Browsers only allow speech once
   you've interacted with a page, so after opening a new page the first tap or
   click anywhere turns the sound back on (and reads the price straight away).

     mountAudioReader(navEl, { apiBase })
     setReaderAsset('SOL')      // views call this when the coin on screen changes
   ========================================================================== */

import { fetchKlines, resolveInstrument, dpForPrice } from './data-adapter.js';

const KEY = 'flipbook.audio.v1';
const EVERY = [1, 3, 5];          // minutes
const SETTLE_MS = 2000;           // give the closed candle a moment to reach the feed
const MIN = 60_000;

const settings = { on: false, every: 5, asset: 'BERA', ...read() };
let apiBase = '', timer = null, nextAt = null, status = '', btn = null, pop = null;
let activated = false, waitingForTap = false;

function read() { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch { return {}; } }
function save() { try { localStorage.setItem(KEY, JSON.stringify(settings)); } catch { /* quota */ } }
const hm = t => { const d = new Date(t); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };

/* ---- what to say ---- */

/** "BERA, 0.2441. Up 0.32 percent over 5 minutes." from 1-minute candles. */
export async function priceSentence(sym = settings.asset, mins = settings.every, base = apiBase) {
  const ins = resolveInstrument(sym);
  const rows = await fetchKlines({ apiBase: base, symbol: ins.pair, interval: '1m', source: ins.source, limit: mins + 3 });
  if (rows.length < 2) throw new Error('no price');
  const last = rows.at(-1), now = last.c;
  // the price `mins` ago: the open of the candle that started then (fall back to counting back)
  const from = rows.find(r => r.t === last.t - mins * MIN) || rows[Math.max(0, rows.length - 1 - mins)];
  const pct = (now / from.o - 1) * 100;
  const dp = ins.dp ?? dpForPrice(now);
  const price = now.toLocaleString('en-US', { maximumFractionDigits: dp });
  const move = Math.abs(pct) < 0.005 ? 'Flat' : `${pct > 0 ? 'Up' : 'Down'} ${Math.abs(pct).toFixed(2)} percent`;
  return `${ins.sym}, ${price}. ${move} over ${mins} minute${mins > 1 ? 's' : ''}.`;
}

/* ---- speaking ---- */

const canSpeak = () => activated || !!navigator.userActivation?.hasBeenActive;

function pickVoice() {
  const voices = window.speechSynthesis.getVoices();
  return voices.find(v => v.lang === 'en-US' && v.localService) || voices.find(v => v.lang?.startsWith('en')) || null;
}

/** Speak now; `interrupt` drops anything still queued so readouts never pile up. */
function speak(text, { interrupt = false } = {}) {
  const synth = window.speechSynthesis;
  if (!synth || typeof SpeechSynthesisUtterance === 'undefined') { status = 'This browser has no speech support.'; return false; }
  if (!canSpeak()) { waitingForTap = true; render(); return false; }
  if (waitingForTap) { waitingForTap = false; render(); }   // the browser allows speech now
  if (interrupt) synth.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'en-US';
  const v = pickVoice(); if (v) u.voice = v;
  synth.speak(u);
  return true;
}

async function readNow(opts) {
  try {
    const text = await priceSentence();
    if (speak(text, opts)) status = `Last read ${hm(Date.now())}: “${text}”`;
  } catch {
    status = `Couldn't get the price at ${hm(Date.now())}.`;
  }
  render();
}

/* ---- schedule: on the clock, every 1/3/5 minutes ---- */

function schedule() {
  clearTimeout(timer); timer = null; nextAt = null;
  if (settings.on) {
    const step = settings.every * MIN, now = Date.now();
    nextAt = Math.floor(now / step) * step + step;
    timer = setTimeout(async () => { await readNow({ interrupt: true }); schedule(); }, nextAt - now + SETTLE_MS);
  }
  render();
}

/** The first tap/click/key on a page unlocks speech; if a readout was waiting, read straight away. */
function onActivate(e) {
  // a touch only counts as permission once the finger lifts
  if (e.type === 'pointerdown' && e.pointerType && e.pointerType !== 'mouse') return;
  activated = true;
  if (!waitingForTap || !settings.on) return;
  waitingForTap = false;
  speak('Price reader on.');   // spoken inside the tap, which mobile browsers require
  readNow();
}

/* ---- public ---- */

/** Follow the coin on screen. */
export function setReaderAsset(sym) {
  const s = String(sym || '').toUpperCase().replace(/USDT$/, '');
  if (!s || s === settings.asset) return;
  settings.asset = s; save(); render();
}

export function mountAudioReader(navEl, { apiBase: base = '' } = {}) {
  if (!navEl || btn) return;
  apiBase = base;
  injectCss();
  btn = document.createElement('button');
  btn.className = 'fb-audio';
  btn.onclick = e => { e.stopPropagation(); pop ? closePop() : openPop(); };
  navEl.appendChild(btn);
  for (const ev of ['pointerdown', 'pointerup', 'keydown']) document.addEventListener(ev, onActivate, { capture: true });
  if (settings.on) waitingForTap = !canSpeak();
  schedule();
}

/* ---- UI ---- */

function render() {
  if (!btn) return;
  btn.textContent = settings.on ? `🔊 ${settings.every}m` : '🔈';
  btn.classList.toggle('on', settings.on);
  btn.classList.toggle('waiting', settings.on && waitingForTap);
  btn.title = !settings.on ? 'Price reader (off)'
    : waitingForTap ? 'Tap anywhere on the page to turn the price reader’s sound back on'
    : `Reading ${settings.asset} every ${settings.every} min`;
  if (!pop) return;
  pop.querySelector('[data-on]').checked = settings.on;
  pop.querySelectorAll('[data-every]').forEach(b => b.classList.toggle('on', +b.dataset.every === settings.every));
  pop.querySelector('[data-asset]').textContent = settings.asset;
  pop.querySelector('[data-status]').textContent = [
    settings.on && nextAt ? `Next readout ${hm(nextAt)}.` : 'Off.',
    waitingForTap ? 'Tap anywhere on the page to turn the sound on.' : '',
    status,
  ].filter(Boolean).join(' ');
}

function openPop() {
  pop = document.createElement('div');
  pop.className = 'fb-audio-pop';
  pop.innerHTML = `
    <h4>Price reader</h4>
    <label class="row"><span>Read prices aloud</span><input type="checkbox" data-on></label>
    <div class="row"><span>Every</span><div class="seg">${EVERY.map(m => `<button data-every="${m}">${m} min</button>`).join('')}</div></div>
    <div class="row"><span>Coin</span><b data-asset></b></div>
    <p class="note">Follows the coin on the chart you're viewing. Reads on the clock, as each candle closes.</p>
    <p class="note" data-status></p>
    <div class="foot"><button data-now>Read now</button></div>`;
  document.body.appendChild(pop);
  const r = btn.getBoundingClientRect();
  pop.style.top = `${r.bottom + 8}px`;
  pop.style.left = `${Math.max(8, Math.min(r.right - 268, window.innerWidth - 276))}px`;

  pop.querySelector('[data-on]').onchange = e => {
    settings.on = e.target.checked; save();
    if (settings.on) { activated = true; waitingForTap = false; speak(`Reading ${settings.asset} every ${settings.every} minute${settings.every > 1 ? 's' : ''}.`); }
    else window.speechSynthesis?.cancel();
    schedule();
  };
  pop.querySelectorAll('[data-every]').forEach(b => b.onclick = () => { settings.every = +b.dataset.every; save(); schedule(); });
  pop.querySelector('[data-now]').onclick = () => { activated = true; waitingForTap = false; readNow({ interrupt: true }); };
  setTimeout(() => document.addEventListener('pointerdown', onDoc, true), 0);
  render();
}
function closePop() { pop?.remove(); pop = null; document.removeEventListener('pointerdown', onDoc, true); }
const onDoc = e => { if (pop && !pop.contains(e.target) && e.target !== btn) closePop(); };

const CSS = `
.fb-audio{font-family:var(--mono,monospace);font-size:12px;color:var(--ink-dim,#8a96a3);background:transparent;border:1px solid var(--line,#262e37);border-radius:8px;padding:5px 9px;cursor:pointer;line-height:1;white-space:nowrap}
.fb-audio:hover{color:var(--ink,#e8edf2);border-color:var(--ink-faint,#566270)}
.fb-audio.on{color:var(--teal,#39d3c3);border-color:var(--teal,#39d3c3)}
.fb-audio.waiting{animation:fb-audio-pulse 1.6s ease-in-out infinite}
@keyframes fb-audio-pulse{0%,100%{opacity:1}50%{opacity:.45}}
.fb-audio-pop{position:fixed;z-index:9998;width:268px;background:var(--panel,#0f1318);border:1px solid var(--panel-edge,#1a2027);border-radius:13px;padding:14px;box-shadow:0 18px 44px rgba(0,0,0,.5);font-family:var(--sans,system-ui);color:var(--ink,#e8edf2)}
.fb-audio-pop h4{font-family:var(--mono,monospace);font-size:9px;letter-spacing:1px;text-transform:uppercase;color:var(--ink-faint,#566270);margin:0 0 11px}
.fb-audio-pop .row{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:10px;font-family:var(--mono,monospace);font-size:11.5px;color:var(--ink-dim,#8a96a3)}
.fb-audio-pop .row b{color:var(--amber,#e8b84b)}
.fb-audio-pop input[type=checkbox]{width:16px;height:16px;accent-color:var(--teal,#39d3c3);cursor:pointer}
.fb-audio-pop .seg{display:inline-flex;background:var(--panel-2,#11161c);border:1px solid var(--line,#262e37);border-radius:8px;padding:2px;gap:2px}
.fb-audio-pop .seg button{font-family:var(--mono,monospace);font-size:10.5px;font-weight:600;color:var(--ink-faint,#566270);background:transparent;border:none;border-radius:6px;padding:5px 8px;cursor:pointer}
.fb-audio-pop .seg button.on{color:var(--teal,#39d3c3);background:var(--teal-soft,rgba(57,211,195,.1))}
.fb-audio-pop .note{font-size:11px;line-height:1.45;color:var(--ink-faint,#566270);margin:0 0 8px}
.fb-audio-pop .foot{display:flex;justify-content:flex-end}
.fb-audio-pop .foot button{font-family:var(--mono,monospace);font-size:11px;font-weight:700;color:var(--bg,#0b0d10);background:var(--teal,#39d3c3);border:none;border-radius:7px;padding:6px 12px;cursor:pointer}
`;
function injectCss() {
  if (document.getElementById('fb-audio-css')) return;
  const s = document.createElement('style'); s.id = 'fb-audio-css'; s.textContent = CSS;
  document.head.appendChild(s);
}
