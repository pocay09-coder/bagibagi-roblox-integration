// Historical Gold migration (scripts/migrate-historical-gold.mjs). LOCAL ONLY: local redis-server + FAKE Roblox Users
// API. Old data is seeded in the exact shape of the production backup (v1 / v2.1 keys only, no v3 keys).
// Covers: dry-run writes nothing, success, duplicates (second run, two runs at once), webhook replay of the old
// transaction, data changing between dry-run and apply, failures in the middle, rollback.
import { spawn, execFile } from "node:child_process";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import http from "node:http";

const PORT = 6398, API_PORT = 8894;
process.env.BB_TEST_REDIS_PORT = String(PORT);
process.env.BAGIBAGI_WEBHOOK_TOKEN = "mig-token";
process.env.ROBLOX_API_KEY = "mig-feed-key";
process.env.ROBLOX_LINK_API_KEY = "mig-link-key";
process.env.LINK_CODE_SECRET = "mig-secret";
process.env.USERNAME_MATCH = "1";
process.env.ROBLOX_USERS_API = `http://127.0.0.1:${API_PORT}`;

// ---------- fake Roblox Users API ----------
const users = new Map([[8717004329, { id: 8717004329, name: "pocay88", displayName: "POCAY" }], [2001, { id: 2001, name: "budi_rbx", displayName: "Budi" }]]);
const apiServer = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const j = JSON.parse(body || "{}");
    const send = (obj) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
    if (req.url === "/v1/usernames/users") {
      const data = [];
      for (const name of j.usernames || []) {
        const u = [...users.values()].find((x) => x.name === String(name).toLowerCase());
        if (u) data.push({ requestedUsername: name, ...u });
      }
      return send({ data });
    }
    if (req.url === "/v1/users") return send({ data: (j.userIds || []).map((id) => users.get(Number(id))).filter(Boolean) });
    res.writeHead(404); res.end("{}");
  });
});
await new Promise((r) => apiServer.listen(API_PORT, r));
const redisSrv = spawn("redis-server", ["--port", String(PORT), "--save", "", "--appendonly", "no"], { stdio: "ignore" });
const { raw, faults } = await import("@upstash/redis");
for (let i = 0; i < 50; i++) { try { if ((await raw(["PING"])) === "PONG") break; } catch {} await new Promise((r) => setTimeout(r, 100)); }
const out = console.log.bind(console);
console.error = () => {};
const wh = (await import("./api/webhook.js")).default;
const rb = (await import("./api/roblox.js")).default;
const mig = await import("./scripts/migrate-historical-gold.mjs");

let pass = 0, fail = 0;
const check = (n, c, x) => { c ? pass++ : fail++; out(`${c ? "PASS" : "FAIL"} ${n}${x !== undefined ? " | " + x : ""}`); };
const mkRes = () => { const r = { headers: {} }; r.status = (c) => { r.code = c; return r; }; r.json = (b) => { r.body = b; return r; }; r.setHeader = (k, v) => { r.headers[k] = v; }; return r; };
async function hook(body) { const r = mkRes(); await wh({ method: "POST", headers: { "x-bagibagi-signature": createHmac("sha256", "mig-token").update(JSON.stringify(body)).digest("hex") }, body }, r); return r; }
async function top() { const r = mkRes(); await rb({ method: "GET", headers: { "x-api-key": "mig-feed-key" }, query: { since: "1" } }, r); return r.body.top50 || []; }
let n = 0;
const tx = (name, amount) => ({ transaction_id: `v3-mig-${++n}`, name, amount, message: "", mediaShareUrl: "", created_at: "" });

const KEY = Buffer.from("pocay88", "utf8").toString("base64url"); // cG9jYXk4OA, like the production report
const SRC = "bagibagi-0000aaaa-test-hist-0001";
const TARGET = "u:8717004329";
const BASE_ARGS = ["--legacy-key", KEY, "--target", TARGET, "--amount", "10000"];
const CONFIRM = `${KEY}:${TARGET}:10000`;
async function m(extra = [], base = BASE_ARGS) {
  const lines = [];
  const code = await mig.main([...base, ...extra], (l) => lines.push(String(l)));
  return { code, text: lines.join("\n") };
}
const gold = async (member = TARGET) => Number((await raw(["ZSCORE", "bb:rank", member])) ?? 0);
async function hgetall(k) { const a = await raw(["HGETALL", k]); const o = {}; for (let i = 0; i < a.length; i += 2) o[a[i]] = a[i + 1]; return o; }
// full database snapshot (every key: type + value; TTL as present / -1)
async function snap(filter = () => true) {
  const keys = (await raw(["KEYS", "*"])).filter(filter).sort();
  const rows = [];
  for (const k of keys) {
    const t = await raw(["TYPE", k]);
    let v = null;
    if (t === "string") v = await raw(["GET", k]);
    else if (t === "hash") v = Object.entries(await hgetall(k)).sort();
    else if (t === "zset") v = await raw(["ZRANGE", k, "0", "-1", "WITHSCORES"]);
    else if (t === "list") v = await raw(["LRANGE", k, "0", "-1"]);
    else if (t === "set") v = (await raw(["SMEMBERS", k])).sort();
    const ttl = await raw(["TTL", k]);
    rows.push([k, t, v, ttl > 0 ? "ttl" : String(ttl)]);
  }
  return JSON.stringify(rows);
}
const OLD_KEYS = (k) => k === "bb:donors" || k.startsWith("bb:donor:") || k === "bb:feed" || k === "bb:history" || k.startsWith("bb:processed:");
const GOLD_VIEW = (k) => OLD_KEYS(k) || k === "bb:rank" || k.startsWith("bb:tx:") || k.startsWith("bb:migration:");
// production-shaped old data (v1 / v2.1): one Rp10.000 donation by "pocay88", counted by the OLD webhook
async function seedLegacy() {
  const row = JSON.stringify({ id: SRC, name: "pocay88", amount: 10000, robloxUsername: null, createdAt: "11/18/2026 7:35:10 PM", receivedAt: 1795005311467 });
  await raw(["ZADD", "bb:donors", "10000", KEY]);
  await raw(["HSET", `bb:donor:${KEY}`, "name", "pocay88", "robloxUsername", ""]);
  await raw(["ZADD", "bb:feed", "1795005311467", row]);
  await raw(["LPUSH", "bb:history", row]);
  await raw(["SET", `bb:processed:${SRC}`, "1", "EX", "31452081"]);
}
async function reset() {
  faults.beforeEval = null; faults.afterEval = null;
  await raw(["FLUSHALL"]);
  await seedLegacy();
  await hook(tx("budi_rbx", 25000)); // an unrelated v3 Gold donor (u:2001), so ranking / consistency are not trivial
  return snap();
}
// async on purpose: the fake Roblox API lives in THIS process and must keep answering while a script runs
const runScript = (args, extraEnv = {}) => new Promise((resolve) => {
  execFile("node", args, { env: { ...process.env, ...extraEnv }, encoding: "utf8", timeout: 60000 }, (e, stdout, stderr) =>
    resolve({ code: e ? (e.code ?? 1) : 0, text: String(stdout || "") + String(stderr || "") }));
});
const consistency = () => runScript(["scripts/check-consistency.mjs"]);
async function report() {
  const r = await runScript(["scripts/migration-report.mjs", "/tmp/mig-hist-test-report"], { ROBLOX_USERS_API_TEST_ONLY: `http://127.0.0.1:${API_PORT}` });
  if (r.code !== 0) return null;
  return JSON.parse(readFileSync("/tmp/mig-hist-test-report.json", "utf8")).rows.find((x) => x.legacyKey === KEY);
}
const isApply = (script) => script.includes("'migrating'");

// ---------- 1. dry-run ----------
let base = await reset();
let d = await m();
check("M1 dry-run: exit 0, READY", d.code === 0 && d.text.includes("RESULT: READY"), d.code);
check("M1 dry-run shows historical 10,000 / target / existing Gold 0 / add 10,000 / predicted 10,000",
  /historical amount\s+: 10,000/.test(d.text) && d.text.includes(`target UserId        : ${TARGET}`) && /existing Gold\s+: 0 /.test(d.text) &&
  /amount to add\s+: 10,000/.test(d.text) && /predicted total\s+: 10,000/.test(d.text));
check("M1 dry-run: predicted Gold rank #2 of 2 (budi 25,000 is above)", d.text.includes("predicted Gold rank #2 of 2"));
check("M1 dry-run lists the source transaction and its old webhook marker", d.text.includes(SRC) && d.text.includes("webhook marker: present (v1"));
check("M1 dry-run wrote nothing (every key + value + TTL identical)", (await snap()) === base);
d = await m([], ["--legacy-key", KEY, "--target", TARGET, "--amount", "15000"]);
check("M2 wrong amount (15,000 != historical 10,000) -> REFUSED, nothing written", d.code === 1 && d.text.includes("FAIL approved amount") && (await snap()) === base);
d = await m([], ["--legacy-key", "bm9ib2R5", "--target", TARGET, "--amount", "10000"]);
check("M2 unknown old entry -> REFUSED", d.code === 1 && d.text.includes("REFUSED"));
d = await m([], ["--legacy-key", KEY, "--target", "8717004329", "--amount", "10000"]);
check("M2 target without u: -> usage error", d.code === 2);
d = await m(["--apply"]);
check("M3 --apply without --confirm -> refused, nothing written", d.code === 2 && (await snap()) === base);
d = await m(["--apply", "--confirm", `${KEY}:${TARGET}:1000`]);
check("M3 --apply with a wrong --confirm -> refused, nothing written", d.code === 2 && (await snap()) === base);

// ---------- 2. success ----------
const oldBefore = await snap(OLD_KEYS);
d = await m(["--apply", "--confirm", CONFIRM]);
check("M4 apply: APPLIED once, Gold 0 -> 10,000", d.code === 0 && d.text.includes("RESULT: APPLIED once") && (await gold()) === 10000, d.text.split("\n").pop());
const row = await hgetall(`bb:tx:${SRC}`);
check("M4 ledger row bb:tx:<original id>: 10000, target, migrated, legacy key, time of the old donation",
  row.amount === "10000" && row.member === TARGET && row.status === "migrated" && row.legacy === KEY && row.at === "1795005311467" && row.migration === mig.MIGRATION_ID);
const rec = await hgetall(`bb:migration:hist:${KEY}`);
check("M4 record: state done, Gold before 0 after 10000, rankApplied 1", rec.state === "done" && rec.rankBefore === "" && rec.rankAfter === "10000" && rec.rankApplied === "1" && rec.txIds === SRC);
check("M4 old data untouched: bb:donors, bb:donor:*, bb:feed, bb:history, bb:processed:* (+TTL) identical", (await snap(OLD_KEYS)) === oldBefore);
check("M4 budi's Gold unchanged", (await gold("u:2001")) === 25000);
let c = await consistency();
check("M4 check-consistency after apply: consistent", c.code === 0 && c.text.includes("RESULT: consistent"), c.text.split("\n").find((l) => l.startsWith("gold ranking")));
let rep = await report();
check("M4 migration report after apply: counted by v3 10,000, historical 0 (nothing left to migrate)", rep && rep.countedByV3 === 10000 && rep.historical === 0);
d = await m(["--verify"]);
check("M4 --verify: APPLIED and consistent", d.code === 0 && d.text.includes("RESULT: APPLIED and consistent"));
const t50 = await top();
const pe = t50.find((e) => e.userId === 8717004329);
check("M5 Top 50: pocay88 as USERNAME_MATCHED, total 10,000, rank #2, #2 ROYAL", pe && pe.identity === "USERNAME_MATCHED" && pe.total === 10000 && pe.rank === 2 && pe.royalTag === "#2 ROYAL", pe && pe.name);

// ---------- 3. duplicates ----------
let after = await snap();
d = await m(["--apply", "--confirm", CONFIRM]);
check("M6 second apply -> ALREADY APPLIED, nothing written", d.code === 0 && d.text.includes("ALREADY APPLIED") && (await snap()) === after);
d = await m();
check("M6 dry-run after apply -> ALREADY APPLIED", d.code === 0 && d.text.includes("ALREADY APPLIED"));
const view = await snap(GOLD_VIEW);
let r = await hook({ transaction_id: SRC, name: "pocay88", amount: 10000, message: "", mediaShareUrl: "", created_at: "" });
check("M7 webhook replay of the OLD transaction -> duplicate, Gold / feed / history / donors unchanged", r.body && r.body.duplicate === true && (await snap(GOLD_VIEW)) === view && (await gold()) === 10000);
await raw(["DEL", `bb:processed:${SRC}`]); // old marker expired (simulated)
r = await hook({ transaction_id: SRC, name: "pocay88", amount: 10000, message: "", mediaShareUrl: "", created_at: "" });
check("M7 replay after the old marker expired -> still duplicate (v3 ledger row never expires)", r.body && r.body.duplicate === true && (await gold()) === 10000);

base = await reset();
const [p1, p2] = await Promise.all([m(["--apply", "--confirm", CONFIRM]), m(["--apply", "--confirm", CONFIRM])]);
const texts = [p1.text, p2.text];
check("M8 two applies at the same time -> exactly one APPLIED, the other ALREADY, Gold 10,000",
  texts.filter((x) => x.includes("APPLIED once")).length === 1 && texts.filter((x) => x.includes("ALREADY APPLIED")).length === 1 && (await gold()) === 10000);

// ---------- 4. data changes between the read and the apply ----------
base = await reset();
let once = true;
faults.beforeEval = async (script) => { if (once && isApply(script)) { once = false; await hook(tx("pocay88", 5000)); } };
d = await m(["--apply", "--confirm", CONFIRM]);
faults.beforeEval = null;
check("M9 a new v3 donation by pocay88 lands just before the apply -> REFUSED (old total changed), nothing migrated",
  d.code === 1 && d.text.includes("changed") && (await gold()) === 5000 && (await raw(["EXISTS", `bb:migration:hist:${KEY}`])) === 0 && (await raw(["EXISTS", `bb:tx:${SRC}`])) === 0);
d = await m();
check("M9 new dry-run: historical still 10,000, existing Gold 5,000, predicted 15,000", d.code === 0 && /historical amount\s+: 10,000/.test(d.text) && /existing Gold\s+: 5,000/.test(d.text) && /predicted total\s+: 15,000/.test(d.text));
d = await m(["--apply", "--confirm", CONFIRM]);
c = await consistency();
check("M9 apply again -> Gold 15,000 (5,000 new + 10,000 historical), consistent", d.code === 0 && (await gold()) === 15000 && c.text.includes("RESULT: consistent"));

// ---------- 5. failures in the middle ----------
base = await reset();
process.env.BB_TEST_REDIS_PORT = "6393"; // nothing listens there: database unreachable
d = await m(["--apply", "--confirm", CONFIRM]);
process.env.BB_TEST_REDIS_PORT = String(PORT);
check("F1 database unreachable -> ERROR, nothing written", d.code === 1 && d.text.includes("ERROR") && (await snap()) === base);
d = await m(["--apply", "--confirm", CONFIRM]);
check("F1 later apply -> applied once", d.code === 0 && (await gold()) === 10000);

base = await reset();
once = true;
faults.afterEval = async (script) => { if (once && isApply(script)) { once = false; throw new Error("ETIMEDOUT (answer lost)"); } };
d = await m(["--apply", "--confirm", CONFIRM]);
faults.afterEval = null;
check("F2 answer lost AFTER the write -> tool reports ERROR (outcome unknown)", d.code === 1 && d.text.includes("ERROR"));
d = await m(["--apply", "--confirm", CONFIRM]);
check("F2 repeated apply -> ALREADY APPLIED, Gold 10,000 (never twice)", d.code === 0 && d.text.includes("ALREADY APPLIED") && (await gold()) === 10000);

base = await reset();
await raw(["DEL", "bb:rank"]); await raw(["SET", "bb:rank", "broken"]);
const brokenBase = await snap();
d = await m(["--apply", "--confirm", CONFIRM]);
check("F3 bb:rank has a wrong type -> REFUSED before any write", d.code === 1 && d.text.includes("REFUSED") && (await snap()) === brokenBase);
base = await reset();
once = true;
faults.beforeEval = async (script) => { if (once && isApply(script)) { once = false; await raw(["SET", `bb:rk:${TARGET}`, "broken"]); } };
d = await m(["--apply", "--confirm", CONFIRM]);
faults.beforeEval = null;
await raw(["DEL", `bb:rk:${TARGET}`]);
check("F3 wrong key type appears just before the apply -> the Lua check refuses BEFORE the first write", d.code === 1 && d.text.includes("BBTYPE rk") && (await snap()) === base);

for (const [cmd, label, goldAfterFail] of [["zincrby", "F4", 0], ["hsetnx", "F5", 10000]]) {
  base = await reset();
  await raw(["ACL", "SETUSER", "limited", "reset", "on", ">pw", "~*", "&*", "+@all", `-${cmd}`], false);
  process.env.BB_TEST_REDIS_USER = "limited"; process.env.BB_TEST_REDIS_PASS = "pw";
  d = await m(["--apply", "--confirm", CONFIRM]);
  delete process.env.BB_TEST_REDIS_USER; delete process.env.BB_TEST_REDIS_PASS;
  await raw(["ACL", "DELUSER", "limited"], false);
  const rr = await hgetall(`bb:migration:hist:${KEY}`);
  check(`${label} ${cmd.toUpperCase()} rejected in the middle of the script -> stops; Gold ${goldAfterFail}, record 'applying', rankApplied ${goldAfterFail ? 1 : 0}`,
    d.code === 1 && rr.state === "applying" && rr.rankApplied === (goldAfterFail ? "1" : "0") && (await gold()) === goldAfterFail, d.text.split("\n").pop());
  d = await m(["--apply", "--confirm", CONFIRM]);
  check(`${label} apply again -> INCOMPLETE, refused, Gold still ${goldAfterFail} (never added twice)`, d.code === 1 && d.text.includes("INCOMPLETE") && (await gold()) === goldAfterFail);
  d = await m(["--verify"]);
  check(`${label} --verify explains where it stopped`, d.code === 1 && d.text.includes(goldAfterFail ? "after the Gold was added" : "BEFORE the Gold was added"));
  d = await m(["--rollback", "--confirm", CONFIRM]);
  check(`${label} --rollback -> database exactly as before the migration`, d.code === 0 && d.text.includes("ROLLED BACK") && (await snap()) === base);
  d = await m(["--apply", "--confirm", CONFIRM]);
  check(`${label} apply after rollback -> applied once, Gold 10,000, consistent`, d.code === 0 && (await gold()) === 10000 && (await consistency()).text.includes("RESULT: consistent"));
}

// ---------- 6. rollback ----------
base = await reset();
await m(["--apply", "--confirm", CONFIRM]);
after = await snap();
d = await m(["--rollback"]);
check("R1 rollback plan writes nothing and shows Gold 10,000 -> 0", d.code === 0 && d.text.includes("ROLLBACK PLAN") && /after rollback 0/.test(d.text) && (await snap()) === after);
d = await m(["--rollback", "--confirm", CONFIRM]);
check("R1 rollback -> database exactly as before the migration", d.code === 0 && (await snap()) === base);
d = await m(["--rollback", "--confirm", CONFIRM]);
check("R1 second rollback -> nothing to roll back", d.code === 0 && d.text.includes("nothing to roll back"));
r = await hook({ transaction_id: SRC, name: "pocay88", amount: 10000, message: "", mediaShareUrl: "", created_at: "" });
check("R1 after rollback the old transaction is still a duplicate (old marker untouched)", r.body && r.body.duplicate === true && (await gold()) === 0);
d = await m(["--apply", "--confirm", CONFIRM]);
check("R1 migration can be applied again after a rollback", d.code === 0 && (await gold()) === 10000);

base = await reset();
await m(["--apply", "--confirm", CONFIRM]);
await hook(tx("pocay88", 5000));
d = await m(["--rollback", "--confirm", CONFIRM]);
c = await consistency();
rep = await report();
check("R2 rollback after a newer v3 donation -> Gold 5,000 kept, metadata kept, consistent, 10,000 migratable again",
  d.code === 0 && (await gold()) === 5000 && (await raw(["EXISTS", `bb:rk:${TARGET}`])) === 1 && c.text.includes("RESULT: consistent") && rep && rep.historical === 10000);
await m(["--apply", "--confirm", CONFIRM]);
d = await m(["--rollback", "--confirm", `${KEY}:${TARGET}:9000`], ["--legacy-key", KEY, "--target", TARGET, "--amount", "9000"]);
check("R3 rollback with a different amount -> refused, nothing changed", d.code === 1 && (await gold()) === 15000);

out(`${pass} passed, ${fail} failed`);
redisSrv.kill();
apiServer.close();
process.exit(fail ? 1 : 0);
