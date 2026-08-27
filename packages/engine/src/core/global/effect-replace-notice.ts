/**
 * effect 差し替え・削除の経路が出す「**続行する**」通知の唯一の出口。
 *
 * 🔴 **なぜ関数にしてあるか**: 拡張は engine プロセスの stderr を、**内容を一切見ずに**
 * まるごと `ERROR:` を付けて出力チャネルへ流す（`extension.ts` の `setupStderrHandler`）。
 * Node の `console.warn` / `console.error` は stderr へ書くので、**正常に継続する操作を
 * `console.warn` で報告した瞬間に、それは ERROR として記録される**。
 *
 * これは実害のある欠陥で、`af041307`（「正常なプラグイン操作を error として記録するのを
 * やめる」）が直した後、**#625 で 4 回目の再発**をした — 差し替えの復旧経路に足した
 * `console.warn` が、実機 gated E2E の R-E4「復旧は ERROR 行を増やさない」を落とした。
 *
 * Rust 側は同じ轍を `8258c40a` で `orbit_child_runtime::notice` に集約して塞いだ。これは
 * その TS 版である。**呼び出し側が stream を選べないことが、この関数の存在理由そのもの**
 * なので、ここを `console.warn` に書き換えたり、呼び出し側で直接 `console.warn` を使ったり
 * しないこと（`effect-replace-notice.spec.ts` がそれを固定している）。
 *
 * 注意: これは「警告を握りつぶす」ための関数ではない。⚠️ マーカーは残るのでログ上は依然
 * として目立つ。変えているのは**深刻度の分類**だけで、**本当に失敗して中止する経路は
 * throw する**（この関数を通らない）。
 */
export function effectReplaceNotice(message: string): void {
  console.log(`[effect-replace] ⚠️ ${message}`)
}
