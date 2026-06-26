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

### 6.170 ci(rust): wire Rust workspace into CI — fmt / clippy / test / cargo-deny (#326) (Jun 26, 2026)

**Date**: 2026-06-26
**Status**: ✅ 実装完了（PR レビュー前）
**Branch**: `326-ci-rust-job`
**Issue**: #326（post-2.0 engine track / γ・cutover #108 前の hardening + CI 負債解消）

これまで CI は `code-review.yml`（npm/TS のみ）で **Rust を一切検証していなかった**。#340 で「CI green ≠ Rust 検証」が
繰り返し問題になった（gated 実機 RUN とローカル cargo が唯一の根拠）。本 PR で Rust workspace を PR ごとに CI 検証する。

**前提クリーンアップ（CI ゲートを green にするため必須）**:
- **fmt drift 19 ファイル**を `cargo fmt --all` で解消（Rust CI 不在で fmt が変更ファイルにしか当たっていなかった。
  `cargo fmt --all` は workspace-exclude の `orbit-link-audio` も整形＝CI の `--check` と一貫）。純整形コミットに分離。
- **clippy 警告**を解消（auto-fix: redundant closure / div_ceil / collapsible if 等 + 手動 3 件: orbit-clap-spike の
  `sort_by`→`sort_by_key(Reverse)` / `if x>0 {a/x}`→`checked_div().unwrap_or(0)` ×2）。挙動不変。

**workflow（`.github/workflows/rust-ci.yml`・2 job）**:
- `rust`（ubuntu）: libasound2-dev（cpal/ALSA）→ dtolnay/rust-toolchain@stable + Swatinem/rust-cache@v2 →
  `cargo fmt --all --check` / `clippy`（default & clap-host）`--all-targets --locked -- -D warnings` /
  `cargo test`（default & clap-host）`--locked`（gated は `#[ignore]` で自動 skip・CI に device 無し）。
- `cargo-deny`（ubuntu）: taiki-e/install-action → `cargo deny check`。default グラフ(link-audio off)が GPL-free を assert。

**スコープ判断**: GPL feature `link-audio`（build.rs が `target_os != "macos"` で error）は ubuntu でビルド不可かつ
GPL 隔離方針のため **CI では有効化しない**（default グラフ = permissive + cross-platform に保つ）。実機 gated テストは
CI で走らない（audio device 無し）。

**ローカル全 green 確認**: fmt clean / clippy `-D warnings` clean（default + clap-host）/ cargo test 全通過
（default + clap-host・非gated）/ cargo-deny `advisories+bans+licenses+sources ok` / `--locked` OK /
verify テストの WAV fixture は git-tracked（CI で `cargo test` 可）。

---

### 6.169 feat(engine): daemon CLAP integration — in-process plugin hosting (#340) (Jun 26, 2026)

**Date**: 2026-06-26
**Status**: ✅ 実装完了 + pr-review-team round 2 + @claude bot で Critical/Important=0 収束（gated 実機テスト 2 本 GREEN・owner マージ待ち）
**Branch**: `340-daemon-clap-integration`
**Issue**: #340（post-2.0 engine track / Epic #292・Path A = γ の前提 + cutover #108 の背骨）

spike で実証した in-process clack-host を本番 daemon `orbit-audio-daemon` に統合し、effect plugin が
daemon 経由で RT-safe に audio を加工できるようにした。**Step0 検証 = COMMIT 判定**（fork せず）:
spike の「Mutex vs lock-free」前提は古く、両経路とも `engine.render` の同一 `try_lock` を通り plugin は
構造上 Mutex-free。clack は pre-1.0 だが git pin で clean build。effect 型 CLAP plugin も最小実装で成立。

**アーキ（clack 境界）**: native は permissive な mixing core を保ち clack に依存しない。`PostProcessor`
trait（`&mut [f32]` を in-place 変換）を native に置き（既存 `PostMixSink`/`AudioBackend` inversion を
踏襲）、clack 実体は permissive crate `orbit-clap-host` に隔離。daemon が `clap-host` feature 配下で
`ClapHost`(!Send) を**専用 OS スレッド**で所有し、plugin の hot-install は wait-free ring 経由で audio
thread に渡す。

**effect topology（serial insert）**: instrument（parallel add-mix）と区別。
- `HostAudioBuffers::has_audio_input`（audio 入力ポートの有無）で経路分岐。
- effect: engine の interleaved 出力を plugin の planar 入力へ de-interleave コピー
  （`set_input_from_interleaved`）→ process → 出力で hardware sum を**上書き**（`replace_cpal_buffer`）。
- instrument: 入力を無音化（`set_input_silent`）→ process → 出力を add-mix（`add_to_cpal_buffer`）。
- mux/downmix は `fill_muxed_from_main_output` に集約し add/replace で共有。

**carry-forward 3（A0 §13・RT 正確性）= 解決**:
1. teardown は StreamGuard の field drop 順で強制（`ClapTeardownGuard` が audio thread で
   `stop_processing` → stream 停止 → 専用スレッドで instance deactivate）。**通常 teardown 経路の**暗黙 Drop の
   wrong-thread stop_processing（strict plugin で UB）を回避。⚠️ shutdown + device-loss + install-race が
   同窓で重なる narrow 残余（install ring の未消費 `InstallMsg` が非 RT スレッドで drop）は本 PR では未解決・
   追跡 issue #342 の focused follow-on PR で対応（両レビューが Minor 認定・実害極小）。
2. `request_callback` は `Arc<AtomicBool>` で lock-free（mpsc の alloc+mutex を排除）。
3. CLAP `EventBuffer` は ring capacity でサイズ固定し RT realloc を防止（debug_assert で検出）。

**Done 証拠（実機 gated・A0 §6: CoreAudio+cpal は xrun 不発火 → RT 健全性は callback 実測時間）**:
- effect gated（`clap_effect_gated.rs`・two-phase ratio）: baseline 0.70711 → effected 0.35355 =
  **ratio 0.50000**（EFFECT_GAIN=0.5 ちょうど）。入力配線死=~0 / replace 欠落=~1.5 を判別する設計で、
  de-interleave 入力 + replace 出力の両方が機能している証拠。callback max 859µs（budget ~10.8ms の ~8%）。
- synth gated（`clap_host_gated.rs`・PR1 回帰）: post_mix_peak 0.25・callback max 449µs。
- cargo workspace 全 green / clippy・fmt clean / npm 1188 passed（SC default path 不変）。

**スコープ外（fence）**: γ の out-of-process sandbox は対象外（次フェーズ）。`link-audio` と `clap-host`
は当面排他（1 callback での render 順序統合は defer・`compile_error!` で弾く）。audio `play()` 意味論・
SC default path は不変。

**/code:pr-review-team（4専門・round 1）**: code-reviewer/silent-failure-hunter/pr-test/comment を並行起動。
Important 修正 = effect process 失敗時の 1-block 無音化（`process_ok` で出力配線を gate し失敗時は dry 素通し）/
`ClapPostProcessor` Drop で plugin 残留を error log（carry-forward #1 検知点）/ double-load guard
（`AlreadyLoaded`）/ `parse_midi_channel` レンジ検証 / eprintln→tracing / mutex-poison を warn で区別。
test 追加（非ステレオ mux ×5・post_peak 不変式・CLAP error code/channel）。**Commit 8fa7c41**。

**/code:pr-review-team（4専門・round 2）**: round-1 で足した新規コードを再レビュー。**Critical 0 / Important 3**:
1. (code-reviewer opus) `config.rs` `main_port_index` が CLAP ループ index を保存するが `discovered` は
   `get()==None` をスキップした filtered list → 早いポート欠落 + 後のポート IS_MAIN で境界外参照 → audio
   thread（cpal C callback）で panic = プロセス abort。push 直前の `discovered.len()` を保存して修正。
2. (silent-failure-hunter opus) `process_error_count` が production で write-only（誰も読まない）→ effect=dry /
   instrument=無音 の失敗が不可視。既存 1Hz ticker に `CLAP_PROCESS_ERROR` WARNING を配線
   （`LINK_EGRESS_DROP` パターン踏襲・defer せず実配線）。
3. (pr-test-analyzer) `ClapTeardownGuard` timeout 経路に unit test 欠如 → 実 plugin 不要の timeout/early-exit
   test 2 本追加（deadlock 防止保証・while 条件反転検知）。
Minor 採用: velocity を 0.0..=1.0 に clamp / pre-load note が黙って drop される旨の doc note / gated に
double-load `AlreadyLoaded` assertion / コメント正確性 3 件（`Sender` は Send+Sync で Mutex 理由は rtrb
`Producer` の `&mut`+`!Sync` / carry-forward #1 は本 PR で解決済み・TODO 文言修正 / config warn 括弧は input
fallback のみ該当）。3 経路（effect-error-bypass / double-load / Drop-log）は全レビュアーがコード精読で正しいと
確認・clack source で carry-forward #2/#3 を裏取り。**CI は Rust を実行しない**（npm のみ）ため検証はローカル
cargo + gated 実機 RUN が根拠: clap-host 10 + daemon lib 8（新 teardown ×2 含む）+ 統合 18 + smoke/pcm green・
clippy 新規警告0・fmt clean・gated effect ratio 0.50000（callback_max 481µs）/ synth peak 0.25（263µs）。

**advisor checkpoint ②（Done 宣言前）**: round-2 で足した `CLAP_PROCESS_ERROR` ticker 配線が「全 ticker
DaemonError は注入 seam + テストを持つ」というコードベースの慣習を破っていた（`LINK_EGRESS_DROP`/xrun/device_lost は
全て seam 付き）→ 注入カウンタ `clap_process_errors`（本番常に 0）+ `clap_process_errors_arc()` seam +
`daemon_error_warning_on_clap_process_error` 統合テスト（発火 + 累積数 + latch 非再発火・両 feature config pass）を
追加（`40d0f6f`）。daemon lib 8 + protocol 19 green。

**@claude bot second-opinion（load-bearing seam `8fa7c41..40d0f6f`）= Critical/Important 0**: 4 重点領域
（main_port_index index 修正 / `CLAP_PROCESS_ERROR` 配線 / teardown seam / effect-instrument routing）と 3 proof-only
経路（effect-error-bypass / double-load / Drop-log）を独立精読し、内部 pr-review-team の評価と一致を確認。CI(npm)
`code-review pass`（40d0f6f）。**申し送り Minor 3 件 → 追跡 issue #342**（cutover #108 前の CLAP-hardening: ①install-ring
teardown drain で wrong-thread stop_processing 残余ケース ②動的ポート rescan ③async teardown 時の busy-wait）。

---

### 6.168 docs(notation): MLTS real-time score-display design note (#339) (Jun 26, 2026)

**Date**: 2026-06-26
**Status**: ✅ 設計記録（discussion record・実装なし）
**Branch**: `337-mixer-dsl-design`（docs のみのため同ブランチに同梱・owner 指示）
**Issue**: #339
**成果物**: `docs/development/POST_2.0_NOTATION_DSL_DESIGN.html`

post-2.0 のリアルタイム/静的 譜面表示（MLTS notation）の設計をブレストし記録。三輪氏（音楽家）の
「譜面表示できる？」が発端 → 本物の五線譜が要る・Pitch DSL のみ対象。

**核心 = MLTS（Multi-Layered Temporal Structure）**: 層ごと beat/tempo 独立で小節線が非整列にずれ込む
（polymeter）。現代西洋記譜は共有小節線前提で、VexFlow 素・OSMD・Verovio・MusicXML・LilyPond でも
native に書けない → レンダラ自作必須。

**ライブラリ判断 = VexFlow**（MIT・programmatic で小節線を自前配置＝MLTS に必須・active v5・SVG+CSS アニメ）。
OSMD 不採用（MusicXML/整列小節前提・VexFlow の上）/ Verovio 不採用（LGPL+整列前提+WASM 重）/ publication=
LilyPond だが MLTS は LilyPond でも frontier → MLTS は拡張 VexFlow が正攻法（live+publish 統一）。

**real-time = 自前**（engine が timing 駆動・VexFlow は描画+カーソル overlay・cursor は transport から駆動）。
**データブリッジ = engine 非依存**（interpreter getState の timedEvents+pitch / resolveDegree / per-seq
beat/tempo/length / transport / midi-run / isMidi・最小は polling+WS で core 改変ゼロ）。

**home（後決め・優先は engine cutover）**: 2.0.0 .vsix には載せない / engine 完成後 2.1.0 .vsix で engine
切替 → OrbitStudio を待たず可能性 or OrbitStudio パネル。notation は engine 非依存で home 柔軟。
**当面の優先 = engine cutover（Path A→γ→#108）**。notation build は cutover 後。

**研究新規性**: MLTS 記譜に標準なし → 視覚言語の設計自体が貢献（論文の芽）。

**スコープ**: 本エントリ = 設計記録のみ・実装なし。明日 demo の最小スクリプト（pitch DSL→VexFlow 静的描画）は
gauge-by-progress の脇 spike（engine 開発を邪魔しない範囲・scratchpad）。

### 6.167 docs(engine): mixer / routing / effects / automation / module DSL design note (#337) (Jun 24, 2026)

**Date**: 2026-06-24
**Status**: ✅ 設計ノート作成（discussion record・実装なし）
**Branch**: `337-mixer-dsl-design`
**Issue**: #337
**成果物**: `docs/development/POST_2.0_MIXER_DSL_DESIGN.html`（手書き HTML・既存 specs スタイル）

post-2.0 engine track の **DSL 側未設計領域**（mixer / routing / effects / automation / module）を
owner とブレストし、設計ディスカッション記録として HTML に固定した。engine 側ホスティング（γ/δ）は
`POST_2.0_NEXT_STEPS.html` §3 にあるが、それを DSL からどう叩くか（plugin 呼び出し / effect chain /
send-return / aux / automation / ファイル分割）は未設計だった。

**統合軸**: **reconciliation key = 名前**（宣言的グラフ + 名前キー差分適用。routing / effect ハンドル /
module identity / recovery を束ねる）。

**確定**（このブレスト）: ルーティングの向き=常に source が行き先を指す / routing 4 ノード（source・
sum(group)・aux(send-return)・output(終端)）+ output 2 ドメイン（audio / data=IAC）/ chain 順=信号フロー
（source 先頭・inst=音源置換・play=パターン直交・send 位置=tap）/ automation 3 層（時間決定論 pre-render /
control-rate signal modulation / semantic=north-star 対象外）/ Global 2 分割（project=永続グラフ /
performance=live param tempo 等）/ SOLO(a,b,c)=集合キーワード（RUN/LOOP/MUTE の group-diff 再利用・
multi-solo がタダ）/ mixer 未挙げ項目 全部 in（solo・sidechain入力・PDC・metering・nesting）/
capture seam の用途 3 つ（検証・recovery ギャップ・render/mastering）/ VST は format-agnostic DSL で δ で差込。

**未決 / OrbitStudio-era / engine 必須**は HTML §11 決定台帳に仕分け記録。

**プロセス**: docs-only のため full PR レビュー（simplify + pr-review-team）はオーバーエンジニアリング
（CLAUDE.md）→ スキップ。正規仕様化・実装は別 issue。HTML は well-formed 検証済。

### 6.166 test(engine): A4-PR4 active-loops across-respawn e2e — full DSL / interpreter-driven (#335) (Jun 23, 2026)

**Date**: 2026-06-23
**Status**: ✅ 実装完了（レビュー前）
**Branch**: `335-active-loops-across-respawn-e2e`
**Issue**: #335（A4 PR4・#321 の 4-PR 計画の最終手）
**正本**: `docs/development/POST_2.0_NEXT_STEPS.html` §4（A4 末）/ §5（active-loops follow-up 行）

A4 の最後の1手。#300（recovery floor）が proxy + 構造論で足りるとして**意図的に defer** した
「実 `loop()` を interpreter 駆動で動かし real daemon を respawn 跨いで継続する」検証を、
A4 完了時点で full DSL 全部入りで consolidation する（recovery consolidation・defer backlog 一掃）。

**スコープ（test-only・production 変更ゼロ）**:
- 既存 `tests/audio/rust-engine/real-daemon-recovery.spec.ts`（#300 gated kill-test）を **scaffold に拡張**。
- 実 `InterpreterV2` に、onDispatch を得るために直接構築した実 `RustEnginePlayer` を注入
  （= `createAudioEngine(rust)` と同じ player・leg2 の RecordingScheduler 注入と同じ seam）。
  spec の「createAudioEngine 経由」= 実 interpreter + 実 player 経路の意（§4/§5 を spec-first で明確化）。
- fixture = full DSL（pan / chop 領域 / per-event gain / **varispeed rate≠1.0** / LinkAudio output
  channel / tempo leader）の `LOOP()` を回す `.orbs`。

**scout question の結論（observability seam）**:
- `daemonPid` / `getDaemonStatus()` / `injectDaemonFault()` / `isRunning` は player に public 既存・
  `onDispatch` も options に既存 → **観測 seam は既存**（§6 の production 追加例外は不成立）→ test-only。
- 観測境界: `DispatchInfo` は timing + `gain` + sample のみ surface。**pan / rate / output_channel は
  `daemon.playAt` へ渡り respawn 跨ぎで exercise されるが onDispatch/GetStatus に出ない**ため値は
  state-assert しない（per-param 正しさは PR1-3 offline + 下記 rate guard が担保・capture は §6 で OUT）。

**テスト構成（2 層）**:
- 非gated（CI 常時・daemon 不要）= fixture-integrity guard: RecordingScheduler で interpreter の
  スケジュールを取り、`toDaemonParams` で **chopd=varispeed rate 2.0 / kick・snare=rate 1.0 /
  pan 3 値 / gain 3 値** を機械チェック（"full DSL" 主張が hollow にならない保証）。
- gated（`ORBIT_REAL_DAEMON=1`・ローカル）= recovery e2e: LOOP() → 実 daemon SIGKILL（mid-loop）
  → auto-respawn → **dispatch 継続を state-level に assert**（liveness/新 pid / transport 再 anchor /
  onset clip なし / 複数 sample で loop 群復帰 / per-event gain 保持 / fresh daemon 状態）。
- daemon は default build（feature `link-audio` OFF）。setLinkTempo / output channel は warn-once
  no-op（hardware bus へ）で loop を stall させないことを実機で確認（LinkAudio 自体の recovery は
  観測 seam 不在のため非検証）。

**検証**:
- gated kill-test を **ローカルで 3 回連続 PASS**（各 respawn attempt 1/5・~5.6s）。
- 非gated guard PASS / npm 全緑（**1188 passed | 28 skipped**）/ cargo `--workspace` 全緑（rust 無変更）。
- SC 既定経路 無改変 / audio `play()` 意味論 無改変 / production code 無変更。

**主な変更ファイル**:
- `tests/audio/rust-engine/real-daemon-recovery.spec.ts`（#335 拡張・非gated guard + gated e2e）
- `docs/development/POST_2.0_NEXT_STEPS.html`（§4/§5 を「createAudioEngine 経由」= 実 player 注入と
  spec-first で明確化・"stretch"→"varispeed"）

A4 完結（PR4 マージ）で #300/#304 の defer backlog は一掃（残るは capture seam と bot Finding 4
= quit backoff の 2 件のみ・いずれも trigger 待ち）。

**レビュー（/simplify）**: 4 cleanup agent（reuse/simplification/efficiency/altitude）適用 —
recovery 不変式を `assertRecoveryInvariants` ヘルパに抽出（#300 runKillTest と #335 で共有・
~25 行重複を解消）/ 非gated guard の `toDaemonParams` を play ごと 1 回にキャッシュ。
skip: 公開 `dispose()` 追加（§6 scope fence = 観測 seam でなく lifecycle・cast は shutdown.ts 前例で
許容）/ `if(!preKillPid)throw`（dead でなく TS narrowing・コメント追記）。適用後 gated 4 テスト全緑。

**レビュー（/code:pr-review-team）**: 4 専門 reviewer（code-reviewer/silent-failure-hunter/
pr-test-analyzer/comment-analyzer）。Critical 0。Important 3 を解消 →
① afterEach を try/finally 化（seq.stop() throw 時も実 daemon を quit・leak 防止）/
② recovery wait を件数（killMark+N）から **sample 多様性（3 seq 全復帰）** に直結し `postSamples===3`
（chopd が 8 ev/bar と密で件数 wait だと kick/snare 復帰前に満たされる decoupling を解消・flake 除去 +
全 loop 復帰を検証）/ ③ chop(1) は slice 経路を bypass する旨へコメント修正（comment-analyzer）。
併せて Minor: uptime 判定を wall-clock 経過基準へ（長い recovery 待ちでの margin 痩せ対策）/ teardown
cast を不在 throw + `?.` 除去で silent-skip 防止 / pan を厳密値 set で固定 / "per-event"→"per-sequence"
gain ラベル統一。skip: post[0] stale（SIGKILL 即時で sub-ms 窓・post[0] discriminator 維持）。
適用後 gated 4 テスト全緑（#335 stricter `===3` を複数回安定 PASS）。

### 6.165 feat(engine): A4-PR3 Link tempo leader — Rust daemon + TS wire (#333) (Jun 23, 2026)

**Date**: 2026-06-23
**Status**: ✅ 実装完了（レビュー前）
**Branch**: `333-linkaudio-tempo-leader`
**Issue**: #333（A4 PR3 Link tempo leader）
**PR**: #334

`global.tempo()` を Ableton Link セッションに push し OrbitScore を Rust 経路
（`ORBITSCORE_ENGINE=rust`）の Link tempo leader にする。SC 経路は既に動作中（#283）で、
本 PR は Rust 経路の no-op を実装して parity を埋める（net-new・新規 GPL 面ゼロ）。
tempo FFI（`set_tempo`/`session_tempo`）は A4-2b で GPL 隔離 crate に既存だったため、
残作業は wire + handle-ownership/threading + tempo-change re-anchor に絞られた。

**Rust 実装（threading seam・Opus 直列・advisor 設計確認済）**:
- **論点1 handle 共有 = 案A + newtype**: `orbit-link-audio/src/lib.rs` で `LinkAudioOutput` を
  `Arc` 共有可能化（`unsafe impl Sync` 追加・SAFETY を「app-state path=control / audio-state
  path=consumer の disjoint thread role を Link が内部同期」で根拠付け）。control 側は
  `LinkTempoControl(Arc<LinkAudioOutput>)` newtype で `set_tempo` のみ公開し audio-state
  メソッド（commit/capture_beat/session_tempo）を型レベルで隠蔽（`set_tempo` は `pub(crate)`）。
- **論点3 re-anchor = poll-based**（advisor が当初の explicit 推奨を撤回）: `egress.rs` で consumer が
  毎 pump `session_tempo()` を poll し、変化検出で segment baseline（`seg_anchor_beat`/
  `seg_anchor_produced`/`beat_per_frame`）を切り替える。Link は last-setter-wins なので自分の push も
  他ピア（Ableton 等）の変更も追従する（explicit を包含・control→consumer 同期配線不要）。**`capture_beat()`
  を再呼びしない**連続 carry（ring latency 位相誤差の再導入を回避・advisor の load-bearing detail）。
  境界での beat 連続 + slope 変化を単体テストで固定（`reanchor_is_beat_continuous_and_changes_slope`・
  `reanchor_slowdown_reduces_slope_but_keeps_continuity`）。
- **論点2 blocking = spawn_blocking**: `session.rs` の `SetLinkTempo` arm が `set_tempo`（内部
  `captureAppSessionState`・非RT・block しうる）を LoadSample と同様 spawn_blocking で隔離する
  （tokio worker を塞がない・app-state path を audio スレッド外で実行する Link 制約も満たす）。
- daemon `link_audio.rs`: `LinkAudioControl` が `LinkTempoControl` を保持、`consumer_loop` は
  `Arc<LinkAudioOutput>` を所有（teardown = `orbit_link_destroy` は app-side cleanup〔enable(false)+
  delete〕で audio-thread 非依存＝shim 確認済のため、last-Arc-drop が consumer 外でも安全）。
  `engine_wrap.rs`: `set_link_tempo(&self)`（feature 有 = `as_ref` で `set_tempo` / 無 =
  `LINK_AUDIO_UNAVAILABLE` stub）。
- **lifecycle 決定（MVP）**: tempo-lead は Link subsystem up（feature `link-audio` 起動・
  `LinkAudioControl` spawn 済）を要する。active channel 0 でも可。channel 完全非依存の単独 leader への
  decouple は defer。
- **license**: tempo API は既に `orbit-link-audio` 内＝**新規 GPL 面ゼロ**。`cargo deny check licenses`
  ok（default graph GPL-free 維持）。

**Rust テスト**: `orbit-link-audio` 9 passed（re-anchor 連続性 2 件含む）/ daemon lib 6 passed +
integration 18 passed / `cargo test --workspace` 緑。

**TS 実装内容**:
- `protocol-types.ts`: `CommandMethod` union に `'SetLinkTempo'` を追加（Rust daemon 名と一致）
- `daemon-client.ts`: `setLinkTempo(bpm: number)` メソッドを追加 — `this.request('SetLinkTempo', { bpm })` パターン
- `rust-engine-player.ts`: `GapKind` に `'linkTempo'` 追加・`freshWarned()` に `linkTempo: false` 追加・`setLinkTempo` no-op を実装に差し替え（`LINK_AUDIO_UNAVAILABLE` = warn-once 握り潰し、`LINK_AUDIO_RUNTIME` = rethrow）
- `mock-daemon-server.ts`: `MockDaemonHandlers` に `SetLinkTempo?: MockHandler` 追加
- `daemon-client.spec.ts`: 2 テスト追加（bpm params 送信・UNAVAILABLE 変換）
- `rust-engine-player.spec.ts`: 3 テスト追加 + defaultHandlers に SetLinkTempo デフォルト追加（registerLinkAudioChannel と対称）

**技術的決定**:
- GapKind を `'linkTempo'` で分離（`outputChannel` と共用しない）— channel 登録と tempo push は独立した warn サイレンス単位
- defaultHandlers() の SetLinkTempo デフォルトが LINK_AUDIO_UNAVAILABLE を投げる — boot() 単体で warn-once パスを自動カバー
- Rust 側依存点: method 文字列 `'SetLinkTempo'`・params `{ bpm: number }` が確定済みインタフェース

**テスト結果**: 全 1187 テスト green（27 skipped は既存）

**レビュー（/simplify・4 観点並列）**: reuse / altitude = clean（altitude は poll-based re-anchor を
「the strongest altitude win」と評価）。適用 2 件:
- **simplification**: egress.rs の anchor / re-anchor が同じ 4 フィールド更新を重複 →
  `start_segment(anchor_beat, produced, bpm)` ヘルパに集約（segment invariant を 1 箇所に）。
- **efficiency**: `session_tempo()` を per-channel `pump_once` で N 回読んでいた → consumer_loop の
  round ごと 1 回に hoist し `pump_once(&output, session_tempo)` へ snapshot を渡す（session-global な
  値の N FFI reads/round → 1・correctness は各 channel が自分の `last_bpm` と比較で保持）。
- skip: F-1（commit 内の二重 `captureAudioSessionState`・ABI 変更が要る design-level・informational）/
  エラー文字列重複の const 化（never-parsed の cosmetic）/ `set_link_tempo` の mutex lock（tempo 変更は
  稀で benign・audio-side disjoint は無傷）。
- 適用後: orbit-link-audio 9 passed + daemon lib 6 passed + clippy clean（diff 内）。

**レビュー（/code:pr-review-team・4 agent 並列 + CI）**: CI green（Build / code-review）。Critical 0。
Important 6 件を fixer で解消（advisor 確認後）:
- **SF-1（silent-failure）**: shim `orbit_link_set_tempo` が void で **false-positive success** → `int` 返り値化し
  `LinkAudioOutput::set_tempo -> bool`・`false` を `WrapError::LinkAudio`(runtime) に昇格。push が silent fail
  すると MIDI（`global.tempo()` free-run）と Link-audio egress（古い session tempo を poll）が別 tempo に乖離
  するのを防ぐ。既存 `LINK_AUDIO_RUNTIME` taxonomy に乗る・**新規 GPL 面ゼロ**。
- **CR-1（code-review）**: `commit_channel`/`capture_beat` を `pub(crate)`（egress.rs のみ）。`session_tempo`/
  `register_channel`/`set_enabled` は cross-crate で daemon が呼ぶため `pub` 維持。SAFETY コメントを
  「型で締まる分（pub(crate)）」と「呼び出し規律で守る分（pub・consumer/control thread）」に正直に書き分け。
- **CR-2**: bpm に sanity 上限 `MAX_LINK_BPM=999`（`+Inf` 伝播 / `beat_per_frame` overflow 防止・下限なし）。
- **CM-1（comment）**: /simplify の hoist で stale 化した struct doc（「tempo poll は pump_once」）を修正。
- **PT-1（pr-test）**: re-anchor trigger を pure `reanchor_beat_on_change` に抽出し device-free に sequence
  テスト（anchor→steady→change→epsilon→capture 例外。trait/mock は over-engineering として回避・advisor）。
- **PT-2**: `validate_bpm` を pure 抽出 + 単体テスト。
- comment 改善 3 件（SAFETY に `session_tempo` Thread-safe:no 追記 / teardown コメントを「最後の Arc」/
  engine_wrap の `as_ref` を interior mutability 説明に）。
- 検証: orbit-link-audio 10 + daemon lib 7 + integration 18 passed・clippy clean（diff 内）。
- **再レビュー（silent-failure + pr-test 再実行・advisor 指示の one-time closure check）**: SF-1 / PT-1 / PT-2 すべて
  **resolved** を再確認。新規 SF-2（global.ts:265 の `.catch` が opaque log）は **defer**: `DaemonProtocolError` が
  `super(`[${code}] ${message}`)`（errors.ts:45）で code+message をレンダーするため既に有用＝opaque でない。warn-once
  再設計は never-path（set_tempo は no-peer でも success・Link 例外でのみ false）への過剰設計 + global.ts は SC/Rust
  共有のため **reject**（advisor）。SF-3（pre-existing・Minor）= shim `orbit_link_session_tempo` の catch に fprintf を
  追加し set_tempo と observability を対称化（1行）。SF-4 benign（None は production unreachable）。**内部レビュー
  closed**（毎修正後の再レビューは LLM が必ず新指摘を出す非終了ループ＝substance 収束で閉じる・advisor）→ 外部
  closure は @claude bot（load-bearing seam: unsafe Sync の call-discipline / FFI bool contract / poll re-anchor）。
- **外部レビュー（@claude bot・load-bearing seam スコープ・3m57s）**: 3 点すべて ✅ 問題なし — ① `unsafe impl Sync`
  健全（型レベル + 抽象層で cross-thread 誤呼びが閉じている）② FFI bool contract end-to-end（false-positive success
  なし・false は全段 rethrow・ピン留めテスト付き）③ poll re-anchor continuity（tempo 変化点で `new_anchor` が旧 slope の
  beat と同値＝数学的に連続・`capture_beat()` 非再呼びで ring-latency 誤差を再導入しない）。実質的 blocking なし。唯一の
  minor = SAFETY コメントに `num_peers`（test-only・Thread-safe:yes）が未言及 → 1 行追記で対応。**Critical/Important=0・
  bot 承認**。owner マージ待ち（self-merge しない）。

### 6.164 feat(engine): A4-2b-2b dynamic N-channel LinkAudio registration (pool + readiness race / #331) (Jun 23, 2026)

**Date**: 2026-06-23
**Status**: 🚧 WIP（core N-channel egress 実装完了・実機 multi-channel 層B PASS）。branch `331-linkaudio-dynamic-registration`（未マージの 2b-2a #330 にスタック）
**Parent**: #331（design 決定は issue コメント）/ 2b-2a #330（owner マージ待ち）

**スタック注意**: 本 branch は未マージ・owner 未承認の #330（`329-linkaudio-egress-rtrb`）上にスタック。owner が 2b-2a をレビューで変更したら rebase する。

**design-first（advisor 2 round）の 2 決定**:
- **Fork 1（RT-safe N-slice）= ArrayVec**: callback で render_multi 引数 `&mut [(&str,&mut[f32])]` を per-callback stack `ArrayVec<_, MAX_LINK_CHANNELS>` で組む（fresh local＝call-body lifetime で借用が通る・heap alloc なし）。「closure 所有・clear 再利用 Vec」は **コンパイル不可**（captured Vec は固定 lifetime・`&mut` invariant）。core API 追加も棄却（core が native 型 `LinkChannelActivate` を知ると permissive 境界を汚す）。**gating spike**（`arrayvec_n_channel_slice_builds_from_pool_without_heap`）で call-body `&mut` 借用を実証済。`arrayvec` は MIT/Apache。
- **Fork 2（readiness race）= readiness flag**: load-bearing は benign window でなく **never-drained ring**（consumer が登録しない slot に callback が push・partial-failure で N では reachable）。per-slot `Arc<AtomicBool> ready` を consumer が **Link 登録完了後に set**、callback は ready の channel のみ render_multi/commit 対象にする → never-drained-ring が**構造的に不可能**（登録失敗→ready 立たず→push せず）。コスト = slot ごと relaxed load 1 回。

**実装**:
- native `output.rs`: `LinkChannelActivate` に `ready: Arc<AtomicBool>` / `LinkEgress { channel: Option } → { channels: Vec }`（cap `MAX_LINK_CHANNELS`=64 で control 強制・callback で log しない＝RT 安全）/ `render_block` を ArrayVec N-channel + skip-not-ready 2-pass（render_multi → 借用解除 → sink commit）。link 有り時は 0-ready でも `render_multi(hw, &[])`（`engine.render` に落とすと channel-tagged event が hardware に bleed）。`pub const MAX_LINK_CHANNELS`。
- orbit-link-audio `egress.rs`: `LinkChannelEgress` の **`LinkAudioOutput` 所有を解消**（consumer thread が 1 output を持ち複数 egress を回す）・`pump_once(&mut self, output: &LinkAudioOutput)`・**per-channel anchor を維持**（各 channel が自分の first-pump で capture・session 単位に hoist しない＝advisor Point 2）。
- daemon `link_audio.rs`: `consumer_loop(output, ...)` が `Vec<LinkChannelEgress>` を保持、register cmd で Link 登録→egress push→**ready.store(true)**、全 egress を pump。`LinkAudioControl.registered: HashSet<String>`（冪等）+ cap（`ChannelLimit` error）。`RegisterCmd`/`LinkChannelActivate` に `ready` 共有。`ConsumerState` 状態機械を削除。
- **検証**: full workspace 19 ok・cargo-deny default GPL-free 維持・clippy clean・**multi-channel 層B 実機 PASS**（`layer_b_multi_channel_egress_received`: 2 channel 登録→各 receiver が独立に kick.wav egress 受信・1.7s）+ 単一 channel 層B（2回登録冪等）も維持。

**error-code 分割（本 commit・#329/#331 follow-up を解消）**: `WrapError` を `LinkAudioUnavailable`（feature `link-audio` 無効ビルド / test backend）と `LinkAudio`（runtime 失敗 = `ChannelLimit`/`RegRingFull`/`ConsumerGone`/mutex poison）に分割。`session.rs` が前者を `LINK_AUDIO_UNAVAILABLE`・後者を `LINK_AUDIO_RUNTIME` に map。TS `rust-engine-player.ts` は **`LINK_AUDIO_UNAVAILABLE` のみ** warn-once で握り潰し、`LINK_AUDIO_RUNTIME` 他は rethrow（N-channel で ChannelLimit が reachable 化＝runtime 失敗を feature-gap と誤認しない）。これで S3 が runtime まで含めて完成。test 更新（mock 既定 = UNAVAILABLE / player は UNAVAILABLE 握り潰し + RUNTIME rethrow / daemon-client）。stale な `LINK_AUDIO_ERROR` コメント 4 箇所も更新。TS build 緑・全 spec 緑（52 + 全 1179 passed）。

**PR #332**（base=`329-linkaudio-egress-rtrb` にスタック）作成 → **/simplify 適用**（`b2c2736`: per-channel commit_fail_streak バグ修正〔channel-global は masking〕+ render_block 述語 hoist + overflow debug_assert）→ **pr-review-team 2 round で収束**: round-1 = code-reviewer 0 Crit/Imp（readiness flag Relaxed 順序・two-pass 整合・error-code split 全 clean）/ pr-test-analyzer 3 Important test gap → pure 関数抽出（`channel_egress_active`/`registration_decision`）+ 単体テスト + `wrap_err_to_protocol` テストで解消（`61c6c3c`）/ silent-failure Minor（warn を channel 名に・`channel_id()` 削除）/ comment-analyzer 2 Important + 1 Minor コメント修正（`1367a0e`）。round-2 = code-reviewer + pr-test-analyzer とも **収束確認・0 Crit/Imp**。CI green（`61c6c3c`）・full workspace 19 ok・cargo-deny GPL-free・TS 1179 passed・multi-channel 層B 維持。

**@claude bot（N-channel concurrency 限定・GPL 隔離は #330 から不変で skip）= 3 問すべて承認**: Q1 readiness flag Relaxed で never-drained-ring 排除（ready=true 観測時 consumer は push+pump 到達済・piggyback 依存ゼロ・rtrb acquire/release）/ Q2 mid-callback false→true は benign（commit される scratch は確定ゼロ＝silence 1 block・beat は produced-frames で永続 desync なし）/ Q3 N egress × 1 output は hazard なし（single consumer thread sequential・per-egress 分離・`&output` immutable）。**新規指摘なし**。CI SUCCESS on HEAD `844f846`。

**follow-up 3 件を #332 に畳む（owner 判断「先にやる」）**: ① **#2 scheduleEvent/scheduleSliceEvent の stale「not wired」warn を削除**（egress 配線済みで誤誘導・feature-gap は registerLinkAudioChannel が authoritative・`a82d037`。stopAll 再 arm test は masterEffect vehicle に切替）② **#1 VerificationReceiver lifetime を PhantomData で型強制**（host-outlives-receiver を compile-error 化・2b-2b で receiver call site 増＝now-relevant・両 gated path 緑・`a5614f8`）③ **#3 LinkEgressStats: ring-drops を 1Hz ticker で surface**（silent-failure が 2a+2b で挙げた・control が drop counter clone 保持→`total_ring_drops`→EngineWrap→session ticker が増加で `LINK_EGRESS_DROP` WARNING DaemonError event・`4d9dd44`）。**⚠️ 追加分（`7777c27`+`e916cdc`）の当初レビューは hand-roll だった（2026-06-23 訂正）**: `7777c27`=/simplify 由来の `registered: HashMap<String, Arc<AtomicU64>>`（name→drop counter）統合、`e916cdc`=IMPORTANT 2（TS `daemon-error` 未購読 / `LINK_EGRESS_DROP` integration test 欠如）反映、は前セッションで実施したが、レビューは `/code:pr-review-team` skill でなく reviewer サブエージェントを Agent tool で直接 spawn する **hand-roll（CLAUDE.md 禁止）** で行われ、`e916cdc` 後の収束 round も bot レビューも無かった。transcript provenance で確認（`@claude` bot 19:54Z < follow-up commit 21:41/22:14Z・実 skill 起動は 19:19Z が最後）。**正規レビューでやり直し（2026-06-23）= `/simplify` + `/code:pr-review-team` 3 round + `@claude` bot で Critical/Important=0 収束**: 検出・修正 = (a) **silent-failure**: `link_egress_ring_drops` の `try_lock().ok()` が WouldBlock/Poisoned を同一視し poison 時 `LINK_EGRESS_DROP` を恒久抑制 → `match` 分岐・poison は `warn!`（`c66079d`）(b) **test gap 3**: `total_ring_drops` 集約の Arc-identity unit test / `LINK_EGRESS_DROP` latch 非再発火 / `onDaemonError` respawn 再購読の単発（`c66079d`）(c) **comment 矛盾**: `link_egress_drops` の「`record_xrun` と同型」誤記を訂正 + DRY helper `daemon_error_event`（`cf17272`）(d) **Round2**: respawn test の `waitFor` 誤キー `timeout`→`timeoutMs` + fatal→`console.error` 被覆（`0f50c0f`）。検証: daemon 18 passed（両 feature config・新 link-audio unit test 含む）/ TS player spec 40 passed / cargo check 両 config clean / cargo-deny `licenses ok`。defer = poison 経路 test（Minor 4/10・poison 注入 seam 過剰・`warn!` で observability 確保）。

**PR2b 完了**（2b-1 #328 MERGED + 2b-2a #330 owner マージ待ち + 2b-2b #332 owner マージ待ち）。**owner handoff（merge 順）**: **#330 を先にマージ** → #332 は base を main に retarget。2 PR・順序あり・両 green。**マージは owner の明示指示待ち**。**残 follow-up**: 完全な LinkEgressStats（per-channel breakdown 等）は CLAP 統合/cutover #108 前の拡張余地。

### 6.163 feat(engine): A4-2b-2 LinkAudio egress — design + Q4 gate + shim beats_at_begin (WIP / #329) (Jun 23, 2026)

**Date**: 2026-06-23
**Status**: 🚧 WIP（design-first 完了 + Q4 gate POSITIVE + 第1増分 = shim beats_at_begin 改修・standalone 3 緑）。本ブランチ `329-linkaudio-egress-rtrb` 継続中
**Parent**: #321 / A4-2b-1（#327・PR #328）**MERGED**（`f8ab0de`）

**背景**: A4-2b-2 = 実 LinkAudio egress（音が実際に Ableton/Link に届く半分）。GPL crate `orbit-link-audio`（#324・PR #325 MERGED）を実配線。

**design-first（3 scout + advisor）**: 3 スレッド lock-free アーキ確定 — ① cpal callback(permissive・!Send): render_multi で hardware + N channel buf を埋め per-channel rtrb producer へ push ② GPL consumer thread(feature 裏・Send): rtrb consumer drain → commit_channel（= Link "audio thread"）③ control(EngineWrap): registration command を ring 経由で配る。rtrb は permissive↔GPL の物理境界（Producer=Send→callback / Consumer=Send→consumer thread・clap-spike scout で両 Send 確認）。

**Q4 gate（層B headless 検証可否）= POSITIVE**: 同一プロセス内 **2 LinkAudio インスタンス** loopback spike を実機実行 = `maxPeersA=1 maxPeersB=1 / channel_seen=1 / received=318 callbacks / frames=39750`（discovery ~550ms）。A(sink) commit を B(source) が headless 受信成功。→ **層B は headless で gate 可能**（テストで 2 つ目の LinkAudio を receiver に）。単一インスタンス自己 loopback は不可（`channels()` は peer のみ・自 sink は self-list せず）。CI（Linux/network 制限）では multicast 不安定 → #300 kill-test と同じ **gated pattern**（local 実行・CI skip / discovery timeout）。

**advisor の split（#329 コメントに記録）**: 2b-2 は racy 3-thread で最難部 offline 検証不可 → **2b-2a = 最小実証 egress**（shim beats_at_begin + GPL consumer + render_multi を callback に配線〔RT refactor は 2b-2a〕+ 1 channel end-to-end + gated 層B/manual・**drop = 永久 beat desync なので produced-frame anchor or drop で mandatory re-anchor**）/ **2b-2b = dynamic mid-stream registration**（2 cmd-ring + pool slot-activation + race を隔離）。channels は boot 時 stream 構築で静的になり得ない（mutable registry 必須）。

**beat anchoring（advisor・empirically-validated）**: session tempo 1 回 capture（default 120）→ 線形再構成 `beats_at_begin = beat_anchor + (produced_frames - frames_anchor) × (bpm/60)/sr`（per-block "now" を使わず ring latency 位相ずれを避ける）。`sr` は render/device SR = commit の sampleRate。tempo-change re-anchor は PR3（premature）。**層A 検証不可**（PCM は beat timestamp を持たない）→ 層B（2 インスタンス受信の Info.beginBeats）/dog-food。

**増分 1**: shim `orbit_link_commit_channel` に `beats_at_begin: f64` 引数追加（内部の `beatAtTime(clock().micros())` 削除・`captureAudioSessionState` は bh.commit の state 用に残す）。hpp/cpp/Rust FFI/wrapper/smoke test 更新。

**増分 2（GPL consumer + beat anchoring・本 commit）**: shim に anchor 用 getter `orbit_link_capture_beat`/`orbit_link_session_tempo`（consumer thread = audio thread から 1 回 capture）。`LinkChannelEgress`（egress.rs）= rtrb `Consumer<f32>` を drain → `beats_at_begin` を **produced-frames から線形再構成**して commit。**advisor の最大 catch（drop = 永久 beat desync）を解決**: `produced_frames = drained + dropped`（drop counter 算入）→ drop 後も beat が producer の真の位置を追う（drained-only だと恒久ずれ）。beat 再構成を **Link 非依存の純関数**（`produced_frames`/`reconstruct_beat`）に分離し unit-test（drop-desync 防止を pin・計 7 緑）。orbit-link-audio に rtrb 依存追加（permissive・consumer 側）。

**増分 3（層B receiver shim + 実 egress 実機証明・本 commit）**: shim に **verification 専用** receiver（`LinkAudioSource` wrapper・`OrbitRecv`・`orbit_link_recv_*`。production egress は sender-only〔spec §8.1〕なので receiver は出荷せず headless 検証専用）。gated 層B テスト `layer_b_egress_received_by_inprocess_receiver`（`#[ignore]`・local で `--ignored` 実行・CI は multicast 不安定で skip）= 同一プロセスに A=sender egress / B=receiver の 2 LinkAudio を立て、`LinkChannelEgress` 経由の **実 commit** を B が headless 受信することを検証。**実機で PASS**（既知 0.2 サンプルが ring→drain→beat 再構成→Link commit→receiver まで到達）。**2b-2a egress core = 実音が Link receiver に届くことを proven**。通常 `cargo test` 7 passed + 1 ignored。

**増分 4（RingTapSink を native へ port・本 commit）**: orbit-clap-spike の `RingTapSink`/`PostMixSink` を `orbit-audio-native/src/link_audio_ring.rs` へ port（rtrb 境界の **producer 側**・permissive）。`push_partial_slice` で wait-free push・満杯時は drop カウント（GPL consumer の produced-frames 算入と対）。native に rtrb 依存追加（permissive）。unit-test 2（push/consume・drop カウント）= native 18 緑・cargo-deny default GPL-free 維持。**これで rtrb 境界の producer(native)/ consumer(orbit-link-audio `LinkChannelEgress`)が両方揃った**。

**増分 5（render_multi を cpal callback に配線・本 commit）**: `orbit-audio-core` に `Engine::render_multi`（try_lock 競合で hardware + 全 channel buffer をゼロ＝既存 silent-drop 規約を multi-buffer に拡張）。native `output.rs` を refactor — `LinkChannelActivate`（control が ring 生成・scratch 事前確保して reg-ring 経由で callback へ渡す activation メッセージ）/ 私有 `LinkEgress`（reg-ring consumer + 単一 channel〔2b-2a〕）/ `render_block`（reg-ring を drain→render_multi で hardware + channel scratch を 1 パスで埋め→`RingTapSink::commit` で ring push・`link` 無しなら従来 `engine.render` でビット同一）/ `start_default_output_with_link_egress(reg_capacity)`（`Producer<LinkChannelActivate>` を返す・feature 裏 daemon 用）。4 sample-format branch は全て `render_block` 経由に統一。native 18 緑・full workspace 19 ok group 回帰なし・clippy clean・daemon `--features link-audio` ビルド可・cargo-deny default GPL-free 維持。

**増分 6（daemon 配線 + 実 callback 駆動 層B 実証・本 commit）**: daemon に `#[cfg(feature="link-audio")] mod link_audio` を新設。① `LinkAudioControl`（control-side）= `LinkAudioOutput` を生成・enable し **GPL consumer thread** を spawn（`consumer_loop`: `Waiting(LinkAudioOutput)→register_channel→id→Active(LinkChannelEgress)` の状態機械・pump ループ）。`register_channel` で `RingTapSink` 生成→ **consumer+drops を mpsc で consumer thread へ / sink+scratch を reg-ring で callback へ**。② `LinkAudioGuard`（drop で shutdown フラグ store(true)+join＝明示 teardown・drop 順非依存・A0 §13）。③ EngineWrap: feature 時 `start()` が `start_default_output_with_link_egress`+`LinkAudioControl::spawn`→`StreamGuard{_stream, _link}`（field 順は意図的: stream を先に止めてから consumer thread を join・rtrb はどちら順でも UB なしだが無駄な drop を避ける）。`register_link_audio_channel`（非 feature は stub で `LINK_AUDIO_ERROR`）。`now_sec` 委譲を追加。④ session.rs `RegisterLinkAudioChannel` command + `wrap_err_to_protocol` に `LinkAudio` arm。⑤ orbit-link-audio に feature `verification-receiver`（default off）= receiver を `pub mod verification`（`VerificationReceiver`）に単一ソース化（lib.rs の私有複製を除去・self-test も feature gate）。⑥ daemon feature `link-audio-verification`（default off）+ **実 callback 駆動の 層B unit test**（`EngineWrap::start()` 実 cpal+consumer thread→register→receiver 購読→kick.wav を channel=loopD に tag して `play_at`→**実 callback が render_multi で channel buffer を埋め ring へ**→consumer drain→Link commit→receiver 受信）。

**層B Done 基準 = 実機 PASS（1.56s）**: 合成 ring feed（既証明）ではなく本 sub-PR の新規コード（`render_block`/`render_multi` in callback + EngineWrap consumer 配線）を end-to-end で通す。前提として callback が headless で **tick**することを native probe `start_default_output_callback_ticks_headless` で実機確認（stream が開くだけでなく now_sec が前進＝render が回る）。`cargo test -p orbit-audio-daemon --features link-audio-verification -- --ignored`。**回帰**: full workspace 19 ok・cargo-deny default GPL-free 維持（verification/link-audio-verification とも default off で default graph 不変）・clippy clean（default/feature 両方）・daemon default ビルド可（stub）。

**beat anchor の既知 constant offset（advisor #4・PR3 defer）**: `pump_once` は anchor を first-pump-with-data（T1）で capture するため ~1 ring-fill 分の latency が anchor に焼き込まれる。これは **drift ではなく一定オフセット**（全 block が同一 anchor を共有し produced_frames で整合）で Link の latency model 内。修正済みの drop-desync バグとは別物。tempo-change re-anchor と合わせ PR3。

**増分 7（TS 配線で .orbs から到達・本 commit）**: TS `protocol-types.ts` の `CommandMethod` に `RegisterLinkAudioChannel` 追加 / `daemon-client.ts` に `registerLinkAudioChannel(channel)` メソッド（`request('RegisterLinkAudioChannel', {channel})`）/ `rust-engine-player.ts` の `registerLinkAudioChannel` を **実 daemon call + try/catch** に（daemon が link-audio 無効ビルド〔既定 permissive daemon〕なら `LINK_AUDIO_ERROR` で reject されるので throw せず warn-once して継続＝channel tag は維持・出力は hardware のみ）。`setLinkTempo` は PR3。TS build 緑・rust-engine-player.spec 緑（MockDaemonServer が未知 method `RegisterLinkAudioChannel` を error 応答 → player catch → warn の経路で従来 assertion 維持）。

**PR #330 作成 → /simplify 適用済**（commit `07c442e`）。

**pr-review-team round-1 修正（本 commit・PR #330）**: 4 専門レビュアー（code-reviewer / silent-failure-hunter / pr-test-analyzer / comment-analyzer）の Critical=0・Important=8 を解消。
- **C1（RT-safety・最重要）**: 同名 channel の**再登録**で callback 側の旧 `LinkChannelActivate`（ring producer）が **RT スレッド上で drop** され ring 不整合で無音化。TS は `sequence.output()` の eager + dispatch で**冪等前提に複数回**登録する設計なので実バグ。`LinkAudioControl` に `registered_channel: Option<String>` を持ち `register_channel` を冪等化（同名再登録は no-op・別名は 2b-2a 単一 channel scope で log+no-op）。層B テストを 2 回登録に拡張して回帰 pin。
- **S1**: `consumer_loop` が `pump_once` の `CommitResult` を全捨て → `CommitFailed`/`ChannelNotFound` を throttle warn（streak=1 と 1000 ごと）。`NoSubscriber` は通常状態で silent。
- **S2**: consumer 側 `register_channel`（Link）失敗を `warn`→`error` に昇格（2b-2a は唯一の登録機会＝以後 dead）。
- **S3**: TS `registerLinkAudioChannel` の catch を `DaemonProtocolError && code==='LINK_AUDIO_ERROR'` に限定し、**別 error class**（daemon 死亡 `DaemonConnectionError` / transport / quit）は rethrow（feature-gap と誤ラベルしない）。**正確には**: `RegRingFull`/`ConsumerGone` も `session.rs` で `LINK_AUDIO_ERROR` に collapse されるため依然握り潰される — ただし 2b-2a は冪等 guard で単一登録＝`RegRingFull` 到達不能・`ConsumerGone` panic site なしで **latent**。error code 分割（`LINK_AUDIO_UNAVAILABLE` vs `LINK_AUDIO_RUNTIME`）は **2b-2b の must-fix**（#329 にコメント記録）。
- **T1/T2/T3**: `Engine::render_multi` の channel routing 非 gated unit test 2 件 / `DaemonClient.registerLinkAudioChannel` の request 送信 + LINK_AUDIO_ERROR 変換テスト / player の warn-once（LINK_AUDIO_ERROR）+ rethrow（その他）+ 受理時 no-warn テスト。MockDaemonHandlers に `RegisterLinkAudioChannel` 追加（既定 = feature 無し daemon を模し LINK_AUDIO_ERROR）。
- **M5**: consumer thread spawn の `.expect` を `LinkAudioError::ThreadSpawn` で Result propagate。
- **M7/M8/M9**: コメント正確性（verification.rs SAFETY に host-lifetime 注記 / link_audio.rs "tokio" ラベルを「daemon tokio task から呼ぶ」に / engine_wrap.rs `link` field doc を「Mutex で `&self` を可能にする」に訂正）。
- **回帰**: full workspace 19 ok・cargo-deny default GPL-free 維持・clippy clean・TS 1179 passed/27 skipped・層B 実機 PASS（2 回登録の冪等性込み）。
- **follow-up（diff 外・本 PR では触らず）**: scheduleEvent/scheduleSliceEvent の `outputChannel` warn は egress 配線前の placeholder（"egress is not wired yet"）で、egress 配線後は stale 化し得る。signal は `sequence.output()`（registerLinkAudioChannel の feature-gap warn or not-enabled warn）が authoritative なので機能影響は無いが、メッセージ整合は別 PR で。

**次（残り）**: advisor → load-bearing な GPL egress なので @claude bot レビュー → 修正確認。**dynamic registration の pool + readiness race は 2b-2b**。**レビューで surface 済**: receiver は verification 専用（sender-only・spec §8.1）だが C++ shim に常時リンク / register_channel 部分失敗 seam（advisor #3）/ beat anchor constant offset（advisor #4・PR3 defer）。

### 6.162 feat(engine): A4-2b-1 single-pass multi-buffer render + channel_name wire (post-2.0 A4 / #327) (Jun 23, 2026)

**Date**: 2026-06-23
**Status**: ✅ 実装 + 全テスト緑（core 39〔既存 35 + render_multi 4: 空channels=render ビット同一 / 1パス routing+sum / **transport 1回進行** / 未登録 channel drop〕・daemon 全緑〔protocol 17 に wire smoke 1 追加〕・full cargo workspace 全緑・npm 1174 passed〔TS wire テスト +7〕）
**Branch**: `327-single-pass-multibuffer-render`
**Parent**: #321（A4 meta）/ A4-2a（#324・PR #325）は **MERGED**（`f68a4d2`）

**背景**: A4-2（GPL 隔離）を advisor 助言で permissive/GPL seam で 2分割。本 PR = **A4-2b-1（permissive・offline 可・単独 merge 可）**: single-pass multi-buffer render + per-event `channel_name` wire + 層A 決定論検証。GPL・rtrb・実 egress は **A4-2b-2** へ。**split 根拠**: offline 決定論検証できる render core を「headless 検証できないかもしれない GPL egress（層B・Ableton/link #50）」の後ろに gate しない。

**mode 所有（scout 確定）**: `Sequence.resolveDispatchChannel()`（`sequence.ts:1136`）が hardware-vs-Link を **TS 側で完全解決**（MIDI/非linkAudio → undefined=hardware / linkAudio + `.output(name)` → channel 名 / linkAudio で `.output()` 欠如 → throw）。**daemon は mode-agnostic**: `channel_name = Some(name)` → Link routing tag / None/空 → hardware。daemon に mode flag 不要。

**実装**:
- **core `Scheduler::render_multi(hardware_out, channels: &mut [(&str, &mut [f32])])`**: 1パスで全 event を走査し hardware_out（channel=None）と各 named channel buffer を同時に埋め、**transport（cursor / master gain ramp / 完了 event 掃除）を1回だけ進める**。N× render_channel の transport 二重進行を恒久解消。既存の per-event 混合を `mix_event_into` に抽出し `render_filtered`/`render_multi` で共有（`render_filtered` は behavior-preserving refactor = 既存 35 テストで bit-identical 担保）。master gain ramp は全バッファに **1回だけ**進めて適用（バッファごとに進めると ramp 多重進行で desync）。未登録 channel の event はどこにも出ない（render_channel の unmatched skip と一致）。`channels` 空なら render() とビット同一。
- **wire（per-event channel_name・mode-agnostic）**: `RustEnginePlayer.scheduleEvent/scheduleSliceEvent` が `outputChannel` を `ScheduledPlay` に格納 → `executePlayback` が `daemon.playAt(..., channel)` へ → `DaemonClient.playAt` が非空時のみ PlayAt JSON に `channel` 追加（空/欠如は省略）→ daemon `session.rs` が `params["channel"]` を解析（""/absent→None coerce）→ `engine.play_at(... channel)`（現状 None 固定を置換）。`engine_wrap.play_at`/core scheduler の channel 層は A4-1 で構築済。
- **本番 render 無改変**（hardware fallback 維持）: render_multi は offline 検証のみで production cpal callback への配線は A4-2b-2。linkAudio mode の event は 2b-2 まで hardware に流れる（A4-1 と同挙動・regression なし）。`registerLinkAudioChannel`/`setLinkTempo` の warn/no-op も維持（egress 未配線で warn は accurate）。

**層A 検証**: core の render_multi cursor-1回進行 determinism（double-advance 修正の実証）+ 1パス routing+sum + 空=render ビット同一 + 未登録 drop。daemon wire smoke（`play_at_with_channel_is_accepted`: PlayAt with channel が session parse を通り PlayStarted = wire が channel を運び parse がエラーにならないことを pin。routing 自体は core/harness が担保・rate と同型の wire 経路ガード）。TS は daemon-client/rust-engine-player の channel 転送を mock で assert（+7）。

**委譲（#298 profile）**: core render_multi（load-bearing single-pass・Opus 直列）+ daemon seam（Opus）+ 検証ゲート（Opus）。TS wire（固定 IF 内の pattern clone + test 配線）= Sonnet 並列・Opus が契約（`channel` JSON field）所有 + 統合検証。

**/simplify（4観点）**: `next_gain_frame` 抽出（ramp 状態遷移の verbatim 重複を `apply_master_gain` と `render_multi` で集約・drift 防止・behavior-preserving）/ render_multi doc 精緻化（「channels 空=render() ビット同一」は channel タグ event が無い場合のみ）。target_idx 二段は borrow-checker 必須で clean、TS spread は idiomatic と確認。**cargo fmt は `-p` でスコープせず workspace 全体を整形し無関係 churn を生むため、編集ファイルのみ revert + 対象 crate のみ fmt し直した**（教訓）。

**/code:pr-review-team（4専門レビュアー・収束）**: Critical 0。Important 2 を反映 = ① **render_multi の ramp 経路 0% 未検証**（全テストが ramp_frames=0 開始）→ `render_multi_gain_ramp_advances_once_and_applies_to_all_buffers` 追加（ramp 1回進行 / hw・channel gain 一致 / channel に gain 適用 を pin・comment が警告する「per-buffer 多重進行 desync」を捕捉）② **`render_channel` doc が render_multi を現在形で『使う』と過剰主張**（実際は production caller 無し）→「A4-2b-2 で移行予定」に時制修正 + `Engine::render_channel` doc 整合。Minor 反映: テスト名 `_is_dropped`→`_is_silent`（実態=無音・event は retain）/ TS warn 文言 `(A4)`→`(A4-2b-2)`「tagged but hardware only」/ render_multi doc に buffer 長前提（release 未チェック・interleaved stride・呼び出し元責任）注記。**2b-2 へ defer**: unknown-channel の retain/drop/diagnostic policy（RT で sampled counter）/ debug_assert の release 安全化（hard-stop でなく RT 安全に）/ RT opts（channel→idx precompute・steady-state gain hoist・start_frame guard を lookup 前に）/ wire→parse→tag の強化検証。非文字列 channel の strict error は lenient optional-param 規約（rate/pan）と一貫で skip。

**スコープ外（A4-2b-2）**: rtrb 本番化（RingTapSink/PostMixSink を permissive 側へ・Producer=native/Consumer=GPL consumer thread）+ GPL consumer が drain→commit_channel + beat anchoring（cumulative-frames から beatsAtBufferBegin 決定論再構成・shim を beats_at_begin 引数化）+ 実 Link commit + production render を render_multi に切替 + registerLinkAudioChannel 実装（dynamic registration: `.output()` は post-start に出現しうる→固定 max-channel pool + 登録 command ring を cpal callback 冒頭 drain）+ 層B headless 受信試行。**beat anchoring は層A 検証不可**（PCM は beat timestamp を持たない）→ 層B/dog-food。**drop policy**: ring 十分サイズ化・万一 drop は re-anchor + log（silent desync 禁止・hard-stop 禁止）。**lock-free 化 = rtrb egress 境界**（scheduler の Arc<Mutex>+try_lock 据え置き）。PR3 tempo / PR4 e2e。

### 6.161 feat(engine): A4-2a GPL isolation crate orbit-link-audio + SC-free C++ shim + cargo-deny gate (post-2.0 A4 / #324) (Jun 22, 2026)

**Date**: 2026-06-22
**Status**: ✅ 実装 + 全テスト緑（orbit-link-audio standalone 2〔FFI smoke: 構築/channel 登録/silence commit no-op/不正 id/tempo/teardown + 内部 null 拒否〕・default workspace `cargo test` 全緑〔回帰なし〕・daemon `--features link-audio` ビルド緑・npm 全緑〔TS 無改変〕）
**Branch**: `324-link-audio-gpl-isolation`
**Parent**: #321（A4 meta）/ 正本: `POST_2.0_NEXT_STEPS.html §3/§4`

**背景**: post-2.0 engine-first / A4（LinkAudio）の permissive-first 第2増分。A4-2（GPL 隔離）は load-bearing かつ大きいため advisor 助言で **PR2a（license-critical gate）/ PR2b（render+rtrb+実 audio+wire）に内部 split**。本 PR は PR2a。

**Step0 ゲート（stop&report・実機検証）= GREEN**:
- **submodule**: `external_libraries/link` populated・tag `Link-4.0`（SHA e9a2e414）・`include/ableton/LinkAudio.hpp` に full audio+tempo API・header-only。
- **SC-free compile**: `<ableton/LinkAudio.hpp>` を SuperCollider 非依存で単独コンパイル成功。
- **link+run**（advisor 指摘で compile に留めず実行まで）: macOS frameworks（CoreFoundation/CoreServices/Security/SystemConfiguration）でリンク → `LinkAudio` 構築 → `enable`（discovery thread・numPeers=0）→ `LinkAudioSink` 登録 → `captureAudioSessionState`/`beatAtTime` → **`BufferHandle::commit()` 実呼び出し（egress FFI surface・no-peer no-op）** → `setTempo`/`commitAppSessionState`（PR3 surface）→ teardown clean・exit 0・hang/prompt なし。
- **license**: Link = `GPL-2.0-or-later / commercial` dual（`external_libraries/link/LICENSE.md` + DSL spec §8.1）。

**本 PR（A4-2a）の実装**:
- 新 crate `rust/crates/orbit-link-audio`（`license = "GPL-2.0-or-later"` 明示・workspace の FairTrade を継承しない・`publish = false`・`[workspace] exclude` で **非 member**）:
  - SC-free C++ shim（`shim/orbit_link_shim.{hpp,cpp}`）を `build.rs`（`cc` crate・`warnings(false)`）で static lib 化 + macOS frameworks link。include 順序の不変条件（LinkAudio.hpp を Link.hpp より先）を踏襲。`packages/sc-link-audio` の SC 結合実装を参照に SC-free 化。
  - C-ABI: `orbit_link_create`/`destroy`/`enable`/`num_peers`/`register_channel`/`commit_channel`（egress 表面・呼び出しスレッドが LinkAudio "audio thread"）/`set_tempo`（PR3 用）。
  - Rust FFI 宣言 + safe wrapper `LinkAudioOutput`（`unsafe impl Send`・`CommitResult` enum）。
- `cargo-deny` + `rust/deny.toml` 新設: default feature グラフ（link-audio off）が GPL-free を assert。allow に permissive + FairTrade のみ・**GPL は意図的に非掲載**。検証: `cargo deny check licenses`（default）= pass / `--all-features`（link-audio on）= **GPL-2.0-or-later rejected で fail**（leak 検出が機能することを逆方向で確認）。
- `orbit-audio-daemon`: `[features] link-audio = ["dep:orbit-link-audio"]`（default off）+ optional path-dep。**本番 render には未配線**（PR2b）。

**設計の要点（advisor 反映）**:
- **Ableton Link は vendored C++（build.rs/cc 経由）で cargo crate ではない** → cargo-deny は Link の GPL を直接は見えない。cargo-deny の役割は ① third-party crate の GPL/copyleft 混入防止 ② orbit-link-audio（GPL 明示）が default graph に現れないこと。**真の保証は構造的**（permissive core は依存行ゼロ・単独コンパイル可）で cargo-deny は backstop。
- **exclude が唯一の正解構成**: GPL crate を member にすると cargo-deny が常時 fail。exclude で非 member 化すると default root から外れ（pass）、permissive crate が誤依存すれば dep として graph に入り検出される。非 member なので package fields はハードコード（FairTrade workspace から意図的に分離）。
- **commit の audio-thread**: rtrb で cpal thread と分離した **GPL consumer thread** が LinkAudio "audio thread" になる（PR2b 配線）。ring latency は beat anchoring に乗るが tempo leader ゆえ可聴上無害（精度要件なし・PR2b/層B で精緻化）。

**/simplify 適用（4観点並列）**: ① shim の単一フィールド `ChannelEntry` ラッパを削除し `vector<unique_ptr<LinkAudioSink>>` に直接化 ② `CommitResult::InvalidArgs` → `ChannelNotFound`（実態=未登録 channel id に即した名前。enum 自体は PR2b consumer drain で no-op/committed 区別が load-bearing なので維持）③ build.rs に Link ヘッダ(`include/ableton`)の `rerun-if-changed` + `ORBIT_LINK_DIR` 上書き（submodule bump 時の stale 回避 + checkout 非依存）。reuse=clean（`thiserror="2.0"` 直書きは exclude 構成の必然）。**PR2b へ defer**: per-block `captureAudioSessionState()` の cache 化（hot path・commit が no-op の PR2a では未顕在・advisor Q4 の決定論 beat 再構成と統合）/ `floatToInt16` の inline・vectorization 確認。**owner へ flag**: cargo-deny gate の CI 配線（現 CI は cargo 非実行 → gate は手動のみ。Rust CI job 追加は infra 判断）。

**/code:pr-review-team 適用（4専門レビュアー並列・2 round で収束）**: round-1 = code-reviewer Critical 1（`commit_channel` の source-slice overread = `maxNumSamples` は宛先上限で src 境界でない → shim に `buf_len` 引数 + `min(num_frames*num_channels, buf_len, maxNumSamples)` clamp + Rust debug_assert）/ Important（① 4 つの extern "C" に例外ガード不在 = C++ 例外が境界越え UB → 全て try/catch ② `bh.commit()==false` が `NoSubscriber` に alias → `-2`=`CommitFailed` 分離 ③ `new()` null peer テスト追加）/ comment Critical（"audio-thread surface" が threading contract を満たすかのような過剰主張 → PR2b scope + Thread-safe:no に修正）。round-2 = 全 4 レビュアー **Critical/Important = 0**（fix が新 bug を生まないことを独立検証: buf_len 引数順序 hpp/cpp/Rust 一致・`-2` mapping end-to-end・隔離 3 leg 健全）。round-2 Minor 反映: destroy/num_peers の silent catch にログ / commit match に明示 `-1` + 未知 sentinel debug_assert / commit コメントの no-op スコープ正確化。**PR3 concern（defer）**: void `set_enabled`/`set_tempo` の `Result` 化（tempo-lead 配線時）。**CI 環境制約**: code-review CI = pass / MERGEABLE・BLOCKED（review 承認待ち）。

**@claude bot レビュー（load-bearing なので起動・scope を GPL 隔離/FFI/SC-free に明示）**: 🔴 1件 = `orbit_link_destroy` の `delete link` が try/catch 外（ファイル冒頭の「Link 呼び出しは throw しうる」前提と矛盾・`~OrbitLink`→`~LinkAudio` が noexcept(false) なら extern "C" 越え UB）→ `delete` も例外ガードで修正。🟡 = ① C++ の `num_frames*num_channels` unsaturated（Rust は saturating）→ **buf_len clamp が吸収して memory-safe**（コメント明記・コード変更不要）② `deny.toml unknown-git="allow"`（clack git dep に現状必要・allow-git リスト化は別 PR・defer）③ `[advisories]` に vulnerability=deny 既定の注記追加。bot 確認済 = GPL 隔離 3層・FFI 例外ガード（delete 除く）・buf_len 三段 clamp・unsafe Send・SC-free 性。

**Done（PR2a 受け入れ基準・達成）**: ✅ default `cargo build`/`test` 緑（orbit-link-audio 非ビルド）・✅ `cargo build -p orbit-audio-daemon --features link-audio` 緑・✅ cargo-deny default = GPL-free pass / leak で fail・✅ permissive crate に依存行ゼロ（構造的境界）・✅ 既存テスト全緑（npm + cargo）・SC 既定経路 無改変・audio `play()` 意味論 無改変。**audio egress 証明は PR2b・tempo lead は PR3**。

**PR2b/PR3 設計 carry-forward（advisor 2026-06-22・本 PR では実装しない・失わないよう記録）**:
- **① beat anchoring**: commit で "now"（`clock().micros()`）を buffer-begin の beat として渡すと、ring latency 分の位相ずれ（receiver 側で δ ずれる）になる。**tempo leader であることは beat 配置と直交で、これを無害化しない**（当初コメントの「tempo leader なので無害」は誤った根拠 → 本 PR でコメント訂正済）。PR2b で cumulative-frames-drained から `beatsAtBufferBegin` を決定論再構成する（efficiency review の指摘と一致）。
- **② threading 分離**: 「GPL consumer thread = Link audio thread」は **未検証の仮定**（link+run gate は peer 無しで実時間 timing を検証できない）。さらに `set_tempo`（`captureAppSessionState` = app-thread・block しうる）は `commit`（audio-thread）と同一スレッドに置けない → **PR3 の tempo 経路は PR2b の egress と別スレッド**。shim が両方を露出していても共有スレッドは前提にしていない。
- **③ PR2b は fresh design**（mechanical 継続ではない）: mode 所有 = `Sequence.resolveDispatchChannel` を読んで TS が hardware-vs-Link を解決し daemon を mode-agnostic に保てるか確認 / RingTapSink の synced 経路 drop は **hard-error 化**（silent drop は beat desync）/ 上記 anchoring・threading。design-first（scout + advisor）で着手する。

**スコープ外（後続）**: PR2b（single-pass multi-buffer render + rtrb 本番化〔synced 経路の drop は hard-error 化〕+ 実 audio routing + wire〔session.rs channel_name + TS stubs〕+ `Sequence.resolveDispatchChannel` の mode 所有確認）/ PR3（tempo leader + 層B）/ PR4（across-respawn e2e）。

### 6.160 feat(engine): A4-1 named-channel routing + sum-by-name on rust mixer (post-2.0 A4 / #322) (Jun 22, 2026)

**Date**: 2026-06-22
**Status**: ✅ 実装 + cargo workspace 全緑（core 単体 5〔routing 分離 / sum 2x / unknown 無音 / unrouted skip / unfiltered 全混合〕+ verify harness 2〔routing 分離・sum-by-name +6dB を実 WAV + region_rms/db_difference で〕。TS 変更ゼロ = npm 影響なし）
**Branch**: `322-linkaudio-routing-sum`
**Parent**: #321（A4 meta）

**背景**: post-2.0 engine-first の parity gap 充填 #2（A3 = PR #320 マージ済の次）。`.orbs` の `outputChannel`（LinkAudio・#209）を Rust 経路で鳴らす A4 の **permissive-first 第1増分**。正本: `POST_2.0_NEXT_STEPS.html §3/§4`。

**Step0（3 偵察 + web spike + advisor + owner 決定）**:
- **parity か net-new か = net-new 確定**: 動く SC 音参照なし（#209 OPEN・`orbitPlayBufLink` SynthDef 未定義）+ scsynth UGen 経路は Rust 非適用 + Rust に tempo 概念皆無・`LinkAudioSink` 無し。Done は「SC 一致」にできず、層A 決定論受信が correct の定義。
- **GPL 面**: 既存 `packages/sc-link-audio` の `link_audio_facade.hpp` は型エイリアスのみ・`channel_registry.cpp` は SC ガード依存でそのまま FFI 不可。`rusty_link` は GPLv2+ かつ標準 Link（tempo）のみで LinkAudio(audio) を wrap しない。→ A4-2 で薄い SC-free C++ shim を新規し sum-by-name は permissive Rust 側に残す（advisor 指摘で GPL 面最小化）。
- **lock-free**: `PostMixSink`/`RingTapSink`/`rtrb` は `orbit-clap-spike`（S1 スパイク）に実証済だが本番未配線。A4-2 で本番へ移植（lock-free 化 + permissive↔GPL 境界を兼ねる）。
- **受信検証**: `LinkAudioSource`（in-process 受信 API）存在だが Link discovery は UDP multicast 依存で同一プロセス/CI 不安定（Ableton/link #50）・SC 側も headless 受信未検証。

**owner 決定（2026-06-22）**: ①検証境界 = 層A headless + **層B も headless 試行**（discovery 不成立なら手動 fallback を報告・stop&report）②GPL 隔離 = feature-gated 薄 crate in-process（default off）③staging = permissive-first 4 分割（PR1 routing+sum → PR2 GPL crate+shim+cargo-deny → PR3 tempo leader → PR4 across-respawn e2e）。

**本 PR（A4-1）の実装**:
- `orbit-audio-core`: event に `channel: Option<String>` タグ追加（`ScheduledSample`/`ActiveSample` + `with_channel`）。`render` を `render_filtered(out, channel_filter)` に refactor（filter=None で従来の hardware sum とビット同一）+ `render_channel(out, name)`（同名 channel は自然加算 = sum-by-name・DSL §8.1.2）。`Engine::render_channel` / `schedule_with_play_id` に channel を thread。
- `orbit-audio-daemon`: `EngineWrap::play_at` に `channel` 引数 + `render_offline_channel`（層A 決定論受信側・cpal 非依存）。wire（protocol channel_name 解析）は A4-2 へ（session.rs は `None` 固定）。
- 「耳」活用: 既存 verify ハーネス（#307/#311 の `region_rms`/`db_difference`）に per-channel PCM を通し routing 分離 + sum-by-name +6dB を実 WAV で検証。

**運用**: GPL/Ableton Link を一切導入しない permissive 増分。SC 既定経路 無改変・audio `play()` 意味論 無改変。Rust workspace は CI fmt/clippy 非 gate（追加コードは周囲スタイルに整合）。

**/simplify 適用（4観点並列）**: ① `render_offline`/`render_offline_channel` を `render_offline_inner(closure)` に共通化 ② `Engine::render`/`render_channel` を `with_scheduler` ヘルパに集約 ③ altitude 指摘で `Scheduler::render_channel` を `pub(crate)` に絞り直接の外部アクセスを閉じる（`Engine::render_channel` は pub + `#[doc(hidden)]` で daemon の `render_offline_channel` から呼ぶため cross-crate 可能）。「混在呼び出し禁止」は呼び出し元責任の prose 規約でアクセス制御では強制されない（A4-2 で RT 配線後に再評価）④ テスト `body` クロージャを `rms_avg` ヘルパに hoist。efficiency = クリーン。test 構造重複（reuse minor）は test 閾値で skip。

**/code:pr-review-team 適用（4専門レビュアー並列）**: code-reviewer = Critical/Important 0。silent-failure / comment-analyzer 指摘 = `Scheduler::render_channel` doc + 本 WORK_LOG ③ の「crate 外へ露出しない」が過大主張（Engine::render_channel は pub・daemon が使用）→ 修正済。pr-test-analyzer 指摘 = sum-by-name が同一 onset のみ → `render_channel_sums_same_name_at_staggered_onsets`（非ゼロ `dst_offset_frames` の `+=` を pin）を追加。latent: transport 二重進行 invariant は prose のみ（production caller 無し）→ A4-2 の single-pass multi-buffer で恒久解消。空文字列 channel `""` vs `None` の wire 意味論は A4-2 で確定。

### 6.159 feat(engine): slice varispeed parity — chop rate≠1.0 on rust engine (post-2.0 A3 / #319) (Jun 22, 2026)

**Date**: 2026-06-22
**Status**: ✅ 実装 + 全テスト緑（npm 全緑・cargo workspace 全緑。core 単体6 = varispeed 5〔rate=1.0 ビット同一 / 倍 / 半 / invalid / fade*rate〕+ stop_all 1、統合 varispeed 1、StopAll protocol 1、TS rate/stopAll/Gap5。PR レビューで fade*rate テスト + stopAll エラー可視化を追加）
**Branch**: `319-slice-varispeed`

**背景**: post-2.0 engine-first の次フェーズ（cutover #108 までの parity gap 充填の1つ目 = A3）。#304（PR #305）が「見かけの parity を作らない」ために rate≠1.0 を 1回 warn + 自然尺に倒した箇所を、実機で尺合わせ再生する。正本: `POST_2.0_NEXT_STEPS.html §4 A3`。

**Step0（2 spike + advisor + owner 決定）**: ① **Signalsmith Rust binding spike** = `signalsmith-stretch`(MIT) が存在し proceed 可（早期採用・production 実績は自前）。② **DSL 意味論 spike**（spec + SC 一次資料）で **核心の再構成**: slice rate≠1.0 の SC parity は SC `PlayBuf.ar(rate: sliceDur/slotDur)` = **純 varispeed（ピッチも動く）**で、pitch-preserving stretch は SC 経路に存在しない → **parity を埋めるのに Signalsmith は不要**。一方 `fixpitch()`/`time()` は SC 未実装の **net-new #213 機能**（Signalsmith FFI + license gate 新設 = 高リスク）。③ 前提誤り訂正: 「cargo deny / deny.toml 前例あり」は事実誤認（リポジトリに不在）。

**owner 決定（2026-06-22・blast radius が決め手）**:
- **Q1 = varispeed-only**。A3 = slice rate≠1.0 varispeed（Rust 内部完結・SC 経路/共有 DSL 表面に非接触・新依存ゼロ）+ 織り込み3件。**fixpitch()/time()/Signalsmith/cargo-deny は #213 follow-on へ分離**（手戻りゼロ: varispeed primitive を後で再利用）。
- **Q2 = time()=varispeed + 将来 stretch() 予約**（spec 方向を記録）。「rate 変化=varispeed」一貫。pitch-preserving は fixpitch+time の合成で得られる。

**varispeed 設計（advisor 承認）**: `ScheduledSample.rate` + 分数読み位置 `read_pos: f64` を導入し、core render を「source を `rate` 倍歩幅で分数走査 + 線形補間」に変更。**rate=1.0 で frac=0 → 元サンプルにビット同一**（既存 slice/pan/fade テスト無改変で通る厳密な一般化）。fade は出力時間（slice_len/rate）で数える。`rate = sliceDuration / eventSlotDuration`（SC `calculatePlaybackRate` と同形）を TS 側で計算し daemon へ送る。出力尺 = `effective_len_frames / sr / rate`（PlayEnded もこの出力終端）。

**seam（TS→daemon→core を一貫）**: `rust-engine-player.ts`（`resolveSliceRegion` を warn から rate 算出へ・`toDaemonParams`/`executePlayback` が rate を渡す・GapKind から `slice` 除去）→ `daemon-client.ts`/`protocol-types.ts`（PlayAt に rate）→ `session.rs`（rate 解析・pan 同様 reject せず 1.0 丸め）→ `engine_wrap.rs`（出力尺 /rate）→ `engine.rs`/`scheduler.rs`（varispeed render）。spec-first で `INSTRUCTION_ORBITSCORE_DSL.md`（slice-fit varispeed §3 + time()/fixpitch()/stretch() §12）と `ENGINE_DAEMON_PROTOCOL.md`（PlayAt rate + StopAll）を先に更新。

**織り込みフォローアップ3件**:
- **daemon hard-stop-all（global）**: core `Scheduler::stop_all()` + daemon `StopAll` コマンド + TS `stopAll()` 配線（disposed/respawning/未接続では skip）。varispeed の rate<1.0 長尺 voice が global stop を跨いで鳴り続けるのを断つ。**per-sequence selective stop（`clearSequenceEvents` の play_id 追跡）は明示 defer**（balloon 厳禁・要 owner 判断＝#319 コメント記録）。
- **Gap5**: quit-during-respawn の CI テスト（mock・respawn backoff 中の quit が clean に終わる）。
- **bot Finding 2**: connect 時 error の二重ログ修正（永続 onError を open 後に attach・connect once を open で detach）。

**検証（Done 基準＝offline 決定論 PCM）**: core 単体（rate=2.0 で倍勾配・rate=0.5 で補間・rate=1.0 ビット同一・invalid rate 丸め）+ **統合**（`verify_schedule_pcm.rs`: 同一 slice を rate=1.0/2.0 で実 `play_at`→render し rate=2.0 が半尺で終わることを PCM の信号終端比で確認）+ StopAll protocol + TS（rate 送信・stopAll・Gap5）。capture seam は含めない（offline で足りる・#300 Step0 の決定を維持）。

**明示 defer**: fixpitch()/time()/Signalsmith/cargo-deny → #213 / capture seam / A4 LinkAudio / γ / cutover #108 / per-sequence hard-stop。

### 6.158 feat(engine): recovery floor — daemon supervision + auto-respawn + 最小 recovery contract (post-2.0 α / #300) (Jun 22, 2026)

**Date**: 2026-06-22
**Status**: ✅ 実装 + 全テスト緑（npm 1162 passed / 27 skipped・cargo daemon 全緑）+ **gated kill-test 2/2 PASS**（SIGKILL hard-death / InjectFault panic clean-exit）
**Branch**: `300-recovery-floor-daemon-supervision`

**背景**: post-2.0 engine track の最初の `/goal2`。owner 決定（2026-06-21・「機能より fundamental を先に」）= α recovery floor（fault ①）。**CLAP/Rust daemon が落ちても TS engine / アプリ全体が引きずられて落ちない**ことを保証する。後続 in-process 楽器（β〜）の安全網でもある（fault ③ = 1st-party in-process crash は①の respawn でのみ捕捉）。pan/slice/per-slice gain は goal1 #304 で実装済 = 再実装しない。正本: `POST_2.0_ENGINE_AND_DISTRIBUTION.md §2.2/§2.5/§7`・アーキ決定 #298（fault 3層 §4）。

**接地した設計前提（コード調査で裏取り）**: 「active loops」を定義する状態は**全て TS 側に在る** — ループの再スケジュールは TS の `setTimeout`（`loop-sequence.ts`・daemon 非依存）、発火待ちキューは `RustEnginePlayer.scheduledPlays`+`liveSequences`。daemon が持つのは disposable な3つ（loaded samples / in-flight voices / transport clock）だけ。→ owner 前提（**権威保持者は TS・daemon は disposable**）が成立。よって supervisor は生存側 = `RustEnginePlayer` に置く（DaemonClient を所有し session 状態の権威を持つ唯一の自然な設置点）。

**Step0 owner 決定（4問・全て推奨案で確定）**:
1. recovery contract = #300 のまま確定（balloon させない）。replay すべき隠れ state は無く（global gain は rust 経路未使用・output device は default）、**active loops のみ replay + 再 anchor だけ**で満たす。
2. fault 注入 = **kill -9（hard-death）+ gated panic コマンド（clean-exit/panic-hook 経路）**。「misbehave synth を segfault に拡張」は daemon が CLAP を非ホスト（daemon CLAP 統合は明示 defer の後続段）なので daemon を殺せない → owner と再設計。supervisor から見れば kill -9 と C-ABI segfault は ws drop に収束。
3. kill-test = **ローカル実機 + 記録した手動 validation（gated・既定 skip）**。CI gate にしない（実プロセス kill は CI で flaky/危険・librosa cross-check と同パターン）。
4. PCM 可聴ギャップ数値化（play --capture seam）は **含めない・state-level Core のみ**（#307 で明示 defer の重い増分）。

**設計（advisor 承認）**:
- **検出（両系統が単一経路に収束）**: `DaemonClient` が「quit() 由来でない ws close」を `daemon-died` event で emit。`intentionalClose` フラグで意図的 quit と crash を区別、`wasRunning` で起動成功後の close のみを死と判定。clean exit（panic hook→exit1）も hard death（segfault/SIGKILL・hook 素通り）も**どちらも ws close に収束**。kill -9 時の ws `error`（ECONNRESET）は永続 listener で吸収し unhandled throw による TS 巻き込みを防ぐ。
- **supervisor（`RustEnginePlayer`）**: `daemon-died` → respawn（single-flight・backoff・上限5回）→ `establishSession`（getStatus 再 anchor + StreamStats off→on 再購読）。同一 DaemonClient を再利用し配線を安定化。
- **唯一 load-bearing な不変式 = 再 anchor の「順序」**: 死後 `clockAnchor` は死んだ daemon の transport（例 2s）を指す。再 anchor 完了**前**に dispatch すると新 daemon（transport=0）へ「2 秒先」を送り 2 秒の desync。→ `respawning` フラグで再 anchor 完了まで `executePlayback` を guard（dispatch を drop = one-shot drop / gap・catch に頼らず順序保証）。`sampleIds` は破棄して lazy 再ロード、`durations` は file 由来で保持。
- **active loops 復帰 = 構造的**: poll ループと TS の loop timer は死を跨いで生存 → respawn 後は自動的に新 daemon へ dispatch 再開。
- **上限到達時**: TS プロセスは落とさず（recovery floor の最終保証）poll ループだけ止め fatal を一度だけ出す。

**fault seam（gated）**: daemon に `InjectFault` コマンド（`ORBIT_DAEMON_ALLOW_FAULT_INJECTION=1` のときだけ受理・既定無効）。panic→panic hook→exit(1)+stderr DaemonError = TS が検出すべき clean-exit 経路を実プロセスで通す。hard-death は外部 SIGKILL（daemon コード0行・panic hook 素通り = C-ABI segfault の忠実な代理）。

**kill-test（#300 受け入れ gate・invariant ベース・実時間 kill は非決定的なので exact-match しない）**: `tests/audio/rust-engine/real-daemon-recovery.spec.ts`（PRODUCTION モード = player が daemon を spawn・所有し supervisor が実際に respawn する経路）。transport を ≥2s 進めてから kill（advisor: t≈0 だと stale anchor≈fresh anchor でバグが隠れる）。検証: (1) liveness=poll 生存・新 pid・loops 復帰、(2) **transport 再 anchor**=復帰後 daemonNowSec が kill 直前より大きく下がる（stale anchor を引きずらない・唯一 load-bearing）、(3) onset clip しない=lead≈lookahead、(4) daemon-side 状態クエリ=fresh uptime / sample 再ロード / active_plays 健全。CI-safe な supervisor 状態機械テスト（mock・respawn 成功/上限失敗の2本）も `rust-engine-player.spec.ts` に追加。

**主な変更**: `DaemonClient`（`intentionalClose`/`daemon-died`/`socket-error` 吸収/`childPid`・`injectFault` seam/handshake orphan-reject 修正）、`RustEnginePlayer`（supervisor: `respawning`/`disposed`/`respawnPromise`・`establishSession`・`respawnLoop`・guard・`onPlaybackError` を respawn 任せに変更・`daemonPid`/`injectDaemonFault`/`getDaemonStatus` seam）、`session.rs`（gated `InjectFault`）、`protocol-types.ts`（`InjectFault` method）、`mock-daemon-server.ts`（`dropConnections`）。

**/simplify（4観点並列）**: 適用 = ① respawnLoop を try/finally で `respawning=false` 単一リセット化 ② dead な `inflightLoads.clear()` 削除（rejected 時に `.finally` で自己削除済み）③ `delay()` inline 化 ④ `InjectFault` の kind 二重デフォルトを unit コマンドへ collapse（YAGNI）⑤ `socket-error` 診断 emit に house style 注記。altitude は構造（supervisor 配置 / detection seam / 同一 client 再利用 / 3フィールド / @internal seam / handshake catch）を affirm。skip = waitFor/定数抽出（gated 統合テストは兄弟 timing.spec と同じく self-contained が house style）・`delay`↔SC `sleep` 統合（SC 経路無改変）。

**/code:pr-review-team（4専門・round 1）**: **Critical 1**（code-reviewer opus + silent-failure-hunter が独立に同一指摘）= respawn の `establishSession` 中に新 daemon が即死すると、getStatus の DaemonConnectionError を anchor=0 で吸収して誤って成功宣言 → 再死の daemon-died が single-flight に吸収され respawnPromise 解決 → 二度と respawn されず dispatch 永久 drop（recovery floor が黙って死ぬ）。修正 = respawnLoop で establishSession 後に `!isRunning()` を確認し retry（`continue`）。Important = `onPlaybackError` に DaemonQuitError 追加 / `socket-error` ghost event を console.warn 可視化 / test gap（再 anchor 不変式・in-flight one-shot 非再発火・quit が respawn 抑制）。Minor = `void ensureRespawn` の安全網 catch / quit の空 catch ログ化。CI-safe mock テスト4本追加（再 anchor desync・one-shot 非再発火・**re-death 回帰**・quit 抑制）。code-reviewer は残りの状態機械（respawning stuck / double-respawn / quit during respawn / intentionalClose race / 順序）を sound と確認。CI（build + code-review bot）pass。**round 2（独立再レビュー）**: code-reviewer(opus) は Critical 修正を実証検証（該当行を revert → re-death テストが wedge/timeout → 回帰テストに牙があると確認）し **CLEAN**。test-analyzer も 4 新テストを非 vacuous と検証し Critical/Important 0。silent-failure の Important 1（`ws-close-error` emit が無 consumer = 実質 silent。round-1 の onError console.warn 化と整合させ console.warn へ）+ Medium 1（re-death `continue` の warn 追加）+ polish（one-shot テストに settle 猶予）を follow-up で解消 → **Critical/Important = 0 に収束**。

**`@claude` bot second-opinion（advisor 推奨・PR #294 前例で internal の blind spot を検出した実績）**: load-bearing seam に絞って起動。**Blocking issue なし**・load-bearing invariant 表は全 ✅（intentionalClose 判別 / wasRunning / handshake catch / respawning finally 順序 / re-death continue / sampleIds vs inflightLoads / single-flight / quit teardown / InjectFault gate）。Finding 1（actionable）= `request()` が CLOSING window で plain Error を投げ `onPlaybackError` の silent-drop を抜け misleading ログ1回（S2 既知 Finding F・correctness ではない）→ `DaemonConnectionError` 化で解消。Finding 3 = executePlayback ガードのコメントが post-guard TOCTOU は catch 任せである旨に触れていない → コメント精度化。Finding 2（connect 時 error の二重ログ・cosmetic）/ Finding 4（quit backoff latency・非問題）は bot 自身が後回し合理的と判断 → defer。

**検証の境界（正直な明記）**: 「active loops 復帰」は **RustEnginePlayer レベルの continuous-stream プロキシ（gated kill-test + mock テスト）+ 構造論**で検証している。loop の再スケジュールは `loop-sequence.ts` の setTimeout（純 TS・daemon 非依存）なので daemon 死の影響を受けず、生存した poll ループへ scheduleEvent し続ける → respawn 後に新 daemon へ自動的に dispatch 再開、が構造的に成立する。ただし **実 `loop()` を `createAudioEngine` 経由 full interpreter で respawn 跨ぎさせる end-to-end は未実施**（S2 の timing parity が「直接駆動・end-to-end 未実施」と境界を明記したのと同型）。閉じる場合は gated e2e テスト1本で足りる（optional・owner 判断）。

**follow-up note（非ブロック・code-reviewer round 2 で sound 確認済）**: Gap 5 = `quit()` が respawn の backoff 中（~150ms）に着地するケースの CI テストは未追加（`disposed` checkpoint + `await respawnPromise` で正しいと確認済・consequence は narrow window の cleanup race のみ）。

**明示 defer**: out-of-process per-plugin isolation（γ・fault ②）/ β audio DSL⊇pitch / time-stretch / LinkAudio(A4) / cutover #108 / play --capture seam（PCM 可聴ギャップ数値化）。

**post-#300 計画 doc + drift 監査（owner 依頼・本 PR 同梱）**: マージ前に「第1増分後の実装計画」を新規 `docs/development/POST_2.0_NEXT_STEPS.html`（snapshot 2026-06-22・MASTER_PLAN の前向きたたき台）に集約 = ①到達点（A0/S1/S1b/S2 + #304 + #300）②**cutover #108 までの parity gap**（#304 が warn/no-op に倒した time-stretch=A3 / LinkAudio=A4 / master effects=γ）③#300/#304 で意図的に defer した小粒の follow-up トラッカー（play --capture seam / Gap5 quit-during-respawn / active-loops e2e / daemon hard-stop-all / bot Finding 2・4）④次 /goal 候補（contained な A3/A4 を先に・γ は段階化、owner 判断）。仕様 drift 監査（agent）= **specs-v2 / core spec は engine/recovery 非言及で drift 無し**、recovery は DSL 意味論を変えないので core spec にセクション不要。事実 status の drift のみ本 PR で修正（done マーク）: ENGINE_AND_DISTRIBUTION §2.2「auto-respawn 未実装」→ 実装済 / §2.5・§7 第1増分=done / A0 §14 pan=done + Finding F 解消 / MASTER_PLAN.html §2・§3・§9 第1増分=done。既存正本の「次フェーズ=X」決定は書かず新 doc を参照（次の選択は owner にティーアップ）。Epic #292 本文 status はマージ後に gh で更新。

**owner 決定（2026-06-22・advisor 反映）を NEXT_STEPS.html に追記**: ① **次フェーズ順序 = A3 time-stretch → A4 LinkAudio**、各フェーズの自然な拾い所にフォローアップを織り込み A3+A4 完了で backlog 一掃（A3: daemon hard-stop-all〔stretch で長尺 voice〕+ Gap5 + Finding2 / A4 末: active-loops e2e〔capture 非依存の state-level〕）。残るは capture と Finding4 のみ（意図的）。② **capture seam は A3 に畳まない**（stretch 検証は offline で足りる・#300 Step0 の「含めない」決定を覆さない）。capture は 2 独立 trigger=（a）dog-food の可聴ギャップ実測〔前倒しうる〕/（b）耳なし実時間検証基盤〔cutover までに確実〕。③ **計測/耳なし検証レイヤ（#307/#308/#313 verify ハーネス + librosa grounding）を再利用資産として再ラベル**（新トラック発明せず）。④ **north-star: (C) score-following / アルゴリズム的「聴く」/ LLM 演奏計画は WCTM 別トラックの研究ビジョン**（engine スコープ外）。依存方向 = engine→計測語彙→(C)、責務境界 = engine は計測語彙をクリーンに保つだけ・(C) の alignment/入力/streaming は抱えない。共有=特徴抽出の語彙 / 用途別=配管。新規性は「DSL 譜面整合 + LLM 計画駆動」の統合部分に限定（score-following 自体は確立 MIR）。先回り実装はしない（投機的一般化の禁止）。

**Commit**: 7aabde7（実装 + /simplify cleanup）/ ff4259c（pr-review-team round 1）/ ff9bb72（round 2 → Critical/Important=0 収束）/ + bot follow-up + post-#300 計画 doc・drift 監査

### 6.157 verify(audio): retroactively self-verify #304 (examples/22 params) via harness — close #307 (#316) (Jun 21, 2026)

**Date**: 2026-06-21
**Status**: ✅ 実装 + 全テスト緑（cargo daemon verify_schedule_pcm 4 / verify 30 / npm 1161 passed）。#307 の受け入れ基準（examples/22 を耳なし PCM 検証）を達成
**Branch**: `316-verify-examples22-goal1`

**背景**: harness epic #307 の受け入れ基準に「examples/22（pan/slice/per-slice gain）を capture して PCM アサーションで #304 を遡及的に自己検証（耳に依存しない裏付け）」がある。phase 1〜3（#310/#312/#314）でハーネス・assertion lib・tier-c・librosa grounding は揃ったが、**#304 の実 deliverable を耳なし検証する最終増分が未達**だった。本増分でこれを満たし #307 をクローズ（完了済み phase-2 #311 も併せて）。

**examples/22 の制約**: `examples/22_rust_engine_parity.orbs` は 4 voice 同時並行の dog-food デモで、各拍に複数 voice が重畳し L/R RMS がミックスになり per-event の pan/gain を分離不能（研究 §4.4）。→ **生ファイルに per-event assert を当てない**。

**設計（advisor 承認・(A) offline）**: examples/22 と同じ素材（kick/snare/hihat/arpeggio）+ #304 の実パラメータ（pan -0.6/+0.6/0/+0.2・gain -3/-6/-9/-4・chop(1) 全体 と chop(2) 領域）を **de-overlap した検証 fixture** `examples22_parity.orbs` に組み、phase-2 の 2 本足で検証。tempo 120 / length 4 / 16 要素 → 0.5s grid（spec: length(2)→8要素 と同型・subdivision は play 要素数で決まり chop と独立）。kick@0s / snare@2s / hat@4s / chopd slice1@6s・slice2@7s（rate=1.0）。

**2 本足**: Leg 2（TS）= InterpreterV2 schedule vs **手書き独立オラクル**（onset/gainDb/pan/slice を .orbs+DSL 仕様から導出・トートロジー回避）。**length>1 を harness で初めて通したが独立オラクルと一致**（interpreter が length>1 を正しく処理）。Leg 1（Rust）= golden → 実 `EngineWrap::play_at` offline render → PCM で **pan を atan2 独立逆算（kick -0.6 / snare +0.6 / hat 0 / chopd +0.2）+ chop(2) 領域 + イベント間無音** を検証。

**gain の扱い（正直に）**: gain 値（-3/-6/-9/-4）は**異なるサンプル間で RMS 比較不能**（固有レベルが違う）ため Leg 1 では検証しない。gain は Leg 2（gainDb/linear の計算）+ phase-2 per_event_gain（同一サンプルの dB 差を実レンダで）でカバー済み。

**スコープ外**: 生 examples/22 の literal smoke（examples/ 配下・別パス・重畳で friction 高く弱い検証）は見送り、de-overlap fixture で acceptance を満たす。CLI `play --capture`（#307 ②・重い）は /goal2（#300）へ defer（#307 が「capture は respawn 後の可聴ギャップ計測に効く」と明記）。

**意義**: 以後の audio 増分（#239 slice / #213 time-stretch / effects）が「耳」でなく PCM で機械検証可能に。#307 が「capture は daemon respawn 後の可聴ギャップを PCM で測れる → goal2 検証に効く」と明記しており、goal2（#300 recovery floor）への橋にもなる。

**/simplify（4観点並列）**: reuse/efficiency は重複・無駄なし（既存 phase-2 パターン踏襲）。altitude の 1 件のみ適用 = Rust `tail_trim` を動的式 `(span/4).min(600)`（本 fixture では全 span≥2400 で常に 600）から既存 fixture と対称な固定 `600` に簡約（挙動同一）。chopd assert のループ化等は「明示の方が読みやすい」で leave-as-is。

**/code:pr-review-team（4専門・1 round 収束）**: Critical/Important=0。code-reviewer がオラクル全値（onset/gain linear+dB/pan raw+daemon/chop offset/sentinel）を .orbs+DSL 仕様から**独立再導出して一致確認**（循環でない裏付け）。Minor 3件適用: ① Leg1 ループ前に `assert_eq!(events.len(),5)` ガード追加（兄弟 per_event_gain テストと対称・golden truncation 時の vacuous green 防止）② `.orbs` の無音間隔表記を正確化（chopd slice1-slice2 間は 0.5s）③ slice 領域「内容」正しさは `chop_region_real_wav.rs` が担う旨の layering 注記。bot は新規外部主張なしで skip（advisor カリブレーション = verify 系は proportional）。

**Commit**: b763abc（実装）+ /simplify cleanup + pr-review-team follow-up

### 6.156 feat(verify): phase-3 — ground measurement primitives against librosa (blind cross-check) (#313) (Jun 21, 2026)

**Date**: 2026-06-21
**Status**: ✅ 実装 + 全テスト緑（cargo daemon+verify / npm 1159 passed）+ cross_check 3 fixture PASS（leader 独立再現）
**Branch**: `313-verify-phase3-librosa-cross-check`

**背景**: phase 1（#307/6.154）・phase 2（#311/6.155）の tier-c 検証が信頼してきたのは、ハーネス自身の**測定プリミティブ**（`orbit-audio-verify`: `region_rms` / `pan_from_lr_rms` の atan2 逆算 / `detect_onset_threshold`・`detect_onset_matched`）。これまでプリミティブは Rust 単体テスト（既知アンカー）でしか裏付けが無く、誰も**独立 MIR ツールと突き合わせていなかった**。tier-c の土台がプリミティブの正しさに乗っているため、librosa を独立 oracle に置いて**プリミティブ層で GRM 独立性を成立させる**（差分検証）。研究記録 = #308 / `docs/research/AUDIO_OUTPUT_VERIFICATION.md` §4.2/§4.4。

**独立性の質を正直に書き分ける（中核）**:
- **onset = アルゴリズム独立（本丸）**: librosa の spectral-flux peak-picking は ours（threshold / matched-filter）と別アルゴリズム。真の差分。librosa の検出値は ours とも scheduled とも異なる独立値（per_event_gain loud で librosa=4608, ours=scheduled=4800）。
- **level = 実装独立**: librosa も `sqrt(mean(x²))`（式は同じ）。捕まえるのは生 PCM 読み込み（`np.fromfile` の interleave/reshape）・channel 取り出し・dtype の**配管**。「RMS の数学を独立に再導出した」とは主張しない。
- **pan = 実装独立**: librosa 由来 per-ch RMS から atan2 逆算（atan2 は純粋数学・`analysis.rs` のアンカーで別途 pin 済）。grounding は per-ch RMS の一致に帰着。

**seam（WAV codec を検証対象に混ぜない）**: Rust example `export_verify_pcm`（`orbit-audio-daemon`・example は dev-dep `orbit-audio-verify` を使える唯一の置き場）が phase-2 fixture を本番 `EngineWrap::play_at` でオフライン決定論レンダ → `CapturedAudio.data` を**生 LE interleaved f32** でダンプ（`.gen/`・gitignore・再生成可能）+ 自プリミティブ測定値を `<fixture>.rust.json`（committed）に出力。Python `cross_check.py` が生 PCM を `np.fromfile(dtype='<f4')` で読み **librosa を numpy 配列に直接**かけて突き合わせ、`<fixture>.compare.json`（committed）を出力。

**onset 3-way**（ours / librosa / 既知スケジュール）: librosa 単独は hop=512≈10.7ms で弱いオラクル → scheduled を strong ground truth に据え librosa を独立 witness に。許容 = ours↔sched ±2ms(96fr) / librosa↔sched ±15ms(720fr) / level 相対 ≤3% / pan ±0.05。

**結果（全 fixture PASS・leader 独立再現 exit 0）**: level lRelErr=0.0（窓一致で配管確認）/ pan Δ=0.0（left/mid/right=−1/−0.5/+1）/ onset ours 0〜+9fr（attack fade 無しでほぼ sample-accurate）/ librosa −64〜−448fr 先行（spectral-flux+backtrack の系統傾向・全件許容内）。`chop_region` の spurious 4 は chop 内部境界の再立ち上がり（scheduled 全件マッチで verdict 不変）。**librosa デフォルト `frame_length=2048` は減衰信号で ~30% 系統ズレ**→窓長明示が必須（py-crosscheck が発見・修正）。

**CI 方針（owner 確定）**: **CI gate にしない**。版固定 `requirements.txt`（librosa==0.11.0 等）+ committed script + 本記録 + `tests/audio/verify/phase3/README.md` の Recorded validation。理由: librosa/numba は版脆弱・onset は frame 解像度で gate だと flaky・回帰は既存 Rust アンカーテストがカバー。self-test（`--selftest`）で機構の正常/異常検出を回帰ガード。

**委譲**: Opus = cross-check 設計（突き合わせ量・許容校正・onset 3-way・GRM 独立性の書き分け・export seam・README/契約・統合/再現確認）。Sonnet = Rust example（render+生f32ダンプ+自測定JSON）/ Python script（librosa 測定+比較）+ 版固定 requirements。leader が selftest cleanup の footgun（`.gen` rmtree で実 PCM 巻き添え）を修正。

**/simplify（4観点並列 + 適用）**: in-file の簡約を適用（named const 化 `BLOCK_FRAMES`/`BODY_HEAD_OFFSET`/`ONSET_SEARCH_MARGIN`・未使用 `panRaw` 削除・`play_span` ヘルパ抽出・matched 分岐コメント / Python: spurious 件数のベクトル化・冗長 `status` 変数と重複 `mkdir` 除去・`_rms` ヘルパ・異常系 selftest を `run_fixture` に統一）。値は不変（rust.json / compare.json バイト一致を確認）。**reuse 最大指摘 = `render_golden`/golden 型 ~80行が phase-2 test と逐語複製**は defer: dedup には merged phase-2 test 改変 + daemon 本体への feature flag + orbit-audio-verify の dev-dep→optional 昇格が必要で reviewed diff の外。両 harness を触る focused follow-up とする（追跡 = #315）。

**/code:pr-review-team（4専門エージェント並列 + 反復）round-1**: Critical 1 + Important 4 を反映。① **selftest 再設計**: 各検出器を 1 ケース 1 摂動で単独 flip 検証（level/pan/onset-ours/onset-librosa）+ spurious assert。従来は L/R 等倍摂動で **pan 検出器が未検証**（Critical）・librosa_matched/空 onset 経路も未駆動だった。② **`detect_onset_matched` を scheduled 真値と整合確認**（従来は Rust が出力するのみで Python 未消費＝「4 プリミティブ grounding」が過大主張）。③ **PCM frame 数を `rust.json["frames"]` と照合**（stale/truncated PCM の silent pass を防ぐ）。④ robustness: `onsetFrameThreshold=null` の TypeError ガード / near-zero RMS 相対誤差の分母 floor / `_selftest*` gitignore / コメント精密化。CI gate 無し方針ゆえ selftest が唯一の自動ガードなので各検出器の単独 flip 検証が要。**round-2**: ⑤ selftest の単独 flip を compare.json の **per-metric フラグで assert**（verdict bool は disjunctive で isolation を保証しない）、⑥ **matched-FAIL 経路を selftest でカバー**（`_selftest_onset_matched`）+ Rust 側で per_event_gain[0] の matched が None なら **expect で loud に**（silent null = grounding 消失を防ぐ）、⑦ burst2 コメント修正。**round-3** で両 reviewer が収束確認（Critical/Important=0）。収束推移: round-1 (C1+I1〜I4) → round-2 (I-A・I-B = round-1 の selftest 強化の深化) → round-3 (0)。

**CI 補足（owner 2026-06-21）**: 現状 CI gate にしないが**将来導入予定**。導入時は版固定 venv を job 化し `export_verify_pcm`→`cross_check.py`（exit code gate）を回す（生成物は決定論）。

**スコープ外（後続）**: 上記 render_golden dedup（両 harness 共有・#315）/ CLI `play --capture out.wav`（決定論 offline-clocking）/ madmom フルスイート / 広い DSL 機能網羅（polymeter/quantize onset）/ 知覚指標 / CI 導入。selftest の残 Minor（`ours=None`・空 onset の guard 分岐の edge path 未テスト・sev 2-3）は意図的に追わない（検証ツールの guard 分岐で収束に影響なし）。

**Commit**: 03c7088（実装）+ 4871fe6（/simplify）+ pr-review-team round-1 follow-up

### 6.155 feat(verify): phase-2 tier-c — interpreter schedule vs rendered PCM (two-leg) (#311) (Jun 21, 2026)

**Date**: 2026-06-21
**Status**: ✅ 実装 + 自動テスト全緑（cargo --workspace / npm）+ clippy clean。tier(c) を end-to-end で閉じる第2増分
**Branch**: `311-audio-verification-phase2-tier-c`

**背景**: phase 1（#307/PR#310・6.154）は core レンダラ（Scheduler）を直接検証した。phase 2 は **interpreter が .orbs から計算したスケジュール（native 経路）を2本足で検証**し、tier(c)（レンダリング音 ↔ DSL 意味的スケジュール）を engine 層から閉じる。研究記録 = #308。

**2本足（advisor 指摘で循環の罠を断つ）**:
- **Leg 2（interpreter の計算が正しいか）**: `RecordingScheduler` 注入の `InterpreterV2` で fixture .orbs を実行 → 生の構造スケジュール（onset/gainDb/pan/slice index・total）を **.orbs + DSL 仕様から手書きした音楽単位オラクル**と比較。解決済み daemon param 同士の比較はトートロジー（slice offset/duration が両者同式）になるため**生のまま**比較。`calculateEventTiming` + DSL→schedule を直接テスト。
- **Leg 1（renderer が忠実に再生するか）**: 構造スケジュール → 本番共有 `toDaemonParams` で解決 → golden JSON → Rust が実 `EngineWrap::play_at` でオフライン決定論レンダ → phase-1 analysis で PCM 検証。pan は atan2 独立逆算、**slice 領域は golden の offset/duration を再導出しない**（GRM 独立性）。

**seam（本番経路と共有・drift 防止）**:
- TS `RustEnginePlayer`: 発音変換を private `toDaemonParams` に lift（executePlayback と検証で**同一変換**: gainDbToAmplitude / pan÷100 / resolveSliceRegion）。`seedDuration` + `DaemonPlayParams` 型 + `ScheduledPlay`/`SliceSpec` export。behavior-preserving（rust-engine 24 + daemon-client 10 緑）。
- TS `InterpreterV2`: audioEngine 注入 option（既定不変・SC 経路無改変）。
- Rust `EngineWrap::render_offline`: cpal 不使用の block 駆動。play_at の sec→frame / resolve_slice_region を経た出力を捕捉（phase-1 が飛ばした層）。

**決定論化の発見**: `preparePlayback` が `scheduler.isRunning` を要求（RecordingScheduler.start で立てる）、`runSequence` が `baseTime = (Date.now()-startTime)+100`（RUN 先読み）→ **fake timers で Date.now() 凍結**し記録 time = musical onset + 100 を決定論化。

**fixture（3機能・判別力）**: `pan_three_voices`（hard-left/中間-50/hard-right・中間値が線形則を判別）/ `chop_region`（chop(2) grid 一致 rate=1.0・slice 領域の出力/無音）/ `per_event_gain`（gainDb -3/-9 の 6dB 差）。golden JSON は committed・staleness guard（`UPDATE_GOLDEN=1` で再生成）。

**検証**: TS Leg 2 **6 passed**（pan/chop/gain × 2）+ Rust Leg 1 **3 passed**（verify_schedule_pcm）。cargo --workspace 全緑 / npm test 1159 passed / **0 failed**（SC 既定 `SuperColliderPlayer` / `event-scheduler.ts` + daemon 実時間経路 + audio play() 意味論 無改変）。clippy clean。

**委譲**: Opus = seam（toDaemonParams lift / InterpreterV2 注入 / render_offline / 2本足構造）+ pan spine の end-to-end 疎通（決定論化の発見含む）。Sonnet = chop/gain fixture の複製。

**スコープ外（後続）**: CLI `play --capture out.wav`（daemon offline render-to-WAV）/ librosa 相当 blind cross-check / 広い DSL 機能網羅。

**Commit**: 301338e (spine) / 16e6434 (chop+gain)

### 6.154 feat(verify): audio output verification harness — capture + PCM assertion lib (#307) (Jun 21, 2026)

**Date**: 2026-06-21
**Status**: ✅ 実装 + 自動テスト全緑（cargo --workspace / npm）+ clippy clean。#304 の pan/領域/per-slice gain を **耳でなく PCM 解析で自動裏付け**
**Branch**: `307-audio-verification-harness`

**背景**: #304（PR #305）の native audio parity は OSC 値 parity と scheduler ユニットで固めた一方、「.orbs を end-to-end で鳴らした実レンダリング PCM」の確認は **owner の耳に依存**した。研究記録 #308（`docs/research/AUDIO_OUTPUT_VERIFICATION.md`）の tier (c)（レンダリング音 ↔ 静的スケジュールの突き合わせ）を **engine 層から着地させる第1歩**。

**設計（advisor 承認）**:
- **capture seam = `Scheduler` 直接駆動**。pan/領域/gain/末尾fade はすべて `orbit-audio-core::Scheduler::render` に入っており、それが DUT そのもの。`Engine` 経由（try_lock の理論上 drop）や daemon の `play_at`（sec→frame 変換 = tier(c) 射程外・protocol test で別途カバー）を通さず、最も決定論的な核を block 分割で回す。**実 WAV 要件は loader でロード→`Scheduler.schedule`→render で満たす**。
- **GRM 独立性（差分検証の成立条件）**: checker は core の `equal_power_pan` / `resolve_slice_region` を **import しない**。pan は L/R RMS から `atan2` で独立逆算（レンダラは cos/sin）、領域境界・gain 比の期待値はテスト側に手計算で直書き。同式を共有すると同一バグが両側に乗り差分が消えるため。

**新規 crate `orbit-audio-verify`**（lib 依存は core のみ / native は dev-dep）:
- `capture.rs` — `CapturedAudio` + `capture(scheduler, channels, total_frames, block_frames)`。block 分割で `dst_offset_frames`（実 cpal callback のイベント境界またぎ）も通す。core 無改変のため channels は引数渡し。
- `analysis.rs` — `region_rms` / `channel_rms` / `region_peak` / `channel_peak` / `linear_to_db` / `db_difference` / `pan_from_lr_rms`（atan2 独立逆算）+ tolerance 定数（`PAN_TOLERANCE=0.05` / `GAIN_DB_TOLERANCE=0.5` / `SILENCE_FLOOR_DB=-90`、本レンダラは完全線形ゆえ MPEG 系非線形校正不要）。
- `onset.rs` — `detect_onset_threshold`（閾値立ち上がり）/ `detect_onset_matched`（matched filter 相互相関・整数フレーム）/ `fade_slope_is_linear`（最小二乗の正規化 RMSE で線形 release 判定）。

**遡及検証テスト（#304 を PCM アサートで裏付け）**:
- `tests/pan_real_wav.rs` — 実 WAV `sine_440.wav` を hard-left/center/hard-right でレンダ → L/R RMS から pan 逆算（±0.05）。
- `tests/chop_region_real_wav.rs` — 実 WAV `arpeggio_c.wav` で領域 on/off（領域外は厳密 0）+ 合成 ramp で offset 同定（読んだ source フレーム == offset+local）。
- `tests/per_slice_gain.rs` — 同尺・同素材・中央パンで線形 gain だけ変えた 2 イベント、body 窓 RMS の dB 差 == 指令比（±0.5 dBFS）。
- `tests/onset_fade_capture.rs` — capture 経路で onset 検出（block 境界またぎ）+ 末尾 fade の線形性。

**委譲（§5/§7 規律）**: Opus が capture seam / analysis コア（pan 逆算・tolerance）/ GRM 独立性 / spine（実 WAV pan）を凍結 → Sonnet が onset/fade 本体・残り遡及テスト・フィクスチャを並列実装。

**検証**: orbit-audio-verify **23 unit + 7 integration = 30 passed**（PR #310 レビューで判別力強化 +4: 中間 pan 値・fade 終端値・db_difference 退化分岐・region_peak/should_panic）。cargo --workspace 全緑（core 23 / daemon 14+1 / native 16 / clap-spike 7・回帰なし）。npm test 1153 passed / 25 skipped / **0 failed**（SC 既定 `SuperColliderPlayer` / `event-scheduler.ts` 無改変・audio play() 意味論不変）。clippy clean。

**PR**: #310（`/simplify` + `/code:pr-review-team` 4 専門 → Critical/Important=0 収束。CI code-review pass）。

**スコープ外（後続増分）**: CLI `play --capture out.wav`（TS→daemon→render 全経路）/ DSL 静的スケジュールを GRM にした end-to-end tier (c) / librosa 相当の blind cross-check。

**Commit**: 8759187

### 6.153 docs(research): audio output verification — DSL static schedule vs rendered PCM (#308) (Jun 21, 2026)

**Date**: 2026-06-21
**Status**: 調査記録（論文化の可能性あり）
**Branch**: `308-audio-verification-research`

#304 の audio parity 検証が owner の耳に依存したことを発端に、「**DSL が静的計算したスケジュール（onset サンプル/レベル dBFS/pan/slice 境界）を golden reference とし、オフラインレンダした実 PCM を解析して自動突き合わせ**」する自己検証機構の deep research（4観点並列 + LLM 角度の追加1本）を実施し、`docs/research/AUDIO_OUTPUT_VERIFICATION.md` に記録。

- **枠組み**: golden-model conformance testing（GRM=DSL スケジュール / DUT=レンダラ / scoreboard=突き合わせ）。手法は HW/DSP 検証・MPEG conformance で成熟。
- **新規性**: tier (c)（レンダリング音 ↔ DSL 意味的スケジュールのエンジン内蔵突き合わせ）は先行事例未発見。最近接の学術先行研究 = Antescofo/IRCAM のモデルベーステストだが**イベント時刻層で止まり PCM 非到達**。
- **上位フレーミング**: これは **LLM の自己 PDCA（Plan-Do-Check-Act）の Check を audio で人間不在に成立させる機構**。agentic 自己修正は客観 oracle が必須（CRITIC / Huang et al. ICLR 2024）で、本機構は「audio の客観 oracle」を提供。`[LLM agent + 音楽 DSL + PCM 解析 + 静的 symbolic スケジュール + 推論時自律ループ]` の組み合わせは未発見。
- 実装は #307（capture backend + assertion lib + CI gate）。本研究は #308。

**Commit**: bc6f76a

### 6.152 feat(engine): native audio parity increment — pan / slice / per-slice gain (#304) (Jun 21, 2026)

**Date**: 2026-06-21
**Status**: ✅ 実装 + 自動テスト全緑（cargo --workspace / npm）+ owner ear verdict 取得（pan/slice/per-slice gain いずれも rust で SC 同等に可聴）+ OSC 実値 parity 観測
**Branch**: `304-audio-parity-increment`

post-2.0 engine-first の第1増分（最初の `/goal`）。S2 で defer した audio gap のうち **pan / chop 領域再生 / per-slice gain** を native daemon 経路に実装し、`ORBITSCORE_ENGINE=rust` opt-in の裏で dog-food 可能にした。SC 既定経路は無改変。

- **pan**（SC `Pan2` と同じ equal-power 則・中央 = -3dB / 1√2）: core scheduler render に等パワー定位を実装。daemon PlayAt の `pan`（既に protocol 仕様化済み・実装が追いついていなかった）を配線。TS は DSL の -100..100 を daemon の [-1,1] へ変換して送る。`scheduleEvent` の「pan 未対応」warn を撤去。
- **chop 領域再生**（region-only・rate=1.0）: PlayAt に `offset_sec` / `duration_sec` を追加（spec 先行で `ENGINE_DAEMON_PROTOCOL.md` 更新）。core は ActiveSample に slice 領域（start/len）を持ち、領域だけを読む。SC `orbitPlayBuf` と同じ末尾 fadeout（`min(8ms, dur×4%)` 線形 release）でクリック防止。TS `scheduleSliceEvent` を実装（slice 領域は lazy load 後に `executePlayback` で解決）。物理 slice ファイル（`audioSlicer`）は live 未使用の dead path のため native では再現しない（startPos 領域読みのみ）。
- **per-slice gain**: 各 slice event の gainDb が daemon PlayAt の gain に独立反映され、core render の per-event `active.gain` で適用される（新機構不要）。
- **rate≠1.0（slice 尺→スロット尺の varispeed = time-stretch）は本増分の対象外**。検出時は 1 回 warn し、slice は自然尺（rate=1.0）で鳴らす（time-stretch 増分 #213/#239 へ defer）。`chop()` は「現状 scsynth 仕様をそのまま採用」（owner）が、rate フィットは roadmap の time-stretch 境界に従い defer。

**用語整理（owner 確認）**: `chop()` = n 等分（既存・本増分）。`slice()`（`recycle()` でも可）= Re-Cycle 型のトランジェント/無音検出による文節切り = #239（将来 β）・本増分対象外。

**主な変更ファイル**:
- Rust: `orbit-audio-core/src/scheduler.rs`（pan equal-power + slice 領域 + fadeout）, `engine.rs`, `orbit-audio-daemon/src/engine_wrap.rs`（slice 出力尺で PlayEnded 補正）, `session.rs`（offset/duration parse + 検証）
- TS: `rust-engine/daemon-client.ts`, `rust-engine/rust-engine-player.ts`（pan/slice 配線 + `resolveSliceRegion`）
- docs: `docs/research/ENGINE_DAEMON_PROTOCOL.md`（PlayAt に offset_sec/duration_sec）
- tests: core に pan 4件 + slice 3件、`rust-engine-player.spec.ts` を pan/slice 新仕様へ更新

**テスト結果**:
- cargo --workspace: 全緑（core 21 / daemon protocol 13 / smoke 1 / native 16 / clap 7）
- npm test: 1153 passed, 25 skipped, 0 failed（回帰なし・SC 既定無改変）

**並行成果**: DAW 標準機能リサーチ（`docs/research/DAW_AUDIO_ARCHITECTURE.md`）= 基礎後の routing/effects 層 roadmap 入力（insert 順序 = engine core の graph 管理 / EQ 等 = CLAP plugin / PDC が insert 順と不可分）。

**SC parity 検証（owner）**: `ORBITSCORE_ENGINE=rust` で examples/22・pan sweep（-60→+60 等パワー）・per-slice gain 階段を ear 確認 → いずれも SC 同等（「パワー感も変わらない」= equal-power 一致）。さらに SC 既定経路を `ORBIT_SCSYNTH_PATH` で起動し、SC が scsynth に送る `/s_new`（amp/pan/startPos/duration）と rust が daemon `playAt` に送る値が**バイト一致**することを OSC ログで観測（耳の A/B 以上に厳密なパラメータ parity）。

**Done のスコープ線引き（owner 確認 2026-06-21）**: audio parity（pan/slice/per-slice gain）は **CLI 経路**（`node cli-audio.js` + `ORBITSCORE_ENGINE=rust`）で実証。CLI と .vsix は同一の `RustEnginePlayer`→daemon コードを通るため音は同等だが、**パッケージ済み .vsix からのゼロ設定 daemon 解決は未対応**（`resolveDaemonBinary` は repo 相対パス + `ORBIT_AUDIO_DAEMON_PATH` を探索。.vsix は env 未設定だと未解決。build:copy-engine も daemon 未同梱）。これは distribution 課題として **#306** へ分離（最終形 OrbitStudio/VSCodium の配布で扱う。.vsix は途中の dog-food シェル）。暫定 dog-food は `ORBIT_AUDIO_DAEMON_PATH` 設定で可能。

**残**: time-stretch / LinkAudio / α recovery floor は後続増分。daemon の .vsix/OrbitStudio 解決は **#306**。examples/22 が `RUN`（one-shot ≈2秒）で audition しづらい点は polish 候補（本増分の Done には非該当）。

**post-review cleanup（/simplify）**: 4観点 cleanup agent の指摘を behavior-preserving に適用 —
slice 長 clamp を core の `resolve_slice_region` に集約し scheduler の render 尺と daemon の
PlayEnded 尺の単一情報源化 / 等パワーパンを `schedule()` で precompute して RT render から
trig（sin/cos）と output_channels 分岐を排除 / render の `gain*env` を frame 単位へ hoist /
session.rs の PlayAt param 抽出を `param_f64` ヘルパーで集約 / 旧 spec の `Math.pow` を
`gainDbToAmplitude` に置換。SKIP: TS slice 数式/pan の SC `event-scheduler.ts` との共通化（保護対象の
SC 経路を触るため follow-up）。検証: cargo --workspace 58 緑 / npm 1153 緑 / 変更ファイル clippy クリーン。

**pr-review-team（round 1）修正**: code-reviewer の Important（engine_wrap が生 `requested_len_frames` を
scheduler へ渡していた → clamp 済 `effective_len_frames` を渡し render/PlayEnded の一致を call site で保証）/
silent-failure-hunter（`ensureLoaded` が sampleRate 不正時に無言で slice→全体再生 degrade → ソースで warn）/
comment-analyzer（slice の旧「skip」コメントを領域再生実装済みへ更新）/ pr-test-analyzer（`resolve_slice_region`
境界・ステレオ slice の channel stride・`duration_sec<0` 拒否の3テスト追加）。検証: cargo 61 緑 / npm 1153 緑。

**pr-review-team（round 2）**: round-1 修正を独立再レビュー。code-reviewer/comment-analyzer/pr-test-analyzer は
0 件（#R1 の effective_len_frames は全ケースで render/PlayEnded 一致・3 新テストも算術的に正しく load-bearing と確認）。
silent-failure-hunter が sibling edge を 1 件検出（`ensureLoaded` が sample_rate のみ検証し `frames` 未検証 →
`frames=NaN` だと `NaN<=0===false` で fallback guard 素通り）→ `frames` 有限・非負も検証 + `resolveSliceRegion`
guard に `!Number.isFinite` を defense-in-depth 追加。検証: npm 1153 緑。

**Commit**: d3be514（実装）, 9282e6c（log ref）, +simplify cleanup, +pr-review fixes（round 1/2）

### 6.151 docs(post-2.0): correct roadmap to engine-first (supersede OrbitStudio-first framing) (#302) (Jun 21, 2026)

**Date**: 2026-06-21
**Status**: ✅ docs/spec のみ（HTML タグバランス検証済・残存矛盾なし）
**Branch**: `302-roadmap-engine-first`（PR 予定・docs-only）

6.150（#298/#299）で記録したアーキ §2.1–2.4（楽器=in-process / effects+3rd-party=plugin / audio DSL⊇pitch / egress）は**不変**。だが #299 のロードマップ框（土台2本・OrbitStudio 先・2.0.0 parity on scsynth）が **SUPERSEDED** となったため engine-first に訂正。

- **振り子の収束（advisor 整理）**: 「OrbitStudio 2.0.0 parity 先決」を「scsynth を Studio に同梱」と誤読（2.0.0 の*体験*と*実装 scsynth* を混同）したのが原因で engine-first ⇄ OrbitStudio-first を往復した。**確定 = engine-first**（master plan 本来の方針）。
- **緊張を解く鍵**: `ORBITSCORE_ENGINE=rust` opt-in が既にある（S2）→ native を opt-in の裏で育て **今の .vsix で dog-food**（scsynth 同梱なし・throwaway ゼロ）→ cutover #108 → OrbitStudio が native を載せる。「使える」と「無駄ゼロ」が両立。
- **確定ロードマップ**: ① native を opt-in 裏で育てる（第1増分 = pan/slice/per-slice gain + α recovery floor #300）→ time-stretch/LinkAudio/γ sandbox/δ 3rd-party → cutover #108 → ② OrbitStudio(VSCodium) on native（scsynth 載せない・CLI+Claude 拡張必須・#301）→ ③ β audio DSL⊇pitch / audio 機能は後。engine の Studio 向け範囲 = サンプラー(in-process)+plugin host(effects)・scsynth 同等ではない。
- **更新ファイル**: POST_2.0_ENGINE_AND_DISTRIBUTION.md（§2.5 / §7 / status banner）, POST_2.0_MASTER_PLAN.html（banner / spine / §3 / Track A 表 / Track B / §9）。
- **関連 issue 再整理**: #301（OrbitStudio）= native の上・cutover 後・最初の /goal でない / #300（α）= engine 第1増分の構成要素 / #302（本訂正）。
- **最初の `/goal`** = engine 第1増分（pan/slice/per-slice gain + α recovery floor）。owner が /goal セット済。

**Commit**: dd5412b（PR #302）

### 6.150 docs(post-2.0): record engine architecture decision — in-process instruments + sandboxed plugins + audio egress (#298) (Jun 21, 2026)

**Date**: 2026-06-21
**Status**: ✅ docs/spec のみ（コア実装なし）。HTML タグバランス検証済
**Branch**: `298-post2.0-engine-arch-decision`（PR 予定・docs-only レビュー）

post-2.0 engine track（A0+S1+S1b #294 / S2 #297 MERGED）後の**次フェーズ設計を owner と確定**し、`POST_2.0_MASTER_PLAN.html` / `POST_2.0_ENGINE_AND_DISTRIBUTION.md §2` の確定決定を再訪して接地し直した。決定は owner 主導 + advisor 2回 + CLAP 一次情報（context7 `/free-audio/clap`）で検証。

- **決定軸 = 「DSL 表現力の着地点に flatten 境界を作らない」**。§2 の結論「楽器系 DSP は engine 内」は**維持**するが、*根拠*を「MIDI 駆動 hosted plugin では表現が落ちる」→「楽器は DSL 表現力の着地点だから flatten 境界を経由させない」に**置換**（ホスト対象は CLAP≠MIDI 1.0 で旧根拠は崩れた）。
- **配置**: 楽器（サンプラー/audio DSL）= **in-process（crown jewel・非交渉）** / effects + 3rd-party = **out-of-process sandboxed plugin**。判定 = DSL が per-note/per-slice 制御を要する→楽器側 / 純 audio→audio→plugin 側。
- **protocol ≠ placement**: 「MIDI を経由しない」はプロトコル（CLAP リッチイベント / `com.orbitscore.*` 超集合拡張）の話で in/out いずれでも可。in-process の真の利点は「表現力が自由に進化 + 税ゼロ」。
- **audio DSL ⊇ pitch DSL**（DSL 設計制約）: pitch モデル(C1)を audio DSL の真部分集合として設計。pitched synth は MIDI/MIDI2.0 で足りる（超集合投資はサンプラーが正当化）。
- **fault 3層**: ①app が daemon 死を生存（recovery floor）②daemon が 3rd-party crash を生存（out-of-process sandbox・未構築）③1st-party in-process crash は①でのみ捕捉。
- **egress（楽器でなく音を出す）**: (A)楽器 egress=standalone 出荷は劣化（別製品）/ (B)音 egress 無劣化 = **b1 薄い bridge プラグイン + standalone エンジン（主案・transport は free-running/follower/leader は standalone 専用）** / b2 engine 埋め込み（後付け）/ LinkAudio は非DAW 補助。制約: engine を clean に埋め込み可能に保つ。
- **ロードマップ（owner 再優先順位化・同セッション後半）= 土台2本 → 改良層**: 土台 = **① VSCodium化（OrbitStudio・2.0.0 parity が先決・最初の /goal = issue #301）+ ② ネイティブ音声エンジン（α #300 → γ sandbox → δ 3rd-party → cutover・①と並行可）**。改良層（土台の後・集中して）= **β audio DSL⊇pitch（+#213）/ audio 機能（slice/stretch）**。master plan の「Track B は engine の後（A1–A2 後）」を撤回し VSCodium を土台前倒し。β は改良層へ後置。旧 advisor 枠組み（"大転換"/"note 毎 IPC tax"）は overstated として棄却。
- **更新ファイル**: `POST_2.0_ENGINE_AND_DISTRIBUTION.md`（§2 全面書き換え + §6 に「2.0.x patch は v2.0.0 タグから分岐」+ §7/§8 をシーケンス/caveat 更新）、`POST_2.0_MASTER_PLAN.html`（Start-here バナー + 依存スパイン + §3 最初の1手 + Track A 表 + §6/§9/§10）。
- **持ち越し to-do 消化**: 「2.0.x patch は v2.0.0 タグから分岐」を §6 に明記。
- **最初の `/goal`（α か β）は別 issue で起草**（本 issue は docs/spec のみ）。

**Commit**: 494b1a7（PR #298）

### 6.149 feat(engine): S2 — daemon dispatch seam parity proof (SC stays default) (#296) (Jun 20, 2026)

**Date**: 2026-06-20
**Status**: ✅ TS 1144 pass / cargo test --workspace 全緑 / 実機 timing verdict = PASS
**Branch**: `296-daemon-dispatch-seam-parity`（PR 予定）

post-2.0 **S2**（master plan §4-A）。TS interpreter の音声ディスパッチを SuperCollider `OSCClient` seam から **Rust daemon（orbit-audio-daemon WebSocket）駆動**へ差し替え可能にし、timing parity を実証。**SC は出荷既定のまま**、Rust は `ORBITSCORE_ENGINE=rust` で opt-in（master plan §6 .vsix feature-freeze）。

- **スコープ確定（advisor×2 + ユーザー確認）**: posture = **parity proof（SC default 維持）**。#108「デフォルトを Rust に（cutover）」は後続フェーズへ defer（pan/slice/LinkAudio/time-stretch を欠く engine に出荷既定を移すのは時期尚早）。pan は S2 から defer（ファンダメンタル vs 機能詰め込みの分離）。
- **seam（Opus 判断・確定）= バックエンドレベル**: `AudioEngineBackend`（`Scheduler` + AudioEngine 面）を新設し、`SuperColliderPlayer` と新規 `RustEnginePlayer` が**ともに**満たす。`InterpreterState.audioEngine` を具象型→interface 化、`createAudioEngine()` が env で分岐。**既存 SC 経路は無改変**（1129 既存テスト無傷）。
- **lean daemon scheduler**: SC EventScheduler は LinkAudio/bufnum/`/s_new` 結合が重いため再利用せず、独立の最小スケジューラ（1ms poll を mirror）を新設。
- **timing モデル = poll-and-fire-now + 定数 lookahead**: SC=fire-now / daemon=schedule-ahead（自前 transport clock）を、poll 発火時に `playAt(daemonNowSec + lookahead)` で繋ぐ。clock anchor は StreamStats(1Hz) の transport now_sec で継続補正。
- **実機 timing verdict（ground-truth = observer 接続の StreamStats）**: lead `time_sec − trueNow` ≈ **min 38–48ms / max 48–58ms（全て正 → onset clip しない）**、anchor drift max ≈ **3–12ms**、inter-onset 誤差 max ≈ **2–7ms（相対 timing 保存）**、xruns **0**、transport rate ≈ **1.00**（複数 run の幅・gated は境界 assert）。→ load-bearing unknown を retire。
- **polymeter 実証**: 同 gated spec で seqA=400ms / seqB=300ms（3:4）を同時走行 → 各 inter-onset 誤差 ≤7ms・xruns 0 で**独立に保存**（parity を by-construction でなく demonstrated に）。境界: `.orbs` の full interpreter end-to-end は未実施（DSL→Sequence の周期計算は不変 TS 層・MIDI↔audio 同期は startTime/TransportClock 無改変で by-construction 維持）。
- **feature gap は boundary で明示**（見かけの parity を作らない）: pan≠0 → 1回 warn + 中央定位 / slice → 1回 warn + skip / outputChannel(LinkAudio) → 1回 warn + hardware fallback / master effects → 1回 warn + no-op。内部 `ScheduledPlay` は pan を保持（param-complete）。
- **テスト**: 新規 unit 22件（MockDaemonServer）+ gated 実機 spec 2件（timing / polymeter・`ORBIT_REAL_DAEMON=1`）。cargo test --workspace 全緑（core 14 / daemon protocol 13 + smoke 1 / native 16 / clap-spike 7）。
- **観測 hook**: `RustEnginePlayer` に `onDispatch`（telemetry / timing 計測・送信前に wallMs/daemonNowSec を coherent 採取）を追加。
- **PR レビュー（/simplify + /code:pr-review-team）反映**: getStatus 失敗の空 catch に warn 追加 / daemon 切断時は poll を停止し単一通知（console.error flood 回避・teardown race は isRunning ガードで抑制）/ master effects の silent no-op を warn 化 / ロード中 clear の再チェック追加。
- **A0 doc §14 に S2 verdict を記録**。DSL/MIDI 意味論は無改変（core spec 変更不要）。

### 6.148 review(spike): @claude bot second-opinion 対応 + PR レビュー規則を CLAUDE.md 化 (#294) (Jun 20, 2026)

**Date**: 2026-06-20
**Status**: ✅ #3 fix + S2/A4 carry-forward 記録 / build+test 緑 / 再レビュー不要（advisor 判断）
**Branch**: `293-clap-hosting-a0-s1`（PR #294）

internal pr-review-team（4観点×複数周）+ /simplify 通過後、**advisor に相談 → `@claude` bot に RT/clack correctness を scoped second-opinion 依頼**。bot が **internal が拾わなかった CLAP-spec-subtle な Important 3件**を検出（Critical 0）。いずれも spike の PASS verdict に無影響（テストシンセが当該パスを踏まない）:
- **#1 teardown スレッド**: `drop(stream)` で `stop_processing()` が main thread から呼ばれる（CLAP は audio thread 要求）→ S2 で `deactivate_and_stop_stream()` パターン。
- **#2 `request_callback` の `mpsc::send`**（alloc+lock）: プラグインが `process()` から呼ぶと RT 違反 → S2 で lock-free 通知。
- **#3 `EventBuffer` realloc 不変条件**: spike に `debug_assert!(len <= 1024)` regression guard 追加（**唯一の即時 fix**）。
- **advisor 判断**: S2 は daemon 統合の fresh 実装でこの spike binary のコピーではない → #1/#2 は spike を patch せず **A0 §13 に S2/A4 carry-forward として記録**（正しいパターンを残し S2 が一度で正しく作る）。**再レビュー不要**（debug_assert + doc 記録は docs-only 例外）。
- **CLAUDE.md（project + user）に PR レビューワークフロー規則を追記**: コード変更時は `/simplify` → `/code:pr-review-team`（Critical/Important=0 まで反復）を **MUST USE SLASH COMMAND**、通過後 advisor 相談 → bot review、docs のみは advisor とレビュー方法相談。
- **discontinued な `/code:autopilot` セクションを project CLAUDE.md から削除**（hook bypass の precedent は PR レビュー規則の「理由」に salvage）。

### 6.147 refactor(spike): /simplify 指摘を適用（behavior-preserving cleanup） (#294) (Jun 20, 2026)

**Date**: 2026-06-20
**Status**: ✅ build clean / unit test 7 pass / static+hot 実走回帰なし
**Branch**: `293-clap-hosting-a0-s1`（PR #294）

`/simplify`（reuse / simplification / efficiency / altitude の 4 cleanup エージェント並列・Skill tool 経由）の指摘を Phase 2 で適用:
- **A** `discovery.rs`: bundle ロードの unsafe FFI を `open_bundle()` に抽出（2関数の重複解消・unsafe 集約）。
- **D** `sink.rs::CountingSink::commit`: peak を per-sample `fetch_max`（2048回/callback）→ local fold して 1 atomic。
- **G** `audio.rs`: hot-install path を `self.install(msg)` に統一（install ロジックの重複解消）。
- **I** `buffers.rs`: channel count を既存 `total_channel_count()` 利用（dead_code 解消）。
- **J** `host.rs`: 未読の dead state（`PluginCallbacks` / `OnceLock`）削除・`initializing` を trait default に。
- **K** `audio.rs`: 未読の dead field `sink_frames` 削除（per-callback fetch_add も除去）。
- **L** `main.rs`: pump の `else` を共通後続に hoist。
- **H** `PostMixSink::commit` の「format は構築時固定」設計意図を doc 化（A4 向け）。**M** テスト名を sample 数に整合。
- **skip（理由付き）**: config fallback 統合（input/output の asymmetry が意図的）/ parse_args helper（clap 依存回避が意図的・borrow 複雑化）/ muxed 2パス（altitude が mux 構造を妥当と確認・RT 検証済）。
- RT hot path（`audio.rs::process`）はクリーンと 4 エージェントが確認。全変更 behavior-preserving。

### 6.146 fix(spike): pr-review-team 指摘対応（Critical 1 + Important 6） (#294) (Jun 20, 2026)

**Date**: 2026-06-20
**Status**: ✅ Critical/Important = 0 / unit test 7 追加 pass / 実走回帰なし
**Branch**: `293-clap-hosting-a0-s1`（PR #294）

`/code:pr-review-team`（code-reviewer / silent-failure-hunter / pr-test-analyzer / comment-analyzer 並列）の指摘を一括修正。**RT hot path の実バグは無し**（latent alloc は Fixed buffer / port rescan 非対応 / 低イベント率で防御済）:
- **Critical**: `hist_us` フィールド doc が stale（1µs/63µs → 50µs/51.2ms に修正・S2 監視の根拠数値）。
- **Important**: ① `plugin.process` のエラーを `process_error_count` で可視化 ② `event_scratch` 容量を event ring（1024）に合わせ comment を正直化 ③ driver thread panic を fatal 化（無効計測を握り潰さない）④ パース不能な plugin id を log（誤解を招く "No plugins found" 回避）⑤ `p99_ns()` 境界 unit test 4 件 ⑥ `ensure_buffer_size_matches` の RT eprintln を `cfg(debug_assertions)` gate。
- **Minor**: `buffers.rs` doc メソッド名 / config fallback log + is_input 型修正 / `_=>{}` 防御 fill / pump Disconnected log / request_callback コメント / hot-install≥measure 警告 / installed_at off-by-one コメント。
- **追加 unit test**: p99 境界 4 / CountingSink abs-peak + RingTapSink drop / add_to_cpal_buffer の ADD-mix 不変条件（A4 差し替え点）= 計 7 件 pass。
- security: secrets なし・`unsafe` は plugin loading の inherent・network/auth なし・全 deps permissive。

### 6.145 feat(spike): S1b — 低レイテンシ + release + dynamic hot-install を実証 (#295) (Jun 20, 2026)

**Date**: 2026-06-20
**Status**: ✅ S1b 完了（3 caveat retire）/ 既存テスト緑
**Branch**: `293-clap-hosting-a0-s1`（PR #294 に追加）
**Issue**: #295（Epic #292）

S1（PR #294）が retire していなかった3項目を `orbit-clap-spike` に CLI を足して実証:
- **S1b-1 低レイテンシ + release**: `--buffer-frames` 追加。128/256 フレーム（2.9/5.8ms budget）で xrun 0・resize 0・発音。**release + 128 frame で callback max 10.8µs（budget の 0.37%）**。小バッファほど相対余裕が大きい。
- **S1b-2 dynamic hot-install**: `--hot-install-after-secs` 追加。engine-only で stream 開始→稼働中に主スレッドで `activate`+buffers→`StartedPluginAudioProcessor`(Send) を **wait-free rtrb ring で audio thread に move→callback が一度 pop して install**（A0 §8 の所有権ハンドオフ）。install at callback #862(256f)/#1722(128f)=期待値、**move は alloc/lock なし・install callback で時間スパイク無し（max 45–49µs）**・install 後に発音。static 経路も回帰なし。
- **実装**: `OrbitAudioProcessor` の plugin/buffers を `Option` 化し static/hot を統一。`InstallMsg` は全 Send。
- A0 doc §13 に結果記録・§12 caveat を retire 更新。**残る未実証**: ノードグラフ / OutputEvents / sample-accurate offset / F32 のみ / hot-uninstall。

### 6.144 feat(spike): S1 — CLAP hosting を orbit-audio cpal callback に RT 統合（verdict=PASS） (#293) (Jun 20, 2026)

**Date**: 2026-06-20
**Status**: ✅ S1 verdict = **PASS（feasibility→proof）** / 既存テスト緑（Rust lib 16 + TS 1129）
**Branch**: `293-clap-hosting-a0-s1`
**Issue**: #293（Epic #292）

post-2.0 クリティカルパス先頭 S1 を実走し RT 安全性の verdict を確定。A0 §4 のアーキ（同一 cpal callback / プラグイン Mutex 外 / rtrb event seam / PostMixSink tap / static-load）を実装。
- **実装**: `rust/crates/orbit-clap-spike`（host・ワークスペース member・`publish=false`）= clack 公式 cpal example を headless 移植 + orbit-audio `Engine` 合算 + rtrb note seam + `PostMixSink`(Counting/RingTap) + 計測モード。`rust-spike/clap-test-synth`（独立 crate・自作 CLAP synth・良性/`CLAP_TEST_SYNTH_MISBEHAVE=1` で 4MB alloc+50ms lock の故意違反）。clack を `f874e85` git pin。
- **委譲（§7）**: synth と host 実装を Sonnet subagent 2 本に並列委譲（A0 §4 = 固定 interface）。**実走・計測・verdict は Opus が実ゲートで実施**（計測バグ 2 件を Opus が修正: p99 ヒスト域 64µs→51ms、発音証明 peak 出力追加）。
- **結果**: good 60s 持続 = **xruns 0 / callback max 509µs（budget 23ms の 2.2%）/ peak 0.25 発音 / resize 0**。misbehave 12s = callback 数 2594→**24 崩壊**・mean **494ms**・max **1.94s** で違反を決定的に検知。→ good の clean は実証検知できる計測上の clean。
- **★重要知見**: macOS CoreAudio + cpal は callback が 2 秒ブロックしても **err_fn xruns が発火しない**（good/bad 両方 0）。→ **xruns 単独は RT 違反検知に使えない**。production 監視は callback duration ベースにする（S2 以降・`StreamStats` に callback-time 分布追加）。A0 §12 に記録。
- **license gate（Opus・§1）**: 新 deps（clack-host/extensions/common/clap-sys/libloading/objc2/rtrb）全 permissive。closure に純 GPL/AGPL 無し（MPL=symphonia 既存・r-efi は MIT/Apache 選択）。
- **Caveat（S1b/S2 へ）**: 1024 フレーム（高レイテンシ）・debug build・static-load のみ・F32 のみ・単一プラグイン。dynamic hot-install / 低レイテンシ厳格テストは未実証。
- Stop&Report 条件（clack breaking / RT 不能 / tap 不成立）いずれも非該当。

### 6.143 chore(docs): WORK_LOG ログローテーション（2026-05 末尾 + 2026-06 前半をアーカイブ） (Jun 20, 2026)

**Date**: 2026-06-20
**Status**: ✅ 整合のみ（`PROJECT_RULES.md §1a` 準拠・欠落/重複なし検証済）
**Branch**: `293-clap-hosting-a0-s1`

main WORK_LOG が 140K（100KB 閾値超）に肥大したため月別アーカイブを実施:
- **最新 20 セクション（6.123–6.142）を main に保持**、古いものを月別に退避。
- **`docs/archive/WORK_LOG_2026-06.md` 新規**: 6.90–6.122（33 セクション）。
- **`docs/archive/WORK_LOG_2026-05.md` に追記**: 6.87–6.89（May 09–10 分・newest-first で 6.86 の上に挿入）。
- main footer に 2026-06 リンク追加。連続性検証で 6.64–6.142 が全て1回ずつ存在を確認。
- 結果: main 1424 行/140K → **325 行/32K**。

### 6.142 docs(post-2.0): A0 RT 統合設計 + Epic #292 / Issue #293 起票 (Jun 20, 2026)

**Date**: 2026-06-20
**Status**: 🟡 A0 設計完了 / S1 は Rust toolchain 未インストールで実行ブロック（Stop & Report）
**Branch**: `293-clap-hosting-a0-s1`
**Issue**: #293（親 Epic #292）

post-2.0 のクリティカルパス先頭 A0+S1（CLAP hosting）に着手。`POST_2.0_MASTER_PLAN.html` + 探索ノート + research を一次ソースに、既存 `rust/` エンジン（cpal callback / Scheduler / daemon）の実コードを照合して A0 設計 doc を作成。
- **Epic #292**「Post-2.0 Native Engine & OrbitStudio」+ 子 **#293**「A0+S1 CLAP hosting」を起票（B/C 子は投機的なので未作成）。
- **A0 doc** (`docs/development/POST_2.0_A0_RT_INTEGRATION_DESIGN.md`): スパイクの仮説＋kill-criteria として記述（「音が出た」では verdict 不可）。主要決定:
  - process() = **同一 cpal callback**（clack 公式 cpal example が同形）。プラグインは **Mutex 外**所有で silent-drop 回避。
  - イベント seam = **`rtrb`** lock-free SPSC ring。tap = **`PostMixSink` trait**（S1=stub / 実 LinkAudio=A4）。
  - **LinkAudioSink の解釈確定**: goal 文言「tap→`LinkAudioSink::commit`」は Rust LinkAudio が A4（S1 下流）のため成立不能 → S1 は tap 点＋RT-safe sink trait（stub）を証明、実体は A4。
  - ブロックサイズ: cpal `BufferSize::Fixed` 要求 + 事前確保（`activate()` の max_frames 整合）。
  - 受け入れ: ≥60 秒持続で xrun=0 + CPU 時間軸計測 + **故意 RT 違反プラグイン**で計測自体の有効性検証。
- **clack-host 実物検証**（GitHub 一次・2026-06-20）: v0.1.0 / MIT OR Apache-2.0 / deps 全 permissive・GPL なし / edition 2024・**MSRV 1.85.0** / cpal host example 同梱。
- **Stop & Report**: ローカルに `rustc`/`cargo`/`rustup` が無い（`~/.cargo`・homebrew・login shell いずれも不在）。S1 実装には **Rust ≥1.85 のインストールが前提** → ユーザー判断待ち。
- advisor 1 回相談（設計 + 委譲 + ambiguity の扱い）。

### 6.141 docs(post-2.0): post-2.0 マスター計画ドキュメント（HTML）(#289) (Jun 20, 2026)

**Date**: 2026-06-20
**Status**: ✅ ドキュメントのみ（レビュー反映済・HOLD: Epic/実装 Issue は承認後）
**Branch**: `289-post2.0-master-plan`

新規セッションが post-2.0 を実行に移せるよう、探索ノート3本（`POST_2.0_ROADMAP_NOTES` / `..._ENGINE_AND_DISTRIBUTION` / `..._PITCH_MODEL_NOTES`）+ research を一次ソースに統合した `docs/development/POST_2.0_MASTER_PLAN.html`（手書き HTML）を作成。`specs-v2/IMPLEMENTATION_INSTRUCTIONS.html` を範にコールドスタート実行可能な形（Start here → §1 不変条件 → §2 依存スパイン → §3 最初の1手 A0+S1 → §4 3トラック → §5 ゲート/停止条件 → §7 Delegation Profile → §8 運用規則 → §9 Epic 提案 → §10 Open Questions）。
- **確信度勾配を保持**（engine=DECIDED / hosting=FEASIBILITY / pitch=SPEC-FIRST / song=TENTATIVE）。advisor 2 回相談（構成 + Opus/Sonnet 切り分け）。
- **§7 Delegation Profile（Opus/Sonnet）**: 判定ルール1つ（Sonnet=IF 確定＋検証容易 / Opus=seam・判断 or 誤答が検証をすり抜ける）+「**委譲は Opus が実ゲートで検証**」を本セッションの実例（Sonnet 監査 5 件見落とし→bot 6 件目）で裏付け。
- **レビュー反映**: (a) Track A スコープ境界（MIDI/IAC は engine 非依存・接点は `TransportClock` のみ）/ (b) ライセンス節（自コード=コンポーネント別自由 / 依存=permissive が不変条件 / 現状 Source-Available v1.0 維持 / 名称統一は横断 TODO・#ops 共有済）。
- WCTM(#224) とは別トラック・締切なし。

### 6.140 docs(user): VitePress MIDI ピラー6ページを英訳 (#287) (Jun 19, 2026)

**Date**: 2026-06-19
**Status**: ✅ ドキュメントのみ（`vitepress build` 緑・dead link 無し）
**Branch**: `287-translate-midi-en`

#237(PR #286) で追加した JA MIDI ピラー6ページに対し、EN スタブ（`sites/user/en/midi/` の「Translation pending」）を**実英訳に置換**。EN サイトの他10ページは翻訳済みで、かつ `en/reference/methods.md` §6 が `/en/midi/` を full documentation として参照していたため、その穴を解消。
- 翻訳6ページ: index / pitch-dsl / mode-scale / voicing / link-audio / quantize（計 902 insertions）。sonnet agent に委譲 → main がレビュー。
- 既存 EN（`en/reference/methods.md` §6・`en/basics/`）の用語・スタイルに整合。**DSL コード構文は不変**、コード内コメントのみ EN 化。frontmatter・`:::` admonition・内部リンク（`/midi/`→`/en/midi/`）・post-2.0 VOLATILE 警告を保持。
- 監査済みの技術事実（gate 0–1 クランプ / `^r`=-1/0/+1 / `.open()`=close→drop2 / `.mode()`+`.root()` 併用不可 / `^N` の degree 7 例）が翻訳でも正しく保持されていることを spot-check で確認。日本語残り0行・stale `/midi/` 絶対リンク無しも検証。

### 6.139 docs(user): bot second-opinion で gate(1.2) の誤記を修正 (#237) (Jun 19, 2026)

**Date**: 2026-06-19
**Status**: ✅ ドキュメント修正のみ（`vitepress build` 緑）
**Branch**: `237-doc-reconciliation-2.0.0`

PR #286 に @claude bot を docs↔実装の精度スコープで second-opinion レビュー依頼。内部監査（6.138）が見落とした **1 件**を検出・修正:
- **index.md gate 表**: 「`1.2`＝次の音と重なる（レガート寄り）」とあったが、`seq.gate()` は `[0,1]` クランプ（`sequence.ts:487` `Math.max(0, Math.min(1, value))`）で `gate(1.2)` は無言で `1.0` になる。`1.2` 行を削除し、「上限 1.0・オーバーラップは `{ }` レガート」を案内する `::: info` 注記に置換。
- bot は他の全照合項目（メソッドシグネチャ・度数式・`^N`・voicing 演算・comp セル名・quantize 挙動・LinkAudio 制約）+ 6.138 の修正4件を実装一致と独立確認。
- bot の任意プロセ提案（`comp()` のチェーン評価順の注記）は未検証のため見送り（精度パス中に未確認記述を足さない方針）。

### 6.138 docs(user): VitePress ピラーページの正確性監査で 4 mismatch を修正 (#237) (Jun 19, 2026)

**Date**: 2026-06-19
**Status**: ✅ ドキュメント修正のみ（`vitepress build` 緑・dead link 無し）
**Branch**: `237-doc-reconciliation-2.0.0`

sub-agent が 6.136 で書いた VitePress 6 ページをエンジン実装と突き合わせる正確性監査（sonnet agent + main の二重チェック）を実施し、**4 件の乖離を修正**:
1. **pitch-dsl.md `^N`**: degree 8 の構造的 +1 オクターブを見落とし、sticky シフト例の音名が 1 オクターブ誤り（`8=C5`→実際 C6、`8^0=C4`→実際 C5）。構造的オクターブの罠を避けるため例を degree 7／degree 1 に書き換え（`sequence.ts:917-927` + `degree-resolution.ts:96-102` で裏取り）。
2. **mode-scale.md**: 例が `.mode(dorian).root(2)` を使用していたが、`.mode()` と `.root()` は同一グループに併用不可（`resolveScopeToContext` で相互排他・`seq.mode()` 既定も無い）。「グループごとのモード切替」と「`.root()` 単独のルート移動」の 2 例に分割。
3. **voicing.md `^r`**: 実装は `Math.floor(random*3)-1`＝`{-1,0,+1}` 一様（約 1/3 で移動なし）だが「±1 oct 上 or 下に移動」と記載 → 「-1/0/+1（0=移動なし）」に訂正。
4. **voicing.md `.open()`**: 実装は close→上から 2 番目の声部を 1 oct 下げる（Drop 2、`resolve-chords.ts:314-318`）だが「オープンポジション」のみ → 正確な定義に。
- 残り 30+ クレーム（drop/invert/shell/rootless/voicelead/comp/cell/density/quantize/linkAudio 等）は実装と一致を確認（mismatch 無し）。「ビルド成功 + リンク解決」は正確性の代理指標にすぎず、挙動クレームの実装照合が本質という advisor 指摘に基づく監査。

### 6.137 docs(user): reconcile README.md + 拡張 README を 2.0.0 へ整合 (#237) (Jun 19, 2026)

**Date**: 2026-06-19
**Status**: ✅ 整合のみ（コード変更なし・テスト 1129 緑）
**Branch**: `237-doc-reconciliation-2.0.0`

ルート `README.md` が 2.0.0 と正面衝突する drift を解消（spec より drift が深かった）:
- MIDI を「Migration Notice（MIDI→audio 移行中）」「Legacy MIDI-Based (Deprecated)」「CoreMIDI/IAC Bus = not implemented」の **3 か所で死んだ機能扱い** → 2.0.0 の現役ピラーへ訂正。
- ヘッダを audio+MIDI 両出力に。Core Features に「🎹 MIDI & Pitch (2.0.0)」節追加（MIDI output / Pitch DSL / comp / LinkAudio / quantize）。「DAW Integration: VST/AU (planned)」→ LinkAudio 実装済に。
- Current Implementation Status を「2.0.0 is released」+ ピラー一覧に。歴史的詳細（audio phases / ICMC v1.1.0 / Phase 6-7 achievements / legacy MIDI phases）は `<details> Development history` へ退避。
- Technology Stack に MIDI(CoreMIDI/IAC)・Ableton Link を追加し「not implemented」行を削除。USER_MANUAL を canonical→**deprecated**（学習サイトを正規リンクに）。テスト数を「1129 passed, 23 skipped (1152) — 2.0.0」に更新。`v3.0`/`2.0.0-dev` の version label を一掃。
- `packages/vscode-extension/README.md`（.vsix の顔・最終更新 5/6 で 2.0.0 ピラー記載 0）: 「New in 2.0.0」節（5 ピラー）追加、`v1.x`→`2.0.0`、User Learning Site リンク追加。
- ライセンス節・examples 音楽内容は不変。#138 cold-install は実状況不明のため `⏳ Pending` 保持。

### 6.136 docs(user): VitePress user site に 2.0.0 ピラーページ追加 (#237) (Jun 19, 2026)

**Date**: 2026-06-19
**Status**: ✅ ドキュメントのみ（`vitepress build` 成功・dead link 無し）
**Branch**: `237-doc-reconciliation-2.0.0`

`sites/user/` に 2.0.0 の 5 ピラー解説を追加（JA 6 ページ + EN 6 スタブ）:
- `midi/` (JA): index（MIDI 出力・IAC 準備・`seq.midi/octave/vel/gate`・`global.key/midiLatency`）/ pitch-dsl（度数・変音記号・`^N` スティッキー・`[ ]` コード・`*n`・パターン/セクション変数・`{ }` レガート・`_` タイ・`@v`/`@g`）/ mode-scale（`mode()` ラティス・グループ適用・`.root()` スコープ）/ voicing（drop/invert/open/close/shell/rootless・ランダム・`.voicelead()`・`.comp()`/`.cell()`/`.density()`）/ link-audio（`linkAudio()`・`output()`・テンポリーダー・MIDI 共存）/ quantize（`global/seq.quantize()`・RUN は常に即時）。
- EN は `en/midi/` に「翻訳保留・JA 参照」スタブ 6 件。
- `reference/methods.md`（JA/EN）に §6 MIDI 出力を追加。`sidebar.ts` に「MIDI とピッチ表現（v2.0.0）」節（JA/EN）追加、「困ったときは / Help」を 15/16 に繰り下げ。
- root/key/scale 関連ページに「post-2.0 で見直し予定」警告ブロック。session-log は opt-in（dormant）の一行注記のみ。

### 6.135 docs(user): deprecate USER_MANUAL ja/en → VitePress (#237) (Jun 19, 2026)

**Date**: 2026-06-19
**Status**: ✅ deprecate バナーのみ（本体は履歴保持）
**Branch**: `237-doc-reconciliation-2.0.0`

`docs/user/ja|en/USER_MANUAL.md` は完全に pre-2.0（audio-only・新ピラー 0・en は `brew install supercollider` のまま）。先頭に **DEPRECATED バナー**を追加し VitePress user site（`sites/user/`）へ誘導。本体は履歴として保持（削除しない）。

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

## Archived sections

Older entries have been archived by month for readability:

- [2025-09](../archive/WORK_LOG_2025-09.md)
- [2025-10](../archive/WORK_LOG_2025-10.md)
- [2026-02](../archive/WORK_LOG_2026-02.md)
- [2026-04](../archive/WORK_LOG_2026-04.md)
- [2026-05](../archive/WORK_LOG_2026-05.md)
- [2026-06](../archive/WORK_LOG_2026-06.md)
