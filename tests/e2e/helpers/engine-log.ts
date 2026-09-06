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
 * 直前のスナップショット以降に**新しく現れた ERROR 行**を返す。
 *
 * 🔴 件数比較（`countErrors`）は `LOG_WINDOW_LINES` の窓がずれるだけで動く。ログ量が増える操作
 * （区間キャプチャを足す等）を挟むと、**新しい ERROR が 1 行も無くても件数が変わりうる**。
 * 2026-09-05 に #661 D-3 がこれで落ちた（`expected 6 to be less than or equal to 5`）。
 *
 * 「何件増えたか」ではなく「**どの行が増えたか**」で語れば、窓のずれに影響されず、かつ
 * 「想定した 1 件以外は増えていない」という**より強い主張**ができる。
 */
export function newErrorLines(before: string, after: string): readonly string[] {
  return newLogLines(before, after).filter((line) => line.includes('ERROR:'))
}

/**
 * 直前のスナップショット以降に**新しく現れた行**（`ERROR:` に限らない）。
 *
 * 🔴 なぜ `newErrorLines` と分けるか: 拡張は engine の stderr を
 * `outputChannel.append('ERROR: ' + chunk)` と **chunk 単位**で前置する
 * （`packages/vscode-extension/src/extension.ts` の `setupStderrHandler`）。同じ chunk に 2 行
 * 入ると 2 行目以降に `ERROR:` が付かない。したがって
 *
 * - **除外**の判定（「他に ERROR が増えていない」）に `newErrorLines` を使うと**偽緑**方向
 * - **包含**の判定（「この失敗がちょうど 1 行出た」）に使うと、たまたま前置を失った時に**偽赤**
 *
 * 包含側は前置に依存しない `newLogLines` で数える。除外側の弱さは #756 で根本を直す。
 */
export function newLogLines(before: string, after: string): readonly string[] {
  const linesOf = (log: string): string[] => log.split('\n').filter((line) => line.trim() !== '')
  const remaining = new Map<string, number>()
  for (const line of linesOf(before)) {
    remaining.set(line, (remaining.get(line) ?? 0) + 1)
  }
  const added: string[] = []
  for (const line of linesOf(after)) {
    const left = remaining.get(line) ?? 0
    if (left > 0) {
      remaining.set(line, left - 1)
      continue
    }
    added.push(line)
  }
  return added
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
