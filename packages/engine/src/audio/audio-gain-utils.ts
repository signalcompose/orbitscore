/**
 * 音声バックエンド共通のゲイン変換ユーティリティ。
 *
 * dB → linear amplitude の単一情報源。SuperCollider 経路（EventScheduler）と
 * Rust daemon 経路（RustEnginePlayer）の両方がこれを使う。
 */

/**
 * dB ゲインを linear amplitude へ変換する。`amplitude = 10^(dB/20)`。
 * 既定（undefined）= 0 dB = 1.0、`-Infinity` = 完全無音 = 0.0。
 */
export function gainDbToAmplitude(gainDb: number | undefined): number {
  if (gainDb === undefined) return 1.0
  if (gainDb === -Infinity) return 0.0
  return Math.pow(10, gainDb / 20)
}
