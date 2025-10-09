# OrbitScore - Claude Code Rules

**このファイルはClaude Codeが最初に読む必須ルールファイルです**

## 🔴 CRITICAL: 実装前の必須ワークフロー

> **一行でもコードを書く前に、以下の手順を完了すること**

### 正しい手順（絶対に守る）

```
1. Issue作成（gh issue create）
2. ブランチ作成（git checkout -b <issue-number>-description）
3. 実装開始（Edit/Writeツール使用OK）
4. テスト実行
5. コミット
6. PR作成（Closes #N）
```

### ❌ 絶対にやってはいけないこと

- developブランチで実装を開始する
- Issueを作成せずに実装を開始する
- ブランチを作成せずに実装を開始する
- Issue番号のないブランチ名を使用する

## 実装開始前の必須チェック

**Edit/Writeツールを使う前に必ず確認:**

1. ✅ Issue作成済み？
2. ✅ ブランチ作成済み？
3. ✅ 現在のブランチはdevelop/mainではない？
4. ✅ ブランチ名にIssue番号が含まれている？

**一つでもNoがあれば、実装を開始してはいけない。**

## セッション開始時の必須アクション

1. **Serenaプロジェクトをアクティベート**
   ```
   serena-activate_project("orbitscore")
   ```

2. **必須ドキュメントを読み込む**
   - `docs/PROJECT_RULES.md`
   - `docs/CONTEXT7_GUIDE.md`（必要に応じて）

3. **Serenaメモリを確認**
   ```
   serena-list_memories
   ```
   - 特に `project_overview`, `current_issues`, `common_workflow_violations` を確認

4. **現在のブランチを確認**
   ```bash
   git branch --show-current
   ```
   - developにいる場合は、作業開始前に機能ブランチを作成

## Git Workflow

### ブランチ命名規則

- **形式**: `<issue-number>-<descriptive-name>`
- **英語のみ**（日本語禁止）
- **例**:
  - ✅ `55-improve-type-safety-process-statement`
  - ❌ `feature/type-safety`（Issue番号なし）
  - ❌ `55-型安全性向上`（日本語使用）

### PR作成

- **必ず`Closes #<issue-number>`を含める**
- **developブランチ向けに作成**
- **例**:
  ```bash
  gh pr create --base develop --title "..." --body "Closes #55

  詳細..."
  ```

### Serenaメモリのコミットルール

- ✅ developでメモリ変更（編集・保存）はOK
- ❌ developでメモリコミットはNG
- ✅ 変更はunstagedのまま機能ブランチに持ち越す
- ✅ 機能ブランチで機能と一緒にコミット

**理由**: メモリ更新だけのPRを防ぐため

## Hooks

### PreToolUse Hooks

- `Bash:git commit.*` → Serenaメモリのコミットをブロック
- `Bash:git checkout -b.*` → ブランチ命名規則をリマインド

### SessionStart Hook

- セッション開始時に必須アクションをリマインド
- developブランチにいる場合は警告を表示

## 詳細ルール

全ての詳細ルールは以下を参照：
- `docs/PROJECT_RULES.md` - 開発ルール
- `.serena/memories/common_workflow_violations.md` - よくある違反事例
- `.claude/hooks/README.md` - Hooksの説明

## 重要なリマインダー

**実装を開始する前に、必ずこのファイルの「実装開始前の必須チェック」を確認してください。**

ワークフロー違反は、ブランチ管理の崩壊、Issue追跡の喪失、PRとIssueの紐付け失敗につながります。
