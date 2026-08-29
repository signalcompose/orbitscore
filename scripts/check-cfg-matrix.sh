#!/usr/bin/env bash
# check-cfg-matrix.sh — Rust の cfg 4象限をすべてビルドする。
#
# 🔴 なぜスクリプトにするか（2026-08-29）
#
# 「4象限を回す」ループを毎回手で書いていて、**同じ日に2回**壊した:
#
#   for F in "" "--features outproc-effect" ...; do cargo build $F; done
#
# zsh は**引用されていない変数を単語分割しない**ので、`--features outproc-effect` が
# 1つの引数として渡り、cargo が拒否する。結果「3象限が落ちている」と報告し、原因を
# 探すのに時間を使った（実際は全象限緑だった）。
#
# 測定手段が壊れていると、緑も赤も意味を持たない。ループを1箇所に閉じ込める。
#
# 使い方:
#   bash scripts/check-cfg-matrix.sh              # build のみ
#   bash scripts/check-cfg-matrix.sh --clippy     # clippy -D warnings も
set -uo pipefail

cd "$(dirname "$0")/../rust" || exit 1

MODE="${1:-build}"
FEATURES=("" "outproc-effect" "outproc-instrument" "outproc-effect,outproc-instrument")
failed=0

for f in "${FEATURES[@]}"; do
  label="${f:-default}"
  if [ "$MODE" = "--clippy" ]; then
    if [ -z "$f" ]; then
      cargo clippy --all-targets -- -D warnings > /dev/null 2>&1
    else
      cargo clippy --all-targets --features "$f" -- -D warnings > /dev/null 2>&1
    fi
  else
    if [ -z "$f" ]; then
      cargo build > /dev/null 2>&1
    else
      cargo build --features "$f" > /dev/null 2>&1
    fi
  fi
  status=$?
  if [ "$status" -eq 0 ]; then
    printf '  ✅ %-36s\n' "$label"
  else
    printf '  🔴 %-36s exit=%s\n' "$label" "$status"
    failed=1
  fi
done

if [ "$failed" -ne 0 ]; then
  echo "cfg matrix FAILED — rerun the red quadrant without the output redirect to see why." >&2
  exit 1
fi
echo "cfg matrix: all quadrants green"
