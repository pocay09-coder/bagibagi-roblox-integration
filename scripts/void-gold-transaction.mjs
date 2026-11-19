// Removes ONE transaction that was counted by mistake (for example a BagiBagi dashboard TEST that arrived like a real
// donation) from the v3 Gold data, exactly and reversibly. DRY-RUN by default: reads only, writes nothing.
// Windows (PowerShell), from the repo folder:
//   dry-run  : node --env-file=<env file> scripts\void-gold-transaction.mjs --tx <transaction id> --member u:<UserId> --amount <n>
//   apply    : (same) --apply --confirm <transaction id>
//   verify   : (same) --verify
//   rollback : (same) --rollback                        (plan only)   then  (same) --rollback --confirm <transaction id>
// What the apply does (one atomic Lua script, every check before the first write):
//   * Gold ranking: the amount is taken off the member (removed when it reaches 0; its metadata is set aside)
//   * the ledger row bb:tx:<id> stays as a TOMBSTONE (amount 0, status voided): the webhook keeps treating that id as a
//     duplicate forever, so a resend can never count it again
//   * the old-leaderboard copy (bb:donors / bb:donor:<key>) the webhook wrote for compatibility is taken off too
//   * the row is removed from bb:history (history board) and bb:feed
//   * bb:processed:<id> stays as it is; everything needed for an exact --rollback is kept in bb:void:<id>
// Prints amounts and ids only, never keys or tokens.
import { Redis } from "@upstash/redis";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

const UNUSED = "bb:void-unused";
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
`;

// KEYS: 1 bb:tx:<id> 2 bb:rank 3 bb:rk:<member> 4 bb:donors 5 bb:donor:<legacy> 6 bb:history 7 bb:feed
//       8 bb:void:<id> 9 bb:void:<id>:rk 10 bb:void:<id>:donor 11 bb:processed:<id>
// ARGV: 1 id 2 member 3 amount 4 legacy key ("" = none) 5 history row ("" = none) 6 feed row ("" = none) 7 now ms
const APPLY_SCRIPT = TYPE_FN + `
if #KEYS ~= 11 or #ARGV ~= 7 then return {'error', 'BBARGS'} end
local member, amount, legacy, hrow, frow = ARGV[2], ARGV[3], ARGV[4], ARGV[5], ARGV[6]
-- 1) idempotency
local rt = typeOf(KEYS[8])
if rt ~= 'none' then
  if rt ~= 'hash' then return {'error', 'BBTYPE record'} end
  if redis.call('HGET', KEYS[8], 'state') == 'done' then return {'already'} end
  return {'incomplete'}
end
-- 2) validate everything before the first write
if typeOf(KEYS[1]) ~= 'hash' then return {'error', 'BBNOTX'} end
local tx = redis.call('HMGET', KEYS[1], 'member', 'amount', 'status', 'legacy')
if tx[1] ~= member or tx[2] ~= amount then return {'error', 'BBMISMATCH'} end
local st = tx[3] or ''
if st == 'voided' or st == 'pending' or st == 'migrated' or st == 'migrating' then return {'error', 'BBSTATUS', st} end
if (tx[4] or '') ~= legacy then return {'error', 'BBLEGACY'} end
if not string.match(member, '^[un]:') then return {'error', 'BBMEMBER'} end
local n = tonumber(amount)
if not n or n <= 0 or n % 1 ~= 0 then return {'error', 'BBAMOUNT'} end
if typeOf(KEYS[2]) ~= 'zset' or not typeOk(KEYS[3], 'hash') or not typeOk(KEYS[4], 'zset') or not typeOk(KEYS[5], 'hash')
  or not typeOk(KEYS[6], 'list') or not typeOk(KEYS[7], 'zset') then return {'error', 'BBTYPE'} end
if typeOf(KEYS[9]) ~= 'none' or typeOf(KEYS[10]) ~= 'none' then return {'error', 'BBSPARE'} end
if typeOf(KEYS[11]) ~= 'string' then return {'error', 'BBNOMARKER'} end
local gold = tonumber(redis.call('ZSCORE', KEYS[2], member) or '-1')
if gold < n then return {'error', 'BBGOLD'} end
if legacy ~= '' then
  local old = tonumber(redis.call('ZSCORE', KEYS[4], legacy) or '-1')
  if old < n then return {'error', 'BBDONORS'} end
end
local hprev, hidx = '', -1
if hrow ~= '' then
  local all = redis.call('LRANGE', KEYS[6], 0, -1)
  for i = 1, #all do if all[i] == hrow then hidx = i - 1; if i > 1 then hprev = all[i - 1] end; break end end
  if hidx < 0 then return {'error', 'BBHISTORY'} end
end
local fscore = ''
if frow ~= '' then
  fscore = redis.call('ZSCORE', KEYS[7], frow)
  if not fscore then return {'error', 'BBFEED'} end
end
-- 3) writes: record first (state voiding), state done last
redis.call('HSET', KEYS[8], 'state', 'voiding', 'id', ARGV[1], 'member', member, 'amount', amount, 'legacy', legacy,
  'origStatus', st, 'historyRow', hrow, 'historyPrev', hprev, 'historyIndex', tostring(hidx), 'feedRow', frow,
  'feedScore', fscore, 'goldBefore', tostring(gold), 'startedAt', ARGV[7])
redis.call('HSET', KEYS[1], 'amount', '0', 'member', '', 'status', 'voided', 'legacy', '', 'origMember', member,
  'origAmount', amount, 'origStatus', st, 'origLegacy', legacy, 'voidedAt', ARGV[7])
local after = redis.call('ZINCRBY', KEYS[2], '-' .. amount, member)
local rankRemoved, rkMoved = '0', '0'
if tonumber(after) <= 0.0001 then
  redis.call('ZREM', KEYS[2], member); rankRemoved = '1'; after = '0'
  if typeOf(KEYS[3]) == 'hash' then redis.call('RENAME', KEYS[3], KEYS[9]); rkMoved = '1' end
end
local donorsRemoved, profileMoved = '0', '0'
if legacy ~= '' then
  local left = redis.call('ZINCRBY', KEYS[4], '-' .. amount, legacy)
  if tonumber(left) <= 0.0001 then
    redis.call('ZREM', KEYS[4], legacy); donorsRemoved = '1'
    if typeOf(KEYS[5]) == 'hash' then redis.call('RENAME', KEYS[5], KEYS[10]); profileMoved = '1' end
  end
end
if hrow ~= '' then redis.call('LREM', KEYS[6], 1, hrow) end
if frow ~= '' then redis.call('ZREM', KEYS[7], frow) end
redis.call('HSET', KEYS[8], 'rankRemoved', rankRemoved, 'rkMoved', rkMoved, 'donorsRemoved', donorsRemoved,
  'profileMoved', profileMoved, 'goldAfter', tostring(after), 'state', 'done', 'doneAt', ARGV[7])
return {'voided', tostring(gold), tostring(after)}
`;

// same KEYS as APPLY; ARGV: 1 id 2 member 3 amount
const ROLLBACK_SCRIPT = TYPE_FN + `
if #KEYS ~= 11 or #ARGV ~= 3 then return {'error', 'BBARGS'} end
if typeOf(KEYS[8]) == 'none' then return {'nothing'} end
if typeOf(KEYS[8]) ~= 'hash' then return {'error', 'BBTYPE record'} end
local r = redis.call('HMGET', KEYS[8], 'state', 'member', 'amount', 'legacy', 'origStatus', 'historyRow', 'historyPrev',
  'feedRow', 'feedScore', 'rkMoved', 'profileMoved')
if r[1] ~= 'done' then return {'error', 'BBINCOMPLETE'} end
if r[2] ~= ARGV[2] or r[3] ~= ARGV[3] then return {'error', 'BBMISMATCH'} end
if typeOf(KEYS[1]) ~= 'hash' or redis.call('HGET', KEYS[1], 'status') ~= 'voided' then return {'error', 'BBTOMBSTONE'} end
if typeOf(KEYS[2]) ~= 'none' and typeOf(KEYS[2]) ~= 'zset' then return {'error', 'BBTYPE'} end
local member, amount, legacy = r[2], r[3], r[4] or ''
redis.call('HSET', KEYS[1], 'amount', amount, 'member', member, 'status', r[5], 'legacy', legacy)
redis.call('HDEL', KEYS[1], 'origMember', 'origAmount', 'origStatus', 'origLegacy', 'voidedAt')
redis.call('ZINCRBY', KEYS[2], amount, member)
if r[10] == '1' and typeOf(KEYS[9]) == 'hash' then
  if typeOf(KEYS[3]) == 'none' then redis.call('RENAME', KEYS[9], KEYS[3]) else redis.call('DEL', KEYS[9]) end
end
if legacy ~= '' then
  redis.call('ZINCRBY', KEYS[4], amount, legacy)
  if r[11] == '1' and typeOf(KEYS[10]) == 'hash' then
    if typeOf(KEYS[5]) == 'none' then redis.call('RENAME', KEYS[10], KEYS[5]) else redis.call('DEL', KEYS[10]) end
  end
end
local hrow, hprev = r[6] or '', r[7] or ''
if hrow ~= '' then
  local placed = -1
  if hprev ~= '' then placed = redis.call('LINSERT', KEYS[6], 'AFTER', hprev, hrow) end
  if hprev == '' or placed == -1 or placed == 0 then redis.call('LPUSH', KEYS[6], hrow) end
end
if (r[8] or '') ~= '' then redis.call('ZADD', KEYS[7], r[9], r[8]) end
redis.call('DEL', KEYS[8])
return {'restored'}
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
const fmt = (n) => (Number.isFinite(Number(n)) ? Number(n).toLocaleString("en-US") : String(n));
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
    else if (["--tx", "--member", "--amount", "--confirm"].includes(k)) a[k.slice(2)] = String(argv[++i] ?? "");
    else return { error: `unknown argument ${k}` };
  }
  if (!/^[A-Za-z0-9_.:-]{3,120}$/.test(a.tx || "")) return { error: "--tx must be the transaction id (e.g. bagibagi-xxxxxxxx-...)" };
  if (!/^[un]:[A-Za-z0-9_-]{1,120}$/.test(a.member || "")) return { error: "--member must look like u:<UserId> (or n:<key>)" };
  if (!/^[1-9]\d{0,11}$/.test(a.amount || "")) return { error: "--amount must be a positive whole number" };
  if ([a.apply, a.verify, a.rollback].filter(Boolean).length > 1) return { error: "use only one of --apply / --verify / --rollback" };
  return a;
}
function keysFor(a, legacy) {
  return [`bb:tx:${a.tx}`, "bb:rank", `bb:rk:${a.member}`, "bb:donors", legacy ? `bb:donor:${legacy}` : `${UNUSED}:donor`,
    "bb:history", "bb:feed", `bb:void:${a.tx}`, `bb:void:${a.tx}:rk`, `bb:void:${a.tx}:donor`, `bb:processed:${a.tx}`];
}
async function readState(redis, a) {
  const s = {};
  s.tx = hashObject(await redis.hgetall(`bb:tx:${a.tx}`));
  s.record = hashObject(await redis.hgetall(`bb:void:${a.tx}`));
  s.marker = await redis.get(`bb:processed:${a.tx}`);
  s.legacy = s.record ? s.record.legacy || "" : (s.tx ? s.tx.legacy || "" : "");
  const rank = (await redis.zrange("bb:rank", 0, -1, { withScores: true })).map(String);
  s.gold = 0; s.ranked = false;
  for (let i = 0; i < rank.length; i += 2) if (rank[i] === a.member) { s.gold = Number(rank[i + 1]); s.ranked = true; }
  const donors = (await redis.zrange("bb:donors", 0, -1, { withScores: true })).map(String);
  s.donors = null;
  for (let i = 0; i < donors.length; i += 2) if (s.legacy && donors[i] === s.legacy) s.donors = Number(donors[i + 1]);
  s.historyRow = ""; s.historyRows = 0;
  for (const row of (await redis.lrange("bb:history", 0, -1)).map(String)) {
    let j = null; try { j = JSON.parse(row); } catch {}
    if (j && j.id === a.tx) { s.historyRows++; if (!s.historyRow) s.historyRow = row; }
  }
  s.feedRow = ""; s.feedRows = 0;
  const feed = (await redis.zrange("bb:feed", 0, -1)).map(String);
  for (const row of feed) {
    let j = null; try { j = JSON.parse(row); } catch {}
    if (j && j.id === a.tx) { s.feedRows++; if (!s.feedRow) s.feedRow = row; }
  }
  return s;
}

export async function main(argv, log = console.log) {
  const a = parseArgs(argv);
  if (a.error) { log(`usage error: ${a.error}`); return 2; }
  if ((a.apply || (a.rollback && a.confirm)) && a.confirm !== a.tx) {
    log(`Refusing to ${a.apply ? "apply" : "roll back"}: add --confirm ${a.tx} (exactly).`);
    return 2;
  }
  const redis = Redis.fromEnv({ automaticDeserialization: false });
  try {
    const s = await readState(redis, a);
    const mode = a.apply ? "APPLY" : a.verify ? "VERIFY" : a.rollback ? (a.confirm ? "ROLLBACK" : "ROLLBACK PLAN") : "DRY-RUN";
    const status = !s.record ? "NOT VOIDED" : s.record.state === "done" ? "VOIDED" : "INCOMPLETE";
    log(`AFTERBEAT void of one Gold transaction - ${mode}${mode === "DRY-RUN" || mode === "VERIFY" || mode === "ROLLBACK PLAN" ? " (reads only, writes nothing)" : ""}`);
    log(`database fingerprint : ${dbFingerprint()}   (compare with dbFingerprint of GET /api/roblox)`);
    log(`transaction          : ${a.tx}   status: ${status}`);
    log(`ledger row           : ${s.tx ? `member ${s.tx.member || "-"}  amount ${fmt(s.tx.amount)}  status ${s.tx.status}${s.tx.name ? `  name "${s.tx.name}"` : ""}` : "MISSING"}`);
    log(`member Gold now      : ${a.member} = ${fmt(s.gold)}${s.ranked ? "" : " (not ranked)"}`);
    log(`old leaderboard copy : ${s.legacy ? `bb:donors ${s.legacy} = ${s.donors === null ? "-" : fmt(s.donors)}` : "(none)"}`);
    log(`history / feed rows  : ${s.historyRows} / ${s.feedRows}`);
    log(`webhook marker       : ${s.marker == null ? "MISSING" : String(s.marker).split("|")[0]} (kept)`);

    if (a.verify) {
      const ok = status === "VOIDED" && s.tx && s.tx.status === "voided" && s.historyRows === 0 && s.feedRows === 0;
      log(ok ? "RESULT: VOIDED and clean (tombstone kept, not in Gold / history / feed)." : `RESULT: ${status}${status === "VOIDED" ? " but something is left - see above" : ""}.`);
      return ok || status === "NOT VOIDED" ? 0 : 1;
    }
    if (a.rollback) {
      if (!s.record) { log("RESULT: nothing to roll back. Nothing written."); return 0; }
      log(`rollback restores     : Gold ${a.member} ${fmt(s.gold)} -> ${fmt(s.gold + Number(a.amount))}, the ledger row, the history / feed row and the old-leaderboard copy`);
      if (!a.confirm) { log(`RESULT: ROLLBACK PLAN only. To roll back: (same) --rollback --confirm ${a.tx}`); return 0; }
      const r = (await redis.eval(ROLLBACK_SCRIPT, keysFor(a, s.legacy), [a.tx, a.member, a.amount])).map((v) => (v == null ? "" : String(v)));
      if (r[0] === "restored") { log("RESULT: ROLLED BACK - the transaction counts again exactly as before."); return 0; }
      if (r[0] === "nothing") { log("RESULT: nothing to roll back. Nothing written."); return 0; }
      log(`RESULT: REFUSED by the database check (${r.slice(1).join(" ")}). Nothing written.`);
      return 1;
    }
    if (status === "VOIDED") { log("RESULT: ALREADY VOIDED - nothing to do, nothing written."); return 0; }
    if (status === "INCOMPLETE") { log("RESULT: INCOMPLETE record found - nothing written. Check it by hand."); return 1; }

    const checks = [
      [!!s.tx, "ledger row exists"],
      [!!s.tx && s.tx.member === a.member, `ledger member is ${a.member}`],
      [!!s.tx && s.tx.amount === a.amount, `ledger amount is ${fmt(a.amount)}`],
      [!!s.tx && !["voided", "pending", "migrated", "migrating"].includes(s.tx.status), "ledger status can be voided (not pending / migrated / voided)"],
      [s.gold >= Number(a.amount), `member Gold (${fmt(s.gold)}) covers the amount`],
      [!s.legacy || (s.donors !== null && s.donors >= Number(a.amount)), "old-leaderboard copy covers the amount"],
      [s.historyRows <= 1 && s.feedRows <= 1, "at most one history row and one feed row"],
      [s.marker != null, "webhook marker exists (the transaction really went through the webhook)"],
    ];
    log(`after the void       : Gold ${a.member} ${fmt(s.gold)} -> ${fmt(Math.max(0, s.gold - Number(a.amount)))}${s.gold - Number(a.amount) <= 0 ? " (removed from the ranking)" : ""}`);
    log("checks:");
    for (const [ok, t] of checks) log(`  ${ok ? "OK  " : "FAIL"} ${t}`);
    if (!checks.every(([ok]) => ok)) { log("RESULT: REFUSED - fix the FAIL lines first. Nothing written."); return 1; }
    if (!a.apply) {
      log(`RESULT: READY. Nothing written. To apply once: (same) --apply --confirm ${a.tx}`);
      return 0;
    }
    const r = (await redis.eval(APPLY_SCRIPT, keysFor(a, s.legacy), [a.tx, a.member, a.amount, s.legacy, s.historyRow, s.feedRow, String(Date.now())]))
      .map((v) => (v == null ? "" : String(v)));
    if (r[0] === "voided") { log(`RESULT: VOIDED once. Gold of ${a.member}: ${fmt(r[1])} -> ${fmt(r[2])}. Run the same command with --verify.`); return 0; }
    if (r[0] === "already") { log("RESULT: ALREADY VOIDED (by another run) - nothing written."); return 0; }
    log(`RESULT: REFUSED by the database check (${r.slice(1).join(" ")}). Nothing written.`);
    return 1;
  } catch (e) {
    log(`ERROR: ${String(e?.message || e).slice(0, 120)}`);
    log("The outcome of a write that was in flight is unknown: run --verify first (a repeated --apply is safe, it never voids twice).");
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(await main(process.argv.slice(2)));
