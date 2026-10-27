#!/bin/bash
# Quick update of an INSTALLED Nexus: copies the files in ./nexus-chat (the built-in "Chat with Nexus" extension) into the app
# and re-signs it. Takes a few seconds. No dmg, no GitHub build.
#   cd nexus-rebrand && ./update_nexus_app.sh                      (updates /Applications/Nexus.app)
#   ./update_nexus_app.sh "/path/to/Nexus.app"                    (another copy)
# Your profile, history and sign-ins live in ~/Library/Application Support/Nexus and are not touched.
set -euo pipefail
cd "$(dirname "$0")"
APP="${1:-/Applications/Nexus.app}"
[ -d "$APP/Contents" ] || { echo "No app at: $APP"; exit 1; }
[ -d nexus-chat ] || { echo "The nexus-chat folder must be next to this script."; exit 1; }
command -v python3 >/dev/null || { echo "python3 missing: run 'xcode-select --install'"; exit 1; }
if pgrep -f "$APP/Contents/MacOS/NexusBrowser" >/dev/null 2>&1; then
  echo "Nexus is running. Quit it (Cmd+Q), then run this again."; exit 1
fi

echo "==> Updating the built-in extension in $APP"
python3 nexus_builtin.py "$APP" --native
xattr -cr "$APP"

echo "==> Re-signing (ad-hoc)"
codesign --remove-signature "$APP" 2>/dev/null || true
codesign --force --deep --sign - --timestamp=none "$APP"
codesign --verify --deep --strict "$APP" && echo "    signature OK"
echo "Done. Open Nexus again."
