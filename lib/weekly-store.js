/* ============================================================================
   FlipBook · weekly predictions & error log  (app/www/lib/weekly-store.js)
   ----------------------------------------------------------------------------
   Per coin, per trading week (saved on this device):
     prediction  { state, shapes, notes, frame:{lo,hi}, savedAt }   made in Tracking Test,
                 editable only until the week starts (then locked)
     log         { state, notes }                                   corrections, in Error Log
   A note is { id, start, end, text, color }; a shape is { id, type, a:{t,price}, b:{t,price} }.
   ========================================================================== */

import { weekFromKey } from './trading-week.js';

const KEY = 'flipbook.weekly.v1';
export const STATES = ['Position Building', 'Reprice', 'Set'];

let all = read();
function read() { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch { return {}; } }
function write() { try { localStorage.setItem(KEY, JSON.stringify(all)); } catch { /* quota */ } }

const slot = (sym, key) => ((all[sym] ||= {})[key] ||= {});
const clone = v => (v == null ? v : JSON.parse(JSON.stringify(v)));

/** A prediction can be changed until its week starts. */
export const isLocked = key => Date.now() >= weekFromKey(key);

export function getWeek(sym, key) {
  const w = all[sym]?.[key] || {};
  return { prediction: clone(w.prediction) || null, log: clone(w.log) || { state: '', notes: [] } };
}

export function savePrediction(sym, key, prediction) {
  if (isLocked(key)) return false;
  slot(sym, key).prediction = { ...clone(prediction), savedAt: Date.now() };
  write();
  return true;
}

export function saveLog(sym, key, log) {
  slot(sym, key).log = clone(log);
  write();
}

/** { '2026-10-19': { predicted, logged } } for the calendar. */
export function weeksWithData(sym) {
  const out = {};
  for (const [key, w] of Object.entries(all[sym] || {})) {
    const p = w.prediction, l = w.log;
    const predicted = !!(p && (p.state || p.shapes?.length || p.notes?.length));
    const logged = !!(l && (l.state || l.notes?.length));
    if (predicted || logged) out[key] = { predicted, logged };
  }
  return out;
}
