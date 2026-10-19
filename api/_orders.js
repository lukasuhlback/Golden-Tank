// Delad logik: meddela admin om nya beställningar från klubbshoppen (push + valfritt mejl).
// Används av /api/shop-order (anropas när en kund beställt) och /api/cron (säkerhetsnät var 15:e minut).
const L = require('./_lib');

async function adminUserIds() {
  const [a, u] = await Promise.all([L.svc('/rest/v1/admins?select=email'), L.authAdmin('/users?per_page=1000')]);
  const emails = new Set((a.body || []).map((x) => String(x.email).toLowerCase()));
  const users = u.ok && u.body && (u.body.users || u.body);
  return (Array.isArray(users) ? users : []).filter((x) => emails.has(String(x.email).toLowerCase())).map((x) => x.id);
}

async function sendMail(subject, text) {
  const key = L.env('RESEND_API_KEY'), to = L.env('ORDER_EMAIL_TO');
  if (!key || !to) return { skipped: true };
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: L.env('ORDER_EMAIL_FROM') || 'Golden Tank <onboarding@resend.dev>', to: to.split(',').map((x) => x.trim()), subject, text }),
  });
  return { ok: r.ok, status: r.status };
}

module.exports = async function notifyNewOrders(site) {
  const r = await L.svc('/rest/v1/shop_orders?select=id,item_name,name,phone,email,extra,created_at&notified_at=is.null&order=id');
  if (!r.ok) return { error: 'shop_orders: ' + JSON.stringify(r.body) + ' (kör 23_kalender_och_bestallningar.sql?)' };
  const claimed = [];
  for (const o of r.body || []) {
    const c = await L.svc('/rest/v1/shop_orders?id=eq.' + o.id + '&notified_at=is.null', { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ notified_at: new Date().toISOString() }) });
    if (c.ok && c.body && c.body.length) claimed.push(o);
  }
  if (!claimed.length) return { claimed: 0 };
  const heading = claimed.length === 1 ? 'Ny beställning 🛒' : claimed.length + ' nya beställningar 🛒';
  const msg = claimed.slice(0, 3).map((o) => o.item_name + ' – ' + o.name).join(', ') + (claimed.length > 3 ? ' m.fl.' : '');
  const out = { claimed: claimed.length };
  let ok = false;
  try { out.push = await L.pushToUsers(await adminUserIds(), heading, msg, site + '/#/admin'); ok = out.push.sent > 0; } catch (e) { out.push = { error: String(e.message || e) }; }
  try {
    out.mail = await sendMail(heading, claimed.map((o) => 'Vara: ' + o.item_name + '\nNamn: ' + o.name + '\nTelefon: ' + o.phone + '\nE-post: ' + o.email + (o.extra ? '\nÖvrigt: ' + o.extra : '') + '\nTid: ' + o.created_at).join('\n\n---\n\n') + '\n\nHantera: ' + site + '/#/admin');
    if (out.mail.ok) ok = true;
  } catch (e) { out.mail = { error: String(e.message || e) }; }
  if (!ok) { // ingen kanal lyckades: försök igen vid nästa körning
    for (const o of claimed) await L.svc('/rest/v1/shop_orders?id=eq.' + o.id, { method: 'PATCH', body: JSON.stringify({ notified_at: null }) });
    out.retry = true;
  }
  return out;
};
