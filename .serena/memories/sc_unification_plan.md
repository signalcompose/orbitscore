# SuperCollider一本化計画

## 背景

パフォーマンステスト結果：
- **SuperCollider**: 音質◎、レイテンシ◎
- **Web Audio API (AudioEngine)**: 音質△、レイテンシ△

**結論**: SuperColliderに一本化する

## 影響範囲分析

### ✅ 削除対象ファイル（Web Audio API専用）

#### Phase 5-1でリファクタリングしたファイル群
```
packages/engine/src/audio/
├── audio-engine.ts (240行) ← メインファイル
├── engine/
│   ├── audio-context-manager.ts (63行)
│   ├── audio-file-cache.ts (81行) ← 削除済み（評価時）
│   └── master-gain-controller.ts (35行)
├── loading/
│   ├── audio-file-loader.ts (86行)
│   └── wav-decoder.ts (78行)
└── playback/
    ├── slice-player.ts (54行)
    └── sequence-player.ts (79行)
```

#### その他の未使用ファイル
```
packages/engine/src/audio/
├── simple-player.ts (196行)
└── precision-scheduler.ts (173行)
```

**削除行数**: 約1,085行

### 🔄 修正が必要なファイル

#### 1. `packages/engine/src/core/global.ts`
**変更箇所**:
```typescript
// 現在
import { AudioEngine } from '../audio/audio-engine'
export function createGlobal(audioEngine: AudioEngine): Global

// 修正後
import { SuperColliderPlayer } from '../audio/supercollider-player'
export function createGlobal(audioEngine: SuperColliderPlayer): Global

// Globalクラス内
private audioEngine: any // Can be AudioEngine or SuperColliderPlayer
↓
private audioEngine: SuperColliderPlayer
```

#### 2. `packages/engine/src/core/sequence.ts`
**変更箇所**:
```typescript
// 現在
import { AudioEngine, AudioFile } from '../audio/audio-engine'
constructor(global: Global, audioEngine: AudioEngine)

// 修正後
import { SuperColliderPlayer } from '../audio/supercollider-player'
constructor(global: Global, audioEngine: SuperColliderPlayer)

private audioEngine: AudioEngine
↓
private audioEngine: SuperColliderPlayer
```

#### 3. `packages/engine/src/core/global/sequence-registry.ts`
**確認が必要**: AudioEngineへの依存をチェック

#### 4. `packages/engine/src/core/global/audio-manager.ts`
**確認が必要**: AudioEngineへの依存をチェック

### ✅ 残すファイル（SuperColliderまたは共通で使用）

```
packages/engine/src/audio/
├── supercollider/ (SC実装)
│   ├── buffer-manager.ts
│   ├── event-scheduler.ts
│   ├── osc-client.ts
│   ├── synthdef-loader.ts
│   └── types.ts
├── supercollider-player.ts (SC実装)
├── slicing/ (WAVスライシング - SCでも使用)
│   ├── index.ts
│   ├── slice-audio-file.ts
│   ├── slice-cache.ts
│   ├── slice-manager.ts
│   ├── temp-file-manager.ts
│   ├── types.ts
│   └── wav-processor.ts
├── audio-slicer.ts (WAVスライシング - SCでも使用)
└── types.ts (共通型定義 - 必要な部分のみ残す)
```

### 📝 ドキュメント・READMEの更新

1. `test-assets/README.md` - AudioEngineの使用例を削除
2. `docs/` 配下のドキュメント - AudioEngine参照を削除

### 🧪 テスト

- 現在のテストは全てSuperCollider使用
- AudioEngine専用のテストファイルは存在しない
- **影響なし**

## 実施手順

### Step 1: ブランチ作成
```bash
# GitHub Issueを作成
# Issue番号を取得（例: #30）

# ブランチ作成
git checkout develop
git pull origin develop
git checkout -b 30-unify-supercollider-audio-engine
```

### Step 2: ファイル削除
```bash
# Phase 5-1でリファクタリングしたファイル群
rm packages/engine/src/audio/audio-engine.ts
rm -rf packages/engine/src/audio/engine/
rm -rf packages/engine/src/audio/loading/
rm -rf packages/engine/src/audio/playback/

# その他の未使用ファイル
rm packages/engine/src/audio/simple-player.ts
rm packages/engine/src/audio/precision-scheduler.ts
```

### Step 3: import文の修正

#### global.ts
```typescript
// 削除
import { AudioEngine } from '../audio/audio-engine'

// 追加
import { SuperColliderPlayer } from '../audio/supercollider-player'

// 修正
export function createGlobal(audioEngine: SuperColliderPlayer): Global {
  return new Global(audioEngine)
}

// クラス内
private audioEngine: SuperColliderPlayer
```

#### sequence.ts
```typescript
// 削除
import { AudioEngine, AudioFile } from '../audio/audio-engine'

// 追加
import { SuperColliderPlayer } from '../audio/supercollider-player'

// 修正
constructor(global: Global, audioEngine: SuperColliderPlayer) {
  this.global = global
  this.audioEngine = audioEngine
  // ...
}

private audioEngine: SuperColliderPlayer
```

### Step 4: テスト実行
```bash
npm test
# 目標: 115 tests passed | 15 skipped
```

### Step 5: リンターチェック
```bash
npm run lint
# 目標: 0 errors
```

### Step 6: ビルド確認
```bash
npm run build
# エラーなし確認
```

### Step 7: ドキュメント更新

1. `test-assets/README.md` - AudioEngineサンプルコード削除
2. リファクタリングプラン更新 - Phase 5-1の状態を反映

### Step 8: コミット
```bash
git add .
git commit -m "refactor: SuperColliderへのオーディオエンジン一本化

- Web Audio API (AudioEngine)関連ファイルを削除
  - audio-engine.ts および Phase 5-1で作成したモジュール群
  - simple-player.ts, precision-scheduler.ts (未使用)
- Global.tsとSequence.tsの型をSuperColliderPlayerに統一
- WAVスライシング機能は維持（SuperColliderでも使用）
- テスト結果: 115 tests passed | 15 skipped
- リンターエラー: 0件

Closes #30"
```

### Step 9: PR作成
```bash
git push origin 30-unify-supercollider-audio-engine

# GitHub UIでPR作成
# タイトル: "refactor: SuperColliderへのオーディオエンジン一本化"
# 本文: "Closes #30"
```

### Step 10: Phase 5-1のPR (#29) をクローズ

PR #29 (audio-engine.tsリファクタリング) は**マージせずにクローズ**
- 理由: SC一本化により不要
- コメント: "SC一本化により不要となったためクローズ"

## リスク管理

### リスク1: 予期しない依存関係
**軽減策**: 
- 削除前に`grep -r "AudioEngine" packages/` で全検索
- テスト実行で確認

### リスク2: ドキュメントの更新漏れ
**軽減策**: 
- `docs/`配下を全検索
- READMEファイルを確認

### リスク3: VS Code拡張への影響
**軽減策**: 
- `packages/vscode-extension/`でAudioEngine参照を検索
- 拡張機能の動作確認

## 期待される効果

1. **コードベースの削減**: 約1,085行削除
2. **メンテナンス負荷の軽減**: 2つのエンジンから1つへ
3. **パフォーマンス向上**: SC統一による音質・レイテンシ改善
4. **Phase 5-1の作業**: 不要になるが、リファクタリング経験は有益

## 注意事項

- Phase 5-1 (PR #29) はマージしない
- WAVスライシング機能(`audio/slicing/`, `audio-slicer.ts`)は削除しない
- SuperColliderPlayer関連ファイルは一切変更しない