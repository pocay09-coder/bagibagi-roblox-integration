// READ-ONLY migration report: old leaderboard totals (bb:donors, v1 / v2.1) -> proposed v3 Gold Donation entries.
// Writes NOTHING to the database (also no cache keys); it only creates two local files: <out>.json and <out>.csv
//   node --env-file=.env.staging.local scripts/migration-report.mjs migration-report
// Uses the official Roblox Users API directly (read-only, batched, slow on purpose).
// Historical part = old total MINUS what v3 already counted for that old key (v3 still writes bb:donors for
// compatibility), so applying the report later can never count a v3 donation twice.
import { Redis } from "@upstash/redis";
import { writeFileSync } from "node:fs";

const redis = Redis.fromEnv({ automaticDeserialization: false });
const API = String(process.env.ROBLOX_USERS_API_TEST_ONLY || "https://users.roblox.com").replace(/\/+$/, ""); // override = local tests only
const out = process.argv[2] || "migration-report";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function usernameCandidate(name) {
  let s = String(name ?? "").normalize("NFC").trim();
  if (s.startsWith("@")) s = s.slice(1).trim();
  if (!/^[A-Za-z0-9_]{3,20}$/.test(s)) return null;
  if (s.startsWith("_") || s.endsWith("_") || (s.match(/_/g) || []).length > 1) return null;
  return s;
}
async function scanAll(match) {
  const keys = []; let cursor = "0";
  do { const [next, batch] = await redis.scan(cursor, { match, count: 500 }); cursor = String(next); keys.push(...batch.map(String)); } while (cursor !== "0");
  return keys;
}

// what v3 already counted per old key
const v3PerLegacy = new Map();
for (const k of await scanAll("bb:tx:*")) {
  const h = await redis.hgetall(k);
  if (h && h.legacy) v3PerLegacy.set(h.legacy, (v3PerLegacy.get(h.legacy) || 0) + (Number(h.amount) || 0));
}
const donors = await redis.zrange("bb:donors", 0, -1, { withScores: true });
const rows = [];
for (let i = 0; i < donors.length; i += 2) {
  const key = String(donors[i]);
  const total = Number(donors[i + 1]) || 0;
  const prof = (await redis.hgetall(`bb:donor:${key}`)) || {};
  const type = key.startsWith("uid:") ? "account(code)" : key.startsWith("id:") ? "donor-id" : "name";
  const historical = Math.max(0, total - (v3PerLegacy.get(key) || 0));
  rows.push({ legacyKey: key, type, name: String(prof.name || ""), legacyTotal: total, countedByV3: v3PerLegacy.get(key) || 0, historical,
    candidate: type === "name" ? usernameCandidate(prof.name) : null, proposed: "", username: "", displayName: "", flags: [] });
}
// batched read-only lookups
const cands = [...new Set(rows.map((r) => r.candidate).filter(Boolean).map((c) => c.toLowerCase()))];
const found = new Map();
for (let i = 0; i < cands.length; i += 100) {
  const batch = cands.slice(i, i + 100);
  for (let attempt = 0; attempt < 4; attempt++) {
    const r = await fetch(API + "/v1/usernames/users", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ usernames: batch, excludeBannedUsers: true }) });
    if (r.status === 429 || r.status >= 500) { await sleep(2000 * 2 ** attempt); continue; }
    const j = await r.json();
    for (const u of j.data || []) {
      if (String(u.requestedUsername).toLowerCase() === String(u.name).toLowerCase()) found.set(String(u.name).toLowerCase(), u);
    }
    break;
  }
  await sleep(1000);
}
for (const r of rows) {
  const nameKey = Buffer.from(r.name.normalize("NFC").trim().replace(/\s+/g, " ").toLowerCase(), "utf8").toString("base64url");
  if (r.type === "account(code)") { r.proposed = "u:" + r.legacyKey.slice(4); r.flags.push("LINKED_BY_OLD_CODE"); }
  else if (r.type === "donor-id") { r.proposed = "n:" + nameKey; r.flags.push("DONOR_ID_ENTRY_CHECK_BY_HAND"); }
  else {
    const u = r.candidate && found.get(r.candidate.toLowerCase());
    if (u) { r.proposed = "u:" + u.id; r.username = u.name; r.displayName = u.displayName; r.flags.push("USERNAME_MATCHED_NOT_PROOF_OF_PAYER"); }
    else { r.proposed = "n:" + nameKey; r.flags.push(r.candidate ? "USERNAME_NOT_FOUND" : "NOT_A_USERNAME"); }
    r.flags.push("OLD_NAME_TOTAL_MAY_MIX_SEVERAL_PEOPLE");
  }
  if (r.historical === 0) r.flags.push("NOTHING_HISTORICAL_TO_MOVE");
}
const sum = (f) => rows.filter(f).reduce((s, r) => s + r.historical, 0);
const summary = { createdAt: new Date().toISOString(), legacyEntries: rows.length, historicalTotal: sum(() => true),
  toAccounts: sum((r) => r.proposed.startsWith("u:")), toNames: sum((r) => r.proposed.startsWith("n:")), note: "Report only. Nothing was written to the database." };
writeFileSync(out + ".json", JSON.stringify({ summary, rows }, null, 1));
const esc = (v) => `"${String(v).replace(/"/g, '""')}"`;
writeFileSync(out + ".csv", ["legacyKey,type,name,legacyTotal,countedByV3,historical,proposed,username,displayName,flags",
  ...rows.map((r) => [r.legacyKey, r.type, r.name, r.legacyTotal, r.countedByV3, r.historical, r.proposed, r.username, r.displayName, r.flags.join(" ")].map(esc).join(","))].join("\n"));
console.log(`entries: ${rows.length}, historical total: ${summary.historicalTotal} (to accounts ${summary.toAccounts}, to names ${summary.toNames})`);
console.log(`written: ${out}.json, ${out}.csv - report only, nothing changed in the database`);
