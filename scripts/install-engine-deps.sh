#!/bin/bash
# Install engine runtime dependencies into the VS Code extension's engine directory.
# This ensures the packaged extension includes supercolliderjs and wavefile.

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
ENGINE_DIR="$PROJECT_ROOT/packages/vscode-extension/engine"

echo "Installing engine runtime dependencies..."

# Create a temporary package.json for installing only production deps
mkdir -p "$ENGINE_DIR/node_modules"
cat > "$ENGINE_DIR/package.json" <<'PKGJSON'
{
  "name": "orbitscore-engine-deps",
  "private": true,
  "dependencies": {
    "supercolliderjs": "^1.0.1",
    "wavefile": "^11.0.0"
  }
}
PKGJSON

# Install production dependencies only
cd "$ENGINE_DIR"
npm install --omit=dev --ignore-scripts 2>&1

# Apply supercolliderjs boot timeout patch
bash "$PROJECT_ROOT/scripts/patch-supercolliderjs.sh"

# Clean up temporary package.json and lock file
rm -f "$ENGINE_DIR/package.json" "$ENGINE_DIR/package-lock.json"

echo "Engine dependencies installed successfully"
