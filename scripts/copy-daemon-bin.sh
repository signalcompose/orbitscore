#!/usr/bin/env bash
#
# copy-daemon-bin.sh
#
# Bundles the native `orbit-audio-daemon` binary into the VS Code extension's
# engine/ directory so a packaged .vsix can resolve it with zero configuration
# (Issue #306). This is opt-in infrastructure only: the extension still ships
# with SuperCollider as the default audio backend (ORBITSCORE_ENGINE unset ==
# "sc"); the rust engine is only reachable via explicit opt-in
# (ORBITSCORE_ENGINE=rust or the orbitscore.engine="rust" setting).
#
# Scope (bounded, first version): darwin-arm64 only. Adding another platform
# means building `orbit-audio-daemon` for that target and adding another
# `bin/<platform>/` directory here — the resolveDaemonBinary() candidate in
# packages/engine/src/audio/rust-engine/daemon-client.ts already keys off
# `${process.platform}-${process.arch}` so no TS change is required for that
# part, but this script itself only knows how to place the one binary it was
# just asked to build for the current host.
#
# Best-effort by design: most contributors / CI (see .github/workflows/release.yml)
# run `npm run build` without ever running `cargo build`, and that must keep
# working with the SC-only default. If the daemon binary hasn't been built,
# this script warns and exits 0 rather than failing the whole build.
#
# Usage:
#   bash scripts/copy-daemon-bin.sh
#
# Build the daemon first if you want it bundled:
#   cd rust && cargo build --release -p orbit-audio-daemon

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

# process.platform-process.arch naming (Node convention), hardcoded to the
# single platform this bounded first version supports.
PLATFORM="darwin-arm64"

DAEMON_SRC="$PROJECT_ROOT/rust/target/release/orbit-audio-daemon"
DEST_DIR="$PROJECT_ROOT/packages/vscode-extension/engine/bin/$PLATFORM"

if [ ! -f "$DAEMON_SRC" ]; then
  echo "⚠️  orbit-audio-daemon not found at $DAEMON_SRC — skipping bundle." >&2
  echo "    The rust engine (ORBITSCORE_ENGINE=rust, opt-in) will not be available" >&2
  echo "    from this build. SuperCollider (default) is unaffected. To bundle it:" >&2
  echo "      cd rust && cargo build --release -p orbit-audio-daemon" >&2
  exit 0
fi

mkdir -p "$DEST_DIR"
cp "$DAEMON_SRC" "$DEST_DIR/orbit-audio-daemon"
chmod +x "$DEST_DIR/orbit-audio-daemon"

echo "Bundled orbit-audio-daemon ($PLATFORM) -> $DEST_DIR/orbit-audio-daemon"
