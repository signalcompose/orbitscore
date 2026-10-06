/**
 * #964: 非 debug 起動の stdout フィルタ（`shouldFilterLine`）が、ループ中の `play()` 差し替えの
 * フィードバック行 `🎚️ <seq>: play=… (next cycle)` を落とさないことの検証。
 *
 * 落ちていた理由: `play()` はオブジェクトになる要素（`(0, 1)` / `_` / `1@v+10` / `b3`）を
 * JSON で行に書き出すので、行に `"type"` が入る。フィルタは SC 時代の OSC ダンプを隠すために
 * `"type"` を含む行を一律に落としていた。`get_log` はフィルタを通った行しか持たないので、
 * MCP 経由のエージェントには「評価されなかった」と見えた。
 *
 * 🔴 行は手で書かず、実際のインタプリタに評価させて採る。判定すべきはエンジンが実際に出す
 * 文字列であって、テストが想像した文字列ではない（行の書式が変わっても、このテストは
 * 新しい書式のまま検証し続ける）。
 */

import { beforeAll, describe, expect, it, vi } from 'vitest'

import { InterpreterV2 } from '../../packages/engine/src/interpreter/interpreter-v2'
import { parseAudioDSL } from '../../packages/engine/src/parser/audio-parser'
import { shouldFilterLine } from '../../packages/vscode-extension/src/engine-handlers'

// 先頭の平らなパターンは修正前から残っていた（対照）。残りは修正前に落ちていた形。
// audio シーケンスで評価するのは、note シーケンスが実 MIDI ポート / プラグインを要するため。
// 更新行は seamlessParameterUpdate('play', …) が出すもので、シーケンスの種類に依らない。
const PLAY_UPDATES = [
  'hat.play(1, 0, 1, 1, 0, 1, 1, 0)',
  'hat.play((0, 1), (0, 1, 0, 1), (0, 1), (0, 0, 1, 0))',
  'hat.play(1, _, 1, 0)',
  'hat.play(1@v+10, _, 1, 0)',
  'hat.play(b3, 1, 1, 0)',
]

interface Captured {
  playLines: Map<string, string[]>
  errors: string[]
}

async function capturePlayUpdateLines(): Promise<Captured> {
  const interpreter = new InterpreterV2()
  const audioEngine = interpreter.audioEngine as any
  audioEngine.boot = vi.fn().mockResolvedValue(undefined)
  audioEngine.getCurrentTime = vi.fn().mockReturnValue(0)
  audioEngine.scheduleEvent = vi.fn()
  audioEngine.scheduleSliceEvent = vi.fn()
  audioEngine.getMasterGainDb = vi.fn().mockReturnValue(0)
  await interpreter.boot()

  const logged: string[] = []
  const errors: string[] = []
  const logSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    logged.push(args.map(String).join(' '))
  })
  const errorSpy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    errors.push(args.map(String).join(' '))
  })
  try {
    await interpreter.execute(
      parseAudioDSL(
        [
          'var global = init GLOBAL',
          'global.key("C")',
          'var hat = init global.seq',
          'hat.output()',
          'hat.play(1, 0, 1, 1)',
          'global.start()',
          'LOOP(hat)',
        ].join('\n'),
      ),
    )
    const playLines = new Map<string, string[]>()
    for (const source of PLAY_UPDATES) {
      const from = logged.length
      await interpreter.execute(parseAudioDSL(source))
      playLines.set(
        source,
        logged.slice(from).filter((line) => line.includes('play=')),
      )
    }
    await interpreter.execute(parseAudioDSL('global.stop()'))
    return { playLines, errors }
  } finally {
    logSpy.mockRestore()
    errorSpy.mockRestore()
  }
}

describe('stdout フィルタは play() の更新行を残す (#964)', () => {
  let captured: Captured

  beforeAll(async () => {
    captured = await capturePlayUpdateLines()
  })

  it('採取の前提: 評価がエラー無しで通り、更新ごとに play= 行がちょうど1本出る', () => {
    expect(captured.errors).toEqual([])
    for (const source of PLAY_UPDATES) {
      const lines = captured.playLines.get(source)
      expect(lines, source).toHaveLength(1)
      expect(lines?.[0], source).toMatch(/^🎚️ hat: play=.+ \(next cycle\)$/)
    }
  })

  it.each(PLAY_UPDATES)('%s の更新行が出力チャネル（= get_log）へ届く', (source) => {
    const [line] = captured.playLines.get(source) ?? []
    expect(line, `no play= line was captured for ${source}`).toBeDefined()
    expect(shouldFilterLine(line)).toBe(false)
  })
})
