/**
 * #614: `evaluate_orbitscore` が評価結果を呼び出し元へ返すことの検証。
 *
 * 以前の `ok` は「stdin へ書けた」しか意味しておらず、パースエラーは stderr へ非同期に
 * 出るだけだった。LLM は `ok` を成功と解釈するため、実機で `Variable not found: global`
 * が出ていても先へ進む（「1260」制作で数時間を溶かした実害あり）。
 */

import { describe, expect, it, vi } from 'vitest'

import {
  EvalMarkBridge,
  parseEvalMarkResultLine,
} from '../../packages/vscode-extension/src/eval-mark-bridge'

const line = (o: unknown): string => JSON.stringify({ evalMark: o })

describe('evalMark の応答パース (#614)', () => {
  it('診断なしの成功を読む', () => {
    expect(parseEvalMarkResultLine(line({ requestId: 'r1', ok: true, diagnostics: [] }))).toEqual({
      requestId: 'r1',
      ok: true,
      diagnostics: [],
    })
  })

  it('parse 診断つきの失敗を読む', () => {
    const d = [{ kind: 'parse', message: 'Variable not found: global' }]
    expect(parseEvalMarkResultLine(line({ requestId: 'r2', ok: false, diagnostics: d }))).toEqual({
      requestId: 'r2',
      ok: false,
      diagnostics: d,
    })
  })

  it('evalMark 以外の行は無視する（他 bridge の応答を横取りしない）', () => {
    expect(parseEvalMarkResultLine('{"pluginUi":{"requestId":"x","ok":true}}')).toBeUndefined()
    expect(parseEvalMarkResultLine('ERROR: something')).toBeUndefined()
  })

  it('envelope が先頭に無い行は受理しない（他 bridge の行に相乗りさせない）', () => {
    // prefix ガードが効いていることを固定する。JSON としては evalMark を含むが、
    // 先頭が `{"evalMark"` ではないので engine が出した本物の応答ではない。
    const smuggled =
      '{"pluginUi":{"requestId":"x"},"evalMark":{"requestId":"r","ok":true,"diagnostics":[]}}'
    expect(parseEvalMarkResultLine(smuggled)).toBeUndefined()
  })

  it('diagnostics の形が違う応答は受理しない', () => {
    expect(
      parseEvalMarkResultLine(line({ requestId: 'r', ok: true, diagnostics: [{ kind: 'x' }] })),
    ).toBeUndefined()
    expect(parseEvalMarkResultLine(line({ requestId: 'r', ok: true }))).toBeUndefined()
  })
})

describe('EvalMarkBridge の相関 (#614)', () => {
  it('requestId が一致した応答で解決する', async () => {
    const bridge = new EvalMarkBridge()
    let sent = ''
    const p = bridge.send((l) => {
      sent = l
      return true
    }, 'req-1')
    const id = JSON.parse(sent.replace('//#evalMark ', '')).requestId
    expect(id).toBe('req-1')
    bridge.handleLine(
      line({ requestId: 'req-1', ok: false, diagnostics: [{ kind: 'parse', message: 'boom' }] }),
    )
    await expect(p).resolves.toMatchObject({ ok: false, diagnostics: [{ message: 'boom' }] })
  })

  it('別の requestId の応答では解決しない', async () => {
    const bridge = new EvalMarkBridge()
    let settled = false
    const p = bridge.send(() => true, 'mine').then(() => (settled = true))
    expect(bridge.handleLine(line({ requestId: 'other', ok: true, diagnostics: [] }))).toBe(true)
    await Promise.resolve()
    expect(settled).toBe(false)
    bridge.drainAll('cleanup')
    await p
  })

  it('engine 停止時の drain は pending を失敗で閉じる（永久ハングさせない）', async () => {
    const bridge = new EvalMarkBridge()
    const p = bridge.send(() => true, 'r')
    bridge.drainAll('engine was stopped')
    await expect(p).resolves.toMatchObject({ ok: false, error: 'engine was stopped' })
  })

  it('stdin へ書けなければ即座に失敗する', async () => {
    const bridge = new EvalMarkBridge()
    await expect(bridge.send(() => false, 'r')).resolves.toMatchObject({ ok: false })
  })

  it('timeout は詰まったキューを指し示す文言で失敗する', async () => {
    vi.useFakeTimers()
    try {
      const bridge = new EvalMarkBridge()
      const p = bridge.send(() => true, 'r', 100)
      await vi.advanceTimersByTimeAsync(150)
      await expect(p).resolves.toMatchObject({ ok: false })
      const r = await p
      expect(!r.ok && r.error).toMatch(/evaluation queue may be blocked/)
    } finally {
      vi.useRealTimers()
    }
  })
})
