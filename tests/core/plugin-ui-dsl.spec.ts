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
  //
  // 🔴 R2 の教訓: `openPluginUiIdempotent` そのものは stub しない（stub すると
  // fast path・already-open catch・staleness の実装を検証できない）。
  // stub するのは境界（hasOpenPluginUi の判定源、openPluginUi の daemon 呼び出し、
  // already-open 後に再同期する現在 target の解決）だけ。
  const openTargets = new Set<string>()
  ;(global as unknown as { hasOpenPluginUi: unknown }).hasOpenPluginUi = (
    receiverId: string,
    index: number,
  ) => openTargets.has(`${receiverId}#${index}`)
  ;(global as unknown as { resolvePluginStateTarget: unknown }).resolvePluginStateTarget = (
    receiverId: string,
  ) => ({
    identity: {
      receiver: receiverId,
      role: 'instrument',
      normalizedName: 'mock-plugin',
      occurrence: 0,
    },
    daemonTarget: { role: 'instrument', instance: `plugin:${receiverId}` },
  })
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
  // たびに走るので、既に開いているのに再 open すると host 側の UiEventPump が
  // `OPEN_UI requested while lifecycle is Open` で落ちる（実機で実測）。
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

  it('🔴 R2: child が「already open」を返したら成功扱い（race の防御）', async () => {
    // fast path をすり抜けた場合（判定後に他所が open した race）でも、child の
    // 状態機械が返す「already open」は失敗ではない — 目的（開いている状態）は達成済み。
    const { global, player, open } = spyGlobal()
    open.mockRejectedValueOnce(
      new Error(
        "Plugin UI request for 'cb' index 0 failed: [PLUGIN_UI_PROTOCOL_ERROR] " +
          'plugin UI event protocol error: OPEN_UI requested while lifecycle is Open',
      ),
    )
    await expect(makeSeq(global, player, 'cb').ui()).resolves.toBeDefined()
    expect(open).toHaveBeenCalledTimes(1)
  })

  it('R4: child 側 desync（already-open）も成功扱い', async () => {
    // host は Closed と見て begin_open を通したが child の UiCloseStateMachine が
    // 既に Open の場合、mailbox エラーの detail に ALREADY_OPEN_DETAIL が載って届く
    // （CommandMailboxError::CommandFailed の Display 形式を模す）。
    const { global, player, open } = spyGlobal()
    open.mockRejectedValueOnce(
      new Error(
        "Plugin UI request for 'cb' index 0 failed: [PLUGIN_UI_COMMAND_ERROR] " +
          'plugin state mailbox command 7 failed (result=2): already-open',
      ),
    )
    await expect(makeSeq(global, player, 'cb').ui()).resolves.toBeDefined()
    expect(open).toHaveBeenCalledTimes(1)
  })

  it('🔴 R4: closing-in-progress は「開いていない」ので throw する', async () => {
    // Closing / ring 未 drain の拒否では UI は開いていない。成功扱いにすると
    // 「開けなかったのに開いたことにする」サイレント no-op になる（R4 Critical）。
    const { global, player, open } = spyGlobal()
    open.mockRejectedValueOnce(
      new Error(
        "Plugin UI request for 'cb' index 0 failed: [PLUGIN_UI_COMMAND_ERROR] " +
          'plugin state mailbox command 7 failed (result=2): closing-in-progress',
      ),
    )
    await expect(makeSeq(global, player, 'cb').ui()).rejects.toThrow('closing-in-progress')
  })

  it('🔴 R4: lifecycle is Closing も「開いていない」ので throw する', async () => {
    const { global, player, open } = spyGlobal()
    open.mockRejectedValueOnce(
      new Error(
        "Plugin UI request for 'cb' index 0 failed: [PLUGIN_UI_PROTOCOL_ERROR] " +
          'plugin UI event protocol error: OPEN_UI requested while lifecycle is Closing',
      ),
    )
    await expect(makeSeq(global, player, 'cb').ui()).rejects.toThrow('lifecycle is Closing')
  })

  it('R4: lifecycle is Opening は成功扱い（前方一致の裏取り）', async () => {
    const { global, player, open } = spyGlobal()
    open.mockRejectedValueOnce(
      new Error(
        "Plugin UI request for 'cb' index 0 failed: [PLUGIN_UI_PROTOCOL_ERROR] " +
          'plugin UI event protocol error: OPEN_UI requested while lifecycle is Opening',
      ),
    )
    await expect(makeSeq(global, player, 'cb').ui()).resolves.toBeDefined()
  })

  it('already open 以外のエラーは従来どおり throw する（何でも飲み込まない）', async () => {
    const { global, player, open } = spyGlobal()
    open.mockRejectedValueOnce(new Error('plugin UI hosting requires the Rust engine backend'))
    await expect(makeSeq(global, player, 'cb').ui()).rejects.toThrow('Rust engine backend')
  })

  it('bus 側も同じ冪等規約に従う', async () => {
    const { global, open, openTargets } = spyGlobal()
    openTargets.add('sum:strings#1')
    await global.sum('strings').ui(1)
    expect(open).not.toHaveBeenCalled()
  })
})

describe('🔴 R2 Critical: respawn がセッション簿記を破棄する', () => {
  // respawn は UI を閉じるがセッションは「次の open が上書きする」設計だった。
  // 冪等ガードはその「次の open」自体を止めるので、リスナで即時破棄しないと
  // `ui()` が永久に no-op になる。
  it('respawn 通知で該当セッションが消え、ui() が再び open できる', async () => {
    const player = {
      boot: vi.fn().mockResolvedValue(undefined),
      getCurrentTime: vi.fn().mockReturnValue(0),
      scheduleEvent: vi.fn(),
      scheduleSliceEvent: vi.fn(),
      getMasterGainDb: vi.fn().mockReturnValue(0),
      // Global のコンストラクタが登録するリスナを捕まえる
      setPluginUiClosedByRespawnListener: vi.fn(),
    } as unknown as SuperColliderPlayer
    const global = new Global(player)
    const captured = (player.setPluginUiClosedByRespawnListener as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0] as (target: { role: string; instance?: string; index: number }) => void
    expect(captured, 'Global がコンストラクタでリスナを登録していない').toBeDefined()

    // 実際の session map に stale エントリを直接置く（openPluginUi の実経路は daemon が要る）。
    const sessions = (
      global as unknown as {
        openPluginUiSessions: Map<string, { receiverId: string; index: number; resolved: unknown }>
      }
    ).openPluginUiSessions
    sessions.set('instrument\u0000plugin:cb\u00000', {
      receiverId: 'cb',
      index: 0,
      resolved: {} as never,
    })
    expect(global.hasOpenPluginUi('cb', 0)).toBe(true)

    // respawn 通知 → セッション破棄 → 冪等判定が「閉じている」に戻る
    captured({ role: 'instrument', instance: 'plugin:cb', index: 0 })
    expect(global.hasOpenPluginUi('cb', 0)).toBe(false)
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
