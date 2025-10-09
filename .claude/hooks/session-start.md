# Session Start Hook

このhookはセッション開始時（startup, resume, clear, compact後）に自動実行されます。

## 目的

Compacting conversation後や新しいセッション開始時に、プロジェクトの重要な情報を思い出すプロセスを自動化します。

## 実行内容

1. **Onboarding確認**: プロジェクトのonboarding情報を確認
2. **重要なメモリ読み込み**:
   - `current_issues`: 現在のIssue状況
   - `project_overview`: プロジェクト全体像
3. **Git状態確認**: 現在のブランチとコミット
4. **Issue番号確認**: 現在作業中のIssue番号をブランチ名から抽出

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

**重要**: この手順を実行せずに作業を開始しないでください。Compacting conversationで失われた文脈を回復するために必須です。
