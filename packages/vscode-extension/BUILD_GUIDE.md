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

### 4. scsynth bundle の抽出 (リリース時のみ)

`.vsix` 配布版には scsynth バイナリ + plugins + libsndfile.dylib (~11.5 MB)
を同梱します。

**Strict mode (Issue #136)**: resolver は SC.app / Spotlight への暗黙
fallback を持ちません。bundle が無ければ `ScsynthNotFoundError` で fail loud
します。これは "SC が無い環境で `.vsix` install するだけで動く" を保証する
ための意図的な設計です (silent fallback があると bundle 抽出失敗を SC.app
が肩代わりして production の不具合を隠蔽するリスクがあるため)。

**Dev workflow への影響**:
- vscode-extension 経由 (通常 user): bundle 同梱で何もしなくて OK
- engine 単独 CLI で SC.app に依存している dev:
  ```bash
  ORBIT_SCSYNTH_PATH=/Applications/SuperCollider.app/Contents/Resources/scsynth \
    npm run dev:engine
  ```
  または `build:bundle` で bundle を抽出してから実行

```bash
# SC.app から抽出 (default: SC.app 不在時 fail-fast)
cd packages/vscode-extension
npm run build:bundle

# dev で SC.app が無い場合は warning + skip
bash ../../scripts/extract-scsynth-bundle.sh --allow-skip

# 抽出後の検証 (構造、universal binary、codesign、plugin count 等)
npm run verify:bundle
```

抽出される構造:
```
packages/vscode-extension/engine/scsynth/
├── Contents/
│   ├── Resources/
│   │   ├── scsynth                (1.5 MB, universal arm64+x86_64)
│   │   └── plugins/               (26 .scx ファイル、5.1 MB)
│   └── Frameworks/
│       └── libsndfile.dylib       (4.9 MB)
├── LICENSE.GPL-3.0                (legal/scsynth-LICENSE.GPL-3.0 から copy)
└── NOTICE                          (legal/scsynth-NOTICE から copy)
```

詳細: [`docs/research/SCSYNTH_BUNDLE_MANIFEST.md`](../../docs/research/SCSYNTH_BUNDLE_MANIFEST.md)

### 5. パッケージ化

```bash
# build → bundle 抽出 → vsce package の順で実行
npm run build
npm run build:bundle
npx vsce package
```

## パッケージサイズの最適化

### 現在の設定

`.vscodeignore`ファイルで以下のファイルを除外しています：

- TypeScriptソースファイル（`**/*.ts`）
- 型定義ファイル（`**/*.d.ts`）
- ソースマップ（`**/*.map`）
- Engineのpackage.json/package-lock.json（ビルド時の一時ファイル）

### 含まれるファイル

- ビルド済みJavaScriptファイル（`dist/`）
- Engineのビルド済みファイル（`engine/dist/`）
- Engineのランタイム依存（`engine/node_modules/` - supercolliderjs, wavefile）
- SuperColliderファイル（`engine/supercollider/`）
- 構文ハイライトファイル（`syntaxes/`）
- 言語設定ファイル（`language-configuration.json`）

### パッケージサイズ

- engine のみ: 約 3.3 MB（2458ファイル）
- scsynth bundle 同梱版: 約 14.8 MB (上記 + scsynth/plugins/libsndfile)
- `engine/node_modules` を含む（supercolliderjs + wavefile のランタイム依存）

### scsynth bundle ディレクトリの取り扱い

`packages/vscode-extension/engine/` は root `.gitignore:36` で無視されており、
bundle (`engine/scsynth/`) も git 管理外です。CI / release pipeline で
`build:bundle` を実行して都度生成します。

LICENSE.GPL-3.0 と NOTICE のテンプレートは git 管理 (`packages/vscode-extension/legal/`)
で、`extract-scsynth-bundle.sh` が bundle dir に copy します。

### Engineランタイム依存の管理

`build:engine` スクリプト実行時に `scripts/install-engine-deps.sh` が自動的に：

1. `engine/` ディレクトリにランタイム依存（supercolliderjs, wavefile）をインストール
2. supercolliderjs のブートタイムアウトパッチを適用（3s → 30s）

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

2. **`Cannot find module 'supercolliderjs'`**
   - `npm run build:engine` を再実行して `engine/node_modules` にランタイム依存をインストール
   - `npx vsce package` で再パッケージ → `code --install-extension *.vsix --force` で再インストール

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
├── engine/                # Engineパッケージ
│   ├── dist/             # ビルド済みEngine
│   ├── node_modules/     # ランタイム依存（supercolliderjs, wavefile）
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
