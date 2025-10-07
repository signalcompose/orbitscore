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
2. ~~**sequence.ts** (571行)~~ ✅ **完了** (PR #27マージ済み)
3. ~~**supercollider-player.ts** (506行)~~ ✅ **完了** (PR #23マージ済み)
4. ~~**global.ts** (432行)~~ ✅ **完了** (PR #24マージ済み)

### 🟡 中優先度（200-500行）
5. ~~**audio-engine.ts** (363行)~~ ✅ **完了** (PR #29作成済み、レビュー待ち)
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

#### 4-2: supercollider-player.ts (506行) ✅ **完了** (PR #23マージ済み)

#### 4-3: global.ts (432行) ✅ **完了** (PR #24マージ済み)

#### 4-4: sequence.ts (571行) ✅ **完了** (PR #27マージ済み)
- **Issue**: #26
- **Branch**: `26-refactor-sequence-phase-4-4`
- **開始日**: 2025-01-07
- **完了日**: 2025-01-07
- **リファクタリング結果**:
  - `core/sequence/` ディレクトリを拡張
  - `types.ts` (132行) - 型定義
  - `parameters/gain-manager.ts` (82行) - ゲイン管理
  - `parameters/pan-manager.ts` (76行) - パン管理
  - `parameters/tempo-manager.ts` (103行) - テンポ・拍子・長さ管理
  - `parameters/random-utils.ts` (26行) - ランダム値生成ユーティリティ
  - `scheduling/event-scheduler.ts` (183行) - イベントスケジューリング
  - `scheduling/run-scheduler.ts` (64行) - ワンショット再生
  - `scheduling/loop-scheduler.ts` (85行) - ループ再生
  - `state/state-manager.ts` (198行) - 状態管理
  - `sequence.ts` (約250行) - 薄いラッパー（後方互換性）
- **バグ修正**:
  - パス解決の不一致修正（`scheduleEventsFromTime`で`process.cwd()`が欠落）
  - Master Gain未適用バグ修正（`finalGainDb = sequenceGainDb + masterGainDb`）
  - Pattern Duration固定値バグ修正（動的計算に変更）
  - Loop Offset計算バグ修正（`loopIteration * patternDuration`）
- **コード品質改善**:
  - 重複コード削減: 約150行
  - 未使用コード削除: 約50行（`calculateFinalGain`, `reset`, `getSchedulingState`, etc.）
  - 型安全性向上: `as any`キャスト5箇所削除
  - DRY原則徹底: `generateRandomValue`, `calculateEventGain`, `seamlessParameterUpdate`などを共通化
  - Schedulerインターフェース拡張: `startTime`プロパティ追加
- **テスト**: ✅ 115 tests passed | 15 skipped
- **マージ日**: 2025-01-07

## Phase 5: 残りの中優先度ファイル

### 5-1: audio-engine.ts (363行) - ✅ **完了** (PR #29作成済み、レビュー待ち)
- **Issue**: #28
- **Branch**: `28-refactor-audio-engine-phase-5-1`
- **開始日**: 2025-01-07
- **完了日**: 2025-01-07
- **リファクタリング結果**:
  - `audio/types.ts` (49行) - 型定義
  - `audio/engine/audio-context-manager.ts` (63行) - AudioContext管理
  - `audio/engine/master-gain-controller.ts` (35行) - マスターボリューム制御
  - `audio/engine/audio-file-cache.ts` (81行) - ファイルキャッシュ管理
  - `audio/loading/wav-decoder.ts` (78行) - WAVデコード処理
  - `audio/loading/audio-file-loader.ts` (86行) - ファイル読み込みロジック
  - `audio/slicing/slice-manager.ts` (47行) - スライス作成・取得
  - `audio/playback/slice-player.ts` (54行) - 個別スライス再生
  - `audio/playback/sequence-player.ts` (79行) - シーケンス再生
  - `audio/audio-engine.ts` (約240行) - 薄いラッパー（後方互換性）
- **コード品質改善**:
  - 全関数が50行以下
  - SRP（単一責任原則）適用
  - DRY原則徹底
  - 明確なディレクトリ構造
  - JSDocコメント充実
- **テスト**: ✅ 115 tests passed | 15 skipped
- **リンターエラー**: ✅ 0件
- **後方互換性**: 完全に維持
- **PR**: #29 (レビュー待ち)

## Phase 6: 低優先度ファイル（残り）

### 6-1: simple-player.ts (196行) - 次のターゲット
- SuperColliderプレイヤーの簡易版
- リファクタリング推奨

### 6-2: precision-scheduler.ts (173行)
- 高精度スケジューリング
- リファクタリング推奨

## 各Phaseの作業フロー

1. **Issue作成**: GitHub Issue
2. **ブランチ作成**: `<issue-number>-<description>`（日本語禁止）
3. **Serenaメモリ更新**: ブランチ作成直後に`refactoring_plan.md`を更新（進行中ステータス）
4. **リファクタリング実施**
5. **PR作成**: developブランチに対して、`Closes #<issue-number>`を含める
6. **レビュー・マージ**: bugbotレビュー後、ユーザーがマージ
7. **Serenaメモリ更新**: マージ後に`refactoring_plan.md`を更新（完了ステータス）

## 成功基準

- ✅ すべてのテストが通る
- ✅ 各ファイルが50行以下の関数で構成される
- ✅ 各関数が単一責任を持つ
- ✅ 重複コードが排除される
- ✅ 再利用可能なモジュール構造
- ✅ 明確なディレクトリ構造
- ✅ JSDocコメントが充実

## 現在の状態

- **Phase 5完了**: 🎉 全ての中優先度ファイル（200-500行）のリファクタリング完了！
- **次のターゲット**: Phase 6-1 (simple-player.ts, 196行)