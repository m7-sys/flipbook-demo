/* ============================================================================
   FlipBook · settings  (app/www/lib/settings-ui.js)
   ----------------------------------------------------------------------------
   A gear button that opens a small popover of candle-color pickers. Changes
   apply live (charts refresh), persist per browser, and can be reset.

     import { mountSettings } from './lib/settings-ui.js';
     mountSettings(navEl);   // appends a gear into the given nav element
   ========================================================================== */

import * as Charts from './chart-engine.js';
import {
  getCandleColors, setCandleColors, resetCandleColors, onCandleColorsChange,
  CANDLE_LABELS,
} from './chart-theme.js';

const CSS = `
.fb-gear{font-family:var(--mono,monospace);font-size:13px;color:var(--ink-dim,#8a96a3);background:transparent;border:1px solid var(--line,#262e37);border-radius:8px;padding:5px 9px;cursor:pointer;line-height:1}
.fb-gear:hover{color:var(--ink,#e8edf2);border-color:var(--ink-faint,#566270)}
.fb-settings-pop{position:fixed;z-index:9998;width:248px;background:var(--panel,#0f1318);border:1px solid var(--panel-edge,#1a2027);border-radius:13px;padding:14px;box-shadow:0 18px 44px rgba(0,0,0,.5);font-family:var(--sans,system-ui)}
.fb-settings-pop h4{font-family:var(--mono,monospace);font-size:9px;letter-spacing:1px;text-transform:uppercase;color:var(--ink-faint,#566270);margin:0 0 11px}
.fb-color-row{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:9px}
.fb-color-row span{font-family:var(--mono,monospace);font-size:11.5px;color:var(--ink-dim,#8a96a3)}
.fb-color-row input[type=color]{width:34px;height:24px;padding:0;border:1px solid var(--line,#262e37);border-radius:6px;background:transparent;cursor:pointer}
.fb-settings-foot{display:flex;justify-content:flex-end;margin-top:6px}
.fb-settings-foot button{font-family:var(--mono,monospace);font-size:10.5px;color:var(--ink-faint,#566270);background:transparent;border:1px solid var(--line,#262e37);border-radius:7px;padding:5px 10px;cursor:pointer}
.fb-settings-foot button:hover{color:var(--ink,#e8edf2);border-color:var(--ink-faint,#566270)}
`;

function injectCss() {
  if (document.getElementById('fb-settings-css')) return;
  const s = document.createElement('style'); s.id = 'fb-settings-css'; s.textContent = CSS;
  document.head.appendChild(s);
}

export function mountSettings(navEl) {
  if (!navEl) return;
  injectCss();
  // refresh charts whenever colors change (covers programmatic resets too)
  onCandleColorsChange(() => Charts.refreshAll());

  const gear = document.createElement('button');
  gear.className = 'fb-gear'; gear.title = 'Candle colors'; gear.textContent = '⚙';
  navEl.appendChild(gear);

  let pop = null;
  const close = () => { pop?.remove(); pop = null; document.removeEventListener('click', onDoc, true); };
  const onDoc = e => { if (pop && !pop.contains(e.target) && e.target !== gear) close(); };

  gear.onclick = (e) => {
    e.stopPropagation();
    if (pop) return close();
    pop = buildPopover();
    document.body.appendChild(pop);
    const r = gear.getBoundingClientRect();
    pop.style.top = `${r.bottom + 8}px`;
    pop.style.left = `${Math.max(8, Math.min(r.right - 248, window.innerWidth - 256))}px`;
    setTimeout(() => document.addEventListener('click', onDoc, true), 0);
  };
}

function buildPopover() {
  const cc = getCandleColors();
  const pop = document.createElement('div');
  pop.className = 'fb-settings-pop';
  pop.innerHTML =
    `<h4>Candle colors</h4>` +
    Object.keys(CANDLE_LABELS).map(k =>
      `<label class="fb-color-row"><span>${CANDLE_LABELS[k]}</span>` +
      `<input type="color" data-key="${k}" value="${cc[k]}"></label>`).join('') +
    `<div class="fb-settings-foot"><button data-reset>Reset to default</button></div>`;

  pop.querySelectorAll('input[type=color]').forEach(inp => {
    inp.addEventListener('input', () => setCandleColors({ [inp.dataset.key]: inp.value }));
  });
  pop.querySelector('[data-reset]').onclick = () => {
    resetCandleColors();
    const fresh = getCandleColors();
    pop.querySelectorAll('input[type=color]').forEach(inp => { inp.value = fresh[inp.dataset.key]; });
  };
  return pop;
}
