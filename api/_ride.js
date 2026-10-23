// Skjuts: ruttberäkning, tider och notiser. Används av /api/ride (och cron-läget ?cron=1).
// Inga npm-beroenden. Vägtider hämtas från OSRM (gratis, ingen nyckel; byt med miljövariabeln OSRM_URL).
// Om OSRM inte svarar uppskattas tiden från fågelavstånd, så att appen aldrig stannar.
const L = require('./_lib');

const DWELL_S = 90;              // stopp vid varje upphämtning (sek)
const SPEED_MPS = 9.7;           // reservberäkning: ~35 km/h inkl. vägkrokar
const WIGGLE = 1.35;
const SHIFT_NOTIFY_MS = 5 * 60e3; // ny tid skickas bara om den flyttas minst 5 min
const TZ = 'Europe/Stockholm';

const hhmm = (ms) => new Intl.DateTimeFormat('sv-SE', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(ms));
const mins = (ms) => Math.round(ms / 60000);
const delta = (ms) => { const m = mins(ms); return Math.abs(m) >= 1 ? ' (' + (m > 0 ? '+' : '−') + Math.abs(m) + ' min)' : ''; };

function hav(a, b) {
  const R = 6371000, r = Math.PI / 180;
  const dLat = (b.lat - a.lat) * r, dLng = (b.lng - a.lng) * r;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

// Matris med körtid i sekunder mellan alla punkter. {m, source}
async function durations(points) {
  const base = (L.env('OSRM_URL') || 'https://router.project-osrm.org').replace(/\/+$/, '');
  try {
    const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 7000);
    const url = base + '/table/v1/driving/' + points.map((p) => p.lng.toFixed(6) + ',' + p.lat.toFixed(6)).join(';') + '?annotations=duration';
    const r = await fetch(url, { signal: ctl.signal, headers: { 'User-Agent': 'golden-tank-app' } });
    clearTimeout(t);
    const j = await r.json();
    if (r.ok && j && j.durations && j.durations.length === points.length && j.durations.every((row) => row.every((v) => typeof v === 'number'))) return { m: j.durations, source: 'osrm' };
  } catch (e) { /* faller tillbaka */ }
  return { m: points.map((a) => points.map((b) => (a === b ? 0 : (hav(a, b) * WIGGLE) / SPEED_MPS))), source: 'estimate' };
}

function* perms(arr) {
  if (arr.length <= 1) { yield arr.slice(); return; }
  for (let i = 0; i < arr.length; i++) {
    const rest = arr.slice(0, i).concat(arr.slice(i + 1));
    for (const p of perms(rest)) yield [arr[i]].concat(p);
  }
}

// Bästa ordning att hämta upp i (kortast total körtid). Index: 0 = start, 1..n = stopp, n+1 = mål.
function bestOrder(m, n) {
  const idx = Array.from({ length: n }, (_, i) => i + 1), dest = n + 1;
  const cost = (o) => { let c = 0, cur = 0; for (const i of o) { c += m[cur][i]; cur = i; } return c + m[cur][dest]; };
  if (n <= 7) {
    let best = null, bc = Infinity;
    for (const o of perms(idx)) { const c = cost(o); if (c < bc) { bc = c; best = o; } }
    return best || [];
  }
  const left = new Set(idx), o = []; let cur = 0; // många stopp: närmaste granne
  while (left.size) { let b = -1, bd = Infinity; for (const i of left) if (m[cur][i] < bd) { bd = m[cur][i]; b = i; } o.push(b); left.delete(b); cur = b; }
  return o;
}

// start = {lat,lng}, stops = [{id,lat,lng}], dest = {lat,lng}, t0Ms = tid då bilen lämnar start.
async function planRoute(start, stops, dest, t0Ms) {
  const points = [start, ...stops, dest];
  const { m, source } = await durations(points);
  const order = bestOrder(m, stops.length);
  let t = t0Ms, cur = 0, driveS = 0; const out = [];
  for (const i of order) { t += m[cur][i] * 1000; driveS += m[cur][i]; out.push({ player_id: stops[i - 1].id, eta: new Date(Math.round(t)).toISOString() }); t += DWELL_S * 1000; cur = i; }
  t += m[cur][stops.length + 1] * 1000; driveS += m[cur][stops.length + 1];
  return { stops: out, arrive: new Date(Math.round(t)).toISOString(), driveMin: Math.round(driveS / 60), source };
}

// ---- data -----------------------------------------------------------------------
const get = async (path) => { const r = await L.svc(path); if (!r.ok) throw new Error('db ' + path + ': ' + JSON.stringify(r.body)); return r.body || []; };
const getRide = async (id) => (await get('/rest/v1/rides?select=*&id=eq.' + id))[0] || null;
const getBookings = (rideId) => get('/rest/v1/ride_bookings?select=*&ride_id=eq.' + rideId);
const getFixture = async (id) => (await get('/rest/v1/fixtures?select=id,opp,played_on,kickoff,venue,venue_lat,venue_lng&id=eq.' + id))[0] || null;
const getPlan = async (rideId) => { const r = (await get('/rest/v1/ride_plan?select=plan&ride_id=eq.' + rideId))[0]; return r ? r.plan : null; };
const names = async (ids) => { ids = [...new Set(ids)].filter(Boolean); if (!ids.length) return {}; const o = {}; (await get('/rest/v1/players?select=id,name&id=in.(' + ids.join(',') + ')')).forEach((p) => { o[p.id] = p.name; }); return o; };
const first = (n) => String(n || '').split(' ')[0] || 'Någon';

// Matchplatsens koordinater. Saknas de försöker vi slå upp fixtures.venue (en gång) via Nominatim.
async function venueOf(f) {
  if (f.venue_lat != null && f.venue_lng != null) return { lat: f.venue_lat, lng: f.venue_lng };
  if (!f.venue || String(f.venue).trim().length < 3) return null;
  try {
    const base = (L.env('NOMINATIM_URL') || 'https://nominatim.openstreetmap.org').replace(/\/+$/, '');
    const r = await fetch(base + '/search?format=json&limit=1&countrycodes=se&q=' + encodeURIComponent(f.venue + ', Stockholm'), { headers: { 'User-Agent': 'golden-tank-app (klubbapp)' } });
    const j = await r.json();
    if (j && j[0]) {
      const v = { lat: +j[0].lat, lng: +j[0].lon };
      await L.svc('/rest/v1/fixtures?id=eq.' + f.id + '&venue_lat=is.null', { method: 'PATCH', body: JSON.stringify({ venue_lat: v.lat, venue_lng: v.lng }) });
      return v;
    }
  } catch (e) { /* ingen träff */ }
  return null;
}

// Räknar om bilens plan och sparar den. Returnerar {plan, prev} eller {needVenue:true}.
async function buildPlan(ride, nowMs) {
  const [f, bks, prev] = await Promise.all([getFixture(ride.match_id), getBookings(ride.id), getPlan(ride.id)]);
  if (!f) return { gone: true };
  const dest = await venueOf(f);
  if (!dest) return { needVenue: true, prev };
  const picked = bks.filter((b) => b.picked_at).sort((a, b) => Date.parse(a.picked_at) - Date.parse(b.picked_at));
  const rest = bks.filter((b) => !b.picked_at);
  let start = { lat: ride.start_lat, lng: ride.start_lng }, t0 = Date.parse(ride.depart_at);
  if (ride.departed_at) {
    t0 = Date.parse(ride.departed_at);
    const last = picked[picked.length - 1];
    if (last) { start = { lat: last.place_lat, lng: last.place_lng }; t0 = Date.parse(last.picked_at); }
  }
  const r = await planRoute(start, rest.map((b) => ({ id: b.player_id, lat: b.place_lat, lng: b.place_lng })), dest, t0);
  const plan = { t0: new Date(t0).toISOString(), departed: !!ride.departed_at, ...r, picked: picked.map((b) => b.player_id), computed_at: new Date(nowMs || Date.now()).toISOString() };
  await L.svc('/rest/v1/ride_plan?on_conflict=ride_id', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates' }, body: JSON.stringify({ ride_id: ride.id, plan, updated_at: plan.computed_at }) });
  return { plan, prev, bookings: bks, fixture: f };
}

// ---- notiser ----------------------------------------------------------------------------
// Skickar till spelare (player_id) som har skjutsnotiser påslagna.
async function notifyPlayers(playerIds, heading, msg, url) {
  playerIds = [...new Set(playerIds)].filter(Boolean);
  if (!playerIds.length) return { sent: 0 };
  const prof = await get('/rest/v1/player_profiles?select=user_id,player_id,active&player_id=in.(' + playerIds.join(',') + ')');
  const uids = prof.filter((p) => p.active !== false).map((p) => p.user_id);
  if (!uids.length) return { sent: 0 };
  const pr = await get('/rest/v1/notification_preferences?select=user_id,rides&user_id=in.(' + uids.join(',') + ')');
  const off = new Set(pr.filter((p) => p.rides === false).map((p) => p.user_id));
  return L.pushToUsers(uids.filter((u) => !off.has(u)), heading, msg, url);
}

// Dubblettskydd: true om det här var första gången (ride, spelare, sort) skickades.
async function claim(rideId, playerId, kind) {
  const r = await L.svc('/rest/v1/ride_notice_log?on_conflict=ride_id,player_id,kind', { method: 'POST', headers: { Prefer: 'resolution=ignore-duplicates,return=representation' }, body: JSON.stringify([{ ride_id: rideId, player_id: playerId || 0, kind }]) });
  return !!(r.ok && Array.isArray(r.body) && r.body.length);
}
const hasLog = async (rideId, kind) => (await get('/rest/v1/ride_notice_log?select=kind&ride_id=eq.' + rideId + '&kind=eq.' + kind + '&limit=1')).length > 0;

const dayDate = (f) => String(f.played_on).slice(0, 10);
const dayLabel = (f) => 'GT - ' + f.opp + ', ' + L.niceDate(dayDate(f), f.kickoff);
const etaOf = (plan, pid) => { const s = plan && (plan.stops || []).find((x) => x.player_id === pid); return s ? Date.parse(s.eta) : null; };
const placeOf = (bks, pid) => { const b = bks.find((x) => x.player_id === pid); return b ? b.place_label + ' (' + b.place_address + ')' : ''; };

// Meddelar passagerare vars tid flyttats minst 5 min (om dagens notiser redan gått ut eller bilen åkt).
async function notifyShifts(ride, prev, plan, bks, f, site, exclude) {
  if (!prev || !plan) return 0;
  if (!(ride.departed_at || (await hasLog(ride.id, 'day')))) return 0;
  let n = 0;
  for (const s of plan.stops) {
    if (exclude && exclude.includes(s.player_id)) continue;
    const old = etaOf(prev, s.player_id), cur = Date.parse(s.eta);
    if (old == null || Math.abs(cur - old) < SHIFT_NOTIFY_MS) continue;
    await notifyPlayers([s.player_id], 'Ny hämtningstid 🚗', 'Du hämtas nu ca ' + hhmm(cur) + delta(cur - old) + '. ' + dayLabel(f), site + '/#/kallelser');
    n++;
  }
  return n;
}

// Skickar väntande händelser (bokningar, avbokningar, inställda bilar, ändrad avgång).
async function flushEvents(site, nowMs) {
  const evs = await get('/rest/v1/ride_events?select=*&sent_at=is.null&order=id.asc&limit=40');
  const out = [];
  for (const ev of evs) {
    const c = await L.svc('/rest/v1/ride_events?id=eq.' + ev.id + '&sent_at=is.null', { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ sent_at: new Date(nowMs || Date.now()).toISOString() }) });
    if (!(c.ok && c.body && c.body.length)) continue;
    try {
      const url = site + '/#/kallelser';
      const ride = ev.ride_id ? await getRide(ev.ride_id) : null;
      const f = ev.match_id ? await getFixture(ev.match_id) : null;
      const lab = f ? dayLabel(f) : '';
      if (ev.kind === 'booked' && ride) {
        const [bks, nm] = await Promise.all([getBookings(ride.id), names([ev.player_id, ride.driver_player_id])]);
        const b = bks.find((x) => x.player_id === ev.player_id);
        const left = Math.max(0, ride.seats - bks.length);
        await notifyPlayers([ride.driver_player_id], 'Ny passagerare 🙋', nm[ev.player_id] + ' bokade plats i din bil – hämtas ' + (b ? b.place_label + ', ' + b.place_address : '') + '. ' + (left ? left + ' lediga platser kvar.' : 'Bilen är nu full.'), url);
        // Bokning efter att dagens notis gått ut: passageraren får sin tid direkt
        if (f && (await hasLog(ride.id, 'day'))) {
          const plan = await getPlan(ride.id), e = etaOf(plan, ev.player_id);
          if (e) await notifyPlayers([ev.player_id], 'Du är bokad 🚗', first(nm[ride.driver_player_id]) + ' åker kl ' + hhmm(Date.parse(ride.depart_at)) + ' och hämtar dig ca ' + hhmm(e) + '. ' + lab, url);
        }
      } else if (ev.kind === 'passenger_left' && ride) {
        const nm = await names([ev.player_id]);
        await notifyPlayers([ride.driver_player_id], 'Avbokning', (nm[ev.player_id] || 'En passagerare') + ' avbokade sin plats i din bil. ' + lab, url);
      } else if (ev.kind === 'ride_cancelled') {
        const pas = (ev.payload && ev.payload.passengers) || [], nm = await names([ev.player_id]);
        await notifyPlayers(pas, 'Skjutsen är inställd ❗', first(nm[ev.player_id]) + ' har ställt in sin bil. Boka en annan skjuts i appen. ' + lab, url);
      } else if (ev.kind === 'ride_changed' && ride) {
        const b = await buildPlan(ride, nowMs), bks = b.bookings || (await getBookings(ride.id)), nm = await names([ride.driver_player_id]);
        for (const x of bks) {
          const e = b.plan ? etaOf(b.plan, x.player_id) : null;
          await notifyPlayers([x.player_id], 'Ändrad avgång 🕒', first(nm[ride.driver_player_id]) + ' åker nu kl ' + hhmm(Date.parse(ride.depart_at)) + (e ? ' och hämtar dig ca ' + hhmm(e) : '') + '. ' + lab, url);
        }
      }
      out.push({ id: ev.id, kind: ev.kind });
    } catch (e) { out.push({ id: ev.id, kind: ev.kind, error: String(e.message || e) }); }
  }
  return out;
}

// Tidsstyrda notiser (körs varje minut av cron). Returnerar vad som skickades.
async function runDue(site, nowMs, dry) {
  const sent = [];
  const rides = await get('/rest/v1/rides?select=*&depart_at=gte.' + L.q(new Date(nowMs - 8 * 3600e3).toISOString()) + '&depart_at=lte.' + L.q(new Date(nowMs + 40 * 3600e3).toISOString()));
  for (const ride of rides) {
    const [bks, f, nm] = await Promise.all([getBookings(ride.id), getFixture(ride.match_id), names([ride.driver_player_id])]);
    if (!f) continue;
    const dep = Date.parse(ride.depart_at), lab = dayLabel(f), url = site + '/#/kallelser', drv = first(nm[ride.driver_player_id]);
    const remaining = bks.filter((b) => !b.picked_at);
    const send = async (kind, pid, head, msg) => {
      if (dry) { sent.push({ ride: ride.id, kind, player: pid, msg }); return; }
      if (!(await claim(ride.id, pid, kind))) return;
      await notifyPlayers([pid], head, msg, url); sent.push({ ride: ride.id, kind, player: pid, msg });
    };
    if (!ride.departed_at && bks.length) {
      let plan = await getPlan(ride.id);
      const fresh = () => plan && Date.parse(plan.t0) === dep && !plan.departed;
      if (!fresh()) { const b = await buildPlan(ride, nowMs); plan = b.plan || plan; }
      const daySlot = Math.min(L.stockholmMs(dayDate(f), '14:00'), dep - 90 * 60e3);
      if (nowMs >= daySlot && nowMs < dep) {
        for (const b of bks) { const e = etaOf(plan, b.player_id); if (e) await send('day', b.player_id, 'Din skjuts idag 🚗', drv + ' åker kl ' + hhmm(dep) + ' och hämtar dig ca ' + hhmm(e) + ' – ' + b.place_label + ' (' + b.place_address + '). ' + lab); }
        await send('day', ride.driver_player_id, 'Din körning idag 🚗', 'Du åker kl ' + hhmm(dep) + ' med ' + bks.length + ' passagerare. ' + lab);
      }
      if (nowMs >= dep - 30 * 60e3 && nowMs < dep) {
        for (const b of bks) { const e = etaOf(plan, b.player_id); await send('t30', b.player_id, 'Skjutsen åker snart ⏰', 'Bilen åker om 30 min' + (e ? '. Du hämtas ca ' + hhmm(e) : '') + ' – ' + b.place_label + '. ' + lab); }
        await send('t30', ride.driver_player_id, 'Dags att åka snart ⏰', 'Åk kl ' + hhmm(dep) + ' – ' + bks.length + ' passagerare väntar. Tryck "Jag åker nu" när du åker.');
      }
      if (nowMs >= dep + 5 * 60e3 && nowMs < dep + 60 * 60e3) await send('nodepart', ride.driver_player_id, 'Har du åkt? 🚗', 'Glöm inte trycka "Jag åker nu" så att passagerarna får rätt tider.');
    }
    if (ride.departed_at && remaining.length) {
      const plan = await getPlan(ride.id);
      for (const b of remaining) { const e = etaOf(plan, b.player_id); if (e && nowMs >= e - 5 * 60e3 && nowMs < e + 25 * 60e3) await send('t5', b.player_id, 'Bilen närmar sig 📍', 'Bilen är ca 5 min bort – förbered dig nu. ' + b.place_label + '.'); }
    }
  }
  return sent;
}

module.exports = { hhmm, hav, durations, bestOrder, planRoute, buildPlan, getRide, getBookings, getFixture, getPlan, names, first, notifyPlayers, notifyShifts, flushEvents, runDue, claim, etaOf, delta, dayLabel, placeOf, SHIFT_NOTIFY_MS };
