#!/usr/bin/env bash
# Restore drill for the cloud (BUILD-PLAN M10): restore every database from the Litestream replica
# into a scratch folder, check each one is intact, and compare row counts with the live data.
# Nothing live is touched. Run monthly, and after any change to backups, on the cloud host
# (needs the litestream 0.5.8+ binary and sqlite3, and the same LITESTREAM_* settings as .env):
#
#   set -a; . ./.env; set +a; DATA=./data ./restore-drill.sh
#
# REPLICA may also be file:///path (that is how the drill itself was tested).
set -euo pipefail
REPLICA="${REPLICA:-s3://${LITESTREAM_BUCKET:?set LITESTREAM_BUCKET or REPLICA}}"
DATA="${DATA:-/data}"
OUT="$(mktemp -d)"
LS="${LITESTREAM:-litestream}"
SQLITE="${SQLITE:-sqlite3}"
fail=0

check() { # name restored-file live-file
  local name="$1" got="$2" live="$3"
  if [ "$("$SQLITE" "$got" 'PRAGMA integrity_check;')" != "ok" ]; then echo "✗ $name: damaged"; fail=1; return; fi
  local q="SELECT (SELECT COUNT(*) FROM sqlite_master WHERE type='table')"
  if "$SQLITE" "$got" "SELECT 1 FROM sqlite_master WHERE name='bottles'" | grep -q 1; then
    q="SELECT (SELECT COUNT(*) FROM wines)||' wines, '||(SELECT COUNT(*) FROM bottles)||' bottles, '||(SELECT COUNT(*) FROM orders)||' orders'"
  fi
  local a b
  a="$("$SQLITE" "$got" "$q")"
  b="$([ -f "$live" ] && "$SQLITE" "file:$live?mode=ro" "$q" || echo '(no live copy)')"
  if [ "$a" = "$b" ]; then echo "✓ $name: $a"; else echo "• $name: restored $a — live $b (live may have changed since the last sync)"; fi
}

"$LS" restore -o "$OUT/registry.db" "$REPLICA/registry.db"
check registry "$OUT/registry.db" "$DATA/registry.db"
for slug in $("$SQLITE" "$OUT/registry.db" "SELECT slug FROM tenants WHERE status <> 'deleted'"); do
  mkdir -p "$OUT/tenants/$slug"
  if "$LS" restore -o "$OUT/tenants/$slug/app.db" "$REPLICA/tenants/$slug/app.db"; then
    check "$slug" "$OUT/tenants/$slug/app.db" "$DATA/tenants/$slug/app.db"
  else
    echo "✗ $slug: no replica"; fail=1
  fi
done
echo "Restored copies in $OUT (delete when done)."
exit $fail
