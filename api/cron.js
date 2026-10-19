// Vercel-funktion: /api/cron
// Körs var 15:e minut (Supabase pg_cron -> se 21_cron_paminnelser.sql) eller manuellt av admin.
//  1) Skickar "Ny matchkallelse" till spelare vars kallelse just skapats.
//  2) Skickar påminnelser till spelare som inte svarat:
//     3 dagar före matchen kl 11:00, samma dag kl 20:30, dagen efter kl 12:00 och därefter dagligen kl 12:00
//     tills spelaren svarat eller matchen spelats (svensk tid).
// Auth: "Authorization: Bearer <CRON_SECRET>" (cron) eller inloggad admins token (manuell körning).
// ?force=1 skickar nya kallelser direkt. Nya kallelser väntar annars 10 min (admin hinner ändra truppen).
// Lägg till ?dry=1 för att se vad som skulle skickas utan att skicka eller markera något.
const L = require('./_lib');
const GRACE_MS = 10 * 60e3; // nya kallelser väntar 10 min så att admin hinner justera truppen

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const miss = L.missing(['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'ONESIGNAL_APP_ID', 'ONESIGNAL_REST_API_KEY']);
    if (miss.length) return res.status(500).json({ error: 'Miljövariabler saknas i Vercel: ' + miss.join(', ') });
    const token = L.bearer(req);
    const secret = L.env('CRON_SECRET');
    const bySecret = !!secret && token === secret;
    if (!bySecret && !(token && (await L.isAdmin(token)))) return res.status(401).json({ error: 'Ej behörig' });

    const url = new URL(req.url || '/', 'http://x');
    const dry = url.searchParams.get('dry') === '1';
    const force = url.searchParams.get('force') === '1'; // admin: skicka kallelser direkt (hoppa över 10 min betänketid)
    const nowMs = dry && url.searchParams.get('now') ? Date.parse(url.searchParams.get('now')) : Date.now();
    const nowIso = new Date(nowMs).toISOString();
    const site = L.siteUrl(req);

    // Kommande matcher (fixtures tas bort när matchrapporten importerats)
    const todayStr = new Date(nowMs - 24 * 3600e3).toISOString().slice(0, 10);
    const fx = await L.svc('/rest/v1/fixtures?select=id,opp,played_on,kickoff&played_on=gte.' + todayStr);
    if (!fx.ok) return res.status(500).json({ error: 'fixtures: ' + JSON.stringify(fx.body) });
    const fixtures = {};
    (fx.body || []).forEach((f) => {
      const { slots, kickoffMs } = L.reminderSlots(String(f.played_on).slice(0, 10), f.kickoff);
      if (kickoffMs > nowMs) fixtures[f.id] = { ...f, slots, kickoffMs, date: String(f.played_on).slice(0, 10) };
    });
    const ids = Object.keys(fixtures);
    const out = { dry, now: nowIso, fixtures: ids.length, invites: [], reminders: [] };
    if (!ids.length) return res.status(200).json(out);

    // Aktiva spelarprofiler + notisinställningar
    const [pr, pf, cl] = await Promise.all([
      L.svc('/rest/v1/player_profiles?select=user_id,player_id,full_name,active'),
      L.svc('/rest/v1/notification_preferences?select=user_id,calls,reminders'),
      L.svc('/rest/v1/match_calls?select=id,match_id,player_id,status,created_at,invited_at,last_reminder_at,reminder_count&player_id=not.is.null&match_id=in.(' + ids.join(',') + ')'),
    ]);
    if (!pr.ok || !pf.ok || !cl.ok) return res.status(500).json({ error: 'Kunde inte läsa data', detail: [pr.body, pf.body, cl.body].find((x) => x && x.message) });
    const profByPlayer = {}; (pr.body || []).forEach((p) => { if (p.active) profByPlayer[p.player_id] = p; });
    const prefs = {}; (pf.body || []).forEach((p) => { prefs[p.user_id] = p; });
    const wants = (uid, key) => !prefs[uid] || prefs[uid][key] !== false; // saknad rad = standardvärde (på)
    const label = (f) => 'GT - ' + f.opp + ', ' + L.niceDate(f.date, f.kickoff);
    const calls = cl.body || [];

    // 1) Nya kallelser
    const byMatchNew = {};
    calls.filter((c) => !c.invited_at && profByPlayer[c.player_id] && (force || nowMs - Date.parse(c.created_at) >= GRACE_MS)).forEach((c) => { (byMatchNew[c.match_id] = byMatchNew[c.match_id] || []).push(c); });
    for (const [mid, list] of Object.entries(byMatchNew)) {
      const f = fixtures[mid];
      const claimed = [];
      for (const c of list) {
        if (dry) { claimed.push(c); continue; }
        const r = await L.svc('/rest/v1/match_calls?id=eq.' + c.id + '&invited_at=is.null', { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ invited_at: nowIso }) });
        if (r.ok && r.body && r.body.length) claimed.push(c);
      }
      const users = claimed.map((c) => profByPlayer[c.player_id].user_id).filter((u) => wants(u, 'calls'));
      let res2 = { sent: users.length, dry: true };
      if (!dry) res2 = await L.pushToUsers(users, 'Ny matchkallelse 📅', label(f) + '. Svara i appen.', site + '/#/kallelser');
      out.invites.push({ match: +mid, claimed: claimed.length, recipients: users.length, result: res2 });
    }

    // 2) Påminnelser till obesvarade kallelser
    const byMatchRem = {};
    for (const c of calls) {
      if (c.status || !c.invited_at || !profByPlayer[c.player_id]) continue;
      const f = fixtures[c.match_id];
      const created = Date.parse(c.created_at);
      const due = f.slots.filter((t) => t <= nowMs && t > created); // endast tider efter att kallelsen skapats
      if (!due.length) continue;
      const latest = Math.max(...due);
      if (c.last_reminder_at && Date.parse(c.last_reminder_at) >= latest) continue; // redan påmind för denna tidpunkt
      const uid = profByPlayer[c.player_id].user_id;
      if (dry) { (byMatchRem[c.match_id] = byMatchRem[c.match_id] || []).push({ c, uid, wants: wants(uid, 'reminders') }); continue; }
      // "Claim": bara en körning får vinna (skyddar mot dubbla cron-anrop)
      const r = await L.svc('/rest/v1/match_calls?id=eq.' + c.id + '&status=is.null' + (c.last_reminder_at ? '&last_reminder_at=eq.' + L.q(c.last_reminder_at) : '&last_reminder_at=is.null'),
        { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ last_reminder_at: nowIso, reminder_count: (c.reminder_count || 0) + 1 }) });
      if (r.ok && r.body && r.body.length) (byMatchRem[c.match_id] = byMatchRem[c.match_id] || []).push({ c, uid, wants: wants(uid, 'reminders') });
    }
    for (const [mid, list] of Object.entries(byMatchRem)) {
      const users = list.filter((x) => x.wants).map((x) => x.uid);
      let r = { dry: true };
      if (!dry) r = await L.pushToUsers(users, 'Matchkallelse 📅', 'Du har en öppen matchkallelse. ' + label(fixtures[mid]), site + '/#/kallelser');
      out.reminders.push({ match: +mid, unanswered: list.length, recipients: users.length, result: r });
    }
    return res.status(200).json(out);
  } catch (e) {
    return res.status(500).json({ error: String((e && e.message) || e) });
  }
};
