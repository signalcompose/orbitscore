import { afterEach, describe, expect, it, vi } from 'vitest'

import { createReplSession } from '../../packages/engine/src/cli/repl-mode'
import { AudioLine } from '../../packages/engine/src/core/sequence/audio-line'

afterEach(() => vi.restoreAllMocks())

/**
 * #611 §5.7: `//#evalBegin` / `//#evalEnd` open/close an audio-line batch spanning the whole
 * evaluated chunk (not one statement). These tests fix the two guards the design calls out:
 * (1) `beginBatch()` implicitly closes an abandoned batch, and (2) a statement that fails
 * mid-evaluation still lets `//#evalEnd` reach `endBatchAll()` — the queue never sees the
 * per-statement rejection because `executeCurrentBuffer` catches it internally.
 */
describe('//#evalBegin / //#evalEnd REPL meta (#611 §5.7)', () => {
  it('begin -> begin -> end: a second //#evalBegin without an intervening //#evalEnd does not throw and still closes cleanly', async () => {
    const execute = vi.fn().mockResolvedValue(undefined)
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const beginSpy = vi.spyOn(AudioLine, 'beginBatchAll')
    const endSpy = vi.spyOn(AudioLine, 'endBatchAll')
    const session = createReplSession({ execute } as any)

    session.pushLine('//#evalBegin')
    session.pushLine('var global = init GLOBAL')
    session.pushLine('//#evalBegin') // no //#evalEnd before this — simulates a stuck frame
    session.pushLine('kick.gain(-6)')
    session.pushLine('//#evalEnd')
    await session.idle()

    expect(beginSpy).toHaveBeenCalledTimes(2)
    expect(endSpy).toHaveBeenCalledTimes(1)
  })

  it('begin -> exception -> end: a statement that throws still lets //#evalEnd close the batch', async () => {
    const execute = vi.fn().mockRejectedValue(new Error('boom'))
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const beginSpy = vi.spyOn(AudioLine, 'beginBatchAll')
    const endSpy = vi.spyOn(AudioLine, 'endBatchAll')
    const session = createReplSession({ execute } as any)

    session.pushLine('//#evalBegin')
    session.pushLine('var global = init GLOBAL')
    session.pushLine('//#evalEnd')
    await session.idle()

    expect(beginSpy).toHaveBeenCalledTimes(1)
    // The rejected execute() is caught inside executeCurrentBuffer and never escapes the
    // FIFO queue, so //#evalEnd still runs and still closes the batch.
    expect(endSpy).toHaveBeenCalledTimes(1)
  })

  it('a sequence line declared mid-frame is in batch mode from the moment it is constructed', async () => {
    let capturedLine: AudioLine | undefined
    let joinedOpenFrame = false
    const execute = vi.fn().mockImplementation(async () => {
      if (!capturedLine) {
        capturedLine = new AudioLine()
        joinedOpenFrame = capturedLine.isInBatch()
        capturedLine.upsert({ kind: 'rack' })
        capturedLine.upsert({ kind: 'gain', db: -6 })
      }
    })
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const session = createReplSession({ execute } as any)

    session.pushLine('//#evalBegin')
    session.pushLine('kick.gain(-6)')
    session.pushLine('//#evalEnd')
    await session.idle()

    expect(capturedLine).toBeDefined()
    // Constructed after beginBatchAll() already ran: observe frame membership at construction
    // time. #883 deliberately removed the old synthetic master terminal from program().
    expect(joinedOpenFrame).toBe(true)
    expect(capturedLine!.program()).toEqual([{ kind: 'rack' }, { kind: 'gain', db: -6 }])
  })
})
