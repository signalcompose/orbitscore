# OrbitScore Development Work Log

## Project Overview

A design and implementation project for a new music DSL (Domain Specific Language) independent of LilyPond. Supports TidalCycles-style selective execution and polyrhythm/polymeter expression.

## Development Environment

- **OS**: macOS (darwin 24.6.0)
- **Language**: TypeScript
- **Testing Framework**: vitest
- **Project Structure**: monorepo (packages/engine, packages/vscode-extension)
- **Version Control**: Git
- **Code Quality**: ESLint + Prettier with pre-commit hooks

---

## Recent Work

### 6.87 Issue #212: LOOP/RUN scheduler を quantize 起動に変更 (May 09, 2026)

**Date**: May 09, 2026
**Status**: ⏳ IN PROGRESS (PR pending)
**Branch**: `212-loop-run-quantize`
**Issue**: signalcompose/orbitscore#212
**Related Issue**: signalcompose/orbitscore#213 (`fixpitch()` / `time()` 実装、 別 PR)
**Commits**:
- `61ec990` feat(scheduler): quantize LOOP startup and play() updates to bar boundary
- `856fbca` fix(vscode): align completions with implementation, add quantize support
- `7f14096` test(scheduler): cover quantize math, LOOP boundary snap, and completion
- `aae395d` docs: document launch quantize, log #212 and CHANGELOG entry

**動機**: ライブコーディング中に `LOOP(seq)` を発火するとループの途中から音が出てしまい、 走っている他ループとリズムが噛み合わない。 `play()` の差し替えも即時で反映されてバーをまたぐ swap がリズムを崩す。 ユーザー要望:
> 本来であれば、その時に走っているループが終わり次第実行がされるというのが良いかと思っています。これはLOOPを回したまま各トラックの内容を変更した時にも同じことが言えます。

加えて VS Code 補完で `tick` `key` のような未実装メソッドが提案され、選ぶと runtime で `Method not found` を起こす。

**実装内容**:

1. **launch quantize の追加** (新 DSL method)
   - `global.quantize("off"|"beat"|"bar"|"2bar"|"4bar"|"8bar")` (default `"bar"`)
   - `seq.quantize(...)` で per-sequence override (未指定時はグローバル継承)
   - `packages/engine/src/core/global/quantize-manager.ts` 新規作成 (manager + `nextQuantizedTime` / `quantizeDurationMs` ヘルパー)
   - `packages/engine/src/core/sequence/parameters/quantize-manager.ts` 新規 (override 用)

2. **`loopSequence()` の起動を quantize 境界に揃える**
   - `LoopSequenceOptions.startTime` 追加。 `currentTime > startTime` のとき lead-in 分を最初の setTimeout に絞り込んで、 iteration 0 の events を `effectiveStart` で予約、 以降のサイクル境界を `effectiveStart + n × patternDuration` に揃える
   - `loopStartTime` も quantize 後の `effectiveStart` を返すよう修正 (post-trigger seamless update がバー境界基準で計算されるようにするため)

3. **`RUN()` は即時のまま** (one-shot のトリガー感を維持)

4. **LOOP 中の `play()` 差し替えを次サイクル待機に変更**
   - `seamlessParameterUpdate` の deferred list に `play` を追加 (従来は `tempo` / `beat` / `length` のみ)
   - `gain` / `pan` / `audio` / `chop` は即時のまま (mixer 操作は real-time の方が自然との判断)

5. **VS Code 補完 / ハイライトの整合性修正**
   - `completion-context.ts` から `tick` / `key` を削除 (実装が既に削除済 `Global.tick()` / `Global.key()`)
   - `quantize` を global / sequence 両方の補完に追加 (snippet で値を選択肢化)
   - `orbitscore-audio.tmLanguage.json` から `tick` / `key` を除去、 `quantize` を追加
   - `extension.ts` の hover で `fixpitch` を「(planned, see #213)」表記に変更
   - `MethodChainContext.hasQuantize` を追加して 1 chain 内で重複提案しない

6. **テスト追加 (+31 件)**
   - `tests/core/quantize.spec.ts`: QuantizeManager / SequenceQuantizeManager / `nextQuantizedTime` / polymeter での bar 計算など、 純粋ロジックを 18 件
   - `tests/core/loop-quantize.spec.ts`: `seq.loop()` 後の `scheduleSliceEvent.time` がグローバル小節境界に snap されること、 `seq.quantize("off")` override が global を上書きすること、 polymeter 下でも quantize は global grid 基準であることを 8 件
   - `tests/vscode-extension/completion-context.spec.ts`: quantize 補完 / `tick` `key` `fixpitch` `time` が出ないこと 5 件
   - `tests/core/seamless-parameter-update.spec.ts`: `play()` の期待ログを `(seamless)` から `(next cycle)` に修正

7. **DSL 仕様書 (`docs/core/INSTRUCTION_ORBITSCORE_DSL.md`) §5 に Launch Quantize セクション追加**
   - 値一覧 / scope / polymeter 時の grid 基準を明記
   - 「`RUN()` は常に即時」「LOOP 中の `play()` は next cycle、 `gain` / `pan` 系は即時」の例外規則を整理

**スコープ外 (別 Issue)**:
- `fixpitch()` / `time()` の実装本体は #213 で対応 (PitchShift UGen / Warp1 / PV_PitchShift の比較検証から)
- 旧 MIDI DSL grammar (`packages/vscode-extension/syntaxes/orbitscore.tmLanguage.json`) の整理は別途
- `.force` 修飾子による即時実行 escape hatch の活性化 (parser は受理するが interpreter で未使用) も別途検討

**バージョン**: 1.2.0 (Unreleased) — forward port from #214 (1.1.1 patch line)

**テスト結果**: 370 passed / 38 skipped / 0 failed (CI 環境)

---

## Archived sections

Older entries have been archived by month for readability:

- [2025-09](../archive/WORK_LOG_2025-09.md)
- [2025-10](../archive/WORK_LOG_2025-10.md)
- [2026-02](../archive/WORK_LOG_2026-02.md)
- [2026-04](../archive/WORK_LOG_2026-04.md)
- [2026-05](../archive/WORK_LOG_2026-05.md)
