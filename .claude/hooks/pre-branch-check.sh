#!/bin/bash
# PreBranch Hook - Remind about branch naming convention

cat << 'EOF'
{
  "notification": "⚠️ **ブランチ作成時のリマインダー**\n\n**ブランチ命名規則**:\n- 形式: `<issue-number>-<descriptive-name>`\n- 英語のみ使用（日本語禁止）\n\n**例**:\n- ✅ Good: `39-reserved-keywords-implementation`\n- ✅ Good: `42-fix-audio-timing-bug`\n- ❌ Bad: `feature/reserved-keywords` (Issue番号なし)\n- ❌ Bad: `39-予約語実装` (日本語使用)\n\n**手順**:\n1. `gh issue create` でIssue作成\n2. Issue番号を確認\n3. `git checkout -b <issue-number>-<description>`\n\nCLAUDE.md「Git Workflow」セクションを参照してください。"
}
EOF

exit 0  # Warning only, no blocking
