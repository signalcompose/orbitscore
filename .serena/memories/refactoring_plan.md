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
1. **audio-parser.ts** (768行) - パーサーロジックが巨大
2. **sequence.ts** (557行) - まだ大きい（一部リファクタリング済み）
3. **supercollider-player.ts** (506行) - SuperCollider連携ロジック
4. **global.ts** (432行) - グローバル状態管理

### 🟡 中優先度（200-500行）
5. **audio-engine.ts** (363行) - オーディオエンジン
6. **cli-audio.ts** (282行) - CLI処理
7. **interpreter-v2.ts** (275行) - インタープリター

### 🟢 低優先度（200行未満）
8. **simple-player.ts** (196行)
9. **precision-scheduler.ts** (173行)
10. **timing-calculator.ts** (151行)
11. ~~**audio-slicer.ts** (139行)~~ ✅ **完了**

## 実施順序

### Phase 1: 現在のPRをマージ ✅ (PR #10)
- Chop slice playback rate adjustment
- Envelope improvements
- Code organization principles documentation

### Phase 2: 小規模ファイルから開始（影響範囲が小さい）
**目的**: リファクタリングパターンの確立、チーム内での合意形成

#### 2-1: audio-slicer.ts (139行) ✅ **完了** (PR #12)
- **現状**: オーディオファイルのスライス処理
- **課題**: 
  - 単一ファイルに複数の責務（ファイル操作、WAV処理、一時ファイル管理、キャッシュ）
  - エラーハンドリングが散在
- **リファクタリング結果**:
  - `audio/slicing/` ディレクトリを作成
  - `types.ts` - 型定義（AudioSliceInfo, AudioProperties）
  - `slice-cache.ts` - キャッシュ管理
  - `temp-file-manager.ts` - 一時ファイル管理（インスタンス固有ディレクトリ、自動クリーンアップ）
  - `wav-processor.ts` - WAV処理（読み込み、サンプル抽出、バッファ作成）
  - `slice-audio-file.ts` - メイン処理
  - `audio-slicer.ts` - 後方互換性のためのラッパークラス
- **バグ修正**:
  - レースコンディション修正（cache.has() + cache.get()! → cache.get()のみ）
  - 不要なasync削除（パフォーマンス改善）
  - Buffer型エラー修正（Uint8Array → Buffer変換）
  - インスタンスディレクトリ使用（プロセスクラッシュ時の自動クリーンアップ）
- **テスト**: ✅ 115 tests passed
- **コミット**: `393308d`, `74537f2`

#### 2-2: timing-calculator.ts (151行) 🔜 **次のステップ**
- **現状**: タイミング計算ロジック
- **課題**:
  - 複数の計算ロジックが1ファイルに集約
  - テストが困難な部分がある
- **リファクタリング方針**:
  - `timing/` ディレクトリ内で分割
  - `calculate-event-timing.ts` - イベントタイミング計算
  - `calculate-pattern-duration.ts` - パターン期間計算
  - `flatten-play-pattern.ts` - パターン展開
- **テスト**: 各関数に対する単体テストを追加

### Phase 3: 中規模ファイル

#### 3-1: cli-audio.ts (282行)
- **現状**: CLI処理、引数パース、実行モード管理
- **課題**:
  - コマンド処理、引数パース、実行ロジックが混在
- **リファクタリング方針**:
  - `cli/` ディレクトリを作成
  - `parse-arguments.ts` - 引数パース
  - `execute-command.ts` - コマンド実行
  - `repl-mode.ts` - REPLモード
  - `play-mode.ts` - 再生モード
- **テスト**: コマンドラインインターフェースのE2Eテスト

#### 3-2: interpreter-v2.ts (275行)
- **現状**: DSLインタープリター
- **課題**:
  - 評価ロジックが複雑
  - エラーハンドリングが散在
- **リファクタリング方針**:
  - `interpreter/` ディレクトリ内で分割
  - `evaluate-expression.ts` - 式評価
  - `handle-definitions.ts` - 定義処理
  - `error-handler.ts` - エラーハンドリング
- **テスト**: 各評価パターンに対するテスト

### Phase 4: 大規模ファイル（慎重に）

#### 4-1: audio-parser.ts (768行) ⚠️
- **現状**: DSLパーサー（最大ファイル）
- **課題**:
  - トークナイザー、パーサー、ASTビルダーが混在
  - 非常に大きく、変更リスクが高い
- **リファクタリング方針**:
  - `parser/` ディレクトリ内で分割
  - `tokenizer.ts` - トークン化
  - `parse-expression.ts` - 式パース
  - `parse-statement.ts` - 文パース
  - `ast-builder.ts` - AST構築
  - `parser-utils.ts` - ユーティリティ
- **テスト**: 既存のパーサーテストを維持、ゴールデンファイルテスト

#### 4-2: supercollider-player.ts (506行)
- **現状**: SuperCollider連携
- **課題**:
  - OSC通信、バッファ管理、スケジューリングが混在
- **リファクタリング方針**:
  - `audio/supercollider/` ディレクトリを作成
  - `osc-client.ts` - OSC通信
  - `buffer-manager.ts` - バッファ管理
  - `event-scheduler.ts` - イベントスケジューリング
  - `synthdef-loader.ts` - SynthDefロード
- **テスト**: SuperCollider連携のモックテスト

#### 4-3: global.ts (432行)
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

#### 4-4: sequence.ts (557行)
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

1. **Issue作成**: GitHub Issue #11など
2. **ブランチ作成**: `<issue-number>-<description>`（日本語禁止）
3. **リファクタリング実施**:
   - 既存のテストが通ることを確認
   - コードを分割
   - 新しいテストを追加
   - すべてのテストが通ることを確認
4. **コミット**: 小さな単位で頻繁にコミット
5. **PR作成**: developブランチに対して
6. **レビュー**: 変更内容を確認
7. **マージ**: squashマージ
8. **次のファイルへ**

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

## 進捗管理

各Phaseの完了時に、このメモリを更新して進捗を記録する。

## 現在の状態

- **Phase 1**: ✅ 完了（PR #10マージ済み）
- **Phase 2-1**: ✅ 完了（audio-slicer.ts、PR #12）
- **Phase 2-2**: 🔜 次のステップ（timing-calculator.ts）
- **Phase 3**: ⏳ 未着手
- **Phase 4**: ⏳ 未着手