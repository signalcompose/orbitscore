# Engine Refactoring Plan

## 目的
`packages/engine/src`内のコードをコーディング規約（SRP、DRY、モジュール組織化）に則ってリファクタリングする。

**⚠️ 重要な変更（2025-01-07）**: 
- **SuperCollider一本化により、Phase 5-1の成果は不要となりました**
- PR #29（audio-engine.tsリファクタリング）はクローズ
- PR #31（SC一本化）で約1,085行のWeb Audio API関連コードを削除
- **Phase 6完了により、全てのリファクタリングが完了しました！** 🎉
- **Phase 7開始（2025-01-07）**: 最終クリーンアップ作業

## アプローチ
**段階的リファクタリング**（推奨）
- リスクが低い
- テストしやすい
- レビューしやすい
- ロールバックが容易
- 並行開発可能

## 完了したリファクタリング

### 🔴 高優先度（500行以上）
1. ~~**audio-parser.ts** (768行)~~ ✅ **完了** (PR #21マージ済み)
2. ~~**sequence.ts** (571行)~~ ✅ **完了** (PR #27マージ済み)
3. ~~**supercollider-player.ts** (506行)~~ ✅ **完了** (PR #23マージ済み)
4. ~~**global.ts** (432行)~~ ✅ **完了** (PR #24マージ済み)

### 🟡 中優先度（200-500行）
5. ~~**audio-engine.ts** (363行)~~ ❌ **不要** (PR #29クローズ、SC一本化により削除)
6. ~~**cli-audio.ts** (282行)~~ ✅ **完了** (PR #17マージ済み)
7. ~~**interpreter-v2.ts** (275行)~~ ✅ **完了** (PR #19マージ済み)

### 🟢 低優先度（200行未満）
8. ~~**simple-player.ts** (196行)~~ ❌ **削除** (SC一本化により不要)
9. ~~**precision-scheduler.ts** (173行)~~ ❌ **削除** (SC一本化により不要)
10. ~~**timing-calculator.ts** (151行)~~ ✅ **完了** (PR #15マージ済み)
11. ~~**audio-slicer.ts** (139行)~~ ✅ **完了** (PR #13マージ済み)

### ⭐ Phase 6（最終フェーズ）
12. ~~**parse-expression.ts** (339行)~~ ✅ **完了** (PR #33 Phase 6-1)
13. ~~**parse-statement.ts** (250行)~~ ✅ **完了** (PR #33 Phase 6-2)
14. ~~**event-scheduler.ts** (244行)~~ ✅ **完了** (PR #33 Phase 6-3)
15. ~~**sequence.ts** (365行)~~ ✅ **Phase 4-4で完了済み**（追加リファクタリング不要）

## Phase 6: 最終リファクタリング (2025-01-07) ✅ 完了

### Issue #32 / PR #33 - マージ完了

**Phase 6-1: parse-expression.ts**
- Before: `parseArgument()` 119行 → After: 25行（ディスパッチャー）
- 改善: -79%、最大メソッド36行

**Phase 6-2: parse-statement.ts**
- Before: `parseMethodCall()` 100行 → After: 32行（ディスパッチャー）
- 改善: -68%、最大メソッド36行

**Phase 6-3: event-scheduler.ts**
- Before: `executePlayback()` 54行 → After: 12行（ディスパッチャー）
- 改善: -78%、最大メソッド23行

**Phase 6-4: sequence.ts**
- 状態: Phase 4-4で完了済み（最大メソッド36行）
- 判断: 追加リファクタリング不要

### 結果
- ✅ 全メソッドが50行以下
- ✅ 115 tests passed | 15 skipped
- ✅ ビルド成功
- ✅ リンターエラー0件

## Phase 7: 最終クリーンアップ (2025-01-07) 🔄 進行中

### Issue #34 / ブランチ: 34-phase-7-final-cleanup-remove-unused-code-and-improve-type-safety

**Phase 7-1: 未使用コード削除**
- [ ] `scheduling/loop-scheduler.ts` 削除（`playback/loop-sequence.ts`と重複）
- [ ] `scheduling/run-scheduler.ts` 削除（`playback/run-sequence.ts`と重複）
- [ ] `scheduling/index.ts` 修正（event-schedulerのみエクスポート）
- [ ] `SuperColliderPlayer.testExecutePlayback()` メソッド削除（未使用）

**Phase 7-2: 非推奨ファイル削除**
- [ ] `prepare-slices.ts`を修正して`slicing/`を直接使用
- [ ] `audio-slicer.ts` 削除（@deprecatedラッパー）
- [ ] テストを修正して`calculation/`を直接使用
- [ ] `timing-calculator.ts` 削除（@deprecatedラッパー）

**Phase 7-3: 型安全性向上**
- [ ] `AudioEngine`インターフェース定義
- [ ] `playback/`の型定義で`Scheduler`型を使用（`any`→`Scheduler`）
- [ ] `any`型を削減（15箇所→0箇所を目標）

**Phase 7-4: 型キャスト削減**
- [ ] `Scheduler`型を拡張して`clearSequenceEvents()`/`sequenceTimeouts`を追加
- [ ] 型キャストを削減（`as any`の使用を最小化）

### 発見された問題（詳細チェック結果）

#### 🔴 重大な問題
1. **完全に未使用のファイル（3ファイル）**
   - `scheduling/loop-scheduler.ts` - `playback/loop-sequence.ts`と完全重複
   - `scheduling/run-scheduler.ts` - `playback/run-sequence.ts`と完全重複
   - これらは`playback/`の方が実際に使用されている

2. **未使用メソッド（1メソッド）**
   - `SuperColliderPlayer.testExecutePlayback()` - どこからも呼ばれていない

#### 🟡 中優先度の問題
3. **非推奨ファイルがまだ使用中（2ファイル）**
   - `audio-slicer.ts` - `prepare-slices.ts`から1箇所のみ使用
   - `timing-calculator.ts` - テストファイル2箇所で使用

4. **型安全性の問題（15箇所以上）**
   - `scheduler: any` が多数
   - `audioEngine: any` が複数
   - `globalInstance: any` など

5. **型キャストの多用（10箇所以上）**
   - `(scheduler as any).clearSequenceEvents()`
   - `(scheduler as any).sequenceTimeouts`
   - `(sequence as any).gain()`
   - など

#### 🟢 低優先度
6. **TODOコメント（1箇所）**
   - `calculate-event-timing.ts:72` - "TODO: Apply time modifications"

### 期待される効果
- ✅ コードベースの簡潔化（約300-400行削減見込み）
- ✅ 型安全性の向上（`any`型→適切な型定義）
- ✅ 保守性の向上（未使用コード削除）
- ✅ 技術的負債の削減

### 成功基準
- ✅ すべてのテストが通る
- ✅ 各ファイルが50行以下の関数で構成される
- ✅ 各関数が単一責任を持つ
- ✅ 重複コードが排除される
- ✅ 再利用可能なモジュール構造
- ✅ 明確なディレクトリ構造
- ✅ JSDocコメントが充実
- ✅ `any`型の使用が最小限

## SuperCollider一本化 (2025-01-07)

### Issue #30 / PR #31 - マージ完了
- **理由**: パフォーマンステスト結果（SC > Web Audio API）
- **削除**: 約1,085行のWeb Audio API関連コード
- **保持**: SuperCollider実装 + WAVスライシング機能
- **結果**: 
  - 10ファイル変更
  - +318行 / -762行 (純減444行)
  - ✅ 115 tests passed
  - ✅ ビルド成功
  - ✅ リンターエラー: 0 errors

## 各Phaseの作業フロー

1. **Issue作成**: GitHub Issue
2. **ブランチ作成**: `<issue-number>-<description>`（日本語禁止）
3. **Serenaメモリ更新**: ブランチ作成直後に`refactoring_plan.md`を更新（進行中ステータス）
4. **リファクタリング実施**
5. **PR作成**: developブランチに対して、`Closes #<issue-number>`を含める
6. **レビュー・マージ**: bugbotレビュー後、ユーザーがマージ
7. **Serenaメモリ更新**: マージ後に`refactoring_plan.md`を更新（完了ステータス）

## 現在の状態

🔄 **Phase 7進行中！**

- **Phase 1-6**: ✅ 完了
- **SuperCollider一本化**: ✅ 完了（PR #31マージ済み）
- **Phase 7**: 🔄 進行中
  - Issue #34作成済み
  - ブランチ作成済み: `34-phase-7-final-cleanup-remove-unused-code-and-improve-type-safety`
  - 作業開始: 2025-01-07

## 最終統計（Phase 6完了時点）

| カテゴリ | Before | After | 改善 |
|---------|--------|-------|------|
| **最大メソッドサイズ** | 119行 | 36行 | **-70%** |
| **200行超ファイル数** | 11ファイル | 0ファイル | **-100%** |
| **総削減行数** | - | 約1,500行 | - |

## 教訓

1. **Phase 5-1の作業（約1,085行のリファクタリング）は最終的に不要となった**
   - しかし、リファクタリング経験は有益
   - プロジェクト方針が決まる前の作業は無駄になる可能性がある
   
2. **パフォーマンステストの重要性**
   - 早期にSC vs Web Audio APIの比較を実施すべきだった
   - 結果に基づく意思決定が最終的に効率的

3. **SuperCollider一本化の効果**
   - コードベース削減: 約444行
   - メンテナンス負荷軽減
   - パフォーマンス向上（音質・レイテンシ）

4. **段階的リファクタリングの有効性**
   - 小さなPRで進めることでレビューが容易
   - テスト失敗時のロールバックが簡単
   - 並行開発が可能

5. **50行ルールの有効性**
   - 全メソッドを50行以下にすることで可読性が大幅向上
   - テスト・デバッグが容易に
   - 新規開発者のオンボーディングが簡単に

6. **詳細チェックの重要性**
   - Phase 6完了後の詳細チェックで追加の改善点が発見された
   - 未使用コード、重複、型安全性の問題が明らかに
   - Phase 7で最終的なクリーンアップを実施

## 次のステップ

Phase 7完了後：
1. **新機能開発**に集中
2. **パフォーマンス最適化**（必要に応じて）
3. **ドキュメント充実化**
4. **テストカバレッジ向上**