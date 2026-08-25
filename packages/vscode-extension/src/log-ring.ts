/**
 * `get_log` が返す行の選択ロジック（vscode 非依存の純関数）。
 *
 * 🔴 #567: 以前は `extension.ts` の中で要求値を**黙って** 500 行へ切り詰めていた。
 *
 * `get_log` はエンジン側のエラーが現れる**唯一のチャネル**である
 * （`evaluate_orbitscore` の `ok` は「stdin へ書けた」しか意味しない）。そこで黙って
 * 捨てると、呼び出し元は「その範囲にエラーが無かった」のか「範囲を狭められた」のかを
 * 区別できない。ERROR 件数の前後比較は窓が固定だと単調でなく、古い ERROR が窓から
 * 流れ出るのと同時に新しい ERROR が入ると**カウントが一致して false green** になる。
 *
 * 対策は2つ:
 *  1. 上限をリングの実容量まで引き上げる（500 に留める理由が無い）
 *  2. **切り詰めたことを応答に含める**（silent truncation をやめる）
 *
 * vscode に依存しない純関数として切り出してあるのは、**テストが実コードを通せる**
 * ようにするため（`extension.ts` の非 export 関数のままでは駆動できない）。
 */

/** 出力チャネルのリングバッファが保持する最大行数。 */
export const OUTPUT_LOG_RING_MAX = 1000

/** `lines` が指定されなかった場合の既定行数。 */
export const DEFAULT_LOG_LINES = 50

/**
 * リングバッファから末尾 N 行を選ぶ。要求がリング容量を超えた場合は、
 * **先頭に明示的な truncated 通知を1行付けて返す**。
 *
 * 通知文言は `ERROR` 等の既存マーカーと衝突しない語を使うこと
 * （呼び出し側のカウント系 assert を汚さないため）。
 */
export function selectLogLines(ring: readonly string[], requested?: number): string[] {
  const want = requested ?? DEFAULT_LOG_LINES
  const n = Math.max(1, Math.min(want, OUTPUT_LOG_RING_MAX))
  const out = ring.slice(-n)
  if (want > OUTPUT_LOG_RING_MAX) {
    return [
      `[get_log] truncated: requested ${want} lines, ring buffer holds at most ` +
        `${OUTPUT_LOG_RING_MAX}; returning ${out.length}.`,
      ...out,
    ]
  }
  return out
}
