import { Redis } from "@upstash/redis";
import { createHmac, timingSafeEqual } from "node:crypto";
import { usernameCandidate, lookupUsernames } from "../lib/roblox-users.js";

// BagiBagi -> AFTERBEAT webhook, v3 (v2.1 + Gold Donation ranking).
// v3: the donor name is treated as a Roblox USERNAME. Found -> counted for that UserId (USERNAME_MATCHED, like a
// gift: NOT proof of who paid). Not found -> counted under the name (UNMATCHED). Roblox API down / rate-limited ->
// counted under the name and marked PENDING; api/roblox.js retries and moves it atomically. Every valid donation is
// counted exactly once in bb:rank (Top 50 / ROYAL), with a per-transaction ledger bb:tx:<id>.
// Everything v2.1 wrote is still written (feed, history, bb:donors, link codes) so older readers / rollback work.
// All writes for one transaction happen in ONE Lua script. Rules that keep it safe on Upstash Redis REST:
//   * every key the script touches is passed in KEYS (dynamic keys are read first, then declared and re-checked
//     inside the script); no undeclared keys, no error_reply, plain string arguments only
//   * every type / value is validated BEFORE the first write; after that only commands that cannot fail on a
//     validated key are used
//   * Redis Lua has no rollback, so the transaction marker is the FIRST write ("pending|...") and is switched to
//     "done|..." as the LAST write. If the database ever rejects a write in between (e.g. a size limit), the
//     transaction stays "pending": it is never counted twice (retries see it as stored) and
//     scripts/check-consistency.mjs lists it for a manual check.
const redis = Redis.fromEnv({ automaticDeserialization: false });

const FEED_MAX = 500;
const HISTORY_MAX = 100;
const PROCESSED_TTL = 60 * 60 * 24 * 365;
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // same as Roblox: no I, L, O, 0, 1
// Anything code-shaped is removed from the stored message (valid or not): a link code never reaches the feed,
// history, leaderboard, alerts or logs.
const CODE_TOKEN = /AFB[\s_-]?([A-Za-z0-9]{4})[\s_-]?([A-Za-z0-9]{4})/i;
const CODE_TOKEN_ALL = new RegExp(CODE_TOKEN.source, "gi");
const UNUSED = "bb:unused"; // declared placeholder for keys a donation does not need (never read or written)

// KEYS: 1 processed  2 feed  3 feed:last  4 history  5 donors  6 avatar hash  7 code key  8 pending(uid)
//       9 avatar user set(uid)  10 profile(name)  11 profile(donor id)  12 profile(account)  13 last link(uid)
//       v3: 14 bb:rank  15 bb:tx:<id>  16 rank hash of the code account  17 rank hash of the matched account
//           18 rank hash of the name  19 bb:rbx:pending
// ARGV: 1 txId  2 member JSON prefix  3 now ms  4 amount  5 name key  6 display name  7 @username (display only)
//       8 donor id key or ""  9 code hash or ""  10 uid read from the code key or ""  11 ttl  12 feed max
//       13 history max  14 masked name for the link record
//       v3: 15 match status (matched|unmatched|pending)  16 matched UserId or ""  17 username  18 display name
//           19 rank name key  20 JSON fragment with username/displayName ("" if none)  21 username candidate
const INGEST_SCRIPT = `
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
  if not n or n ~= n or n <= 0 or n % 1 ~= 0 or n > max then return nil end
  return n
end
-- 1) idempotency (also respects markers written by the old v1 webhook; the v3 ledger never expires)
if redis.call('EXISTS', KEYS[1]) == 1 or redis.call('EXISTS', KEYS[15]) == 1 then return {'duplicate'} end
-- 2) validate every value and key type BEFORE the first write
local amount = posInt(ARGV[4], 1e12)
local now = posInt(ARGV[3], 1e14)
local ttl, feedMax, histMax = posInt(ARGV[11], 1e9), posInt(ARGV[12], 1e6), posInt(ARGV[13], 1e6)
if not amount or not now or not ttl or not feedMax or not histMax then return {'error', 'BBARG'} end
if not typeOk(KEYS[2], 'zset') then return {'error', 'BBTYPE feed'} end
if not typeOk(KEYS[3], 'string') then return {'error', 'BBTYPE feed:last'} end
if not typeOk(KEYS[4], 'list') then return {'error', 'BBTYPE history'} end
if not typeOk(KEYS[5], 'zset') then return {'error', 'BBTYPE donors'} end
if not typeOk(KEYS[6], 'hash') then return {'error', 'BBTYPE avatar'} end
if not typeOk(KEYS[14], 'zset') then return {'error', 'BBTYPE rank'} end
if not typeOk(KEYS[19], 'zset') then return {'error', 'BBTYPE pendingset'} end
for i = 16, 18 do
  if not typeOk(KEYS[i], 'hash') then return {'error', 'BBTYPE rankhash'} end
end
local last = redis.call('GET', KEYS[3])
if last then
  last = tonumber(last)
  if not last or last ~= last then return {'error', 'BBVALUE feed:last'} end
else
  local top = redis.call('ZREVRANGE', KEYS[2], 0, 0, 'WITHSCORES')
  last = tonumber(top[2]) or 0
end
-- one-time code: still present AND still pointing at the account read before the script
local uid = false
if ARGV[9] ~= '' and ARGV[10] ~= '' then
  if not typeOk(KEYS[7], 'string') then return {'error', 'BBTYPE code'} end
  if redis.call('GET', KEYS[7]) == ARGV[10] then uid = ARGV[10] end
end
if uid then
  if not typeOk(KEYS[8], 'string') then return {'error', 'BBTYPE pending'} end
  if not typeOk(KEYS[9], 'set') then return {'error', 'BBTYPE userset'} end
  if not typeOk(KEYS[13], 'hash') then return {'error', 'BBTYPE lastlink'} end
end
-- 3) identity: stable donor id (if BagiBagi sends one) > verified account (one-time code) > name
local donorKey, identity, profileKey
if ARGV[8] ~= '' then donorKey = ARGV[8]; identity = 'donor'; profileKey = KEYS[11]
elseif uid then donorKey = 'uid:' .. uid; identity = 'account'; profileKey = KEYS[12]
else donorKey = ARGV[5]; identity = 'name'; profileKey = KEYS[10] end
if not typeOk(profileKey, 'hash') then return {'error', 'BBTYPE profile'} end
local avatar = uid
if not avatar and identity == 'donor' then avatar = redis.call('HGET', KEYS[6], donorKey) end
if avatar and not string.match(avatar, '^%d+$') then avatar = false end
-- v3 ranking member: legacy code account > username match > name (UNMATCHED / PENDING)
local member, rankKey, txStatus, matchedUid
if uid then member = 'u:' .. uid; rankKey = KEYS[16]; txStatus = 'code'; matchedUid = uid
elseif ARGV[15] == 'matched' and string.match(ARGV[16], '^%d+$') then
  member = 'u:' .. ARGV[16]; rankKey = KEYS[17]; txStatus = 'matched'; matchedUid = ARGV[16]
else
  member = 'n:' .. ARGV[19]; rankKey = KEYS[18]; txStatus = (ARGV[15] == 'pending') and 'pending' or 'unmatched'; matchedUid = false
end
-- 4) unique, strictly increasing feed score in commit order (ms + 0.001 steps)
local score = now
if score <= last then score = last + 0.001 end
local scoreStr = string.format('%.3f', score)
local receivedAt = string.format('%.0f', math.floor(score))
local extra = ',"match":"' .. txStatus .. '","matchedUserId":' .. (matchedUid or 'null')
if txStatus == 'matched' then extra = extra .. ARGV[20] end
local feedRow = ARGV[2] .. ',"receivedAt":' .. receivedAt .. ',"robloxUserId":' .. (avatar or 'null') .. ',"identity":"' .. identity .. '"' .. extra .. '}'
local info = identity .. '|' .. ARGV[4] .. '|' .. scoreStr
-- 5) writes. FIRST the marker (pending), LAST the marker (done).
redis.call('SET', KEYS[1], 'pending|' .. info, 'EX', ttl)
if uid then
  redis.call('DEL', KEYS[7])
  if redis.call('GET', KEYS[8]) == ARGV[9] then redis.call('DEL', KEYS[8]) end
  redis.call('HSET', KEYS[6], donorKey, uid)
  redis.call('SADD', KEYS[9], donorKey)
  redis.call('HSET', KEYS[13], 'tx', ARGV[1], 'at', receivedAt, 'amount', ARGV[4], 'name', ARGV[14])
end
redis.call('ZINCRBY', KEYS[5], ARGV[4], donorKey)
redis.call('HSET', profileKey, 'name', ARGV[6], 'robloxUsername', ARGV[7], 'identity', identity)
redis.call('SET', KEYS[3], scoreStr)
redis.call('ZADD', KEYS[2], scoreStr, feedRow)
redis.call('ZREMRANGEBYRANK', KEYS[2], 0, -(feedMax + 1))
redis.call('LPUSH', KEYS[4], feedRow)
redis.call('LTRIM', KEYS[4], 0, histMax - 1)
-- v3 ranking + ledger (counted exactly once; PENDING can later be moved by api/roblox.js)
redis.call('HSET', KEYS[15], 'amount', ARGV[4], 'member', member, 'status', txStatus, 'name', ARGV[6], 'cand', ARGV[21], 'at', receivedAt, 'legacy', donorKey)
redis.call('ZINCRBY', KEYS[14], ARGV[4], member)
if matchedUid then
  redis.call('HSET', rankKey, 'lastName', ARGV[6])
  if txStatus == 'matched' then
    redis.call('HSET', rankKey, 'username', ARGV[17], 'displayName', ARGV[18], 'refreshedAt', ARGV[3], 'banned', '0')
  else
    redis.call('HSETNX', rankKey, 'refreshedAt', '0')
  end
else
  redis.call('HSET', rankKey, 'name', ARGV[6])
  if txStatus == 'pending' then
    redis.call('HINCRBY', rankKey, 'pending', 1)
    redis.call('ZADD', KEYS[19], now, ARGV[1])
  end
end
redis.call('SET', KEYS[1], 'done|' .. info, 'EX', ttl)
return {'accepted', identity, txStatus}
`;

function reply(res, status, data) {
  return res.status(status).json(data);
}

function cleanText(value, maxLength) {
  return String(value ?? "")
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .trim()
    .slice(0, maxLength);
}

function validSignature(body, token, signature) {
  if (typeof signature !== "string" || !/^[a-f0-9]{64}$/i.test(signature)) {
    return false;
  }

  // This follows BagiBagi's documented Node.js example:
  // HMAC-SHA256(JSON.stringify(parsedBody), webhookToken).
  const expected = createHmac("sha256", token)
    .update(JSON.stringify(body))
    .digest();

  const received = Buffer.from(signature, "hex");
  return received.length === expected.length &&
    timingSafeEqual(received, expected);
}

// One-time link code from the message -> keyed hash (the code itself is never stored or logged).
export function linkCodeHash(message) {
  const secret = process.env.LINK_CODE_SECRET;
  if (!secret) return "";
  const m = String(message || "").match(CODE_TOKEN);
  if (!m) return "";
  const code = `AFB-${m[1].toUpperCase()}-${m[2].toUpperCase()}`;
  for (const ch of code.slice(4).replace("-", "")) {
    if (!CODE_ALPHABET.includes(ch)) return "";
  }
  return createHmac("sha256", secret).update(code).digest("hex");
}

// OPTIONAL stable donor id - only when BagiBagi really sends a stable per-donor field (check with
// LOG_WEBHOOK_KEYS=1, which logs field NAMES only). Only a keyed hash is stored, never the raw value.
function stableDonorKey(body) {
  const field = process.env.DONOR_ID_FIELD;
  const secret = process.env.DONOR_ID_SECRET;
  if (!field || !secret) return "";
  const raw = cleanText(body[field], 200).toLowerCase();
  if (!raw) return "";
  return "id:" + createHmac("sha256", secret).update(raw).digest("hex").slice(0, 32);
}

function maskName(name) {
  const chars = Array.from(String(name || ""));
  return chars.length ? chars.slice(0, 2).join("") + "***" : "***";
}

// ===== TEST webhooks (v3.1) =====
// A signed webhook marked as a test ("test": true / "is_test": true / "isTest": true, or - outside production only -
// transaction_id "test-...")
// is NOT a donation: it is kept for 15 minutes in bb:testfeed only, so Roblox can play the full alert once with a
// [TEST] label. It never touches bb:processed, bb:tx, bb:rank, bb:donors, bb:history, bb:feed or link codes.
// Production ignores test webhooks unless ALLOW_TEST_WEBHOOKS=1.
const TEST_TTL_SECONDS = 15 * 60;
const TEST_MAX = 50;
const TEST_SCRIPT = `
local function typeOf(k) local t = redis.call('TYPE', k) if type(t) == 'table' then t = t.ok or t['ok'] end return t end
local t1, t2 = typeOf(KEYS[1]), typeOf(KEYS[2])
if (t1 ~= 'zset' and t1 ~= 'none') or (t2 ~= 'string' and t2 ~= 'none') then return {'error'} end
if redis.call('EXISTS', KEYS[2]) == 1 then return {'duplicate'} end
redis.call('SET', KEYS[2], '1', 'EX', ARGV[3])
redis.call('ZADD', KEYS[1], ARGV[1], ARGV[2])
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', '(' .. ARGV[4])
redis.call('ZREMRANGEBYRANK', KEYS[1], 0, -(tonumber(ARGV[5]) + 1))
redis.call('EXPIRE', KEYS[1], ARGV[3])
return {'accepted'}
`;
export function isTestWebhook(body, transactionId) {
  if (body.test === true || body.is_test === true || body.isTest === true) return true;
  // the "test-" id prefix only counts outside production: a real BagiBagi id can never be dropped from the ranking
  return process.env.VERCEL_ENV !== "production" && /^test-/i.test(String(transactionId || ""));
}

// GROSS amount (before the BagiBagi fee). Default field "amount"; AMOUNT_FIELD can name another top-level field (or
// a dotted path like "data.gross_amount") once a real webhook shows which field is the gross amount.
export function grossAmount(body) {
  const field = /^[A-Za-z0-9_]{1,40}(\.[A-Za-z0-9_]{1,40}){0,2}$/.test(process.env.AMOUNT_FIELD || "") ? process.env.AMOUNT_FIELD : "amount";
  let v = body;
  for (const part of field.split(".")) v = v && typeof v === "object" ? v[part] : undefined;
  if (typeof v === "string" && /^\d{1,13}(\.0+)?$/.test(v.trim())) v = Number(v.trim());
  return typeof v === "number" ? v : NaN;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return reply(res, 405, { error: "Method not allowed" });
  }

  const webhookToken = process.env.BAGIBAGI_WEBHOOK_TOKEN;
  if (!webhookToken) {
    return reply(res, 500, { error: "Webhook is not configured" });
  }

  const body = req.body;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return reply(res, 400, { error: "Invalid JSON body" });
  }

  const signature = req.headers["x-bagibagi-signature"];
  if (!validSignature(body, webhookToken, signature)) {
    return reply(res, 401, { error: "Invalid BagiBagi signature" });
  }

  if (process.env.LOG_WEBHOOK_KEYS === "1") {
    console.log("BagiBagi webhook keys:", Object.keys(body).sort().join(","));
    // numbers of amount-like fields only (never names, messages or ids): shows which field is the GROSS amount
    const nums = Object.entries(body)
      .filter(([k, v]) => /amount|total|gross|net|fee|nominal|price/i.test(k) && (typeof v === "number" || /^\d{1,13}(\.\d+)?$/.test(String(v))))
      .map(([k, v]) => `${k}=${v}`);
    if (nums.length) console.log("BagiBagi webhook amount fields:", nums.join(","));
  }

  const transactionId = cleanText(body.transaction_id, 120);
  const donorName = cleanText(body.name, 40) || "Donatur";
  const amount = grossAmount(body); // GROSS amount (AMOUNT_FIELD, default "amount")
  const rawMessage = cleanText(body.message, 180);

  if (!transactionId || !Number.isSafeInteger(amount) || amount <= 0) {
    return reply(res, 400, { error: "Invalid transaction fields" });
  }

  // a staging smoke test must never write into production (defence in depth: production uses other secrets too)
  if (process.env.VERCEL_ENV === "production" && /^smoke-/i.test(transactionId)) {
    return reply(res, 200, { ok: true, ignored: "test transaction" });
  }

  // TEST webhook: alert only, never counted (see TEST_SCRIPT above)
  if (isTestWebhook(body, transactionId)) {
    if (process.env.VERCEL_ENV === "production" && process.env.ALLOW_TEST_WEBHOOKS !== "1") {
      return reply(res, 200, { ok: true, ignored: "test webhook (production)" });
    }
    const now = Date.now();
    const row = JSON.stringify({
      id: transactionId, name: donorName, amount,
      message: rawMessage.replace(CODE_TOKEN_ALL, " ").replace(/\s+/g, " ").trim(),
      receivedAt: now, test: true
    });
    try {
      const r = await redis.eval(TEST_SCRIPT, ["bb:testfeed", `bb:testseen:${transactionId}`],
        [String(now), row, String(TEST_TTL_SECONDS), String(now - TEST_TTL_SECONDS * 1000), String(TEST_MAX)]);
      const status = Array.isArray(r) ? String(r[0]) : "error";
      if (status === "error") return reply(res, 500, { error: "Test storage has a wrong type" });
      return reply(res, 200, { ok: true, test: true, [status]: true });
    } catch (e) {
      console.error("Test webhook storage error:", String(e?.message || e).slice(0, 80));
      return reply(res, 500, { error: "Could not store test webhook" });
    }
  }

  const codeHash = linkCodeHash(rawMessage);
  const message = rawMessage.replace(CODE_TOKEN_ALL, " ").replace(/\s+/g, " ").trim();
  // display only; AFTERBEAT never uses @username as proof of account ownership
  const usernameMatch = message.match(/(?:^|\s)@([A-Za-z0-9_]{3,20})(?=$|\s)/);
  const robloxUsername = usernameMatch ? usernameMatch[1] : "";
  const nameKey = Buffer.from(donorName.toLowerCase(), "utf8").toString("base64url");
  const donorKeyId = stableDonorKey(body);

  // v3: name -> Roblox username (never DisplayName). Any problem = PENDING, the donation is still counted.
  const rankName = Buffer.from(donorName.normalize("NFC").trim().replace(/\s+/g, " ").toLowerCase(), "utf8").toString("base64url");
  const cand = process.env.USERNAME_MATCH === "1" ? usernameCandidate(donorName) : null;
  let match = { status: "unmatched", id: "", name: "", displayName: "" };
  if (cand) {
    try {
      const found = (await lookupUsernames(redis, [cand])).get(cand.toLowerCase());
      if (found === undefined) match.status = "pending";
      else if (found) match = { status: "matched", id: String(found.id), name: found.name, displayName: found.displayName };
    } catch {
      match.status = "pending";
    }
  }
  const matchFragment = match.status === "matched"
    ? `,"username":${JSON.stringify(match.name)},"displayName":${JSON.stringify(match.displayName)}`
    : "";

  // receivedAt / robloxUserId / identity are added inside the script (atomic, commit order)
  const memberPrefix = JSON.stringify({
    id: transactionId,
    name: donorName,
    amount,
    message,
    robloxUsername: robloxUsername || null,
    createdAt: cleanText(body.created_at, 60)
  }).slice(0, -1);

  try {
    // read the code key first so the script can DECLARE the account keys; the script re-checks it atomically
    const codeKey = codeHash ? `bb:link:code:${codeHash}` : `${UNUSED}:code`;
    let candidate = "";
    if (codeHash) {
      const v = await redis.get(codeKey);
      if (v !== null && v !== undefined && /^\d{1,15}$/.test(String(v))) candidate = String(v);
    }
    const result = await redis.eval(
      INGEST_SCRIPT,
      [
        `bb:processed:${transactionId}`, "bb:feed", "bb:feed:last", "bb:history", "bb:donors", "bb:avatar", codeKey,
        candidate ? `bb:link:pending:${candidate}` : `${UNUSED}:pending`,
        candidate ? `bb:avatar:user:${candidate}` : `${UNUSED}:userset`,
        `bb:donor:${nameKey}`,
        donorKeyId ? `bb:donor:${donorKeyId}` : `${UNUSED}:profile:donor`,
        candidate ? `bb:donor:uid:${candidate}` : `${UNUSED}:profile:account`,
        candidate ? `bb:link:last:${candidate}` : `${UNUSED}:lastlink`,
        "bb:rank", `bb:tx:${transactionId}`,
        candidate ? `bb:rk:u:${candidate}` : `${UNUSED}:rk:code`,
        match.status === "matched" ? `bb:rk:u:${match.id}` : `${UNUSED}:rk:match`,
        `bb:rk:n:${rankName}`, "bb:rbx:pending"
      ],
      [
        transactionId, memberPrefix, String(Date.now()), String(amount), nameKey, donorName, robloxUsername,
        donorKeyId, codeHash, candidate, String(PROCESSED_TTL), String(FEED_MAX), String(HISTORY_MAX), maskName(donorName),
        match.status, match.id, match.name, match.displayName, rankName, matchFragment, cand ? cand.toLowerCase() : ""
      ]
    );
    const status = Array.isArray(result) ? String(result[0]) : String(result);
    if (status === "duplicate") return reply(res, 200, { ok: true, duplicate: true });
    if (status === "accepted") return reply(res, 200, { ok: true, accepted: true });
    // validation refused (nothing written): log the code only, never the body / message
    console.error("BagiBagi webhook refused:", Array.isArray(result) ? String(result[1]).slice(0, 60) : "unknown");
    return reply(res, 500, { error: "Could not store donation" });
  } catch (error) {
    // Network error / timeout: the script either ran completely or not at all -> BagiBagi may retry safely.
    console.error("BagiBagi webhook storage error:", String(error?.message || error).slice(0, 120));
    return reply(res, 500, { error: "Could not store donation" });
  }
}
