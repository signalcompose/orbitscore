#!/usr/bin/env bash
#
# copy-daemon-bin.sh
#
# Bundles the native `orbit-audio-daemon` binary into the VS Code extension's
# engine/ directory so a packaged .vsix can resolve it with zero configuration
# (Issue #306). Since cutover #369, rust is the *default* audio backend
# (ORBITSCORE_ENGINE unset == "rust"); SuperCollider is reachable only via
# explicit opt-out (ORBITSCORE_ENGINE=sc or the orbitscore.engine="sc" setting).
#
# Scope (bounded, first version): darwin-arm64 only. Adding another platform
# means building `orbit-audio-daemon` for that target and adding another
# `bin/<platform>/` directory here — the resolveDaemonBinary() candidate in
# packages/engine/src/audio/rust-engine/daemon-client.ts already keys off
# `${process.platform}-${process.arch}` so no TS change is required for that
# part, but this script itself only knows how to place the one binary it was
# just asked to build for the current host.
#
# Best-effort by design: most contributors run `npm run build` without ever
# running `cargo build`, and that must keep working even though rust is now
# the default backend (#369) — those local builds simply won't have the
# daemon resolvable at runtime. If the daemon binary hasn't been built, this
# script warns and exits 0 rather than failing the whole build.
#
# This best-effort skip is safe only because release.yml's post-package gate
# fails loud (aborts the release) if engine/bin/darwin-arm64/orbit-audio-daemon
# is missing from the packaged .vsix — that gate is what actually guarantees
# the *shipped* artifact has the daemon. Packaging paths that don't go through
# release.yml (e.g. a manual `vsce package` after a plain `npm run build`) are
# NOT covered by that gate and can produce a .vsix whose default backend
# (rust) is unable to start.
#
# The release daemon uses OOP-both plugin hosting, so its effect and instrument
# child executables are bundled beside the daemon. The daemon resolves them as
# siblings of its own executable, requiring no additional runtime wiring.
#
# Usage:
#   bash scripts/copy-daemon-bin.sh
#
# Build the release binaries first if you want them bundled:
#   cd rust && cargo build --release -p orbit-audio-daemon --features outproc-effect,outproc-instrument
#   cargo build --release -p orbit-clap-effect-child -p orbit-clap-instrument-child

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

# process.platform-process.arch naming (Node convention), hardcoded to the
# single platform this bounded first version supports.
PLATFORM="darwin-arm64"

DEST_DIR="$PROJECT_ROOT/packages/vscode-extension/engine/bin/$PLATFORM"

mkdir -p "$DEST_DIR"

copy_binary() {
  local binary_name="$1"
  local source_path="$PROJECT_ROOT/rust/target/release/$binary_name"
  local destination_path="$DEST_DIR/$binary_name"

  if [ ! -f "$source_path" ]; then
    echo "⚠️  $binary_name not found at $source_path — skipping bundle." >&2
    return
  fi

  cp "$source_path" "$destination_path"
  chmod +x "$destination_path"
  echo "Bundled $binary_name ($PLATFORM) -> $destination_path"
}

copy_binary "orbit-audio-daemon"
copy_binary "orbit-clap-effect-child"
copy_binary "orbit-clap-instrument-child"
