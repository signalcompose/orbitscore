/**
 * #614: `//#evalMark` が直前のコードの評価結果を requestId 付きで返す。
 *
 * `evaluate_orbitscore` の `ok` は「stdin へ書けた」しか意味しておらず、パース/実行エラーは
 * stderr へ非同期に出るだけだった。LLM は `ok` を成功と解釈するため、実機で
 * `Variable not found: global` が出ていても先へ進んでしまう（実測）。
 *
 * 🔴 待ち方の設計: REPL は行を **FIFO** で処理するので、コードの直後にマーカーを送れば
 * **マーカーに到達した時点で評価は完了している**。settle 時間や「エラーが出ないこと」を
 * 時間で待つ必要がない（長い評価でも誤検知しない）。このテストはその順序性を固定する。
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

import { createReplSession } from '../../packages/engine/src/cli/repl-mode'

afterEach(() => {
  vi.restoreAllMocks()
})

function harness(execute?: (source: string) => void) {
  const logs: string[] = []
  const errors: string[] = []
  vi.spyOn(console, 'log').mockImplementation((m?: unknown) => {
    logs.push(String(m))
  })
  vi.spyOn(console, 'error').mockImplementation((m?: unknown) => {
    errors.push(String(m))
  })
  const interpreter = {
    execute: async (_ir: unknown, options: { source?: string }) => {
      execute?.(options.source ?? '')
    },
  } as never
  return { session: createReplSession(interpreter), logs, errors }
}

const marks = (logs: string[]): Array<Record<string, unknown>> =>
  logs
    .filter((l) => l.trim().startsWith('{"evalMark"'))
    .map((l) => (JSON.parse(l) as { evalMark: Record<string, unknown> }).evalMark)

describe('//#evalMark (#614)', () => {
  it('診断が無ければ ok:true を返す', async () => {
    const { session, logs } = harness()
    session.pushLine('global.tempo(120)')
    session.pushLine('//#evalMark {"requestId":"r1"}')
    await session.idle()
    expect(marks(logs)).toEqual([{ requestId: 'r1', ok: true, diagnostics: [] }])
  })

  it('🔴 パースエラーは ok:false と診断で返る（これが #614 の実害）', async () => {
    const { session, logs } = harness()
    // 行の途中に不正トークン = 待っても完結しない本物の構文エラー（#608 と同じ形）
    session.pushLine('global.play(([1, 5, 9]@v+10, 0))')
    session.pushLine('//#evalMark {"requestId":"r2"}')
    await session.idle()
    const m = marks(logs)
    expect(m).toHaveLength(1)
    expect(m[0]!.ok).toBe(false)
    const diagnostics = m[0]!.diagnostics as Array<{ kind: string; message: string }>
    expect(diagnostics.length).toBeGreaterThan(0)
    expect(diagnostics[0]!.kind).toBe('parse')
  })

  it('実行時エラーは kind=runtime として返る', async () => {
    const { session, logs } = harness(() => {
      throw new Error('boom at runtime')
    })
    session.pushLine('global.tempo(120)')
    session.pushLine('//#evalMark {"requestId":"r3"}')
    await session.idle()
    const diagnostics = marks(logs)[0]!.diagnostics as Array<{ kind: string; message: string }>
    expect(diagnostics).toEqual([{ kind: 'runtime', message: 'boom at runtime' }])
  })

  it('診断は mark ごとにクリアされる（前回の失敗を引きずらない）', async () => {
    const { session, logs } = harness()
    session.pushLine('global.play(([1, 5, 9]@v+10, 0))')
    session.pushLine('//#evalMark {"requestId":"a"}')
    session.pushLine('global.tempo(120)')
    session.pushLine('//#evalMark {"requestId":"b"}')
    await session.idle()
    const m = marks(logs)
    expect(m[0]!.ok).toBe(false)
    expect(m[1]).toEqual({ requestId: 'b', ok: true, diagnostics: [] })
  })

  it('🔴 未完のまま残った入力は mark 時に強制実行され、結果が報告される', async () => {
    // 括弧が閉じていない = 通常は「複数行入力の途中」として保留される。しかし
    // evaluate_orbitscore は「これで全部」を意味するので、保留のまま ok を返しては
    // 「何も実行していないのに成功」になる。
    const { session, logs } = harness()
    session.pushLine('global.play((1, 2,')
    session.pushLine('//#evalMark {"requestId":"inc"}')
    await session.idle()
    const m = marks(logs)
    expect(m).toHaveLength(1)
    expect(m[0]!.ok).toBe(false)
    expect((m[0]!.diagnostics as unknown[]).length).toBeGreaterThan(0)
  })

  it('requestId が無い evalMark はエラーとして報告する（黙って捨てない）', async () => {
    const { session, logs, errors } = harness()
    session.pushLine('//#evalMark {}')
    await session.idle()
    expect(marks(logs)).toHaveLength(0)
    expect(errors.join('\n')).toMatch(/evalMark requires a non-empty string requestId/)
  })
})
