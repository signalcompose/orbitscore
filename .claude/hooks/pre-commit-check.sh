#!/bin/bash
# PreCommit Hook - Check required updates before commit

# Get project root
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel)}"
cd "$PROJECT_DIR" || exit 1

# Check if WORK_LOG.md is staged
if ! git diff --cached --name-only | grep -q "docs/WORK_LOG.md"; then
  cat << 'EOF'
{
  "notification": "⚠️ **コミット前チェック**\n\nWORK_LOG.mdが更新されていません。\n\n以下を確認してください：\n- docs/WORK_LOG.mdに今回の変更を記録しましたか？\n- 何を変更し、なぜ変更したかを記録しましたか？\n\nPROJECT_RULESでは、すべてのコミットでWORK_LOG.mdの更新が必須です。"
}
EOF
  # Warning only, don't block
  exit 0
fi

# All checks passed
exit 0
