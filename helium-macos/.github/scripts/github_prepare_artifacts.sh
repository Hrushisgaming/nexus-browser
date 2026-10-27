#!/bin/bash -eux
# Packs a CI build phase for the next phase. When the build has finished it also makes the Nexus .dmg
# (unsigned: ad-hoc signed by sign_and_package_app.sh, no Apple account needed).

_target_cpu="${1:-arm64}"

_root_dir="$(dirname "$(greadlink -f "$0")")"
_main_repo="$_root_dir/helium-chromium"
_src_dir="$_root_dir/build/src"

# If build finished successfully
if [ -f "$_root_dir/build_finished_$_target_cpu.log" ]; then
  _helium_version=$(python3 "$_main_repo/utils/helium_version.py" --tree "$_main_repo" --platform-tree "$_root_dir" --print)

  _file_name="nexus_${_helium_version}_${_target_cpu}-macos.dmg"

  cd "$_src_dir"

  xattr -cs out/Default/Nexus.app

  # Nexus look: app icon, logos, setup page and leftover "Helium" words. Best-effort: it prints SKIP for anything that
  # does not fit this build and never stops the job. Must run before signing (and before the launcher swap below).
  python3 "$_root_dir/../nexus-rebrand/nexus_patch_ci.py" "$_src_dir/out/Default/Nexus.app" || true

  # Add Chat with Nexus (side panel extension + launcher). Vault and Proton VPN are already compiled in (--native).
  # This happens before signing, so the ad-hoc signature below covers it.
  python3 "$_root_dir/../nexus-rebrand/nexus_builtin.py" "$_src_dir/out/Default/Nexus.app" --native

  # Finder layout of the dmg window: resources/dmg_dsstore still lists the old Helium file names, so Nexus.app would not
  # be placed. Rebuild it for Nexus. Best-effort: on any failure the old layout is kept and the job goes on.
  timeout 600 "$_root_dir/devutils/generate_dmg_dsstore.sh" || echo "warn: could not rebuild the dmg window layout, using the old one" >&2

  # No MACOS_CERTIFICATE_NAME is set, so sign_and_package_app.sh signs ad-hoc and skips notarization.
  export OUT_DMG_PATH="$_root_dir/$_file_name"
  "$_root_dir/sign_and_package_app.sh"

  cd "$_root_dir"
  shasum -a 256 "$_file_name" | tee "./${_file_name}.sha256.txt"

  echo "file_name=$_file_name" >> $GITHUB_OUTPUT

  mkdir -p release_asset
  mv "$_file_name" release_asset/
  ls -kahl release_asset/
  du -hs release_asset/

  # Nothing left to resume, so skip packing the source tree (tens of GB).
  mkdir -p upload_part_build upload_logs
  echo "finished" > upload_part_build/FINISHED.txt
  mv -vn ./*.log upload_logs/
  echo "ready for upload action"
  exit 0
fi

gsync --file-system "$_src_dir"

# Resume check, part 1: what the next phase will have to work with. The next phase prints the same lines after unpacking.
echo "=== DIAG: state before packing ==="
ls -la "$_src_dir/out/Default"/.siso* 2>&1 | head || true
echo "object files present: $(find "$_src_dir/out/Default/obj" -name '*.o' 2>/dev/null | wc -l)"
find "$_src_dir/out/Default/obj" -name '*.o' 2>/dev/null | head -3 | while read -r _f; do stat -f '%Fm %N' "$_f"; done || true
stat -f '%Fm %N' "$_src_dir/out/Default/build.ninja" || true
echo "=== END DIAG ==="

# Needs to be compressed to stay below GitHub's upload limit 2 GB (?!) 2020-11-24; used to be  5-8GB (?)
# --format pax keeps the file times to the nanosecond. The default tar format rounds them to whole seconds, and then the
# next phase may see every compiled file as changed and compile it all again (that is what the Oct 2026 run did: all 10
# phases started at [0/85k] and the build never finished, so no dmg).
tar --format pax -C build -c -f - src | zstd -vv -11 -T0 -o build_src.tar.zst

sha256sum ./build_src.tar.zst | tee ./sums.txt

mkdir -p upload_part_build
mv build_src.tar.zst sums.txt upload_part_build/
cp -va ./*.log upload_part_build/

ls -kahl upload_part_build/
du -hs upload_part_build/

mkdir upload_logs
mv -vn ./*.log upload_logs/

ls -kahl upload_logs/
du -hs upload_logs/

echo "ready for upload action"
