#!/bin/bash
# SessionStart Hook - Display critical rules and reminders

# Get project root and current branch
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null)}"
if [ -n "$PROJECT_DIR" ]; then
  cd "$PROJECT_DIR" || exit 1
  CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null)
else
  CURRENT_BRANCH=""
fi

# Base notification
NOTIFICATION="📋 **セッション開始時の必須アクション**\n\n1. **Serenaプロジェクトをアクティベート**\n   - serena-activate_project(\"orbitscore\")\n\n2. **必須ドキュメントを読み込む**\n   - docs/PROJECT_RULES.md\n   - docs/CONTEXT7_GUIDE.md\n\n3. **Serenaメモリを確認**\n   - serena-list_memories\n   - 特に \`project_overview\`, \`current_issues\` を確認\n\n4. **Git Workflow reminder**\n   - Issue作成 → ブランチ作成（Issue番号含む） → 実装 → PR作成（Closes #N）\n   - ブランチ名: \`<issue-number>-<descriptive-name>\` （英語のみ）"

# Add develop branch reminder if on develop
if [[ "$CURRENT_BRANCH" == "develop" ]]; then
  NOTIFICATION="$NOTIFICATION\n\n⚠️ **現在 \`develop\` ブランチにいます**\n\n**Serenaメモリ更新のルール:**\n- ✅ メモリ変更（編集・保存）はOK\n- ❌ メモリのコミットはNG\n- 変更はunstagedのまま機能ブランチに持ち越す\n- 機能ブランチで機能と一緒にコミット\n\n作業を始める前に機能ブランチを作成してください。"
fi

NOTIFICATION="$NOTIFICATION\n\nこれらを確認してから作業を開始してください。"

# Output notification
cat << EOF
{
  "notification": "$NOTIFICATION"
}
EOF

exit 0
