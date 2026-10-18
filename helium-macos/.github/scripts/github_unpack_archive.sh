#!/bin/bash -eux

# Unpacking script for GitHub Actions

echo "Checking sha256sum of archive:"
sha256sum -c sums.txt

_src_dir="$PWD/build/src"
ls -lrt

mkdir build
echo "Extracting build archive"
tar -C build -xf build_src.tar.zst

rm build_src.tar.zst

sudo df -h
sudo du -hs "$_src_dir"

echo "=== DIAG: state after unpack ==="
ls -la "$_src_dir/out/Default" | head -40 || true
ls -la "$_src_dir/out/Default"/.siso* 2>&1 | head || true
echo "object files present: $(find "$_src_dir/out/Default/obj" -name '*.o' 2>/dev/null | wc -l)"
echo "=== END DIAG ==="
