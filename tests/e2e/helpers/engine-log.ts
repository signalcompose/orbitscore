/**
 * `get_log` の判定（#668 設計 §4.4）。
 *
 * 🔴 なぜ 1 本にまとめるか: `countErrors` が `orbitstudio-mcp-gated.spec.ts` に **7 箇所**
 * 別々に定義されていた（`:496, 2144, 2722, 3155, 3461, 3969, 4464`。うち `:2144` だけは
 * ローカル定義の `countLogMarker` 経由）。ここへ寄せて 1 本にする（PR-E2）。
 *
 * ERROR 件数の判定は常に `<=`（等価にしない）。理由は `LOG_WINDOW_LINES` の窓固定にある —
 * `gated-assertion-hygiene.spec.ts` がこの規律を機械で守る。
 */
import { expect } from 'vitest'

import type { McpClient } from './mcp-client'

/** `get_log` が返す固定窓（#625）。古い ERROR 行はこの窓の外へスクロールアウトするだけで、
 * 消えたことの証明にはならない — 厳密等価をここより外へ書かない理由。 */
export const LOG_WINDOW_LINES = 500

/**
 * ログ文字列中で `marker` に一致する箇所の件数。
 *
 * 文字列 marker は `split(marker).length - 1`（既存の `errorPrefix` 系イディオムと同型）、
 * 正規表現 marker は `match` の件数（`g` フラグが無ければ補う）。
 */
export function countLogMarker(log: string, marker: string | RegExp): number {
  if (typeof marker === 'string') {
    if (marker.length === 0) return 0
    return log.split(marker).length - 1
  }
  const flags = marker.flags.includes('g') ? marker.flags : `${marker.flags}g`
  return (log.match(new RegExp(marker.source, flags)) ?? []).length
}

/** ERROR 行の件数。gated E2E 全体で共有する判定（7 重定義の統合先）。 */
export function countErrors(log: string): number {
  return countLogMarker(log, /ERROR:/g)
}

/** 現在の ERROR 件数のスナップショット。差分で語るための起点（`errorsBefore` の一般化）。 */
export async function errorBaseline(client: McpClient): Promise<number> {
  const log = (await client.call('get_log', { lines: LOG_WINDOW_LINES })).text
  return countErrors(log)
}

/**
 * 「この操作は ERROR を増やさなかった」。
 *
 * 🔴 等価比較にしない（`gated-assertion-hygiene.spec.ts` が機械で禁じている）。窓の外へ
 * 流れた古い ERROR は消えたわけではないので、`===` にすると嘘をつく。
 */
export async function expectNoNewErrors(
  client: McpClient,
  baseline: number,
  label: string,
): Promise<void> {
  const log = (await client.call('get_log', { lines: LOG_WINDOW_LINES })).text
  const current = countErrors(log)
  expect(
    current,
    `${label} must add no ERROR lines. Log tail: ${log.slice(-1600)}`,
  ).toBeLessThanOrEqual(baseline)
}

/** 「この文言が少なくとも n 回出た」。マーカーの `>=` 判定（`startR28Engine` の `markerCount` の一般化）。 */
export async function expectLogMarkerAtLeast(
  client: McpClient,
  marker: string | RegExp,
  atLeast: number,
  label: string,
): Promise<void> {
  const log = (await client.call('get_log', { lines: LOG_WINDOW_LINES })).text
  const count = countLogMarker(log, marker)
  expect(count, `${label}. Log tail: ${log.slice(-1600)}`).toBeGreaterThanOrEqual(atLeast)
}
