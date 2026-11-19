import { Redis } from "@upstash/redis";
import { createHash, createHmac, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import { lookupUsernames, refreshUsers } from "../lib/roblox-users.js";

// AFTERBEAT feed for Roblox game servers, v3 (backward compatible with v2.1 / v1 clients).
// v3 adds "top50" (Gold Donation, every valid donation counted once) with "#N ROYAL" data for ranks 1-30 that
// belong to a found Roblox account. The Roblox SERVER gives the tag, only to the player whose UserId matches.
// GET also finishes PENDING username lookups (atomic move, never counted twice) and refreshes DisplayNames.
//   GET  ?since=<ms>        donations with receivedAt >= since (oldest first, max 100), like v1
//   GET  ?after=<cursor>    donations strictly after a cursor (exact paging, also many rows in one ms)
//   POST {action, userId}   one-time link codes for Auto Avatar: "create" | "status" | "unlink"
// Called ONLY by Roblox game servers. GET uses ROBLOX_API_KEY, POST uses a SEPARATE ROBLOX_LINK_API_KEY.
// The game server must always send the UserId of the player who pressed the button (Player.UserId from the
// RemoteFunction), never a UserId typed by a client. The old link codes are kept for compatibility only: they are
// NOT required for the leaderboard or for ROYAL.
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
const TOP50 = 50;
const ROYAL_MAX = 30;
const RESOLVE_BATCH = 25;
const REFRESH_AFTER_MS = 24 * 3600 * 1000;

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

// KEYS: 1 feed 2 donors 3 history 4 rank   ARGV: 1 min score 2 page limit 3 top count 4 history count 5 top50
const READ_FEED_SCRIPT = TYPE_FN + `
if not typeOk(KEYS[1], 'zset') or not typeOk(KEYS[2], 'zset') or not typeOk(KEYS[3], 'list') or not typeOk(KEYS[4], 'zset') then return {'error'} end
local rows = redis.call('ZRANGEBYSCORE', KEYS[1], ARGV[1], '+inf', 'WITHSCORES', 'LIMIT', 0, tonumber(ARGV[2]))
local top = redis.call('ZREVRANGE', KEYS[2], 0, tonumber(ARGV[3]) - 1, 'WITHSCORES')
local hist = redis.call('LRANGE', KEYS[3], 0, tonumber(ARGV[4]) - 1)
local oldest = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')
local rank = redis.call('ZREVRANGE', KEYS[4], 0, tonumber(ARGV[5]) - 1, 'WITHSCORES')
return {'ok', rows, top, hist, oldest[2] or false, redis.call('ZCARD', KEYS[1]), rank}
`;

// KEYS: rank hashes (bb:rk:<member>) in Top 50 order
const READ_RANK_SCRIPT = TYPE_FN + `
local out = {}
for i = 1, #KEYS do
  local v = {false, false, false, false, false, false, false}
  if typeOf(KEYS[i]) == 'hash' then v = redis.call('HMGET', KEYS[i], 'username', 'displayName', 'banned', 'name', 'pending', 'lastName', 'refreshedAt') end
  out[#out + 1] = {v[1] or false, v[2] or false, v[3] or false, v[4] or false, v[5] or false, v[6] or false, v[7] or false}
end
return out
`;

// PENDING -> found: move the amount atomically from the name entry to the account (only if still pending there)
// KEYS: 1 tx  2 rank  3 pending set  4 from hash  5 to hash   ARGV: 1 txId 2 from 3 to 4 username 5 displayName 6 now
const REATTRIBUTE_SCRIPT = TYPE_FN + `
if not typeOk(KEYS[2], 'zset') or not typeOk(KEYS[3], 'zset') or not typeOk(KEYS[4], 'hash') or not typeOk(KEYS[5], 'hash') then return {'error'} end
if typeOf(KEYS[1]) ~= 'hash' then redis.call('ZREM', KEYS[3], ARGV[1]) return {'gone'} end
local st = redis.call('HGET', KEYS[1], 'status')
local mem = redis.call('HGET', KEYS[1], 'member')
local amt = tonumber(redis.call('HGET', KEYS[1], 'amount') or '')
if st ~= 'pending' or mem ~= ARGV[2] or not amt or amt <= 0 then redis.call('ZREM', KEYS[3], ARGV[1]) return {'skip'} end
redis.call('ZINCRBY', KEYS[2], -amt, ARGV[2])
local left = tonumber(redis.call('ZSCORE', KEYS[2], ARGV[2]) or '0')
if left and left <= 0.0005 then redis.call('ZREM', KEYS[2], ARGV[2]) end
redis.call('ZINCRBY', KEYS[2], amt, ARGV[3])
redis.call('HSET', KEYS[1], 'member', ARGV[3], 'status', 'matched', 'resolvedAt', ARGV[6])
redis.call('HINCRBY', KEYS[4], 'pending', -1)
redis.call('HSET', KEYS[5], 'username', ARGV[4], 'displayName', ARGV[5], 'refreshedAt', ARGV[6], 'banned', '0', 'lastName', redis.call('HGET', KEYS[1], 'name') or '')
redis.call('ZREM', KEYS[3], ARGV[1])
return {'moved'}
`;

// PENDING -> definitely not found: stays counted under the name (never moved later)
// KEYS: 1 tx  2 pending set  3 from hash   ARGV: 1 txId 2 from member
const MARK_UNMATCHED_SCRIPT = TYPE_FN + `
if not typeOk(KEYS[2], 'zset') then return {'error'} end
if typeOf(KEYS[1]) == 'hash' and typeOk(KEYS[3], 'hash') and redis.call('HGET', KEYS[1], 'status') == 'pending'
  and redis.call('HGET', KEYS[1], 'member') == ARGV[2] then
  redis.call('HSET', KEYS[1], 'status', 'unmatched')
  redis.call('HINCRBY', KEYS[3], 'pending', -1)
end
redis.call('ZREM', KEYS[2], ARGV[1])
return {'ok'}
`;

// global limit for POST (all accounts together)   KEYS: 1 counter of this minute   ARGV: 1 max
const POST_LIMIT_SCRIPT = `
local n = redis.call('INCR', KEYS[1])
if n == 1 then redis.call('EXPIRE', KEYS[1], 120) end
if n > tonumber(ARGV[1]) then return {'busy'} end
return {'ok'}
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
if redis.call('EXISTS', KEYS[2]) == 1 then return {'collision'} end
if (redis.call('GET', KEYS[1]) or '') ~= ARGV[5] then return {'retry'} end
local n = redis.call('INCR', KEYS[3])
if n == 1 then redis.call('EXPIRE', KEYS[3], 3600) end
if n > tonumber(ARGV[4]) then return {'rate'} end
if ARGV[5] ~= '' then redis.call('DEL', KEYS[4]) end
redis.call('SET', KEYS[2], ARGV[1], 'EX', tonumber(ARGV[3]), 'NX')
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
    let code = newCode();
    let hash = createHmac("sha256", secret).update(code).digest("hex");
    const ttl = codeTtl();
    for (let attempt = 0; attempt < 4; attempt++) {
      const old = await pendingHash(uid);
      const r = await redis.eval(CREATE_SCRIPT,
        [`bb:link:pending:${uid}`, `bb:link:code:${hash}`, `bb:link:rate:${uid}`, codeKeyOf(old)],
        [String(uid), hash, String(ttl), String(CREATE_LIMIT_PER_HOUR), old]);
      const s = Array.isArray(r) ? String(r[0]) : "";
      if (s === "ok") return reply(res, 200, { ok: true, code, expiresIn: ttl }); // code only to this player's server
      if (s === "rate") return reply(res, 429, { error: "Too many codes, try later" });
      if (s === "collision") { // the same code exists already: never overwrite it, take another one
        code = newCode();
        hash = createHmac("sha256", secret).update(code).digest("hex");
        continue;
      }
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

function dbFingerprint() {
  try {
    const host = new URL(String(process.env.UPSTASH_REDIS_REST_URL || "")).hostname;
    return host ? createHash("sha256").update(host).digest("hex").slice(0, 12) : null;
  } catch {
    return null;
  }
}

// ===== short Redis locks (v3.1 review fix) =====
// Each holder writes its OWN random token. Release = compare-and-delete in Lua: a process whose lock already expired
// (it ran longer than the TTL) can never delete a lock that a newer process holds now. The work under these locks is
// idempotent anyway (REATTRIBUTE / MARK_UNMATCHED re-check the ledger), the lock only avoids duplicate effort.
const UNLOCK_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end
return 0
`;
async function withLock(key, ttlSeconds, fn) {
  const token = randomUUID();
  const got = await redis.set(key, token, { nx: true, ex: ttlSeconds });
  if (!got) return false; // someone else is working
  try {
    await fn();
  } finally {
    try {
      await redis.eval(UNLOCK_SCRIPT, [key], [token]);
    } catch (e) {
      // not released: it expires by itself after ttlSeconds
      console.error("Lock release error:", String(e?.message || e).slice(0, 80));
    }
  }
  return true;
}

// finish PENDING lookups (one server at a time; failures just leave them pending)
async function resolvePending() {
  await withLock("bb:rbx:lock", 20, resolvePendingWork);
}
async function resolvePendingWork() {
  {
    const ids = ((await redis.zrange("bb:rbx:pending", 0, RESOLVE_BATCH - 1)) || []).map(String);
    if (!ids.length) return;
    const txs = [];
    for (const id of ids) txs.push([id, await redis.hgetall(`bb:tx:${id}`)]);
    const cands = txs.map(([, h]) => h && h.status === "pending" && h.cand).filter(Boolean);
    const found = cands.length ? await lookupUsernames(redis, cands) : new Map();
    for (const [id, h] of txs) {
      const from = h && h.member ? String(h.member) : "";
      const fromHash = from.startsWith("n:") ? `bb:rk:${from}` : `${UNUSED}:rk:from`;
      if (!h || h.status !== "pending" || !h.cand) {
        await redis.eval(MARK_UNMATCHED_SCRIPT, [`bb:tx:${id}`, "bb:rbx:pending", fromHash], [id, from]);
        continue;
      }
      const v = found.get(String(h.cand).toLowerCase());
      if (v === undefined) continue; // Roblox still unavailable: stays pending, counted under the name
      if (v) {
        await redis.eval(REATTRIBUTE_SCRIPT, [`bb:tx:${id}`, "bb:rank", "bb:rbx:pending", fromHash, `bb:rk:u:${v.id}`],
          [id, from, `u:${v.id}`, v.name, v.displayName, String(Date.now())]);
      } else {
        await redis.eval(MARK_UNMATCHED_SCRIPT, [`bb:tx:${id}`, "bb:rbx:pending", fromHash], [id, from]);
      }
    }
  }
}

// DisplayName / username of Top 50 accounts, refreshed once per 24 h; banned / deleted accounts lose avatar + ROYAL
async function refreshStale(entries) {
  const now = Date.now();
  const stale = entries.filter((e) => e._account && (!e._refreshedAt || now - e._refreshedAt > REFRESH_AFTER_MS)).map((e) => e._account);
  if (!stale.length) return;
  await withLock("bb:rbx:refreshlock", 30, async () => {
    const r = await refreshUsers(redis, stale);
    for (const e of entries) {
      if (!e._account || !r.has(e._account)) continue;
      const v = r.get(e._account);
      if (v) {
        await redis.hset(`bb:rk:u:${e._account}`, { username: v.name, displayName: v.displayName, refreshedAt: String(now), banned: "0" });
        e._username = v.name; e._displayName = v.displayName; e._banned = false;
      } else if (v === null) {
        await redis.hset(`bb:rk:u:${e._account}`, { refreshedAt: String(now), banned: "1" });
        e._banned = true;
      }
    }
  });
}

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return reply(res, 405, { error: "Method not allowed" });
  }

  // separate secrets: a leaked feed key cannot create or remove links
  const expectedKey = req.method === "POST" ? process.env.ROBLOX_LINK_API_KEY : process.env.ROBLOX_API_KEY;
  const suppliedKey = req.headers["x-api-key"];
  if (req.method === "POST" && !expectedKey) return reply(res, 503, { error: "Linking is not configured" });

  if (!expectedKey || !safeEqual(String(suppliedKey || ""), expectedKey)) {
    return reply(res, 401, { error: "Unauthorized" });
  }

  res.setHeader("Cache-Control", "no-store");
  try {
    if (req.method === "POST") {
      const max = Number(process.env.LINK_GLOBAL_PER_MINUTE || 120);
      const lim = await redis.eval(POST_LIMIT_SCRIPT, [`bb:link:global:${Math.floor(Date.now() / 60000)}`], [String(max > 0 ? Math.floor(max) : 120)]);
      if (Array.isArray(lim) && String(lim[0]) === "busy") return reply(res, 429, { error: "Busy, try later" });
      return await handleLink(req, res);
    }

    if (process.env.USERNAME_MATCH === "1") {
      try { await resolvePending(); } catch (e) { console.error("Pending lookup error:", String(e?.message || e).slice(0, 80)); }
    }

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

    const feedResult = await redis.eval(READ_FEED_SCRIPT, ["bb:feed", "bb:donors", "bb:history", "bb:rank"],
      [min, String(PAGE_LIMIT), String(TOP_SCAN), String(HISTORY_LIMIT), String(TOP50)]);
    if (!Array.isArray(feedResult) || String(feedResult[0]) !== "ok") throw new Error("feed keys have a wrong type");
    const [, rows, top, hist, oldest, count, rank] = feedResult;
    // TEST webhooks (alert only, never counted): last 15 minutes, newer than the client's window
    let tests = [];
    try {
      const testMin = Math.max(Math.floor(minValue) || 0, Date.now() - 15 * 60000);
      const tr = await redis.zrange("bb:testfeed", testMin, "+inf", { byScore: true });
      tests = (tr || []).map((t) => { try { return JSON.parse(String(t)); } catch { return null; } })
        .filter((t) => t && t.test === true).slice(-20);
    } catch (e) {
      console.error("Test feed error:", String(e?.message || e).slice(0, 80));
    }

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

    // Gold Donation Top 50 (every valid donation; accounts by UserId, other names by name)
    const rankRows = [];
    for (let i = 0; i < (rank || []).length; i += 2) rankRows.push([String(rank[i]), Number(rank[i + 1])]);
    const rankInfo = rankRows.length ? await redis.eval(READ_RANK_SCRIPT, rankRows.map(([m]) => `bb:rk:${m}`), []) : [];
    const work = rankRows.map(([m, total], i) => {
      const [username, displayName, banned, name, pending, lastName, refreshedAt] = rankInfo[i] || [];
      const acct = m.startsWith("u:") ? toUserId(m.slice(2)) : null;
      return { m, total, acct, _account: acct, _username: username || null, _displayName: displayName || null,
        _banned: String(banned) === "1", _name: name || null, _pending: Number(pending) || 0, _lastName: lastName || null,
        _refreshedAt: Number(refreshedAt) || 0 };
    });
    if (process.env.USERNAME_MATCH === "1") {
      try { await refreshStale(work); } catch (e) { console.error("Refresh error:", String(e?.message || e).slice(0, 80)); }
    }
    const top50 = work.map((w, i) => {
      const position = i + 1;
      if (w.acct) {
        const available = !w._banned;
        const royal = available && position <= ROYAL_MAX; // ranks 1-30 of the WHOLE list; slots are never passed on
        return {
          rank: position, identity: "USERNAME_MATCHED", userId: w.acct, available,
          username: w._username, displayName: w._displayName || w._username,
          name: w._displayName || w._username || w._lastName || "Donatur",
          total: Number.isFinite(w.total) ? w.total : 0, royal, royalTag: royal ? `#${position} ROYAL` : null
        };
      }
      return {
        rank: position, identity: w._pending > 0 ? "PENDING" : "UNMATCHED", userId: null, available: false,
        username: null, displayName: null, name: w._name || "Donatur",
        total: Number.isFinite(w.total) ? w.total : 0, royal: false, royalTag: null
      };
    });

    return reply(res, 200, {
      ok: true,
      apiVersion: 3,
      apiRevision: "3.1",
      env: process.env.VERCEL_ENV || "local",
      dbFingerprint: dbFingerprint(),
      serverTime: Date.now(),
      donations,
      nextCursor: lastScore,
      hasMore: (rows || []).length / 2 >= PAGE_LIMIT,
      truncated,
      leaderboard,
      top50,
      history,
      tests
    });
  } catch (error) {
    console.error("Roblox feed error:", String(error?.message || error).slice(0, 120));
    return reply(res, 500, { error: "Could not read donation data" });
  }
}

// exported for the local test suite only (constants, no side effects)
export const __scripts = { CREATE_SCRIPT, REATTRIBUTE_SCRIPT, MARK_UNMATCHED_SCRIPT, UNLOCK_SCRIPT };
export const __locks = { withLock }; // tests only
