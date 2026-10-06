/**
 * #567: `get_log` が要求を黙って切り詰めないことの検証。
 *
 * `get_log` はエンジン側エラーが現れる唯一のチャネルなので、黙って窓を狭められると
 * 呼び出し元は「エラーが無かった」のか「見せてもらえなかった」のかを区別できない。
 */

import { describe, expect, it } from 'vitest'

import {
  DEFAULT_LOG_LINES,
  OUTPUT_LOG_RING_MAX,
  selectLogLines,
  tapOutputIntoLogRing,
} from '../../packages/vscode-extension/src/log-ring'

const ring = (n: number): string[] => Array.from({ length: n }, (_, i) => `line-${i}`)

describe('get_log の行選択 (#567)', () => {
  it('要求どおりの行数を末尾から返す', () => {
    expect(selectLogLines(ring(100), 10)).toEqual(ring(100).slice(-10))
  })

  it('未指定なら既定行数', () => {
    expect(selectLogLines(ring(200))).toHaveLength(DEFAULT_LOG_LINES)
  })

  it('リング容量ちょうどの要求は通知を付けない（誤報しない）', () => {
    const out = selectLogLines(ring(OUTPUT_LOG_RING_MAX), OUTPUT_LOG_RING_MAX)
    expect(out).toHaveLength(OUTPUT_LOG_RING_MAX)
    expect(out[0]).not.toMatch(/\[get_log\] truncated/)
  })

  it('🔴 容量を超える要求は truncated を明示する（silent truncation をやめた）', () => {
    const out = selectLogLines(ring(OUTPUT_LOG_RING_MAX), OUTPUT_LOG_RING_MAX + 1)
    expect(out[0]).toMatch(/\[get_log\] truncated: requested 1001 lines/)
    expect(out[0]).toContain(`at most ${OUTPUT_LOG_RING_MAX}`)
    // 通知1行 + 実データ
    expect(out).toHaveLength(OUTPUT_LOG_RING_MAX + 1)
  })

  it('500 を超えても切られない（旧上限の 500 は撤廃された）', () => {
    // 旧実装は 500 で cap していた。600 要求で 600 返ることを固定する。
    expect(selectLogLines(ring(800), 600)).toHaveLength(600)
  })

  it('通知文言は ERROR カウントを汚さない', () => {
    const out = selectLogLines(ring(OUTPUT_LOG_RING_MAX), 5000)
    expect(out[0]).not.toMatch(/ERROR/)
  })

  it('履歴がリングより少ない場合は通知を出さない（切り詰めではない）', () => {
    const out = selectLogLines(ring(3), 10)
    expect(out).toEqual(['line-0', 'line-1', 'line-2'])
    expect(out[0]).not.toMatch(/truncated/)
  })
})

// 設計 668 §13.5.2 の「ring proxy」: `append` は行の途中で区切られて呼ばれうる（debug 起動は
// engine stdout の chunk をそのまま渡す）。呼び出しごとに split すると、1 行がリングでは 2 行になる。
describe('出力チャネル → get_log リングの写し取り', () => {
  const tapped = () => {
    const ring: string[] = []
    const shown: string[] = []
    const channel = {
      append: (value: string) => shown.push(value),
      appendLine: (value: string) => shown.push(value + '\n'),
    }
    tapOutputIntoLogRing(channel, (line) => ring.push(line))
    return { channel, ring, shown }
  }

  it('append の途中で割れた行をリングでは 1 行にする', () => {
    const { channel, ring, shown } = tapped()
    channel.append('🎚️ hat: play={"ty')
    expect(ring).toEqual([])
    channel.append('pe":"tie"} (next cycle)\nnext line\n')
    expect(ring).toEqual(['🎚️ hat: play={"type":"tie"} (next cycle)', 'next line'])
    // 出力チャネル自体へは従来どおりそのまま渡す。
    expect(shown.join('')).toBe('🎚️ hat: play={"type":"tie"} (next cycle)\nnext line\n')
  })

  it('appendLine は持ち越しと合わせて、チャネルに見えている 1 行としてリングへ入れる', () => {
    const { channel, ring } = tapped()
    channel.append('partial ')
    channel.appendLine('end')
    channel.appendLine('')
    expect(ring).toEqual(['partial end', ''])
  })

  it('append の空行はリングへ入れない（従来どおり）', () => {
    const { channel, ring } = tapped()
    channel.append('a\n\nb\n')
    expect(ring).toEqual(['a', 'b'])
  })
})
