# OrbitScore はじめに

**OrbitScore オーディオベースライブコーディングDSLのクイックスタートガイド**

## 前提条件

始める前に、以下を用意してください：

- **macOS**（主要サポート）
- **Node.js** v22.0.0以上
- **SuperCollider**（オーディオエンジン）
- **VS Code、Cursor、またはClaude Code**（推奨エディタ）

## ステップ1: SuperColliderのインストール

SuperColliderはオーディオ再生に必要です。

### macOS
```bash
brew install --cask supercollider
```

### Linux
```bash
sudo apt-get install supercollider
```

### Windows
[SuperCollider公式サイト](https://supercollider.github.io/)からダウンロード

## ステップ2: OrbitScoreのクローンとビルド

```bash
# リポジトリをクローン
git clone https://github.com/yourusername/orbitscore.git
cd orbitscore

# 依存関係のインストールとビルド
npm install
npm run build
```

## ステップ3: SynthDefのビルド

SynthDefはSuperCollider統合に必要です。

```bash
# supercolliderディレクトリへ移動
cd packages/engine/supercollider

# 既存のsclangプロセスを停止
pkill sclang

# SynthDefをビルド
./build-synthdefs.sh
```

**期待される出力**: `✅ All SynthDefs saved!`

## ステップ4: VS Code拡張機能のインストール（オプション）

VS Code/Cursor/Claude Codeでのライブコーディングに使用：

```bash
cd packages/vscode-extension
npm install
npm run build

# 拡張機能をインストール
code --install-extension orbitscore-0.0.1.vsix
```

## ステップ5: インストールの確認

テストファイル `test.osc` を作成：

```osc
var global = init GLOBAL
global.tempo(120)
global.beat(4 by 4)
global.audioPath("../test-assets/audio")
global.start()

var kick = init global.seq
kick.audio("kick.wav")
kick.play(1, 0, 1, 0)

LOOP(kick)
```

### CLIで実行

```bash
cd packages/engine
npm run cli -- /path/to/test.osc
```

### VS Codeで実行

1. VS Codeで `test.osc` を開く
2. すべての行を選択
3. **Cmd+Enter**（Mac）または **Ctrl+Enter**（Linux/Windows）を押す
4. キックドラムが再生されます

## ステップ6: サンプルを試す

`examples/` ディレクトリのサンプルファイルを確認：

```bash
cd examples
ls *.osc
```

推奨サンプル：
- `01_hello_world.osc` - 基本的な使い方
- `09_reserved_keywords.osc` - トランスポート制御
- `performance-demo.osc` - 高度な機能

## 次のステップ

- [ユーザーマニュアル](./USER_MANUAL.md)で詳細な構文ガイドを確認
- [DSL仕様書](../../core/INSTRUCTION_ORBITSCORE_DSL.md)で完全な言語リファレンスを確認
- [テストガイド](../../testing/TESTING_GUIDE.md)でテスト手順を確認

## トラブルシューティング

### 問題: オーディオが出力されない

**解決方法**:
1. SuperColliderがインストールされているか確認: `which scsynth`
2. オーディオファイルが存在するか確認: `ls test-assets/audio/*.wav`
3. グローバルスケジューラーを再起動: `global.stop()` → `global.start()`

### 問題: Cmd+Enterが動作しない

**解決方法**:
1. ファイルに `.osc` 拡張子があるか確認
2. VS Codeを再起動
3. コマンドパレットを使用: "OrbitScore: Run Selection"

### 問題: SynthDefビルドが失敗

**解決方法**:
1. sclangが実行されていないことを確認: `pkill sclang`
2. SuperColliderが正しくインストールされているか確認
3. ビルドスクリプトを再実行

## 追加リソース

- [SuperColliderドキュメント](https://doc.sccode.org/)
- [OrbitScore GitHub](https://github.com/yourusername/orbitscore)
- [Issue Tracker](https://github.com/yourusername/orbitscore/issues)

---

English version: [Getting Started (English)](../en/GETTING_STARTED.md)
