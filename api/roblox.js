import { Redis } from "@upstash/redis";
import { createHmac, randomInt, timingSafeEqual } from "node:crypto";

// AFTERBEAT feed for Roblox game servers, v2.1 (backward compatible with v1 clients).
//   GET  ?since=<ms>        donations with receivedAt >= since (oldest first, max 100), like v1
//   GET  ?after=<cursor>    donations strictly after a cursor (exact paging, also many rows in one ms)
//   POST {action, userId}   one-time link codes for Auto Avatar: "create" | "status" | "unlink"
// Called ONLY by Roblox game servers (x-api-key). The game server must always send the UserId of the player who
// pressed the button (Player.UserId from the RemoteFunction), never a UserId typed by a client.
// Upstash REST rule: every key a Lua script touches is passed in KEYS.
const redis = Redis.fromEnv({ automaticDeserialization: false });

const PAGE_LIMIT = 100;
const TOP_LIMIT = 10;
const TOP_SCAN = 20; // read more, because entries of the same verified account are merged
const HISTORY_LIMIT = 20;
const FEED_MAX = 500; // must match webhook.js
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CREATE_LIMIT_PER_HOUR = 10;
const UNUSED = "bb:unused";

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

// KEYS: 1 feed 2 donors 3 history   ARGV: 1 min score 2 page limit 3 top count 4 history count
const READ_FEED_SCRIPT = TYPE_FN + `
if not typeOk(KEYS[1], 'zset') or not typeOk(KEYS[2], 'zset') or not typeOk(KEYS[3], 'list') then return {'error'} end
local rows = redis.call('ZRANGEBYSCORE', KEYS[1], ARGV[1], '+inf', 'WITHSCORES', 'LIMIT', 0, tonumber(ARGV[2]))
local top = redis.call('ZREVRANGE', KEYS[2], 0, tonumber(ARGV[3]) - 1, 'WITHSCORES')
local hist = redis.call('LRANGE', KEYS[3], 0, tonumber(ARGV[4]) - 1)
local oldest = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')
return {'ok', rows, top, hist, oldest[2] or false, redis.call('ZCARD', KEYS[1])}
`;

// KEYS: 1 avatar hash, 2.. profile keys   ARGV: identity keys (same order as profile keys)
const READ_PROFILES_SCRIPT = TYPE_FN + `
local avOk = typeOk(KEYS[1], 'hash')
local out = {}
for i = 2, #KEYS do
  local prof = {false, false, false}
  if typeOf(KEYS[i]) == 'hash' then prof = redis.call('HMGET', KEYS[i], 'name', 'robloxUsername', 'identity') end
  local av = false
  if avOk then av = redis.call('HGET', KEYS[1], ARGV[i - 1]) end
  out[#out + 1] = {prof[1] or false, prof[2] or false, prof[3] or false, av or false}
end
return out
`;

// KEYS: 1 pending  2 new code key  3 rate key  4 old code key (or placeholder)
// ARGV: 1 uid  2 new hash  3 ttl  4 max per hour  5 old hash read before ("" = none)
const CREATE_SCRIPT = TYPE_FN + `
for i = 1, 4 do if not typeOk(KEYS[i], 'string') then return {'error'} end end
if (redis.call('GET', KEYS[1]) or '') ~= ARGV[5] then return {'retry'} end
local n = redis.call('INCR', KEYS[3])
if n == 1 then redis.call('EXPIRE', KEYS[3], 3600) end
if n > tonumber(ARGV[4]) then return {'rate'} end
if ARGV[5] ~= '' then redis.call('DEL', KEYS[4]) end
redis.call('SET', KEYS[2], ARGV[1], 'EX', tonumber(ARGV[3]))
redis.call('SET', KEYS[1], ARGV[2], 'EX', tonumber(ARGV[3]))
return {'ok'}
`;

// KEYS: 1 user set  2 pending  3 last link
const STATUS_SCRIPT = TYPE_FN + `
local n = 0
if typeOf(KEYS[1]) == 'set' then n = redis.call('SCARD', KEYS[1]) end
local last = {false, false, false}
if typeOf(KEYS[3]) == 'hash' then last = redis.call('HMGET', KEYS[3], 'at', 'amount', 'name') end
return {n, redis.call('PTTL', KEYS[2]), last[1] or false, last[2] or false, last[3] or false}
`;

// KEYS: 1 user set  2 avatar hash  3 pending  4 pending code key (or placeholder)  5 last link
// ARGV: 1 uid  2 pending hash read before ("" = none)
const UNLINK_SCRIPT = TYPE_FN + `
if not typeOk(KEYS[1], 'set') or not typeOk(KEYS[2], 'hash') or not typeOk(KEYS[3], 'string') then return {'error'} end
if (redis.call('GET', KEYS[3]) or '') ~= ARGV[2] then return {'retry'} end
local removed = 0
for _, key in ipairs(redis.call('SMEMBERS', KEYS[1])) do
  if redis.call('HGET', KEYS[2], key) == ARGV[1] then
    redis.call('HDEL', KEYS[2], key)
    removed = removed + 1
  end
end
redis.call('DEL', KEYS[1])
if ARGV[2] ~= '' then redis.call('DEL', KEYS[4]) end
redis.call('DEL', KEYS[3])
redis.call('DEL', KEYS[5])
return {'ok', removed}
`;

function reply(res, status, data) {
  return res.status(status).json(data);
}

function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const aa = Buffer.from(a);
  const bb = Buffer.from(b);
  return aa.length === bb.length && timingSafeEqual(aa, bb);
}

function parseDonation(value) {
  try {
    return typeof value === "string" ? JSON.parse(value) : value;
  } catch {
    return null;
  }
}

function toUserId(v) {
  const s = String(v ?? "");
  return /^\d{1,15}$/.test(s) && Number(s) > 0 ? Number(s) : null;
}

function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  try { return JSON.parse(req.body || "{}"); } catch { return {}; }
}

function newCode() {
  let s = "";
  for (let i = 0; i < 8; i++) s += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return `AFB-${s.slice(0, 4)}-${s.slice(4)}`;
}

function codeTtl() {
  const t = Number(process.env.LINK_CODE_TTL_SECONDS || 1800);
  return Math.min(86400, Math.max(60, Number.isFinite(t) ? Math.floor(t) : 1800));
}

const pendingHash = async (uid) => {
  const v = await redis.get(`bb:link:pending:${uid}`);
  return v === null || v === undefined ? "" : String(v);
};
const codeKeyOf = (hash) => (hash ? `bb:link:code:${hash}` : `${UNUSED}:code`);

async function handleLink(req, res) {
  const secret = process.env.LINK_CODE_SECRET;
  if (!secret) return reply(res, 503, { error: "Linking is not configured" });
  const body = readBody(req);
  const uid = toUserId(body.userId);
  if (!uid) return reply(res, 400, { error: "Invalid userId" });
  const action = String(body.action || "");

  if (action === "create") {
    const code = newCode();
    const hash = createHmac("sha256", secret).update(code).digest("hex");
    const ttl = codeTtl();
    for (let attempt = 0; attempt < 3; attempt++) {
      const old = await pendingHash(uid);
      const r = await redis.eval(CREATE_SCRIPT,
        [`bb:link:pending:${uid}`, `bb:link:code:${hash}`, `bb:link:rate:${uid}`, codeKeyOf(old)],
        [String(uid), hash, String(ttl), String(CREATE_LIMIT_PER_HOUR), old]);
      const s = Array.isArray(r) ? String(r[0]) : "";
      if (s === "ok") return reply(res, 200, { ok: true, code, expiresIn: ttl }); // code only to this player's server
      if (s === "rate") return reply(res, 429, { error: "Too many codes, try later" });
      if (s !== "retry") break;
    }
    return reply(res, 500, { error: "Could not create code" });
  }
  if (action === "status") {
    const r = await redis.eval(STATUS_SCRIPT, [`bb:avatar:user:${uid}`, `bb:link:pending:${uid}`, `bb:link:last:${uid}`], []);
    const n = Number(r?.[0] || 0);
    const pttl = Number(r?.[1] || -2);
    const last = r?.[2] ? { at: Number(r[2]), amount: Number(r[3]), name: String(r[4] || "") } : null;
    // lastLinkedDonation lets the player spot a leaked code that somebody else used first (then: unlink)
    return reply(res, 200, { ok: true, linked: n > 0, identities: n, pendingExpiresIn: pttl > 0 ? Math.ceil(pttl / 1000) : 0, lastLinkedDonation: last });
  }
  if (action === "unlink") {
    for (let attempt = 0; attempt < 3; attempt++) {
      const pend = await pendingHash(uid);
      const r = await redis.eval(UNLINK_SCRIPT,
        [`bb:avatar:user:${uid}`, "bb:avatar", `bb:link:pending:${uid}`, codeKeyOf(pend), `bb:link:last:${uid}`],
        [String(uid), pend]);
      const s = Array.isArray(r) ? String(r[0]) : "";
      if (s === "ok") return reply(res, 200, { ok: true, removed: Number(r[1] || 0) });
      if (s !== "retry") break;
    }
    return reply(res, 500, { error: "Could not unlink" });
  }
  return reply(res, 400, { error: "Unknown action" });
}

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return reply(res, 405, { error: "Method not allowed" });
  }

  const expectedKey = process.env.ROBLOX_API_KEY;
  const suppliedKey = req.headers["x-api-key"];

  if (!expectedKey || !safeEqual(String(suppliedKey || ""), expectedKey)) {
    return reply(res, 401, { error: "Unauthorized" });
  }

  res.setHeader("Cache-Control", "no-store");
  try {
    if (req.method === "POST") return await handleLink(req, res);

    // exact cursor (exclusive) or v1 "since" in ms (inclusive)
    let min, minValue;
    const after = String(req.query.after ?? "");
    if (/^\d{1,16}(\.\d{1,6})?$/.test(after)) {
      min = "(" + after;
      minValue = Number(after);
    } else {
      const rawSince = Number(req.query.since ?? 0);
      minValue = Number.isFinite(rawSince) && rawSince > 0 ? Math.floor(rawSince) : Date.now();
      min = String(minValue);
    }

    const feedResult = await redis.eval(READ_FEED_SCRIPT, ["bb:feed", "bb:donors", "bb:history"],
      [min, String(PAGE_LIMIT), String(TOP_SCAN), String(HISTORY_LIMIT)]);
    if (!Array.isArray(feedResult) || String(feedResult[0]) !== "ok") throw new Error("feed keys have a wrong type");
    const [, rows, top, hist, oldest, count] = feedResult;

    const donations = [];
    let lastScore = null;
    for (let i = 0; i < (rows || []).length; i += 2) {
      const d = parseDonation(rows[i]);
      lastScore = String(rows[i + 1]);
      if (d) donations.push(d);
    }

    const ids = [];
    for (let i = 0; i < (top || []).length; i += 2) ids.push([String(top[i]), Number(top[i + 1])]);
    const profiles = ids.length
      ? await redis.eval(READ_PROFILES_SCRIPT, ["bb:avatar", ...ids.map(([k]) => `bb:donor:${k}`)], ids.map(([k]) => k))
      : [];

    // one entry per verified Roblox account (several verified identities of the same player are added up);
    // entries without a verified account are never merged, not even with the same name
    const merged = [];
    const byUser = new Map();
    ids.forEach(([key, total], i) => {
      const [name, robloxUsername, identity, avatar] = profiles[i] || [];
      const uid = toUserId(avatar);
      const entry = {
        name: String(name || "Donatur"),
        robloxUsername: String(robloxUsername || ""),
        total: Number.isFinite(total) ? total : 0,
        robloxUserId: uid, // only after a one-time-code verification; never from names
        identity: identity ? String(identity) : (key.startsWith("id:") ? "donor" : key.startsWith("uid:") ? "account" : "name")
      };
      if (uid && byUser.has(uid)) {
        byUser.get(uid).total += entry.total;
        return;
      }
      if (uid) byUser.set(uid, entry);
      merged.push(entry);
    });
    merged.sort((a, b) => b.total - a.total); // stable: equal totals keep the database order
    const leaderboard = merged.slice(0, TOP_LIMIT);

    const history = (hist || []).map(parseDonation).filter(Boolean);
    const oldestScore = oldest === null || oldest === undefined || oldest === false ? null : Number(oldest);
    // the feed keeps the newest FEED_MAX rows: if the requested position is older than the oldest kept row,
    // rows in between may have been removed -> tell the client instead of skipping silently
    const truncated = oldestScore !== null && Number(count) >= FEED_MAX && minValue < oldestScore;

    return reply(res, 200, {
      ok: true,
      apiVersion: 2,
      serverTime: Date.now(),
      donations,
      nextCursor: lastScore,
      hasMore: (rows || []).length / 2 >= PAGE_LIMIT,
      truncated,
      leaderboard,
      history
    });
  } catch (error) {
    console.error("Roblox feed error:", String(error?.message || error).slice(0, 120));
    return reply(res, 500, { error: "Could not read donation data" });
  }
}
