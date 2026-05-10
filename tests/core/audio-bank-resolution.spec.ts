import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { Global } from '../../packages/engine/src/core/global'
import { Sequence } from '../../packages/engine/src/core/sequence'
import { SuperColliderPlayer } from '../../packages/engine/src/audio/supercollider-player'
import {
  expandHome,
  looksLikePath,
  resolveAudio,
} from '../../packages/engine/src/core/global/audio-resolver'

/**
 * Helpers ----------------------------------------------------------------
 */

function mkTempBank(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'orbs-bank-'))
}

function touch(file: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, '')
}

function makePlayer(): SuperColliderPlayer {
  return {
    boot: vi.fn().mockResolvedValue(undefined),
    getCurrentTime: vi.fn().mockReturnValue(0),
    scheduleEvent: vi.fn(),
    scheduleSliceEvent: vi.fn(),
    getMasterGainDb: vi.fn().mockReturnValue(0),
  } as any
}

/**
 * Pure resolver tests ----------------------------------------------------
 */

describe('audio-resolver: looksLikePath', () => {
  it.each(['./pad.wav', '../pad.wav', '~/pad.wav', '/abs/pad.wav', 'sub/dir/file.wav'])(
    'classifies "%s" as path-direct',
    (spec) => {
      expect(looksLikePath(spec)).toBe(true)
    },
  )

  it.each(['bd', 'bd:2', 'kick.wav', 'hat'])('classifies "%s" as bare name', (spec) => {
    expect(looksLikePath(spec)).toBe(false)
  })
})

describe('audio-resolver: expandHome', () => {
  it('expands "~" alone', () => {
    expect(expandHome('~')).toBe(os.homedir())
  })

  it('expands "~/foo"', () => {
    expect(expandHome('~/foo')).toBe(path.join(os.homedir(), 'foo'))
  })

  it('leaves non-tilde paths untouched', () => {
    expect(expandHome('./foo')).toBe('./foo')
    expect(expandHome('/abs/foo')).toBe('/abs/foo')
    expect(expandHome('foo')).toBe('foo')
  })
})

describe('audio-resolver: resolveAudio', () => {
  let bankRoot: string
  let cache: Map<string, string>

  beforeEach(() => {
    bankRoot = mkTempBank()
    cache = new Map()
  })

  afterEach(() => {
    fs.rmSync(bankRoot, { recursive: true, force: true })
  })

  describe('path-direct mode', () => {
    it('returns absolute paths unchanged', () => {
      const result = resolveAudio({
        spec: '/abs/foo.wav',
        audioPaths: [bankRoot],
        documentDirectory: '/docs',
        cache,
      })
      expect(result).toBe('/abs/foo.wav')
    })

    it('expands ~/ in path-direct specs', () => {
      const result = resolveAudio({
        spec: '~/sample.wav',
        audioPaths: [],
        documentDirectory: '',
        cache,
      })
      expect(result).toBe(path.join(os.homedir(), 'sample.wav'))
    })

    it('resolves relative paths against documentDirectory', () => {
      const result = resolveAudio({
        spec: './foo.wav',
        audioPaths: [],
        documentDirectory: '/docs',
        cache,
      })
      expect(result).toBe('/docs/foo.wav')
    })
  })

  describe('bank lookup', () => {
    it('resolves a bare name to sorted 0th file', () => {
      touch(path.join(bankRoot, 'bd', 'a.wav'))
      touch(path.join(bankRoot, 'bd', 'b.wav'))

      const result = resolveAudio({
        spec: 'bd',
        audioPaths: [bankRoot],
        documentDirectory: '',
        cache,
      })
      expect(result).toBe(path.join(bankRoot, 'bd', 'a.wav'))
    })

    it('resolves "bank:N" to sorted Nth variant', () => {
      touch(path.join(bankRoot, 'hh', '00.wav'))
      touch(path.join(bankRoot, 'hh', '01.wav'))
      touch(path.join(bankRoot, 'hh', '02.wav'))

      const result = resolveAudio({
        spec: 'hh:2',
        audioPaths: [bankRoot],
        documentDirectory: '',
        cache,
      })
      expect(result).toBe(path.join(bankRoot, 'hh', '02.wav'))
    })

    it('wraps the variant index modulo file count', () => {
      touch(path.join(bankRoot, 'cp', 'a.wav'))
      touch(path.join(bankRoot, 'cp', 'b.wav'))

      const result = resolveAudio({
        spec: 'cp:5',
        audioPaths: [bankRoot],
        documentDirectory: '',
        cache,
      })
      // 5 % 2 == 1 → "b.wav"
      expect(result).toBe(path.join(bankRoot, 'cp', 'b.wav'))
    })

    it('falls through to the second audioPath when the first lacks the bank', () => {
      const second = mkTempBank()
      try {
        touch(path.join(second, 'sd', 'snap.wav'))

        const result = resolveAudio({
          spec: 'sd',
          audioPaths: [bankRoot, second],
          documentDirectory: '',
          cache,
        })
        expect(result).toBe(path.join(second, 'sd', 'snap.wav'))
      } finally {
        fs.rmSync(second, { recursive: true, force: true })
      }
    })

    it('accepts uppercase audio extensions (AIFF, MP3 …)', () => {
      touch(path.join(bankRoot, 'pad', 'A.AIFF'))
      touch(path.join(bankRoot, 'pad', 'b.MP3'))

      const result = resolveAudio({
        spec: 'pad',
        audioPaths: [bankRoot],
        documentDirectory: '',
        cache,
      })
      expect(result).toBe(path.join(bankRoot, 'pad', 'A.AIFF'))
    })

    it('throws with a helpful hint when the bank is missing', () => {
      touch(path.join(bankRoot, 'kit', 'a.wav'))

      expect(() =>
        resolveAudio({
          spec: 'missing',
          audioPaths: [bankRoot],
          documentDirectory: '',
          cache,
        }),
      ).toThrow(/Sample not found.*Available banks: kit/)
    })

    it('throws when audioPath is empty and spec is bare', () => {
      expect(() =>
        resolveAudio({
          spec: 'bd',
          audioPaths: [],
          documentDirectory: '',
          cache,
        }),
      ).toThrow(/no audioPath\(\) or document context/)
    })

    it('rejects non-integer variant index', () => {
      expect(() =>
        resolveAudio({
          spec: 'bd:abc',
          audioPaths: [bankRoot],
          documentDirectory: '',
          cache,
        }),
      ).toThrow(/non-negative integer/)
    })
  })

  describe('legacy fallback (bare name with extension)', () => {
    it('resolves "kick.wav" by joining with the first audioPath when no bank exists', () => {
      // No bank folder named kick.wav, no actual file either: Hybrid still
      // returns the legacy join so the engine can surface a load-time error.
      const result = resolveAudio({
        spec: 'kick.wav',
        audioPaths: [bankRoot],
        documentDirectory: '',
        cache,
      })
      expect(result).toBe(path.join(bankRoot, 'kick.wav'))
    })

    it('returns an existing direct file when present in any audioPath entry', () => {
      const second = mkTempBank()
      try {
        touch(path.join(second, 'kick.wav'))

        const result = resolveAudio({
          spec: 'kick.wav',
          audioPaths: [bankRoot, second],
          documentDirectory: '',
          cache,
        })
        expect(result).toBe(path.join(second, 'kick.wav'))
      } finally {
        fs.rmSync(second, { recursive: true, force: true })
      }
    })

    it('prefers bank lookup over legacy fallback when a folder exists', () => {
      // If user accidentally names a bank with an extension-like suffix,
      // bank lookup still wins. Documented edge case.
      touch(path.join(bankRoot, 'snap.wav', '01.wav'))

      const result = resolveAudio({
        spec: 'snap.wav',
        audioPaths: [bankRoot],
        documentDirectory: '',
        cache,
      })
      expect(result).toBe(path.join(bankRoot, 'snap.wav', '01.wav'))
    })
  })

  describe('cache behaviour', () => {
    it('caches resolution results keyed by audioPaths + docDir + spec', () => {
      touch(path.join(bankRoot, 'bd', 'a.wav'))

      const opts = {
        spec: 'bd',
        audioPaths: [bankRoot],
        documentDirectory: '',
        cache,
      }

      const first = resolveAudio(opts)
      // Mutate the file system after the first call. If the cache is hit,
      // the result should still point at "a.wav" rather than "z.wav".
      touch(path.join(bankRoot, 'bd', 'z.wav'))
      const second = resolveAudio(opts)

      expect(second).toBe(first)
      expect(cache.size).toBe(1)
    })
  })
})

/**
 * Integration with Global / Sequence ------------------------------------
 */

describe('Global.audioPath() — variadic + array forms', () => {
  let global: Global
  let player: SuperColliderPlayer

  beforeEach(() => {
    player = makePlayer()
    global = new Global(player)
  })

  it('accepts a single absolute path (legacy)', () => {
    global.audioPath('/abs/samples')
    expect(global.audioPath()).toBe('/abs/samples')
  })

  it('accepts multiple variadic paths', () => {
    global.audioPath('/a', '/b', '/c')
    expect(global.audioPath()).toBe('/a')
    expect(global.getState().audioPaths).toEqual(['/a', '/b', '/c'])
  })

  it('accepts a single array argument', () => {
    global.audioPath(['/a', '/b'])
    expect(global.getState().audioPaths).toEqual(['/a', '/b'])
  })

  it('expands ~/ entries to the home directory', () => {
    global.audioPath('~/Clean-Samples')
    expect(global.getState().audioPaths).toEqual([path.join(os.homedir(), 'Clean-Samples')])
  })

  it('throws on a relative path without a document directory', () => {
    expect(() => global.audioPath('./samples')).toThrow(/no document context/)
  })
})

describe('Sequence.audio() — bare bank names via Global', () => {
  let bankRoot: string
  let global: Global
  let seq: Sequence

  beforeEach(() => {
    bankRoot = mkTempBank()
    const player = makePlayer()
    global = new Global(player)
    seq = new Sequence(global, player)
    seq.setName('test')
  })

  afterEach(() => {
    fs.rmSync(bankRoot, { recursive: true, force: true })
  })

  it('resolves "bd" against the configured audioPath', () => {
    touch(path.join(bankRoot, 'bd', '01.wav'))
    global.audioPath(bankRoot)

    seq.audio('bd')
    expect((seq as any)._audioFilePath).toBe(path.join(bankRoot, 'bd', '01.wav'))
  })

  it('resolves "bd:1" to the sorted 1st variant', () => {
    touch(path.join(bankRoot, 'bd', '00.wav'))
    touch(path.join(bankRoot, 'bd', '01.wav'))
    global.audioPath(bankRoot)

    seq.audio('bd:1')
    expect((seq as any)._audioFilePath).toBe(path.join(bankRoot, 'bd', '01.wav'))
  })

  it('keeps existing path-direct behaviour for absolute paths', () => {
    seq.audio('/abs/kick.wav')
    expect((seq as any)._audioFilePath).toBe('/abs/kick.wav')
  })

  it('keeps the legacy join behaviour for "kick.wav" + audioPath base', () => {
    global.audioPath('/abs/samples')
    seq.audio('kick.wav')
    expect((seq as any)._audioFilePath).toBe(path.join('/abs/samples', 'kick.wav'))
  })

  it('expands ~/ in path-direct specs', () => {
    seq.audio('~/sample.wav')
    expect((seq as any)._audioFilePath).toBe(path.join(os.homedir(), 'sample.wav'))
  })

  it('invalidates the resolver cache when audioPath is reconfigured', () => {
    touch(path.join(bankRoot, 'bd', 'a.wav'))
    global.audioPath(bankRoot)
    seq.audio('bd')
    expect((seq as any)._audioFilePath).toBe(path.join(bankRoot, 'bd', 'a.wav'))

    const second = mkTempBank()
    try {
      touch(path.join(second, 'bd', 'z.wav'))
      global.audioPath(second)
      seq.audio('bd')
      expect((seq as any)._audioFilePath).toBe(path.join(second, 'bd', 'z.wav'))
    } finally {
      fs.rmSync(second, { recursive: true, force: true })
    }
  })

  it('throws a helpful error when a bare name cannot be resolved', () => {
    global.audioPath(bankRoot)
    expect(() => seq.audio('does_not_exist')).toThrow(/Sample not found/)
  })
})
