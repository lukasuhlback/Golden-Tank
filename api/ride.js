// Vercel-funktion: /api/ride
// Inloggad spelare (POST, Authorization: Bearer <användartoken>):
//   {action:'plan',   ride_id}                 räknar om rutt/tider (anropas av appen efter bokning/ändring) och skickar väntande händelser
//   {action:'depart', ride_id}                 föraren trycker "Jag åker nu"
//   {action:'picked', ride_id, player_id}      föraren markerar en passagerare som hämtad
//   {action:'undo',   ride_id}                 föraren ångrar "Jag åker nu" (inom 3 min, utan notis)
// Cron (GET /api/ride?cron=1, Authorization: Bearer <CRON_SECRET>), varje minut:
//   skickar tidsstyrda notiser (matchdagen, 30 min före avgång, ca 5 min före hämtning) och väntande händelser.
//   ?dry=1&now=<ISO> visar vad som skulle skickas utan att skicka.
const L = require('./_lib');
const R = require('./_ride');

async function profileOf(userId) {
  const r = await L.svc('/rest/v1/player_profiles?select=player_id,full_name&user_id=eq.' + L.q(userId));
  return r.ok && r.body && r.body[0] ? r.body[0] : null;
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const miss = L.missing(['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'ONESIGNAL_APP_ID', 'ONESIGNAL_REST_API_KEY']);
    if (miss.length) return res.status(500).json({ error: 'Miljövariabler saknas i Vercel: ' + miss.join(', ') });
    const site = L.siteUrl(req), url = new URL(req.url || '/', 'http://x');
    const token = L.bearer(req);

    // ---- cron
    if (url.searchParams.get('cron') === '1') {
      const secret = L.env('CRON_SECRET');
      if (!(secret && token === secret) && !(token && (await L.isAdmin(token)))) return res.status(401).json({ error: 'Ej behörig' });
      const dry = url.searchParams.get('dry') === '1';
      const nowMs = dry && url.searchParams.get('now') ? Date.parse(url.searchParams.get('now')) : Date.now();
      const due = await R.runDue(site, nowMs, dry);
      const events = dry ? [] : await R.flushEvents(site, nowMs);
      return res.status(200).json({ dry, now: new Date(nowMs).toISOString(), due, events });
    }

    if (req.method !== 'POST') return res.status(405).json({ error: 'Använd POST' });
    const me = await L.getUser(token);
    if (!me) return res.status(401).json({ error: 'Inte inloggad' });
    const body = L.readBody(req), action = String(body.action || ''), rideId = parseInt(body.ride_id, 10);
    const prof = await profileOf(me.id), admin = await L.isAdmin(token);
    if (!prof && !admin) return res.status(403).json({ error: 'Endast spelare med konto' });
    const pid = prof ? prof.player_id : null;
    const nowMs = Date.now();

    if (!rideId) {   // ingen bil (t.ex. efter avbokning): skicka bara väntande händelser
      const events = await R.flushEvents(site, nowMs);
      return res.status(200).json({ ok: true, events: events.length });
    }
    const ride = await R.getRide(rideId);
    if (!ride) { const events = await R.flushEvents(site, nowMs); return res.status(200).json({ ok: true, gone: true, events: events.length }); }
    const isDriver = pid != null && ride.driver_player_id === pid;
    const bks = await R.getBookings(ride.id);
    const isPassenger = pid != null && bks.some((b) => b.player_id === pid);
    if (!isDriver && !isPassenger && !admin) return res.status(403).json({ error: 'Du är inte med i den här bilen' });

    if (action === 'plan') {
      const r = await R.buildPlan(ride, nowMs);
      if (r.needVenue) { await R.flushEvents(site, nowMs); return res.status(200).json({ ok: true, needVenue: true }); }
      if (r.gone) return res.status(200).json({ ok: true, gone: true });
      await R.notifyShifts(ride, r.prev, r.plan, r.bookings, r.fixture, site, isPassenger ? [pid] : []);
      const events = await R.flushEvents(site, nowMs);
      return res.status(200).json({ ok: true, plan: r.plan, events: events.length });
    }

    if (!isDriver && !admin) return res.status(403).json({ error: 'Bara föraren kan göra det här' });

    if (action === 'depart') {
      if (ride.departed_at) return res.status(200).json({ ok: true, already: true });
      const before = await R.getPlan(ride.id);
      const up = await L.svc('/rest/v1/rides?id=eq.' + ride.id + '&departed_at=is.null', { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ departed_at: new Date(nowMs).toISOString() }) });
      if (!(up.ok && up.body && up.body.length)) return res.status(200).json({ ok: true, already: true });
      const r = await R.buildPlan(up.body[0], nowMs);
      if (r.needVenue) return res.status(200).json({ ok: true, needVenue: true });
      const nm = await R.names([ride.driver_player_id]), f = r.fixture, drv = R.first(nm[ride.driver_player_id]);
      let sent = 0;
      for (const s of r.plan.stops) {
        const old = R.etaOf(before, s.player_id), cur = Date.parse(s.eta);
        await R.notifyPlayers([s.player_id], drv + ' har åkt 🚗', 'Du hämtas ca ' + R.hhmm(cur) + (old != null ? R.delta(cur - old) : '') + '. ' + R.dayLabel(f), site + '/#/kallelser');
        sent++;
      }
      return res.status(200).json({ ok: true, plan: r.plan, notified: sent });
    }

    if (action === 'picked') {
      const who = parseInt(body.player_id, 10);
      const b = bks.find((x) => x.player_id === who);
      if (!b) return res.status(404).json({ error: 'Passageraren finns inte i bilen' });
      if (!ride.departed_at) return res.status(400).json({ error: 'Tryck först "Jag åker nu"' });
      const before = await R.getPlan(ride.id);
      await L.svc('/rest/v1/ride_bookings?id=eq.' + b.id, { method: 'PATCH', body: JSON.stringify({ picked_at: b.picked_at ? null : new Date(nowMs).toISOString() }) });
      const r = await R.buildPlan(ride, nowMs);
      if (r.needVenue) return res.status(200).json({ ok: true, needVenue: true });
      const n = await R.notifyShifts(ride, before, r.plan, r.bookings, r.fixture, site, [who]);
      return res.status(200).json({ ok: true, plan: r.plan, notified: n });
    }

    if (action === 'undo') {
      if (!ride.departed_at || nowMs - Date.parse(ride.departed_at) > 3 * 60e3) return res.status(400).json({ error: 'Går bara att ångra de första minuterna' });
      await L.svc('/rest/v1/ride_bookings?ride_id=eq.' + ride.id, { method: 'PATCH', body: JSON.stringify({ picked_at: null }) });
      await L.svc('/rest/v1/rides?id=eq.' + ride.id, { method: 'PATCH', body: JSON.stringify({ departed_at: null }) });
      await L.svc('/rest/v1/ride_notice_log?ride_id=eq.' + ride.id + '&kind=eq.t5', { method: 'DELETE' });
      const r = await R.buildPlan({ ...ride, departed_at: null }, nowMs);
      return res.status(200).json({ ok: true, plan: r.plan || null });
    }

    return res.status(400).json({ error: 'Okänd åtgärd' });
  } catch (e) {
    return res.status(500).json({ error: String((e && e.message) || e) });
  }
};
