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

# --- deny の出し方（公式契約・確認済み 2026-09-04）------------------------
#
# 🔴 `{"error": "..."}` を stdout に出す形は**スキーマに無い**。
# `exit 2` でブロック自体は効くが、**理由が Claude に届かない**
# （公式: "The blocking message is the reason from your JSON's blocking decision
#  when it makes one, and your stderr text otherwise."）。
# 正しいのは `hookSpecificOutput.permissionDecision` / `permissionDecisionReason`。
# 自動セキュリティレビューの `gate-action-field-mismatch` はこれを指していた。
#
# ⚠️ 同じ形の契約違反が `pre-commit-check.sh` にもある（本 PR のスコープ外・#745 に記録）。
deny() {
  python3 -c "
import json, sys
print(json.dumps({
  'hookSpecificOutput': {
    'hookEventName': 'PreToolUse',
    'permissionDecision': 'deny',
    'permissionDecisionReason': sys.stdin.read(),
  }
}, ensure_ascii=False))
"
  exit 0   # 決定は JSON が運ぶ。exit 2 と混ぜない（公式: どちらか一方に統一する）
}


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

# 🔴 **フラグの位置に依存しない**取り方（背景セキュリティレビュー指摘 1）。
# `gh pr merge --admin --merge 744` のようにフラグが先だと、
# 「`gh pr merge` の直後の数字」を見る素朴な正規表現は**素通りする**（実証済み）。
# `gh pr merge` 以降のトークンを走査し、**最初の裸の整数**を PR 番号として拾う。
pr=$(printf '%s' "$cmd" | python3 -c "
import re, sys
cmd = sys.stdin.read()
m = re.search(r'gh\s+pr\s+merge\b(.*)', cmd, re.S)
if not m:
    sys.exit(0)
for tok in m.group(1).split():
    if tok in ('--', '&&', '||', ';', '|'):
        break
    if tok.startswith('-'):
        continue
    if tok.isdigit():
        print(tok)
        break
" 2>/dev/null)

# 番号省略（カレントブランチの PR）は番号から辿れないので、**ブランチから引く**。
if [ -z "$pr" ]; then
  pr=$(gh pr view --json number --jq .number 2>/dev/null)
fi

# それでも取れなければ **ブロックする**（fail-closed・指摘 2）。
# 「判定できないから通す」は、判定を壊せば必ず通るという意味になる。
if [ -z "$pr" ]; then
  deny <<'EOJ'
🚫 レビューゲート: マージ対象の PR 番号を特定できませんでした（#745）

判定できないため、安全側に倒してブロックしました（fail-closed）。

対処: PR 番号を明示してください。

  gh pr merge <番号> --merge
EOJ
fi

# --- 2. 🔴 レビューの単位は「束」— base で判定する -------------------------
#
# CLAUDE.md「🔴 レビューの単位は「束」」（owner 合意 2026-09-03・#703）:
#
# | 単位 | ゲート |
# |---|---|
# | **小 PR**（base = 束の統合ブランチ・draft） | CI + **その PR が足した E2E だけを実機で** + main が差分を読む。**レビューチーム・Fable・bot は呼ばない** |
# | **束 PR**（統合ブランチ → main） | 1〜8 をすべて + マージ前ゲート（実機 E2E 全件） |
# | **main 直行 PR** | 仕様だけなら軽いレビュー、must-fix は 1〜8 |
#
# つまり **base が main でない PR（= 小 PR）にフル編成を要求してはいけない**。
# 初版はここを見ておらず、**段 2 以降の小 PR を全部止める**ものになっていた
# （owner 指摘 2026-09-04）。
base=$(gh pr view "$pr" --json baseRefName --jq .baseRefName 2>/dev/null)
if [ -z "$base" ]; then
  deny <<EOJ
🚫 レビューゲート: PR #$pr の base を取得できませんでした（#745）

小 PR（統合ブランチ向け）か main 直行かを判定できないため、安全側に倒してブロックしました。

対処: gh pr view $pr --json baseRefName が通ることを確認してください（認証・ネットワーク）。
EOJ
fi

# 小 PR（base ≠ main）は**通す**。束の締めでまとめてレビューするのが規則。
[ "$base" != "main" ] && exit 0

# --- 3. docs のみか code を含むか -------------------------------------------
# 🔴 **取得できなければブロックする**（fail-closed・指摘 2）。
# 旧版は「ネットワーク断で運用を止めない」として通していたが、
# **判定を失敗させれば必ず通る**ゲートは、ゲートとして機能しない。
files=$(gh pr view "$pr" --json files --jq '.files[].path' 2>/dev/null)
if [ -z "$files" ]; then
  deny <<EOJ
🚫 レビューゲート: PR #$pr のファイル一覧を取得できませんでした（#745）

docs / code を判定できないため、安全側に倒してブロックしました（fail-closed）。

対処: gh pr view $pr --json files が通ることを確認してから再実行してください（認証・ネットワーク）。
EOJ
fi

code=$(printf '%s\n' "$files" | grep -vE '^(docs/|sites/|\.github/)' | grep -vE '\.md$' | head -1)
[ -z "$code" ] && exit 0    # docs のみ → 通す（CLAUDE.md: フル編成はオーバーエンジニアリング）

# --- 4. レビュー完了マーカー -------------------------------------------------
if gh pr view "$pr" --json comments --jq '.comments[].body' 2>/dev/null | grep -qF "$MARKER"; then
  exit 0
fi

# --- 5. ブロック -------------------------------------------------------------
deny <<EOJ
🚫 レビューフロー未通過のマージをブロックしました（#745）

PR #$pr は base=main の main 直行 PR で、code を含みます（例: $code）。

main 直行 PR のゲート（CLAUDE.md「PR レビューワークフロー」）:

  1. ブランチ <issue番号>-<英語>
  2. CI が緑
  3. 🔴 /simplify → /code:pr-review-team フル編成 + Fable 監査を並行
  4. 🔴 ビルド + 実機 E2E
  5. マージは owner の指示を待つ

2026-09-04 に 3 と 4 を落として code PR を 2 本 main に入れました。
CI が緑であることはゲート 2 を満たすだけで、3 と 4 の代わりにはなりません。

通す手順: フローを回したうえで、PR にマーカーを貼る:

  gh pr comment $pr --body 'review-gate: passed — simplify / pr-review-team / Fable / 実機 E2E'

docs のみの PR と、小 PR（base ≠ main）は自動で通ります。
EOJ
