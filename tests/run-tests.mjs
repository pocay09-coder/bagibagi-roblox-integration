// Backend v2 tests against a LOCAL redis-server (separate test database, never Upstash production).
import { spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { writeFileSync } from "node:fs";

const PORT = 6390;
process.env.BB_TEST_REDIS_PORT = String(PORT);
process.env.BAGIBAGI_WEBHOOK_TOKEN = "test-webhook-token";
process.env.ROBLOX_API_KEY = "test-api-key";
process.env.LINK_CODE_SECRET = "test-link-secret";
process.env.ROBLOX_LINK_API_KEY = "test-link-key";

const server = spawn("redis-server", ["--port", String(PORT), "--save", "", "--appendonly", "no"], { stdio: "ignore" });
const { raw, faults, stats } = await import("@upstash/redis");
for (let i = 0; i < 50; i++) {
  try { if ((await raw(["PING"])) === "PONG") break; } catch {}
  await new Promise((r) => setTimeout(r, 100));
}

// capture logs: no link code may ever appear in them
const logs = [];
const origErr = console.error, origLog = console.log;
console.error = (...a) => logs.push(a.join(" "));
console.log = (...a) => logs.push(a.join(" "));
const out = (...a) => origLog(...a);

const webhook = (await import("./api/webhook.js")).default;
const roblox = (await import("./api/roblox.js")).default;

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) pass++; else fail++;
  out(`${cond ? "PASS" : "FAIL"} ${name}${extra !== undefined ? " | " + extra : ""}`);
}
function mkRes() {
  const r = { code: 0, body: null, headers: {} };
  r.status = (c) => { r.code = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  r.setHeader = (k, v) => { r.headers[k] = v; };
  return r;
}
async function hook(body, sig) {
  const res = mkRes();
  const s = sig ?? createHmac("sha256", process.env.BAGIBAGI_WEBHOOK_TOKEN).update(JSON.stringify(body)).digest("hex");
  await webhook({ method: "POST", headers: { "x-bagibagi-signature": s }, body }, res);
  return res;
}
const tx = (id, name, amount, message = "", extra = {}) => ({ transaction_id: id, name, amount, message, mediaShareUrl: "", created_at: "2026-11-18T13:00:00Z", ...extra });
async function feed(query = { since: "1" }, key = "test-api-key") {
  const res = mkRes();
  await roblox({ method: "GET", headers: { "x-api-key": key }, query }, res);
  return res;
}
async function link(action, userId, key = "test-link-key") {
  const res = mkRes();
  await roblox({ method: "POST", headers: { "x-api-key": key }, query: {}, body: { action, userId } }, res);
  return res;
}
const flush = () => raw(["FLUSHALL"]);
const total = async (member) => Number(await raw(["ZSCORE", "bb:donors", member]) || 0);
const nameKey = (n) => Buffer.from(n.toLowerCase(), "utf8").toString("base64url");
async function dumpAll() {
  const keys = await raw(["KEYS", "*"]);
  let s = keys.join("\n");
  for (const k of keys) {
    const t = await raw(["TYPE", k]);
    if (t === "string") s += "\n" + (await raw(["GET", k]));
    if (t === "list") s += "\n" + (await raw(["LRANGE", k, "0", "-1"])).join("\n");
    if (t === "zset") s += "\n" + (await raw(["ZRANGE", k, "0", "-1", "WITHSCORES"])).join("\n");
    if (t === "hash") s += "\n" + (await raw(["HGETALL", k])).join("\n");
    if (t === "set") s += "\n" + (await raw(["SMEMBERS", k])).join("\n");
  }
  return s;
}

// ===================== PRIORITY 1: transactions =====================
await flush();
let r = await hook(tx("t1", "Budi", 10000, "Semangat"));
check("T1 first transaction accepted", r.code === 200 && r.body.accepted === true);
check("T1 feed + history + leaderboard + metadata written together",
  (await raw(["ZCARD", "bb:feed"])) === 1 && (await raw(["LLEN", "bb:history"])) === 1 && (await total(nameKey("Budi"))) === 10000 &&
  (await raw(["HGET", `bb:donor:${nameKey("Budi")}`, "name"])) === "Budi" && (await raw(["EXISTS", "bb:processed:t1"])) === 1);
r = await hook(tx("t1", "Budi", 10000, "Semangat"));
check("T2 identical retry -> duplicate, total unchanged", r.body.duplicate === true && (await total(nameKey("Budi"))) === 10000);
r = await hook(tx("t1", "Budi", 99999, "lain"));
check("T3 retry with changed fields, same tx id -> duplicate, unchanged", r.body.duplicate === true && (await total(nameKey("Budi"))) === 10000 && (await raw(["ZCARD", "bb:feed"])) === 1);

// timeout AFTER the write succeeded (response lost) -> BagiBagi retries
let once = true;
faults.afterEval = async (script) => { if (once && script.includes("idempotency")) { once = false; throw new Error("ETIMEDOUT"); } };
r = await hook(tx("t4", "Cici", 20000));
const firstCode = r.code;
faults.afterEval = null;
r = await hook(tx("t4", "Cici", 20000));
check("T4 timeout after commit: 500, retry = duplicate, counted once", firstCode === 500 && r.body.duplicate === true && (await total(nameKey("Cici"))) === 20000);

// crash BEFORE the write
once = true;
faults.beforeEval = async (script) => { if (once && script.includes("idempotency")) { once = false; throw new Error("process crashed"); } };
r = await hook(tx("t5", "Dedi", 30000));
const crashCode = r.code;
const afterCrash = await raw(["EXISTS", "bb:processed:t5"]);
faults.beforeEval = null;
r = await hook(tx("t5", "Dedi", 30000));
check("T5 crash before commit: nothing stored, retry stores once", crashCode === 500 && afterCrash === 0 && r.body.accepted === true && (await total(nameKey("Dedi"))) === 30000);

// a write that would fail mid-way (wrong key type) must not leave anything behind
await raw(["RENAME", "bb:history", "bb:history:saved"]);
await raw(["SET", "bb:history", "broken"]);
const feedBefore = await raw(["ZCARD", "bb:feed"]);
r = await hook(tx("t6", "Eka", 40000));
check("T6 failing write is rejected BEFORE any write (no partial result)", r.code === 500 && (await raw(["EXISTS", "bb:processed:t6"])) === 0 &&
  (await raw(["ZCARD", "bb:feed"])) === feedBefore && (await total(nameKey("Eka"))) === 0);
await raw(["DEL", "bb:history"]);
await raw(["RENAME", "bb:history:saved", "bb:history"]);
r = await hook(tx("t6", "Eka", 40000));
check("T6 after repair the retry stores once", r.body.accepted === true && (await total(nameKey("Eka"))) === 40000);

// parallel duplicates
let results = await Promise.all(Array.from({ length: 25 }, () => hook(tx("t7", "Fafa", 5000))));
check("T7 25 parallel deliveries of one tx -> 1 accepted, 24 duplicate, counted once",
  results.filter((x) => x.body.accepted).length === 1 && results.filter((x) => x.body.duplicate).length === 24 && (await total(nameKey("Fafa"))) === 5000);

// parallel distinct + unique increasing scores
results = await Promise.all(Array.from({ length: 40 }, (_, i) => hook(tx(`p${i}`, "Paralel", 1000 + i))));
const z = await raw(["ZRANGE", "bb:feed", "0", "-1", "WITHSCORES"]);
const scores = []; for (let i = 1; i < z.length; i += 2) scores.push(Number(z[i]));
const uniqueInc = scores.every((s, i) => i === 0 || s > scores[i - 1]);
check("T8 40 parallel different tx -> all stored, total exact", results.every((x) => x.body.accepted) && (await total(nameKey("Paralel"))) === 40 * 1000 + (39 * 40) / 2);
check("T8 feed scores unique and strictly increasing (commit order)", uniqueInc && new Set(scores).size === scores.length);

// ===================== existing (v1) Upstash data =====================
await flush();
const legacyMember = JSON.stringify({ id: "legacy-1", name: "Lama", amount: 50000, message: "v1", robloxUsername: null, createdAt: "", receivedAt: 1763000000000 });
await raw(["ZADD", "bb:feed", "1763000000000", legacyMember]);
await raw(["LPUSH", "bb:history", legacyMember]);
await raw(["ZINCRBY", "bb:donors", "50000", nameKey("Lama")]);
await raw(["HSET", `bb:donor:${nameKey("Lama")}`, "name", "Lama", "robloxUsername", ""]);
await raw(["SET", "bb:processed:legacy-1", "1", "EX", "999999"]);
r = await hook(tx("legacy-1", "Lama", 50000, "v1"));
check("T9 tx already stored by v1 -> duplicate (old idempotency keys respected)", r.body.duplicate === true && (await total(nameKey("Lama"))) === 50000);
r = await hook(tx("new-1", "Baru", 7000));
const z2 = await raw(["ZRANGE", "bb:feed", "0", "-1", "WITHSCORES"]);
check("T9 v1 rows kept untouched, new row after them", z2[0] === legacyMember && Number(z2[3]) > Number(z2[1]) && (await raw(["LLEN", "bb:history"])) === 2);
let g = await feed({ since: "1" });
const lbLama = g.body.leaderboard.find((e) => e.name === "Lama");
check("T9 v1 leaderboard entry still listed, identity 'name', no avatar", lbLama && lbLama.total === 50000 && lbLama.identity === "name" && lbLama.robloxUserId === null);
check("T9 v1 donation still readable", g.body.donations.some((d) => d.id === "legacy-1"));

// ===================== PRIORITY 2: one-time link codes =====================
await flush();
let c = await link("create", 111);
const code1 = c.body.code;
check("L1 create: one-time code returned with expiry", c.code === 200 && /^AFB-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/.test(code1) && c.body.expiresIn === 1800, code1);
check("L1 code stored only as a hash with TTL", !(await dumpAll()).includes(code1) && Number(await raw(["TTL", (await raw(["KEYS", "bb:link:code:*"]))[0]])) > 1700);
r = await hook(tx("k1", "POCAY", 50000, `Halo ${code1.toLowerCase()} semangat!`));
g = await feed({ since: "1" });
let d1 = g.body.donations.find((d) => d.id === "k1");
check("L2 donation with valid code -> verified account, avatar", d1.robloxUserId === 111 && d1.identity === "account");
check("L2 code removed from stored message", d1.message === "Halo semangat!", d1.message);
const lbAcc = g.body.leaderboard.find((e) => e.identity === "account");
check("L2 leaderboard entry of the verified account carries robloxUserId", lbAcc && lbAcc.robloxUserId === 111 && lbAcc.total === 50000);
check("L2 code consumed (one-time) + pending cleared", (await raw(["KEYS", "bb:link:code:*"])).length === 0 && (await raw(["EXISTS", "bb:link:pending:111"])) === 0);
let st = await link("status", 111);
check("L2 status: linked", st.body.linked === true && st.body.identities === 1);
r = await hook(tx("k2", "Orang Lain", 9000, `pakai kode bocor ${code1}`));
g = await feed({ since: "1" });
let d2 = g.body.donations.find((d) => d.id === "k2");
check("L3 leaked code reused after use -> NOT linked", d2.robloxUserId === null && d2.identity === "name" && !d2.message.includes("AFB"));
// expired code
c = await link("create", 222);
const code2 = c.body.code;
for (const k of await raw(["KEYS", "bb:link:code:*"])) await raw(["PEXPIRE", k, "1"]);
await new Promise((res) => setTimeout(res, 20));
r = await hook(tx("k3", "Telat", 9000, code2));
g = await feed({ since: "1" });
check("L4 expired code -> NOT linked", g.body.donations.find((d) => d.id === "k3").robloxUserId === null);
// new code replaces the old pending one
const a = (await link("create", 333)).body.code;
const b = (await link("create", 333)).body.code;
await hook(tx("k4", "Ganti", 1000, a));
await hook(tx("k5", "Ganti", 1000, b));
g = await feed({ since: "1" });
check("L5 a new code cancels the previous one", g.body.donations.find((d) => d.id === "k4").robloxUserId === null && g.body.donations.find((d) => d.id === "k5").robloxUserId === 333);
// rate limit
let codes429 = 0;
for (let i = 0; i < 12; i++) if ((await link("create", 444)).code === 429) codes429++;
check("L6 code creation rate-limited (10 per hour per account)", codes429 === 2);
// same name: linked vs not linked
const cb = (await link("create", 555)).body.code;
await hook(tx("s1", "Budi", 10000, cb));
await hook(tx("s2", "Budi", 20000, "aku Budi juga @pocay88"));
g = await feed({ since: "1" });
const budis = g.body.leaderboard.filter((e) => e.name === "Budi");
check("L7 two donors named Budi stay separate; avatar only on the verified one",
  budis.length === 2 && budis.filter((e) => e.robloxUserId === 555).length === 1 && budis.filter((e) => e.robloxUserId === null).length === 1);
check("L7 @username in message never links", g.body.donations.find((d) => d.id === "s2").robloxUserId === null);
// unlink
let u = await link("unlink", 111);
g = await feed({ since: "1" });
const lbAfter = g.body.leaderboard.find((e) => e.identity === "account" && e.total === 50000);
st = await link("status", 111);
check("L8 unlink: avatar removed from leaderboard, total kept, status not linked", u.body.removed === 1 && lbAfter && lbAfter.robloxUserId === null && st.body.linked === false);
const relink = (await link("create", 111)).body.code;
await hook(tx("k6", "POCAY", 5000, relink));
g = await feed({ since: "1" });
check("L8 re-link after unlink works again", g.body.leaderboard.some((e) => e.robloxUserId === 111));
check("L9 no code in API responses or logs",
  ![code1, code2, a, b, cb, relink].some((x) => JSON.stringify(g.body).toUpperCase().includes(x) || logs.join("\n").toUpperCase().includes(x)));
const all = await dumpAll();
check("L9 no code in any Redis key or value", ![code1, code2, a, b, cb, relink].some((x) => all.includes(x) || all.includes(x.toLowerCase())));
check("L10 invalid code-shaped text is removed but never links", await (async () => {
  await hook(tx("k7", "Iseng", 1000, "coba AFB-ABCI-EFGH ya"));
  const gg = await feed({ since: "1" });
  const dd = gg.body.donations.find((x) => x.id === "k7");
  return dd.message === "coba ya" && dd.robloxUserId === null;
})());

// stable donor id path (only if BagiBagi sends such a field)
process.env.DONOR_ID_FIELD = "supporter_email";
process.env.DONOR_ID_SECRET = "test-donor-secret";
const cd = (await link("create", 777)).body.code;
await hook(tx("d1", "Rani", 10000, cd, { supporter_email: "rani@example.com" }));
await hook(tx("d2", "Rani", 15000, "tanpa kode", { supporter_email: "rani@example.com" }));
await hook(tx("d3", "Rani", 3000, "Rani lain", { supporter_email: "other@example.com" }));
g = await feed({ since: "1" });
const d2r = g.body.donations.find((x) => x.id === "d2");
const ranis = g.body.leaderboard.filter((e) => e.name === "Rani");
check("L11 donorId: later donation WITHOUT code gets the verified avatar automatically", d2r.robloxUserId === 777 && d2r.identity === "donor");
check("L11 donorId: same name, different donor -> separate, no avatar", ranis.length === 2 && ranis.some((e) => e.robloxUserId === 777 && e.total === 25000) && ranis.some((e) => e.robloxUserId === null && e.total === 3000));
check("L11 raw donor field never stored", !(await dumpAll()).includes("rani@example.com"));
await link("unlink", 777);
await hook(tx("d4", "Rani", 1000, "setelah lepas", { supporter_email: "rani@example.com" }));
g = await feed({ since: "1" });
check("L11 donorId: after unlink no avatar any more", g.body.donations.find((x) => x.id === "d4").robloxUserId === null);
delete process.env.DONOR_ID_FIELD;
delete process.env.DONOR_ID_SECRET;

// ===================== PRIORITY 3: pagination with equal timestamps =====================
await flush();
const realNow = Date.now;
Date.now = () => 1763450000000; // every webhook gets the SAME millisecond
for (let i = 0; i < 250; i++) await hook(tx(`m${String(i).padStart(3, "0")}`, "Burst", 100));
Date.now = realNow;
let seen = new Set(), dupl = 0, pages = 0, cursor = null, order = [];
for (;;) {
  const q = cursor ? { after: cursor } : { since: "1763449999000" };
  const pg = await feed(q);
  pages++;
  for (const d of pg.body.donations) { if (seen.has(d.id)) dupl++; seen.add(d.id); order.push(d.id); }
  if (!pg.body.hasMore) break;
  cursor = pg.body.nextCursor;
  if (pages > 10) break;
}
check("P1 250 donations in ONE millisecond: cursor paging returns all exactly once", seen.size === 250 && dupl === 0 && pages === 3, `pages=${pages}`);
check("P1 commit order kept", order.every((id, i) => i === 0 || id > order[i - 1]));
const v1style = await feed({ since: "1763450000000" });
check("P2 v1 clients (since=ms) still work; first page = 100 rows + nextCursor", v1style.body.donations.length === 100 && typeof v1style.body.nextCursor === "string");
await hook(tx("late", "Telat", 100));
const afterLast = await feed({ after: cursor });
check("P3 a row committed later is always AFTER the last cursor (no missed rows)", afterLast.body.donations.some((d) => d.id === "late"));
check("P4 feed keeps max 500 rows", (await raw(["ZCARD", "bb:feed"])) <= 500);

// ===================== auth / config =====================
check("A1 GET without key -> 401", (await feed({ since: "1" }, "")).code === 401);
check("A2 POST link without key -> 401", (await link("create", 1, "wrong")).code === 401);
check("A2b the GET (feed) key is NOT accepted for POST", (await link("create", 1, "test-api-key")).code === 401);
const savedSecret = process.env.LINK_CODE_SECRET;
delete process.env.LINK_CODE_SECRET;
check("A3 linking without LINK_CODE_SECRET -> 503 (feature off, feed still works)", (await link("create", 1)).code === 503 && (await feed({ since: "1" })).code === 200);
r = await hook(tx("nosecret", "X", 100, "AFB-ABCD-EFGH"));
check("A3 webhook without LINK_CODE_SECRET still stores the donation (code ignored, removed)", r.body.accepted === true);
process.env.LINK_CODE_SECRET = savedSecret;
check("A4 bad signature -> 401, nothing stored", (await hook(tx("sig", "X", 100), "00".repeat(32))).code === 401 && (await raw(["EXISTS", "bb:processed:sig"])) === 0);
check("A5 userId validated", (await link("create", "abc")).code === 400 && (await link("create", -5)).code === 400);


// ===================== AUDIT v2.1 =====================
out("\n--- audit v2.1 ---");
const { Redis: StubRedis } = await import("@upstash/redis");
let strictCaught = false;
try { await new StubRedis().eval("return redis.call('GET', 'not-declared')", [], []); } catch (e) { strictCaught = /UNDECLARED/.test(e.message); }
check("S0 strict mode active: a script touching an undeclared key fails", process.env.BB_STRICT_KEYS !== "1" || strictCaught);

const snapshot = async () => (await dumpAll()).split("\n").sort().join("\n");
// X1: every key with a wrong type is refused BEFORE any write
async function wrongType(label, setup, breakIt, repair, makeTx) {
  await flush();
  await setup();
  const before = await snapshot();
  await breakIt();
  const broken = await snapshot();
  const rr = await hook(makeTx());
  const after = await snapshot();
  await repair();
  const retry = await hook(makeTx());
  check(`X1 wrong type ${label}: refused, nothing written, retry stores once`, rr.code === 500 && after === broken && retry.body.accepted === true, `code=${rr.code}`);
}
const noop = async () => {};
const simple = (id) => () => tx(id, "Budi", 1000, "halo");
for (const [label, key, bad] of [
  ["bb:feed", "bb:feed", ["SET", "bb:feed", "x"]],
  ["bb:feed:last", "bb:feed:last", ["RPUSH", "bb:feed:last", "x"]],
  ["bb:history", "bb:history", ["SET", "bb:history", "x"]],
  ["bb:donors", "bb:donors", ["SET", "bb:donors", "x"]],
  ["bb:avatar", "bb:avatar", ["SET", "bb:avatar", "x"]],
  ["name profile", `bb:donor:${nameKey("Budi")}`, ["SET", `bb:donor:${nameKey("Budi")}`, "x"]],
]) {
  await wrongType(label, noop, () => raw(bad), () => raw(["DEL", key]), simple("wt-" + label));
}
await flush();
await raw(["SET", "bb:feed:last", "abc"]);
let rr = await hook(tx("wt-value", "Budi", 1000));
check("X1 non-numeric bb:feed:last refused before writes", rr.code === 500 && (await raw(["EXISTS", "bb:processed:wt-value"])) === 0);
let linkCodeX;
for (const [label, keyOf, bad] of [
  ["pending", (u) => `bb:link:pending:${u}`, (k) => ["HSET", k, "a", "b"]],
  ["avatar user set", (u) => `bb:avatar:user:${u}`, (k) => ["SET", k, "x"]],
  ["last link", (u) => `bb:link:last:${u}`, (k) => ["SET", k, "x"]],
  ["account profile", (u) => `bb:donor:uid:${u}`, (k) => ["SET", k, "x"]],
]) {
  await wrongType(label, async () => { linkCodeX = (await link("create", 900)).body.code; },
    async () => { const k = keyOf(900); if (label === "pending") { await raw(["DEL", k]); } await raw(bad(k)); },
    async () => { await raw(["DEL", keyOf(900)]); },
    () => tx("wt-" + label, "POCAY", 1000, `kode ${linkCodeX}`));
}
await flush();
linkCodeX = (await link("create", 901)).body.code;
for (const k of await raw(["KEYS", "bb:link:code:*"])) { await raw(["DEL", k]); await raw(["RPUSH", k, "x"]); }
rr = await hook(tx("wt-code", "POCAY", 1000, linkCodeX));
check("X1 code key with wrong type: refused, nothing written", rr.code === 500 && (await raw(["EXISTS", "bb:processed:wt-code"])) === 0 && (await raw(["EXISTS", "bb:feed"])) === 0);

// X2: a command REJECTED in the middle of the script (Redis has no rollback) -> marker stays "pending",
// never counted twice, reported by check-consistency
async function midFailure(label, deny, expect) {
  await flush();
  await raw(["ACL", "SETUSER", "limited", "reset", "on", ">pw", "~*", "&*", "+@all", ...deny.map((c) => "-" + c)], false);
  process.env.BB_TEST_REDIS_USER = "limited"; process.env.BB_TEST_REDIS_PASS = "pw";
  const first = await hook(tx("mid-" + label, "Gagal", 7000));
  delete process.env.BB_TEST_REDIS_USER; delete process.env.BB_TEST_REDIS_PASS;
  const marker = String(await raw(["GET", "bb:processed:mid-" + label]) ?? "");
  const totalAfter = await total(nameKey("Gagal"));
  const retry = await hook(tx("mid-" + label, "Gagal", 7000));
  const totalRetry = await total(nameKey("Gagal"));
  check(`X2 command ${deny.join("+")} rejected mid-script: ${expect}`, first.code === 500 &&
    (label === "set" ? marker === "" && retry.body.accepted === true && totalRetry === 7000
                     : marker.startsWith("pending|") && retry.body.duplicate === true && totalRetry === totalAfter && totalRetry <= 7000),
    `marker=${marker.split("|")[0] || "none"} total=${totalRetry}`);
}
await midFailure("lpush", ["lpush"], "marker pending, retry = duplicate, total never doubled");
await midFailure("zincrby", ["zincrby"], "marker pending, total not counted, retry = duplicate (manual check)");
await midFailure("set", ["set"], "first write refused -> nothing stored, retry stores once");
await raw(["ACL", "DELUSER", "limited"], false);
// consistency check finds the pending one
await flush();
await raw(["ACL", "SETUSER", "limited", "reset", "on", ">pw", "~*", "&*", "+@all", "-lpush"], false);
process.env.BB_TEST_REDIS_USER = "limited"; process.env.BB_TEST_REDIS_PASS = "pw";
await hook(tx("needs-check", "Gagal", 1000));
delete process.env.BB_TEST_REDIS_USER; delete process.env.BB_TEST_REDIS_PASS;
await raw(["ACL", "DELUSER", "limited"], false);
const { execFileSync } = await import("node:child_process");
let consistencyOut = "", consistencyExit = 0;
try { consistencyOut = execFileSync("node", ["scripts/check-consistency.mjs"], { env: { ...process.env }, encoding: "utf8" }); }
catch (e) { consistencyOut = String(e.stdout); consistencyExit = e.status; }
check("X2 check-consistency reports the interrupted transaction (exit 1)", consistencyExit === 1 && consistencyOut.includes("needs-check"), consistencyOut.split("\n")[0]);

// X3: timeouts / lost responses at every step
await flush();
const cg = (await link("create", 905)).body.code;
once = true;
faults.beforeGet = async () => { if (once) { once = false; throw new Error("ETIMEDOUT on read"); } };
rr = await hook(tx("to-read", "Telat", 1000, cg));
faults.beforeGet = null;
const rr2 = await hook(tx("to-read", "Telat", 1000, cg));
g = await feed({ since: "1" });
check("X3 timeout on the code read: nothing stored, retry stores + links once", rr.code === 500 && rr2.body.accepted === true && g.body.donations.filter((d) => d.id === "to-read").length === 1 && g.body.donations.find((d) => d.id === "to-read").robloxUserId === 905);
once = true;
faults.afterEval = async (script) => { if (once && script.includes("'rate'")) { once = false; throw new Error("ETIMEDOUT"); } };
const lost = await link("create", 906);
faults.afterEval = null;
const again = await link("create", 906);
await hook(tx("to-create", "X", 1000, again.body.code));
g = await feed({ since: "1" });
check("X3 lost 'create' response: retry gives a new working code", lost.code === 500 && again.body.ok === true && g.body.donations.find((d) => d.id === "to-create").robloxUserId === 906);
once = true;
faults.afterEval = async (script) => { if (once && script.includes("SMEMBERS")) { once = false; throw new Error("ETIMEDOUT"); } };
const ul1 = await link("unlink", 906);
faults.afterEval = null;
const ul2 = await link("unlink", 906);
check("X3 lost 'unlink' response: retry is safe, account unlinked", ul1.code === 500 && ul2.body.ok === true && (await link("status", 906)).body.linked === false);

// X4: races between the pre-read and the script
await flush();
const raceCode = (await link("create", 910)).body.code;
const racers = await Promise.all([hook(tx("race-a", "A", 1000, raceCode)), hook(tx("race-b", "B", 1000, raceCode)), hook(tx("race-c", "C", 1000, raceCode))]);
g = await feed({ since: "1" });
check("X4 one code used by 3 parallel donations -> exactly one linked", racers.every((x) => x.body.accepted) && g.body.donations.filter((d) => d.robloxUserId === 910).length === 1);
let codeB2 = null;
once = true;
faults.beforeEval = async (script) => { if (once && script.includes("'rate'")) { once = false; codeB2 = (await link("create", 911)).body.code; } };
const codeA2 = (await link("create", 911)).body.code;
faults.beforeEval = null;
await hook(tx("rc-b", "X", 1000, codeB2));
await hook(tx("rc-a", "X", 1000, codeA2));
g = await feed({ since: "1" });
check("X4 two 'create' at the same time: only the last one stays valid", g.body.donations.find((d) => d.id === "rc-b").robloxUserId === null && g.body.donations.find((d) => d.id === "rc-a").robloxUserId === 911);
await raw(["DEL", "bb:link:rate:912"]);
const preCode = (await link("create", 912)).body.code;
let lateCode = null;
once = true;
faults.beforeEval = async (script) => { if (once && script.includes("SMEMBERS")) { once = false; lateCode = (await link("create", 912)).body.code; } };
await link("unlink", 912);
faults.beforeEval = null;
await hook(tx("ur-1", "X", 1000, lateCode));
await hook(tx("ur-2", "X", 1000, preCode));
g = await feed({ since: "1" });
check("X4 'create' during 'unlink': unlink retries, no code survives", g.body.donations.find((d) => d.id === "ur-1").robloxUserId === null && g.body.donations.find((d) => d.id === "ur-2").robloxUserId === null);

// X5: code leaked BEFORE use / X6: attempts by another account
await flush();
const victimCode = (await link("create", 920)).body.code;
await hook(tx("leak-1", "Penyerang", 5000, `hehe ${victimCode}`));
await hook(tx("leak-2", "Korban", 8000, victimCode));
g = await feed({ since: "1" });
let stV = await link("status", 920);
check("X5 leaked code used first by someone else: links to the CODE OWNER only, never to the other donor's account",
  g.body.donations.find((d) => d.id === "leak-1").robloxUserId === 920 && g.body.donations.find((d) => d.id === "leak-2").robloxUserId === null);
check("X5 owner can see which donation used the code (masked name + amount)", stV.body.lastLinkedDonation && stV.body.lastLinkedDonation.name === "Pe***" && stV.body.lastLinkedDonation.amount === 5000);
await link("unlink", 920);
g = await feed({ since: "1" });
check("X5 owner unlinks -> that leaderboard entry loses the avatar", !g.body.leaderboard.some((e) => e.robloxUserId === 920));
const cA = (await link("create", 930)).body.code;
await link("create", 931);
await hook(tx("acc-1", "B mencoba", 1000, cA));
g = await feed({ since: "1" });
check("X6 another account cannot take over a code (code belongs to the account that created it)", g.body.donations.find((d) => d.id === "acc-1").robloxUserId === 930 && (await link("status", 931)).body.linked === false);
check("X6 'create' for account B does not touch account A's pending code", (await raw(["EXISTS", "bb:link:pending:931"])) === 1);

// X7: cursor vs feed retention (500)
await flush();
let fake = 1763500000000;
Date.now = () => fake++;
for (let i = 0; i < 50; i++) await hook(tx(`ret${String(i).padStart(3, "0")}`, "R", 100));
const early = await feed({ since: "1" });
const earlyCursor = early.body.nextCursor;
for (let i = 50; i < 600; i++) await hook(tx(`ret${String(i).padStart(3, "0")}`, "R", 100));
const recent = await feed({ since: String(fake - 5) });
Date.now = realNow;
const behind = await feed({ after: earlyCursor });
check("X7 client further behind than the 500-row retention -> truncated=true (not silently skipped)", behind.body.truncated === true && behind.body.donations[0].id === "ret100", behind.body.donations[0]?.id);
check("X7 normal client -> truncated=false", recent.body.truncated === false && early.body.truncated === false);

// X8: leaderboard consistency on link / unlink (stable donor id path)
await flush();
process.env.DONOR_ID_FIELD = "supporter_email"; process.env.DONOR_ID_SECRET = "s";
const c1x = (await link("create", 940)).body.code;
await hook(tx("lb1", "Nina", 10000, c1x, { supporter_email: "nina1@example.com" }));
await raw(["DEL", "bb:link:rate:940"]);
const c2x = (await link("create", 940)).body.code;
await hook(tx("lb2", "Nina2", 20000, c2x, { supporter_email: "nina2@example.com" }));
await hook(tx("lb3", "Nina", 4000, "Nina lain", { supporter_email: "other@example.com" }));
g = await feed({ since: "1" });
const sumAll = (lb) => lb.reduce((s, e) => s + e.total, 0);
const verified = g.body.leaderboard.filter((e) => e.robloxUserId === 940);
check("X8 one account linked to two donor ids -> ONE podium entry (30.000)", verified.length === 1 && verified[0].total === 30000);
const sumBefore = sumAll(g.body.leaderboard);
await link("unlink", 940);
g = await feed({ since: "1" });
check("X8 after unlink: no avatar, entries split again, totals unchanged", !g.body.leaderboard.some((e) => e.robloxUserId) && sumAll(g.body.leaderboard) === sumBefore && g.body.leaderboard.length === 3);
await raw(["DEL", "bb:link:rate:940"]);
const c3x = (await link("create", 940)).body.code;
await hook(tx("lb4", "Nina", 1000, c3x, { supporter_email: "nina1@example.com" }));
g = await feed({ since: "1" });
const v2 = g.body.leaderboard.filter((e) => e.robloxUserId === 940);
check("X8 re-link with one donor id: only that identity gets the avatar back", v2.length === 1 && v2[0].total === 11000 && sumAll(g.body.leaderboard) === sumBefore + 1000);
check("X8 unverified same-name entries are never merged", g.body.leaderboard.filter((e) => e.name === "Nina" && !e.robloxUserId).length === 1);
delete process.env.DONOR_ID_FIELD; delete process.env.DONOR_ID_SECRET;
check("S1 no script ever touched an undeclared key during the whole run", stats.undeclared === 1, `undeclared=${stats.undeclared} (1 = the S0 probe)`);

// sample v2 response for the Roblox (BagiBagiLive) compatibility test
await flush();
await raw(["ZADD", "bb:feed", "1763000000000", legacyMember]);
await raw(["ZINCRBY", "bb:donors", "50000", nameKey("Lama")]);
await raw(["HSET", `bb:donor:${nameKey("Lama")}`, "name", "Lama", "robloxUsername", ""]);
const sc = (await link("create", 8717004329)).body.code;
await hook(tx("rb1", "POCAY", 150000, `Semangat ${sc}`));
await hook(tx("rb2", "POCAY", 90000, "POCAY palsu @pocay88"));
await hook(tx("rb3", "Sari", 40000, "halo"));
g = await feed({ since: "1762999999000" });
writeFileSync("./sample-v2-response.json", JSON.stringify(g.body, null, 2));

console.error = origErr; console.log = origLog;
out(`\n${pass} passed, ${fail} failed`);
server.kill();
process.exit(fail ? 1 : 0);
