#!/usr/bin/env bash
# package-oracle.sh — orbit-vst3-gain-oracle を macOS .vst3 バンドルに package する。
#
# Phase 0 (#381) の sample-exact 検証（0b ①）で使う既知挙動 oracle プラグイン。
# cdylib をビルドし `<target>/vst3-fixtures/GainOracle.vst3` に組み立てる。
# 成果物は target/ 配下（gitignore）なのでバイナリは repo に入らない。
#
# host spike / test はこのスクリプトを呼ぶか、同じパスを直接組み立てる。
# 出力パスを stdout に print する（test harness が食えるように）。
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
workspace_root="$(cd "$here/../.." && pwd)"   # rust/
cd "$workspace_root"

profile="${1:-debug}"
if [ "$profile" = "release" ]; then
  cargo build -p orbit-vst3-gain-oracle --release >&2
else
  cargo build -p orbit-vst3-gain-oracle >&2
fi

dylib="target/$profile/liborbit_vst3_gain_oracle.dylib"
[ -f "$dylib" ] || { echo "dylib not found: $dylib" >&2; exit 1; }

bundle="target/vst3-fixtures/GainOracle.vst3"
rm -rf "$bundle"
mkdir -p "$bundle/Contents/MacOS"
cp "$dylib" "$bundle/Contents/MacOS/GainOracle"
printf 'BNDL????' > "$bundle/Contents/PkgInfo"
cat > "$bundle/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key><string>GainOracle</string>
  <key>CFBundleIdentifier</key><string>com.signalcompose.orbitscore.gain-oracle</string>
  <key>CFBundleName</key><string>GainOracle</string>
  <key>CFBundlePackageType</key><string>BNDL</string>
  <key>CFBundleSignature</key><string>????</string>
  <key>CFBundleVersion</key><string>0.0.1</string>
</dict>
</plist>
PLIST

# 絶対パスを stdout に（test harness 用）。
echo "$workspace_root/$bundle"
