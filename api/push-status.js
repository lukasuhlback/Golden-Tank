// Vercel-funktion: /api/push-status  (endast admin)
// Visar vilka spelare som har push-notiser påslagna (enligt OneSignal). Resultat per spelare: on | off | none | unknown.
const L = require('./_lib');

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Använd POST' });
  try {
    const miss = L.missing(['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'ONESIGNAL_APP_ID', 'ONESIGNAL_REST_API_KEY']);
    if (miss.length) return res.status(500).json({ error: 'Miljövariabler saknas i Vercel: ' + miss.join(', ') });
    const token = L.bearer(req);
    if (!token || !(await L.isAdmin(token))) return res.status(403).json({ error: 'Endast admin' });
    const pr = await L.svc('/rest/v1/player_profiles?select=user_id,player_id,active');
    const rows = (pr.body || []).filter((p) => p.active);
    const st = await L.pushStatus(rows.map((p) => p.user_id));
    const byPlayer = {};
    rows.forEach((p) => { byPlayer[p.player_id] = st[p.user_id] || 'unknown'; });
    return res.status(200).json({ ok: true, byPlayer });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
};
