#!/bin/bash
# PreMerge Hook — code を含む PR を**レビューフロー未通過のままマージさせない**（#745）。
#
# ## なぜ要るか（2026-09-04 に実際にやった）
#
# main 直行 PR のゲートは 5 段階（CLAUDE.md「PR レビューワークフロー」）:
#
#   1. `<issue番号>-<英語>` でブランチを切る
#   2. CI が緑
#   3. **`/simplify` → `/code:pr-review-team` フル編成 + Fable 監査を並行**
#   4. **ビルド + 実機 E2E**
#   5. マージは owner の指示を待つ
#
# ところが実際には、**CI が緑ならマージしてよい**と扱い、**ゲート 3 と 4 を頭から
# 落として** code PR を 2 本 main に入れた（#737 は `sequence.ts` /
# `event-scheduler.ts` を触る変更で、レビューを一切通していない）。
#
# 🔴 **同じ指摘を同じセッションの冒頭でも受けている。口頭の注意では再発した。**
#
# ## 何をするか
#
# `gh pr merge <n>` の前に:
#   1. PR 番号を取る
#   2. `gh pr view --json files` で **docs のみか code を含むか**を判定
#   3. code を含むなら、PR に**レビュー完了マーカー**のコメントがあるか確認
#   4. 無ければ **ブロック**（exit 2）してチェックリストを出す
#
# 🔴 **これは weak-form にしない。ブロックする。**
# push の検証（#742）は「済んだことを見えるようにする」ので警告で足りたが、
# **マージは戻せない**うえ、**無審査のコードが main に入る**実害が既に出ている。
#
# **マーカーの限界**: hook は「フローが本当に走ったか」までは検証できない。
# だが**黙って飛ばせなくなる**ことに意味がある（マーカーを貼る = 意図的な宣言になる）。

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null)}"
cd "$PROJECT_DIR" 2>/dev/null || exit 0

MARKER="review-gate: passed"

# --- 1. PR 番号を取る -------------------------------------------------------
# hook にはツール入力が stdin の JSON で来る。取れなければ何もしない（誤ブロックを避ける）。
payload=$(cat 2>/dev/null)
cmd=$(printf '%s' "$payload" | python3 -c "
import json,sys
try:
    d=json.load(sys.stdin)
except Exception:
    sys.exit(0)
ti=d.get('tool_input') or {}
print(ti.get('command') or '')
" 2>/dev/null)

[ -z "$cmd" ] && exit 0

pr=$(printf '%s' "$cmd" | sed -n 's/.*gh pr merge[[:space:]]\{1,\}\([0-9]\{1,\}\).*/\1/p')
# 番号省略（カレントブランチの PR）は判定できないので通す — 誤ブロックより取りこぼしを選ぶ。
# 🔴 番号を明示する運用にすればこの穴は閉じる。
[ -z "$pr" ] && exit 0

# --- 2. docs のみか code を含むか -------------------------------------------
files=$(gh pr view "$pr" --json files --jq '.files[].path' 2>/dev/null)
[ -z "$files" ] && exit 0   # 取得できなければ通す（ネットワーク断で運用を止めない）

code=$(printf '%s\n' "$files" | grep -vE '^(docs/|sites/|\.github/)' | grep -vE '\.md$' | head -1)
[ -z "$code" ] && exit 0    # docs のみ → 通す（CLAUDE.md: フル編成はオーバーエンジニアリング）

# --- 3. レビュー完了マーカー -------------------------------------------------
if gh pr view "$pr" --json comments --jq '.comments[].body' 2>/dev/null | grep -qF "$MARKER"; then
  exit 0
fi

# --- 4. ブロック -------------------------------------------------------------
cat <<EOF
{
  "error": "🚫 **レビューフロー未通過のマージをブロックしました（#745）**\n\nPR #$pr は **code を含みます**（例: \`$code\`）。\n\nmain 直行 PR のゲート（CLAUDE.md「PR レビューワークフロー」）:\n\n1. ✅ ブランチ \`<issue番号>-<英語>\`\n2. CI が緑\n3. 🔴 **\`/simplify\` → \`/code:pr-review-team\` フル編成 + Fable 監査を並行**\n4. 🔴 **ビルド + 実機 E2E**（\`npm run build\` → 標準プラグイン実機確認 2 行 → gated）\n5. マージは owner の指示を待つ\n\n**2026-09-04 に 3 と 4 を落として code PR を 2 本 main に入れました。**\nCI が緑であることはゲート 2 を満たすだけで、3 と 4 の代わりにはなりません。\n\n**通す手順**: フローを回したうえで、PR にマーカーを貼る:\n\n  gh pr comment $pr --body 'review-gate: passed — simplify / pr-review-team / Fable / 実機 E2E'\n\n**docs のみの PR は自動で通ります**（フル編成はオーバーエンジニアリング）。"
}
EOF
exit 2
