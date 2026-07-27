/**
 * vscode-free stdout identity guards and agent start decisions.
 */

import { describe, it, expect, vi } from 'vitest'

import {
  applyEngineExit,
  applyEngineStdinError,
  applyEngineStdoutChunk,
  decideStartEngineForAgent,
  type EngineExitEffects,
  type EngineStdinErrorEffects,
  type EngineStdoutEffects,
} from '../../packages/vscode-extension/src/engine-lifecycle'

function effects(): EngineStdoutEffects {
  return {
    handleStep: vi.fn(),
    clearSequence: vi.fn(),
    clearAllPlayheads: vi.fn(),
    handleSelectAudioDeviceLine: vi.fn(() => false),
    warnMalformedSelectAudioDeviceLine: vi.fn(),
    transcribeLog: vi.fn(),
    setPlayingStatus: vi.fn(),
    setReadyStatus: vi.fn(),
  }
}

function exitEffects(): EngineExitEffects {
  return {
    logExit: vi.fn(),
    clearEngineState: vi.fn(),
    clearAllPlayheads: vi.fn(),
    drainDeviceBridge: vi.fn(),
    showStoppedStatus: vi.fn(),
    refreshEngineView: vi.fn(),
  }
}

function stdinErrorEffects(): EngineStdinErrorEffects {
  return {
    logStdinError: vi.fn(),
    drainDeviceBridge: vi.fn(),
  }
}

describe('engine stdout lifecycle', () => {
  it('transcribes and diagnoses stale output without mutating current engine state', () => {
    const fx = effects()
    const output =
      '[STEP] drums 0 123\n⏹ bass stopped\n✅ Global stopped\n{"selectAudioDevice":{"ok":'

    applyEngineStdoutChunk(output, output.split('\n'), false, fx)

    expect(fx.transcribeLog).toHaveBeenCalledOnce()
    expect(fx.warnMalformedSelectAudioDeviceLine).toHaveBeenCalledWith(
      '{"selectAudioDevice":{"ok":',
      true,
    )
    expect(fx.handleStep).not.toHaveBeenCalled()
    expect(fx.clearSequence).not.toHaveBeenCalled()
    expect(fx.clearAllPlayheads).not.toHaveBeenCalled()
    expect(fx.handleSelectAudioDeviceLine).not.toHaveBeenCalled()
    expect(fx.setPlayingStatus).not.toHaveBeenCalled()
    expect(fx.setReadyStatus).not.toHaveBeenCalled()
  })

  it('applies playhead, status, and bridge effects for current output', () => {
    const fx = effects()
    vi.mocked(fx.handleSelectAudioDeviceLine).mockReturnValue(true)
    const output =
      '[STEP] drums 0 123\n⏹ bass stopped\n✅ Global stopped\n{"selectAudioDevice":{"ok":true}}'

    applyEngineStdoutChunk(output, output.split('\n'), true, fx)

    expect(fx.transcribeLog).toHaveBeenCalledOnce()
    expect(fx.handleStep).toHaveBeenCalledWith({
      seqName: 'drums',
      argPath: '0',
      atEpochMs: 123,
    })
    expect(fx.clearSequence).toHaveBeenCalledWith('bass')
    expect(fx.clearAllPlayheads).toHaveBeenCalledOnce()
    expect(fx.handleSelectAudioDeviceLine).toHaveBeenCalled()
    expect(fx.warnMalformedSelectAudioDeviceLine).not.toHaveBeenCalled()
    expect(fx.setReadyStatus).toHaveBeenCalledOnce()
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

  it('logs and applies every state mutation for the current process', () => {
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
