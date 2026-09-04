import { describe, it, expect, beforeEach, vi } from 'vitest'

import { Global } from '../../packages/engine/src/core/global'
import { Sequence } from '../../packages/engine/src/core/sequence'
import { MidiManager } from '../../packages/engine/src/core/global/midi-manager'
import { MidiOutput } from '../../packages/engine/src/midi/midi-output'
import { SuperColliderPlayer } from '../../packages/engine/src/audio/supercollider-player'

function mockMidiOutput(ports: string[] = ['IACドライバ バス1']): MidiOutput {
  return {
    ensurePort: vi.fn((q: string) => {
      const hit = ports.find((p) => p.toLowerCase().includes(q.toLowerCase()))
      if (!hit) throw new Error(`no port matches "${q}"`)
      return hit
    }),
    noteOn: vi.fn(),
    noteOff: vi.fn(),
    pitchBend: vi.fn(),
    releaseOwner: vi.fn(),
    panic: vi.fn(),
    getActiveNotes: vi.fn(() => []),
    listPorts: vi.fn(() => ports),
    closeAll: vi.fn(),
  } as unknown as MidiOutput
}

describe('Sequence.output() — LinkAudio channel binding', () => {
  let global: Global
  let seq: Sequence
  let mockPlayer: SuperColliderPlayer
  let warnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    mockPlayer = {
      boot: vi.fn().mockResolvedValue(undefined),
      getCurrentTime: vi.fn().mockReturnValue(0),
      scheduleEvent: vi.fn(),
      scheduleSliceEvent: vi.fn(),
      getMasterGainDb: vi.fn().mockReturnValue(0),
      // TA4: registerLinkAudioChannel is the eager-registration hook wired from
      // output(). Without it the existing tests still pass (optional-chained),
      // but its absence meant the output()→register wiring was never exercised.
      registerLinkAudioChannel: vi.fn().mockResolvedValue(undefined),
      setBusRouting: vi.fn().mockResolvedValue(undefined),
    } as any

    global = new Global(mockPlayer)
    seq = new Sequence(global, mockPlayer)
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  it('should have no output channel by default', () => {
    expect(seq.getOutputChannel()).toBeUndefined()
    const state = seq.getState()
    expect(state.outputChannel).toBeUndefined()
  })

  it('should record the channel name when output() is called', () => {
    global.linkAudio()
    seq.output('kick')
    expect(seq.getOutputChannel()).toBe('kick')
    expect(seq.getState().outputChannel).toBe('kick')
  })

  it('should be method-chainable (returns this)', () => {
    global.linkAudio()
    const result = seq.output('snare')
    expect(result).toBe(seq)
  })

  it('should overwrite the channel name on subsequent calls', () => {
    global.linkAudio()
    seq.output('kick')
    seq.output('kick-2')
    expect(seq.getOutputChannel()).toBe('kick-2')
  })

  it('should warn when called without Global.linkAudio() but still record the value', () => {
    seq.output('orphan-channel')
    expect(seq.getOutputChannel()).toBe('orphan-channel')
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(warnSpy.mock.calls[0]?.[0]).toContain('global.linkAudio()')
    // Ensure the (incorrect) `init` prefix is NOT present in the message —
    // `init` is reserved for variable declarations, not method calls.
    expect(warnSpy.mock.calls[0]?.[0]).not.toContain('init global.linkAudio()')
  })

  it('should not warn when Global.linkAudio() is enabled before output()', () => {
    global.linkAudio()
    seq.output('kick')
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('should accept channel names with hyphens and underscores', () => {
    global.linkAudio()
    seq.output('drum-bus_01')
    expect(seq.getOutputChannel()).toBe('drum-bus_01')
  })

  describe('output()→registerLinkAudioChannel wiring (TA4)', () => {
    it('calls registerLinkAudioChannel with the channel name when linkAudio is on', () => {
      global.linkAudio()
      seq.output('kick')
      // output() fire-and-forgets the call (optional-chain + .catch).
      // The spy is invoked synchronously on the same tick.
      expect(mockPlayer.registerLinkAudioChannel).toHaveBeenCalledWith('kick')
    })

    it('does NOT call registerLinkAudioChannel when linkAudio is off', () => {
      seq.output('kick')
      expect(mockPlayer.registerLinkAudioChannel).not.toHaveBeenCalled()
    })
  })

  describe('output() empty-string guard', () => {
    it('throws when called with an empty string', () => {
      global.linkAudio()
      expect(() => seq.output('')).toThrow(/requires a non-empty channel name/)
    })

    it('throws when called with a whitespace-only string', () => {
      global.linkAudio()
      expect(() => seq.output('   ')).toThrow(/requires a non-empty channel name/)
    })

    it('does not throw when called with a valid channel name (regression guard)', () => {
      global.linkAudio()
      expect(() => seq.output('valid')).not.toThrow()
      expect(seq.getOutputChannel()).toBe('valid')
    })
  })

  describe('numeric render buses (#598 P1)', () => {
    it('records canonical render bus 1..16 without changing the realtime output channel', () => {
      expect(seq.output(1)).toBe(seq)
      expect(seq.getRenderBus()).toBe('1')
      expect(seq.getOutputChannel()).toBeUndefined()
      expect(seq.getState().renderBus).toBe('1')
      expect(warnSpy).not.toHaveBeenCalled()

      seq.output(16)
      expect(seq.getRenderBus()).toBe('16')
    })

    it.each([0, 17, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
      'rejects an invalid numeric render bus: %s',
      (bus) => {
        expect(() => seq.output(bus)).toThrow(/integer from 1 to 16/)
      },
    )

    it('does not reinterpret a numeric-looking string as a render bus', () => {
      seq.output('1')
      expect(seq.getRenderBus()).toBeUndefined()
      expect(seq.getOutputChannel()).toBe('1')
      expect(warnSpy).toHaveBeenCalledTimes(1)
    })

    // 🔴 §4.4.1 の一方向の非対称（#612 レビュー統合で確定）:
    // **オフラインの宛先宣言は live routing を変えない / live 宛先の宣言は render bus をクリアする。**
    //
    // 経緯: 当初の実装は数値 output で `_outputChannel` をクリアしており、main の変異検証で
    // 「排他性」として固定してしまっていた。しかし Fable 監査が、その挙動だと
    // `global.linkAudio()` セッションで稼働中の seq にレンダ準備の `output(1)` を書き足した瞬間
    // `resolveDispatchChannel()` が throw して**ライブ演奏が停止する**ことを特定した。
    // `_renderBus` のフィールドコメントが宣言する不変条件とも矛盾していた。
    it('keeps the live output channel when an offline render bus is declared', () => {
      seq.output('master')
      expect(seq.getOutputChannel()).toBe('master')

      seq.output(3)

      expect(seq.getRenderBus()).toBe('3')
      expect(
        seq.getOutputChannel(),
        'オフラインの宛先宣言が live routing を壊すと、LinkAudio セッションで演奏が止まる',
      ).toBe('master')
    })

    it('clears the render bus when the same sequence is re-declared with a channel name', () => {
      seq.output(3)
      expect(seq.getRenderBus()).toBe('3')

      seq.output('master')

      expect(seq.getOutputChannel()).toBe('master')
      expect(
        seq.getRenderBus(),
        'output("master") で render bus が残ると、score-mode で意図しないバスへ出力される',
      ).toBeUndefined()
      expect(seq.getState().renderBus).toBeUndefined()
    })

    // 🔴 sum 分岐の render bus クリア（#612 レビューが変異で発見）: 既存の
    // 「resolves a same-named sum ...」は **未設定の `_renderBus` から** `output(1)` を
    // 呼ぶため、sum 分岐の `this._renderBus = undefined` を削除する変異が
    // **25 passed のまま生き残った**。事前状態を非デフォルトにしてから遷移させる必要がある。
    it('clears the render bus when the same name later resolves to a sum bus', () => {
      seq.output(3)
      expect(seq.getRenderBus()).toBe('3')

      global.sum('3')
      seq.output(3)

      expect(seq.getInsertBus()).toBe('seq-bus-0')
      expect(
        seq.getRenderBus(),
        'sum に解決されたのに render bus が残ると、同じ seq が sum 経由と render bus の両方へ載る',
      ).toBeUndefined()
    })

    // 🔴 例外時の状態保全（#612 レビューが変異で発見）: 上の「rejects an invalid numeric
    // render bus」は throw することしか見ておらず、**例外の前に既存の宛先が壊れていないか**を
    // 検査していない。`this._outputChannel = undefined` を範囲チェックより前へ動かす変異が
    // 生き残った。実害: `output(10)` の typo で `output(0)` と書くと、エラーは出るが
    // その前に master ルーティングが失われ、次の再生で無音になる。
    it('leaves existing routing untouched when a numeric render bus is rejected', () => {
      seq.output('master')
      seq.output(3)

      expect(() => seq.output(0)).toThrow(/integer from 1 to 16/)

      expect(seq.getOutputChannel(), '例外の前に live routing が壊れている').toBe('master')
      expect(seq.getRenderBus(), '例外の前に render bus が壊れている').toBe('3')
    })

    it('resolves a same-named sum before interpreting a numeric render bus', () => {
      global.sum('1')
      seq.output(1)

      expect(seq.getRenderBus()).toBeUndefined()
      expect(seq.getInsertBus()).toBe('seq-bus-0')
      expect(mockPlayer.setBusRouting).toHaveBeenCalledWith('seq-bus-0', 'sum-bus-0', [])
      expect(warnSpy).not.toHaveBeenCalled()
    })
  })
})

/**
 * #282 — MIDI sequences must be exempt from the LinkAudio strict-mode
 * `.output()` requirement. `resolveDispatchChannel()` is the eager guard that
 * run()/loop() call FIRST — it is the exact call that threw for the user's
 * `LOOP(piano, inner, bass)` of a `.midi()` Pavane in a `global.linkAudio()`
 * file (pre-#645; it returns `{ kind: 'skip', reason }` instead of throwing
 * now — see #645 PR-D0). Decision #14: "MIDI と SC オーディオは併走可 / 排他に
 * する技術的理由がない"; spec §8.1.2 scopes the requirement to "発音 sequences".
 */
describe('Sequence.resolveDispatchChannel() — MIDI exemption under linkAudio (#282)', () => {
  let global: Global
  let midiOut: MidiOutput
  let mockPlayer: SuperColliderPlayer

  beforeEach(() => {
    mockPlayer = {
      boot: vi.fn().mockResolvedValue(undefined),
      getCurrentTime: vi.fn().mockReturnValue(0),
      scheduleEvent: vi.fn(),
      scheduleSliceEvent: vi.fn(),
      getMasterGainDb: vi.fn().mockReturnValue(0),
    } as never
    midiOut = mockMidiOutput()
    global = new Global(mockPlayer, new MidiManager(() => midiOut))
  })

  it('returns hardware for a MIDI sequence even when linkAudio is on and no .output() is set', () => {
    global.linkAudio()
    const seq = new Sequence(global, mockPlayer)
    seq.midi('IAC', 1)
    expect(seq.isMidi()).toBe(true)
    // The user's exact failure (pre-#645): this call threw "has no .output() channel set".
    expect(() => seq.resolveDispatchChannel()).not.toThrow()
    expect(seq.resolveDispatchChannel()).toEqual({ kind: 'hardware' })
  })

  it('still resolves to skip for an AUDIO sequence with linkAudio on and no .output() (strict mode preserved, no longer a throw)', () => {
    global.linkAudio()
    const seq = new Sequence(global, mockPlayer)
    // Absolute path → no document-directory resolution needed at construction.
    seq.audio('/abs/kick.wav')
    expect(seq.isMidi()).toBe(false)
    expect(() => seq.resolveDispatchChannel()).not.toThrow()
    const target = seq.resolveDispatchChannel()
    expect(target.kind).toBe('skip')
    expect(target.kind === 'skip' && target.reason).toMatch(/no .output\(\) channel set/)
  })

  it('returns the channel name (kind: link) for an AUDIO sequence that declares .output()', () => {
    global.linkAudio()
    const seq = new Sequence(global, mockPlayer)
    seq.audio('/abs/kick.wav').output('kick')
    expect(seq.resolveDispatchChannel()).toEqual({ kind: 'link', channel: 'kick' })
  })
})
