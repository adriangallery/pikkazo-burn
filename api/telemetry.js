// Cubist Souls — front-end error telemetry sink (fire-and-forget buoy).
//
// The front-end (assets/tele.js) POSTs a tiny JSON blob whenever window.onerror
// or an unhandledrejection fires. We store ONLY what's needed to debug a broken
// page — the error message, the page it happened on, and the User-Agent. NEVER
// any PII: no IP in the stored record, no cookies, no user identifiers. The
// client IP is used solely as an ephemeral rate-limit counter key (never stored),
// exactly like api/govern/vote.js.
//
// Storage (Upstash Redis REST, keys namespaced under cs:tele: — shared DB):
//   LPUSH  cs:tele:log  {"ts":unix,"page":"/x","msg":"...","stack":"...","ua":"..."}
//   LTRIM  cs:tele:log  0 499                 — hard cap at 500 newest entries
//   INCR   cs:tele:rl:<ip>  (TTL 3600s)       — 10 reports/hour/IP; error loops
//                                               must not flood the log
//
// Read the log (Vercel env creds — same UPSTASH_REDIS_REST_* used everywhere):
//   curl -s "$UPSTASH_REDIS_REST_URL" \
//     -H "Authorization: Bearer $UPSTASH_REDIS_REST_TOKEN" \
//     -d '["LRANGE","cs:tele:log","0","49"]'
//
// The endpoint answers 204 on the happy path (fire-and-forget): the browser
// never waits on us and telemetry can never surface an error of its own.

// Credentials are injected by the host (Vercel env); never inline them.
const ENV = process.env;
const RL_MAX = 10;
const RL_WINDOW = 3600;
const LOG_KEY = "cs:tele:log";
const LOG_CAP = 500;

const MAX_MSG = 500;
const MAX_STACK = 2000;
const MAX_PAGE = 300;
const MAX_UA = 512;

// Same-origin allow-list. This endpoint is only ever called by our own pages, so
// we do NOT open CORS to "*": a request that declares a foreign Origin is refused.
// A request with NO Origin header (same-origin navigations often omit it) passes.
const ALLOW_EXACT = new Set([
  "https://cubistsouls.com",
  "https://www.cubistsouls.com",
  "https://cubistsouls.vercel.app",
  "https://pikkazo-burn.vercel.app",
]);
// localhost / 127.0.0.1 on any port, http or https (local dev).
const ALLOW_LOCAL = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

export function originAllowed(origin) {
  if (!origin) return true; // no Origin header → same-origin, allow
  return ALLOW_EXACT.has(origin) || ALLOW_LOCAL.test(origin);
}

// Single-command Upstash REST call (same shape as api/govern/*).
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

// Pure, unit-testable validator. Returns {ok:true,record} or {ok:false,code,error}.
// Oversize msg/stack → 413 (the client is misbehaving). Missing/wrong-typed
// required fields → 400. Everything is sanitised to a fixed shape before storage.
export function validateTele(body) {
  if (!body || typeof body !== "object") return { ok: false, code: 400, error: "bad body" };

  const { page, msg, stack, ua } = body;

  if (typeof page !== "string" || page.length === 0 || page.length > MAX_PAGE)
    return { ok: false, code: 400, error: "bad page" };

  if (typeof msg !== "string" || msg.length === 0)
    return { ok: false, code: 400, error: "bad msg" };
  if (msg.length > MAX_MSG) return { ok: false, code: 413, error: "msg too large" };

  if (stack != null) {
    if (typeof stack !== "string") return { ok: false, code: 400, error: "bad stack" };
    if (stack.length > MAX_STACK) return { ok: false, code: 413, error: "stack too large" };
  }

  // Fixed, PII-free record. ua is truncated (never rejected). ts is server-set.
  const record = {
    ts: Math.floor(Date.now() / 1000),
    page: page,
    msg: msg,
  };
  if (stack) record.stack = stack;
  if (typeof ua === "string" && ua) record.ua = ua.slice(0, MAX_UA);

  return { ok: true, record };
}

export default async function handler(req, res) {
  const origin = req.headers.origin;

  // CORS / preflight — same-origin only.
  if (originAllowed(origin) && origin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "content-type");
  }
  if (req.method === "OPTIONS") {
    return res.status(originAllowed(origin) ? 204 : 403).end();
  }
  if (!originAllowed(origin)) return res.status(403).end();

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST, OPTIONS");
    return res.status(405).end();
  }

  // Storage unconfigured → accept-and-drop. Telemetry must never surface an error.
  if (!ENV.UPSTASH_REDIS_REST_URL || !ENV.UPSTASH_REDIS_REST_TOKEN)
    return res.status(204).end();

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = null; } }

  const v = validateTele(body);
  if (!v.ok) return res.status(v.code).end();

  // Light per-IP rate limit (best-effort). Error loops must not flood the log.
  try {
    const ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "unknown";
    const key = "cs:tele:rl:" + ip;
    const n = await redis(["INCR", key]);
    if (n === 1) await redis(["EXPIRE", key, RL_WINDOW]);
    if (n > RL_MAX) return res.status(429).end();
  } catch { /* rate-limit failure must not drop a report */ }

  // Store + cap. Any failure is swallowed — the browser never learns.
  try {
    await redis(["LPUSH", LOG_KEY, JSON.stringify(v.record)]);
    await redis(["LTRIM", LOG_KEY, 0, LOG_CAP - 1]);
  } catch { /* fire-and-forget */ }

  res.setHeader("Cache-Control", "no-store");
  return res.status(204).end();
}
