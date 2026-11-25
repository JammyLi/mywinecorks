#!/usr/bin/env bash
# MyWineCorks — first-time setup on a Mac.
#   ./scripts/setup-mac.sh
# Installs Node 22 + pnpm if needed, installs packages, creates your workspace
# (prints the Owner's one-time setup link), then starts the app.
set -euo pipefail
# Apple Silicon Mac running this Terminal under Rosetta (Intel mode)? Re-run natively,
# so Homebrew, Node and the database module are all arm64.
if [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = "1" ]; then
  echo "Switching from Rosetta to native Apple Silicon…"
  exec arch -arm64 /bin/bash "$0" "$@"
fi
cd "$(dirname "$0")/.."
ROOT="$(pwd)"
green() { printf '\033[32m%s\033[0m\n' "$*"; }
gold()  { printf '\033[33m%s\033[0m\n' "$*"; }
red()   { printf '\033[31m%s\033[0m\n' "$*"; }

echo; gold "== MyWineCorks setup =="

# 1. Tools ------------------------------------------------------------------
node_major() { node -v 2>/dev/null | sed -E 's/^v([0-9]+).*/\1/' || echo 0; }
if [ "$(node_major)" -lt 22 ] 2>/dev/null || ! command -v node >/dev/null; then
  if ! command -v brew >/dev/null; then
    red "Node.js 22 is needed. Install Homebrew first (https://brew.sh), or Node 22 LTS from https://nodejs.org, then run this again."
    exit 1
  fi
  gold "Installing Node.js 22 with Homebrew…"
  brew install node@22
  export PATH="$(brew --prefix node@22)/bin:$PATH"
  echo "export PATH=\"$(brew --prefix node@22)/bin:\$PATH\"" >> "$HOME/.zprofile"
fi
green "✓ Node $(node -v)"

if ! command -v pnpm >/dev/null; then
  gold "Installing pnpm…"
  if command -v brew >/dev/null; then brew install pnpm; else npm install -g pnpm@10; fi
fi
green "✓ pnpm $(pnpm -v)"

# 2. Packages ---------------------------------------------------------------
gold "Installing packages (first time takes a minute)…"
pnpm install
green "✓ Packages installed"

# 3. Settings ---------------------------------------------------------------
ENV=apps/server/.env
if [ ! -f "$ENV" ]; then
  cp apps/server/.env.example "$ENV"
  green "✓ Created $ENV (self-hosted mode, data in apps/server/data)"
fi

# 4. Workspace --------------------------------------------------------------
if [ ! -f apps/server/data/registry.db ]; then
  echo; gold "Create your workspace (press Enter to accept the suggestion in brackets)"
  read -r -p "Company / cellar name [我的酒窖]: " NAME;           NAME=${NAME:-我的酒窖}
  read -r -p "Workspace id, letters/numbers/dashes [my-cellar]: " SLUG; SLUG=${SLUG:-my-cellar}
  read -r -p "Owner email [jammy.li@getfocus.com]: " EMAIL;       EMAIL=${EMAIL:-jammy.li@getfocus.com}
  read -r -p "Owner name [Jammy]: " ONAME;                        ONAME=${ONAME:-Jammy}
  read -r -p "Language zh-TW or en [zh-TW]: " LANG_;              LANG_=${LANG_:-zh-TW}
  (cd apps/server && pnpm exec tsx --env-file=.env src/cli/create-tenant.ts \
      --slug "$SLUG" --name "$NAME" --owner "$EMAIL" --owner-name "$ONAME" --lang "$LANG_") | tee "$ROOT/setup-link.txt"
  green "✓ Workspace created (link also saved in setup-link.txt)"
else
  green "✓ Workspace already exists (apps/server/data)"
fi

# 5. Start ------------------------------------------------------------------

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
echo
IP=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || true)
green "Starting MyWineCorks…"
echo "  This Mac:          http://localhost:5500"
[ -n "$IP" ] && echo "  Phone (same Wi-Fi): http://$IP:5500"
LINK=$(grep -Eo 'http://[^ ]+/setup\?[^ ]+' setup-link.txt 2>/dev/null | tail -1 || true)
if [ -n "$LINK" ] && [ ! -f apps/server/data/.owner-ready ]; then
  echo "  First time? Open your setup link: $LINK"
  (sleep 6 && open "$LINK") >/dev/null 2>&1 &
  touch apps/server/data/.owner-ready
else
  (sleep 6 && open "http://localhost:5500") >/dev/null 2>&1 &
fi
echo "  Stop with Ctrl+C. Next time just run: ./scripts/start.sh"
echo
exec pnpm dev
