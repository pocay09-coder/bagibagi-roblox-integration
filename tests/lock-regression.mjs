// Regression for the v3.1 review fix: a lock holder that ran past its TTL must not delete a newer holder's lock.
// LOCAL ONLY (local redis-server on 6397, fake Roblox Users API on 8895).
// regression: GET -> resolvePending; mid-work the lock "expires" and server B takes it. Does A delete B's lock?
import { spawn } from "node:child_process";
import http from "node:http";
const dir = process.argv[2] || process.cwd();
process.env.BB_TEST_REDIS_PORT = "6397";
Object.assign(process.env, { BAGIBAGI_WEBHOOK_TOKEN: "t", ROBLOX_API_KEY: "k", ROBLOX_LINK_API_KEY: "l", LINK_CODE_SECRET: "s", USERNAME_MATCH: "1", ROBLOX_USERS_API: "http://127.0.0.1:8895" });
let mode = "500";
const api = http.createServer((q, r) => { let b = ""; q.on("data", (c) => (b += c)); q.on("end", () => {
  if (mode === "500") { r.writeHead(500); return r.end("{}"); }
  r.end(JSON.stringify({ data: [{ requestedUsername: "player01", id: 3001, name: "player01", displayName: "P1" }] })); }); });
await new Promise((ok) => api.listen(8895, ok));
const srv = spawn("redis-server", ["--port", "6397", "--save", "", "--appendonly", "no"], { stdio: "ignore" });
const { raw, faults } = await import(`${dir}/node_modules/@upstash/redis/index.js`);
for (let i = 0; i < 50; i++) { try { if ((await raw(["PING"])) === "PONG") break; } catch {} await new Promise((r) => setTimeout(r, 100)); }
await raw(["FLUSHALL"]);
const { createHmac } = await import("node:crypto");
const wh = (await import(`${dir}/api/webhook.js`)).default, rb = (await import(`${dir}/api/roblox.js`)).default;
const res = () => { const o = {}; o.status = (c) => { o.code = c; return o; }; o.json = (b) => { o.body = b; return o; }; o.setHeader = () => {}; return o; };
const body = { transaction_id: "x1", name: "player01", amount: 4000, message: "", created_at: "" };
await wh({ method: "POST", headers: { "x-bagibagi-signature": createHmac("sha256", "t").update(JSON.stringify(body)).digest("hex") }, body }, res());
mode = "ok"; await raw(["DEL", "bb:rbx:backoff", "bb:rbx:fails"]);
let done = false;
faults.beforeEval = async (script) => {
  if (!done && script.includes("ZINCRBY") && script.includes("resolvedAt")) { // first REATTRIBUTE = A is mid-work
    done = true;
    await raw(["DEL", "bb:rbx:lock"]);                              // A's lock expired
    await raw(["SET", "bb:rbx:lock", "token-of-B", "EX", "20"]);    // server B took it
  }
};
await rb({ method: "GET", headers: { "x-api-key": "k" }, query: { since: "1" } }, res());
const after = await raw(["GET", "bb:rbx:lock"]);
const okLock = done && after === "token-of-B";
console.log(`${okLock ? "PASS" : "FAIL"} old holder (lock expired mid-work) does not delete the new holder lock: ${after === null ? "DELETED" : after}`);
api.close(); srv.kill(); process.exit(okLock ? 0 : 1);
