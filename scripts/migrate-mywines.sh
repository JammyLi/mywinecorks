#!/usr/bin/env bash
# Move MyWines data into MyWineCorks (SPEC §14). MyWines is only read, never changed.
#
#   ./scripts/migrate-mywines.sh                       # dry run: shows what would be imported
#   ./scripts/migrate-mywines.sh --commit              # import for real
#
# Options (all optional):
#   --from <MyWines data folder>   default: ../mywines/data next to this project
#   --user login=email:role        bring a MyWines user over (repeat for each user);
#                                  role = owner, admin, manager, employee, picker, viewer
#   --workspace <id>               only needed if there is more than one workspace
#
# Stop MyWines before the real run so its last changes are in the copy.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"
FROM="$ROOT/../mywines/data"
ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --from) FROM="$2"; shift 2 ;;
    *) ARGS+=("$1"); shift ;;
  esac
done
FROM="$(cd "$FROM" 2>/dev/null && pwd)" || { echo "MyWines data folder not found. Use --from /path/to/mywines/data"; exit 1; }
[ -f "$FROM/mywines.db" ] || { echo "No mywines.db in $FROM"; exit 1; }
pnpm --silent --filter @mwc/server migrate-mywines --from "$FROM" ${ARGS[@]+"${ARGS[@]}"}
