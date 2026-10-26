# packages/session — 層 2（セッション）

設計: [`docs/design/848-native-orbitstudio-design.md`](../../docs/design/848-native-orbitstudio-design.md) §3・§4・§8。ここには**この層に置かないもの**だけを書く（置くものは設計 §3 の表）。

## この層に置かないもの

- **描画・ウィンドウ・ファイルの open / save・キーバインド・IME**（層 3。`vscode` も `AppKit` も import しない）
- **DSL の意味論の新しい実装**。DSL の解釈は `packages/engine` の 1 か所（設計 §10.3）。ここは engine を出力のパス（`@orbitscore/engine/dist/<module>`）で import して呼ぶだけ
- **`packages/engine` への新しいファイル**（凍結版の `.vsix` に入る `engine/dist` を増やさない・設計 §4.5.1）。engine に barrel（`src/index.ts`）も足さない
- **凍結版への変更**: `packages/vscode-extension/**` と `packages/engine/src/cli/repl-mode.ts` は触らない（設計 §10.3・F-10）
- **GUI だけの近道**。GUI が呼ぶ RPC メソッドは MCP からも届くこと（D-4）
- **最終形でないまま動くものを、台帳に載せずに置くこと**。暫定物は同じ PR で `tests/repo/native-provisional-ledger.ts` に行を足し、コードに台帳の ID つきの `PROVISIONAL` の印を置く（文法は設計 §1.4.2。この文書に文法の実例を書くと検査が拾う）
