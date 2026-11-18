// READ-ONLY backup of every "bb:*" key (value + TTL) to a local JSON file. Run BEFORE deploying v3:
//   node --env-file=.env.production.readonly scripts/export-backup.mjs backup-before-v3.json
// v3 keys (bb:tx:*, bb:rank, bb:rk:*, bb:rbx:*) are included automatically (everything under "bb:").
// Uses client-side SCAN (no Lua). The file contains donor names / messages: keep it private, never commit it.
import { Redis } from "@upstash/redis";
import { writeFileSync } from "node:fs";

const redis = Redis.fromEnv({ automaticDeserialization: false });
const keys = [];
let cursor = "0";
do {
  const [next, batch] = await redis.scan(cursor, { match: "bb:*", count: 500 });
  cursor = String(next);
  keys.push(...batch.map(String));
} while (cursor !== "0");
const out = [];
for (const key of keys) {
  const type = String(await redis.type(key));
  let value = null;
  if (type === "string") value = await redis.get(key);
  else if (type === "list") value = await redis.lrange(key, 0, -1);
  else if (type === "zset") value = await redis.zrange(key, 0, -1, { withScores: true });
  else if (type === "hash") value = await redis.hgetall(key);
  else if (type === "set") value = await redis.smembers(key);
  out.push({ key, type, ttl: Number(await redis.ttl(key)), value });
}
const file = process.argv[2] || `bagibagi-backup-${Date.now()}.json`;
writeFileSync(file, JSON.stringify({ exportedAt: new Date().toISOString(), keys: out }, null, 1));
console.log(`exported ${out.length} keys to ${file}`);
