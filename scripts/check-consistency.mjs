// READ-ONLY consistency check (staging or production). Prints counts and transaction ids only (no names, no codes).
//   UPSTASH_REDIS_REST_URL=... UPSTASH_REDIS_REST_TOKEN=... node scripts/check-consistency.mjs
// Exit code 1 when something needs a manual look:
//   * "pending" markers: a webhook write was interrupted between the first and the last write (never counted twice,
//     but feed / history / leaderboard of that transaction must be checked by hand)
//   * avatar links whose reverse index is missing, leaderboard entries without metadata
import { Redis } from "@upstash/redis";

const redis = Redis.fromEnv({ automaticDeserialization: false });
async function scanAll(match) {
  const keys = [];
  let cursor = "0";
  do {
    const [next, batch] = await redis.scan(cursor, { match, count: 500 });
    cursor = String(next);
    keys.push(...batch.map(String));
  } while (cursor !== "0");
  return keys;
}
const markers = { v1: 0, done: 0, pending: [], other: 0 };
for (const k of await scanAll("bb:processed:*")) {
  const v = String((await redis.get(k)) ?? "");
  if (v === "1") markers.v1++;
  else if (v.startsWith("done|")) markers.done++;
  else if (v.startsWith("pending|")) markers.pending.push(k.slice("bb:processed:".length));
  else markers.other++;
}
const avatar = (await redis.hgetall("bb:avatar")) || {};
let brokenLinks = 0;
for (const [identityKey, uid] of Object.entries(avatar)) {
  const members = (await redis.smembers(`bb:avatar:user:${uid}`)).map(String);
  if (!members.includes(identityKey)) brokenLinks++;
}
const top = await redis.zrange("bb:donors", 0, -1, { withScores: true });
let missingProfiles = 0;
for (let i = 0; i < top.length; i += 2) {
  if (!(await redis.hgetall(`bb:donor:${top[i]}`))) missingProfiles++;
}
// v3 Gold Donation: bb:rank must equal the sum of the ledger bb:tx:* per member; PENDING bookkeeping must match
const ledgerSum = new Map();
const pendingPerMember = new Map();
let ledgerRows = 0, ledgerPending = 0;
for (const k of await scanAll("bb:tx:*")) {
  const raw = await redis.hgetall(k);
const h = Array.isArray(raw) ? Object.fromEntries(
  Array.from({ length: Math.floor(raw.length / 2) },
    (_, i) => [String(raw[i * 2]), raw[i * 2 + 1]])
) : raw;
  if (!h) continue;
  ledgerRows++;
  const amt = Number(h.amount) || 0;
  ledgerSum.set(h.member, (ledgerSum.get(h.member) || 0) + amt);
  if (h.status === "pending") { ledgerPending++; pendingPerMember.set(h.member, (pendingPerMember.get(h.member) || 0) + 1); }
}
const rank = await redis.zrange("bb:rank", 0, -1, { withScores: true });
let rankMismatch = 0, rankNonPositive = 0, rankTotal = 0;
const rankMembers = new Set();
for (let i = 0; i < rank.length; i += 2) {
  const m = String(rank[i]); const v = Number(rank[i + 1]);
  rankMembers.add(m); rankTotal += v;
  if (!(v > 0)) rankNonPositive++;
  if (Math.abs((ledgerSum.get(m) || 0) - v) > 0.0001) rankMismatch++;
}
for (const [m, v] of ledgerSum) if (v > 0 && !rankMembers.has(m)) rankMismatch++;
const pendingSet = (await redis.zrange("bb:rbx:pending", 0, -1)).map(String);
let pendingBad = 0;
for (const id of pendingSet) { const h = await redis.hgetall(`bb:tx:${id}`); if (!h || h.status !== "pending") pendingBad++; }
if (pendingSet.length !== ledgerPending) pendingBad++;
for (const [m, n] of pendingPerMember) {
  const h = await redis.hgetall(`bb:rk:${m}`);
  if (!h || Number(h.pending || 0) !== n) pendingBad++;
}
console.log(`transaction markers: v1=${markers.v1} done=${markers.done} pending=${markers.pending.length} other=${markers.other}`);
console.log(`gold ranking: ${rank.length / 2} entries, total ${rankTotal}, ledger rows ${ledgerRows}, mismatches ${rankMismatch}, non-positive ${rankNonPositive}`);
console.log(`username lookups pending: ${pendingSet.length}, bookkeeping problems: ${pendingBad}`);
if (markers.pending.length) console.log("pending transaction ids (check by hand):", markers.pending.join(", "));
console.log(`avatar links: ${Object.keys(avatar).length}, missing reverse index: ${brokenLinks}`);
console.log(`leaderboard entries: ${top.length / 2}, without metadata: ${missingProfiles}`);
const problems = markers.pending.length + brokenLinks + missingProfiles + rankMismatch + rankNonPositive + pendingBad;
console.log(problems ? `RESULT: ${problems} item(s) need a manual check` : "RESULT: consistent");
process.exit(problems ? 1 : 0);
