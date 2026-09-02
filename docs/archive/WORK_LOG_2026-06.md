# OrbitScore Development Work Log - 2026-06 Archive

**Archive Period**: 2026-06 (6.90-6.122; recent 6.123+ in ../development/WORK_LOG.md)
**Note**: This is an archived version of the work log. For recent work, see [../development/WORK_LOG.md](../development/WORK_LOG.md)

---

### 6.178 docs(wctm): change production runtime to a pi-based dedicated harness (Jun 28, 2026)

**Branch**: `claude/agent-external-data-harness-yob87g`
**変更ファイル**: `docs/specs-v2/WCTM_SYSTEM_SPEC_v1.md` §4 全面改訂 + §3.2 / §10 / ヘッダ改訂注 / 構成図凡例、`docs/specs-v2/IMPLEMENTATION_INSTRUCTIONS.md`（W-Runtime / ロードマップ図 / known-decisions 表）、`docs/specs-v2/DESIGN_DISCUSSION_RECORD.md` §14 新規（決定 #60–#63）。

**経緯**: laiso「Pi Coding Agent」記事を起点に大和が「このハーネスで外部データの受け取りをエージェント側で可能にできるのでは」と提起。設計対話の結論として **WCTM 本番ランタイムを Claude Code 二段構え（旧 decision #29）から pi（@mariozechner/pi-coding-agent）ベースの OrbitScore 専用ハーネスに確定**。

**なぜ変えたか（詳細は DESIGN_DISCUSSION_RECORD §14）**:
- **Claude Code は push を実行に持ち込めない**: MCP プロトコルは server→client push を持つが、Claude Code は `resources/updated` 未実装（#7252）・push 受信しても agent 不達（#33679/#36665）。WCTM の「小節到着が特徴量を駆動する」push 型本質要件と非両立。
- **自前イベントループ（pi）なら** 「小節到着→コンテキスト組立→Messages API 発火」を書け、外部データがターンを駆動できる（変わるのはターンを誰が発火するか）。
- **開発コスト**: 開発ツール（Claude Code）と本番ランタイム（pi）を分離すれば、A で測った数字は本番経路に移植不能（測定妥当性）+ 二重実装回避 + リハ中の柔軟性 → pi-first が有利。「即日動く」は薄いスケルトンで確保。
- **専用ハーネスの価値**: customTools で OrbitScore 語彙＝エージェントの道具（§6 橋）、SDK で orbitstudio 埋め込み、.orbslog をネイティブ作業記憶に。演奏ハーネス＝作曲ハーネスを共有コアに（本番後一般化）。

**核心の未解決問題（§14.5、要 大和確認）**: 「今どこを演奏しているか」= 形式内位置（bar:beat + セクション/コード）の検出。特徴量はテクスチャを与えるが形式位置を与えない。推奨初期案 = オペレーター舵取り + エンジン小節カウントのハイブリッド位置ラベル。本番の自律度は大和判断。

**据え置き**: Agent Bridge（脳なし MCP）・統一評価経路は不変。**コード変更なし（docs のみ）**。
### 6.177 feat(engine): γ M1 PR-B — real CLAP effect child + shared 1-block core (#357) (Jun 27, 2026)

γ M1 の **PR-B**。PR-A の transport の上に、**実 CLAP effect plugin を隔離 child プロセスで host** し、offline A/B parity を実 effect で確認する。設計正本 = `docs/development/POST_2.0_GAMMA_M1_DESIGN.md` §4.4/§4.6/§5(a)/§6。実装前に advisor 相談（① clack single-thread lifecycle を最初に証明 ② merged-RT 委譲を独立 commit 化 ③ closed-form oracle 採用）。

**抽出した共有資産（`orbit-clap-host`）**:
- `process_block_core(plugin, buffers, steady, input_events, data) -> bool` = 1-block CLAP 適用カーネル（effect=serial overwrite / instrument=add-mix 分岐・入出力配線は成功時のみ・steady 更新）。`ClapPostProcessor::process()` の effect/instrument 本体をこれに**委譲**（byte-identical）し、新規 `ClapEffectProcessor` も同じカーネルを使う = 二重実装を排除（設計 §4.4）。
- `instantiate_activate(...)` = discover→instantiate→activate→start_processing の load 経路を `ClapHost::load_plugin`（daemon）と `ClapEffectProcessor::load`（child/parity）で共有抽出。
- `ClapEffectProcessor` = **single-thread** effect-only ラッパ（`load → process_block → drop`）。daemon は activate=main / process=audio の別スレッド構成だが child は 1 スレッド直列。フィールド宣言順（`plugin`→`_instance`）で drop 順 = stop_processing→deactivate を同一スレッドに収め、carry-forward #1 の wrong-thread teardown を構造的に sidestep。

**新規 child crate** `rust/crates/orbit-clap-effect-child`（`orbit-clap-host`+`orbit-audio-sandbox` 両依存）= PR-A gain child の gain 乗算を `ClapEffectProcessor::process_block` に差し替え。transport protocol（per-slot `seq_tag`/`seq_done`）は gain child と同一。input slot→scratch（ループ前確保=RT安全）→in-place effect→output slot。**依存の向きは child→transport のみ**で `orbit-audio-sandbox` は child crate に依存せず clack-free を維持（`cargo tree -p orbit-audio-sandbox` に clack 不在 = fault 隔離の不変条件・設計 §4.6）。

**検証（advisor sequencing）**:
- **基礎証明（最初に実行）**: `effect_processor_smoke_gated`（`orbit-clap-host`）で single-thread の load→process_block→drop が実 test-effect で成立・出力 = 0.5×入力。child crate を建てる前にこの foundation を確証。
- **PR-B Done（gated・offline・device 不要）**: `effect_parity_gated`（`orbit-clap-effect-child`）= **closed-form oracle**（OOP child 出力 == `input*0.5` を `max_abs_diff==0.0` で sample-exact・transport+CLAP 同時検証）+ **A/B parity**（in-process side A == OOP side B）。oracle は両側同一コードでなく独立な数学的解と突き合わせる点で in-proc-vs-OOP より強い（advisor ③）。
- **merged-RT 委譲の非回帰（独立 commit・前後計測）**: gated daemon test を委譲の**前後で実行**し byte-identical を確認 — effect `ratio 0.50000` / synth `post_mix_peak 0.25000` が一致（callback_count の ±1 は固定 sleep 窓内の cpal callback 回数のゆらぎ）。
- **workspace 全体**: `cargo test --workspace --features clap-host` 全緑（device あり: core 42 / daemon 8+protocol 19 / native 24 / sandbox 14 / verify 23 / clap-host 12 / spike 7+3 等）/ `cargo clippy --workspace --all-targets --locked -D warnings` + `-p orbit-audio-daemon --features clap-host` clean / `cargo fmt --check` clean。実 CLAP の gated 検証は test-effect dylib（workspace 非 member）ビルド要のため `#[ignore]`・CI backstop は PR-A gain parity（clack 非依存）。daemon spawn/watchdog/respawn 統合は **PR-C**（PR-A 同様 daemon の実 stream 統合は無改変）。

**PR-B round-1/2 review 収束（`/simplify` + `/code:pr-review-team`）**: `/simplify` の cleanup（`InstantiatedPlugin.note_port_index` 重複除去 / no-op rename 除去 / child loop の slot index/offset hoist）適用後、`/code:pr-review-team` を回し round-1 指摘を fixer pass で解消、round-2 で 4 reviewer 全員が **Critical=0 / Important=0** を独立確認（自己申告でなく独立再レビューで裏取り）。
- **silent-failure Critical（child が `process_block` の bool 戻り値を破棄＝CLAP 失敗が child で不可視）→ MINOR 格下げ + 解消**: `process_errors` カウンタで集計しループ終了時に `eprintln` 報告（RT loop に IO を入れない）。child→host の health signal を `SharedRegion` に乗せるのは **PR-A の frozen transport を触る**ため見送り、**PR-C で §4.5 supervision signal 群と一緒に設計**（child は PR-C まで本番 consumer 無し = severity 妥当・advisor 判断）。残存（異常終了時の未報告 / host stderr 可視性）も PR-C 前提として tracking。
- **`#[must_use]`（Important）→ 完全解消**: `process_block` / `process_block_core` 両方に付与。daemon `process_ok` 束縛 / child `if !...` / parity・smoke の `assert!` の全 call site が戻り値を消費。
- **test gap → CLOSED**: ① partial-block を実 CLAP で検証（parity を `assert_oop_parity` 化し 512f 倍数 + 300f 端数=128+128+44 の 2 ケース・最終 `n_frames < block_frames`）② 新コードの初の**非 gated CI 被覆**（`tests/cli.rs` の child 引数バリデーション 4 ケース[--shm/--plugin/未知/値なし] + `controller.rs::instantiate_activate_nonexistent_path_is_err`＝discovery 失敗が panic でなく Err 伝播・dylib/device 不要で CI 実行可）。「CI で test-effect dylib をビルドして gated parity を回す」は norm（gated=実機 RUN）に合致し PR-C の CI 配線と一体設計が適切なため follow-on。instrument 分岐の offline 検証も PR-C。
- **comment 精度**: BufferSize::Fixed 契約の RT-safe caveat cross-ref（processor.rs）/ Cargo.toml の依存方向を能動形に / main.rs:93 SAFETY 追記 / parity doc の partial 条件を `n_frames < block_frames` に訂正（`< MAX_FRAMES` は両ケースで真＝区別しない）。
- **@claude bot レビュー（scoped）+ clack teardown 機構の source 検証**: 内部収束後、advisor 判断で重点2点（single-thread teardown drop 順 / `process_block_core` byte-identical 委譲）に絞り bot レビュー → 両点 no-blocker。ただし advisor 指示「API 契約 claim は pinned source で裏取りしてから cite」に従い `effect.rs` の drop-順 rationale を clack（pinned rev `f874e858`）で検証したところ、**当初コメント（及び bot が是認した rationale）が機構的に不正確**と判明: `StartedPluginAudioProcessor` は Drop を持たず stop_processing は呼ばない。実 teardown は `plugin`/`_instance` が共有する `Arc<PluginInstanceInner>` の**最後の Arc drop 時に `PluginInstanceInner::Drop`** が stop_processing→deactivate→destroy をまとめて実行（`host/src/plugin/instance.rs:232`）。`PluginInstance::Drop`（`host/src/plugin.rs:399`）は**唯一所有者のときだけ** inner を drop し、さもなくば wrong-thread teardown 回避のため**意図的に leak**する。よって field 宣言順 `plugin`→`_instance` は load-bearing で**正しい**が、逆順の failure mode は crash でなく **silent leak**（smoke/parity は順序が逆でも緑）→ コメントが順序を守る唯一のガード。コメントを Arc-sole-owner 機構に**訂正**し、clack bump 時に再確認すべき2 Drop site を anchor（コード挙動は単一スレッド teardown で検証済＝不変・doc-only 訂正）。
- 再検証: fmt / clippy（workspace + daemon clap-host・-D warnings）clean・非 gated 全緑（cli 4 + controller unit + lib 13）・gated 全緑（parity[partial 込み] + smoke）・daemon byte-identical 維持（effect ratio 0.50000 / synth peak 0.25000 = `#[must_use]`/doc 変更は codegen 不変）。

### 6.176 feat(engine): γ M1 PR-A — out-of-process sandbox transport crate (#355) (Jun 27, 2026)

γ 本実装（#354）を owner 2026-06-27 決定で **M1（effect 隔離）/ M2（instrument+automation・spike-first）に段階化**したうちの **M1 の PR-A**。advisor 相談（設計 checkpoint）+ 3 サブシステムの並列探索（spike transport / clap-host seam / verify harness）を経て設計。設計正本 = `docs/development/POST_2.0_GAMMA_M1_DESIGN.md`。

**新規 production crate** `rust/crates/orbit-audio-sandbox`（spike `orbit-sandbox-spike` から **transport だけ**昇格・計測 scaffolding は持ち込まない）:
- `transport`: 親子共有 `SharedRegion`（file-backed mmap MAP_SHARED + SPSC ping-pong）。**N-slot-generic**（`slot_offset = seq % SLOTS` / outstanding guard `seq_done >= new_seq - SLOTS` / 配列 `BUF_LEN*SLOTS`）= advisor #1: cross-process `repr(C)` 構造に slot 数を焼き付けず、PR-C の 2 vs 3 決定を **`SLOTS` const 1 つの変更**で済ませる（`seq & 1` は 2 のべき乗専用だった）。`control` flag で child を clean 終了。**memmap2 のみ依存**（native/cpal/clack 非依存 = 依存隔離が fault 隔離の鏡）。
- `host::PipelinedEffectHost`: 候補B 状態機械（submit `data`→ 前ブロック read で in-place 上書き・spin なし）。stale = **repeat-previous**（owner 決定・直前 good block 再出力でクリック回避）。RT-safe（alloc/lock/syscall なし・last-good 事前確保・生ポインタは atomic field 参照と slot 単位 copy のみ）。
- `bin/sandbox-effect-child`: gain child（clack 非依存・実 CLAP child は PR-B）。A/B parity の OOP 側相手。
- `offline`: cpal 非依存の同期ドライバ（submit→spin 待ち→read）+ A/B parity primitive（`max_abs_diff` / `render_in_process_gain`）。

**検証 3 分割**（advisor #2: offline は同期で repeat-previous を構造的に exercise できない → 別建て）:
- **(a) audio 正しさ**: 2 層。① tests/host_child_integration.rs = **production path の CI root-of-trust**: 実 `PipelinedEffectHost`（候補B 状態機械）+ 実 spawn child + 実 mmap を cpal 無しで統合し、各 callback 間で `seq_done` を追いつかせて毎回 fresh path に当て、入力を gain 倍し **ちょうど 1 block 遅延**させた結果に **sample-exact 一致**（決定論）。本番で実際に走る両プロセス半分を一緒に動かす唯一の CI テスト。② tests/parity.rs = transport + **同期ドライバ**の sample-exact A/B（diff=0.0・64/256/300/512f）。①が pipelined host を、②が transport（mmap+SPSC+slot index）を検証する別役割（parity.rs の同期ドライバは本番では使わない経路なので、これ単独を production カバレッジと誤読しない）。両方 audio device 不要で **CI 実行可**。
- **(b) pipeline 状態機械**: host.rs の **mock-child**（seq_done を制御）unit test で steady-state +1block 遅延 / repeat-previous（seq_done 保留→last-good 再出力）/ stall（child 停止→slot 再利用待ち）を決定論検証。
- **(c) RT stale-rate 32-64f**: gated 実機（PR-C）。

advisor #3（gain child を PR-A に昇格＝parity 相手）/ #4（M1 = master-effect 単独 post-processor・chaining は M2+・spec 明記）/ #5（sample-exact parity 採用）も反映。daemon adapter（`impl PostProcessor`）+ spawn/supervision は PR-C へ（PR-A は daemon 無改変・自己完結）。

**検証**: 新 crate の `cargo test`（unit 7 + offline 2 + parity 2 + host_child_integration 1 = 全緑）/ **workspace 全体 `cargo test --workspace` 全緑**（新 member 追加後の回帰確認・advisor 指摘）/ `cargo clippy --workspace --all-targets -D warnings` clean（const assertion 化で `assertions_on_constants` 解消）/ `cargo fmt --check` clean / `cargo deny check licenses bans` ok（memmap2/anyhow は permissive・spike で vetted 済）。CI は Rust gated 非実行のため (a)(b) の offline/integration が CI 根拠・RT 実機 stale-rate は PR-C gated。

**PR-A round-1 review 対応（per-slot メタデータ・PR #356）**: `/code:pr-review-team` round-1 の load-bearing 指摘（code-reviewer の per-slot メタデータ不在・可変 buffer findings を subsume）を advisor 設計検証の上で修正。**spike #351 の child が `cur > last` で latest 処理だったことを確認**し（silently diverge しない）、その discipline を維持したまま `SharedRegion` に **per-slot `seq_tag: [AtomicU64; SLOTS]`** と **per-slot `n_frames: [AtomicU32; SLOTS]`** を追加（単一 `n_frames` を置換）。host READ は `seq_done >= target` でなく `seq_tag[slot(target)] == target`(Acquire) で fresh 判定し、「latest 処理」で skip された中間 seq の **false-fresh を防止**（global monotone な seq_done では skip 検知不能・観測 counter = PR-C の slot 数決定指標を保護）。copy 長は `n_frames[slot(target)]` で clamp し可変 buffer の stale tail を防ぐ。`seq_done` は submit guard 専用に残す。child/offline/mock の三者を同一 per-slot プロトコルへ同期（advisor #1: mock を実 child と別プロトコルにすると unit test が phantom を検証する）。**追加テスト**: skip-not-false-fresh（load-bearing・旧 seq_done 判定なら false-fresh していたケース）/ recovery-after-stall / submit-guard-exact-boundary / over-BUF_LEN-clamp / open_shared の missing-file・too-small。comment-analyzer の SAFETY 修正（offline.rs:70 が guard でなく scope の `mmap` が backing を生かす旨に訂正・他 SAFETY 完全化）。supervision 3 件（child ExitStatus 捕捉 / 親死亡 watchdog / crash-vs-timeout 診断）は `TODO(PR-C)` で defer（supervisor consumer が未在）。再検証: `cargo test -p orbit-audio-sandbox`（13 unit + 1 integration + 2 parity 全緑）/ `cargo test --workspace` 全緑 / clippy -D warnings clean / fmt clean / `cargo deny check` ok。

**PR-A round-2/3 収束（PR #356）**: round-2 で pr-test-analyzer の Critical 1（read-clamp の差分検出テスト欠如 = 固定フレーム既存テストは alloc_zeroed で slot tail が 0.0 のため regression を捕捉できない）に対し `pipelined_read_clamps_to_target_slot_frames` を追加（slot 末尾に sentinel 9.0 を仕込み、現 callback が target より大きい buffer を要求しても sentinel が漏れないことを検証 = clamp を `copy=count` に退行させると失敗する真の差分テスト）。Drop の silent-failure 2 件（try_wait の Err アームを timeout と分離 / remove_file 失敗ログ）+ safe fn 3 つの `# Safety`→`# Note` も対応。round-3 で 4 reviewer 全員が **Critical 0 / Important 0** を独立確認（収束は self-declare でなく独立再レビューで裏取り）。`cargo test -p orbit-audio-sandbox` 14 unit 全緑。

**⚠️ spike 数の provisional 性を設計doc に記録（advisor 指摘）**: per-slot `seq_tag` 機構は **PR-A の新規**で spike #351 には無い。spike は `seq_done`-only プロトコル（false-fresh on skip）を計測したので、その `pipelined_stale` / 「32f feasible」verdict は real glitch を **undercount**（skip が最も起きる 32f に集中）している。よって spike 数を slot 決定の根拠にせず、**PR-C の gated 実機計測を corrected `seq_tag` プロトコル下でやり直してから 2 vs 3 slot を決める**旨を `POST_2.0_GAMMA_M1_DESIGN.md` §5 (c)・§6 PR-C 行・新規注に明記。correct path（`seq_tag`）は単一スレッド mock + 同期統合テストのみで、**実並列下は未計測**（PR-C で計測）。

### 6.175 spike(engine): γ latency policy fork — pipelined solves 64f (#350) (Jun 27, 2026)

γ staging の次段（Step0 #348 の後）。Step0 verdict §6 の **latency policy fork を計測して決める**（"run before you plan"）feasibility spike。owner 方針（DAW 並み小バッファ性能が目標）により 64f/32f を edge case ではなく性能ゴールとして扱う。

`orbit-sandbox-spike` の `sandbox-host` に 3 モードを追加して計測:
- **候補 A**（`--child-rt-priority`）: child の spin スレッドを mach `THREAD_TIME_CONSTRAINT_POLICY`（RT）へ（mach2・macOS 限定 target 依存）。
- **in-process 対照**（`--in-process`）: child を使わず callback 内で直接合成し floor を測る。
- **候補 B**（`--pipelined`）: host は spin せず block N を渡し N-1 を読む。ping-pong バッファ（input/output 各 2 slot・`seq&1` で uniform index・child も変更）+ 2-outstanding guard（`seq_done >= new_seq-2`）。判定軸 = **stale 率**（callback_max ではない・advisor 指摘）。

**計測（MacBook Pro arm64・44100Hz・release・同一機材）**:
- **候補 A は棄却**: 64f で worst callback_max ~2〜2.75ms（縮まず）、ある run で 154 overruns（≈223ms 無音）に不安定化。連続 spin スレッドへの time-constraint は macOS demote を招く。→ tail は child プリエンプト由来ではない。
- **in-process 対照**: 64f worst callback_max = **6µs（0.41%）**。→ ~2ms tail は OS/driver floor ではなく **sandbox round-trip 待ち固有**。owner 主張「ネイティブ楽器=in-process は小バッファ OK」を実機で裏付け。
- **候補 B が解く**: callback_max は 32〜256f すべてで ~3.5〜8µs（**<0.5% budget**）= tail 消滅。stale 率 = 256/128f 0% / 64f ≈0.11%（15s・11/10330）/ 32f ≈0.45%（31/6861）。stall は 64f+ で 0・32f で数件。

**Verdict = 候補 B（one-block-pipelined）採用**。out-of-process sandbox を 32f まで小バッファで feasible にする。代償 = 1 block 遅延 + stale <0.5%（@32-64f・production は repeat-previous）+ 32f で slot 再利用圧（slot 3 化を検討）。同期設計の「≥256f 下限」制約は pipelined では外れる。verdict = `docs/development/POST_2.0_GAMMA_LATENCY_FORK_SPIKE.md`。次 = γ 本実装で pipelined 採用 → event/param IPC → daemon 統合 → cutover #108。

### 6.174 spike(engine): γ out-of-process sandbox feasibility — Gate1/Gate2 verdict (#348) (Jun 27, 2026)

post-2.0 native engine の **γ（out-of-process sandbox）** フェーズ Step0。正本 `POST_2.0_NEXT_STEPS.html` の staging 指示「γ は単一 /goal にせず『daemon CLAP 統合（#340/#341 完了）→ sandbox スパイク』と段階化」に従い、feasibility spike（実装ではなく stop&report ゲート付き）を実施。

**新規 crate** `rust/crates/orbit-sandbox-spike`（publish=false・2 binary）:
- `sandbox-host`: cpal 出力 RT callback で 1 ブロックを共有メモリ越しに child に渡し gain を掛け戻させる round-trip を **bounded spin**（timeout 付き）で待つ。別スレッド watchdog が child の死を検知し clean child を respawn。
- `sandbox-child`: 隔離エフェクトプロセス。`--crash-after-blocks` で自発 segfault し Gate2 を駆動。
- 同期は file-backed mmap(MAP_SHARED) 内の `seq_request`/`seq_done` atomic の SPSC Acquire/Release ハンドシェイク（新規 sync crate 不要・futex 非依存）。計測ハーネスは `orbit-clap-spike`（#295 baseline）の bucket histogram p99 / callback_max を流用。

**Gate1（warmed・synchronous・各 buffer 3 回・MacBook Pro arm64・44100Hz）**: 判定軸は worst-case `callback_max ÷ budget`（`overruns` は CoreAudio が xrun を発火しないため不可・#295 fence）。
- 512f（budget 11.6ms）: worst callback_max 2.15ms = 18.5% → **PASS**。
- 128f（2.9ms）: 2.83ms = 98% → 余裕ゼロ（reliably safe とは言えない）。
- 64f（1.45ms）: 4.15ms = 286% → **違反**。
- mean/p99 は µs（mean 6〜21µs / p99 大半 <0.5ms）。**worst-case tail（~2〜4ms）は buffer サイズ非依存の定数**（scheduling jitter＝child/host のプリエンプト由来）→ budget がこれを上回る必要があり、同期設計は実質 **≥256 frame の buffer 下限**を強制。tail はプロセス隔離ではなく**同期 round-trip 設計の代償**。

**Gate2（crash 封じ込め + watchdog 復帰）= PASS**: child SIGSEGV → **host プロセス生存**（C-ABI segfault をプロセス境界で封じ込め）→ watchdog respawn → audio-flow 復帰（`recovered=true`・peak 0.25）。512f は budget 内 recovery（overrun 0）で無音落ちすら無し。64f は bounded spin が callback を timeout で頭打ち（deadlock 無し）・gap 中 数十 callbacks が glitch-to-silence（respawn 窓 ≈ 数十 ms）。**未証明**: plugin 内部状態（preset/automation）の復帰（child は stateless gain）。

**Verdict = FEASIBLE**（両ゲート PASS）。低 buffer の tail は既知・対処可能な設計制約で blocker ではない。**latency policy の fork（spike の output・事前に決めない方針どおり）= 「synchronous + child RT 優先度」 vs 「one-block-pipelined」**（どちらも本 spike では未計測の candidate・γ 実装で計測して決める）。verdict は `docs/development/POST_2.0_GAMMA_SANDBOX_SPIKE.md` に記録。advisor が verdict 解釈を確認（4 点の scoping 修正を反映）。`/simplify` + `/code:pr-review-team`（4 レビュアー）で全 Critical/Important を解消: input data race（live child が timeout 超過時の UB）を **1-outstanding request モデル**で構造的に排除・`measurement_invalid` sentinel で respawn 失敗/検知エラー/watchdog panic の誤データを可視化（authoritative に見える誤 go/no-go を防止）・`child_processed` の warm-up 汚染除去・p99 overflow saturation テスト追加。defer: event/param IPC・複数 plugin・境界越え automation・本番 daemon 統合（cutover #108）。

### 6.173 docs(engine): S1b-1 low-latency strict floor 32/64 frame verdict (#295) (Jun 27, 2026)

pre-γ hardening スプリント PR B（#295 = S1b low-latency strict test + dynamic hot-install follow-up）。owner 再パッケージで risky な #295 を #342 系から分離した独立 PR。

**重要な発見**: 計測ハーネス `orbit-clap-spike` は S1b-1（`--buffer-frames` で `BufferSize::Fixed` 強制）も S1b-2（`--hot-install-after-secs`）も**実装済**で、§13 が既に 128/256 frame を実証済。owner 拡張（2026-06-26）の **32/64 frame 実用下限**が未カバーだったため、それを埋める **計測 + verdict（docs-mostly・本番コード変更なし）**。

**計測**（MacBook Pro 内蔵 Output・arm64・macOS 26.5.1・44100Hz・`CLAPTestSynth` release dylib・8s）:
- release static: 256=8.8µs(0.15%) / 128=9.2µs(0.32%) / **64=9.2µs(0.63%)** / **32=6.3µs(0.87%)** — 全 `resize=0`・`xrun=0`・`peak=0.25`。
- debug worst-case: 64=27.4µs(1.89%) / 32=52.7µs(7.26%)。
- hot-install(release・+3s): 128=#1034/6.4µs / 64=#2069/13.5µs(0.93%) / 32=#4136/5.9µs — install 後発音・`resize=0`。

**verdict = PASS（強い余裕・リスク柵 不発火）**: device は 32 frame まで `BufferSize::Fixed` を honor（realloc 経路に到達せず）。release 32 frame で budget の 0.87%、worst-case でも 7.26%。hot-install ハンドオフは 32/64 でも成立。#295 のリスク柵「device が 32/64 を honor しない / 持続 xrun」は発火せず。

**精度フェンス**（過大主張回避・advisor 指摘）: ①低レイテンシは spike 経由のみ計測可（daemon は `BufferSize::Default` で buffer 非強制・spike-at-32 は同一 process 経路の proxy）②hot-install の daemon 実モデルは `clap_host_gated` が本筋、spike `--hot-install` は機構の二次 proof ③spike は `orbit-clap-host` でなく自前旧 host コピー（統一リファクタは本 PR スコープ外）。

**レビュー**: docs-mostly のため advisor 指針で軽量経路（comment-analyzer + advisor・/simplify + /code:pr-review-team は skip）。`clap_lowlatency_gated.rs` 等の新規 gated test は追加しない（spike が反復可能ハーネス・gold-plating 回避）。`docs/development/POST_2.0_A0_RT_INTEGRATION_DESIGN.md` §13「S1b-1 拡張」+ ヘッダ status + retired-assumptions 注記を更新。

### 6.172 chore(engine): rescan warn-only + teardown busy-wait verdict (#342-#2 / #342-#3) (Jun 27, 2026)

**Date**: 2026-06-27
**Status**: ✅ 実装完了（PR レビュー前）
**Branch**: `342-rescan-warn-teardown-verdict`
**Issue**: #342（項目2・項目3）
**スプリント**: Pre-γ hardening スプリント PR A（#342-2 + #342-3 を1 PR に束ね・owner 承認）。B = #295 は独立。

軽量 2 項目を1 PR に束ねた（owner 判断・§2 の「#342 を1 PR に束ねる」override）。リスクのある #295 とは切り離す。

**#342-#2: audio-port rescan warn-only（`orbit-clap-host/src/host.rs`）**
- `HostAudioPortsImpl::rescan`（AudioPortRescanFlags）は S1 で no-op（`is_rescan_flag_supported=false` 広告済）。
- plugin が動的にポートを変えると構築時固定の `is_effect`（`has_audio_input`）が陳腐化しうる。サイレントを避け **warn ログ1文**を追加して可視化（`flags` を Debug 出力）。
- **動的ポート対応そのものは作らない**（#342 項目2 の将来作業）。note/param rescan は対象外（is_effect 陳腐化は audio ports 固有）。

**#342-#3: teardown busy-wait は据え置き（verdict・`orbit-audio-daemon/src/clap_host.rs`）**
- `ClapTeardownGuard::drop` の `sleep(2ms)` poll は **変更推奨なし**（現結論）。guard は非 RT スレッド（`main()` 非 async）で走り、RT audio thread は `done` を atomic store するだけ。Condvar 置換は notify 時に RT thread へ mutex を強いて **RT を悪化**させる。
- 将来 async context から `StreamGuard` を drop する場合のみ async yield / atomic-wait に変える旨を**コードコメントで明記**（将来の誤った "fix" を防ぐ）。コード logic 変更なし。

**ローカル検証**: fmt（`--all --check`）clean / clippy（clap-host + daemon clap-host・`-D warnings`）clean / test（clap-host 11 + daemon protocol 19 ほか・0 failed。protocol の loopback bind は sandbox 制限で要 sandbox-off 実行）。

**レビュー（/simplify）**: 4 agent（reuse/simplification/efficiency/altitude）。reuse+efficiency+altitude が一致して **warn-once latch** を指摘（unthrottled warn は misbehaving plugin の繰り返し rescan でログ flood）。`OrbitHostMainThread` に `bool` フィールド `warned_rescan_unsupported` を追加し warn-once 化（main-thread 専用なので atomic 不要・`session.rs` の `device_lost_reported` 慣習を再利用）。host.rs コメントは warn メッセージとの重複を削り latch の根拠に絞った。clap_host.rs の #342-#3 verdict コメントは altitude が「load-bearing な anti-footgun・clean」と判定し維持（simplification の「1行圧縮」より altitude を採用）。

**レビュー（/code:pr-review-team）**: code-reviewer / silent-failure-hunter / pr-test-analyzer = **Critical/Important=0**。comment-analyzer のみ **Critical 1 + Important 2**（#342-#3 verdict コメントの事実誤り）を指摘し、一次情報で裏取りして全て採用・修正:
- **C-1**: 「`main()` の非 async スコープで drop」は誤り。`_stream_guard` は `async fn run()`（`#[tokio::main]` multi_thread・worker 2）末尾・`server::serve().await` 返却後に drop = **tokio worker の async context**。teardown 中 worker を最大 TEARDOWN_TIMEOUT(500ms) ブロックしうるが、通常は RT thread が即 `done` を立て数 ms で抜け・shutdown フェーズなので許容（`done` を立てる cpal callback は worker と独立で deadlock しない）→ コメント訂正。
- **I-1**: 「RT thread は `done` を atomic store するだけ」は過小。実際は stop_processing(CLAP 仕様=RT 必須)+buffers 解放+install ring drain も行う（processor.rs で確認）→ コメント訂正。
- **I-2**: 「Condvar は notify 時に RT thread へ mutex を強いる」は技術的に誤り（`Condvar::notify_one` は `&self`・mutex 保持不要）。真の RT 不適理由は notify の syscall(futex/psynch_cvsignal) レイテンシ → コメント訂正（code-reviewer は mutex 説を是としたが comment-analyzer が正しい・一次情報で裁定）。
- Minor 対応: pr-test-analyzer の「real plugin 不要で latch を単体テスト可」を採用し `rescan_warn_latches_after_first_request`（`AudioPortRescanFlags` を trivially 構築・UFCS 呼び）追加。silent-failure の「再要求 flags の観測性」を `else { tracing::debug!(...) }` で対応（warn flood 回避・debug は既定抑制）。
- 再検証: fmt/clippy clean・clap-host 12 + daemon protocol 19 ほか 0 failed。

### 6.171 fix(engine): drain install ring on teardown to prevent plugin-instance leak (#342-#1) (Jun 26, 2026)

**Date**: 2026-06-26
**Status**: ✅ 実装完了（PR レビュー前）
**Branch**: `342-install-ring-drain`
**Issue**: #342（#340 follow-on hardening・①install-ring teardown drain）

#340 review が「install-ring teardown drain / wrong-thread stop_processing 残余」を #342 に分離していた。
本 PR で一次情報（clack `f874e858` + rtrb 0.3.4）を精読し、**リスクの実体を確定**したうえで最小修正した。

**確定した実体 = wrong-thread UB ではなく「リーク」**:
- `StartedPluginAudioProcessor` は `Arc<PluginInstanceInner>` で `Drop` impl を持たない（process.rs:401）。drop は Arc 減算のみで plugin code を呼ばない。
- `PluginInstance::Drop`（plugin.rs:399-410）は **sole Arc owner のときだけ** teardown し、processor handle が残存すれば意図的に **leak** する（wrong-thread teardown を避ける clack の設計）。
- `PluginInstanceInner::Drop`（instance.rs:232-254）→ active なら `deactivate_with`（is_started なら stop_processing → deactivate → destroy）を **その drop が走るスレッド**で実行。
- rtrb `RingBuffer::Drop`（lib.rs:233-242）は未消費スロットを drop するが、Producer/Consumer 共有 Arc の **最後の drop 時のみ**発火。
- 帰結: Consumer（cpal `_stream`）が先に drop（refcount 2→1・未 drop）、Producer（clap・`host.shutdown()` の**後**）drop で初めて InstallMsg が drop される。よって `host.shutdown()`（= PluginInstance drop）時点で processor Arc が ring 越しに残存 → sole owner でない → **instance leak（deactivate/destroy 永久未呼出）**。
- 発生条件: plugin load → install 着地前に teardown（teardown 分岐が hot-install pop より前で early-return する窓）。狭いエッジだが実在のリーク。

**採用 A: drain-and-drop（owner 承認）**:
- cpal teardown 分岐で `drain_install_ring`（install ring を pop 全消費 → InstallMsg を cpal スレッドで drop = Arc 解放・benign）。
- これで `host.shutdown()` より前に processor Arc が解放され、`PluginInstance::Drop` が sole owner となって stop_processing+deactivate+destroy を **clap スレッド（= start_processing と同一）**で正常実行する。
- spec 記述「専用スレッドへ handoff」は Arc 解放による暗黙 handoff で達成（実 teardown は clap スレッド）。新規 channel 不要・最小差分。spec deviation は §1 rule に従い owner 承認 + 本ログで記録。

**テスト**:
- drain を generic 関数 `drain_install_ring<T>(&mut Consumer<T>)` に切り出し、`DropCounter` で「全 pop + 全 drop + ring 空」を決定論検証（real plugin 不要）。
- gated 実機 RUN（CoreAudio + test-synth/effect dylib）で正常 teardown 経路の非回帰を裏取り: synth peak 0.25 / effect ratio 0.50000・teardown panic/UB なし完了。

**ローカル全 green**: fmt clean / clippy `-D warnings`（clap-host + daemon clap-host）/ cargo test workspace 0 failed（新規 drain test 含む）/ gated synth+effect GREEN。

**CI（#326 で入れた Rust CI が #342-#1 を検証）**: `fmt / clippy / test`・`license / dependency gate`・`code-review` 3 チェックすべて SUCCESS。

**レビュー（/simplify + /code:pr-review-team）**:
- `/simplify`（4 agent）: drain_install_ring の戻り値 `u64`→`()` 簡素化（production で破棄・テストは DROPS+空で等価）/ Drop に install ring 非空検知ログ追加（altitude: 既存 plugin 検知と対称化）。reuse/efficiency は clean。
- `/code:pr-review-team`（code-reviewer / silent-failure-hunter / pr-test-analyzer / comment-analyzer）: **Critical=0 / コード Important=0**。code-reviewer は 4 観点（drain ordering・RT 安全・Drop スレッド・doc 正確性）すべて clack/rtrb ソースで検証。
  - 「Important」ラベル 2 件はいずれも doc/test-comment レベル: ① doc「Arc 減算のみ」が ordering-contingent（silent-failure I-1 + comment-analyzer）→ StreamGuard field 順 + host が Arc 保持の不変条件を doc に明記。② 実 leak シナリオは real plugin + 非決定 race で自動テスト不可（pr-test-analyzer・accepted structural gap）→ 単体テスト + gated テストに非カバー注記。
  - Minor 対応: Drop ログの因果文言是正 + `slots()` 占有数追加（code-reviewer + silent-failure M-2）/ 単体テストに empty-ring ケース追加。
  - 見送り: 正常経路 drain の silent 性への RT-path tracing（agent 自身の atomic 推奨と矛盾・benign event・Drop backstop で異常系は可視化済み）。

**advisor 収束相談（2026-06-26）**: 収束**確立**（第2フル ラウンド不要・provenance は transcript の skill 起動 + CI green on ccaa240・#326 と同論理）。**@claude bot = ordering 不変条件 + clack Drop/Arc 相互作用に絞った scoped review が妥当**との助言。

**@claude bot scoped review（2026-06-27・owner GO 後に起動）**: load-bearing な正当性（正常 teardown 経路）を一次情報まで降りて検証し **Critical/Important=0 で確認**。リーク解析（wrong-thread UB → leak 再フレーム）正しい / drain が `host.shutdown()` 前に走る（field drop 順 + `teardown_done` 後書きスピン）/ drain 時点で `PluginInstance` Arc 生存（refcount 0 非到達）/ drain は RT benign、すべて ✅。
- **bot の non-blocking 観察を post-bot advisor consult で精査 → bot の framing は誤りと判定**: bot は「panic-during-load corner はいずれの経路でも deactivate 未呼出 / 本 PR が新規導入したものでない」としたが、これは false。正しくは（advisor + 当方分析）**clap スレッドが load 中に panic した場合に wrong-thread deactivate の質が main（drain なし版 = `install_rx` drop）→ RT（drain 版 = audio thread）に変わる新挙動**。極稀（load 中 panic 要）+ 既存 panic-時 leak 病理に乗る + 正常経路では非発生 → #342-#1 スコープ外。**#342 項目4 として追跡**（コードで guard する場合は code change で再レビュー要）+ `drain_install_ring` doc に corner note 追記。
- **再レビュー不要（advisor）**: コード変更は doc コメント追記のみで load-bearing logic 不変。8-agent ループの再走は不均衡。マージは owner の明示指示待ち（self-merge 禁止）。

---

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

**CI が炙り出した harness bug の修正（#326 の価値そのもの）**: 初回 CI で `protocol.rs` の 7 テストが
**ubuntu のみ** fail（macOS ローカルは green）。全て実 `LoadSample`(kick.wav) 後のコマンド reply 待ちで
`common/mod.rs` の `recv_reply_with_events` が「64 messages 以内に reply 来ず」で panic。root cause は
**scan budget の数え漏れ**: `for _ in 0..64` が全メッセージを数える一方、`StreamStats`（1 Hz ticker が
`start_paused` の auto-advance で reply 前に積む noise）を budget から除外していなかった（コメントは
「budget 圧迫回避」を主張していたが events vec から外すだけで loop counter には効いていなかった）。
ubuntu の scheduling 差で reply 到達前に 64 を超過。修正 = **`StreamStats` を budget に数えない**
（非 StreamStats を 64 で cap・anti-hang の絶対上限 backstop 併設・reply 未達時は何を見たかを panic に出力）。
挙動は behavior-preserving（macOS 19/19・ubuntu は push で検証）。修正後 CI で `fmt / clippy / test` 1m43s green
（7 テスト含む全 19 が ubuntu でも pass）= 仮説確定。

**cargo-deny job の network 堅牢化**: 同 CI で `license / dependency gate`（cargo-deny）が 10s で fail。原因は
依存・config ではなく **crates.io sparse-index 取得の transient flake**（`cargo metadata` の index 更新が
HTTP2 framing / SSL unexpected eof）。`rust` job は rust-cache で registry が温まり network 依存が低い一方、
**cargo-deny job は toolchain/cache 無しで毎回 cold fetch** していた。対策: cargo-deny job に
`dtolnay/rust-toolchain@stable` + `Swatinem/rust-cache@v2` + `CARGO_NET_RETRY=10` を追加（registry を温め
cold fetch への露出を減らす）。修正後 CI で両 rust job + code-review すべて green（cold cache でも cargo-deny 通過）。

**レビュー（/simplify + /code:pr-review-team）**:
- `/simplify`（reuse/simplification/efficiency/altitude 4 agent）: reuse 1件適用（harness の `"StreamStats"` リテラル →
  既存 const `protocol::EVENT_STREAM_STATS`）。他は意図的な複雑さ（診断 state・二重 cap・YAML job 重複）として clean 判定。
- `/code:pr-review-team`（code-reviewer / silent-failure-hunter / pr-test-analyzer / comment-analyzer）: **Critical=0**。
  Important 3件を修正:
  1. (silent-failure) harness 診断: 別 ID reply で budget 枯渇時、reply は `event` を持たず `"<reply-or-other>"` の
     羅列になる → `event=<名>` / `reply(id=<id>)` を区別記録。budget/backstop も const 化（panic メッセージと同期）。
  2. (comment) `analysis.rs` / 3. `pan_real_wav.rs`: rustfmt 整列で設計根拠コメントが直前 `let` 行の trailing comment
     列に帰属して見える問題 → 空行挿入で独立コメント化（fmt 安定確認済）。
  - Minor: `protocol.rs` の `"StreamStats"` も const 化 / `config.rs` の不正確なソートコメント訂正
    （存在しない sample-rate ソートの記述を削除）/ workflow の retry コメントを具体値非依存に修正。
  - 見送り（理由付き）: teardown timeout backstop（現 count backstop で十分）/ `deny.toml` の `unknown-git`
    （#326 スコープ外・clack git dep に warning が出る恐れ）/ `workflow_dispatch`（GitHub UI の Re-run で代替可能・前提誤り）。

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

新規セッションが post-2.0 を実行に移せるよう、探索ノート3本（`POST_2.0_ROADMAP_NOTES` / `..._ENGINE_AND_DISTRIBUTION` / `..._PITCH_MODEL_NOTES`）+ research を一次ソースに統合した `docs/development/POST_2.0_MASTER_PLAN.html`（手書き HTML）を作成。`specs-v2/IMPLEMENTATION_INSTRUCTIONS.md` を範にコールドスタート実行可能な形（Start here → §1 不変条件 → §2 依存スパイン → §3 最初の1手 A0+S1 → §4 3トラック → §5 ゲート/停止条件 → §7 Delegation Profile → §8 運用規則 → §9 Epic 提案 → §10 Open Questions）。
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

**背景**: `docs/specs-v2/PITCH_DSL_SPEC_v1.1.md`（v1.1 の仕様正本）は 2026-06-12 の実装前ドラフトで、E1-E6 実装の確定決定（DESIGN_DISCUSSION_RECORD #47-59）と乖離・矛盾していた。spec-first 原則（規則 #6）に対し締切優先で code→spec の逆順になった負債を解消。オラクルは test の assertion（`tests/midi/{voicing,random,expression,mode,key-center}.spec.ts`, `tests/audio-parser/pattern-binding-parsing.spec.ts`）に固定し、各 normative 文を test と照合。

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
- `docs/specs-v2/PITCH_DSL_SPEC_v1.1.md` §2.1 (度数受理 / `o`=running range)、§2.4 (`^N` スティッキー pitch range)
- `docs/specs-v2/IMPLEMENTATION_INSTRUCTIONS.md`: テスト網羅項を新ルールに
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

1. `IMPLEMENTATION_INSTRUCTIONS.md` — 作業指示書 (フェーズ・依存グラフ・委譲方針・Known Decisions §7)
2. `PITCH_DSL_SPEC_v1.1.md` — Stage 1 = note DSL の仕様正本
3. `SESSION_LOG_SPEC_v1.md` — 記録 .orbslog の仕様正本
4. `WCTM_SYSTEM_SPEC_v1.md` — コンサートシステムの仕様正本
5. `DESIGN_DISCUSSION_RECORD.md` — 設計経緯と棄却済み代替案 (決定ログ #1-32)

**起票した Issue 群 (2026-06-13)**: Epic #224、 実装系 #225-237 (Phase 0/R/1/L1/2/3/4・W-Bridge/RuntimeA/Link/Ops・docs sync)、 将来予約 #238-242 (audio `[ ]`・slice()・譜面レンダリング Epic・L2 Replayer・WCTM 事後分析)。 ラベル `wctm` / `session-log`、 マイルストーン「WCTM 2026-08-07」を新設。

**テスト結果**: 424 passed / 23 skipped (447 total)。 ドキュメントのみの変更で回帰なし。

**次のステップ**: #226 Phase 0 (事前検証4項目。 仕様前提が崩れたら停止して報告)。

---

