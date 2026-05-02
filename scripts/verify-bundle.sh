#!/usr/bin/env bash
#
# verify-bundle.sh
#
# bundled scsynth (extract-scsynth-bundle.sh の出力 or `.vsix` 解凍済み)
# が正しい構造・signature・architecture を保っているか検証する。
#
# Usage:
#   bash scripts/verify-bundle.sh                                     # default: packages/vscode-extension/engine/scsynth
#   bash scripts/verify-bundle.sh /path/to/extracted/extension/engine/scsynth   # arbitrary path (e.g. unzipped .vsix)
#
# 受け入れ基準: docs/research/SCSYNTH_BUNDLE_MANIFEST.md § Cold-install verification checklist

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
TARGET="${1:-$REPO_ROOT/packages/vscode-extension/engine/scsynth}"

echo "🔍 Verifying scsynth bundle at: $TARGET"
echo "─────────────────────────────────────────────"

errors=0
fail() {
  echo "  ❌ $1" >&2
  errors=$((errors + 1))
}
ok() {
  echo "  ✅ $1"
}

# 1. Layout
if [ ! -d "$TARGET" ]; then
  fail "bundle directory does not exist: $TARGET"
  exit 1
fi
[ -f "$TARGET/Contents/Resources/scsynth" ] && ok "scsynth binary exists" || fail "scsynth binary missing"
[ -d "$TARGET/Contents/Resources/plugins" ] && ok "plugins directory exists" || fail "plugins directory missing"
[ -f "$TARGET/Contents/Frameworks/libsndfile.dylib" ] && ok "libsndfile.dylib exists" || fail "libsndfile.dylib missing"

# 2. Plugin count (non-supernova)
plugin_count=$(find "$TARGET/Contents/Resources/plugins" -name '*.scx' ! -name '*_supernova.scx' 2>/dev/null | wc -l | tr -d ' ')
if [ "$plugin_count" -eq 26 ]; then
  ok "26 non-supernova plugins"
elif [ "$plugin_count" -gt 0 ]; then
  fail "expected 26 plugins, got $plugin_count (SC version may differ — verify against SCSYNTH_BUNDLE_MANIFEST.md)"
else
  fail "no plugins found"
fi

supernova_count=$(find "$TARGET/Contents/Resources/plugins" -name '*_supernova.scx' 2>/dev/null | wc -l | tr -d ' ')
if [ "$supernova_count" -gt 0 ]; then
  fail "$supernova_count supernova-variant plugins should not be bundled"
fi

# 3. Executable bit
if [ -x "$TARGET/Contents/Resources/scsynth" ]; then
  ok "scsynth has execute permission"
else
  fail "scsynth lacks execute permission (mode: $(stat -f '%Mp%Lp' "$TARGET/Contents/Resources/scsynth" 2>/dev/null || echo 'unknown'))"
fi

# 4. Architecture (universal arm64 + x86_64)
if [ -f "$TARGET/Contents/Resources/scsynth" ]; then
  file_out=$(file "$TARGET/Contents/Resources/scsynth")
  if echo "$file_out" | grep -qE "universal|arm64.*x86_64"; then
    ok "scsynth is universal binary"
  else
    fail "scsynth is not universal binary: $file_out"
  fi
fi

# 5. Codesign verification
if [ -f "$TARGET/Contents/Resources/scsynth" ]; then
  if codesign --verify --verbose "$TARGET/Contents/Resources/scsynth" >/dev/null 2>&1; then
    ok "scsynth signature valid (codesign --verify)"
  else
    fail "scsynth signature verification failed"
  fi

  team_id=$(codesign -dv "$TARGET/Contents/Resources/scsynth" 2>&1 | grep TeamIdentifier | awk -F= '{print $2}' | tr -d '[:space:]' || true)
  if [ "$team_id" = "HE5VJFE9E4" ]; then
    ok "scsynth TeamIdentifier matches SC project (HE5VJFE9E4)"
  else
    fail "TeamIdentifier mismatch: got '$team_id', expected 'HE5VJFE9E4'"
  fi
fi

# 6. libsndfile signature
if [ -f "$TARGET/Contents/Frameworks/libsndfile.dylib" ]; then
  if codesign --verify --verbose "$TARGET/Contents/Frameworks/libsndfile.dylib" >/dev/null 2>&1; then
    ok "libsndfile.dylib signature valid"
  else
    fail "libsndfile.dylib signature verification failed"
  fi
fi

# 7. LICENSE / NOTICE
[ -f "$TARGET/LICENSE.GPL-3.0" ] && ok "LICENSE.GPL-3.0 present" || fail "LICENSE.GPL-3.0 missing (required for GPL §6)"
[ -f "$TARGET/NOTICE" ] && ok "NOTICE present" || fail "NOTICE missing (required for GPL aggregation disclosure)"

echo "─────────────────────────────────────────────"
if [ "$errors" -eq 0 ]; then
  echo "✅ All bundle verification checks passed"
  exit 0
else
  echo "❌ $errors check(s) failed"
  exit 1
fi
