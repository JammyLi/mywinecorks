#!/usr/bin/env bash
# Print a one-time password reset link (e.g. when the Owner is locked out):
#   ./scripts/reset-password.sh you@example.com
set -euo pipefail
cd "$(dirname "$0")/.."
[ -n "${1:-}" ] || { echo "Usage: ./scripts/reset-password.sh <email> [workspace]"; exit 1; }
pnpm --silent --filter @mwc/server reset-password --email "$1" ${2:+--workspace "$2"}
