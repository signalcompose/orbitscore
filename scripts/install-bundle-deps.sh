#!/bin/bash
# Install a package's production dependencies into a directory that ships inside
# the .vsix, deriving the set from that package's own package.json.
#
# Usage: install-bundle-deps.sh <label> <source-package.json> <dest-dir> [--prune]
#
#   label                a human name for the log lines ("engine", "extension")
#   source-package.json  where the `dependencies` set is read from
#   dest-dir             the directory whose node_modules/ must end up holding them
#   --prune              replace dest-dir/node_modules wholesale instead of merging.
#                        Only pass this for a directory the build owns outright
#                        (engine/), never for one npm also writes into.
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
# --ignore-scripts is safe: the native dependency in play (@julusian/midi) ships
# prebuilt binaries (prebuildify) loaded at require-time via node-gyp-build, so
# nothing needs compiling.

set -e

LABEL="${1:?usage: install-bundle-deps.sh <label> <source-package.json> <dest-dir> [--prune]}"
SOURCE_PKG="${2:?missing <source-package.json>}"
DEST_DIR="${3:?missing <dest-dir>}"
MODE="${4:-}"

[ -f "$SOURCE_PKG" ] || { echo "ERROR: no such package.json: $SOURCE_PKG" >&2; exit 1; }
[ -d "$DEST_DIR" ] || { echo "ERROR: no such directory: $DEST_DIR" >&2; exit 1; }

DEPS_TMP="$(mktemp -d)"
trap 'rm -rf "$DEPS_TMP"' EXIT

# A package.json whose dependencies mirror the source's production set exactly —
# no hardcoded list that can fall out of sync with what the code requires.
node -e '
  const fs = require("fs");
  const src = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  fs.writeFileSync(process.argv[2], JSON.stringify({
    name: "orbitscore-bundle-deps",
    private: true,
    dependencies: src.dependencies || {},
  }, null, 2) + "\n");
' "$SOURCE_PKG" "$DEPS_TMP/package.json"

DEP_NAMES=$(node -e 'console.log(Object.keys(require(process.argv[1]).dependencies).join(" "))' "$DEPS_TMP/package.json")

if [ -z "$DEP_NAMES" ]; then
  echo "$LABEL has no runtime dependencies to bundle"
  exit 0
fi

echo "Installing $LABEL runtime dependencies (derived from $SOURCE_PKG)..."
echo "  deps: $(echo "$DEP_NAMES" | tr ' ' ',' | sed 's/,/, /g')"

(cd "$DEPS_TMP" && npm install --omit=dev --ignore-scripts 2>&1)

if [ "$MODE" = "--prune" ]; then
  # 🔴 Check the path before rm -rf. DEST_DIR is built from an absolute path by
  # every caller, but an empty value here would aim the delete at /node_modules.
  if [ -z "$DEST_DIR" ] || [ ! -d "$DEST_DIR" ]; then
    echo "ERROR: DEST_DIR が不正です: '$DEST_DIR'" >&2
    exit 1
  fi
  rm -rf "$DEST_DIR/node_modules"
  mv "$DEPS_TMP/node_modules" "$DEST_DIR/node_modules"
else
  # Merge: npm may have put packages here itself (a version conflict that could
  # not hoist), and removing those would break the build that reads them.
  #
  # Copy one package at a time rather than the whole tree, so a scope directory
  # (@types, say) gains the new package instead of losing the ones already in it.
  mkdir -p "$DEST_DIR/node_modules"
  for SRC in "$DEPS_TMP"/node_modules/*; do
    NAME="$(basename "$SRC")"
    case "$NAME" in
      .bin) continue ;;                         # local shims, nothing requires them
      @*)                                       # a scope: descend one level
        mkdir -p "$DEST_DIR/node_modules/$NAME"
        for SCOPED in "$SRC"/*; do
          rm -rf "$DEST_DIR/node_modules/$NAME/$(basename "$SCOPED")"
          cp -R "$SCOPED" "$DEST_DIR/node_modules/$NAME/"
        done
        ;;
      *)
        rm -rf "${DEST_DIR:?}/node_modules/$NAME"
        cp -R "$SRC" "$DEST_DIR/node_modules/"
        ;;
    esac
  done
fi

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

echo "$LABEL dependencies installed successfully"
