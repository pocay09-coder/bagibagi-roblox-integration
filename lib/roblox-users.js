// AFTERBEAT v3 - Roblox account lookup (server side only, used by api/webhook.js and api/roblox.js).
// The BagiBagi donor name is treated as a Roblox USERNAME candidate. A match only says "this donation is for that
// account" (like a gift); it is NOT proof of who paid. DisplayName is never used to search (it is not unique).
//
//   POST https://users.roblox.com/v1/usernames/users   { usernames: [...], excludeBannedUsers: true }
//   POST https://users.roblox.com/v1/users             { userIds:   [...], excludeBannedUsers: true }
//
// Protection for the Roblox API and for donations:
//   * cache: found 7 days, not found 12 hours (Upstash keys bb:rbx:u:<lowercase username>)
//   * global budget of API requests per minute + backoff after 429 / 5xx / timeout (bb:rbx:backoff)
//   * any problem returns "undefined" (= PENDING): the donation is stored and counted anyway, and retried later
const POS_TTL = 7 * 86400;
const NEG_TTL = 12 * 3600;
const TIMEOUT_MS = 1500;
const MAX_BATCH = 100;

// ROBLOX_USERS_API is only for local tests (fake API). On Vercel (Preview and Production) the official API is always used.
const apiBase = () => String((!process.env.VERCEL_ENV && process.env.ROBLOX_USERS_API) || "https://users.roblox.com").replace(/\/+$/, "");
const budgetPerMinute = () => {
  const n = Number(process.env.ROBLOX_LOOKUPS_PER_MINUTE || 60);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 60;
};

// KEYS: 1 backoff  2 budget counter (per minute)   ARGV: 1 max per minute
const BUDGET_SCRIPT = `
if redis.call('EXISTS', KEYS[1]) == 1 then return {'backoff'} end
local n = redis.call('INCR', KEYS[2])
if n == 1 then redis.call('EXPIRE', KEYS[2], 120) end
if n > tonumber(ARGV[1]) then return {'budget'} end
return {'ok'}
`;
// KEYS: 1 backoff  2 failure counter   ARGV: 1 retry-after seconds ("" = exponential)  2 max seconds
const BACKOFF_SCRIPT = `
local n = redis.call('INCR', KEYS[2])
redis.call('EXPIRE', KEYS[2], 3600)
local s = tonumber(ARGV[1])
if not s or s <= 0 then s = math.min(2 ^ n, tonumber(ARGV[2])) end
if s < 1 then s = 1 end
redis.call('SET', KEYS[1], '1', 'EX', math.floor(s))
return {math.floor(s)}
`;

// Placeholder names payment pages use for hidden / anonymous donors (BagiBagi sends "Seseorang"). They are never looked up:
// a real Roblox account that happens to have that username would otherwise receive someone else's donation.
export const ANONYMOUS_NAMES = new Set(["seseorang", "anonim", "anonymous", "anon", "someone", "donatur", "donator",
  "hambaallah", "hamba_allah", "noname", "no_name", "tanpanama", "tanpa_nama"]);

// Roblox username rules: 3-20 letters / digits / one underscore (not first or last). A leading "@" is ignored.
export function usernameCandidate(name) {
  let s = String(name ?? "").normalize("NFC").trim();
  if (s.startsWith("@")) s = s.slice(1).trim();
  if (!/^[A-Za-z0-9_]{3,20}$/.test(s)) return null;
  if (ANONYMOUS_NAMES.has(s.toLowerCase())) return null;
  if (s.startsWith("_") || s.endsWith("_") || (s.match(/_/g) || []).length > 1) return null;
  return s;
}

async function gate(redis) {
  const r = await redis.eval(BUDGET_SCRIPT, ["bb:rbx:backoff", `bb:rbx:budget:${Math.floor(Date.now() / 60000)}`], [String(budgetPerMinute())]);
  return Array.isArray(r) ? String(r[0]) : "error";
}

async function backoff(redis, retryAfter, maxSeconds) {
  try {
    await redis.eval(BACKOFF_SCRIPT, ["bb:rbx:backoff", "bb:rbx:fails"], [String(retryAfter || ""), String(maxSeconds)]);
  } catch { /* backoff is best effort */ }
}

async function postJson(path, body) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(apiBase() + path, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
      signal: ctl.signal
    });
    let data = null;
    try { data = await r.json(); } catch { data = null; }
    return { status: r.status, retryAfter: Number(r.headers.get("retry-after")) || 0, data };
  } finally {
    clearTimeout(timer);
  }
}

// usernames -> Map(lowercase -> {id, name, displayName} | null (not found) | undefined (PENDING: try again later))
export async function lookupUsernames(redis, usernames) {
  const out = new Map();
  const misses = [];
  for (const u of [...new Set(usernames.map((x) => String(x).toLowerCase()))]) {
    let cached = null;
    try { cached = await redis.get(`bb:rbx:u:${u}`); } catch { cached = null; }
    if (cached === "none") out.set(u, null);
    else if (cached) {
      try { const v = JSON.parse(cached); out.set(u, v && v.id ? v : undefined); if (!(v && v.id)) misses.push(u); }
      catch { misses.push(u); }
    } else misses.push(u);
  }
  if (!misses.length) return out;
  for (let i = 0; i < misses.length; i += MAX_BATCH) {
    const batch = misses.slice(i, i + MAX_BATCH);
    let allowed = "error";
    try { allowed = await gate(redis); } catch { allowed = "error"; }
    if (allowed !== "ok") { batch.forEach((u) => out.set(u, undefined)); continue; }
    let res;
    try {
      res = await postJson("/v1/usernames/users", { usernames: batch, excludeBannedUsers: true });
    } catch {
      await backoff(redis, 0, 300); // timeout / network
      batch.forEach((u) => out.set(u, undefined));
      continue;
    }
    if (res.status === 429 || res.status >= 500 || !res.data || !Array.isArray(res.data.data)) {
      await backoff(redis, res.status === 429 ? res.retryAfter : 0, res.status === 429 ? 900 : 300);
      batch.forEach((u) => out.set(u, undefined));
      continue;
    }
    try { await redis.del("bb:rbx:fails"); } catch {}
    for (const u of batch) {
      // exact match only: the CURRENT username must equal the requested one (case-insensitive)
      const hit = res.data.data.find((x) =>
        String(x?.requestedUsername || "").toLowerCase() === u && String(x?.name || "").toLowerCase() === u && Number(x?.id) > 0);
      const v = hit ? { id: Number(hit.id), name: String(hit.name), displayName: String(hit.displayName || hit.name) } : null;
      out.set(u, v);
      try { await redis.set(`bb:rbx:u:${u}`, v ? JSON.stringify(v) : "none", { ex: v ? POS_TTL : NEG_TTL }); } catch {}
    }
  }
  return out;
}

// userIds -> Map(id -> {name, displayName} | null (banned / deleted) | undefined (try later))
export async function refreshUsers(redis, userIds) {
  const out = new Map();
  const ids = [...new Set(userIds.map(Number).filter((x) => x > 0))].slice(0, MAX_BATCH);
  if (!ids.length) return out;
  let allowed = "error";
  try { allowed = await gate(redis); } catch {}
  if (allowed !== "ok") return out;
  let res;
  try {
    res = await postJson("/v1/users", { userIds: ids, excludeBannedUsers: true });
  } catch {
    await backoff(redis, 0, 300);
    return out;
  }
  if (res.status === 429 || res.status >= 500 || !res.data || !Array.isArray(res.data.data)) {
    await backoff(redis, res.status === 429 ? res.retryAfter : 0, res.status === 429 ? 900 : 300);
    return out;
  }
  for (const id of ids) {
    const hit = res.data.data.find((x) => Number(x?.id) === id);
    out.set(id, hit ? { name: String(hit.name), displayName: String(hit.displayName || hit.name) } : null);
  }
  return out;
}
