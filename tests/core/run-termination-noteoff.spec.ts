/**
 * #606 PR-K-A1 — **一発 `RUN()` の終端で保留 note が解放される**ことを固定する。
 *
 * ## 🔴 これは「実装を足す」PR ではなく「守りを足す」PR である
 *
 * 発火点も配送機構も **既にあった**（2026-09-04 に実装を読んで確認）:
 *
 * | 層 | 場所 |
 * |---|---|
 * | RUN 終端の発火 | `run-sequence.ts:60-63` の `setTimeout(… clearSequenceEventsFn(name) …, patternDuration)` |
 * | 経路の振り分け | `sequence.ts:1015-1023` `clearEvents()` → MIDI / instrument なら `clearOwner(name)` |
 * | 実際の note-off | `midi-scheduler.ts:211-214` `clearOwner()` が **`output.releaseOwner(owner)` を呼ぶ** |
 *
 * ところが**この鎖を直接検査するテストが 1 本も無かった**
 * （[[consumerless-code-is-unprotected]]）。`clearOwner()` から `releaseOwner()` の 1 行を
 * 落としても既存 2205 件は全部通る。**鳴りっぱなしは音にしか出ないので、
 * ユニットで守らないと誰も気づけない。**
 *
 * ## 仕様の出どころ
 *
 * core spec PH.4 / `PITCH_DSL_SPEC_v1.1.md` §7-2（#729 で明文化）:
 * 「**一発 `RUN()` の終端**とオフラインレンダの終端も保留 note の解放義務を持つ。
 * 発火点が増えても**配送機構は 1 本**で、場面ごとに別の flush を作らない」。
 *
 * 🔴 本テストが守るのは **owner 単位の解放**である。daemon 側の「最後の砦」は
 * **instance 単位（全 owner）**で、`global.stop()` / shutdown / engine 異常終了の
 * 3 場面でしか発火しない（PH.4・#729 で粒度を明文化）。**混同すると他シーケンスを巻き込む。**
 */
import { describe, expect, it } from 'vitest'

import type { ActiveNote, MidiOutput } from '../../packages/engine/src/midi/midi-output'
import { MidiScheduler } from '../../packages/engine/src/midi/midi-scheduler'

/** `MidiOutput` の最小実装。誰の note が生きていて、誰が解放されたかだけを記録する。 */
class RecordingOutput implements MidiOutput {
  readonly released: string[] = []
  private notes: ActiveNote[] = []

  ensurePort(portName: string): string {
    return portName
  }

  noteOn(port: string, channel: number, note: number, _velocity: number, owner: string): void {
    this.notes.push({ port, channel, note, owner })
  }

  noteOff(port: string, channel: number, note: number, owner: string): void {
    this.notes = this.notes.filter(
      (n) => !(n.owner === owner && n.port === port && n.channel === channel && n.note === note),
    )
  }

  pitchBend(): void {}

  releaseOwner(owner: string): void {
    this.released.push(owner)
    this.notes = this.notes.filter((n) => n.owner !== owner)
  }

  panic(): void {
    this.notes = []
  }

  getActiveNotes(): ReadonlyArray<ActiveNote> {
    return this.notes
  }

  listPorts(): string[] {
    return ['test-port']
  }

  closeAll(): void {}
}

const PORT = 'test-port'

describe('#606 RUN termination releases held notes', () => {
  it('releases the owner when its scheduled events are cleared', () => {
    const output = new RecordingOutput()
    const scheduler = new MidiScheduler(output)

    // RUN 終端で `clearEvents()` が通るのと同じ経路（`sequence.ts` の MIDI / instrument 分岐）。
    scheduler.clearOwner('runSeq')

    expect(
      output.released,
      '🔴 `clearOwner()` が `releaseOwner()` を呼ばないと、RUN 終端で保留 note が鳴りっぱなしになる ' +
        '（`midi-scheduler.ts:211-214`・core spec PH.4）',
    ).toEqual(['runSeq'])
  })

  it('releases only that owner, never the siblings sounding on the same instance', () => {
    const output = new RecordingOutput()
    const scheduler = new MidiScheduler(output)

    output.noteOn(PORT, 1, 60, 100, 'kept')
    output.noteOn(PORT, 1, 64, 100, 'ended')

    scheduler.clearOwner('ended')

    expect(
      output.released,
      '解放するのは終端したシーケンスだけ（PH.4「1 シーケンスの停止に wildcard な解放を使わない」）',
    ).toEqual(['ended'])
    expect(
      output.getActiveNotes().map((n) => n.owner),
      '🔴 他シーケンスの発音を巻き込んではならない。daemon 側の instance 単位の「最後の砦」と ' +
        'この owner 単位の経路を混同すると、ここが壊れる（#729 で粒度を明文化した理由）',
    ).toEqual(['kept'])
  })

  it('drops that owner pending notes so a finished RUN cannot sound later', () => {
    const output = new RecordingOutput()
    const scheduler = new MidiScheduler(output)
    const far = Date.now() + 10_000

    scheduler.scheduleNote({
      owner: 'ended',
      port: PORT,
      channel: 1,
      note: 60,
      velocity: 100,
      detune: 0,
      onTime: far,
      offTime: far + 500,
    })
    expect(scheduler.pendingCount(), '前提: 予定が積まれていること').toBeGreaterThan(0)

    scheduler.clearOwner('ended')

    expect(
      scheduler.pendingCount(),
      '終端したシーケンスの予定が残ると、解放した後にまた鳴り出す',
    ).toBe(0)
  })

  /**
   * 🔴 **この 1 本は変異で穴が見つかって足した**（2026-09-04）。
   *
   * 上の 3 本だけだと、`clearOwner()` の queue フィルタを **`this.queue = []`（全消し）**へ
   * 変える変異が**生き残った** — 「終端したシーケンスの予定だけを落とす」という PH.4 の規範
   * （「1 シーケンスの停止に wildcard な解放を使わない」）を**誰も検査していなかった**。
   *
   * 解放（`releaseOwner`）の側は 2 本目が owner を見ているが、**予定（queue）の側は
   * 見ていなかった**。片翼だけ守っていたことになる（[[enumeration-stops-one-level-too-early]]）。
   */
  it('keeps the siblings pending notes when one owner terminates', () => {
    const output = new RecordingOutput()
    const scheduler = new MidiScheduler(output)
    const far = Date.now() + 10_000
    const note = (owner: string) => ({
      owner,
      port: PORT,
      channel: 1,
      note: 60,
      velocity: 100,
      detune: 0,
      onTime: far,
      offTime: far + 500,
    })

    scheduler.scheduleNote(note('kept'))
    scheduler.scheduleNote(note('ended'))
    const before = scheduler.pendingCount()

    scheduler.clearOwner('ended')

    expect(
      scheduler.pendingCount(),
      '🔴 `ended` の予定だけが落ちること。`this.queue = []` のような wildcard な全消しは ' +
        '**まだ鳴るはずの `kept` の予定まで巻き込む**（PH.4「1 シーケンスの停止に wildcard な解放を使わない」）',
    ).toBe(before / 2)
  })
})
