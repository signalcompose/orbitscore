#!/bin/bash
# PreEdit Hook - Check branch before editing files

# Get project root and current branch
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null)}"
if [ -n "$PROJECT_DIR" ]; then
  cd "$PROJECT_DIR" || exit 1
  CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null)
else
  CURRENT_BRANCH=""
fi

# Check if on main branch
if [[ "$CURRENT_BRANCH" == "main" ]]; then
  cat << 'EOF'
{
  "error": "🚫 **実装ブロック: mainブランチでの編集禁止**\n\n現在のブランチ: `main`\n\n**ワークフロー違反**: mainブランチで直接実装を開始しようとしています。\n\n**正しい手順**:\n1. Issue作成: `gh issue create --title \"...\"`\n2. ブランチ作成: `git checkout -b <issue-number>-description`\n3. 実装開始\n\n**理由**:\n- ブランチ管理の崩壊を防ぐ\n- Issue追跡を確実にする\n- PRとIssueの紐付けを保証する\n\n詳細: CLAUDE.md「実装前の必須ワークフロー」"
}
EOF
  exit 2  # Block edit
fi

# Check if branch name contains issue number (format: <number>-<description>)
if [[ "$CURRENT_BRANCH" != "" ]] && ! [[ "$CURRENT_BRANCH" =~ ^[0-9]+-.*$ ]]; then
  cat << 'EOF'
{
  "notification": "⚠️ **ブランチ命名規則の警告**\n\n現在のブランチ: `${CURRENT_BRANCH}`\n\nブランチ名にIssue番号が含まれていません。\n\n**推奨形式**: `<issue-number>-<descriptive-name>`\n\n例: `55-improve-type-safety-process-statement`\n\n作業を続ける前に、正しいブランチ名で作り直すことを推奨します。"
}
EOF
  # Warning only, don't block
  exit 0
fi

# All checks passed
exit 0
