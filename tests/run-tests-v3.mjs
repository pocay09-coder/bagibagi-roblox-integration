// v3 tests: username matching, Top 50 Gold Donation, ROYAL data, PENDING retry. LOCAL ONLY:
// local redis-server (separate test database) + a local FAKE Roblox Users API. Never Upstash, never roblox.com.
import { spawn, execFileSync } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import http from "node:http";

const PORT = 6394, API_PORT = 8899;
process.env.BB_TEST_REDIS_PORT = String(PORT);
process.env.BAGIBAGI_WEBHOOK_TOKEN = "v3-token";
process.env.ROBLOX_API_KEY = "v3-feed-key";
process.env.ROBLOX_LINK_API_KEY = "v3-link-key";
process.env.LINK_CODE_SECRET = "v3-secret";
process.env.USERNAME_MATCH = "1";
process.env.ROBLOX_USERS_API = `http://127.0.0.1:${API_PORT}`;

// ---------- fake Roblox Users API ----------
const api = { mode: "ok", retryAfter: 0, byName: new Map(), byId: new Map(), oldNames: new Map(), calls: { names: 0, ids: 0 } };
function addUser(id, name, displayName) { const u = { id, name, displayName }; api.byName.set(name.toLowerCase(), u); api.byId.set(id, u); return u; }
addUser(8717004329, "pocay88", "POCAY");
addUser(2001, "budi_rbx", "Budi");
addUser(2002, "sari123", "Budi");      // same DisplayName as budi_rbx, different account
addUser(2003, "newuser01", "Baru");
addUser(2004, "lateuser1", "Telat");
api.oldNames.set("oldpocay", api.byId.get(8717004329)); // old username of pocay88
for (let i = 1; i <= 40; i++) addUser(3000 + i, `player${String(i).padStart(2, "0")}`, `P${i}`);
const apiServer = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const send = (code, obj, headers = {}) => { res.writeHead(code, { "content-type": "application/json", ...headers }); res.end(JSON.stringify(obj)); };
    if (api.mode === "timeout") return setTimeout(() => send(200, { data: [] }), 3000);
    if (api.mode === "429") return send(429, { errors: [{ message: "TooManyRequests" }] }, api.retryAfter ? { "retry-after": String(api.retryAfter) } : {});
    if (api.mode === "500") return send(500, { errors: [] });
    const j = JSON.parse(body || "{}");
    if (req.url === "/v1/usernames/users") {
      api.calls.names++;
      const data = [];
      for (const n of j.usernames || []) {
        const u = api.byName.get(String(n).toLowerCase()) || api.oldNames.get(String(n).toLowerCase());
        if (u) data.push({ requestedUsername: n, hasVerifiedBadge: false, id: u.id, name: u.name, displayName: u.displayName });
      }
      return send(200, { data });
    }
    if (req.url === "/v1/users") {
      api.calls.ids++;
      return send(200, { data: (j.userIds || []).map((id) => api.byId.get(Number(id))).filter(Boolean).map((u) => ({ id: u.id, name: u.name, displayName: u.displayName })) });
    }
    send(404, {});
  });
});
await new Promise((r) => apiServer.listen(API_PORT, r));

const redisSrv = spawn("redis-server", ["--port", String(PORT), "--save", "", "--appendonly", "no"], { stdio: "ignore" });
const { raw, stats, faults } = await import("@upstash/redis");
for (let i = 0; i < 50; i++) { try { if ((await raw(["PING"])) === "PONG") break; } catch {} await new Promise((r) => setTimeout(r, 100)); }
const logs = [];
const out = console.log.bind(console);
console.error = (...a) => logs.push(a.join(" "));
const wh = (await import("./api/webhook.js")).default;
const rbMod = await import("./api/roblox.js");
const rb = rbMod.default;

let pass = 0, fail = 0;
const check = (n, c, x) => { c ? pass++ : fail++; out(`${c ? "PASS" : "FAIL"} ${n}${x !== undefined ? " | " + x : ""}`); };
const mkRes = () => { const r = { headers: {} }; r.status = (c) => { r.code = c; return r; }; r.json = (b) => { r.body = b; return r; }; r.setHeader = (k, v) => { r.headers[k] = v; }; return r; };
async function hook(body) { const r = mkRes(); await wh({ method: "POST", headers: { "x-bagibagi-signature": createHmac("sha256", "v3-token").update(JSON.stringify(body)).digest("hex") }, body }, r); return r; }
async function feed(key = "v3-feed-key") { const r = mkRes(); await rb({ method: "GET", headers: { "x-api-key": key }, query: { since: "1" } }, r); return r; }
async function post(body, key = "v3-link-key") { const r = mkRes(); await rb({ method: "POST", headers: { "x-api-key": key }, query: {}, body }, r); return r; }
let n = 0;
const tx = (name, amount, message = "") => ({ transaction_id: `v3-${++n}`, name, amount, message, mediaShareUrl: "", created_at: "" });
const flush = async () => { await raw(["FLUSHALL"]); api.mode = "ok"; api.retryAfter = 0; };
const top = async () => (await feed()).body.top50;
const entry = (t, pred) => t.find(pred);
const rankSum = async () => { const z = await raw(["ZRANGE", "bb:rank", "0", "-1", "WITHSCORES"]); let s = 0; for (let i = 1; i < z.length; i += 2) s += Number(z[i]); return s; };
const clearBackoff = () => raw(["DEL", "bb:rbx:backoff", "bb:rbx:fails"]);

// ---------- 1. username matching ----------
await flush();
await hook(tx("pocay88", 10000, "halo"));
let t = await top();
let p = entry(t, (e) => e.userId === 8717004329);
check("V1 BagiBagi name = Roblox username -> USERNAME_MATCHED, UserId, DisplayName, @username",
  p && p.identity === "USERNAME_MATCHED" && p.displayName === "POCAY" && p.username === "pocay88" && p.name === "POCAY" && p.total === 10000);
let f = (await feed()).body.donations.find((d) => d.name === "pocay88");
check("V1 feed row carries match info (matchedUserId, username, displayName)", f && f.match === "matched" && f.matchedUserId === 8717004329 && f.username === "pocay88" && f.displayName === "POCAY");
const callsBefore = api.calls.names;
await hook(tx("POCAY88", 5000));
await hook(tx("@pocay88", 2500));
t = await top();
check("V2 case / leading @ -> same account, totals added up by UserId", entry(t, (e) => e.userId === 8717004329).total === 17500 && t.filter((e) => e.userId === 8717004329).length === 1);
check("V8 cache: repeated username -> no new Roblox API call", api.calls.names === callsBefore);
await hook(tx("TidakAda_xyz9", 3000));
t = await top();
let u = entry(t, (e) => e.name === "TidakAda_xyz9");
check("V3 username not found -> still counted, UNMATCHED, exact BagiBagi name, no avatar", u && u.identity === "UNMATCHED" && u.userId === null && u.total === 3000 && u.royal === false);
const negCalls = api.calls.names;
await hook(tx("TidakAda_xyz9", 1000));
check("V8 negative cache: unknown name again -> no new API call, added to the same name entry", api.calls.names === negCalls && entry(await top(), (e) => e.name === "TidakAda_xyz9").total === 4000);
const fmtCalls = api.calls.names;
for (const bad of ["Budi Santoso", "🔥Raja🔥", "ab", "nama__dua", "_awal", "x".repeat(21)]) await hook(tx(bad, 100));
t = await top();
check("V4 names that cannot be usernames -> no API call, counted as UNMATCHED", api.calls.names === fmtCalls && ["Budi Santoso", "🔥Raja🔥", "ab"].every((nm) => entry(t, (e) => e.name === nm && e.identity === "UNMATCHED")));
await hook(tx("budi_rbx", 4000));
await hook(tx("sari123", 6000));
t = await top();
check("V5 same DisplayName 'Budi', different usernames -> two separate accounts", entry(t, (e) => e.userId === 2001).total === 4000 && entry(t, (e) => e.userId === 2002).total === 6000);
await hook(tx("POCAY", 700));
t = await top();
check("V6 DisplayName typed instead of username -> not matched to that account", entry(t, (e) => e.name === "POCAY" && e.identity === "UNMATCHED") && entry(t, (e) => e.userId === 8717004329).total === 17500);
await hook(tx("oldpocay", 800));
t = await top();
check("V7 old (previous) username -> NOT matched (current username must be exact)", entry(t, (e) => e.name === "oldpocay" && e.identity === "UNMATCHED"));
let allAmounts = 10000 + 5000 + 2500 + 3000 + 1000 + 600 + 4000 + 6000 + 700 + 800;
check("V25 every valid donation is in the ranking exactly once (sum of ranking = sum of donations)", (await rankSum()) === allAmounts, await rankSum());

// ---------- 2. Roblox API problems -> PENDING, counted, retried safely ----------
await flush();
api.mode = "429"; api.retryAfter = 2;
let r = await hook(tx("newuser01", 9000));
t = await top();
let pe = entry(t, (e) => e.name === "newuser01");
check("V9 Roblox API 429 -> donation stored + counted at once as PENDING", r.body.accepted === true && pe && pe.identity === "PENDING" && pe.total === 9000 && (await raw(["EXISTS", "bb:rbx:backoff"])) === 1);
const during = api.calls.names;
await hook(tx("lateuser1", 1000));
check("V9 during backoff no further API calls (still counted)", api.calls.names === during && entry(await top(), (e) => e.name === "lateuser1" && e.identity === "PENDING"));
api.mode = "ok";
await feed(); // still in backoff -> nothing moves
check("V9 backoff respected by the retry", entry(await top(), (e) => e.name === "newuser01" && e.identity === "PENDING") !== undefined);
await clearBackoff();
await feed();
t = await top();
check("V9 after recovery: moved to the account, name entry gone, total unchanged, nothing doubled",
  entry(t, (e) => e.userId === 2003).total === 9000 && entry(t, (e) => e.userId === 2004).total === 1000 && !entry(t, (e) => e.name === "newuser01" && !e.userId) && (await rankSum()) === 10000);
check("V9 pending queue empty, ledger says matched", (await raw(["ZCARD", "bb:rbx:pending"])) === 0 && (await raw(["HGET", "bb:tx:v3-" + (n - 1), "status"])) === "matched");
// timeout
await flush();
api.mode = "timeout";
r = await hook(tx("pocay88", 1234));
check("V10 Roblox API timeout -> stored as PENDING (webhook still answers)", r.body.accepted === true && entry(await top(), (e) => e.identity === "PENDING" && e.total === 1234));
api.mode = "ok"; await clearBackoff(); await feed();
check("V10 timeout recovered -> matched", entry(await top(), (e) => e.userId === 8717004329 && e.total === 1234));
// pending, then definitely not found -> stays under the name forever
await flush();
api.mode = "500";
await hook(tx("ghost_user1", 2000));
api.mode = "ok"; await clearBackoff(); await feed();
t = await top();
check("V11 pending -> definitely not found -> UNMATCHED (stays counted under the name)", entry(t, (e) => e.name === "ghost_user1" && e.identity === "UNMATCHED" && e.total === 2000) && (await raw(["ZCARD", "bb:rbx:pending"])) === 0);
addUser(2099, "ghost_user1", "Hantu"); await raw(["DEL", "bb:rbx:u:ghost_user1"]);
await hook(tx("ghost_user1", 500));
t = await top();
check("V11 an account created LATER does not take over the old donation, only new ones",
  entry(t, (e) => e.name === "ghost_user1" && !e.userId).total === 2000 && entry(t, (e) => e.userId === 2099).total === 500);
// concurrency: 10 pending, 3 parallel GETs
await flush();
api.mode = "500";
for (let i = 1; i <= 10; i++) await hook(tx(`player${String(i).padStart(2, "0")}`, 1000 * i));
api.mode = "ok"; await clearBackoff();
await Promise.all([feed(), feed(), feed()]);
for (let i = 0; i < 3 && (await raw(["ZCARD", "bb:rbx:pending"])) > 0; i++) await feed();
t = await top();
check("V12 3 Roblox servers retrying at the same time -> every pending donation moved exactly once",
  (await rankSum()) === 55000 && t.filter((e) => e.userId >= 3001 && e.userId <= 3010).length === 10 && t.every((e) => e.identity !== "PENDING"));
const again = await raw(["EVAL", rbMod.__scripts.REATTRIBUTE_SCRIPT, "5", "bb:tx:v3-" + n, "bb:rank", "bb:rbx:pending", "bb:rk:n:x", "bb:rk:u:3010", "v3-" + n, "n:x", "u:3010", "a", "b", "1"]);
check("V13 repeating a move is a no-op (never double)", String(again[0]) === "skip" && (await rankSum()) === 55000);
// budget
await flush();
process.env.ROBLOX_LOOKUPS_PER_MINUTE = "2";
for (let i = 11; i <= 15; i++) await hook(tx(`player${i}`, 100));
const pend = await raw(["ZCARD", "bb:rbx:pending"]);
check("V14 API budget reached -> extra lookups become PENDING (all 5 counted)", pend === 3 && (await rankSum()) === 500, `pending=${pend}`);
delete process.env.ROBLOX_LOOKUPS_PER_MINUTE;
await raw(["EVAL", "for _, k in ipairs(redis.call('KEYS', 'bb:rbx:budget:*')) do redis.call('DEL', k) end return 1", "0"]);
await feed();
check("V14 resolved after the budget resets", (await raw(["ZCARD", "bb:rbx:pending"])) === 0 && (await top()).filter((e) => e.userId).length === 5);

// ---------- 3. Top 50 + ROYAL ----------
await flush();
for (let i = 1; i <= 35; i++) await hook(tx(`player${String(i).padStart(2, "0")}`, (100 - i) * 1000)); // player01 highest
await hook(tx("Nama Bebas", 88500)); // UNMATCHED between player11 (89.000) and player12 (88.000) -> rank 12
for (let i = 0; i < 20; i++) await hook(tx(`Kecil ${i}`, 10 + i)); // many small unmatched names
t = await top();
check("V26 Top 50 = 50 entries, highest first", t.length === 50 && t.every((e, i) => i === 0 || t[i - 1].total >= e.total) && t[0].rank === 1 && t[49].rank === 50);
const r12 = t[11];
check("V15 UNMATCHED at rank 12 -> no ROYAL for that slot", r12.name === "Nama Bebas" && r12.royal === false && r12.royalTag === null);
check("V15 ranks 1-30 with a found account -> royal + '#N ROYAL' tag", t.slice(0, 30).filter((e) => e.userId).every((e) => e.royal && e.royalTag === `#${e.rank} ROYAL`) && t[7].royalTag === "#8 ROYAL");
check("V15 slot of rank 12 is not handed to rank 31", t[30].userId && t[30].royal === false && t.filter((e) => e.royal).length === 29);
const p31 = t[30];
await hook(tx(p31.username, 27500)); // rank 31 (70.000) jumps to 97.500 = rank 3
t = await top();
const moved = entry(t, (e) => e.userId === p31.userId);
check("V15 ranking changes -> tag follows (#31 -> #3 ROYAL)", moved.rank === 3 && moved.royalTag === "#3 ROYAL");
const dropped = t[30];
check("V15 the account pushed to #31 loses ROYAL", dropped.userId && dropped.royal === false);
// refresh: DisplayName change + banned account
const target = t[0];
api.byId.get(target.userId).displayName = "NamaBaru";
await raw(["HSET", `bb:rk:u:${target.userId}`, "refreshedAt", "1"]);
const second = t[1];
api.byId.delete(second.userId);
await raw(["HSET", `bb:rk:u:${second.userId}`, "refreshedAt", "1"]);
t = await top();
check("V16 DisplayName refreshed from Roblox (24h refresh)", entry(t, (e) => e.userId === target.userId).displayName === "NamaBaru");
const ban = entry(t, (e) => e.userId === second.userId);
check("V16 banned / deleted account -> still counted, no avatar, no ROYAL", ban && ban.available === false && ban.royal === false && ban.total > 0);

// ---------- 4. switches, guards, keys ----------
await flush();
process.env.USERNAME_MATCH = "0";
const offCalls = api.calls.names;
await hook(tx("pocay88", 1000));
check("V17 USERNAME_MATCH off -> no API call, still counted (UNMATCHED)", api.calls.names === offCalls && entry(await top(), (e) => e.name === "pocay88" && e.identity === "UNMATCHED"));
process.env.USERNAME_MATCH = "1";
process.env.VERCEL_ENV = "production";
r = await hook({ transaction_id: "smoke-abc", name: "x", amount: 1000, message: "", created_at: "" });
check("V18 production: 'smoke-*' test transaction ignored, nothing written", r.body.ignored && (await raw(["EXISTS", "bb:processed:smoke-abc"])) === 0 && (await raw(["EXISTS", "bb:tx:smoke-abc"])) === 0);
r = await hook(tx("Nama Asli", 1000)); // not a username -> no Roblox call (on Vercel the real API would be used)
check("V18 production: real transactions still accepted", r.body.accepted === true);
delete process.env.VERCEL_ENV;
const dupTx = tx("pocay88", 4321);
await hook(dupTx);
await raw(["DEL", `bb:processed:${dupTx.transaction_id}`]); // marker expired after a year
r = await hook(dupTx);
check("V19 duplicate is caught by the permanent ledger even after the marker expired", r.body.duplicate === true && entry(await top(), (e) => e.userId === 8717004329).total === 4321);
let cc = "", ce = 0;
try { cc = execFileSync("node", ["scripts/check-consistency.mjs"], { env: { ...process.env, BB_STRICT_KEYS: "" }, encoding: "utf8" }); } catch (e) { cc = String(e.stdout); ce = e.status; }
check("V20 check-consistency: ranking == ledger", ce === 0 && cc.includes("mismatches 0"), cc.split("\n").find((l) => l.startsWith("gold ranking")));
await raw(["ZINCRBY", "bb:rank", "1", "u:8717004329"]);
try { cc = execFileSync("node", ["scripts/check-consistency.mjs"], { env: { ...process.env, BB_STRICT_KEYS: "" }, encoding: "utf8" }); ce = 0; } catch (e) { cc = String(e.stdout); ce = e.status; }
check("V20 check-consistency detects a wrong total", ce === 1 && cc.includes("mismatches 1"));
await raw(["ZINCRBY", "bb:rank", "-1", "u:8717004329"]);
check("V21 POST with the GET key -> 401; GET with the POST key -> 401", (await post({ action: "status", userId: 1 }, "v3-feed-key")).code === 401 && (await feed("v3-link-key")).code === 401);
check("V21 POST with the link key works", (await post({ action: "status", userId: 1 })).body.ok === true);
await raw(["SET", "bb:link:code:existinghash", "111"]);
const col = await raw(["EVAL", rbMod.__scripts.CREATE_SCRIPT, "4", "bb:link:pending:222", "bb:link:code:existinghash", "bb:link:rate:222", "bb:unused:code", "222", "existinghash", "1800", "10", ""]);
check("V22 a code that already exists is never overwritten (SET NX / collision)", String(col[0]) === "collision" && (await raw(["GET", "bb:link:code:existinghash"])) === "111");
process.env.LINK_GLOBAL_PER_MINUTE = "3";
await raw(["EVAL", "for _, k in ipairs(redis.call('KEYS', 'bb:link:global:*')) do redis.call('DEL', k) end return 1", "0"]);
const codes = [];
for (let i = 0; i < 4; i++) codes.push((await post({ action: "status", userId: 500 + i })).code);
check("V23 global POST rate limit", codes.slice(0, 3).every((c) => c === 200) && codes[3] === 429, codes.join(","));
delete process.env.LINK_GLOBAL_PER_MINUTE;
await raw(["EVAL", "for _, k in ipairs(redis.call('KEYS', 'bb:link:global:*')) do redis.call('DEL', k) end return 1", "0"]);
const lc = (await post({ action: "create", userId: 777 })).body.code;
await hook(tx("pocay88", 3000, `kode lama ${lc}`));
t = await top();
check("V24 old link code still works (compatibility) and is NOT required", entry(t, (e) => e.userId === 777 && e.total === 3000) && entry(t, (e) => e.userId === 8717004329).total === 4321);
process.env.UPSTASH_REDIS_REST_URL = "https://example-staging-12345.upstash.io";
const fp = (await feed()).body;
check("V28 response tells environment + database fingerprint (for the smoke test guard)",
  fp.env === "local" && fp.dbFingerprint === createHash("sha256").update("example-staging-12345.upstash.io").digest("hex").slice(0, 12) && fp.apiVersion === 3);
delete process.env.UPSTASH_REDIS_REST_URL;
check("V29 old fields unchanged for current Roblox clients (donations, leaderboard, nextCursor)", Array.isArray(fp.donations) && Array.isArray(fp.leaderboard) && "nextCursor" in fp && Array.isArray(fp.top50));
check("V30 no Lua script touched an undeclared key", stats.undeclared === 0, `undeclared=${stats.undeclared}`);
check("V31 no secrets / codes in logs", !logs.join("\n").includes(lc) && !logs.join("\n").includes("v3-link-key"));


// ---------- 5. v3.1 TEST webhooks + gross amount ----------
await flush();
await hook(tx("pocay88", 10000)); // one real donation as reference
const keysBefore = (await raw(["KEYS", "*"])).filter((k) => !k.startsWith("bb:rbx:")).sort().join(",");
const rankBefore = await rankSum();
const tw = (id, amount, extra = {}) => ({ transaction_id: id, name: "Tes Donatur", amount, message: "halo AFB-ABCD-EFGH", mediaShareUrl: "", created_at: "", ...extra });
r = await hook(tw("t-flag-1", 25000, { test: true }));
check("T1 signed test webhook (test:true) accepted as TEST", r.body.ok === true && r.body.test === true && r.body.accepted === true);
let g2 = (await feed()).body;
const t1row = (g2.tests || []).find((t) => t.id === "t-flag-1");
check("T1 GET tests[] carries it (amount, name, test flag, code removed from message)", t1row && t1row.amount === 25000 && t1row.test === true && t1row.name === "Tes Donatur" && !String(t1row.message).includes("AFB"));
check("T1 NOT in donations / history / top50 / leaderboard", !JSON.stringify([g2.donations, g2.history, g2.top50, g2.leaderboard]).includes("t-flag-1"));
const keysAfter = (await raw(["KEYS", "*"])).filter((k) => !k.startsWith("bb:rbx:") && k !== "bb:testfeed" && !k.startsWith("bb:testseen:")).sort().join(",");
check("T1 no ledger / processed marker / rank / donor / history / link key written", keysAfter === keysBefore && (await rankSum()) === rankBefore && (await raw(["EXISTS", "bb:tx:t-flag-1"])) === 0 && (await raw(["EXISTS", "bb:processed:t-flag-1"])) === 0);
r = await hook(tw("t-flag-1", 25000, { test: true }));
check("T2 the same test again = duplicate (one alert only)", r.body.duplicate === true && (g2 = (await feed()).body, (g2.tests || []).filter((t) => t.id === "t-flag-1").length === 1));
r = await hook(tw("test-prefix-1", 5000));
check("T3 transaction_id 'test-...' (outside production) = TEST", r.body.test === true && (await raw(["EXISTS", "bb:tx:test-prefix-1"])) === 0);
for (const k of ["is_test", "isTest"]) { r = await hook(tw("t-" + k, 1000, { [k]: true })); check(`T3 flag ${k}: true = TEST`, r.body.test === true); }
r = await hook(tw("t-string-flag", 1000, { test: "true" }));
check("T3 test: \"true\" (string) is NOT a test flag -> counted as a normal donation", r.body.accepted === true && r.body.test === undefined && (await raw(["EXISTS", "bb:tx:t-string-flag"])) === 1);
process.env.VERCEL_ENV = "production";
r = await hook(tw("t-prod-1", 9000, { test: true }));
check("T4 production: test webhook ignored, nothing stored", r.body.ignored && (await raw(["ZSCORE", "bb:testfeed", "x"])) === null && !((await feed()).body.tests || []).some((t) => t.id === "t-prod-1"));
r = await hook(tw("test-real-id-1", 4000));
check("T4 production: an id starting with 'test-' WITHOUT a test flag is a REAL donation (never dropped)", r.body.accepted === true && (await raw(["EXISTS", "bb:tx:test-real-id-1"])) === 1);
process.env.ALLOW_TEST_WEBHOOKS = "1";
r = await hook(tw("t-prod-allowed", 9000, { test: true }));
check("T4 production + ALLOW_TEST_WEBHOOKS=1: accepted as TEST only", r.body.test === true && (await raw(["EXISTS", "bb:tx:t-prod-allowed"])) === 0);
delete process.env.ALLOW_TEST_WEBHOOKS; delete process.env.VERCEL_ENV;
await raw(["ZADD", "bb:testfeed", String(Date.now() - 16 * 60000), JSON.stringify({ id: "t-old", amount: 1, test: true })]);
check("T5 tests older than 15 minutes are not delivered", !((await feed()).body.tests || []).some((t) => t.id === "t-old"));
{ const rr = mkRes(); await rb({ method: "GET", headers: { "x-api-key": "v3-feed-key" }, query: { since: String(Date.now() + 60000) } }, rr);
  check("T5 a client whose window starts after the test does not get it again (since cursor)", rr.code === 200 && !(rr.body.tests || []).some((t) => t.id === "t-flag-1")); }
// gross amount
process.env.AMOUNT_FIELD = "gross_amount";
r = await hook({ ...tx("pocay88", 9500), gross_amount: 10000 });
let txh = await raw(["HGET", "bb:tx:v3-" + n, "amount"]);
check("G1 AMOUNT_FIELD=gross_amount: the GROSS field is counted, not 'amount'", r.body.accepted === true && txh === "10000", txh);
r = await hook({ ...tx("pocay88", 9500), gross_amount: "20000" });
txh = await raw(["HGET", "bb:tx:v3-" + n, "amount"]);
check("G1 a numeric string is accepted", txh === "20000");
process.env.AMOUNT_FIELD = "data.gross";
r = await hook({ ...tx("pocay88", 1), data: { gross: 30000 } });
txh = await raw(["HGET", "bb:tx:v3-" + n, "amount"]);
check("G1 dotted path (data.gross) works", txh === "30000");
process.env.AMOUNT_FIELD = "bad field;drop";
r = await hook(tx("pocay88", 4000));
txh = await raw(["HGET", "bb:tx:v3-" + n, "amount"]);
check("G2 invalid AMOUNT_FIELD falls back to 'amount'", txh === "4000");
process.env.AMOUNT_FIELD = "gross_amount";
r = await hook(tx("pocay88", 4000));
check("G2 gross field missing -> rejected (never counts the net amount by mistake)", r.code === 400);
delete process.env.AMOUNT_FIELD;
process.env.LOG_WEBHOOK_KEYS = "1";
const logged = [];
const origLog = console.log; console.log = (...a) => logged.push(a.join(" "));
await hook({ ...tx("Nama Rahasia", 10000, "pesan rahasia"), net_amount: 9500, fee: 500 });
console.log = origLog;
delete process.env.LOG_WEBHOOK_KEYS;
const lj = logged.join("\n");
check("G3 LOG_WEBHOOK_KEYS logs amount-like numbers to find the gross field, never names / messages", lj.includes("amount=10000") && lj.includes("net_amount=9500") && lj.includes("fee=500") && !lj.includes("Rahasia") && !lj.includes("rahasia"));

// ---------- 6. review fix: token-owned locks with compare-and-delete ----------
await flush();
const { withLock } = rbMod.__locks;
let ran = false;
let okL = await withLock("bb:test:lock", 20, async () => { ran = true; check("L1 while working, the lock holds a random token (not a fixed value)", /^[0-9a-f-]{36}$/.test(String(await raw(["GET", "bb:test:lock"])))); });
check("L1 owner runs the work and releases its own lock", okL === true && ran && (await raw(["EXISTS", "bb:test:lock"])) === 0);
await raw(["SET", "bb:test:lock", "token-of-B", "EX", "20"]);
ran = false;
okL = await withLock("bb:test:lock", 20, async () => { ran = true; });
check("L2 lock held by someone else: no work, the other lock is untouched", okL === false && !ran && (await raw(["GET", "bb:test:lock"])) === "token-of-B");
await raw(["DEL", "bb:test:lock"]);
okL = await withLock("bb:test:lock", 20, async () => {
  // A runs longer than its TTL: its lock expires and B takes the lock while A is still working
  await raw(["DEL", "bb:test:lock"]);
  await raw(["SET", "bb:test:lock", "token-of-B", "EX", "20"]);
});
check("L3 an OLD holder whose lock expired never deletes the NEW holder's lock", (await raw(["GET", "bb:test:lock"])) === "token-of-B");
await raw(["DEL", "bb:test:lock"]);
let threw = false;
try { await withLock("bb:test:lock", 20, async () => { throw new Error("work failed"); }); } catch { threw = true; }
check("L4 work throws: the error is passed on and the lock is still released", threw && (await raw(["EXISTS", "bb:test:lock"])) === 0);
faults.beforeEval = async (script) => { if (script.includes("redis.call('DEL', KEYS[1])") && script.includes("GET")) throw new Error("network"); };
okL = await withLock("bb:test:lock", 20, async () => {});
faults.beforeEval = null;
const ttlLeft = await raw(["TTL", "bb:test:lock"]);
check("L5 release fails (network): no crash, the lock simply expires by its TTL", okL === true && ttlLeft > 0 && ttlLeft <= 20, `ttl=${ttlLeft}`);
await raw(["DEL", "bb:test:lock"]);
// end to end through GET: pending resolution + 24h refresh with the real lock keys
api.mode = "500";
await hook(tx("player01", 4000));
api.mode = "ok"; await clearBackoff();
await raw(["SET", "bb:rbx:lock", "foreign-token", "EX", "20"]);
await feed();
check("L6 GET while another server holds bb:rbx:lock: pending stays pending, foreign lock untouched",
  (await raw(["ZCARD", "bb:rbx:pending"])) === 1 && (await raw(["GET", "bb:rbx:lock"])) === "foreign-token");
await raw(["DEL", "bb:rbx:lock"]);
await feed();
check("L6 next GET takes the lock, resolves the pending donation and releases its own lock",
  (await raw(["ZCARD", "bb:rbx:pending"])) === 0 && (await raw(["EXISTS", "bb:rbx:lock"])) === 0 && entry(await top(), (e) => e.userId === 3001).total === 4000);
await raw(["HSET", "bb:rk:u:3001", "refreshedAt", "1"]);
await raw(["SET", "bb:rbx:refreshlock", "foreign-refresh", "EX", "30"]);
await feed();
check("L7 24h refresh skipped while another server holds bb:rbx:refreshlock, foreign lock untouched",
  (await raw(["HGET", "bb:rk:u:3001", "refreshedAt"])) === "1" && (await raw(["GET", "bb:rbx:refreshlock"])) === "foreign-refresh");
await raw(["DEL", "bb:rbx:refreshlock"]);
await feed();
check("L7 next GET refreshes and releases its own refresh lock",
  Number(await raw(["HGET", "bb:rk:u:3001", "refreshedAt"])) > 1 && (await raw(["EXISTS", "bb:rbx:refreshlock"])) === 0);
check("T6 v3.1 scripts touched no undeclared key either", stats.undeclared === 0, `undeclared=${stats.undeclared}`);
out(`\n${pass} passed, ${fail} failed`);
apiServer.close(); redisSrv.kill(); process.exit(fail ? 1 : 0);
