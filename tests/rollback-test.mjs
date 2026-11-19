import { spawn } from "node:child_process";
import { createHmac } from "node:crypto";
process.env.BB_TEST_REDIS_PORT = "6392";
process.env.BAGIBAGI_WEBHOOK_TOKEN = "tok"; process.env.ROBLOX_API_KEY = "key"; process.env.LINK_CODE_SECRET = "sec"; process.env.ROBLOX_LINK_API_KEY = "lkey";
const srv = spawn("redis-server", ["--port", "6392", "--save", "", "--appendonly", "no"], { stdio: "ignore" });
await new Promise((r) => setTimeout(r, 400));
const { raw } = await import("@upstash/redis");
const v2w = (await import("./api/webhook.js")).default, v2r = (await import("./api/roblox.js")).default;
const v1w = (await import("./v1/api/webhook.js")).default, v1r = (await import("./v1/api/roblox.js")).default;
let pass = 0, fail = 0;
const check = (n, c, x) => { c ? pass++ : fail++; console.log(`${c ? "PASS" : "FAIL"} ${n}${x !== undefined ? " | " + x : ""}`); };
const res = () => { const r = {}; r.status = (c) => { r.code = c; return r; }; r.json = (b) => { r.body = b; return r; }; r.setHeader = () => {}; return r; };
const hook = async (h, body) => { const r = res(); await h({ method: "POST", headers: { "x-bagibagi-signature": createHmac("sha256", "tok").update(JSON.stringify(body)).digest("hex") }, body }, r); return r; };
const get = async (h, q) => { const r = res(); await h({ method: "GET", headers: { "x-api-key": "key" }, query: q }, r); return r; };
const link = async (action, userId) => { const r = res(); await v2r({ method: "POST", headers: { "x-api-key": "lkey" }, query: {}, body: { action, userId } }, r); return r; };
const tx = (id, name, amount, message = "") => ({ transaction_id: id, name, amount, message, mediaShareUrl: "", created_at: "" });
await raw(["FLUSHALL"]);
// production today = v1 data
await hook(v1w, tx("a1", "Lama", 10000, "v1"));
// deploy v2
const code = (await link("create", 4242)).body.code;
await hook(v2w, tx("b1", "POCAY", 20000, `x ${code}`));
await hook(v2w, tx("b2", "Budi", 5000));
// ROLLBACK to v1
let r = await hook(v1w, tx("b1", "POCAY", 20000, "retry after rollback"));
check("rollback: v1 sees transactions stored by v2 as duplicates (no double count)", r.body.duplicate === true);
r = await hook(v1w, tx("c1", "Setelah", 3000));
check("rollback: v1 webhook keeps storing new donations", r.body.accepted === true);
let g = await get(v1r, { since: "1" });
check("rollback: v1 feed reads v1 + v2 rows", g.code === 200 && ["a1", "b1", "b2", "c1"].every((id) => g.body.donations.some((d) => d.id === id)));
check("rollback: v1 leaderboard still lists every entry incl. the verified one", g.body.leaderboard.length === 4 && g.body.leaderboard.some((e) => e.name === "POCAY" && e.total === 20000));
check("rollback: no code in v1 output either", !JSON.stringify(g.body).includes(code));
// roll FORWARD to v2 again
r = await hook(v2w, tx("d1", "Maju", 1000));
g = await get(v2r, { since: "1" });
const ids = g.body.donations.map((d) => d.id);
check("roll-forward: v2 continues after v1 rows, nothing lost", r.body.accepted === true && ["a1", "b1", "b2", "c1", "d1"].every((id) => ids.includes(id)) && ids.indexOf("d1") > ids.indexOf("c1"));
check("roll-forward: verified avatar still there", g.body.leaderboard.some((e) => e.robloxUserId === 4242));
console.log(`\n${pass} passed, ${fail} failed`);
srv.kill(); process.exit(fail ? 1 : 0);
