// Vercel-funktion: /api/cron
// Körs var 15:e minut (Supabase pg_cron -> se 21_cron_paminnelser.sql) eller manuellt av admin.
//  1) Skickar "Ny matchkallelse" till spelare vars kallelse just skapats.
//  2) Skickar påminnelser till spelare som inte svarat:
//     3 dagar före matchen kl 11:00, samma dag kl 20:30, dagen efter kl 12:00 och därefter dagligen kl 12:00
//     tills spelaren svarat eller matchen spelats (svensk tid).
// Auth: "Authorization: Bearer <CRON_SECRET>" (cron) eller inloggad admins token (manuell körning).
// Kallelsen skickas automatiskt 3 dagar före matchen kl 11:00 (svensk tid). Matcher som läggs in med mindre tid kvar kallas efter 10 min.
// ?force=1&match=<id> skickar kallelsen för just den matchen direkt (admin).
// Lägg till ?dry=1 för att se vad som skulle skickas utan att skicka eller markera något.
const L = require('./_lib');
const notifyOrders = require('./_orders');
const GRACE_MS = 10 * 60e3; // nya kallelser väntar 10 min så att admin hinner justera truppen

// Matchens lirare: 1 timme efter avspark skapas omröstningen (stänger kl 23:59 samma dag) och notis går till alla som svarat ja.
async function motmRun(nowMs, dry, site) {
  const out = [];
  const from = new Date(nowMs - 36 * 3600e3).toISOString().slice(0, 10);
  const fx = await L.svc('/rest/v1/fixtures?select=id,opp,played_on,kickoff&kickoff=not.is.null&played_on=gte.' + from);
  if (!fx.ok) return out;
  for (const f of fx.body || []) {
    const date = String(f.played_on).slice(0, 10);
    const opens = L.stockholmMs(date, String(f.kickoff).slice(0, 5)) + 3600e3;
    const closes = L.stockholmMs(L.addDays(date, 1), '00:00');
    if (!(nowMs >= opens && nowMs < closes)) continue;
    const have = await L.svc('/rest/v1/motm_polls?select=match_id&match_id=eq.' + f.id);
    if (have.ok && have.body && have.body.length) continue;
    if (dry) { out.push({ match: f.id, dry: true, opens: new Date(opens).toISOString(), closes: new Date(closes).toISOString() }); continue; }
    const claim = await L.svc('/rest/v1/motm_polls?on_conflict=match_id', { method: 'POST', headers: { Prefer: 'resolution=ignore-duplicates,return=representation' }, body: JSON.stringify([{ match_id: f.id, opens_at: new Date(opens).toISOString(), closes_at: new Date(closes).toISOString() }]) });
    if (!(claim.ok && claim.body && claim.body.length)) continue;
    const [cl, pr, pf] = await Promise.all([
      L.svc('/rest/v1/match_calls?select=player_id&status=eq.yes&player_id=not.is.null&match_id=eq.' + f.id),
      L.svc('/rest/v1/player_profiles?select=user_id,player_id,active'),
      L.svc('/rest/v1/notification_preferences?select=user_id,motm'),
    ]);
    const yes = new Set(((cl.ok && cl.body) || []).map((c) => c.player_id));
    const prefs = {}; ((pf.ok && pf.body) || []).forEach((x) => { prefs[x.user_id] = x; });
    const users = ((pr.ok && pr.body) || []).filter((x) => x.active && yes.has(x.player_id) && !(prefs[x.user_id] && prefs[x.user_id].motm === false)).map((x) => x.user_id);
    const r = await L.pushToUsers(users, 'Rösta fram matchens lirare 🏅', 'GT - ' + f.opp + '. Vem var bäst i kväll? Rösta senast kl 23:59.', site + '/#/m/' + f.id);
    out.push({ match: f.id, recipients: users.length, result: r });
  }
  return out;
}

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
    const forceMatch = url.searchParams.get('force') === '1' ? String(url.searchParams.get('match') || '') : ''; // admin: skicka kallelser direkt för EN match
    const nowMs = dry && url.searchParams.get('now') ? Date.parse(url.searchParams.get('now')) : Date.now();
    const nowIso = new Date(nowMs).toISOString();
    const site = L.siteUrl(req);

    // Säkerhetsnät: meddela om beställningar som missats (se /api/shop-order)
    let ordRes = null;
    if (!dry) { try { ordRes = await notifyOrders(site); } catch (e) { ordRes = { error: String(e.message || e) }; } }

    // Kommande matcher (fixtures tas bort när matchrapporten importerats)
    const todayStr = new Date(nowMs - 24 * 3600e3).toISOString().slice(0, 10);
    let fx = await L.svc('/rest/v1/fixtures?select=id,opp,series,kit_choice,played_on,kickoff&played_on=gte.' + todayStr);
    if (!fx.ok) fx = await L.svc('/rest/v1/fixtures?select=id,opp,played_on,kickoff&played_on=gte.' + todayStr); // 30_stall_notiser.sql ej körd än
    if (!fx.ok) return res.status(500).json({ error: 'fixtures: ' + JSON.stringify(fx.body) });
    const fixtures = {};
    (fx.body || []).forEach((f) => {
      const { slots, kickoffMs } = L.reminderSlots(String(f.played_on).slice(0, 10), f.kickoff);
      if (kickoffMs > nowMs) fixtures[f.id] = { ...f, slots, kickoffMs, date: String(f.played_on).slice(0, 10), inviteAt: L.stockholmMs(L.addDays(String(f.played_on).slice(0, 10), -3), '11:00') };
    });
    const ids = Object.keys(fixtures);
    const out = { dry, now: nowIso, fixtures: ids.length, invites: [], reminders: [], kits: [], motm: [], orders: ordRes };
    try { out.motm = await motmRun(nowMs, dry, site); } catch (e) { out.motm = [{ error: String((e && e.message) || e) }]; }
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
    calls.filter((c) => !c.invited_at && profByPlayer[c.player_id] && ((forceMatch && String(c.match_id) === forceMatch) || (nowMs >= fixtures[c.match_id].inviteAt && nowMs - Date.parse(c.created_at) >= GRACE_MS))).forEach((c) => { (byMatchNew[c.match_id] = byMatchNew[c.match_id] || []).push(c); });
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
      const after = Math.max(created, Date.parse(c.invited_at) || 0);
      const due = f.slots.filter((t) => t <= nowMs && t > after); // endast tider efter att kallelsen skapats/skickats
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

    // 3) Tröjnotis: motståndaren spelar i vitt och ställ är valt. Dagen före kl 19:00 och matchdagen kl 16:00, bara till spelare som svarat ja.
    try {
      const nk = (x) => String(x || '').toLowerCase().replace(/[^a-zåäö0-9]/g, '');
      const kr = await L.svc('/rest/v1/team_kits?select=series,team,color&color=eq.' + L.q('vit'));
      const whites = (kr.ok && kr.body) || [];
      const WIN = 3 * 3600e3;
      for (const f of Object.values(fixtures)) {
        if (!f.kit_choice) continue;
        if (!whites.some((k) => k.series === f.series && nk(k.team) === nk(f.opp))) continue;
        const slots = [['before', L.stockholmMs(L.addDays(f.date, -1), '19:00')], ['day', L.stockholmMs(f.date, '16:00')]];
        const due = slots.filter(([, t]) => nowMs >= t && nowMs < t + WIN && nowMs < f.kickoffMs);
        for (const [kind] of due) {
          const yes = calls.filter((c) => String(c.match_id) === String(f.id) && c.status === 'yes' && profByPlayer[c.player_id]);
          const users = yes.map((c) => profByPlayer[c.player_id].user_id).filter((u) => wants(u, 'kits'));
          const blue = f.kit_choice === 'blue';
          const when = kind === 'before' ? 'Imorgon' : 'Matchdag';
          const title = when + ': vi spelar i ' + (blue ? 'BLÅTT 🔵' : 'VITT ⚪');
          const msg = label(f) + '. ' + f.opp + ' spelar i vitt. ' + (blue ? 'Vi spelar i blått – ta med båda ställen (vitt i backup).' : 'Vi spelar i vitt – ta med båda ställen (blått i backup).');
          if (dry) { out.kits.push({ match: +f.id, kind, choice: f.kit_choice, recipients: users.length, dry: true }); continue; }
          const claim = await L.svc('/rest/v1/kit_notice_log?on_conflict=match_id,kind,choice', { method: 'POST', headers: { Prefer: 'resolution=ignore-duplicates,return=representation' }, body: JSON.stringify([{ match_id: +f.id, kind, choice: f.kit_choice }]) });
          if (!(claim.ok && claim.body && claim.body.length)) continue;
          const r3 = await L.pushToUsers(users, title, msg, site + '/#/m/' + f.id);
          out.kits.push({ match: +f.id, kind, choice: f.kit_choice, recipients: users.length, result: r3 });
        }
      }
    } catch (e) { out.kits.push({ error: String((e && e.message) || e) }); }
    return res.status(200).json(out);
  } catch (e) {
    return res.status(500).json({ error: String((e && e.message) || e) });
  }
};
