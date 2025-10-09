#!/bin/bash
# PreCompact Hook - Save important information before context compaction

cat << 'EOF'
{
  "notification": "⚠️ **コンテキスト圧縮前の必須アクション**\n\n**重要な情報を保存してください：**\n\n1. **現在の作業状況をSerenaメモリに保存**\n   - serena-write_memory で現在の作業内容を記録\n   - 特に：設計決定、実装中の課題、次のステップ\n\n2. **引き継ぎメモの作成**\n   - `.claude/next-session-prompt.md` を更新\n   - 次のセッションで必要な情報を記録\n\n3. **未コミットの変更を確認**\n   - `git status` で未コミットの変更を確認\n   - 必要に応じてコミットまたはstash\n\n4. **重要な決定事項の記録**\n   - アーキテクチャの変更\n   - ライブラリ選定の理由\n   - 実装アプローチの決定\n\n**次のセッションで自動的にリマインドされます：**\n- SessionStart Hookが必須アクションを表示\n- CLAUDE.mdを明示的に読み込む\n- Serenaプロジェクトをアクティベート\n\nこれにより、summarize後でもプロジェクトの記憶を完全に復元できます。"
}
EOF

exit 0
