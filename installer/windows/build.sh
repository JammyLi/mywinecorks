#!/usr/bin/env bash
# Build the Windows installer: release/MyWineCorks-Setup-<version>.exe
# Needs: Node 22, pnpm, makensis (apt install nsis / brew install makensis), internet (npm + GitHub).
#   installer/windows/build.sh --trust <hq-license-public.pem>
set -euo pipefail
ORIG=$(pwd)
cd "$(dirname "$0")"
HERE=$(pwd); REPO=$(cd ../.. && pwd)
WINSW_VER=2.12.0
# (arguments such as --trust are relative to where the script was started)
(cd "$ORIG" && node "$REPO/scripts/release/build.mjs" --platform win-x64 "$@")
REL="$REPO/release/win-x64"
VERSION=$(node -p "require('$REL/release.json').version")
CACHE="$REPO/release/.cache"; STAGE="$HERE/.stage"
rm -rf "$STAGE"; mkdir -p "$STAGE" "$CACHE"
cp -R "$REL/app" "$REL/launcher.mjs" "$REL/node.exe" "$STAGE/"
WINSW="$CACHE/WinSW-$WINSW_VER-x64.exe"
[ -f "$WINSW" ] || curl -fsSL -o "$WINSW" "https://github.com/winsw/winsw/releases/download/v$WINSW_VER/WinSW-x64.exe"
cp "$WINSW" "$STAGE/MyWineCorksService.exe"
cp "$HERE/files/"* "$STAGE/"
OUT="$REPO/release/MyWineCorks-Setup-$VERSION.exe"
makensis -V2 -DVERSION="$VERSION" -DSTAGE="$STAGE" -DOUTFILE="$OUT" "$HERE/mywinecorks.nsi"
rm -rf "$STAGE"
ls -lh "$OUT"
