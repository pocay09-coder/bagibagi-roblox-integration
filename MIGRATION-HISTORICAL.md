# Historical Gold migration (one time) and rollback

`scripts/migrate-historical-gold.mjs` moves the OLD leaderboard total (v1 / v2.1 `bb:donors`) of one legacy entry
into the v3 Gold ranking (`bb:rank`) of one approved Roblox account. It is a dry-run unless `--apply --confirm …` is
given, and it can add the amount only once.

## Approved values (production migration report, 19 Nov 2026)

| Field | Value |
|---|---|
| legacy key | `cG9jYXk4OA` (name "pocay88") |
| target | `u:8717004329` (pocay88 / POCAY), payer confirmed by the game owner |
| amount | 10000 (one source transaction `bagibagi-ae08fc59-05bc-4fa3-f358-08df447192e2`, 18 Nov 2026) |
| confirm string | `cG9jYXk4OA:u:8717004329:10000` |

## What the apply writes (one atomic Lua script)

1. For every source transaction (old donations of this name in `bb:history` that v3 never counted), a ledger row
   `bb:tx:<original transaction id>` with `status migrated`, `member u:<UserId>`, `legacy <key>`, `migration historical-v1`
   and the time of the old donation.
2. `ZINCRBY bb:rank <amount> u:<UserId>`.
3. `bb:rk:u:<UserId>`: only missing fields (`lastName`, `refreshedAt 0`), so the backend refreshes username /
   DisplayName from Roblox on the next GET. Existing metadata is never overwritten.
4. Record `bb:migration:hist:<key>` (state, amount, ids, Gold before / after, whether the Gold was added).

It never touches `bb:donors`, `bb:donor:*`, `bb:feed`, `bb:history` or `bb:processed:*`. No alert is replayed in
Roblox, and the old webhook markers stay as they are.

## Why the amount cannot be counted twice

* The script checks, inside the same atomic Lua script and before its first write, that the record and all ledger
  rows do not exist yet. A second run, or two runs at the same time, answers `ALREADY APPLIED`.
* The ledger row uses the ORIGINAL transaction id. The webhook treats an existing `bb:tx:<id>` as a duplicate and
  that row never expires. A BagiBagi resend of the old donation stays a duplicate even after its old
  `bb:processed` marker expires.
* After the apply the migration report shows `countedByV3 10000, historical 0` for this entry, so the
  same old total can never be proposed again.
* The apply is refused (`changed`) when the old total or the target's Gold changed after the numbers were read,
  for example by a new donation. Run the dry-run again.
* A lost answer (timeout after the write) is safe: a repeated `--apply` answers `ALREADY APPLIED`.

## Procedure (production, ONLY after explicit approval)

Windows PowerShell, in the repo folder. `<write env>` is an env file with a token that can WRITE to the production
database. `.env.production.readonly` can only be used for the read-only steps.

1. Backup right before: `node --env-file=.env.production.readonly scripts\export-backup.mjs backup-before-migration-<date>.json`
2. Fresh report: `node --env-file=.env.production.readonly scripts\migration-report.mjs migration-report`. It must
   still show historical 10000 for `cG9jYXk4OA`.
3. Dry-run: `node --env-file=.env.production.readonly scripts\migrate-historical-gold.mjs --legacy-key cG9jYXk4OA --target u:8717004329 --amount 10000`
   It must say `RESULT: READY`, every check OK, `historical amount 10,000`, `predicted total` = existing Gold + 10,000.
   Compare `database fingerprint` with `dbFingerprint` from `GET /api/roblox` of production.
4. Apply: `node --env-file=<write env> scripts\migrate-historical-gold.mjs --legacy-key cG9jYXk4OA --target u:8717004329 --amount 10000 --apply --confirm cG9jYXk4OA:u:8717004329:10000`
5. Verify: the same command with `--verify` instead of `--apply --confirm …` must print `RESULT: APPLIED and consistent`.
   Then run `scripts\check-consistency.mjs` (must print `RESULT: consistent`) and check that Top 50 shows pocay88 with +10,000.

## Rollback

The script's rollback is the supported way back. It is exact: on a database without later changes it restores
every key, value and TTL to the state before the apply (tested).

1. Plan (writes nothing): the dry-run command with `--rollback`.
   It shows the Gold now and after the rollback, and which keys will be deleted.
2. Roll back: `… --rollback --confirm cG9jYXk4OA:u:8717004329:10000`
3. Check: `--verify` must print `NOT APPLIED`, `check-consistency` must print `consistent`, and the migration report
   shows historical 10000 again.

What the rollback does, in one atomic Lua script:
* subtracts the amount from `bb:rank` (only if the record says it was added); the entry is removed when it reaches 0
* deletes the migration ledger rows and the record
* deletes `bb:rk:u:<UserId>` only if the migration created it and the account no longer has Gold
* keeps donations made after the migration (their Gold and metadata stay)
* never touches `bb:donors`, `bb:feed`, `bb:history` or `bb:processed:*`. While its marker exists, the old
  transaction is still refused as a duplicate.
* refuses when `--target` / `--amount` do not match the record

### If an apply stopped in the middle (`INCOMPLETE`)

This can only happen if Redis rejects a command inside the script. All key types and values are checked before the
first write. The amount is still never counted twice: a new `--apply` refuses with `INCOMPLETE`.

1. `--verify` tells where it stopped: before or after the Gold was added (`rankApplied`).
2. `--rollback --confirm …` undoes exactly what was written. It uses `rankApplied` to decide whether to subtract.
3. Run the dry-run and `--apply --confirm …` again.

### Other notes

* Rolling back the backend (Vercel Promote of an older deployment) does not undo data. Older backends ignore
  `bb:tx:*`, `bb:rank` and `bb:migration:*`.
* The backup JSON from step 1 is the record of the state before the migration. There is no automatic restore
  from it; use the script's rollback.

## Tests (local only)

`tests/migration-historical-test.mjs` runs in `bash tests/run-all.sh` (50 checks). It covers:
* the dry-run writing nothing, refusals, and success;
* duplicates: a second run and two runs at once;
* a webhook replay of the old transaction, including after its marker expired;
* a donation arriving between dry-run and apply;
* an unreachable database, a lost answer, wrong key types, and commands rejected in the middle (ZINCRBY / HSETNX);
* exact rollback, rollback after newer donations, and a refused rollback.
