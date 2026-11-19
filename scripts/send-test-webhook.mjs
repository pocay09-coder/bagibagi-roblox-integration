// AFTERBEAT BagiBagi backend v3.1 - send ONE signed TEST webhook to STAGING (Vercel Preview + separate Upstash).
// A test webhook plays the full donation alert in Roblox with a [TEST] label, but is NEVER counted:
// not in the ledger, Top 50 / Gold ranking, podium, history or donor totals (it lives 15 minutes in bb:testfeed).
// Same safety guards as the smoke test: refuses the production domain, env=production and any other database.
// Windows (PowerShell):
//   node --env-file=.env.staging.local scripts\send-test-webhook.mjs --amount 25000 --name "Tes Donatur" --message "halo"
// Prints no keys.
import { createHash, createHmac, randomUUID } from "node:crypto";

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf("--" + name); return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : def; };
const allowLocal = args.includes("--allow-local"); // local test run only
const BASE = String(process.env.STAGING_URL || "").replace(/\/+$/, "");
const TOKEN = process.env.STAGING_WEBHOOK_TOKEN;
const KEY = process.env.STAGING_API_KEY;
const BYPASS = process.env.VERCEL_PROTECTION_BYPASS || "";
const PRODUCTION_HOSTS = ["bagibagi-roblox-integration.vercel.app", ...String(process.env.PRODUCTION_HOST || "").split(",").filter(Boolean)];
const amount = Number(opt("amount", "10000"));
const name = String(opt("name", "Tes BagiBagi")).slice(0, 40);
const message = String(opt("message", "Tes donasi (tidak tercatat)")).slice(0, 180);
if (!BASE || !TOKEN || !KEY) { console.error("Set STAGING_URL, STAGING_WEBHOOK_TOKEN, STAGING_API_KEY"); process.exit(2); }
if (!Number.isSafeInteger(amount) || amount <= 0) { console.error("--amount must be a whole number above 0"); process.exit(2); }
let host = "";
try { host = new URL(BASE).hostname; } catch { console.error("STAGING_URL is not a URL"); process.exit(2); }
if (PRODUCTION_HOSTS.includes(host)) { console.error(`Refusing to run: ${host} is the PRODUCTION domain.`); process.exit(2); }

const common = BYPASS ? { "x-vercel-protection-bypass": BYPASS } : {};
async function feed() {
  const r = await fetch(`${BASE}/api/roblox?since=${Date.now() - 60000}`, { headers: { ...common, "x-api-key": KEY } });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}
let probe;
try { probe = await feed(); } catch (e) { console.error(`Refusing to run: cannot reach ${host} (${e.cause?.code || e.message}).`); process.exit(2); }
if (probe.status !== 200) { console.error(`Refusing to run: feed answered HTTP ${probe.status} (Deployment Protection? wrong key?)`); process.exit(2); }
if (probe.body.env === "production") { console.error("Refusing to run: backend reports env=production."); process.exit(2); }
if (probe.body.env !== "preview" && !(allowLocal && probe.body.env === "local")) { console.error(`Refusing to run: backend env is "${probe.body.env}", expected "preview".`); process.exit(2); }
if (probe.body.apiRevision !== "3.1") { console.error(`Refusing to run: backend is not v3.1 (apiRevision ${probe.body.apiRevision}). Deploy v3.1 to the Preview first.`); process.exit(2); }
let expected = "";
try { expected = createHash("sha256").update(new URL(String(process.env.UPSTASH_REDIS_REST_URL || "")).hostname).digest("hex").slice(0, 12); } catch {}
if (!expected || probe.body.dbFingerprint !== expected) { console.error("Refusing to run: set UPSTASH_REDIS_REST_URL to YOUR staging database (fingerprint check failed)."); process.exit(2); }

const before = probe.body;
const id = `test-${randomUUID()}`;
const body = { transaction_id: id, name, amount, message, test: true, created_at: new Date().toISOString() };
const sig = createHmac("sha256", TOKEN).update(JSON.stringify(body)).digest("hex");
const r = await fetch(`${BASE}/api/webhook`, { method: "POST", headers: { ...common, "content-type": "application/json", "x-bagibagi-signature": sig }, body: JSON.stringify(body) });
const res = await r.json().catch(() => ({}));
if (r.status !== 200 || !res.test || !res.accepted) { console.error(`FAIL webhook answered HTTP ${r.status}: ${JSON.stringify(res)}`); process.exit(1); }
const after = (await feed()).body;
const inTests = (after.tests || []).some((t) => t.id === id && t.test === true && t.amount === amount);
const leaked = JSON.stringify([after.donations, after.history, after.top50, after.leaderboard]).includes(id);
const sum = (b) => (b.top50 || []).reduce((s, e) => s + (Number(e.total) || 0), 0);
console.log(`${inTests ? "PASS" : "FAIL"} test webhook stored for the alert (Roblox shows it within ~10 s with [TEST])`);
console.log(`${!leaked ? "PASS" : "FAIL"} not in donations / history / Top 50 / leaderboard`);
console.log(`${sum(after) === sum(before) ? "PASS" : "FAIL"} Top 50 totals unchanged`);
process.exit(inTests && !leaked && sum(after) === sum(before) ? 0 : 1);
