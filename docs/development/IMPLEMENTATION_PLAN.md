# OrbitScore Audio-Based DSL Implementation Plan

## Overview

Implementation plan for the new audio-based OrbitScore DSL as defined in `INSTRUCTION_ORBITSCORE_DSL.md`.

**Single Source of Truth**: [`../core/INSTRUCTION_ORBITSCORE_DSL.md`](../core/INSTRUCTION_ORBITSCORE_DSL.md)

## Migration Status

- **Old System**: MIDI-based DSL (deprecated)
- **New System**: Audio-based DSL (✅ Core implementation complete)
- **Migration Date**: December 25, 2024
- **Completion Status**: ~90% (Core features complete, advanced features pending)
- **Refactoring Status**: ✅ Phase 1-7 Complete (All major refactoring completed)
- **DSL Version**: v3.0 (Underscore prefix + Unidirectional toggle)

## Current Implementation Summary

### ✅ Completed (tested)
- **Parser**: Full DSL syntax support with 50 tests
- **Object-Oriented Architecture**: Global and Sequence classes
- **Audio Engine**: WAV loading, slicing, SuperCollider-based playback
- **Transport System**: Scheduling, polymeter, mute/unmute
- **VS Code Extension**: Syntax highlighting, autocomplete, execution
- **Timing Calculation**: Hierarchical play patterns
- **Method Chaining**: Fluent API across all components
- **Audio Slicing (chop)**: SuperCollider buffer-based partial playback
- **CLI with Timeout**: Auto-stop feature for testing
- **Real Audio Playback**: Verified with kick, snare, hihat, bass, arpeggio

### ⚠️ Partially Implemented
- **Audio Formats**: Only WAV fully supported (AIFF/MP3/MP4 placeholders)
- **Time Stretching**: Basic tempo adjustment (needs quality algorithm)
- **Pitch Shifting**: Placeholder only (needs DSP implementation)
- **Infinite Loop**: length(n) provides finite loops (needs loop() method)

### 📋 Not Yet Implemented
- **Force Modifier**: `.force` for immediate transport
- **Composite Meters**: `((3 by 4)(2 by 4))` syntax
- **Advanced Audio**: offset, reverse, fade
- **DAW Plugin**: VST/AU development (Phase A5)

### 📊 Testing Coverage
- **Total Tests**: 225 passed, 23 skipped (248 total) = 90.7%
- **Parser Tests**: 50/50
- **Interpreter Tests**: 83/83
- **DSL v3.0 Tests**: 56/56 (Unidirectional Toggle, Underscore Prefix, Gain/Pan)
- **Audio Engine Tests**: 15/15 (SuperCollider integration)
- **Real Audio Tests**: Verified with actual playback (kick, snare, hihat, bass, arpeggio)

## Implementation Phases

### Phase A1: New Parser Implementation ✅ COMPLETED

**Goal**: Implement parser for the audio-based DSL syntax
**Status**: Fully implemented and tested

#### A1.1 Tokenizer Updates
- [x] Support for `by` keyword (meter syntax)
- [x] Support for `.` operator (method calls)
- [x] Support for `var` keyword
- [x] Support for `init` keyword
- [x] Support for parentheses in expressions

#### A1.2 Global Parameter Parsing
```js
global.tempo(140)
global.tick(480)
global.beat(4 by 4)
global.beat((3 by 4)(2 by 4))
global.key(C)
```
- [x] Parse method call syntax
- [x] Parse `n by m` meter notation
- [ ] Parse composite meters (partially)
- [ ] Parse shorthand aliases (not implemented, using autocomplete instead)

#### A1.3 Initialization Parsing
```js
var global = init GLOBAL
var seq1 = init GLOBAL.seq
```
- [x] Parse variable declarations
- [x] Parse init expressions (both `init GLOBAL` and `init global.seq`)
- [x] Track initialized sequences

#### A1.4 Sequence Configuration
```js
seq1.tempo(120)
seq1.beat(17 by 8)
seq1.audio("../audio/piano1.wav").chop(6)
```
- [x] Parse sequence method calls
- [x] Parse audio loading
- [x] Parse chop parameters

#### A1.5 Play Structure Parsing
```js
seq1.play(0)
seq1.play((0)(0))
seq1.play((0)((0)(0)))
seq1.play(0.chop(5), 0.chop(4))
seq1.play(1).fixpitch(0)
```
- [x] Parse nested play structures (both `(1, 2)` and `(1)(2)` syntax)
- [x] Parse functional form (.chop, .time)
- [x] Parse fixpitch modifier
- [x] Parse slice numbers (1-n for chop(n))

#### A1.6 Transport Command Parsing
```js
global.start()
global.start.force()
global.loop(seq1, seq2)
seq1.mute()
```
- [x] Parse transport methods
- [ ] Parse force modifier (not yet implemented)
- [x] Parse targeted sequences

#### A1.7 Testing
- [x] Create test suite for all syntax variants (31 parser tests)
- [x] Generate IR for sample files
- [x] Validate parser error handling

### Phase A2: Audio Engine Integration ✅ MOSTLY COMPLETED

**Goal**: Implement audio playback and processing
**Status**: Core features implemented, some advanced features pending

#### A2.1 Audio File Loading
- [x] WAV format support (fully implemented)
- [ ] AIFF format support (placeholder)
- [ ] MP3 format support (placeholder)
- [ ] MP4 format support (placeholder)
- [x] Sample rate conversion to 48kHz

#### A2.2 Audio Slicing
- [x] Implement chop(n) functionality
- [x] Calculate slice boundaries
- [x] Handle edge cases (chop(1), default behavior)

#### A2.3 Time-Stretching
- [x] Default playback (tempo-adjusted)
- [ ] Implement quality time-stretch algorithm (WSOLA)
- [ ] Maintain audio quality

#### A2.4 Pitch Shifting
- [ ] Implement fixpitch(n) functionality (placeholder only)
- [ ] Granular synthesis or Phase Vocoder
- [ ] Preserve formants option

#### A2.5 Audio Output
- [x] Web Audio API integration (node-web-audio-api)
- [x] Buffer management
- [ ] Latency optimization

### Phase A3: Transport System ✅ MOSTLY COMPLETED

**Goal**: Implement real-time transport controls
**Status**: Core transport implemented, some advanced features pending

#### A3.1 Global Transport
- [x] run() - start transport
- [ ] start.force() - immediate start (not implemented)
- [x] loop() - loop mode
- [ ] loop.force() - immediate loop (not implemented)
- [x] stop() - stop transport

#### A3.2 Sequence Transport
- [x] Per-sequence run/loop/stop
- [x] Mute/unmute functionality
- [x] Targeted transport (specific sequences)

#### A3.3 Scheduling
- [x] Bar boundary quantization
- [x] Independent sequence timing
- [x] Polymeter support (tested with 5/4 vs 4/4)

#### A3.4 State Management
- [x] Track playing sequences
- [x] Handle sequence synchronization
- [ ] Manage loop points (partial)

### Phase A4: VS Code Extension Update ✅ COMPLETED

**Goal**: Update extension for audio DSL support
**Status**: Fully implemented with context-aware features

#### A4.1 Syntax Highlighting
- [x] Update grammar for new syntax
- [x] Highlight method calls
- [x] Highlight transport commands

#### A4.2 Command Execution
- [x] Implement Cmd+Enter execution
- [x] Parse selected text
- [x] Send to engine via IPC

#### A4.3 IntelliSense and Autocomplete
- [x] Method autocomplete
  - [x] Context-aware suggestions (global vs sequence methods)
  - [x] Method signature display
  - [x] Quick info tooltips
- [x] Parameter hints
  - [x] Type information
  - [x] Valid value ranges
  - Example values
- [ ] Documentation hover
  - Method descriptions
  - Usage examples
  - Links to documentation
- [ ] Snippet support
  - Common patterns (init, play, etc.)
  - Template expansion
  - Cursor positioning
- [ ] NO abbreviations in DSL
  - Full readable names only
  - Speed through autocomplete, not shortcuts
  - Maintain code readability

#### A4.4 Diagnostics
- [ ] Real-time syntax checking
- [ ] Error highlighting
- [ ] Warning for deprecated features

### Phase A5: DAW Plugin Development

**Goal**: Create VST/AU plugin for DAW integration

#### A5.1 Plugin Architecture
- [ ] VST3 wrapper implementation
- [ ] AU wrapper implementation
- [ ] IPC with OrbitScore engine

#### A5.2 Audio Routing
- [ ] Select sequence output
- [ ] Multi-channel support
- [ ] Sync with DAW transport

#### A5.3 Parameter Automation
- [ ] Expose parameters to DAW
- [ ] Handle automation curves
- [ ] Real-time parameter updates

## Testing Strategy

### Unit Tests
- Parser: All syntax variants
- Audio Engine: File formats, slicing, stretching
- Transport: State transitions, timing

### Integration Tests
- End-to-end playback
- Multi-sequence synchronization
- Editor command execution

### Performance Tests
- Audio latency measurement
- CPU usage optimization
- Memory management

## Success Criteria

1. **Parser**: Successfully parse all DSL syntax from [`../core/INSTRUCTION_ORBITSCORE_DSL.md`](../core/INSTRUCTION_ORBITSCORE_DSL.md)
2. **Audio**: Play sliced audio with tempo adjustment and optional pitch preservation
3. **Transport**: Execute all transport commands with proper timing
4. **Editor**: Cmd+Enter execution works for all commands
5. **DAW**: Plugin routes audio to DAW tracks

## Migration Path

### Deprecated Components
- `packages/engine/src/midi.ts` - MIDI output
- `packages/engine/src/pitch.ts` - Degree to MIDI conversion
- Old parser for MIDI-based syntax

### New Components Needed
- `packages/engine/src/audio/` - Audio engine
- `packages/engine/src/transport/` - Transport system
- `packages/engine/src/parser/audio-parser.ts` - New parser
- `packages/daw-plugin/` - DAW plugin package

## Risk Mitigation

1. **Audio Latency**: Use appropriate buffer sizes, implement look-ahead
2. **Time-Stretching Quality**: Research best algorithms (Rubber Band, SoundTouch)
3. **Cross-Platform**: Initially focus on macOS, plan for Windows/Linux
4. **DAW Compatibility**: Test with major DAWs (Ableton, Logic, Cubase)

## Timeline Estimate

- Phase A1 (Parser): 1 week
- Phase A2 (Audio Engine): 2-3 weeks
- Phase A3 (Transport): 1 week
- Phase A4 (VS Code Extension): 1 week
- Phase A5 (DAW Plugin): 2-3 weeks

**Total**: 7-10 weeks for full implementation

## Future Improvements (Post DSL v3.0)

### 中優先度（次のPRで対処可能）

#### ⚠️ エッジケーステストの追加
**関連Issue**: Claude Review #45 項目5
**目的**: RUN/LOOP/MUTEコマンドの堅牢性向上
**内容**:
- 空のコマンド: `RUN()`, `LOOP()`, `MUTE()`
- 重複シーケンス: `RUN(kick, kick, kick)`
- 存在しないシーケンス: `RUN(nonexistent)`（現在は警告のみ）
- RUN→LOOP遷移時の挙動確認
- 同一シーケンスの複数グループ所属

**実装場所**: `tests/interpreter/unidirectional-toggle.spec.ts`

#### ⚠️ パフォーマンス最適化
**関連Issue**: Claude Review #45 項目4
**目的**: handleLoopCommandの処理効率向上
**内容**:
- 現在の二重ループを単一ループに統合
- oldLoopGroupとnewLoopGroupの差分処理を最適化
- メモリアロケーション削減

**実装場所**: `packages/engine/src/interpreter/process-statement.ts`
**推定工数**: 0.5日

### 低優先度（将来的な改善）

#### 📚 ドキュメント充実
**関連Issue**: Claude Review #45 項目6
**目的**: 実践的なユースケースの提供
**内容**:
- より多くの実用例（ライブコーディングパターン）
- DSL v2.0からv3.0への移行ガイド
- RUN/LOOP/MUTEの組み合わせパターン集
- トラブルシューティングガイド

**実装場所**:
- `docs/USER_MANUAL.md`
- `docs/MIGRATION_GUIDE_v3.md`（新規作成）
- `examples/live-coding-patterns/`（新規ディレクトリ）

**推定工数**: 1-2日

#### 📚 シームレス更新ロジックの統一・コメント追加
**関連Issue**: Claude Review #45 項目1
**目的**: 全_method()実装の一貫性確保
**内容**:
- 現在の_method()実装レビュー
- "Future: immediate application logic"コメントの具体化
- 統一的なシームレス更新パターンの設計
- 実装ガイドライン文書化

**実装場所**:
- `packages/engine/src/core/sequence.ts`
- `packages/engine/src/core/global.ts`
- `docs/DEVELOPER_GUIDE.md`（新規セクション）

**推定工数**: 2-3日（設計含む）

---

*Last Updated: 2025-10-26*
*Canonical Reference: [`../core/INSTRUCTION_ORBITSCORE_DSL.md`](../core/INSTRUCTION_ORBITSCORE_DSL.md)*