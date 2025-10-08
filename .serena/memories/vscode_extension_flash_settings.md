# VSCode拡張機能 - フラッシュ設定機能

## 概要

OrbitScore VSCode拡張機能に、コード実行時の視覚的フィードバック（フラッシュ）をカスタマイズする機能を実装しました。

## 実装した機能

### 1. 設定項目（package.json）

```json
"configuration": {
  "title": "OrbitScore",
  "properties": {
    "orbitscore.flashCount": {
      "type": "number",
      "default": 2,
      "minimum": 1,
      "maximum": 5,
      "description": "Number of times to flash executed lines",
      "format": "integer"
    },
    "orbitscore.flashDuration": {
      "type": "number", 
      "default": 150,
      "minimum": 50,
      "maximum": 500,
      "description": "Duration of each flash in milliseconds",
      "format": "integer"
    },
    "orbitscore.flashColor": {
      "type": "string",
      "enum": ["selection", "error", "warning", "info", "custom"],
      "default": "selection",
      "description": "Color theme for line flash"
    },
    "orbitscore.flashCustomColor": {
      "type": "string",
      "default": "#ff6b6b",
      "description": "Custom flash color (hex format, e.g., #ff6b6b)",
      "format": "color-hex"
    },
    "orbitscore.flashOpacity": {
      "type": "number",
      "default": 1.0,
      "minimum": 0.1,
      "maximum": 1.0,
      "description": "Flash opacity (0.1 = 10% transparent, 1.0 = fully opaque)",
      "format": "percent"
    }
  }
}
```

### 2. コマンド（⚡ Configure Flash Settings）

拡張機能内で設定を変更できるコマンドを実装：

- フラッシュ回数設定（1-5回）
- 持続時間設定（50-500ms）
- 色テーマ選択（selection/error/warning/info/custom）
- カスタム色入力（HEX形式）
- 透明度設定（10-100%）
- テスト機能（現在の設定でプレビュー）

### 3. フラッシュ実装

`runSelection()` 関数で実行時にフラッシュを表示：

```typescript
// Visual feedback: flash the executed lines (configurable)
const flashLines = () => {
  const config = vscode.workspace.getConfiguration('orbitscore')
  const flashCount = config.get<number>('flashCount', 2)
  const flashDuration = config.get<number>('flashDuration', 150)
  const flashColor = config.get<string>('flashColor', 'selection')
  const flashCustomColor = config.get<string>('flashCustomColor', '#ff6b6b')
  const flashOpacity = config.get<number>('flashOpacity', 1.0)
  
  // 色と透明度の処理
  // フラッシュ実行ロジック
}
```

## 使用方法

### 方法1: VSCode設定画面
1. `Cmd + ,` で設定を開く
2. 検索ボックスに "OrbitScore" と入力
3. 各設定項目を変更（format指定により適切なUIが表示）

### 方法2: 拡張機能コマンド
1. ステータスバーの OrbitScore をクリック
2. "⚡ Configure Flash" を選択
3. インタラクティブな設定画面で変更

## 技術的な学び

### VSCode拡張機能設定の仕様
- **拡張機能ページの「FEATURES > Settings」**: 設定の一覧表示のみ（編集不可）
- **実際の編集**: `Cmd + ,` の設定パネルで行う
- **format指定**: `"format": "integer"`, `"format": "percent"`, `"format": "color-hex"` により適切なUIが表示される

### 設定の反映
- 設定変更は即座に反映される
- `vscode.workspace.getConfiguration()` で現在の設定値を取得
- 設定変更は `config.update()` で保存

## 今後の改善点

- フラッシュパターンの追加（フェードイン/アウト、パルスなど）
- 音声フィードバックの追加
- フラッシュ範囲のカスタマイズ（行全体 vs 選択範囲）

## 関連ファイル

- `packages/vscode-extension/package.json` - 設定定義
- `packages/vscode-extension/src/extension.ts` - 実装
- `packages/engine/src/core/sequence.ts` - ログメッセージ追加