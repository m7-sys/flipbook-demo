/* ============================================================================
   FlipBook · sessions editor  (app/www/lib/sessions-ui.js)
   ----------------------------------------------------------------------------
   A modal to manage trading sessions: rename, edit start/end, set DST market,
   add, delete, reset to defaults, and pick the home timezone. Changes persist
   via sessions-store and notify subscribers (so the journal dropdown updates).

     import { openSessionEditor, buildSessionOptions } from './lib/sessions-ui.js';
   ========================================================================== */

import {
  getSessions, setSessions, addSession, removeSession, resetSessions,
  getHomeTz, setHomeTz, formatRange, currentSessionId, DST_MARKETS,
} from './sessions-store.js';

const TZ_CHOICES = [
  'Asia/Kuala_Lumpur', 'Asia/Singapore', 'Asia/Hong_Kong', 'Asia/Tokyo',
  'Asia/Dubai', 'Europe/London', 'Europe/Berlin', 'America/New_York',
  'America/Chicago', 'America/Los_Angeles', 'UTC',
];

const CSS = `
.fb-sess-scrim{position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;background:rgba(7,9,11,.72);backdrop-filter:blur(3px);font-family:var(--sans,system-ui)}
.fb-sess-card{width:min(94%,560px);max-height:88vh;display:flex;flex-direction:column;background:var(--panel,#0f1318);border:1px solid var(--panel-edge,#1a2027);border-radius:16px;box-shadow:0 24px 60px rgba(0,0,0,.5)}
.fb-sess-head{display:flex;align-items:center;gap:10px;padding:16px 18px;border-bottom:1px solid var(--panel-edge,#1a2027)}
.fb-sess-head h3{font-size:14px;font-weight:700;margin:0;color:var(--ink,#e8edf2)}
.fb-sess-head .x{margin-left:auto;background:transparent;border:none;color:var(--ink-faint,#566270);font-size:20px;cursor:pointer}
.fb-sess-head .x:hover{color:var(--ink,#e8edf2)}
.fb-sess-tz{display:flex;align-items:center;gap:8px;padding:11px 18px;border-bottom:1px solid var(--panel-edge,#1a2027);font-family:var(--mono,monospace);font-size:11px;color:var(--ink-faint,#566270)}
.fb-sess-tz select{font-family:var(--mono,monospace);font-size:12px;color:var(--ink,#e8edf2);background:var(--panel-2,#11161c);border:1px solid var(--line,#262e37);border-radius:7px;padding:6px 8px}
.fb-sess-body{overflow-y:auto;padding:10px 18px;flex:1}
.fb-sess-row{display:grid;grid-template-columns:1fr 64px 64px 130px 26px;gap:8px;align-items:center;padding:7px 0;border-bottom:1px solid var(--panel-edge,#1a2027)}
.fb-sess-row.head{border-bottom:1px solid var(--line,#262e37)}
.fb-sess-row.head span{font-family:var(--mono,monospace);font-size:8.5px;letter-spacing:1px;text-transform:uppercase;color:var(--ink-faint,#566270)}
.fb-sess-row input,.fb-sess-row select{font-family:var(--mono,monospace);font-size:12px;color:var(--ink,#e8edf2);background:var(--panel-2,#11161c);border:1px solid var(--line,#262e37);border-radius:6px;padding:6px 7px;width:100%}
.fb-sess-row input:focus,.fb-sess-row select:focus{outline:none;border-color:var(--amber,#e8b84b)}
.fb-sess-row .del{background:transparent;border:none;color:var(--ink-faint,#566270);cursor:pointer;font-size:15px}
.fb-sess-row .del:hover{color:var(--rose,#e8584b)}
.fb-sess-foot{display:flex;align-items:center;gap:10px;padding:13px 18px;border-top:1px solid var(--panel-edge,#1a2027)}
.fb-sess-foot .add{font-family:var(--mono,monospace);font-size:11px;font-weight:600;color:var(--teal,#39d3c3);background:var(--teal-soft,rgba(57,211,195,.1));border:1px solid var(--teal,#39d3c3);border-radius:8px;padding:7px 12px;cursor:pointer}
.fb-sess-foot .reset{font-family:var(--mono,monospace);font-size:10.5px;color:var(--ink-faint,#566270);background:transparent;border:1px solid var(--line,#262e37);border-radius:8px;padding:7px 11px;cursor:pointer}
.fb-sess-foot .done{margin-left:auto;font-family:var(--mono,monospace);font-size:12px;font-weight:700;color:#0b0d10;background:var(--amber,#e8b84b);border:none;border-radius:8px;padding:8px 16px;cursor:pointer}
`;

function injectCss() {
  if (document.getElementById('fb-sess-css')) return;
  const s = document.createElement('style'); s.id = 'fb-sess-css'; s.textContent = CSS;
  document.head.appendChild(s);
}

/** Build <option> markup for a session <select>, marking the current session. */
export function buildSessionOptions(selectedId) {
  const curId = currentSessionId();
  const chosen = selectedId || curId;   // new entries auto-pick the current session
  return getSessions().map(s => {
    const cur = s.id === curId ? ' — now' : '';
    const sel = s.id === chosen ? ' selected' : '';
    return `<option value="${s.id}"${sel}>${s.name} · ${formatRange(s)}${cur}</option>`;
  }).join('');
}

/** Open the editor. onClose() fires after the modal closes (to refresh callers). */
export function openSessionEditor(onClose) {
  injectCss();
  const scrim = document.createElement('div');
  scrim.className = 'fb-sess-scrim';
  scrim.innerHTML = `
    <div class="fb-sess-card">
      <div class="fb-sess-head"><h3>Trading sessions</h3><button class="x">×</button></div>
      <div class="fb-sess-tz">Home timezone
        <select data-tz>${TZ_CHOICES.map(t => `<option value="${t}"${t === getHomeTz() ? ' selected' : ''}>${t}</option>`).join('')}</select>
        <span>· times below are in this zone; tagged sessions shift on market DST</span>
      </div>
      <div class="fb-sess-body">
        <div class="fb-sess-row head"><span>Name</span><span>Start</span><span>End</span><span>DST</span><span></span></div>
        <div data-rows></div>
      </div>
      <div class="fb-sess-foot">
        <button class="add" data-add>+ Add session</button>
        <button class="reset" data-reset>Reset to defaults</button>
        <button class="done" data-done>Done</button>
      </div>
    </div>`;
  document.body.appendChild(scrim);

  const rowsEl = scrim.querySelector('[data-rows]');
  const render = () => {
    rowsEl.innerHTML = getSessions().map(s => `
      <div class="fb-sess-row" data-id="${s.id}">
        <input data-f="name" type="text" value="${escapeHtml(s.name)}">
        <input data-f="start" type="time" value="${s.start}">
        <input data-f="end" type="time" value="${s.end}">
        <select data-f="dst">${DST_MARKETS.map(d => `<option value="${d.value}"${d.value === s.dst ? ' selected' : ''}>${d.label}</option>`).join('')}</select>
        <button class="del" title="Delete">🗑</button>
      </div>`).join('');
  };
  render();

  // edit handlers (event-delegated)
  rowsEl.addEventListener('input', e => {
    const row = e.target.closest('.fb-sess-row'); if (!row) return;
    const list = getSessions();
    const s = list.find(x => x.id === row.dataset.id); if (!s) return;
    s[e.target.dataset.f] = e.target.value;
    setSessions(list);
  });
  rowsEl.addEventListener('click', e => {
    if (!e.target.classList.contains('del')) return;
    const row = e.target.closest('.fb-sess-row');
    removeSession(row.dataset.id);
    render();
  });

  scrim.querySelector('[data-tz]').addEventListener('change', e => setHomeTz(e.target.value));
  scrim.querySelector('[data-add]').onclick = () => { addSession(); render(); };
  scrim.querySelector('[data-reset]').onclick = () => { resetSessions(); render(); };

  const close = () => { scrim.remove(); onClose?.(); };
  scrim.querySelector('.x').onclick = close;
  scrim.querySelector('[data-done]').onclick = close;
  scrim.addEventListener('click', e => { if (e.target === scrim) close(); });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
