# OrbitScore プロジェクト リファクタリング計画

## 現状の問題点

### 1. ビルドシステムの問題
- ✅ **workspace設定は既に存在**（`package.json`に`workspaces`が定義済み）
- ❌ **依存関係が正しくインストールされていない**
  - ルートの`node_modules`が存在しない
  - 各パッケージの`node_modules`も存在しない
- ❌ **TypeScriptコンパイラが見つからない**
  - グローバルインストールされていない
  - ローカルの`node_modules/.bin/tsc`も存在しない

### 2. パッケージ構造の問題
- ⚠️ **VS Code拡張のpackage.json名が重複**
  - `packages/vscode-extension/package.json`の`name`が`"orbitscore"`
  - ルートの`package.json`の`name`も`"orbitscore"`
  - workspaceでは一意な名前が必要（例：`@orbitscore/vscode-extension`）
  
- ⚠️ **CLIの二重実装**
  - `cli.js` - 古いMIDIベース
  - `cli-audio.js` - 新しいオーディオベース
  - どちらを使うべきか不明確

### 3. 依存関係の問題
- ⚠️ **依存関係が分散**
  - `node-web-audio-api`と`wavefile`がルートにある
  - 本来は`@orbitscore/engine`の依存関係であるべき
  
- ⚠️ **TypeScriptが複数箇所に定義**
  - ルート: `"typescript": "^5.9.2"`
  - engine: `"typescript": "^5.4.0"`
  - vscode-extension: `"typescript": "^5.9.3"`

### 4. VS Code拡張の問題
- ❌ **間違ったエンジンを呼び出し**
  - `cli.js`（MIDIベース）を呼び出そうとしている
  - `cli-audio.js`を呼ぶべき
  
- ❌ **コマンド引数が不適切**
  - `play`コマンドが存在しない
  - `eval`コマンドを使うべき

## リファクタリング計画

### Phase 1: 依存関係の整理とインストール（緊急）

#### 1.1 パッケージ名の修正
```json
// packages/vscode-extension/package.json
{
  "name": "@orbitscore/vscode-extension",
  "displayName": "OrbitScore",
  // ...
}
```

#### 1.2 依存関係の移動
```json
// packages/engine/package.json に追加
{
  "dependencies": {
    "@julusian/midi": "^3.0.0",
    "dotenv": "^16.4.5",
    "node-web-audio-api": "^1.0.4",
    "wavefile": "^11.0.0"
  }
}
```

```json
// ルートのpackage.jsonから削除
{
  "dependencies": {}  // 空にする
}
```

#### 1.3 TypeScriptバージョンの統一
全てルートで管理し、各パッケージからは削除：
```json
// ルートのpackage.json
{
  "devDependencies": {
    "typescript": "^5.9.2"  // 最新版に統一
  }
}
```

#### 1.4 クリーンインストール
```bash
# 既存のnode_modulesとロックファイルを削除
rm -rf node_modules package-lock.json
rm -rf packages/*/node_modules packages/*/package-lock.json

# クリーンインストール
npm install
```

### Phase 2: ビルドシステムの統一

#### 2.1 ルートのビルドスクリプト改善
```json
// package.json
{
  "scripts": {
    "clean": "rm -rf packages/*/dist",
    "build": "npm run clean && npm run build:engine && npm run build:extension",
    "build:engine": "npm -w @orbitscore/engine run build",
    "build:extension": "npm -w @orbitscore/vscode-extension run build",
    "dev": "npm run build:engine && npm run build:extension -- --watch",
    "test": "npm -w @orbitscore/engine test",
    "package:extension": "npm -w @orbitscore/vscode-extension run package"
  }
}
```

#### 2.2 拡張のビルドスクリプト追加
```json
// packages/vscode-extension/package.json
{
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "watch": "tsc -p tsconfig.json --watch",
    "package": "vsce package --no-dependencies",
    "install-local": "cursor --install-extension *.vsix"
  },
  "devDependencies": {
    "@types/vscode": "^1.90.0",
    "@vscode/vsce": "^2.22.0"
  }
}
```

### Phase 3: VS Code拡張の修正

#### 3.1 正しいエンジンの呼び出し
```typescript
// packages/vscode-extension/src/extension.ts
const enginePath = path.join(projectRoot, 'packages/engine/dist/cli-audio.js')
const proc = child_process.spawn('node', [enginePath, 'eval', tmpFile, '10'], {
  cwd: projectRoot,
})
```

### Phase 4: 不要ファイルの削除

#### 4.1 古いMIDIベースCLIの廃止
- `packages/engine/src/cli.ts` を削除（または`cli-midi.ts`にリネーム）
- `packages/engine/src/cli-audio.ts` を `cli.ts` にリネーム
- ドキュメント更新

#### 4.2 古いVS Code拡張ファイルの削除
- `packages/vscode-extension/src/extension-old.ts` を削除

### Phase 5: ドキュメントの更新

#### 5.1 README.mdの更新
```markdown
# OrbitScore

## クイックスタート

### インストール
\`\`\`bash
npm install
\`\`\`

### ビルド
\`\`\`bash
npm run build
\`\`\`

### VS Code拡張のインストール
\`\`\`bash
npm run package:extension
cursor --install-extension packages/vscode-extension/*.vsix
\`\`\`

### テスト
\`\`\`bash
npm test
\`\`\`
```

#### 5.2 開発ガイドの作成
- `docs/DEVELOPMENT.md` - 開発環境セットアップ
- `docs/ARCHITECTURE.md` - プロジェクト構造
- `docs/CONTRIBUTING.md` - コントリビューションガイド

## 実装ロードマップ

### ステップ1: 緊急修正（30分）
1. [ ] パッケージ名の修正
2. [ ] 依存関係の移動
3. [ ] TypeScriptバージョン統一
4. [ ] クリーンインストール
5. [ ] ビルド確認

### ステップ2: 拡張機能修正（15分）
1. [ ] VS Code拡張のコード修正
2. [ ] ビルド
3. [ ] パッケージング
4. [ ] インストール
5. [ ] テスト

### ステップ3: クリーンアップ（20分）
1. [ ] 不要ファイル削除
2. [ ] ドキュメント更新
3. [ ] WORK_LOGに記録

## 期待される成果

### 改善されること
- ✅ 一度の`npm install`で全依存関係がインストールされる
- ✅ `npm run build`で全パッケージがビルドされる
- ✅ TypeScriptコンパイラがどこからでも使える
- ✅ VS Code拡張が正しく動作する
- ✅ プロジェクト構造が明確で理解しやすい

### 削減されること
- ❌ 複数の`node_modules`ディレクトリ → 1つのルート`node_modules`に統一
- ❌ 重複した依存関係
- ❌ ビルドコマンドの混乱
- ❌ 不要な古いファイル

## 次のステップ

このリファクタリング計画に同意いただけたら、順次実行していきます。

---

*作成日: 2024年12月25日*
