# POST-2.0 — VST3 Hosting 実装計画（effect + instrument, CLAP と対称）

**記録日**: 2026-07-08
**Issue**: #395（本 plan doc）/ #381（Phase 0 = Step0 spike）/ Epic #292
**正本参照**: `docs/development/POST_2.0_PLUGIN_STRATEGY.html`（§3 format 非依存 substrate / §7 δ VST3 / §9 まとめ）・`docs/research/RUST_PLUGIN_HOSTING.md`
**実装の委譲先**: `/codex:rescue`（本 doc は codex が会話文脈なしで迷わず実装できる粒度で書く）

---

## 0. この doc の読み方（codex 向け前置き）

- 各 Phase は **「対象ファイル（実在テンプレートの path:line）」→「作業手順」→「受け入れ基準」→「STOP gate」** の順で書いてある。
- **必ず、まず既存の CLAP 実装ファイル（§2 の表）を実際に開いて読むこと。** 本 doc の説明は要約であり、正確な契約は実ファイルにある。VST3 実装は基本的に「CLAP 版のファイルを VST3 に置き換えた対称物」を作る作業。
- 🛑 **STOP gate** が付いた項目は、条件を満たせなければ**その場で停止し owner に報告**する（先に進まない）。
- 受け入れ基準は**可能な限り offline（device/耳 不要）**。既存 M1（#360）が確立した「closed-form oracle との sample-exact 比較」パターンを踏襲する。
- ブランチ/コミット規約はリポジトリの `CLAUDE.md` に従う（main 直コミット禁止・issue 番号付きブランチ・Conventional Commits・WORK_LOG 更新）。

---

## 1. スコープと owner 意図

> 🎛️ **パイプラインの north star**: 1 つの再生パイプラインで **CLAP / VST3 / AU を併用**する。instrument は per-format 単体、effect は**混在フォーマットの直列チェーン**。正本 §3 の format 非依存 substrate（「plugin format = どの child を spawn するか」だけ）がこれを可能にする。

### owner が求めているもの
- **最終ゴール = CLAP / VST3 / AU を同じパイプラインで併用できる engine。** どれか 1 つに絞るのではなく、3 フォーマットが 1 つの再生パイプラインに共存する。
- **「両方」= instrument 系と effect 系の両カテゴリをホストする**、という意味（DAW/SDK で裏取り済み・§8 evidence）:
  - **effect（エフェクト）= 直列 insert チェーンのノード**。信号を直列に通す挿入で、**複数連結でき各ノードのフォーマットが混在し得る**（例: `AU → CLAP → VST3`）。Ableton「chain of devices（左→右に流れる）」/ Bitwig device chain / JUCE `AudioProcessorGraph` が標準モデル。format 混在は REAPER（VST3/CLAP/AU をホスト）+ JUCE `AudioPluginInstance`（format 別 wrapper 上の format 非依存ノード）で architecturally 確認。**caveat**: 「AU→CLAP→VST3」順の verbatim なマニュアル例は無く format 列挙 + host 抽象からの推論。**Bitwig は AU 非対応**（VST/CLAP のみ）。
  - **instrument（音源）= note/MIDI 入力 → audio 出力の source ノード**（通常 audio 入力なし）。effect のように「audio を直列に通す」挿入ではない。※「1 track = 1 instrument」は host 不変条件ではない — DAW は instrument rack/layer で重ねられ前段に note/MIDI FX も置ける（REAPER/Ableton/Bitwig）。OrbitScore 近期は 1 音源 = 1 プラグインで足りるが、内部モデルは format 非依存ノードグラフの **source ノード**として扱う（effect = insert ノード / instrument = source ノード）。
- **VST3 の位置づけ = 次に追加するフォーマット。** 市販プラグイン資産が VST3/AU に集中し出荷価値が高いため VST3 を最優先で足す。実装は**既存 CLAP host の構造を対称にコピーした兄弟実装**（`orbit-clap-host` → `orbit-vst3-host` 等）。共有の format 非依存 substrate に両方が乗るので **CLAP は動いたまま**・**AU も後から同 substrate に乗る**。「主眼」は「VST3 を最優先で追加」の意味で、他フォーマットを捨てる意味ではない。
- **CLAP は legacy ではなく first-class。** 市販資産は VST3/AU 中心だが、**良質なオープンソース CLAP は積極的に集めてバンドルしたい**（owner）。
- 実プラグイン資産（市販）は VST3/AU に集中 → 出荷価値は VST3/AU カバレッジに依存（owner 確定 2026-07-04）。

> ⚠️ **effect chain の現状と design item**: 現 substrate は**単一 effect insert**（`PostProcessor` 1 つ）。混在フォーマットの**多段チェーン**が最終形。format 非依存 substrate では各ノードのフォーマットは独立（各ノードが自分のフォーマットの child を spawn・serial insert = overwrite が自然に合成される）。**多段チェーン化は design item** — 現コードが単一 effect 前提なので、Phase 1 で「format 選択を chain-ready にしておく」（`PluginFormat` を per-node で持てる形）に留め、実際の N 段チェーン + 混在フォーマットの合成は現コードと突き合わせて別途設計する（Phase 1 の VST3 effect 自体は現 CLAP と同じ単一 insert で足りる）。

> 🔌 **プラグイン I/O サーフェスの完全カバー（correctness 要件・evidence 済み §8）**: プラグインは名前どおり "plug-in" であり、**各プラグインが宣言した I/O + event surface を host が query して honor** しないと正しくホストできない。カバーすべき面: audio 入出力バス（**multi-out / sidechain(aux) 含む**）・**note/MIDI の入力と出力**（effect が MIDI を取る / instrument が MIDI を出すこともある）・param automation・**MIDI CC**・**note expression / MPE / MIDI2 dialect**。「stereo audio-in → audio-out + note-on/off だけ」の固定形は serious host には不足。裏取り: CLAP `audio-ports`/`note-ports`(dialect 宣言)/`params`・VST3 `getBusCount`/`setBusArrangements`/`IEventList`/`IParameterChanges`(note expr 含む)・AU `AUAudioUnit`(inputBusses/outputBusses/MIDI in+out)。→ この要件が **Phase 2 の M2 IPC 設計を規定**（format-neutral event/param IPC は full surface を運べること）+ **audio transport は宣言された bus arrangement を honor**（現 M1 transport は単一 stereo sum なので multi-out/sidechain は既知の coverage gap）。

> 🧩 **アーキの北極星 = Bitwig 型 per-plugin サンドボックス（owner 指定の理想・evidence §8）**: Bitwig はプラグインを **audio engine と別プロセスで sandbox** し（modes: `Within Bitwig` / `Together`〔default〕/ `By Manufacturer` / `By Plug-in` / `Individually`）、crash してもプロジェクト全体を巻き込まず `Reload Plug-in` で復帰する。**OrbitScore の OOP-child substrate（γ sandbox spike + M1 `EffectChildSupervisor` の spawn/watchdog/respawn）は既にこの同型**（out-of-process・crash 隔離・自動 respawn）。VST3/AU の追加は「同じ sandbox substrate に別 format の child を足す」だけ = **構造的に Bitwig に自然に寄る**。sandbox 粒度（1 child = 1 plugin か複数まとめるか）は Bitwig の 5 modes 相当の**将来 knob**（現状は effect ごとに 1 child ≒ `By Plug-in`/`Individually`）。CLAP は **Bitwig + u-he の共同開発** → CLAP-first substrate はこの系譜と整合。

### 🔴 最重要 — effect と instrument は準備状態が非対称（平坦化禁止）
| カテゴリ | 乗る substrate | 現状 | この doc での扱い |
|---|---|---|---|
| **VST3 effect** | M1 effect transport（`orbit-audio-sandbox`・**DONE #360**） | substrate 完成・CLAP effect child が実証済み | **Phase 0→1 で codex がすぐ着手可**（具体的・file-anchored） |
| **VST3 instrument** | M2 instrument IPC（per-block note/param・**未実装**） | substrate 自体が存在しない（正本 §3/§9 で「次の関門」） | **Phase 2 で M2 を先に設計（spec 作業・Opus + owner）→ Phase 3 で instrument** |

> 🛑 **codex への最重要指示**: instrument（Phase 3）は M2 substrate（Phase 2）が存在しないと実装できない。**M2 が未着手のうちに VST3 instrument child を書き始めてはいけない**（ad-hoc な IPC を発明すると、正本 §3 の「M2 IPC を format-neutral にする」という唯一の plan-affecting 決定を破壊する）。Phase 2 が landing するまで Phase 3 は着手禁止。

### この doc が対象にしないもの
- **DSL 構文**: 現状ゼロ（§6）。engine 側は CLI/env 駆動で完結でき、DSL は non-blocking な後続の owner 判断（§6 で選択肢提示）。**codex は DSL を実装しない**。受け入れ基準は `cargo test` + gated offline harness であって「DSL を配線する」ではない。
- **AU（AudioUnit）**: owner「急がない」。本 doc 対象外（VST3 substrate ができれば AU も同 substrate に child を足すだけ・将来別 doc）。

---

## 2. 現状アーキテクチャ（既存 CLAP 資産 — codex はまずこれを読む）

VST3 実装はこれらの**対称物**を作る。各行の path:line は 2026-07-08 時点で実ファイル確認済み。

### 2.1 共通 seam（VST3 でもそのまま使う・変更不要）
| 資産 | path | 契約 |
|---|---|---|
| `PostProcessor` trait | `rust/crates/orbit-audio-native/src/post_processor.rs`（trait 定義 ~L23-27） | `fn process(&mut self, data: &mut [f32])` の 1 メソッドのみ。engine render 済み interleaved f32（hardware sum）を in-place 変換。**VST3 版もこの trait を実装するだけ**。ch数/SR は構築時確定。 |
| render loop 呼び出し元 | `rust/crates/orbit-audio-native/src/output.rs`（`render_block()` 内 ~L186-188） | `if let Some(p) = post.as_mut() { p.process(hw); }`。engine render 後・capture tap 前。**この呼び出し元は format 非依存**。 |
| in-process 起動 entry | `rust/crates/orbit-audio-native/src/output.rs`（`start_default_output_with_clap()` ~L340-350） | `Box<dyn PostProcessor>` + buffer_frames + capture_path を受け取る。VST3 用に汎化 or 対称関数を足す。 |

### 2.2 CLAP host crate（VST3 版 `orbit-vst3-host` の対称元）
| 資産 | path | 役割 |
|---|---|---|
| crate root | `rust/crates/orbit-clap-host/` | in-process CLAP host。`lib.rs` が公開 API を集約（`new_clap_host()` 等）。 |
| load→activate→start | `orbit-clap-host/src/controller.rs`（`instantiate_activate()` ~L83-175） | discover → `PluginInstance::new` → activate → `start_processing`。daemon 側・OOP 側の両方がこれを共有。 |
| **effect/instrument 分岐（★核心）** | `orbit-clap-host/src/processor.rs`（`process_block_core()` L121-164。分岐 = **L133** `let is_effect = buffers.has_audio_input();`） | **L133** で audio 入力ポート有無を判定。effect: 入力に dry を de-interleave → 出力で **L155 `replace_cpal_buffer`（overwrite = serial insert）**。instrument: **L137 `set_input_silent()`** → 出力を **L157 `add_to_cpal_buffer`（+= add-mix）**。 |
| 単一スレッド effect 実装 | `orbit-clap-host/src/effect.rs`（teardown field 順の正当性コメント ~L58-68） | OOP child が使う単一スレッド版。フィールド宣言順（`plugin` を `_instance` より前）で drop 順を保証。 |
| discovery | `orbit-clap-host/src/discovery.rs` | `.clap` バンドル探索/ロード。 |
| Cargo.toml（依存 pin） | `orbit-clap-host/Cargo.toml`（~L20-33） | `clack-host` / `clack-extensions` を git pin（pre-1.0）。**clack は permissive なので GPL 隔離は不要だが feature に括る**（コメント L3）。 |

### 2.3 OOP substrate（VST3 で **そのまま流用**・CLAP 非依存を確認済み）
| 資産 | path | 役割・流用可否 |
|---|---|---|
| **transport（★流用）** | `rust/crates/orbit-audio-sandbox/src/transport.rs`（`SharedRegion` ~L79-118・`SLOTS=2` L48） | file-backed mmap(MAP_SHARED) + SPSC ping-pong。同期 = atomic `seq_request`/`seq_done`/per-slot `seq_tag`（Acquire/Release）。**完全に CLAP 非依存**（memmap2 のみ依存・clack import ゼロ）。**VST3 でも無改変で使える。** |
| pipelined host | `orbit-audio-sandbox/src/host.rs`（`PipelinedEffectHost` ~L29-48） | 候補B state machine（submit→前block read）。format 非依存。 |
| CLAP child binary | `rust/crates/orbit-clap-effect-child/src/main.rs`（処理ループ ~L68-151） | 隔離子プロセス実バイナリ。CLI 引数 `--shm <path>` `--plugin <path>` `--plugin-id <id>` `--sample-rate <u32>`。shm を map → input slot を scratch にコピー → `ClapEffectProcessor::process_block`（in-place）→ output slot → `seq_tag`/`seq_done` 更新。**clack をリンクする唯一の OOP crate**。**VST3 版はこの main.rs を丸ごと対称コピーし、`ClapEffectProcessor` を VST3 版に差し替える。** |
| daemon supervisor | `rust/crates/orbit-audio-daemon/src/outproc_effect.rs`（`EffectChildSupervisor` ~L357-521・`OutProcEffectPostProcessor` ~L224-252・`OutProcEffectConfig` L64 / `from_env` L82） | spawn + watchdog（20ms `try_wait` ポーリング）+ respawn（同一 shm を指す child 再起動）+ teardown 順（Drop: watchdog停止→QUIT→shm unlink）。プラグイン指定は **env のみ**: `ORBIT_EFFECT_CHILD_BIN`（child binary path・L78）/ `ORBIT_EFFECT_PLUGIN`（.clap path・必須・L80）/ `ORBIT_EFFECT_PLUGIN_ID`（任意・L81）。 |

### 2.4 daemon 配線
| 資産 | path | 役割 |
|---|---|---|
| feature 配線 | `rust/crates/orbit-audio-daemon/src/engine_wrap.rs`（`EngineWrap::start()` clap-host 版 ~L302-339・outproc-effect 版 ~L349-419） | `#[cfg(feature = "clap-host")]` / `#[cfg(feature = "outproc-effect")]`。両 feature は `link-audio` と相互排他（`compile_error!` ガード）。 |

### 2.5 license 境界
| 資産 | path | 契約 |
|---|---|---|
| allow list | `rust/deny.toml`（~L20-35） | 許可 = MIT / Apache-2.0 / BSD-2/3 / ISC / Zlib / Unicode-3.0 / MPL-2.0 / CC0-1.0 / `LicenseRef-Signal-compose-FairTrade-1.0`。GPL-2.0-or-later は意図的に非掲載。 |
| GPL 隔離パターン | `rust/Cargo.toml`（`exclude` ~L15-24） | `orbit-link-audio`（GPL）を workspace member から除外し optional feature 経由でのみ取り込む。cargo-deny は default graph（GPL feature off）で走る。**VST3 は permissive なのでこの隔離は不要**（allow list を通る想定）。 |

### 2.6 DSL 側（TypeScript）
| 資産 | path | 現状 |
|---|---|---|
| play params | `packages/engine/src/audio/rust-engine/rust-engine-player.ts`（`DaemonPlayParams` ~L102-117 / `toDaemonParams` ~L953） | `gain/pan/offsetSec/durationSec/rate` のみ。**plugin フィールドは存在しない。** プラグインをロードする DSL 構文は皆無（§6）。 |

---

## 3. 実装計画（段階化・依存グラフ付き）

```
Phase 0  Step0 spike (in-process, offline)           ← #381・codex-ready・🛑 2 STOP gate
   │       ├ 0a: vst3 dep-tree license audit
   │       └ 0b: 実 VST3 effect を offline で load→process→drop（sample-exact 1 block）
   ▼
Phase 1  VST3 effect (production, OOP)                ← codex-ready・M1 substrate 流用
   │       ├ 1a: orbit-vst3-host（in-proc + effect processor）
   │       ├ 1b: effect/instrument 判定 = VST3 bus count
   │       ├ 1c: orbit-vst3-effect-child（transport 流用）
   │       └ 1d: daemon supervisor を format 汎化
   ▼
Phase 2  M2 instrument IPC substrate (SPEC)           ← 🔴 Opus + owner・codex 委譲禁止
   │       format-neutral な per-block note/param IPC を設計
   ▼
Phase 3  VST3 instrument (production, OOP)            ← M2 landing 後に codex-ready
           orbit-vst3-instrument-child（M2 substrate 上）

（並行・non-blocking）DSL surface = owner 判断（§6）— engine は DSL なしで CLI/env 完結
```

---

### Phase 0 — Step0 spike（in-process・offline・#381）

**目的**: VST3 の最大リスク = 「Rust で COM を unsafe に手書きしてホストする」を、最小・offline で retire する。transport には触れない。

**依存**: なし（今すぐ着手可）。

#### 0a. `vst3` crate の依存ツリー license 監査 🛑
- **作業**: `orbit-vst3-host`（新 crate）に `vst3 = "0.3"` を追加した状態で `cargo tree` を取り、**全 transitive 依存**のライセンスを `rust/deny.toml` の allow list（§2.5）と照合する。`cargo deny check licenses` を実行。
- **受け入れ基準**: `cargo deny check` が pass。
- 🛑 **STOP gate**: allow list に無いライセンス（特に copyleft）を持つ依存が 1 つでもあれば**停止して owner に報告**。GPL 隔離 crate パターン（`orbit-link-audio` 方式・§2.5）の適用可否を添えて判断を仰ぐ。**owner 承認なしに allow list を書き換えない。**
  - 補足: `vst3` crate 本体は MIT OR Apache-2.0（確認済み）。v0.3.0 で binding が source 同梱になり build-time の libclang 生成が消えたので、`bindgen`/`clang-sys` 系の重い依存は入らない見込み。ただし**推測せず `cargo tree` で実確認する**こと。

#### 0b. 最小 in-process host spike 🛑
- **新 crate**: `rust/crates/orbit-vst3-host/`（`publish = false` の spike から始めてよい。将来 Phase 1 で production 化）。
- **対称元**: `orbit-clap-host/src/controller.rs`（`instantiate_activate` L83-175）+ `processor.rs`（`process_block_core` L121-164）。**これを VST3 の COM 呼び出しで書き直す。**
- **作業手順**:
  1. `.vst3` バンドル（macOS では `Contents/MacOS/<name>` の dylib）を dlopen し、`GetPluginFactory` を取得。
  2. factory から `IComponent` を instantiate → `initialize` → `IAudioProcessor` を query。
  3. `setupProcessing`（`ProcessSetup`: sample rate / max block size / realtime）→ `setActive(true)` → `setProcessing(true)`。
  4. `process(ProcessData)` を 1 block 分呼ぶ（既知の入力サンプル）。
  5. 逆順で teardown（`setProcessing(false)`→`setActive(false)`→`terminate`→factory drop）。**drop 順は `orbit-clap-host/src/effect.rs:58-68` の field-order 規律を VST3 用に踏襲。**
- **テスト対象プラグイン（2 系統・両方必須）**:
  - **① sample-exact oracle**: 振る舞いが closed-form に予測できる自作 gain VST3。`vst3` crate 同梱の `examples/gain.rs`（`out = gain × in`・smoothing なし・純 Rust）を cdylib 化し macOS `.vst3` バンドルに package する（**C++ SDK 不要**）。**我々が挙動を完全に把握している既知プラグイン**であることが要点。
  - **② 実市販プラグイン（ABI 検証・load-bearing）**: インストール済みの**本物の VST3**（実 Steinberg C++ SDK でコンパイル・`/Library/Audio/Plug-Ins/VST3/`）を最低 1 つ load→process→drop する。
- **受け入れ基準（offline・device 不要）**:
  - **① sample-exact**: 既知入力に対する 1 block 出力が **oracle と sample-exact**（`in × gain` と bit 一致・許容誤差 f32 丸めのみ）。`process()` の音声データパス意味論を証明する。
  - **② 実プラグイン ABI 適合**: ②の本物プラグインが**クラッシュせず** factory 取得 → IComponent instantiate → IAudioProcessor query → setupProcessing → process 1 block を通し、**妥当な出力**（無音入力→無音・既知入力→非発散）を返す。🔴 **①だけでは binding ABI の正しさは証明されない**（Rust プラグイン ↔ Rust ホストは同じ `vst3` crate の ABI 解釈を共有するため、**相互に一貫して間違っていても PASS しうる**）。②が実 SDK 製プラグインとの適合を担保する load-bearing な判定。
  - どちらも `#[ignore]` gated でなく通常 `cargo test` で回せる offline test（dylib 不在時は test 内 skip 判定可・ただし ② は「skip=未検証」を verdict に明記）。
- **compatibility sweep（Phase 0 の診断出力・gate ではない）**: ②のホストが動いたら、`/Library/Audio/Plug-Ins/VST3/` の全 VST3 に対し best-effort で load→query→（可能なら process）→drop を回し、**pass / fail / crash / hang の互換マトリクス**を verdict doc に記録する。crash/hang するプラグインは Phase 1+ の triage 対象としてマークするだけ（Phase 0 gate は ②の代表 1 つで足りる）。★ **北極星 = 市販 VST3 コレクション全体の互換性**（owner 意図「最終的には全部試す」）。exhaustive な per-plugin correctness（各プラグインの I/O サーフェス・MPE 等の honor）は Phase 1+ の継続作業。
- 🛑 **STOP gate**: ①で手書き COM が sample-exact な 1 block を出せない／②で実市販プラグインが 1 つも load→process を通せない／`vst3` crate の API surface が hosting に不足している場合、**Phase 1 以降は全て moot**。verdict doc（`docs/development/POST_2.0_VST3_STEP0_SPIKE.md`）に事実を記録し owner に報告。GO 判定なら工数見積りを添える。

**Phase 0 完了条件**: 0a pass + 0b ① sample-exact + 0b ② 実市販プラグイン load-bearing PASS + compatibility sweep 記録 + verdict doc。**この gate を越えるまで Phase 1 に着手しない。**

---

### Phase 1 — VST3 effect（production・OOP）

**目的**: 実 VST3 effect を production daemon で OOP child として host する。M1 substrate（`orbit-audio-sandbox`）を流用。

**依存**: Phase 0 GO。

#### 1a. `orbit-vst3-host` を production 化
- **対称元**: `orbit-clap-host`（crate 全体）。
- Phase 0 の spike を整理し、以下を公開 API に:
  - `Vst3EffectProcessor`（`orbit-clap-host::ClapEffectProcessor` の対称・単一スレッド load→process→drop）。
  - process カーネル（`process_block_core` L121-164 対称）。**effect/instrument 分岐（1b）を内蔵。**
- `PostProcessor` trait（§2.1）を実装（VST3 でも seam は共通）。

#### 1b. effect/instrument 判定（★ CLAP と機構が違う・codex 注意）
- CLAP は `buffers.has_audio_input()`（`processor.rs:133`）で判定していた。**VST3 では同じ API は無い。**
- **VST3 の等価判定**: `IComponent::getBusCount(kAudio, kInput)` で **audio 入力バス数**を問い合わせ、`> 0` なら effect（**overwrite = `replace_cpal_buffer` 相当**）、`0` なら instrument（**add-mix = `add_to_cpal_buffer` 相当**）。
- 🔴 **silent-but-wrong リスク**: ここを CLAP の機構がそのまま移ると誤解すると、add-mix と overwrite を取り違えて「音は出るが間違った」出力になる。**必ず VST3 bus arrangement API で判定すること**を実装コメントに明記。
- Phase 1 では effect 経路（入力バス > 0）のみ通す。instrument 経路（0 バス）は Phase 3 まで実質未使用だが、判定ロジックは対称に書いておく。

#### 1c. `orbit-vst3-effect-child` を新規作成
- **対称元**: `orbit-clap-effect-child/src/main.rs`（L68-151）を**丸ごとコピー**し、処理部の `ClapEffectProcessor::process_block` を `Vst3EffectProcessor::process_block` に差し替える。
- **transport は無改変流用**: `orbit_audio_sandbox::SharedRegion`（§2.3）を map。CLI 引数も CLAP child と対称（`--shm` `--plugin` `--plugin-id`〔VST3 では class id〕`--sample-rate`）。protocol（per-slot `seq_tag` fresh 判定・`seq_done` submit guard・scratch を介す in-place 橋渡し）は**同一**。
- **clack をリンクしない**（VST3 child は `orbit-vst3-host` 経由でのみ VST3 SDK に依存）。

#### 1d. daemon supervisor を format 汎化
- **対象**: `orbit-audio-daemon/src/outproc_effect.rs`（`OutProcEffectConfig` L64 / `from_env` L82・`EffectChildSupervisor` L357-521）。
- CLAP 固有部分は「どの child_exe を spawn するか」と「env 変数名」だけ（transport/watchdog/respawn は format 非依存）。**最小変更**:
  - `OutProcEffectConfig` に plugin format 種別フィールド（`enum PluginFormat { Clap, Vst3 }`）を追加。
  - `from_env` を拡張: `ORBIT_EFFECT_FORMAT`（`clap`|`vst3`・既定 `clap` で後方互換）を読み、format に応じて既定 child_exe（`orbit-clap-effect-child` / `orbit-vst3-effect-child`）を選ぶ。`ORBIT_EFFECT_PLUGIN`（プラグイン path）/ `ORBIT_EFFECT_PLUGIN_ID` はそのまま。
  - `EffectChildSupervisor::spawn()` は child_exe を CLI パラメータで受けているだけなので、config の child_exe を渡すだけで流用可（**spawn/watchdog/respawn ロジックは変更しない**）。
- `engine_wrap.rs`（§2.4）の feature 配線: 既存 `outproc-effect` feature で両 format を扱えるようにする（VST3 用に新 feature を切るか既存に相乗りするかは、依存の重さ次第で codex が判断・迷えば既存 feature 相乗り + format は runtime env で分岐が最小変更）。

#### Phase 1 受け入れ基準
- **offline oracle parity**（最重要・device 不要）: M1（#360）が確立したパターン — 実 VST3 gain effect を child 経由で通し、host 側出力が closed-form oracle（入力 × gain）と sample-exact。既存の CLAP 側 offline parity test（`orbit-clap-effect-child` の gated/offline test）を対称に複製。
- **`cargo deny check` pass**（§2.5 allow list）。
- **`cargo test` pass**（既存の supervisor 非 gated test — respawn-fail/orphan-reap/concurrent-teardown — を VST3 child でも通す）。
- **gated 実機 harness**（owner 同席時に実行・`#[ignore]`）: parity ratio + kill→respawn 復帰 + 32/64f stale-rate。CLAP 側の `tests/outproc_effect_gated.rs` を対称に複製。CI は Rust gated 非実行なので、ローカル cargo + 実機 RUN が根拠になる（owner 同席・[[owner-authorizes-self-run-gated-audio]] 運用）。

---

### Phase 2 — M2 instrument IPC substrate（SPEC 作業）

> 🔴 **これは codex に委譲しない。** format-neutral IPC の設計は「決定を含む spec 作業」であり、正本 §3/§9 の「M2 IPC を format-neutral（note + param/CC）で仕様化する」という**唯一の plan-affecting 決定**を保持する責務がある（Opus main + owner）。codex に投げると ad-hoc IPC を発明してこの決定を破壊する。

**目的**: per-block で **full event/param surface** を child へ運ぶ format-neutral な IPC を設計する。§1 の I/O カバレッジ要件（§8 evidence）どおり、note-on/off だけでなく **MIDI/note の in+out・CC・param automation・note expression / MPE / MIDI2 dialect** を neutral に表現する（3 format に写せる superset にする: CLAP `note-ports` の dialect・VST3 `Event`〔note expression 含む〕・AU MIDI in/out）。effect の M1 transport（audio buffer 往復）に **event/param チャネル**を足す拡張 + **宣言された audio bus arrangement**（multi-out / sidechain）の honor を含める。

> 🔴 **format-neutral の意味を取り違えない**: 「note-on/off + 1 param」に痩せさせるのは NG。neutral = 3 format の宣言 surface を**包含する superset**であること（痩せた IPC は正本 §3 の決定を実質破壊する）。ここが Phase 2 を Opus + owner が持つ理由。

**設計の起点（既存資産）**:
- `orbit-clap-host/src/events.rs` の `PluginEvent`（`make_event_ring` / `PluginEventProducer/Consumer`）は既に `PluginEvent::NoteOn{key,channel,velocity}` 形で **neutral**。これを IPC 境界（`orbit-audio-sandbox` transport）に載せる形へ拡張する。
- transport（`SharedRegion`）は現状 audio input/output slot のみ。ここに **event slot（per-block の note/param 列）** を足すのが M2 の substrate 拡張。

**成果物**: 設計 doc（`docs/development/POST_2.0_GAMMA_M2_DESIGN.md`）+ owner ゲート。設計確定後、child 側の event 適用実装は Sonnet/codex 委譲可（transport 拡張の純粋部分）。

**この doc では M2 の詳細設計は未確定**（owner 協議事項）。Phase 1 が landing した後、別途この doc または M2 design doc で詰める。

---

### Phase 3 — VST3 instrument（production・OOP）

**目的**: 実 VST3 instrument（音源）を M2 substrate 上で host。pitch DSL（Epic #224）との結節点。

**依存**: 🛑 **Phase 2（M2 substrate）landing 必須。** M2 が無ければ着手禁止（§1）。

**作業（M2 landing 後に詳細化）**:
- **新 child**: `orbit-vst3-instrument-child`。`orbit-vst3-effect-child`（Phase 1c）を対称元に、audio 入力を無音（`set_input_silent` 相当）にし出力を **add-mix**（1b の 0-バス経路）。
- M2 IPC で per-block の note/param を受け、`Vst3EventList`（VST3 の event 入力）へ変換して `process(ProcessData)` の `IEventList` に渡す。
- **受け入れ基準**: offline note-render parity（既知 note 列 → 既知波形の instrument で sample-exact）。gated 実機で発音確認（owner 同席）。

---

## 4. codex への申し送り（作業規律・検証・landmines）

### 検証コマンド（各 Phase 完了時に全部緑を確認）
```bash
cd rust
cargo build --workspace
cargo test --workspace              # 非 gated
cargo deny check                    # ★ vst3 は crates.io crate なので必ず審査対象
cargo fmt --all -- --check
cargo clippy --workspace -- -D warnings
# gated（owner 同席時のみ・#[ignore]）
cargo test -p orbit-audio-daemon --test outproc_effect_gated -- --ignored --nocapture
```

### 規律
- **既存 CLAP ファイルを実際に開いてから対称物を書く**（§2 の path:line）。要約でなく実契約に合わせる。
- **transport（`orbit-audio-sandbox`）は無改変で流用**。ここに VST3 方言を焼き込まない（format 非依存を保つ）。
- effect/instrument 判定は VST3 bus count で（§1b）。CLAP の `has_audio_input` を移植しない。
- **後方互換**: `ORBIT_EFFECT_FORMAT` 既定は `clap`。既存 CLAP 経路を壊さない。
- **1 論理変更 = 1 commit**（Conventional Commits・title 英語 / body 日本語）。各 commit で build/test 緑を維持。
- **WORK_LOG.md を毎コミットで更新**（`docs/WORK_LOG.md`）。

### landmines（このリポジトリ固有・serena memory 由来）
- build は sandbox で EPERM（listen 不可）→ `dangerouslyDisableSandbox: true` で実行。
- `.env.example` は sandbox read-deny → `git diff` が誤って削除表示。`git status --short` が権威。
- daemon 再ビルド直後の初回 `start_engine` は ready timeout（10s）で落ちることがある → リトライ 1 回で回復。
- 両 OOP feature（`clap-host`/`outproc-effect`）は `link-audio` と相互排他（`compile_error!` ガード）。VST3 を feature 化する場合もこの排他規律に合わせる。
- **CI は Rust gated を実行しない** → offline test + ローカル cargo + owner 同席 gated RUN が唯一の根拠。offline で証明できるものは offline で（closed-form oracle）。

### レビュー（Phase ごと・PR 時）
リポジトリ `CLAUDE.md` の PR レビューワークフロー厳守: `/simplify` → `/code:pr-review-team`（Critical/Important=0 まで収束）→ advisor → 必要なら `@claude` bot。**codex がハンドロールで代用しない。**

---

## 5. 委譲マトリクス

| 作業 | 担当 | 理由 |
|---|---|---|
| VST3 SDK / crate ライセンス一次確認 | **Opus**（済） | license 検証は Opus 専管（[[verify-api-contract-against-source]]）。§Phase0-0a の dep-tree 監査は codex 実行 + Opus/owner が STOP 判定 |
| Phase 0 spike 実装 | codex（Sonnet 可） | 契約確定後の隔離 spike |
| Phase 1 effect 実装 | codex | file-anchored・M1 流用・offline 検証 |
| **Phase 2 M2 IPC 設計** | **🔴 Opus + owner** | format-neutral 決定の保持（委譲禁止） |
| Phase 3 instrument 実装 | codex（M2 landing 後） | M2 substrate 上の対称 child |
| DSL surface 決定 | **owner**（§6） | 複数の妥当案・機能の形を決める |

---

## 6. DSL surface（non-blocking・owner 判断）

engine は §2.3 のとおり **CLI/env 駆動で完結**でき、DSL なしで Phase 0-3 の全受け入れ基準を満たせる（既存 CLAP も env のみで動いている）。DSL は **engine が動いた後の後続**として、owner が形を決める。**急がない**（急ぐと未確定の構文を engine に焼き込むリスク）。

選択肢（Phase 1 effect が動いた後に owner と確定）:

- **Option A — verb スタイル（推奨候補）**: `seq.effect("path.vst3")` / `seq.instrument("path.vst3")` のように sequence/track に紐づける。既存 DSL の verb 群（`gain`/`pan` 等）と一貫。`DaemonPlayParams`（`rust-engine-player.ts:102-117`）に plugin 参照フィールドを足す拡張が要る。
- **Option B — global plugin registry**: `global.loadPlugin("id", "path.vst3")` で登録 → sequence から id 参照。多数プラグインの共有・再利用に向く。
- **Option C — engine CLI/env 据え置き（当面）**: DSL を足さず env 駆動のまま（Phase 1-3 の検証はこれで足りる）。DSL は §8 EQ-from-DSL（正本）や M2 param/CC path が成熟してから。

推奨: **Option C で engine を先に固め、effect が実機で動いてから Option A を owner と確定**（正本 §8「EQ-from-DSL は M2 param/CC path の消費者・急がない」と整合）。

---

## 7. 参照
- 正本: `docs/development/POST_2.0_PLUGIN_STRATEGY.html`（§3 substrate / §7 δ VST3 / §9）
- 研究: `docs/research/RUST_PLUGIN_HOSTING.md`（CLAP>AU>VST3 成熟度・VST3 MIT 化）
- M1 設計: `docs/development/POST_2.0_GAMMA_M1_DESIGN.md`（effect OOP の設計正本・#360）
- γ spike verdicts: `POST_2.0_GAMMA_SANDBOX_SPIKE.md` / `POST_2.0_GAMMA_LATENCY_FORK_SPIKE.md`
- Issue: #395（本 doc）/ #381（Phase 0）/ Epic #292 / #360（M1）

---

## 8. プラグインホスト設計の evidence（codex research・2026-07-08）

§1 の framing（effect chain / instrument / 混在 format / I/O カバレッジ）の裏取り。一次ソース = SDK ヘッダ・DAW マニュアル・JUCE docs。

| 主張 | 判定 | 一次ソース |
|---|---|---|
| effect = 直列 insert チェーン（左→右） | ✅ 確認 | Ableton Live 12 manual "chain of devices"（§3.11/3.14）・Bitwig "Introduction to Devices"（signal は device 間を左→右）・JUCE `AudioProcessorGraph`（node + `addConnection`） |
| チェーンで format 混在可（AU/CLAP/VST3） | ✅ architecturally（**caveat**） | REAPER "About"（VST/VST3/CLAP/AU on macOS 等をホスト）・JUCE `AudioPluginInstance`（`AudioProcessor` 派生・format 別 extension は境界のみ）。**caveat**: 「AU→CLAP→VST3」順の verbatim 例は未取得（推論）。**Bitwig は AU 非対応**（manual は "VST or CLAP"） |
| instrument = source ノード（1 track=1 instrument は非不変） | ✅ 訂正済 | Ableton（MIDI→audio を instrument が変換・instrument rack）・Bitwig（instrument = note 受け audio 出力）。rack/layer・前段 note FX で複数化可能 → 「1 track=1 instrument」は host 不変条件ではない |
| host の process 界面は format-neutral | ✅ 確認 | VST3 `IAudioProcessor::process(ProcessData&)`（audio bus + `IParameterChanges` + `IEventList`）・CLAP `clap_process_t`（frames + audio in/out + event lists）・JUCE `processBlock(AudioBuffer&, MidiBuffer&)` |
| **I/O + event surface の完全カバーが必須** | ✅ 確認・critical | **CLAP**: `audio-ports`(channel/main/in-place)・`note-ports`(dialect: CLAP/MIDI/MPE/MIDI2)・`params`(automation event・MIDI CC 衝突を明記)。**VST3**: `getBusCount`/`getBusInfo`/`activateBus`・`setBusArrangements`・`Event`(note on/off・poly pressure・note expression・chord/scale・legacy MIDI CC)。**AU**: `AUAudioUnit` inputBusses/outputBusses/renderBlock/parameterTree/MIDI in scheduling + MIDI out block・`AudioUnitParameters.h`(mod wheel/pitch bend/pressure/expression 等 CC mapping) |
| **Bitwig = per-plugin サンドボックス host（owner 指定の理想）** | ✅ 確認 | Bitwig はプラグインを **audio engine と別プロセスで sandbox**・crash 隔離（"Never again will a single plug-in take down your entire project"）・`Reload Plug-in` で復帰。5 modes = `Within Bitwig`/`Together`(default)/`By Manufacturer`/`By Plug-in`/`Individually`。VST2.4/VST3/CLAP を全 OS でホスト。出典: bitwig.com learnings "Plug-in Hosting & Crash Protection" + support "What is plug-in crash protection" |
| CLAP は Bitwig + u-he 共同開発 | ✅ 確認 | 出典: bitwig.com/stories "CLAP: The New Audio Plug-in Standard"（u-he と共同 initiate） → OrbitScore の CLAP-first substrate はこの系譜と整合 |
| **OrbitScore OOP-child は Bitwig サンドボックスと同型** | ✅ 既存資産 | γ sandbox spike（`POST_2.0_GAMMA_SANDBOX_SPIKE.md`）+ M1 `EffectChildSupervisor`（out-of-process・spawn/watchdog/respawn）= Bitwig の per-plugin sandbox + crash reload と同機構。VST3/AU 追加 = 同 substrate に child を足すだけ |

**結論（research bottom line）**: modern host は effects を serial/graph の signal path のノードとしてモデル化し、plugin format は loading/adapter の関心事であって audio chain が単一 format である必要はない。ただし ①「1 track = 1 instrument」は強すぎ（rack/layer/multi-out/前段 note FX がある）②「stereo audio-in → audio-out + note-on/off」の固定抽象は serious host には不足 — 宣言された bus（multi-out/sidechain）・note/MIDI in+out・param/CC・note expression/MPE/MIDI2 を honor する必要。
