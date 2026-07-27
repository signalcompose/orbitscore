/**
 * vscode-free stdout identity guards and agent start decisions.
 */

import { describe, it, expect, vi } from 'vitest'

import {
  applyEngineError,
  applyEngineExit,
  applyEngineStdinError,
  applyEngineStdoutChunk,
  decideStartEngineForAgent,
  transportStatusText,
  type EngineErrorEffects,
  type EngineExitEffects,
  type EngineStdinErrorEffects,
  type EngineStdoutEffects,
  type TransportState,
} from '../../packages/vscode-extension/src/engine-lifecycle'

function effects(): EngineStdoutEffects {
  return {
    handleStep: vi.fn(),
    clearSequence: vi.fn(),
    clearAllPlayheads: vi.fn(),
    handleSelectAudioDeviceLine: vi.fn(() => false),
    warnMalformedSelectAudioDeviceLine: vi.fn(),
    transcribeLog: vi.fn(),
    setTransportStatus: vi.fn(),
  }
}

function terminationEffects(): Omit<EngineExitEffects, 'logExit'> {
  return {
    clearEngineState: vi.fn(),
    clearAllPlayheads: vi.fn(),
    drainDeviceBridge: vi.fn(),
    showStoppedStatus: vi.fn(),
    refreshEngineView: vi.fn(),
  }
}

function exitEffects(): EngineExitEffects {
  return {
    logExit: vi.fn(),
    ...terminationEffects(),
  }
}

function stdinErrorEffects(): EngineStdinErrorEffects {
  return {
    logStdinError: vi.fn(),
    drainDeviceBridge: vi.fn(),
  }
}

function errorEffects(): EngineErrorEffects {
  return {
    logError: vi.fn(),
    ...terminationEffects(),
  }
}

describe('engine stdout lifecycle', () => {
  it('transcribes and diagnoses stale output without mutating current engine state', () => {
    const fx = effects()
    const output =
      '[STEP] drums 0 123\n⏹ bass stopped\n✅ Global stopped\n{"selectAudioDevice":{"ok":'

    applyEngineStdoutChunk(output, output.split('\n'), false, fx)

    expect(fx.transcribeLog).toHaveBeenCalledOnce()
    expect(fx.warnMalformedSelectAudioDeviceLine).toHaveBeenCalledTimes(1)
    expect(fx.warnMalformedSelectAudioDeviceLine).toHaveBeenCalledWith(
      '{"selectAudioDevice":{"ok":',
      true,
    )
    expect(fx.handleStep).not.toHaveBeenCalled()
    expect(fx.clearSequence).not.toHaveBeenCalled()
    expect(fx.clearAllPlayheads).not.toHaveBeenCalled()
    expect(fx.handleSelectAudioDeviceLine).not.toHaveBeenCalled()
    expect(fx.setTransportStatus).not.toHaveBeenCalled()
  })

  it('does not warn for a well-formed //#selectAudioDevice line from a stale engine (#527 review Important #1)', () => {
    // Reproduces the exact false-positive the review reported: a stale
    // engine's result line that is perfectly valid JSON must not be reported
    // as "malformed" — that conflates "may we touch the FIFO" (isCurrent)
    // with "does this line even parse" (a property of the line itself).
    const fx = effects()
    const rawLine = '{"selectAudioDevice":{"ok":true}}'

    applyEngineStdoutChunk(rawLine, [rawLine], false, fx)

    expect(fx.warnMalformedSelectAudioDeviceLine).not.toHaveBeenCalled()
    expect(fx.handleSelectAudioDeviceLine).not.toHaveBeenCalled()
  })

  it('reports accurate (non-hardcoded) staleness for a malformed candidate line even when current', () => {
    // #527 review Important #3: a mutant that hardcodes the `stale` argument
    // to `true` must be caught here — this is the one case (current +
    // malformed) that actually reaches the warn call with isCurrent true.
    const fx = effects()
    const rawLine = '{"selectAudioDevice":{"ok":'

    applyEngineStdoutChunk(rawLine, [rawLine], true, fx)

    expect(fx.warnMalformedSelectAudioDeviceLine).toHaveBeenCalledTimes(1)
    expect(fx.warnMalformedSelectAudioDeviceLine).toHaveBeenCalledWith(rawLine, false)
  })

  it('consumes the select-audio-device bridge exactly once for a well-formed candidate line (#527 review Critical #1)', () => {
    const fx = effects()
    vi.mocked(fx.handleSelectAudioDeviceLine).mockReturnValue(true)
    const rawLine = '{"selectAudioDevice":{"ok":true}}'

    applyEngineStdoutChunk(rawLine, [rawLine], true, fx)

    expect(fx.handleSelectAudioDeviceLine).toHaveBeenCalledTimes(1)
    expect(fx.handleSelectAudioDeviceLine).toHaveBeenCalledWith(rawLine)
    expect(fx.warnMalformedSelectAudioDeviceLine).not.toHaveBeenCalled()
  })

  it('never lets a STEP line reach the select-audio-device bridge (#527 review Critical #2)', () => {
    const fx = effects()
    const rawLine = '[STEP] drums 0 123'

    applyEngineStdoutChunk(rawLine, [rawLine], true, fx)

    expect(fx.handleStep).toHaveBeenCalledTimes(1)
    expect(fx.handleSelectAudioDeviceLine).not.toHaveBeenCalled()
  })

  it('applies playhead, status, and bridge effects for current output', () => {
    const fx = effects()
    vi.mocked(fx.handleSelectAudioDeviceLine).mockReturnValue(true)
    const output =
      '[STEP] drums 0 123\n⏹ bass stopped\n✅ Global stopped\n{"selectAudioDevice":{"ok":true}}'

    applyEngineStdoutChunk(output, output.split('\n'), true, fx)

    expect(fx.transcribeLog).toHaveBeenCalledOnce()
    expect(fx.handleStep).toHaveBeenCalledTimes(1)
    expect(fx.handleStep).toHaveBeenCalledWith({
      seqName: 'drums',
      argPath: '0',
      atEpochMs: 123,
    })
    expect(fx.clearSequence).toHaveBeenCalledTimes(1)
    expect(fx.clearSequence).toHaveBeenCalledWith('bass')
    expect(fx.clearAllPlayheads).toHaveBeenCalledOnce()
    // The bridge sees the two non-candidate, non-step lines (mirroring the
    // pre-refactor "call handleLine on every current line" loop) plus the
    // one genuine candidate line — exactly 3, in that order. A mutant that
    // removes the `!intent.selectAudioDeviceCandidate` guard (double-calling
    // the bridge for the candidate line, #527 review Critical #1) or that
    // drops `continue` after handleStep (letting the STEP line fall through
    // to the same call, #527 review Critical #2) both push this to 4.
    expect(fx.handleSelectAudioDeviceLine).toHaveBeenCalledTimes(3)
    expect(fx.handleSelectAudioDeviceLine).toHaveBeenNthCalledWith(1, '⏹ bass stopped')
    expect(fx.handleSelectAudioDeviceLine).toHaveBeenNthCalledWith(2, '✅ Global stopped')
    expect(fx.handleSelectAudioDeviceLine).toHaveBeenNthCalledWith(
      3,
      '{"selectAudioDevice":{"ok":true}}',
    )
    expect(fx.warnMalformedSelectAudioDeviceLine).not.toHaveBeenCalled()
    expect(fx.setTransportStatus).toHaveBeenCalledTimes(1)
    expect(fx.setTransportStatus).toHaveBeenCalledWith('ready')
  })

  it('wires setTransportStatus("playing") for running output', () => {
    const fx = effects()
    const output = '✅ Global running'

    applyEngineStdoutChunk(output, [output], true, fx)

    expect(fx.setTransportStatus).toHaveBeenCalledTimes(1)
    expect(fx.setTransportStatus).toHaveBeenCalledWith('playing')
  })
})

describe('transportStatusText (#527 review round 3 Important #2)', () => {
  it('renders the playing / ready labels, with and without the debug suffix', () => {
    expect(transportStatusText('playing', false)).toBe('🎵 OrbitScore: ▶️ Playing')
    expect(transportStatusText('playing', true)).toBe('🎵 OrbitScore: ▶️ Playing 🐛')
    expect(transportStatusText('ready', false)).toBe('🎵 OrbitScore: Ready')
    expect(transportStatusText('ready', true)).toBe('🎵 OrbitScore: Ready 🐛')
  })

  it('throws instead of silently falling through to "Ready" for a value outside the union', () => {
    // A ternary (the pre-fix shape) would fold any non-'playing' value into
    // the 'ready' branch — no log, no error, just a status bar showing
    // "Ready" while the engine is actually playing. The exhaustive switch
    // must throw instead. The invalid value can only be reached by bypassing
    // the type system (e.g. a future IPC/JSON boundary), hence the cast.
    expect(() => transportStatusText('unknown' as unknown as TransportState, false)).toThrow(
      /Unhandled transport state/,
    )
  })
})

describe('applyEngineExit', () => {
  it('logs but skips every state mutation for a stale (non-current) process', () => {
    const fx = exitEffects()

    applyEngineExit(1, false, fx)

    expect(fx.logExit).toHaveBeenCalledWith(1)
    expect(fx.clearEngineState).not.toHaveBeenCalled()
    expect(fx.clearAllPlayheads).not.toHaveBeenCalled()
    expect(fx.drainDeviceBridge).not.toHaveBeenCalled()
    expect(fx.showStoppedStatus).not.toHaveBeenCalled()
    expect(fx.refreshEngineView).not.toHaveBeenCalled()
  })

  it('logs and applies every state mutation, in order, for the current process (#527 review Important #2)', () => {
    const fx = exitEffects()

    applyEngineExit(0, true, fx)

    expect(fx.logExit).toHaveBeenCalledWith(0)
    expect(fx.clearEngineState).toHaveBeenCalledOnce()
    expect(fx.clearAllPlayheads).toHaveBeenCalledOnce()
    expect(fx.drainDeviceBridge).toHaveBeenCalledWith(
      'engine process exited before responding to //#selectAudioDevice',
    )
    expect(fx.showStoppedStatus).toHaveBeenCalledOnce()
    expect(fx.refreshEngineView).toHaveBeenCalledOnce()

    // Order matters: refreshEngineView reads engine-view state through
    // extension.ts's module closures, so it must run AFTER clearEngineState
    // nulls out engineProcess — otherwise the view reads one stale cycle. A
    // mutant that reverses this sequence must fail here even though every
    // individual mock above was still called exactly once with the right
    // argument.
    const order = (fn: { mock: { invocationCallOrder: number[] } }) =>
      fn.mock.invocationCallOrder[0]
    expect(order(fx.logExit)).toBeLessThan(order(fx.clearEngineState))
    expect(order(fx.clearEngineState)).toBeLessThan(order(fx.clearAllPlayheads))
    expect(order(fx.clearAllPlayheads)).toBeLessThan(order(fx.drainDeviceBridge))
    expect(order(fx.drainDeviceBridge)).toBeLessThan(order(fx.showStoppedStatus))
    expect(order(fx.showStoppedStatus)).toBeLessThan(order(fx.refreshEngineView))
  })
})

describe('applyEngineStdinError', () => {
  it('logs but does not drain the device bridge for a stale (non-current) process', () => {
    const fx = stdinErrorEffects()

    applyEngineStdinError('EPIPE', false, fx)

    expect(fx.logStdinError).toHaveBeenCalledWith('EPIPE')
    expect(fx.drainDeviceBridge).not.toHaveBeenCalled()
  })

  it('logs and drains the device bridge for the current process', () => {
    const fx = stdinErrorEffects()

    applyEngineStdinError('EPIPE', true, fx)

    expect(fx.logStdinError).toHaveBeenCalledWith('EPIPE')
    expect(fx.drainDeviceBridge).toHaveBeenCalledWith('engine stdin error: EPIPE')
  })
})

describe('applyEngineError (#533)', () => {
  it('logs but skips every state mutation for a stale (non-current) process', () => {
    const fx = errorEffects()
    const err = new Error('spawn node ENOENT')

    applyEngineError(err, false, fx)

    expect(fx.logError).toHaveBeenCalledWith(err)
    expect(fx.clearEngineState).not.toHaveBeenCalled()
    expect(fx.clearAllPlayheads).not.toHaveBeenCalled()
    expect(fx.drainDeviceBridge).not.toHaveBeenCalled()
    expect(fx.showStoppedStatus).not.toHaveBeenCalled()
    expect(fx.refreshEngineView).not.toHaveBeenCalled()
  })

  it('logs and applies every state mutation, in order, for the current process', () => {
    const fx = errorEffects()
    const err = new Error('spawn node ENOENT')

    applyEngineError(err, true, fx)

    expect(fx.logError).toHaveBeenCalledWith(err)
    expect(fx.clearEngineState).toHaveBeenCalledOnce()
    expect(fx.clearAllPlayheads).toHaveBeenCalledOnce()
    expect(fx.drainDeviceBridge).toHaveBeenCalledWith('engine process error: spawn node ENOENT')
    expect(fx.showStoppedStatus).toHaveBeenCalledOnce()
    expect(fx.refreshEngineView).toHaveBeenCalledOnce()

    // Order matters, same rationale as applyEngineExit's equivalent test:
    // a reordering mutant must fail here even though every individual mock
    // above was still called exactly once with the right argument.
    const order = (fn: { mock: { invocationCallOrder: number[] } }) =>
      fn.mock.invocationCallOrder[0]
    expect(order(fx.logError)).toBeLessThan(order(fx.clearEngineState))
    expect(order(fx.clearEngineState)).toBeLessThan(order(fx.clearAllPlayheads))
    expect(order(fx.clearAllPlayheads)).toBeLessThan(order(fx.drainDeviceBridge))
    expect(order(fx.drainDeviceBridge)).toBeLessThan(order(fx.showStoppedStatus))
    expect(order(fx.showStoppedStatus)).toBeLessThan(order(fx.refreshEngineView))
  })
})

describe('decideStartEngineForAgent', () => {
  it('rejects capture_wav while running and directs the caller to stop_engine', () => {
    const decision = decideStartEngineForAgent(true, { captureWav: '/tmp/capture.wav' })
    expect(decision.kind).toBe('reject')
    expect(decision).toMatchObject({
      error: expect.stringContaining('capture_wav'),
    })
    expect(decision).toMatchObject({
      error: expect.stringContaining('stop_engine'),
    })
  })

  it('rejects debug while running and directs the caller to stop_engine', () => {
    const decision = decideStartEngineForAgent(true, { debug: true })
    expect(decision.kind).toBe('reject')
    expect(decision).toMatchObject({
      error: expect.stringContaining('debug'),
    })
    expect(decision).toMatchObject({
      error: expect.stringContaining('stop_engine'),
    })
  })

  it('reuses a running engine when no spawn-only options were requested', () => {
    expect(decideStartEngineForAgent(true)).toEqual({ kind: 'already-running' })
  })

  it('spawns when the engine is not running', () => {
    expect(
      decideStartEngineForAgent(false, { captureWav: '/tmp/capture.wav', debug: true }),
    ).toEqual({
      kind: 'spawn',
    })
  })
})
