#!/bin/bash
# bundle-macos.sh — orbit-std-gain の cdylib をビルドし、macOS の .clap bundle に組む。
#
# 使い方: ./bundle-macos.sh [--release] [--out <dir>]
#
# 既定の出力先:
#   rust/target/<profile>/std-plugins/Gain.clap
#
# `--out <dir>` を渡すと <dir>/Gain.clap へ組む（アプリ同梱時に child 実行ファイルの隣の
# `std-plugins/` を指すために使う — SC.10.8 規範 2 の解決規約）。
#
# 🔴 bundle 名 `Gain.clap` は DSL 表面 `Gain(db: …)` と 1 対 1 で対応する。child は
#    `std-plugins/<name>.clap` で解決するため、**名前を変えると解決が無言で外れる**。

set -euo pipefail

export PATH="$HOME/.cargo/bin:$PATH"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKSPACE_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"

PROFILE="debug"
CARGO_FLAGS=()
OUT_DIR=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --release) PROFILE="release"; CARGO_FLAGS+=("--release"); shift ;;
    --out)     OUT_DIR="${2:?--out にはディレクトリが要る}"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

# plugin 名は crate の定数と一致していなければならない。手打ちのリテラルにしないよう
# lib.rs から読み出す（片方だけ直し忘れる形を作らない）。
PLUGIN_NAME="$(sed -n 's/^pub const PLUGIN_NAME: &str = "\(.*\)";$/\1/p' "$SCRIPT_DIR/src/lib.rs")"
PLUGIN_ID="$(sed -n 's/^pub const PLUGIN_ID: &str = "\(.*\)";$/\1/p' "$SCRIPT_DIR/src/lib.rs")"
if [[ -z "$PLUGIN_NAME" || -z "$PLUGIN_ID" ]]; then
  echo "error: src/lib.rs から PLUGIN_NAME / PLUGIN_ID を読めなかった" >&2
  exit 1
fi

echo "==> cargo build -p orbit-std-gain ${CARGO_FLAGS[*]-}"
(cd "$WORKSPACE_DIR" && cargo build -p orbit-std-gain ${CARGO_FLAGS[@]+"${CARGO_FLAGS[@]}"})

DYLIB="$WORKSPACE_DIR/target/$PROFILE/liborbit_std_gain.dylib"
if [[ ! -f "$DYLIB" ]]; then
  echo "error: cdylib が見つからない: $DYLIB" >&2
  exit 1
fi

if [[ -z "$OUT_DIR" ]]; then
  OUT_DIR="$WORKSPACE_DIR/target/$PROFILE/std-plugins"
fi
BUNDLE="$OUT_DIR/$PLUGIN_NAME.clap"

echo "==> Assembling bundle: $BUNDLE"
rm -rf "$BUNDLE"
mkdir -p "$BUNDLE/Contents/MacOS"
cp "$DYLIB" "$BUNDLE/Contents/MacOS/$PLUGIN_NAME"

cat > "$BUNDLE/Contents/Info.plist" << PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleExecutable</key>
    <string>$PLUGIN_NAME</string>
    <key>CFBundleIdentifier</key>
    <string>$PLUGIN_ID</string>
    <key>CFBundleName</key>
    <string>$PLUGIN_NAME</string>
    <key>CFBundlePackageType</key>
    <string>BNDL</string>
    <key>CFBundleShortVersionString</key>
    <string>0.0.1</string>
    <key>CFBundleVersion</key>
    <string>0.0.1</string>
    <key>CFBundleSignature</key>
    <string>????</string>
</dict>
</plist>
PLIST

echo "==> Verifying clap_entry export:"
nm -gU "$BUNDLE/Contents/MacOS/$PLUGIN_NAME" | grep clap_entry

echo ""
echo "Bundle:    $BUNDLE"
echo "Plugin ID: $PLUGIN_ID"
