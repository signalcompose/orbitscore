#!/bin/bash
# PostCompact Hook - Restore context after compaction

cat << 'EOF'
{
  "notification": "🔄 **コンテキスト圧縮完了 - 復元アクション**\n\nコンテキストが圧縮されました。会話履歴が要約され、詳細な文脈が失われています。\n\n**セッションを継続するための必須アクション：**\n\n1. **このファイル（CLAUDE.md）を明示的に読み込む**\n   - Read tool で CLAUDE.md を読み込んでください\n   - 最新のルールと手順を再確認\n\n2. **Serenaプロジェクトを再アクティベート**\n   - serena-activate_project(\"orbitscore\")\n\n3. **必須ドキュメントを読み込む**\n   - docs/PROJECT_RULES.md\n   - docs/CONTEXT7_GUIDE.md\n\n4. **Serenaメモリを確認**\n   - serena-list_memories\n   - 特に `project_overview`, `current_issues` を確認\n   - `.claude/next-session-prompt.md` があれば読み込む\n\n5. **作業文脈の復元**\n   - 現在のブランチを確認: `git branch --show-current`\n   - 未コミットの変更を確認: `git status`\n   - 直近のコミットを確認: `git log -1`\n\n**または、新しいセッションで再開することを推奨します。**\n\nこれらを実行してから作業を継続してください。"
}
EOF

exit 0
