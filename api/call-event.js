// Vercel-funktion: /api/call-event  (inloggad spelare)
// Anropas av appen efter att en spelare svarat på en kallelse. Notifierar de som valt att få
// "när spelare anmäler sig / ändrar svar / lämnar återbud". Texten byggs i _callevent.js från databasen.
// Svar upp till 3 timmar gamla accepteras (appen försöker igen om nätet svek) men varje svar notifieras bara en gång.
const L = require('./_lib');
const CE = require('./_callevent');

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
    const pr = await L.svc('/rest/v1/player_profiles?select=player_id&user_id=eq.' + L.q(me.id));
    const prof = pr.ok && pr.body && pr.body[0];
    if (!prof) return res.status(403).json({ error: 'Endast spelare med konto' });
    const out = await CE.notifyCallEvent({ matchId, playerId: prof.player_id, site: L.siteUrl(req) });
    return res.status(out.error ? 500 : 200).json(out);
  } catch (e) {
    return res.status(500).json({ error: String((e && e.message) || e) });
  }
};
