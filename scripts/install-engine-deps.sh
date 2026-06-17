#!/bin/bash
# Install engine runtime dependencies into the VS Code extension's engine directory.
#
# The dependency set is derived from packages/engine/package.json so the bundle
# never drifts from what the engine actually requires at runtime. (This script
# previously hardcoded only supercolliderjs + wavefile and silently dropped
# @julusian/midi / uuid / ws — the v1.1 MIDI runtime deps — which crashed the
# packaged extension with "Cannot find module '@julusian/midi'" on MIDI init.
# See #209 / Epic #278 QA.)

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
ENGINE_DIR="$PROJECT_ROOT/packages/vscode-extension/engine"
ENGINE_PKG="$PROJECT_ROOT/packages/engine/package.json"

echo "Installing engine runtime dependencies (derived from engine package.json)..."

mkdir -p "$ENGINE_DIR/node_modules"

# Write a temporary package.json whose dependencies mirror the engine's own
# production dependencies exactly — no hardcoded list to fall out of sync.
node -e '
  const fs = require("fs");
  const eng = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const out = {
    name: "orbitscore-engine-deps",
    private: true,
    dependencies: eng.dependencies || {},
  };
  fs.writeFileSync(process.argv[2], JSON.stringify(out, null, 2) + "\n");
' "$ENGINE_PKG" "$ENGINE_DIR/package.json"

echo "  deps: $(node -e 'console.log(Object.keys(require(process.argv[1]).dependencies).join(", "))' "$ENGINE_DIR/package.json")"

# Install production dependencies only. --ignore-scripts is safe: @julusian/midi
# ships prebuilt native binaries (prebuildify) loaded at require-time via
# node-gyp-build, so no postinstall/compile step is needed.
cd "$ENGINE_DIR"
npm install --omit=dev --ignore-scripts 2>&1

# Apply supercolliderjs boot timeout patch
bash "$PROJECT_ROOT/scripts/patch-supercolliderjs.sh"

# Clean up temporary package.json and lock file
rm -f "$ENGINE_DIR/package.json" "$ENGINE_DIR/package-lock.json"

echo "Engine dependencies installed successfully"
