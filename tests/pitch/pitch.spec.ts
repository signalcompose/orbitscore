import { describe, it, expect } from 'vitest'

import { PitchConverter } from '../../packages/engine/src/pitch'
import type { SequenceConfig } from '../../packages/engine/src/ir'

describe('PitchConverter', () => {
  const createConfig = (overrides: Partial<SequenceConfig> = {}): Required<SequenceConfig> => ({
    name: 'test',
    bus: 'test-bus',
    channel: 1,
    key: 'C',
    tempo: 120,
    meter: { n: 4, d: 4, align: 'shared' },
    octave: 0.0, // C4を基準とするため0に設定
    octmul: 1.0,
    bendRange: 2,
    mpe: false,
    defaultDur: { kind: 'unit', value: 1 },
    randseed: 0,
    ...overrides,
  })

  describe('degreeToSemitone conversion', () => {
    it('should convert degree 1 (C) to root note', () => {
      const converter = new PitchConverter(createConfig({ key: 'C' }))
      const result = converter.convertPitch({ degree: 1 })
      expect(result.note).toBe(0) // C0 = MIDI note 0 (octave 0)
      expect(result.pitchBend).toBe(0)
    })

    it('should convert degree 2 (C#) to semitone 1', () => {
      const converter = new PitchConverter(createConfig({ key: 'C' }))
      const result = converter.convertPitch({ degree: 2 })
      expect(result.note).toBe(1) // C#0 = MIDI note 1 (octave 0)
      expect(result.pitchBend).toBe(0)
    })

    it('should convert degree 8 (G) to semitone 7', () => {
      const converter = new PitchConverter(createConfig({ key: 'C' }))
      const result = converter.convertPitch({ degree: 8 })
      expect(result.note).toBe(7) // G0 = MIDI note 7 (octave 0)
      expect(result.pitchBend).toBe(0)
    })

    it('should map all 12 degrees correctly in key C', () => {
      const converter = new PitchConverter(createConfig({ key: 'C' }))

      // Complete degree to MIDI note mapping in key C (octave 0)
      const expectedMapping = [
        { degree: 1, note: 0 }, // C0
        { degree: 2, note: 1 }, // C#0
        { degree: 3, note: 2 }, // D0
        { degree: 4, note: 3 }, // D#0
        { degree: 5, note: 4 }, // E0
        { degree: 6, note: 5 }, // F0
        { degree: 7, note: 6 }, // F#0
        { degree: 8, note: 7 }, // G0
        { degree: 9, note: 8 }, // G#0
        { degree: 10, note: 9 }, // A0
        { degree: 11, note: 10 }, // A#0
        { degree: 12, note: 11 }, // B0
      ]

      expectedMapping.forEach(({ degree, note }) => {
        const result = converter.convertPitch({ degree })
        expect(result.note).toBe(note)
      })
    })
  })

  describe('key transposition', () => {
    it('should transpose correctly for different keys', () => {
      const converterC = new PitchConverter(createConfig({ key: 'C' }))
      const converterG = new PitchConverter(createConfig({ key: 'G' }))

      const resultC = converterC.convertPitch({ degree: 1 })
      const resultG = converterG.convertPitch({ degree: 1 })

      expect(resultC.note).toBe(0) // C0 (degree 1 = root in key C)
      expect(resultG.note).toBe(7) // G0 (degree 1 = root in key G)
    })

    it('should handle flat keys correctly', () => {
      const converter = new PitchConverter(createConfig({ key: 'Db' }))
      const result = converter.convertPitch({ degree: 1 })
      expect(result.note).toBe(1) // Db0 (degree 1 = root in key Db)
    })
  })

  describe('octave shift', () => {
    it('should apply octave shift correctly', () => {
      const converter = new PitchConverter(createConfig())
      const result = converter.convertPitch({ degree: 1, octaveShift: 1 })
      expect(result.note).toBe(12) // C1 = MIDI note 12
    })

    it('should apply negative octave shift correctly', () => {
      const converter = new PitchConverter(createConfig())
      const result = converter.convertPitch({ degree: 1, octaveShift: -1 })
      expect(result.note).toBe(0) // C0 = MIDI note 0 (negative octave shift clamped)
    })
  })

  describe('detune', () => {
    it('should apply detune correctly', () => {
      const converter = new PitchConverter(createConfig())
      const result = converter.convertPitch({ degree: 1, detune: 0.5 })
      expect(result.note).toBe(0) // C0 base note
      expect(result.pitchBend).toBe(2048) // 0.5 / bendRange(2) * 8192
    })

    it('should apply negative detune correctly', () => {
      const converter = new PitchConverter(createConfig())
      const result = converter.convertPitch({ degree: 1, detune: -0.3 })
      expect(result.note).toBe(0) // C0 base note
      expect(result.pitchBend).toBe(-1229) // -0.3 semitones * 4096
    })
  })

  describe('octave and octmul', () => {
    it('should apply octave correctly', () => {
      const converter = new PitchConverter(createConfig({ octave: 1.0 }))
      const result = converter.convertPitch({ degree: 1 })
      expect(result.note).toBe(12) // C1 = MIDI note 12 (0 + 12)
    })

    it('should apply octmul correctly (applies to octave term only)', () => {
      const converter = new PitchConverter(createConfig({ octave: 1.0, octmul: 2.0 }))
      const result = converter.convertPitch({ degree: 1 })
      expect(result.note).toBe(24) // 0 + 0 + (1*2*12) = 24
    })
  })

  describe('bendRange', () => {
    it('should respect bendRange setting', () => {
      const converter = new PitchConverter(createConfig({ bendRange: 4 }))
      const result = converter.convertPitch({ degree: 1, detune: 1.0 })
      expect(result.note).toBe(0) // C0 base note (detune is applied via pitch bend)
      expect(result.pitchBend).toBe(2048) // 1.0 / 4 * 8192
    })
  })

  describe('MPE channel assignment', () => {
    it('should assign channels sequentially in MPE mode', () => {
      const converter = new PitchConverter(createConfig({ mpe: true }))

      const result1 = converter.convertPitch({ degree: 1 })
      const result2 = converter.convertPitch({ degree: 2 })
      const result3 = converter.convertPitch({ degree: 3 })

      expect(result1.channel).toBe(1)
      expect(result2.channel).toBe(2)
      expect(result3.channel).toBe(3)
    })

    it('should wrap around after channel 15 in MPE mode', () => {
      const converter = new PitchConverter(createConfig({ mpe: true }))

      // Generate 16 notes to test wrap-around
      const results = []
      for (let i = 0; i < 16; i++) {
        results.push(converter.convertPitch({ degree: 1 }))
      }

      expect(results[14].channel).toBe(15)
      expect(results[15].channel).toBe(1) // Wraps back to 1
    })

    it('should use same channel in non-MPE mode', () => {
      const converter = new PitchConverter(createConfig({ mpe: false, channel: 5 }))

      const result1 = converter.convertPitch({ degree: 1 })
      const result2 = converter.convertPitch({ degree: 2 })

      expect(result1.channel).toBe(5)
      expect(result2.channel).toBe(5)
    })
  })

  describe('random suffix', () => {
    it('should apply random value for r suffix', () => {
      const converter = new PitchConverter(createConfig({ randseed: 12345 }))

      // Test with original value containing 'r'
      const result1 = converter.convertPitch({ degree: 1.0 }, '1.0r')
      const result2 = converter.convertPitch({ degree: 1.0 }, '1.0r')

      // Should be deterministic with same seed
      expect(result1.note).toBe(result2.note)
      expect(result1.pitchBend).toBe(result2.pitchBend)
    })

    it('should not apply random value without r suffix', () => {
      const converter = new PitchConverter(createConfig())

      const result1 = converter.convertPitch({ degree: 1.0 }, '1.0')
      const result2 = converter.convertPitch({ degree: 1.0 }, '1.0')

      // Should be identical
      expect(result1.note).toBe(result2.note)
      expect(result1.pitchBend).toBe(result2.pitchBend)
    })
  })

  describe('edge cases', () => {
    it('should clamp MIDI note to valid range', () => {
      const converter = new PitchConverter(createConfig({ octave: 6.0 }))
      const result = converter.convertPitch({ degree: 1 })
      expect(result.note).toBe(72) // C6 = MIDI note 72 (0 + 6*12)
    })

    it('should clamp MIDI note to minimum range', () => {
      const converter = new PitchConverter(createConfig({ octave: -6.0 }))
      const result = converter.convertPitch({ degree: 1 })
      expect(result.note).toBe(0) // Clamped to min MIDI note
    })

    it('should throw error for rest (degree 0)', () => {
      const converter = new PitchConverter(createConfig())
      expect(() => converter.convertPitch({ degree: 0 })).toThrow()
    })
  })

  describe('channel reset', () => {
    it('should reset channel assignment', () => {
      const converter = new PitchConverter(createConfig({ mpe: true }))

      converter.convertPitch({ degree: 1 })
      converter.convertPitch({ degree: 2 })

      converter.resetChannelAssignment()

      const result = converter.convertPitch({ degree: 3 })
      expect(result.channel).toBe(1)
    })
  })
})
