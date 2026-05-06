import * as path from 'path'

import { describe, it, expect, beforeEach, vi } from 'vitest'

import { Global } from '../../packages/engine/src/core/global'
import { Sequence } from '../../packages/engine/src/core/sequence'
import { SuperColliderPlayer } from '../../packages/engine/src/audio/supercollider-player'

describe('Audio path resolution (no process.cwd() fallback)', () => {
  let global: Global
  let seq: Sequence
  let mockPlayer: SuperColliderPlayer

  beforeEach(() => {
    mockPlayer = {
      boot: vi.fn().mockResolvedValue(undefined),
      getCurrentTime: vi.fn().mockReturnValue(0),
      scheduleEvent: vi.fn(),
      scheduleSliceEvent: vi.fn(),
      getMasterGainDb: vi.fn().mockReturnValue(0),
    } as any

    global = new Global(mockPlayer)
    seq = new Sequence(global, mockPlayer)
    seq.setName('test')
  })

  describe('audioPath()', () => {
    it('should accept absolute paths without document context', () => {
      expect(() => global.audioPath('/abs/samples')).not.toThrow()
      expect(global.audioPath()).toBe('/abs/samples')
    })

    it('should resolve relative paths against documentDirectory', () => {
      global.setDocumentDirectory('/Users/foo/songs')
      global.audioPath('./samples')
      expect(global.audioPath()).toBe('/Users/foo/songs/samples')
    })

    it('should throw on relative path without documentDirectory', () => {
      expect(() => global.audioPath('samples')).toThrowError(/no document context/)
    })
  })

  describe('sequence.audio()', () => {
    it('should accept absolute paths', () => {
      expect(() => seq.audio('/abs/kick.wav')).not.toThrow()
    })

    it('should resolve via audioPath when set', () => {
      global.setDocumentDirectory('/Users/foo/songs')
      global.audioPath('/abs/samples')
      seq.audio('kick.wav')
      expect((seq as any)._audioFilePath).toBe(path.join('/abs/samples', 'kick.wav'))
    })

    it('should resolve via documentDirectory when audioPath unset', () => {
      global.setDocumentDirectory('/Users/foo/songs')
      seq.audio('kick.wav')
      expect((seq as any)._audioFilePath).toBe(path.resolve('/Users/foo/songs', 'kick.wav'))
    })

    it('should throw on relative path with no audioPath and no documentDirectory', () => {
      expect(() => seq.audio('kick.wav')).toThrowError(/no audioPath\(\) or document context/)
    })
  })
})
