# A0 — RT 統合設計（CLAP プラグインを orbit-audio に RT 安全に載せる）

> **ステータス: S1 + S1b 実行完了 — verdict = PASS（feasibility→proof 達成）。S1=§12 / S1b（低レイテンシ・release・dynamic hot-install）=§13。post-2.0 / Epic #292 / Issue #293・#295。** 2026-06-20 作成・同日 S1/S1b 実行。
> 正本ロードマップ: `docs/development/POST_2.0_MASTER_PLAN.html`（§3 最初の1手 = A0+S1）。
> hosting feasibility 一次情報: `docs/research/RUST_PLUGIN_HOSTING.md`。daemon 契約: `docs/research/ENGINE_DAEMON_PROTOCOL.md`。

本書は**設計の証明ではなく、S1 スパイクの仮説と棄却条件（kill-criteria）を定義する**。S1 が存在する理由は「binding が動く」ではなく「**orbit-audio のライブコーディング scheduler + RT callback + 別プロセス daemon に、プラグイン処理を RT 安全に統合できるか**」という integration-level のリスクを retire することにある（`RUST_PLUGIN_HOSTING.md` §6）。よって本書の受け入れ基準は「音が一度出た」を意図的に**満たさない**ように設計する。

---

## 0. 結論（先出し）

| 論点 | 決定 | 確信度 |
|---|---|---|
| process() を走らせる場所 | **同一 cpal callback（audio thread）** | 高（clack 公式 cpal example が同形） |
| プラグイン processor の所有 | **Mutex の外**・cpal closure が直接所有（Scheduler とは別） | 高 |
| 制御→音声のイベント供給 | **lock-free SPSC ring（`rtrb`）** を callback 先頭で drain → `InputEvents` | 高 |
| tap の宛先 | **`PostMixSink` trait**（S1 = stub 実装 / 実 LinkAudio = A4） | 高（後述の依存関係で一意に決まる） |
| S1 の load 方式 | **static-load-before-stream-build**（startup で1プラグイン） | 高（dynamic hot-install は S1b/S2 へ分離） |
| ブロックサイズ | cpal `BufferSize::Fixed` を要求 + 事前確保。超過時 resize は**計測対象の例外パス** | 中（実機で要計測） |

これらは S1 で**反証されうる仮説**であり、反証は §7 の Stop & Report に従う。

---

## 1. 現状アーキテクチャ（実コードの事実）

### 1.1 RT パス（pull 型）

- cpal `build_output_stream` の data callback が `engine.render(data)` を呼ぶ（`rust/crates/orbit-audio-native/src/output.rs:151`、I16/I32/U16 は scratch 経由 `:163-217`）。
- `Engine::render`（`rust/crates/orbit-audio-core/src/engine.rs:98-107`）は `Arc<Mutex<Scheduler>>` に **`try_lock`**。競合時は `out` をゼロ埋めして即返す（**silent drop**）。
- `Scheduler::render`（`rust/crates/orbit-audio-core/src/scheduler.rs:132-206`）は interleaved buffer にアクティブサンプルを加算 → マスターゲインのフレーム単位ランプ → `cursor_frames` 前進。**alloc / lock なし**。
- 出力ストリーム構築時、buffer size は `None`（host 任意・**可変ブロック**）（`output.rs:154,161-,182-,202-` の `build_output_stream(..., None)`）。RT 初回 alloc 回避のため scratch を 1 秒分事前確保（`output.rs:144-146`）。

### 1.2 制御パス（blocking）

- WebSocket server（`orbit-audio-daemon/src/server.rs`）→ `session` → `EngineWrap`（`engine_wrap.rs`）の `play_at` / `stop` / `load_sample` / `set_global_gain`。
- これらは `Engine::schedule_with_play_id` 等（`engine.rs:42-91`）経由で Scheduler の Mutex を**ブロッキング `lock()`**。
- サンプル本体は `EngineWrap.samples: Mutex<HashMap<String, Sample>>`（制御側のみ）に保持し、schedule 時に `ScheduledSample` へ clone（`engine_wrap.rs:161-170`）。

### 1.3 LinkAudio の所在（重要）

repo 全体 grep の結果、**`LinkAudioSink` / `LinkAudioSource` は Rust `rust/` に存在しない**。LinkAudio は現状 TypeScript（`registerLinkAudioChannel` 等）+ C++ SuperCollider `.scx`（`orbitPlayBufLink` SynthDef・#209）側にのみ実装されている。Rust 側への移植は **A4**（master plan §4-A）の担当で、S1 の**下流**。

---

## 2. goal 文言「tap → `LinkAudioSink::commit`」の解釈（決定）

goal / master plan は Tracktion 時代の記述を引き継いでおり「post-mix を tap → 既存 `LinkAudioSink::commit`（RT-safe）へ流す」と書く。だが §1.3 の通り **Rust に `LinkAudioSink` は無く、その移植は A4（S1 の下流）**。したがって S1 で literal な `LinkAudioSink::commit` 呼び出しは**成立し得ない**。依存関係が解釈を一意に決める:

> **決定**: S1 は「**post-mix を RT 安全に tap できる点**」と「**RT-safe な sink インターフェース（trait）**」を証明する。sink の S1 実装は **stub**（no-alloc / no-lock の最小実装）。実 LinkAudio は **A4** が同 trait の裏に実装する。

これは仕様の解釈で埋める性質の曖昧さではなく、依存グラフから導かれる唯一の整合解（よってユーザーへは「質問」ではなく「1行の訂正報告」とする）。

---

## 3. 設計判断 — process() をどこで走らせるか

`RUST_PLUGIN_HOSTING.md` §G と master plan §3 が問う3択を、orbit-audio の実コードに対して評価する。

### 3.1 候補

| 方式 | 内容 | 評価 |
|---|---|---|
| **A. 同一 callback（採用）** | CLAP `process()` を cpal callback（audio thread）内で呼び、出力を post-mix に合算 | レイテンシ最小・サンプル精度・clack 公式 cpal example と同形・DAW 標準。プラグインの RT 違反が直接 xrun を生む = **S1 が暴くべき当の現象** |
| B. 別スレッド | 専用ワーカで process し、ring 経由で callback が pre-rendered を pull | 1 buffer 余分なレイテンシ・サンプル精度喪失・スケジューラ同期が複雑化。CLAP の process は audio thread 前提なので不自然 |
| C. プロセス分離 | プラグインを別プロセスで sandbox（Apple AUv3 の out-of-process 等） | クラッシュ隔離は得るが IPC 音声ストリームのレイテンシ・複雑度が過大。**CLAP synth スパイクには過剰**（AUv3 の S 後続で再評価） |

### 3.2 採用 = A（同一 callback）。根拠

1. **clack 公式 cpal example が A をそのまま実装**している（`host/examples/cpal/src/host/audio.rs`）。cpal closure は `move |data, _info| audio_processor.process(data)`（同 `:510-514`）で、orbit-audio の `engine.render(data)` と完全に同形。
2. `StartedPluginAudioProcessor::process(&ins, &mut outs, &events, &mut OutputEvents, Some(steady), None)` は audio thread から呼ぶ設計（同 `:563-570`）。
3. B/C は本スパイクが retire すべき RT リスク（process が callback 内で時間予算を守れるか）を**隠す**方向に働く。A はそれを正面から計測にさらす。

> **注意（advisor 指摘・load-bearing）**: A を採ることは「`render` は callback 内で alloc/lock しない」という既存契約（`rust/README.md` Design principles）を、任意の 3rd-party `process()` が**構造的に破りうる**状態に置く。この緊張こそが S1 の実験対象。したがって「動いた」では verdict にならず、§6 の時間軸計測が要る。

---

## 4. 採用アーキテクチャ（S1 の統合形）

### 4.1 audio-thread 構造体（cpal closure が所有）

clack example の `StreamAudioProcessor`（`audio.rs:516-577`）に倣い、orbit-audio 用の audio-thread 構造体を1つ作る。所有物:

- `engine: Engine`（既存サンプル経路。内部は `Arc<Mutex<Scheduler>>` のまま）
- `plugin: StartedPluginAudioProcessor<OrbitClapHost>`（**Mutex の外**・この構造体が直接所有）
- `events: rtrb::Consumer<PluginEvent>`（制御→音声の lock-free ring の受信端）
- `event_scratch`: 事前確保した CLAP `EventBuffer`（callback 内で ring を drain して詰める）
- `plugin_scratch: Vec<f32>`（プラグイン出力の事前確保バッファ）
- `sink: Box<dyn PostMixSink>`（tap 宛先・§4.4）
- `steady_counter: u64`（plugin process の steady time）

callback（`render(data)`）の手順:
1. `engine.render(data)` で既存サンプルを `data` にミックス（既存挙動・無改変）。
2. ring を drain → `event_scratch` に CLAP イベント化（§4.2）。
3. `plugin.process(empty_in, plugin_out, &events, &mut OutputEvents::void(), Some(steady), None)`。
4. `plugin_out` を `data` に加算（合算ミックス）。
5. `sink.commit(data)` で post-mix を tap（§4.4）。
6. `steady_counter += frames`。

**プラグインは Mutex の外**なので、Scheduler のロック競合（制御スレッドが schedule 中）で**プラグイン音声が silent-drop されない**。サンプル経路の silent-drop は既存挙動として温存（S1 で Scheduler の lock-free 化はしない = 別 Issue / A4 隣接）。

### 4.2 イベント seam（制御→音声・lock-free）

- **`rtrb`（SPSC・lock-free・wait-free）** を採用。clack の cpal example が同目的で `rtrb 0.3` を使用（example `Cargo.toml`）。
- 制御側（S1 ではテスト driver / 後に daemon の `PluginMidiEvent`）が producer に note-on/off を push。
- audio thread が callback 先頭で drain し、`sample_count` 範囲のオフセットで CLAP `InputEvents` に変換。
- **S1 の明示的簡略化（gap として記録）**: イベントは **block 先頭一括供給**（sample-accurate なフレーム内オフセットは付けない）。サンプル精度のオフセットは S1b 以降。

### 4.3 スレッドモデル / プラグイン lifecycle

clack の `HostHandlers`（`Shared` / `MainThread` / `AudioProcessor` の3関連型・example `host.rs:71-83`）に従う。

- **main thread**: `PluginInstance::new` → `instance.activate(...).start_processing()`（example `audio.rs:446-449`）。CLAP は一部コールバック（`call_on_main_thread_callback`・timer・param flush）を main thread で要求する。S1 headless では daemon の制御スレッド（または専用スレッド）が `receiver` を pump する（example `run_cli` `host.rs:339-352`）。
- **audio thread**: `StartedPluginAudioProcessor::process` のみ。
- **S1 = static-load-before-stream-build**: activate 済み processor を cpal stream 構築**前**に得て、closure に move する（example の `activate_to_stream` がこの順）。

### 4.4 tap = `PostMixSink` trait

```rust
/// post-mix（最終ミックス済み interleaved f32）を RT 安全に受け取る宛先。
/// 実装は callback から呼ばれる: alloc / lock / 系統呼び出し禁止。
pub trait PostMixSink: Send {
    fn commit(&mut self, post_mix: &[f32]);
}
```

- **S1 実装（stub）**: 2 種を用意して RT 安全性を実証する。
  1. `CountingSink`（フレーム数 / ピークを atomic 更新するだけ・完全 no-alloc）。
  2. `RingTapSink`（事前確保した `rtrb` producer へ非ブロッキング push。満杯時は drop してカウント）。— 「post-mix を別スレッドへ RT 安全に渡せる」ことの証明。LinkAudio が必要とする形に最も近い。
- **A4 実装（実 LinkAudio）**: 同 trait の裏で Rust 版 LinkAudio sink（隔離 GPL モジュール）として実装。S1 はこの差し替え点が成立することを示すだけ。

---

## 5. ブロックサイズ / activate の整合（advisor 指摘の sharp edge）

- CLAP `activate()` は `PluginAudioConfiguration { sample_rate, min_frames_count, max_frames_count }` を要求（example `config.rs:647-653`）= **最大ブロックの上限が要る**。
- だが現 `output.rs` は `build_output_stream(..., None)` で **host 任意・可変ブロック**。→ S1 では cpal stream を **`BufferSize::Fixed(max)`** で要求し（example `config.rs:638-644`）、その `max` を `max_frames_count` に一致させる。
- cpal は `Fixed` 要求でも稀に `max` 超のバッファを渡しうる（example のコメント `config.rs:609-611`）。example は callback 内で host buffer を resize（`ensure_buffer_size_matches`・`audio.rs:552`）= **潜在的 alloc**。S1 は orbit-audio の既存方針（scratch 事前確保 `output.rs:144`）に合わせ、`max` を十分大きく取って **resize 発生をゼロに保ち、発生したらカウントして verdict に含める**（隠さない）。
- macOS CoreAudio は固定 buffer 要求が通りやすい（実機で確認）。

---

## 6. 受け入れ基準 / kill-criteria（measurable・「音が出た」では不可）

S1 の verdict は **Opus（委譲不可）** が次の計測で出す:

1. **持続再生での RT 健全性**: 単発でなく **≥60 秒の連続発音**（複数 note の重なり含む）で、`StreamStats.xruns`（`output.rs:23-67`）が **0 を維持**。xrun が出るならブロックサイズ / 統合方式の問題として記録。
2. **CPU load を時間軸で**: 1 Hz の `StreamStats`／自前計測で callback の所要時間分布（平均 / p99）を記録。block 期限（`frames / sample_rate`）に対する余裕を可視化。初回 note 時のスパイクも捕捉。
3. **誤動作しうるプラグインで検証（vibes 排除）**: 受け入れには **2 種**を通す。
   - (a) 実在の無料 CLAP synth（例: Surge XT 等）— 「実機で発音する」証明。
   - (b) **故意に RT 違反する自作 CLAP**（first note で alloc / lock / sleep する nih-plug 製の最小プラグイン）— **計測が RT 違反を実際に検知する**ことの証明。(b) で xrun/CPU スパイクが**観測できなければ計測自体が無効**として verdict を保留。
4. **イベント seam の RT 安全性**: 非音声スレッドから `rtrb` に note を push し、callback が drain して発音 → ロック/alloc なしで成立。ring 満杯時の drop がカウントされる。
5. **tap の RT 安全性**: `PostMixSink`（Counting / RingTap）が callback 内で alloc/lock なしに post-mix を受ける。RingTap の drop がカウントされる。
6. **既存テスト全グリーン**: `cargo test --workspace`（既存 Rust）+ `npm test`（既存 TS）。S1 は既存経路を**壊さない**（プラグイン経路は加算的に追加）。

> verdict は「retire できた / できない / 条件付き」の3値で記す。条件付きなら残リスク（dynamic hot-install 等）を §8 に明記。

---

## 7. Stop & Report 条件（master plan §5）

以下のいずれかに該当したら**実装を進めず停止**し、選択肢＋推奨を添えて報告する:

- **clack-host の pre-1.0 breaking** が S1 を阻む（API が研究 doc / 本書の前提と乖離、cpal example がビルド不能等）。
- **RT 統合が解けない**（誤動作しないプラグインでも持続 xrun・ブロックサイズ調停不能・main-thread pump と audio-thread の整合が取れない）。
- **tap が成立しない**（post-mix を RT 安全に sink へ渡せない）。
- **§9 の license 規律を破る依存**が必要になる。

技術フォールバック（license 動機は消滅済）として Tracktion を含め再検討する。

---

## 8. static-first の射程（正直な境界）

S1（static-load）が証明するのは **RT コア**（process を audio thread に載せて持続発音・イベント ring・tap）。**証明しないもの**を明記する:

- **dynamic hot-install** = daemon の `LoadPlugin` を**実行時**に処理してプラグインを稼働中ストリームへ差し込む経路（`StartedPluginAudioProcessor` を制御スレッドから audio thread へ install する所有権ハンドオフ）。これは別の未知数 → **S1b**（同一スパイク内の追加ステップ）または **S2**（daemon seam 差し替え）で扱う。
- **複数プラグイン / ノードグラフ** = protocol §5 の `ConnectNode`。S1 はプラグイン1個。
- **AU / VST3** = master plan の後続（成熟度順）。
- **Scheduler の lock-free 化** = サンプル経路の silent-drop 解消。S1 ではプラグインを Mutex 外に置くことで回避するが、サンプル経路自体は無改変。

「static spike が通った」を「daemon 統合が通った」と誤読しないこと。

---

## 9. License 不変条件の検証（§1・Opus 非委譲）

S1 で追加する依存と license（2026-06-20 GitHub 一次確認）:

| crate | license | GPL? |
|---|---|---|
| `clack-host` 0.1.0 | MIT OR Apache-2.0 | なし |
| 依存: `clap-sys` / `clack-common` | MIT OR Apache-2.0（同 workspace） | なし |
| 依存: `libloading` | ISC 系 permissive | なし |
| 依存（macOS）: `objc2-foundation` | MIT/Apache/Zlib | なし |
| `clack-extensions`（audio-ports/note-ports/params/log/timer） | MIT OR Apache-2.0 | なし |
| `rtrb` 0.3 | MIT OR Apache-2.0 | なし |
| `nih-plug`（(b) 故意違反プラグイン用・1st-party 側） | ISC | なし |

→ permissive 規律を満たす。**実 `cargo add` 時に transitive tree を再確認**（supercolliderjs の GPL 隣接 transitive 事例を踏まえ、`cargo deny`（repo に `deny.toml` 前例あり）で license gate を回す）。

---

## 10. 前提条件 / Open Questions（S1 着手前）

- **Rust toolchain**: clack-host は **edition 2024 / MSRV 1.85.0**。現 `rust/rust-toolchain.toml` は `channel = "stable"`（≥1.85 なら可）。**ただし本セッションのシェルで `rustc`/`cargo`/`rustup` が PATH 上に見つからない** → S1 実装前に toolchain の存在と version（≥1.85）を確認する（Phase 0 的検証）。
- **テストプラグインの調達**: (a) 実在 CLAP synth の入手、(b) 故意違反プラグインの自作（nih-plug 最小）。
- **main-thread pump の置き場所**: S1 headless では専用スレッドで可。S2 で daemon の tokio runtime / 制御スレッドへどう統合するか（CLAP main-thread セマンティクスとの整合）。
- **`output.rs` の改変範囲**: 既存 `start_default_output` は無改変で温存し、S1 用に並行の `start_output_with_plugin`（仮）を足すか、closure を差し替え可能にするか。既存テストを壊さない加算的設計を優先。

---

## 12. S1 実行結果 / Verdict（2026-06-20）

実装: `rust/crates/orbit-clap-spike`（host・ワークスペース member・`publish=false`）+ `rust-spike/clap-test-synth`（自作 CLAP synth・良性/故意違反）。clack を `f874e85` に git pin。macOS aarch64・cargo 1.96・**debug build**。config = 2ch F32 @ 44100Hz・**1024 フレームブロック（budget ≈ 23.2ms）**。120bpm で C4 を NoteOn/NoteOff 連打。

### 計測結果

| 指標 | good（60s 持続） | misbehave（12s・RT 違反注入） |
|---|---|---|
| total_callbacks | 2594 | **24（崩壊）** |
| **xruns**（cpal err_fn） | 0 | **0** ← §下記の重要知見 |
| callback_min | 123µs | 408µs |
| callback_mean | 339µs | **494ms** |
| callback_p99 | 400µs | 51ms（ヒスト飽和） |
| callback_max | **509µs（budget の 2.2%）** | **1.94 秒** |
| post_mix_peak | **0.25（発音確認）** | 0.25 |
| buffer_resize_count | 0 | 0 |
| ring_tap_drops | 4.87M（consumer 未 drain・想定通り） | 0 |

### Verdict = **PASS（条件付き）**

A0 §4 のアーキ（同一 callback / プラグイン Mutex 外 / rtrb event seam / PostMixSink tap / static-load）で、**外部 CLAP プラグインを既存 orbit-audio の cpal callback に統合し、60 秒持続で xrun 相当ゼロ・callback 最悪 509µs（予算の 2.2%）・実発音（peak 0.25）・in-callback realloc ゼロ**を達成。Stop&Report 条件（clack breaking / RT 統合不能 / tap 不成立）はいずれも非該当。→ **hosting feasibility を proof に変えた。**

### ★ 重要知見（A0 §6 と production monitoring を更新する）

**macOS CoreAudio + cpal では、audio callback が 2 秒ブロックしても `cpal` の `StreamError`（err_fn）= xruns は発火しない**（good/misbehave 両方で 0）。→ **`xruns`（err_fn / 既存 `StreamStats`）単独は RT 違反の検知に使えない（false-negative）**。代わりに **callback 実測時間（mean/max/p99）＋ callback 数 vs 期待値の崩壊**が違反を決定的に検知した（misbehave で mean 494ms・max 1.94s・callback 数 2594→24）。

含意:
- S2 以降の **production RT 監視は callback duration ベース**にする（daemon の `StreamStats.xruns` を信頼しない）。`ENGINE_DAEMON_PROTOCOL` の `StreamStats` イベントに callback-time 分布を足すべき。
- これにより good-mode の「clean」は**実証検知できる計測上の clean** であり vibes ではない（advisor §6-3b の要求を満たした）。

### Caveats / S1 が retire していないもの

> **更新（2026-06-20）**: 下記のうち ①高レイテンシ限定 ②debug 限定 ③static-load のみ は **S1b で retire 済（§13）**。

- ~~**1024 フレーム（高レイテンシ）限定**~~ → S1b-1 で 128/256 frame を実証（§13）。
- ~~**debug build**~~ → S1b-1 で release を実証（§13）。
- ~~**static-load のみ**~~ → S1b-2 で dynamic hot-install を実証（§13）。
- プラグイン 1 個・ノードグラフ無し。`OutputEvents::void()`（plugin→host イベント未処理）。event は block 先頭一括（sample-accurate オフセット無し）。hot-uninstall（deactivate ハンドオフ）は未実証。
- A0 からの逸脱: cpal sample format は **F32 のみ**対応（I16/I32/U16 は未実装・spike 簡略化）。

## 13. S1b 実行結果（2026-06-20）— 低レイテンシ + release + dynamic hot-install

S1 の未 retire 3 項目（高レイテンシ限定 / debug / static-load）を潰した（Issue #295）。

### S1b-1 — 低レイテンシ + release（`--buffer-frames`）

| 構成 | budget | callback max | xrun | resize | 発音 |
|---|---|---|---|---|---|
| 128 frame・debug | 2.9ms | 31µs（1.07%） | 0 | 0 | peak 0.25 |
| 256 frame・debug | 5.8ms | 91µs（1.57%） | 0 | 0 | peak 0.25 |
| **128 frame・release** | 2.9ms | **10.8µs（0.37%）** | 0 | 0 | peak 0.25 |

→ 低レイテンシ（128 frame = 2.9ms）でも debug/release とも RT 安全。小バッファほど 1 callback の仕事が小さく相対余裕はむしろ大きい。（p99=0 は callback が全て <50µs でヒスト最小バケットに入るため。worst-case は `max_ns` が示す。）

### S1b-2 — dynamic hot-install（`--hot-install-after-secs`）

稼働中ストリームを engine-only で開始 → N 秒後に**主スレッドで `activate` + buffers 構築 → `StartedPluginAudioProcessor`(Send) を wait-free rtrb ring で audio thread に move → callback が一度だけ pop して install**（A0 §8 の所有権ハンドオフ）。

| 構成 | install callback | callback max | xrun | 発音 |
|---|---|---|---|---|
| 256 frame・+5s | #862（=5s@256） | 49µs（0.84%） | 0 | peak 0.25（install 後） |
| 128 frame・+5s | #1722（=5s@128） | 45µs（1.54%） | 0 | peak 0.25（install 後） |

→ install は期待 callback で着地、**move は alloc/lock 無し**、install callback で時間スパイク無し（max 45–49µs に留まる）、install 後に発音。static 経路も回帰なし。

### 実装

`OrbitAudioProcessor` の `plugin`/`buffers` を `Option` 化し、static（stream 前に同期 install）と hot（`InstallMsg` を rtrb で受領）を統一。`InstallMsg{StartedPluginAudioProcessor, HostAudioBuffers, note_port_index}` は全 `Send`（buffers は control thread で事前確保）。CLAP `activate`/`start_processing` は主スレッド、`process` は audio thread。

### S1b 後に残る未実証（さらに後続）

単一プラグイン・ノードグラフ無し（`ConnectNode`）/ `OutputEvents::void()`（plugin→host 未処理）/ block 先頭一括 event / cpal F32 のみ / hot-uninstall（deactivate ハンドオフ）。

### S2/A4 carry-forward（bot second-opinion・RT/clack correctness）

PR #294 で `@claude` bot に RT/clack correctness を second-opinion 依頼し、**internal pr-review-team が拾わなかった CLAP-spec-subtle な 3 件**を検出（Critical 0 / Important 3）。**いずれも spike の PASS verdict に影響なし**（テストシンセが当該パスを踏まない）。**spike binary は patch しない** — S2 はこの crate のコピーでなく daemon 統合の fresh 実装のため、「正しいパターンを記録して S2 が一度で正しく作る」方が durable（advisor 判断）。

- **#1 teardown スレッド**: `drop(stream)` は `StartedPluginAudioProcessor::drop` → `stop_processing()` を **main thread** で呼ぶが、CLAP は `process()` と同じ **audio thread** を要求。→ S2 は clack example の **`deactivate_and_stop_stream()` パターン**（stream 停止前に audio thread で `proc.stop_processing()`）を踏む。暗黙 Drop に頼ると strict なプラグインで UB になりうる。
- **#2 `request_callback` の RT 非安全**: `host.rs` の `mpsc::Sender::send()` は alloc + 内部 mutex。プラグインが `process()` 内から `host.request_callback()` を呼ぶのは CLAP 上合法 → audio thread で RT 違反。→ S2 は **lock-free 通知**（`Arc<AtomicBool>` を main pump が poll 等）に置換。
- **#3 `EventBuffer` realloc 不変条件**: Vec-backed のため容量超過で callback 内 realloc。spike では `event_scratch.len() <= 1024` の **`debug_assert` で regression guard 追加済**。→ S2 は固定サイズ CLAP event ring へ。

bot レビュー全文: PR #294 コメント（GitHub Actions `runs/27862509329`）。

## 11. 関連

- Epic #292 / Issue #293 / Issue #295（S1b） / research #95
- `docs/development/POST_2.0_MASTER_PLAN.html`（§3, §5, §7）
- `docs/research/RUST_PLUGIN_HOSTING.md`（§0, §A, §6）
- `docs/research/ENGINE_DAEMON_PROTOCOL.md`（§5 Plugin 予約コマンド・§10 ringbuf 指針）
- clack 公式 cpal example: `prokopyl/clack` `host/examples/cpal/`（本書の API 根拠）
