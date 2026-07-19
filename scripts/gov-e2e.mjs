#!/usr/bin/env node
/**
 * Cubist Souls Govern — end-to-end ballot test.
 *
 * Signs the canonical vote message with a throwaway wallet, casts it against a
 * running deployment, reads it back, and proves the tally's verification both
 * ACCEPTS a good signature and REJECTS a corrupted one.
 *
 *   BASE_URL=https://cubistsouls.com  node scripts/gov-e2e.mjs
 *   BASE_URL=https://cubistsouls.com  PROPOSAL_ID=prop-000  node scripts/gov-e2e.mjs
 *
 * Without BASE_URL it runs OFFLINE: sign+verify roundtrip only (no HTTP), so it
 * still proves the canonical message and the accept/reject logic. The orchestrator
 * runs it WITH BASE_URL against prod for the full POST → GET → verify path.
 *
 * The canonical message MUST match api/govern/vote.js and govMessage() in
 * govern-x9v4k2.html byte-for-byte.
 */
import { ethers } from "ethers";

const BASE_URL = process.env.BASE_URL || "";
const PROPOSAL_ID = process.env.PROPOSAL_ID || "prop-000";

function canonical(id, choice, snapshotBlock, address) {
  return "Cubist Souls Govern\n" +
         "Proposal: " + id + "\n" +
         "Choice: " + choice + "\n" +
         "Snapshot: " + snapshotBlock + "\n" +
         "Voter: " + address.toLowerCase();
}

const ok = m => console.log("  \x1b[32m✓\x1b[0m " + m);
const bad = m => { console.log("  \x1b[31m✗\x1b[0m " + m); process.exitCode = 1; };
const info = m => console.log("  · " + m);

async function getProposal() {
  if (!BASE_URL) {
    // offline default: mirror govern/proposals.json prop-000 shape
    return { id: PROPOSAL_ID, snapshotBlock: 25566780, options: ["a", "b", "c"], closesAt: "2999-01-01T00:00:00.000Z" };
  }
  const r = await fetch(`${BASE_URL}/govern/proposals.json`, { cache: "no-store" });
  if (!r.ok) throw new Error(`proposals.json → ${r.status}`);
  const list = await r.json();
  const p = list.find(x => x.id === PROPOSAL_ID) || list[0];
  if (!p) throw new Error("no proposals found");
  return p;
}

async function main() {
  console.log(`\nCubist Souls Govern e2e — ${BASE_URL ? "LIVE against " + BASE_URL : "OFFLINE (sign+verify only)"}\n`);

  const wallet = ethers.Wallet.createRandom();
  const addr = wallet.address.toLowerCase();
  const prop = await getProposal();
  const choice = 0;
  info(`throwaway wallet: ${addr}`);
  info(`proposal: ${prop.id}  ·  snapshot block: ${prop.snapshotBlock}  ·  choice: ${choice}`);

  // ── 1) sign the canonical message ──
  const msg = canonical(prop.id, choice, prop.snapshotBlock, addr);
  const sig = await wallet.signMessage(msg);
  info(`canonical message:\n${msg.split("\n").map(l => "      " + l).join("\n")}`);
  info(`signature: ${sig.slice(0, 22)}…  (${(sig.length - 2) / 2} bytes)`);

  // ── 2) tally-side verification: good sig accepted, corrupted sig rejected ──
  const recovered = ethers.verifyMessage(msg, sig).toLowerCase();
  recovered === addr ? ok("valid signature recovers to the voter address (would be COUNTED)")
                     : bad(`valid signature recovered to ${recovered}, expected ${addr}`);

  // corrupt one hex nibble of the signature body
  const flip = sig.slice(-1) === "0" ? "1" : "0";
  const corrupt = sig.slice(0, -1) + flip;
  let corruptRec = null;
  try { corruptRec = ethers.verifyMessage(msg, corrupt).toLowerCase(); } catch { /* malformed → also rejected */ }
  corruptRec !== addr ? ok("corrupted signature does NOT recover to the voter (would be DISCARDED)")
                      : bad("corrupted signature still recovered to the voter — verification is broken");

  // a signature over a DIFFERENT choice must not validate the claimed choice
  const otherMsg = canonical(prop.id, 1, prop.snapshotBlock, addr);
  const mismatch = ethers.verifyMessage(otherMsg, sig).toLowerCase();
  mismatch !== addr ? ok("signature is bound to its choice (re-check under a different choice fails)")
                    : bad("signature validated under a different choice — message binding is broken");

  if (!BASE_URL) {
    console.log("\n  OFFLINE run complete. Set BASE_URL to exercise POST /vote + GET /votes against prod.\n");
    return;
  }

  // ── 3) POST the vote ──
  const postRes = await fetch(`${BASE_URL}/api/govern/vote`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ proposalId: prop.id, choice, address: addr, sig }),
  });
  const postJson = await postRes.json().catch(() => ({}));
  postRes.ok && postJson.ok ? ok(`POST /api/govern/vote → 200 ${JSON.stringify(postJson)}`)
                            : bad(`POST /api/govern/vote → ${postRes.status} ${JSON.stringify(postJson)}`);

  // ── 4) GET the votes and confirm ours is stored verbatim ──
  const getRes = await fetch(`${BASE_URL}/api/govern/votes?id=${encodeURIComponent(prop.id)}&_=${Date.now()}`, { cache: "no-store" });
  const getJson = await getRes.json().catch(() => ({}));
  const stored = getJson.votes && getJson.votes[addr];
  if (!stored) return bad(`GET /api/govern/votes did not return our ballot for ${addr}`);
  ok(`GET /api/govern/votes → our ballot is present (choice=${stored.choice})`);
  stored.sig === sig ? ok("stored signature matches what we sent")
                     : bad("stored signature differs from what we sent");

  // ── 5) re-verify the stored ballot exactly as the tally does ──
  const storedMsg = canonical(prop.id, stored.choice, prop.snapshotBlock, addr);
  const storedRec = ethers.verifyMessage(storedMsg, stored.sig).toLowerCase();
  storedRec === addr ? ok("stored ballot re-verifies from the public JSON (tally would count it)")
                     : bad("stored ballot failed re-verification");

  // ── 6) server must reject a malformed ballot ──
  const junkRes = await fetch(`${BASE_URL}/api/govern/vote`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ proposalId: prop.id, choice: 999, address: addr, sig }),
  });
  junkRes.status === 400 ? ok("server rejects out-of-range choice (400)")
                         : bad(`server accepted out-of-range choice → ${junkRes.status}`);

  console.log("\n  LIVE run complete.\n");
}

main().catch(e => { console.error("\n  \x1b[31mFATAL\x1b[0m", e.message, "\n"); process.exit(1); });
