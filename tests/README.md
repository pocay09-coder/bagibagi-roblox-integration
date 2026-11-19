# Local tests (TEST ONLY - never deploy anything from this folder)

Run everything from the package (Linux / WSL, needs node >= 20 and redis-server):

    bash tests/run-all.sh

It copies api/, lib/ and scripts/ into a temporary folder, installs the test stub (tests/stub/@upstash/redis, which
talks to a LOCAL redis-server instead of Upstash) and runs with strict keys (a Lua script touching a key outside
KEYS fails). A local FAKE Roblox Users API is used; nothing goes to Upstash, Vercel or roblox.com.

1. run-tests.mjs       84 checks: transactions, retry, timeout, crash, parallel, duplicates, wrong key types,
                       commands rejected mid-script (ACL), one-time codes, pagination, retention, auth, GET/POST keys
2. run-tests-v3.mjs    47 checks: username match (case, @, DisplayName, old username, invalid names, cache),
                       PENDING on 429 / timeout / 5xx / budget + safe retry with 3 parallel servers, Top 50,
                       ROYAL #1-30 (UNMATCHED slot not handed on, tag follows rank), banned / renamed accounts,
                       production guard for smoke-* ids, permanent ledger dedupe, consistency check, NX, POST limit
3. rollback-test.mjs    7 checks: v1 (tests/v1-original) <-> v3 on the same data, both directions
4. migration-test.mjs  10 checks: migration report proposals + the database stays identical (read-only)
5. smoke-test guards    8 checks: refuses no flag, production domain, env not preview, env production, other
                       database, database not given, wrong key; refused runs write nothing
6. staging-smoke-test  19 checks over HTTP (local-server.mjs wraps the handlers like Vercel)
7. check-consistency + export-backup (read-only tools)

Expected last line: ALL TESTS PASSED
