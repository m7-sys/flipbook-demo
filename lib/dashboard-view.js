/* ============================================================================
   FlipBook · Dashboard ("Board") view
   ----------------------------------------------------------------------------
   Analytics over graded predictions. Three layout modes (Command · Focus ·
   Stream) re-arrange the same widget set: an insight banner, KPI tiles, an
   accuracy-over-time curve, a calibration scatter, by-session and by-setup
   hit-rate bars, and a recent-entries feed (click → opens that call in the
   Flipbook). Renders with the shared chart engine; metrics come from stats.js,
   which blends real graded journal entries on top of deterministic samples.

     import { mountDashboard } from './lib/dashboard-view.js';
     mountDashboard(document.getElementById('view-dashboard'));
   ========================================================================== */

import * as Charts from './chart-engine.js';
import { listEntries, configure, syncFromServer } from './journal-store.js';
import { sampleGradedEntries, gradedFromJournal, computeStats, insightFor } from './stats.js';

const LAYOUTS = ['command', 'focus', 'stream'];

const css = `
#__ROOT__{display:flex;flex-direction:column;height:100%;min-height:0;background:var(--bg);color:var(--ink);font-family:var(--sans)}
#__ROOT__ .db-bar{display:flex;align-items:center;gap:14px;padding:12px 22px;border-bottom:1px solid var(--panel-edge);background:var(--panel);flex:0 0 auto}
#__ROOT__ .db-title{font-size:14px;font-weight:700}
#__ROOT__ .db-range{font-family:var(--mono);font-size:9.5px;letter-spacing:1px;text-transform:uppercase;color:var(--ink-faint);border:1px solid var(--line);border-radius:6px;padding:4px 9px}
#__ROOT__ .db-seg{margin-left:auto;display:inline-flex;background:var(--panel-2);border:1px solid var(--line);border-radius:9px;padding:3px;gap:2px}
#__ROOT__ .db-seg button{font-family:var(--mono);font-size:11px;font-weight:700;color:var(--ink-faint);background:transparent;border:none;border-radius:6px;padding:6px 13px;cursor:pointer;transition:.14s;text-transform:capitalize}
#__ROOT__ .db-seg button:hover{color:var(--ink-dim)} #__ROOT__ .db-seg button.on{color:var(--amber);background:var(--amber-soft)}

#__ROOT__ .db-scroll{flex:1;min-height:0;overflow-y:auto;padding:18px 22px 26px}
#__ROOT__ .db-grid{display:grid;grid-template-columns:repeat(12,1fr);gap:14px;align-content:start}
#__ROOT__ .card{background:var(--panel);border:1px solid var(--panel-edge);border-radius:13px;padding:15px;display:flex;flex-direction:column;min-width:0}
#__ROOT__ .card h4{font-family:var(--mono);font-size:9.5px;letter-spacing:1px;text-transform:uppercase;color:var(--ink-faint);margin:0 0 11px}
#__ROOT__ canvas{display:block;width:100%;flex:1;min-height:0}

/* insight banner */
#__ROOT__ .db-insight{grid-column:1/13;display:flex;align-items:center;gap:12px;background:linear-gradient(90deg,var(--amber-soft),transparent);border:1px solid var(--panel-edge);border-left:2px solid var(--amber);border-radius:12px;padding:13px 16px}
#__ROOT__ .db-insight .spark{color:var(--amber);font-size:15px}
#__ROOT__ .db-insight p{margin:0;font-size:13.5px;color:var(--ink)}

/* KPI tiles */
#__ROOT__ .w-kpis{grid-column:1/13;display:grid;grid-template-columns:repeat(4,1fr);gap:14px;padding:0;border:none;background:transparent}
#__ROOT__ .kpi{background:var(--panel);border:1px solid var(--panel-edge);border-radius:13px;padding:14px 15px;display:flex;flex-direction:column;gap:5px}
#__ROOT__ .kpi .k-label{font-family:var(--mono);font-size:9px;letter-spacing:1px;text-transform:uppercase;color:var(--ink-faint)}
#__ROOT__ .kpi .k-val{font-family:var(--mono);font-size:26px;font-weight:700;color:var(--ink);line-height:1}
#__ROOT__ .kpi .k-val.teal{color:var(--teal)} #__ROOT__ .kpi .k-val.amber{color:var(--amber)} #__ROOT__ .kpi .k-val.rose{color:var(--rose)}
#__ROOT__ .kpi .k-sub{font-family:var(--mono);font-size:10px;color:var(--ink-faint)}

/* hero (focus) */
#__ROOT__ .w-hero{display:none;justify-content:center;gap:6px;background:linear-gradient(160deg,var(--teal-soft),transparent)}
#__ROOT__ .w-hero .h-val{font-family:var(--mono);font-size:54px;font-weight:700;color:var(--teal);line-height:1}
#__ROOT__ .w-hero .h-label{font-family:var(--mono);font-size:10px;letter-spacing:1px;text-transform:uppercase;color:var(--ink-faint)}
#__ROOT__ .w-hero .h-sub{font-size:12px;color:var(--ink-dim);margin-top:4px}

/* bars */
#__ROOT__ .bar-row{display:flex;align-items:center;gap:10px;margin-bottom:9px}
#__ROOT__ .bar-row .bl{font-family:var(--mono);font-size:11px;color:var(--ink-dim);width:96px;flex:0 0 auto;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#__ROOT__ .bar-track{flex:1;height:8px;background:var(--panel-2);border-radius:5px;overflow:hidden}
#__ROOT__ .bar-fill{height:100%;border-radius:5px;transition:width .5s cubic-bezier(.4,0,.2,1)}
#__ROOT__ .bar-row .bv{font-family:var(--mono);font-size:11px;font-weight:700;width:62px;text-align:right;flex:0 0 auto}
#__ROOT__ .bar-row .bv .r{color:var(--ink-faint);font-weight:400;font-size:9.5px}

/* feed */
#__ROOT__ .w-feed{padding:15px 15px 6px}
#__ROOT__ .feed-list{overflow-y:auto;flex:1;min-height:0;margin:0 -6px}
#__ROOT__ .feed-item{display:flex;align-items:center;gap:11px;padding:9px 6px;border-bottom:1px solid var(--panel-edge);text-decoration:none;cursor:pointer;transition:.12s}
#__ROOT__ .feed-item:hover{background:var(--panel-2)}
#__ROOT__ .feed-item .v-dot{width:8px;height:8px;border-radius:50%;flex:0 0 auto}
#__ROOT__ .feed-item .f-main{flex:1;min-width:0}
#__ROOT__ .feed-item .f-top{display:flex;gap:8px;align-items:baseline}
#__ROOT__ .feed-item .f-sym{font-family:var(--mono);font-size:12px;font-weight:700;color:var(--ink)}
#__ROOT__ .feed-item .f-setup{font-size:11.5px;color:var(--ink-dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#__ROOT__ .feed-item .f-meta{font-family:var(--mono);font-size:9.5px;color:var(--ink-faint);margin-top:2px}
#__ROOT__ .feed-item .f-conv{font-family:var(--mono);font-size:11px;font-weight:700;flex:0 0 auto}

/* ---- layout placements ---- */
#__ROOT__[data-layout=command] .w-curve{grid-column:1/8;min-height:300}
#__ROOT__[data-layout=command] .w-scatter{grid-column:8/13;min-height:300}
#__ROOT__[data-layout=command] .w-sessions{grid-column:1/5;min-height:264}
#__ROOT__[data-layout=command] .w-setups{grid-column:5/9;min-height:264}
#__ROOT__[data-layout=command] .w-feed{grid-column:9/13;min-height:264}

#__ROOT__[data-layout=focus] .db-grid{gap:16px}
#__ROOT__[data-layout=focus] .w-hero{display:flex;grid-column:1/5;grid-row:1;min-height:188}
#__ROOT__[data-layout=focus] .w-kpis{grid-column:1/5;grid-row:2;grid-template-columns:1fr 1fr}
#__ROOT__[data-layout=focus] .w-curve{grid-column:5/13;grid-row:1/3;min-height:404}
#__ROOT__[data-layout=focus] .w-feed{grid-column:1/5;grid-row:3/5;min-height:380}
#__ROOT__[data-layout=focus] .w-scatter{grid-column:5/9;grid-row:3;min-height:280}
#__ROOT__[data-layout=focus] .w-sessions{grid-column:9/13;grid-row:3;min-height:280}
#__ROOT__[data-layout=focus] .w-setups{grid-column:5/13;grid-row:4;min-height:196}

#__ROOT__[data-layout=stream] .w-feed{grid-column:1/6;grid-row:1/5;min-height:640}
#__ROOT__[data-layout=stream] .w-kpis{grid-column:6/13;grid-row:1;grid-template-columns:repeat(4,1fr)}
#__ROOT__[data-layout=stream] .w-curve{grid-column:6/13;grid-row:2;min-height:264}
#__ROOT__[data-layout=stream] .w-scatter{grid-column:6/9;grid-row:3;min-height:256}
#__ROOT__[data-layout=stream] .w-sessions{grid-column:9/13;grid-row:3;min-height:256}
#__ROOT__[data-layout=stream] .w-setups{grid-column:6/13;grid-row:4;min-height:160}

@media(max-width:920px){
  #__ROOT__ .db-grid > *{grid-column:1/13 !important;grid-row:auto !important}
  #__ROOT__ .w-kpis{grid-template-columns:1fr 1fr !important}
}
`;

export async function mountDashboard(root, { layout = 'command', flipbookHref = 'flipbook.html', apiBase = 'http://localhost:3001' } = {}) {
  if (!root.id) root.id = 'view-dashboard';
  injectStyle(root.id);
  root.dataset.layout = layout;

  // pull cross-device entries before computing (resolves instantly to cache if offline)
  configure({ apiBase });
  await syncFromServer();

  // blend real graded journal entries (if any) on top of deterministic samples
  const real = gradedFromJournal(listEntries());
  const stats = computeStats([...sampleGradedEntries(64), ...real]);
  const insight = insightFor(stats);

  root.innerHTML = barHTML(layout) + `<div class="db-scroll"><div class="db-grid">${gridHTML(insight, stats, flipbookHref)}</div></div>`;

  // KPI values
  setKpi(root, 'accuracy', `${stats.accuracy}%`, gradeClass(stats.accuracy, 60, 50), `${stats.count} graded calls`);
  setKpi(root, 'gap', `${stats.calibrationGap > 0 ? '+' : ''}${stats.calibrationGap}`, stats.calibrationGap > 8 ? 'rose' : 'amber', 'conviction − outcome (pts)');
  setKpi(root, 'expectancy', `${stats.expectancy > 0 ? '+' : ''}${stats.expectancy}R`, stats.expectancy > 0 ? 'teal' : 'rose', 'avg per graded call');
  setKpi(root, 'streak', `${stats.streak}d`, 'amber', 'journaling streak');

  // hero (focus layout)
  root.querySelector('[data-hero-val]').textContent = `${stats.accuracy}%`;
  root.querySelector('[data-hero-sub]').textContent = `across ${stats.count} graded calls · ${stats.expectancy > 0 ? '+' : ''}${stats.expectancy}R expectancy`;

  // charts
  Charts.register(root.querySelector('[data-curve]'), (ctx, w, h) =>
    Charts.curve(ctx, w, h, stats.accuracyOverTime, { color: Charts.THEME.teal }));
  Charts.register(root.querySelector('[data-scatter]'), (ctx, w, h) =>
    Charts.scatter(ctx, w, h, stats.calibration.pts, { bins: stats.calibration.bins }));

  // bars
  renderBars(root.querySelector('[data-sessions]'), stats.bySession, false);
  renderBars(root.querySelector('[data-setups]'), stats.bySetup, true);

  // layout switch
  root.querySelector('.db-seg').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    root.querySelector('.db-seg .on')?.classList.remove('on');
    b.classList.add('on');
    root.dataset.layout = b.dataset.layout;
    requestAnimationFrame(() => Charts.refreshAll());
    setTimeout(() => Charts.refreshAll(), 140);
  });

  requestAnimationFrame(() => Charts.refreshAll());
  return { refresh: () => Charts.refreshAll() };
}

/* ---- render helpers ----------------------------------------------------- */

const gradeClass = (v, good, ok) => (v >= good ? 'teal' : v >= ok ? 'amber' : 'rose');

function setKpi(root, key, val, cls, sub) {
  const tile = root.querySelector(`[data-kpi=${key}]`);
  const v = tile.querySelector('.k-val');
  v.textContent = val; v.className = 'k-val ' + cls;
  tile.querySelector('.k-sub').textContent = sub;
}

function renderBars(host, rows, withR) {
  host.innerHTML = rows.map(r => {
    const col = r.hitRate >= 66 ? 'var(--teal)' : r.hitRate >= 50 ? 'var(--amber)' : 'var(--rose)';
    const rTag = withR ? `<span class="r"> · ${r.avgR > 0 ? '+' : ''}${r.avgR}R</span>` : '';
    return `<div class="bar-row"><span class="bl" title="${r.label}">${r.label}</span>` +
      `<span class="bar-track"><span class="bar-fill" style="width:${r.hitRate}%;background:${col}"></span></span>` +
      `<span class="bv">${r.hitRate}%${rTag}</span></div>`;
  }).join('');
}

function feedHTML(recent, href) {
  const ago = t => {
    const h = Math.floor((Date.now() - t) / 3.6e6);
    return h < 1 ? 'just now' : h < 24 ? `${h}h ago` : `${Math.floor(h / 24)}d ago`;
  };
  const col = v => (v === 'hit' ? 'var(--teal)' : v === 'partial' ? 'var(--amber)' : 'var(--rose)');
  return recent.map(e =>
    `<a class="feed-item" href="${href}?entry=${e.id}">` +
    `<span class="v-dot" style="background:${col(e.verdict)}"></span>` +
    `<span class="f-main"><span class="f-top"><span class="f-sym">${e.symbol}</span>` +
    `<span class="f-setup">${e.setup}</span></span>` +
    `<span class="f-meta">${e.session} · ${ago(e.gradedAt)} · ${e.verdict}</span></span>` +
    `<span class="f-conv" style="color:${col(e.verdict)}">${e.conviction}%</span></a>`
  ).join('');
}

/* ---- markup ------------------------------------------------------------- */

function barHTML(layout) {
  const seg = LAYOUTS.map(l => `<button data-layout="${l}" class="${l === layout ? 'on' : ''}">${l}</button>`).join('');
  return `<div class="db-bar"><span class="db-title">Trading desk</span>` +
    `<span class="db-range">Last 30 days</span><div class="db-seg">${seg}</div></div>`;
}

function gridHTML(insight, stats, href) {
  const kpi = (key, label) => `<div class="kpi" data-kpi="${key}"><span class="k-label">${label}</span><span class="k-val">—</span><span class="k-sub"></span></div>`;
  return `
  <div class="db-insight"><span class="spark">${insight.spark}</span><p>${insight.text}</p></div>

  <div class="card w-hero"><span class="h-label">Prediction accuracy</span><span class="h-val" data-hero-val>—</span><span class="h-sub" data-hero-sub></span></div>

  <div class="w-kpis">
    ${kpi('accuracy', 'Prediction accuracy')}
    ${kpi('gap', 'Calibration gap')}
    ${kpi('expectancy', 'Expectancy')}
    ${kpi('streak', 'Journal streak')}
  </div>

  <div class="card w-curve"><h4>Accuracy over time · rolling 9</h4><canvas data-curve></canvas></div>
  <div class="card w-scatter"><h4>Calibration · conviction vs outcome</h4><canvas data-scatter></canvas></div>
  <div class="card w-sessions"><h4>By session</h4><div data-sessions></div></div>
  <div class="card w-setups"><h4>By setup</h4><div data-setups></div></div>
  <div class="card w-feed"><h4>Recent entries</h4><div class="feed-list">${feedHTML(stats.recent, href)}</div></div>`;
}

function injectStyle(rootId) {
  if (document.getElementById('db-view-css')) return;
  const tag = document.createElement('style');
  tag.id = 'db-view-css';
  tag.textContent = css.replaceAll('__ROOT__', rootId);
  document.head.appendChild(tag);
}
