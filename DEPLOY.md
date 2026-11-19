# BagiBagi → AFTERBEAT backend v3 — Gold Donation (username → Roblox account, Top 50, ROYAL data)

**Status: tested locally only (local Redis 7.0 test database, strict "all keys in KEYS" mode, fake Roblox Users API).
NOT production-ready. Production only after `scripts/staging-smoke-test.mjs` passes against a Vercel Preview that
uses a SEPARATE Upstash staging database, and only with the owner's approval. Roblox Studio is not changed by this
package.**

## What v3 does

| Area | Behaviour |
|---|---|
| Identity | The BagiBagi `name` is read as a Roblox **Username** and looked up with the official Roblox Users API (`POST users.roblox.com/v1/usernames/users`). Only an exact match with the CURRENT username counts (case and a leading `@` are ignored). DisplayName is never searched, old usernames are not accepted. No code, no owner approval, no manual linking. |
| Found (USERNAME_MATCHED) | stored under the UserId: Username, DisplayName, avatar via UserId. Donations are added up per UserId. |
| Not found (UNMATCHED) | still counted, shown with the BagiBagi name, no avatar, no role. A Roblox account created later does NOT take over old donations. |
| Roblox API problem (PENDING) | 429 / timeout / 5xx / budget used up: the donation is stored and counted at once under the name and marked PENDING. The feed request (GET) retries in small batches with a lock and moves it to the account exactly once, or marks it UNMATCHED for good. Only PENDING donations are ever moved. |
| Top 50 Gold Donation | new sorted set `bb:rank`, updated in the same Lua script as the transaction (one write per donation, no scanning), ledger `bb:tx:<id>` per transaction = permanent duplicate protection + proof for every total. |
| ROYAL data | `top50[i].royal = true` and `royalTag = "#N ROYAL"` only for ranks 1–30 that belong to a FOUND, existing account. A rank held by an UNMATCHED / PENDING name gives no role and is not handed to rank 31. Banned / deleted accounts (24 h refresh) keep their total, lose avatar and role. |
| Security | A matching username is NOT proof of who paid (anyone can type it; treated as a gift). No admin rights come from it. The backend never takes a UserId from a Roblox client; ROYAL is decided from backend data only. Webhook HMAC, deduplication, separate GET/POST keys, global POST limit, `SET NX` for codes stay. |
| Old one-time codes | still work for compatibility (a code in the message wins over the name), but are not required anymore. |
| Robux systems | not touched. BagiBagi Gold Donation is a separate list (`top50`); the old `leaderboard` field is unchanged. |

## Feed answer (`GET /api/roblox`) — new fields, old fields unchanged

```
apiVersion: 3, env: "preview" | "production" | "local", dbFingerprint: "<12 hex chars>",
top50: [ { rank, identity: "USERNAME_MATCHED" | "PENDING" | "UNMATCHED", userId, available,
           username, displayName, name, total, royal, royalTag } ]   // highest first, max 50
```
`dbFingerprint` = first 12 hex chars of SHA-256 of the Upstash host name (no secret). The smoke test compares it with
your staging database so it can never write test data into another database.

## Package / verification

* Version: `VERSION`. Every file + SHA-256 in `MANIFEST.sha256` (Windows: `Get-FileHash <file> -Algorithm SHA256`).
* Local tests: `bash tests/run-all.sh` (Linux / WSL, needs `redis-server`) →
  1 main suite **84 passed** · 2 v3 suite **47 passed** · 3 rollback v1↔v3 **7 passed** · 4 migration report
  read-only **10 passed** · 5 smoke-test guards **8 passed** · 6 smoke test over local HTTP **19 passed** ·
  7 `RESULT: consistent` → `ALL TESTS PASSED`. Local results do not replace the staging run.

## Files

* `api/webhook.js`, `api/roblox.js`, `lib/roblox-users.js` — the backend (deploy these three + `package.json`).
* `scripts/staging-smoke-test.mjs` — writes FAKE donations (`smoke-…`), staging only, many refusal guards.
* `scripts/check-consistency.mjs` — read-only: ranking = ledger, PENDING bookkeeping, markers, link index.
* `scripts/migration-report.mjs` — read-only report: old totals → proposed v3 entries (writes nothing to the database).
* `scripts/export-backup.mjs` — read-only JSON backup of all `bb:*` keys.
* `.env.preview.example` — variable names for the Preview environment (no values).
* `tests/` — local tests (TEST ONLY, never deploy `tests/stub`).

## Environment variables (Vercel → Settings → Environment Variables)

| Name | Preview (staging) | Notes |
|---|---|---|
| `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` | staging database | never the production database |
| `BAGIBAGI_WEBHOOK_TOKEN` | new staging value | signs webhooks |
| `ROBLOX_API_KEY` | new staging value | **GET** feed (Roblox game) |
| `ROBLOX_LINK_API_KEY` | new staging value, **different** from `ROBLOX_API_KEY` | **POST** (old code menu). Without it POST answers 503 |
| `LINK_CODE_SECRET` | new staging value | old one-time codes |
| `USERNAME_MATCH` | `1` | off = every donation stays under its name (no Roblox lookups) |
| `ROBLOX_LOOKUPS_PER_MINUTE` | optional, default 60 | Roblox API budget; above it donations become PENDING |
| `LINK_GLOBAL_PER_MINUTE` | optional, default 120 | global POST limit |

`ROBLOX_USERS_API` is a local-test switch and is ignored on Vercel. Never set production values in Preview.

## 1. Staging smoke test from Windows (PowerShell)

1. **Node.js**: `winget install OpenJS.NodeJS.LTS`, open a NEW PowerShell, `node -v` must show v20.6 or newer.
2. Extract the zip, then `cd <folder>` and `npm install` (installs `@upstash/redis` for the read-only scripts).
3. **Upstash**: create a NEW database `bagibagi-staging` (never reuse production).
4. **Vercel**: add the variables above with scope **Preview only**. Push the v3 files to branch
   `bagibagi-v2-staging` (not `main`). Wait for the Preview URL. Check under Deployment → Environment that it is a
   Preview deployment.
5. **Deployment Protection** (if on): Settings → Deployment Protection → *Protection Bypass for Automation* →
   create a secret. It goes into `VERCEL_PROTECTION_BYPASS` (only in your local file).
6. Create `.env.staging.local` in the folder with Notepad (*Save as type: All files*, so it does not end in `.txt`).
   Fill in YOUR staging values yourself — never paste them into a chat, never commit the file:
   ```
   STAGING_URL=https://<preview-url>.vercel.app
   STAGING_WEBHOOK_TOKEN=
   STAGING_API_KEY=
   STAGING_LINK_API_KEY=
   VERCEL_PROTECTION_BYPASS=
   UPSTASH_REDIS_REST_URL=
   UPSTASH_REDIS_REST_TOKEN=
   SMOKE_MATCH_USERNAME=pocay88
   ```
7. Run:
   ```powershell
   node --env-file=.env.staging.local scripts\staging-smoke-test.mjs --i-am-using-a-staging-database
   node --env-file=.env.staging.local scripts\check-consistency.mjs
   ```
   Required: `guards ok: env=preview, database fingerprint … = staging`, `19 passed, 0 failed` and
   `RESULT: consistent`. A line starting with `Refusing to run:` means nothing was written — fix what it says.
8. Optional, read-only: `node --env-file=.env.staging.local scripts\migration-report.mjs staging-migration`
   → `staging-migration.csv` (open in Excel).
9. Send back only the PASS/FAIL/RESULT/Refusing lines. They contain no keys.

## 2. Production (NOT now — only after staging passed and the owner approved)

1. Read-only backup with a separate local file `.env.production.readonly` (production URL + a **read-only** token
   from Upstash → Database → REST API → Read-Only Token):
   `node --env-file=.env.production.readonly scripts\export-backup.mjs backup-before-v3.json` (keep private).
2. Add `ROBLOX_LINK_API_KEY` and `USERNAME_MATCH=1` for Production. Note the current production deployment =
   rollback target.
3. **Before merging**: the Roblox game must send `ROBLOX_LINK_API_KEY` for POST (Studio phase), or the old code menu
   must stay hidden — otherwise that menu answers 401. Alerts, feed and podium keep working (GET key unchanged).
4. Merge to `main`, watch Vercel logs, run `check-consistency.mjs` (read-only) → `RESULT: consistent`.
5. `top50` starts EMPTY: it only contains donations received by v3. Old totals are added only through the migration
   below, after the owner approved the report.

## Rollback (tested: v1 ↔ v3 in both directions)

1. Vercel → Deployments → previous production deployment → **Promote to Production**. No data restore needed:
   older versions treat v3 transactions as duplicates and ignore the extra v3 keys.
2. Donations received WHILE rolled back are not in `bb:rank`. After rolling forward, `migration-report.mjs` lists them
   as "historical" (old total minus what v3 already counted), so nothing is lost or counted twice.

## Old totals → v3 (report only, needs approval)

`scripts/migration-report.mjs` reads `bb:donors` and proposes for every old entry: `u:<UserId>` (exact current
username found, flagged *not proof of payer*), `u:<UserId>` for old code links, or a name entry. It subtracts what v3
already counted (`bb:tx:*` field `legacy`). It writes nothing to the database. Applying it is a separate step that is
not included and will only be built after the owner approved the report. Nothing is merged by DisplayName.

## Roblox side (Studio phase — waits for approval)

* The game server reads `top50` with `ROBLOX_API_KEY`, finds online players by `player.UserId` (server side only) and
  sets the ROYAL rank attribute; clients never send a UserId or a rank.
* NameTags: ROYAL `#N ROYAL` (emerald `#50C878`, light glow) shown next to the Robux tag, neither replaces the other.
  LEAD DANCE colour purple `#A855F7` (colour only). Chat tag via `TextChatService.OnIncomingMessage`.
* The code GUI can be hidden; POST calls (if kept) use `ROBLOX_LINK_API_KEY`.
