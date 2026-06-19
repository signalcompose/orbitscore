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

### 6.134 docs(spec): SoT spec を 2.0.0 実態へ整合 (#237) (Jun 19, 2026)

**Date**: 2026-06-19
**Status**: ✅ 整合のみ（コード変更なし）
**Branch**: `237-doc-reconciliation-2.0.0`

post-2.0 の前提として、3観点ドリフト監査（Pitch DSL / core+LinkAudio+session-log / version+status）の結果を `docs/core/INSTRUCTION_ORBITSCORE_DSL.md` に反映（75+/34-）:
- **version**: ヘッダを「OrbitScore 2.0.0 — DSL Specification」+ `ENGINE_VERSION 2.0.0 / DSL_VERSION 1.1` 明記。
- **§12/§13**: Completed に quantize・session-log(dormant) 追加 / Not-Yet に slice(#239)・audio `[ ]` stack(#238) 追加 / 「Deferred: @v expression」は stale 削除（E5 実装済）/ テスト数を脱ハードコード。
- **構造**: 重複していた `## 8.` を解消し §9–§13 へ renumber（cross-ref も更新）。P.11/P.12 の番号順を修正。
- **core §1–§8**: §7 underscore methods を「2.0.0 未実装」明記 / §1 singleton（変数名でreuse）/ §2 key()=実装済・tick()=未 / §6 formats に aif・flac 追加・48k/24bit ハードコード削除 / §5 `global.start()` は即時 / §8.1.2 MIDI 除外(#282) + warn 毎回 / §8.1.3 fallback warn は再生時 / §8.1.4 **Live→OrbitScore tempo は未実装**（leader-push のみ #283）。
- **VOLATILE（post-2.0 redesign pending）**: P.1/P.5 root/key/scale に注記 + `POST_2.0_PITCH_MODEL_NOTES.md` ポインタ。P.5 の `seq.root(C)` 誤例を `seq.root(1)`+「seq は数値のみ・#280」へ。`seq.mode()` は group のみと訂正。P.4 mode period=highest element、`.r`=per-slot を明記。

### 6.133 chore: @claude bot レビューの low 指摘対応 + 初回ノート遅延を #285 で追跡 (Jun 19, 2026)

**Date**: 2026-06-19
**Status**: ✅ build 緑 / 1129 passed | 23 skipped
**Branch**: `279-qa-2.0.0-matrix-smoke-examples`

PR #281 の `@claude` bot レビュー（結論「マージブロッカー無し・round-1/2 fix を追認」）の非ブロッカー指摘に対応:
- `packages/engine/supercollider/setup.scd`: 末尾改行追加（cosmetic・複数回指摘）
- `scripts/qa-midi-smoke.sh`: `perl -e "sleep ${DWELL}"` → `perl -e 'sleep $ARGV[0]' -- "${DWELL}"`（env 値が perl コードとして展開されるのを回避）
- **[Medium] 初回ノート最大2秒ブロック**（plugin-present の lazy probe・`timeoutMs=2000`）は **#285 で post-release 追跡**（2.0.0 ブロッカーではない。plugin-absent は boot 配線済みで回避済み）。

### 6.132 chore(deps): npm audit fix — resolve shipped `ws` (high) before 2.0.0 (Jun 19, 2026)

**Date**: 2026-06-19
**Status**: ✅ build 緑 / 1129 passed | 23 skipped
**Branch**: `279-qa-2.0.0-matrix-smoke-examples`

2.0.0 リリース前の dependabot 対応。**.vsix に出荷される production 依存**を切り分けて非破壊修正:
- `npm audit fix`（semver 互換のみ・`package-lock.json` のみ変更）で production の **`ws`(high: memory disclosure / DoS)** 等を解消。
- 修正後の production audit: **6 moderate のみ**（すべて supercolliderjs(alpha) の transitive。非破壊では直せず upstream 待ち。攻撃面は localhost scsynth 接続のみで実リスク低）。**出荷物の high/critical は 0**。
- 残る critical 1 / high は **devDependency（vitest/eslint/build 等・.vsix 非同梱）**。`--force`（破壊的）を要しリリース toolchain を不安定化させ得るため post-release / dependabot PR で追跡（2.0.0 はブロックしない）。

### 6.131 release(2.0.0): drop -dev, finalize 2.0.0 — last feature .vsix (Jun 19, 2026)

**Date**: 2026-06-19
**Status**: ✅ build 緑 / 1129 passed | 23 skipped / simplify + pr-review-team(Critical=0/Important=0) + security PASS
**Branch**: `279-qa-2.0.0-matrix-smoke-examples`

`2.0.0-dev` → `2.0.0` に確定。v1.1.1 以降の新ピラー（MIDI 出力 / Pitch DSL / comp / session-log / LinkAudio）を束ねた**最後の機能 .vsix リリース**（post-2.0 は専用アプリ OrbitStudio へ移行。`docs/development/POST_2.0_ROADMAP_NOTES.md`）:
- `packages/engine/src/version.ts`: `ENGINE_VERSION` `2.0.0-dev` → `2.0.0`
- `packages/vscode-extension/package.json`: version `2.0.0-dev` → `2.0.0`（= .vsix 版）
- 配布は **GitHub Release のみ**（marketplace は後日・#197 PAT 未登録）。merge 後に tag + Release。
- session-log は dormant（既定 off・#229 redesign は post-2.0）/ #280（`seq.root(note-name)`）は known issue（post-2.0 の root 後置一本化で解消予定）。
- 残 QA（実音 H 項目・学習サイト walkthrough）は OrbitStudio へ defer（Epic #278 disposition）。

### 6.130 fix(link-audio): pr-review-team round 2 — clear in-flight probe map on stopAll + log best-effort catches (Jun 19, 2026)

**Date**: 2026-06-19
**Status**: ✅ build 緑 / 1129 passed | 23 skipped
**Branch**: `279-qa-2.0.0-matrix-smoke-examples`

round-2 再レビュー（code-reviewer + silent-failure-hunter）で round-1 の Critical/Important が全解消と確認。round-1 の並行ガード fix が導入した新規 Important 1 件 + minor を修正:
- **Important**: `stopAll()` で `resolvingChannel`（in-flight probe memo）が未クリア → stop-then-play の狭いレースで stale 結果共有 → `this.resolvingChannel.clear()` 追加。
- minor: `stopAll()` で `warnedAboutMissingPlugin=false` リセット（次セッションで plugin 不在 warn 復活）/ `setLinkTempo` の空 catch → warn（global.ts の round-1 fix がこの層で握り潰されていた）/ `ensureLinkAudioChannelRegistered` の空 catch → warn（防御的）。

→ pr-review-team は **Critical=0 / Important=0** に収束（round 1 fix → round 2 verify → round 2 新規 Important を本コミットで修正）。

### 6.129 test(link-audio): pr-review-team round 1 — close test-coverage gaps (Jun 19, 2026)

**Date**: 2026-06-19
**Status**: ✅ 1129 passed | 23 skipped（+18 tests・regression 0）
**Branch**: `279-qa-2.0.0-matrix-smoke-examples`

pr-test-analyzer の Critical/Important カバレッジギャップを補完:
- TA1 `OSCClient.registerLinkAudioChannel`: /done→true / timeout→false / transport error→rethrow（`tests/audio/osc-client-register.spec.ts`）
- TA2 `loadLinkAudioSynthDef`: file 不在→false/送信0 / 両在→`/d_recv` 2回順序 / keepalive 欠如→1回+warn（`tests/audio/synthdef-loader.spec.ts`）
- TA3 session-log gate: `shouldEnableSessionLog()` を `cli/session-log-gate.ts` に抽出（play/repl から使用・挙動不変）+ 全分岐 test（`tests/cli/session-log-gate.spec.ts`）
- TA4 `output()→registerLinkAudioChannel` 配線（`sequence-output.spec.ts` の mock + assert）
- TA5 `resolveLinkAudioChannel` が transport error で throw せず hardware fallback（`link-audio-dispatch.spec.ts`）
- TA6 `boot()` が load 失敗時に `setLinkAudioPluginAvailable(false)` + warn（`supercollider-player-boot.spec.ts`）

### 6.128 fix(link-audio): pr-review-team round 1 — correctness/robustness fixes (Jun 19, 2026)

**Date**: 2026-06-19
**Status**: ✅ build 緑 / 1111 tests passed / C++ cmake compile 検証済
**Branch**: `279-qa-2.0.0-matrix-smoke-examples`

`/code:pr-review-team`（code-reviewer/silent-failure-hunter/pr-test-analyzer/comment-analyzer）の Critical/Important を修正（テスト追加は別コミット）:
- **Critical**: `orbit_link_audio_out.cpp` の `g_beatAnchorSet`/`g_anchorBufCounter`/`g_anchorMicros` を `PluginLoad` でリセット（scsynth プロセス内再起動時の符号付きアンダーフロー → beat 破綻を防止）。
- **Important**:
  - `event-scheduler.stopAll()`: `linkAudioPluginAvailable=null` リセット（次セッション再 probe）。
  - `supercollider-player.boot()`: `loadLinkAudioSynthDef()` 戻り値を `setLinkAudioPluginAvailable(false)` に配線（plugin 不在時の 2000ms lazy timeout 解消）。
  - `event-scheduler.resolveLinkAudioChannel()`: per-channel 並行ガード（in-flight memo）+ 2本目以降の登録 boolean 捕捉（timeout は warn + fallback）。
  - `osc-client.registerLinkAudioChannel()`: catch を timeout（`false` latch）と transport error（rethrow → `null` 維持で再 probe）に分離。
  - `synthdef-loader`: keepalive `.scsyndef` 欠如時の warn。
  - `event-scheduler.stopAll()`: `void freeNode` → `.catch`+warn。
  - `global.pushLinkTempoIfLeading`: 空 `.catch(()=>{})` → warn。
  - stale コメント（"boot pipeline が flip" 系）を実態（null=未 probe / boot は load-fail 時のみ false / lazy probe が true）に修正。

### 6.127 refactor(engine): /simplify pass の挙動不変クリーンアップを適用 (Jun 19, 2026)

**Date**: 2026-06-19
**Status**: ✅ build 緑 / 1111 tests passed
**Branch**: `279-qa-2.0.0-matrix-smoke-examples`

2.0.0 finalize 前の `/simplify`（4 agent: reuse/simplification/efficiency/altitude）の**挙動不変な品質 fix のみ**を適用:
- `diagnostics-analysis.ts`: `.output()` と `.midi()` の重複スキャン2パスを**単一パス**に統合（keystroke ごとの hot-path コスト削減・分類結果は不変）。3 agent 一致指摘。
- `synthdef-loader.ts`: 4箇所の inline `setTimeout` を private `sleep(ms)` に抽出（delay 値据え置き）。

**skip（simplify スコープ外＝挙動変更/correctness → pr-review-team へ回送）**:
- altitude #1: `g_beatAnchorSet`(C++) が scsynth 再起動で未リセット → 負オフセットの恐れ。
- altitude #2: `stopAll()` で `linkAudioPluginAvailable` 未クリア（セッション跨ぎの stale state）。
- altitude #4: boot の `loadLinkAudioSynthDef()` 戻り値未配線 → plugin 不在時に初回 dispatch で 2000ms timeout。
- C: event-scheduler の冗長 `has()` ガード（agent 間で見解割れ・リスク回避で保留）。
- D: `removeEffect` の `/n_free` 直送 → 新 `freeNode()` 置換（diff 外の既存行のため保留）。

### 6.126 docs(post-2.0): engine/pitch/song/distribution 方向 + Rust hosting research を記録 (Jun 19, 2026)

**Date**: 2026-06-19
**Status**: ✅ 記録のみ（実装なし・探索段階/未確定・post-2.0）
**Branch**: `279-qa-2.0.0-matrix-smoke-examples`

**内容**: 2.0.0 以降の方向性を大和さんと議論し durable 化（WCTM とは別トラック）。
- `docs/development/POST_2.0_ROADMAP_NOTES.md` — engine-first / 全体方向 / features deferred / session-log redesign 北極星。
- `docs/development/POST_2.0_PITCH_MODEL_NOTES.md` — root/key/scale + song(arrange) 層の再設計（root=後置一本化〔絶対=音名/相対=大文字ローマ〕, key=2軸カスケード頂点, conductor 等）。
- `docs/development/POST_2.0_ENGINE_AND_DISTRIBUTION.md` — engine=Rust(既存 `rust/`) 方向 / 薄いホスト+DSPプラグイン / Fair Trade 内部基盤 / freemium⟺permissive / 層構造 monetization / Steam+notarize 配布 / OrbitScore=言語・OrbitStudio=アプリ。
- `docs/research/NATIVE_ENGINE_TRACKTION_VSCODIUM.md`（結論は ENGINE_AND_DISTRIBUTION が更新）/ `docs/research/RUST_PLUGIN_HOSTING.md` — Rust 3rd-party ホスティング feasibility（CLAP>AU>VST3・VST3 は SDK 3.8 で MIT 単独化・engine=Rust 確定方向、残る証明は CLAP 統合スパイク+RT 統合設計）。

### 6.125 fix(session-log): make .orbslog dormant (opt-in) for 2.0.0 finalize (Jun 19, 2026)

**Date**: 2026-06-19
**Status**: ✅ build 緑 / session-log ユニット 26 件緑
**Branch**: `279-qa-2.0.0-matrix-smoke-examples`

**背景**: 6/18 ライブで `.orbslog` が生成されない / LinkAudio 送出トラックが記録されない不具合。原因は現行が **file-scoped**（`<basename>.<stamp>.orbslog`）で、複数ファイルをまたぐ1セッションに合わない**設計ミスマッチ**。finalize 中にパッチせず dormant 化し、redesign（session-scoped・全トラック捕捉・L2 replay #241/分析 #242 対応）は post-2.0 へ（`POST_2.0_ROADMAP_NOTES.md`）。

**変更**:
- `cli/play-mode.ts` / `cli/repl-mode.ts` の `enableSessionLog()` を **`ORBITSCORE_SESSION_LOG=1` の opt-in 裏に退避**（既定 off・既存 `ORBITSCORE_DEBUG` と prefix 整合）。
- writer (`core/session-log/`) / API / 26 ユニットは**保持**（resurrect 可）。

### 6.124 feat(link-audio): OrbitScore を Link テンポリーダーに (#283) (Jun 18, 2026)

**Date**: 2026-06-18
**Status**: ✅ 実装・テスト済（実機受け入れは大和さん: `global.tempo(72)` eval → Ableton BPM 追従を目視）
**Branch**: `279-qa-2.0.0-matrix-smoke-examples`

**要望（大和）**: `global.tempo()` を設定すると Ableton が追従してほしい = OrbitScore を Link テンポリーダーに。

**設計（advisor 承認・「軽い方の道」）**: plugin が tempo を push する → `global.tempo == Link tempo`
が構造的に保証 → MIDI(global.tempo 自走) と Audio(Link beat) が**自動で揃う**。scheduler を
Link beat 駆動に作り変える必要がない（その逆方向 follower 強化の方が重い）。

**実装**:
- C++ `ChannelRegistry::setLinkTempo(bpm)`: app スレッドの `captureAppSessionState()` →
  `setTempo(bpm, clock().micros())` → `commitAppSessionState()`。audio スレッドの
  `captureAudioSessionState` と並行安全（Link の app/audio session-state 分離の正規用法）。
- C++ `/cmd /orbit/setLinkTempo <bpm>` ハンドラ（同期・/done 不要、bpm を 20..999 で検証、
  `getf` が int/float 両対応）。PluginLoad で登録。
- engine: `OSCClient.setLinkTempo` → `EventScheduler.setLinkTempo` → `SuperColliderPlayer.setLinkTempo`、
  `AudioEngine.setLinkTempo?`、`Global.pushLinkTempoIfLeading()` を tempo()/linkAudio()/start() から呼ぶ
  （ファイル順 tempo→linkAudio を吸収するため3点）。

**制約（重要・本番ルール）**: Link は last-setter-wins。OrbitScore が唯一のテンポ設定者である間だけ
MIDI/Audio が揃う。**Live 側でテンポを動かすと Link tempo が global.tempo と乖離し MIDI がドリフト**
（scheduler は Link に追従しない）。本番は「テンポは OrbitScore のコードで設定、Live のテンポは触らない」。

**検証**: unit（global.tempo→setLinkTempo 送信 / linkAudio off は非送信 / ファイル順吸収 /
start 再アサート / 任意能力欠如で throw なし、EventScheduler 委譲）。全 1111 passed（+7）。
.scx に `/orbit/setLinkTempo` シンボル + vsix 同梱を確認。**実機受け入れ（Ableton BPM 追従の目視）は大和さん**。

**Commit**: fdbfc10

### 6.123 fix(link-audio): MIDI シーケンスを LinkAudio strict-mode から除外 (#282) (Jun 18, 2026)

**Date**: 2026-06-18
**Status**: ✅ 修正・テスト済（実機再テストは大和さん）
**Branch**: `279-qa-2.0.0-matrix-smoke-examples`

**発見**: IAC(MIDI) + LinkAudio(Audio) 共存サンプル（examples/19）の MIDI 部分を
`LOOP(piano, inner, bass)` した時点で runtime error:
`Sequence 'piano' has no .output() channel set, but global.linkAudio() is enabled.`

**原因**: `Sequence.run()`(sequence.ts:1205) と `loop()`(1249) が `resolveDispatchChannel()`
を **`isMidi()` ガード無しで** eager 呼び出し。schedule 経路(1115/1185)は MIDI で早期
return するが eager validation は通らず、LinkAudio strict-mode の「`.output()` 必須」が
MIDI シーケンスにも誤適用されていた。VS Code 診断 `analyzeLinkAudioMissingOutput` にも同型バグ。

**仕様（共存は正本で支持済み・spec 変更不要）**:
- DESIGN_DISCUSSION_RECORD #14「MIDI と SC オーディオは併走可 / 排他にする技術的理由がない」
- IMPLEMENTATION_INSTRUCTIONS「MIDI に LinkAudio 型の排他は適用しない」
- core spec §8.1.2「全ての**発音** sequence が `.output()`」← 発音=オーディオ限定

**修正**:
1. engine `resolveDispatchChannel()` 冒頭に `if (this.isMidi()) return undefined`（全4呼出点を一括で MIDI 安全化）。
2. vscode-extension `analyzeLinkAudioMissingOutput` で `.midi(` を持つ名前を orphan から除外。

**検証**: ユーザーの throw を正確に再現する unit test（MIDI+linkAudio+no output →
`resolveDispatchChannel()` が undefined / audio は throw 継続）+ 診断テスト（MIDI 非 flag /
混在ファイルで audio のみ flag）。全 1104 passed（+5）。engine dist と extension dist
（vsix 同梱）の両方に反映を確認。

**Commit**: 5dc2975

### 6.122 fix(link-audio): 連続ストリーム化 — per-channel keepalive committer (#209) (Jun 17, 2026)

**Date**: 2026-06-17
**Status**: ✅ 実装・wiring 検証済 + **実機 Live で正常再生を確認（2026-06-17 大和さん）**
**Branch**: `279-qa-2.0.0-matrix-smoke-examples`

**ユーザー診断（正しい）**: latency を 100ms→2.0s に上げると「レベル一定だがブツ切り」。LinkAudio は連続オーディオストリームなのにブツ切り＝**送信ストリームに穴**。「送り方が間違っている」。

**根本**: `orbitPlayBufLink` は transient（doneAction:2）で、サンプルが鳴っている間しか commit しない。疎なパターン（0.5s hit / 1.5s gap）だと**ストリームに穴** → 受信側が underrun（低 latency でドリフト）or 穴を再生（高 latency でブツ切り）。実測でも送信側の beat は単調・音は無傷・ドロップ無しだったので、原因は「穴」だと確定。

**修正（2点で根治）**:
1. **サンプル精度ビート**（commit efec707, 6.121内）: beat 位置を壁時計でなくグローバルアンカー+サンプル数で算出 → 配置を単調正確化（dBeat=0.002666 一定を実測確認）。
2. **per-channel keepalive committer**: `orbitLinkAudioKeepalive` SynthDef（`OrbitLinkAudioOut(DC.ar(0),DC.ar(0),ch)` で無音を毎ブロック commit）を追加。engine がチャンネル登録時に1つ常駐起動（node=800000+ch、stopAll で n_free）。これでストリームが途切れず、サンプル synth は plugin の per-channel mix にビートを合わせて加算。

**検証**: cli-audio(supercolliderjs 経路)+bundled scsynth で keepalive ロード + 3 チャンネル分の s_new + エラー無しを確認。ユニット 1099 passed（keepalive 起動/once-per-channel/stopAll free の3テスト追加）。計測 Print は除去済。**実機 Live 再生で正常を確認（2026-06-17）** — 最大リスクの「Ableton ミキサー/FX を通す LinkAudio 経路」が機能。

**Commit**: e693d6e（keepalive） / efec707（サンプル精度ビート）

### 6.121 fix(link-audio): blockSize=512 緩和を試行 → **revert**（ドリフト未解決） (Jun 17, 2026)

**Date**: 2026-06-17
**Status**: ⛔ revert 済（緩和にならず、全 synth に 10ms 量子化を足す副作用のみ）
**続報**: probe ハーネス（system scsynth, 単一ch）では一見安定したが、**拡張の実使用（bundled scsynth, 単一キック loop）では blockSize=512 でもドリフト**。さらに supercolliderjs は数値 blockSize を弾く（要文字列 '512'、commit 576278e で対処）が、根治せず。advisor 助言で **-z を既知良好の 64 に revert**（hardware 経路はフルレベル・安定・tempo 同期で正常＝ドリフトは LinkAudio commit 側で確定）。
**切り分け結論**: hardware(orbitPlayBuf) はクリーン。LinkAudio(orbitPlayBufLink) の **commit timing（beat を壁時計から取得）が quiet+drift の根本**。正しい修正は beat 位置をサンプル精度で出す UGen 改修（深夜の本番直前 RT 改修は不可 → post-show issue）。kick が raw と違って聞こえた件はファイル同形式（mono/48k/F32）でモニタ（MacBook スピーカーの低域不足）由来の可能性大。
**Branch**: `279-qa-2.0.0-matrix-smoke-examples`

**症状**: LinkAudio で時間とともにレベルがドリフト（snare 膨らむ/kick 痩せて消える、単一チャンネルでも loud→inaudible）。Live 設定・SR・バッファドロップではない。

**根本**: プラグインは各ブロックの Link ビート位置を `beatAtTime(clock().micros())`（next() 実行時の壁時計）から取る。scsynth はハードウェアバッファ(512)ごとに `-z`(=既定64) ブロックを**バースト処理**するため、バースト内の複数ブロックがほぼ同一壁時計＝同一ビートにコミットされ、Live の per-source レート補正が反応してレベルが暴れる/ドリフトする（advisor 確認）。

**緩和（低リスク・RT 音声コード不変更）**: scsynth の `-z` を 512 に（`osc-client.ts` boot に `blockSize: 512`）。バッファ=512 と 1:1 になりバースト解消。probe（`verify-sample-playback.scd` に `s.options.blockSize=512`）の単一チャンネルで 60s レベル安定を確認。
- トレードオフ: synth onset timing が ~10.7ms 量子化。Link は元々 100ms 遅延なので本番は許容。
- **本丸（post-show）**: ビート位置をサンプル精度（frame counter）で出す UGen 修正で -z=64 のまま levels 安定 + tight timing。要 issue 化。

**Commit**: [PENDING-121]

### 6.120 feat(link-audio): `.output()` 評価時に channel を即登録（本番の事前ルーティング用） (Jun 17, 2026)

**Date**: 2026-06-17
**Status**: ✅ 実装・テスト済（1096 passed）
**Branch**: `279-qa-2.0.0-matrix-smoke-examples`

**要望（ユーザー）**: LinkAudio の channel が **再生時（初回 dispatch）にしか Live に出ない**ため、本番前に Ableton 側のトラック入力をセットできない。`snare.output("snare")` を**評価した時点**で Live の Link Audio ソースに出てほしい。

**変更**:
- `AudioEngine` に optional `registerLinkAudioChannel(name)` を追加（types.ts）。
- `EventScheduler`: 遅延登録ロジックを `resolveLinkAudioChannel(name)` に共通化し、dispatch 経路と eager 経路で共有。eager 用の public `ensureLinkAudioChannelRegistered(name)`（未 boot なら no-op、best-effort）を追加。
- `SuperColliderPlayer.registerLinkAudioChannel(name)` → scheduler に委譲。
- `Sequence.output(name)`: linkAudio 有効時に `audioEngine.registerLinkAudioChannel(name)` を fire-and-forget で即呼ぶ。dispatch 時の登録は idempotent フォールバックとして維持（`registeredChannels` set で二重登録防止）。

**結果**: `.output("name")` 評価で Live に "OrbitScore"/name ソースが即出現 → 本番前ルーティング可能。テスト +3（eager 登録/idempotent/未 boot no-op）。vsix 再パッケージ・再インストール済。

**Commit**: [PENDING-120]

### 6.119 fix: 拡張同梱 engine deps に @julusian/midi 等が欠落（VS Code でエンジン起動不可） (Jun 17, 2026)

**Date**: 2026-06-17
**Status**: ✅ 修正・実物検証済
**Branch**: `279-qa-2.0.0-matrix-smoke-examples`

**症状**: インストールした `2.0.0-dev` 拡張でエンジン起動 → `Error: Cannot find module '@julusian/midi'` でクラッシュ（`rtmidi-output.js` 起点）。

**原因**: `scripts/install-engine-deps.sh` が同梱 engine に **`supercolliderjs` + `wavefile` の2つしか**インストールしていなかった。v1.1 で MIDI 用に増えた `@julusian/midi` / `uuid` / `ws` が同期されず、拡張だけが欠落していた。ソースツリー実行（root node_modules に全部ある）では再現せず見逃していた（＝実 artifact での検証不足）。

**修正**: `install-engine-deps.sh` を **engine の package.json から production deps を自動導出**する方式に変更（将来また欠ける事故を防止）。再ビルド → `@julusian/midi`（arm64 prebuild 同梱）/`uuid`/`ws` が bundle に入ることを確認 → vsix 再パッケージ → 再インストール → **インストール済み実物の cli-audio.js が module 解決して起動することを確認**。

**副次（オーディオデバイス検出 "Regex matches: 0"）**: 検出は別 scsynth を `-u 57199` で起動してデバイスを開くため、**クラッシュ残骸 scsynth がデバイスを掴んでいると失敗**していた。残骸を掃除して拡張同一ロジックを再現すると 4 デバイス正常検出。→ エンジン正常起動（本修正）で解消。**注意: エンジン稼働中はデバイス検出が競合する**ため、デバイス選択はエンジン停止中に行う。手動設定は `<workspace>/.orbitscore.json` の `audioDevice`。

**Commit**: [PENDING-119]

### 6.118 #209 LinkAudio engine routing — orbitPlayBufLink + boot配線 + channel登録 (Jun 17, 2026)

**Date**: 2026-06-17
**Status**: ✅ 実装完了 + **実機 Ableton で実音確認済**（2026-06-17 夜）
**Issue**: signalcompose/orbitscore#209（Epic #187 Step 4-2 / Epic #278 §4b）
**Branch**: `279-qa-2.0.0-matrix-smoke-examples`（明日のライブ向け緊急対応のため QA ブランチに同梱。後で分割可）

**背景**: 当初 #209 は「SC ツールチェーンが無いので不可」と判断していたが、これは**誤り**だった。実機（このMac）に SuperCollider + OrbitLinkAudio plugin が導入済で、`verify-plugin.scd` が全項目 pass。明日のライブで §4b（実 `.orbs` → Link Audio → Ableton）が必須のため緊急実装。

**実装（4つの欠け配線を補完）**:
1. **`orbitPlayBufLink` SynthDef**（`setup.scd`）: orbitPlayBuf の再生/エンベロープを流用し、出力のみ `Out.ar` → `OrbitLinkAudioOut(L,R,channel)` に差し替え。引数は engine dispatch と一致（bufnum/amp/pan/rate/startPos/duration/channel）。plugin 有無で `if(\OrbitLinkAudioOut.asClass.notNil)` ガード。`sclang setup.scd` で `orbitPlayBufLink.scsyndef` 生成。
2. **setup.scd の出力パス修正**: 旧 `proj_livecoding` ハードコードを `~synthdefDir`（nowExecutingPath 基準の相対）に。
3. **boot 配線**（`supercollider-player.ts` + `synthdef-loader.ts`）: `loadLinkAudioSynthDef()` で link SynthDef を best-effort ロード。
4. **遅延検出 + channel 登録**（`event-scheduler.ts` + `osc-client.ts`）: 初回 link dispatch で `/cmd /orbit/registerLinkAudioChannel` を送り `/done` で plugin 存在を検出（タイムアウト=不在→hardware fallback）。channel ごとに1回だけ登録（`registeredChannels` set）。`linkAudioPluginAvailable` を tri-state（null=未検出）に。stopAll で登録もクリア。

**5. 🔴 プラグイン修正（実音が出なかった根本原因, channel_registry.cpp）**:
- 実機 Ableton で "OrbitScore" ピアが **発見されない**問題を調査 → scsynth が Link 発見ポート(20808)を一切開いていないと判明。
- 原因: `initLinkAudio` が `enableLinkAudio(true)`（音声共有層）は呼ぶが、**基底 Link のネットワーク発見 `enable(true)` を呼んでいなかった**。LinkAudio は Link を継承するが両者は別スイッチ。
- 修正: `initLinkAudio` に `impl_->link->enable(true);` を追加 → プラグイン再ビルド(cmake, ad-hoc署名) → Extensions に再導入。scsynth が `*:20808` を開き、Live に "OrbitScore" ピアが出現、トラック接続で **実音が鳴ることを実機確認**。
- 副次: 切り分け中に Tailscale(utun/100.64.x CGNAT)が Link のインターフェース選択を乱す可能性も確認（ユーザーが一時オフ）。最終的な決め手は enable(true)。

**検証**:
- `verify-sample-playback.scd`（新規, Ctrl+C まで連続再生）: 実 wav → orbitPlayBufLink → channel 'test'。修正後、Live で **ピア出現 + 実音確認済**。
- 実エンジン E2E: `node dist/cli-audio.js play examples/10_link_audio.orbs`（ORBIT_SCSYNTH_PATH=システムscsynth）で plugin検出→channel登録→link経路dispatch を確認。
- ユニット: 1093 passed（link 登録1回・lazy 検出 true/false の3テスト追加）/ build 緑。

**残**: 修正版 `.scx` を vsix の bundled scsynth にも反映して本番 artifact 更新。本番が source経路かvsix経路かで使う scsynth が変わる点に注意。

**Commit**: [PENDING-209]

### 6.117 Epic #278 Phase A+B — 2.0.0-dev QA マトリクス + MIDI example + スモーク (Jun 17, 2026)

**Date**: 2026-06-17
**Status**: ✅ 実装完了（QA / docs / examples）
**Issue**: signalcompose/orbitscore#279（Epic #278 の Phase A+B = PR ①）
**Branch**: `279-qa-2.0.0-matrix-smoke-examples`（main から）

**概要**: v1.1.1 → 2.0.0-dev で積まれた新ピラー（MIDI 出力 / Pitch DSL E1–E6・Phase 3·4·R / comp C1·C2a / session-log L1 / LinkAudio）の実機 E2E QA 基盤を整備。プログラム的に検証可能な範囲を確定し、人間 QA に渡す境界を明示。

**Phase 0（ブランチ衛生）**:
- `wctm-architecture-docs` の `.gitignore`（`docs/WCTM/` scratch ignore）をローカルコミットで park（d908687）。QA 子ブランチは main から切る。
- ベースライン検証: `npm test` → **1090 passed | 23 skipped (1113)** / `npm run build` 成功（main @ b4b513d）。

**Phase A（QA マトリクス）**:
- `docs/testing/QA_2.0.0.md` を新規作成。全インベントリを **P（プログラム検証可）/ H（人間・実機のみ）** に分類、各行に確認手段・期待結果・spec 参照・状態。人間 QA チェックリスト（Phase C 学習サイトへ取り込む）も収録。

**Phase B（example + スモーク + session-log 検証）**:
- 新 MIDI example 8 件を作成: `examples/11_midi_degrees`〜`18_voicelead_comp.orbs`（degree→MIDI / chords·stacks / scope·mode / ties·legato·hold / repetition·sections / expression / voicing·random / voicelead·comp）。
- スモークランナー `scripts/qa-midi-smoke.sh` を作成（`midi-run` に通し `→ IAC` 到達＋engine error 無しを判定。macOS に `timeout` が無いため background + perl sleep + SIGINT 方式）。**8 passed, 0 failed**。
- session-log `.orbslog` の内容・原子性を実ファイル probe + 既存 13 ユニットで確認（inert→atomic create→meta→preamble→評価レコード triple stamp→stop）。
- 回帰ガード: `npm test` 再実行 → 1090 passed 維持。

**QA Finding（記録済 / 要子 Issue 化）**:
- **FINDING-1**: `seq.root(<note-name>)`（例 `lead.root(C)`）が runtime で拒否される（"root() degree must be a positive integer"）。グループレベル note root（`(1,3,5).root(F)`）は動作。spec P.5 は `seq.root(C)` を有効と記載 → spec/実装の乖離。example 13 は数値 seq root + group note root で回避。子 Issue **#280** 起票済。

**PR レビュー反映（`/code:pr-review-team`、4 エージェント並列）**:
- **Critical（silent-failure-hunter）**: スモークの失敗トークン denylist が不完全で、部分破損（健全 seq + 壊れ seq の混在）を PASS で握り潰す穴。インタプリタの silent-error 文字列（`Method not found:` / `do not exist and will be ignored` / `Variable not found:` 等）を ENGINE_FAIL に追加。
- **Important**: マルチ seq のスケジュール数を期待数と照合（silent ドロップ検出）/ `loop started` を SCHEDULED に追加。
- **Minor（code-reviewer）**: `midi-run` を npm 経由でなく ts-node 直接起動（SIGINT がグレースフル shutdown に届き、孤児 node / 鳴りっぱなし MIDI を残さない）/ 空 FILES 配列の bash 3.2 ガード / `printf %s` を `[@]` に / 死んだ `✗` トークン除去。
- **comment-analyzer / pr-test-analyzer**: example 13/17 の Expected コメント訂正、README ファイル一覧に 11–18 追記、QA マトリクスの test 引用 3 件を正確化。
- 検証: ネガティブテスト2種（`global.start()` 欠落、RUN が存在しない seq）で FAIL を確認。直接 ts-node 化後の孤児プロセス 0 を確認。全8スモーク PASS 維持。

**人間 QA ランブック**: `docs/testing/QA_2.0.0_HUMAN_RUNBOOK.md` を追加（ユーザー依頼）。実機・実音 QA の step-by-step（IAC/monitor/DAW セットアップ → example 11-18 の実音確認 → session-log → LinkAudio verify-live-receive → リリースまでの残タスク）。コマンド・期待・記録欄つき。§1（MIDI 実音）は #209 不要で着手可能、§4b のみ #209 後。

**人間ゲート（このセッションでは到達不能）**: 実音 QA・LinkAudio Ableton E2E・`.scx` Gatekeeper（#210）・#209 実装・PR マージ。2.0.0 リリースはこれら完了後。

**Commit**: `3fe2185`（初回）/ レビュー反映は追加コミット

### 6.116 Issue #276 — session log L1 polish（PR #275 bot レビュー反映） (Jun 15, 2026)

**Date**: 2026-06-15
**Status**: ✅ 実装完了（chore）
**Issue**: signalcompose/orbitscore#276 / 親 #229（#275 マージ後の follow-up）
**Branch**: `276-session-log-l1-polish`

**概要**: PR #275（L1）マージ後の claude bot レビューの軽微指摘のうち v1 ハードニング2点を反映。Critical/Important なし。

**対応（v1）**:
- **衝突ループの TOCTOU 解消**: `fs.writeFileSync(candidate, meta, { flag: 'wx' })`（原子的排他作成）に置換。`existsSync`→`write` の隙間競合を排し、ループも簡潔化（EEXIST→次候補、他の I/O エラーは disabled で best-effort 維持）。並列 REPL でも既存ログを無音上書きしない。
- **単一 GLOBAL 前提を明記**: `sessionHooksInstalled` は最初の GLOBAL のみフックする旨を SESSION_LOG_SPEC §3.1 + コードコメントに明記。

**バージョン整合（大和さん確定 2026-06-15）**: v1.1.1 以降 175 コミットで MIDI 出力（新ピラー）+ Pitch DSL + comp + session log が積まれた。すべて追加的（破壊なし）で厳密 semver では 1.2.0 だが、MIDI という新ピラー + 録音の世代交代として **WCTM マイルストーンを 2.0.0 とする**（製品ポジショニング判断）。`version.ts` の `ENGINE_VERSION` を `2.0.0-dev` に整合（`.orbslog` meta の engineVersion）。`DSL_VERSION` は別軸なので `1.1` 維持。package.json 群の bump + タグはリリース時に実施（現状 root 1.1.0 / engine 0.0.1 のドリフトはリリースで解消）。

**deferred（v2 と判断、§7 Future Directions に記録）**:
- preamble 無上限（素朴な oldest 破棄は init 行を失い因果記録を壊す → 正しい上限設計は v2）
- version.ts の package.json からの**自動同期**（monorepo + dist layout で動的読みが脆い → ビルド時注入/リリーススクリプトの領域。値の整合自体は上記で実施済）

**テスト**: 既存ファイルを上書きしない wx 原子性テストを追加（+1）。session-log 26件、全体 1090 passed / 23 skipped。

### 6.115 Issue #229 — session log writer `.orbslog`（Phase 1-L1） (Jun 15, 2026)

**Date**: 2026-06-15
**Status**: ✅ 実装完了（L1。/simplify + /code:pr-review-team 予定）
**Issue**: signalcompose/orbitscore#229 / 親 Epic #224 / 正本 SESSION_LOG_SPEC_v1
**Branch**: `229-session-log-writer`

**概要**: 評価の因果記録 `.orbslog` の書き出し層 L1。フライトレコーダー方式（常時ローリングバッファ → `global.start()` でファイル生成 + meta + preamble + 以降追記）。傍受点定義は main、writer 本体は自己完結。

**設計の確定（advisor 検証 + コード確認で spec 曖昧点を解消、正本 §3/§3.1 に反映）**:
- **傍受点 = `InterpreterV2.execute()`**（全 eval 経路の単一 funnel）。`options.source/sourceFile/evalSource` を thread。
- **wall 原点** = engine/buffer 起動、発生時スタンプ（§3 文言修正）。
- **start/stop フックは Global.start()/stop() 境界**: `global.stop()` は `transportCommands` に stop が無く method 経路を通るため、両者が必ず通る Global 境界でフック（process-statement ではない）。
- **writer は opt-in**（実エントリのみ装着）→ 既存テストはファイル生成なし。
- **effect は LOOP のみ**（`nextQuantizedTime` 流用、Phase 0-2 確認済）/ **命名は CLI 完全・editor は untitled** / **tempo 二重記録は follow-up**（§3.1 に明記）。

**実装**:
- `core/session-log/session-log-writer.ts`（新規）: ローリング preamble バッファ・行単位 `appendFileSync`（kill-9 で最大1行）・命名（同一秒衝突は連番）・stop・再start=新ファイル。純 I/O。
- `core/global.ts`: `getTransportPosition()`/`getQuantizedEffectPosition()`/`msToBarBeat()` + opt-in `setTransportHooks()`。
- `interpreter/`: `enableSessionLog()` + execute() で eval 記録 + `installSessionHooks()`。
- `cli/play-mode.ts`・`repl-mode.ts`: 実エントリで `enableSessionLog` + source 供給。

**テスト**: writer 単体 9件 + interpreter 統合 6件（preamble 完全性 / 三重スタンプ整合 / 複数ファイル sourceFile / kill-9 行耐性 / 再start / inert）。全体 1079 passed / 23 skipped（既存回帰なし）。

### 6.114 Issue #273 — comp C2a polish（PR #272 bot レビュー反映） (Jun 14, 2026)

**Date**: 2026-06-14
**Status**: ✅ 実装完了（chore）
**Issue**: signalcompose/orbitscore#273 / 親 #271（#272 マージ後の follow-up）
**Branch**: `273-comp-c2a-polish`

**概要**: PR #272 マージ後の claude bot レビュー（5件・全件高品質評価・Critical 0）のうち**有効な軽微指摘**を反映。bot の「multi-line コメントが CLAUDE.md 違反」指摘は**誤検知**（両 CLAUDE.md に該当規約なし＋既存コードは multi-line JSDoc 多用、grep で確認）のため対象外。

**対応**:
- `comp-rhythm.ts`: 未知セル警告の `density ?? 0.5` を `density` に（param 既定 0.5 で常に定義済＝デッドコード除去）。
- `core/sequence.ts`: `.cell()` と `.density()` 併用時に `comp()` で warn（cell 優先で density 無視を discoverable に。挙動は不変）。`cell()` の持続性（`comp()` 後も残る）を doc 明記。
- `tests/midi/comp.spec.ts`: `quarters`（4分割）の dispatch テスト追加、cell+density 併用 warn のアサート追加。

**テスト**: comp.spec.ts 27件（+1）。全体 1064 passed / 23 skipped。

### 6.113 Issue #271 — comping rhythm engine `.comp()` / `.cell()` / `.density()`（comp phase C2a） (Jun 14, 2026)

**Date**: 2026-06-14
**Status**: ✅ 実装完了（C2a。/simplify + /code:pr-review-team 予定）
**Issue**: signalcompose/orbitscore#271 / 親 #259 / 設計 docs/research/comping-voice-leading-design.md
**Branch**: `271-comp-c2a`

**概要**: `.comp` 段階実装の C2a。各引数を1小節のコードとして受け取り、コンピングのリズム**セル**で各小節を展開する**primitive マクロ**。N コード → N 小節。展開結果は通常の play パターン（`( )` 等分割）なので、コード解決・タイミング・`.voicelead()`（C1）がそのまま合成される（**パーサ変更ゼロ**: `parseArguments` は method 非依存で play-element をパース、`callMethod` が generic dispatch）。

**設計上の重要な確定（ユーザー指摘 + 調査 + advisor 検証）**:
- **セルは meter 非依存の固定分割**: 各セルは固有スロット数（Charleston=8, quarters/twofour=4）を持ち、小節をその数で等分割する。偶数グリッドのセルを奇数拍子に乗せたときの「ズレ」は**意図的なポリメーター**（8:3 等）として歓迎（多層時間構造と掛け算可能）。meter 由来 slotsPerBar 計算・収まり判定は廃止 → 単純化。
- **音価は `gate`、off は rest**（調査根拠: 標準コンピングは Freddie Green 的に短い、pad/legato 持続は別スタイル。出典: Piano With Jonny / TJPS / Hal Galper / Acoustic Guitar / Jazz Library）。タイ持続は将来オプション。
- **コンピング知能（旧 C3: voicing 自動選択・rootless A/B・密度連動 sustain）は DSL 関数にしない → LLM バンドメイトスキルへ移管**。DSL はメカニズム/primitive に徹し、音楽的判断は LLM 側が持つ（哲学「ユーザー/AI 制御が主役・自動作曲ではない」と整合）。DSL 側コンピングは C2a で primitive 出揃い一区切り。C2b（per-cycle 可変 subdivision）はメカニズム寄りで保留（WCTM クリティカルパス外）。

**実装**:
- `midi/comp-rhythm.ts`: 純関数 `cellToGrid(cellName, density, warn?)` → `{slots, onsets}`。名前付きセル（charleston/redgarland/offbeats/quarters/twofour）＋ density モード（既定 8 分割に `round(d×8)` 個を等間隔）。未知セルは警告して density フォールバック。
- `core/sequence.ts`: `seq.cell(name)` / `seq.density(n)` setter + `comp(...chords)`。各コードを `( )` 入れ子（onset にコード clone、else `0`）へ展開し `length(N)` → `play(...)`。素の `.comp()` は charleston 既定。

**spec**: PITCH_DSL_SPEC §6.4 + core INSTRUCTION P.14 に normative セクション追加（メカニズム/知能の境界 = C3 は DSL スコープ外を明記）。

**テスト**: `tests/midi/comp.spec.ts` 16件（カーネル単体 10: セル/density/clamp/未知セル + dispatch 6: 既定 charleston / 3-4 ポリメーター発火時刻 / named cell / density 0 laying out / N 小節 / voicelead 合成）。全体 1053 passed / 23 skipped。

### 6.112 Issue #269 — auto voice-leading `.voicelead()` / `.vl()`（comp phase C1） (Jun 14, 2026)

**Date**: 2026-06-14
**Status**: ✅ 実装完了（C1。/simplify + /code:pr-review-team 済）
**Issue**: signalcompose/orbitscore#269 / 親 #259 / 設計 #268
**Branch**: `269-voicelead-c1`

**概要**: `.comp` 段階実装の C1。連続するコード stack を直前に対し最小移動（L1 / Tymoczko）で再ボイシングする決定論的演算子 `.voicelead()`（alias `.vl()`）。`.comp` の土台。

**設計上の重要な確定（実装調査で判明、advisor 検証済）**:
- voice-leading は **絶対ピッチ（root context）を要する**ため §6.1 voicing のような eval-time ではなく、**出力段で一度だけ走る決定論パス**（`validateMidiDispatch` と同型・同 awaited チェーン、per-cycle ではない）。結果を各声部の `octaveShift` にシンボリックに書き戻し、`^N`/`.oct()`/`^r` が上に加算（§7-0 維持、eval/dispatch 軸の決定論側）。
- 設計ドラフト #268 の「eval-time symbolic」記述はこの調査で誤りと判明 → #268 側を「deterministic, context-dependent, once-run」に訂正済（doc/impl 乖離防止）。

**実装**:
- `midi/voice-leading.ts`: 純関数 `voiceLeadOctaves(prev, curBase)`。等数はソート後 n 通り cyclic rotation の L1 最小、不一致は min(n,m) を lead・余剰はオクターブ 0（C1 簡略化、bipartite は C2+）。コモントーンは距離 0 で自然保持。
- `parser`: `.voicelead()`/`.vl()` をスコープチェーン（`SCOPE_CHAIN_OPS`）に追加。`PlayScoped.voicelead` / `TimedEventScope.voicelead`、timing walk で伝播。
- `core/sequence.ts`: `seq.voicelead()`/`vl()` setter + `applyVoiceLeading()`（onset でコードをグループ化し、≥2声部・voicelead スコープのコードを最小移動で octave 再配置）。run()/loop() の validateMidiDispatch 直後に実行。
- `seq` 既定 と グループ `(...).voicelead()` の両対応。単音はスルー、最初のコードは記譜どおり（アンカー）、記譜 `^N` は VL が包摂。

**spec**: PITCH_DSL_SPEC §6.3 に normative セクション追加（phase gate, rule #7）。音楽性限界（傾向音解決・並行回避を保証しない）を明記。

**レビュー**: /simplify（4 agent）+ /code:pr-review-team（4 専門 + CI bot）。VL 書き戻しの `rangeSet:false` クリア（`^N` running range 汚染遮断）、parseScopeChain の else フォールバック明示分岐化（時限爆弾除去）、3コード threading / cross-root / unequal / anchor-^N テスト追加。Critical=0 / Important=0 / security 全合格。

**テスト**: `tests/midi/voice-leading.spec.ts` 15件（純関数単体 + dispatch 統合 + parse + seq既定/group + cross-root + threading + 音楽性）。全体 1036 passed / 23 skipped。

### 6.111 Issue #259 — `.comp` + auto voice-leading 設計ドラフト（調査 + 提案） (Jun 14, 2026)

**Date**: 2026-06-14
**Status**: 🟡 設計ドラフト（pre-decision → 一部確定。C1 着手済）
**Issue**: signalcompose/orbitscore#259
**Branch**: `259-comp-voiceleading-design`

**背景**: `.comp`（自動ジャズコンピング、#259）は「土台（E2 primitives）は揃ったが実装対象としては未定義」状態。エビデンスベースで設計を練るため、3並列リサーチ（コンピングのリズム＋先行ソフト / ジャズボイシング＋音域 / ボイスリーディング理論＋アルゴリズム、いずれも WebSearch・出典付き）を実施し、`docs/research/comping-voice-leading-design.md` に調査 + 設計提案をまとめた。

**設計の要点（advisor レビュー反映）**:
- **2機能に分離**: ① auto voice-leading（決定論・出力段 once-run・シンボリック、min-L1 cyclic-rotation。命名 `.voicelead()`/`.vl()`）/ ② `.comp` 生成マクロ（リズム生成 + ボイシング選択 + thinning の合成）
- **既存2軸へマッピング**で「構造=リズムはユーザが書く ↔ `.comp` 自動生成」の緊張を解消（`.comp` のツリー展開は `*n`/spread と同機構）。**真の新規点 = リズムの subdivision が dispatch-time 可変になる初ケース**を明示
- **リズムモデル**: mode と同形のハイブリッド（subdivision グリッド primitive + 名前付きセル ライブラリ）を推奨
- **決定 #53 準拠**（seed なし・毎サイクル再ロール）
- **`.rootless()` primitive（root 除去）は正しい**。jazz rootless は上位テンプレートと明確化
- **段階分割**: C1（実装済 #269/#270）→ C2 リズムエンジン → C3 完全 `.comp`

**確定（2026-06-14, ユーザー）**: C1→C2→C3 段階 / 命名 `.voicelead()`+`.vl()` / 呼び出しは seq・group 両対応 / リズムはハイブリッド / seed なし。`.comp` は WCTM クリティカルパス外。

### 6.110 Issue #266 — 正本 HTML の normative 同期（PITCH_DSL_SPEC ← as-built E1-E6） (Jun 14, 2026)

**Date**: 2026-06-14
**Status**: ✅ 実装完了（ドキュメントのみ。/simplify + レビュー前）
**Issue**: signalcompose/orbitscore#266
**Branch**: `266-pitch-spec-normative-sync`

**背景**: `docs/specs-v2/PITCH_DSL_SPEC_v1.1.html`（v1.1 の仕様正本）は 2026-06-12 の実装前ドラフトで、E1-E6 実装の確定決定（DESIGN_DISCUSSION_RECORD #47-59）と乖離・矛盾していた。spec-first 原則（規則 #6）に対し締切優先で code→spec の逆順になった負債を解消。オラクルは test の assertion（`tests/midi/{voicing,random,expression,mode,key-center}.spec.ts`, `tests/audio-parser/pattern-binding-parsing.spec.ts`）に固定し、各 normative 文を test と照合。

**主な乖離解消**:
- **§6 の矛盾**: 「ビルダー API `.drop()` 等は採用しない」と明記されていたが E2 で voicing 演算子を実装（決定 #49/#51）→ value 合成（構成音）と voicing（オクターブ配置）を別軸として整理し、採用理由を明記（コード名シンボルではないため設計原則5は保持）
- **新規 §6.1 Voicing operators**（`.drop`/`.invert`/`.open`/`.close`/`.shell`/`.rootless`）、**§6.2 Randomness**（`Xr`/`.r`/`.r(p)`/`^r`、`r` を1プリミティブとして一箇所に集約）
- **新規 §2.5 per-note expression**（`@v`/`@g`）+ §8 Out of Scope から `@v` を削除
- **§2.2 mode period** 規則を「最終要素」→「最大半音位置」に修正（`mode(1, 7^-1)` 対策、E6 の review fix を反映）
- **§1 key-center register**（`global.key("D4")`、優先 `seq.octave()` > key octave > 4、E3）、**§6.5.3 section variables**（トップレベルカンマ=セル区切り、E4）
- **§10 Open Questions** の mode-period 境界ケースを解決済みに更新
- header status を `draft-for-implementation` → `E1-E6 as-built`（全体 implemented とはせず、§3 group chains / Phase 2+ は別管理と明記）

**advisor レビュー反映**: ①オラクル=test ②全体 implemented ラベル禁止（`.oct`/`.hold` の偽主張回避）③top-level renumber 回避・subsection 追加（編集後 `§` grep で dangling なし確認）④core MD P.11/P.12 の §参照を `正本 PITCH_DSL_SPEC §6.1-6.2 / §2.5` へ補正し cross-doc 不整合を解消 ⑤`r` ファミリを一箇所に集約。

**確認**: 1022 passed / 23 skipped（ドキュメントのみ）。新規 5 id ユニーク、dangling cross-ref なし。HTML は手書き直接編集（[[specs-html-authoring]]、pandoc 不使用）。

### 6.109 Issue #227 + #236 — Phase R (`*n`+パターン変数) + Phase 4 (タイ/レガート/hold) (Jun 14, 2026)

**Date**: 2026-06-14
**Status**: ✅ 実装完了（Phase R + Phase 4、1 ブランチ。/simplify + レビュー前）
**Issue**: signalcompose/orbitscore#227, #236
**Branch**: `227-phase-r-and-phase-4`

**方針**: Phase R（パーサー/評価器・低リスク）→ Phase 4（dispatch）を 1 ブランチ・コミット群分離で。Phase 3 の namespace 基盤（Global registry / `BoundValue.kind`）を再利用。code-architect blueprint 済（`PlayRepeat` ノード + eval 時展開、`chord_ref` を「名前参照」に一般化し kind 分岐、`*n` 後置は左→右で chain と合成）。

**本コミット（R: `*n` 反復, §6.5）**:
- `parser/types.ts`: `ASTERISK` トークン、`PlayRepeat`（transient、L2 で n 兄弟へ展開）を PlayElement union に。`PlayChordRef` を「名前参照（chord/pattern を kind で分岐）」と再定義
- `parser/tokenizer.ts`: `*` トークン
- `parser/parse-expression.ts`: `parsePostfix`（`*n`→PlayRepeat / `.root()`→PlayScoped を左→右、§6.5 例 `riff*4.root(3)`・`(a)(b).root(2)*2`）。`collapseScopedRun` 後に適用、`*n`/chain は run を閉じる（Q1）。bare 文字列名は wrap 時のみ chord_ref へ昇格（`global.key(C)` は不変）
- `parser/parse-statement.ts`: `parseArguments` でも `parsePostfix` 共有
- `midi/chord/resolve-chords.ts`: `BindingLookup`（name→BoundValue）へ一般化。`resolveElements`（1→N walker）で `*n` 展開（deep clone）・名前参照を kind 分岐（chord→縦 stack / pattern→横 splice）・unknown は warning。stack 内の名前は chord 限定（pattern/unbound は warning）
- `core/global.ts`: `definePattern` / `getBinding`（chord namespace を pattern と共有）
- `core/sequence.ts`: `play()` の resolver を `getBinding` に
- `timing/calculate-event-timing.ts`: 未解決 `repeat` の internal-error ガード

**決定（blueprint）**: `chord_ref` はリネームせず「名前参照」として kind 分岐（churn 回避）。Tidal 差異: OrbitScore `*n` はスロット占有反復（Tidal `!`）、スロット内分割は nest `(1,1)`。

**テスト**: `repeat-parsing.spec.ts` 7件 / `repeat-timing.spec.ts` 5件（`*0` エラー・`*1` 恒等・左→右 postfix・グループ内反復・audio スライス値で pitch 非依存）。chord 系テストの unknown 警告文言を「unknown name」へ更新。全体 939 passed / 23 skipped。

**追加コミット（R: パターン変数, §6.5）**:
- `parser/parse-statement.ts`: `parseVarDeclaration` に `var NAME = (...)` 分岐（RHS が `(` 始まり。init/chord は不変）、`parsePatternBinding`（トップレベル兄弟 run を parseArgument+collapseScopedRun+postfix で。トップレベルのカンマは拒否＝Q2、NEWLINE/EOF で終端、juxtaposition は LPAREN で継続）
- `interpreter/process-statement.ts`: `pattern_binding` を currentGlobal.definePattern に配線
- 解決は R の `*n` コミットで導入済（`resolveName` の pattern 分岐＝横 splice、chord と同一 namespace を kind 分岐）。単一グループ→1スロット / juxtaposition→複数兄弟 splice。`riff*3`・`riff.root(3)`・chord と共存。評価時値渡し（play() 時点で解決、再定義は走行中パターンに非影響）
- core spec は specs-v2 を正本として参照（§6.5 + Tidal 差異注記は PITCH_DSL_SPEC が正本。core sync は別 Issue #237）

**テスト**: `pattern-binding-parsing.spec.ts` 5件 / `sequence-pattern-dispatch.spec.ts` 8件（単一/juxtaposition splice・`*n`・`.root()`・chord 共存・評価時値渡し・unknown warning・interpreter 配線）。全体 952 passed / 23 skipped。**Phase R 完了**。

**追加コミット（Phase 4: タイ / 声部タイ / レガート / hold, §5/§4）**:
- `parser/tokenizer.ts`: `UNDERSCORE`（先頭 `_` を傍受。中間 `_` の識別子は不変）/ `LBRACE` / `RBRACE`
- `parser/types.ts`: `PlayTie`（`_` イベントタイ）/ `PlayLegato`（`{ }`）を PlayElement へ。`PlayPitch.tie`（`_n` 声部タイ）/ `PlayScoped.hold`
- `parser/parse-expression.ts`: `parseLegato`、`parseNestedPlayElement`/`parseArgument` の UNDERSCORE/LBRACE 分岐、`parseStackElement` の UNDERSCORE 分岐（`_5`/`_b7` を chord_ref より先に傍受）、`parseScopeChain` に `.hold()`
- `timing/calculate-event-timing.ts`: `tie` 分岐（スロット占有マーカー、pitch 無し）/ `legato` 分岐（`( )` 同分割、内部音に legato タグ・末尾は通常 gate）/ voiceTie タグ / `hold` を resolveScope に
- `core/sequence.ts`: `scheduleMidiEvents` を **3段パス**に再構成（resolve→offTime算出/抑制→emit）。`_` 吸収・`_n`/hold 静的ピッチ照合抑制・`{ }` overlap。on数=off数を構造的に保証（hanging note 不変条件）。`hold()` メソッド + `LEGATO_OVERLAP_MS=20`
- `midi/chord/resolve-chords.ts`: `legato` 再帰 arm

**仕様補足（DESIGN_DISCUSSION_RECORD §11、決定 #44-46）**: 先頭 `_` の LOOP 持ち越しは clearOwner 衝突のため v1.1 では休符（真の持ち越しは follow-up）。overlap=20ms。`.hold()` のスタック判定 = slot size>1（単音連打は非対象 #8）。`_n`/hold は静的・解決後ピッチ照合（動的照会は不変条件リスク）。

**テスト**: `tie-legato-parsing.spec.ts` 7件 / `tie-legato-timing.spec.ts` 3件 / `sequence-tie-legato-dispatch.spec.ts` 8件（legato overlap 順序・`_` 二音・先頭 `_`=休符・`_n` 抑制+fallback・hold 自動タイ+#8単音除外）/ hanging-note 不変条件に Phase 4 パターンの 100× LOOP swap を追加。全体 971 passed / 23 skipped。**Phase 4 完了 → Phase R + Phase 4 完了**。

**追加コミット（実機検証ハーネス + デモ）**: 実エンジン（parse→度数解決→MIDI→IAC）で**実在の PD 曲**を鳴らして Phase R/4 を検証するため、MIDI→OrbitScore 変換器 `tools/midi2orbs/`（`smf.js` / 声部モード `midi2orbs.js` / 和音モード `midi2orbs-chordal.js` + README）と PD デモ `tools/midi-monitor/{pavane,chorale,phase-r4-tour}.orbs` を追加。ピッチ列を元 MIDI と照合して一致を確認（パヴァーヌ=3声・度数+`^`、コラール=`[ ]`+`_n` 声部タイ）。著作権 MIDI 本体は非コミット。判明した DSL フィードバック（度数モデルのオクターブ越え friction / 多声の2手段 / tie↔tree-duration の相補性）は README に記録。コード変更なし（ツール/デモ/ドキュメントのみ）。

**追加（Gymnopédie 全曲）**: transcriber 和音モードを 3/4・サブビートグリッド・全長対応に拡張し、Satie「ジムノペディ No.1」全78小節を `tools/midi-monitor/gymnopedie.orbs` として生成（`[ ]` 和音 + 左手バスの `_n` 保持、Gmaj7⇄Dmaj7 を元 MIDI と照合一致）。実曲テストで surfaced した将来課題: (a) key 中心の絶対音域指定、(b) セクション変数（複数小節の楽節束縛・曲構成での再利用）。

**追加コミット（/simplify + PR #252 レビュー反映）**: `/simplify`（4エージェント並列）→ `/code:pr-review-team`（code-reviewer / silent-failure-hunter / pr-test-analyzer / comment-analyzer の4専門 + 再レビュー）を実施し critical/important=0 まで収束。

- **/simplify 適用（挙動不変）**: scheduleMidiEvents Stage B の onset グルーピングを 1 回構築し `applyGateAndLegato`/`applyVoiceTiesAndHold` で共有（F2）/ import・chord・pattern binding ガードを `requireGlobal(state,label)` に集約（F3）/ `parsePostfix` を for ループ化（F4）/ legato tail の `Math.max(...map)` を単一パスへ（F5）。**スキップ**: `parseNestedPlay`/`parseLegato` の共通化（F1）= 区切り文法が別物（`( )` は LPAREN のみ並置継続 / `{ }` は LPAREN/LBRACE/LBRACKET）で統合すると Phase 2/3 scope テストが依存する挙動が変わるため。
- **レビュー修正（Critical/Important）**:
  - **循環パターン参照ガード（Critical）**: `var riff = (riff)` / 相互 `a→b→a` が `resolveName` 無限再帰 → stack overflow。`resolve-chords.ts` に分岐ローカルの `visiting: Set<string>`（add-before-recurse / `try-finally` で delete-after）を threading し、検出時は warning + `[]`。兄弟再利用 `play(riff, riff)` は誤検出しない。
  - **`[chord], _` が全声部を延長（Important）**: `absorbEventTies` を単一 `lastEmitted` → 直近 onset の全 plan（スタックは同一 onset を共有＝1イベント）を保持する `lastGroup` に。spec §5.1「直前**イベント**を1スロット延長」+ 構造表「`[ ]`=同時発音=全声部が親スロット全長を共有」を grep 確認し、単声部のみ延長は spec 違反のバグと確定（解釈ではない）。
  - **声部タイ+イベントタイの `tieSlots` 引き継ぎ（Important）**: `applyVoiceTiesAndHold` の held 延長を `n.slotDur` → `(n.slotDur + n.tieSlots)` に（`_n` で抑制される音に吸収された `_` の延長分を held 音へ伝播）。
  - **コメント（Important）**: `parsePostfix` docstring に `.hold()` 追記 / `gate()` の orphaned docstring を本来位置へ復元 / `*0`「diagnostic error」→「parse 時に拒否」/「slot size>1」→「slot note-count>1」/ phase-r4-tour.orbs の hold() コメント修正。
  - **却下（false positive・証拠付き）**: F4「console.warn→Sentry」= engine に `logError`/Sentry 基盤は皆無、`console.warn`/`console.error` が確立規約。F3「`modified` が `chord_ref` を包んで silent drop」= `modified.value` は `number|PlayNested` 型で文法上 bare chord_ref を包めない。**降格**: pattern binding の GLOBAL 無し時は `console.error` が変数名付きで発火済（Sentry 前提が崩れたため Minor）。
- **テスト追加（+6、非空虚性を実機確認）**: `chord-resolution.spec.ts` に循環参照3件（自己/相互/兄弟再利用）。`sequence-tie-legato-dispatch.spec.ts` に発火時刻スタンプ付き backend で 3件（`[1,3,5],_` 和音全延長・rest がタイ鎖を断つ・`_n`+`_` の held 延長）。C1/C2 テストは修正を一時 revert すると確かに fail することを確認。全体 **977 passed / 23 skipped**。
- **後続 Issue 候補**: 未束縛名のスロット消失 vs 休符（C3）/ 空パターン `var x=()` 診断（F5）は error-path の判断事項として follow-up。

### 6.108 Issue #250 — 設計記録: アイデンティティ・スコープ原則・表現 2 軸モデル (Jun 13, 2026)

**Date**: 2026-06-13
**Status**: ✅ 記録完了（正本 spec 反映は確定後）
**Issue**: signalcompose/orbitscore#250
**Branch**: `250-design-principles-expression-model`

Phase 3 確定後の設計対話を `DESIGN_DISCUSSION_RECORD.md` に §10 + 決定 #39-43 として記録（コード変更なし）:
- **アイデンティティ**:「譜面的構造をプログラム的抽象化で書く DAW の MIDI 部」/ 完全な楽譜再現は非目標（度数・`^N`・chord 値の抽象の延長）
- **スコープ判定基準**（デザインプリンシパル）: 速記性 / 直交性 / リアルタイム演奏可能性の3条件を満たす機能だけ採用。記譜記号の網羅は非目標
- **表現 2 軸**: velocity 軸（`@v`・アクセント=相対ブースト）+ articulation 軸（per-seq `gate` → per-note articulation → `{ }` レガートを統一）。音価はツリー+タイが持ち、絶対音価 `@u`(v1.0) は棄却（二重管理）。`@`系トークン文法は Phase 4 後の専用フェーズ
- **Phase 4 スコープ確定**: `_`/`_n`(必須)/`{ }`/`.hold()`(採用) 全部入り
- §9.7 未決「コード内 `^N` × running range」を Phase 3 (PR #249) で確定済み（✅ 化）

正本 PITCH_DSL_SPEC（HTML）への反映は方針確定後（本記録は方針＝デザインプリンシパルの保全）。

### 6.107 Issue #231 — Phase 3: `[ ]` スタック + chord 値 (Jun 13, 2026)

**Date**: 2026-06-13
**Status**: ✅ 実装完了（B0-B7。スタック core + chord 値 spread/除去/import。/simplify + レビュー前）
**Issue**: signalcompose/orbitscore#231
**Branch**: `231-phase-3-stack-chord`

**設計**: code-architect で blueprint を策定（4層パイプライン: L1 parse→PlayStack（生）/ L2 evaluate（chord 名解決・spread・除去・^N、namespace を持つ唯一の層）/ L3 timing（並列再帰）/ L4 dispatch（同時 note-on は等 startTime から自動的に従う、audio 拒否は生パターン走査）。spec §4/§6/§10 正本。advisor で「Phase R 未実装＝chord 値用の値束縛基盤を本フェーズで最小構築」を確認）。

**前提の訂正**: 直前要約は Phase R (#227 パターン変数) 完了を前提にしていたが、#227 は OPEN・値束縛/`import`/`*n` 基盤は未実装。chord 値の namespace は本フェーズで chord 専用に最小構築し、`kind` discriminant で Phase R と共有可能にする（`*n`・汎用タプルパターン変数は作らない）。

**本コミット（スタック core B0-B4）**:
- `parser/types.ts`: `PlayStack`（voices + 任意 octaveShift）/`StackElement`/`PlayChordRef`/`PlayChordRemoval` を追加、PlayElement union に PlayStack
- `parser/parse-expression.ts`: `parseStack`/`parseStackElement`（`[ ]` を常に PlayStack へ。LBRACKET の旧 `bracketReservedMessage` throw を撤去）、`parseChordRef`（bare 識別子 + `^N`）、`parseChordRemoval`（`-N`/`-bN`、`[ ]` 内 `-` は常に除去）、`asStackVoice`（スタック voice の `^N` は構造的＝rangeSet クリア §2.4）
- `timing/calculation/calculate-event-timing.ts`: `stack` 分岐（voice ごとに `[voice]` を全長・等 startTime で並列再帰、`[1,(5,3,2,1)]` のサブツリーは同一スパンを再分割）+ `applyStackOctaveShift`（whole-stack `^N` を構造的に加算）。未解決 chord_ref/removal が来たら internal error
- `core/sequence.ts`: dispatch の octaveShift を加算式に修正（`runningRange + groupOct + (rangeSet?0:octaveShift)`。構造的シフトを上乗せ、従来の旋律音は no-op）。`validateNonMidiDispatch` + `containsStack`（生パターン再帰走査、`( )`/scope/modifier 内のスタックも検出）を追加し run()/loop() で eager 拒否（§10-5 audio スタック予約）

**テスト**: `stack-parsing.spec.ts` 10件 / `stack-timing.spec.ts` 5件 / `sequence-stack-dispatch.spec.ts` 7件（同時 note-on、scope 合成、voice/whole `^N` の加算、running range 非干渉、audio 拒否）。`pitch-parsing.spec.ts` の旧「`[ ]` reserved＝parse throw」3件を新仕様（PlayStack へ parse、拒否は dispatch）に更新。全体 895 passed / 23 skipped。

**追加コミット（B5: chord 評価器 — 純関数モジュール）**:
- `midi/chord/types.ts`: `ChordVoice`（degree/alteration/構造的 octaveShift/detune）、`BoundValue`（`kind:'chord'` discriminant で Phase R と namespace 共有可能に）
- `midi/chord/predefined-chords.ts`: `import chords` 標準テーブル（maj/min/dim/aug/sus4/sus2/6/m6/maj7/m7/dom7/m7b5/dim7/mMaj7/maj9/m9/dom9）。度数は長音階基準、quality は accidental に（m7 = 1,b3,5,b7）
- `midi/chord/resolve-chords.ts`: `resolveChords(elements, getChord)` — spread（ref 展開）/ 除去 `-N`（字面一致 degree+alteration、不一致は warning）/ ref `^N`（spread voice に構造的加算）/ standalone ref → 一スロット stack。namespace は `getChord` 注入で純関数化（§6.5.2 評価時値渡し）
- `parser/types.ts`: PlayElement union に `PlayChordRef`（§9.1 の `(0, m7, 0)` グループ要素対応、L2 で解決され timing には到達しない transient）、StackElement を `PlayElement | PlayChordRemoval` に整理
- `timing/calculate-event-timing.ts`: 未解決 chord_ref が timing walk に来たら internal error（silent drop 防止）

**テスト**: `chord-resolution.spec.ts` 11件（spread/add/除去/不一致 warning/`^N`/standalone/unknown/whole-stack `^N` 保持/predefined テーブル）。全体 906 passed / 23 skipped。

**追加コミット（B6/B7: chord 値の parse + namespace + 配線）**:
- `parser/types.ts`: `IMPORT` トークン、`ChordBinding`/`ImportStatement` を Statement union に
- `parser/tokenizer.ts`: `import` キーワード
- `parser/parse-statement.ts`: `parseVarDeclaration` を `chord([...])` 束縛に分岐（`init` パスは不変）、`parseImport`（`import chords` のみ受理）
- `parser/parse-expression.ts`: `parseNestedPlayElement` に IDENTIFIER → chord_ref（§9.1 の `(0, m7, 0)` グループ要素）
- `core/global.ts`: chord namespace（`importChords`/`defineChord`/`getChordVoices`、衝突 warning §10-4）を Global に（`global.key()` と同様 program-global、interpreter/直接 seq 両経路で共有）
- `core/sequence.ts`: `play()` で timing 前に `resolveChords`（chord ref を spread/除去/`^N` 解決し純シンボリックに）。warning は console.warn
- `midi/chord/resolve-chords.ts`: `evaluateChordDefinition`（`var = chord()` の束縛時評価）
- `interpreter/process-statement.ts`: `import`/`chord_binding` を currentGlobal に配線

**決定（spec 範囲内）**: 除去 `-N` の字面一致は (degree, alteration)（§6 字面一致の具体化）。namespace 衝突は last-write-wins + warning（§10-4）。未定義 chord 名参照は warning + 空展開（§6 は未規定、no-op+warning 哲学に整合）。`{ }` レガート・`_` タイ（§5）と top-level bare chord 名は Phase 3 範囲外（§9.1 のそれらは Phase 4）。

**テスト**: `chord-binding-parsing.spec.ts` 8件 / `sequence-chord-dispatch.spec.ts` 12件（import+`[m7]`、`(0,m7,0,m7).root(3)`、spread+add/除去、whole-chord `^+1`、defineChord、unknown warning、registry、interpreter 配線、**§9.1 正本 bar 3**）。`sequence-stack-dispatch.spec.ts` に **§9.1 正本 bar 4**（`[1,3,b7,13]`/`b13` の高次テンション 13/b13）を追加。全体 927 passed / 23 skipped。core spec は specs-v2 を正本として参照（§4/§6 は PITCH_DSL_SPEC が正本、乖離なし）。

### 6.106 Issue #230 — Phase 2: `.root()`/`.mode()`/`.oct()` グループスコープ — パーサー層 (Jun 13, 2026)

**Date**: 2026-06-13
**Status**: 🚧 IN PROGRESS (パーサー層完了。dispatch のスコープ解決は後続コミット)
**Issue**: signalcompose/orbitscore#230
**Branch**: `230-phase-2-root-group-chains`

**設計**: code-architect で blueprint を策定（PlayScoped 新ノード、スコープは calculateEventTiming のツリー walk で捕捉しフラット dispatch では per-event descriptor で消費、共有 run ヘルパで no-chain 並置の splice を保全、build sequence B0-B8）。spec §2.3/§3 正本。

**本コミット（パーサー層 B1-B4 のパーサー部分）**:
- `parser/types.ts`: `PlayScoped`/`ScopeRoot`/`ScopeMode` を追加、PlayElement union に。スコープチェーンが有る時だけ生成（no-chain 並置は従来通り別 sibling）
- `parser/parse-expression.ts`: `parseScopeChain`（root/mode/oct、重複・root+mode 衝突を diagnostic エラー、last-wins 不採用）、`parseRootArg`（音名 F#/Bb/C をトークンから再構成 + 度数 3/b6、`noteNameToPitchClass` 再利用）、`parseModeArg`（mode 予約＝raw 捕捉、dispatch で throw 予定）、`assertChainClosesRun`（チェーン直後カンマなし `(` = エラー §3）、`collapseScopedRun`（並置 run を1スコープに集約）
- `parser/parse-statement.ts`: `parseArguments` に run 集約（`(A)(B).root(X)` を1ノードに、カンマが run 境界）

**テスト**: `tests/audio-parser/scope-chain-parsing.spec.ts` 20件（音名/度数 root、oct、mode 予約、重複/衝突/chain-closes エラー、並置 run 集約、§3 入れ子 override 例、no-chain 並置の回帰ガード）。全体 848 passed / 23 skipped。

**追加コミット (B5-B6: dispatch スコープ解決)**:
- `timing/calculation/types.ts`: `TimedEvent.scope`（TimedEventScope: root/mode/groupOct）追加
- `timing/calculation/calculate-event-timing.ts`: scope スタックをツリー walk でスレッド、PlayScoped は timing 透過（並置と同じスロット）+ frame push、各リーフに inner→outer 解決した scope を付与
- `core/sequence.ts`: `resolveScopeToContext(scope, getSeqDefault)` を追加し scheduleMidiEvents / validateMidiDispatch で per-event 解決。音名 root は key 不要・度数 root は key 必須（未宣言はエラー）・mode は throw。seq 既定は遅延算出（音名 root のみのシーケンスが key を要求されないように）
- テスト: `scope-timing.spec.ts` 4件（timing 透過 + inner→outer + groupOct）、`sequence-scope-dispatch.spec.ts` 8件（音名/度数 root、並置共有、入れ子 override、key 有無、mode 拒否）。全体 860 passed。

**追加コミット (B7: `.oct()`×`^N` 合成)**: 大和確認で **additive** に決定。`effectiveOctave = runningRange + groupOct`（§9.3 直交＝足し合わせ）。`^N` は `.oct()` グループを抜けても持続（§9.4 linear）、groupOct は running range にフィードバックしない。テスト3件追加（加算合成 / oct 単独 / `^N` 持続）。全体 863 passed。

**B8 core spec 反映**: Phase 1 の前例に倣い、core spec (`INSTRUCTION_ORBITSCORE_DSL.md`) は line 12 の「v1.1 は specs-v2 が正本」ポインタで反映済みとする（§2.3/§3 を core spec に複製すると specs-v2 と二重保守＝乖離リスク。operating rule #7 の眼目「乖離を作らない」はポインタで満たす）。v1.1 安定後にまとめて fold-in する方針。

**VS Code エディタ支援**（Sonnet subagent、§5「拡張側に閉じる」、main がレビュー）:
- `syntaxes/orbitscore-audio.tmLanguage.json`: `.root()`/`.mode()`/`.oct()` チェーンの TextMate ハイライト（begin/end で引数内の `F#` を保護）+ 音名/度数/整数の引数ハイライト
- `src/extension.ts`: root/mode/oct の hover + play() 引数内 `).` 文脈での補完（paren balance ガードで `play(...).` の誤発火を回避）
- **main レビューで修正**: (1) grammar の legacy `#.*$` コメント規則を**削除**（OrbitScore のコメントは `//`、`#` は ACCIDENTAL。この規則が `#5`/`F#`/`##1` を全域でコメント誤認していた＝Phase 1 シャープ表示のバグ。agent の begin/end 回避の根本原因を除去）。(2) hover 例の `(1 2 3)` → `(1, 2, 3)`（OrbitScore はカンマ区切り）
- **span レベルのセマンティックハイライト（並置 run の可視化）は見送り**: `PlayScoped` ノードにソース位置(offset)が無く、実装には engine パーサー拡張（PlayScoped に startOffset/endOffset）+ `DocumentSemanticTokensProvider` + package.json の semanticTokenTypes が必要。「`.root()`+カンマ両忘れ→静かな併合」緩和の本命だが engine 変更を伴うため follow-up（chain-closes/重複のパースエラーで多くは既に検出される）。

**Phase 2 完了**: パーサー + timing + dispatch + エディタ支援。テスト 863 passed / 23 skipped。core spec はポインタ規約で反映。

**Phase 2 PR**: #247 作成済み。

**/simplify パス (2026-06-13)**: 4観点で Phase 2 production code (787行) をレビュー。適用4件: (A) 共有 `collapseScopedRun` で parser の run-collapse 重複を統合（pre/post-push の drift 解消、3 agent が指摘）、(B) 共有 `degreeRootToPitchClass` で度数解決カーネル統合、(D) `resolveScope` 空スタック早期 return、(E) `.mode()` エラーが `ScopeMode.raw` を使用（dead field 解消）。スキップ: 条件スプレッド・timing/dispatch 分離（正しい層）、microopt、diff 外の paren ループ。863 passed 維持。

**/code:pr-review-team イテレーション1 (#247)**: 4 専門レビュアー。Critical 0、Important 修正:
- **(silent-failure) `.root(0)` のサイレント tonic fallback**: 群 `.root()` は seq.root() の guard が無く degree 0 が黙って key tonic に落ちていた → `parseRootArg` に degree<1 の parse エラー（`expectRootDegree`）+ `degreeRootToPitchClass` の silent fallback を throw に。
- **(comment) 度数範囲 `1-12` 誤記**（受理は {1-9,11,13}）→ tmLanguage + 補完 + hover の3箇所を `1-9, 11, 13` に修正。
- **(test) カバレッジ +9**: nested レベルの run-collapse（`((1)(2).root(3), 5)`、/simplify の共有関数を両経路で検証）、不正 root 引数（`.root(0)`/`.root(b0)`/`.root(H)`/空）、note-root + bare degree 混在で no-key reject、inner `.oct()` × outer `.root()` 別フレーム、`.oct(-N)`。
- code-reviewer は Critical/Important ゼロ。872 passed。

**/code:pr-review-team イテレーション2 (#247)**: 再レビュー（code-reviewer + silent-failure-hunter）でイテレーション1修正が正しく新規問題なしを確認（Critical 0 / Important 0）。surfaced Minor 1件を fold-in: `expectRootDegree` に `Number.isInteger` チェック追加（seq.root() setter と対称、`.root(1.5)` を parse エラーに）+ テスト。**完了条件達成: Critical 0 / Important 0 / security pass**。873 passed / 23 skipped。

**次**: #247 マージ判断（ユーザー指示待ち）。follow-up: span レベルハイライト（PlayScoped offset 要）、Phase 3 (#231 `[ ]` スタック + chord 値)。

---

### 6.105 Issue #228 — Phase 1: 度数記法の再設計 (pitch range / スティッキー `^N`) (Jun 13, 2026)

**Date**: 2026-06-13
**Status**: 🚧 IN PROGRESS (PR #245 に同梱)
**Issue**: signalcompose/orbitscore#228
**Branch**: `228-phase-1-midi-output`

**動機**: Phase 1 実機検証 (6.103) で2オクターブスケールを度数 `1..15` で鳴らしたところ、大和さんが「度数仕様が想定と違う」と指摘。`8,10,12,14` はバークリーで使わない非音楽的な数字で、メロディはルート上のコード度数 (1-7 + テンション 9/11/13) で書く。第四議論を経て **pitch range (音域状態) モデル**に収束 (DESIGN_DISCUSSION_RECORD §9、決定ログ #33-38)。

**確定した仕様 (spec が正本)**:

- **度数 = 和声的位置**: `1-7` (スケール) + テンション `9/11/13` (メロディでも明示可、`2/4/6` の +1オクターブ)。
- **`^N` = スティッキー pitch range**: 音/休符に付き、その地点から running range を base+N に設定。play() 内で読み順に持続、各 play() 先頭でリセット、`^0` で戻る。`0^N` = 無音で音域変更。独立 `^` マーカーは無し。3オクターブ上 = `3^3` 一発。
- **range は全度数に効く (統一ルール、linear)**。`^N`(linear/persistent) と `.oct()`(lexical/group、Phase 2) は別軸の道具。
- **度数受理 = {1-9, 11, 13}**。`8` = オクターブ上ルート (8va、`1^1` 等価)。`10/12/14/15+` は**エラー** (`^N` を案内)。後方互換は取らない (未リリース機能ゆえ)。

**変更内容**:

- `docs/specs-v2/DESIGN_DISCUSSION_RECORD.md` + `.html`: §9 第四議論を追記 (9.1-9.7、決定ログ #33-38)。`.html` は直接編集で同期 (pandoc 不使用 — 仕様 HTML は手書き保守が方針、`.md` のテーマを壊さないため)
- `docs/specs-v2/PITCH_DSL_SPEC_v1.1.html` §2.1 (度数受理 / `o`=running range)、§2.4 (`^N` スティッキー pitch range)
- `docs/specs-v2/IMPLEMENTATION_INSTRUCTIONS.html`: テスト網羅項を新ルールに
- `midi/degree-resolution.ts`: 受理度数 {1-9,11,13} 検証 (10/12/14/15+ は throw)
- `parser/types.ts` + `parse-expression.ts`: PlayPitch に `rangeSet` (「`^` を書いたか」=スティッキー set point)
- `midi/types.ts`: SymbolicPitch に `rangeSet?` (出力段の running range スレッド用)
- `timing/calculation/calculate-event-timing.ts`: `rangeSet` を pitch に伝播
- `core/sequence.ts` `scheduleMidiEvents`: 読み順で **running range をスレッド** (rangeSet で更新、以降の全度数に effective range を適用)

**テスト (821 passed / 23 skipped)**: degree 受理 {1-9,11,13} / 拒否 {10,12,14,15+}、スティッキー range の持続 (`play(1, 3^1, 5)` → C4 E5 **G5** で +1 が残る ≠ one-shot の G4)、`^0` リセット / `0^N` 無音音域変更、parser の `rangeSet` (`3^1`=true / `b3`=false / `1^0`=true)。

**未決/確認済**: `^N` × `.root()` グループの相互作用は **linear で確定** (大和さん、グループを抜けても range 持続)。chord 値内の `^N` (§6 ヴォイシング) は Phase 2+ で別途確認。

**/code:pr-review-team イテレーション1 (2026-06-13)**: 4 専門レビュアー (code-reviewer / silent-failure-hunter / pr-test-analyzer / comment-analyzer) で PR #245 をレビュー。Critical 2 + Important 6 を修正:
- **(Critical) 度数拒否が run() に伝播していなかった**: bad degree (10/12/14/15+) は fire-and-forget の scheduleEventsFn callback 内で throw され unhandled rejection になっていた (eager 検証は root だけだった)。`validateMidiDispatch()` を追加し、run()/loop() の eager ブロックで root + 全度数を事前解決 → 拒否度数が awaited チェーンで reject するように。テストで実証 (`play(10)`/`play(15)` → run() rejects)。
- **(Critical) README**: 「Ctrl+C = パニック」を graceful LOOP() に訂正。
- **(Important) MidiScheduler ピッチベンド残留**: detune≠0 の note の後、ベンドが中央に戻らず次の note を detune させていた → offTime に `pitchBend(…, 0)` reset を追加 + テスト。
- **(Important) MidiScheduler.tick() の throw 耐性**: `action.run()` が throw すると queue cleanup がスキップされ double-send / hanging note → try/catch + log で継続。
- **(Important) seq.root(0) のサイレント fallback**: 0 は休符で root 不正 → 正の整数を検証 (throw)。
- **(Important) テスト追加**: テンション 9/11/13 + range 継承、変化記号 + range 継承 (`3^1, b5`)、度数拒否の dispatch 伝播。
- **(Important) comment**: parsePitchModifiers docstring を sticky pitch range に更新。
- minor: degree-resolution 式コメントを `range o` に、dev-server `do_GET` の `/pattern` を exact match に。
- テスト 827 passed / 23 skipped。

**/code:pr-review-team イテレーション2 (2026-06-13)**: 再レビュー (code-reviewer / silent-failure-hunter) でイテレーション1の修正が正しく、新規問題なしを確認 (Critical 0 / Important 0)。surface された Minor を1件修正:
- **ループ中 play(不正度数) の crash 防止**: deferred (setTimeout) の scheduleEventsFn は awaited チェーン外なので、ループ中に不正度数を play() すると次サイクルで throw → Node>=22 で unhandled rejection / 未捕捉例外 = プロセス crash。イテレーション1の eager 検証は run()/loop() 入口だけ救済しており mid-loop は crash する非対称があった。`loop-sequence.ts` に `safeSchedule` ラッパを追加し deferred 呼び出しを catch+log、ループは last good schedule で継続。`tests/core/loop-sequence-resilience.spec.ts` で実証。
- セキュリティチェックリスト: secrets/injection/XSS なし。dev-server が 0.0.0.0 bind + 無認証だが localhost dev ツール (機微データなし、cross-machine 共同検証用途) ゆえ pass (信頼ネットワーク限定の注記つき)。
- 完了条件達成: **Critical 0 / Important 0 / security pass**。テスト 828 passed / 23 skipped。

**次**: PR #245 レビュー/マージ。その後 Phase 2 (#230) / L1 (#229)。

---

### 6.104 Issue #246 — MIDI モニターに「Now playing (DSL)」パターン表示 (`/pattern`) (Jun 13, 2026)

**Date**: 2026-06-13
**Status**: 🚧 IN PROGRESS (PR #245 に同梱)
**Issue**: signalcompose/orbitscore#246
**Branch**: `228-phase-1-midi-output`

**動機**: 大和さん「テストツールで今どの DSL パターンが実行されているか見たい」「ログ的に見れるといい」。手作り MIDI と表示の食い違いを防ぎ、共同検証で「今鳴っている DSL」を一目で確認するため。

**変更内容**:

- `tools/midi-monitor/dev-server.py`: `POST /pattern` (送信側が実行中の DSL を `{source,label}` で報告、`latest_pattern` に保持) + `GET /pattern` (最新を返す) を追加
- `tools/midi-monitor/index.html`: 「Now playing (DSL)」パネル — `/pattern` をポーリングして実評価ソースを表示 (`replaceChildren`/`createElement` で XSS 回避)

**経緯メモ**: headless runner (6.103、コミット `2bd34ef`) は `POST /pattern` を呼ぶが、**endpoint 側 (本変更) が未コミットだった**。本エントリで endpoint を確定し、midi-run.ts の `/pattern` 報告が実際に機能する。表示=エンジンが評価した実ソースなので、音と表示が原理的に一致する。

**/simplify パス (2026-06-13)**: 4 観点 (reuse/simplification/efficiency/altitude) で session 変更 (`2bd34ef..HEAD` の code) をレビュー。適用: `dev-server.py` の `/pattern` で `datetime.now()` を2回呼んでいたのを1回に集約。スキップ: index.html の meta DOM (textContent 化は `.label` のスタイルを落とすため)、`SymbolicPitch.rangeSet`/dual `octaveShift` の altitude (spec §9.4 で現レイヤを是認済・#240 score rendering 向けの tracked smell)。reuse/efficiency は実所見ゼロ。

---

### 6.103 Issue #228 — Phase 1: headless MIDI CLI runner (実エンジン .orbs → IAC) (Jun 13, 2026)

**Date**: 2026-06-13
**Status**: 🚧 IN PROGRESS (Phase 1 実機検証ツール。 commit hash: `a9a350b`)
**Issue**: signalcompose/orbitscore#228
**Branch**: `228-phase-1-midi-output`

**動機**: 大和さんの指摘「手で MIDI を作るのでなく、 DSL を CLI で実行してロジックを通過させて MIDI を送れ」。 これが Phase 1 の本当の実機検証。 TransportClock 分離 (6.102) により audio engine なしで MIDI を走らせられるようになった。

**変更内容**:

- `packages/engine/src/cli/midi-run.ts`: `.orbs` を実エンジン経路で評価する headless ランナー。 `parseAudioDSL` + `processGlobalInit/SequenceInit/Statement` (InterpreterV2 を迂回、 SC ブートを回避)、 no-op audio engine + デフォルト MidiManager (実 RtMidiOutput → IAC)。 評価した DSL ソースを monitor の `/pattern` に報告 (表示=真実)。 SIGINT で panic 停止
- `package.json`: `npm run midi-run -- <file.orbs>` スクリプト追加 (ts-node)
- `tools/midi-monitor/README.md`: headless runner の使い方を追記

**実機検証 (end-to-end)**: `npm run midi-run -- tools/midi-monitor/example.orbs` で、 `piano.play(1, 2, 3, 4, 5, 6, 7, 1^+1)` を**エンジンが度数解決**して C4-C5 (60,62,64,65,67,69,71,72) を IAC に送出 → ブラウザ Web MIDI で受信・発音をログ確認。 `/pattern` に `label: example.orbs` + 実ソースが報告され、 表示=エンジン評価ソースで音と一致 (以前の手作り MIDI の食い違い問題を原理的に解消)。 **SC は一切ブートせず**。

**意義**: DSL → パーサー → 度数解決 (§7-0 出力最終段) → MidiOutput → IAC の Phase 1 全経路を実機で確証。 WCTM の実機テスト基盤にもなる。

**追記 (graceful stop + REPL)**: 大和さんの指摘「パニックでなく LOOP() で止めたい」を反映。 Ctrl+C / SIGTERM は `global.stop()` のパニック (CC123/120) ではなく **`LOOP()` を評価して正規の per-sequence note-off** で停止 (§7-2、 実機でブラウザ受信が note-off のみ・panic 無しを確認)。 加えて **stdin live-coding REPL** を追加 — 実行中に DSL 行 (`LOOP()` / `LOOP(piano)` / `piano.play(...)`) を評価できる (OrbitScore のライブコーディング)。

**次**: PR #245 レビュー/マージ判断。 その後 Phase 2 (#230) / L1 (#229)。

---

### 6.102 Issue #228 — Phase 1: TransportClock で MIDI を SC から分離 (同期維持) (Jun 13, 2026)

**Date**: 2026-06-13
**Status**: 🚧 IN PROGRESS (Phase 1 改善。 commit hash: `312e73e`)
**Issue**: signalcompose/orbitscore#228
**Branch**: `228-phase-1-midi-output`

**動機**: 大和さんの指摘「IAC 経由は SC を絡ませない方がすっきり」。 ただし audio/MIDI を同時に使うとき**同期が壊れてはいけない**。 調査の結論: audio スケジューラも MIDI スケジューラも `Date.now()` ポーリングで、 同期は**共有する時刻原点 (`startTime`)** で実現されている。 従来は MIDI が audio scheduler オブジェクトから startTime を読んでいた (= コード結合だが、 これが同期の源)。

**設計判断**: 共有「トランスポート時計」に巻き上げる。 audio も MIDI も同一の `Date.now()` 原点を参照し、 MIDI は audio engine を参照しない。

**変更内容**:

- `core/global/transport-clock.ts`: `TransportClock` (startTime/running、 `global.start()` で一度だけ `Date.now()` をスタンプ) = 唯一のクロック原点
- `core/global/midi-transport-scheduler.ts`: `MidiTransportScheduler implements Scheduler` — TransportClock backed、 audio メソッドは no-op。 MIDI シーケンスはこれを使い **audio scheduler を一切参照しない**
- `core/global.ts`: TransportClock 所有、 `start()` で原点スタンプ (audio scheduler 始動より先) → 同期維持、 `stop()` で停止。 `getMidiTransport()`/`isTransportRunning()` 追加
- `core/sequence.ts`: `activeScheduler()` = MIDI なら MidiTransport、 audio なら SC scheduler。 seamlessParameterUpdate / run / loop / unmute の per-sequence scheduler を振り替え。 **audio 経路は無変更**
- `tests/core/transport-clock.spec.ts`: 5件 (原点スタンプ・冪等・**no-op audio engine でも MIDI 動作** = 分離実証)。 MIDI dispatch / hanging-note テストは `global.start()` 追加で更新

**同期の保証**: audio scheduler と MidiTransport は同じ `global.start()` の `Date.now()` 原点を共有 → 同音楽時刻のイベントは同 `Date.now()` 発火。 下流レイテンシ差は `midiLatency()` + ポート lead で補正 (§9、 既存)。 MIDI 専用セッションは SC を一切ブートしない。

**テスト結果**: 878 passed / 23 skipped (901 total)。 +5、 audio 回帰なし。

**次**: headless MIDI CLI ランナー (ts-node)。 TransportClock のおかげで audio engine 不要の綺麗な実装に。

---

### 6.101 Issue #246 — ブラウザ MIDI モニター + シンセ (.orbs 検証ツール) (Jun 13, 2026)

**Date**: 2026-06-13
**Status**: 🚧 IN PROGRESS (Phase 1 ブランチに同梱。 commit hash: `8217af3`)
**Issue**: signalcompose/orbitscore#246
**Branch**: `228-phase-1-midi-output` (PR #245 に同梱)

**動機**: Phase 1 の MIDI 出力を DAW やソフトシンセのセットアップなしで確認するため (大和さん提案)。 Phase 1 と同じブランチに入れることで、 同じ PR のレビュー/テストで早速使える。

**変更内容 (`tools/midi-monitor/`)**:

- `index.html`: 単一静的ページ (ビルド不要・依存なし・vanilla JS)。 Web MIDI で IAC 受信 + Web Audio でポリフォニックシンセ (osc + ADSR + lowpass)。 velocity→音量、 pitch bend→±2半音 (エンジンの bend range に一致)、 CC123/120→全 note-off、 MIDI モニターログ + 発音中ノート表示、 MIDI 無しの Test tone。 `innerHTML` は使わず `replaceChildren`/`createElement` (XSS 回避)
- `example.orbs`: IAC へ C メジャースケールを送る最小例。 port は substring `"IAC"` で日英両環境対応
- `README.md`: 使い方 + IAC オンライン化手順

**位置づけ**: 人間/リハ用の検証ハーネス (CI 自動化用ではない)。 WCTM のソフトピアノ代替 (WCTM_SYSTEM_SPEC §9 / #232) にも転用可。

**検証**: localhost 配信で HTTP 200、 主要要素・コード存在確認、 inline JS の `node --check` 構文OK。 実 IAC→発音は Chrome での人手確認 (Web MIDI は secure context 必須)。

**追記 (commit `7ff89e2`)**: 楽器選択 (Piano / Organ / Synth) + 任意のイベントレポート (`?report=1`) + `dev-server.py` (静的配信 + POST /events を stdout) を追加。 **実機 end-to-end 検証済み**: CLI (`@julusian/midi`) → `IACドライバ バス1` → ブラウザ Web MIDI で C メジャースケール + 和音をビット単位一致で受信・発音、 ピッチ正常を人手確認。 先頭音落ちはタブ非フォーカス時の AudioContext スロットルが原因 (README 明記)。 `dev-server.py` 経由でブラウザ受信イベントを観測しながら人間/エージェント連携でテストできることを実証。

---

### 6.100 Issue #228 — Phase 1 増分5d: hanging note 不変条件 + `[ ]` 予約 (Phase 1 機能完成) (Jun 13, 2026)

**Date**: 2026-06-13
**Status**: 🚧 IN PROGRESS (Phase 1 機能完成。 commit hash: `d8d0dd3`)
**Issue**: signalcompose/orbitscore#228
**Branch**: `228-phase-1-midi-output`

**動機**: Phase 1 のゲート条件 (hanging note ゼロ) の受け入れテストと、 audio `[ ]` の diagnostic 予約 (§10-5)。 これで Phase 1 の機能が出揃う。

**変更内容**:

- `tests/core/midi-hanging-note-invariant.spec.ts`: 実 RtMidiOutput (recording backend) + fake timers で 3 件:
  - **LOOP play() 差し替え100回で hanging note ゼロ** (Phase 1 ゲート条件)
  - MUTE で sounding note 全解放
  - global.stop() で panic (CC123+CC120 全ch、 active note ゼロ)
- `[ ]` 予約 (§10-5): `tokenizer` に LBRACKET/RBRACKET 追加 (従来は default で黙って破棄)。 `parse-expression` でパースエラー (「v1.1 では未対応・予約」)。 黙って無視せずエラーにすることで将来の開放 (Phase 3 の MIDI chord / audio レイヤリング) を純粋な追加変更にする
- `tests/audio-parser/pitch-parsing.spec.ts`: `[ ]` 予約テスト 3 件追加

**テスト結果**: 873 passed / 23 skipped (896 total)。 +6、 回帰なし。

**Phase 1 機能チェックリスト (受け入れ基準)**:
- ✅ `seq.midi(port, ch)` + ポート名ロケール対応 (`/iac/i`)
- ✅ root スコープ度数解決 (§2.1)、 `seq.root()`/global.key()/octave
- ✅ §7-0 シンボリックピッチ保持 (番号化は出力最終段のみ)
- ✅ active note tracking + パニック CC123/120
- ✅ **LOOP 差し替え100回で hanging note ゼロ**
- ✅ hanging note 不変条件 (note-on = note-off)
- ✅ 度数解決の網羅テスト (326件)
- ✅ detune (pitch bend ±2)、 gate/vel/octave、 midiLatency + ポート lead
- ✅ audio `[ ]` の diagnostic 予約
- ✅ 既存テストグリーン (回帰なし)
- ⏭ L1 ログ同乗 (#229)、 VS Code ハイライト (Phase 2)、 core spec 反映 (#237) は別 Issue

**Phase 1 コミット**: 増分1 `38b3040` / 2a `f7ee68b` / 2b `f275b45` / 3 `2e23104` / 4 `876cec7` / 5a `c849119` / 5b `4c3f50b` / 5c `0c36eb6` / 5d (本コミット)。 全 9 コミット、 MIDI 関連テスト +445。

**次**: PR 作成 (#228 Closes) → レビュー → マージ。 その後 Phase 2 (#230 `.root()` グループチェーン)。

---

### 6.99 Issue #228 — Phase 1 増分5c: MIDI ディスパッチ配線 (発音つながる) (Jun 13, 2026)

**Date**: 2026-06-13
**Status**: 🚧 IN PROGRESS (Phase 1 増分5c。 commit hash: `ba12399`)
**Issue**: signalcompose/orbitscore#228
**Branch**: `228-phase-1-midi-output`

**動機**: パイプライン最後の配線。 MIDI シーケンスの play() を実際に発音させる。 これで DSL `b3` → パーサー → timing → **度数解決 (出力最終段) → MidiScheduler → MidiOutput → 🔊** がつながる。

**設計判断**: 既存の audio 中心 `loop-sequence`/`run-sequence`/`prepare-playback` はコールバック駆動で audio/MIDI 非依存だったため**そのまま再利用**。MIDI 固有部分だけを Sequence 側のコールバックで差し替える (最小の中枢変更)。 時刻基底は audio scheduler の startTime を共有 (併走同期)。

**変更内容 (`core/sequence.ts`)**:

- `scheduleMidiEvents()`: TimedEvent → `resolveDegree(symbolic, rootContext)` → `ScheduledMidiNote` → MidiScheduler。 §7-0 の番号化を**ここ (出力最終段) で**実施。 rest (度数0) はスキップ、 detune は pitch bend へ、 onTime = `schedulerStartTime + baseTime + ev.startTime + sendDelay`
- `resolveRootContext()`: global.key() + seq.root(degree) + seq.octave から RootContext。 key 未宣言 + 度数ありはエラー (§2.3)。 run()/loop() で eager 検証 (resolveDispatchChannel と同じ理由で early throw)
- `clearEvents()`: MIDI は `MidiScheduler.clearOwner` (pending 除去 + sounding note 解放、 §7-2)、 audio は従来通り。 run/loop/stop/mute/unmute/play差し替え の全クリア経路を振り替え
- `scheduleEvents`/`scheduleEventsFromTime` に MIDI 分岐 (従来は `!_audioFilePath` で早期 return していた箇所)
- `tests/core/sequence-midi-dispatch.spec.ts`: fake timers + mock 出力で 6 件 (度数→MIDI番号 end-to-end、 b3→Eb4、 octave、 gate の note-off 対、 stop で releaseOwner、 key 未宣言エラー)

**テスト結果**: 867 passed / 23 skipped (890 total)。 +6、 回帰なし。

**次**: 増分5d (hanging note 不変条件: LOOP差し替え100回でゼロ — Phase 1 ゲート条件)。 残: audio `[ ]` の diagnostic 予約 (§10-5、 `[ ]` トークンは Phase 3 で導入のため要検討)。

---

### 6.98 Issue #228 — Phase 1 増分5b: Sequence MIDI 設定面 + audio排他 (Jun 13, 2026)

**Date**: 2026-06-13
**Status**: 🚧 IN PROGRESS (Phase 1 増分5b。 commit hash: `3289c01`)
**Issue**: signalcompose/orbitscore#228
**Branch**: `228-phase-1-midi-output`

**動機**: Sequence のユーザー向け MIDI 設定メソッド。 これで MIDI シーケンスの宣言面が揃う (実際の発音配線は 5c)。

**変更内容 (`core/sequence.ts`)**:

- `midi(portName, channel)`: MIDI モード宣言。 ポートを eager 解決 (ローカライズ substring、 未知ポートは宣言時エラー)。 channel 1..16 検証。 `audio()` 済みなら排他エラー
- `gate(v)` (0..1)、 `vel(v)` (1..127)、 `octave(v)`、 `root(degree)` セッター。 既定 gate=0.8/vel=96/octave=4 (§1)
- `isMidi()`、 `audio()`/`chop()` に MIDI 排他チェック
- `getState()` に midiPort/midiChannel/gate/vel/octave/rootDegree を追加
- `tests/core/sequence-midi-config.spec.ts`: 10 件 (ポート解決・channel検証・排他双方向・clamp・既定値)

**テスト結果**: 861 passed / 23 skipped (884 total)。 +10、 回帰なし。

**次**: 増分5c (MIDI ディスパッチ配線: run/loop/play/stop/mute → MidiScheduler、 TimedEvent → 度数解決 → ScheduledMidiNote)、 5d (hanging note 不変条件 100回)。

---

### 6.97 Issue #228 — Phase 1 増分5a: Global MIDI インフラ + key/midiLatency (Jun 13, 2026)

**Date**: 2026-06-13
**Status**: 🚧 IN PROGRESS (Phase 1 増分5a。 commit hash: `a0e999f`)
**Issue**: signalcompose/orbitscore#228
**Branch**: `228-phase-1-midi-output`

**動機**: Sequence MIDI 統合 (増分5) の土台。 全 MIDI シーケンスが共有する MidiOutput + MidiScheduler を Global が lazy に所有し、 グローバル key と midiLatency を提供する。

**変更内容**:

- `midi/note-name.ts`: 音名 → ピッチクラス解析 (`"C"`/`"F#"`/`"Bb"`/`"C##"`、 octave 境界 wrap、 case-insensitive)。 §1/§2.3
- `core/global/midi-manager.ts`: `MidiManager` — lazy な MidiOutput+MidiScheduler 所有 (audio-only セッションは CoreMIDI に触れない)、 グローバル key、 midiLatency、 ポート単位 lead オフセット (Disklavier 機構レイテンシ、 §9)。 出力は注入可能 (テストで mock)
- `core/global.ts`: `key(name)`、 `midiLatency(ms)`、 `getMidiManager()` を追加。 `start()`/`stop()` で scheduler を起動/停止。 constructor に MidiManager 注入口
- `tests/midi/note-name.spec.ts` (5件)、 `tests/midi/midi-manager.spec.ts` (5件)

**確認**: インタプリタは動的ディスパッチ (`obj[method].apply`) なので `global.key()`/`global.midiLatency()` は自動的に届く (whitelist なし)。

**テスト結果**: 851 passed / 23 skipped (874 total)。 +10、 回帰なし。

**次**: 増分5b (Sequence の midi()/gate/vel/octave/root + audio排他)、 5c (MIDI ディスパッチ配線 + 度数解決)、 5d (hanging note 不変条件)。

---

### 6.96 Issue #228 — Phase 1 増分4: MidiScheduler (TS lookahead) (Jun 13, 2026)

**Date**: 2026-06-13
**Status**: 🚧 IN PROGRESS (Phase 1 増分4。 commit hash: `b866454`)
**Issue**: signalcompose/orbitscore#228
**Branch**: `228-phase-1-midi-output`

**動機**: RtMidi は即時送信のみのため、 TS 側で note タイミングを駆動する lookahead スケジューラ。 §5 に従い Sonnet に実装委譲、 契約 (型) と統合レビューは main。

**設計判断**: §7-0 のシンボリックピッチ→MIDI番号の解決はディスパッチ層 (増分5、 出力最終段) で行うため、 MidiScheduler は **解決済みノート** (`ScheduledMidiNote`) を受け取る。 時刻は `Date.now()` 基準の絶対 epoch ms (audio スケジューラと同一クロック基底で併走可)。

**変更内容**:

- `midi-scheduler.ts`: 契約 (main 作成) — `ScheduledMidiNote` (owner/port/channel/note/velocity/detune/onTime/offTime)、 `MidiSchedulerOptions`。 `MidiScheduler` クラス (Sonnet 実装) — `setInterval(tickMs=5)` ポーリング、 各 tick で `Date.now()` をスナップして `time <= now` のアクションを `(time,seq)` 順に発火 (ドリフト補正は tick 毎の壁時計比較)。 detune は note-on 直前に pitch bend。 `start`(冪等)/`stop`(panic)/`clearOwner`(pending除去 + releaseOwner)
- `tests/midi/midi-scheduler.spec.ts`: fake timers + mock MidiOutput で 21 件 (発火タイミング、 順序、 detune→bend、 clearOwner、 stop→panic、 過去時刻の翌tick発火、 start冪等)

**テスト結果**: 841 passed / 23 skipped (864 total)。 midi-scheduler +21、 回帰なし。

**次**: 増分5 (Sequence MIDI 統合: midi() + ディスパッチ + 値=度数解釈 + 排他 + パラメータ + audio[]予約 + hanging note 不変条件) [main 直列]。

---

### 6.95 Issue #228 — Phase 1 増分3: MidiOutput (@julusian/midi ラッパー) (Jun 13, 2026)

**Date**: 2026-06-13
**Status**: 🚧 IN PROGRESS (Phase 1 増分3。 commit hash: `e36e6cf`)
**Issue**: signalcompose/orbitscore#228
**Branch**: `228-phase-1-midi-output`

**動機**: raw MIDI 送出層。 ポート解決・note 送出・active note tracking・パニックを担う隔離モジュール。 §5 委譲方針に従い実装は Sonnet サブエージェントに委譲、 契約 (interface) と統合品質レビューは main (Opus)。

**変更内容**:

- `packages/engine/package.json`: `@julusian/midi@^3.6.1` を依存追加
- `midi-output.ts` (main 作成): 契約定義 — `MidiOutput` interface、 `MidiBackend` 注入 seam (テストで mock 可)、 `ActiveNote`
- `rtmidi-output.ts` (Sonnet 実装 + main レビュー): `RtMidiOutput implements MidiOutput`。 ポート名 case-insensitive substring 解決 (ローカライズ名 `"IACドライバ バス1"` を `"iac"` で当てる、 §1)、 note-on/off、 pitch bend (±2半音固定)、 active note tracking、 `releaseOwner` (LOOP除外/MUTE/play差し替え時の解放)、 `panic` (CC123+CC120 全ch、 §7-2)
- `tests/midi/midi-output.spec.ts`: mock backend で 41 件 (ポート解決・note tracking・releaseOwner・panic・**hanging note 不変条件**・pitch bend)

**main によるレビュー改善**: `noteOn`/`noteOff`/`pitchBend` が毎回 `ensurePort` (ポート再列挙) を呼ぶとライブ演奏で1音ごとに CoreMIDI 列挙が走るため、 解決済みポート名のキャッシュ高速パス (`resolveOpenPort`) を追加。

**テスト結果**: 820 passed / 23 skipped (843 total)。 midi-output +41、 回帰なし。

**次**: 増分4 (MidiScheduler: TS lookahead) [Sonnet 委譲]。

---

### 6.94 Issue #228 — Phase 1 増分2b: TimedEvent シンボリックピッチ拡張 (§7-0) (Jun 13, 2026)

**Date**: 2026-06-13
**Status**: 🚧 IN PROGRESS (Phase 1 増分2b。 commit hash: `e9abf90`)
**Issue**: signalcompose/orbitscore#228
**Branch**: `228-phase-1-midi-output`

**動機**: パース (増分2a) で生成した `PlayPitch` を、 タイミング計算を通してシンボリックピッチのまま運ぶ。 これで「パース → timing」がつながり、 §7-0 (MIDI 番号化は出力最終段のみ) を pipeline で守る。

**変更内容**:

- `timing/calculation/types.ts`: `TimedEvent` に optional `pitch?: SymbolicPitch` を追加 (非破壊。 audio スライスイベントは未設定のまま)。 midi/types から SymbolicPitch を import (timing→midi の一方向依存、 循環なし)
- `calculate-event-timing.ts`: `element.type === 'pitch'` を処理。 リズム木が startTime/duration を与え、 シンボリックピッチを未解決のまま carry。 sliceNumber は degree をフォールバックとしてミラー
- `tests/timing/pitch-timing.spec.ts`: 4 件 (pitch carry、 octave shift/detune 透過、 ネスト内 pitch、 audio 回帰)

**設計判断**: TimedEvent は解決済み midiNote を持たず **シンボリックピッチのみ** を運ぶ。 root context (rootPitchClass/octave) の適用と MIDI 番号化は出力アダプタ最終段 (増分3-5) で行う。

**テスト結果**: 779 passed / 23 skipped (802 total)。 pitch-timing +4、 回帰なし。

**次**: 増分3 (MidiOutput: @julusian/midi ラッパー) [Sonnet 委譲]。

---

### 6.93 Issue #228 — Phase 1 増分2a: ピッチトークン + パーサー (§2.1 / §2.4) (Jun 13, 2026)

**Date**: 2026-06-13
**Status**: 🚧 IN PROGRESS (Phase 1 増分2a。 commit hash: `356afcb`)
**Issue**: signalcompose/orbitscore#228
**Branch**: `228-phase-1-midi-output`

**動機**: MIDI 度数記法 (`b3`, `#5`, `bb7`, `##1`, `3^+1`, `b7~-0.25`) を DSL でパースできるようにする。 共有トークナイザーに触れる最重要作業のため main (Opus) が直列で実施 (§5)。

**事前確認**: audio DSL のコメントは `//` で `#` と衝突しない。 `#`/`^`/`~`/`b+数字` は既存 .orbs / テストで未使用 → 新トークン追加は既存パースを壊さない (grep 確認済み)。

**変更内容**:

- `tokenizer.ts`: ACCIDENTAL (`#`/`##`/`b`/`bb` ラン)、 CARET (`^`)、 TILDE (`~`)、 PLUS (`+`) トークンを追加。 `b` ランは「直後が数字」のときのみ alteration とみなし、 そうでなければ識別子にフォールバック (変数名 `b` を保護)
- `parser/types.ts`: 新トークン型 + `PlayPitch` AST ノード (degree/alteration/octaveShift/detune) を `PlayElement` union に追加。 裸の整数は `number` のまま (audio スライス番号互換)
- `parse-expression.ts`: accidental + number + `^`/`~` 修飾を `PlayPitch` に解析。 トップレベルとネスト両対応。 `bb`/`##` = ±2、 3個以上で warning (spec §2.1)
- `tests/audio-parser/pitch-parsing.spec.ts`: トークナイザー/パーサーテスト 21 件

**設計判断**: 裸整数を `number` のまま残すことで audio スライス番号パースを完全に無変更に保つ。 `PlayPitch` は accidental か `^`/`~` がある場合のみ生成。 値=度数の解釈は MIDI ディスパッチ時 (増分3以降)。

**既知の制約**: `b7` 等は flat-7 記法として予約されるため、 同名の変数定義は不可 (spec の設計通り)。

**テスト結果**: 775 passed / 23 skipped (798 total)。 pitch-parsing +21、 回帰なし。

**次**: 増分2b (TimedEvent シンボリックピッチ拡張 + timing 計算のピッチ対応)。

---

### 6.92 Issue #228 — Phase 1 増分1: 度数解決コア (§2.1 / §7-0) (Jun 13, 2026)

**Date**: 2026-06-13
**Status**: 🚧 IN PROGRESS (Phase 1 全体の増分1。 commit hash: `283e56f`)
**Issue**: signalcompose/orbitscore#228
**Branch**: `228-phase-1-midi-output`
**Epic**: signalcompose/orbitscore#224

**動機**: Phase 1 (raw MIDI 出力) の基盤として、 MIDI ハードウェア・スケジューラに依存しない純関数部分から着手。 §7-0 シンボリックピッチ保持の型契約と §2.1 度数解決を最初に確立する (パイプライン全体がこの型に乗るため、 最初に固めないと後で取り返せない)。

**増分1の内容 (新規 `packages/engine/src/midi/`)**:

- `types.ts` — §7-0 契約の型定義: `SymbolicPitch` (degree/alteration/octaveShift/detune)、 `RootContext` (rootPitchClass/octave)、 `ResolvedPitch` (midiNote + シンボリック情報を保持)。 MIDI 番号化は出力最終段のみという §7-0 を型レベルで強制
- `degree-resolution.ts` — §2.1 の IONIAN 式による純関数 `resolveDegree()`。 度数 0 = 休符 (null)、 度数 9/11/13/15 はオクターブ折り返しが式から自然導出、 C4=60 規約
- `index.ts` — モジュール公開面
- `tests/midi/degree-resolution.spec.ts` — プロパティテスト 326 件 (全度数 1-15 × 変化記号 ±2 × octave 2-5 の網羅 + C4=60 + テンション折り返し + §7-0 保持 + detune 透過 + バリデーション)

**設計判断**: spec §3 のアーキテクチャ決定に従い `packages/engine/src/midi/` を AudioEngine と並置 (EventRouter フル分離はしない)。 型契約は中枢に影響するため main (Opus) が直接定義。 度数解決の数理は §2.1 が完全な契約。

**テスト結果**: 754 passed / 23 skipped (777 total)。 midi +326、 回帰なし。

**Phase 1 の残り増分 (次セッション以降)**: ① パーサー拡張 (`b3`/`#5`/`3^+1`/`b7~-0.25` トークン)、 ② MidiOutput (@julusian/midi ラッパー、 ポート名ロケール対応、 active note tracking、 パニック CC123/120) [Sonnet 委譲可]、 ③ MidiScheduler (TS lookahead 50-100ms、 ドリフト補正) [Sonnet 委譲可]、 ④ Sequence への `midi()` メソッド + ディスパッチフラグ + 値=度数解釈、 ⑤ `global.key()`/`midiLatency()` + ポート単位オフセット、 ⑥ seq.gate/vel/octave、 ⑦ audio `[ ]` の diagnostic エラー予約、 ⑧ hanging note 不変条件テスト。

---

### 6.91 Issue #226 — Phase 0 事前検証4項目 (Jun 13, 2026)

**Date**: 2026-06-13
**Status**: ✅ DONE (commit hash: `93dad80`)
**Issue**: signalcompose/orbitscore#226
**Branch**: `226-phase-0-verification`
**Epic**: signalcompose/orbitscore#224

**動機**: v1.1 Pitch DSL 実装に着手する前に、 仕様が依拠する4つの前提をコードを書く前に検証する (指示書 §4 Phase 0)。 仕様の前提を崩す結果が出たら停止して報告する条件付き。

**検証結果 (停止条件には1件も該当せず)**:

- **0-1 `(1)(2)` タプル並置**: ✅ 前提成立。 兄弟展開される (parse-statement.ts:383 が意図的に連続処理)。 ただしパーサーは並置とカンマ区切りを区別せずフラット化するため、 Phase 2 の `.root()` スコープ規則には AST 区別の拡張が必要 (spec 織り込み済み)。 再現テスト `tests/phase0/juxtaposition-verification.spec.ts` (4件) で固定
- **0-2 `quantize("bar")` play() 差し替え**: ✅ 前提成立・実装済み。 `seamlessParameterUpdate` の deferToNextCycle に 'play' が含まれ次サイクル反映。 既存34テスト (loop-quantize / seamless-parameter-update / quantize) で担保。 Issue #212 修正が PR #215 でマージ済み
- **0-3 `@julusian/midi`**: ✅ 動作確認。 Node 22.17.1 + macOS arm64 で prebuild `midi-darwin-arm64` 込みインストール成功。 実 IAC ポート `"IACドライバ バス1"` への note 送出に成功。 ⚠️ ポート名がロケール依存 (英語例 `"IAC Driver Bus 1"` と不一致) のため Phase 1 で `/iac/i` 等の言語非依存マッチが必要。 `openVirtualPort()` も利用可
- **0-4 Link 追従**: ⚠️ オーディオ受け渡しのみ。 スケジューリングは内部クロック (`Date.now()` + `setInterval`) 独立で Link beat/phase を参照しない。 → W-Link (#234) に「Link 追従スケジューリング」を新規実装項目として昇格 (spec 織り込み済み、 停止条件外)

**成果物**: `docs/research/PHASE0_VERIFICATION_REPORT.md` (各項目の結果 + 後続フェーズへの影響評価)、 `tests/phase0/juxtaposition-verification.spec.ts`。

**テスト結果**: 428 passed / 23 skipped (451 total)。 phase0 テスト +4、 回帰なし。

**次のステップ**: Phase R (#227) または Phase 1 (#228)。 0-1/0-3 の含意を各フェーズ着手時に反映。

---

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
