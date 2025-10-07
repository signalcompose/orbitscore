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
3. ~~**supercollider-player.ts** (506行)~~ ✅ **完了** (PR #23マージ済み)
4. ~~**global.ts** (432行)~~ ✅ **完了** (PR #25マージ済み)

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

#### 4-2: supercollider-player.ts (506行) ✅ **完了** (PR #23マージ済み)
- **Issue**: #22
- **Branch**: `22-refactor-supercollider-playerts-phase-4-2`
- **開始日**: 2025-01-07
- **完了日**: 2025-01-07
- **リファクタリング結果**:
  - `audio/supercollider/` ディレクトリを作成
  - `types.ts` (35行) - 型定義（BufferInfo, ScheduledPlay, AudioDevice, etc.）
  - `osc-client.ts` (95行) - OSC通信
  - `buffer-manager.ts` (93行) - バッファ管理
  - `event-scheduler.ts` (244行) - イベントスケジューリング
  - `synthdef-loader.ts` (175行) - SynthDefロード
  - `supercollider-player.ts` (181行) - 薄いラッパー（後方互換性）
  - `index.ts` (16行) - モジュールエクスポート
- **バグ修正**:
  - executePlaybackエラーハンドリング追加（`.catch()`で非同期エラーを捕捉）
  - バッファ状態設定のバグ修正（`bufferManager.bufferCache`への正しいアクセス）
  - 音声ファイルパスのバグ修正（`process.cwd()`からの相対パス）
  - テストモッキングの修正（公開メソッド`player.scheduleSliceEvent`を使用）
  - synthId生成のID衝突防止（`Math.random()`から単調増加カウンターへ変更）
  - BufferInfo型エラー修正（テストモックに`duration`プロパティ追加）
  - メソッドチェーン型エラー修正（`tempo().beat()`を分離）
- **テスト**: ✅ 115 tests passed | 15 skipped
- **CI/CD**: SuperCollider連携テストをCI環境でスキップ（`describe.skipIf(process.env.CI === 'true')`）
- **マージ日**: 2025-01-07

#### 4-3: global.ts (432行) ✅ **完了** (PR #25マージ済み)
- **Issue**: #24
- **Branch**: `24-refactor-global-phase-4-3`
- **開始日**: 2025-01-07
- **完了日**: 2025-01-07
- **評価修正日**: 2025-01-07
- **マージ日**: 2025-01-07
- **リファクタリング結果**:
  - `core/global/` ディレクトリを作成
  - `types.ts` (45行) - 共通型定義（Meter, Scheduler, MasterEffect, GlobalState）
  - `tempo-manager.ts` (45行) - テンポ・メーター管理
  - `audio-manager.ts` (45行) - オーディオパス・デバイス管理
  - `effects-manager.ts` (200行 → 120行) - マスターエフェクト管理
  - `transport-control.ts` (55行) - トランスポート制御
  - `sequence-registry.ts` (35行) - シーケンス管理
  - `global.ts` (170行) - 薄いラッパー（後方互換性）
  - `index.ts` (10行) - モジュールエクスポート
- **設計改善**:
  - 単一責任原則（SRP）の適用：各マネージャーが明確な責務を持つ
  - メソッドチェーンの型安全性改善（`this`型の正しい処理）
  - 循環参照の解決（SequenceRegistryの初期化順序調整）
  - 状態管理の分離（各マネージャーが独立した状態を持つ）
- **評価修正内容（Claude 4.5 Sonnet）**:
  - **DRY原則の徹底**: EffectsManagerの重複コード削減（219行 → 120行、45%削減）
  - **ヘルパーメソッド追加**: `removeEffect()`, `addOrUpdateEffect()`
  - **関数の長さ改善**: compressor 73行→32行、limiter 46行→21行、normalizer 46行→21行
  - **リンターエラー修正**: インポートグループ化の警告を修正
  - **バグ修正**: 非null assertion演算子削除（型安全性向上）
  - **ドキュメント改善**: JSDoc重複削除（21行削除）
  - **コード品質向上**: 可読性、保守性、再利用性の向上
- **テスト**: ✅ 115 tests passed | 15 skipped
- **ビルド**: ✅ 成功
- **リンターエラー**: ✅ なし
- **後方互換性**: ✅ 完全に維持（既存のAPIは全て動作）
- **評価結果**: ✅ 優秀な実装品質、追加修正により更に改善
- **最終コミット数**: 5コミット（実装3 + 評価修正2）

#### 4-4: sequence.ts (557行) ⏳ **次のターゲット**
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
7. **🔄 モデル切り替え**: Auto (Sonnet 3.5)がユーザーに4.5 Sonnetへの切り替えを依頼
8. **評価・修正**: Claude 4.5 Sonnetがコード品質を評価・修正
9. **レビュー**: BugBotのコメントを確認
10. **マージ**: ユーザーが「all check passed」を確認後、squashマージ（ブランチは削除しない）
11. **🆕 Serenaメモリ更新**: マージ後に`refactoring_plan.md`を更新（完了ステータス）
12. **次のファイルへ**

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
- **Phase 4-2**: ✅ 完了（PR #23マージ済み）
- **Phase 4-3**: ✅ **完了**（PR #25マージ済み）
- **Phase 4-4**: ⏳ 次のターゲット（sequence.ts）