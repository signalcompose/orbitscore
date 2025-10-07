# Engine Refactoring Plan

## 目的
`packages/engine/src`内のコードをコーディング規約（SRP、DRY、モジュール組織化）に則ってリファクタリングする。

## アプローチ
**段階的リファクタリング**（推奨）
- リスクが低い
- テストしやすい
- レビューしやすい
- ロールバックが容易
- 並行開発可能

## ファイルサイズと優先度

### 🔴 高優先度（500行以上）
1. ~~**audio-parser.ts** (768行)~~ ✅ **完了** (PR #21マージ済み)
2. **sequence.ts** (557行) - まだ大きい（一部リファクタリング済み）
3. **supercollider-player.ts** (506行) - SuperCollider連携ロジック ⏳ **進行中** (Issue #22, Branch: 22-refactor-supercollider-playerts-phase-4-2)
4. **global.ts** (432行) - グローバル状態管理

### 🟡 中優先度（200-500行）
5. **audio-engine.ts** (363行) - オーディオエンジン
6. ~~**cli-audio.ts** (282行)~~ ✅ **完了** (PR #17マージ済み)
7. ~~**interpreter-v2.ts** (275行)~~ ✅ **完了** (PR #19マージ済み)

### 🟢 低優先度（200行未満）
8. **simple-player.ts** (196行)
9. **precision-scheduler.ts** (173行)
10. ~~**timing-calculator.ts** (151行)~~ ✅ **完了** (PR #15マージ済み)
11. ~~**audio-slicer.ts** (139行)~~ ✅ **完了** (PR #13マージ済み)

## 実施順序

### Phase 1: 現在のPRをマージ ✅ (PR #10マージ済み)

### Phase 2: 小規模ファイルから開始
#### 2-1: audio-slicer.ts ✅ **完了** (PR #13マージ済み)
#### 2-2: timing-calculator.ts ✅ **完了** (PR #15マージ済み)

### Phase 3: 中規模ファイル
#### 3-1: cli-audio.ts ✅ **完了** (PR #17マージ済み)
#### 3-2: interpreter-v2.ts ✅ **完了** (PR #19マージ済み)

### Phase 4: 大規模ファイル（慎重に）

#### 4-1: audio-parser.ts (768行) ✅ **完了** (PR #21マージ済み)
- **リファクタリング結果**:
  - `parser/` ディレクトリ内で分割
  - `types.ts` (115行) - 型定義
  - `tokenizer.ts` (185行) - トークン化
  - `parser-utils.ts` (114行) - ユーティリティ関数
  - `parse-expression.ts` (320行) - 式パース
  - `parse-statement.ts` (234行) - 文パース
  - `audio-parser.ts` (95行) - 後方互換性のためのラッパー
  - `index.ts` (16行) - モジュールエクスポート
- **バグ修正**:
  - parseNestedPlay型の不一致修正（`PlayNested | PlayWithModifier`に変更）
  - parseMethodCall型安全性改善（`Statement | null`に変更）
  - parseRandomValue型安全性改善（`as any`削除、エラーメッセージ改善）
  - isRandomSyntax厳密化（後方互換性保持、`rabc`などは通常の識別子として扱う）
- **テスト**: ✅ 115 tests passed
- **マージ日**: 2025-01-07

#### 4-2: supercollider-player.ts (506行) ⏳ **進行中**
- **Issue**: #22
- **Branch**: `22-refactor-supercollider-playerts-phase-4-2`
- **開始日**: 2025-01-07
- **現状**: SuperCollider連携
- **課題**:
  - OSC通信、バッファ管理、スケジューリングが混在
  - 単一ファイルに複数の責務
- **リファクタリング方針**:
  - `audio/supercollider/` ディレクトリを作成
  - `types.ts` - 型定義
  - `osc-client.ts` - OSC通信
  - `buffer-manager.ts` - バッファ管理
  - `event-scheduler.ts` - イベントスケジューリング
  - `synthdef-loader.ts` - SynthDefロード
  - `supercollider-player.ts` - 薄いラッパー（後方互換性）
- **テスト**: SuperCollider連携のモックテスト、実機テスト

#### 4-3: global.ts (432行) ⏳ **未着手**
- **現状**: グローバル状態管理
- **課題**:
  - テンポ、メーター、シーケンス管理が混在
- **リファクタリング方針**:
  - `core/global/` ディレクトリを作成
  - `tempo-manager.ts` - テンポ管理
  - `meter-manager.ts` - メーター管理
  - `sequence-registry.ts` - シーケンス登録
  - `transport-control.ts` - トランスポート制御
- **テスト**: 各管理機能の単体テスト

#### 4-4: sequence.ts (557行) ⏳ **未着手**
- **現状**: シーケンス管理（一部リファクタリング済み）
- **課題**:
  - まだ大きい、さらなる分割が可能
- **リファクタリング方針**:
  - `core/sequence/` ディレクトリをさらに拡張
  - `parameters/` - パラメータ管理（gain, pan, tempo, etc.）
  - `scheduling/` - スケジューリングロジック
  - `state/` - 状態管理
- **テスト**: 既存のテストを維持、追加テスト

## 各Phaseの作業フロー

1. **Issue作成**: GitHub Issue
2. **ブランチ作成**: `<issue-number>-<description>`（日本語禁止）
3. **🆕 Serenaメモリ更新**: ブランチ作成直後に`refactoring_plan.md`を更新（進行中ステータス）
4. **リファクタリング実施**:
   - 既存のテストが通ることを確認
   - コードを分割
   - 新しいテストを追加
   - すべてのテストが通ることを確認
5. **コミット**: 小さな単位で頻繁にコミット
6. **PR作成**: developブランチに対して、`Closes #<issue-number>`を含める
7. **レビュー**: 変更内容を確認
8. **マージ**: ユーザーが「all check passed」を確認後、squashマージ（ブランチは削除しない）
9. **🆕 Serenaメモリ更新**: マージ後に`refactoring_plan.md`を更新（完了ステータス）
10. **次のファイルへ**

## 成功基準

- ✅ すべてのテストが通る
- ✅ 各ファイルが50行以下の関数で構成される
- ✅ 各関数が単一責任を持つ
- ✅ 重複コードが排除される
- ✅ 再利用可能なモジュール構造
- ✅ 明確なディレクトリ構造
- ✅ JSDocコメントが充実

## 注意事項

- **パーサーは特に慎重に**: DSLの根幹なので、動作確認を徹底
- **SuperColliderは実機テスト必須**: モックだけでなく実際の音出しテスト
- **後方互換性を維持**: 既存のDSLコードが動作し続けること
- **段階的に進める**: 一度に大量の変更をしない
- **テストを先に書く**: TDDの原則に従う
- **pre-commitフックを活用**: test/build/lintを自動実行
- **ブランチは削除しない**: GitHubでブランチを保持（履歴追跡のため）
- **⚠️ AIエージェントは原則としてマージを実行しない**: ユーザーが「all check passed」を確認してからマージ
  - **例外**: ユーザーが明示的に「マージしてください」と依頼した場合は実行可能

## 進捗管理

各Phaseの完了時に、このメモリを更新して進捗を記録する。

## 現在の状態

- **Phase 1**: ✅ 完了（PR #10マージ済み）
- **Phase 2-1**: ✅ 完了（PR #13マージ済み）
- **Phase 2-2**: ✅ 完了（PR #15マージ済み）
- **Phase 3-1**: ✅ 完了（PR #17マージ済み）
- **Phase 3-2**: ✅ 完了（PR #19マージ済み）
- **Phase 4-1**: ✅ 完了（PR #21マージ済み）
- **Phase 4-2**: ⏳ **進行中**（Issue #22、Branch: 22-refactor-supercollider-playerts-phase-4-2）
- **Phase 4-3**: ⏳ 未着手
- **Phase 4-4**: ⏳ 未着手