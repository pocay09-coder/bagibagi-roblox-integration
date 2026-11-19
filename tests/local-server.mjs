// local HTTP wrapper around the two handlers (like Vercel), backed by the local test redis (port 6391)
// and a local FAKE Roblox Users API (port 8898) - nothing leaves this machine.
import http from "node:http";
process.env.BB_TEST_REDIS_PORT = "6391";
process.env.BAGIBAGI_WEBHOOK_TOKEN = "local-staging-token";
process.env.ROBLOX_API_KEY = "local-staging-key";
process.env.LINK_CODE_SECRET = "local-link-secret";
process.env.ROBLOX_LINK_API_KEY = "local-staging-link-key";
process.env.USERNAME_MATCH = "1";
const FAKE_API_PORT = Number(process.env.LOCAL_FAKE_API_PORT || 8898);
process.env.ROBLOX_USERS_API = `http://127.0.0.1:${FAKE_API_PORT}`;
process.env.UPSTASH_REDIS_REST_URL = process.env.LOCAL_FAKE_DB_URL || "https://local-staging-db.upstash.io";
if (process.env.LOCAL_PRETEND_ENV) process.env.VERCEL_ENV = process.env.LOCAL_PRETEND_ENV;
const users = { pocay88: { id: 8717004329, name: "pocay88", displayName: "POCAY" } };
http.createServer((req, res) => {
  let b = "";
  req.on("data", (c) => (b += c));
  req.on("end", () => {
    const j = JSON.parse(b || "{}");
    const data = req.url === "/v1/usernames/users"
      ? (j.usernames || []).map((n) => users[String(n).toLowerCase()] && { requestedUsername: n, ...users[String(n).toLowerCase()] }).filter(Boolean)
      : (j.userIds || []).map((id) => Object.values(users).find((u) => u.id === Number(id))).filter(Boolean);
    res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ data }));
  });
}).listen(FAKE_API_PORT);
const webhook = (await import("./api/webhook.js")).default;
const roblox = (await import("./api/roblox.js")).default;
http.createServer((req, res) => {
  let data = "";
  req.on("data", (c) => (data += c));
  req.on("end", async () => {
    const u = new URL(req.url, "http://x");
    const vreq = { method: req.method, headers: req.headers, query: Object.fromEntries(u.searchParams), body: data ? JSON.parse(data) : undefined };
    const vres = { statusCode: 200, status(c) { this.statusCode = c; return this; }, setHeader(k, v) { res.setHeader(k, v); },
      json(b) { res.statusCode = this.statusCode; res.setHeader("content-type", "application/json"); res.end(JSON.stringify(b)); return this; } };
    const h = u.pathname === "/api/webhook" ? webhook : u.pathname === "/api/roblox" ? roblox : null;
    if (!h) { res.statusCode = 404; return res.end("{}"); }
    await h(vreq, vres);
  });
}).listen(Number(process.env.LOCAL_PORT || 8787), () => console.log("local staging on " + (process.env.LOCAL_PORT || 8787)));
