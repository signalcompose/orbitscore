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

### 6.90 Issue #225 — specs-v2 配置 + CLAUDE.md オンボーディング (Jun 13, 2026)

**Date**: 2026-06-13
**Status**: ✅ DONE (commit hash: `19141f1`)
**Issue**: signalcompose/orbitscore#225
**Branch**: `225-docs-specs-v2`
**Epic**: signalcompose/orbitscore#224 (v1.1 Pitch DSL + Session Log + WCTM、 締切 2026-08-07)

**動機**: v1.1 Pitch DSL / MIDI 出力・Session Log (.orbslog)・WCTM コンサートシステムの正本仕様5文書をリポジトリに配置し、 後続の実装セッション (Opus) が迷わず作業を開始できる土台を作る。 Epic #224 配下の最初のタスクであり、 全実装フェーズの前提。

**作業内容**:

- ローカル未追跡だった `docs/spec-v2/` を、 指示書 §8 指定の **`docs/specs-v2/`** にリネームして git 管理下に配置 (5文書: 4 HTML + DESIGN_DISCUSSION_RECORD は md/html 併存。 HTML が正本、 SVG アーキテクチャ図を含む)
- **CLAUDE.md** に「🎯 現在進行中」セクションを追記 (全書き換えはせずセクション単位の追記。 Context Collapse 防止): specs-v2 の読み順、 §7 Known Decisions 再議論禁止ルール、 Epic #224 参照、 委譲方針 (§5)、 Phase 0 停止条件
- **docs/core/INDEX.md** に「Active spec set」セクションを追加 (読み順テーブル + 再議論禁止の注記)
- **docs/core/INSTRUCTION_ORBITSCORE_DSL.md** (SoT) 冒頭に specs-v2 への参照 + 各フェーズゲートでの SoT 反映ルール (§8.1-1) を追記

**正本仕様 (docs/specs-v2/、 読み順)**:

1. `IMPLEMENTATION_INSTRUCTIONS.html` — 作業指示書 (フェーズ・依存グラフ・委譲方針・Known Decisions §7)
2. `PITCH_DSL_SPEC_v1.1.html` — Stage 1 = note DSL の仕様正本
3. `SESSION_LOG_SPEC_v1.html` — 記録 .orbslog の仕様正本
4. `WCTM_SYSTEM_SPEC_v1.html` — コンサートシステムの仕様正本
5. `DESIGN_DISCUSSION_RECORD.md` — 設計経緯と棄却済み代替案 (決定ログ #1-32)

**起票した Issue 群 (2026-06-13)**: Epic #224、 実装系 #225-237 (Phase 0/R/1/L1/2/3/4・W-Bridge/RuntimeA/Link/Ops・docs sync)、 将来予約 #238-242 (audio `[ ]`・slice()・譜面レンダリング Epic・L2 Replayer・WCTM 事後分析)。 ラベル `wctm` / `session-log`、 マイルストーン「WCTM 2026-08-07」を新設。

**テスト結果**: 424 passed / 23 skipped (447 total)。 ドキュメントのみの変更で回帰なし。

**次のステップ**: #226 Phase 0 (事前検証4項目。 仕様前提が崩れたら停止して報告)。

---

### 6.89 Issue #221 — audioPath search resolution + sample bank lookup (May 10, 2026)

**Date**: May 10, 2026
**Status**: ✅ DONE (実装、テスト、docs 更新完了。 commit hash: `bacf4e0`)
**Issue**: signalcompose/orbitscore#221
**Branch**: `claude/review-issue-221-RkVzz`
**Version target**: v1.2.1 (forward-only patch、 v1.2.0 LinkAudio とは独立)

**動機**: TidalCycles 系 sample collection (Clean-Samples 等) を OrbitScore で利用可能にする。 SuperDirt / sclang を経由せず、 単なる WAV file 群として独立配布されている collection を user が自分で配置し、 OrbitScore はその sample 名 (`bd`, `sd`, `hh:5` 等) で参照できる仕組みを提供。 既存 TidalCycles user の barrier を下げ、 既存 `audio() + chop() + play()` の DSL style がそのまま使えるようにする。

**設計判断 (Hybrid 採用)**:

Issue #221 本文の strict 仕様 (`audioPath(string[])` のみ、 bare name は常に bank lookup) を厳密適用すると、 既存の 30+ `.orbs` ファイル / VS Code extension / unit test (旧 `audioPath(string)` + `audio("kick.wav")` join 挙動依存) が全部 break する。 v1.2.1 は patch version で breaking change 想定外のため、 user に確認のうえ **Hybrid 方式** を採用:

- `audioPath()` は `string | string[] | variadic` の 3 形式を受ける (旧 single string と新 array の共存)
- `audio()` は path-direct → bank lookup → legacy join の優先順で解決
- 拡張子付き bare name (`kick.wav`) は bank lookup hit せず legacy join 経路に fallback
- 既存 30+ `.orbs` ファイル / VS Code extension / 既存 7 件の unit test を一切触らずに新機能追加

**実装内容**:

1. **新規 `packages/engine/src/core/global/audio-resolver.ts`** (約 165 行)
   - `looksLikePath(spec)` — path-direct 判定
   - `expandHome(p)` — `~`, `~/foo` を `os.homedir()` で展開
   - `resolveAudio({ spec, audioPaths, documentDirectory, cache })` — 統合 resolver
   - `bd:N` の variant index parsing (modulo wraparound、 NaN/負数/非整数は throw)
   - 拡張子 filter `wav|aif|aiff|mp3|mp4|flac` (大文字小文字不問)
   - 解決失敗時の error には available banks の hint 同梱

2. **`packages/engine/src/core/global/audio-manager.ts`** 拡張
   - 内部 storage を `_audioPath: string` → `_audioPaths: string[]` に変更
   - `audioPath(...values: (string | string[])[]): string | this` で variadic + array 両対応
   - 解決結果 cache (`Map<string, string>`)、 audioPath 再設定 / documentDirectory 変更で invalidate
   - getter `audioPath()` は配列の 0 番目を string で返す (legacy compat)
   - `resolve(spec)` を新設、 内部で audio-resolver に委譲

3. **`packages/engine/src/core/global/types.ts`** — `GlobalState` に `audioPaths: string[]` 追加 (旧 `audioPath: string` も legacy compat で残す)

4. **`packages/engine/src/core/global.ts`**
   - `audioPath()` を variadic 化、 audio-manager に転送
   - `resolveAudioSpec(spec): string` を新設、 audio-manager `.resolve()` への薄い wrapper

5. **`packages/engine/src/core/sequence.ts`** の `audio()` 簡素化
   - 自前の path resolution logic を削除
   - `this.global.resolveAudioSpec(filepath)` 1 行に置換
   - 既存 chop / `_audioFilePath` 周辺は変更なし

6. **新規 `tests/core/audio-bank-resolution.spec.ts`** (39 件)
   - looksLikePath / expandHome の pure function tests
   - resolveAudio の path-direct / bank lookup / `bank:N` variant / multi-path traversal / 拡張子 filter / cache hit
   - 解決失敗時の error message validation
   - Global.audioPath() の variadic + array + `~/` 展開
   - Sequence.audio() integration (bare name, legacy join, `~/`, cache invalidation)

**テスト結果**:
- 全 447 件 pass (424 passed, 23 skipped) — 旧 230 から 217 件増加、 既存全 pass
- 新規 39 件 (audio-bank-resolution) + 既存 7 件 (audio-path-resolution) 全 green
- `npm run build` clean、 `npm run lint` clean (1 件の warning は既存の audio-slicer.spec.ts、 本件と無関係)

**触らなかった領域** (Issue 仕様の 「既存 layer に手を入れない」 を遵守):
- `BufferManager` / OSC layer / `EventScheduler` / DSL parser (`tokenizer.ts`, `parse-expression.ts`)
- VS Code extension の completion / diagnostic (legacy single-string API でも動作継続)
- 既存の 30+ `test-assets/scores/*.orbs` ファイル

**Sample collection license に関する文書化**:
- `docs/core/INSTRUCTION_ORBITSCORE_DSL.md` で Clean-Samples (GPL-3.0) を最初の推奨として案内
- Dirt-Samples は LICENSE 不在 / provenance unknown を明示、 OrbitScore 側 bundle / auto-download は実装しない方針を明記
- README 更新 (本変更と同一 PR 内で実施)

**変更ファイル**:
- 新規: `packages/engine/src/core/global/audio-resolver.ts`、 `tests/core/audio-bank-resolution.spec.ts`
- 編集: `packages/engine/src/core/global/audio-manager.ts`、 `packages/engine/src/core/global/types.ts`、 `packages/engine/src/core/global.ts`、 `packages/engine/src/core/sequence.ts`、 `docs/core/INSTRUCTION_ORBITSCORE_DSL.md`、 `docs/development/WORK_LOG.md`、 `README.md`

**Next steps**:
- Issue #221 を closing する PR 作成 (ユーザー承認後)
- v1.2.1 release notes に本機能を含める
- `.orbs` parser への配列 literal 対応は別 issue (現状 variadic で代替可能)

---

### 6.88 Release v1.1.1 — quantize patch ship (May 09, 2026)

**Date**: May 09, 2026 (tag push: May 09 16:09 UTC, re-tag: 16:26 UTC)
**Status**: ✅ DONE (GitHub Release v1.1.1 作成済、 Marketplace/Open VSX は gate off で skip)
**Tag**: `v1.1.1` annotated (現在は commit `afd6646` を指す、 後述の re-tag 経緯あり)
**Branch (1.1.x)**: `1.1.x` HEAD
**Issue**: signalcompose/orbitscore#216 (gate backport)、 #219 (本 entry)
**Related PRs**: #214 (1.1.x への #212 patch)、 #215 (main への forward port)、 #217 (gate backport to 1.1.x)
**GitHub Release**: https://github.com/signalcompose/orbitscore/releases/tag/v1.1.1
**.vsix asset**: `orbitscore-darwin-arm64-1.1.1.vsix` (7,445,312 bytes)

**動機**: ICMC 2026 Hamburg (5/10-16) 直前で v1.1.0 (May 06 stable) にバンドルされた quantize 関連 bug fix (#212) を patch release として ship する。 v1.1.1 は ICMC 期間の primary distribution vehicle、 v1.2.0 (LinkAudio + quantize 含む post-rebase) は post-ICMC release を想定。

**ship までの flow** (時系列):

1. **PR #214 merge** (16:07 UTC) — `1.1.x` line に #212 quantize patch を取り込み (merge commit `99a16df`)
2. **v1.1.1 tag push #1** (16:09 UTC) — `99a16df` に annotated tag、 release.yml run `25605590449` 起動
3. **partial failure 発生** — Build / .vsix package / GitHub Release 作成は SUCCESS、 但し `Publish to VS Code Marketplace` step が `VSCE_PAT` 未登録のまま failure、 `Publish to Open VSX` も skip
4. **原因切り分け** — 1.1.x の `release.yml` には main entry 6.76 (Issue #197) で導入された `vars.PUBLISH_MARKETPLACE == 'true'` gate が backport されていなかった。 同等の gate なしで stable tag を push すると secret 未整備の現状では必ず failure になる構造
5. **Issue #216 + PR #217** — gate を 1.1.x に backport、 CI 全 green で merge (merge commit `afd6646`)
6. **v1.1.1 re-tag** (16:26 UTC) — 旧 tag (`99a16df` を指す) を delete し、 新 HEAD `afd6646` に v1.1.1 を annotated tag で打ち直し
7. **v1.1.1 tag push #2** — release.yml run `25605955652` 起動
8. **clean SUCCESS** — Build / .vsix / GitHub Release 作成は SUCCESS、 Marketplace + Open VSX は `vars.PUBLISH_MARKETPLACE != 'true'` で skip (期待通り)、 Summary に 「Marketplace/Open VSX gated off」 ラベル表示

**過去パターンからの逸脱 (honest record)**:

entry 6.75 (v1.1.0 stable release、 May 07) では **同一の partial failure** が発生したが、 当時は **re-tag せず、 partial failure を歴史として受け入れ、 後続 release のために gate を整備** (entry 6.76) という forward-only path を選択していた。

本 release では:
- **destructive operation を実行**: `git push origin :refs/tags/v1.1.1` で remote tag 削除、 `gh release delete v1.1.1` で旧 GitHub Release 削除
- **commit 上の tag pointer を rewrite**: v1.1.1 が `99a16df` → `afd6646` に移動

これは過去パターン (entry 6.75 forward-only) からの逸脱。 ICMC 直前で session 内のみの状態で download 履歴がほぼなかったため pragmatic に決断したが、 公開済 tag の rewrite は通常避けるべき。

**今後の方針** (今回の判断を踏まえて):
- stable tag push 後の partial failure は、 今後は forward-only (v1.1.2 patch を切る) を default とする
- destructive な re-tag は **release が hour 単位以内、 download 実績が確認できる前** にのみ pragmatic option として残す
- いずれの場合も WORK_LOG に honest に記録する

**配布手段** (ICMC 期間):
- **GitHub Release から `.vsix` direct download → VS Code に手動 install**
- VS Code Marketplace / Open VSX は publisher 整備が完了する post-ICMC で publish (`gh secret set VSCE_PAT/OVSX_PAT` + `gh variable set PUBLISH_MARKETPLACE=true` でゲート開放)
- Yamato 氏が現地発表時に install 手順をデモするフロー

**v1.1.1 に含まれる主な変更** (#212):
- `LOOP()` 起動の bar boundary quantize (default `"bar"`、 `off`/`beat`/`bar`/`2bar`/`4bar`/`8bar` を選択可)
- LOOP 中の `play()` 差し替えが次サイクルで反映される seamless update
- `RUN()` は即時 (one-shot のトリガー感を維持)
- VS Code 補完から実装が削除済の `tick` / `key` を除去、 `quantize` を新規追加
- DSL spec §5 に Launch Quantize セクション追加

**スコープ外**:
- `fixpitch()` / `time()` の実装本体は #213 で対応 (post-ICMC、 PitchShift UGen / Warp1 / PV_PitchShift の比較検証から)
- LinkAudio + sc-link-audio plugin (Epic #187) は v1.2.0 line で post-ICMC release

**main への反映**:
- 1.1.x の WORK_LOG entry 6.77 (#216 backport) は frozen patch line に留め、 本 entry 6.88 (release record) で main 側に集約
- 1.1.x の 6.77 内容は本 entry の「Step 5」として再構成済、 重複扱いは可

**テスト結果**:
- 1.1.x: 300 passed / 23 skipped / 0 failed (build:clean + npm test、 May 09 18:09 JST)
- main (PR #215 merge 後): 385 passed / 23 skipped / 0 failed (CI 環境)

---

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
