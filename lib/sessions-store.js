/* ============================================================================
   FlipBook · sessions store  (app/www/lib/sessions-store.js)
   ----------------------------------------------------------------------------
   User-customizable trading sessions for the journal Window field. Each session
   has a name, a start/end time (HH:MM in the user's home timezone), and a DST
   market tag. When the tagged market (London / US) is on summer time, that
   session shifts one hour earlier automatically — the browser's timezone
   database tells us when, so we never hand-code DST rules.

     getSessions / setSessions / addSession / removeSession / resetSessions
     getHomeTz / setHomeTz
     effectiveRange(session)      → DST-adjusted { start, end, shifted }
     currentSessionId(sessions)   → id of the session matching "now"
     formatRange(session)         → "15:00–19:00" (+ DST note)
   ========================================================================== */

const S_KEY = 'flipbook.sessions.v1';
const TZ_KEY = 'flipbook.homeTz.v1';

const MARKET_TZ = { london: 'Europe/London', us: 'America/New_York' };

export const DST_MARKETS = [
  { value: 'none', label: 'No DST (fixed)' },
  { value: 'london', label: 'Follows London DST' },
  { value: 'us', label: 'Follows US DST' },
];

export const DEFAULT_SESSIONS = [
  { id: 's1', name: 'Asia morning', start: '08:00', end: '12:00', dst: 'none' },
  { id: 's2', name: 'Asia lunch', start: '12:00', end: '13:30', dst: 'none' },
  { id: 's3', name: 'Asia–London crossover', start: '13:30', end: '15:00', dst: 'none' },
  { id: 's4', name: 'London morning', start: '15:00', end: '19:00', dst: 'london' },
  { id: 's5', name: 'London lunch', start: '19:00', end: '20:30', dst: 'london' },
  { id: 's6', name: 'US Forex open', start: '20:30', end: '21:30', dst: 'us' },
  { id: 's7', name: 'US Stocks open', start: '21:30', end: '00:00', dst: 'us' },
  { id: 's8', name: 'US lunch', start: '00:00', end: '01:30', dst: 'us' },
  { id: 's9', name: 'US close', start: '01:30', end: '04:00', dst: 'us' },
  { id: 's10', name: 'Inter-day change', start: '05:00', end: '06:00', dst: 'none' },
];

const detectedTz = () => {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Kuala_Lumpur'; }
  catch { return 'Asia/Kuala_Lumpur'; }
};

let sessions = loadSessions();
let homeTz = localStorage.getItem(TZ_KEY) || detectedTz();
const subs = new Set();

function loadSessions() {
  try {
    const v = JSON.parse(localStorage.getItem(S_KEY));
    return Array.isArray(v) && v.length ? cloneList(v) : cloneList(DEFAULT_SESSIONS);
  } catch { return cloneList(DEFAULT_SESSIONS); }
}
function cloneList(list) { return list.map(s => ({ ...s })); }
const persist = () => { try { localStorage.setItem(S_KEY, JSON.stringify(sessions)); } catch {} subs.forEach(f => f()); };

const uuid = () => 'sx' + Math.random().toString(36).slice(2, 9);

/* ---- accessors ---- */
export function getSessions() { return sessions.map(s => ({ ...s })); }
export function setSessions(list) { sessions = list.map(s => ({ ...s })); persist(); }
export function addSession(s = {}) {
  sessions.push({ id: uuid(), name: s.name || 'New session', start: s.start || '09:00', end: s.end || '12:00', dst: s.dst || 'none' });
  persist();
}
export function removeSession(id) { sessions = sessions.filter(s => s.id !== id); persist(); }
export function resetSessions() { sessions = cloneList(DEFAULT_SESSIONS); persist(); }
export function onSessionsChange(fn) { subs.add(fn); return () => subs.delete(fn); }

export const getHomeTz = () => homeTz;
export function setHomeTz(tz) { homeTz = tz || detectedTz(); try { localStorage.setItem(TZ_KEY, homeTz); } catch {} subs.forEach(f => f()); }

/* ---- time helpers ---- */
const toMin = hhmm => { const [h, m] = String(hhmm).split(':').map(Number); return (h * 60 + (m || 0)); };
const toHHMM = min => { const m = ((min % 1440) + 1440) % 1440; return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`; };

/** Offset (minutes ahead of UTC) for an IANA zone at a given instant. */
function zoneOffsetMin(tz, date) {
  const p = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(date).reduce((a, x) => (a[x.type] = x.value, a), {});
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return Math.round((asUTC - date.getTime()) / 60000);
}

/** Is the given market currently observing summer time? */
export function isMarketDST(market, date = new Date()) {
  const tz = MARKET_TZ[market]; if (!tz) return false;
  const y = date.getUTCFullYear();
  const jan = zoneOffsetMin(tz, new Date(Date.UTC(y, 0, 1)));
  const jul = zoneOffsetMin(tz, new Date(Date.UTC(y, 6, 1)));
  if (jan === jul) return false;
  return zoneOffsetMin(tz, date) === Math.max(jan, jul);
}

/** DST-adjusted range: tagged markets move 1h earlier on summer time. */
export function effectiveRange(session, date = new Date()) {
  const shift = (session.dst && session.dst !== 'none' && isMarketDST(session.dst, date)) ? -60 : 0;
  return { start: toHHMM(toMin(session.start) + shift), end: toHHMM(toMin(session.end) + shift), shifted: shift !== 0 };
}

/** Current wall-clock minutes in the home timezone. */
function nowMinInHome(date = new Date()) {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: homeTz, hour12: false, hour: '2-digit', minute: '2-digit' })
    .formatToParts(date).reduce((a, x) => (a[x.type] = x.value, a), {});
  return (+p.hour % 24) * 60 + +p.minute;
}

/** Id of the session containing "now" (handles ranges crossing midnight). */
export function currentSessionId(list = sessions, date = new Date()) {
  const now = nowMinInHome(date);
  for (const s of list) {
    const r = effectiveRange(s, date);
    let a = toMin(r.start), b = toMin(r.end);
    if (b === a) continue;
    const inRange = a < b ? (now >= a && now < b) : (now >= a || now < b); // wrap past midnight
    if (inRange) return s.id;
  }
  return null;
}

/** "15:00–19:00" with a DST note when shifted. */
export function formatRange(session, date = new Date()) {
  const r = effectiveRange(session, date);
  return `${r.start}–${r.end}${r.shifted ? ' · DST −1h' : ''}`;
}
