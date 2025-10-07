# Development Guidelines

## Issue and PR Workflow

### Automatic Issue Closing (重要)

**PRを作成する際は、必ずPR本文に`Closes #<issue-number>`を含めること**

#### 使用できるキーワード
- `Closes #N`
- `Fixes #N`
- `Resolves #N`
（大文字小文字は区別されない）

#### メリット
1. ✅ **自動化**: PRマージ時にIssueが自動的にクローズされる
2. ✅ **忘れない**: GitHubが自動処理するため、手動でIssueを閉じ忘れることがない
3. ✅ **明確な関連**: PRとIssueの関係が明確になる
4. ✅ **トレーサビリティ**: どのPRでどのIssueが解決されたか追跡しやすい

#### ワークフロー
```
Issue作成 → ブランチ作成 → 開発 → PR作成（Closes #N を含める） → マージ → Issue自動クローズ
```

#### 例
```bash
gh pr create --base develop \
  --title "refactor: timing-calculator.tsをモジュール分割" \
  --body "Closes #14

## 実施内容
- timing-calculator.tsを5つのモジュールに分割
- SRP、DRY原則に準拠
- 既存テストが通ることを確認

## テスト
- ✅ 全テスト通過
- ✅ ビルド成功"
```

#### 注意事項
- **必ず`Closes #N`を含める**（忘れないように）
- 複数のIssueを閉じる場合: `Closes #14, Closes #15`
- PRテンプレートに含めることも検討

## Pre-commit Hook

### 現在の設定
```bash
#!/usr/bin/env sh
# Pre-commit hook for OrbitScore
#
# IMPORTANT: This hook runs tests and build before commit.
# This is intentional to catch errors early, even though it makes commits slower.

npx lint-staged
npm test || exit 1
npm run build || exit 1
```

### 理由
- 手元でテストとビルドが通っていないものをプッシュしても、CI/CDで失敗するだけ
- 早期にエラーを検出する方が効率的
- コミット時に少し時間がかかるが、後でやり直す方が非効率

### スキップ方法（非推奨）
```bash
git commit --no-verify
```

## Refactoring Workflow

### Phase 2: 小規模ファイル（Phase 2-1完了、Phase 2-2進行中）

#### Phase 2-1: audio-slicer.ts ✅ 完了
- Issue #11
- PR #12（マージ済み）
- 5つのモジュールに分割
- バグ修正（レースコンディション、不要なasync、Buffer型エラー、exit handler）

#### Phase 2-2: timing-calculator.ts 🔜 進行中
- Issue #14
- ブランチ: `14-refactor-timing-calculator-phase-2-2`
- 5つのモジュールに分割予定
- PR作成時に`Closes #14`を含める

### 成功基準
- ✅ すべてのテストが通る
- ✅ 各ファイルが50行以下の関数で構成される
- ✅ 各関数が単一責任を持つ
- ✅ 重複コードが排除される
- ✅ 再利用可能なモジュール構造
- ✅ 明確なディレクトリ構造
- ✅ JSDocコメントが充実

### 注意事項
- 段階的に進める（一度に大量の変更をしない）
- テストを先に書く（TDDの原則）
- pre-commitフックを活用（test/build/lintを自動実行）
- PR作成時に`Closes #N`を忘れない