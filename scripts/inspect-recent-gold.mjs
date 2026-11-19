// READ-ONLY diagnostic: newest Gold history rows + their v3 ledger rows + the Gold ranking. Writes nothing.
// Windows (PowerShell), from the repo folder:
//   node --env-file=.env.production.readonly scripts\inspect-recent-gold.mjs [count]
// Prints ids, names, amounts and match data only (no message text: only its length and whether it mentions a test; no keys or tokens).
import { Redis } from "@upstash/redis";

const redis = Redis.fromEnv({ automaticDeserialization: false });
const count = Math.min(20, Math.max(1, Number(process.argv[2]) || 5));
function hashObject(raw) {
  if (raw == null) return null;
  if (Array.isArray(raw)) {
    if (raw.length === 0) return null;
    const pairs = [];
    for (let i = 0; i + 1 < raw.length; i += 2) pairs.push([String(raw[i]), raw[i + 1] == null ? raw[i + 1] : String(raw[i + 1])]);
    return Object.fromEntries(pairs);
  }
  return typeof raw === "object" && Object.keys(raw).length ? raw : null;
}
const HIDE = new Set(["message", "mediaShareUrl"]);
const rows = await redis.lrange("bb:history", 0, count - 1);
console.log(`newest ${rows.length} history rows (bb:history):`);
for (const raw of rows) {
  let j = {};
  try { j = JSON.parse(String(raw)); } catch {}
  const shown = Object.fromEntries(Object.entries(j).filter(([k]) => !HIDE.has(k)));
  const msg = String(j.message ?? "");
  shown.messageHint = { length: msg.length, mentionsTest: /\btest|uji ?coba|percobaan|contoh/i.test(msg), hasMedia: !!j.mediaShareUrl };
  if (shown.receivedAt) shown.receivedAt = new Date(Number(shown.receivedAt)).toISOString();
  const tx = hashObject(await redis.hgetall(`bb:tx:${j.id}`));
  const marker = await redis.get(`bb:processed:${j.id}`);
  console.log(JSON.stringify({ ...shown, ledger: tx ? { member: tx.member, status: tx.status, amount: tx.amount, cand: tx.cand, legacy: tx.legacy || "" } : null, marker: marker == null ? null : String(marker).split("|")[0] }));
}
const rank = (await redis.zrange("bb:rank", 0, -1, { withScores: true })).map(String);
const list = [];
for (let i = 0; i < rank.length; i += 2) {
  const rk = hashObject(await redis.hgetall(`bb:rk:${rank[i]}`)) || {};
  list.push({ member: rank[i], gold: Number(rank[i + 1]), username: rk.username || "", displayName: rk.displayName || "", lastName: rk.lastName || "" });
}
list.sort((a, b) => b.gold - a.gold);
console.log("Gold ranking (bb:rank):");
for (const e of list) console.log(JSON.stringify(e));
