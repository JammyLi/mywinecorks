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
IP=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || true)
echo "MyWineCorks: http://localhost:5173${IP:+   ·   phone on same Wi-Fi: http://$IP:5173}"
(sleep 6 && open "http://localhost:5173") >/dev/null 2>&1 &
exec pnpm dev
