# γ M1 設計 — out-of-process effects の本番 daemon 統合

- **Issue**: #355（親 #354 γ本実装 / Epic #292 Post-2.0 Native Engine & OrbitStudio）
- **前段（すべて MERGED）**: daemon CLAP 統合 #341（`c42b0f0`）/ γ Step0 feasibility spike #349（`59ed06b`）/ γ latency fork spike #351（`3e672a9`・候補B採用）
- **正本（親）**: [`POST_2.0_NEXT_STEPS.html`](POST_2.0_NEXT_STEPS.html) §3「γ」/ [`POST_2.0_GAMMA_LATENCY_FORK_SPIKE.md`](POST_2.0_GAMMA_LATENCY_FORK_SPIKE.md)（候補B verdict・代償）/ [`POST_2.0_GAMMA_SANDBOX_SPIKE.md`](POST_2.0_GAMMA_SANDBOX_SPIKE.md)（Step0 feasibility）
- **日付**: 2026-06-27

---

## 1. これは何か

γ本実装を owner 2026-06-27 決定で **M1 / M2 に段階化**したうちの **M1**。検証済みの pipelined（候補B）sandbox スタックを本番 daemon の CLAP 経路に統合し、**effect のみ out-of-process** で master effects parity + 3rd-party crash 生存を達成する。未実証の RT-hot-path event/param IPC（per-block note + 境界越え automation）は **M2 = 別 spike** に分離する。

### M1 / M2 の境界（判別根拠）

daemon コード確認（#341 統合後）:
- `orbit-clap-host` の `ClapPostProcessor`（`orbit-audio-native::PostProcessor` 実装・`fn process(&mut [f32])`）が effect(serial insert)/instrument(add-mix) を分岐
- daemon には **note event ring**（instrument・per-block）と **install ring**（load-time hot-install）はあるが **per-block param ring は無い**（`PluginEvent` は `NoteOn`/`NoteOff` のみ・automation 変種なし）
- Rust ネイティブの compressor/limiter/normalizer は無い → master effects parity は **effect plugin の out-of-process ホスト**で埋める設計
- latency-fork の defer リストが「境界越え automation」を既に除外

→ 境界を **effect（audio-in/out・load-time param）vs instrument（per-block event）+ automation（per-block param）** で割ると、effect 側は spike 実証済みスタック（mmap MAP_SHARED + SPSC pipelined transport / watchdog / load-time control plane）だけで完結し、**未実証の RT-hot-path IPC にゼロ露出**で parity + crash 生存を達成できる。

---

## 2. スコープ

### M1 でやること

- 検証済み pipelined sandbox host（候補B）を本番 daemon の CLAP 経路に統合
- shared-mem audio transport（file-backed mmap MAP_SHARED + SPSC ping-pong）を **production crate に昇格**
- watchdog + respawn（child crash 生存）
- effect topology = serial insert（#341 から踏襲）
- **effect のみ out-of-process**（load-time param・per-block automation なし）

### M1 でやらないこと（→ M2 以降）

- **RT-hot-path event/param IPC**（out-of-process instrument の per-block note + 境界越え automation）= M2 spike
- **PostProcessor の chaining**: M1 は **最終 mix への master-effect を単独 post-processor として**実装する（engine が mix を render → OOP master effect → 出力）。OOP effect **と** in-process CLAP instrument を同時に走らせる構成は `PostProcessor` trait（単一 impl）では表現できず、composite/chain が要る → **M2+ に明示 defer**。
- δ（VST3/AU）/ cutover #108 本体 / Signalsmith・#213

---

## 3. owner 決定（2026-06-27 確定）

1. **stale policy = repeat-previous**（spike は silence。child が間に合わない block では直前の good block を再出力してクリックを回避）
2. **slot 数 = M1 の verify harness で実測して決定**（32f stall/latency で 2 vs 3）。→ **§4 のとおり transport は最初から N-slot-generic に作り**、slot 数を 1 つの const 変更で切り替えられるようにする（PR-C の決定が cross-process 構造の rewrite を強制しないため）
3. **daemon 統合の形 = 既存 in-process clack-host 経路への差し込み**（§4 で具体化）

---

## 4. アーキテクチャ

### 4.1 seam = `PostProcessor` trait

```rust
// orbit-audio-native::post_processor
pub trait PostProcessor: Send {
    fn process(&mut self, data: &mut [f32]);  // engine が render 済みの interleaved f32 を in-place 変換
}
```

OOP effect host は `ClapPostProcessor` と**並列の新 impl**（`OutProcEffectPostProcessor`）で、daemon が `orbit_audio_native::start_default_output_with_clap(processor)` に `Box<dyn PostProcessor>` として差し込む差し込み口は不変。native crate は in-process / out-of-process を区別しない。

### 4.2 pipelined post-processor（候補B → post-processor 写像）

spike の pipelined host loop（block N を submit し N-1 を読む・spin なし）を post-processor 意味論へ写す。`process(data)` の各呼び出し（RT callback）:

1. **submit**: `data`（block N・engine の dry 出力）を shm input slot `slot_offset(N)` へ copy → `n_frames[slot(N)]` store（per-slot）→ `seq_request.store(N, Release)`
2. **read**: per-slot `seq_tag[slot(N-1)] == N-1`（Acquire）なら shm output slot(N-1) を `data` へ **overwrite**（= serial insert）し **last-good として保存**（copy 長は `n_frames[slot(N-1)]` で clamp し、現 callback が長ければ末尾を無音化）。未達なら **last-good を `data` へ copy（repeat-previous）**。最初の block は silence で prime
3. **slot guard**: N-outstanding（`seq_done >= new_seq - SLOTS`）で slot 再利用衝突を防ぐ

**read 判定が `seq_done` でなく per-slot `seq_tag` な理由**（PR-A round-1 review・load-bearing）: child は「latest 処理」（spike #351 が検証した挙動・最新 `seq_request` を処理）なので中間 seq を skip しうる。global monotone な `seq_done` で `>= N-1` を見ると、child が N-1 を skip して N を処理した時に `seq_done >= N-1` が成立し、**書かれていない slot(N-1) を false-fresh** で読んで観測 counter（PR-C の slot 数決定指標）を汚染する。child が output 書き込み後に `seq_tag[slot] = seq`(Release) を publish し、host が `seq_tag[slot(N-1)] == N-1`(Acquire) を確認することで skip を検知し repeat-previous に落とす。`seq_done` は submit guard 専用に残す。`n_frames` も per-slot 化（pipelined で host が次 block の n_frames を submit 済みでも、各 slot が正しい長さを持つ）。

- **1-block 遅延**は最終 hw sum **全体**に均一にかかる純レイテンシ（effect は serial insert で dry を置換するため、上流の transport/scheduling には影響しない）。owner 受容済み（candidate B の代償）。
- **RT-safe**: alloc/lock/block なし。last-good buffer は construction 時に事前確保。

### 4.3 N-slot-generic transport（cross-process 構造・PR-A で凍結）

spike は slot 数 2 をハードコード（`slot_offset = (seq & 1)*BUF_LEN`・`SLOTS=2`・`input: [f32; BUF_LEN*SLOTS]`・guard `seq_done >= new_seq-2`）。`& 1` は 2 のべき乗専用で 2→3 は tunable ではない。**最初から汎用化**:

```rust
pub const SLOTS: usize = 2;  // PR-C の実測で 2 or 3 に確定（const 1 つの変更で済む）
pub fn slot_offset(seq: u64) -> usize { (seq as usize % SLOTS) * BUF_LEN }
// outstanding guard: seq_done >= new_seq - SLOTS
// input/output 配列は BUF_LEN * SLOTS で確保
```

`SharedRegion`（`#[repr(C, align(64))]`）は `seq_request`/`seq_done`/`child_processed`(AtomicU64)・`control`(AtomicU32)・**per-slot** `seq_tag`(`[AtomicU64; SLOTS]`)・**per-slot** `n_frames`(`[AtomicU32; SLOTS]`)・`input`/`output`(各 `[f32; BUF_LEN*SLOTS]`)。Acquire/Release で input/output の可視性を同期（spike から踏襲）。per-slot `seq_tag`/`n_frames` は PR-A round-1 review で追加（§4.2 read 判定の根拠参照）。slot 数を焼き付けない構造方針上、PR-C の 2 vs 3 決定は同一 build で両プロセスが再コンパイルされる前提（cross-process ABI を published せず・same-build determinism）。

### 4.4 child process

新 binary。shm を open し、**実 CLAP effect plugin を自プロセス（別アドレス空間）で host**する。input block を読み → `plugin.process()` → output block を書く。effect は **event ring 不要**（load-time param のみ）。

- **child は `orbit-clap-host` の subset**（`load_plugin` + 1-block process）を使う。ring 包みの `ClapPostProcessor.process()` から core を抽出する小リファクタを **PR-B で**行う。
- **PR-A は gain child を昇格**（spike の gain child を crash-injection 抜きで・gain 設定可能に）。A/B parity の OOP 側に走らせる相手として end-to-end にテスト可能にし、PR-B で実 CLAP child へ差し替える。

**PR-B での具体化（実装済み）**:
- 抽出した 1-block core = `orbit-clap-host` の `process_block_core(plugin, buffers, steady, input_events, data) -> bool`（effect/instrument 分岐 + 入出力配線 + steady 更新）。`ClapPostProcessor::process()` の effect/instrument 本体はこれに委譲し（byte-identical・gated daemon test で ratio 0.50000 / peak 0.25000 を前後一致確認）、新規の `ClapEffectProcessor` も同じ core を使う。
- `ClapEffectProcessor`（`orbit-clap-host`）= **single-thread** で `load → process_block → drop` を完結する effect-only ラッパ。daemon は activate=main / process=audio の別スレッドだが、child は 1 スレッドで直列実行する。フィールド宣言順（`plugin` を `_instance` より前）で drop 順 = stop_processing → deactivate を同一スレッドに収め、carry-forward #1 の wrong-thread teardown を構造的に sidestep する。load 経路は `instantiate_activate`（`load_plugin` と共有抽出）。
- child binary = 新 crate **`orbit-clap-effect-child`**（`orbit-clap-host` + `orbit-audio-sandbox` の両方に依存）。PR-A の gain child（`sandbox-effect-child`）の gain 乗算を `ClapEffectProcessor::process_block` に差し替えたもの。transport protocol（per-slot `seq_tag`/`seq_done`）は gain child と同一。
- **既知ギャップ（M1 スコープ外・real plugin 向け）**: child は `call_on_main_thread_callback` を pump しない（load-time param のみの effect には不要）。main-thread callback を要求する 3rd-party plugin は M1 スコープ外。

### 4.5 daemon supervision

- **spawn**: `std::process::Command` で child を起動。child binary path は設定可能に（spike は sibling-of-exe ハードコード）
- **watchdog**: 別 thread が `child.try_wait()` を poll → `Ok(Some(status))`（crash/exit）で clean respawn・`respawn_count`/`last_respawn_ns` 更新・respawn 失敗で `measurement_invalid`
- **StreamGuard mirror**（drop 順は load-bearing）: `_outproc_teardown`（audio thread に IPC 送信停止を signal → drain → ack）→ `_stream`（cpal callback 停止）→ `_child_guard`（child に shutdown signal → exit 待ち）
- **teardown handshake**: `teardown_requested`/`teardown_done`(AtomicBool)。in-process 版（processor.rs:221-233）の handshake を踏襲。「stop processing」= 「child への audio 送信停止 + IPC flush」

### 4.6 crate 構造・clack 隔離

- 新 **transport crate**（`SharedRegion` 等 + daemon 側 `OutProcEffectPostProcessor`）は **clack 非依存**（純 transport IPC）。依存隔離が fault 隔離の鏡になる。
- **clack は child binary のみ**がリンク（child だけが `orbit-clap-host` を使う）。
- spike-only scaffolding（CLI/histogram/test-tone/`--crash-after-blocks` null-write/warm-up）は昇格しない。

**PR-B での具体化（依存の向き）**: child crate `orbit-clap-effect-child` が `orbit-clap-host`（clack）と `orbit-audio-sandbox`（memmap2）の**両方に依存する**。向きは常に child → transport であり、**transport crate（`orbit-audio-sandbox`）は child crate に依存しない**ため memmap2 単独（clack-free）を保つ。よって daemon の OOP 経路（PR-C で `orbit-audio-sandbox` を使う）は clack をリンクせず、clack は spawn された child プロセス内だけに閉じる。`cargo tree -p orbit-audio-sandbox` に clack が現れないことが不変条件。

---

## 5. 検証戦略（3分割）

CI は Rust gated 非実行（device なし・`#[ignore]` 自動 skip）。offline 決定論テストは CI 実行可・実機計測は gated。**load-bearing な repeat-previous を gated-only にしない**ため3分割:

| | 何を証明 | 実行 | 機構 |
|---|---|---|---|
| **(a) audio 正しさ** | in-process と out-of-process の **A/B parity** + **production path（実 host+実 child+実 mmap）** | **CI**（offline・同期 + 統合） | ① `host_child_integration.rs`（root-of-trust）= 実 `PipelinedEffectHost`+実 spawn child+実 mmap を cpal 無しで統合し、callback 間で `seq_done` を追いつかせ毎回 fresh path に当て、入力 gain 倍を **1 block 遅延**させた結果に sample-exact 一致。② `parity.rs` = transport + 同期ドライバの A/B parity（OOP gain == in-process gain）。①が pipelined host を、②が transport を別役割で検証 |
| **(b) pipeline state machine** | **repeat-previous + stall** の論理 | **CI**（決定論 unit test） | **seq_done を制御する mock child**（withhold → last-good が再出力されることを assert・stall 経路も） |
| **(c) RT stale-rate** | 32–64f の小バッファ viability | **gated 実機** | live cpal で `--buffer-frames 32/64`・stale_pct/callback_max を threshold assert → **slot 数 2 vs 3 を決定**（corrected `seq_tag` プロトコル下で再計測・spike 数は provisional・下記注参照） |

- **A/B parity の判定**: 可能なら **sample-exact**（同一 plugin・決定論・両側同一 block size なら 1-block 整列後の body は bit 一致）。plugin が両ホスト文脈で決定論的でない / block-size 依存 buffering を持つ場合は RMS-within-`GAIN_DB_TOLERANCE`(0.5dB) に fallback。primed first / drained last block は差を許容。
- **再利用資産**: `orbit-audio-verify`（`capture`/`CapturedAudio`/`region_rms`/`db_difference`）・`verify_schedule_pcm.rs` の `render_golden()` パターン（in-process 側）・spike の `RtStats` histogram/`p99_ns`（gated 計測）・`is_recovered()` 論理（crash-survival assert）。
- **PR-B の実 CLAP parity は gated（CI backstop は gain parity）**: 実 CLAP effect での A/B parity（`orbit-clap-effect-child` の `effect_parity_gated.rs`・`orbit-clap-host` の `effect_processor_smoke_gated.rs`）は実 plugin dylib（`rust-spike/clap-test-effect`・workspace 非 member）のビルドを要するため `#[ignore]`（local 実行）。test-effect は決定論 *0.5 なので **closed-form oracle**（OOP 出力 == `input*0.5` を sample-exact）で transport + CLAP を同時検証し、加えて in-process side A == OOP side B（A/B parity）も確認する（いずれも audio device 不要の offline）。CI で常時走る parity は PR-A の **gain child**（clack 非依存）が担う backstop。
- **ギャップ（M1 で作る）**: A/B parity primitive（2 つの render を比較）/ OOP の offline render 経路 / programmatic crash-survival `#[test]`（gated）/ 32-64f stale-rate のアサート化。
- **⚠️ spike の stale 数は provisional（PR-C で再計測必須）**: spike #351 の `pipelined_stale` / 「32f feasible」verdict は **`seq_done`-only プロトコル**（`seq_tag` 不在）下の計測。child の「latest 処理」で中間 seq が skip された block を `seq_done >= N-1` が **false-fresh** として fresh に算入していたため、real glitch を **undercount**（skip が最も起きる 32f に集中）している。PR-A で per-slot `seq_tag` に修正したが、**この correct path は実並列下で未計測**（単一スレッド mock は skip を手動シミュレート・同期統合テストは callback 間で `seq_done` を追いつかせるので race 無し → どちらも true-concurrency を検証しない）。よって **(c) gated 実機の stale-rate を corrected `seq_tag` プロトコル下で計測し直してから 2 vs 3 slot を決める**。spike の stale 数を slot 決定の根拠にしない。

---

## 6. PR 分割（内部）

| PR | スコープ | Done |
|---|---|---|
| **PR-A** ✅ | **transport crate `orbit-audio-sandbox`**（N-slot-generic・memmap2 のみ依存）+ gain child binary（clack 非依存）+ `PipelinedEffectHost`（候補B 状態機械・repeat-previous/stall）+ **offline 決定論サンドボックスモード** + A/B parity primitive + **mock-child の pipeline state-machine unit test** + **production-path 統合テスト**（実 host+実 child+実 mmap） | in-proc gain vs out-of-proc gain の A/B parity が **CI（offline）で sample-exact 通過** + **実 host+実 child 統合テストが 1 block 遅延を sample-exact 検証** + repeat-previous/stall の unit test 緑 + workspace 全体緑（daemon 無改変） |
| **PR-B** ✅ | OOP effect の **実 CLAP child**（`orbit-clap-host` の `instantiate_activate`+`process_block_core` を抽出・`ClapEffectProcessor` single-thread ラッパ・`ClapPostProcessor` も同 core に委譲）+ child crate `orbit-clap-effect-child`（clack+transport 両依存・transport は clack-free 維持）で effect plugin を host + parity を実 effect で再確認 | 実 CLAP effect が child で動き offline A/B parity 緑（closed-form oracle = OOP 出力 == input*0.5 sample-exact + side A==B）。daemon 委譲は byte-identical（gated ratio 0.50000/peak 0.25000 前後一致）・workspace 全体緑 |
| **PR-C** | daemon 側 `OutProcEffectPostProcessor`（`PipelinedEffectHost` を `impl PostProcessor` で薄く包む・clack 非依存）+ child spawn/watchdog/respawn + daemon 統合（StreamGuard mirror・teardown handshake）+ **gated 実機 RUN**（parity/kill-test/32-64f stale・**corrected `seq_tag` プロトコル下で再計測**）→ **slot 数 2 vs 3 決定** | gated 実機で parity + kill-test 生存 + 32-64f viability・slot 数確定（spike 数でなく corrected-protocol 計測が根拠） |

各 PR は `/simplify` + `/code:pr-review-team`（ハンドロール禁止・収束は独立再レビューで裏取り）→ advisor → 必要なら @claude bot（owner-gated）→ owner 明示マージ。

---

## 7. Done / フェーズゲート（M1 全体）

- 既存テスト全緑 + gated 実機 RUN（CI は Rust gated 非実行 → ローカル cargo + gated 実機 RUN が唯一の根拠）
- effects parity（in-process と一致・sample-exact or 0.5dB 以内）
- daemon が 3rd-party crash を生存（kill-test / C-ABI segfault 封じ込め + watchdog respawn 復帰）
- 小バッファ viability（32–64f・stale_pct/callback_max が threshold 内）

---

## 8. 委譲 / 不変条件

- **Opus 直列**: RT / CLAP / sandbox correctness（transport・pipelined loop・supervision）。純関数（A/B parity 比較等）と隔離モジュールは Sonnet 委譲可。
- spec-first（逸脱は owner 承認 + spec 先行更新）/ `play()` 意味論・SC default 不変 / merge = merge commit + owner 明示承認。
