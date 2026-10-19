// Vercel-funktion: /api/remind  (endast admin)
// Skickar en påminnelse direkt till spelare som inte svarat på en matchkallelse ("Skicka notis nu").
// Body: { match_id, call_ids?: [..] }  – utan call_ids skickas till alla obesvarade i matchen.
const L = require('./_lib');

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Använd POST' });
  try {
    const miss = L.missing(['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'ONESIGNAL_APP_ID', 'ONESIGNAL_REST_API_KEY']);
    if (miss.length) return res.status(500).json({ error: 'Miljövariabler saknas i Vercel: ' + miss.join(', ') });
    const token = L.bearer(req);
    if (!token || !(await L.isAdmin(token))) return res.status(403).json({ error: 'Endast admin' });
    const b = L.readBody(req), mid = parseInt(b.match_id, 10);
    if (!mid) return res.status(400).json({ error: 'match_id saknas' });
    const fx = await L.svc('/rest/v1/fixtures?select=id,opp,played_on,kickoff&id=eq.' + mid);
    const f = fx.ok && fx.body && fx.body[0];
    if (!f) return res.status(404).json({ error: 'Matchen finns inte längre (redan spelad?)' });
    const [cl, pr, pf] = await Promise.all([
      L.svc('/rest/v1/match_calls?select=id,player_id,status,reminder_count,invited_at&player_id=not.is.null&match_id=eq.' + mid),
      L.svc('/rest/v1/player_profiles?select=user_id,player_id,full_name,active'),
      L.svc('/rest/v1/notification_preferences?select=user_id,reminders'),
    ]);
    const want = Array.isArray(b.call_ids) ? b.call_ids.map(Number) : null;
    const prof = {}; (pr.body || []).forEach((p) => { prof[p.player_id] = p; });
    const prefs = {}; (pf.body || []).forEach((p) => { prefs[p.user_id] = p; });
    const targets = (cl.body || []).filter((c) => !c.status && (!want || want.includes(c.id)));
    const users = [], sentCalls = [], skipped = [];
    for (const c of targets) {
      const p = prof[c.player_id];
      if (!p || !p.active) { skipped.push({ name: p ? p.full_name : '#' + c.player_id, why: 'saknar aktiv inlogg' }); continue; }
      if (prefs[p.user_id] && prefs[p.user_id].reminders === false) { skipped.push({ name: p.full_name, why: 'har stängt av påminnelser' }); continue; }
      users.push(p.user_id); sentCalls.push(c);
    }
    let result = { sent: 0 };
    if (users.length) {
      result = await L.pushToUsers(users, 'Matchkallelse 📅', 'Du har en öppen matchkallelse. GT - ' + f.opp + ', ' + L.niceDate(String(f.played_on).slice(0, 10), f.kickoff), L.siteUrl(req) + '/#/kallelser');
      if (result.sent) {
        const now = new Date().toISOString();
        for (const c of sentCalls) await L.svc('/rest/v1/match_calls?id=eq.' + c.id, { method: 'PATCH', body: JSON.stringify({ last_reminder_at: now, reminder_count: (c.reminder_count || 0) + 1, ...(c.invited_at ? {} : { invited_at: now }) }) });
      }
    }
    // Vilka av mottagarna har egentligen push påslaget? (OneSignal tar bort dem som inte har det)
    let noPush = [];
    if (users.length) {
      const st = await L.pushStatus(users);
      noPush = sentCalls.map((c) => ({ c, p: prof[c.player_id] })).filter((x) => ['none', 'off'].includes(st[x.p.user_id])).map((x) => ({ name: x.p.full_name, state: st[x.p.user_id] }));
    }
    return res.status(200).json({ ok: true, sent: result.sent || 0, skipped, noPush, errors: result.errors || [] });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
};
