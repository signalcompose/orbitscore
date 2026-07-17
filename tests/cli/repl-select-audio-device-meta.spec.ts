/**
 * REPL メタ行 `//#selectAudioDevice <name>`（D2.5, #484）。View/MCP から走行中エンジンの
 * 出力デバイスをライブ切替するための帯域外チャネル。`documentDirectory` と異なり単独行で
 * 即時処理され、相関用の 1 行 JSON を stdout に出す。
 */

import { describe, it, expect, vi } from 'vitest'

import {
  extractSelectAudioDeviceMeta,
  createReplSession,
} from '../../packages/engine/src/cli/repl-mode'
import { InterpreterV2 } from '../../packages/engine/src/interpreter/interpreter-v2'

describe('extractSelectAudioDeviceMeta', () => {
  it('extracts the device name from a meta line', () => {
    expect(extractSelectAudioDeviceMeta('//#selectAudioDevice MacBook Pro Speakers')).toEqual({
      device: 'MacBook Pro Speakers',
    })
  })

  it('returns an empty device (system default) when the name is omitted', () => {
    expect(extractSelectAudioDeviceMeta('//#selectAudioDevice')).toEqual({ device: '' })
    expect(extractSelectAudioDeviceMeta('//#selectAudioDevice ')).toEqual({ device: '' })
  })

  it('returns undefined for unrelated lines (including other meta lines)', () => {
    expect(extractSelectAudioDeviceMeta('var x = 1')).toBeUndefined()
    expect(extractSelectAudioDeviceMeta('//#documentDirectory /songs')).toBeUndefined()
  })

  it('tolerates leading whitespace', () => {
    expect(extractSelectAudioDeviceMeta('  //#selectAudioDevice Built-in Output')).toEqual({
      device: 'Built-in Output',
    })
  })
})

describe('createReplSession //#selectAudioDevice bridge', () => {
  function makeInterpreterWithDevice(impl: {
    selectAudioDevice?: (device: string) => Promise<string>
  }): InterpreterV2 {
    const interpreter = new InterpreterV2()
    const audioEngine = (interpreter as any).state.audioEngine
    audioEngine.boot = vi.fn().mockResolvedValue(undefined)
    if (impl.selectAudioDevice) audioEngine.selectAudioDevice = impl.selectAudioDevice
    return interpreter
  }

  it('emits an ok JSON result line on success', async () => {
    const interpreter = makeInterpreterWithDevice({
      selectAudioDevice: async (device) => device || 'system default',
    })
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      const session = createReplSession(interpreter)
      session.pushLine('//#selectAudioDevice Built-in Output')
      await session.idle()
      expect(logSpy).toHaveBeenCalledWith(
        JSON.stringify({ selectAudioDevice: { ok: true, device: 'Built-in Output' } }),
      )
    } finally {
      logSpy.mockRestore()
    }
  })

  it('emits an error JSON result line when the backend rejects', async () => {
    const interpreter = makeInterpreterWithDevice({
      selectAudioDevice: async () => {
        throw new Error('AUDIO_DEVICE_SWITCH_UNAVAILABLE')
      },
    })
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      const session = createReplSession(interpreter)
      session.pushLine('//#selectAudioDevice')
      await session.idle()
      expect(logSpy).toHaveBeenCalledWith(
        JSON.stringify({
          selectAudioDevice: { ok: false, error: 'AUDIO_DEVICE_SWITCH_UNAVAILABLE' },
        }),
      )
    } finally {
      logSpy.mockRestore()
    }
  })

  it('emits an ok:false result when the backend has no selectAudioDevice (SC path)', async () => {
    const interpreter = makeInterpreterWithDevice({})
    // The default (rust) backend happens to implement selectAudioDevice on its prototype,
    // so `delete` wouldn't remove it — shadow it with an own-property override instead,
    // mirroring the SC backend's lack of the method.
    ;(interpreter.audioEngine as any).selectAudioDevice = undefined
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      const session = createReplSession(interpreter)
      session.pushLine('//#selectAudioDevice Foo')
      await session.idle()
      const [payload] = logSpy.mock.calls[logSpy.mock.calls.length - 1]
      const parsed = JSON.parse(payload as string)
      expect(parsed.selectAudioDevice.ok).toBe(false)
      expect(parsed.selectAudioDevice.error).toMatch(/not supported/)
    } finally {
      logSpy.mockRestore()
    }
  })

  it('does not add the meta line to the DSL eval buffer', async () => {
    const interpreter = makeInterpreterWithDevice({
      selectAudioDevice: async (device) => device,
    })
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      const session = createReplSession(interpreter)
      session.pushLine('var global = init GLOBAL')
      session.pushLine('//#selectAudioDevice Foo')
      await session.idle()
      // '✓' is only logged on successful DSL execution; the meta line must not
      // have been folded into that buffer (which would otherwise produce a parse error).
      expect(logSpy).toHaveBeenCalledWith('✓')
    } finally {
      logSpy.mockRestore()
    }
  })
})
