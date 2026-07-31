/**
 * daemon との wire でやり取りする JSON を検証する小さな共有ヘルパ。
 *
 * `rust-engine-player.ts`（受信イベントの検証）と `render-score.ts`（送信 manifest の生成）が
 * 同じ「未知の値を検査してから型を付ける」規約を必要とするため、片方の private ヘルパを
 * もう片方が import する（依存の向きが逆になる）のではなく、両者が依存できる位置に置く。
 */

/**
 * `value` が **plain object** であることを確かめて型を付ける。`null` と配列は拒否する
 * （どちらも `typeof === 'object'` なので、素朴な typeof 検査では通り抜ける）。
 *
 * @param label エラー文言の先頭に置く位置情報（例: `RenderScore.samples[0]`）
 */
export function wireObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`)
  }
  return value as Record<string, unknown>
}
