// Gemensamma hjälpfunktioner för Vercel-funktionerna (filer som börjar med _ blir inte egna endpoints).
// Inga npm-beroenden: pratar direkt med Supabase REST/Auth och OneSignal REST via fetch.

const env = (k) => process.env[k] || '';
const SB = () => env('SUPABASE_URL').replace(/\/+$/, '');

function missing(keys) {
  return keys.filter((k) => !env(k));
}

async function raw(url, opts) {
  const r = await fetch(url, opts);
  const text = await r.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch (e) { body = text; }
  return { ok: r.ok, status: r.status, body };
}

// REST med användarens egen token (RLS gäller) eller service role (token = null).
function rest(path, token, opts = {}) {
  const key = token ? env('SUPABASE_ANON_KEY') : env('SUPABASE_SERVICE_ROLE_KEY');
  return raw(SB() + path, {
    ...opts,
    headers: { apikey: key, Authorization: 'Bearer ' + (token || key), 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
}
const svc = (path, opts) => rest(path, null, opts);

// Auth-admin-API (kräver service role)
const authAdmin = (path, opts = {}) => svc('/auth/v1/admin' + path, opts);

function bearer(req) {
  return (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
}

// Verifierar en användartoken mot Supabase Auth. Returnerar {id,email} eller null.
async function getUser(token) {
  if (!token) return null;
  const r = await raw(SB() + '/auth/v1/user', { headers: { apikey: env('SUPABASE_ANON_KEY'), Authorization: 'Bearer ' + token } });
  return r.ok && r.body && r.body.id ? { id: r.body.id, email: r.body.email || '' } : null;
}

async function isAdmin(token) {
  const r = await rest('/rest/v1/rpc/is_admin', token, { method: 'POST', body: '{}' });
  return r.ok && r.body === true;
}

const q = encodeURIComponent;

// ---- OneSignal -----------------------------------------------------------------
async function osPost(payload) {
  const r = await fetch('https://api.onesignal.com/notifications?c=push', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Key ' + env('ONESIGNAL_REST_API_KEY') },
    body: JSON.stringify({ app_id: env('ONESIGNAL_APP_ID'), target_channel: 'push', ...payload }),
  });
  const out = await r.json().catch(() => ({}));
  console.log('OneSignal', r.status, JSON.stringify(out), JSON.stringify(payload));
  return { ok: r.ok && !!out.id && !out.errors, out, status: r.status };
}

// Skickar till specifika användare (Supabase user_id = OneSignal external_id).
async function pushToUsers(ids, heading, message, url) {
  ids = [...new Set(ids)].filter(Boolean);
  if (!ids.length) return { sent: 0, note: 'inga mottagare' };
  let sent = 0; const errors = [];
  for (let i = 0; i < ids.length; i += 1500) {
    const part = ids.slice(i, i + 1500);
    const r = await osPost({
      include_aliases: { external_id: part },
      headings: { en: heading, sv: heading },
      contents: { en: message, sv: message },
      url,
    });
    if (r.ok) sent += part.length;
    else errors.push(r.out.errors || r.out); // t.ex. "All included players are not subscribed" = ingen har tillåtit push än
  }
  return { sent, errors };
}

// ---- Tid (Europe/Stockholm) ------------------------------------------------------
const TZ = 'Europe/Stockholm';
function tzOffsetMs(utcMs) {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    .formatToParts(new Date(utcMs)).reduce((a, x) => (a[x.type] = x.value, a), {});
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - utcMs;
}
// "2026-10-22", "19:30" i svensk tid => UTC-millisekunder
function stockholmMs(dateStr, hhmm) {
  const [y, m, d] = dateStr.split('-').map(Number), [h, mi] = (hhmm || '00:00').split(':').map(Number);
  const guess = Date.UTC(y, m - 1, d, h, mi);
  let ms = guess - tzOffsetMs(guess);
  ms = guess - tzOffsetMs(ms);
  return ms;
}
function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number), t = new Date(Date.UTC(y, m - 1, d + n));
  return t.toISOString().slice(0, 10);
}
const DAYS = ['sön', 'mån', 'tis', 'ons', 'tors', 'fre', 'lör'], MON = ['jan', 'feb', 'mars', 'apr', 'maj', 'juni', 'juli', 'aug', 'sep', 'okt', 'nov', 'dec'];
function niceDate(dateStr, hhmm) {
  const [y, m, d] = dateStr.split('-').map(Number), wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return DAYS[wd] + ' ' + d + ' ' + MON[m - 1] + (hhmm ? ' kl ' + hhmm.slice(0, 5) : '');
}

// Påminnelsetider för en match: 3 dagar före 11:00 och 20:30, därefter dagligen 12:00 (dagen före, och matchdagen om avspark efter 12:00).
function reminderSlots(dateStr, kickoff) {
  const ko = stockholmMs(dateStr, kickoff ? kickoff.slice(0, 5) : '23:59');
  const s = [
    stockholmMs(addDays(dateStr, -3), '11:00'),
    stockholmMs(addDays(dateStr, -3), '20:30'),
    stockholmMs(addDays(dateStr, -2), '12:00'),
    stockholmMs(addDays(dateStr, -1), '12:00'),
    stockholmMs(dateStr, '12:00'),
  ];
  return { slots: s.filter((t) => t < ko), kickoffMs: ko };
}

function siteUrl(req) {
  return (env('SITE_URL') || ('https://' + (req && req.headers && req.headers.host))).replace(/\/+$/, '');
}

function readBody(req) {
  try { return typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {}; } catch (e) { return {}; }
}

module.exports = { env, missing, raw, rest, svc, authAdmin, bearer, getUser, isAdmin, q, osPost, pushToUsers, stockholmMs, addDays, niceDate, reminderSlots, siteUrl, readBody };
