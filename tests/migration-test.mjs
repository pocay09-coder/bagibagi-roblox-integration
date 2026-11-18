// local test of scripts/migration-report.mjs: correct proposals + the database is byte-for-byte unchanged.
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import http from "node:http";
const PORT = 6395;
process.env.BB_TEST_REDIS_PORT = String(PORT);
process.env.BAGIBAGI_WEBHOOK_TOKEN = "m-token"; process.env.ROBLOX_API_KEY = "m-key"; process.env.ROBLOX_LINK_API_KEY = "m-link"; process.env.LINK_CODE_SECRET = "m-secret";
process.env.USERNAME_MATCH = "1"; process.env.ROBLOX_USERS_API = "http://127.0.0.1:8896"; process.env.ROBLOX_USERS_API_TEST_ONLY = "http://127.0.0.1:8896";
const users = { pocay88: { id: 8717004329, name: "pocay88", displayName: "POCAY" }, budi_rbx: { id: 2001, name: "budi_rbx", displayName: "Budi" } };
let apiCalls = 0;
const api = http.createServer((req, res) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { apiCalls++; const j = JSON.parse(b || "{}");
  res.end(JSON.stringify({ data: (j.usernames || []).map((n) => users[n.toLowerCase()] && { requestedUsername: n, ...users[n.toLowerCase()] }).filter(Boolean) })); }); });
await new Promise((r) => api.listen(8896, r));
const srv = spawn("redis-server", ["--port", String(PORT), "--save", "", "--appendonly", "no"], { stdio: "ignore" });
const { raw } = await import("@upstash/redis");
for (let i = 0; i < 50; i++) { try { if ((await raw(["PING"])) === "PONG") break; } catch {} await new Promise((r) => setTimeout(r, 100)); }
let pass = 0, fail = 0; const check = (n, c, x) => { c ? pass++ : fail++; console.log(`${c ? "PASS" : "FAIL"} ${n}${x !== undefined ? " | " + x : ""}`); };
const b64 = (s) => Buffer.from(s.toLowerCase(), "utf8").toString("base64url");
// legacy (v1 / v2.1) data as it exists before v3: name entries + one account linked by the old code
const legacy = [["pocay88", 50000], ["Budi_RBX", 20000], ["Budi Santoso", 15000], ["hilang_akun", 7000]];
for (const [name, amt] of legacy) { await raw(["ZINCRBY", "bb:donors", String(amt), b64(name)]); await raw(["HSET", `bb:donor:${b64(name)}`, "name", name]); }
await raw(["ZINCRBY", "bb:donors", "9000", "uid:777"]); await raw(["HSET", "bb:donor:uid:777", "name", "Akun Kode"]);
// then v3 goes live and pocay88 donates 3.000 more (v3 also adds it to the old bb:donors entry)
const wh = (await import("./api/webhook.js")).default;
const body = { transaction_id: "m-1", name: "pocay88", amount: 3000, message: "", mediaShareUrl: "", created_at: "" };
const res = { status() { return this; }, json(b) { this.body = b; return this; }, setHeader() {} };
await wh({ method: "POST", headers: { "x-bagibagi-signature": createHmac("sha256", "m-token").update(JSON.stringify(body)).digest("hex") }, body }, res);
const snapshot = async () => {
  const keys = (await raw(["KEYS", "*"])).sort(); const out = [];
  for (const k of keys) {
    const t = String(await raw(["TYPE", k]));
    const v = t === "string" ? await raw(["GET", k]) : t === "hash" ? await raw(["HGETALL", k]) : t === "zset" ? await raw(["ZRANGE", k, "0", "-1", "WITHSCORES"])
      : t === "list" ? await raw(["LRANGE", k, "0", "-1"]) : t === "set" ? (await raw(["SMEMBERS", k])).sort() : "?";
    out.push(`${k}|${t}|${JSON.stringify(v)}|ttl>0:${(await raw(["PTTL", k])) > 0}`);
  }
  return out.join("\n");
};
const before = await snapshot();
const callsBefore = apiCalls;
// async on purpose: the fake Roblox API lives in this process and must keep answering
const { stdout: log } = await promisify(execFile)("node", ["scripts/migration-report.mjs", "/tmp/mig-report"], { env: process.env, encoding: "utf8" });
const after = await snapshot();
check("report did not change the database at all (every key + value + TTL identical)", before === after, `${before.split("\n").length} keys`);
check("Roblox lookups batched (1 request for all names)", apiCalls - callsBefore === 1, apiCalls - callsBefore);
const rep = JSON.parse(readFileSync("/tmp/mig-report.json", "utf8"));
const row = (n) => rep.rows.find((r) => r.name === n);
check("pocay88: old 53.000 minus 3.000 already counted by v3 = 50.000 historical -> u:8717004329",
  row("pocay88").legacyTotal === 53000 && row("pocay88").countedByV3 === 3000 && row("pocay88").historical === 50000 && row("pocay88").proposed === "u:8717004329");
check("Budi_RBX (other case) -> budi_rbx account, flagged 'not proof of payer'", row("Budi_RBX").proposed === "u:2001" && row("Budi_RBX").flags.includes("USERNAME_MATCHED_NOT_PROOF_OF_PAYER"));
check("'Budi Santoso' (not a username) -> stays a name entry", row("Budi Santoso").proposed.startsWith("n:") && row("Budi Santoso").flags.includes("NOT_A_USERNAME"));
check("hilang_akun (no such account) -> stays a name entry", row("hilang_akun").proposed.startsWith("n:") && row("hilang_akun").flags.includes("USERNAME_NOT_FOUND"));
check("old code link uid:777 -> u:777", row("Akun Kode").proposed === "u:777" && row("Akun Kode").flags.includes("LINKED_BY_OLD_CODE"));
check("summary adds up (historical 101.000 = 79.000 to accounts + 22.000 to names)", rep.summary.historicalTotal === 101000 && rep.summary.toAccounts === 79000 && rep.summary.toNames === 22000, JSON.stringify(rep.summary));
check("CSV written", readFileSync("/tmp/mig-report.csv", "utf8").split("\n").length === 6);
check("log says nothing was changed", log.includes("nothing changed in the database"));
console.log(`\n${pass} passed, ${fail} failed`);
api.close(); srv.kill(); process.exit(fail ? 1 : 0);
