#!/usr/bin/env bash
# Start MyWineCorks (after setup-mac.sh has run once). Stop with Ctrl+C.
set -euo pipefail
cd "$(dirname "$0")/.."
IP=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || true)
echo "MyWineCorks: http://localhost:5173${IP:+   ·   phone on same Wi-Fi: http://$IP:5173}"
(sleep 6 && open "http://localhost:5173") >/dev/null 2>&1 &
exec pnpm dev
