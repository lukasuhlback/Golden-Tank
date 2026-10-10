// Vercel-funktion: listar alla bildfiler i mappen Lagloggos så att appen kan matcha lagnamn mot filnamn automatiskt.
const fs = require('fs');
const path = require('path');

module.exports = (req, res) => {
  try {
    const dir = path.join(process.cwd(), 'Lagloggos');
    const files = fs.existsSync(dir)
      ? fs.readdirSync(dir).filter((f) => /\.(png|webp|jpe?g|svg|gif|avif)$/i.test(f)).sort()
      : [];
    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=600');
    res.status(200).json(files);
  } catch (e) {
    res.status(200).json([]);
  }
};
