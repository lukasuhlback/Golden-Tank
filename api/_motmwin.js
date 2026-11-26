// Matchens lirare: när röstningen stängt (kl 00:00 svensk tid) får den/de som utsetts en notis.
// Skickas till alla som utsetts, oavsett notisinställningar. Trycker man på notisen öppnas matchsidan.
// Körs av /api/cron (var 15:e minut): röstningar som stängde de senaste 3 timmarna och ännu inte notifierats.
// Dubblettskydd: push_log (kind='motm', ref=match_id). Ett resultat notifieras högst en gång.
const L = require('./_lib');

const ORD = { 3: 'Tredje', 4: 'Fjärde', 5: 'Femte', 6: 'Sjätte', 7: 'Sjunde', 8: 'Åttonde', 9: 'Nionde', 10: 'Tionde' };
const ord = (n) => ORD[n] || n + ':e';
const first = (s) => String(s || '').trim().split(/\s+/)[0] || '';

// Vinnare ur motm_results-rader för en match (samma regel som appen: minst 4 röster, flest röster vinner, lika = delat)
function winnersOf(rows) {
  if (!rows || !rows.length || !(Number(rows[0].total) > 3)) return [];
  const mx = Math.max(...rows.map((r) => Number(r.votes)));
  return rows.filter((r) => Number(r.votes) === mx).map((r) => r.player_id);
}

// Hur många röstningar i rad (senaste först, hoppar över röstningar utan giltig vinnare) spelaren utsetts i
async function streakOf(playerId, closesAt) {
  const po = await L.svc('/rest/v1/motm_polls?select=match_id,closes_at&closes_at=lte.' + L.q(closesAt) + '&order=closes_at.desc&limit=12');
  const polls = (po.ok && po.body) || [];
  if (!polls.length) return 0;
  const rs = await L.svc('/rest/v1/motm_results?select=match_id,player_id,votes,total&match_id=in.(' + polls.map((p) => p.match_id).join(',') + ')');
  const rows = (rs.ok && rs.body) || [];
  let n = 0;
  for (const p of polls) {
    const w = winnersOf(rows.filter((r) => String(r.match_id) === String(p.match_id)));
    if (!w.length) continue;
    if (w.includes(playerId)) n++; else break;
  }
  return n;
}

function buildMessage(name, others, opp, streak) {
  const f = first(name), vs = opp ? ' mot ' + opp : '';
  const heading = streak >= 3 ? 'Matchens lirare igen! 🔥' : 'Du är matchens lirare! 🏅';
  const lead = streak >= 3 ? ord(streak) + ' matchen i rad, ' + f + '! ' : 'Grattis ' + f + '! ';
  let body;
  if (others.length) {
    const list = others.length === 1 ? others[0] : others.slice(0, -1).join(', ') + ' och ' + others[others.length - 1];
    body = 'Du delar utmärkelsen med ' + list + ' efter matchen' + vs + '.';
  } else {
    body = streak >= 3 ? 'Du blev vald' + vs + '.' : 'Du blev vald till matchens lirare' + vs + '.';
  }
  return { heading, message: lead + body };
}

async function motmWinnersRun(nowMs, dry, site) {
  const out = [];
  const from = new Date(nowMs - 3 * 3600e3).toISOString(), to = new Date(nowMs).toISOString();
  const po = await L.svc('/rest/v1/motm_polls?select=match_id,closes_at&closes_at=gte.' + L.q(from) + '&closes_at=lte.' + L.q(to));
  if (!po.ok) return [{ error: 'motm_polls kunde inte läsas' }];
  for (const p of po.body || []) {
    const mid = p.match_id;
    const rr = await L.svc('/rest/v1/motm_results?select=player_id,votes,total&match_id=eq.' + mid);
    const win = winnersOf((rr.ok && rr.body) || []);
    if (!win.length) { out.push({ match: mid, skipped: 'för få röster eller inga resultat' }); continue; }
    if (dry) { out.push({ match: mid, dry: true, winners: win }); continue; }
    const cl = await L.svc('/rest/v1/push_log', { method: 'POST', body: JSON.stringify({ kind: 'motm', ref: String(mid) }) });
    if (!cl.ok) {
      if (cl.status === 409 || (cl.body && cl.body.code === '23505')) continue; // redan notifierad
      out.push({ match: mid, error: 'push_log: ' + JSON.stringify(cl.body) });
      continue;
    }
    const inList = win.join(',');
    const [fx, mt, pr, pl] = await Promise.all([
      L.svc('/rest/v1/fixtures?select=id,opp&id=eq.' + mid),
      L.svc('/rest/v1/matches?select=id,opp&id=eq.' + mid),
      L.svc('/rest/v1/player_profiles?select=user_id,player_id,full_name&player_id=in.(' + inList + ')'),
      L.svc('/rest/v1/players?select=id,name&id=in.(' + inList + ')'),
    ]);
    const opp = ((fx.ok && fx.body && fx.body[0]) || (mt.ok && mt.body && mt.body[0]) || {}).opp || '';
    const name = {}; ((pl.ok && pl.body) || []).forEach((x) => { name[x.id] = x.name; });
    const acct = {}; ((pr.ok && pr.body) || []).forEach((x) => { acct[x.player_id] = x; if (x.full_name) name[x.player_id] = x.full_name; });
    const res = [];
    for (const id of win) {
      if (!acct[id] || !acct[id].user_id) { res.push({ player: id, skipped: 'saknar konto' }); continue; }
      const others = win.filter((x) => x !== id).map((x) => first(name[x]) || 'en annan spelare');
      const streak = await streakOf(id, p.closes_at);
      const m = buildMessage(name[id], others, opp, streak);
      const r = await L.pushToUsers([acct[id].user_id], m.heading, m.message, site + '/#/m/' + mid);
      console.log('motm-vinnare', 'match', mid, 'spelare', id, 'serie', streak, 'skickat', r.sent, JSON.stringify(r.errors || []));
      res.push({ player: id, message: m.message, sent: r.sent, errors: r.errors || [] });
    }
    out.push({ match: mid, winners: res });
  }
  return out;
}

module.exports = { motmWinnersRun, winnersOf, buildMessage };
