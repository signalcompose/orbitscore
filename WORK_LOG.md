# OrbitScore Development Work Log

## Project Overview

A design and implementation project for a new music DSL (Domain Specific Language) independent of LilyPond. Supports TidalCycles-style selective execution and polyrhythm/polymeter expression.

## Development Environment

- **OS**: macOS (darwin 24.6.0)
- **Language**: TypeScript
- **Testing Framework**: vitest
- **Project Structure**: monorepo (packages/engine, packages/vscode-extension)
- **Version Control**: Git

## Phase 1: Parser Implementation (Completed)

### 1.1 Project Initialization

**Date**: December 19, 2024
**Work Content**:

- Monorepo structure verification
- Investigation of existing files (ir.ts, parser.ts, scheduler.ts, midi.ts)
- demo.osc file content analysis
- Implementation plan document (IMPLEMENTATION_PLAN.md) creation

**Technical Decisions**:

- IR type definitions frozen as contracts
- Adoption of incremental implementation approach
- Adoption of test-driven development

### 1.2 Testing Framework Introduction

**Date**: December 19, 2024
**Work Content**:

- Migration from Node.js standard testing to vitest
- vitest configuration file (vitest.config.ts) creation
- Test script updates

**Technical Decisions**:

- vitest adoption rationale: TypeScript support, fast execution, modern API
- Test file placement: `tests/parser/parser.spec.ts`

### 1.3 Tokenizer Implementation

**Date**: December 19, 2024
**Work Content**:

- Tokenizer class implementation
- Token type definitions (TokenType, Token)
- Parsing of keywords, numbers, strings, symbols
- Comment processing (# syntax)
- Decimal point and random suffix (r) processing

**Implementation Details**:

```typescript
export type TokenType =
  | 'KEYWORD'
  | 'IDENTIFIER'
  | 'NUMBER'
  | 'STRING'
  | 'BOOLEAN'
  | 'LPAREN'
  | 'RPAREN'
  | 'LBRACE'
  | 'RBRACE'
  | 'LBRACKET'
  | 'RBRACKET'
  | 'COMMA'
  | 'AT'
  | 'PERCENT'
  | 'COLON'
  | 'ASTERISK'
  | 'CARET'
  | 'TILDE'
  | 'SLASH'
  | 'NEWLINE'
  | 'EOF'
```

**Technical Challenges and Solutions**:

- Challenge: `U0.5` syntax parsing (identifiers containing decimal points)
- Solution: Using `/[a-zA-Z0-9_.]/` pattern in `readIdentifier()` method

### 1.4 Parser Implementation

**Date**: December 19, 2024
**Work Content**:

- Parser class implementation
- Global configuration parsing (key, tempo, meter, randseed)
- Sequence configuration parsing (bus, channel, meter, tempo, octave, etc.)
- Event parsing (degrees, durations, chords, octave shifts, detune, random)

**Implementation Details**:

```typescript
export class Parser {
  private tokens: Token[]
  private pos: number = 0

  private parseGlobalConfig(): GlobalConfig
  private parseSequenceConfig(): SequenceConfig
  private parseSequenceEvent(): SequenceEvent
  private parseDurationSpec(): DurationSpec
  private parsePitchSpec(): PitchSpec
}
```

### 1.5 Duration Syntax Implementation

**Date**: December 19, 2024
**Work Content**:

- Seconds: `@2s`
- Units: `@U1.5`, `@U0.5`
- Percentage: `@25%2bars`
- Tuplets: `@[3:2]*U1` (not implemented)

**Technical Challenges and Solutions**:

- Challenge: `@25%2bars` syntax parsing
- Problem: Expected `bars` with `this.expect("KEYWORD")` but `bars` is `IDENTIFIER` type
- Solution: Modified to `this.expect("IDENTIFIER")`

### 1.6 Chord Syntax Implementation

**Date**: December 19, 2024
**Work Content**:

- IR type definition extension: addition of `chord` type
- Chord syntax parsing: `(1@U0.5, 5@U1, 8@U0.25)`
- Design for individual durations per pitch

**Implementation Details**:

```typescript
export type SequenceEvent =
  | { kind: 'note'; pitches: PitchSpec[]; dur: DurationSpec }
  | { kind: 'chord'; notes: { pitch: PitchSpec; dur: DurationSpec }[] }
  | { kind: 'rest'; dur: DurationSpec }
```

### 1.7 Testing and Golden IR Creation

**Date**: December 19, 2024
**Work Content**:

- Complete parsing test implementation for demo.osc
- Golden IR JSON file creation
- Test success verification

**Test Results**:

- ✅ Global config: key=C, tempo=120, meter=4/4 shared
- ✅ Sequence config: piano, IAC Driver Bus 1, channel 1, tempo 132, meter 5/4 independent
- ✅ Chord: `(1@U0.5, 5@U1, 8@U0.25)` → chord type
- ✅ Rest: `0@U0.5` → rest type
- ✅ Single note: `3@2s` → note type (seconds)
- ✅ Complex duration: `12@25%2bars` → note type (percentage)

## Technical Achievements

### 1. DSL Design Features

- **Syntax Consistency**: All durations use `@` prefix
- **Type Safety**: Strict type definitions with TypeScript
- **Extensibility**: Contract-based design with IR type definitions

### 2. Parser Design Features

- **Lexer-Parser Separation**: Clear separation between Tokenizer and Parser
- **Error Handling**: Detailed error messages with line and column numbers
- **Recursive Descent Parser**: Methods corresponding to each syntax element

### 3. Testing Design Features

- **Golden IR**: Expected IR output for demo.osc saved as JSON file
- **Regression Testing**: Detection of existing functionality breaks due to parser changes
- **vitest**: Fast execution with modern testing framework

## Commit History

### Major Commits

1. `c880244` - feat: implement basic parser structure with tokenizer and parser classes
2. `d068930` - feat: add vitest testing framework and improve parser
3. `c481545` - feat: fix parser sequence config parsing and add chord support
4. `3a49dd5` - feat: complete Phase 1 parser implementation

### Commit Strategy

- **Small Unit Commits**: Incremental commits for each feature
- **Meaningful Commit Messages**: Clear description of changes
- **Test-Included Commits**: Tests added for each feature

## Next Phases

## Phase 2: Pitch/Bend Conversion (Completed)

### 2.1 概要

**Date**: December 19, 2024
**Work Content**:

- 度数(1..12)→キー基準の半音度数へ変換（1→+1半音, …, 12→+12半音）
- octave, octmul, octaveShift の合成（octmul はオクターブ項にのみ適用）
- detune（半音単位の実数）を最終半音値に加算し、最寄りMIDIノートとの差をPitchBend化
- bendRange に基づくPitchBend正規化と [-8192, +8191] へのクリップ
- MPEチャンネル割当（通常モードは固定Ch、MPEはローテーション）
- 単体テスト `tests/pitch/pitch.spec.ts` の追加と全面整合

### 2.2 技術的決定

- 度数は「半音度数」として解釈（INSTRUCTIONS_NEW_DSL.mdに準拠）
- MIDI基準は C4=60。半音値は `60 + keyOffset + degree + (octave * octmul * 12) + (octaveShift * 12)`
- detune はノート丸め後にPitchBendへ反映（ベースノートの安定性を優先）
- bendRange の換算は `bend = (semitoneDelta / bendRange) * 8192` を四捨五入しレンジ内にクリップ
- MPEは安全なCh分散（実装はローテーション方式）

### 2.3 テスト結果

- vitest: 22テスト/22パス（parser 1, pitch 21）
- 主な検証項目:
  - キー変換（C, G, Db）
  - octave / octmul / octaveShift の合成
  - detune と bendRange の相互作用
  - 最小/最大ノートのクランプ
  - MPE/非MPEのチャンネル割当

### 2.4 変更ファイル

- `packages/engine/src/pitch.ts`（新規）: 変換ロジック実装
- `tests/pitch/pitch.spec.ts`: テスト追加/整合
- `INSTRUCTIONS_NEW_DSL.md` / `IMPLEMENTATION_PLAN.md`: フェーズ完了時に `WORK_LOG.md` へ記録するルールを追記

### 2.5 備考

- 数値末尾 `r` の乱数は再現性確保（randseed）し、degree での利用をサポート
- IR契約（`ir.ts`）は変更なし

### Phase 2: Pitch/Bend Conversion

- Implementation of degree → MIDI note + PitchBend conversion
- Octave, coefficient, detune synthesis
- MPE/channel assignment

## Phase 3: Scheduler + Transport (In Progress)

### 3.1 Overview

**Date**: December 19, 2024
**Work Content**:

- Real-time scheduling implementation with LookAhead=50ms, Tick=5ms
- Shared/independent meter support with polymeter/tempo
- Transport functionality (Loop/Jump/Mute/Solo) with quantization at bar boundaries
- Window-based note event scheduling with cross-boundary NOTE_OFF handling

### 3.2 Scheduler Core Implementation

**Date**: December 19, 2024
**Work Content**:

- Basic scheduler with window-based event generation
- Event scheduling through `scheduleThrough()` method
- Support for both shared and independent sequences
- Cross-window NOTE_OFF tracking to prevent stuck notes

**Implementation Details**:

```typescript
export class Scheduler {
  private currentSec: number = 0
  private wallStartMs: number | null = null
  private tickTimer: NodeJS.Timeout | null = null
  private pendingJumpBar: number | null = null
  private loop: LoopRange | null = null
  private muted: Set<string> = new Set()
  private soloed: Set<string> = new Set()
  
  scheduleThrough(targetMs: number): void
  simulateTransportAdvanceAcrossSequences(durationSec: number): void
}
```

### 3.3 Transport Integration

**Date**: December 19, 2024  
**Work Content**:

- Jump/Loop implementation with bar boundary quantization
- `simulateTransportAdvanceAcrossSequences` method for boundary-aware advancement
- Support for mixed shared/independent sequences
- Proper handling of transport actions at boundaries

**Technical Decisions**:

- Transport actions (jump/loop) are applied only at bar boundaries
- No overflow time is applied after loop (maintains boundary semantic)
- Method stops at first boundary where transport action occurs
- Recursive advancement removed to maintain single-boundary-per-call behavior

### 3.4 Test Suite Implementation

**Date**: December 19, 2024
**Work Content**:

- Comprehensive test coverage across 15 test files
- 21 tests covering all scheduler functionality
- Golden events generation for demo.osc validation
- Transport integration tests for real-time playback scenarios

**Test Files Created/Modified**:

1. `tests/scheduler/basic.spec.ts` - Basic event scheduling
2. `tests/scheduler/window.spec.ts` - Window-based scheduling
3. `tests/scheduler/cross_window_noteoff.spec.ts` - NOTE_OFF boundary handling
4. `tests/scheduler/shared_independent.spec.ts` - Mixed meter support
5. `tests/scheduler/polymeter_tempo.spec.ts` - Polymeter/tempo combinations
6. `tests/scheduler/quantize.spec.ts` - Quantization behavior
7. `tests/scheduler/mute_solo.spec.ts` - Mute/Solo functionality
8. `tests/scheduler/loop_jump.spec.ts` - Loop/Jump operations
9. `tests/scheduler/transport_state.spec.ts` - Transport state management
10. `tests/scheduler/realtime.spec.ts` - Real-time scheduling
11. `tests/scheduler/reschedule.spec.ts` - Event rescheduling
12. `tests/scheduler/next_boundary.spec.ts` - Boundary calculations
13. `tests/scheduler/next_boundary_transport.spec.ts` - Transport at boundaries
14. `tests/scheduler/transport_integration.spec.ts` - Full transport integration
15. `tests/scheduler/golden_events_demo.spec.ts` - Golden event validation

### 3.5 Bug Fixes and Refinements

**Date**: December 19, 2024
**Work Content**:

#### Transport Integration Fixes (Final Phase)

- **Parser Errors**: Fixed sequence naming issues in test files
  - `sequence shared` → `sequence sharedSeq`
  - `sequence indep` → `sequence indepSeq`

- **Loop Test Logic**: Adjusted timing for proper loop boundary testing
  - Changed start from 2.5s to 3.5s (within bar 1)
  - Updated expectations to match boundary behavior

- **simulateTransportAdvanceAcrossSequences**: Simplified and corrected logic
  - Stops at boundaries after applying transport actions
  - No overflow after loop (consistent boundary semantics)
  - Fixed to handle one boundary at a time as intended

### 3.6 Technical Achievements

1. **Real-time Scheduling**: Accurate timing with 50ms lookahead buffer
2. **Polymeter/Tempo Support**: Independent and shared meter/tempo handling
3. **Transport Quantization**: Jump/Loop actions applied at bar boundaries
4. **NOTE_OFF Management**: Cross-window tracking prevents stuck notes
5. **Test Coverage**: 100% test pass rate (21/21 tests)

### 3.7 Implementation Status

- ✅ Basic scheduler with window-based events
- ✅ Shared/independent sequence support
- ✅ Transport (Jump/Loop) with boundary quantization
- ✅ Mute/Solo functionality
- ✅ Cross-window NOTE_OFF handling
- ✅ Real-time scheduling integration
- ✅ Comprehensive test suite

### 3.8 Commit History

- `ea3f482` - fix: Transport integration Phase 3 - Fix jump/loop behavior at boundaries

### 3.9 Next Steps

- Phase 4: VS Code Extension implementation
- Phase 5: MIDI Output via CoreMIDI

### Phase 4: VS Code Extension

- Selective execution functionality
- Transport UI
- Engine integration

### Phase 5: MIDI Output Implementation

- IAC Bus output via CoreMIDI
- Implementation using @julusian/midi

## Research Notes for Paper Writing

### Research Significance

1. **Novel Approach to Music DSL**: Independent DSL without LilyPond dependency
2. **Polyrhythm/Polymeter Expression**: Implementation of shared/independent meters
3. **Practical Music Production Environment**: Development experience through VS Code integration

### Technical Contributions

1. **Type-Safe Music DSL**: Strict type definitions with TypeScript
2. **Contract-Based Design**: Stable API through IR type definitions
3. **Test-Driven Development**: Regression testing with Golden IR

### Future Research Challenges

1. **Performance Optimization**: Parsing performance for large scores
2. **Usability**: Improvement of error messages
3. **Extensibility**: Addition of new syntax elements

## References and Related Work

- TidalCycles: Live coding music with Haskell
- LilyPond: Music notation software
- Domain Specific Languages: Design and Implementation
- TypeScript: Typed JavaScript at Scale

---

**Created**: December 19, 2024
**Author**: AI Assistant
**Project**: OrbitScore
**Phase**: Phase 3 In Progress
