#!/usr/bin/env bash
# Start MyWineCorks (after setup-mac.sh has run once). Stop with Ctrl+C.
set -euo pipefail
# Apple Silicon Mac running this Terminal under Rosetta (Intel mode)? Re-run natively,
# so Homebrew, Node and the database module are all arm64.
if [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = "1" ]; then
  echo "Switching from Rosetta to native Apple Silicon…"
  exec arch -arm64 /bin/bash "$0" "$@"
fi
cd "$(dirname "$0")/.."

# Older settings used ports 3000 / 5173, which clash with MyWines and other tools → move to 3500 / 5500.
ENV_FILE=apps/server/.env
if [ -f "$ENV_FILE" ]; then
  if grep -q '^PORT=3000$' "$ENV_FILE"; then sed -i '' 's/^PORT=3000$/PORT=3500/' "$ENV_FILE"; echo "Updated $ENV_FILE: PORT=3500"; fi
  if grep -q 'localhost:5173' "$ENV_FILE"; then sed -i '' 's/localhost:5173/localhost:5500/' "$ENV_FILE"; echo "Updated $ENV_FILE: PUBLIC_URL uses port 5500"; fi
fi
# Stop early with a clear message if another program already uses our ports.
API_PORT=$(grep -E '^PORT=' "$ENV_FILE" 2>/dev/null | cut -d= -f2); API_PORT=${API_PORT:-3500}
for P in "$API_PORT" 5500; do
  if lsof -nP -iTCP:"$P" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "Port $P is already in use by:"; lsof -nP -iTCP:"$P" -sTCP:LISTEN | tail -n +2 | awk '{print "  " $1 " (pid " $2 ")"}'
    echo "Stop that program (or MyWineCorks if it is already running in another Terminal window) and try again."
    exit 1
  fi
done
IP=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || true)
echo "MyWineCorks: http://localhost:5500${IP:+   ·   phone on same Wi-Fi: http://$IP:5500}"
(sleep 6 && open "http://localhost:5500") >/dev/null 2>&1 &
exec pnpm dev
