#!/usr/bin/env bash
# Build and package the known-behavior VST3 instrument oracle for host tests.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
workspace_root="$(cd "$here/../.." && pwd)"
cd "$workspace_root"

profile="${1:-debug}"
if [ "$profile" = "release" ]; then
  cargo build -p orbit-vst3-synth-oracle --release >&2
else
  cargo build -p orbit-vst3-synth-oracle >&2
fi

dylib="target/$profile/liborbit_vst3_synth_oracle.dylib"
[ -f "$dylib" ] || { echo "dylib not found: $dylib" >&2; exit 1; }

# 🔴 出力先は**呼び出し元ごとに分ける**（既定は PID）。
#
# このスクリプトは複数クレートのテストから呼ばれる（`orbit-vst3-host` のループ通しテストと
# `orbit-vst3-instrument-child` の配線テスト）。それぞれ**別プロセス**なので、固定パスへ
# `rm -rf` → `mkdir` → `cp` すると、片方の `cp` の最中にもう片方が消す・`dlopen` した瞬間に
# 差し替わる、といった競合が起きる。`cargo test` は既定でテストバイナリを逐次実行するので
# 今は表面化しないが、`cargo test -p A` と `cargo test -p B` を別ターミナルで並行実行したり
# `cargo nextest`（クロスバイナリ並列が既定）へ移ると即座に踏む。
#
# 手順の共有（直し忘れ防止）が目的であって、成果物を共有する必要は無いので、
# 出力先を分けて競合そのものを無くす。
slot="${2:-$$}"
bundle="target/vst3-fixtures/$slot/SynthOracle.vst3"
rm -rf "$bundle"
mkdir -p "$bundle/Contents/MacOS"
cp "$dylib" "$bundle/Contents/MacOS/SynthOracle"
printf 'BNDL????' > "$bundle/Contents/PkgInfo"
cat > "$bundle/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleExecutable</key><string>SynthOracle</string>
  <key>CFBundleIdentifier</key><string>com.signalcompose.orbitscore.synth-oracle</string>
  <key>CFBundleName</key><string>SynthOracle</string>
  <key>CFBundlePackageType</key><string>BNDL</string>
  <key>CFBundleSignature</key><string>????</string>
  <key>CFBundleVersion</key><string>0.0.1</string>
</dict></plist>
PLIST

echo "$workspace_root/$bundle"
