#!/usr/bin/env node
/**
 * Cubist Souls — telemetry endpoint unit harness (no network, mocked Upstash).
 *
 *   node scripts/tele-test.mjs
 *
 * Exercises api/telemetry.js against a fake Redis (globalThis.fetch stub) and a
 * mock req/res, proving: happy path → 204 + LPUSH/LTRIM, oversize msg/stack →
 * 413, per-IP rate-limit → 429 after 10, bad method → 405, foreign Origin → 403,
 * same-origin CORS header echoed, and that no IP / PII is ever stored.
 */
process.env.UPSTASH_REDIS_REST_URL = "https://fake.upstash.io";
process.env.UPSTASH_REDIS_REST_TOKEN = "fake-token";

// api/telemetry.js is ESM syntax in a non-"type:module" package (Vercel treats
// API files as ESM at build). Load it locally via a data: URL so the real file
// stays untouched and needs no package.json change.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const __dir = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(__dir, "../api/telemetry.js"), "utf8");
const { default: handler, validateTele, originAllowed } =
  await import("data:text/javascript," + encodeURIComponent(src));

const ok = (m) => console.log("  \x1b[32m✓\x1b[0m " + m);
const bad = (m) => { console.log("  \x1b[31m✗\x1b[0m " + m); process.exitCode = 1; };

// ── fake Upstash: record commands, simulate INCR counters ──
let calls = [];
let counters = {};
function installRedis() {
  calls = [];
  counters = {};
  globalThis.fetch = async (_url, opts) => {
    const cmd = JSON.parse(opts.body);
    calls.push(cmd);
    let result = "OK";
    if (cmd[0] === "INCR") { counters[cmd[1]] = (counters[cmd[1]] || 0) + 1; result = counters[cmd[1]]; }
    return { ok: true, json: async () => ({ result }) };
  };
}

function mockRes() {
  const res = { statusCode: null, headers: {}, ended: false, body: undefined };
  res.setHeader = (k, v) => { res.headers[k.toLowerCase()] = v; return res; };
  res.status = (c) => { res.statusCode = c; return res; };
  res.end = (b) => { res.ended = true; res.body = b; return res; };
  res.json = (o) => { res.ended = true; res.body = o; return res; };
  return res;
}

function req({ method = "POST", origin = "https://cubistsouls.com", ip = "1.2.3.4", body } = {}) {
  const headers = {};
  if (origin !== undefined) headers.origin = origin;
  if (ip !== undefined) headers["x-forwarded-for"] = ip;
  return { method, headers, body };
}

const goodBody = { page: "/gallery", msg: "TypeError: x is not a function", stack: "at foo\nat bar", ua: "Mozilla/5.0" };

async function run() {
  console.log("\nCubist Souls telemetry harness\n");

  // 1) pure validator
  {
    const v = validateTele(goodBody);
    v.ok && v.record.page === "/gallery" && v.record.msg === goodBody.msg
      ? ok("validateTele accepts a well-formed report") : bad("validateTele rejected a good report");
    "ip" in v.record ? bad("record contains an IP — PII leak!") : ok("stored record carries NO ip/PII (only ts,page,msg,stack,ua)");

    validateTele({ page: "/x", msg: "a".repeat(501) }).code === 413
      ? ok("oversize msg → 413") : bad("oversize msg not 413");
    validateTele({ page: "/x", msg: "ok", stack: "s".repeat(2001) }).code === 413
      ? ok("oversize stack → 413") : bad("oversize stack not 413");
    validateTele({ msg: "no page" }).code === 400
      ? ok("missing page → 400") : bad("missing page not 400");
    validateTele({ page: "/x" }).code === 400
      ? ok("missing msg → 400") : bad("missing msg not 400");
  }

  // 2) origin allow-list
  originAllowed("https://cubistsouls.com") && originAllowed("http://localhost:3000") &&
    originAllowed(undefined) && !originAllowed("https://evil.example")
    ? ok("originAllowed: site + localhost + no-origin pass, foreign rejected")
    : bad("originAllowed logic wrong");

  // 3) happy path → 204 + LPUSH/LTRIM
  {
    installRedis();
    const res = mockRes();
    await handler(req({ body: goodBody }), res);
    res.statusCode === 204 ? ok("POST valid report → 204") : bad("valid report not 204 (" + res.statusCode + ")");
    const cmds = calls.map((c) => c[0]);
    cmds.includes("LPUSH") && cmds.includes("LTRIM") ? ok("stored via LPUSH + LTRIM cap")
      : bad("did not LPUSH/LTRIM: " + JSON.stringify(cmds));
    const ltrim = calls.find((c) => c[0] === "LTRIM");
    ltrim && ltrim[2] === 0 && ltrim[3] === 499 ? ok("LTRIM caps to 0..499 (500 entries)")
      : bad("LTRIM args wrong: " + JSON.stringify(ltrim));
    const lpush = calls.find((c) => c[0] === "LPUSH");
    const stored = lpush && JSON.parse(lpush[2]);
    stored && !("ip" in stored) && stored.msg === goodBody.msg
      ? ok("LPUSH payload is PII-free and carries the message") : bad("LPUSH payload wrong");
    res.headers["access-control-allow-origin"] === "https://cubistsouls.com"
      ? ok("CORS: echoes same-origin Access-Control-Allow-Origin") : bad("CORS header missing/wrong");
  }

  // 4) oversize msg over the wire → 413
  {
    installRedis();
    const res = mockRes();
    await handler(req({ body: { page: "/x", msg: "a".repeat(501) } }), res);
    res.statusCode === 413 ? ok("oversize msg over HTTP → 413") : bad("oversize over HTTP not 413 (" + res.statusCode + ")");
  }

  // 5) rate limit → 429 after 10 from same IP
  {
    installRedis();
    let last = null;
    for (let i = 0; i < 12; i++) {
      const res = mockRes();
      await handler(req({ body: goodBody, ip: "9.9.9.9" }), res);
      last = res.statusCode;
    }
    last === 429 ? ok("11th+ report from an IP → 429 (loop guard)") : bad("rate limit not enforced (last=" + last + ")");
  }

  // 6) bad method → 405
  {
    installRedis();
    const res = mockRes();
    await handler(req({ method: "GET" }), res);
    res.statusCode === 405 ? ok("GET → 405") : bad("GET not 405 (" + res.statusCode + ")");
  }

  // 7) foreign Origin → 403
  {
    installRedis();
    const res = mockRes();
    await handler(req({ body: goodBody, origin: "https://evil.example" }), res);
    res.statusCode === 403 ? ok("foreign Origin → 403") : bad("foreign Origin not 403 (" + res.statusCode + ")");
  }

  // 8) OPTIONS preflight → 204 same-origin
  {
    installRedis();
    const res = mockRes();
    await handler(req({ method: "OPTIONS" }), res);
    res.statusCode === 204 ? ok("OPTIONS preflight same-origin → 204") : bad("OPTIONS not 204 (" + res.statusCode + ")");
  }

  console.log(process.exitCode ? "\n  SOME CHECKS FAILED\n" : "\n  ALL CHECKS PASSED\n");
}

run().catch((e) => { console.error("FATAL", e); process.exit(1); });
