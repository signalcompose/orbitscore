/**
 * #617: 楽譜からプラグイン UI を開く（`seq.ui()` / `sum("x").ui()`）。
 *
 * 音色を作って保存する工程を**楽譜を書きながら**回せるようにするための表面。
 * 機構は既存の `global.openPluginUi` / `closePluginUi` をそのまま通す
 * （新しい経路を作らない）。
 */

import { describe, expect, it, vi } from 'vitest'

import { Global } from '../../packages/engine/src/core/global'
import { Sequence } from '../../packages/engine/src/core/sequence'
import type { SuperColliderPlayer } from '../../packages/engine/src/audio/supercollider-player'
import {
  BUS_DSL_METHODS,
  SEQUENCE_DSL_METHODS,
} from '../../packages/engine/src/signal-chain/runtime'

/** 名前付き Sequence を実 API で作る。 */
function makeSeq(global: Global, player: SuperColliderPlayer, name: string): Sequence {
  const seq = new Sequence(global, player)
  seq.setName(name)
  return seq
}

/** open/close の呼び出しを記録する Global。実経路（seq.ui → global.openPluginUi）を通す。 */
function spyGlobal(): {
  global: Global
  player: SuperColliderPlayer
  open: ReturnType<typeof vi.fn>
  close: ReturnType<typeof vi.fn>
  openTargets: Set<string>
} {
  const player = {
    boot: vi.fn().mockResolvedValue(undefined),
    getCurrentTime: vi.fn().mockReturnValue(0),
    scheduleEvent: vi.fn(),
    scheduleSliceEvent: vi.fn(),
    getMasterGainDb: vi.fn().mockReturnValue(0),
  } as unknown as SuperColliderPlayer
  const global = new Global(player)
  const open = vi.fn(async () => ({}) as never)
  const close = vi.fn(async () => ({}) as never)
  ;(global as unknown as { openPluginUi: unknown }).openPluginUi = open
  ;(global as unknown as { closePluginUi: unknown }).closePluginUi = close
  // 冪等判定に使うセッション有無。既定は「開いていない」。
  const openTargets = new Set<string>()
  ;(global as unknown as { hasOpenPluginUi: unknown }).hasOpenPluginUi = (
    receiverId: string,
    index: number,
  ) => openTargets.has(`${receiverId}#${index}`)
  return { global, player, open, close, openTargets }
}

describe('seq.ui() (#617)', () => {
  it('既定は instrument（index 0）を開く', async () => {
    const { global, player, open, close } = spyGlobal()
    const seq = makeSeq(global, player, 'cb')
    await seq.ui()
    expect(open).toHaveBeenCalledTimes(1)
    expect(open).toHaveBeenCalledWith('cb', 0)
    expect(close).not.toHaveBeenCalled()
  })

  it('index を渡すと effect のチェーン位置を開く', async () => {
    const { global, player, open } = spyGlobal()
    await makeSeq(global, player, 'lead').ui(1)
    expect(open).toHaveBeenCalledWith('lead', 1)
  })

  it('open=false は閉じる（open は呼ばない）', async () => {
    const { global, player, open, close } = spyGlobal()
    await makeSeq(global, player, 'cb').ui(0, false)
    expect(close).toHaveBeenCalledTimes(1)
    expect(close).toHaveBeenCalledWith('cb', 0)
    expect(open).not.toHaveBeenCalled()
  })

  it('チェーンできる（既存の表面と並べて書ける）', async () => {
    const { global, player, open } = spyGlobal()
    const seq = makeSeq(global, player, 'cb')
    expect(await seq.ui()).toBe(seq)
    expect(open).toHaveBeenCalledTimes(1)
  })

  it('複数パートの UI を同時に開ける（制限しない・owner 裁定）', async () => {
    const { global, player, open } = spyGlobal()
    await makeSeq(global, player, 'vln1').ui()
    await makeSeq(global, player, 'vla').ui()
    await makeSeq(global, player, 'vc').ui()
    expect(open).toHaveBeenCalledTimes(3)
    expect(open.mock.calls.map((c) => c[0])).toEqual(['vln1', 'vla', 'vc'])
  })
})

describe('🔴 ui() は冪等（#619 レビュー・F2b）', () => {
  // ライブコーディングではブロックの**再評価が常態**。楽譜に書いた `cb.ui()` は評価の
  // たびに走るので、既に開いているのに再 open すると child の状態機械が
  // `OPEN_UI requires state == Closed` で落ちる（実機で実測）。
  it('既に開いていれば seq.ui() は open を呼ばない', async () => {
    const { global, player, open, openTargets } = spyGlobal()
    openTargets.add('cb#0')
    await makeSeq(global, player, 'cb').ui()
    expect(open).not.toHaveBeenCalled()
  })

  it('開いていなければ通常どおり open する（冪等化が全部を殺していない）', async () => {
    const { global, player, open } = spyGlobal()
    await makeSeq(global, player, 'cb').ui()
    expect(open).toHaveBeenCalledTimes(1)
  })

  it('index が違えば別セッションとして open する', async () => {
    const { global, player, open, openTargets } = spyGlobal()
    openTargets.add('cb#0')
    await makeSeq(global, player, 'cb').ui(1)
    expect(open).toHaveBeenCalledTimes(1)
    expect(open).toHaveBeenCalledWith('cb', 1)
  })

  it('close は冪等化しない（閉じる指示は常に通す）', async () => {
    const { global, player, close, openTargets } = spyGlobal()
    openTargets.add('cb#0')
    await makeSeq(global, player, 'cb').ui(0, false)
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('bus 側も同じ冪等規約に従う', async () => {
    const { global, open, openTargets } = spyGlobal()
    openTargets.add('sum:strings#1')
    await global.sum('strings').ui(1)
    expect(open).not.toHaveBeenCalled()
  })
})

describe('sum("x").ui() (#617)', () => {
  it('bus の insert を receiverId 付きで開く', async () => {
    const { global, open } = spyGlobal()
    await global.sum('strings').ui(1)
    expect(open).toHaveBeenCalledWith('sum:strings', 1)
  })

  it('bus の既定 index は 1（bus に instrument は無い）', async () => {
    const { global, open } = spyGlobal()
    await global.sum('strings').ui()
    expect(open).toHaveBeenCalledWith('sum:strings', 1)
  })

  it('aux も同じ語彙で開ける', async () => {
    const { global, open } = spyGlobal()
    await global.aux('verb').ui(1)
    expect(open).toHaveBeenCalledWith('aux:verb', 1)
  })

  it('open=false は閉じる', async () => {
    const { global, close } = spyGlobal()
    await global.sum('strings').ui(1, false)
    expect(close).toHaveBeenCalledWith('sum:strings', 1)
  })
})

describe('DSL 語彙への登録 (#617)', () => {
  // 🔴 #528: 語彙に載せ忘れると実行時に `Unknown chain method` で弾かれ、
  // ユニットテストは緑のままエディタ評価だけが壊れる。
  it('sequence 語彙に ui がある', () => {
    expect(SEQUENCE_DSL_METHODS.has('ui')).toBe(true)
  })

  it('bus 語彙に ui がある', () => {
    expect(BUS_DSL_METHODS.has('ui')).toBe(true)
  })
})
