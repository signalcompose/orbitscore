#!/bin/bash
# PreCommit Hook - Check required updates before commit

# Get project root
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel)}"
cd "$PROJECT_DIR" || exit 1

# Get current branch
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)

# Check if on develop/main and trying to commit Serena memory files
if [[ "$CURRENT_BRANCH" == "develop" ]] || [[ "$CURRENT_BRANCH" == "main" ]]; then
  if git diff --cached --name-only | grep -q "^\.serena/memories/"; then
    cat << 'EOF'
{
  "error": "🚫 **Serenaメモリのコミットブロック**\n\n`develop`/`main`ブランチでは`.serena/memories/`の変更をコミットできません。\n\n**理由**: メモリ更新だけのPRを防ぐため\n\n**対処方法**:\n1. Serenaメモリの変更をunstageする:\n   `git restore --staged .serena/memories/`\n\n2. 機能ブランチを作成:\n   `git checkout -b <issue-number>-<description>`\n\n3. 機能実装と一緒にメモリをコミット\n\n**ルール**:\n- ✅ developでメモリ変更はOK（編集・保存可能）\n- ❌ developでメモリコミットはNG\n- ✅ 変更はunstagedのまま次のブランチに持ち越す\n- ✅ 機能ブランチで機能と一緒にコミット\n\n詳細: PROJECT_RULES.md「Serena Memory Management」"
}
EOF
    exit 2  # Block commit
  fi
fi

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
