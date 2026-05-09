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

### 6.76 Issue #212 (1.1.x backport): LOOP/RUN scheduler を quantize 起動に変更 (May 09, 2026)

**Date**: May 09, 2026
**Status**: ⏳ IN PROGRESS (PR pending, 1.1.1 patch release)
**Branch**: `release/1.1.x-212-loop-run-quantize` (cherry-pick from `212-loop-run-quantize`)
**Issue**: signalcompose/orbitscore#212
**Related Issue**: signalcompose/orbitscore#213 (`fixpitch()` / `time()` 実装、 別 PR)
**Commits** (cherry-picked from `212-loop-run-quantize`):
- `53e26ba` feat(scheduler): quantize LOOP startup and play() updates to bar boundary
- `cf5f62f` fix(vscode): align completions with implementation, add quantize support
- `ce39754` test(scheduler): cover quantize math, LOOP boundary snap, and completion
- `e79b220` docs: document launch quantize, log #212 and CHANGELOG entry
**Target**: v1.1.1 stable (`release/1.1.x` lineage)

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

**バージョン**: 1.1.1 (patch)

**テスト結果**: 370 passed / 38 skipped / 0 failed (CI 環境)



**Date**: May 08, 2026
**Status**: ⏳ IN PROGRESS (PR pending)
**Branch**: `201-vsix-bundle-orbit-plugin`
**Issue**: signalcompose/orbitscore#201 (Step 4 sub-task 4-1)

**目的**: Issue #201 (Epic #187 Step 4) の 4 sub-task のうち最初の 1 つ。 release build で stock SuperCollider plugin (26 個) と並んで `OrbitLinkAudio.scx` (LinkAudio dispatch UGen) を同梱し、 エンドユーザーが `.vsix` install するだけで LinkAudio 経路が使える状態を整える。

残り 3 sub-task は別 PR で対応:
- **4-2**: boot pipeline で plugin available フラグ flip (engine TS layer)
- **4-3**: release CI workflow に sc-link-audio build step を追加
- **4-4**: 統合 E2E checklist §A-G の自動化検収

**実装内容**:

- `scripts/extract-scsynth-bundle.sh` を拡張、 stock SC plugin の copy 後に
  `packages/sc-link-audio/build/OrbitLinkAudio.scx` を bundle
  (`Resources/plugins/`) に同梱する step を追加。 build 済 `.scx` が存在
  しない dev workflow では warn + skip して bundle 抽出自体は成功させる
  (LinkAudio 経路が使えない `.vsix` だが hardware fallback では動く)
- bundle 検証 line を更新: `Plugin count: 26 stock SC + 1 custom = 27 total`
  形式で stock 数の regression check (ABS = 26) と total count を区別
- `packages/vscode-extension/BUILD_GUIDE.md` にビルド手順 (cmake build →
  extract-scsynth-bundle.sh 順序) を追記、 同梱後の構造図と plugin count
  を 27 に更新

**実装ファイル**:
- `scripts/extract-scsynth-bundle.sh` — OrbitLinkAudio.scx 同梱 step + plugin count 検証強化
- `packages/vscode-extension/BUILD_GUIDE.md` — build 順序 + 構造図 + サイズ更新

**検証結果**:
- `bash scripts/extract-scsynth-bundle.sh` 実行成功、 OrbitLinkAudio.scx が
  `engine/scsynth/Contents/Resources/plugins/` に正しく配置
- `Plugin count: 26 stock SC + 1 custom = 27 total` の出力確認
- bundle 内の OrbitLinkAudio.scx が ad-hoc 署名済 (build 時の codesign が
  そのまま残る — Developer ID 再署名は release CI scope で別途対応予定)

**設計上の判断**:
- **同梱条件: `.scx` 存在チェックのみ**: build 失敗時に bundle 抽出も巻き
  添えで失敗するのは過剰。 dev workflow の柔軟性を保ち、 LinkAudio 経路は
  optional として扱う。 production の release CI では sc-link-audio の
  cmake build step が prerequisite なので、 そちらで失敗 fail-fast に任せる
- **bundle path**: `Resources/plugins/` 直下に置く。 SC convention (UGen
  plugin の標準位置) と一致させ、 scsynth が `-U` で plugin path を指定
  された時に自動で発見する
- **Developer ID 署名は別 PR**: 本 PR は dev workflow の bundle 同梱が
  scope。 macOS Gatekeeper 通過のための Developer ID 再署名は release CI
  workflow (Step 4-3) と一緒に追加するのが自然

**残課題** (本 PR scope 外):
- Step 4-2: engine TS の `linkAudioPluginAvailable` フラグ flip
- Step 4-3: release CI に sc-link-audio cmake build step + Developer ID
  再署名
- Step 4-4: 統合 E2E checklist 自動化

---

### 6.85 Issue #205 + #206 / Epic #187: LinkAudio plugin follow-ups (May 08, 2026)

**Date**: May 08, 2026
**Status**: ⏳ IN PROGRESS (PR pending)
**Branch**: `205-206-link-audio-plugin-followup`
**Issues**: signalcompose/orbitscore#205, signalcompose/orbitscore#206

**目的**: PR #204 (Step 2.3 sum-by-name) merge 後の review-team で deferred とした 2 件の Important 指摘を解消する。 plugin 内部品質と test harness カバレッジを改善し、 v1.x release 前の technical debt を削減。

**実装内容**:

#### Issue #206: blockSize truncation test harness

- `scripts/verify-blocksize-truncation.scd` 新規追加
- `s.options.blockSize = 4096` (>`kLinkAudioMaxBlockFrames` = 2048) で boot
- `s.options.hardwareBufferSize = 4096` も同時に設定 (engine block ≤ HW buffer 制約のため)
- 検証項目:
  - scsynth が oversized block で boot 成功
  - `OrbitLinkAudioOut_Ctor` が "server blockSize=4096 exceeds kLinkAudioMaxBlockFrames=2048" の warning Print を emit
  - `next()` が `std::min(inNumSamples, kLinkAudioMaxBlockFrames)` で安全に truncate、 crash しない

**なぜ別 harness にしたか**: `verify-plugin.scd` 本体は default block size で動作確認するので、 oversize 検証だけ別 boot が必要。 同 harness 内で blockSize 変更すると全 Synth で warn が flood され、 既存 [OK] line の signal が劣化する。

#### Issue #205: /cmd registerLinkAudioChannel OSC reply via DoAsynchronousCommand

- `ChannelRegistry::registerChannel(...)` を `void` → `bool` 戻りに変更
  - `true`: 新規登録成功、 または既存 id (idempotent re-register)
  - `false`: alloc 例外、 LinkAudio singleton 未初期化
- `OrbitLinkAudioOut_RegisterChannel` を `DoAsynchronousCommand` ベースに refactor
  - 4 stage callback (stage2 NRT / stage3 RT / stage4 NRT / cleanup NRT)
  - stage2: `g_channelRegistry.registerChannel` を呼んで `cmd->success` に格納
  - stage3: `return true` (RT で work なし、 chain 継続のため必須 — false だと scsynth 観測上 stage4 が呼ばれない)
  - stage4: `return cmd->success` → true 時のみ scsynth が `/done /orbit/registerLinkAudioChannel` を OSC 経由で送信
  - cleanup: cmdData の delete
- 即時 reject (id ≤ 0 / name nullptr / name 空) は同期 path で従来通り Print + early return (DoAsync 不要)
- TS 側の使用想定:
  - 成功 → `/done` 受信
  - 失敗 (alloc 系) → `/done` timeout で検出 (scsynth log にも diagnostic Print が残る)
  - 失敗 (validation 系) → `/done` timeout、 これは TS 側 client bug の signal

**verify-plugin.scd 拡張**:
- OSCFunc で `/done /orbit/registerLinkAudioChannel` を listen、 `doneCount` を集計
- 期待値: 3 件 (id=1 first time / id=1 rename idempotent / id=3 cross-channel)
  - validation reject 3 件 (id=2 empty / id=-5 / id=4 no string) は `/done` 送らない
- 末尾で `if (doneCount != 3) { 1.exit }` で assertion

**実装ファイル**:
- `scripts/verify-blocksize-truncation.scd` — 新規 (#206)
- `scripts/verify-plugin.scd` — `/done` listen + assertion 追加 (#205)
- `src/channel_registry.hpp` — `registerChannel` 戻り値 bool 化 (#205)
- `src/channel_registry.cpp` — 戻り値 propagate (#205)
- `src/orbit_link_audio_out.cpp` — DoAsynchronousCommand 4 stage 実装 (#205)

**検証結果**:
- `cmake --build build` 成功
- `verify-plugin.scd` 全 10 step 通過 (新規 step 10 = `/done` 受信 assertion)
- `verify-blocksize-truncation.scd` 通過 (warn Print 確認 + no-crash)

**設計上の判断**:
- **stage3 を `return true` に固定**: SDK header コメントは "completion msg performed if stage3 returns true" としか書かないが、 観測上 false だと stage4 まで chain が続かず /done が送られない。 RT 側で work しないので unconditional true は安全
- **失敗時は /done を送らない (vs 別 reply で /fail を送る)**: public plugin SDK に `/fail` 送信 API なし、 framework の自動送信 `/fail` は alloc-failure の特定 message 用。 「失敗 = timeout」の契約は SC built-in command (`/b_alloc` 等) と一致しており、 TS 側で extra branch logic 不要
- **fixed-size 256 byte name buffer**: 動的 alloc を避けて cmdData を POD 化、 cleanup で `delete cmd` だけで済む。 256 chars は Live channel name の実用上限を充分上回る

**残課題** (本 PR scope 外):
- Step 4 build/distribution pipeline (Issue #201)

---

### 6.84 Issue #200 / Epic #187: Link Audio sum-by-name (Step 2.3) (May 08, 2026)

**Date**: May 08, 2026
**Status**: ⏳ IN PROGRESS (draft PR pending)
**Branch**: `200-link-audio-sum-by-name`
**Issue**: signalcompose/orbitscore#200

**目的**: 同一 channel に bind された複数 Synth の音声を sink ごとに加算 mix する。Step 2.2 直後の状態では `LinkAudioSink::BufferHandle` を Synth ごとに直接 commit しており、 同 tick 内で複数 Synth が走ると後勝ちになっていた (E2E checklist §C 未達)。

**実装内容**:

1. **`SinkEntry` 構造体導入** (`channel_registry.hpp`)
   - `LinkAudioSink` + `ChannelMixState` を1つの owning struct に同梱
   - UGen Ctor 時の lookup を 1 回で済ませ、 sink と mix 状態に同じキャッシュ済み pointer から到達できるよう変更
   - `lookup()` 戻り値を `LinkAudioSink*` から `SinkEntry*` に変更

2. **`ChannelMixState` 設計**
   - `float mixBuffer[kLinkAudioMaxBlockFrames * kLinkAudioNumChannels]` で float 加算 accumulator (int32 ではなく float — sum 中の早期 int16 量子化を避ける)
   - `currentBufCounter` で tick 識別 (-1 = 未accumulate; uint32 → int64 cast で sentinel 共存)
   - `currentSessionState` は `std::optional<LinkSessionState>` (`SessionState` に default ctor が無いため。 flush gate `currentBufCounter >= 0` の時点で has_value 保証)
   - `currentFrames` / `currentSampleRate` / `currentBeatsAtBufferBegin` は flush 時に commit へ渡す凍結値

3. **deferred commit パターン** (`orbit_link_audio_out.cpp::OrbitLinkAudioOut_next`)
   - 各 tick の **最初** の Synth 呼び出しで前 tick の accumulator を flush。 flush 条件は `bufCounter == prev + 1` (tick 隣接時のみ)
   - gap > 1 の場合は捨てる: audio thread スターブや UGen が複数 tick を skip した場合、 captured session state の beat が Live 現在位置と乖離 → 古いデータの commit は誤同期になる
   - flush 後、 mix buffer を memset し、 新 tick 用に session state を capture
   - 同 tick 内の後続 Synth は `mixBuffer[i*2+ch] += in[i]` で追加加算 (per-Synth clamp 無し — flush 時に sum 後一括 clamp)
   - net で 1-tick latency (≈ 21 ms @ 48 kHz/1024 frames; 通常 ~1.3 ms @ 64 frames) が発生するが、 Link sync 同期窓を充分下回る

4. **scratch buffer 廃止** (`orbit_link_audio_out.cpp`)
   - Per-Unit `int16 scratch[]` field を削除 (mix buffer は `SinkEntry::mix` 側に1個に集約)
   - float → int16 quantise + clamp は flush path 内で `bh.samples` へ直接書き込み
   - Sum-by-name と RT 安全性 (allocation-free) を両立

5. **共通定数の `channel_registry.hpp` への移動**
   - `kLinkAudioMaxBlockFrames` (= 2048) / `kLinkAudioNumChannels` (= 2) / `kSinkInitialMaxNumSamples` (= 8192) を header に集約
   - `ChannelMixState::mixBuffer` の実サイズ計算と UGen 側の `static_assert`、 `LinkAudioSink` seed 生成が同じ単一 source of truth を参照

6. **link_audio_facade に `LinkSessionState` alias 追加**
   - `using LinkSessionState = ::ableton::LinkAudio::SessionState;` (BasicLink<Clock>::SessionState 継承経路を caller から隠蔽)

7. **検証 script の拡張**
   - `verify-plugin.scd`: 既存 channel id=1 に 2 Synth を同時起動して、 deferred-commit 経路の no-crash 検証を追加 (audio content 検証は Live 側でしかできないので scope 外)
   - `verify-live-receive.scd`: `test-tone` (single Synth) に加え `test-sum` channel に 220 Hz + 330 Hz 2 Synth を同時 publish。 operator が Live UI で chord として聞こえれば accumulator 正常、 単音だけなら last-writer-wins 退行

**実装ファイル**:
- `packages/sc-link-audio/src/channel_registry.hpp` — SinkEntry / ChannelMixState 追加、 共通定数集約 (+103/-15)
- `packages/sc-link-audio/src/channel_registry.cpp` — sinks map 型変更、 lookup 戻り値型変更 (+5/-5)
- `packages/sc-link-audio/src/orbit_link_audio_out.cpp` — Ctor cache + next() deferred-commit 全面書き換え (+118/-93)
- `packages/sc-link-audio/src/link_audio_facade.hpp` — LinkSessionState alias (+5)
- `packages/sc-link-audio/scripts/verify-plugin.scd` — 2-Synth same-channel テスト追加 (+16)
- `packages/sc-link-audio/scripts/verify-live-receive.scd` — sum-by-name 用 test-sum channel 追加 (+19/-6)

**検証結果**:
- `cmake --build build` 成功 (warning なし)
- `verify-plugin.scd` 全 step 通過、 sum-by-name no-crash step 含む
- E2E checklist §C (Live UI で chord 確認) は operator 検収 (verify-live-receive.scd 実行時)

**設計上の判断**:
- **1-tick latency は許容**: Link 同期は ms オーダー、 audio block は通常 1〜2 ms 程度。 deferred commit を pipeline 化して同 tick で flush する案もあったが、 「最初の Synth が tick の最後の Synth であるか」を Synth 毎に判定する手段が SC_PlugIn から提供されていないため、 1-tick deferral が最も自然
- **sum 後 clamp**: 2 Synth 各 0.6 → sum 1.2 → clamp 1.0 が mixer 標準動作。 per-Synth clamp は信号を破壊する
- **silent stale-tick drop**: gap > 1 を Print できない (RT thread 制約)。 観測性が必要なら別 issue で `mWorld->mBufCounter` 連続性 metric を Live 側 OSC reply で出す follow-up
- **`SessionState` を optional 化**: `LinkAudio` 参照を SinkEntry ctor に追加する案もあったが、 SinkEntry ctor は forwarding template で `LinkAudioSink` ctor 引数を素通しさせる設計を維持したかった。 optional は 1 byte の has_value flag だけで RT path への overhead は無視できる

**残課題** (本 PR scope 外):
- E2E checklist §C operator 検収 (Live 実機で chord 受信確認)
- Step 2.4 Sample rate mismatch detection
- Step 2.5 Hardware fallback
- Step 4 build/distribution pipeline (Issue #201)

---

### 6.83 Issue #198 / Epic #187: SC plugin UGen 実装 (Step 2.2) (May 08, 2026)

**Date**: May 08, 2026
**Status**: ⏳ IN PROGRESS (draft PR、 着陸後 review)
**Branch**: `198-link-audio-ugen-impl`
**Issue**: signalcompose/orbitscore#198

**動機**: PR #195 で landing した `packages/sc-link-audio/` skeleton に、 LinkAudio (Ableton/link) + SC Plugin SDK の git submodule を取り込み、 `OrbitLinkAudioOut` UGen の C++ 実装を完成させる。 これにより scsynth プロセス内で LinkAudio へ直接 commit し、 仮想ループバック無しで Live トラックへ音声をルーティングする経路が確保される。

#### 主要な実装内容

1. **submodule 追加**:
   - `packages/sc-link-audio/external_libraries/supercollider-sdk/` → `github.com/supercollider/supercollider` tag `Version-3.14.0` に pin (sc_api_version = 3、 ローカル `scsynth 3.14.0` と整合)
   - `packages/sc-link-audio/external_libraries/link/` → `github.com/Ableton/link` master + `modules/asio-standalone` (LinkAudio.hpp / Link.hpp / asio header-only)
   - `git clone --depth 1 --filter=blob:none` (treeless partial clone) で SC SDK の容量を抑制 — 通常の shallow clone は curl 18 (RPC partial) でタイムアウトしたため

2. **LinkAudio API surface 確定** (`docs/research/LINK_AUDIO_API.md` §1 に対する一次情報レビュー):
   - `LinkAudio(double bpm, std::string name)` ctor、 `enableLinkAudio(bool)`、 `captureAudioSessionState()` (RT-safe per docs)、 `clock().micros()` で beat 時刻取得
   - `LinkAudioSink(LinkAudio&, std::string name, size_t maxNumSamples)` で channel 公開、 `BufferHandle::commit(SessionState, beats, quantum, numFrames, numChannels, sr)` で per-block commit
   - **重要発見**: `<ableton/Link.hpp>` と `<ableton/LinkAudio.hpp>` の include 順に注意。 両者の `ApiConfig.hpp` は `LINK_API_CONTROLLER` という同一 macro guard を使うため、 `Link.hpp` を先に include すると `link_audio/ApiConfig.hpp` の typedef (`ChannelId` / `PeerId` / `SessionId`) が skip され、 `LinkAudio.hpp:307` (`LinkAudioSource::id() const`) で `unknown type name 'ChannelId'` で fail する。 facade で `LinkAudio.hpp` を先に include することで回避

3. **`link_audio_facade.hpp` 完成版**: 上記 include 順を強制する 1 ファイル wrapper。 alpha API 変更追従を 1 翻訳単位に閉じ込める

4. **`channel_registry.hpp/cpp`**:
   - `Impl::sinks` を `std::unordered_map<int32_t, std::unique_ptr<LinkAudioSink>>` で実装、 `std::mutex` で保護
   - `LinkAudio` singleton は registry が `std::unique_ptr<LinkAudio>` で所有 (`PluginLoad` で生成、 `PluginUnload` で破棄)
   - `lookup()` は registry が一度割り当てた sink を Step 2.2 では erase しないことを契約とし、 UGen Ctor で raw pointer を cache。 audio thread (`next()`) は cached pointer のみ使用 (lock-free)

5. **`orbit_link_audio_out.cpp`**:
   - `IN(0)` / `IN(1)` で stereo audio input、 `IN0(2)` で `channel` (control-rate constant)
   - `next()` で `std::clamp(f, -1.0f, 1.0f) * 32767.0f` の order で float → int16 変換 (clamp 後の scale でないと wrap-around distortion)
   - `BufferHandle` を per-block で取得・commit、 RAII 解放。 missing subscriber は `operator bool()` false で skip
   - `captureAudioSessionState()` + `link.clock().micros()` で `beatsAtBufferBegin` を計算、 quantum=4.0 で 4/4 mapping (polymeter は v1.2.x で対応)
   - `commit()` には `unit->mWorld->mSampleRate` (scsynth hardware SR) をそのまま渡す。 plugin 内 resampling は本 PR scope 外、 v1.2.x で対応 (`docs/research/LINK_AUDIO_API.md` §0.3)
   - 各 UGen は scratch buffer (`int16_t[2048 * 2]`) を Unit struct に持ち、 audio thread で alloc 不要

6. **OSC `/cmd /orbit/registerLinkAudioChannel <id> <name>` ハンドラ**:
   - Live は `LinkAudioSink` の `name()` を表示するため、 TS dispatch (Step 3) が送る integer channelId とは別経路で human-readable 名を plugin に伝える必要があった
   - `DefinePlugInCmd` で `/orbit/registerLinkAudioChannel` を登録、 `args->geti()` + `args->gets()` で id + name を読んで `ChannelRegistry::registerChannel()` 呼出
   - TS-side の dispatch wiring (`acquire(name)` 時の `/cmd` 送信) は **Step 4 (boot pipeline 統合) で実装**。 本 PR scope 外
   - 設計選択肢 (a-c) は実装着手前にユーザーレビューで合意 ((b) `/cmd` 別途登録を採用)

7. **`OrbitLinkAudio.sc` (sclang クラス stub)**:
   - sclang から `SynthDef` 内で `OrbitLinkAudioOut.ar(left, right, channel)` を使えるように、 UGen 用の sclang サブクラスを定義
   - SC Extensions に `.scx` と並べて install (CMake は build のみ、 install は手動 / Step 4 で自動化)
   - `checkInputs` で audio rate 強制 (left / right が control rate だと C++ 側が float* で control rate の 1 sample buffer を読んで silent failure するため)

8. **CMakeLists の post-build codesign**:
   - macOS は signed parent process (`scsynth` 本体は SuperCollider team で署名済) からの unsigned bundle dlopen を `signal: SIGKILL (Code Signature Invalid)` で殺す
   - `add_custom_command(... codesign --force --sign - ...)` で build 直後に ad-hoc 署名を実施
   - 署名なしで install して試した最初の load で scsynth が即時 crash、 `~/Library/Logs/DiagnosticReports/scsynth-*.ips` で診断
   - production 配布版 (Step 4 `.vsix`) は Developer ID で再署名する想定

9. **検証 (`packages/sc-link-audio/scripts/verify-plugin.scd`)**:
   - sclang harness で 6 段階の検証: class load / scsynth boot (no dlopen crash) / `/cmd` 受理 (positive + 負例 3 件: empty name 拒否、 rename no-op + Print、 unregistered id sink-null Ctor warn) / SynthDef instantiate / 2 秒間 `next()` 走行 (registered id) / unregistered id (id=999) で Ctor warn + next() early-return
   - FAIL 経路は `1.exit`、 30 s タイムアウト guard で hang 検出
   - 全 OK で exit code 0、 server `/quit` も正常 (PluginUnload も正しく fire)
   - Live 12.4+ 受信を含む完全 E2E (`docs/testing/LINK_AUDIO_E2E_CHECKLIST.md` §B-G) は Step 4 で TS dispatch / boot pipeline 統合後に実施可能

#### PR review team pass — iteration 1〜3 反映 (May 08)

draft PR 作成後に simplify pass (3 並列 agent) + pr-review-team (4 並列 agent × 3 iteration) を回し、 Critical 1 件 + Important 多数を反映、 iteration 4 で **Critical = 0, Important = 0** を確認。

- **RT 安全性 (simplify pass)**: `next()` 内の registry mutex 取得を除去 (`LinkAudio*` を Ctor で cache)、 `mWorld->mSampleRate` も Ctor cache、 dead `requestMaxNumSamples` branch を `static_assert` 化
- **Critical**: `verify-plugin.scd` の FAIL 経路が `0.exit` 固定だった (CI で pass / fail 区別不能) → `1.exit` + 30 s タイムアウト
- **silent failure 系 (iter 1〜3)**: Ctor で sink miss 時に `Print` 警告 / `next()` の `unit->link` null guard / `registerChannel` + `initLinkAudio` を try/catch 化 / `shutdownLinkAudio` を 3 段 try/catch (sinks.clear / enableLinkAudio(false) / link dtor 各々) / `/cmd` の `geti(-1)` + `gets(nullptr)` で malformed 引数を sentinel reject + Print / `setName` 経路を no-op + Print (LinkAudio.hpp が `LinkAudioSink` を "Thread-safe: no" と明記する race の回避) / Ctor で server blockSize > kMaxBlockFrames を 1 行警告
- **logging mechanism**: `scprintf` は MH_BUNDLE plugin から link 不可なので SC plugin SDK の `Print` macro (= `(*ft->fPrint)`) 経由に統一。 `ft` を file scope の external linkage に変更し、 `channel_registry.cpp` から `extern InterfaceTable* ft;` で参照
- **負例 test**: `verify-plugin.scd` に unregistered id (id=999) / empty name (id=2, "") / rename no-op (id=1 への 2 度目登録) / sentinel id reject (id=-5) の 4 件、 各 `/cmd` 後に `s.sync`、 期待される Print 出力を `[OK]` メッセージに明示。 assertion 強度は「server crash しない」 + transcript の Print 目視確認 (full 自動化は OSC reply 拡張または stdout grep wrapper が必要、 別作業)
- **comment 整理**: WORK_LOG 6.83 / Step 番号 narration を除去し、 RT-safety / dlopen codesign / sink lifetime invariant など WHY が non-obvious なものは保持。 `channel_registry.hpp` の `registerChannel` doc を「subsequent calls update the displayed name」 から no-op + race 回避 rationale に更新

#### 既知の制限 (本 PR で対応しない)

- **sum-by-name (Step 2.3)**: 同一 channel に複数 sequence が commit する場合の集約は未実装。 現状は last-write-wins per audio tick (各 UGen が独立に `BufferHandle` を取って commit するため)。 Step 2.3 で per-channel mix buffer + tick-end commit パターンを導入予定
- **Plugin 内 resampling (v1.2.x)**: target SR はと scsynth hardware SR を一致させる前提。 不一致時は LinkAudio 側で ring buffer drops が発生する (Void-LinkAudio README 引用)。 plugin 内 resampling 実装は v1.2.x の課題
- **TS dispatch wiring (Step 4)**: `LinkAudioChannelRegistry.acquire()` の新規 name 割当時に `/cmd /orbit/registerLinkAudioChannel <id> <name>` を送る wire は未実装。 Step 4 boot pipeline 統合 PR でまとめて対応

#### Submodule pinning 注意点

- `external_libraries/supercollider-sdk` は **Version-3.14.0 tag** に pin (sc_api_version = 3、 ローカル / bundle scsynth と整合)。 master tip (sc_api_version = 6) に動かすと `API version mismatch` で plugin load 失敗
- `external_libraries/link` は **master** に追従。 LinkAudio API は alpha なので将来 breaking change の可能性あり、 facade で吸収する方針

**残作業 (本 PR 着陸後)**:
- Step 2.3: sum-by-name (per-channel mix buffer + tick-end commit) — issue #200
- Step 4: TS dispatch `/cmd /orbit/registerLinkAudioChannel` wire + boot pipeline での `setLinkAudioPluginAvailable(true)` flip + `.vsix` bundle 統合 + Developer ID 再署名 (本 PR の ad-hoc 署名を置換) — issue #201
- PR #191 follow-up improvements (channel name 64 chars validation 等 7 件) — issue #202

**Doc 整理 (本 PR で実施)**:
- `docs/LINK_AUDIO_E2E_CHECKLIST.md` を `docs/testing/LINK_AUDIO_E2E_CHECKLIST.md` に移動 (PR #191 review M2 / #5 指摘の improvement、 既存 `docs/testing/TESTING_GUIDE.md` 等との配置整合)
- 同 checklist 冒頭に「Plugin 単体検収」 セクションを追加し、 `verify-plugin.scd` (自動) と `verify-live-receive.scd` (Live UI 手動) を案内 (Step 2.2 deliverable で実施可能になった項目を §A-G フル統合 E2E と区別)

**次の Step**: PR #198 のユーザー確認 → review → merge → Step 2.3 (#200) または Step 4 (#201) 着手。

---

### 6.82 Epic #187 / PR #191: claude bot review fixes + LinkAudio strict mode (May 08, 2026)

**Latest follow-up (May 08, post-PR-review-team)**: claude bot 最新レビュー (commit b640469 後) の Minor 指摘から、 ユーザー混乱を防ぐ価値が高い 1 件 (`output("")` の edit-time vs runtime 不整合) を反映:
- 新規 `analyzeEmptyOutputArg()` analyzer を追加し、 `.output("")` および whitespace-only 引数を edit-time で `Error` severity flag (commit `52ee2db`)
- 5 ケース test 追加で 354 件 pass
- 残り Minor (resolveDispatchChannel の二重呼び出し / completion-context のライン局所性 / lookup() 未テスト) は本 PR scope 外、 今後の改善候補

**Date**: May 08, 2026
**Status**: ⏳ IN PROGRESS（PR #191 review-iteration、 main 取り込み済）
**Branch**: `190-link-audio-dsl-syntax`
**関連 PR**: #191 (Step 3 consolidated)、 issue: Epic #187 / #190 / #192

**動機**:

PR #191 の claude bot review (3 件) で指摘された必須 / 推奨項目への対応と、 ユーザーレビューで spec を strict mode に確定 (linkAudio 宣言時に `.output()` 無い sequence は error 扱い、 silent fallback 禁止)。 同時に main 起点で landed した #189 (Step 1) / #195 (Step 2.1) / #196 (release pipeline) を本 branch へ取り込み、 WORK_LOG numbering を 6.79-6.81 に renumber して main の 6.75-6.78 と整合させる。

**Strict mode 確定 (DSL spec §8.1.2 改訂)**:

「全 sequence が LinkAudio 経由」 という §8.1.1 の宣言と整合させるため、 LinkAudio mode 宣言下で `.output()` を持たない sequence は **runtime error** + **VS Code Error diagnostic** とする。 これまでの「silent fallback to hardware + console warn」 は廃止。 hardware/LinkAudio 混在は仕様レベルで禁止 (§8.1.1) なので、 「.output() 忘れ」 は誤動作 (一部 sequence が hardware に流れる) より error で止める方が安全という判断。

**変更内容**:

1. **必須 fix #1 — warn message correction** (`packages/engine/src/core/sequence.ts`):
   - `.output()` の console.warn が `'init global.linkAudio()'` を含んでいた → `'global.linkAudio()'` に修正。 DSL では `init` は変数宣言専用 (`var x = init GLOBAL`)、 method call の前に置くと parser error になるため、 ユーザーが警告メッセージをそのままコピペするとハマる。
   - `tests/core/sequence-output.spec.ts`、 `docs/testing/LINK_AUDIO_E2E_CHECKLIST.md` の対応箇所も更新

2. **必須 fix #2 — testExecutePlayback `@internal` annotation**:
   - `EventScheduler.testExecutePlayback` (PR #23 Phase 4-2 で導入済み pre-existing API、 本 PR の追加ではない) と `SuperColliderPlayer.testExecutePlayback` に `@internal` JSDoc + 趣旨コメント。 既存の `tests/audio/supercollider-gain-pan.spec.ts` 等で広く使われているため call site の置換は scope 外、 但し新規 test (`link-audio-dispatch.spec.ts`) でも採用したのでマーキングだけは更新。

3. **推奨 fix #3 — sample rate validation** (`link-audio-manager.ts`):
   - `linkAudio(targetSampleRate?)` で SR を validate:
     - 非正整数 / NaN / Infinity → warn + override drop (mode flip は維持、 auto-detect にフォールバック)
     - 非標準値 (32000 等) → warn (hint) のみ、 plugin 内 resampling で受理
     - 標準値 (44100 / 48000 / 88200 / 96000 / 176400 / 192000) → silent
   - `tests/core/global-link-audio.spec.ts` に validation block 追加 (6 ケース)

4. **推奨 fix #4 — order-dependent `analyzeOutputWithoutLinkAudio` diagnostic**:
   - 旧実装は file 全体 scan (`linkAudio` がどこかで宣言されていれば OK) → 行順序依存に変更
   - `.output()` が `global.linkAudio()` より前の行にある場合 (live coding 上行から評価) も flag
   - メッセージに違反箇所 `declared at line N` を含める
   - 旧 test `'declared anywhere in the file'` を `'declared on the same line as .output() or earlier'` + `'order violation'` の 2 ケースに置換

5. **推奨 fix #5 — `getLinkAudioChannelRegistry()` accessor comment**:
   - 旧 "Test / debug accessor" → Step 4 boot pipeline + test で使用される旨を明記、 `@internal` 付加

6. **NEW — LinkAudio strict mode runtime + diagnostic**:
   - **runtime**: `Sequence.resolveDispatchChannel()` を public に昇格 (Step 4 boot pipeline + test 用)、 LinkAudio enabled かつ `_outputChannel` 未設定なら throw (sequence name + 修正手順を含むメッセージ)
   - **VS Code diagnostic**: 新 `analyzeLinkAudioMissingOutput()` — `init global.seq` 宣言から sequence 名を抽出、 `<name>.output(` 参照を探し、 LinkAudio 宣言下で output 無い sequence の `<name>.play(` を全 location で **Error** として flag (Warning ではなく Error)
   - `extension.ts` で strict-mode analyzer を wire (`vscode.DiagnosticSeverity.Error`)
   - 旧 strict-mode 判定が無かったので `tests/core/sequence-link-audio-integration.spec.ts` の test 1 件を error 期待に書き換え + 2 ケース (sequence name 含有 / 修正手順 hint) 追加
   - VS Code diagnostic test 7 ケース新規 (orphan flag、 output あり non-flag、 linkAudio 無し no-op、 partial mix、 multi-play、 word-boundary、 commented-out)

7. **DSL spec §8.1.2 改訂** (`docs/core/INSTRUCTION_ORBITSCORE_DSL.md`):
   - 旧 「`.output()` 未指定は hardware にフォールバック」 → strict mode: runtime error
   - 「`global.linkAudio()` 未宣言で `.output()` 呼出」 のフェイルセーフ警告は別経路として残置 (mode 有効化忘れ用)

8. **vsce package CI failure 修正** (`packages/vscode-extension/.vscodeignore`):
   - PR #195 で `packages/sc-link-audio/` が main に landed したため、 PR #191 の release.yml CI で `vsce package` が `invalid relative path: extension/../sc-link-audio/.gitignore` で失敗
   - 原因: vsce 3.x の `.vscodeignore` パターンは vsce が emit する literal な相対パス文字列に対してマッチする。 既存の `../../**` は repo root レベル (2 階層上) を対象とするためsibling package には効かない。 `../engine/**` は engine だけ個別指定する形で、 新しい sibling が増えるたびに exception を足す必要があった
   - 修正: per-package 指定 (`../engine/**` + `../sc-link-audio/**`) を一括 sibling exclusion (`../*/**`) に置き換え。 これで現状の sc-link-audio + 将来の sibling package (midi-engine 等) も自動でカバーされる。 bundled engine は `engine/` (no `../`) に build:copy-engine でコピーされる経路なので影響なし
   - 本来 #195 で対応すべきだったが当時 release.yml の paths filter (`packages/sc-link-audio/**` を含まない) のため CI で検知されず、 PR #191 で初めて顕在化した。 main の release.yml は tag push でのみ走るので次の release tag までは不顕性
   - 「なぜ vsce が sibling を enumerate するのか」 の根本原因調査は別 issue で追跡 (本 PR の merge gate ではない)

9. **main 取り込み + WORK_LOG renumber**:
   - `git merge origin/main` → conflict は WORK_LOG.md のみ (sc-link-audio/ 等 add は auto-merge)
   - HEAD の 6.79 (Step 3.3+3.5) → 6.81、 6.78 (Step 3.2) → 6.80、 6.77 (Step 3.1) → 6.79 に renumber
   - origin/main の 6.78 (Step 2.1) / 6.77 (Step 1) / 6.76 (Marketplace gate) / 6.75 (v1.1.0) は保持

**検証**: `npm run build` (clean) → success、 `npm test` で 331 件 pass / 23 件 skip (元 314 件から +17 件)、 regression なし。

**追加対応 (simplify pass、 May 08)**: `/simplify` (3 agent 並列: code-reuse / code-quality / efficiency) の指摘に対応:

- **code-reuse**:
  - `LINK_AUDIO_PATTERN` を module-scope に hoist (重複定義 2 箇所解消)
  - `findFirstMatchingLine()` helper 抽出 (3 箇所の同 scaffold を統一)
  - `seqDeclPattern` で legacy `init GLOBAL.seq` (uppercase) も match (parser 互換) — test 1 件追加
- **code-quality**:
  - SynthDef 名 `'orbitPlayBuf'` / `'orbitPlayBufLink'` を `SYNTHDEF_HARDWARE` / `SYNTHDEF_LINK` 定数化 (typo silent failure 防止)
  - `SuperColliderPlayer.testExecutePlayback` の `@deprecated` を `@internal` に修正 (IDE strike-through 誤誘導の解消)
  - epic step / 過去 PR 番号 narration コメントを除去 (event-scheduler.ts x4、 sequence.ts x1、 link-audio-channels.ts x1)
  - 警告メッセージから epic 内部参照 (`see Step 2 of Epic #187`) を削除、 actionable hint に置換
  - SR validation の warn 文言を 6 値 set と一致 (44100/48000/88200/96000/176400/192000)
- **efficiency**:
  - `analyzeLinkAudioMissingOutput` の inner-loop 内 RegExp 動的生成を precompile 化 (200 行 × 10 sequences の file で keystroke ごとの ~2000 regex compile を回避)
  - `EventScheduler.stopAll()` で `linkAudioChannels.clear()` を call (long live-coding session で nextId 単調増加を防ぐ、 engine restart で fresh state)

**残作業 (本 PR 着陸後)**:
- Step 2.2: SC plugin (UGen 実装 + submodule mount)、 別 branch
- Step 4: build pipeline で `.scx` 同梱 + plugin available フラグ flip
- Step 3.4: 動的切替 + latency offset (v1.2.x 検討)

**次の Step**: PR #191 のユーザー確認 → merge (project rule に従い `--merge`、 `--squash` ではない) → Step 2.2 着手。

#### PR review team pass (May 08)

4 agent PR review team + simplify pass の指摘のうち本 PR スコープに該当する Critical 2 件・Important 6 件を反映。

- **C1**: `Sequence.run()` / `loop()` の冒頭で `resolveDispatchChannel()` を eager 呼び出し — strict-mode throw が fire-and-forget scheduleEventsFn 内の unhandled rejection で消失する問題を解消。 pipeline test 3 件追加 (`sequence-link-audio-integration.spec.ts`)
- **C2**: `link-audio-channels.ts` docstring の `§B` → `§0.2` (正しいセクション参照に修正)
- **I1**: `Sequence.output("")` 空文字列 / whitespace-only を即時 throw するバリデーション追加
- **I2**: `output()` JSDoc の "emitted once" → "emitted on each call when LinkAudio mode is not enabled" に訂正 (実装と整合)
- **I3**: `output()` JSDoc に asymmetry 注記 ("channel changes take effect at next scheduling cycle; no seamlessParameterUpdate — see Step 3.4")
- **I4**: `link-audio-dispatch.spec.ts` fallback テストのテスト名を "no channel arg" に改訂 + `expect(sentMessages[0]).not.toContain('channel')` assertion 追加
- **I5**: `stopAll()` の channel registry clear を integration test 化 (`link-audio-dispatch.spec.ts` に 1 ケース追加)
- **I6**: `completion-context.ts` の新規 logic を unit test 化 — `tests/vscode-extension/completion-context.spec.ts` を新規作成 (vscode mock + 10 ケース: analyzeMethodChain 5 件 / global completions 2 件 / sequence completions 3 件)

**検証**: 335 件 pass / 23 件 skip (元 331 件から +4 件、 regression なし)。 なお daemon-client.spec.ts の 10 件は sandbox ネットワーク制限 (EPERM listen) による pre-existing 失敗で今回変更と無関係。

#### PR review team pass — iteration 2 follow-up (May 08)

iteration 1 fix 後の 4 agent re-review で残った test gap (Critical 1 件・Important 1 件) を解消。

- **Critical**: `output("")` / `output("   ")` の空文字列 throw guard が untested だった。 `tests/core/sequence-output.spec.ts` に `describe('output() empty-string guard')` ブロックを追加し、 空文字列 throw / whitespace-only throw / valid channel no-throw の 3 ケースを verify。
- **Important**: `seq.loop()` success path (`.output()` 設定済みで throw しない) が untested だった。 `tests/core/sequence-link-audio-integration.spec.ts` に `seq.run()` success test と対称の `seq.loop()` success test を追加。

**検証**: 339 件 pass / 23 件 skip (335 件から +4 件、 regression なし)。

---

### 6.81 Epic #187: Link Audio docs + VS Code support (Step 3.3 + 3.5) (May 07, 2026)

**Date**: May 07, 2026
**Status**: ⏳ IN PROGRESS（PR #191 draft、 着陸後 review 待ち）
**Branch**: `190-link-audio-dsl-syntax` (consolidated PR)
**Issue**: Epic #187 / Step 3.3 (syntax + completion + diagnostic) と Step 3.5 (docs + examples)

**動機**: 当初は Step 3.x を sub-step ごとに別 PR にする計画だったが、 review 負担最適化のため TypeScript + docs で完結する全 sub-step を PR #191 に統合。 本エントリは Step 3.3 と Step 3.5 のコミットをまとめて記録する。 PR #193 (Step 3.2) は #191 に fast-forward マージして close 済。

**Step 3.5 — DSL spec + examples + E2E checklist** (commit `2879ca1`):

- `docs/core/INSTRUCTION_ORBITSCORE_DSL.md` §8 (DAW Integration) を全面改訂、 §8.1 (Link Audio Output) として正式仕様化:
  - §8.1.1 Global mode declaration (`global.linkAudio([SR])`、 once-per-file、 hardware と排他)
  - §8.1.2 Per-sequence channel binding (`seq.output("name")`、 同名 channel sum)
  - §8.1.3 Plugin lifecycle (scsynth 起動 / 終了 紐づけ、 ランタイム切替は v1.2.0 非対応)
  - §8.1.4 Live 側操作手順
- `examples/10_link_audio.orbs` 新規 (single channel publish / drums bus sum / per-sequence gain+pan の 3 パターン)
- `examples/README.md` チュートリアル一覧と ファイル一覧を更新
- `docs/testing/LINK_AUDIO_E2E_CHECKLIST.md` 新規 (Live 12.4+ + plugin の手動 E2E、 A〜G の 7 セクション + トラブルシュート)

**Step 3.3 — VS Code 拡張対応**:

- `packages/vscode-extension/syntaxes/orbitscore-audio.tmLanguage.json`:
  - global methods に `linkAudio` を追加
  - sequence methods に `output` を追加
  - 両方の patterns で entity.name.function ハイライトに乗せる
- `packages/vscode-extension/src/completion-context.ts`:
  - MethodChainContext に hasLinkAudio / hasOutput フラグ追加
  - global completion に `linkAudio(${1:48000})` を追加 (まだ宣言されていないとき)
  - sequence completion に `output("${1:channel-name}")` を追加 (audio 設定後 + まだ output 未指定時)
- `packages/vscode-extension/src/diagnostics-analysis.ts`:
  - GLOBAL_ONCE_METHODS に `linkAudio` を追加 (existing once-per-file diagnostic を再利用)
  - 新規 `analyzeOutputWithoutLinkAudio()` — `seq.output()` が呼ばれているのに `global.linkAudio()` が宣言されていない場合に警告。 file 全体走査、 行コメント除去、 commented-out も正しく無視
- `packages/vscode-extension/src/extension.ts`:
  - `updateDiagnostics` 末尾に `analyzeOutputWithoutLinkAudio` を wire
- `tests/vscode-extension/diagnostics-analysis.spec.ts`:
  - 新規 8 ケース (analyzeOutputWithoutLinkAudio: 6 ケース + global once linkAudio 重複: 2 ケース)

**検証**: npm test で 314 件 pass / 23 件 skip (累計 +48 件、 regression なし)。 husky pre-commit hook で全 commit が lint + format + build pass。

**Step 3 consolidated PR (#191) の最終姿**:
- Step 3.1 DSL syntax (4 commits)
- Step 3.2 dispatch wiring (5 commits、 旧 PR #193 から fast-forward)
- Step 3.5 docs + examples (1 commit)
- Step 3.3 VS Code 拡張 (本コミット)
- 計 11+ commits、 約 1500 行の追加 (TypeScript + docs)

**Step 3.4 (動的切替 + latency offset) は本 PR スコープ外** (v1.2.x 持ち越し)。 当初 Issue #190 の checklist にあったが、 着地後の review で必要性を再判断する想定。

**残作業**:
- Step 2: SC plugin (C++ UGen) `OrbitLinkAudioOut` 実装、 別 branch / 別 PR
- Step 4: ブート pipeline での plugin available 検出 + flip、 build pipeline の `.scx` 同梱、 別 PR
- Step 3.4: 動的切替 + latency offset (v1.2.x 検討)

**次の Step**: γ (Step 2.1 SC plugin skeleton) を別 branch / 別 PR で着手。

---

### 6.80 Issue #192 / Epic #187: Link Audio dispatch wiring (Step 3.2) (May 07, 2026)

**Date**: May 07, 2026
**Status**: ⏳ IN PROGRESS（PR draft、 着陸後 review 待ち）
**Branch**: `192-link-audio-dispatch` (stacked on `190-link-audio-dsl-syntax`)
**Issue**: #192 (Step 3.2) / Epic: #187

**動機**: Step 3.1 (#190) で導入した DSL state (`Global._linkAudioEnabled`, `Sequence._outputChannel`) を **実際のスケジューリング経路** に流す。 SC plugin (Step 2) が未実装の段階でも contract layer を完成させ、 plugin 着地時に SynthDef 名と channel ID が噛み合うよう scaffolding を準備する。

**設計方針**:
- outputChannel を optional param として scheduler interface に追加 (完全な後方互換)
- Sequence layer で「Global.linkAudio() 有効時のみ outputChannel を渡す」 判定を一元化 (resolveDispatchChannel)
- EventScheduler.sendPlaybackMessage で 3 通り dispatch:
  1. outputChannel + plugin available → `orbitPlayBufLink` SynthDef + channel arg
  2. outputChannel + plugin missing → `orbitPlayBuf` fallback + 1 回 warn
  3. outputChannel なし → 既存 `orbitPlayBuf`
- plugin available フラグは default false、 Step 4 のブート pipeline で SynthDef discovery 後に true へ flip する想定

**変更内容** (4 commit):

1. `feat(engine): add LinkAudioChannelRegistry for name → channelId mapping` (4b271e5)
   - `packages/engine/src/audio/supercollider/link-audio-channels.ts` (新規)
   - 同名 channel への複数 sequence は idempotent に同じ ID 解決 (sum-by-name 前提)
   - `tests/audio/link-audio-channels.spec.ts` (6 ケース)

2. `refactor(engine): thread outputChannel through scheduler signatures` (d2cfc88)
   - Scheduler interface (`global/types.ts`) に outputChannel?: string optional 追加
   - SuperColliderPlayer / EventScheduler signatures + ScheduledPlay/PlaybackOptions types を拡張
   - 完全な後方互換 (既存呼出は undefined を渡してパス)

3. `feat(engine): dispatch SynthDef based on outputChannel with hardware fallback` (d79968e)
   - EventScheduler に LinkAudioChannelRegistry インスタンス + plugin available フラグ + warn フラグ
   - `setLinkAudioPluginAvailable()` / `isLinkAudioPluginAvailable()` / `getLinkAudioChannelRegistry()` public API
   - sendPlaybackMessage で 3 通り dispatch + plugin 不在時 1 回 warn
   - `tests/audio/link-audio-dispatch.spec.ts` (8 ケース)

4. `feat(engine): wire Sequence dispatch channel to global LinkAudio mode` (125ab5f)
   - Sequence に resolveDispatchChannel() 追加 — linkAudio off ならば undefined 返す
   - ScheduleEventsOptions / ScheduleEventsFromTimeOptions に outputChannel?: string 追加
   - sequence-side helper (`scheduling/event-scheduler.ts`) で scheduler.scheduleEvent / scheduleSliceEvent への thread
   - `tests/core/sequence-link-audio-integration.spec.ts` (4 ケース)

**End-to-end dispatch contract が成立**:

DSL → core → scheduler → plugin の全レイヤーで outputChannel 配線完了:
1. DSL: `seq.output("kick")` (Step 3.1)
2. Core: `Sequence._outputChannel` + `Global._linkAudioEnabled` (Step 3.1)
3. Dispatch decision: `resolveDispatchChannel()` (本 sub-step)
4. Scheduling pipeline: `ScheduleEventsOptions.outputChannel` (本 sub-step)
5. SC Player: `scheduleEvent(..., outputChannel)` (本 sub-step)
6. EventScheduler: SynthDef 名切替 + channel id 解決 (本 sub-step)
7. SC plugin の `orbitPlayBufLink` (Step 2 で実装予定)

**検証**: npm test で 306 件 pass / 23 件 skip (新規 18 件追加)、 regression なし。 husky pre-commit hook で 4 commit すべて lint + format + build pass。

**残作業 (別 sub-issue)**:
- Step 2: SC plugin (C++ UGen) 実装 — `orbitPlayBufLink` SynthDef 提供、 plugin available フラグの flip タイミング Step 4 で wire
- Step 3.3: VS Code 拡張対応 (syntax highlighting、 completion、 厳密 diagnostic)
- Step 3.4: 動的切替 (immediate output) + latency offset
- Step 3.5: docs (`INSTRUCTION_ORBITSCORE_DSL.md`) + examples

**stacked PR の状態**:
- PR #189 (Step 1 research) → main 待ち
- PR #190 (Step 3.1 DSL syntax) → main 待ち
- PR #192 (Step 3.2 dispatch、 本 sub-step) → 190-link-audio-dsl-syntax を base に作成、 #190 が main に landing したら自動 rebase

**次の Step**: Step 1 PR (#189) merge → Step 3.1 PR (#190) merge → 本 PR (#192) merge → Step 2 (SC plugin 実装) 着手。 Step 3.3 / 3.4 / 3.5 は Step 2 と並行可能。

---

### 6.79 Issue #190 / Epic #187: Link Audio DSL syntax (Step 3.1) (May 07, 2026)

**Date**: May 07, 2026
**Status**: ⏳ IN PROGRESS（PR draft、 着陸後 review 待ち）
**Branch**: `190-link-audio-dsl-syntax`
**Issue**: #190 (Step 3.1) / Epic: #187

**動機**: Epic #187 の Step 3.1。 LinkAudio output layer の DSL 表面構文 (`global.linkAudio([SR])` + `seq.output("channel-name")`) を parser・AST・コア state レベルで受理し、 単体テストでカバーする。 SC plugin / dispatch / VS Code 拡張は別 sub-step (3.2 / 3.3 / 3.4 / 3.5) で扱い、 本 Issue は **DSL 表面の文法対応のみ** に絞る。

**設計方針** (Epic #187 §0 を継承):
- LinkAudio mode は once-per-file 宣言で hardware 出力と排他
- `seq.output("name")` は channel name のみ (kind は Global mode から implicit)
- ランタイム切替は v1.2.0 非対応 (immediate 系 `_method()` は本 sub-step では未実装)
- SR 戦略は plugin 内リサンプリング (auto-detect → DSL override → 48k fallback)

**変更内容**:

`packages/engine/src/core/global/link-audio-manager.ts` 新規:
- LinkAudioManager クラス。 _enabled / _targetSampleRate を保持、 linkAudio(targetSR?) で enable

`packages/engine/src/core/global/types.ts`:
- GlobalState に linkAudioEnabled / linkAudioTargetSampleRate を追加

`packages/engine/src/core/global.ts`:
- LinkAudioManager をインスタンス化、 linkAudio(targetSR?) / isLinkAudioEnabled() メソッド追加、 getState() に LinkAudio state を merge

`packages/engine/src/core/sequence.ts`:
- _outputChannel フィールド追加、 output(channelName) メソッド (chainable) + getOutputChannel() アクセサ
- output() 呼出時に Global.linkAudio() 未宣言なら console.warn (例外を投げない、 厳密チェックは Step 3.3 の VS Code diagnostic で)

`packages/engine/src/core/sequence/types.ts`:
- SequenceState に outputChannel?: string を追加

`tests/core/global-link-audio.spec.ts` 新規 (7 ケース):
- default disabled、 有効化、 明示 SR、 44.1k 受理、 chainable、 上書き、 explicit→undefined への戻し

`tests/core/sequence-output.spec.ts` 新規 (7 ケース):
- default undefined、 記録、 chainable、 上書き、 Global 未宣言時 warn、 Global 宣言済み時 warn なし、 hyphen + underscore 受理

`tests/audio-parser/link-audio-syntax.spec.ts` 新規 (8 ケース):
- tokenizer / parser を変更せずに既存 method-call 経路で受理されることを確認
- global.linkAudio() の args の有無 + 値伝播
- seq.output() の hyphen / underscore 受理、 chain 組み合わせ
- 複合プログラム (global.tempo + global.linkAudio + var init + seq chain)

**parser を触らなかった理由**:
既存 tokenizer keyword は `var, init, by, GLOBAL, force, RUN, LOOP, MUTE` のみで、 `linkAudio` / `output` は IDENTIFIER として通る。 AST は generic な `target / method / args` 構造なので追加メソッドのために schema 変更は不要。

**`init` prefix の扱い (要 review)**:
ユーザーレビューで「init global.linkAudio()」 案が選択されたが、 既存 parser では `init` は変数宣言専用 (`var x = init GLOBAL` / `var s = init global.seq`)。 厳密に `init global.linkAudio()` 形を実装するには parser 拡張 (`parseGlobalInit` を method-call 受理に拡張) が必要。 本 PR では既存 conventions (`global.tempo()` 等) と揃った `global.linkAudio()` 形を採用 (parser 拡張不要)。 着陸後の review で「init prefix 必須かどうか」 をユーザー判断仰ぐ。

**コミット構成 (小コミット 3 本)**:
- `68fb4d6` feat(engine): add Global.linkAudio() for LinkAudio mode declaration
- `7cfd85b` feat(engine): add Sequence.output() for LinkAudio channel binding
- `d1ffdcf` test(parser): verify LinkAudio DSL syntax parses via existing generic path

**検証**: npm test で 288 件 pass / 23 件 skip (新規 22 件追加)、 regression なし。 lint-staged hook (eslint + prettier) を 3 commit すべて pass、 build も pass。

**残作業 (別 sub-issue)**:
- Step 3.2: dispatch ロジック (SuperColliderPlayer 側 SynthDef 切替、 channel ID 管理)
- Step 3.3: VS Code 拡張対応 (syntax / completion / 厳密 diagnostic)
- Step 3.4: 動的切替 + latency offset
- Step 3.5: docs (`INSTRUCTION_ORBITSCORE_DSL.md`) + examples

**次の Step**: Step 1 PR (#189) merge → Step 2 (SC plugin 実装) 着手。 Step 3 残 sub-step は Step 2 の進捗と並行可能。

---

### 6.78 Issue #194 / Epic #187: SC plugin skeleton (Step 2.1) (May 07, 2026)

**Date**: May 07, 2026
**Status**: ⏳ IN PROGRESS（PR draft、 着陸後 review 待ち）
**Branch**: `194-link-audio-plugin-skeleton` (main から派生、 PR #191 とは独立)
**Issue**: #194 (Step 2.1) / Epic: #187

**動機**: Epic #187 の Step 2.1。 `OrbitLinkAudio.scx` plugin の置き場 (`packages/sc-link-audio/`) を skeleton として整備し、 後続 Step 2.2 (UGen 実装) / Step 4 (build pipeline 統合) が着手できる足場を作る。 本 sub-step は **ファイル配置とディレクトリ構造の確定が目的** で、 実コンパイルは scope 外。

**設計方針** (Epic #187 §0 を継承):
- macOS arm64 only (v1.x release target、 Linux/Windows は scope 外)
- LinkAudio API は alpha → wrapper 1 ファイル (`link_audio_facade.hpp`) に集約
- GPL-2.0-or-later の独立 artifact、 OrbitScore 本体 (`LicenseRef-Signal-compose-FairTrade-1.0`) と mere aggregation
- submodule (SC SDK + Ableton/link) の物理追加は Step 2.2 で実施 (本 sub-step は placeholder のみ)

**変更内容** (1 commit):

新規ファイル群:
- `packages/sc-link-audio/README.md` — 目的、 ディレクトリ構造、 ライセンス、 ビルド前提、 関連 Issue/PR、 ステータス表
- `packages/sc-link-audio/CMakeLists.txt` — C++17、 SC_PATH / LINK_AUDIO_PATH を configure-time 変数で受ける、 macOS arm64 強制、 OrbitLinkAudio.scx を `add_library(... MODULE)` で出力。 Step 2.1 では configure までを wire (実コンパイルは Step 2.2 の submodule 追加後)
- `packages/sc-link-audio/.gitignore` — build/ 成果物 + submodule clone を ignore
- `packages/sc-link-audio/external_libraries/.gitkeep` — submodule mount point の placeholder + コメントで Step 2.2 の手順を明記
- `packages/sc-link-audio/src/link_audio_facade.hpp` — alpha API 変更を吸収する 1 ファイル wrapper の枠組み (型 alias + Step 2.2 で埋める関数シグネチャ コメント)
- `packages/sc-link-audio/src/channel_registry.hpp` / `channel_registry.cpp` — TS 側 `LinkAudioChannelRegistry` (Step 3.2) と対になる server 側 lookup の宣言 + stub 実装 (lazy-create + sum-by-name 用)
- `packages/sc-link-audio/src/orbit_link_audio_out.cpp` — `OrbitLinkAudioOut` UGen の skeleton (Ctor/Dtor/next が no-op、 Step 2.2 で実装)

設計上の注意:
- 全 C++ ソースに `#ifdef ORBIT_SC_PLUGIN_BUILD` を巻いて、 SC SDK が無い環境でも編集 / lint が破綻しない
- `#include "link_audio_facade.hpp"` は ORBIT_SC_PLUGIN_BUILD 未定義時に stub forward declaration を提供 (linter 対応)
- workspace package.json は触らない (C++ プロジェクトのため、 npm workspaces とは無関係)

**検証**:
- `npm test` で 266 件 pass / 23 件 skip (本 branch は main 起点のため、 PR #191 の +48 件は載っていない、 これは想定通り)
- regression なし、 TS toolchain への影響ゼロ
- husky pre-commit hook で commit が pass

**残作業 (別 sub-issue)**:
- Step 2.2: `OrbitLinkAudioOut` UGen 単一 channel commit 実装、 git submodule add (SC SDK + Ableton/link)
- Step 2.3: channelId → sink lookup の動的 add/remove
- Step 2.4: 同名 sum 動作の検収 (2 sequence で同一 channel に出して加算合成確認)
- Step 2.5: tempo / phase / transport sync (LinkAudio 内蔵 Link 経由)
- Step 4: ブート pipeline での plugin available 検出 + flip、 `.vsix` bundle 統合

**stacked PR の状態**:
- PR #189 (Step 1 research) → main 待ち
- PR #191 (Step 3.1 + 3.2 + 3.3 + 3.5 consolidated) → main 待ち、 Step 2 plugin 不在時の hardware fallback で機能完備
- PR #194 (Step 2.1 skeleton、 本 sub-step) → main 起点で独立、 PR #191 の merge 順序とは無関係

**次の Step**: 着陸後 PR review + tag push を待機。 飛行機内で進められる範囲はここまで (Step 2.2 以降は SC SDK + Ableton/link の git clone が必要、 着陸環境で着手)。

---

### 6.77 Issue #188 / Epic #187: Link Audio API research finalized (Step 1) (May 07, 2026)

**Date**: May 07, 2026
**Status**: ⏳ IN PROGRESS（PR レビュー待ち）
**Branch**: `188-link-audio-research`
**Issue**: #188 (Step 1) / Epic: #187

**動機**: Ableton Live 12.4 (2026-05-05 公開) で導入された Link Audio を OrbitScore に統合する Epic #187 の前段階として、 SDK の API surface・サンプルレート挙動・ライセンス条件を一次情報で確定し、 後続 Step 2 (SC plugin 実装) / Step 3 (DSL 構文) / Step 4 (ビルドパイプライン) が安心して着手できる解像度を確保する。

**設計方針** (Epic #187 の plan を引き継ぎ):
- scsynth は維持、 LinkAudio 専用ブリッジを SC plugin (C++ UGen) として実装
- DSL `seq.output("link-audio", "channel-name")` で出力先指定（MIDI 拡張余地を残す形）
- macOS arm64 only、 Link Audio API は alpha のため wrapper 1 ファイルに集約
- MIDI は別 Issue（DSL 構文だけ拡張余地確保）

**主な findings (一次情報確定)**:

API surface (`LinkAudio.hpp` 直接読込):
- `LinkAudio` は `Link` を継承 → tempo / beat / phase / transport は base Link メソッドで取得
- `LinkAudioSink::BufferHandle::commit()` は realtime-safe（SC plugin audio thread から呼べる）
- `commit()` に sample rate を毎回渡せる仕様（API 上は SR 固定不要）
- 16-bit signed integer interleaved、 mono(1) または stereo(2) のみ
- `setChannelsChangedCallback` のシグネチャは `void()` 引数なし

Sample rate 制約 (Void-LinkAudio README からの一次引用):
- Link Audio は **内部リサンプリングなし** → publisher / subscriber SR 不一致時に ring buffer overflow（44.1k vs 48k で ~8% 連続ドロップ）
- 当初は scsynth `-S 48000` 強制起動を検討したが、 ユーザーレビューで撤回 → 後述の確定方針へ

License 概況:
- Link 公式: GPL-2.0-or-later（標準 GPL v2、 改変条項なし）または proprietary commercial
- OrbitScore 本体: `LicenseRef-Signal-compose-FairTrade-1.0`

**ユーザーレビューで確定した設計決定** (LINK_AUDIO_API.md §0 参照):

1. **出力モード**: `init global.linkAudio([SR])` で **once-per-file 宣言**、 hardware 出力と排他。 当初の per-sequence destination 案 (`seq.output("link-audio", "ch")`) から簡素化
2. **Per-sequence syntax**: `seq.output("channel-name")` — kind 引数不要 (Global mode から implicit)
3. **Sample rate**: scsynth は hardware SR 任せ、 plugin 内で target SR へリサンプリング (auto-detect → DSL override → 48k fallback)。 hardware 環境差異吸収と Live セッション SR 柔軟対応のため
4. **License**: `.scx` を独立 GPL-2.0-or-later artifact として分離配布、 `.vsix` bundle 同梱時は LICENSE.GPL-2.0 + NOTICE で mere aggregation 明記
5. **Channel 上限**: self-imposed 制限なし、 LinkAudio 仕様任せ
6. **Plugin lifecycle**: `init global.linkAudio()` 宣言時 load + enable、 scsynth shutdown 時 disable / unload。 ランタイム切替は v1.2.0 では非対応

**変更内容**:

- `docs/research/LINK_AUDIO_API.md` 新規作成（一次情報 URL 引用、 API surface / SR / License / 設計追加確定 / 残不確定要素を網羅 + Section 0 にユーザーレビュー後の確定設計決定を集約）

**Epic plan への影響**:
- 一次情報による破壊的 findings なし
- ユーザーレビューによる設計簡素化あり (per-sequence destination → Global mode 排他)
- Epic Issue #187 body は本コミット後に簡素化された設計で update

**残不確定要素 (Step 2 着手前に解消)**:
- `linkaudio/AudioPlatform.hpp` の commit ループ実装パターン (submodule 取り込み後直接読む)
- LinkAudio peer info / OS API による target SR auto-detect 可否
- Plugin 内リサンプリングの実装方式（線形 / 簡易 sinc / rubato 相当）
- SC Plugin SDK のバージョン pinning と scsynth bundle (3.14.x) との ABI 一致

**次の Step**: Step 2 (SC plugin 実装) を別 branch / 別 Issue で着手予定。

---

### 6.76 Gate Marketplace/Open VSX publish on PUBLISH_MARKETPLACE variable (May 07, 2026)

**Date**: May 07, 2026
**Status**: ⏳ IN PROGRESS (PR #196 に同梱)
**Branch**: `claude/prepare-orbitscore-release-0Q6uK`
**関連 Issue**: #197 (Marketplace / Open VSX 登録追跡)
**関連 PR**: #196 (release v1.1.0 cut)

**動機**: v1.1.0 stable tag push 後、 `release.yml` の `Publish to VS Code Marketplace` step が `VSCE_PAT` 未登録のため fail-loud で失敗 (run id 25484379033)。 GitHub Release 作成と .vsix asset 添付は完了しているが、 publisher account / PAT 準備が整うまでは workflow を成功させたい。

**経緯**:
- v1.1.0 tag push は 6.75 で完了、 release workflow が起動
- Build / bundle / .vsix package / GitHub Release create までは success
- `Publish to VS Code Marketplace (stable only)` step が `VSCE_PAT` secret 未登録で fail-loud を意図通り発火
- Open VSX publish step は依存関係で skipped
- 利用者は publisher account 準備前であり、 暫定で publish step を gate する必要がある

**変更内容**:

- `release.yml` の publish step に repo variable `PUBLISH_MARKETPLACE == 'true'` の gate を追加:
  - `Publish to VS Code Marketplace (stable only)` の `if` に追加
  - `Publish to Open VSX (stable only)` の `if` に追加
  - 未設定 (`!= 'true'`) の場合、 stable tag push でも publish step は skip される (GitHub Release は引き続き作成)
- workflow header コメントに gating model を追記 (PUBLISH_MARKETPLACE の意味、 issue #197 への参照)
- error message を更新: 「VSCE_PAT 未登録」 → 「PUBLISH_MARKETPLACE=true なのに VSCE_PAT 未登録」 (variable と secret の不整合を明示)
- `Summary` step に新しい分岐を追加: stable release だが publish gated off の状態を表示

**設計判断**:
- `if: false` でハードコード disable する案より、 repo variable gate にすることで
  - 復旧操作が `gh variable set PUBLISH_MARKETPLACE --body 'true'` の 1 コマンドで完結 (workflow 再編集不要)
  - secret 登録 + variable 有効化を分離して、 variable 有効化時に secret 未登録なら fail-loud (誤設定検出可)
  - 状態が GitHub UI 上で可視 (Settings → Secrets and variables → Actions → Variables)
- prerelease (`v*-rc1` 等) は別ロジック (`is_prerelease == 'false'`) で既に skip 済、 PUBLISH_MARKETPLACE と独立

**復旧手順 (issue #197 完了時)**:
1. `gh secret set VSCE_PAT --repo signalcompose/orbitscore`
2. `gh secret set OVSX_PAT --repo signalcompose/orbitscore`
3. `gh variable set PUBLISH_MARKETPLACE --body 'true' --repo signalcompose/orbitscore`
4. 次の stable tag (例: v1.1.1) で publish が走ることを確認

---

### 6.75 Release v1.1.0 stable — promote RC sequence to stable (May 06, 2026)

**Date**: May 06, 2026
**Status**: ⏳ READY (tag push 待ち、 proxy 制約により利用者側で push 必要)
**Branch**: `claude/prepare-orbitscore-release-0Q6uK`
**Tag**: `v1.1.0` (v1.1.0-rc1/rc2/rc3 を経た初の stable 化)

**動機**: ICMC 2026 Hamburg (5/10-16) 発表前に、 既に rc1/rc2/rc3 を切り終えた v1.1.0 を stable として正式タグ付けし、 `release.yml` workflow による Marketplace / Open VSX / GitHub Release の自動配信パイプラインを起動する。 RC 連番をきちんと stable で締めくくることで `v1.0.1 → v1.1.0-rc{1,2,3} → v1.1.0 stable` の canonical な lineage を残す。

**バージョン選択の根拠**:
- 当初 v1.2.0 案で実装着手したが、 過去タグ (v1.0.1, v1.1.0-rc{1,2,3}) を `git fetch --tags` で確認した結果、 v1.1.0 RC が 3 本も切られているのに stable promote が未実施という宙吊り状態が判明
- post-rc3 の変更 (.orbs rename / 学習サイト / diagnostics) は「v1.1.0 の最終スコープに取り込まれた追加分」 として位置づけ可能、 別 minor を切る積極的理由なし
- README / WORK_LOG にも「ICMC v1.1.0 release-ready」 という記述があり、 そもそも 1.1.0 が出すべきバージョンだった
- semver 上 `.osc` → `.orbs` は breaking だが、 利用者影響範囲を考慮して minor (1.1.0) 扱い、 CHANGELOG Changed 冒頭で明示

**Proxy 制約 (重要)**:
- Claude session の git proxy は `refs/tags/*` への push を 403 で全面ブロック
- annotated/lightweight 問わず、 また tag 名のパターンに依らず拒否される
- これは tag push が release.yml workflow を起動して Marketplace publish まで自動実行する高権限操作だからで、 安全装置として人間の手動 push を強制する設計
- 結果、 commit + branch push までは Claude が完了、 最後の `git push origin v1.1.0` のみ利用者側で実行が必要

**変更内容**:

- `CHANGELOG.md` 新規作成 (Keep a Changelog 準拠、 1.1.0 が初エントリ)
- `package.json` (root) `1.1.2` → `1.1.0` (※ 後方への version down は package.json 上の数値のみ、 git tag は新規)
- `packages/vscode-extension/package.json` `1.1.2` → `1.1.0`
- `package-lock.json` workspace ルートと vscode-extension entry を 1.1.0 に同期

**含まれる主な変更 (v1.1.0-rc3 以降)**:
- 拡張子 `.osc` → `.orbs` (af9b887) ※ 利用者リネーム必要
- 診断機能: global once-per-file / audioPath ordering (0666633, 2c3d793)
- ユーザー向け学習サイト 8 章 (65a11b8)
- 開発者向け学習サイト 16 章 (671481f)
- i18n: dev 18 章 / user 8 章の英訳 (136c4b6, d4e1850)
- GitHub Pages deploy workflow (36dae32)
- 環境非依存 audio path 解決 fix (f972ddc)

**自動化フロー**:
1. tag `v1.1.0` を push (利用者側で実行)
2. `.github/workflows/release.yml` が trigger:
   - macOS arm64 で extension をビルド
   - scsynth bundle 抽出 + 整合性検証
   - `.vsix` package 化
   - `gh release create --generate-notes` で GitHub Release 作成 + .vsix を asset 添付
   - VS Code Marketplace + Open VSX に publish (stable tag のみ)
3. CHANGELOG.md は repo 内 canonical 詳細記録、 GitHub Release notes は workflow による auto-generated 形式

---

### 6.74 Deploy user + dev learning sites to GitHub Pages (May 06, 2026)

**Date**: May 06, 2026
**Status**: ⏳ IN PROGRESS (PR pending)
**Branch**: `claude/review-issues-gyJUJ`
**関連 Issue**: #183 (deploy user site), #165 (deploy dev site), #181 (translation sync gap), #166 Epic (dev learning site)

**動機**: ICMC 2026 Hamburg (5/10-16) の発表に向けて、user / dev 両学習サイトの公開導線を確立する。Twitter / QR / 論文から飛んできた閲覧者が Web 上で内容を読める状態にする。 user は内容完成・dev は「個人学習ノート」 として未完を含むまま公開する方針。

**設計方針**:
- 同一 repo・GitHub Actions deploy・subpath split:
  - user → `https://signalcompose.github.io/orbitscore/`
  - dev → `https://signalcompose.github.io/orbitscore/dev/`
- カスタムドメイン (post-ICMC) は CNAME + `base` 切替で対応可
- dev サイトは未完 (#166 stub 章、#181 ja code comment 残存) を含むまま公開:
  - landing の disclaimer (「個人学習ノート」「code が SoT」) で読者期待値を制御
  - `.translation-glossary.md` で「code 内 ja コメントは byte-identical (英訳しない)」 を明文化
  - `what-is-orbitscore.md` stub には Glossary / ADR-002 への pointer を追加 (迷子防止)

**変更内容**:

Workflow:
- `.github/workflows/deploy-sites.yml` 新規 — `main` の `sites/**` 変更で trigger、 user / dev を 1 artifact に集約 → Pages deploy

VitePress config:
- `sites/user/.vitepress/config.ts` — `base: '/orbitscore/'` 追加
- `sites/dev/.vitepress/config.ts` — `base: '/orbitscore/dev/'` 追加、 KaTeX CSS link を base 込みに更新

Translation glossary (#181 sync gap 対応):
- `sites/dev/.translation-glossary.md` §2 を改訂:
  - 「code 内 ja コメントは byte-identical (英訳しない)」 を明文化、citation 整合を最優先する根拠を記載
  - 「commit message 引用は ja のまま (verbatim quote)」 を追加

Stub 暫定対応 (#166 Epic 残作業):
- `sites/dev/orientation/what-is-orbitscore.md` (ja/en) — stub のまま、Glossary と ADR-002 への pointer を追加、「暫定的な要点」 を 3 行で書き起こし、Epic #166 で yamato 直筆予定を明記

README:
- `README.md` (root) — Learning Sites (web) セクション追加、 4 link
- `sites/user/README.md` — 「公開について」 → 「公開 URL」 に置換、 deploy workflow 説明
- `sites/dev/README.md` — 「公開 URL」 セクション追加、 個人学習ノートとして未完を含むことを明記

**ビルド確認**:
- `npm run docs:build -w @orbitscore/user-site` ✅ 成功 (18.57s)
- `npm run docs:build -w @orbitscore/dev-site` ✅ 成功 (23.92s)
- 生成 HTML の asset href が `/orbitscore/` および `/orbitscore/dev/` で正しく prefix 化されることを確認
- workflow の combine step (user dist → root + dev dist → /dev/) を local 模擬実行、両 index.html 生成確認

**残タスク (post-deploy)**:
- Repo Settings → Pages → Source = "GitHub Actions" を web UI で有効化 (yamato 操作)
- カスタムドメイン取得 + CNAME 設定 + `base` 切替 (post-ICMC、別 PR)
- #181 残作業: 8 ファイルの ja code comment は glossary 改訂で「byte-identical 規律」 として正規化 (修正不要)
- #166 Epic: `what-is-orbitscore.md` の本文完成 (post-ICMC、 yamato 直筆)

### 6.73 Translation prep: i18n setup, glossaries, spike translations (May 06, 2026)

**Date**: May 06, 2026
**Status**: ⏳ IN PROGRESS（マージ前 review 待ち）
**Branch**: `prep-translation-i18n-setup`

**動機**: dev / user 両学習サイトの日英翻訳を効率化するための事前準備。bulk 翻訳は Claude on the Web / CronCreate routine に委ねる前提で、品質と整合性を保証するインフラを Claude Code 側で確立する。

**設計方針**:
- VitePress 標準の i18n 機能を使用（locales: ja root + en）
- 用語ペア・トーン・do-not-translate を `.translation-glossary.md` に明示
- spike 章を Claude Code で完訳して on-the-web の reference template とする
- 章単位 issue で並列翻訳できる workflow

**変更内容**:

`sites/user/`:
- `.translation-glossary.md` 新規（用語ペア、ですます調 → polite English の翻訳例、章タイトル英訳一覧）
- `.vitepress/config.ts` を `locales: { root, en }` 構造に書き換え
- `.vitepress/sidebar.ts` を `sidebarJa` / `sidebarEn` に分離
- `en/` 配下に全 10 章 stub を作成（warning ボックス表示）
- `en/index.md` (章 1) を完訳（spike）
- `en/getting-started/first-sound.md` (章 3) を完訳（spike）

`sites/dev/`:
- `.translation-glossary.md` 新規（user とは別のトーン規律と verbatim 規律を含む、CRITICAL §4）
- `.vitepress/config.ts` を i18n 対応化、README.md を srcExclude に追加
- `.vitepress/sidebar.ts` を `sidebarJa` / `sidebarEn` に分離
- `en/` 配下に全 19 章 stub を作成
- `en/orientation/architecture-overview.md` (spike 章) を sub-agent dispatch で完訳

`docs/development/`:
- `TRANSLATION_WORKFLOW.md` 新規（翻訳 workflow、章単位 issue テンプレ、ローカル実行例）
- `TRANSLATION_STATUS.md` 新規（29 章の進捗 tracker、status 定義、ja 更新時の手順）

**ビルド確認**: 両サイト build クリーン通過。`/en/` 配下の各 stub と spike 章が表示でき、navbar 右上に言語スイッチャーが自動生成されることを確認。

**残タスク（別 issue で扱う）**:
- bulk 翻訳: user 残り 8 章 + dev 残り 18 章（章単位 issue で Claude on the Web に dispatch）
- ja 元更新時の en 自動 outdated 検出（CronCreate routine 化）
- Web デプロイ（GitHub Pages 等）

---

### 6.72 Issue #174: Build user-facing learning site (sites/user/) (May 06, 2026)

**Date**: May 06, 2026
**Status**: ⏳ IN PROGRESS（マージ前 review 待ち）
**Branch**: `174-user-learning-site`
**Issue**: #174

**動機**: ICMC で論文に興味を持った人や VS Code 拡張をインストールしたユーザーが、OrbitScore で実際に音を出してライブコーディングを始められるようにする「優しく丁寧な」初心者向け学習サイトを構築。dev サイト (`sites/dev/`) と並行して、UX 寄りの learning resource を整備する。

**設計方針**:
- 場所: `sites/user/`（VitePress、`@orbitscore/user-site` workspace）
- 言語: 日本語のみ（英語版は別 issue で on-the-web / CronCreate routine で後追い）
- 想定読者: 完全初心者、小学校高学年〜中学生レベルでも理解可能、子供扱いせず
- トーン: ですます調、friendly、kind、親切丁寧
- 表現: コードのみ（動画・GIF・スクリーンショットなし、必要なら Mermaid のみ）
- SoT 関係: `docs/user/ja/USER_MANUAL.md` を primary source として再構成（dev サイトとは異なり code 直接引用ではない）

**章構成（10 章）**:
1. OrbitScore とは（landing 兼ねる）
2. インストール
3. はじめての音
4. パターンを作る
5. 複数のシーケンス
6. ポリメーター・ポリリズム
7. オーディオ操作
8. ライブコーディング
9. リファレンス（チートシート）
10. トラブルシューティング

**変更内容**:

- `docs/development/USER_LEARNING_SITE.md` 新規作成（DEV_LEARNING_SITE.md 形式準拠の project brief）
- `sites/user/` VitePress project 一式を新規作成（package.json、.vitepress/config.ts + sidebar.ts + theme/、STYLE_GUIDE.md、README.md）
- 全 10 章を執筆（sub-agent 並列 dispatch、Group A/B/C で 9 章、spike 章 first-sound.md は手書き）
- `docs/core/INDEX.md` に user 学習サイトの section を追加

**執筆 workflow**:
- spike 章: 章 3 first-sound.md を手書きでトーン基準を確立
- bulk: sub-agent を 3 並列で dispatch（Group A: 章 2, 10 / Group B: 章 4, 5, 6 / Group C: 章 7, 8, 9）
- self-check: ですます調違反、子供扱いトーン、過剰絵文字を grep で検出 → 違反なし

**ビルド確認**: `npm run -w sites/user docs:build` クリーン通過、dead link なし、syntax warning なし。

**別 issue で扱う**:
- 英語版翻訳（dev サイトの英語化と同時に）
- Web デプロイ（GitHub Pages or Vercel）
- マーケットプレイス公開後の install ページ更新

---

### 6.71 Issue #171: Diagnostics for global once-per-file & audioPath ordering (May 06, 2026)

**Date**: May 06, 2026
**Status**: ⏳ IN PROGRESS（マージ前動作確認待ち）
**Branch**: `171-global-once-per-file-diagnostics`
**Issue**: #171
**Version**: 1.1.1 → **1.1.2**

**動機**:
- パス解決の runtime エラーは Output Channel にしか出ず、入力時点で気づきにくい（デモ中だと致命的）
- DSL の意図: `global` の state-setting メソッドは単一情報源、live coding の正攻法は「行を書き換えて再評価」
- `global.audioPath()` は `seq.audio()` より前にないと、絶対化のタイミングがズレる

**設計方針**: VS Code 拡張の静的 diagnostic として実装（parser レベルでは syntax error にできない、構文上は valid）。Engine/parser 一切無変更、テストも無変更。

**変更内容**:

`packages/vscode-extension/src/extension.ts`:
- 既存の `updateDiagnostics()` 関数末尾に 2 つの解析パスを追加
- Analysis 1: `global.<method>()` の重複検出（state-setting 10 メソッド対象）
  - 対象: tempo, beat, audioPath, start, stop, gain, key, normalizer, limiter, compressor
  - 対象外: `init global.seq`, LOOP/RUN/MUTE
  - 2 回目以降の出現に Warning severity の Diagnostic
- Analysis 2: audioPath ordering 検出
  - 最初の `global.audioPath(` 出現位置を取得
  - 各 `\.audio("...")` 呼び出しについて、相対パスかつ audioPath より前に出現または audioPath 不在 → Warning
  - 絶対パス（`/`, `~/`, `C:\`）はスキップ

`package.json` (root) / `packages/vscode-extension/package.json`: 1.1.1 → 1.1.2

`sites/dev/editor/execution-feedback.md`: 「診断のチェック内容は 3 種類」を 5 種類に拡張、新節 4・5 を追加

**テスト結果**: 247 passed / 23 skipped / 270 total（engine 無変更のため）

**マージ前動作確認**:
- once-per-file: tempo 重複に warning、init global.seq / LOOP は warning なし
- ordering: audio() が audioPath() より前で warning、絶対パスはスキップ
- 既存ファイル: `05_live_coding_session.orbs` で tempo 2-3 回目に warning（想定通り）

---

### 6.70 Issue #170: Rename file extension from .osc to .orbs (May 06, 2026)

**Date**: May 06, 2026
**Status**: ⏳ IN PROGRESS（マージ前動作確認待ち）
**Branch**: `170-rename-extension-to-orbs`
**Issue**: #170
**Version**: 1.1.0 → **1.1.1**

**動機**:
- OSC (Open Sound Control) との混同回避（ICMC コミュニティで衝突）
- 論文では拡張子に言及がないため、ICMC 前のいまが切り替えタイミングとして最適
- `.orbs` は orbit との語感連続性、ブランド整合、衝突小

**設計方針**: 後方互換なし（ICMC 前で外部影響限定的、清潔なコードベース優先）

**変更内容**:

ファイルリネーム (82 ファイル、`.osc` → `.orbs`):
- `examples/` (11 ファイル)
- `test-assets/scores/` (66 ファイル)
- `test-audio/` (5 ファイル)

VS Code 拡張:
- `packages/vscode-extension/package.json`: 言語登録の extensions を `.osc` → `.orbs` に変更、version 1.1.0 → 1.1.1

ソースコード（コメント、JSDoc 例、エラーメッセージ）:
- `packages/engine/src/cli-audio.ts`, `cli/execute-command.ts`, `cli/parse-arguments.ts`, `cli/play-mode.ts`
- `packages/engine/src/core/global.ts`, `core/global/audio-manager.ts`, `core/sequence.ts`
- `packages/vscode-extension/src/extension.ts`
- すべてコメント・docstring・エラーメッセージ内の `.osc` 文字列のみ。プログラム的な拡張子チェック（`.endsWith('.osc')` 等）は元から存在せず

ドキュメント:
- `sites/dev/` 6 ファイル更新
- `docs/` (active) 約 15 ファイル更新（archive は意図的に温存）
- `README.md`, `CONTRIBUTING.md`, `examples/README.md`, `test-assets/README.md`, `packages/vscode-extension/README.md`

バージョンバンプ:
- root `package.json`: 1.0.1 → 1.1.1
- `packages/vscode-extension/package.json`: 1.1.0 → 1.1.1

**RC 番号を版番に含めない理由**: VS Code Extension パネルが `1.1.0-rc3` の suffix を表示しないため、複数 .vsix を区別できない。patch を毎回上げる方式に切り替え。

**未更新（意図的）**:
- `docs/archive/WORK_LOG_*.md`: 過去の作業記録、当時の事実として保存
- `CLAUDE.md.backup`: 古い snapshot、編集対象外

**テスト結果**: 247 passed / 23 skipped / 270 total

**.vsix**: `packages/vscode-extension/orbitscore-1.1.1.vsix` (7.18 MB, 2510 files)

**マージ前動作確認**:
- [ ] `.orbs` ファイル開いて syntax highlight が効く
- [ ] `.orbs` ファイルで `Cmd+Enter` (runSelection) 動作
- [ ] `.orbs` ファイル開くと syntax highlight が効かない（プレーンテキスト扱い）
- [ ] CLI `orbitscore-audio play examples/01_getting_started.orbs` 動作

---

### 6.69 Issue #168: Eliminate environment-dependent audio file path resolution (May 06, 2026)

**Date**: May 06, 2026
**Status**: ✅ COMPLETE
**Branch**: `168-audio-path-environment-independence`
**Issue**: #168

**動機**: `audioPath()` および `audio()` のパス解決に `process.cwd()` フォールバックが残っており、開発環境依存（VS Code workspace の有無、エンジン spawn 時の cwd 等）でサイレントに誤解決される懸念があった。デモ時に「音が鳴らない」事故になりうる。

**設計方針**:
- パスは 2 種類のみを許容: 絶対パス、または `.orbs` ファイルからの相対パス
- `process.cwd()` フォールバックを完全排除 → 明示エラー
- `documentDirectory` を常に保証する仕組みを engine / VS Code 拡張 / CLI 各層に整備

**変更内容**:

Engine:
- `packages/engine/src/core/global/audio-manager.ts`: 相対パス + documentDirectory 未設定の場合に明示エラー
- `packages/engine/src/core/sequence.ts`: `audio()` で同様のエラー化
- `packages/engine/src/interpreter/process-statement.ts`: 冗長な防御的解決を削除（`_audioFilePath` は常に絶対パス前提に簡素化）
- `packages/engine/src/core/sequence/scheduling/event-scheduler.ts`: `process.cwd()` フォールバックを assertion に変更
- `packages/engine/src/core/sequence/playback/prepare-playback.ts`: 同上
- `packages/engine/src/interpreter/interpreter-v2.ts`: `execute()` に `documentDirectory` オプションを追加し、global 初期化後に自動セット
- `packages/engine/src/cli/play-mode.ts`: `.orbs` ファイルパスから documentDirectory を自動導出して execute に渡す

VS Code 拡張:
- `packages/vscode-extension/src/extension.ts`: `setDocumentDirectory` の自動注入を「global ブロック評価時のみ」から拡張。`globalInitialized` フラグでセッション状態を追跡し、init 後の任意の評価でもコード先頭に prepend するように変更（`.orbs` ファイル切り替えにも追従）

テスト:
- `tests/core/audio-path-resolution.spec.ts` 新規追加（7 テスト）: 絶対パス受理、documentDirectory 経由解決、未設定エラー、各ケースを網羅
- `tests/core/dsl-v3-underscore-methods.spec.ts`: setUp で `setDocumentDirectory('/tmp/test')` を追加
- `tests/timing/chop-timing.spec.ts`: 同上

ドキュメント:
- `sites/dev/glossary.md`: `setDocumentDirectory` エントリを新仕様に更新（注入タイミング 2 種、CLI 自動導出、フォールバック非存在を明記）
- `sites/dev/pipeline/selective-execution.md`: 注入ロジック節を書き換え
- `sites/dev/editor/execution-feedback.md`: 同上

**テスト結果**: 247 passed / 23 skipped / 270 total

**破壊的変更**: 暗黙の `cwd` 依存で動いていたコードはエラーになる。ICMC 前のため外部影響は限定的と判断。

---

### 6.68 Issue #162: Scaffold dev learning site + spike chapter 0-2 (May 05, 2026)

**Date**: May 05, 2026
**Status**: ✅ COMPLETE (Phase A 完走、Phase B は別 issue)
**Branch**: `162-scaffold-dev-learning-site`
**Issue**: #162

**Work Content**: dev 学習サイトの **Phase A**: VitePress scaffold + spike 章 (0-2 アーキテクチャ全景) を 1 PR で end-to-end。前 PR #161 で skill 導入と project brief は済、本 PR はその次段。

**目的**: skill loop (Phase 4 scaffold → Phase 5 writing → Phase 6 build → Phase 7 verify → Phase 8 advisor audit) が機能するかを 1 章で validate し、Phase B の bulk parallel writing に進む前提条件を確立する。

**新規 / 更新ファイル**:
- 新規: `sites/dev/` (VitePress project root、`type: module`)
  - `package.json` (`@orbitscore/dev-site`、deps: vitepress, vitepress-plugin-mermaid, mermaid, @vscode/markdown-it-katex, katex)
  - `.vitepress/config.ts` (Mermaid + KaTeX 設定、cleanUrls、srcExclude STYLE_GUIDE)
  - `.vitepress/sidebar.ts` (16 章の TOC export)
  - `.vitepress/theme/index.ts` (default theme re-export、Vue component の global 登録は意図的に避けた)
  - `index.md` (landing、 個人学習ノート disclaimer + status table)
  - `STYLE_GUIDE.md` (frontmatter 規約、`## Sources` 規約、`## 次の深掘り候補` 必須、shallow first pass 制約 400-800 行目安、tone)
  - `orientation/architecture-overview.md` (spike 章、status `draft`、書き手 = sub-agent / advisor audit 通過)
  - 残り 15 章 stub (frontmatter `status: stub` + 1 行説明、Phase B で本文)
- 更新: root `package.json` (workspaces に `sites/*` 追加)
- 更新: `.gitignore` (`sites/*/.vitepress/cache/`, `sites/*/.vitepress/dist/`)
- 更新: `docs/core/INDEX.md` (新 section: dev 学習サイト)

**spike 章執筆プロセス**:
1. **Phase 5 (writing)**: general-purpose sub-agent (model: sonnet) を 1 つ dispatch、`packages/engine/src/` 全体構造 + `vscode-extension/src/extension.ts` + `audio/supercollider/scsynth-resolver.ts` 等を primary source として読ませて書かせた
2. **Phase 6 (build)**: 初回 build で 3 dead link 検出 (sub-agent が stub の path を guess していた)、normalize fix
3. **Phase 8 (audit)**: advisor で audit。 1 件 Critical (「Electron renderer」 → 正確には 「Extension Host (Node.js、Renderer から fork)」) + 2 件 Minor (UDP/TCP 不一致、heartbeat → /status query) を flag、すべて修正

**学んだこと (Phase B 設計への反映)**:
- sub-agent の cross-link は **必ず stub の path を読み込ませる** prompt にする (推測しがち)
- advisor audit が conceptual error (process model 誤認) を catch できることが実証された (cross-LLM-family audit に格上げしなくても spike 段階では十分)
- shallow first pass の 1 章は 318 行で overview として機能する。Phase B の他章も同 scale を狙う

**完了条件**:
- [x] `sites/dev/` で VitePress build pass (dead link 0)
- [x] 0-2 章が `status: draft` で完成 (advisor audit critical / minor すべて適用済)
- [x] 残り 15 章が `status: stub` で存在
- [x] STYLE_GUIDE.md 完成
- [x] WORK_LOG / INDEX 更新

**未完了 (yamato 作業)**:
- 0-2 章を読み、code に戻って Sources の line range / code snippet 逐語性を verify
- mental model が更新できたら別 commit で `status: reviewed` に格上げ

**Out of Scope (別 issue)**:
- Phase B: 残り 15 章の bulk writing (Part 別 sub-agent 並列 dispatch)
- Phase C: cross-chapter polish + Glossary 統一 + 深掘り backlog 整理
- Phase D: GitHub Pages deploy (post-ICMC)

---

### 6.67 Issue #160: Install vitepress-learning-site skill (May 05, 2026)

**Date**: May 05, 2026
**Status**: ✅ COMPLETE (infra のみ、scaffold は別 PR)
**Branch**: `160-install-vitepress-learning-skill`
**Issue**: #160

**Work Content**: dev 学習サイト構築 (post-ICMC) の前段として [yuichkun/.claude](https://github.com/yuichkun/.claude/tree/main/skills/vitepress-learning-site) の `vitepress-learning-site` skill を `.claude/skills/` 配下に install。作者承諾済、verbatim copy (上流 commit `66e544d`)。本 PR は infra のみ、サイト本体の scaffold は別 issue で対応予定。

**動機**: LLM 駆動開発で生じる「実装レイヤーの理解の構造的欠落」 (仕様考案 → LLM 実装 → 動作確認、という cycle で実装中に知識が獲得されない問題) を補う仕組み。dev 学習サイトを開発サイクルに組み込むことで、code から explanation を生成 → audit → 著者が読んで編集する loop を回す。

**install 構成** (12 ファイル、verbatim):
- `.claude/skills/vitepress-learning-site/SKILL.md`
- `.claude/skills/vitepress-learning-site/references/*.md` (8 ファイル)
- `.claude/skills/vitepress-learning-site/assets/*` (3 ファイル)

**設計上の決定 (advisor 経由で確定)**:
- `.claude/skills-config/` のような新規 convention を **発明しない** (Claude Code 公式 schema との衝突リスク、discovery が指示ベース、community precedent ゼロ、bus factor 悪化の懸念)
- 代わりに **既存 pattern (project CLAUDE.md → docs/development/ への参照)** を使う
- skill overrides + project brief は [`docs/development/DEV_LEARNING_SITE.md`](DEV_LEARNING_SITE.md) に集約
- CLAUDE.md に `## 🎓 Skill: vitepress-learning-site の運用` section を追加し、skill 起動前に DEV_LEARNING_SITE.md を必ず読む指示を明記

**新規 / 更新ファイル**:
- 新規: `.claude/skills/vitepress-learning-site/` 配下 12 ファイル
- 新規: `docs/development/DEV_LEARNING_SITE.md` (project brief + skill Phase 1-8 overrides)
- 更新: `CLAUDE.md` (skill 運用 section 追加、Documentation Structure list に DEV_LEARNING_SITE エントリ追加)
- 更新: `docs/core/INDEX.md` (Development table に DEV_LEARNING_SITE エントリ追加)
- 更新: 本ファイル (エントリ追加)

**Skill overrides の主要決定** (詳細は DEV_LEARNING_SITE.md):
- audience = self (yamato 自身、実装学習)
- language = 日本語 only (start)、en は post-ICMC で検討
- primary source = own codebase
- site location = `sites/dev/`、章構造は code tree mirror
- external audit = advisor (会話 context) で代替、Codex/Gemini は precondition でない
- 各章 frontmatter に `verified-against: <commit-sha>` 必須 (doc rot を解消ではなく document する artifact framing)
- deploy = post-ICMC で GitHub Pages、initial は local-only

**Out of Scope (別 issue / 別 PR で対応)**:
- dev 学習サイト本体の scaffold (`sites/dev/` の VitePress 設定、章ファイル骨格)
- routine 設計 (PR merge 時の章更新 trigger 等、post-ICMC)
- ICMC 用 minimum user site
- 既存 docs/ から dev/user 両サイトへの段階的移行

---

### 6.66 Issue #137: Marketplace + Open VSX automated publish workflow (May 02, 2026)

**Date**: May 02, 2026
**Status**: ✅ COMPLETE (workflow file 完成、secrets 登録は user 作業)
**Branch**: `137-marketplace-publish-workflow`
**Issue**: #137 (Epic #131 Phase 1 — ICMC v1.0)

**Work Content**: PR #155 (Issue #136 scsynth bundle) マージ完了後の release 自動化。tag push (`v*`) trigger で GitHub Release / VS Code Marketplace / Open VSX に自動 publish する workflow を追加。`-rc` / `-alpha` / `-beta` suffix の prerelease tag は GitHub Release のみ自動化、Marketplace と Open VSX は stable tag のみ。

**実装**:
- `.github/workflows/release.yml` 新規作成 (macos-14 runner)
- pipeline:
  1. checkout + setup-node
  2. `brew install --cask supercollider` (bundle source)
  3. `npm ci` + `npm run build` (engine + extension)
  4. `npm run build:bundle` (scsynth 抽出)
  5. `npm run verify:bundle` (pre-package integrity gate)
  6. `npx vsce package --target $VSIX_TARGET --no-yarn` (currently `darwin-arm64`、env var で集約)
  7. `.vsix` 解凍 → verify-bundle.sh で **post-package signature 維持**確認
  8. tag で release type 判定 (stable iff `^v[0-9]+\.[0-9]+\.[0-9]+$`、それ以外は test/smoke tag も含めすべて prerelease 扱い)
  9. `gh release create` (prerelease/stable + `--generate-notes` で auto changelog)
  10. stable のみ `vsce publish` + `ovsx publish`
  11. GitHub Actions job summary に release 情報

**Security 対策**: `${{ github.ref_name }}` を直接 `run:` で展開せず `env:` 経由で shell 変数として参照 (workflow injection 緩和、参照: github.blog/security/vulnerability-research/)。

**必要 secrets** (user 作業):
- `VSCE_PAT`: VS Code Marketplace publisher token (Azure DevOps PAT)
- `OVSX_PAT`: Open VSX namespace token (Eclipse Foundation アカウント)
- **Apple Developer ID 不要** — SC project の既存 notarized signature を流用 (`docs/research/CODESIGN_PIPELINE.md` で確定)

**動作シナリオ**:
- `git tag v1.1.0 && git push origin v1.1.0` → 全 channel publish
- `git tag v1.1.0-rc4 && git push origin v1.1.0-rc4` → GitHub Release prerelease のみ
- 既存の手動 prerelease (rc1-rc3) も同パイプラインで再現可能

**後続**:
- user による secrets 登録 (`gh secret set VSCE_PAT --repo signalcompose/orbitscore` 等)
- 初回 publisher 取得 (Signal compose、Marketplace + Open VSX)
- 動作確認: 試験 tag (`v0.0.0-test1` 等) で workflow が走るか smoke

---

### 6.65 Issue #136: scsynth bundle integration in vscode-extension (May 02, 2026)

**Date**: May 02, 2026
**Status**: ✅ COMPLETE (PR pending review)
**Branch**: `136-bundle-scsynth-vscode-extension`
**Issue**: #136 (Epic #131 Phase 1 — ICMC v1.0)

**Work Content**: ICMC 2026 リリースの最大インストール障壁 (SC.app の手動 install 強要) を解消するため、scsynth + 26 plugins + libsndfile.dylib (~11.5MB) を `.vsix` に同梱、path resolver を extension/engine 共通化、bundle 不在時の first-run UX を実装。旧 #146 の (1)(2) (bundle 検出 + Notification) を統合 (CodeX レビュー承認、#146 close 済)。

**Version**: 1.0.1 → **1.1.0** (Phase 13 で minor bump、scsynth bundle 同梱は major feature)

**実装** (18 commits、各単独で `npm test` 通過):

| # | Commit | 内容 |
|---|--------|------|
| 1 | `63e298b` | feat(audio): add scsynth path resolver with multi-source fallback |
| 2 | `24a2e5c` | refactor(audio): wire SuperColliderPlayer through scsynth resolver |
| 3 | `a4bad3b` | feat(vscode-extension): add orbitscore.scsynthPath setting and pass to engine |
| 4 | `7880462` | refactor(vscode-extension): unify selectAudioDevice through scsynth resolver |
| 5 | `9663a83` | feat(vscode-extension): add bundle status bar and first-run notification |
| 6 | `aca6450` | feat(build): add scsynth bundle extract/verify scripts and legal placeholders |
| 7 | `e25894d` | docs(worklog,readme): record scsynth bundle integration |
| 8 | `1569110` | refactor(audio): drop SC.app/spotlight fallback from scsynth resolver |
| 9 | `08c2855` | refactor(vscode-extension): align UX with strict bundle requirement |
| 10 | `5f93169` | docs(worklog,readme,build-guide): document strict resolver and dev workaround |
| 11 | `98277db` | docs(platform): scope v1.0 to macOS Apple Silicon only |
| 12 | `bb94fe6` | fix(review): address claude-review feedback (libsndfile LGPL, JSDoc, DRY, dead code) |
| 13 | `58d9825` | docs(extension-readme): restructure for marketplace + bump version to 1.1.0 |
| 14 | `df3e8f7` | refactor(vscode-extension): rename killSuperCollider command to forceKillScsynth |
| 15 | `fbd033a` | fix(vscode-extension): exec→execFile in selectAudioDevice + status bar settings target |
| 16 | `e82e0ef` | fix(vscode-extension): skip engine spawn when scsynth unresolvable (avoid double error notice) |
| 17 | `2f8f4d8` | refactor(vscode-extension): reuse pre-check resolution + execFile for all killall (review minors) |
| 18 | this | docs(legal): embed GPL-3.0 verbatim + NOTICE aggregation clause (closes #139) |

**新規ファイル**:
- `packages/engine/src/audio/supercollider/scsynth-resolver.ts` (resolver 本体、strict mode)
- `tests/audio/scsynth-resolver.spec.ts` (10 unit tests、CI 実行可)
- `scripts/extract-scsynth-bundle.sh` (SC.app 自動 discovery + 26 plugin filter + 検証)
- `scripts/verify-bundle.sh` (`.vsix` 解凍後の signature/permission 確認)
- `packages/vscode-extension/legal/scsynth-LICENSE.GPL-3.0` (#139 placeholder)
- `packages/vscode-extension/legal/scsynth-NOTICE` (GPL-3.0 §6 corresponding source URL 明記)

**Path resolver 仕様** (engine 側に唯一存在、extension は `require` で再利用):
1. `opts.explicit` (caller 明示)
2. `process.env.ORBIT_SCSYNTH_PATH` (extension が settings から渡す)
3. Bundle (`<engine root>/scsynth/Contents/Resources/scsynth`)

**Strict mode の理由** (本 PR レビュー過程で確定): 当初は SC.app fallback と Spotlight も持っていたが、ICMC リリース目標 (「SC が無くても動く」) に対して fallback はテストの意味を曖昧にすると判断。bundle 抽出失敗を SC.app が肩代わりして production の不具合を隠蔽するリスクを排除するため、Phase 8 で fallback を削除。bundle が無ければ即 `ScsynthNotFoundError` で fail loud。各候補で `fs.statSync` + 実行権限ビット (`mode & 0o111`) を検査。`daemon-client.ts:417-433` の `resolveDaemonBinary()` パターン流用。

**Dev workflow への影響**:
- engine 単独 CLI (`npm run dev:engine`) で SC.app に依存していた dev は `ORBIT_SCSYNTH_PATH=/Applications/SuperCollider.app/Contents/Resources/scsynth` を env で渡す
- vscode-extension 経由 (通常 user) は build pipeline で bundle 同梱、何もしなくて OK

**First-run UX** (CodeX 指摘「status bar degraded」反映 + Phase 9 で strict mode 整合):
- StatusBar item (priority 99) で source 別に icon: `bundle` (✅) / `env`/`explicit` (⚙️ custom) / 解決失敗 (❌ error 背景)
- `startEngine()` 実行時に解決失敗 → 毎回 `showErrorMessage` (Open Settings / View Logs)
- 当初設計の "Don't Show Again" dismiss 機構は廃止 (silent fallback がない以上、Notice を黙らせる選択肢自体が不適切)

**リリース戦略** (本 PR レビュー過程で確定):
- ICMC v1.0 初回は **GitHub Release に `.vsix` を添付**して配布、ユーザは ダウンロード + ダブルクリック (or `code --install-extension`) で install
- Marketplace 自動 publish (#137) は ICMC ブロッカーから降格可能 (別 issue で再整理)

**動作環境** (v1.0): **macOS (Apple Silicon)** のみ。bundle scsynth は universal binary だが、Intel Mac は未テスト。Windows / Linux は scsynth bundle に対応 binary が同梱されないため非対応 (cross-platform は将来 issue で扱う)。Marketplace publish 時は `vsce package --target darwin-arm64` で OS gate を明示する想定。

**実機検証 (SC 3.14.1 環境)**:
- `npm run build:bundle` → 11MB bundle 生成、26 plugins、universal arm64+x86_64
- `npm run verify:bundle` → 11/11 checks pass (signature valid、TeamIdentifier=HE5VJFE9E4)
- engine test 240 pass / 23 skipped (resolver 10 新規 + 既存 230 維持、Phase 8 で sc-app/spotlight test 1 件削減)
- TypeScript build clean、ESLint clean

**スコープ外** (本 PR で実装しない):
- #137 Marketplace 自動 publish workflow (リリース戦略変更で ICMC ブロッカーから降格、別 issue で再整理予定)
- #138 cold-install acceptance test (実機 SC-less Mac で別途検証)
- #151 OrbitScore: Check Audio Setup (post-icmc)
- #152 OrbitScore: Open Examples (post-icmc)
- #156 環境変数名統一 (post-icmc、Phase 15 review feedback)

**スコープに吸収** (本 PR で完了):
- #139 LICENSE/NOTICE 文言洗練 → Phase 18 で GPL-3.0 verbatim 同梱 + NOTICE に separate works (OSC IPC) aggregation 明記 + libsndfile LGPL-2.1 区別 (Phase 12)。本 PR マージで #139 close。

**後続**:
- 本 PR マージ → #138 で SC-less Mac の cold-install 検証
- #138 通過 → 手動 GitHub Release で `.vsix` 配布開始
- ICMC 2026 リリース ready

---

### 6.64 Issue #153: pre-edit-check.sh allow plan-mode plan files (May 02, 2026)

**Date**: May 02, 2026
**Status**: ✅ COMPLETE
**Branch**: `153-hook-allow-plans-dir`
**Issue**: #153

**Work Content**: Claude Code plan mode の plan file (`.claude/plans/<name>.md`) 書込が main ブランチで `pre-edit-check.sh` にブロックされ workflow が完結しない問題を解決。Issue #136 (scsynth bundle) の plan 作成中に発見した hook 改善作業。

**実装**:
- `.claude/hooks/pre-edit-check.sh` 修正
  - stdin から `tool_input.file_path` を読み取る処理を追加 (jq 優先、python3 fallback)
  - `case` 判定で `*/.claude/plans/*` パスは早期 `exit 0` で通過
- 既存の main 編集 deny ロジックと branch 命名警告は無改修

**検証**:
- Sanity test 7 ケースすべて pass
  - feature branch + 通常 file → exit 0 (既存通り)
  - feature branch + plan file → exit 0 (新挙動、early allow)
  - 空 stdin / malformed JSON / `tool_input.file_path` 欠落 → exit 0 (graceful)
  - simulated main + plan file → exit 0 (新挙動、early allow)
  - simulated main + 通常 file → deny JSON 出力 + exit 0 (既存通り)

**後続**:
- 本 fix で plan mode workflow が main ブランチでも完結可能に
- 将来 `claude-tools` リポジトリに汎用 branch-protection plugin を作る際の参考実装

---


---

## Archived sections

Older entries have been archived by month for readability:

- [2025-09](../archive/WORK_LOG_2025-09.md)
- [2025-10](../archive/WORK_LOG_2025-10.md)
- [2026-02](../archive/WORK_LOG_2026-02.md)
- [2026-04](../archive/WORK_LOG_2026-04.md)

