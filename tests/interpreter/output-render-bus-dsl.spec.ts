/**
 * #598 P1 / #612 レビュー: **DSL テキストから `output(n)` が届くこと**を通しで押さえる。
 *
 * 既存の `tests/core/sequence-output.spec.ts` は `Sequence.output()` を TS から**直接**呼んでおり、
 * `parseAudioDSL → processStatement → callMethod → Sequence.output(number)` という
 * **ユーザーと LLM が実際に使う唯一の表面**を一度も通していなかった。
 *
 * このプロジェクトで実害を出した事故はすべて「部品は正しいが**配線**が壊れていた」型である
 * （#528: `setDocumentDirectory` の誤分類でエディタ評価が全滅・ユニットは全件緑 /
 * #608: 構文エラーの誤判定でセッションが沈黙停止）。数値引数はメソッド解決の経路で
 * 文字列に潰される・別メソッドへ吸われる等の壊れ方をしうるが、それはこの層でしか見えない。
 *
 * プロジェクト規律（CLAUDE.md）:「DSL の表面を追加する PR は、その構文を評価する
 * テストなしにマージしない」。P1 は無音仕様（レンダは P2）なので、ここでは
 * **記録された render bus と、範囲外のエラー**までを押さえる。
 */

import { describe, expect, it } from 'vitest'

import { Global } from '../../packages/engine/src/core/global'
import { Sequence } from '../../packages/engine/src/core/sequence'
import { processSequenceInit } from '../../packages/engine/src/interpreter/process-initialization'
import { processStatement } from '../../packages/engine/src/interpreter/process-statement'
import { parseAudioDSL } from '../../packages/engine/src/parser/audio-parser'
import { createMixerRuntimeRegistry } from '../../packages/engine/src/signal-chain/runtime'
import { RecordingScheduler } from '../audio/verify/recording-scheduler'

function makeState() {
  const scheduler = new RecordingScheduler()
  const global = new Global(scheduler)
  return {
    globals: new Map([['global', global]]),
    sequences: new Map<string, Sequence>(),
    mixers: createMixerRuntimeRegistry(),
    currentGlobal: global,
    audioEngine: scheduler,
    isBooted: true,
    runGroup: new Set<string>(),
    loopGroup: new Set<string>(),
    muteGroup: new Set<string>(),
    engineT0: Date.now(),
  }
}

async function run(source: string, state: ReturnType<typeof makeState>): Promise<void> {
  const ir = parseAudioDSL(source)
  for (const init of ir.sequenceInits) await processSequenceInit(init, state)
  for (const statement of ir.statements) await processStatement(statement, state)
}

describe('output(n) reaches the sequence from DSL text (#598 P1)', () => {
  it('records the render bus written as a numeric literal in the score', async () => {
    const state = makeState()
    await run(
      ['var global = init GLOBAL', 'var kick = init global.seq', 'kick.output(3)'].join('\n'),
      state,
    )

    const kick = state.sequences.get('kick')
    expect(kick, 'seq が宣言されていない — 配線以前の問題').toBeDefined()
    // 🔴 canonical decimal string であること。数値が数値のまま渡る／別の型へ潰れる、を検出する。
    expect(kick!.getRenderBus()).toBe('3')
    // オフラインの宛先宣言が live routing を変えないこと（§4.4.1）も、この層で確認する。
    expect(kick!.getOutputChannel()).toBeUndefined()
  })

  it('does not treat a numeric-looking string literal as a render bus', async () => {
    const state = makeState()
    await run(
      ['var global = init GLOBAL', 'var kick = init global.seq', 'kick.output("3")'].join('\n'),
      state,
    )

    const kick = state.sequences.get('kick')!
    // 文字列 "3" は LinkAudio channel。DSL 層で number と string が同一視されると
    // ここが '3' になり、意図しない render bus 宣言が生まれる。
    expect(kick.getRenderBus()).toBeUndefined()
    expect(kick.getOutputChannel()).toBe('3')
  })

  it('surfaces the range error from DSL text instead of silently ignoring it', async () => {
    const state = makeState()
    await expect(
      run(
        ['var global = init GLOBAL', 'var kick = init global.seq', 'kick.output(17)'].join('\n'),
        state,
      ),
      'DSL から範囲外を書いても弾かれないなら、検証が表面に届いていない',
    ).rejects.toThrow(/integer from 1 to 16/)
  })
})
