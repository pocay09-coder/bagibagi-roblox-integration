// Gold repair tools - LOCAL ONLY (local redis-server, local HTTP wrapper around the handlers, FAKE Roblox Users API):
//   * anonymous names ("Seseorang", ...) are never matched to a Roblox account
//   * scripts/replay-bagibagi-donation.mjs: a missed donation re-sent once through the real webhook code
//   * scripts/void-gold-transaction.mjs: a transaction counted by mistake removed exactly, reversibly, never twice
import { spawn, execFile } from "node:child_process";
import { createHmac } from "node:crypto";
import http from "node:http";

const PORT = 6388, API_PORT = 8893, HTTP_PORT = 8792;
process.env.BB_TEST_REDIS_PORT = String(PORT);
process.env.BAGIBAGI_WEBHOOK_TOKEN = "repair-token";
process.env.ROBLOX_API_KEY = "repair-feed-key";
process.env.ROBLOX_LINK_API_KEY = "repair-link-key";
process.env.LINK_CODE_SECRET = "repair-secret";
process.env.USERNAME_MATCH = "1";
process.env.ROBLOX_USERS_API = `http://127.0.0.1:${API_PORT}`;

const users = [
  { id: 8717004329, name: "pocay88", displayName: "POCAY" },
  { id: 117961194, name: "seseorang", displayName: "seseorang" }, // a real account that happens to be called "seseorang"
  { id: 2001, name: "budi_rbx", displayName: "Budi" },
];
const api = http.createServer((req, res) => {
  let b = "";
  req.on("data", (c) => (b += c));
  req.on("end", () => {
    const j = JSON.parse(b || "{}");
    const data = req.url === "/v1/usernames/users"
      ? (j.usernames || []).map((n) => { const u = users.find((x) => x.name === String(n).toLowerCase()); return u && { requestedUsername: n, ...u }; }).filter(Boolean)
      : (j.userIds || []).map((id) => users.find((u) => u.id === Number(id))).filter(Boolean);
    res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ data }));
  });
});
await new Promise((r) => api.listen(API_PORT, r));
const redisSrv = spawn("redis-server", ["--port", String(PORT), "--save", "", "--appendonly", "no"], { stdio: "ignore" });
const { raw } = await import("@upstash/redis");
for (let i = 0; i < 50; i++) { try { if ((await raw(["PING"])) === "PONG") break; } catch {} await new Promise((r) => setTimeout(r, 100)); }
const out = console.log.bind(console);
console.error = () => {};
const wh = (await import("./api/webhook.js")).default;
const rb = (await import("./api/roblox.js")).default;
const { usernameCandidate } = await import("./lib/roblox-users.js");
const voidTool = await import("./scripts/void-gold-transaction.mjs");

// local HTTP wrapper (like Vercel) so the replay script really sends an HTTP request
let httpHits = 0;
const srv = http.createServer((req, res) => {
  let data = "";
  req.on("data", (c) => (data += c));
  req.on("end", async () => {
    httpHits++;
    const vreq = { method: req.method, headers: req.headers, query: {}, body: data ? JSON.parse(data) : undefined };
    const vres = { statusCode: 200, status(c) { this.statusCode = c; return this; }, setHeader(k, v) { res.setHeader(k, v); },
      json(b) { res.statusCode = this.statusCode; res.setHeader("content-type", "application/json"); res.end(JSON.stringify(b)); return this; } };
    if (new URL(req.url, "http://x").pathname !== "/api/webhook") { res.statusCode = 404; return res.end("{}"); }
    await wh(vreq, vres);
  });
});
await new Promise((r) => srv.listen(HTTP_PORT, r));

let pass = 0, fail = 0;
const check = (n, c, x) => { c ? pass++ : fail++; out(`${c ? "PASS" : "FAIL"} ${n}${x !== undefined ? " | " + x : ""}`); };
const mkRes = () => { const r = { headers: {} }; r.status = (c) => { r.code = c; return r; }; r.json = (b) => { r.body = b; return r; }; r.setHeader = (k, v) => { r.headers[k] = v; }; return r; };
async function hook(body) { const r = mkRes(); await wh({ method: "POST", headers: { "x-bagibagi-signature": createHmac("sha256", "repair-token").update(JSON.stringify(body)).digest("hex") }, body }, r); return r; }
async function feed() { const r = mkRes(); await rb({ method: "GET", headers: { "x-api-key": "repair-feed-key" }, query: { since: "1" } }, r); return r.body; }
const donation = (id, name, amount, message = "") => ({ transaction_id: id, name, amount, message, mediaShareUrl: "", created_at: "11/20/2026 1:40:01 AM" });
const gold = async (m) => Number((await raw(["ZSCORE", "bb:rank", m])) ?? 0);
async function hgetall(k) { const a = await raw(["HGETALL", k]); const o = {}; for (let i = 0; i < a.length; i += 2) o[a[i]] = a[i + 1]; return o; }
async function snap(filter = () => true) {
  const keys = (await raw(["KEYS", "*"])).filter((k) => !k.startsWith("bb:rbx:") && filter(k)).sort(); // lookup caches excluded
  const rows = [];
  for (const k of keys) {
    const t = await raw(["TYPE", k]);
    let v = null;
    if (t === "string") v = await raw(["GET", k]);
    else if (t === "hash") v = Object.entries(await hgetall(k)).sort();
    else if (t === "zset") v = await raw(["ZRANGE", k, "0", "-1", "WITHSCORES"]);
    else if (t === "list") v = await raw(["LRANGE", k, "0", "-1"]);
    else if (t === "set") v = (await raw(["SMEMBERS", k])).sort();
    rows.push([k, t, v, (await raw(["TTL", k])) > 0 ? "ttl" : "-"]);
  }
  return JSON.stringify(rows);
}
const runNode = (args, extraEnv = {}) => new Promise((resolve) => {
  execFile("node", args, { env: { ...process.env, ...extraEnv }, encoding: "utf8", timeout: 60000 }, (e, so, se) =>
    resolve({ code: e ? (e.code ?? 1) : 0, text: String(so || "") + String(se || "") }));
});
const consistency = () => runNode(["scripts/check-consistency.mjs"]);
async function v(extra, base) { const lines = []; const code = await voidTool.main([...base, ...extra], (l) => lines.push(String(l))); return { code, text: lines.join("\n") }; }

// ---------- 1. anonymous names ----------
check("A1 usernameCandidate: Seseorang / seseorang / @Anonim / anonymous -> no lookup",
  ["Seseorang", "seseorang", "@Anonim", "anonymous", "Hamba_Allah", "someone"].every((n) => usernameCandidate(n) === null));
check("A1 usernameCandidate: real usernames still looked up", usernameCandidate("pocay88") === "pocay88" && usernameCandidate("@budi_rbx") === "budi_rbx");
await raw(["FLUSHALL"]);
let r = await hook(donation("bagibagi-anon-0001", "Seseorang", 10000, "Selamat ngedonasi!"));
let f = await feed();
const anonRow = (f.history || []).find((x) => x.id === "bagibagi-anon-0001");
const anonTop = (f.top50 || []).find((x) => x.name === "Seseorang");
check("A2 donation from 'Seseorang' (an account 'seseorang' exists): counted, but UNMATCHED - no UserId, no avatar",
  r.body?.accepted === true && anonRow && anonRow.match === "unmatched" && !anonRow.matchedUserId && anonTop && anonTop.identity === "UNMATCHED" && !anonTop.userId,
  anonRow && anonRow.match);
check("A2 the account 'seseorang' (117961194) got nothing", (await gold("u:117961194")) === 0);

// ---------- 2. replay of a missed donation (real HTTP, real webhook code) ----------
await raw(["FLUSHALL"]);
const REF = "0f6d6ffd-8398-4bac-fcb9-08df447192e2";
const replayArgs = ["scripts/replay-bagibagi-donation.mjs", "--ref", REF, "--name", "pocay88", "--amount", "10000", "--message", "test", "--created", "11/20/2026 1:32:00 AM"];
const replayEnv = { WEBHOOK_URL: `http://127.0.0.1:${HTTP_PORT}/api/webhook` };
let before = await snap();
httpHits = 0;
let p = await runNode(replayArgs, replayEnv);
check("P1 dry-run: exit 0, nothing sent, database unchanged", p.code === 0 && p.text.includes("DRY-RUN") && httpHits === 0 && (await snap()) === before);
check("P1 dry-run shows transaction_id bagibagi-<ref>, name, amount, message, created_at",
  p.text.includes(`bagibagi-${REF}`) && p.text.includes("pocay88 / 10,000") && p.text.includes('"test"') && p.text.includes("11/20/2026 1:32:00 AM"));
p = await runNode([...replayArgs, "--send"], replayEnv);
check("P2 --send without --confirm -> refused, nothing sent", p.code === 2 && httpHits === 0);
p = await runNode([...replayArgs, "--send", "--confirm", "x"], replayEnv);
check("P2 --send with a wrong --confirm -> refused, nothing sent", p.code === 2 && httpHits === 0);
p = await runNode([...replayArgs, "--send", "--confirm", REF], { WEBHOOK_URL: "http://example.com/api/webhook" });
check("P2 plain http to a non-local host -> refused", p.code === 2 && p.text.includes("https"));
p = await runNode([...replayArgs, "--send", "--confirm", REF], { ...replayEnv, BAGIBAGI_WEBHOOK_TOKEN: "wrong-token" });
check("P2 wrong token -> backend answers 401, nothing counted", p.code === 1 && p.text.includes("401") && (await gold("u:8717004329")) === 0);
p = await runNode([...replayArgs, "--send", "--confirm", REF], replayEnv);
const txRow = await hgetall(`bb:tx:bagibagi-${REF}`);
f = await feed();
const hRow = (f.history || []).find((x) => x.id === `bagibagi-${REF}`);
const dRow = (f.donations || []).find((x) => x.id === `bagibagi-${REF}`);
check("P3 send -> ACCEPTED: Gold pocay88 +10,000 (matched to u:8717004329)", p.code === 0 && p.text.includes("ACCEPTED") && (await gold("u:8717004329")) === 10000 && txRow.member === "u:8717004329" && txRow.status === "matched", p.text.split("\n").pop());
check("P3 history row: name pocay88, message 'test', created_at from the receipt, avatar UserId", hRow && hRow.name === "pocay88" && hRow.message === "test" && hRow.createdAt === "11/20/2026 1:32:00 AM" && hRow.matchedUserId === 8717004329);
check("P3 in the feed for the in-game alert (donations[]) with its message", dRow && dRow.message === "test");
let c = await consistency();
check("P3 check-consistency: consistent", c.code === 0 && c.text.includes("RESULT: consistent"));
before = await snap();
p = await runNode([...replayArgs, "--send", "--confirm", REF], replayEnv);
check("P4 send again -> DUPLICATE, nothing changed", p.code === 0 && p.text.includes("DUPLICATE") && (await snap()) === before && (await gold("u:8717004329")) === 10000);

// ---------- 3. void a transaction counted by mistake ----------
// the mistaken one: matched to an account (like the 'Seseorang' test that the old code matched to u:117961194)
await raw(["FLUSHALL"]);
await hook(donation("bagibagi-real-0001", "pocay88", 10000, "test"));
await hook(donation("bagibagi-oops-0001", "budi_rbx", 10000, "Selamat ngedonasi!")); // stands in for the mistaken test
const VARGS = ["--tx", "bagibagi-oops-0001", "--member", "u:2001", "--amount", "10000"];
const base = await snap();
let d = await v([], VARGS);
check("V1 dry-run: READY, nothing written", d.code === 0 && d.text.includes("RESULT: READY") && (await snap()) === base);
check("V1 dry-run shows Gold u:2001 10,000 -> 0 (removed), 1 history row, 1 feed row", d.text.includes("10,000 -> 0 (removed from the ranking)") && d.text.includes("history / feed rows  : 1 / 1"));
d = await v([], ["--tx", "bagibagi-oops-0001", "--member", "u:2001", "--amount", "9000"]);
check("V2 wrong amount -> REFUSED, nothing written", d.code === 1 && d.text.includes("REFUSED") && (await snap()) === base);
d = await v([], ["--tx", "bagibagi-oops-0001", "--member", "u:8717004329", "--amount", "10000"]);
check("V2 wrong member -> REFUSED", d.code === 1 && d.text.includes("REFUSED"));
d = await v(["--apply"], VARGS);
check("V2 --apply without --confirm -> refused", d.code === 2 && (await snap()) === base);
d = await v(["--apply", "--confirm", "bagibagi-oops-0001"], VARGS);
const tomb = await hgetall("bb:tx:bagibagi-oops-0001");
f = await feed();
check("V3 apply: VOIDED, Gold u:2001 removed, pocay88 unchanged", d.code === 0 && d.text.includes("VOIDED once") && (await gold("u:2001")) === 0 && (await gold("u:8717004329")) === 10000, d.text.split("\n").pop());
check("V3 tombstone kept: amount 0, status voided", tomb.amount === "0" && tomb.status === "voided" && tomb.member === "" && tomb.origMember === "u:2001");
check("V3 gone from Top 50, history and feed; old-leaderboard copy removed",
  !(f.top50 || []).some((x) => x.userId === 2001) && !(f.history || []).some((x) => x.id === "bagibagi-oops-0001") && !(f.donations || []).some((x) => x.id === "bagibagi-oops-0001")
  && (await raw(["ZSCORE", "bb:donors", Buffer.from("budi_rbx").toString("base64url")])) === null);
check("V3 webhook marker kept", (await raw(["EXISTS", "bb:processed:bagibagi-oops-0001"])) === 1);
c = await consistency();
check("V3 check-consistency: consistent", c.code === 0 && c.text.includes("RESULT: consistent"), c.text.split("\n").find((l) => l.startsWith("gold ranking")));
d = await v(["--verify"], VARGS);
check("V3 --verify: VOIDED and clean", d.code === 0 && d.text.includes("VOIDED and clean"));
let after = await snap();
d = await v(["--apply", "--confirm", "bagibagi-oops-0001"], VARGS);
check("V4 apply again -> ALREADY VOIDED, nothing written", d.code === 0 && d.text.includes("ALREADY VOIDED") && (await snap()) === after);
r = await hook(donation("bagibagi-oops-0001", "budi_rbx", 10000, "Selamat ngedonasi!"));
check("V4 webhook resend of the voided id -> duplicate, Gold unchanged", r.body?.duplicate === true && (await gold("u:2001")) === 0);
await raw(["DEL", "bb:processed:bagibagi-oops-0001"]); // old marker expired (simulated)
r = await hook(donation("bagibagi-oops-0001", "budi_rbx", 10000, "Selamat ngedonasi!"));
check("V4 resend after the marker expired -> still duplicate (tombstone)", r.body?.duplicate === true && (await gold("u:2001")) === 0);

// rollback must restore the exact state (fresh run so the marker is the original one)
await raw(["FLUSHALL"]);
await hook(donation("bagibagi-real-0001", "pocay88", 10000, "test"));
await hook(donation("bagibagi-oops-0001", "budi_rbx", 10000, "Selamat ngedonasi!"));
await hook(donation("bagibagi-real-0002", "pocay88", 10000, "test lagi")); // a newer row on top of the history
const base2 = await snap();
await v(["--apply", "--confirm", "bagibagi-oops-0001"], VARGS);
d = await v(["--rollback"], VARGS);
check("R1 rollback plan writes nothing", d.code === 0 && d.text.includes("ROLLBACK PLAN"));
d = await v(["--rollback", "--confirm", "bagibagi-oops-0001"], VARGS);
check("R1 rollback -> database exactly as before the void (history position too)", d.code === 0 && d.text.includes("ROLLED BACK") && (await snap()) === base2);
d = await v(["--rollback", "--confirm", "bagibagi-oops-0001"], VARGS);
check("R1 second rollback -> nothing to roll back", d.code === 0 && d.text.includes("nothing to roll back"));

// member with other donations: Gold decreases, metadata stays
await raw(["FLUSHALL"]);
await hook(donation("bagibagi-keep-0001", "budi_rbx", 5000, "first"));
await hook(donation("bagibagi-oops-0002", "budi_rbx", 10000, "mistake"));
d = await v(["--apply", "--confirm", "bagibagi-oops-0002"], ["--tx", "bagibagi-oops-0002", "--member", "u:2001", "--amount", "10000"]);
c = await consistency();
check("R2 member keeps other donations: Gold 15,000 -> 5,000, metadata kept, consistent",
  d.code === 0 && (await gold("u:2001")) === 5000 && (await raw(["EXISTS", "bb:rk:u:2001"])) === 1 && c.text.includes("RESULT: consistent"));
d = await v([], ["--tx", "bagibagi-oops-0002", "--member", "u:2001", "--amount", "10000"]);
check("R2 dry-run after the void -> ALREADY VOIDED", d.code === 0 && d.text.includes("ALREADY VOIDED"));

out(`${pass} passed, ${fail} failed`);
redisSrv.kill(); api.close(); srv.close();
process.exit(fail ? 1 : 0);
