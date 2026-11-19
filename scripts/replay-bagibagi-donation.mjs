// Re-sends ONE real BagiBagi donation that never reached the backend (for example because the webhook URL pointed
// somewhere else at the time), exactly as BagiBagi sends it: the same JSON fields, signed with the webhook token, with
// transaction_id = "bagibagi-" + the Referensi from the BagiBagi receipt. The normal webhook code then processes it once:
// Gold ranking, history, alert in the game, username match. Sending it again only answers "duplicate" (never counted twice).
// DRY-RUN by default: prints what would be sent and sends nothing.
// Env (a local file that is never committed, e.g. .env.production.webhook):
//   BAGIBAGI_WEBHOOK_TOKEN = the webhook token from the BagiBagi dashboard (the same one the backend uses)
//   WEBHOOK_URL            = https://<backend domain>/api/webhook
// Windows (PowerShell), from the repo folder:
//   node --env-file=.env.production.webhook scripts\replay-bagibagi-donation.mjs --ref <Referensi> --name <Pengirim> --amount <n> --message "<pesan>" --created "11/20/2026 1:32:00 AM"
//   (same) --send --confirm <Referensi>
// Prints no token.
import { createHmac } from "node:crypto";
import { pathToFileURL } from "node:url";

const REF = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseArgs(argv) {
  const a = { send: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === "--send") a.send = true;
    else if (["--ref", "--name", "--amount", "--message", "--created", "--confirm"].includes(k)) a[k.slice(2)] = String(argv[++i] ?? "");
    else return { error: `unknown argument ${k}` };
  }
  if (!REF.test(a.ref || "")) return { error: "--ref must be the Referensi from the BagiBagi receipt (xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx)" };
  if (!a.name || a.name.length > 60) return { error: "--name must be the Pengirim exactly as on the receipt (max 60 characters)" };
  if (!/^[1-9]\d{0,11}$/.test(a.amount || "")) return { error: "--amount must be a positive whole number (Total Transaksi)" };
  if (a.message === undefined) a.message = "";
  if (a.message.length > 500) return { error: "--message is too long (max 500)" };
  if (!a.created || a.created.length > 60) return { error: '--created must be the receipt time, e.g. "11/20/2026 1:32:00 AM"' };
  a.ref = a.ref.toLowerCase();
  return a;
}

export async function main(argv, log = console.log, fetchImpl = fetch) {
  const a = parseArgs(argv);
  if (a.error) { log(`usage error: ${a.error}`); return 2; }
  const token = process.env.BAGIBAGI_WEBHOOK_TOKEN || "";
  const rawUrl = process.env.WEBHOOK_URL || "";
  let url;
  try { url = new URL(rawUrl); } catch { log("Set WEBHOOK_URL (https://<backend domain>/api/webhook) in the env file."); return 2; }
  const local = url.hostname === "127.0.0.1" || url.hostname === "localhost";
  if (url.protocol !== "https:" && !local) { log("Refusing: WEBHOOK_URL must use https."); return 2; }
  if (url.pathname !== "/api/webhook") { log("Refusing: WEBHOOK_URL must end with /api/webhook."); return 2; }
  if (!token) { log("Set BAGIBAGI_WEBHOOK_TOKEN in the env file."); return 2; }

  // the same fields (and order) as a real BagiBagi donation webhook
  const body = {
    transaction_id: `bagibagi-${a.ref}`,
    name: a.name,
    amount: Number(a.amount),
    message: a.message,
    mediaShareUrl: "",
    created_at: a.created,
  };
  const raw = JSON.stringify(body);
  const signature = createHmac("sha256", token).update(raw).digest("hex");
  log(`AFTERBEAT replay of one BagiBagi donation - ${a.send ? "SEND" : "DRY-RUN (nothing is sent)"}`);
  log(`target               : ${url.host}${url.pathname}`);
  log(`transaction_id       : ${body.transaction_id}`);
  log(`name / amount        : ${body.name} / ${body.amount.toLocaleString("en-US")}`);
  log(`message              : ${body.message ? JSON.stringify(body.message) : "(none)"}`);
  log(`created_at           : ${body.created_at}`);
  log(`signed               : yes (HMAC-SHA256 with the webhook token, value not shown)`);
  if (!a.send) {
    log("RESULT: DRY-RUN. To send it once:");
    log(`  node --env-file=<env file> scripts\\replay-bagibagi-donation.mjs --ref ${a.ref} --name "${a.name}" --amount ${a.amount} --message "${a.message}" --created "${a.created}" --send --confirm ${a.ref}`);
    return 0;
  }
  if ((a.confirm || "").toLowerCase() !== a.ref) { log(`Refusing to send: add --confirm ${a.ref} (exactly).`); return 2; }
  let r;
  try {
    r = await fetchImpl(url.href, { method: "POST", headers: { "content-type": "application/json", "x-bagibagi-signature": signature }, body: raw });
  } catch (e) {
    log(`ERROR: ${String(e?.cause?.code || e?.message || e).slice(0, 100)} - nothing known about the result; sending again is safe (duplicate).`);
    return 1;
  }
  const text = await r.text().catch(() => "");
  let j = {};
  try { j = JSON.parse(text); } catch {}
  if (r.status === 200 && j.accepted) { log("RESULT: ACCEPTED - counted once by the backend (Gold, history and the in-game alert)."); return 0; }
  if (r.status === 200 && j.duplicate) { log("RESULT: DUPLICATE - this transaction was already processed before. Nothing changed."); return 0; }
  log(`RESULT: NOT ACCEPTED - HTTP ${r.status} ${String(j.error || text).slice(0, 120)}`);
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(await main(process.argv.slice(2)));
