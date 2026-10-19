// Vercel-funktion: /api/admin-users  (endast admin)
// Skapar och hanterar spelarinloggningar. Använder Supabase service role, som bara finns som miljövariabel i Vercel.
const L = require('./_lib');

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Använd POST' });
  try {
    const miss = L.missing(['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY']);
    if (miss.length) return res.status(500).json({ error: 'Miljövariabler saknas i Vercel: ' + miss.join(', ') });
    const token = L.bearer(req);
    const me = await L.getUser(token);
    if (!me) return res.status(401).json({ error: 'Inte inloggad' });
    if (!(await L.isAdmin(token))) return res.status(403).json({ error: 'Endast admin' });

    const b = L.readBody(req), act = b.action;
    const profile = async (user_id) => {
      const r = await L.svc('/rest/v1/player_profiles?select=*&user_id=eq.' + L.q(user_id));
      return r.ok && r.body && r.body[0];
    };
    const adminEmails = async () => {
      const r = await L.svc('/rest/v1/admins?select=email');
      return r.ok && Array.isArray(r.body) ? r.body.map((x) => String(x.email).toLowerCase()) : [];
    };
    const setAdmin = async (email, on) => {
      email = String(email).toLowerCase();
      const cur = await adminEmails();
      if (on && !cur.includes(email)) {
        const r = await L.svc('/rest/v1/admins', { method: 'POST', body: JSON.stringify({ email }) });
        if (!r.ok) throw new Error('admins: ' + JSON.stringify(r.body));
      }
      if (!on && cur.includes(email)) {
        if (cur.length <= 1) throw new Error('Det måste finnas minst en admin.');
        if (email === String(me.email).toLowerCase()) throw new Error('Du kan inte ta bort din egen adminroll.');
        const r = await L.svc('/rest/v1/admins?email=eq.' + L.q(email), { method: 'DELETE' });
        if (!r.ok) throw new Error('admins: ' + JSON.stringify(r.body));
      }
    };

    if (act === 'list') {
      const [p, a, u] = await Promise.all([
        L.svc('/rest/v1/player_profiles?select=*&order=full_name'),
        adminEmails(),
        L.authAdmin('/users?per_page=1000'),
      ]);
      const last = {};
      const users = u.ok && u.body && (u.body.users || u.body);
      (Array.isArray(users) ? users : []).forEach((x) => { last[x.id] = x.last_sign_in_at || null; });
      return res.status(200).json({
        profiles: (p.body || []).map((x) => ({ ...x, is_admin: a.includes(String(x.email).toLowerCase()), last_sign_in_at: last[x.user_id] || null })),
        admins: a,
      });
    }

    if (act === 'create') {
      const email = String(b.email || '').trim().toLowerCase(), password = String(b.password || '');
      if (!EMAIL.test(email)) return res.status(400).json({ error: 'Ogiltig e-postadress' });
      if (password.length < 8) return res.status(400).json({ error: 'Lösenordet måste vara minst 8 tecken' });
      const pr = await L.svc('/rest/v1/players?select=id,name,no,pos&id=eq.' + L.q(parseInt(b.player_id, 10)));
      const player = pr.ok && pr.body && pr.body[0];
      if (!player) return res.status(404).json({ error: 'Spelaren hittades inte' });
      const ex = await L.svc('/rest/v1/player_profiles?select=user_id&player_id=eq.' + player.id);
      if (ex.ok && ex.body && ex.body.length) return res.status(409).json({ error: 'Spelaren har redan en inloggning' });
      const cu = await L.authAdmin('/users', { method: 'POST', body: JSON.stringify({ email, password, email_confirm: true }) });
      if (!cu.ok) return res.status(400).json({ error: (/already|registered|exists/i.test(JSON.stringify(cu.body)) ? 'E-posten har redan ett konto – använd "Koppla befintligt konto" i stället. ' : '') + 'Kunde inte skapa användaren: ' + ((cu.body && (cu.body.msg || cu.body.message || cu.body.error_description)) || cu.status) });
      const uid = cu.body.id;
      const ins = await L.svc('/rest/v1/player_profiles', { method: 'POST', body: JSON.stringify({ user_id: uid, player_id: player.id, full_name: player.name, email, shirt_no: player.no || '', position: player.pos || '' }) });
      if (!ins.ok) {
        await L.authAdmin('/users/' + uid, { method: 'DELETE' }); // ångra
        return res.status(500).json({ error: 'Profilen kunde inte skapas: ' + JSON.stringify(ins.body) });
      }
      if (b.make_admin) await setAdmin(email, true);
      return res.status(200).json({ ok: true, user_id: uid });
    }

    if (act === 'link') {
      // Koppla ett BEFINTLIGT konto (t.ex. adminens eget) till en spelare, utan nytt konto/ny e-post.
      const pr = await L.svc('/rest/v1/players?select=id,name,no,pos&id=eq.' + L.q(parseInt(b.player_id, 10)));
      const player = pr.ok && pr.body && pr.body[0];
      if (!player) return res.status(404).json({ error: 'Spelaren hittades inte' });
      let target = { id: me.id, email: me.email };
      if (b.email && String(b.email).toLowerCase() !== String(me.email).toLowerCase()) {
        const u = await L.authAdmin('/users?per_page=1000');
        const list = u.ok && u.body && (u.body.users || u.body);
        const f = (Array.isArray(list) ? list : []).find((x) => String(x.email).toLowerCase() === String(b.email).toLowerCase());
        if (!f) return res.status(404).json({ error: 'Ingen användare med den e-posten' });
        target = { id: f.id, email: f.email };
      }
      const [e1, e2] = await Promise.all([L.svc('/rest/v1/player_profiles?select=user_id&player_id=eq.' + player.id), L.svc('/rest/v1/player_profiles?select=user_id&user_id=eq.' + L.q(target.id))]);
      if ((e1.body && e1.body.length) || (e2.body && e2.body.length)) return res.status(409).json({ error: 'Spelaren eller kontot är redan kopplat' });
      const ins = await L.svc('/rest/v1/player_profiles', { method: 'POST', body: JSON.stringify({ user_id: target.id, player_id: player.id, full_name: player.name, email: String(target.email).toLowerCase(), shirt_no: player.no || '', position: player.pos || '' }) });
      if (!ins.ok) return res.status(500).json({ error: 'Kunde inte koppla: ' + JSON.stringify(ins.body) });
      return res.status(200).json({ ok: true, user_id: target.id });
    }

    const uid = String(b.user_id || '');
    if (!uid) return res.status(400).json({ error: 'user_id saknas' });
    const prof = await profile(uid);
    if (!prof) return res.status(404).json({ error: 'Inloggningen hittades inte' });

    if (act === 'reset') {
      const password = String(b.password || '');
      if (password.length < 8) return res.status(400).json({ error: 'Lösenordet måste vara minst 8 tecken' });
      const r = await L.authAdmin('/users/' + uid, { method: 'PUT', body: JSON.stringify({ password }) });
      if (!r.ok) return res.status(400).json({ error: 'Kunde inte byta lösenord: ' + JSON.stringify(r.body) });
      return res.status(200).json({ ok: true });
    }
    if (act === 'email') {
      const email = String(b.email || '').trim().toLowerCase();
      if (!EMAIL.test(email)) return res.status(400).json({ error: 'Ogiltig e-postadress' });
      const was = await adminEmails();
      const r = await L.authAdmin('/users/' + uid, { method: 'PUT', body: JSON.stringify({ email, email_confirm: true }) });
      if (!r.ok) return res.status(400).json({ error: 'Kunde inte byta e-post: ' + JSON.stringify(r.body) });
      await L.svc('/rest/v1/player_profiles?user_id=eq.' + L.q(uid), { method: 'PATCH', body: JSON.stringify({ email }) });
      if (was.includes(String(prof.email).toLowerCase())) { await setAdmin(email, true); await L.svc('/rest/v1/admins?email=eq.' + L.q(String(prof.email).toLowerCase()), { method: 'DELETE' }); }
      return res.status(200).json({ ok: true });
    }
    if (act === 'setactive') {
      const r = await L.svc('/rest/v1/player_profiles?user_id=eq.' + L.q(uid), { method: 'PATCH', body: JSON.stringify({ active: !!b.active }) });
      if (!r.ok) return res.status(500).json({ error: JSON.stringify(r.body) });
      return res.status(200).json({ ok: true });
    }
    if (act === 'setadmin') {
      await setAdmin(prof.email, !!b.admin);
      return res.status(200).json({ ok: true });
    }
    if (act === 'delete') {
      if (uid === me.id) return res.status(400).json({ error: 'Du kan inte ta bort din egen inloggning.' });
      await setAdmin(prof.email, false).catch(() => {});
      const r = await L.authAdmin('/users/' + uid, { method: 'DELETE' }); // profil och notisinställningar tas bort via on delete cascade
      if (!r.ok) return res.status(500).json({ error: 'Kunde inte ta bort: ' + JSON.stringify(r.body) });
      return res.status(200).json({ ok: true });
    }
    return res.status(400).json({ error: 'Okänd åtgärd' });
  } catch (e) {
    return res.status(500).json({ error: String((e && e.message) || e) });
  }
};
