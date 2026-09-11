#!/bin/bash
# Install engine runtime dependencies into the VS Code extension's engine directory.
#
# Kept as the named entry point (CLAUDE.md's manual pre-merge gate, the root
# `pretest:e2e:gated`, and the dev site all name this script). The mechanism —
# and the reason it is needed at all — lives in install-bundle-deps.sh, which
# the extension's own dependencies go through too (#873).
#

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

bash "$SCRIPT_DIR/install-bundle-deps.sh" \
  engine \
  "$PROJECT_ROOT/packages/engine/package.json" \
  "$PROJECT_ROOT/packages/vscode-extension/engine"
