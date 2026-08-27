import { describe, it, expect, vi, afterEach } from 'vitest'

import { effectReplaceNotice } from '../../packages/engine/src/core/global/effect-replace-notice'

afterEach(() => vi.restoreAllMocks())

/**
 * 🔴 このファイルが守っているのは「文言」ではなく「**どのストリームへ出るか**」である。
 *
 * 拡張は engine プロセスの stderr を、内容を一切見ずに `ERROR:` を付けて出力チャネルへ流す
 * （`extension.ts` の `setupStderrHandler`）。`console.warn` / `console.error` は stderr へ
 * 書くので、**正常に継続する操作をそれで報告した瞬間に ERROR として記録される**。
 *
 * これは `af041307` が直した欠陥の **4 回目の再発**で、#625 では実機 gated E2E の R-E4
 * 「復旧は ERROR 行を増やさない」が実際に落ちて発覚した。ユニットテストもレビュー4名も
 * Fable 監査も変異検証も、**この欠陥を検出できなかった** — ストリームの分類は engine の
 * 外（拡張）で起きるからである。
 */
describe('effectReplaceNotice (#625: normal continuation must not be recorded as ERROR)', () => {
  it('writes to stdout and never to stderr', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})

    effectReplaceNotice('replacement will continue without state preservation.')

    expect(log).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledTimes(0)
    expect(error).toHaveBeenCalledTimes(0)
  })

  it('owns the marker so call sites cannot drift', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    effectReplaceNotice('the old tenant is already gone.')

    expect(log).toHaveBeenCalledWith('[effect-replace] ⚠️ the old tenant is already gone.')
  })
})
