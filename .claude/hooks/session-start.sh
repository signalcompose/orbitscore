#!/bin/bash
# SessionStart Hook - Display critical rules and reminders

cat << 'EOF'
{
  "notification": "📋 **セッション開始時の必須アクション**\n\n1. **Serenaプロジェクトをアクティベート**\n   - serena-activate_project(\"orbitscore\")\n\n2. **必須ドキュメントを読み込む**\n   - docs/PROJECT_RULES.md\n   - docs/CONTEXT7_GUIDE.md\n\n3. **Serenaメモリを確認**\n   - serena-list_memories\n   - 特に `project_overview`, `current_issues` を確認\n\n4. **Git Workflow reminder**\n   - Issue作成 → ブランチ作成（Issue番号含む） → 実装 → PR作成（Closes #N）\n   - ブランチ名: `<issue-number>-<descriptive-name>` （英語のみ）\n\nこれらを確認してから作業を開始してください。"
}
EOF

exit 0
