// Cubist Souls Govern — vote intake (dumb mailbox).
//
// The server does NOT verify signatures (no crypto deps here). It only stores
// signed ballots. The TALLY is done 100% client-side by the govern page and by
// any auditor: a ballot whose signature doesn't recover to `address` simply
// doesn't count. So the worst a malicious POST can do is store junk that the
// tally throws away. This keeps the server a thin, auditable buoy.
//
// CANONICAL MESSAGE the voter signs (EIP-191 personal_sign) — EXACT format,
// "\n" line separators, address lowercased:
//
//   Cubist Souls Govern
//   Proposal: <id>
//   Choice: <optionIndex>
//   Snapshot: <snapshotBlock>
//   Voter: <address lowercase>
//
// Storage (Upstash Redis REST, keys namespaced under cs:gov: — shared DB):
//   HSET cs:gov:votes:<proposalId> <address_lowercase> {"choice":n,"sig":"0x..","ts":unix}
//   INCR cs:gov:rl:<ip>  (TTL 3600s)  — light anti-spam, 20 votes/hour/IP
//
// Re-voting before close overwrites the address's field (HSET), so one wallet =
// one live ballot per proposal.

// Credentials are injected by the host (Vercel env); never inline them.
const ENV = process.env;
const RL_MAX = 20;
const RL_WINDOW = 3600;

// Single-command Upstash REST call. Body form handles arbitrary values safely.
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

async function loadProposals(req) {
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  const proto = (req.headers["x-forwarded-proto"] || "https").split(",")[0];
  const r = await fetch(`${proto}://${host}/govern/proposals.json`, { signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error("proposals " + r.status);
  return r.json();
}

// Pure, unit-testable validator. Returns {ok:true,...} or {ok:false,code,error}.
export function validateVote(body, proposals, nowMs) {
  if (!body || typeof body !== "object") return { ok: false, code: 400, error: "bad body" };
  const { proposalId, choice, address, sig } = body;

  if (typeof proposalId !== "string" || proposalId.length > 64)
    return { ok: false, code: 400, error: "bad proposalId" };
  const prop = proposals.find(p => p.id === proposalId);
  if (!prop) return { ok: false, code: 404, error: "unknown proposal" };

  const c = Number(choice);
  if (!Number.isInteger(c) || c < 0 || c >= prop.options.length)
    return { ok: false, code: 400, error: "choice out of range" };

  if (typeof address !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(address))
    return { ok: false, code: 400, error: "bad address" };

  // 65-byte secp256k1 signature = 132 hex chars incl. 0x.
  if (typeof sig !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(sig))
    return { ok: false, code: 400, error: "bad signature" };

  if (nowMs >= Date.parse(prop.closesAt))
    return { ok: false, code: 409, error: "voting closed" };

  return { ok: true, proposalId, address: address.toLowerCase(), choice: c };
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  if (!ENV.UPSTASH_REDIS_REST_URL || !ENV.UPSTASH_REDIS_REST_TOKEN)
    return res.status(500).json({ error: "storage not configured" });

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = null; } }

  let proposals;
  try { proposals = await loadProposals(req); }
  catch { return res.status(502).json({ error: "proposals unavailable" }); }

  const v = validateVote(body, proposals, Date.now());
  if (!v.ok) return res.status(v.code).json({ error: v.error });

  // light per-IP rate limit (best-effort; never blocks a legit single vote)
  try {
    const ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "unknown";
    const key = "cs:gov:rl:" + ip;
    const n = await redis(["INCR", key]);
    if (n === 1) await redis(["EXPIRE", key, RL_WINDOW]);
    if (n > RL_MAX) return res.status(429).json({ error: "rate limited" });
  } catch { /* rate-limit failure must not drop a vote */ }

  try {
    const value = JSON.stringify({ choice: v.choice, sig: body.sig, ts: Math.floor(Date.now() / 1000) });
    await redis(["HSET", "cs:gov:votes:" + v.proposalId, v.address, value]);
  } catch {
    return res.status(502).json({ error: "store failed" });
  }

  res.setHeader("Cache-Control", "no-store");
  return res.status(200).json({ ok: true });
}
