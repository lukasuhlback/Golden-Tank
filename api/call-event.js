// Vercel-funktion: /api/call-event  (inloggad spelare)
// Anropas av appen efter att en spelare svarat på en kallelse. Notifierar de som valt att få
// "när spelare anmäler sig / ändrar svar / lämnar återbud". Texten byggs här från databasen.
const L = require('./_lib');

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Använd POST' });
  try {
    const miss = L.missing(['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'ONESIGNAL_APP_ID', 'ONESIGNAL_REST_API_KEY']);
    if (miss.length) return res.status(500).json({ error: 'Miljövariabler saknas i Vercel: ' + miss.join(', ') });
    const me = await L.getUser(L.bearer(req));
    if (!me) return res.status(401).json({ error: 'Inte inloggad' });
    const matchId = parseInt(L.readBody(req).match_id, 10);
    if (!matchId) return res.status(400).json({ error: 'match_id saknas' });

    const pr = await L.svc('/rest/v1/player_profiles?select=player_id,full_name&user_id=eq.' + L.q(me.id));
    const prof = pr.ok && pr.body && pr.body[0];
    if (!prof) return res.status(403).json({ error: 'Endast spelare med konto' });
    const [cr, fx] = await Promise.all([
      L.svc('/rest/v1/match_calls?select=status,prev_status,comment,responded_at&match_id=eq.' + matchId + '&player_id=eq.' + prof.player_id),
      L.svc('/rest/v1/fixtures?select=id,opp,played_on,kickoff&id=eq.' + matchId),
    ]);
    const call = cr.ok && cr.body && cr.body[0], f = fx.ok && fx.body && fx.body[0];
    if (!call || !call.status || !f) return res.status(404).json({ error: 'Kallelsen hittades inte' });
    // Skydd mot dubbletter/spam: bara om svaret är färskt (senaste minuten)
    if (!call.responded_at || Date.now() - Date.parse(call.responded_at) > 60e3) return res.status(200).json({ skipped: true, reason: 'Inget nytt svar' });
    if (call.prev_status === call.status) return res.status(200).json({ skipped: true, reason: 'Oförändrat svar' });

    // Vilken sorts händelse? (yes = anmäld, no = återbud, ändring däremellan = ändrat svar)
    const first = !call.prev_status;
    let key;
    if (call.status === 'no') key = 'cancels';
    else if (first) key = call.status === 'yes' ? 'joins' : 'changes';
    else key = 'changes';
    const SV = { yes: '✅ kommer', no: '❌ kommer inte', maybe: '🤔 avvaktar' };
    const name = prof.full_name;
    const heading = key === 'cancels' ? 'Återbud ❌' : key === 'joins' ? 'Anmälan ✅' : 'Ändrat svar 🔄';
    const dateTxt = 'GT - ' + f.opp + ', ' + L.niceDate(String(f.played_on).slice(0, 10), f.kickoff);
    let msg = name + ' ' + SV[call.status] + (key === 'changes' && call.prev_status ? ' (var: ' + SV[call.prev_status].replace(/^\S+\s/, '') + ')' : '');
    if (call.comment) msg += ' – ' + call.comment;
    msg += '. ' + dateTxt;

    const pf = await L.svc('/rest/v1/notification_preferences?select=user_id,' + key);
    const on = new Set((pf.body || []).filter((p) => p[key] === true).map((p) => p.user_id));
    const to = [...on].filter((u) => u !== me.id); // alla som valt denna notis (spelare och admin med inställning)
    const r = await L.pushToUsers(to, heading, msg, L.siteUrl(req) + '/#/m/' + matchId);
    return res.status(200).json({ ok: true, kind: key, recipients: to.length, result: r });
  } catch (e) {
    return res.status(500).json({ error: String((e && e.message) || e) });
  }
};
