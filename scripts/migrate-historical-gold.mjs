// ONE-TIME historical Gold migration (v3): moves an OLD leaderboard total (bb:donors, v1 / v2.1) of ONE legacy entry
// into the v3 Gold ranking (bb:rank) of ONE approved Roblox account. DRY-RUN by default: reads only, writes nothing.
// Windows (PowerShell), from the repo folder:
//   dry-run  : node --env-file=<env file> scripts\migrate-historical-gold.mjs --legacy-key <key> --target u:<UserId> --amount <n>
//   apply    : (same) --apply --confirm <key>:u:<UserId>:<n>
//   verify   : (same) --verify
//   rollback : (same) --rollback                       (plan only, writes nothing)
//              (same) --rollback --confirm <key>:u:<UserId>:<n>
// Exactly once:
//   * every source transaction (the old donations behind the legacy total, found in bb:history) becomes a v3 ledger
//     row bb:tx:<original transaction id>. That is the key the webhook checks for duplicates (and it never expires),
//     so the old transaction can never be counted again, even after its old bb:processed marker has expired
//   * plus a record bb:migration:hist:<legacy key>. One atomic Lua script checks both before its first write, so a
//     second run - or two runs at the same time - can never add the amount twice
//   * the apply is refused when the old total or the target's Gold changed after the numbers were read
// Never touches bb:donors, bb:donor:*, bb:feed, bb:history or bb:processed:* (no alert is replayed in Roblox, the
// old webhook markers stay as they are). Prints amounts and ids only, never keys or tokens.
import { Redis } from "@upstash/redis";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

export const MIGRATION_ID = "historical-v1";
const MAX_SOURCES = 50;

const TYPE_FN = `
local function typeOf(k)
  local t = redis.call('TYPE', k)
  if type(t) == 'table' then t = t['ok'] end
  return t
end
local function typeOk(k, want)
  local t = typeOf(k)
  return t == 'none' or t == want
end
local function posInt(v, max)
  local n = tonumber(v)
  if not n or n ~= n or n <= 0 or n % 1 ~= 0 or n > (max or 1e12) then return nil end
  return n
end
`;

// read-only snapshot. KEYS: 1 bb:donors  2 bb:rank  3 bb:rk:<target>  4 bb:migration:hist:<key>  5 bb:history
// ARGV: 1 legacy key  2 target member
const READ_SCRIPT = TYPE_FN + `
local out = {typeOf(KEYS[1]), '', typeOf(KEYS[2]), '', typeOf(KEYS[3]), {}, typeOf(KEYS[4]), {}, typeOf(KEYS[5]), {}, {}}
if out[1] == 'zset' then out[2] = redis.call('ZSCORE', KEYS[1], ARGV[1]) or '' end
if out[3] == 'zset' then
  out[4] = redis.call('ZSCORE', KEYS[2], ARGV[2]) or ''
  out[11] = redis.call('ZRANGE', KEYS[2], 0, -1, 'WITHSCORES')
end
if out[5] == 'hash' then out[6] = redis.call('HGETALL', KEYS[3]) end
if out[7] == 'hash' then out[8] = redis.call('HGETALL', KEYS[4]) end
if out[9] == 'list' then out[10] = redis.call('LRANGE', KEYS[5], 0, -1) end
return out
`;

// KEYS: 1 bb:donors  2 bb:rank  3 bb:rk:<target>  4 bb:migration:hist:<key>  4+i bb:tx:<src i>  4+n+i bb:processed:<src i>
// ARGV: 1 legacy key  2 target  3 amount  4 expected old total  5 expected Gold of target ("" = not ranked)  6 now ms
//       7 migration id  8 n   then per source i (base 9+(i-1)*4): id, amount, name, receivedAt
const APPLY_SCRIPT = TYPE_FN + `
local n = tonumber(ARGV[8])
if not n or n < 1 or n > ${MAX_SOURCES} or n % 1 ~= 0 or #KEYS ~= 4 + 2 * n or #ARGV ~= 8 + 4 * n then return {'error', 'BBARGS'} end
local legacyKey, target, migId = ARGV[1], ARGV[2], ARGV[7]
-- 1) idempotency: the record and every ledger row must not exist yet
local rt = typeOf(KEYS[4])
if rt ~= 'none' then
  if rt ~= 'hash' then return {'error', 'BBTYPE record'} end
  if redis.call('HGET', KEYS[4], 'state') == 'done' then return {'already'} end
  return {'incomplete'}
end
for i = 1, n do
  if redis.call('EXISTS', KEYS[4 + i]) == 1 then return {'conflict', ARGV[9 + (i - 1) * 4]} end
end
-- 2) validate every value and key type BEFORE the first write
if typeOf(KEYS[1]) ~= 'zset' then return {'error', 'BBTYPE donors'} end
if not typeOk(KEYS[2], 'zset') then return {'error', 'BBTYPE rank'} end
if not typeOk(KEYS[3], 'hash') then return {'error', 'BBTYPE rk'} end
for i = 1, n do
  if typeOf(KEYS[4 + n + i]) ~= 'string' then return {'error', 'BBMARKER', ARGV[9 + (i - 1) * 4]} end
end
if not string.match(target, '^u:%d+$') then return {'error', 'BBTARGET'} end
local amount = posInt(ARGV[3])
if not amount then return {'error', 'BBAMOUNT'} end
local sum = 0
for i = 1, n do
  local b = 9 + (i - 1) * 4
  local a = posInt(ARGV[b + 1])
  if not a or not posInt(ARGV[b + 3], 1e14) or ARGV[b] == '' then return {'error', 'BBSOURCE'} end
  sum = sum + a
end
if sum ~= amount then return {'error', 'BBSUM'} end
local legacy = redis.call('ZSCORE', KEYS[1], legacyKey)
if not legacy or tonumber(legacy) ~= tonumber(ARGV[4]) then return {'changed', 'old total'} end
if tonumber(legacy) < amount then return {'error', 'BBLEGACY'} end
local before = redis.call('ZSCORE', KEYS[2], target)
if (before and ARGV[5] == '') or (not before and ARGV[5] ~= '') or (before and tonumber(before) ~= tonumber(ARGV[5])) then
  return {'changed', 'gold'}
end
if not posInt(ARGV[6], 1e14) then return {'error', 'BBNOW'} end
-- 3) writes. FIRST the ledger rows (status migrating) + the record (state applying), LAST state done.
--    rankApplied tells a later --rollback whether the Gold was already added if a command fails in between.
local ids = {}
for i = 1, n do
  local b = 9 + (i - 1) * 4
  redis.call('HSET', KEYS[4 + i], 'amount', ARGV[b + 1], 'member', target, 'status', 'migrating', 'name', ARGV[b + 2],
    'cand', '', 'at', ARGV[b + 3], 'legacy', legacyKey, 'migration', migId)
  ids[#ids + 1] = ARGV[b]
end
local rkCreated = (typeOf(KEYS[3]) == 'none') and '1' or '0'
redis.call('HSET', KEYS[4], 'state', 'applying', 'migration', migId, 'legacyKey', legacyKey, 'target', target,
  'amount', ARGV[3], 'txIds', table.concat(ids, ','), 'rankBefore', before or '', 'rkCreated', rkCreated,
  'rankApplied', '0', 'startedAt', ARGV[6])
local after = redis.call('ZINCRBY', KEYS[2], ARGV[3], target)
redis.call('HSET', KEYS[4], 'rankApplied', '1', 'rankAfter', after)
redis.call('HSETNX', KEYS[3], 'lastName', ARGV[11])
redis.call('HSETNX', KEYS[3], 'refreshedAt', '0')
for i = 1, n do redis.call('HSET', KEYS[4 + i], 'status', 'migrated') end
redis.call('HSET', KEYS[4], 'state', 'done', 'doneAt', ARGV[6])
return {'applied', before or '0', after}
`;

// KEYS: 1 bb:rank  2 bb:rk:<target>  3 bb:migration:hist:<key>  3+i bb:tx:<src i>
// ARGV: 1 legacy key  2 target  3 amount  4 migration id  5 n  5+i source id i
const ROLLBACK_SCRIPT = TYPE_FN + `
local n = tonumber(ARGV[5])
if not n or n < 1 or n > ${MAX_SOURCES} or n % 1 ~= 0 or #KEYS ~= 3 + n or #ARGV ~= 5 + n then return {'error', 'BBARGS'} end
local rt = typeOf(KEYS[3])
if rt == 'none' then return {'nothing'} end
if rt ~= 'hash' then return {'error', 'BBTYPE record'} end
local rec = redis.call('HMGET', KEYS[3], 'target', 'amount', 'migration', 'txIds', 'rankApplied', 'rkCreated', 'legacyKey')
local ids = {}
for i = 1, n do ids[#ids + 1] = ARGV[5 + i] end
if rec[1] ~= ARGV[2] or rec[2] ~= ARGV[3] or rec[3] ~= ARGV[4] or rec[4] ~= table.concat(ids, ',') or rec[7] ~= ARGV[1] then
  return {'error', 'BBMISMATCH'}
end
if not typeOk(KEYS[1], 'zset') or not typeOk(KEYS[2], 'hash') then return {'error', 'BBTYPE'} end
for i = 1, n do
  local k = KEYS[3 + i]
  if typeOf(k) ~= 'hash' or redis.call('HGET', k, 'migration') ~= ARGV[4] or redis.call('HGET', k, 'member') ~= ARGV[2] then
    return {'error', 'BBROW', ARGV[5 + i]}
  end
end
local gold = redis.call('ZSCORE', KEYS[1], ARGV[2]) or '0'
if rec[5] == '1' then
  gold = redis.call('ZINCRBY', KEYS[1], '-' .. ARGV[3], ARGV[2])
  if tonumber(gold) <= 0.0001 then redis.call('ZREM', KEYS[1], ARGV[2]); gold = '0' end
end
if rec[6] == '1' and not redis.call('ZSCORE', KEYS[1], ARGV[2]) then redis.call('DEL', KEYS[2]) end
for i = 1, n do redis.call('DEL', KEYS[3 + i]) end
redis.call('DEL', KEYS[3])
return {'rolledback', gold, rec[5]}
`;

function hashObject(raw) {
  if (raw == null) return null;
  if (Array.isArray(raw)) {
    if (raw.length === 0) return null;
    const pairs = [];
    for (let i = 0; i + 1 < raw.length; i += 2) pairs.push([String(raw[i]), raw[i + 1] == null ? raw[i + 1] : String(raw[i + 1])]);
    return Object.fromEntries(pairs);
  }
  if (typeof raw === "object") return Object.keys(raw).length ? raw : null;
  return null;
}
const nameKey = (name) => Buffer.from(String(name ?? "").toLowerCase(), "utf8").toString("base64url"); // = webhook / v1
const fmt = (n) => (Number.isFinite(n) ? Number(n).toLocaleString("en-US") : String(n));
const iso = (ms) => (Number(ms) > 0 ? new Date(Number(ms)).toISOString().replace(".000Z", "Z") : "?");
function dbFingerprint() {
  try {
    const host = new URL(String(process.env.UPSTASH_REDIS_REST_URL || "")).hostname;
    return host ? createHash("sha256").update(host).digest("hex").slice(0, 12) : "(local test database)";
  } catch {
    return "(local test database)";
  }
}
function parseArgs(argv) {
  const a = { apply: false, verify: false, rollback: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === "--apply") a.apply = true;
    else if (k === "--verify") a.verify = true;
    else if (k === "--rollback") a.rollback = true;
    else if (["--legacy-key", "--target", "--amount", "--confirm"].includes(k)) a[k.slice(2)] = String(argv[++i] ?? "");
    else return { error: `unknown argument ${k}` };
  }
  if (!a["legacy-key"] || !a.target || !a.amount) return { error: "required: --legacy-key <key> --target u:<UserId> --amount <n>" };
  if ([a.apply, a.verify, a.rollback].filter(Boolean).length > 1) return { error: "use only one of --apply / --verify / --rollback" };
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(a["legacy-key"])) return { error: "--legacy-key must be the base64url key from the migration report" };
  if (!/^u:\d{1,20}$/.test(a.target)) return { error: "--target must look like u:<UserId>" };
  if (!/^[1-9]\d{0,11}$/.test(a.amount)) return { error: "--amount must be a positive whole number (rupiah)" };
  a.amountNum = Number(a.amount);
  a.expectedConfirm = `${a["legacy-key"]}:${a.target}:${a.amount}`;
  return a;
}
async function scanAll(redis, match) {
  const keys = [];
  let cursor = "0";
  do {
    const [next, batch] = await redis.scan(cursor, { match, count: 500 });
    cursor = String(next);
    keys.push(...batch.map(String));
  } while (cursor !== "0");
  return keys;
}

// everything the dry-run / apply / verify / rollback needs, read without writing anything
async function readState(redis, legacyKey, target) {
  const r = await redis.eval(READ_SCRIPT, ["bb:donors", "bb:rank", `bb:rk:${target}`, `bb:migration:hist:${legacyKey}`, "bb:history"], [legacyKey, target]);
  const [tDonors, legacyRaw, tRank, goldRaw, tRk, rkRaw, tRec, recRaw, tHist, histRaw, rankAll] = r;
  const s = {
    types: { donors: String(tDonors), rank: String(tRank), rk: String(tRk), record: String(tRec), history: String(tHist) },
    legacyRaw: String(legacyRaw ?? ""), goldRaw: String(goldRaw ?? ""),
    rk: hashObject(rkRaw), record: hashObject(recRaw), rankAll: (rankAll || []).map(String)
  };
  s.legacyTotal = s.legacyRaw === "" ? null : Number(s.legacyRaw);
  s.gold = s.goldRaw === "" ? 0 : Number(s.goldRaw);
  s.profile = hashObject(await redis.hgetall(`bb:donor:${legacyKey}`)) || {};
  // v3 ledger: what v3 already counted for this old key, and the target's own rows
  s.ledger = new Map();
  for (const k of await scanAll(redis, "bb:tx:*")) {
    const h = hashObject(await redis.hgetall(k));
    if (h) s.ledger.set(k.slice("bb:tx:".length), h);
  }
  s.countedByV3 = 0; s.targetLedgerSum = 0; s.targetLedgerRows = 0;
  for (const h of s.ledger.values()) {
    if (h.legacy === legacyKey) s.countedByV3 += Number(h.amount) || 0;
    if (h.member === target) { s.targetLedgerSum += Number(h.amount) || 0; s.targetLedgerRows++; }
  }
  s.historical = s.legacyTotal === null ? 0 : Math.max(0, s.legacyTotal - s.countedByV3);
  // source transactions: history rows of this old key that v3 never counted (no ledger row)
  s.sources = []; s.historyRows = 0;
  const seen = new Set();
  for (const row of histRaw || []) {
    let j = null;
    try { j = JSON.parse(String(row)); } catch {}
    if (!j || typeof j !== "object" || nameKey(j.name) !== legacyKey) continue;
    s.historyRows++;
    const id = String(j.id ?? "");
    if (!id || seen.has(id) || s.ledger.has(id)) continue;
    seen.add(id);
    s.sources.push({ id, amount: Number(j.amount), name: String(j.name ?? ""), at: Number(j.receivedAt) || 0 });
  }
  for (const src of s.sources) {
    const marker = await redis.get(`bb:processed:${src.id}`);
    src.marker = marker == null ? null : String(marker);
    src.ttl = src.marker === null ? -2 : Number(await redis.ttl(`bb:processed:${src.id}`));
  }
  s.sourceSum = s.sources.reduce((t, x) => t + (Number.isFinite(x.amount) ? x.amount : NaN), 0);
  // predicted position in the Gold ranking after adding
  s.rankMembers = s.rankAll.length / 2;
  return s;
}
function status(s) {
  if (!s.record) return "NOT APPLIED";
  return s.record.state === "done" ? "APPLIED" : "INCOMPLETE";
}
function predictedPosition(s, target, total) {
  let higher = 0, members = 0;
  for (let i = 0; i < s.rankAll.length; i += 2) {
    if (s.rankAll[i] === target) continue;
    members++;
    if (Number(s.rankAll[i + 1]) > total) higher++;
  }
  return { position: higher + 1, of: members + 1 };
}
function markerText(src) {
  if (src.marker === null) return "MISSING";
  const kind = src.marker === "1" ? "v1" : src.marker.split("|")[0];
  return `present (${kind}${src.ttl > 0 ? `, expires in ${Math.floor(src.ttl / 86400)} d` : src.ttl === -1 ? ", no expiry" : ""})`;
}
function checksFor(s, a) {
  const c = [];
  const add = (ok, text) => c.push({ ok, text });
  add(s.types.donors === "zset" && s.legacyTotal !== null, `old leaderboard entry ${a["legacy-key"]} exists in bb:donors`);
  add(s.types.rank === "zset" || s.types.rank === "none", `bb:rank is a sorted set (or not created yet): ${s.types.rank}`);
  add(s.types.rk === "hash" || s.types.rk === "none", `bb:rk:${a.target} is a hash (or not created yet): ${s.types.rk}`);
  add(s.historical > 0, `historical amount is positive: ${fmt(s.historical)}`);
  add(a.amountNum === s.historical, `approved amount (${fmt(a.amountNum)}) == historical amount (${fmt(s.historical)})`);
  add(s.sources.length > 0 && s.sources.length <= MAX_SOURCES, `source transactions found in bb:history: ${s.sources.length}`);
  add(s.sourceSum === s.historical, `source transactions add up to the historical amount (${fmt(s.sourceSum)})`);
  add(s.sources.every((x) => Number.isSafeInteger(x.amount) && x.amount > 0 && x.at > 0), "every source transaction has a valid amount and time");
  add(s.sources.length > 0 && s.sources.every((x) => x.marker !== null), "every source transaction has its old webhook marker (it was counted by the old webhook)");
  add(Math.abs(s.gold - s.targetLedgerSum) < 0.0001, `target Gold (${fmt(s.gold)}) == sum of its ledger rows (${fmt(s.targetLedgerSum)}) before migrating`);
  return c;
}

export async function main(argv, log = console.log) {
  const a = parseArgs(argv);
  if (a.error) { log(`usage error: ${a.error}`); return 2; }
  const mode = a.apply ? "APPLY" : a.verify ? "VERIFY" : a.rollback ? (a.confirm ? "ROLLBACK" : "ROLLBACK DRY-RUN") : "DRY-RUN";
  if ((a.apply || (a.rollback && a.confirm)) && a.confirm !== a.expectedConfirm) {
    log(`Refusing to ${a.apply ? "apply" : "roll back"}: add --confirm ${a.expectedConfirm} (exactly).`);
    return 2;
  }
  const redis = Redis.fromEnv({ automaticDeserialization: false });
  const key = a["legacy-key"], target = a.target;
  try {
    const s = await readState(redis, key, target);
    const st = status(s);
    log(`AFTERBEAT historical Gold migration - ${mode}${mode.includes("DRY-RUN") || mode === "VERIFY" ? " (reads only, writes nothing)" : ""}`);
    log(`database fingerprint : ${dbFingerprint()}   (compare with dbFingerprint of GET /api/roblox)`);
    log(`migration status     : ${st}${s.record ? `  (record bb:migration:hist:${key}, state ${s.record.state})` : ""}`);
    log(`legacy entry         : ${key}  name "${s.profile.name || "?"}"  old total ${s.legacyTotal === null ? "-" : fmt(s.legacyTotal)}  already counted by v3 ${fmt(s.countedByV3)}`);

    if (a.verify) return verify(s, a, log);
    if (a.rollback) return await rollback(redis, s, a, log);

    if (st === "APPLIED") {
      log(`target UserId        : ${target}   Gold now ${fmt(s.gold)}`);
      log("RESULT: ALREADY APPLIED - nothing to do, nothing written.");
      return 0;
    }
    if (st === "INCOMPLETE") {
      log("RESULT: INCOMPLETE - a previous apply stopped in the middle. Nothing written now. Run --verify, then --rollback (see MIGRATION-HISTORICAL.md).");
      return 1;
    }
    const pred = predictedPosition(s, target, s.gold + a.amountNum);
    log(`historical amount    : ${fmt(s.historical)}`);
    log(`target UserId        : ${target}`);
    log(`existing Gold        : ${fmt(s.gold)}   (ledger rows of target: ${s.targetLedgerRows}, sum ${fmt(s.targetLedgerSum)})`);
    log(`amount to add        : ${fmt(a.amountNum)}`);
    log(`predicted total      : ${fmt(s.gold + a.amountNum)}   (predicted Gold rank #${pred.position} of ${pred.of})`);
    log(`source transactions  : ${s.sources.length}  (history rows of this name: ${s.historyRows})`);
    for (const x of s.sources) {
      log(`  ${x.id}  ${fmt(x.amount)}  ${iso(x.at)}  webhook marker: ${markerText(x)}  -> new ledger row bb:tx:${x.id} (status migrated)`);
    }
    log("not touched          : bb:donors, bb:donor:*, bb:feed, bb:history, bb:processed:* (no alert is replayed)");
    const checks = checksFor(s, a);
    log("checks:");
    for (const c of checks) log(`  ${c.ok ? "OK  " : "FAIL"} ${c.text}`);
    const ready = checks.every((c) => c.ok);
    if (!ready) { log("RESULT: REFUSED - fix the FAIL lines first. Nothing written."); return 1; }
    if (!a.apply) {
      log("RESULT: READY. Nothing written. To apply exactly once:");
      log(`  node --env-file=<env file> scripts\\migrate-historical-gold.mjs --legacy-key ${key} --target ${target} --amount ${a.amount} --apply --confirm ${a.expectedConfirm}`);
      return 0;
    }
    // apply: one atomic script re-checks everything (idempotency, types, unchanged totals) before its first write
    const keys = ["bb:donors", "bb:rank", `bb:rk:${target}`, `bb:migration:hist:${key}`,
      ...s.sources.map((x) => `bb:tx:${x.id}`), ...s.sources.map((x) => `bb:processed:${x.id}`)];
    const args = [key, target, a.amount, s.legacyRaw, s.goldRaw, String(Date.now()), MIGRATION_ID, String(s.sources.length),
      ...s.sources.flatMap((x) => [x.id, String(x.amount), x.name, String(x.at)])];
    const r = (await redis.eval(APPLY_SCRIPT, keys, args)).map((v) => (v == null ? "" : String(v)));
    if (r[0] === "applied") {
      log(`RESULT: APPLIED once. Gold of ${target}: ${fmt(Number(r[1]))} -> ${fmt(Number(r[2]))}. Ledger rows: ${s.sources.map((x) => `bb:tx:${x.id}`).join(", ")}`);
      log("Next: run the same command with --verify (instead of --apply), then scripts/check-consistency.mjs.");
      return 0;
    }
    if (r[0] === "already") { log("RESULT: ALREADY APPLIED (by another run) - nothing written."); return 0; }
    if (r[0] === "incomplete") { log("RESULT: INCOMPLETE record found - nothing written. Run --verify, then --rollback."); return 1; }
    if (r[0] === "changed") { log(`RESULT: REFUSED - the ${r[1]} changed after the numbers were read. Nothing written. Run the dry-run again.`); return 1; }
    if (r[0] === "conflict") { log(`RESULT: REFUSED - ledger row bb:tx:${r[1]} already exists. Nothing written.`); return 1; }
    log(`RESULT: REFUSED by the database check (${r.slice(1).join(" ")}). Nothing written.`);
    return 1;
  } catch (e) {
    log(`ERROR: ${String(e?.message || e).slice(0, 120)}`);
    log("The outcome of a write that was in flight is unknown: run --verify before anything else (a repeated --apply is safe, it never adds twice).");
    return 1;
  }
}

function verify(s, a, log) {
  const st = status(s);
  log(`target UserId        : ${a.target}   Gold now ${fmt(s.gold)}   ledger rows ${s.targetLedgerRows}, sum ${fmt(s.targetLedgerSum)}`);
  log(`historical left      : ${fmt(s.historical)}   (old total ${s.legacyTotal === null ? "-" : fmt(s.legacyTotal)} minus counted by v3 ${fmt(s.countedByV3)})`);
  if (!s.record) { log("RESULT: NOT APPLIED - nothing was migrated for this entry."); return 0; }
  const rec = s.record;
  const ids = String(rec.txIds || "").split(",").filter(Boolean);
  log(`record               : target ${rec.target}  amount ${fmt(Number(rec.amount))}  rows ${ids.length}  Gold before ${rec.rankBefore || "0"} after ${rec.rankAfter || "-"}  rankApplied ${rec.rankApplied}`);
  let rowsOk = true;
  for (const id of ids) {
    const h = s.ledger.get(id);
    const ok = !!h && h.migration === MIGRATION_ID && h.member === rec.target && (st === "APPLIED" ? h.status === "migrated" : true);
    rowsOk &&= ok;
    log(`  ledger row bb:tx:${id}: ${h ? `status ${h.status}, amount ${fmt(Number(h.amount))}` : "MISSING"}  -> webhook replay of this id = duplicate (permanent)${ok ? "" : "  [PROBLEM]"}`);
  }
  const consistent = Math.abs(s.gold - s.targetLedgerSum) < 0.0001;
  log(`  ${consistent ? "OK  " : "FAIL"} Gold of target == sum of its ledger rows`);
  log(`  ${rec.target === a.target && rec.amount === a.amount ? "OK  " : "FAIL"} record matches --target / --amount`);
  if (st === "INCOMPLETE") {
    log(`RESULT: INCOMPLETE - stopped after ${rec.rankApplied === "1" ? "the Gold was added" : "the ledger rows were written, BEFORE the Gold was added"}. Never counted twice. Fix: --rollback, then --apply again.`);
    return 1;
  }
  const ok = rowsOk && consistent && rec.target === a.target && rec.amount === a.amount && s.historical === 0;
  log(ok ? "RESULT: APPLIED and consistent." : "RESULT: APPLIED but a check failed - see the lines above.");
  return ok ? 0 : 1;
}

async function rollback(redis, s, a, log) {
  if (!s.record) { log("RESULT: nothing to roll back (no record). Nothing written."); return 0; }
  const rec = s.record;
  const ids = String(rec.txIds || "").split(",").filter(Boolean);
  if (rec.target !== a.target || rec.amount !== a.amount || ids.length === 0) {
    log(`RESULT: REFUSED - the record says target ${rec.target}, amount ${rec.amount}; it does not match --target / --amount.`);
    return 1;
  }
  const after = rec.rankApplied === "1" ? Math.max(0, s.gold - a.amountNum) : s.gold;
  log(`target UserId        : ${a.target}   Gold now ${fmt(s.gold)}  ->  after rollback ${fmt(after)}${rec.rankApplied === "1" ? "" : "  (the Gold had not been added yet)"}`);
  log(`will delete          : ${ids.map((id) => `bb:tx:${id}`).join(", ")}, bb:migration:hist:${a["legacy-key"]}${rec.rkCreated === "1" && after <= 0 ? `, bb:rk:${a.target} (created by the migration)` : ""}`);
  log("not touched          : bb:donors, bb:donor:*, bb:feed, bb:history, bb:processed:* (old webhook markers keep protecting the old transactions)");
  if (!a.confirm) {
    log("RESULT: ROLLBACK PLAN only. Nothing written. To roll back:");
    log(`  node --env-file=<env file> scripts\\migrate-historical-gold.mjs --legacy-key ${a["legacy-key"]} --target ${a.target} --amount ${a.amount} --rollback --confirm ${a.expectedConfirm}`);
    return 0;
  }
  const keys = ["bb:rank", `bb:rk:${a.target}`, `bb:migration:hist:${a["legacy-key"]}`, ...ids.map((id) => `bb:tx:${id}`)];
  const r = (await redis.eval(ROLLBACK_SCRIPT, keys, [a["legacy-key"], a.target, a.amount, MIGRATION_ID, String(ids.length), ...ids])).map((v) => (v == null ? "" : String(v)));
  if (r[0] === "rolledback") { log(`RESULT: ROLLED BACK. Gold of ${a.target} is now ${fmt(Number(r[1]))}.`); return 0; }
  if (r[0] === "nothing") { log("RESULT: nothing to roll back (already rolled back). Nothing written."); return 0; }
  log(`RESULT: REFUSED by the database check (${r.slice(1).join(" ")}). Nothing written.`);
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(await main(process.argv.slice(2)));
