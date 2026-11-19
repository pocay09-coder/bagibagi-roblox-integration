// AFTERBEAT BagiBagi backend v3.1 - smoke test for STAGING (Vercel Preview + SEPARATE Upstash database).
// Sends signed FAKE webhooks (transaction ids "smoke-...") and writes test data, so it refuses to run unless:
//   * the flag --i-am-using-a-staging-database is given
//   * the URL is not the known production domain
//   * the backend reports env "preview" (Vercel) and the SAME database fingerprint as your staging
//     UPSTASH_REDIS_REST_URL (computed locally; the token is never sent anywhere)
// Windows (PowerShell):
//   node --env-file=.env.staging.local scripts\staging-smoke-test.mjs --i-am-using-a-staging-database
// Prints only PASS/FAIL lines (no keys, no codes).
import { createHash, createHmac, randomUUID } from "node:crypto";

const args = process.argv.slice(2);
if (!args.includes("--i-am-using-a-staging-database")) {
  console.error("Refusing to run: add --i-am-using-a-staging-database (this writes fake donations).");
  process.exit(2);
}
const allowLocal = args.includes("--allow-local"); // only for the local test run (tests/run-all.sh)
const BASE = String(process.env.STAGING_URL || "").replace(/\/+$/, "");
const TOKEN = process.env.STAGING_WEBHOOK_TOKEN;
const KEY = process.env.STAGING_API_KEY;
const LINK_KEY = process.env.STAGING_LINK_API_KEY;
const BYPASS = process.env.VERCEL_PROTECTION_BYPASS || "";
const MATCH_USER = process.env.SMOKE_MATCH_USERNAME || "pocay88";
const PRODUCTION_HOSTS = ["bagibagi-roblox-integration.vercel.app", ...String(process.env.PRODUCTION_HOST || "").split(",").filter(Boolean)];
if (!BASE || !TOKEN || !KEY || !LINK_KEY) { console.error("Set STAGING_URL, STAGING_WEBHOOK_TOKEN, STAGING_API_KEY, STAGING_LINK_API_KEY"); process.exit(2); }
let host = "";
try { host = new URL(BASE).hostname; } catch { console.error("STAGING_URL is not a URL"); process.exit(2); }
if (PRODUCTION_HOSTS.includes(host)) { console.error(`Refusing to run: ${host} is the PRODUCTION domain.`); process.exit(2); }

const common = BYPASS ? { "x-vercel-protection-bypass": BYPASS } : {};
async function feed(q, key = KEY) {
  const r = await fetch(`${BASE}/api/roblox?${new URLSearchParams(q)}`, { headers: { ...common, "x-api-key": key } });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

// ---- guards BEFORE any write ----
let probe;
try { probe = await feed({ since: String(Date.now()) }); } catch (e) { console.error(`Refusing to run: cannot reach ${host} (${e.cause?.code || e.message}).`); process.exit(2); }
if (probe.status !== 200) { console.error(`Refusing to run: feed answered HTTP ${probe.status} (Deployment Protection? set VERCEL_PROTECTION_BYPASS; wrong key?)`); process.exit(2); }
if (probe.body.apiVersion !== 3) { console.error(`Refusing to run: backend is not v3 (apiVersion ${probe.body.apiVersion}).`); process.exit(2); }
if (probe.body.env === "production") { console.error("Refusing to run: backend reports env=production."); process.exit(2); }
if (probe.body.env !== "preview" && !(allowLocal && probe.body.env === "local")) { console.error(`Refusing to run: backend env is "${probe.body.env}", expected "preview".`); process.exit(2); }
let expected = "";
try { const h = new URL(String(process.env.UPSTASH_REDIS_REST_URL || "")).hostname; expected = createHash("sha256").update(h).digest("hex").slice(0, 12); } catch {}
if (!expected) { console.error("Refusing to run: set UPSTASH_REDIS_REST_URL (your STAGING database) so the database can be checked."); process.exit(2); }
if (probe.body.dbFingerprint !== expected) { console.error(`Refusing to run: the Preview uses ANOTHER database (fingerprint ${probe.body.dbFingerprint}, staging ${expected}). Check the Preview environment variables.`); process.exit(2); }
console.log(`guards ok: env=${probe.body.env}, database fingerprint ${expected} = staging`);

let pass = 0, fail = 0;
const check = (n, c) => { c ? pass++ : fail++; console.log(`${c ? "PASS" : "FAIL"} ${n}`); };
const run = randomUUID().slice(0, 8);
async function hook(body) {
  const raw = JSON.stringify(body);
  const sig = createHmac("sha256", TOKEN).update(JSON.stringify(JSON.parse(raw))).digest("hex");
  const r = await fetch(`${BASE}/api/webhook`, { method: "POST", headers: { ...common, "content-type": "application/json", "x-bagibagi-signature": sig }, body: raw });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}
async function link(action, userId, key = LINK_KEY) {
  const r = await fetch(`${BASE}/api/roblox`, { method: "POST", headers: { ...common, "x-api-key": key, "content-type": "application/json" }, body: JSON.stringify({ action, userId }) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}
const tx = (id, name, amount, message = "") => ({ transaction_id: `smoke-${run}-${id}`, name, amount, message, mediaShareUrl: "", created_at: new Date().toISOString() });
const since = String(Date.now() - 60000);

// ---- v2.1 behaviour (14) ----
let r = await hook(tx("a", `Smoke ${run}`, 1000, "halo"));
check("first transaction accepted", r.status === 200 && r.body.accepted === true);
r = await hook(tx("a", `Smoke ${run}`, 1000, "halo"));
check("retry of the same transaction = duplicate", r.status === 200 && r.body.duplicate === true);
const par = await Promise.all(Array.from({ length: 8 }, () => hook(tx("b", `Smoke ${run}`, 500))));
check("8 parallel deliveries -> exactly 1 accepted", par.filter((x) => x.body.accepted).length === 1 && par.every((x) => x.status === 200));
let g = await feed({ since });
check("feed v3 answers (apiVersion 3, serverTime, cursor, top50)", g.status === 200 && g.body.apiVersion === 3 && typeof g.body.serverTime === "number" && "nextCursor" in g.body && Array.isArray(g.body.top50));
const mine = (g.body.donations || []).filter((d) => String(d.id).startsWith(`smoke-${run}-`));
check("both test transactions in the feed exactly once", mine.length === 2);
const uid = 1000000000 + Math.floor(Math.random() * 1000000);
const c = await link("create", uid);
check("old one-time code still created (compatibility)", c.status === 200 && /^AFB-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/.test(c.body.code || ""));
r = await hook(tx("c", `Smoke ${run}`, 2000, `tes ${c.body.code} ok`));
g = await feed({ since });
const dc = (g.body.donations || []).find((d) => d.id === `smoke-${run}-c`);
check("donation with the code -> robloxUserId, code removed from message", dc && dc.robloxUserId === uid && !String(dc.message).toUpperCase().includes("AFB"));
r = await hook(tx("d", `Smoke ${run}`, 2000, `lagi ${c.body.code}`));
g = await feed({ since });
const dd = (g.body.donations || []).find((d) => d.id === `smoke-${run}-d`);
check("used code cannot be reused", dd && dd.robloxUserId === null);
check("no code anywhere in the feed answer", !JSON.stringify(g.body).toUpperCase().includes(String(c.body.code)));
const st = await link("status", uid);
check("status: linked + shows the donation that used the code", st.status === 200 && st.body.linked === true && st.body.lastLinkedDonation && st.body.lastLinkedDonation.amount === 2000);
const other = uid + 1;
const c2 = await link("create", other);
r = await hook(tx("e", `Smoke ${run}`, 1500, `pakai kode akun lain ${c2.body.code}`));
g = await feed({ since });
const de = (g.body.donations || []).find((d) => d.id === `smoke-${run}-e`);
check("a code links only the account that created it", de && de.robloxUserId === other && (await link("status", uid)).body.identities === 1);
check("feed answer has the retention flag", typeof g.body.truncated === "boolean");
await link("unlink", other);
const ul = await link("unlink", uid);
check("unlink works", ul.status === 200 && ul.body.removed >= 1 && (await link("status", uid)).body.linked === false);
check("feed without key -> 401", (await fetch(`${BASE}/api/roblox?since=1`, { headers: common })).status === 401);

// ---- v3 Gold Donation (5) ----
check("the feed (GET) key is NOT accepted for POST", (await link("status", uid, KEY)).status === 401);
await hook(tx("m1", MATCH_USER, 1100));
await hook(tx("m2", MATCH_USER.toUpperCase(), 900));
const unknown = `zq${run}${Math.floor(Math.random() * 1e6)}`.slice(0, 20);
await hook(tx("u1", unknown, 700));
let acct, un;
for (let i = 0; i < 6; i++) { // a PENDING lookup is retried by the feed; give Roblox a few seconds
  g = await feed({ since: String(Date.now()) });
  acct = (g.body.top50 || []).find((e) => e.identity === "USERNAME_MATCHED" && String(e.username || "").toLowerCase() === MATCH_USER.toLowerCase());
  un = (g.body.top50 || []).find((e) => e.name === unknown);
  if (acct && un) break;
  await new Promise((res) => setTimeout(res, 3000));
}
check(`username "${MATCH_USER}" found on Roblox -> USERNAME_MATCHED with UserId + DisplayName`, acct && acct.userId > 0 && typeof acct.displayName === "string" && acct.displayName.length > 0);
check("two donations for the same username are added up under one UserId", acct && acct.total >= 2000 && (g.body.top50 || []).filter((e) => e.userId === acct.userId).length === 1);
check("unknown name -> still counted in Top 50 as UNMATCHED, no UserId", un && (un.identity === "UNMATCHED" || un.identity === "PENDING") && un.userId === null && un.total === 700);
check("ROYAL data: only found accounts in ranks 1-30, tag '#N ROYAL'", (g.body.top50 || []).every((e) => e.royal ? (e.userId > 0 && e.rank <= 30 && e.royalTag === `#${e.rank} ROYAL`) : e.royalTag === null));

// ---- v3.1 test webhook (2): alert only, never counted ----
if (probe.body.apiRevision === "3.1") {
  const tid = `test-${run}`;
  const tbody = { transaction_id: tid, name: `Smoke ${run}`, amount: 1234, message: "tes", test: true, created_at: new Date().toISOString() };
  r = await hook(tbody);
  g = await feed({ since: String(Date.now() - 60000) });
  check("test webhook -> only in tests[] (for the [TEST] alert), not in donations / history / Top 50",
    r.status === 200 && r.body.test === true && (g.body.tests || []).some((t) => t.id === tid) && !JSON.stringify([g.body.donations, g.body.history, g.body.top50]).includes(tid));
  r = await hook(tbody);
  check("the same test webhook again = duplicate (one alert)", r.status === 200 && r.body.duplicate === true);
} else {
  console.log(`SKIP test-webhook checks: backend is v${probe.body.apiRevision || "3.0"} (deploy v3.1 for test webhooks)`);
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
