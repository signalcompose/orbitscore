# OrbitScore 音声テストセットアップガイド

## 概要

このガイドでは、OrbitScoreの音声テスト環境のセットアップ方法と、2種類のテスト方法について説明します。

## テストの種類

### 1. エージェント実行テスト（AI実行型）
- **目的**: AIエージェントが実行し、ユーザーが音を聞いて確認
- **用途**: 実装の検証、リグレッションテスト
- **特徴**: 自動実行、期待値の事前説明、結果の確認

### 2. ライブコーディングテスト（手動実行型）
- **目的**: ユーザーが実際にライブコーディングを行い、機能を確認
- **用途**: ライブパフォーマンスの動作確認、UX検証
- **特徴**: 対話的、リアルタイム変更、実戦的な確認

## 前提条件

### システム要件
- Node.js v22.0.0以上
- SuperCollider（オーディオエンジン）
- VS Code または Cursor
- オーディオデバイス（スピーカーまたはヘッドフォン）

### SuperColliderのインストール

**macOS:**
```bash
brew install --cask supercollider
```

**Linux:**
```bash
sudo apt-get install supercollider
```

**Windows:**
- [SuperCollider公式サイト](https://supercollider.github.io/)からダウンロード

### SuperColliderの起動確認

```bash
# macOS: SuperColliderの場所を確認
ls -la /Applications/SuperCollider.app

# scsynthの場所を確認
find /Applications/SuperCollider.app -name scsynth -type f
```

### SynthDefの準備

OrbitScoreでは、専用のSynthDef（シンセサイザー定義）を使用します。
既にコンパイル済みの`.scsyndef`ファイルが用意されているので、通常はそのまま使えます：

```bash
# SynthDefファイルの確認
ls -la packages/engine/supercollider/synthdefs/
# orbitPlayBuf.scsyndef    - メイン再生エンジン
# fxCompressor.scsyndef    - コンプレッサー
# fxLimiter.scsyndef       - リミッター
# fxNormalizer.scsyndef    - ノーマライザー
```

**SynthDefの再ビルドが必要な場合：**

```bash
cd packages/engine/supercollider

# 既存のsclangプロセスを終了
killall sclang 2>/dev/null

# SynthDefをビルド（macOS）
/Applications/SuperCollider.app/Contents/MacOS/sclang setup.scd

# 成功メッセージを確認
# ✅ All SynthDefs saved! が表示されればOK
```

## セットアップ手順

### Step 1: プロジェクトのビルド

```bash
# プロジェクトルートに移動
cd /Users/yamato/Src/proj_livecoding/orbitscore

# Engineパッケージのビルド
cd packages/engine
npm install
npm run build

# VSCode拡張機能のビルド
cd ../vscode-extension
npm install
npm run build
```

### Step 2: VSCode拡張機能のインストール

#### 方法A: 開発モード（推奨 - デバッグ可能）

1. VS Codeで`packages/vscode-extension`フォルダを開く
2. `F5`キーを押す
3. 新しいVS Codeウィンドウ（Extension Development Host）が開く

#### 方法B: パッケージインストール

```bash
cd packages/vscode-extension

# パッケージ化
npx vsce package

# インストール
# VS Codeで Cmd+Shift+P → "Install from VSIX..." → 生成された.vsixファイルを選択
```

### Step 3: テストファイルの準備

テストファイルは`examples/`ディレクトリに用意されています：

```bash
ls examples/*.osc
```

主なテストファイル：
- `01_getting_started.osc` - 基本動作確認
- `05_drum_patterns_simple.osc` - ドラムパターン
- `07_audio_control.osc` - 音量・パン制御
- `08_timing_verification.osc` - タイミング精度検証

## エージェント実行テスト（Type 1）

### テスト実行手順

AIエージェントが以下の手順でテストを実行します：

1. **テスト内容の事前説明**
   - 使用する音声ファイル
   - `chop(n)`による分割数
   - `play()`による再生順序
   - 期待される音の流れ
   - 再生時間の目安

2. **コマンド実行**
   - CLIを使用した実行
   - または、VSCode拡張機能を使用した実行

3. **結果確認**
   - ユーザーに「期待通りに聞こえましたか？」と確認

### CLIでの実行例

```bash
# Engineディレクトリに移動
cd packages/engine

# 基本的な実行
node dist/cli-audio.js ../../examples/01_getting_started.osc

# デバッグモード（詳細ログ）
DEBUG=orbitscore:* node dist/cli-audio.js ../../examples/01_getting_started.osc
```

### VSCode拡張機能での実行例

1. `.osc`ファイルを開く
2. ステータスバーをクリック → "🚀 Start Engine"
3. ファイル全体を選択して`Cmd+Enter`で実行

## ライブコーディングテスト（Type 2）

### テスト実行手順

ユーザーが実際にライブコーディングを行います：

### Step 1: エンジン起動

1. VS CodeでOrbitScoreプロジェクトを開く
2. `.osc`ファイルを開く（例：`examples/live-demo.osc`）
3. ステータスバーをクリック
   - **通常モード**: 🚀 Start Engine
   - **デバッグモード**: 🐛 Start Engine (Debug)

### Step 2: オーディオデバイス選択（オプション）

ステータスバーをクリック → "🔊 Select Audio Device"

### Step 3: ライブコーディング

基本的なワークフロー：

```orbitscore
// 1. 定義を書く
var global = init GLOBAL { bpm: 120 }

let kick = new Sequence("kick")
  .beat("x___")
  .length("1/4")
  .audio("test-assets/audio/kick.wav")
  .chop(1)
  .play("1")

// 2. 保存（Cmd+S）- 定義が評価される

// 3. 実行コマンドを選択して実行（Cmd+Enter）
global.start()
kick.loop()

// 4. パラメータを変更して再度Cmd+Enter
kick.gain(6)  // 音量を上げる
kick.pan(-50) // 左に寄せる

// 5. 停止
kick.stop()
global.stop()
```

### Step 4: 確認項目

- [ ] エンジンが正常に起動する
- [ ] 定義が正しく評価される（エラーが出ない）
- [ ] 音が期待通りに鳴る
- [ ] パラメータ変更がリアルタイムに反映される
- [ ] 停止コマンドが正しく動作する
- [ ] 複数シーケンスの同時実行が可能
- [ ] エラーメッセージが適切に表示される

## トラブルシューティング

### エンジンが起動しない

**症状**: "Engine not found" エラー

**解決策**:
```bash
cd packages/engine
npm run build
```

### SuperColliderサーバーが起動しない

**症状**: "Could not connect to SuperCollider" エラー

**解決策**:
1. SuperColliderがインストールされているか確認
2. ポート57110が使用されていないか確認
```bash
lsof -i :57110
```
3. 手動でSuperColliderサーバーを起動してテスト
```bash
scsynth -u 57110
```

### 音が出ない

**症状**: エラーは出ないが音が聞こえない

**解決策**:
1. オーディオデバイスの音量を確認
2. 正しいオーディオデバイスが選択されているか確認
3. 音声ファイルのパスが正しいか確認
4. デバッグモードで詳細ログを確認

### パスエラー

**症状**: "File not found" エラー

**解決策**:
- 音声ファイルのパスを環境に合わせて変更
- 絶対パスまたはプロジェクトルートからの相対パスを使用

```orbitscore
// 相対パス（プロジェクトルートから）
.audio("test-assets/audio/kick.wav")

// 絶対パス
.audio("/Users/yamato/Src/proj_livecoding/orbitscore/test-assets/audio/kick.wav")
```

## テストケース例

### 基本的な音出しテスト

```orbitscore
var global = init GLOBAL { bpm: 120 }

// シンプルなキックドラム
let kick = new Sequence("kick")
  .beat("x___")
  .length("1/4")
  .audio("test-assets/audio/kick.wav")
  .chop(1)
  .play("1")

global.start()
kick.loop()
```

期待される結果：
- 120 BPMで4拍子のキック（1拍ごと）が聞こえる
- リズムが安定している
- 音量が適切

### Chopテスト

```orbitscore
var global = init GLOBAL { bpm: 120 }

// アルペジオを4分割して順番に再生
let arp = new Sequence("arp")
  .beat("xxxx")
  .length("1/16")
  .audio("test-assets/audio/arpeggio_c.wav")
  .chop(4)
  .play("1 2 3 4")

global.start()
arp.loop()
```

期待される結果：
- アルペジオが4つのスライスに分割される
- 各スライスが順番に再生される（1→2→3→4）
- タイミングが正確（16分音符ごと）

### Gain/Pan テスト

```orbitscore
var global = init GLOBAL { bpm: 120 }

let kick = new Sequence("kick")
  .beat("x___")
  .length("1/4")
  .audio("test-assets/audio/kick.wav")
  .chop(1)
  .play("1")
  .gain(-6)   // -6 dB（少し小さく）
  .pan(-50)   // 左寄り

global.start()
kick.loop()

// リアルタイムで変更
kick.gain(6)  // +6 dB（大きく）
kick.pan(50)  // 右寄り
```

期待される結果：
- 音量が変更される（-6 dB → +6 dB）
- ステレオ位置が変わる（左 → 右）
- 変更が即座に反映される

## パフォーマンステスト

より高度なテストは`docs/PERFORMANCE_TEST_GUIDE.md`を参照してください：

- ポリメーター（異なる拍子）
- ポリテンポ（異なるBPM）
- ネストされたリズム（最大11レベル）
- マルチトラック（20トラック以上）

## 次のステップ

- [ ] 基本的な音出しテストを実行
- [ ] Chopテストを実行
- [ ] Gain/Panテストを実行
- [ ] ライブコーディングでのリアルタイム変更テスト
- [ ] パフォーマンステストの実行

## 関連ドキュメント

- [PERFORMANCE_TEST_GUIDE.md](PERFORMANCE_TEST_GUIDE.md) - パフォーマンステストの詳細
- [INSTRUCTION_ORBITSCORE_DSL.md](INSTRUCTION_ORBITSCORE_DSL.md) - DSL仕様
- [BUILD_GUIDE.md](../packages/vscode-extension/BUILD_GUIDE.md) - ビルド手順
- [Examples README](../examples/README.md) - サンプルファイルの説明
