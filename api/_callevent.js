// Gemensam logik för "spelare anmäler sig / ändrar svar / lämnar återbud"-notiser.
// Används av /api/call-event (direkt från appen) och av /api/cron (säkerhetsnät om appen aldrig hann skicka).
// Dubblettskydd: varje svar (match + spelare + svarstid) loggas i push_log (kind='call') och notifieras bara en gång.
const L = require('./_lib');

// 'claimed' = vi vann och ska skicka, 'dup' = redan skickat, 'na' = kunde inte logga (t.ex. push_log nekar kind='call')
async function claim(ref) {
  const r = await L.svc('/rest/v1/push_log', { method: 'POST', body: JSON.stringify({ kind: 'call', ref }) });
  if (r.ok) return 'claimed';
  if (r.status === 409 || (r.body && r.body.code === '23505')) return 'dup';
  return 'na';
}
const release = (ref) => L.svc('/rest/v1/push_log?kind=eq.call&ref=eq.' + L.q(ref), { method: 'DELETE' });

// opts: { matchId, playerId, site, maxAgeMs, requireClaim }
async function notifyCallEvent(opts) {
  const { matchId, playerId, site, maxAgeMs = 3 * 3600e3, requireClaim = false } = opts;
  const [pr, cr, fx] = await Promise.all([
    L.svc('/rest/v1/player_profiles?select=user_id,player_id,full_name&player_id=eq.' + playerId),
    L.svc('/rest/v1/match_calls?select=status,prev_status,comment,responded_at&match_id=eq.' + matchId + '&player_id=eq.' + playerId),
    L.svc('/rest/v1/fixtures?select=id,opp,played_on,kickoff&id=eq.' + matchId),
  ]);
  const prof = pr.ok && pr.body && pr.body[0], call = cr.ok && cr.body && cr.body[0], f = fx.ok && fx.body && fx.body[0];
  if (!prof || !call || !call.status || !f) return { skipped: true, reason: 'Kallelsen hittades inte' };
  if (!call.responded_at) return { skipped: true, reason: 'Inget nytt svar' };
  const age = Date.now() - Date.parse(call.responded_at);
  if (age > maxAgeMs) return { skipped: true, reason: 'För gammalt svar' };
  if (call.prev_status === call.status) return { skipped: true, reason: 'Oförändrat svar' };

  const ref = matchId + ':' + playerId + ':' + call.responded_at;
  const c = await claim(ref);
  if (c === 'dup') return { skipped: true, reason: 'Redan notifierad' };
  if (c === 'na') {
    if (requireClaim) return { skipped: true, error: "push_log accepterar inte kind='call' – kan inte skydda mot dubbletter" };
    if (age > 60e3) return { skipped: true, reason: 'Inget nytt svar' }; // äldre skydd: bara helt färska svar när vi inte kan logga
  }

  // yes = anmälan (även om man tidigare sagt nej/avvaktar), no = återbud, avvaktar = ändrat svar
  const key = call.status === 'no' ? 'cancels' : call.status === 'yes' ? 'joins' : 'changes';
  const SV = { yes: '✅ kommer', no: '❌ kommer inte', maybe: '🤔 avvaktar' };
  const heading = key === 'cancels' ? 'Återbud ❌' : key === 'joins' ? 'Anmälan ✅' : 'Ändrat svar 🔄';
  const dateTxt = 'GT - ' + f.opp + ', ' + L.niceDate(String(f.played_on).slice(0, 10), f.kickoff);
  let msg = prof.full_name + ' ' + SV[call.status] + (call.prev_status && SV[call.prev_status] ? ' (var: ' + SV[call.prev_status].replace(/^\S+\s/, '') + ')' : '');
  if (call.comment) msg += ' – ' + call.comment;
  msg += '. ' + dateTxt;

  const [pf, nr, pp] = await Promise.all([
    L.svc('/rest/v1/notification_preferences?select=user_id,' + key),
    L.svc('/rest/v1/match_calls?select=player_id&match_id=eq.' + matchId + '&status=eq.no&player_id=not.is.null'),
    L.svc('/rest/v1/player_profiles?select=user_id,player_id'),
  ]);
  const on = new Set((pf.body || []).filter((p) => p[key] === true).map((p) => p.user_id));
  const declined = new Set(((nr.ok && nr.body) || []).map((x) => x.player_id));
  const optedOut = new Set(((pp.ok && pp.body) || []).filter((p) => declined.has(p.player_id)).map((p) => p.user_id));
  const to = [...on].filter((u) => u !== prof.user_id && !optedOut.has(u));
  const r = to.length ? await L.pushToUsers(to, heading, msg, site + '/#/m/' + matchId) : { sent: 0, note: 'inga mottagare' };
  console.log('call-event', key, 'match', matchId, 'spelare', playerId, 'valt:', on.size, 'mottagare:', to.length, 'skickat:', r.sent, JSON.stringify(r.errors || []));
  if (to.length && !r.sent && c === 'claimed') await release(ref); // inget gick iväg: tillåt nytt försök
  return { ok: true, kind: key, optedIn: on.size, declinedMatch: [...on].filter((u) => optedOut.has(u)).length, recipients: to.length, result: r };
}

module.exports = { notifyCallEvent };
