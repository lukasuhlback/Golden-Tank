// Vercel-funktion: /api/calendar.ics
// Öppet kalenderflöde (iCalendar) som vem som helst kan prenumerera på i mobilens kalender.
// Innehåller kommande matcher + admins kalenderhändelser.
const L = require('./_lib');

const pad = (n) => String(n).padStart(2, '0');
const utc = (ms) => { const d = new Date(ms); return d.getUTCFullYear() + pad(d.getUTCMonth() + 1) + pad(d.getUTCDate()) + 'T' + pad(d.getUTCHours()) + pad(d.getUTCMinutes()) + pad(d.getUTCSeconds()) + 'Z'; };
const day = (s) => String(s).slice(0, 10).replace(/-/g, '');
const esc = (t) => String(t == null ? '' : t).replace(/\\/g, '\\\\').replace(/;/g, '\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
function fold(line) { // max 75 byte per rad, vik med mellanslag
  const out = []; let cur = '', bytes = 0;
  for (const ch of line) {
    const b = Buffer.byteLength(ch);
    if (bytes + b > (out.length ? 74 : 75)) { out.push(cur); cur = ''; bytes = 0; }
    cur += ch; bytes += b;
  }
  out.push(cur);
  return out.join('\r\n ');
}
const hm = (t) => String(t).slice(0, 5);

function build(fixtures, events, nowMs) {
  const L2 = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Golden Tank//Kalender//SV', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', 'X-WR-CALNAME:Golden Tank', 'X-WR-TIMEZONE:Europe/Stockholm', 'REFRESH-INTERVAL;VALUE=DURATION:PT1H', 'X-PUBLISHED-TTL:PT1H'];
  const stamp = utc(nowMs);
  const ev = (uid, o) => {
    L2.push('BEGIN:VEVENT', 'UID:' + uid + '@golden-tank', 'DTSTAMP:' + stamp);
    if (o.start) { L2.push('DTSTART:' + utc(o.start), 'DTEND:' + utc(o.end)); }
    else { L2.push('DTSTART;VALUE=DATE:' + o.d1, 'DTEND;VALUE=DATE:' + o.d2); }
    L2.push('SUMMARY:' + esc(o.title));
    if (o.loc) L2.push('LOCATION:' + esc(o.loc));
    if (o.desc) L2.push('DESCRIPTION:' + esc(o.desc));
    L2.push('END:VEVENT');
  };
  for (const f of fixtures) {
    const date = String(f.played_on).slice(0, 10), title = '⚽ Golden Tank – ' + f.opp;
    if (f.kickoff) { const s = L.stockholmMs(date, hm(f.kickoff)); ev('match-' + f.id, { start: s, end: s + 3600e3, title, loc: f.venue, desc: f.series ? 'Serie: ' + f.series : '' }); }
    else ev('match-' + f.id, { d1: day(date), d2: day(L.addDays(date, 1)), title, loc: f.venue });
  }
  for (const e of events) {
    const d1 = String(e.starts_on).slice(0, 10), d2 = String(e.ends_on || e.starts_on).slice(0, 10);
    const title = (e.kind === 'träning' ? '🏃 ' : e.kind === 'lagfest' ? '🎉 ' : e.kind === 'läger' ? '🏕️ ' : e.kind === 'möte' ? '🗓️ ' : '📌 ') + e.title;
    if (e.start_time) {
      const s = L.stockholmMs(d1, hm(e.start_time)), en = e.end_time ? L.stockholmMs(d2, hm(e.end_time)) : s + 2 * 3600e3;
      ev('evt-' + e.id, { start: s, end: en > s ? en : s + 3600e3, title, loc: e.location, desc: e.notes });
    } else ev('evt-' + e.id, { d1: day(d1), d2: day(L.addDays(d2, 1)), title, loc: e.location, desc: e.notes });
  }
  L2.push('END:VCALENDAR');
  return L2.map(fold).join('\r\n') + '\r\n';
}

module.exports = async (req, res) => {
  try {
    const miss = L.missing(['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY']);
    if (miss.length) { res.statusCode = 500; return res.end('Saknar miljövariabler: ' + miss.join(', ')); }
    const since = new Date(Date.now() - 60 * 86400e3).toISOString().slice(0, 10);
    const [fx, ev] = await Promise.all([
      L.svc('/rest/v1/fixtures?select=id,opp,series,played_on,kickoff,venue&order=played_on'),
      L.svc('/rest/v1/calendar_events?select=*&starts_on=gte.' + since + '&order=starts_on'),
    ]);
    const body = build(fx.ok ? fx.body || [] : [], ev.ok ? ev.body || [] : [], Date.now());
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('Content-Disposition', 'inline; filename="golden-tank.ics"');
    res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=600');
    return res.end(body);
  } catch (e) {
    res.statusCode = 500; return res.end('Fel: ' + String(e.message || e));
  }
};
module.exports.build = build;
