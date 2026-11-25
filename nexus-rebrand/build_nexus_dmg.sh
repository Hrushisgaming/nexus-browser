#!/bin/bash
# Builds Nexus.dmg. Run on your Mac (needs python3, codesign, hdiutil, curl: all there once you have run xcode-select --install).
#
#   ./build_nexus_dmg.sh                       uses the Helium dmg in base/ (or ~/Downloads, or downloads one)
#   ./build_nexus_dmg.sh /path/to/helium.dmg   uses that one instead
#   ./build_nexus_dmg.sh --refresh-proton      also fetches a fresh Proton VPN extension
#   ./build_nexus_dmg.sh --native              the base dmg was built from the Nexus source (Vault, Authenticator and Proton VPN are already inside it)
#
# Where the Helium base comes from, first match wins:
#   1. the path you pass          2. base/helium_*arm64-macos.dmg in this folder (keep a copy there!)
#   3. ~/Downloads/helium_*arm64-macos.dmg      4. the latest release on github.com/imputnet/helium-macos
set -euo pipefail
cd "$(dirname "$0")"

REFRESH=0; BASE=""; NATIVE=0
for a in "$@"; do case "$a" in --refresh-proton) REFRESH=1 ;; --native) NATIVE=1 ;; *) BASE="$a" ;; esac; done
PROTON_ID="jplgfhpmjnbigmhklmmbgecoobifkmpa"

command -v python3 >/dev/null || { echo "python3 missing: run 'xcode-select --install' first"; exit 1; }
newest() { ls -t "$@" 2>/dev/null | head -1 || true; }

# ---- 1. find the Helium base ----
[ -n "$BASE" ] || BASE="$(newest base/helium_*arm64-macos.dmg)"
[ -n "$BASE" ] || BASE="$(newest "$HOME"/Downloads/helium_*arm64-macos.dmg)"
if [ -z "$BASE" ]; then
  echo "==> No Helium dmg found locally; downloading the latest release into base/"
  mkdir -p base
  API="https://api.github.com/repos/imputnet/helium-macos/releases/latest"
  URL="$(curl -fsSL "$API" | python3 -c 'import json,sys; print(next((a["browser_download_url"] for a in json.load(sys.stdin)["assets"] if a["name"].endswith("arm64-macos.dmg")), ""))' || true)"
  [ -n "$URL" ] || { echo "Could not find a download. Put a helium_*arm64-macos.dmg into the base/ folder and run this again."; exit 1; }
  BASE="base/$(basename "$URL")"; curl -fL --progress-bar -o "$BASE.part" "$URL" && mv "$BASE.part" "$BASE"
fi
[ -f "$BASE" ] || { echo "Helium dmg not found: $BASE"; exit 1; }
echo "==> Base: $BASE"

# ---- 2. Proton VPN extension (fetched once, then kept in vendor/ so later builds work offline) ----
mkdir -p vendor; CRX="vendor/proton-vpn.crx"
if [ "$NATIVE" = 0 ] && { [ "$REFRESH" = 1 ] || [ ! -s "$CRX" ]; }; then
  echo "==> Fetching the Proton VPN extension from the Chrome Web Store (saved in vendor/)"
  U="https://clients2.google.com/service/update2/crx?response=redirect&prodversion=155.0.0.0&acceptformat=crx2,crx3&x=id%3D${PROTON_ID}%26installsource%3Dondemand%26uc"
  if curl -fsSL --max-time 120 -o "$CRX.part" "$U" && [ "$(head -c 4 "$CRX.part")" = "Cr24" ]; then mv "$CRX.part" "$CRX"
  else rm -f "$CRX.part"; echo "    Could not download it (offline?). Building WITHOUT Proton VPN. Run again once online, or use install_proton_vpn.command."; fi
fi

WORK="$(mktemp -d)"; MNT="$WORK/mnt"; STAGE="$WORK/stage"; mkdir -p "$MNT" "$STAGE"
cleanup() { hdiutil detach "$MNT" -quiet 2>/dev/null || true; rm -rf "$WORK"; }
trap cleanup EXIT

# ---- 3. copy Helium.app out of the base ----
echo "==> Copying Helium.app out of the disk image"
IMG="$BASE"
if [ "$(head -c 6 "$BASE" | od -An -tx1 | tr -d ' \n')" = "fd377a585a00" ]; then      # an xz-wrapped disk image
  echo "    (this base is xz-compressed; unpacking it first, about a minute)"
  IMG="$WORK/base.img"
  python3 -c 'import lzma,shutil,sys; shutil.copyfileobj(lzma.open(sys.argv[1],"rb"), open(sys.argv[2],"wb"), 1<<22)' "$BASE" "$IMG"
fi
ATTACH=(hdiutil attach -nobrowse -readonly -noverify -mountpoint "$MNT")
"${ATTACH[@]}" "$IMG" >/dev/null 2>&1 || "${ATTACH[@]}" -imagekey diskimage-class=CRawDiskImage "$IMG" >/dev/null
ditto "$MNT/Helium.app" "$STAGE/Nexus.app"
hdiutil detach "$MNT" -quiet
xattr -cr "$STAGE/Nexus.app"

# ---- 4. change it into Nexus, add the built-in extensions ----
echo "==> Applying Nexus changes"
python3 nexus_patch.py "$STAGE/Nexus.app"
echo "==> Building in the AI side panel, Nexus Vault, Nexus Authenticator and Proton VPN"
[ -d nexus-chat ] && [ -d nexus-vault ] && [ -d nexus-authenticator ] || { echo "nexus-chat, nexus-vault or nexus-authenticator folder missing next to this script"; exit 1; }
if [ "$NATIVE" = 1 ]; then python3 nexus_builtin.py "$STAGE/Nexus.app" --native
else python3 nexus_builtin.py "$STAGE/Nexus.app" ${CRX:+--crx "$CRX"}; fi

# ---- 5. sign ----
echo "==> Re-signing (the old signature is invalid after editing)"
rm -f "$STAGE/Nexus.app/Contents/embedded.provisionprofile"
codesign --remove-signature "$STAGE/Nexus.app" 2>/dev/null || true
codesign --force --sign - --timestamp=none "$STAGE/Nexus.app/Contents/MacOS/Helium"
codesign --force --deep --sign - --timestamp=none "$STAGE/Nexus.app"
codesign --verify --deep --strict "$STAGE/Nexus.app"
echo "    signature OK"

# ---- 6. dmg ----
echo "==> Building Nexus.dmg"
ln -s /Applications "$STAGE/Applications"
OUT="$PWD/Nexus.dmg"; rm -f "$OUT"
hdiutil create -volname "Nexus" -srcfolder "$STAGE" -ov -format UDZO "$OUT" >/dev/null
hdiutil verify "$OUT" >/dev/null && echo "    dmg verified"
echo "Done: $OUT"
