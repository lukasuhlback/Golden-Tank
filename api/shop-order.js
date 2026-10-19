// Vercel-funktion: /api/shop-order
// Anropas av appen direkt efter att en kund skickat en beställning. Funktionen tar inga uppgifter från anropet:
// den kollar bara om det finns beställningar som admin inte meddelats om, och skickar då push (och mejl om RESEND_* är satt).
const L = require('./_lib');
const notify = require('./_orders');

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const miss = L.missing(['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'ONESIGNAL_APP_ID', 'ONESIGNAL_REST_API_KEY']);
    if (miss.length) return res.status(500).json({ error: 'Miljövariabler saknas i Vercel: ' + miss.join(', ') });
    const r = await notify(L.siteUrl(req));
    return res.status(r.error ? 500 : 200).json(r.error ? { error: r.error } : { ok: true, notified: r.claimed || 0 });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
};
