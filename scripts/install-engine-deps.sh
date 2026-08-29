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

# 🔴 Install OUTSIDE the workspace, then move the tree in.
#
# ENGINE_DIR lives under packages/vscode-extension, which npm treats as part of
# this repo's workspace. Installing in place lets npm HOIST any dependency that
# is already satisfied at the repo root — it then never lands in the bundle, and
# the packaged extension crashes at runtime with "Cannot find module". `yaml`
# was silently missing exactly this way (#654 real-device gate): the build was
# green, the vsix installed fine, and the engine died on first evaluate.
#
# A temp dir outside the repo has no workspace root above it, so npm has nowhere
# to hoist to and every declared dependency is written locally.
#
# --ignore-scripts is safe: @julusian/midi ships prebuilt native binaries
# (prebuildify) loaded at require-time via node-gyp-build, so no compile step.
DEPS_TMP="$(mktemp -d)"
trap 'rm -rf "$DEPS_TMP"' EXIT
cp "$ENGINE_DIR/package.json" "$DEPS_TMP/package.json"
(cd "$DEPS_TMP" && npm install --omit=dev --ignore-scripts 2>&1)

rm -rf "$ENGINE_DIR/node_modules"
mv "$DEPS_TMP/node_modules" "$ENGINE_DIR/node_modules"

# Apply supercolliderjs boot timeout patch
bash "$PROJECT_ROOT/scripts/patch-supercolliderjs.sh"

# 🔴 Verify every declared dependency actually landed, and fail loudly if not.
# The failure this guards against is invisible at build time and only surfaces
# as a runtime crash in the packaged extension, so the check has to be here.
MISSING=""
for DEP in $(node -e 'console.log(Object.keys(require(process.argv[1]).dependencies).join(" "))' "$ENGINE_DIR/package.json"); do
  if [ ! -d "$ENGINE_DIR/node_modules/$DEP" ]; then
    MISSING="$MISSING $DEP"
  fi
done

# Clean up temporary package.json and lock file
rm -f "$ENGINE_DIR/package.json" "$ENGINE_DIR/package-lock.json"

if [ -n "$MISSING" ]; then
  echo "ERROR: engine runtime dependencies missing from the bundle:$MISSING" >&2
  echo "       The packaged extension would crash with \"Cannot find module\"." >&2
  exit 1
fi

echo "Engine dependencies installed successfully"
