# よくあるワークフロー違反と対策

## 概要
AIエージェント（特にSonnet 3.5）がよく犯すワークフロー違反と、それを防ぐための対策をまとめる。

## よくある違反事例

### 1. Issue作成前にブランチを作成
**違反例:**
```bash
git checkout -b feature/new-feature  # ❌ Issue番号がない
```

**正しい手順:**
```bash
# 1. Issue作成
gh issue create --title "[Feature] Add new feature"
# → Issue #39 が作成される

# 2. Issue番号を含むブランチ作成
git checkout -b 39-add-new-feature
```

**なぜこれが起きるか:**
- 「実装の準備」を依頼されると、Issueを飛ばしてブランチを作ってしまう
- `AGENTS.md`や`PROJECT_RULES.md`を読まずに作業を開始する

**対策:**
- `AGENTS.md`の先頭に「CRITICAL RULES」セクションを追加（完了）
- セッション開始時に必ず`AGENTS.md`を読むよう強調

### 2. ブランチ名にIssue番号を含めない
**違反例:**
```bash
git checkout -b feature/reserved-keywords  # ❌ Issue番号なし
git checkout -b reserved-keywords-implementation  # ❌ Issue番号なし
```

**正しい例:**
```bash
git checkout -b 39-reserved-keywords-implementation  # ✅
git checkout -b 42-fix-audio-bug  # ✅
```

**なぜこれが起きるか:**
- `feature/` プレフィックスに慣れている（一般的なGit Flowの影響）
- Issue番号の重要性を理解していない

**対策:**
- ブランチ命名規則を`AGENTS.md`に明記（完了）
- 具体例を複数提示

### 3. PR本文に`Closes #N`を含めない
**違反例:**
```bash
gh pr create --body "Add new feature"  # ❌ Issue番号への参照なし
```

**正しい例:**
```bash
gh pr create --body "Closes #39

Add reserved keywords implementation"  # ✅
```

**なぜこれが起きるか:**
- 自動クローズ機能を知らない
- Issue-PR連携の重要性を理解していない

**対策:**
- `PROJECT_RULES.md`に自動クローズの説明を追加（既存）
- PRテンプレートの作成を検討

### 4. DSL構文を仕様書で確認せずに推測
**違反例:**
```javascript
seq.beat(4)  // ❌ beat()は単一引数を取らない
```

**正しい例:**
```javascript
seq.beat(4 by 4)  // ✅ "n by m" 形式が必須
```

**なぜこれが起きるか:**
- `INSTRUCTION_ORBITSCORE_DSL.md`を読まずにコードを書く
- 他の言語の構文から推測してしまう

**対策:**
- `PROJECT_RULES.md`のDSL記述ルールを強調（既存）
- コード作成前に必ず仕様書を読むよう指示

### 5. セッション開始時にAGENTS.mdを読まない
**違反例:**
- いきなり実装を開始
- 準備アクション（Serena activate、ドキュメント確認）をスキップ

**正しい手順:**
1. `AGENTS.md`を読む
2. Serenaプロジェクトをアクティベート
3. `PROJECT_RULES.md`を読む
4. Serenaメモリを確認
5. 作業開始

**なぜこれが起きるか:**
- システムプロンプトを読んでも実行しない
- 「準備して」という指示を「すぐ実装開始」と解釈

**対策:**
- `AGENTS.md`の先頭に「このファイルを必ず最初に読むこと」を明記（完了）
- repo_specific_ruleでも同様に強調

## 根本原因

### Sonnet 3.5の特性
- **高速処理優先**: 詳細なルール確認より、すぐに実装を開始しようとする
- **一般的なパターン適用**: プロジェクト固有ルールより、一般的なベストプラクティスを優先
- **推測傾向**: 不明点を質問せず、推測で進めてしまう

### 対策の方向性
1. **視覚的強調**: 🔴 や **太字** で重要ルールを目立たせる
2. **具体例の提示**: ✅/❌ の対比で正誤を明確化
3. **理由の説明**: なぜそのルールが重要か、違反するとどうなるかを明記
4. **チェックリスト**: 作業開始前の確認項目を列挙

## 改善履歴
- 2025-01-08: `AGENTS.md`にCRITICAL RULESセクションを追加
- 2025-01-08: このメモリを作成してよくある違反を文書化