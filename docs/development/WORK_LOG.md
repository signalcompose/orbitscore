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

**残**: time-stretch / LinkAudio / α recovery floor は後続増分。examples/22 が `RUN`（one-shot ≈2秒）で audition しづらい点は polish 候補（本増分の Done には非該当）。

**Commit**: d3be514

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
