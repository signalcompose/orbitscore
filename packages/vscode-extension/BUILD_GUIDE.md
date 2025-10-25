# OrbitScore VSCode Extension Build Guide

## 概要

このドキュメントは、OrbitScore VSCode拡張機能のビルドとパッケージ化の手順を説明します。

## 前提条件

- Node.js v22.0.0以上
- npm
- VS Code Extension Manager (`@vscode/vsce`)

## ビルド手順

### 1. 依存関係のインストール

```bash
cd packages/vscode-extension
npm install
```

### 2. Engineパッケージのビルド

VSCode拡張はengineパッケージに依存しているため、先にengineをビルドする必要があります：

```bash
# プロジェクトルートから
cd packages/engine
npm run build
```

### 3. VSCode拡張のビルド

```bash
cd packages/vscode-extension
npm run build
```

### 4. パッケージ化

```bash
npx vsce package
```

## パッケージサイズの最適化

### 現在の設定

`.vscodeignore`ファイルで以下のファイルを除外しています：

- TypeScriptソースファイル（`**/*.ts`）
- 型定義ファイル（`**/*.d.ts`）
- ソースマップ（`**/*.map`）
- Engineのnode_modules（`engine/node_modules/**`）
- Engineのpackage.json/package-lock.json

### 含まれるファイル

- ビルド済みJavaScriptファイル（`dist/`）
- Engineのビルド済みファイル（`engine/dist/`）
- SuperColliderファイル（`engine/supercollider/`）
- 構文ハイライトファイル（`syntaxes/`）
- 言語設定ファイル（`language-configuration.json`）

### パッケージサイズ

- **最適化前**: 24.49 MB（2685ファイル）
- **最適化後**: 93.18 KB（67ファイル）

## 開発時のビルド

### ウォッチモード

```bash
npm run dev
```

このコマンドは`tsc -w`を実行し、ファイル変更を監視して自動的に再ビルドします。

### 手動ビルド

```bash
npm run build
```

## トラブルシューティング

### よくある問題

1. **Engineが見つからない**
   ```
   Engine not found: /path/to/engine/dist/cli-audio.js
   ```
   - 解決策: `packages/engine`で`npm run build`を実行

2. **パッケージサイズが大きい**
   - `.vscodeignore`の設定を確認
   - `engine/node_modules`が除外されているか確認

3. **TypeScriptエラー**
   - `tsconfig.json`の設定を確認
   - 依存関係が正しくインストールされているか確認

### デバッグ

拡張機能のデバッグは、VS Codeの拡張機能開発ホストで行います：

1. VS Codeで`packages/vscode-extension`を開く
2. F5キーを押して拡張機能開発ホストを起動
3. 新しいVS Codeウィンドウで拡張機能をテスト

## リリース手順

### バージョン更新

1. `package.json`の`version`フィールドを更新
2. ビルドとパッケージ化を実行
3. 生成された`.vsix`ファイルをテスト

### パッケージの配布

```bash
# パッケージ化
npx vsce package

# 生成されたファイル
ls -la *.vsix
```

## ファイル構成

```
packages/vscode-extension/
├── src/                    # TypeScriptソース
│   ├── extension.ts       # メイン拡張機能
│   └── completion-context.ts # コード補完
├── dist/                  # ビルド済みJavaScript
├── syntaxes/              # 構文ハイライト
├── engine/                # Engineパッケージ（必要な部分のみ）
│   ├── dist/             # ビルド済みEngine
│   └── supercollider/    # SuperColliderファイル
├── package.json          # 拡張機能設定
├── tsconfig.json         # TypeScript設定
├── .vscodeignore        # パッケージ除外設定
└── BUILD_GUIDE.md       # このファイル
```

## 注意事項

- Engineパッケージの変更後は、必ずVSCode拡張も再ビルドしてください
- パッケージサイズを監視し、不要なファイルが含まれていないか確認してください
- 新しい依存関係を追加する際は、`.vscodeignore`の更新を検討してください
