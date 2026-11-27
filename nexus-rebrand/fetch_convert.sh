#!/bin/bash
# Builds "Convert to it!" (github.com/p2r3/convert, GPL-2.0) and puts the result into nexus-convert/ so that it becomes
# the built-in page nexus://convert. Needs bun (https://bun.sh) and git. Takes a few minutes; needs internet.
#
#   ./fetch_convert.sh              build the latest default branch of p2r3/convert (it is "master", not "main")
#   CONVERT_REF=<ref> ./fetch_convert.sh   build a specific branch/tag/commit
#
# The result (nexus-convert/index.html and its assets) is plain build output; delete it and run this again to update.
# If anything fails nothing is left half-written: nexus-convert/ keeps what it had.
set -euo pipefail
cd "$(dirname "$0")"
REF="${CONVERT_REF:-}"
command -v bun >/dev/null || { echo "bun is missing: install it from https://bun.sh (or: npm i -g bun)"; exit 1; }
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
echo "==> Fetching p2r3/convert (${REF:-default branch})"
git clone --quiet https://github.com/p2r3/convert "$WORK/src"
[ -z "$REF" ] || git -C "$WORK/src" checkout --quiet "$REF"
SHA="$(git -C "$WORK/src" rev-parse HEAD)"
cd "$WORK/src"
echo "==> Building ($SHA)"
export PUPPETEER_SKIP_DOWNLOAD=1 ELECTRON_SKIP_BINARY_DOWNLOAD=1 HUSKY=0
bun install --ignore-scripts
bun run build:assemble --all
bun x tsc
bun x vite build
[ -f dist/index.html ] || { echo "the build produced no dist/index.html"; exit 1; }
cd - >/dev/null
DEST="$PWD/nexus-convert"; STAGE="$WORK/stage"; mkdir -p "$STAGE"
cp -R "$WORK/src/dist/." "$STAGE/"
# An extension page may not load scripts from anywhere but itself; the build uses relative paths (base: "./"), so it
# should work as is. Anything that still points to a web address is listed here so you can see what needs the internet.
echo "==> Web addresses left in index.html (informational):"; grep -o 'https\?://[^"'"'"' )]*' "$STAGE/index.html" | sort -u | head -20 || true
cp "$WORK/src/LICENSE" "$STAGE/LICENSE.convert"
printf 'Convert to it! (github.com/p2r3/convert), commit %s, GPL-2.0. Built by fetch_convert.sh.\n' "$SHA" > "$STAGE/SOURCE.txt"
# replace the old build, keep our own files
for f in manifest.json nexus-redirect.js README.txt; do cp "$DEST/$f" "$STAGE/$f"; done
cp -R "$DEST/icons" "$STAGE/icons"
rm -rf "$DEST.old"; mv "$DEST" "$DEST.old"; mv "$STAGE" "$DEST"; rm -rf "$DEST.old"
echo "Done: nexus-convert/ is ready ($(du -sh "$DEST" | cut -f1)). Rebuild Nexus to include it."
