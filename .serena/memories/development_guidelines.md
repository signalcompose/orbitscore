# Development Guidelines

このメモリには、OrbitScoreプロジェクトの開発ガイドラインを記録します。

## Multi-Model Development Workflow (推奨)

**役割分担による効率的な開発サイクル:**

```
┌─────────────────────────────────────────────────────────┐
│ Phase X-Y リファクタリング/実装サイクル                      │
└─────────────────────────────────────────────────────────┘

1. 【実装担当: Auto (Sonnet 3.5)】
   - Issue/ブランチ作成
   - Serenaメモリ更新（進行中ステータス）
   - コード実装
   - テスト実行
   - コミット
   - PR作成（`Closes #<issue-number>`）
   
   ⚠️ 問題発生時（ループ/ハルシネーション/行き詰まり）
   ↓ エスカレーション（ユーザー判断）
   
   【問題解決: Claude 4.5 Sonnet】
   - 問題の分析と診断
   - 解決策の提案と実装
   - Autoに戻すための明確な指示を残す
   - Serenaメモリに解決策を記録
   
   ↓ 解決後、Autoに戻る（ユーザー判断）
   
   【実装再開: Auto (Sonnet 3.5)】
   - 4.5の指示とSerenaメモリを参照
   - 実装を継続
   ↓

2. 【評価・修正: Claude 4.5 Sonnet】
   - コーディング規約チェック
   - 設計パターン検証
   - テスト結果確認
   - リンターエラー修正
   - 必要に応じて追加修正
   - コミット（修正があった場合）
   ↓

3. 【レビュー: BugBot（自動）】
   - PR上で自動レビュー実行
   ↓

4. 【レビュー受け渡し: ユーザー】
   - BugBotのコメントを確認
   - 必要に応じて以下のコマンドで取得:
     gh pr view <PR番号> --comments
   - レビュー内容を4.5 Sonnetに伝える
   ↓

5. 【レビュー対応: Claude 4.5 Sonnet】
   - BugBotの指摘に対応
   - 修正実装
   - テスト実行
   - コミット
   ↓

6. 【マージ: ユーザー】
   - "all check passed"を確認
   - マージ実行（squash）
   ↓

7. 【次フェーズ準備: Claude 4.5 Sonnet】
   - Serenaメモリ更新（完了ステータス）
   - 次のPhaseの準備
   - セッション終了報告
```

### 利点

- ✅ **コスト効率**: 実装はSonnet 3.5、評価・レビュー対応はSonnet 4.5で最適化
- ✅ **品質保証**: 複数段階のチェック（評価 → BugBot → レビュー対応）
- ✅ **明確な役割分担**: 各ステップで責任が明確
- ✅ **自動化**: BugBotが自動レビュー、Issueも自動クローズ
- ✅ **エスカレーション**: 問題発生時に4.5 Sonnetが介入して解決

### エスカレーション判断基準（Auto → 4.5 Sonnet）

**Autoが以下の状況を検出した場合、ユーザーに報告すべき:**

1. **ループ検出**
   - 同じエラーが3回以上繰り返される
   - 同じ修正を何度も試している
   - 進捗がないまま10回以上のツール呼び出し

2. **ハルシネーション**
   - 存在しないAPI/メソッドを使おうとする
   - ドキュメントにない機能を実装しようとする
   - Context7やSerenaで確認できない情報を使用

3. **行き詰まり**
   - テストが通らず原因が特定できない
   - 複雑な設計判断が必要
   - 複数の解決策があり選択が困難

4. **仕様不明確**
   - DSL仕様（`INSTRUCTION_ORBITSCORE_DSL.md`）に記載がない
   - 設計パターンの選択が必要
   - アーキテクチャレベルの判断が必要

### エスカレーション時のAuto報告フォーマット

```
⚠️ エスカレーション推奨

【問題】: [問題の簡潔な説明]
【試行回数】: X回
【試したこと】:
- 試行1: [内容] → [結果]
- 試行2: [内容] → [結果]
【現在の状態】: [コードの状態、エラー内容]
【判断が必要な点】: [何を決める必要があるか]

4.5 Sonnetへのエスカレーションを推奨します。
```

### 4.5 Sonnet解決後のハンドオフ

- Serenaメモリに解決策を記録（`current_issues`または新規メモリ）
- 明確な次のステップを文書化
- Autoが参照できる形で指示を残す

### 補助ツール

```bash
# BugBotレビュー取得を簡単にするエイリアス
alias review-get='gh pr view --comments | grep -A 100 "bugbot"'
```

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

3. **マージ**:
   - ⚠️ **原則**: AIエージェントはマージを実行しない
   - ユーザーが「all check passed」を確認してからマージします
   - **例外**: ユーザーが明示的に「マージしてください」「マージをお願いします」と依頼した場合は実行可能
   - マージ方法: squashマージ
   - ブランチは原則として削除しない（履歴追跡のため）
   - **例外**: ユーザーが明示的に「ブランチを削除してください」と依頼した場合は削除可能

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
8. **マージ**:
   - 原則: ユーザーが「all check passed」を確認後、squashマージ
   - 例外: ユーザーが明示的に依頼した場合、AIエージェントが実行可能
   - ブランチは原則として削除しない（履歴追跡のため）
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
- **ブランチは原則として削除しない**: GitHubでブランチを保持（履歴追跡のため）
- **⚠️ AIエージェントは原則としてマージを実行しない**: ユーザーが「all check passed」を確認してからマージ
  - **例外**: ユーザーが明示的に「マージしてください」と依頼した場合は実行可能

## Git Workflow Rules

### Branch Protection

- `main`ブランチと`develop`ブランチは保護されています
- 直接プッシュは禁止
- PRを通じてのみマージ可能

### Merge Policy

- **原則**: AIエージェントはマージを実行しない
- ユーザーが以下を確認してからマージします：
  1. すべてのテストが通過（all check passed）
  2. ビルドが成功
  3. Lintエラーがない
  4. BugBotのコメントが解決済み
- **例外**: ユーザーが明示的に「マージしてください」「マージをお願いします」と依頼した場合は実行可能
- マージ方法: squashマージ
- ブランチは原則として削除しない（履歴追跡のため）
- **例外**: ユーザーが明示的に「ブランチを削除してください」と依頼した場合は削除可能

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
# 1. マージ実行
# - 原則: ユーザーが実行
# - 例外: ユーザーが明示的に依頼した場合、AIエージェントが実行可能

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