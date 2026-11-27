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
# Development: the AI gateway, portal service and HQ share two random tokens, kept in their own
# .env files (never committed). Created once; nothing to do by hand.
add_env() { # file key value — only when the key is not set yet
  touch "$1"
  grep -qE "^$2=." "$1" || { sed -i '' "/^$2=\$/d" "$1" 2>/dev/null || true; echo "$2=$3" >> "$1"; }
}
cur() { grep -E "^$2=." "$1" 2>/dev/null | head -1 | cut -d= -f2- || true; }
SVC=$(cur apps/ai-gateway/.env AI_SERVICE_TOKEN); SVC=${SVC:-$(openssl rand -hex 24)}
ADM=$(cur apps/ai-gateway/.env AI_ADMIN_TOKEN); ADM=${ADM:-$(openssl rand -hex 24)}
add_env apps/ai-gateway/.env AI_SERVICE_TOKEN "$SVC"
add_env apps/ai-gateway/.env AI_ADMIN_TOKEN "$ADM"
add_env apps/portal-service/.env AI_SERVICE_TOKEN "$SVC"
add_env apps/hq/.env AI_ADMIN_TOKEN "$ADM"
add_env apps/hq/.env AI_URL "http://localhost:3600"

# Stop early with a clear message if another program already uses our ports.
API_PORT=$(grep -E '^PORT=' "$ENV_FILE" 2>/dev/null | cut -d= -f2 || true); API_PORT=${API_PORT:-3500}
for P in "$API_PORT" 5500 5543 3600 3700 3900 4400; do
  if lsof -nP -iTCP:"$P" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "Port $P is already in use by:"; lsof -nP -iTCP:"$P" -sTCP:LISTEN | tail -n +2 | awk '{print "  " $1 " (pid " $2 ")"}'
    echo "Stop that program (or MyWineCorks if it is already running in another Terminal window) and try again."
    exit 1
  fi
done
IP=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || true)
echo "MyWineCorks: http://localhost:5500${IP:+   ·   phone setup (first time): http://$IP:$API_PORT/phone   ·   phone app: https://$IP:5543/m}"
echo "Customer portal (development): http://localhost:3900/<portal address>"
echo "Website (development): http://localhost:4400 — requests from its forms appear in HQ › Website requests"
if grep -qE '^ANTHROPIC_API_KEY=.' apps/ai-gateway/.env 2>/dev/null; then echo "AI: Claude (key in apps/ai-gateway/.env)"; else echo "AI: example answers only — put ANTHROPIC_API_KEY in apps/ai-gateway/.env for real ones"; fi
echo "MyWineCorks HQ (licenses, development only): http://localhost:3700 — first time, the setup link is in apps/hq/data/setup-link.txt"
(sleep 6 && open "http://localhost:5500") >/dev/null 2>&1 &
exec pnpm dev
