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

## Phase 3: Scheduler + Transport (Completed)

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

## Phase 4: VS Code Extension (Completed)

### 4.1 Overview

**Date**: December 19, 2024
**Work Content**:

- Minimal VS Code extension implementation
- Language support for .osc files with syntax highlighting
- Command implementation (start/runSelection/stop/transport)
- Transport UI with webview panel
- Status bar integration
- Real-time diagnostics

### 4.2 Language Support Implementation

**Date**: December 19, 2024
**Work Content**:

- Created TextMate grammar for syntax highlighting
- Implemented language configuration (brackets, comments, folding)
- File association for .osc extension
- Auto-closing pairs and surrounding pairs

**Files Created**:

- `packages/vscode-extension/syntaxes/orbitscore.tmLanguage.json`
- `packages/vscode-extension/language-configuration.json`

### 4.3 Command Implementation

**Date**: December 19, 2024
**Work Content**:

Implemented four main commands:

1. **Start Engine**: Launches OrbitScore engine daemon
2. **Run Selection**: Executes selected text or entire document (Cmd+Enter)
3. **Stop Engine**: Terminates engine process
4. **Transport Panel**: Opens interactive transport control webview

**Key Features**:

- Cmd+Enter keybinding for quick execution
- Temporary file creation for selection execution
- Process management for engine lifecycle
- Output channel for engine logs

### 4.4 Transport UI Development

**Date**: December 19, 2024
**Work Content**:

- Webview-based transport panel with Play/Pause/Stop controls
- Jump to bar functionality
- Loop configuration with start/end bars
- Real-time status bar updates
- Bidirectional communication between extension and engine

**Transport State Management**:

```typescript
interface TransportState {
  playing: boolean
  bar: number
  beat: number
  bpm: number
  loopEnabled: boolean
  loopStart?: number
  loopEnd?: number
}
```

### 4.5 Engine CLI Interface

**Date**: December 19, 2024
**Work Content**:

Created CLI interface (`packages/engine/src/cli.ts`) with:

- Engine daemon mode for VS Code integration
- File execution support
- Transport command handling via stdin
- Status reporting via stdout

**Commands Supported**:

- `orbitscore start` - Start engine daemon
- `orbitscore run <file>` - Execute .osc file
- Transport: play, pause, stop, jump, loop

### 4.6 Diagnostics Integration

**Date**: December 19, 2024
**Work Content**:

- Real-time syntax error checking
- Parser integration for validation
- Error location extraction (line, column)
- Visual indicators in editor

### 4.7 Technical Achievements

1. **Full IDE Experience**: Syntax highlighting, diagnostics, and execution
2. **Interactive Transport**: Real-time playback control
3. **Seamless Integration**: Cmd+Enter workflow like TidalCycles
4. **Process Management**: Robust engine lifecycle handling
5. **Error Feedback**: Immediate syntax validation

### 4.8 Implementation Status

- ✅ Language support (syntax, configuration)
- ✅ Command palette integration
- ✅ Keybinding (Cmd+Enter)
- ✅ Transport UI (webview panel)
- ✅ Status bar integration
- ✅ Diagnostics
- ✅ Engine CLI interface
- ✅ CoreMidiSink (IAC Bus連携完了)

### 4.9 Commit History

- `2c470c9` - fix: Correct degree to note mapping system
- `d7a3669` - feat: Implement VS Code extension (Phase 4)
- `332ebc3` - docs: Add PROJECT_RULES.md and update WORK_LOG.md for Phase 4
- `ce08b16` - docs: Update WORK_LOG.md with documentation commit hash
- `374db22` - docs: Add English instruction verification rule to PROJECT_RULES.md
- `f0b7754` - docs: Update WORK_LOG.md with latest commit
- `9bf6e18` - refactor: Organize documentation in docs folder
- `c7bc785` - docs: Update WORK_LOG.md with documentation reorganization
- `fcbe265` - chore: Setup ESLint and Prettier pre-commit hooks
- `7a5b657` - docs: Update WORK_LOG.md with pre-commit hook setup
- `56b1243` - chore: Update Husky prepare script for v9
- `349a25d` - docs: Update project description to highlight unique features
- `349cb74` - docs: Finalize repository description
- `3581356` - docs: Update WORK_LOG.md with latest commits
- `1d82d60` - docs: Add WORK_LOG-README sync rule and update README to current state

### 4.10 Next Steps

- Phase 5: MIDI Output implementation with @julusian/midi
- IAC Bus connection
- MIDI message routing
- Engine integration

## Phase 5: MIDI Output Implementation (Completed)

### 5.1 Overview

**Date**: September 20, 2025  
**Work Content**:

- `CoreMidiSink` を @julusian/midi で実装し、IAC Bus を自動接続
- `.env` の `ORBITSCORE_MIDI_PORT` を読み込み、CLI から接続先を制御
- CLI の `run` コマンドを非同期化し、バス選択とグレースフルシャットダウンを追加
- MIDIユニットテストを新設し、送信フォーマットとポート接続の振る舞いを検証

**Technical Decisions**:

- デフォルトポートは `IAC Driver Bus 1`、環境変数とシーケンスの `bus` 定義で上書き
- `openPortByName` 失敗時はポート一覧を列挙し、名前を正規化して再試行
- `Scheduler` 利用時に多重ポートを避けるため、CLIで単一シンクを共有し起動時に明示的に `open`
- Graceful shutdown ハンドラを追加し、SIGINT/SIGTERM/uncaughtException で確実に `close`

### 5.2 CoreMidiSink Implementation

- MIDIメッセージの data バイトは 7bit にクランプ、status は 0xFF マスクで安全化
- 送信前にポートオープン済みか検証し、未接続時は例外で通知
- テスト容易性のため `@julusian/midi` モジュールをモック注入できるようコンストラクタを設計

### 5.3 CLI Integration

- `dotenv` をロードして `.env` を自動反映
- `.osc` のシーケンスからユニークな `bus` 名を抽出し、複数検出時は警告ログを出力
- `run` コマンド実行時に既存スケジューラを停止・再生成し、最新IRで再生
- シグナルハンドラで `Scheduler` と `CoreMidiSink` を破棄し、プロセス終了時のMIDIポートリークを防止

### 5.4 Testing

- 新しい `tests/midi/core_sink.spec.ts` で 5 ケースを追加（ポート解決・クランプ・例外・クローズ）
- 既存の Vitest スイートと併せて `npm test` で 49 テスト全通過を確認

### 5.5 Implementation Status

- ✅ IAC Bus output via CoreMIDI
- ✅ Implementation using @julusian/midi
- ✅ CLI 経由の環境変数・バス選択サポート
- ✅ MIDI 向けユニットテストと自動化

### 5.6 Commit History

- (to be recorded after commit)

### 5.7 CLI Transport Reporting Improvement

**Date**: September 20, 2025  
**Work Content**:

- `Scheduler` に `getLoopState()` と `getDisplayBpm()` を追加
- `packages/engine/src/cli.ts` の TRANSPORT 出力で BPM/Loop を実値に更新
- 既存テスト 49/49 パスを再確認（機能追加による破壊なし）

**Notes**:

- 現状の表示BPMは `IR.global.tempo` に準拠（将来的にシーケンス別表示やUI拡張を検討）

### 5.8 Repo Docs Update

**Date**: September 20, 2025  
**Work Content**:

- `AGENTS.md` に言語/エンコーディング方針を追記：「あなたの返答はUTF-8の日本語で返す。」
- 追加更新: 英語での指示時は正しい英文で返答し、英作文力向上を支援し、意図確認を行う方針を追記
  - 上記方針は `AGENTS.md` の Language & Encoding 節にも反映済み
- `agent.md` は方針重複のため削除し、AGENTS.md に集約
- `PROJECT_RULES.md` の要点（WORK_LOG/README厳格運用、コミット体裁テンプレ、Pre-commitチェック、MIDI/DSLの厳守事項）を `AGENTS.md` に反映
- 言語方針を更新：「英語での指示時も回答は日本語。併せて Suggested English を提示して英作文チェックを実施」

**Rationale**:

- リポジトリ内エージェントの応答言語を統一し、ユーザー期待に整合させるため

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
**Phase**: Phase 5 Completed

### 5.9 Parser Fixes: Tuplet + Pitch Suffix (Detune/Octave) for Single Notes

**Date**: September 20, 2025  
**Work Content**:

- Fix `parseDurationSpec()` to correctly parse tuplets: `@[a:b]*U<value>` now accepts `IDENTIFIER` tokens like `U1`, `U0.5` (tokenizer groups `U` and digits).
- Remove incorrect fallback branch that returned `@2s` with a hardcoded value; `@<number>s` now uses the parsed number consistently.
- Support single-note pitch suffix parsing by using `parsePitchSpec()` for non-chord events:
  - Detune: `~+0.5`
  - Octave shift: `^+1`
- Add tests: `tests/parser/duration_and_pitch.spec.ts`

**Rationale**:

- Tokenizer treats `U1.5` as a single `IDENTIFIER` → parser needed to parse numeric part after `U` instead of expecting separate `NUMBER` token.
- Single-note events previously ignored `~` and `^` suffixes because they parsed raw degree only.

**Validation**:

- `npm test` passes (existing suites + new parser tests for tuplet and pitch suffix).
- Verified no regression in scheduler/pitch/midi tests.

**Impact**:

- DSL `tuplet` duration and single-note microtonal/octave modifiers work as specified in `INSTRUCTIONS_NEW_DSL.md`.

### 5.10 Parser/IR wiring for random suffix `r` and key token acceptance

**Date**: September 20, 2025  
**Work Content**:

- Parser: `key` 値で `KEYWORD` だけでなく `IDENTIFIER` も受理（`C`, `Db`, ...）。
- IR: `PitchSpec` に `degreeRaw?: string` を追加（例: `"1.0r"`）。
- Parser: `parsePitchSpec()` が最初の `NUMBER` トークン文字列を保持して `degreeRaw` へ格納。
- Scheduler→PitchConverter: `convertPitch(pitch, pitch.degreeRaw)` を配線し、`r` サフィックスをE2E適用。
- Tests: `tests/scheduler/random_suffix.spec.ts` を追加（randseedに基づく決定的挙動を確認）。
- 既存テスト更新: `tests/parser/duration_and_pitch.spec.ts` に `degreeRaw` 追加に伴う期待値の更新。

**Rationale**:

- 仕様「任意の数値末尾 'r' は [0,0.999] を加算」を度数に対して実運用できるよう、原文数値をIRに保持してPitchConverterへ伝搬する必要があったため。
- 一部のテーマ/配色環境で `C` などが `IDENTIFIER` としてトークナイズされるケースにも堅牢にするため。

**Validation**:

- `npm test` 53/53 パス（新規2件含む）。

**Impact**:

- `1.0r` などの表記が、シーケンスの `randseed` に基づき決定的にピッチへ反映されるようになった。
- 将来的に detune/octave/duration への `r` 拡張も同様のパターンで配線可能。
