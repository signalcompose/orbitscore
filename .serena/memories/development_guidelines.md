# Development Guidelines

このメモリには、OrbitScoreプロジェクトの開発ガイドラインを記録します。

## Issue and PR Workflow

### Automatic Issue Closing

PRをマージする際、PR本文に以下のキーワードを含めることで、関連するIssueを自動的にクローズできます：

```markdown
Closes #123
Fixes #123
Resolves #123
```

**重要な注意点**:
- GitHubのデフォルトブランチが`develop`に変更されました
- **自動クローズは`develop`ブランチへのマージ時に機能します**
- `main`ブランチへのマージ時にも自動クローズが機能する可能性があります（要確認）
- 複数のIssueを閉じる場合は、それぞれに対してキーワードを使用します：
  ```markdown
  Closes #123
  Closes #456
  ```

### PR Workflow Example

1. **ブランチ作成**:
   ```bash
   gh issue develop <issue-number> --checkout
   ```

2. **作業完了後、PR作成**:
   ```bash
   gh pr create --base develop --title "..." --body "Closes #<issue-number>"
   ```

3. **マージ（ユーザーが実行）**:
   - ⚠️ **AIエージェントはマージを実行してはいけません**
   - ユーザーが「all check passed」を確認してからマージします
   - マージ方法: squashマージ
   - ブランチは削除しない（履歴追跡のため）

4. **Issueの自動クローズ**:
   - PRがマージされると、`Closes #<issue-number>`で指定されたIssueが自動的にクローズされます

## Pre-commit Hook

プロジェクトでは、コミット前に自動的にテストとビルドを実行するpre-commitフックを使用しています。

### 設定方法

```bash
# Huskyのインストール（package.jsonに既に設定済み）
npm install

# pre-commitフックが自動的に設定されます
```

### フックの内容

`.husky/pre-commit`:
```bash
#!/usr/bin/env sh
. "$(dirname -- "$0")/_/husky.sh"

# Pre-commit checks for OrbitScore
# Purpose: Prevent pushing broken code and ensure code quality before reaching the remote repository
# - Run tests to catch regressions
# - Build to catch TypeScript errors
# - Lint staged files for code style

npm test || exit 1
npm run build || exit 1
npx lint-staged
```

### 意図

- **壊れたコードのプッシュを防ぐ**: テストとビルドが失敗した場合、コミットできません
- **コード品質の確保**: リモートリポジトリに到達する前にコード品質を保証します
- **CI/CDの負荷軽減**: ローカルで問題を検出することで、CI/CDパイプラインの実行回数を減らします

### 注意事項

- pre-commitフックは時間がかかる場合があります（テスト実行のため）
- 緊急時にスキップする場合: `git commit --no-verify`（非推奨）

## Refactoring Workflow

リファクタリング作業は段階的に進め、各Phaseごとに以下のワークフローに従います。

### Phase 2の例

#### Phase 2-1: audio-slicer.ts

1. **Issue作成**: Issue #11
2. **ブランチ作成**: `11-refactor-audio-slicer-phase-2-1`
3. **Serenaメモリ更新**: ブランチ作成直後に`refactoring_plan.md`を更新（進行中ステータス）
4. **リファクタリング実施**:
   - 既存のテストが通ることを確認
   - コードを分割（`audio/slicing/`ディレクトリ作成）
   - 新しいテストを追加
   - すべてのテストが通ることを確認
5. **コミット**: 小さな単位で頻繁にコミット
6. **PR作成**: `gh pr create --base develop --title "..." --body "Closes #11"`
7. **レビュー**: BugBotのコメントを確認、修正
8. **ユーザーがマージ**: ユーザーが「all check passed」を確認後、squashマージ（ブランチは削除しない）
9. **Serenaメモリ更新**: マージ後に`refactoring_plan.md`を更新（完了ステータス）
10. **次のPhaseへ**

#### Phase 2-2: timing-calculator.ts

同様のワークフローで進行。

### 成功基準

- ✅ すべてのテストが通る
- ✅ 各ファイルが50行以下の関数で構成される
- ✅ 各関数が単一責任を持つ
- ✅ 重複コードが排除される
- ✅ 再利用可能なモジュール構造
- ✅ 明確なディレクトリ構造
- ✅ JSDocコメントが充実

### 注意事項

- **段階的に進める**: 一度に大量の変更をしない
- **テストを先に書く**: TDDの原則に従う
- **pre-commitフックを活用**: test/build/lintを自動実行
- **後方互換性を維持**: 既存のDSLコードが動作し続けること
- **ブランチは削除しない**: GitHubでブランチを保持（履歴追跡のため）
- **⚠️ AIエージェントはマージを実行しない**: ユーザーが「all check passed」を確認してからマージ

## Git Workflow Rules

### Branch Protection

- `main`ブランチと`develop`ブランチは保護されています
- 直接プッシュは禁止
- PRを通じてのみマージ可能

### Merge Policy

- **⚠️ AIエージェントはマージを実行してはいけません**
- ユーザーが以下を確認してからマージします：
  1. すべてのテストが通過（all check passed）
  2. ビルドが成功
  3. Lintエラーがない
  4. BugBotのコメントが解決済み
- マージ方法: squashマージ
- ブランチは削除しない（履歴追跡のため）

### Branch Naming

- 日本語禁止
- フォーマット: `<issue-number>-<description>`
- 例: `18-refactor-interpreter-v2ts-phase-3-2`

## Serena Memory Update Workflow

### ブランチ作成直後（進行中ステータス）

新しいブランチを作成したら、**最初のステップ**としてSerenaメモリを更新します：

```bash
# 1. Issue作成
gh issue create --title "..." --body "..."

# 2. ブランチ作成
gh issue develop <issue-number> --checkout

# 3. Serenaメモリ更新（最初のステップ）
# - refactoring_plan.md を更新
# - 該当Phaseを「進行中」に変更
# - Issue番号、ブランチ名を記録
```

### マージ後（完了ステータス）

PRがマージされたら、Serenaメモリを更新します：

```bash
# 1. ユーザーがマージ実行（AIエージェントは実行しない）

# 2. developブランチに切り替え
git checkout develop
git pull origin develop

# 3. Serenaメモリ更新
# - refactoring_plan.md を更新
# - 該当Phaseを「完了」に変更
# - PR番号、コミットハッシュを記録
```

### メモリ更新のタイミング

| タイミング | 更新内容 | 実行者 |
|----------|---------|--------|
| ブランチ作成直後 | 進行中ステータス | AIエージェント |
| マージ後 | 完了ステータス | AIエージェント |

これにより、Serenaメモリが常に最新の状態を反映し、プロジェクトの進捗を正確に追跡できます。