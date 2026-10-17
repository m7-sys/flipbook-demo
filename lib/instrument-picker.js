/* ============================================================================
   FlipBook · coin search  (app/www/lib/instrument-picker.js)
   ----------------------------------------------------------------------------
   A popover that searches every coin the server can chart (OKX perpetuals +
   Binance spot coins OKX lacks), labelled by source.

     openInstrumentPicker({ anchor, apiBase, exclude, onPick })
   ========================================================================== */

import { loadInstruments, searchInstruments, SOURCE_LABEL } from './data-adapter.js';

const CSS = `
.fb-ipick{position:fixed;z-index:9998;width:260px;background:var(--panel,#0f1318);border:1px solid var(--panel-edge,#1a2027);border-radius:12px;box-shadow:0 18px 44px rgba(0,0,0,.5);overflow:hidden;font-family:var(--mono,monospace)}
.fb-ipick input{width:100%;box-sizing:border-box;font-family:inherit;font-size:13px;color:var(--ink,#e8edf2);background:var(--panel-2,#11161c);border:none;border-bottom:1px solid var(--line,#262e37);padding:11px 12px;outline:none}
.fb-ipick ul{list-style:none;margin:0;padding:4px 0;max-height:300px;overflow-y:auto}
.fb-ipick li{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:7px 12px;cursor:pointer;font-size:12px;color:var(--ink,#e8edf2)}
.fb-ipick li.on,.fb-ipick li:hover{background:var(--amber-soft,rgba(232,184,75,.1))}
.fb-ipick .src{font-size:9px;letter-spacing:.6px;border-radius:5px;padding:2px 6px;border:1px solid currentColor}
.fb-ipick .src.okx{color:var(--amber,#e8b84b)} .fb-ipick .src.binance{color:var(--teal,#39d3c3)}
.fb-ipick .empty{padding:12px;font-size:11px;color:var(--ink-faint,#566270)}
`;

function injectCss() {
  if (document.getElementById('fb-ipick-css')) return;
  const s = document.createElement('style'); s.id = 'fb-ipick-css'; s.textContent = CSS;
  document.head.appendChild(s);
}

let open = null;   // only one picker at a time

export function openInstrumentPicker({ anchor, apiBase = '', exclude = [], onPick }) {
  open?.close();
  injectCss();
  const skip = new Set(exclude);
  const pop = document.createElement('div');
  pop.className = 'fb-ipick';
  pop.innerHTML = `<input type="text" placeholder="Search coins… (e.g. BTC)" spellcheck="false" autocomplete="off"><ul></ul>`;
  document.body.appendChild(pop);

  const r = anchor.getBoundingClientRect();
  pop.style.top = `${Math.min(r.bottom + 6, window.innerHeight - 360)}px`;
  pop.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - 268))}px`;

  const input = pop.querySelector('input');
  const list = pop.querySelector('ul');
  let items = [], sel = 0;

  const render = () => {
    items = searchInstruments(input.value).filter(i => !skip.has(i.sym));
    sel = Math.min(sel, Math.max(0, items.length - 1));
    list.innerHTML = items.length
      ? items.map((i, k) => `<li data-k="${k}" class="${k === sel ? 'on' : ''}"><span>${i.sym}</span>` +
          `<span class="src ${i.source}">${SOURCE_LABEL[i.source] || i.source}</span></li>`).join('')
      : `<li class="empty">${input.value ? 'No match' : 'Loading coins…'}</li>`;
  };
  const choose = k => { const i = items[k]; if (!i) return; close(); onPick?.(i.sym, i); };

  input.addEventListener('input', () => { sel = 0; render(); });
  input.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(sel + 1, items.length - 1); render(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(sel - 1, 0); render(); }
    else if (e.key === 'Enter') { e.preventDefault(); choose(sel); }
    else if (e.key === 'Escape') close();
    e.stopPropagation();   // keep the Flipbook's arrow-key navigation out of it
  });
  list.addEventListener('click', e => { const li = e.target.closest('li[data-k]'); if (li) choose(+li.dataset.k); });

  const onDoc = e => { if (!pop.contains(e.target) && e.target !== anchor) close(); };
  setTimeout(() => document.addEventListener('pointerdown', onDoc, true), 0);
  function close() { pop.remove(); document.removeEventListener('pointerdown', onDoc, true); if (open === handle) open = null; }

  const handle = { close };
  open = handle;
  render();
  input.focus();
  loadInstruments(apiBase).then(() => { if (pop.isConnected) render(); });
  return handle;
}
