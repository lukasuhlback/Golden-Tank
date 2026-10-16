// Vercel-funktion: delningslänk med förhandsvisning (titel, text och bild) som skickar vidare till matchsidan.
module.exports = (req, res) => {
  const q = req.query || {};
  const esc = (s) => String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const id = /^\d{1,5}$/.test(String(q.m || '')) ? String(q.m) : '';
  const title = esc(String(q.t || 'Golden Tank').slice(0, 120));
  const desc = esc(String(q.d || 'Golden Tank – resultat och statistik').slice(0, 220));
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  const proto = String(req.headers['x-forwarded-proto'] || 'https').split(',')[0].trim();
  const base = proto + '://' + host;
  const dest = id ? base + '/#/m/' + id : base + '/';
  const img = base + '/og-card.png';
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=86400');
  res.status(200).send(
    '<!doctype html><html lang="sv"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
      '<title>' + title + '</title>' +
      '<meta property="og:type" content="website"><meta property="og:site_name" content="Golden Tank">' +
      '<meta property="og:title" content="' + title + '"><meta property="og:description" content="' + desc + '">' +
      '<meta property="og:image" content="' + esc(img) + '"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">' +
      '<meta property="og:url" content="' + esc(dest) + '">' +
      '<meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="' + title + '"><meta name="twitter:description" content="' + desc + '"><meta name="twitter:image" content="' + esc(img) + '">' +
      '<meta http-equiv="refresh" content="0;url=' + esc(dest) + '"></head><body>' +
      '<script>location.replace(' + JSON.stringify(dest).replace(/</g, '\\u003c') + ')</script>' +
      '<a href="' + esc(dest) + '">Öppna matchen</a></body></html>'
  );
};
