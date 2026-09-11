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
#   1. Under `vsce package --no-dependencies`, vsce excludes the package-root
#      `node_modules`; a `!node_modules/**` negation in .vscodeignore does NOT
#      override it (measured). With the dependency walk enabled, directories
#      returned by `npm list` are globbed individually and can ship from there.
#      Nested ones like engine/node_modules and dist/node_modules ship normally.
#   2. Node resolves `require('@modelcontextprotocol/sdk/...')` from
#      dist/mcp-server.js by walking up from that file, so dist/node_modules is
#      the FIRST directory it looks in — no path rewriting needed.
#
# The original cold-install failure happened first: `npm list --parseable`
# returned hoisted repo-root paths, `path.relative(cwd, ...)` turned them into
# `../../node_modules/...`, and .vscodeignore's `../../**` silently dropped them.
# Installing duplicates into the package root was then tried and exposed a
# second failure: root and local copies mapped to the same .vsix entry, which
# VSIX rejects as a duplicate case-insensitive path. `--no-dependencies` turns
# that walk off; the files ship because they are ordinary files under dist/.
#

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
EXT_DIR="$PROJECT_ROOT/packages/vscode-extension"

bash "$SCRIPT_DIR/install-bundle-deps.sh" \
  extension \
  "$EXT_DIR/package.json" \
  "$EXT_DIR/dist"
