import { describe, it, expect } from "vitest";
import { convertDegreeToMidi, convertChordToMidi } from "../../packages/engine/src/pitch";
import type { PitchSpec, SequenceConfig } from "../../packages/engine/src/ir";

describe("Pitch Conversion", () => {
  const defaultConfig: Required<SequenceConfig> = {
    name: "test",
    bus: "test",
    channel: 1,
    key: "C",
    tempo: 120,
    meter: { n: 4, d: 4, align: "shared" },
    octave: 4.0,
    octmul: 1.0,
    bendRange: 2,
    mpe: false,
    defaultDur: { kind: "unit", value: 1 },
    randseed: 0
  };

  describe("convertDegreeToMidi", () => {
    it("should convert basic degrees correctly", () => {
      // C major scale degrees
      const cMajor: PitchSpec = { degree: 1 }; // C
      const result = convertDegreeToMidi(cMajor, defaultConfig);
      expect(result.note).toBe(60); // Middle C
      expect(result.pitchBend).toBe(0);
      expect(result.channel).toBe(1);
    });

    it("should handle different keys", () => {
      const configG: Required<SequenceConfig> = { ...defaultConfig, key: "G" };
      const gMajor: PitchSpec = { degree: 1 }; // G
      const result = convertDegreeToMidi(gMajor, configG);
      expect(result.note).toBe(67); // G4
      expect(result.pitchBend).toBe(0);
    });

    it("should handle octave shifts", () => {
      const octaveUp: PitchSpec = { degree: 1, octaveShift: 1 };
      const result = convertDegreeToMidi(octaveUp, defaultConfig);
      expect(result.note).toBe(72); // C5
      expect(result.pitchBend).toBe(0);
    });

    it("should handle detune", () => {
      const detuned: PitchSpec = { degree: 1, detune: 0.5 };
      const result = convertDegreeToMidi(detuned, defaultConfig);
      expect(result.note).toBe(60); // C4
      expect(result.pitchBend).toBe(2048); // +0.5 semitones
    });

    it("should handle fractional degrees", () => {
      const fractional: PitchSpec = { degree: 1.5 };
      const result = convertDegreeToMidi(fractional, defaultConfig);
      expect(result.note).toBe(60); // C4
      expect(result.pitchBend).toBe(2048); // +0.5 semitones
    });

    it("should respect bendRange", () => {
      const configWide: Required<SequenceConfig> = { ...defaultConfig, bendRange: 4 };
      const detuned: PitchSpec = { degree: 1, detune: 1.0 };
      const result = convertDegreeToMidi(detuned, configWide);
      expect(result.note).toBe(60); // C4
      expect(result.pitchBend).toBe(2048); // +1 semitone with 4-semitone range
    });

    it("should handle octave multiplication", () => {
      const configOctMul: Required<SequenceConfig> = { ...defaultConfig, octmul: 2.0 };
      const normal: PitchSpec = { degree: 1 };
      const result = convertDegreeToMidi(normal, configOctMul);
      expect(result.note).toBe(72); // C5 (doubled)
      expect(result.pitchBend).toBe(0);
    });

    it("should handle different base octave", () => {
      const configOct3: Required<SequenceConfig> = { ...defaultConfig, octave: 3.0 };
      const normal: PitchSpec = { degree: 1 };
      const result = convertDegreeToMidi(normal, configOct3);
      expect(result.note).toBe(48); // C3
      expect(result.pitchBend).toBe(0);
    });
  });

  describe("convertChordToMidi", () => {
    it("should convert chord without MPE", () => {
      const chord: PitchSpec[] = [
        { degree: 1 }, // C
        { degree: 3 }, // E
        { degree: 5 }  // G
      ];
      const results = convertChordToMidi(chord, defaultConfig, 1);
      
      expect(results).toHaveLength(3);
      expect(results[0].channel).toBe(1);
      expect(results[1].channel).toBe(1);
      expect(results[2].channel).toBe(1);
      
      expect(results[0].note).toBe(60); // C4
      expect(results[1].note).toBe(64); // E4
      expect(results[2].note).toBe(67); // G4
    });

    it("should convert chord with MPE", () => {
      const configMPE: Required<SequenceConfig> = { ...defaultConfig, mpe: true };
      const chord: PitchSpec[] = [
        { degree: 1 }, // C
        { degree: 3 }, // E
        { degree: 5 }  // G
      ];
      const results = convertChordToMidi(chord, configMPE, 1);
      
      expect(results).toHaveLength(3);
      expect(results[0].channel).toBe(1);
      expect(results[1].channel).toBe(2);
      expect(results[2].channel).toBe(3);
      
      expect(results[0].note).toBe(60); // C4
      expect(results[1].note).toBe(64); // E4
      expect(results[2].note).toBe(67); // G4
    });

    it("should handle large chords with MPE", () => {
      const configMPE: Required<SequenceConfig> = { ...defaultConfig, mpe: true };
      const chord: PitchSpec[] = [
        { degree: 1 }, { degree: 3 }, { degree: 5 },
        { degree: 7 }, { degree: 9 }, { degree: 11 },
        { degree: 13 }, { degree: 15 }, { degree: 17 },
        { degree: 19 }, { degree: 21 }, { degree: 23 },
        { degree: 25 }, { degree: 27 }, { degree: 29 },
        { degree: 31 }, { degree: 33 } // 17 notes
      ];
      const results = convertChordToMidi(chord, configMPE, 1);
      
      expect(results).toHaveLength(17);
      // Channels should cycle through 1-15
      expect(results[0].channel).toBe(1);
      expect(results[14].channel).toBe(15);
      expect(results[15].channel).toBe(1); // Wraps around
      expect(results[16].channel).toBe(2);
    });
  });

  describe("Edge Cases", () => {
    it("should handle rest (degree 0)", () => {
      const rest: PitchSpec = { degree: 0 };
      const result = convertDegreeToMidi(rest, defaultConfig);
      expect(result.note).toBe(0); // MIDI note 0
      expect(result.pitchBend).toBe(0);
    });

    it("should clamp MIDI notes to valid range", () => {
      const veryHigh: PitchSpec = { degree: 1, octaveShift: 10 };
      const result = convertDegreeToMidi(veryHigh, defaultConfig);
      expect(result.note).toBe(127); // Clamped to max MIDI note
    });

    it("should clamp pitch bend to valid range", () => {
      const configSmall: Required<SequenceConfig> = { ...defaultConfig, bendRange: 0.1 };
      const veryDetuned: PitchSpec = { degree: 1, detune: 10 };
      const result = convertDegreeToMidi(veryDetuned, configSmall);
      expect(result.pitchBend).toBe(8191); // Clamped to max pitch bend
    });
  });
});