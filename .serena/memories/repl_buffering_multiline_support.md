# REPLモードのバッファリングとマルチライン対応

## 問題

VSCode拡張から複数行のコード（改行を含む`play()`等）を送信すると、REPLモードが各行を個別に処理してパーサーエラーが発生していた。

## 原因

Node.jsの`readline`インターフェースの`line`イベントは、**各行の末尾の改行を除去した状態で個別に発火**する。そのため、以下のような複数行の文は分割されて処理される：

```javascript
arp.play(     // 1回目のlineイベント
  1,          // 2回目のlineイベント
  2,          // 3回目のlineイベント
  3,          // 4回目のlineイベント
  4           // 5回目のlineイベント
)             // 6回目のlineイベント
```

各行を個別にパースすると`Expected RPAREN but got EOF`などのエラーが発生する。

## 解決策

`repl-mode.ts`にバッファリングロジックを実装：

1. **各行をバッファに蓄積**
   - `buffer += line + '\n'`で改行を保持

2. **毎回パースを試行**
   - バッファ全体を`parseAudioDSL(buffer.trim())`でパース
   - 成功したら実行してバッファをクリア
   - **不完全な入力エラーが出たら継続バッファリング**

3. **不完全な入力の検出**
   - `error.message.includes('EOF')`
   - `error.message.includes('Expected RPAREN')`
   - `error.message.includes('Expected comma or closing parenthesis')`
   - これらのエラーは「まだ入力が続いている」ことを示す

4. **フォールバック: 連続空行**
   - 2行以上の連続空行で強制実行（念のため）

## 重要ポイント

- **パーサーエラーメッセージを利用**: エラー内容から入力の完全性を判断
- **改行の保持**: `line + '\n'`で改行を明示的に追加
- **デバッグログ**: `ORBITSCORE_DEBUG`環境変数で詳細ログを制御

## 関連ファイル

- `packages/engine/src/cli/repl-mode.ts`: バッファリングロジック実装
- `packages/vscode-extension/src/extension.ts`: VSCode拡張のフィルタリング改善（`global.*`設定保持、`start`をトランスポートコマンドに追加）