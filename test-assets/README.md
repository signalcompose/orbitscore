# OrbitScore Test Assets

This directory contains test audio files and score examples for OrbitScore development and testing.

## Directory Structure

```
test-assets/
├── audio/              # Test WAV files
├── scores/             # Example .osc files
├── generate-test-audio.js  # Audio generation script
└── README.md          # This file
```

## Audio Files

All audio files are in WAV format (48kHz, 32-bit float, mono):

### Drum Sounds
- `kick.wav` - Synthesized kick drum (0.5s)
- `snare.wav` - Synthesized snare drum (0.2s)
- `hihat_closed.wav` - Closed hi-hat (0.05s)
- `hihat_open.wav` - Open hi-hat (0.15s)

### Bass Sounds
- `bass_c1.wav` - Bass note C2 (65.41 Hz, 1s)
- `bass_e1.wav` - Bass note E2 (82.41 Hz, 1s)
- `bass_g1.wav` - Bass note G2 (98.00 Hz, 1s)

### Melodic Sounds
- `sine_440.wav` - Pure sine wave A4 (440 Hz, 1s)
- `sine_880.wav` - Pure sine wave A5 (880 Hz, 1s)
- `chord_c_major.wav` - C major chord (C4-E4-G4, 2s)
- `chord_a_minor.wav` - A minor chord (A4-C5-E5, 2s)
- `arpeggio_c.wav` - C major arpeggio pattern (1s)

## Score Examples

Example OrbitScore files demonstrating various DSL features:

### 1. `01_basic_drum_pattern.osc`
- **Purpose**: Simple 4/4 drum pattern
- **Features**: Basic sequencing, audio loading, chopping
- **Sequences**: Kick, snare, hi-hat patterns

### 2. `02_bass_sequence.osc`
- **Purpose**: Bass line with layered patterns
- **Features**: Multi-bar loops, time stretching, pitch shifting
- **Sequences**: Two bass layers, simple drums

### 3. `03_melodic_patterns.osc`
- **Purpose**: Melodic content with chords
- **Features**: Long sequences, chord progressions, arpeggios
- **Sequences**: Melody, chords, arpeggiated patterns

### 4. `04_polymeter_example.osc`
- **Purpose**: Polyrhythmic patterns
- **Features**: Different meters (3/4, 4/4, 5/4) playing simultaneously
- **Sequences**: Three different metric patterns creating evolving rhythms

### 5. `05_live_coding_session.osc`
- **Purpose**: Complete live coding example
- **Features**: Section-by-section execution, real-time manipulation
- **Sequences**: Full drum kit, bass, lead, with performance commands
- **Usage**: Execute sections with Cmd+Enter in VS Code

### 6. `06_advanced_techniques.osc`
- **Purpose**: Advanced DSL features
- **Features**: 
  - Nested play structures (flams, rolls)
  - Modified play with `.fixpitch()` and `.time()`
  - Multiple audio sources
  - Polyrhythmic layers
  - Dynamic pattern generation with variables
  - Complex chord progressions

## How to Use

### In VS Code with OrbitScore Extension

1. Open any `.osc` file from the `scores/` directory
2. Select code sections or entire file
3. Press `Cmd+Enter` to execute selected code
4. Use `Cmd+.` to stop playback

### Regenerating Audio Files

If you need to regenerate the test audio files:

```bash
cd test-assets
node generate-test-audio.js
```

This will create all test WAV files in the `audio/` directory.

## Audio File Specifications

- **Format**: WAV
- **Sample Rate**: 48000 Hz
- **Bit Depth**: 32-bit floating point
- **Channels**: Mono (1 channel)
- **Duration**: Varies (0.05s - 2s)

## Notes

- Audio paths in score files use relative paths (`../audio/`)
- All audio files are synthesized (no copyrighted content)
- Files are optimized for testing, not production quality
- Suitable for unit tests, integration tests, and demos

## License

These test assets are part of the OrbitScore project and follow the same license.