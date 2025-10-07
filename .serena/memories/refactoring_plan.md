# Engine Refactoring Plan

## 目的
`packages/engine/src`内のコードをコーディング規約（SRP、DRY、モジュール組織化）に則ってリファクタリングする。

**⚠️ 重要な変更（2025-01-07）**: 
- **SuperCollider一本化により、Phase 5-1の成果は不要となりました**
- PR #29（audio-engine.tsリファクタリング）はクローズ
- PR #31（SC一本化）で約1,085行のWeb Audio API関連コードを削除

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
5. ~~**audio-engine.ts** (363行)~~ ❌ **不要** (PR #29クローズ、SC一本化により削除)
6. ~~**cli-audio.ts** (282行)~~ ✅ **完了** (PR #17マージ済み)
7. ~~**interpreter-v2.ts** (275行)~~ ✅ **完了** (PR #19マージ済み)

### 🟢 低優先度（200行未満）
8. ~~**simple-player.ts** (196行)~~ ❌ **削除** (SC一本化により不要)
9. ~~**precision-scheduler.ts** (173行)~~ ❌ **削除** (SC一本化により不要)
10. ~~**timing-calculator.ts** (151行)~~ ✅ **完了** (PR #15マージ済み)
11. ~~**audio-slicer.ts** (139行)~~ ✅ **完了** (PR #13マージ済み)

## SuperCollider一本化 (2025-01-07)

### Issue #30 / PR #31
- **理由**: パフォーマンステスト結果（SC > Web Audio API）
- **削除**: 約1,085行のWeb Audio API関連コード
- **保持**: SuperCollider実装 + WAVスライシング機能
- **結果**: 
  - 10ファイル変更
  - +318行 / -762行 (純減444行)
  - ✅ 115 tests passed
  - ✅ ビルド成功
  - ✅ リンター: 0 errors

### 削除されたファイル
```
packages/engine/src/audio/
├── audio-engine.ts (240行)
├── engine/
│   ├── audio-context-manager.ts (63行)
│   ├── audio-file-cache.ts (81行)
│   └── master-gain-controller.ts (35行)
├── loading/
│   ├── audio-file-loader.ts (86行)
│   └── wav-decoder.ts (78行)
├── playback/
│   ├── slice-player.ts (54行)
│   └── sequence-player.ts (79行)
├── simple-player.ts (196行)
└── precision-scheduler.ts (173行)
```

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

- **全フェーズ完了**: 🎉 全てのリファクタリング完了！
- **SuperCollider一本化**: ✅ 完了（PR #31）
- **Phase 5-1の結果**: PR #29はクローズ（SC一本化により不要）

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