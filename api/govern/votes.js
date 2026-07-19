// Cubist Souls Govern — public vote reader.
//   GET /api/govern/votes?id=<proposalId>
// Returns the raw ballot box for a proposal as flat JSON:
//   { "<address_lowercase>": { "choice": n, "sig": "0x..", "ts": unix }, ... }
// This is the exact data the tally verifies — published so anyone can reproduce
// the count. Signatures are NOT filtered here; verification is the auditor's job.

const ENV = process.env;

async function redis(cmd) {
  const r = await fetch(ENV.UPSTASH_REDIS_REST_URL, {
    method: "POST",
    headers: { Authorization: "Bearer " + ENV.UPSTASH_REDIS_REST_TOKEN, "content-type": "application/json" },
    body: JSON.stringify(cmd),
  });
  if (!r.ok) throw new Error("redis " + r.status);
  const j = await r.json();
  if (j.error) throw new Error("redis: " + j.error);
  return j.result;
}

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "GET only" });
  if (!ENV.UPSTASH_REDIS_REST_URL || !ENV.UPSTASH_REDIS_REST_TOKEN)
    return res.status(500).json({ error: "storage not configured" });

  const id = String(req.query.id || "");
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id)) return res.status(400).json({ error: "bad id" });

  let flat;
  try {
    // HGETALL returns [field, value, field, value, ...] over the REST API.
    flat = await redis(["HGETALL", "cs:gov:votes:" + id]);
  } catch {
    return res.status(502).json({ error: "read failed" });
  }

  const out = {};
  if (Array.isArray(flat)) {
    for (let i = 0; i + 1 < flat.length; i += 2) {
      try { out[flat[i]] = JSON.parse(flat[i + 1]); }
      catch { /* skip malformed entry */ }
    }
  }

  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "public, max-age=0, s-maxage=10, stale-while-revalidate=30");
  return res.status(200).json({ id, votes: out });
}
