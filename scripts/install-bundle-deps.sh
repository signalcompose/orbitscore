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
#   WORK_LOG 6.119  @julusian/midi / uuid / ws — engine, crashed on MIDI init
#   WORK_LOG 6.422  yaml                       — engine, crashed on first evaluate
#   #873            @modelcontextprotocol/sdk  — extension, activate() never ran
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
# prebuilt binaries loaded at require-time by pkg-prebuilds
# (`require("pkg-prebuilds/bindings")`), so nothing needs compiling.

set -e

LABEL="${1:?usage: install-bundle-deps.sh <label> <source-package.json> <dest-dir>}"
SOURCE_PKG="${2:?missing <source-package.json>}"
DEST_DIR="${3:?missing <dest-dir>}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
LOCKFILE="$PROJECT_ROOT/package-lock.json"

[ -f "$SOURCE_PKG" ] || { echo "ERROR: no such package.json: $SOURCE_PKG" >&2; exit 1; }
[ -f "$LOCKFILE" ] || { echo "ERROR: no root package-lock.json: $LOCKFILE" >&2; exit 1; }
mkdir -p "$DEST_DIR"

DEPS_TMP="$(mktemp -d)"
trap 'rm -rf "$DEPS_TMP"' EXIT

# A package.json whose dependency names mirror the source's production set, with
# every range replaced by the exact version resolved in the root lockfile. This
# makes the shipped versions the same ones the repository tests. The same pass
# prints the names, so the source list is derived once rather than re-read.
DEP_NAMES=$(node -e '
  const fs = require("fs");
  const path = require("path");
  const src = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const deps = src.dependencies;
  if (deps === null || typeof deps !== "object" || Array.isArray(deps)) {
    throw new Error(`${process.argv[1]}: dependencies must exist and be a JSON object (use {} for none)`);
  }
  const lockPath = process.argv[3];
  const projectRoot = path.dirname(lockPath);
  const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
  if (lock.packages === null || typeof lock.packages !== "object" || Array.isArray(lock.packages)) {
    throw new Error(`${lockPath}: packages must be a JSON object`);
  }
  const sourceDir = path.relative(projectRoot, path.dirname(path.resolve(process.argv[1])))
    .split(path.sep).join("/");
  const exactDeps = {};
  for (const name of Object.keys(deps)) {
    const candidates = sourceDir && sourceDir !== "."
      ? [`${sourceDir}/node_modules/${name}`, `node_modules/${name}`]
      : [`node_modules/${name}`];
    const locked = candidates.map((key) => lock.packages[key]).find(Boolean);
    if (!locked || typeof locked.version !== "string" || !locked.version) {
      throw new Error(`${name}: no exact version found in ${lockPath} (${candidates.join(", ")})`);
    }
    exactDeps[name] = locked.version;
  }
  fs.writeFileSync(process.argv[2], JSON.stringify({
    name: "orbitscore-bundle-deps",
    private: true,
    dependencies: exactDeps,
  }, null, 2) + "\n");
  console.log(Object.keys(deps).join(" "));
' "$SOURCE_PKG" "$DEPS_TMP/package.json" "$LOCKFILE")

mkdir -p "$DEPS_TMP/node_modules"

if [ -z "$DEP_NAMES" ]; then
  echo "$LABEL has no runtime dependencies to bundle"
fi

# Skip the reinstall when the tree already on disk was built from this exact
# dependency set. `npm run build` is run constantly during development and the
# install is otherwise paid every time for a set that almost never changes.
# The stamp records lockfile-resolved exact versions, so any locked version move
# automatically reinstalls. This fast path checks package manifests for direct
# dependencies only; the post-package gate checks the transitive resolution graph.
STAMP="$DEST_DIR/node_modules/.orbitscore-bundle-deps.json"
if [ -n "$DEP_NAMES" ] && [ -f "$STAMP" ] && cmp -s "$DEPS_TMP/package.json" "$STAMP"; then
  UP_TO_DATE=1
  for DEP in $DEP_NAMES; do
    [ -f "$DEST_DIR/node_modules/$DEP/package.json" ] || { UP_TO_DATE=0; break; }
  done
  if [ "$UP_TO_DATE" = 1 ]; then
    echo "$LABEL dependencies already current — skipping install"
    exit 0
  fi
fi

if [ -n "$DEP_NAMES" ]; then
  echo "Installing $LABEL runtime dependencies (locked from $SOURCE_PKG)..."
  echo "  deps: $(echo "$DEP_NAMES" | tr ' ' ',' | sed 's/,/, /g')"

  # --prefer-offline resolves from the local npm cache when it can, so a rebuild
  # after a dependency change does not pay a registry round-trip per package.
  (cd "$DEPS_TMP" && npm install --omit=dev --ignore-scripts --prefer-offline --no-audit --no-fund 2>&1)
fi

# 🔴 Check the path before rm -rf. DEST_DIR is built from an absolute path by
# every caller, but an empty value here would aim the delete at /node_modules.
if [ -z "$DEST_DIR" ] || [ ! -d "$DEST_DIR" ]; then
  echo "ERROR: DEST_DIR が不正です: '$DEST_DIR'" >&2
  exit 1
fi
# Atomic replacement assumes mktemp and DEST_DIR are on the same filesystem;
# across filesystems mv degrades to copy-and-remove, but the resulting tree is unchanged.
rm -rf "$DEST_DIR/node_modules"
mv "$DEPS_TMP/node_modules" "$DEST_DIR/node_modules"

# 🔴 Verify every declared dependency actually landed, and fail loudly if not.
# The failure this guards against is invisible at build time and only surfaces
# as a runtime crash in the packaged extension, so the check has to be here.
MISSING=""
for DEP in $DEP_NAMES; do
  if [ ! -f "$DEST_DIR/node_modules/$DEP/package.json" ]; then
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
