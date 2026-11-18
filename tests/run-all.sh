#!/usr/bin/env bash
# Runs EVERY local test straight from this package, in a temporary folder.
# Needs: node >= 20 and redis-server. Local redis on ports 6390-6395, local HTTP on 8787/8788, fake Roblox Users
# API on 8896-8899. Never touches Upstash, Vercel or roblox.com.
#   bash tests/run-all.sh
set -uo pipefail
PKG="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d)"
SRV=""; SRV2=""
cleanup() { [ -n "$SRV" ] && kill "$SRV" 2>/dev/null; [ -n "$SRV2" ] && kill "$SRV2" 2>/dev/null; redis-cli -p 6391 shutdown nosave >/dev/null 2>&1; rm -rf "$WORK"; }
trap cleanup EXIT
cp -r "$PKG/api" "$PKG/lib" "$PKG/scripts" "$PKG/package.json" "$WORK/"
cp "$PKG/tests/"*.mjs "$WORK/"
mkdir -p "$WORK/node_modules/@upstash/redis" "$WORK/v1/api"
cp "$PKG/tests/stub/@upstash/redis/"* "$WORK/node_modules/@upstash/redis/"   # TEST ONLY stub -> local redis
cp "$PKG/tests/v1-original/api/"*.js "$WORK/v1/api/"
cp "$PKG/package.json" "$WORK/v1/"
ln -s "$WORK/node_modules" "$WORK/v1/node_modules"
cd "$WORK"
unset VERCEL_ENV UPSTASH_REDIS_REST_URL UPSTASH_REDIS_REST_TOKEN
export BB_STRICT_KEYS=1   # a Lua script touching a key outside KEYS fails (Upstash REST rule)
FAILED=0
run() { local name="$1"; shift; echo "== $name"; "$@" > out.log 2>&1; local rc=$?; grep -E "FAIL|passed|RESULT|exported" out.log; [ $rc -ne 0 ] && FAILED=1; return 0; }
run "1/7 main suite v2.1 behaviour on v3 code (expected 84 passed, 0 failed)" node run-tests.mjs
run "2/7 v3 Gold Donation: username, Top 50, ROYAL, PENDING (expected 47 passed, 0 failed)" node run-tests-v3.mjs
run "3/7 rollback v1 <-> v3 (expected 7 passed, 0 failed)" node rollback-test.mjs
run "4/7 migration report is read-only (expected 10 passed, 0 failed)" node migration-test.mjs
redis-server --port 6391 --save "" --appendonly no --daemonize yes >/dev/null; sleep 0.5
node local-server.mjs > server.log 2>&1 & SRV=$!
LOCAL_PORT=8788 LOCAL_FAKE_API_PORT=8897 LOCAL_PRETEND_ENV=production node local-server.mjs > server2.log 2>&1 & SRV2=$!
sleep 1.5
export STAGING_WEBHOOK_TOKEN=local-staging-token STAGING_API_KEY=local-staging-key STAGING_LINK_API_KEY=local-staging-link-key
DB=https://local-staging-db.upstash.io; S=scripts/staging-smoke-test.mjs; F=--i-am-using-a-staging-database
echo "== 5/7 smoke test refuses unsafe targets and writes nothing (expected 8 passed, 0 failed)"
G=0; GF=0
guard() { local name="$1"; shift; env "$@" > g.log 2>&1; local rc=$?; if [ $rc -eq 2 ] && grep -q "Refusing" g.log; then G=$((G+1)); else echo "FAIL $name (exit $rc)"; GF=$((GF+1)); fi; }
guard "no flag"                 STAGING_URL=http://127.0.0.1:8787 UPSTASH_REDIS_REST_URL=$DB node $S
guard "production domain"       STAGING_URL=https://bagibagi-roblox-integration.vercel.app UPSTASH_REDIS_REST_URL=$DB node $S $F
guard "env is not preview"      STAGING_URL=http://127.0.0.1:8787 UPSTASH_REDIS_REST_URL=$DB node $S $F
guard "backend says production" STAGING_URL=http://127.0.0.1:8788 UPSTASH_REDIS_REST_URL=$DB node $S $F --allow-local
guard "other database"          STAGING_URL=http://127.0.0.1:8787 UPSTASH_REDIS_REST_URL=https://another-db.upstash.io node $S $F --allow-local
guard "database not given"      STAGING_URL=http://127.0.0.1:8787 node $S $F --allow-local
guard "wrong key"               STAGING_URL=http://127.0.0.1:8787 STAGING_API_KEY=wrong UPSTASH_REDIS_REST_URL=$DB node $S $F --allow-local
[ "$(redis-cli -p 6391 DBSIZE)" = "0" ] && G=$((G+1)) || { echo "FAIL refused runs wrote data"; GF=$((GF+1)); }
echo "$G passed, $GF failed"; [ $GF -ne 0 ] && FAILED=1
run "6/7 staging smoke test against a local HTTP server (expected 19 passed, 0 failed)" \
  env STAGING_URL=http://127.0.0.1:8787 UPSTASH_REDIS_REST_URL=$DB node $S $F --allow-local
run "7/7 read-only tools (expected RESULT: consistent + export)" sh -c \
  "BB_TEST_REDIS_PORT=6391 node scripts/check-consistency.mjs && BB_TEST_REDIS_PORT=6391 node scripts/export-backup.mjs backup-test.json"
[ $FAILED -eq 0 ] && echo "ALL TESTS PASSED" || echo "SOME TESTS FAILED"
exit $FAILED
