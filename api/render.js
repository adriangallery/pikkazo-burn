// Server-side compositor for the Soul Builder.
//   /api/render?combo=<hex16>
// Composes the 8 recovered trait plates (in zOrder) into a single 768x768 PNG.
// Used for OG/share images and as the canonical renderer for any future
// on-chain "Dress your Soul" combo. Output is immutable per-combo → cache hard.
import sharp from "sharp";

const RAW = "https://raw.githubusercontent.com/adriangallery/cubist-souls-assets/main";
const MANIFEST_URL = RAW + "/manifest.json";
const SIZE = 768;
const INK = { r: 11, g: 9, b: 8, alpha: 1 }; // --ink

export const config = { maxDuration: 60 };

// Cache the manifest in warm-instance module scope (it's tiny + stable).
let _manifest = null;
async function getManifest() {
  if (_manifest) return _manifest;
  const r = await fetch(MANIFEST_URL, { signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error("manifest " + r.status);
  _manifest = await r.json();
  return _manifest;
}

// combo = 16 hex chars, 1 byte per category in manifest.categories order,
// value = option index. Returns null if malformed or out of bounds.
function decodeCombo(hex, categories) {
  if (typeof hex !== "string") return null;
  hex = hex.trim().toLowerCase();
  if (!/^[0-9a-f]{16}$/.test(hex)) return null;
  const state = {};
  for (let i = 0; i < categories.length; i++) {
    const b = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    const cat = categories[i];
    if (b >= cat.options.length) return null; // reject out-of-bounds
    state[cat.id] = cat.options[b];
  }
  return state;
}

async function fetchLayer(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error(`${url} -> ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

export default async function handler(req, res) {
  let manifest;
  try {
    manifest = await getManifest();
  } catch (e) {
    return res.status(502).json({ error: "manifest unavailable" });
  }

  const { categories, zOrder } = manifest;
  const state = decodeCombo(req.query.combo, categories);
  if (!state) return res.status(400).json({ error: "invalid combo" });

  try {
    // Fetch plates in zOrder (bottom → top).
    const buffers = await Promise.all(
      zOrder.map(id => {
        const cat = categories.find(c => c.id === id);
        return fetchLayer(`${RAW}/${cat.dir}/${state[id].file}`);
      })
    );

    const png = await sharp({
      create: { width: SIZE, height: SIZE, channels: 4, background: INK },
    })
      .composite(buffers.map(input => ({ input, top: 0, left: 0 })))
      .png()
      .toBuffer();

    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "public, max-age=86400, s-maxage=31536000, immutable");
    return res.status(200).send(png);
  } catch (e) {
    return res.status(502).json({ error: "compose failed" });
  }
}
