#!/bin/bash
# Install the VS Code extension's OWN runtime dependencies so the .vsix can
# activate on a cold install (#873).
#
# Without this, npm workspaces hoist @modelcontextprotocol/sdk and zod to the
# repo root, nothing lands inside the package, and activate() throws
# "Cannot find module '@modelcontextprotocol/sdk/server/mcp.js'" on the user's
# machine — while every build and CI gate stays green.
#
# 🔴 The destination is dist/node_modules, not the package's own node_modules,
# and that is load-bearing for two separate reasons:
#
#   1. `vsce package` excludes the package-root `node_modules` unconditionally.
#      A `!node_modules/**` negation in .vscodeignore does NOT override it
#      (measured). Nested ones like engine/node_modules and dist/node_modules
#      are not special-cased and ship normally.
#   2. Node resolves `require('@modelcontextprotocol/sdk/...')` from
#      dist/mcp-server.js by walking up from that file, so dist/node_modules is
#      the FIRST directory it looks in — no path rewriting needed.
#
# Installing into the package root instead also breaks packaging outright: npm
# would then have the dependency at two resolvable paths (hoisted root + local),
# vsce's dependency walk emits both onto one .vsix entry, and the VSIX format
# rejects it with "the following files have the same case insensitive path".
# `vsce package --no-dependencies` turns that walk off; the files ship because
# they are ordinary files under dist/.
#
# `--prune` is safe: dist/ is build output that nothing but the build writes to.

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
EXT_DIR="$PROJECT_ROOT/packages/vscode-extension"

mkdir -p "$EXT_DIR/dist"

bash "$SCRIPT_DIR/install-bundle-deps.sh" \
  extension \
  "$EXT_DIR/package.json" \
  "$EXT_DIR/dist" \
  --prune
