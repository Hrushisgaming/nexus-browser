#!/bin/bash
# Re-brands a Nexus .dmg that was built on GitHub (icon, logos, setup page) and refreshes the built-in Chat with Nexus
# extension from the ./nexus-chat folder next to this script, re-signs it ad-hoc and writes a new dmg.
# Run on your Mac, from the nexus-rebrand folder:   ./fix_nexus_dmg.sh ~/Downloads/nexus_*_arm64-macos.dmg
# Writes Nexus-updated.dmg next to this script. The original dmg is not touched.
set -euo pipefail
cd "$(dirname "$0")"
SRC="${1:?usage: ./fix_nexus_dmg.sh /path/to/nexus_..._arm64-macos.dmg}"
[ -f "$SRC" ] || { echo "not found: $SRC"; exit 1; }
command -v python3 >/dev/null || { echo "python3 missing: run 'xcode-select --install'"; exit 1; }

WORK="$(mktemp -d)"; MNT="$WORK/mnt"; STAGE="$WORK/stage"; mkdir -p "$MNT" "$STAGE"
cleanup() { hdiutil detach "$MNT" -quiet 2>/dev/null || true; rm -rf "$WORK"; }
trap cleanup EXIT

echo "==> Copying Nexus.app out of the dmg"
hdiutil attach -nobrowse -readonly -noverify -mountpoint "$MNT" "$SRC" >/dev/null
[ -d "$MNT/Nexus.app" ] || { echo "no Nexus.app inside this dmg"; ls "$MNT"; exit 1; }
ditto "$MNT/Nexus.app" "$STAGE/Nexus.app"
hdiutil detach "$MNT" -quiet
xattr -cr "$STAGE/Nexus.app"

echo "==> Applying the icon / logo changes"
python3 nexus_patch_ci.py "$STAGE/Nexus.app"

echo "==> Refreshing the built-in Chat with Nexus extension (the files in ./nexus-chat)"
python3 nexus_builtin.py "$STAGE/Nexus.app" --native

echo "==> Re-signing (ad-hoc)"
rm -f "$STAGE/Nexus.app/Contents/embedded.provisionprofile"
codesign --remove-signature "$STAGE/Nexus.app" 2>/dev/null || true
codesign --force --deep --sign - --timestamp=none "$STAGE/Nexus.app"
codesign --verify --deep --strict "$STAGE/Nexus.app" && echo "    signature OK"

echo "==> Building the dmg"
ln -s /Applications "$STAGE/Applications"
OUT="$PWD/Nexus-updated.dmg"                      # never the same file as the input
[ "$OUT" -ef "$SRC" ] && OUT="$PWD/Nexus-updated-2.dmg"
rm -f "$OUT"
hdiutil create -volname "Nexus" -srcfolder "$STAGE" -ov -format UDZO "$OUT" >/dev/null
echo "Done: $OUT"
