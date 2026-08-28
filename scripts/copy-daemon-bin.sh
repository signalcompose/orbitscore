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
# the default backend (#369). #487 以降、cargo が使える環境では bundle 前に再ビルド
# を試みるが、**ビルド失敗時も警告して既存バイナリへ縮退する**（exit 0 を維持）。
# daemon バイナリが無い場合も従来どおり警告して exit 0。
#
# This best-effort skip is safe only because release.yml's post-package gate
# fails loud (aborts the release) if engine/bin/darwin-arm64/orbit-audio-daemon
# or either OOP child binary is missing from the packaged .vsix — that gate is
# what actually guarantees the *shipped* artifact has its daemon and children.
# Packaging paths that don't go through release.yml (e.g. a manual `vsce package`
# after a plain `npm run build`) are NOT covered by that gate and can produce a
# .vsix whose default backend (rust) is unable to start.
#
# The release daemon uses OOP-both plugin hosting, so its effect and instrument
# child executables are bundled beside the daemon. The daemon resolves them as
# siblings of its own executable, requiring no additional runtime wiring.
#
# #628 以降、**標準プラグイン**（spec SC.10.8）も同じディレクトリの `std-plugins/` へ
# 同梱する。child は自分の実行ファイルの隣の `std-plugins/<name>.clap` を見て解決するため、
# ここに置くだけで配線は不要（インストールレイアウトの知識を daemon / TS に持たせない）。
# **OS のプラグインディレクトリには何も置かない** — 標準プラグインはアプリの一部であり、
# ユーザーのカタログを汚さない。
#
# Usage:
#   bash scripts/copy-daemon-bin.sh
#
# #487 以降、cargo が使える環境ではこのスクリプト自身が bundle 前に release を再ビルド
# する（stale child バイナリの黙殺コピー = #479 の真因の再発防止）。

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

  # #540: 既存ファイルへの in-place 上書き（cp は同一 inode に書く）は、macOS の kernel
  # code-signing キャッシュを invalid にし、以後の exec が SIGKILL で即死する
  # （署名自体は `codesign --verify` で valid のまま = 診断が非常に紛らわしい）。
  # 必ず unlink してから新しい inode としてコピーする。
  rm -f "$destination_path"
  cp "$source_path" "$destination_path"
  chmod +x "$destination_path"
  echo "Bundled $binary_name ($PLATFORM) -> $destination_path"
}

# 標準プラグインは単一バイナリではなく **.clap bundle ディレクトリ**なので、copy_binary とは
# 別扱いにする。#540 の code-signing キャッシュ問題は bundle 内の実行ファイルにも同じく効くため、
# in-place 上書きを避けて毎回まるごと作り直す。
copy_std_plugin_bundle() {
  local bundle_name="$1"
  local source_path="$PROJECT_ROOT/rust/target/release/std-plugins/$bundle_name"
  local destination_path="$DEST_DIR/std-plugins/$bundle_name"

  if [ ! -d "$source_path" ]; then
    echo "⚠️  $bundle_name not found at $source_path — skipping bundle." >&2
    return
  fi

  mkdir -p "$DEST_DIR/std-plugins"
  rm -rf "$destination_path"
  cp -R "$source_path" "$destination_path"
  echo "Bundled $bundle_name ($PLATFORM) -> $destination_path"
}

# #487: stale child バイナリの黙殺コピー防止（#479 の真因）。cargo が使える環境では
# bundle 前に daemon + 全 child を必ず再ビルドする（incremental なので通常は数秒）。
# cargo 不在の contributor は従来どおり best-effort（存在するものをコピー・警告付き）。
if command -v cargo >/dev/null 2>&1; then
  echo "Rebuilding daemon + child binaries (release) before bundling..."
  # best-effort 契約の維持: cargo はあるがツールチェーン不足等でビルドできない環境
  # （TS 専業 contributor 等）でも npm run build を落とさず、既存バイナリへ縮退する。
  if ! (cd "$PROJECT_ROOT/rust" \
    && cargo build --release -p orbit-audio-daemon --features outproc-effect,outproc-instrument \
    && cargo build --release -p orbit-effect-rack-child \
    && cargo build --release -p orbit-clap-effect-child -p orbit-clap-instrument-child \
      -p orbit-vst3-effect-child -p orbit-vst3-instrument-child \
    && cargo build --release -p orbit-plugin-scan \
    && bash "$PROJECT_ROOT/rust/crates/orbit-std-gain/bundle-macos.sh" --release >/dev/null); then
    echo "⚠️  release rebuild failed — bundling whatever exists in rust/target/release (may be stale)." >&2
  fi
else
  echo "⚠️  cargo not found — bundling whatever exists in rust/target/release (may be stale)." >&2
fi

copy_binary "orbit-audio-daemon"
# #628: rack effect child。daemon は `outproc_effect.rs` で自分の隣の
# `orbit-effect-rack-child` を探す。**これが無いと effect 宣言そのものが起動に失敗する。**
copy_binary "orbit-effect-rack-child"
copy_binary "orbit-clap-effect-child"
copy_binary "orbit-clap-instrument-child"
copy_binary "orbit-vst3-effect-child"
copy_binary "orbit-vst3-instrument-child"
copy_binary "orbit-plugin-scan"

# 標準プラグイン（SC.10.8）。`Gain` が初号で、以後ここへ足していく。
copy_std_plugin_bundle "Gain.clap"
