# Session Start Hook - 文脈回復の自動化

## ⚠️ 重要性

Compacting conversation後は、重要な約束事（プロジェクトルール、現在のIssue、Git状態）が**完全に失われます**。このhookは、それらを**自動的に復元**するために必須です。

**このhookが動作しないと、約束事を忘れたまま実装が進められてしまいます。**

## 実行タイミング

- `compact`: Compacting conversation後（**最重要**）
- `resume`: セッション再開時（`--resume`, `/resume`）

## 目的

Compacting conversation後や新しいセッション開始時に、プロジェクトの重要な情報を思い出すプロセスを**完全自動化**します。

## 実行内容

1. **Onboarding確認**: `mcp__serena__check_onboarding_performed`
2. **重要なメモリ読み込み**:
   - `current_issues`: 現在のIssue状況と次のタスク
   - `project_overview`: プロジェクト全体像とアーキテクチャ
3. **Git状態確認**:
   - `git branch --show-current`: 現在のブランチ
   - `git log -1 --oneline`: 最新コミット
4. **Issue番号確認**: ブランチ名からIssue番号を抽出（例: 57-dsl-clarification → Issue #57）

## 手順

以下の順序で実行してください：

```
1. mcp__serena__check_onboarding_performed を実行
2. mcp__serena__read_memory で current_issues を読み込み
3. mcp__serena__read_memory で project_overview を読み込み
4. git branch --show-current && git log -1 --oneline を実行
5. 現在のブランチ名からIssue番号を抽出（例: 57-dsl-clarification-parser-consistency → Issue #57）
```

この情報を元に、セッションで何をすべきかを理解してから作業を開始してください。

## 実装詳細

`.claude/hooks/session-start.sh`スクリプトが、JSON形式の`additionalContext`を出力します：

```json
{
  "hookSpecificOutput": {
    "hookEventName": "SessionStart",
    "additionalContext": "⚠️ COMPACTING CONVERSATION後の必須手順を実行してください:..."
  }
}
```

Claude側がこの`additionalContext`を自動的に認識し、会話文脈に追加します。

## 設定

`.claude/settings.json`:
```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "compact",
        "hooks": [{"type": "command", "command": "$CLAUDE_PROJECT_DIR/.claude/hooks/session-start.sh"}]
      },
      {
        "matcher": "resume",
        "hooks": [{"type": "command", "command": "$CLAUDE_PROJECT_DIR/.claude/hooks/session-start.sh"}]
      }
    ]
  }
}
```

## トラブルシューティング

**hookが動作しない場合**:
1. スクリプトに実行権限があるか確認: `ls -la .claude/hooks/session-start.sh`
2. 手動実行してJSON出力を確認: `./.claude/hooks/session-start.sh`
3. `.claude/settings.json`の構造を確認
4. Claude Code docsの最新情報を確認

**手動実行**:
hookが動作しない場合は、CLAUDE.mdの「⚠️ COMPACTING CONVERSATION後の必須手順」を参照して手動実行してください。

**重要**: この手順を実行せずに作業を開始しないでください。Compacting conversationで失われた文脈を回復するために必須です。
