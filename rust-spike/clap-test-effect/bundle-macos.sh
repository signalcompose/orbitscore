#!/bin/bash
# bundle-macos.sh — build the dylib and assemble the macOS .clap bundle.
# Usage: ./bundle-macos.sh [--release]
#
# The bundle is created at:
#   target/<profile>/CLAPTestEffect.clap/Contents/MacOS/CLAPTestEffect

set -euo pipefail

export PATH="$HOME/.cargo/bin:$PATH"

PROFILE="debug"
CARGO_FLAGS=""
if [[ "${1:-}" == "--release" ]]; then
  PROFILE="release"
  CARGO_FLAGS="--release"
fi

echo "==> cargo build $CARGO_FLAGS"
cargo build $CARGO_FLAGS

DYLIB="target/$PROFILE/libclap_test_effect.dylib"
BUNDLE="target/$PROFILE/CLAPTestEffect.clap"

echo "==> Assembling bundle: $BUNDLE"
mkdir -p "$BUNDLE/Contents/MacOS"
cp "$DYLIB" "$BUNDLE/Contents/MacOS/CLAPTestEffect"

cat > "$BUNDLE/Contents/Info.plist" << 'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleExecutable</key>
    <string>CLAPTestEffect</string>
    <key>CFBundleIdentifier</key>
    <string>com.signalcompose.clap-test-effect</string>
    <key>CFBundleName</key>
    <string>CLAP Test Effect</string>
    <key>CFBundlePackageType</key>
    <string>BNDL</string>
    <key>CFBundleShortVersionString</key>
    <string>0.1.0</string>
    <key>CFBundleVersion</key>
    <string>0.1.0</string>
    <key>CFBundleSignature</key>
    <string>????</string>
</dict>
</plist>
PLIST

echo "==> Verifying clap_entry export:"
nm -gU "$BUNDLE/Contents/MacOS/CLAPTestEffect" | grep clap_entry

echo ""
echo "Bundle: $(pwd)/$BUNDLE"
echo "Plugin ID: com.signalcompose.clap-test-effect"
