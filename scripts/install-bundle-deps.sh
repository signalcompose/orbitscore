#!/bin/bash
# Install a package's production dependencies into a directory that ships inside
# the .vsix, deriving the set from that package's own package.json.
#
# Usage: install-bundle-deps.sh <label> <source-package.json> <dest-dir>
#
#   label                a human name for the log lines ("engine", "extension")
#   source-package.json  where the `dependencies` set is read from
#   dest-dir             the directory whose node_modules/ must end up holding them
#                        (created if missing; its node_modules/ is replaced wholesale,
#                        so only point this at a directory the build owns outright)
#
# 🔴 Why this script has to exist at all.
#
# npm workspaces HOIST any dependency already satisfied at the repo root. The
# package then builds green, `vsce package` finds nothing local to bundle, and
# the packaged extension dies at runtime with "Cannot find module" — on a
# machine that has no repo root to hoist from. This has now bitten three times:
#
#   #209  @julusian/midi / uuid / ws  — engine, crashed on MIDI init
#   #654  yaml                        — engine, crashed on first evaluate
#   #873  @modelcontextprotocol/sdk   — extension, activate() never ran
#
# The fix is the same each time: install in a temp dir that has NO workspace
# root above it, so npm has nowhere to hoist to and writes every declared
# dependency locally, then move that tree into place.
#
# 🔴 This is a stopgap, not the destination (#875). Bundling the extension with
# esbuild would make the whole class structurally impossible — a bundler walks
# the actual `require`/`import` graph, where this script walks `dependencies`
# and so cannot see a package that is imported but never declared. Landing a
# new build technology immediately before the stable freeze was the larger
# risk, so the copy-based approach was kept and the migration filed instead.
#
# --ignore-scripts is safe: the native dependency in play (@julusian/midi) ships
# prebuilt binaries (prebuildify) loaded at require-time via node-gyp-build, so
# nothing needs compiling.

set -e

LABEL="${1:?usage: install-bundle-deps.sh <label> <source-package.json> <dest-dir>}"
SOURCE_PKG="${2:?missing <source-package.json>}"
DEST_DIR="${3:?missing <dest-dir>}"

[ -f "$SOURCE_PKG" ] || { echo "ERROR: no such package.json: $SOURCE_PKG" >&2; exit 1; }
mkdir -p "$DEST_DIR"

DEPS_TMP="$(mktemp -d)"
trap 'rm -rf "$DEPS_TMP"' EXIT

# A package.json whose dependencies mirror the source's production set exactly —
# no hardcoded list that can fall out of sync with what the code requires. The
# same pass prints the names, so the list is derived once rather than re-read.
DEP_NAMES=$(node -e '
  const fs = require("fs");
  const src = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const deps = src.dependencies || {};
  fs.writeFileSync(process.argv[2], JSON.stringify({
    name: "orbitscore-bundle-deps",
    private: true,
    dependencies: deps,
  }, null, 2) + "\n");
  console.log(Object.keys(deps).join(" "));
' "$SOURCE_PKG" "$DEPS_TMP/package.json")

if [ -z "$DEP_NAMES" ]; then
  echo "$LABEL has no runtime dependencies to bundle"
  exit 0
fi

# Skip the reinstall when the tree already on disk was built from this exact
# dependency set. `npm run build` is run constantly during development and the
# install is otherwise paid every time for a set that almost never changes.
# The stamp records the resolved spec strings, so a widened range re-installs
# while a republished patch inside an unchanged range does not.
STAMP="$DEST_DIR/node_modules/.orbitscore-bundle-deps.json"
if [ -f "$STAMP" ] && cmp -s "$DEPS_TMP/package.json" "$STAMP"; then
  UP_TO_DATE=1
  for DEP in $DEP_NAMES; do
    [ -d "$DEST_DIR/node_modules/$DEP" ] || { UP_TO_DATE=0; break; }
  done
  if [ "$UP_TO_DATE" = 1 ]; then
    echo "$LABEL dependencies already current — skipping install"
    exit 0
  fi
fi

echo "Installing $LABEL runtime dependencies (derived from $SOURCE_PKG)..."
echo "  deps: $(echo "$DEP_NAMES" | tr ' ' ',' | sed 's/,/, /g')"

# --prefer-offline resolves from the local npm cache when it can, so a rebuild
# after a dependency change does not pay a registry round-trip per package.
(cd "$DEPS_TMP" && npm install --omit=dev --ignore-scripts --prefer-offline 2>&1)

# 🔴 Check the path before rm -rf. DEST_DIR is built from an absolute path by
# every caller, but an empty value here would aim the delete at /node_modules.
if [ -z "$DEST_DIR" ] || [ ! -d "$DEST_DIR" ]; then
  echo "ERROR: DEST_DIR が不正です: '$DEST_DIR'" >&2
  exit 1
fi
rm -rf "$DEST_DIR/node_modules"
mv "$DEPS_TMP/node_modules" "$DEST_DIR/node_modules"

# 🔴 Verify every declared dependency actually landed, and fail loudly if not.
# The failure this guards against is invisible at build time and only surfaces
# as a runtime crash in the packaged extension, so the check has to be here.
MISSING=""
for DEP in $DEP_NAMES; do
  if [ ! -d "$DEST_DIR/node_modules/$DEP" ]; then
    MISSING="$MISSING $DEP"
  fi
done

if [ -n "$MISSING" ]; then
  echo "ERROR: $LABEL runtime dependencies missing from the bundle:$MISSING" >&2
  echo "       The packaged extension would crash with \"Cannot find module\"." >&2
  exit 1
fi

# Written last so an interrupted install never leaves a stamp claiming success.
cp "$DEPS_TMP/package.json" "$STAMP"

echo "$LABEL dependencies installed successfully"
