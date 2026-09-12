#!/bin/bash
# PreEdit Hook - Check branch before editing files
#
# Claude Code PreToolUse hook protocol:
# - Block: exit 0 with stdout JSON
#   {"hookSpecificOutput":{"hookEventName":"PreToolUse",
#    "permissionDecision":"deny","permissionDecisionReason":"..."}}
# - Legacy shell style: exit 2 + reason on stderr (not stdout)
# Ref: https://code.claude.com/docs/en/hooks-guide

# Get project root and current branch
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null)}"
if [ -n "$PROJECT_DIR" ]; then
  cd "$PROJECT_DIR" || exit 1
  CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null)
else
  CURRENT_BRANCH=""
fi

# Read tool_input.file_path from stdin (Claude Code PreToolUse hook protocol).
# Plan-mode の plan file (.claude/plans/) は Phase 4 で書込必須なので protected branch でも許可。
TARGET_FILE=""
if ! [ -t 0 ]; then
  INPUT_JSON=$(cat 2>/dev/null || true)
  if [ -n "$INPUT_JSON" ]; then
    if command -v jq >/dev/null 2>&1; then
      TARGET_FILE=$(printf '%s' "$INPUT_JSON" | jq -r '.tool_input.file_path // ""' 2>/dev/null || true)
    elif command -v python3 >/dev/null 2>&1; then
      TARGET_FILE=$(printf '%s' "$INPUT_JSON" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("tool_input",{}).get("file_path",""))' 2>/dev/null || true)
    fi
  fi
fi

case "$TARGET_FILE" in
  */.claude/plans/*)
    exit 0
    ;;
esac

# 🔴 リポジトリ外の絶対パスはこのフックの対象外（#913）。
#
# このフックが守っているのは「main に直接**実装**を積まない」ことである。
# repo の外にあるファイルはブランチと無関係なので、そもそも保護対象ではない:
#   ~/.claude/projects/<project>/memory/       セッション横断の memory
#   /private/tmp/claude-<uid>/.../scratchpad/  一時ファイル
#   ~/.cvi                                     additional working directory
#
# これを塞いでいなかったため、**memory を 1 ファイル書くためだけに差分 0 の
# ブランチを作って消す**という運用が発生した（2026-09-13 実測）。
#
# 🔴 個別のホワイトリストを増やす形にはしない。次に別の外部パスで同じことが起きる。
# 判定は「repo 配下かどうか」の 1 本にする。
#
# 安全側の倒し方:
#   - 相対パスは cwd = repo 相対なので **repo 内**として扱う（従来どおり deny 対象）
#   - `..` を含む絶対パスは解決せず **repo 内**として扱う（fail closed）
if [ -n "$PROJECT_DIR" ] && [ -n "$TARGET_FILE" ]; then
  case "$TARGET_FILE" in
    /*)
      case "$TARGET_FILE" in
        *..*) ;;
        "$PROJECT_DIR"/*) ;;
        *) exit 0 ;;
      esac
      ;;
  esac
fi

# Block edits on main branch (JSON-style deny so the reason reaches the user)
if [[ "$CURRENT_BRANCH" == "main" ]]; then
  REASON=$(cat <<'MSG'
🚫 実装ブロック: mainブランチでの編集禁止

ワークフロー違反: mainブランチで直接実装を開始しようとしています。

正しい手順:
1. Issue作成: gh issue create --title "..."
2. ブランチ作成: git checkout -b <issue-number>-description
3. 実装開始

理由: ブランチ管理の崩壊防止 / Issue 追跡の確実化 / PR-Issue 紐付け保証
詳細: CLAUDE.md「実装前の必須ワークフロー」
MSG
)
  # jq で安全に JSON エスケープ (fallback: python3)
  if command -v jq >/dev/null 2>&1; then
    REASON_JSON=$(printf '%s' "$REASON" | jq -Rs .)
  else
    REASON_JSON=$(printf '%s' "$REASON" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')
  fi
  printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":%s}}\n' "$REASON_JSON"
  exit 0
fi

# Warn (don't block) when branch name lacks an issue number prefix
if [[ "$CURRENT_BRANCH" != "" ]] && ! [[ "$CURRENT_BRANCH" =~ ^[0-9]+-.*$ ]]; then
  # ブランチ名に " や \ 等が含まれた場合でも malformed JSON を出さないよう
  # deny 分岐と同じ escape パスを通す
  MSG=$(printf '⚠️ ブランチ命名規則の警告\n\n現在のブランチ: `%s`\n\nブランチ名にIssue番号が含まれていません。\n\n推奨形式: <issue-number>-<descriptive-name>\n例: 55-improve-type-safety-process-statement\n\n作業を続ける前に、正しいブランチ名で作り直すことを推奨します。' "$CURRENT_BRANCH")
  if command -v jq >/dev/null 2>&1; then
    MSG_JSON=$(printf '%s' "$MSG" | jq -Rs .)
  else
    MSG_JSON=$(printf '%s' "$MSG" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')
  fi
  printf '{"notification":%s}\n' "$MSG_JSON"
  exit 0
fi

# All checks passed
exit 0
