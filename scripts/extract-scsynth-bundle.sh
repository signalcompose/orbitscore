#!/usr/bin/env bash
#
# extract-scsynth-bundle.sh
#
# SuperCollider.app から scsynth バイナリ + plugins (non-supernova 26 個) +
# libsndfile.dylib を抽出し、`packages/vscode-extension/engine/scsynth/` の
# bundle 構造に配置する。
#
# 仕様: docs/research/SCSYNTH_BUNDLE_MANIFEST.md
#
# Usage:
#   bash scripts/extract-scsynth-bundle.sh           # default: fail-fast (CI/release 用)
#   bash scripts/extract-scsynth-bundle.sh --allow-skip   # SC.app 不在で warning + exit 0 (dev 用)
#
# Exit codes:
#   0 - 成功 (または --allow-skip で SC.app 不在)
#   1 - 一般エラー
#   2 - SC.app 不在 (--allow-skip なし)

set -euo pipefail

# ============================================================
# CLI args
# ============================================================
ALLOW_SKIP=0
for arg in "$@"; do
  case "$arg" in
    --allow-skip)
      ALLOW_SKIP=1
      ;;
    -h|--help)
      sed -n '3,20p' "$0"
      exit 0
      ;;
    *)
      echo "Unknown argument: $arg" >&2
      exit 1
      ;;
  esac
done

# ============================================================
# Paths
# ============================================================
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DEST="$REPO_ROOT/packages/vscode-extension/engine/scsynth/Contents"
LEGAL_SRC="$REPO_ROOT/packages/vscode-extension/legal"

# ============================================================
# SC.app discovery
# ============================================================
SC_APP=""
for candidate in \
  "/Applications/SuperCollider.app" \
  "/Applications/SuperCollider/SuperCollider.app"; do
  if [ -d "$candidate" ]; then
    SC_APP="$candidate"
    break
  fi
done

if [ -z "$SC_APP" ] && command -v mdfind >/dev/null 2>&1; then
  found=$(mdfind -name SuperCollider.app 2>/dev/null | head -1 || true)
  if [ -n "$found" ] && [ -d "$found" ]; then
    SC_APP="$found"
  fi
fi

if [ -z "$SC_APP" ]; then
  msg="SuperCollider.app not found. Install via 'brew install --cask supercollider' or download from https://supercollider.github.io/"
  if [ "$ALLOW_SKIP" -eq 1 ]; then
    echo "⚠️  Skipping bundle extract: $msg" >&2
    exit 0
  fi
  echo "ERROR: $msg" >&2
  exit 2
fi

SC_ROOT="$SC_APP/Contents"
SCSYNTH_SRC="$SC_ROOT/Resources/scsynth"
PLUGINS_SRC="$SC_ROOT/Resources/plugins"
LIBSNDFILE_SRC="$SC_ROOT/Frameworks/libsndfile.dylib"

# ============================================================
# Pre-flight checks
# ============================================================
if [ ! -f "$SCSYNTH_SRC" ]; then
  echo "ERROR: scsynth binary not found at: $SCSYNTH_SRC" >&2
  exit 1
fi
if [ ! -d "$PLUGINS_SRC" ]; then
  echo "ERROR: plugins directory not found at: $PLUGINS_SRC" >&2
  exit 1
fi
if [ ! -f "$LIBSNDFILE_SRC" ]; then
  echo "ERROR: libsndfile.dylib not found at: $LIBSNDFILE_SRC" >&2
  exit 1
fi

echo "📦 Extracting scsynth bundle from: $SC_APP"

# ============================================================
# Build dest layout
# ============================================================
# 既存 bundle を完全に消してから再構築 (stale plugin 残留防止)
rm -rf "$DEST"
mkdir -p "$DEST/Resources/plugins" "$DEST/Frameworks"

# scsynth 本体
cp "$SCSYNTH_SRC" "$DEST/Resources/scsynth"
chmod +x "$DEST/Resources/scsynth"

# plugins (non-supernova のみ、_supernova suffix を除外)
plugin_count=0
for f in "$PLUGINS_SRC"/*.scx; do
  basename=$(basename "$f")
  if [[ "$basename" != *_supernova.scx ]]; then
    cp "$f" "$DEST/Resources/plugins/$basename"
    plugin_count=$((plugin_count + 1))
  fi
done

# libsndfile dylib
cp "$LIBSNDFILE_SRC" "$DEST/Frameworks/libsndfile.dylib"

# LICENSE / NOTICE (legal/ から copy、bundle 配下に配置)
if [ -f "$LEGAL_SRC/scsynth-LICENSE.GPL-3.0" ]; then
  cp "$LEGAL_SRC/scsynth-LICENSE.GPL-3.0" "$DEST/../LICENSE.GPL-3.0"
fi
if [ -f "$LEGAL_SRC/scsynth-NOTICE" ]; then
  cp "$LEGAL_SRC/scsynth-NOTICE" "$DEST/../NOTICE"
fi

# ============================================================
# Verification
# ============================================================
echo "─────────────────────────────────────────────"
echo "Bundle size: $(du -sh "$DEST" | cut -f1)"
echo "Plugin count: $plugin_count (expected: 26 for SC 3.14.x)"

if [ "$plugin_count" -ne 26 ]; then
  echo "WARN: expected 26 non-supernova plugins, got $plugin_count" >&2
  echo "  SC version may have added/removed plugins. Verify against SCSYNTH_BUNDLE_MANIFEST.md" >&2
fi

echo "Architecture check:"
file_out=$(file "$DEST/Resources/scsynth")
echo "  $file_out"
if ! echo "$file_out" | grep -qE "universal|arm64.*x86_64"; then
  echo "ERROR: scsynth is not a universal binary" >&2
  exit 1
fi

echo "Codesign check:"
if codesign --verify --verbose "$DEST/Resources/scsynth" 2>&1 | tail -3; then
  echo "  ✅ scsynth signature valid"
else
  echo "ERROR: scsynth signature verification failed" >&2
  exit 1
fi

team_id=$(codesign -dv "$DEST/Resources/scsynth" 2>&1 | grep TeamIdentifier | awk -F= '{print $2}' | tr -d '[:space:]')
if [ "$team_id" != "HE5VJFE9E4" ]; then
  echo "WARN: scsynth TeamIdentifier is '$team_id' (expected 'HE5VJFE9E4' for SC project signature)" >&2
fi

echo "─────────────────────────────────────────────"
echo "✅ Bundle prepared at: $DEST"
