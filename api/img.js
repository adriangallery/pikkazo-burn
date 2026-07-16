// Image proxy for Cubist Souls / the burn page. Serves the original Pikkazo
// artwork for a token id.
//
// Order: our durable GitHub mirror first (ours, fast, permanent); if the token
// isn't mirrored yet, race the public IPFS gateways so a freshly-burned Soul
// still reveals instantly. Vercel's edge cache serves everything after the
// first hit.
const CID = "QmVgPQtmUBVFK4YqiTQHSFuF1yWcWF3BKGvpXYwFFHfiBm";
const RAW = "https://raw.githubusercontent.com/adriangallery/cubist-souls-assets/main/img";
const GATEWAYS = [
  id => `https://ipfs.io/ipfs/${CID}/${id}`,
  id => `https://gateway.pinata.cloud/ipfs/${CID}/${id}`,
  id => `https://${CID}.ipfs.dweb.link/${id}`,
  id => `https://${CID}.ipfs.w3s.link/${id}`,
  id => `https://4everland.io/ipfs/${CID}/${id}`,
];

export const config = { maxDuration: 60 };

async function fetchFrom(url, timeout) {
  const r = await fetch(url, { signal: AbortSignal.timeout(timeout) });
  if (!r.ok) throw new Error(`${url} -> ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  if (!buf.length) throw new Error("empty body");
  return { buf, type: r.headers.get("content-type") || "image/png" };
}

export default async function handler(req, res) {
  const id = Number(req.query.id);
  if (!Number.isInteger(id) || id < 1 || id > 10000) {
    return res.status(400).json({ error: "bad token id" });
  }

  let out;
  try {
    // Our mirror first.
    out = await fetchFrom(`${RAW}/${id}.png`, 15000);
  } catch {
    try {
      // Not mirrored yet — whichever IPFS gateway answers first wins.
      out = await Promise.any(GATEWAYS.map(gw => fetchFrom(gw(id), 45000)));
    } catch {
      return res.status(502).json({ error: "all sources failed" });
    }
  }

  res.setHeader("Content-Type", out.type);
  res.setHeader("Cache-Control", "public, max-age=86400, s-maxage=31536000, immutable");
  return res.status(200).send(out.buf);
}
