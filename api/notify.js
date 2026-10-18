// Vercel-funktion: /api/notify
// Anropas från adminsidan efter att ett matchresultat rapporterats eller en nyhet publicerats.
// Skickar en pushnotis via OneSignal. REST-nyckeln finns bara som miljövariabel i Vercel.
// Inga npm-beroenden: pratar direkt med Supabase REST (PostgREST) med administratörens egen inloggning,
// så databasens RLS (is_admin) avgör vem som får göra vad.

const SB = () => (process.env.SUPABASE_URL || '').replace(/\/+$/, '');

async function sbFetch(path, token, opts = {}) {
  const r = await fetch(SB() + path, {
    ...opts,
    headers: {
      apikey: process.env.SUPABASE_ANON_KEY,
      Authorization: 'Bearer ' + token,
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
  });
  const text = await r.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch (e) { body = text; }
  return { ok: r.ok, status: r.status, body };
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Använd POST' });
  try {
    for (const k of ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'ONESIGNAL_APP_ID', 'ONESIGNAL_REST_API_KEY']) {
      if (!process.env[k]) return res.status(500).json({ error: 'Miljövariabeln ' + k + ' saknas i Vercel' });
    }
    // 1) Admin-kontroll med användarens egen token (samma regel som RLS: is_admin()).
    const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!token) return res.status(401).json({ error: 'Inte inloggad' });
    const adm = await sbFetch('/rest/v1/rpc/is_admin', token, { method: 'POST', body: '{}' });
    if (!adm.ok || adm.body !== true) return res.status(403).json({ error: 'Endast admin får skicka notiser' });

    // 2) Klienten skickar bara VAD (kind + id). Texten byggs här från databasen.
    const { kind, id } = typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {};
    const site = (process.env.SITE_URL || 'https://' + req.headers.host).replace(/\/+$/, '');
    const q = (v) => encodeURIComponent(v);
    let heading = '', message = '', url = site + '/', ref = '';

    if (kind === 'result') {
      const m = await sbFetch('/rest/v1/matches?select=id,opp,gf,ga,prelim,series&id=eq.' + q(parseInt(id, 10)), token);
      const row = m.ok && m.body && m.body[0];
      if (!row) return res.status(404).json({ error: 'Matchen hittades inte' });
      const s = await sbFetch('/rest/v1/series?select=lab&key=eq.' + q(row.series), token);
      const lab = s.ok && s.body && s.body[0] && s.body[0].lab;
      heading = row.prelim ? 'Preliminärt resultat' : 'Slutresultat';
      message = 'Golden Tank ' + row.gf + '–' + row.ga + ' ' + row.opp + (lab ? ' · ' + lab : '');
      url = site + '/#/m/' + row.id;
      ref = row.id + ':' + (row.prelim ? 'p' : 'f'); // preliminärt och slutligt resultat får vars en notis
    } else if (kind === 'news') {
      const n = await sbFetch('/rest/v1/news?select=id,title,body&id=eq.' + q(parseInt(id, 10)), token);
      const row = n.ok && n.body && n.body[0];
      if (!row) return res.status(404).json({ error: 'Nyheten hittades inte' });
      heading = 'Nyhet från Golden Tank';
      message = String(row.title || (row.body || '').slice(0, 120) || 'Ny nyhet i appen').slice(0, 140);
      ref = String(row.id);
    } else {
      return res.status(400).json({ error: 'Okänd typ' });
    }

    // 3) Skydd mot dubbletter: samma match/nyhet notifieras bara en gång (unik nyckel i push_log).
    const ins = await sbFetch('/rest/v1/push_log', token, { method: 'POST', body: JSON.stringify({ kind, ref }) });
    if (!ins.ok) {
      if (ins.status === 409 || (ins.body && ins.body.code === '23505')) return res.status(200).json({ skipped: true, reason: 'Notis redan skickad' });
      return res.status(500).json({ error: 'push_log: ' + JSON.stringify(ins.body) });
    }

    // 4) Skicka via OneSignal REST API.
    const r = await fetch('https://api.onesignal.com/notifications?c=push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Key ' + process.env.ONESIGNAL_REST_API_KEY },
      body: JSON.stringify({
        app_id: process.env.ONESIGNAL_APP_ID,
        target_channel: 'push',
        included_segments: ['Subscribed Users'],
        headings: { en: heading, sv: heading },
        contents: { en: message, sv: message },
        url,
      }),
    });
    const out = await r.json().catch(() => ({}));
    if (!r.ok || out.errors) {
      await sbFetch('/rest/v1/push_log?kind=eq.' + q(kind) + '&ref=eq.' + q(ref), token, { method: 'DELETE' }); // så att man kan försöka igen
      return res.status(502).json({ error: 'OneSignal: ' + JSON.stringify(out.errors || out) });
    }
    return res.status(200).json({ sent: true, id: out.id, recipients: out.recipients == null ? null : out.recipients });
  } catch (e) {
    return res.status(500).json({ error: String(e && e.message || e) });
  }
};
